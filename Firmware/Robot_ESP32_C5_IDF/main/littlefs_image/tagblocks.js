// Real blocks on the floor, found by their AprilTags: 40 mm cubes with a
// 30 mm tag36h11 tag on one or more faces (sizes configurable). A map of
// them in the robot's odometry frame, for games that put virtual things on
// and around real ones (game_knightblocks.js).
//
// Every ~120 ms a frame of the camera stream (CORS mode, see
// Lynx.cam.enableCors) goes to apriltag_worker.js. Each tag found: its four
// corners are undistorted with the lens calibration (Lynx.lens -- the C
// library's own pose ignores the barrel distortion), a homography from the
// tag's square gives its pose in the camera, and the camera's pose when the
// frame was shown (ar.pose, already delayed to match the video; pan, tilt,
// height) puts it in the world. A tag is on a block's top (its normal points
// up) or on a side (horizontal normal): the block's center is half a block
// behind the tag, its height snapped to a stacking level (bottom at 0, 4,
// 8 cm...), its heading the face's normal (or the tag's edge, on top) modulo
// 90 degrees -- a cube looks the same every quarter turn.
//
// The map: tags seen near each other at the same level are one block (any
// faces), averaged over observations; a tag seen far from its block, three
// times in agreement, means the block was moved, and the whole block goes
// there (one stray observation doesn't move it). A block counts once seen
// twice (one-off false detections don't). Blocks don't float: one seen up a
// level stands on blocks below, which are inferred if not seen themselves.
// Nothing is forgotten on its own -- clear() (a rescan) starts over.
//
// Lynx.tagBlocks(ar, {tagMm, blockMm}) -> {start(), stop(), clear(), blocks()
//   -> [{id, x, y, yaw, level, h0, h1, half, inferred, n, seen}], state
//   {ready, error, fps, detectMs, tags, lastDetections}}

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const INTERVAL_MS = 120;
  const MAX_RANGE_M = 1.0;
  const MIN_SIDE_PX = 10; // smaller tags give poses too rough to use
  const CONFIRM_N = 2;
  const MOVE_N = 3; // a block counts as moved after this many sightings elsewhere (in agreement)
  const MAX_TURN_RAD_S = 0.6; // pictures taken while the camera turns faster are skipped (blur, lag)
  const FORGET_UNCONFIRMED_MS = 3000;

  // 4-point homography (model X, Y -> image x, y), h33 = 1: 8 x 8 linear solve.
  function homography(model, img) {
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const [X, Y] = model[i];
      const [x, y] = img[i];
      A.push([X, Y, 1, 0, 0, 0, -x * X, -x * Y]);
      b.push(x);
      A.push([0, 0, 0, X, Y, 1, -y * X, -y * Y]);
      b.push(y);
    }
    const n = 8;
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
      if (Math.abs(A[p][c]) < 1e-12) return null;
      [A[c], A[p]] = [A[p], A[c]];
      [b[c], b[p]] = [b[p], b[c]];
      for (let r = 0; r < n; r++) {
        if (r === c) continue;
        const k = A[r][c] / A[c][c];
        for (let j = c; j < n; j++) A[r][j] -= k * A[c][j];
        b[r] -= k * b[c];
      }
    }
    const h = b.map((v, i) => v / A[i][i]);
    return [[h[0], h[1], h[2]], [h[3], h[4], h[5]], [h[6], h[7], 1]];
  }
  const norm3 = (v) => {
    const l = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / l, v[1] / l, v[2] / l];
  };
  const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const QUARTER = Math.PI / 2;
  const modQuarter = (a) => {
    let m = a % QUARTER;
    if (m < -QUARTER / 2) m += QUARTER;
    if (m >= QUARTER / 2) m -= QUARTER;
    return m;
  };

  // A tag's pose in the camera frame (x right, y down, z forward) from its
  // image corners: {t (center), r1, r2 (its edges' directions), n (normal,
  // toward the camera)}; null if implausible.
  function tagPose(corners, w, h, tagM) {
    const { f } = Lynx.lens.params(w, h);
    const undistort = (p) => {
      const dx = p.x - w / 2;
      const dy = p.y - h / 2;
      const rp = Math.hypot(dx, dy);
      if (rp < 1e-9) return [0, 0];
      const rn = Math.tan(Lynx.lens.angleAt(rp, w, h)); // radius on the pinhole image plane at z = 1
      return [(dx / rp) * rn, (dy / rp) * rn];
    };
    const s = tagM / 2;
    const model = [[-s, s], [s, s], [s, -s], [-s, -s]];
    const H = homography(model, corners.map(undistort));
    if (!H) return null;
    const h1 = [H[0][0], H[1][0], H[2][0]];
    const h2 = [H[0][1], H[1][1], H[2][1]];
    const h3 = [H[0][2], H[1][2], H[2][2]];
    const l1 = Math.hypot(...h1);
    const l2 = Math.hypot(...h2);
    if (l1 / l2 > 1.6 || l2 / l1 > 1.6) return null; // too foreshortened to trust
    let lambda = 2 / (l1 + l2);
    if (h3[2] * lambda < 0) lambda = -lambda;
    const r1 = norm3(h1.map((v) => v * lambda));
    const r2raw = h2.map((v) => v * lambda);
    const r2 = norm3(r2raw.map((v, i) => v - dot3(r1, r2raw) * r1[i]));
    const t = h3.map((v) => v * lambda);
    let n = cross3(r1, r2);
    if (dot3(n, t) > 0) n = n.map((v) => -v); // the side facing the camera
    return { t, r1, r2, n };
  }

  Lynx.tagBlocks = (ar, opts = {}) => {
    const TAG = (opts.tagMm || 30) / 1000;
    const BLOCK = (opts.blockMm || 40) / 1000;
    const HALF = BLOCK / 2;
    const state = { ready: false, error: null, fps: 0, detectMs: 0, tags: 0, lastDetections: [] };
    const blocks = new Map(); // id -> block
    const tagToBlock = new Map();
    let nextId = 1;
    let worker = null;
    let timer = null;
    let busy = false;
    let pending = null;
    let frameId = 0;
    let lastDone = 0;
    let lastSnap = null;
    const canvas = document.createElement("canvas");
    const g = canvas.getContext("2d", { willReadFrequently: true });
    const img = document.getElementById("camStream");

    function start() {
      if (worker) return;
      if (Lynx.cam && Lynx.cam.enableCors) Lynx.cam.enableCors();
      state.error = null;
      worker = new Worker("apriltag_worker.js");
      worker.onmessage = onMessage;
      worker.onerror = (e) => (state.error = `AprilTag worker failed${e && e.message ? ": " + e.message : ""}`);
      timer = setInterval(grab, INTERVAL_MS);
    }
    function stop() {
      clearInterval(timer);
      timer = null;
      if (worker) worker.terminate();
      worker = null;
      busy = false;
      state.ready = false;
    }

    function grab() {
      if (!state.ready || busy || !img || !img.naturalWidth || !ar.view) return;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      let data;
      try {
        g.drawImage(img, 0, 0);
        data = g.getImageData(0, 0, w, h);
      } catch (e) {
        state.error = "Can't read the camera picture (CORS) -- waiting for the stream to reconnect";
        return;
      }
      // the camera as it was for this picture (ar.pose is delayed to match the video)
      const cw = ar.cameraWorld();
      const snap = { x: cw.x, y: cw.y, h: cw.h, th: ar.camTheta, tilt: ar.tilt, w, hgt: h, t: performance.now() };
      const prev = lastSnap;
      lastSnap = snap;
      if (prev) {
        const dt = (snap.t - prev.t) / 1000;
        const turn = Math.abs(Math.atan2(Math.sin(snap.th - prev.th), Math.cos(snap.th - prev.th))) + Math.abs(snap.tilt - prev.tilt);
        if (dt > 0 && turn / dt > MAX_TURN_RAD_S) return; // turning: wait for a steadier picture
      }
      busy = true;
      pending = { id: ++frameId, snap };
      worker.postMessage({ type: "frame", id: frameId, width: w, height: h, rgba: data.data.buffer }, [data.data.buffer]);
    }

    function onMessage(ev) {
      const m = ev.data;
      if (m.type === "ready") {
        state.ready = true;
        state.error = null;
        return;
      }
      if (m.type === "error") {
        state.error = m.message;
        return;
      }
      if (m.type !== "detections") return;
      busy = false;
      if (!pending || m.id !== pending.id) return;
      const now = performance.now();
      if (lastDone) state.fps = 0.8 * state.fps + 0.2 * (1000 / Math.max(1, now - lastDone));
      lastDone = now;
      state.detectMs = 0.8 * state.detectMs + 0.2 * m.ms;
      state.tags = m.detections.length;
      state.lastDetections = m.detections.map((d) => ({ id: d.id, corners: d.corners, w: pending.snap.w, h: pending.snap.hgt, at: now }));
      m.detections.forEach((d) => {
        const o = observe(d, pending.snap);
        if (o) add(o, d.id, now);
      });
      // one-offs that never got a second look
      for (const [id, b] of blocks) {
        if (b.n < CONFIRM_N && now - b.seen > FORGET_UNCONFIRMED_MS) {
          blocks.delete(id);
          b.tags.forEach((t) => tagToBlock.get(t) === id && tagToBlock.delete(t));
        }
      }
    }

    // A detection -> a block observation {x, y, level, yaw, face} (world), or null.
    function observe(d, snap) {
      const c = d.corners.map((p) => [p.x, p.y]);
      let minSide = Infinity;
      for (let i = 0; i < 4; i++) minSide = Math.min(minSide, Math.hypot(c[i][0] - c[(i + 1) % 4][0], c[i][1] - c[(i + 1) % 4][1]));
      if (minSide < MIN_SIDE_PX) return null;
      const p = tagPose(d.corners, snap.w, snap.hgt, TAG);
      if (!p || Math.hypot(...p.t) > MAX_RANGE_M) return null;
      // camera frame -> world (x, y on the floor, z up)
      const ct = Math.cos(snap.tilt);
      const st = Math.sin(snap.tilt);
      const cth = Math.cos(snap.th);
      const sth = Math.sin(snap.th);
      const dir = (v) => {
        const fwd = v[2] * ct - v[1] * st;
        const down = v[2] * st + v[1] * ct;
        return [fwd * cth + v[0] * sth, fwd * sth - v[0] * cth, -down];
      };
      const tw = dir(p.t);
      const pos = [snap.x + tw[0], snap.y + tw[1], snap.h + tw[2]];
      const nw = dir(p.n);
      let x;
      let y;
      let ch;
      let yaw;
      let face;
      if (nw[2] > 0.75) {
        face = "top";
        x = pos[0];
        y = pos[1];
        ch = pos[2] - HALF;
        const e = dir(p.r1);
        yaw = Math.atan2(e[1], e[0]);
      } else if (Math.abs(nw[2]) < 0.5) {
        face = "side";
        const l = Math.hypot(nw[0], nw[1]);
        const ux = nw[0] / l;
        const uy = nw[1] / l;
        x = pos[0] - ux * HALF;
        y = pos[1] - uy * HALF;
        ch = pos[2];
        yaw = Math.atan2(uy, ux);
      } else return null; // neither: a bad pose
      const level = Math.round((ch - HALF) / BLOCK);
      if (level < 0 || level > 5 || Math.abs(ch - (HALF + level * BLOCK)) > 0.4 * BLOCK) return null;
      return { x, y, level, yaw: modQuarter(yaw), face, rawH: ch };
    }

    function add(o, tagId, now) {
      let b = tagToBlock.has(tagId) ? blocks.get(tagToBlock.get(tagId)) : null;
      if (b && (b.level !== o.level || Math.hypot(b.x - o.x, b.y - o.y) > 0.03)) {
        // seen elsewhere: moved? (only once it's seen there a few times in agreement)
        const m = b.move;
        if (m && m.level === o.level && Math.hypot(m.x - o.x, m.y - o.y) < 0.02) m.n++;
        else b.move = { x: o.x, y: o.y, level: o.level, n: 1 };
        if (b.move.n < MOVE_N) return;
        Object.assign(b, { x: o.x, y: o.y, level: o.level, yaw: o.yaw, n: 1, moved: now, move: null });
      } else if (!b) {
        // another face of a block we know?
        let best = null;
        let bestD = HALF * 1.25;
        for (const k of blocks.values()) {
          const dd = Math.hypot(k.x - o.x, k.y - o.y);
          if (k.level === o.level && dd < bestD) {
            best = k;
            bestD = dd;
          }
        }
        b = best;
        if (!b) {
          b = { id: nextId++, x: o.x, y: o.y, level: o.level, yaw: o.yaw, n: 0, tags: new Set(), seen: now };
          blocks.set(b.id, b);
        }
        b.tags.add(tagId);
        tagToBlock.set(tagId, b.id);
      }
      // a running average (newer counts more once there's a history)
      const a = Math.max(0.15, 1 / (b.n + 1));
      b.x += (o.x - b.x) * a;
      b.y += (o.y - b.y) * a;
      const c4 = (1 - a) * Math.cos(4 * b.yaw) + a * Math.cos(4 * o.yaw);
      const s4 = (1 - a) * Math.sin(4 * b.yaw) + a * Math.sin(4 * o.yaw);
      b.yaw = Math.atan2(s4, c4) / 4;
      b.n++;
      b.seen = now;
      b.move = null;
      // two blocks where there's room for one: the better-known one stays
      for (const k of blocks.values()) {
        if (k === b || k.level !== b.level || Math.hypot(k.x - b.x, k.y - b.y) > BLOCK * 0.7) continue;
        const [keep, drop] = k.n >= b.n ? [k, b] : [b, k];
        drop.tags.forEach((t) => {
          keep.tags.add(t);
          tagToBlock.set(t, keep.id);
        });
        blocks.delete(drop.id);
        if (drop === b) break;
      }
    }

    function list() {
      const out = [];
      for (const b of blocks.values()) {
        if (b.n < CONFIRM_N) continue;
        out.push({ id: b.id, x: b.x, y: b.y, yaw: b.yaw, level: b.level, h0: b.level * BLOCK, h1: (b.level + 1) * BLOCK, half: HALF, inferred: false, n: b.n, seen: b.seen, tags: [...b.tags] });
      }
      // what the ones up a level stand on
      const real = out.slice();
      real.forEach((b) => {
        for (let k = 0; k < b.level; k++) {
          if (out.some((o) => o.level === k && Math.hypot(o.x - b.x, o.y - b.y) < BLOCK * 0.75)) continue;
          out.push({ ...b, id: `${b.id}.${k}`, level: k, h0: k * BLOCK, h1: (k + 1) * BLOCK, inferred: true, tags: [] });
        }
      });
      return out;
    }

    function clear() {
      blocks.clear();
      tagToBlock.clear();
    }

    return { start, stop, clear, blocks: list, state, BLOCK, TAG, observeForTest: observe, tagPose };
  };
  Lynx.tagMath = { homography, tagPose };
})(window.Lynx);
