// Camera intrinsics from photos of a flat calibration target: an AprilGrid
// (Kalibr's layout: tagCols x tagRows AprilTags, tag i at row floor(i /
// tagCols), column i % tagCols, tagSize the black square's side, tagSpacing
// the gap as a share of tagSize). Pure math, no page: app_camcal.js feeds it
// detections (tag_worker.js) and saves what comes out.
//
// The lens model is the robot's (Lynx.lens): a point at angle th off the
// optical axis lands r = f (th + k1 th^3 + k2 th^5) pixels from the optical
// center (cx, cy) -- one focal length (square pixels).
//
//   prepareView(dets, grid, w, h, init) -> {points: [{X, Y, u, v}], H} or null
//     every detected tag's four corners matched to their spots on the board
//     (by where a homography of the tag centers predicts them -- no corner
//     order convention needed), and a first guess of the board's pose.
//   solve(views, init, w, h) -> {f, cx, cy, k1, k2, rms, perView, points, iterations}
//     Levenberg-Marquardt over the intrinsics and every view's pose,
//     minimizing the reprojection error (pixels); points off by more than
//     3x the RMS (and 2 px) are dropped and it's solved again.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  // -- small linear algebra -------------------------------------------------------------
  function solveLinear(A, b) {
    // Gaussian elimination with partial pivoting; A n x n (copied), b n
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-15) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < n; r++) {
        const k = M[r][c] / M[c][c];
        if (k === 0) continue;
        for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let j = r + 1; j < n; j++) s -= M[r][j] * x[j];
      x[r] = s / M[r][r];
    }
    return x;
  }
  const norm3 = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

  // rotation vector <-> matrix (Rodrigues)
  function rodrigues(r) {
    const th = Math.hypot(r[0], r[1], r[2]);
    if (th < 1e-12) return [[1, -r[2], r[1]], [r[2], 1, -r[0]], [-r[1], r[0], 1]];
    const k = [r[0] / th, r[1] / th, r[2] / th];
    const c = Math.cos(th);
    const s = Math.sin(th);
    const v = 1 - c;
    return [
      [c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s],
      [k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s],
      [k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v],
    ];
  }
  function toRotvec(R) {
    const tr = R[0][0] + R[1][1] + R[2][2];
    const c = Math.max(-1, Math.min(1, (tr - 1) / 2));
    const th = Math.acos(c);
    if (th < 1e-9) return [0, 0, 0];
    if (Math.PI - th < 1e-6) {
      // 180 degrees: the axis from the diagonal
      const x = Math.sqrt(Math.max(0, (R[0][0] + 1) / 2));
      const y = Math.sqrt(Math.max(0, (R[1][1] + 1) / 2)) * (R[0][1] >= 0 ? 1 : -1);
      const z = Math.sqrt(Math.max(0, (R[2][2] + 1) / 2)) * (R[0][2] >= 0 ? 1 : -1);
      return [x * th, y * th, z * th];
    }
    const s = 2 * Math.sin(th);
    return [((R[2][1] - R[1][2]) / s) * th, ((R[0][2] - R[2][0]) / s) * th, ((R[1][0] - R[0][1]) / s) * th];
  }

  // -- the lens model -----------------------------------------------------------------------------
  // camera point -> pixel
  function project(K, X, Y, Z) {
    const xn = X / Z;
    const yn = Y / Z;
    const r = Math.hypot(xn, yn);
    let s = 1;
    if (r > 1e-12) {
      const th = Math.atan(r);
      const th2 = th * th;
      s = (th * (1 + K.k1 * th2 + K.k2 * th2 * th2)) / r;
    }
    return [K.cx + K.f * xn * s, K.cy + K.f * yn * s];
  }
  // pixel -> normalized pinhole coordinates (z = 1)
  function unproject(K, u, v) {
    const dx = (u - K.cx) / K.f;
    const dy = (v - K.cy) / K.f;
    const rd = Math.hypot(dx, dy);
    if (rd < 1e-12) return [0, 0];
    let th = rd;
    for (let i = 0; i < 30; i++) {
      const th2 = th * th;
      const g = th * (1 + K.k1 * th2 + K.k2 * th2 * th2) - rd;
      const dg = 1 + 3 * K.k1 * th2 + 5 * K.k2 * th2 * th2;
      th -= g / dg;
    }
    const rn = Math.tan(Math.min(th, 1.5));
    return [(dx / rd) * rn, (dy / rd) * rn];
  }

  // -- the board ---------------------------------------------------------------------------------
  function gridInfo(grid) {
    const s = grid.tagSize;
    const pitch = s * (1 + grid.tagSpacing);
    return { s, pitch, n: grid.tagCols * grid.tagRows, center: (id) => [(id % grid.tagCols) * pitch + s / 2, Math.floor(id / grid.tagCols) * pitch + s / 2] };
  }

  // Least-squares homography (h33 = 1) from >= 4 point pairs, with normalization.
  function homographyLS(src, dst) {
    const nrm = (pts) => {
      const mx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      const my = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      const d = pts.reduce((a, p) => a + Math.hypot(p[0] - mx, p[1] - my), 0) / pts.length || 1;
      const k = Math.SQRT2 / d;
      return { T: [[k, 0, -k * mx], [0, k, -k * my], [0, 0, 1]], p: pts.map((p) => [(p[0] - mx) * k, (p[1] - my) * k]) };
    };
    const a = nrm(src);
    const b = nrm(dst);
    const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0));
    const Atb = new Array(8).fill(0);
    const add = (row, rhs) => {
      for (let i = 0; i < 8; i++) {
        Atb[i] += row[i] * rhs;
        for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j];
      }
    };
    for (let i = 0; i < src.length; i++) {
      const [X, Y] = a.p[i];
      const [x, y] = b.p[i];
      add([X, Y, 1, 0, 0, 0, -x * X, -x * Y], x);
      add([0, 0, 0, X, Y, 1, -y * X, -y * Y], y);
    }
    const h = solveLinear(AtA, Atb);
    if (!h) return null;
    const Hn = [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
    // H = Tb^-1 Hn Ta
    const Tb = b.T;
    const kb = Tb[0][0];
    const TbInv = [[1 / kb, 0, -Tb[0][2] / kb], [0, 1 / kb, -Tb[1][2] / kb], [0, 0, 1]];
    const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
    const H = mul(mul(TbInv, Hn), a.T);
    return H.map((r) => r.map((v) => v / H[2][2]));
  }
  const applyH = (H, X, Y) => {
    const w = H[2][0] * X + H[2][1] * Y + H[2][2];
    return [(H[0][0] * X + H[0][1] * Y + H[0][2]) / w, (H[1][0] * X + H[1][1] * Y + H[1][2]) / w];
  };

  // board-plane -> normalized-camera homography -> pose {r (rotation vector), t}
  function poseFromH(H) {
    const h1 = [H[0][0], H[1][0], H[2][0]];
    const h2 = [H[0][1], H[1][1], H[2][1]];
    const h3 = [H[0][2], H[1][2], H[2][2]];
    let lambda = 2 / (Math.hypot(...h1) + Math.hypot(...h2));
    if (h3[2] * lambda < 0) lambda = -lambda; // the board in front of the camera
    const r1 = norm3(h1.map((v) => v * lambda));
    const r2raw = h2.map((v) => v * lambda);
    const r2 = norm3(r2raw.map((v, i) => v - dot3(r1, r2raw) * r1[i]));
    const r3 = cross3(r1, r2);
    const R = [[r1[0], r2[0], r3[0]], [r1[1], r2[1], r3[1]], [r1[2], r2[2], r3[2]]];
    return { r: toRotvec(R), t: h3.map((v) => v * lambda) };
  }

  // A picture's detections -> its board points with pixels, and a first pose.
  // The detector lists every tag's corners in the same rotational order, and
  // the grid's tags are all printed the same way up -- so which detected
  // corner is which board corner is one of 8 ways (4 turns, mirrored or not)
  // for the whole picture: the one whose homography fits best.
  function prepareView(dets, grid, w, h, init) {
    const G = gridInfo(grid);
    const K = { f: init.f, cx: init.cx ?? w / 2, cy: init.cy ?? h / 2, k1: init.k1 || 0, k2: init.k2 || 0 };
    const tags = dets.filter((d) => d.id >= 0 && d.id < G.n && d.corners && d.corners.length === 4);
    if (tags.length < 2) return null;
    const nc = tags.map((d) => d.corners.map((p) => unproject(K, p.x, p.y)));
    const hs = G.s / 2;
    const boardOf = (d) => {
      const [bx, by] = G.center(d.id);
      return [[bx - hs, by - hs], [bx + hs, by - hs], [bx + hs, by + hs], [bx - hs, by + hs]];
    };
    let best = null;
    for (let rot = 0; rot < 4; rot++) {
      for (const mirror of [false, true]) {
        const k = (j) => (mirror ? (rot - j + 4) % 4 : (j + rot) % 4);
        const src = [];
        const dst = [];
        tags.forEach((d, i) => {
          const b = boardOf(d);
          for (let j = 0; j < 4; j++) {
            src.push(b[k(j)]);
            dst.push(nc[i][j]);
          }
        });
        const H = homographyLS(src, dst);
        if (!H) continue;
        // RMS misfit, relative to the tags' size in the picture
        let e = 0;
        src.forEach((q, n) => {
          const p = applyH(H, q[0], q[1]);
          e += (p[0] - dst[n][0]) ** 2 + (p[1] - dst[n][1]) ** 2;
        });
        if (!best || e < best.e) best = { e, k, H };
      }
    }
    if (!best) return null;
    // tags that don't fit the grid's homography (a misread, a reflection) out
    const points = [];
    tags.forEach((d, i) => {
      const b = boardOf(d);
      const pred = b.map(([X, Y]) => applyH(best.H, X, Y));
      const size = Math.hypot(pred[0][0] - pred[2][0], pred[0][1] - pred[2][1]);
      let bad = false;
      for (let j = 0; j < 4; j++) {
        const q = pred[best.k(j)];
        if (Math.hypot(nc[i][j][0] - q[0], nc[i][j][1] - q[1]) > 0.25 * size) bad = true;
      }
      if (bad) return;
      for (let j = 0; j < 4; j++) points.push({ X: b[best.k(j)][0], Y: b[best.k(j)][1], u: d.corners[j].x, v: d.corners[j].y });
    });
    if (points.length < 16) return null;
    const H2 = homographyLS(points.map((p) => [p.X, p.Y]), points.map((p) => unproject(K, p.u, p.v))) || best.H;
    return { points, pose: poseFromH(H2), tags: points.length / 4 };
  }

  // -- Levenberg-Marquardt ----------------------------------------------------------------------
  const INTR = ["f", "cx", "cy", "k1", "k2"];
  const STEP = { f: 0.01, cx: 0.01, cy: 0.01, k1: 1e-6, k2: 1e-6 };

  function residualsOfView(K, pose, pts, out, o) {
    const R = rodrigues(pose.r);
    const t = pose.t;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const X = R[0][0] * p.X + R[0][1] * p.Y + t[0];
      const Y = R[1][0] * p.X + R[1][1] * p.Y + t[1];
      const Z = R[2][0] * p.X + R[2][1] * p.Y + t[2];
      const [u, v] = Z > 1e-6 ? project(K, X, Y, Z) : [1e6, 1e6];
      out[o + 2 * i] = u - p.u;
      out[o + 2 * i + 1] = v - p.v;
    }
  }

  function lm(views, K0, opts) {
    const fix = opts.fix || {};
    const free = INTR.filter((k) => !fix[k]);
    let K = { ...K0 };
    let poses = views.map((v) => ({ r: v.pose.r.slice(), t: v.pose.t.slice() }));
    const offs = [];
    let m = 0;
    views.forEach((v) => {
      offs.push(m);
      m += 2 * v.points.length;
    });
    const P = free.length + 6 * views.length;
    const resid = (K_, poses_) => {
      const out = new Float64Array(m);
      views.forEach((v, i) => residualsOfView(K_, poses_[i], v.points, out, offs[i]));
      return out;
    };
    const cost = (r) => r.reduce((a, x) => a + x * x, 0);
    let r = resid(K, poses);
    let c = cost(r);
    let lambda = 1e-3;
    let it = 0;
    for (; it < (opts.maxIter || 60); it++) {
      // Jacobian, column by column (numeric; a pose only touches its own view's rows)
      const JtJ = Array.from({ length: P }, () => new Float64Array(P));
      const Jtr = new Float64Array(P);
      const cols = []; // [{rows: [start, end), d: Float64Array}]
      free.forEach((name) => {
        const Kp = { ...K, [name]: K[name] + STEP[name] };
        const rp = resid(Kp, poses);
        const d = new Float64Array(m);
        for (let i = 0; i < m; i++) d[i] = (rp[i] - r[i]) / STEP[name];
        cols.push({ a: 0, b: m, d });
      });
      views.forEach((v, vi) => {
        const n2 = 2 * v.points.length;
        for (let k = 0; k < 6; k++) {
          const pp = { r: poses[vi].r.slice(), t: poses[vi].t.slice() };
          const h = k < 3 ? 1e-6 : 1e-6;
          if (k < 3) pp.r[k] += h;
          else pp.t[k - 3] += h;
          const out = new Float64Array(m);
          residualsOfView(K, pp, v.points, out, offs[vi]);
          const d = new Float64Array(m);
          for (let i = offs[vi]; i < offs[vi] + n2; i++) d[i] = (out[i] - r[i]) / h;
          cols.push({ a: offs[vi], b: offs[vi] + n2, d });
        }
      });
      for (let i = 0; i < P; i++) {
        const ci = cols[i];
        let s = 0;
        for (let q = ci.a; q < ci.b; q++) s += ci.d[q] * r[q];
        Jtr[i] = s;
        for (let j = i; j < P; j++) {
          const cj = cols[j];
          const a = Math.max(ci.a, cj.a);
          const b = Math.min(ci.b, cj.b);
          let t = 0;
          for (let q = a; q < b; q++) t += ci.d[q] * cj.d[q];
          JtJ[i][j] = JtJ[j][i] = t;
        }
      }
      // try steps, raising the damping until the cost drops
      let improved = false;
      for (let tries = 0; tries < 10; tries++) {
        const A = JtJ.map((row, i) => Array.from(row, (v, j) => (i === j ? v * (1 + lambda) + 1e-12 : v)));
        const delta = solveLinear(A, Array.from(Jtr, (v) => -v));
        if (!delta) {
          lambda *= 10;
          continue;
        }
        const K2 = { ...K };
        free.forEach((name, i) => (K2[name] += delta[i]));
        const poses2 = poses.map((p, vi) => {
          const o = free.length + 6 * vi;
          return { r: [p.r[0] + delta[o], p.r[1] + delta[o + 1], p.r[2] + delta[o + 2]], t: [p.t[0] + delta[o + 3], p.t[1] + delta[o + 4], p.t[2] + delta[o + 5]] };
        });
        const r2 = resid(K2, poses2);
        const c2 = cost(r2);
        if (c2 < c) {
          const rel = (c - c2) / c;
          K = K2;
          poses = poses2;
          r = r2;
          c = c2;
          lambda = Math.max(1e-9, lambda / 3);
          improved = true;
          if (rel < 1e-10) it = 1e9; // converged
          break;
        }
        lambda *= 10;
      }
      if (!improved) break;
    }
    return { K, poses, r, rms: Math.sqrt(c / Math.max(1, m / 2)), iterations: Math.min(it, opts.maxIter || 60) };
  }

  function solve(viewsIn, init, w, h, opts = {}) {
    let views = viewsIn.filter((v) => v && v.points.length >= 16);
    if (views.length < 3) return { error: "Need at least 3 good pictures of the target" };
    const K0 = { f: init.f, cx: init.cx ?? w / 2, cy: init.cy ?? h / 2, k1: init.k1 || 0, k2: init.k2 || 0 };
    // first without k2 (stabler), then everything
    let res = lm(views, K0, { fix: { k2: true }, maxIter: 40 });
    views = views.map((v, i) => ({ ...v, pose: res.poses[i] }));
    res = lm(views, res.K, { maxIter: 60 });
    // outliers out (3 x RMS, at least 2 px), solve again
    const lim = Math.max(2, 3 * res.rms);
    let dropped = 0;
    let o = 0;
    const kept = views.map((v, i) => {
      const pts = v.points.filter((p, j) => {
        const e = Math.hypot(res.r[o + 2 * j], res.r[o + 2 * j + 1]);
        return e <= lim || (dropped++, false);
      });
      o += 2 * v.points.length;
      return { ...v, points: pts, pose: res.poses[i] };
    }).filter((v) => v.points.length >= 16);
    if (dropped) res = lm(kept, res.K, { maxIter: 60 });
    const used = dropped ? kept : views;
    // per-view RMS, for showing which pictures fit worst
    let q = 0;
    const perView = used.map((v) => {
      let s = 0;
      for (let j = 0; j < v.points.length; j++) s += res.r[q + 2 * j] ** 2 + res.r[q + 2 * j + 1] ** 2;
      q += 2 * v.points.length;
      return Math.sqrt(s / v.points.length);
    });
    return { ...res.K, rms: res.rms, perView, views: used.length, points: used.reduce((a, v) => a + v.points.length, 0), dropped, iterations: res.iterations };
  }

  Lynx.camcalSolver = { prepareView, solve, project, unproject, rodrigues, gridInfo };
})(window.Lynx);
