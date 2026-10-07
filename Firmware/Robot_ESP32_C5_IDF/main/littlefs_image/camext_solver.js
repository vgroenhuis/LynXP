// Camera extrinsics: where the camera sits on the robot and how the pan /
// tilt servos really turn it, from tour pictures of a fixed checkerboard on
// a wall and the world-frame cube (tags 24-29) on the floor next to it. The
// intrinsics come calibrated (Lynx.lens). Pure math; app_camcal.js collects
// the pictures (its "extrinsics" mode) and saves the result.
//
// The camera chain (world: x, y on the floor, z up):
//   robot at (X, Y) facing TH -- its odometry, placed in the world by one
//     unknown turn and shift, plus a small correction per spot (odometry
//     is good over one tour, not perfect);
//   pan about the vertical axis between the wheels: psi = TH + panOffset +
//     pan * (pan > 0 ? panGainL : panGainR) (positive = left);
//   the head at height h (the tilt axis), possibly rolled by axisRoll about
//     the forward direction (a small pan shaft wobbles);
//   tilt about that axis: the camera's downward angle D = mountTilt -
//     tilt * (tilt > 0 ? tiltGainUp : tiltGainDown) (tilt > 0 looks up --
//     the robot's cameraTiltDeg is mountTilt);
//   the optical center `offset` in front of the tilt axis along the view,
//     and the camera rolled by camRoll about its optical axis.
// The board: its corners at (col, row) * square in its own frame, which sits
// anywhere in the world (6 unknowns). The cube: resting on the floor (its
// center half a cube up), at an unknown place and turn (3 unknowns) -- it
// fixes the floor's level: with the robot driving on the floor, the board
// alone can't tell a higher camera from a higher board.
//
// Every parameter has a prior (the nominal value and how far off it may be);
// a weakly seen one stays near it. Levenberg-Marquardt over all of them,
// residuals in units of their uncertainty (pixels / PIX_SIGMA).
//
//   Lynx.camextSolver.solve(views, opts) -> {params, sigma, rms, ...}
//     views: [{K (intrinsics), pan, tilt (commanded, deg), odo: {x, y, th},
//              corners: [{col, row, u, v}] (absolute board indices),
//              tags: [{id, u, v}] (cube tag centers, pixels)}]
//     opts: {square, cube (m), prior: {...}, fixed: [names held at their prior]}
//   Lynx.camextSolver.labelView(points [{i, j, u, v}], cols, rows) ->
//     points with absolute {col, row} when the whole board is in view, else
//     {rel: true, ...} (oriented, but offset unknown -- placed by
//     placeView() against the model)

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const PIX_SIGMA = 0.5;
  const D2R = Math.PI / 180;
  // [name, prior value (overridden by opts.prior), prior sigma]
  const CHAIN = [
    ["h", 0.1, 0.003],
    ["offset", 0.005, 0.01],
    ["mountTilt", 0, 3 * D2R],
    ["axisRoll", 0, 3 * D2R],
    ["camRoll", 0, 3 * D2R],
    ["panOffset", 0, 3 * D2R],
    ["panGainL", 1, 0.03],
    ["panGainR", 1, 0.03],
    ["tiltGainUp", 1, 0.03],
    ["tiltGainDown", 1, 0.03],
  ];

  const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
  const Rz = (a) => [[Math.cos(a), -Math.sin(a), 0], [Math.sin(a), Math.cos(a), 0], [0, 0, 1]];
  const Rx = (a) => [[1, 0, 0], [0, Math.cos(a), -Math.sin(a)], [0, Math.sin(a), Math.cos(a)]];
  // nose down by D (about the left-pointing y axis)
  const Rdown = (D) => [[Math.cos(D), 0, Math.sin(D)], [0, 1, 0], [-Math.sin(D), 0, Math.cos(D)]];
  function rodrigues(r) {
    const th = Math.hypot(r[0], r[1], r[2]);
    if (th < 1e-12) return [[1, -r[2], r[1]], [r[2], 1, -r[0]], [-r[1], r[0], 1]];
    const k = r.map((v) => v / th);
    const c = Math.cos(th);
    const s = Math.sin(th);
    const v = 1 - c;
    return [
      [c + k[0] * k[0] * v, k[0] * k[1] * v - k[2] * s, k[0] * k[2] * v + k[1] * s],
      [k[1] * k[0] * v + k[2] * s, c + k[1] * k[1] * v, k[1] * k[2] * v - k[0] * s],
      [k[2] * k[0] * v - k[1] * s, k[2] * k[1] * v + k[0] * s, c + k[2] * k[2] * v],
    ];
  }

  // The camera for one view: {C (center), R (columns: forward, right, down -- world)}
  function cameraOf(P, view, spot) {
    const T = P.world; // [turn, x, y]: odometry -> world
    const s = P.spots[spot];
    const oth = view.odo.th + s[0];
    const ox = view.odo.x + s[1];
    const oy = view.odo.y + s[2];
    const X = T[1] + ox * Math.cos(T[0]) - oy * Math.sin(T[0]);
    const Y = T[2] + ox * Math.sin(T[0]) + oy * Math.cos(T[0]);
    const TH = T[0] + oth;
    const pan = view.pan * D2R;
    const tilt = view.tilt * D2R;
    const psi = TH + P.panOffset + pan * (pan > 0 ? P.panGainL : P.panGainR);
    const D = P.mountTilt - tilt * (tilt > 0 ? P.tiltGainUp : P.tiltGainDown);
    const R = mul(mul(mul(Rz(psi), Rx(P.axisRoll)), Rdown(D)), Rx(P.camRoll));
    const fwd = [R[0][0], R[1][0], R[2][0]];
    const C = [X + P.offset * fwd[0], Y + P.offset * fwd[1], P.h + P.offset * fwd[2]];
    // camera axes: forward = local x, right = -local y, down = -local z
    return { C, fwd, right: [-R[0][1], -R[1][1], -R[2][1]], down: [-R[0][2], -R[1][2], -R[2][2]] };
  }
  function toPixel(cam, K, p) {
    const d = [p[0] - cam.C[0], p[1] - cam.C[1], p[2] - cam.C[2]];
    const x = d[0] * cam.right[0] + d[1] * cam.right[1] + d[2] * cam.right[2];
    const y = d[0] * cam.down[0] + d[1] * cam.down[1] + d[2] * cam.down[2];
    const z = d[0] * cam.fwd[0] + d[1] * cam.fwd[1] + d[2] * cam.fwd[2];
    if (z < 0.02) return null;
    return Lynx.camcalSolver.project(K, x, y, z);
  }
  function boardPoint(P, col, row, sq, Rb) {
    const R = Rb || rodrigues(P.board.slice(0, 3));
    const X = col * sq;
    const Y = row * sq;
    return [R[0][0] * X + R[0][1] * Y + P.board[3], R[1][0] * X + R[1][1] * Y + P.board[4], R[2][0] * X + R[2][1] * Y + P.board[5]];
  }
  const FACES = { 24: [1, 0, 0], 25: [0, 1, 0], 26: [0, 0, 1], 27: [0, 0, -1], 28: [0, -1, 0], 29: [-1, 0, 0] };
  function tagCenter(P, id, cube) {
    const n = FACES[id];
    const [cx, cy, g] = P.cube;
    const c = Math.cos(g);
    const s = Math.sin(g);
    const hs = cube / 2;
    return [cx + (n[0] * c - n[1] * s) * hs, cy + (n[0] * s + n[1] * c) * hs, hs + n[2] * hs];
  }

  // -- the parameter vector ------------------------------------------------------------------------
  function pack(P) {
    return [...CHAIN.map(([n]) => P[n]), ...P.board, ...P.cube, ...P.world, ...P.spots.flat()];
  }
  function unpack(v, nSpots) {
    const P = {};
    let k = 0;
    CHAIN.forEach(([n]) => (P[n] = v[k++]));
    P.board = v.slice(k, k + 6);
    k += 6;
    P.cube = v.slice(k, k + 3);
    k += 3;
    P.world = v.slice(k, k + 3);
    k += 3;
    P.spots = [];
    for (let i = 0; i < nSpots; i++, k += 3) P.spots.push(v.slice(k, k + 3));
    return P;
  }

  function residuals(P, views, opts, prior) {
    const out = [];
    const Rb = rodrigues(P.board.slice(0, 3));
    views.forEach((v) => {
      const cam = cameraOf(P, v, v.spot);
      v.corners.forEach((c) => {
        const q = toPixel(cam, v.K, boardPoint(P, c.col, c.row, opts.square, Rb));
        out.push(q ? (q[0] - c.u) / PIX_SIGMA : 100, q ? (q[1] - c.v) / PIX_SIGMA : 100);
      });
      (v.tags || []).forEach((t) => {
        const q = toPixel(cam, v.K, tagCenter(P, t.id, opts.cube));
        // (a tag center from its corners is a little rougher than a checker corner)
        out.push(q ? (q[0] - t.u) / (2 * PIX_SIGMA) : 100, q ? (q[1] - t.v) / (2 * PIX_SIGMA) : 100);
      });
    });
    CHAIN.forEach(([n, , sig]) => out.push((P[n] - prior[n]) / (opts.fixed && opts.fixed.includes(n) ? 1e-4 : sig)));
    P.spots.forEach((s) => out.push(s[0] / (0.5 * D2R), s[1] / 0.01, s[2] / 0.01));
    return out;
  }

  function solveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => [...row, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      if (Math.abs(M[p][c]) < 1e-18) return null;
      [M[c], M[p]] = [M[p], M[c]];
      for (let r = c + 1; r < n; r++) {
        const k = M[r][c] / M[c][c];
        if (k) for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
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
  function invert(A) {
    const n = A.length;
    return Array.from({ length: n }, (_, i) => solveLinear(A, Array.from({ length: n }, (__, j) => (i === j ? 1 : 0))));
  }

  function lm(P0, views, opts, prior, maxIter) {
    const nSpots = P0.spots.length;
    let v = pack(P0);
    const n = v.length;
    const steps = v.map((_, i) => (i < CHAIN.length ? 1e-6 : 1e-6));
    let r = residuals(unpack(v, nSpots), views, opts, prior);
    let cost = r.reduce((a, x) => a + x * x, 0);
    let lambda = 1e-3;
    let JtJ = null;
    for (let it = 0; it < maxIter; it++) {
      const m = r.length;
      const J = [];
      for (let i = 0; i < n; i++) {
        const vp = v.slice();
        vp[i] += steps[i];
        const rp = residuals(unpack(vp, nSpots), views, opts, prior);
        const col = new Float64Array(m);
        for (let q = 0; q < m; q++) col[q] = (rp[q] - r[q]) / steps[i];
        J.push(col);
      }
      JtJ = Array.from({ length: n }, () => new Array(n).fill(0));
      const Jtr = new Array(n).fill(0);
      for (let i = 0; i < n; i++) {
        const a = J[i];
        let t = 0;
        for (let q = 0; q < m; q++) t += a[q] * r[q];
        Jtr[i] = t;
        for (let j = i; j < n; j++) {
          const b = J[j];
          let u = 0;
          for (let q = 0; q < m; q++) u += a[q] * b[q];
          JtJ[i][j] = JtJ[j][i] = u;
        }
      }
      let improved = false;
      for (let t = 0; t < 10; t++) {
        const A = JtJ.map((row, i) => row.map((x, j) => (i === j ? x * (1 + lambda) + 1e-12 : x)));
        const d = solveLinear(A, Jtr.map((x) => -x));
        if (!d) {
          lambda *= 10;
          continue;
        }
        const v2 = v.map((x, i) => x + d[i]);
        const r2 = residuals(unpack(v2, nSpots), views, opts, prior);
        const c2 = r2.reduce((a, x) => a + x * x, 0);
        if (c2 < cost) {
          const rel = (cost - c2) / cost;
          v = v2;
          r = r2;
          cost = c2;
          lambda = Math.max(1e-9, lambda / 3);
          improved = true;
          if (rel < 1e-9) it = maxIter;
          break;
        }
        lambda *= 10;
      }
      if (!improved) break;
    }
    return { P: unpack(v, nSpots), r, cost, JtJ };
  }

  // -- labelling the board's corners -----------------------------------------------------------------
  // A picture's corners (relative grid steps i, j from the detector) ->
  // board columns (left to right as the camera sees it) and rows (top to
  // bottom). When the whole board is in view that's absolute; otherwise
  // only the orientation is known (rel: true) and placeView finds the offset.
  function labelView(points, cols, rows) {
    const key = new Map(points.map((p) => [`${p.i},${p.j}`, p]));
    const avg = (di, dj) => {
      let x = 0;
      let y = 0;
      let n = 0;
      points.forEach((p) => {
        const q = key.get(`${p.i + di},${p.j + dj}`);
        if (q) {
          x += q.u - p.u;
          y += q.v - p.v;
          n++;
        }
      });
      return n ? [x / n, y / n] : [0, 0];
    };
    const a = avg(1, 0);
    const b = avg(0, 1);
    const iIsCol = Math.abs(a[0]) >= Math.abs(b[0]);
    const colStep = iIsCol ? a : b;
    const rowStep = iIsCol ? b : a;
    const cs = colStep[0] >= 0 ? 1 : -1; // (columns to the right)
    const rs = rowStep[1] >= 0 ? 1 : -1; // (rows downward)
    const lab = points.map((p) => ({ col: (iIsCol ? p.i : p.j) * cs, row: (iIsCol ? p.j : p.i) * rs, u: p.u, v: p.v }));
    const c0 = Math.min(...lab.map((p) => p.col));
    const r0 = Math.min(...lab.map((p) => p.row));
    const spanC = Math.max(...lab.map((p) => p.col)) - c0 + 1;
    const spanR = Math.max(...lab.map((p) => p.row)) - r0 + 1;
    lab.forEach((p) => {
      p.col -= c0;
      p.row -= r0;
    });
    return { corners: lab, absolute: spanC === cols && spanR === rows, spanC, spanR };
  }
  // A partial view's offset on the board: the one that puts its corners
  // nearest where the model predicts them (within a third of a square).
  function placeView(P, view, opts) {
    const cam = cameraOf(P, view, view.spot);
    let best = null;
    for (let oc = 0; oc <= opts.cols - view.spanC; oc++) {
      for (let or = 0; or <= opts.rows - view.spanR; or++) {
        let e = 0;
        let n = 0;
        let step = 0;
        view.corners.forEach((c) => {
          const q = toPixel(cam, view.K, boardPoint(P, c.col + oc, c.row + or, opts.square));
          const q2 = toPixel(cam, view.K, boardPoint(P, c.col + oc + 1, c.row + or, opts.square));
          if (!q || !q2) return;
          e += Math.hypot(q[0] - c.u, q[1] - c.v);
          step += Math.hypot(q2[0] - q[0], q2[1] - q[1]);
          n++;
        });
        if (n && (!best || e / n < best.e)) best = { oc, or, e: e / n, step: step / n };
      }
    }
    if (!best || best.e > 0.33 * best.step) return null;
    return view.corners.map((c) => ({ ...c, col: c.col + best.oc, row: c.row + best.or }));
  }

  // -- a first guess ---------------------------------------------------------------------------------
  // the board's pose from one absolute view, with the nominal chain
  function boardFromView(P, view, opts) {
    const S = Lynx.camcalSolver;
    const pts = view.corners.map((c) => ({ X: c.col * opts.square, Y: c.row * opts.square, u: c.u, v: c.v }));
    const vw = S.viewFromPoints(pts, 0, 0, view.K);
    if (!vw) return null;
    const Rb = S.rodrigues(vw.pose.r); // board -> camera (x right, y down, z forward)
    const cam = cameraOf(P, view, view.spot);
    const camToWorld = (q) => [0, 1, 2].map((k) => cam.right[k] * q[0] + cam.down[k] * q[1] + cam.fwd[k] * q[2]);
    const t = camToWorld(vw.pose.t);
    const ex = camToWorld([Rb[0][0], Rb[1][0], Rb[2][0]]);
    const ey = camToWorld([Rb[0][1], Rb[1][1], Rb[2][1]]);
    const ez = [ex[1] * ey[2] - ex[2] * ey[1], ex[2] * ey[0] - ex[0] * ey[2], ex[0] * ey[1] - ex[1] * ey[0]];
    const R = [[ex[0], ey[0], ez[0]], [ex[1], ey[1], ez[1]], [ex[2], ey[2], ez[2]]];
    const rv = S.unrodrigues ? S.unrodrigues(R) : toRotvec(R);
    return [...rv, cam.C[0] + t[0], cam.C[1] + t[1], cam.C[2] + t[2]];
  }
  function toRotvec(R) {
    const tr = R[0][0] + R[1][1] + R[2][2];
    const th = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2)));
    if (th < 1e-9) return [0, 0, 0];
    const s = 2 * Math.sin(th);
    if (Math.abs(s) < 1e-6) {
      const x = Math.sqrt(Math.max(0, (R[0][0] + 1) / 2));
      const y = Math.sqrt(Math.max(0, (R[1][1] + 1) / 2)) * (R[0][1] >= 0 ? 1 : -1);
      const z = Math.sqrt(Math.max(0, (R[2][2] + 1) / 2)) * (R[0][2] >= 0 ? 1 : -1);
      return [x * th, y * th, z * th];
    }
    return [((R[2][1] - R[1][2]) / s) * th, ((R[0][2] - R[2][0]) / s) * th, ((R[1][0] - R[0][1]) / s) * th];
  }
  // the cube from its tag centers: each a ray, met at half a cube up, pushed half a cube back
  function cubeFromViews(P, views, opts) {
    const pts = [];
    views.forEach((v) => {
      const cam = cameraOf(P, v, v.spot);
      (v.tags || []).forEach((t) => {
        const n = Lynx.camcalSolver.unproject(v.K, t.u, t.v);
        const d = [0, 1, 2].map((k) => cam.right[k] * n[0] + cam.down[k] * n[1] + cam.fwd[k]);
        const z = t.id === 26 ? opts.cube : opts.cube / 2;
        if (Math.abs(d[2]) < 1e-6) return;
        const s = (z - cam.C[2]) / d[2];
        if (s <= 0) return;
        const hd = Math.hypot(d[0], d[1]) || 1;
        const back = t.id === 26 ? 0 : opts.cube / 2;
        pts.push([cam.C[0] + d[0] * s + (d[0] / hd) * back, cam.C[1] + d[1] * s + (d[1] / hd) * back]);
      });
    });
    if (!pts.length) return null;
    return [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length, 0];
  }

  // -- solving ------------------------------------------------------------------------------------------
  function solve(viewsIn, opts) {
    const prior = {};
    CHAIN.forEach(([n, def]) => (prior[n] = opts.prior && Number.isFinite(opts.prior[n]) ? opts.prior[n] : def));
    // spots: views whose odometry agrees (within 1 cm, 1 deg) share one
    const spots = [];
    const views = viewsIn.map((v) => {
      let s = spots.findIndex((o) => Math.hypot(o.x - v.odo.x, o.y - v.odo.y) < 0.01 && Math.abs(Math.atan2(Math.sin(o.th - v.odo.th), Math.cos(o.th - v.odo.th))) < D2R);
      if (s < 0) {
        spots.push(v.odo);
        s = spots.length - 1;
      }
      const lab = labelView(v.points, opts.cols, opts.rows);
      return { ...v, spot: s, corners: lab.absolute ? lab.corners : [], partial: lab.absolute ? null : lab };
    });
    const full = views.filter((v) => v.corners.length);
    if (full.length < 3) return { error: "Need at least 3 pictures with the whole checkerboard in view" };
    if (!views.some((v) => v.tags && v.tags.length)) return { error: "The cube (tags 24-29) wasn't seen -- it fixes the floor's level" };
    // a first guess: nominal chain, odometry as the world, the board from the first full view
    let P = { ...prior, board: [0, 0, 0, 0, 0, 0], cube: [0, 0, 0], world: [0, 0, 0], spots: spots.map(() => [0, 0, 0]) };
    const b0 = boardFromView(P, full[0], opts);
    if (!b0) return { error: "Couldn't place the board" };
    P.board = b0;
    const c0 = cubeFromViews(P, views, opts);
    if (!c0) return { error: "Couldn't place the cube" };
    P.cube = c0;
    // first the full views, then the partial ones placed against that, then all
    let used = full;
    let res = lm(P, used, opts, prior, 40);
    P = res.P;
    const placed = views.filter((v) => v.partial).map((v) => {
      const c = placeView(P, { ...v, corners: v.partial.corners, spanC: v.partial.spanC, spanR: v.partial.spanR }, opts);
      return c ? { ...v, corners: c } : null;
    }).filter(Boolean);
    used = full.concat(placed);
    res = lm(P, used, opts, prior, 40);
    P = res.P;
    // outliers (beyond 4 sigma) out, and once more
    let k = 0;
    const kept = used.map((v) => {
      const c = v.corners.filter(() => {
        const e = Math.hypot(res.r[k], res.r[k + 1]);
        k += 2;
        return e < 4;
      });
      k += 2 * (v.tags || []).length;
      return { ...v, corners: c };
    });
    res = lm(P, kept, opts, prior, 40);
    P = res.P;
    // uncertainties (1 sigma) from the curvature
    const cov = invert(res.JtJ);
    const nMeas = kept.reduce((a, v) => a + 2 * v.corners.length + 2 * (v.tags || []).length, 0);
    const pixRes = res.r.slice(0, nMeas);
    const rms = PIX_SIGMA * Math.sqrt(pixRes.reduce((a, x) => a + x * x, 0) / Math.max(1, nMeas));
    const scale = Math.max(1, rms / PIX_SIGMA);
    const sigma = {};
    CHAIN.forEach(([n], i) => (sigma[n] = cov && cov[i] ? Math.sqrt(Math.max(0, cov[i][i])) * scale : NaN));
    return {
      params: Object.fromEntries(CHAIN.map(([n]) => [n, P[n]])), sigma, prior, rms,
      views: kept.length, full: full.length, partial: placed.length, spots: spots.length,
      corners: kept.reduce((a, v) => a + v.corners.length, 0), tags: kept.reduce((a, v) => a + (v.tags || []).length, 0),
      board: P.board, cube: P.cube,
    };
  }

  Lynx.camextSolver = { solve, labelView, placeView, cameraOf, toPixel, boardPoint, tagCenter, CHAIN };
})(window.Lynx);
