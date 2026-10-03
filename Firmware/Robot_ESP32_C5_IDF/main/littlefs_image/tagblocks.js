// Real blocks on the floor, found by their AprilTags (tag16h5 or tag36h11):
// cubes with a tag on one or more faces, the tag a fixed share of the face
// (75% by default) -- the same tag on all of a cube's faces, or different
// ones. A map of them in the robot's odometry frame, for games that put
// virtual things on and around real ones (game_knightblocks.js).
//
// Every ~120 ms a frame of the camera stream (CORS mode, see
// Lynx.cam.enableCors) goes to tag_worker.js. Each tag found: its four
// corners are undistorted with the lens calibration (Lynx.lens -- the C
// library's own pose ignores the barrel distortion), and a homography from
// the tag's square gives its pose in the camera -- at unit size: a picture
// alone can't tell a small near tag from a big far one. The camera's pose
// when the frame was shown (ar.pose, already delayed to match the video;
// pan, tilt, height) puts it in the world.
//
// Block sizes: blocks come in sizes, each tag ID on blocks of one size,
// rounded to whole cm. A block on the floor has its side tags' centers half
// a block up and its top tag a whole block up, which fixes the scale given
// the camera's height -- each such sighting is a vote for its ID's size, and
// the most-voted size counts.
//
// A tag is on a block's top (its normal points up) or on a side (horizontal
// normal): the block's center is half a block behind the tag, at the height
// it's seen at (the camera's height and tilt calibration needn't be perfect;
// a block drawn where it's seen lines up with the video), with a stacking
// level (0 on the floor, 1 on a block...) from the nearest multiple of its
// size; its heading the face's normal (or the tag's edge, on top) modulo 90
// degrees -- a cube looks the same every quarter turn.
//
// The map learns only from pictures taken with the camera still (robot,
// pan and tilt unchanged for STILL_MS, as shown with the video): no blur,
// no lag between picture and pose. Per tag ID: one block, unless one picture
// shows that tag on cubes apart from each other (the faces of one cube
// agree on its center) -- how many is the most seen at once. A sighting
// near one of its tag's blocks updates it (averaged); elsewhere, it's a new
// cube with that tag if there are more than the map has, else one of them
// moved there (at once if it's known to be gone, else once seen there
// MOVE_N times, or once clearly). A block that should be in plain view in
// a still picture -- a tag face turned to the camera, big enough, inside
// the picture, not behind another block -- but whose tag isn't seen there
// MISS_N pictures running is gone from there (moved or taken away) until
// its tag turns up again. One face is enough for a whole cube, and one
// clear sighting (a faint one needs a second: stray quads decode as
// tag16h5 tags now and then, with low margins). Blocks don't float: one up a
// level stands on blocks below, which are inferred if not seen themselves.
// clear() (a rescan) starts over.
//
// Lynx.tagBlocks(ar, {family, tagRatio}) -> {start(), stop(), clear(), blocks()
//   -> [{id, tag, x, y, yaw, level, h0, h1, half, inferred, n, seen}], state
//   {ready, error, fps, detectMs, tags, stable, lastDetections, ids: [{id, cm, sure, count}]}}

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const INTERVAL_MS = 120;
  const MAX_RANGE_M = 1.0;
  const MIN_SIDE_PX = 10; // smaller tags give poses too rough to use
  const MIN_FACING_COS = 0.5; // tags seen more than 60 degrees off-axis are skipped
  const CONFIRM_N = 2; // sightings for a block from weak detections...
  const STRONG_MARGIN = 40; // ...one is enough with a decision margin this good (or a tag36h11 tag)
  const MOVE_N = 2; // a block counts as moved after this many sightings elsewhere (in agreement)
  const MISS_N = 4; // still pictures running without a block that should be in them: it's gone
  const STILL_MS = 400; // the camera counts as still after this long without moving...
  const STILL_M = 0.003; // ...more than this
  const STILL_RAD = 0.01; // ...or turning / tilting more than this (0.6 deg)
  const MIN_CM = 1; // block sizes
  const MAX_CM = 20;
  const MAX_VOTES = 40; // size votes per tag ID (enough to settle it)
  const FORGET_UNCONFIRMED_MS = 10000;

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
    // seen too nearly edge-on, the pose is a guess (a cube's face 60+ degrees
    // off-axis can come out centimetres off); its other faces do better
    if (-dot3(n, t) / Math.hypot(...t) < MIN_FACING_COS) return null;
    return { t, r1, r2, n };
  }

  Lynx.tagBlocks = (ar, opts = {}) => {
    const RATIO = Math.min(0.95, Math.max(0.3, opts.tagRatio || 0.75)); // tag / block face
    const state = { ready: false, error: null, fps: 0, detectMs: 0, tags: 0, stable: false, lastDetections: [], ids: [] };
    const ids = new Map(); // tag id -> {id, votes: Map(cm -> n), cm, count, blocks: [block]}
    let nextUid = 1;
    let worker = null;
    let timer = null;
    let busy = false;
    let pending = null;
    let frameId = 0;
    let lastDone = 0;
    const history = []; // recent camera snapshots (for stillness)
    const canvas = document.createElement("canvas");
    const g = canvas.getContext("2d", { willReadFrequently: true });
    const img = document.getElementById("camStream");

    function start() {
      if (worker) return;
      if (Lynx.cam && Lynx.cam.enableCors) Lynx.cam.enableCors();
      state.error = null;
      worker = new Worker("tag_worker.js");
      worker.onmessage = onMessage;
      worker.postMessage({ type: "family", family: opts.family || "tag16h5" });
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

    // Still: the camera's pose (as shown with this picture) hasn't changed for STILL_MS.
    function still(snap) {
      history.push(snap);
      while (history.length && history[0].t < snap.t - 2 * STILL_MS) history.shift();
      if (!history.length || snap.t - history[0].t < STILL_MS) return false;
      const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
      return history.every(
        (o) => o.t < snap.t - STILL_MS - INTERVAL_MS ||
          (Math.hypot(o.x - snap.x, o.y - snap.y) < STILL_M && Math.abs(wrap(o.th - snap.th)) < STILL_RAD && Math.abs(o.tilt - snap.tilt) < STILL_RAD),
      );
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
      snap.still = still(snap);
      state.stable = snap.still;
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
      // the map only learns from pictures taken with the camera still (no blur, no lag)
      if (pending.snap.still) integrate(m.detections, pending.snap, now);
      // faint one-offs that never got a second look
      for (const info of ids.values()) info.blocks = info.blocks.filter((b) => b.ok || now - b.seen < FORGET_UNCONFIRMED_MS);
      state.ids = [...ids.values()].filter((i) => i.cm || i.guess).map((i) => ({ id: i.id, cm: i.cm || i.guess, sure: !!i.cm, count: i.count }));
    }

    function info(id) {
      if (!ids.has(id)) ids.set(id, { id, votes: new Map(), cm: 0, count: 0, blocks: [] });
      return ids.get(id);
    }

    // camera frame (x right, y down, z forward) -> world direction, and back
    function frames(snap) {
      const ct = Math.cos(snap.tilt);
      const st = Math.sin(snap.tilt);
      const cth = Math.cos(snap.th);
      const sth = Math.sin(snap.th);
      return {
        toWorld(v) {
          const fwd = v[2] * ct - v[1] * st;
          const down = v[2] * st + v[1] * ct;
          return [fwd * cth + v[0] * sth, fwd * sth - v[0] * cth, -down];
        },
        toCam(p) {
          const dx = p[0] - snap.x;
          const dy = p[1] - snap.y;
          const fwd = dx * cth + dy * sth;
          const down = snap.h - p[2];
          return [dx * sth - dy * cth, -fwd * st + down * ct, fwd * ct + down * st];
        },
      };
    }

    // A detection -> a block observation {id, x, y, h, level, yaw, face, B
    // (block size, m), strong} (world), or null. The tag's pose is found at
    // unit size first; the scale comes from its tag ID's block size, voted
    // for here by sightings of blocks on the floor.
    function observe(d, snap) {
      const c = d.corners.map((p) => [p.x, p.y]);
      let minSide = Infinity;
      for (let i = 0; i < 4; i++) minSide = Math.min(minSide, Math.hypot(c[i][0] - c[(i + 1) % 4][0], c[i][1] - c[(i + 1) % 4][1]));
      if (minSide < MIN_SIDE_PX) return null;
      const p = tagPose(d.corners, snap.w, snap.hgt, 1);
      if (!p) return null;
      const F = frames(snap);
      const tu = F.toWorld(p.t); // where the tag's center is, per metre of tag size
      const nw = F.toWorld(p.n);
      let face;
      if (nw[2] > 0.75) face = "top";
      else if (Math.abs(nw[2]) < 0.5) face = "side";
      else return null; // neither: a bad pose
      // Block size if the block stands on the floor: the tag's center is
      // then half a block up (side) or a whole block (top), and it's at
      // camera height + scale x tu[2].
      const up = face === "top" ? 1 : 0.5;
      const scale0 = snap.h / (up / RATIO - tu[2]);
      const cm0 = Math.round((scale0 / RATIO) * 100);
      const I = info(d.id);
      if (!I.cm && cm0 >= MIN_CM && cm0 <= MAX_CM) I.guess = cm0; // (until a block on the floor settles it)
      const cm = I.cm || cm0;
      if (!(cm >= MIN_CM && cm <= MAX_CM)) return null;
      const B = cm / 100;
      const s = B * RATIO;
      if (Math.hypot(...p.t) * s > MAX_RANGE_M) return null;
      const pos = [snap.x + tu[0] * s, snap.y + tu[1] * s, snap.h + tu[2] * s];
      const half = B / 2;
      let x;
      let y;
      let ch;
      let yaw;
      if (face === "top") {
        x = pos[0];
        y = pos[1];
        ch = pos[2] - half;
        const e = F.toWorld(p.r1);
        yaw = Math.atan2(e[1], e[0]);
      } else {
        const l = Math.hypot(nw[0], nw[1]);
        const ux = nw[0] / l;
        const uy = nw[1] / l;
        x = pos[0] - ux * half;
        y = pos[1] - uy * half;
        ch = pos[2];
        yaw = Math.atan2(uy, ux);
      }
      const level = Math.round((ch - half) / B);
      if (level < 0 || level > 5 || Math.abs(ch - (half + level * B)) > 0.45 * B) return null;
      // a vote for this ID's size: only from blocks on the floor (that's what the estimate assumes)
      const vote = cm0 >= MIN_CM && cm0 <= MAX_CM && level === 0 ? cm0 : 0;
      return { id: d.id, x, y, h: ch, level, yaw: modQuarter(yaw), face, B, vote, strong: typeof d.margin !== "number" || d.margin >= STRONG_MARGIN };
    }

    const near = (b, o, B, k = 0.75) => Math.hypot(b.x - o.x, b.y - o.y) < k * B && Math.abs(b.h - o.h) < 0.5 * B;

    // One still picture's sightings into the map.
    function integrate(dets, snap, now) {
      const obs = dets.map((d) => observe(d, snap)).filter(Boolean);
      // size votes first (a size change restarts that ID's averages)
      obs.forEach((o) => {
        if (!o.vote) return;
        const I = info(o.id);
        if (I.votesN >= MAX_VOTES) return;
        I.votesN = (I.votesN || 0) + 1;
        I.votes.set(o.vote, (I.votes.get(o.vote) || 0) + 1);
        let best = I.cm;
        for (const [cm, n] of I.votes) if (!best || n > (I.votes.get(best) || 0)) best = cm;
        if (best !== I.cm) {
          if (I.cm) I.blocks.forEach((b) => (b.n = 0)); // positions were scaled for the old size
          I.cm = best;
        }
      });
      const seen = new Set(); // blocks sighted in this picture
      const byId = new Map();
      obs.forEach((o) => (byId.has(o.id) ? byId.get(o.id).push(o) : byId.set(o.id, [o])));
      for (const [id, list] of byId) {
        const I = info(id);
        const B = (I.cm || Math.round(list[0].B * 100)) / 100;
        // the faces seen of one cube agree on its center: one cluster per cube
        const clusters = [];
        list.forEach((o) => {
          const c = clusters.find((k) => near(k[0], o, B, 0.6));
          if (c) c.push(o);
          else clusters.push([o]);
        });
        I.count = Math.max(I.count, clusters.length); // cubes with this tag seen at once
        const free = I.blocks.slice();
        const later = [];
        clusters.forEach((c) => {
          // the block it was last seen as, if it's (still) there
          let best = null;
          let bestD = Infinity;
          free.forEach((b) => {
            const dd = Math.hypot(b.x - c[0].x, b.y - c[0].y);
            if (b.present && near(b, c[0], B) && dd < bestD) {
              best = b;
              bestD = dd;
            }
          });
          if (!best) {
            later.push(c);
            return;
          }
          free.splice(free.indexOf(best), 1);
          c.forEach((o) => update(best, o, now));
          seen.add(best);
        });
        later.forEach((c) => {
          if (I.blocks.length < I.count) {
            // another cube with this tag
            const b = { uid: nextUid++, id, x: c[0].x, y: c[0].y, h: c[0].h, level: c[0].level, yaw: c[0].yaw, n: 0, ok: false, present: true, miss: 0, seen: now };
            I.blocks.push(b);
            c.forEach((o) => update(b, o, now));
            seen.add(b);
            return;
          }
          // one of this tag's blocks moved here: one that's gone from where it
          // was first, else one not seen in this picture (once confirmed)
          const cand = free.find((b) => !b.present) || free[0];
          if (!cand) return;
          free.splice(free.indexOf(cand), 1);
          const o = c[0];
          const mv = cand.move;
          if (mv && mv.level === o.level && Math.hypot(mv.x - o.x, mv.y - o.y) < 0.4 * B) mv.n++;
          else cand.move = { x: o.x, y: o.y, level: o.level, n: 1 };
          if (!cand.present || o.strong || cand.move.n >= MOVE_N) {
            Object.assign(cand, { x: o.x, y: o.y, h: o.h, level: o.level, yaw: o.yaw, n: 0, present: true, miss: 0, move: null });
            c.forEach((oo) => update(cand, oo, now));
            seen.add(cand);
          }
        });
      }
      // Gone: a block that should be in plain view in this still picture,
      // but whose tag isn't seen there, MISS_N pictures running -- moved
      // (or taken away). Its tag seen anywhere brings it back there.
      for (const I of ids.values()) {
        const B = (I.cm || I.guess || 0) / 100;
        I.blocks.forEach((b) => {
          if (seen.has(b)) {
            b.miss = 0;
            return;
          }
          if (!b.present || !b.ok || !B) return;
          if (expectVisible(b, B, snap)) {
            b.miss++;
            if (b.miss >= MISS_N) {
              b.present = false;
              b.move = null;
            }
          }
        });
      }
      // two blocks where there's room for one (different tags): the better-known one stays
      const all = present();
      all.forEach((a) =>
        all.forEach((b) => {
          if (a === b || !a.present || !b.present || a.level !== b.level) return;
          const B = Math.min(a.B, b.B);
          if (Math.hypot(a.x - b.x, a.y - b.y) > 0.7 * B) return;
          (a.n >= b.n ? b : a).present = false;
        }),
      );
    }

    function update(b, o, now) {
      const a = Math.max(0.15, 1 / (b.n + 1)); // a running average (newer counts more once there's a history)
      b.x += (o.x - b.x) * a;
      b.y += (o.y - b.y) * a;
      b.h += (o.h - b.h) * a; // the center's height, as seen
      b.level = o.level;
      const c4 = (1 - a) * Math.cos(4 * b.yaw) + a * Math.cos(4 * o.yaw);
      const s4 = (1 - a) * Math.sin(4 * b.yaw) + a * Math.sin(4 * o.yaw);
      b.yaw = Math.atan2(s4, c4) / 4;
      b.n++;
      b.ok = b.ok || o.strong || b.n >= CONFIRM_N;
      b.seen = now;
      b.present = true;
      b.move = null;
    }

    function present() {
      const out = [];
      for (const I of ids.values()) {
        const cm = I.cm || I.guess;
        if (!cm) continue;
        I.blocks.forEach((b) => {
          if (b.present && b.ok) {
            b.B = cm / 100;
            out.push(b);
          }
        });
      }
      return out;
    }

    // Would this block's tag be found in this picture? Some face with a tag
    // turned toward the camera (well within what's detected), big enough,
    // inside the picture, in range, and not behind another block.
    function expectVisible(b, B, snap) {
      const F = frames(snap);
      const half = B / 2;
      const tag = B * RATIO;
      const others = present().filter((o) => o !== b);
      const normals = [[0, 0, 1]];
      for (let k = 0; k < 4; k++) normals.push([Math.cos(b.yaw + k * QUARTER), Math.sin(b.yaw + k * QUARTER), 0]);
      return normals.some((n) => {
        const fc = [b.x + n[0] * half, b.y + n[1] * half, b.h + n[2] * half];
        const v = [fc[0] - snap.x, fc[1] - snap.y, fc[2] - snap.h];
        const dist = Math.hypot(...v);
        if (dist > MAX_RANGE_M * 0.9 || dist < 0.05) return false;
        const facing = -dot3(n, v) / dist;
        if (facing < 0.65) return false;
        const cc = F.toCam(fc);
        const pr = Lynx.lens.project(cc[0], cc[1], cc[2], snap.w, snap.hgt);
        if (!pr) return false;
        const px = (pr.scale * tag * Math.sqrt(facing)) / cc[2];
        if (px < 2 * MIN_SIDE_PX) return false;
        const m = px * 0.7 + 6;
        if (pr.u < m || pr.v < m || pr.u > snap.w - m || pr.v > snap.hgt - m) return false;
        // nothing (no other block, nor a block standing on this face) between it and the camera
        const p = [fc[0] + n[0] * 0.003, fc[1] + n[1] * 0.003, fc[2] + n[2] * 0.003];
        return !others.some((o) => segmentHitsBlock([snap.x, snap.y, snap.h], p, o));
      });
    }
    function segmentHitsBlock(a, p, o) {
      const c = Math.cos(o.yaw);
      const s = Math.sin(o.yaw);
      const loc = (q) => [(q[0] - o.x) * c + (q[1] - o.y) * s, -(q[0] - o.x) * s + (q[1] - o.y) * c, q[2] - o.h];
      const A = loc(a);
      const P = loc(p);
      const hb = o.B / 2;
      let t0 = 0;
      let t1 = 1;
      for (let i = 0; i < 3; i++) {
        const d = P[i] - A[i];
        if (Math.abs(d) < 1e-9) {
          if (A[i] < -hb || A[i] > hb) return false;
          continue;
        }
        let ta = (-hb - A[i]) / d;
        let tb = (hb - A[i]) / d;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1) return false;
      }
      return true;
    }

    function list() {
      const out = present().map((b) => ({
        id: b.uid, tag: b.id, x: b.x, y: b.y, yaw: b.yaw, level: b.level, h0: b.h - b.B / 2, h1: b.h + b.B / 2, half: b.B / 2,
        inferred: false, n: b.n, seen: b.seen,
      }));
      // what the ones up a level stand on: right under them, a block lower each (as big, presumably)
      const real = out.slice();
      real.forEach((b) => {
        const B = 2 * b.half;
        for (let k = 0; k < b.level; k++) {
          if (out.some((o) => o.level === k && Math.hypot(o.x - b.x, o.y - b.y) < B * 0.75)) continue;
          const down = (b.level - k) * B;
          out.push({ ...b, id: `${b.id}.${k}`, level: k, h0: b.h0 - down, h1: b.h1 - down, inferred: true });
        }
      });
      return out;
    }

    function clear() {
      ids.clear();
      state.ids = [];
    }

    return { start, stop, clear, blocks: list, state, RATIO, observeForTest: observe, tagPose };
  };
  Lynx.tagMath = { homography, tagPose };
})(window.Lynx);
