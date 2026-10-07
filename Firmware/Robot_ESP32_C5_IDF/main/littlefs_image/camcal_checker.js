// Checkerboard corners in a camera picture, for the camera calibration
// (app_camcal.js; the math in camcal_solver.js). OpenCV.js builds come
// without its chessboard finder, so this does it:
//
//   1. Candidates: saddle points of the (lightly smoothed) brightness -- where
//      four squares meet, the brightness curves up one way and down the other
//      (Hessian determinant strongly negative); local maxima of that.
//   2. Each to a fraction of a pixel, as OpenCV's cornerSubPix: at the true
//      corner every brightness gradient around it is perpendicular to the
//      line from the corner (least squares over a small window, iterated).
//   3. The grid: from the strongest well-formed cross of four neighbours near
//      the middle, grown outward -- each next corner predicted from the ones
//      found (straight on from the last two, or the neighbouring row's step)
//      and taken if a candidate is that close; a corner must show the checker
//      pattern (dark/light quadrants along the grid's diagonals), its colour
//      alternating with its neighbours'.
// The board can be partly out of the picture: each corner gets (i, j) grid
// steps from the start -- which one of the board's corners it is doesn't
// matter for the intrinsics (one picture's points only need to be
// consistent with each other).
//
//   Lynx.camcalChecker.find(gray (Float32Array), w, h, opts) ->
//     {points: [{i, j, u, v}], candidates} or null
//   opts.maxCols, opts.maxRows: the board's inner corners (a grid found
//   longer than the board's longer side means a misstep: rejected).

window.Lynx = window.Lynx || {};

(function (Lynx) {
  function blur(src, w, h, sigma) {
    const r = Math.max(1, Math.ceil(2.5 * sigma));
    const k = [];
    let sum = 0;
    for (let i = -r; i <= r; i++) {
      const v = Math.exp(-(i * i) / (2 * sigma * sigma));
      k.push(v);
      sum += v;
    }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    const tmp = new Float32Array(w * h);
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) s += k[i + r] * src[y * w + Math.min(w - 1, Math.max(0, x + i))];
        tmp[y * w + x] = s;
      }
    }
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let s = 0;
        for (let i = -r; i <= r; i++) s += k[i + r] * tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x];
        out[y * w + x] = s;
      }
    }
    return out;
  }

  // 1. saddle candidates
  function candidates(gray, w, h, opts) {
    const g = blur(gray, w, h, opts.sigma || 1.5);
    const S = new Float32Array(w * h);
    let max = 0;
    for (let y = 2; y < h - 2; y++) {
      for (let x = 2; x < w - 2; x++) {
        const i = y * w + x;
        const ixx = g[i - 2] - 2 * g[i] + g[i + 2];
        const iyy = g[i - 2 * w] - 2 * g[i] + g[i + 2 * w];
        const ixy = (g[i - 2 * w - 2] + g[i + 2 * w + 2] - g[i - 2 * w + 2] - g[i + 2 * w - 2]) / 4;
        const s = ixy * ixy - ixx * iyy; // > 0 at a saddle
        S[i] = s;
        if (s > max) max = s;
      }
    }
    const thr = max * (opts.rel || 0.02);
    const R = opts.nms || 4;
    const out = [];
    for (let y = R; y < h - R; y++) {
      for (let x = R; x < w - R; x++) {
        const s = S[y * w + x];
        if (s <= thr) continue;
        let peak = true;
        for (let dy = -R; dy <= R && peak; dy++) for (let dx = -R; dx <= R; dx++) if ((dx || dy) && S[(y + dy) * w + x + dx] > s) { peak = false; break; }
        if (peak) out.push({ x: x + 0.5, y: y + 0.5, s }); // (pixel centers at i + 0.5)
      }
    }
    return { pts: out, smooth: g };
  }

  // 2. sub-pixel (cornerSubPix's idea); coordinates with pixel i spanning i..i+1
  function subpix(g, w, h, p, r) {
    let px = p.x;
    let py = p.y;
    for (let it = 0; it < 8; it++) {
      let a = 0;
      let b = 0;
      let c = 0;
      let bx = 0;
      let by = 0;
      const cx = Math.round(px - 0.5);
      const cy = Math.round(py - 0.5);
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1) continue;
          const i = y * w + x;
          const gx = (g[i + 1] - g[i - 1]) / 2;
          const gy = (g[i + w] - g[i - w]) / 2;
          const wt = Math.exp(-(dx * dx + dy * dy) / (r * r));
          const qx = x + 0.5;
          const qy = y + 0.5;
          a += wt * gx * gx;
          b += wt * gx * gy;
          c += wt * gy * gy;
          bx += wt * (gx * gx * qx + gx * gy * qy);
          by += wt * (gx * gy * qx + gy * gy * qy);
        }
      }
      const det = a * c - b * b;
      if (!(Math.abs(det) > 1e-9)) return null;
      const nx = (c * bx - b * by) / det;
      const ny = (a * by - b * bx) / det;
      const step = Math.hypot(nx - px, ny - py);
      px = nx;
      py = ny;
      if (step < 0.01) break;
    }
    if (Math.hypot(px - p.x, py - p.y) > r) return null; // (wandered off)
    return { x: px, y: py, s: p.s };
  }

  // brightness at a point (bilinear; pixel centers at i + 0.5)
  const sample = (g, w, h, x0, y0) => {
    const x = Math.min(w - 1.001, Math.max(0, x0 - 0.5));
    const y = Math.min(h - 1.001, Math.max(0, y0 - 0.5));
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const fx = x - xi;
    const fy = y - yi;
    const i = yi * w + xi;
    return (g[i] * (1 - fx) + g[i + 1] * fx) * (1 - fy) + (g[i + w] * (1 - fx) + g[i + w + 1] * fx) * fy;
  };
  // the checker pattern at p for grid steps a, b: + if the (+a+b, -a-b)
  // quadrants are the light ones, - if the dark; 0 if it isn't a clear checker
  function polarity(g, w, h, p, a, b) {
    const q = (s, t) => sample(g, w, h, p.x + 0.4 * (s * a[0] + t * b[0]), p.y + 0.4 * (s * a[1] + t * b[1]));
    const d1 = q(1, 1) + q(-1, -1);
    const d2 = q(1, -1) + q(-1, 1);
    const spread = Math.abs(q(1, 1) - q(-1, -1)) + Math.abs(q(1, -1) - q(-1, 1));
    const diff = d1 - d2;
    if (Math.abs(diff) < 30 || spread > 0.6 * Math.abs(diff)) return 0;
    return diff > 0 ? 1 : -1;
  }

  // 3. the grid
  function find(gray, w, h, opts = {}) {
    const { pts: raw, smooth } = candidates(gray, w, h, opts);
    if (raw.length < 9) return null;
    const fine = blur(gray, w, h, 0.7);
    const pts = raw.map((p) => subpix(fine, w, h, p, opts.win || 4)).filter(Boolean);
    // a spatial hash for nearest-candidate lookups
    const cell = 16;
    const hash = new Map();
    pts.forEach((p, k) => {
      const key = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`;
      if (!hash.has(key)) hash.set(key, []);
      hash.get(key).push(k);
    });
    const nearest = (x, y, rad, skip) => {
      let best = -1;
      let bd = rad;
      const r = Math.ceil(rad / cell);
      const gx = Math.floor(x / cell);
      const gy = Math.floor(y / cell);
      for (let yy = gy - r; yy <= gy + r; yy++) {
        for (let xx = gx - r; xx <= gx + r; xx++) {
          (hash.get(`${xx},${yy}`) || []).forEach((k) => {
            if (skip && skip.has(k)) return;
            const d = Math.hypot(pts[k].x - x, pts[k].y - y);
            if (d < bd) {
              bd = d;
              best = k;
            }
          });
        }
      }
      return best;
    };
    const kNearest = (p, k, rad) => {
      const out = [];
      const r = Math.ceil(rad / cell);
      const gx = Math.floor(p.x / cell);
      const gy = Math.floor(p.y / cell);
      for (let yy = gy - r; yy <= gy + r; yy++) {
        for (let xx = gx - r; xx <= gx + r; xx++) {
          (hash.get(`${xx},${yy}`) || []).forEach((q) => {
            const d = Math.hypot(pts[q].x - p.x, pts[q].y - p.y);
            if (d > 1 && d < rad) out.push({ q, d });
          });
        }
      }
      return out.sort((a, b) => a.d - b.d).slice(0, k);
    };

    // seeds: strong candidates nearest the middle first
    const order = pts.map((p, k) => k).sort((a, b) => {
      const da = Math.hypot(pts[a].x - w / 2, pts[a].y - h / 2) / (pts[a].s + 1e-9) ** 0.25;
      const db = Math.hypot(pts[b].x - w / 2, pts[b].y - h / 2) / (pts[b].s + 1e-9) ** 0.25;
      return da - db;
    });
    let best = null;
    for (const seed of order.slice(0, 40)) {
      const res = grow(seed);
      if (res && (!best || res.size > best.size)) best = res;
      if (best && best.size >= 0.6 * (opts.maxCols || 13) * (opts.maxRows || 14)) break;
    }
    if (!best || best.size < 9) return null;
    const points = [];
    best.forEach((k, key) => {
      const [i, j] = key.split(",").map(Number);
      points.push({ i, j, u: pts[k].x, v: pts[k].y });
    });
    return { points, candidates: pts.length };

    function grow(seed) {
      const p0 = pts[seed];
      const nb = kNearest(p0, 4, 120);
      if (nb.length < 4) return null;
      // two pairs of opposite neighbours
      const v = nb.map((n) => [pts[n.q].x - p0.x, pts[n.q].y - p0.y]);
      let pairA = null;
      let pairB = null;
      for (let a = 0; a < 4 && !pairB; a++) {
        for (let b = a + 1; b < 4; b++) {
          const s = Math.hypot(v[a][0] + v[b][0], v[a][1] + v[b][1]);
          const l = (Math.hypot(...v[a]) + Math.hypot(...v[b])) / 2;
          if (s < 0.25 * l) {
            const rest = [0, 1, 2, 3].filter((q) => q !== a && q !== b);
            const s2 = Math.hypot(v[rest[0]][0] + v[rest[1]][0], v[rest[0]][1] + v[rest[1]][1]);
            const l2 = (Math.hypot(...v[rest[0]]) + Math.hypot(...v[rest[1]])) / 2;
            if (s2 < 0.25 * l2) {
              pairA = [a, b];
              pairB = rest;
              break;
            }
          }
        }
      }
      if (!pairB) return null;
      const A = v[pairA[0]];
      const B = v[pairB[0]];
      const cosAB = (A[0] * B[0] + A[1] * B[1]) / (Math.hypot(...A) * Math.hypot(...B));
      if (Math.abs(cosAB) > 0.75) return null; // (not a grid cross)
      const pol0 = polarity(smooth, w, h, p0, A, B);
      if (!pol0) return null;
      // the four neighbours are checker corners too, of the other colour
      for (const k of [pairA[0], pairA[1], pairB[0], pairB[1]]) {
        if (polarity(smooth, w, h, pts[nb[k].q], A, B) !== -pol0) return null;
      }
      const grid = new Map([["0,0", seed]]);
      const used = new Set([seed]);
      grid.set("1,0", nb[pairA[0]].q);
      grid.set("-1,0", nb[pairA[1]].q);
      grid.set("0,1", nb[pairB[0]].q);
      grid.set("0,-1", nb[pairB[1]].q);
      [...grid.values()].forEach((k) => used.add(k));
      const P = (i, j) => (grid.has(`${i},${j}`) ? pts[grid.get(`${i},${j}`)] : null);
      const queue = [[1, 0], [-1, 0], [0, 1], [0, -1], [0, 0]];
      let guard = 0;
      while (queue.length && guard++ < 2000) {
        const [i, j] = queue.shift();
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ti = i + di;
          const tj = j + dj;
          if (grid.has(`${ti},${tj}`)) continue;
          const here = P(i, j);
          // the prediction: straight on from the last two, else the neighbouring row's step
          let pred = null;
          let step = null;
          const back = P(i - di, j - dj);
          if (back) {
            pred = [2 * here.x - back.x, 2 * here.y - back.y];
            step = Math.hypot(here.x - back.x, here.y - back.y);
          } else {
            for (const [pi, pj] of [[dj, di], [-dj, -di]]) {
              const s0 = P(i + pi, j + pj);
              const s1 = P(i + pi + di, j + pj + dj);
              if (s0 && s1) {
                pred = [here.x + s1.x - s0.x, here.y + s1.y - s0.y];
                step = Math.hypot(s1.x - s0.x, s1.y - s0.y);
                break;
              }
            }
          }
          if (!pred) continue;
          const k = nearest(pred[0], pred[1], 0.3 * step, used);
          if (k < 0) continue;
          // the checker pattern, with the colour that fits (i, j): its grid
          // steps toward +i and +j, from whichever neighbours are known
          const q = pts[k];
          const stepTo = (si, sj, fallback) => {
            const prev = P(ti - si, tj - sj);
            if (prev) return [q.x - prev.x, q.y - prev.y];
            const next = P(ti + si, tj + sj);
            if (next) return [next.x - q.x, next.y - q.y];
            return fallback;
          };
          const ga = stepTo(1, 0, A);
          const gb = stepTo(0, 1, B);
          const pol = polarity(smooth, w, h, q, ga, gb);
          if (pol !== pol0 * ((ti + tj) % 2 === 0 ? 1 : -1)) continue;
          grid.set(`${ti},${tj}`, k);
          used.add(k);
          queue.push([ti, tj]);
        }
      }
      // each corner halfway between its neighbours along a grid line (within
      // a fifth of a step), else it's out -- twice (one out can show up
      // another)
      for (let round = 0; round < 2; round++) {
        const out = [];
        grid.forEach((k, key) => {
          const [i, j] = key.split(",").map(Number);
          const q = pts[k];
          for (const [di, dj] of [[1, 0], [0, 1]]) {
            const a = P(i - di, j - dj);
            const b = P(i + di, j + dj);
            if (!a || !b) continue;
            const step = Math.hypot(b.x - a.x, b.y - a.y) / 2;
            if (Math.hypot(q.x - (a.x + b.x) / 2, q.y - (a.y + b.y) / 2) > 0.2 * step) {
              out.push(key);
              return;
            }
          }
        });
        if (!out.length) break;
        out.forEach((key) => grid.delete(key));
      }
      if (grid.size < 9) return null;
      // a grid bigger than the board is a misstep
      const is = [...grid.keys()].map((s) => +s.split(",")[0]);
      const js = [...grid.keys()].map((s) => +s.split(",")[1]);
      const spanI = Math.max(...is) - Math.min(...is) + 1;
      const spanJ = Math.max(...js) - Math.min(...js) + 1;
      const big = Math.max(opts.maxCols || 99, opts.maxRows || 99);
      if (spanI > big || spanJ > big) return null;
      return grid;
    }
  }

  Lynx.camcalChecker = { find, candidates };
})(window.Lynx);
