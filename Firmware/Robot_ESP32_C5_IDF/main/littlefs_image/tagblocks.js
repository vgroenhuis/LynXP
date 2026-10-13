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
// A cube with two or more tagged faces in one still picture is placed by a
// whole-cube fit (fitCube): its x, y and heading -- upright, at its stacking
// level, its size known -- together with the camera's actual tilt, to all
// those tags' corners at once (also a tag seen too edge-on for a pose of
// its own). Measured: a still cube's place repeats to 0.1 mm (12 mm from
// separate tags), and the hobby tilt servo's 1-2 degrees of error -- ~2 cm
// on the floor at 30 cm -- comes out with it: state.tiltFix.
//
// A size set by hand on the Tags page (doc entry "user": 1) beats every
// estimate: running pages pick it up at their next save, and never change it.
//
// Remembered (opts.persist): each tag's size, how many cubes carry it and
// where they were last seen go to the robot's "tags" document (/appdata/tags,
// shown on the Tags page) -- sizes as soon as they're known, places at most
// every SAVE_EVERY_MS. A remembered size counts at once: such a tag's block
// is placed from any one face. opts.fixedSizes ({tag id: cm}) are sizes
// known in advance (the frame cube's tags).
//
// Lynx.tagBlocks(ar, {family, tagRatio, persist, fixedSizes, onStill}) ->
//   {start(), stop(), clear(), blocks() -> [{id, tag, x, y, yaw, level, h0,
//   h1, half, inferred, n, seen}], transform(cx, cy, alpha), pause(ms),
//   state {ready, error, fps, detectMs, tags, stable, lastDetections,
//   ids: [{id, cm, sure, count}]}}
// onStill(observations, snap): every still picture's sightings (world;
// side faces with their outward heading, normalYaw), e.g. for the frame cube.

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
  const SAVE_EVERY_MS = 10000;

  // The robot's "tags" document: {v: 1, tags: {id: {cm, count, at (ms since
  // 1970), blocks: [[x, y, z] (m, world, block centers)]}}}.
  Lynx.tagStore = {
    load: () =>
      fetch("/appdata/tags", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => (d && d.tags ? d : { v: 1, tags: {} }))
        .catch(() => ({ v: 1, tags: {} })),
    save: (doc) => fetch("/appdata/tags", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(doc) }),
  };

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
    const undistort = (p) => Lynx.lens.normalize(p.x, p.y, w, h); // (on the pinhole image plane at z = 1)
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

    // remembered sizes (and fixed ones) count from the start
    let doc = null;
    let savedAt = 0;
    let dirtySizes = false;
    let pausedUntil = 0;
    const fixed = opts.fixedSizes || {};
    // opts.cubes: groups of tags on the faces of one cube (the frame cube's
    // 24-29) -- any of them is a sighting of that one block, filed under the
    // group's first tag
    // (such a cube is the only one: never two blocks for it)
    const alias = new Map();
    const single = new Set();
    (opts.cubes || []).forEach((g) => {
      g.forEach((t) => alias.set(t, g[0]));
      single.add(g[0]);
    });
    Object.keys(fixed).forEach((id) => Object.assign(info(+id), { cm: fixed[id], fixed: true }));
    // (ms since 1970 <-> this page's performance.now())
    const toEpoch = (t) => Math.round(Date.now() - (performance.now() - t));
    const fromEpoch = (ms) => performance.now() - (Date.now() - ms);
    // The user's limit (Tags page): no more cubes with a tag than that -- the
    // ones seen longest ago go first.
    function applyLimit(I) {
      const max = single.has(I.id) ? 1 : I.max;
      if (!max || I.blocks.length <= max) return;
      I.blocks = I.blocks.slice().sort((a, b) => b.seen - a.seen).slice(0, max);
      I.count = Math.min(I.count, max);
    }
    if (opts.persist) {
      Lynx.tagStore.load().then((d) => {
        doc = d;
        Object.entries(d.tags).forEach(([id, t]) => {
          if (alias.has(+id) && alias.get(+id) !== +id) return; // (another one's face: filed under the first)
          const I = info(+id);
          if ((!I.fixed || t.user) && t.cm >= MIN_CM && t.cm <= MAX_CM) Object.assign(I, { cm: t.cm, fixed: true });
          I.max = t.max > 0 ? t.max : 0;
          // its cubes where they were last seen -- not shown until seen again, but
          // a sighting overlapping one of them is that cube (same instance, same count)
          const cm = I.cm;
          if (!cm || I.blocks.length || !Array.isArray(t.blocks)) return;
          const B = cm / 100;
          I.blocks = t.blocks.slice(0, 20).map((b) => ({
            uid: nextUid++, id: +id, x: b[0], y: b[1], h: b[2], level: Math.max(0, Math.round((b[2] - B / 2) / B)), yaw: 0,
            n: 1, ok: true, present: false, miss: 0, seen: b[4] ? fromEpoch(b[4]) : fromEpoch(t.at || 0),
          }));
          I.count = single.has(+id) ? 1 : I.blocks.length; // (a saved count beyond the places known meant nothing)
          applyLimit(I);
        });
      });
    }
    let saving = false;
    function persist(now) {
      if (!opts.persist || !doc || saving) return;
      if (!dirtySizes && now - savedAt < SAVE_EVERY_MS) return;
      savedAt = now;
      const sizesChanged = dirtySizes;
      dirtySizes = false;
      saving = true;
      // the robot's copy first: the Tags page may have set limits, or forgotten tags
      Lynx.tagStore
        .load()
        .then((fresh) => {
          const out = { v: 1, tags: { ...fresh.tags } };
          // tags that are another one's faces (the frame cube's) are filed under the first one only
          alias.forEach((first, t) => t !== first && delete out.tags[t]);
          let changed = sizesChanged;
          for (const I of ids.values()) {
            const old = out.tags[I.id];
            // a size set by hand and then cleared (Tags page): measured again from here on
            if (old && !old.user && !old.cm && I.fixed && !(I.id in fixed)) {
              Object.assign(I, { cm: 0, guess: 0, votes: new Map(), votesN: 0, fixed: false });
              I.blocks.forEach((b) => (b.n = 0));
            }
            // a size set by hand (Tags page) is the size: this page changes to it, and keeps it
            if (old && old.user && old.cm >= MIN_CM && old.cm <= MAX_CM) {
              if (I.cm !== old.cm) I.blocks.forEach((b) => (b.n = 0)); // (positions were scaled for the old size)
              Object.assign(I, { cm: old.cm, fixed: true });
            }
            const cm = I.cm;
            if (!cm) continue;
            I.max = old && old.max > 0 ? old.max : 0;
            applyLimit(I);
            // every cube with this tag, where it was last seen: [x, y, z, here (1) or
            // since found gone from there (0), when (ms since 1970)]
            const known = I.blocks.filter((b) => b.ok);
            const here = known.filter((b) => b.present);
            if (!known.length && !old && !I.count) continue; // (never seen: only a size known in advance)
            const blocks = known.map((b) => [+b.x.toFixed(3), +b.y.toFixed(3), +b.h.toFixed(3), b.present ? 1 : 0, toEpoch(b.seen)]);
            // (the count is the cubes with a known place -- each one listed)
            const t = { cm, count: single.has(I.id) ? 1 : blocks.length, at: here.length ? Date.now() : old ? old.at : Date.now(), blocks };
            if (I.max) t.max = I.max;
            if (old && old.user) t.user = 1;
            const ob = (old && old.blocks) || [];
            // (places count as changed only beyond a cm)
            const moved = ob.length !== blocks.length || blocks.some((b, k) => b[3] !== ob[k][3] || Math.hypot(b[0] - ob[k][0], b[1] - ob[k][1], b[2] - ob[k][2]) > 0.01);
            if (!old || moved || old.cm !== t.cm || old.count !== t.count) {
              changed = true;
              out.tags[I.id] = t;
            }
          }
          doc = out;
          if (changed) return Lynx.tagStore.save(out);
          return null;
        })
        .catch(() => {})
        .then(() => (saving = false));
    }

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
      const snap = { x: cw.x, y: cw.y, h: cw.h, th: ar.camTheta, tilt: ar.tilt, frame: ar.frame, w, hgt: h, t: performance.now() };
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
      if (pending.snap.still && now >= pausedUntil) integrate(m.detections, pending.snap, now);
      persist(now);
      // faint one-offs that never got a second look
      for (const info of ids.values()) info.blocks = info.blocks.filter((b) => b.ok || now - b.seen < FORGET_UNCONFIRMED_MS);
      state.ids = [...ids.values()].filter((i) => i.cm || i.guess).map((i) => ({ id: i.id, cm: i.cm || i.guess, sure: !!i.cm, count: i.count }));
    }

    function info(id) {
      if (!ids.has(id)) ids.set(id, { id, votes: new Map(), cm: 0, count: 0, blocks: [] });
      return ids.get(id);
    }

    // camera frame (x right, y down, z forward) -> world direction, and back
    // camera frame [x right, y down, z ahead] <-> world, as the picture was
    // taken: the full camera model (Lynx.cameraFrame -- lean, rolls; snap.x/y/h
    // is the lens itself, offset included)
    function frames(snap) {
      const F = snap.frame;
      return {
        toWorld(v) {
          return [0, 1, 2].map((k) => v[0] * F.right[k] + v[1] * F.down[k] + v[2] * F.fwd[k]);
        },
        toCam(p) {
          const d = [p[0] - snap.x, p[1] - snap.y, p[2] - snap.h];
          const dot = (a) => d[0] * a[0] + d[1] * a[1] + d[2] * a[2];
          return [dot(F.right), dot(F.down), dot(F.fwd)];
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
      const id = alias.has(d.id) ? alias.get(d.id) : d.id;
      const I = info(id);
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
      return { id, tag: d.id, x, y, h: ch, level, yaw: modQuarter(yaw), normalYaw: face === "side" ? yaw : null, face, B, vote, strong: typeof d.margin !== "number" || d.margin >= STRONG_MARGIN, det: d };
    }

    const near = (b, o, B, k = 0.75) => Math.hypot(b.x - o.x, b.y - o.y) < k * B && Math.abs(b.h - o.h) < 0.5 * B;
    // Two real cubes can't overlap: sightings (or a sighting and a block) of the
    // same tag this close are one and the same cube.
    const OVERLAP = 0.9;
    const FIT_MAX_PX = 2.5; // a whole-cube fit worse than this (RMS) isn't used
    const FIT_MAX_TILT = (5 * Math.PI) / 180; // nor one that needs the camera tilted more than this

    // -- the whole-cube fit -----------------------------------------------------------
    // A cube's tags' corners in the picture for (x, y, yaw) and the camera
    // tilted by dt (rad, up): each tag on a side face (k: which quarter turn
    // from the cube's heading) or the top, its corners in its detection's
    // order (shift, flip: how the tag sits on the face, found once).
    function cubeResiduals(snap, B, zc, faces, q, dt) {
      const F = snap.frame;
      const c = Math.cos(dt);
      const s = Math.sin(dt);
      const fwd = [0, 1, 2].map((k) => F.fwd[k] * c - F.down[k] * s);
      const down = [0, 1, 2].map((k) => F.down[k] * c + F.fwd[k] * s);
      const right = F.right;
      const half = B / 2;
      const ts = (B * RATIO) / 2;
      const cy = Math.cos(q[2]);
      const sy = Math.sin(q[2]);
      const out = [];
      faces.forEach((f) => {
        const n = f.top ? [0, 0, 1] : [Math.cos((f.k * Math.PI) / 2), Math.sin((f.k * Math.PI) / 2), 0];
        const up = f.top ? [1, 0, 0] : [0, 0, 1];
        const a = [n[1] * up[2] - n[2] * up[1], n[2] * up[0] - n[0] * up[2], n[0] * up[1] - n[1] * up[0]];
        const model = [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(([i, j]) => [0, 1, 2].map((k) => n[k] * half + a[k] * i * ts + up[k] * j * ts));
        for (let k = 0; k < 4; k++) {
          const m = model[f.flip ? (4 - ((k + f.shift) % 4)) % 4 : (k + f.shift) % 4];
          const w = [q[0] + cy * m[0] - sy * m[1], q[1] + sy * m[0] + cy * m[1], zc + m[2]];
          const d = [w[0] - snap.x, w[1] - snap.y, w[2] - snap.h];
          const dot = (v) => d[0] * v[0] + d[1] * v[1] + d[2] * v[2];
          const pr = Lynx.lens.project(dot(right), dot(down), dot(fwd), snap.w, snap.hgt);
          if (!pr) out.push(50, 50);
          else out.push(pr.u - f.det.corners[k].x, pr.v - f.det.corners[k].y);
        }
      });
      return out;
    }
    const sq = (r) => r.reduce((a, v) => a + v * v, 0);
    function solveSmall(A, b) {
      const n = b.length;
      const M = A.map((r, i) => [...r, b[i]]);
      for (let c = 0; c < n; c++) {
        let p = c;
        for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
        if (Math.abs(M[p][c]) < 1e-18) return null;
        [M[c], M[p]] = [M[p], M[c]];
        for (let r = 0; r < n; r++) {
          if (r === c) continue;
          const k = M[r][c] / M[c][c];
          for (let j = c; j <= n; j++) M[r][j] -= k * M[c][j];
        }
      }
      return M.map((r, i) => r[n] / r[i]);
    }
    // The cluster's cube (its sightings c, plus dets: detections of its tags
    // in this picture) fitted: {x, y, yaw, dt, rms, faces} or null.
    function fitCube(c, dets, snap, B) {
      const F = frames(snap);
      const rep0 = c.rep;
      const zc = rep0.level * B + B / 2;
      // its faces: the sightings' detections, and same-tag detections right next to them
      const mine = new Set(c.map((o) => o.det));
      const box = (d) => {
        const xs = d.corners.map((p) => p.x);
        const ys = d.corners.map((p) => p.y);
        return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
      };
      const near = (d, e) => {
        const a = box(d);
        const b = box(e);
        const size = Math.max(a[2] - a[0], a[3] - a[1], b[2] - b[0], b[3] - b[1]);
        return Math.max(a[0] - b[2], b[0] - a[2], a[1] - b[3], b[1] - a[3]) < 0.6 * size;
      };
      const idOf = (d) => (alias.has(d.id) ? alias.get(d.id) : d.id);
      dets.forEach((d) => {
        if (!mine.has(d) && idOf(d) === rep0.id && [...mine].some((e) => near(d, e))) mine.add(d);
      });
      if (Lynx.debugCubeFit && mine.size < 2) console.log("cube fit: one tag only");
      if (mine.size < 2) return null;
      // A fit from a starting heading: each tag's face from where it sits
      // around the cube (seen from above), the corner order that fits, then
      // x, y, yaw and the camera's tilt -- twice (faces and orders again from
      // the first round's cube).
      const sightingTop = (det) => {
        const o = c.find((oo) => oo.det === det);
        return o ? o.face === "top" : false;
      };
      const assign = (q) =>
        [...mine].map((det) => {
          const u = det.corners.reduce((a, p) => a + p.x, 0) / 4;
          const v = det.corners.reduce((a, p) => a + p.y, 0) / 4;
          const nn = Lynx.lens.normalize(u, v, snap.w, snap.hgt);
          const ray = F.toWorld([nn[0], nn[1], 1]);
          const t = (zc - snap.h) / ray[2];
          const k = Math.round((Math.atan2(snap.y + ray[1] * t - q[1], snap.x + ray[0] * t - q[0]) - q[2]) / (Math.PI / 2));
          const f = { det, top: sightingTop(det), k: ((k % 4) + 4) % 4, shift: 0, flip: false };
          let best = null;
          for (const flip of [false, true]) {
            for (let shift = 0; shift < 4; shift++) {
              f.flip = flip;
              f.shift = shift;
              const e = sq(cubeResiduals(snap, B, zc, [f], q, 0));
              if (!best || e < best.e) best = { e, flip, shift };
            }
          }
          f.flip = best.flip;
          f.shift = best.shift;
          return f;
        });
      const refine = (faces, v0) => {
        let v = v0.slice();
        const res = (vv) => cubeResiduals(snap, B, zc, faces, vv, vv[3]);
        let r = res(v);
        let lam = 1e-3;
        for (let it = 0; it < 30; it++) {
          const J = [1e-5, 1e-5, 1e-5, 1e-5].map((hh, jj) => {
            const vp = v.slice();
            vp[jj] += hh;
            return res(vp).map((x, ii) => (x - r[ii]) / hh);
          });
          const A = J.map((a) => J.map((b) => a.reduce((tt, x, ii) => tt + x * b[ii], 0)));
          const g = J.map((a) => a.reduce((tt, x, ii) => tt + x * r[ii], 0));
          let ok = false;
          for (let k = 0; k < 8; k++) {
            const d = solveSmall(A.map((row, ii) => row.map((x, jj) => (ii === jj ? x * (1 + lam) + 1e-12 : x))), g.map((x) => -x));
            if (!d) {
              lam *= 10;
              continue;
            }
            const v2 = v.map((x, ii) => x + d[ii]);
            const r2 = res(v2);
            if (sq(r2) < sq(r)) {
              v = v2;
              r = r2;
              lam = Math.max(1e-9, lam / 3);
              ok = true;
              break;
            }
            lam *= 10;
          }
          if (!ok) break;
        }
        return { v, r };
      };
      // Every way the tags can sit on the cube's side faces (distinct faces;
      // a top tag stays on top), from two starting headings: the best fit.
      // (Where the tags seem to sit around the cube can't be trusted for
      // this: with the camera's tilt 2 degrees off, the cube seems 4 cm away
      // from where it is.)
      let bestFit = null;
      const base = assign([rep0.x, rep0.y, rep0.yaw, 0]);
      const sides = base.filter((f) => !f.top);
      if (sides.length > 4) return null;
      const combos = [];
      const pick = (i, used, ks) => {
        if (i === sides.length) {
          combos.push(ks.slice());
          return;
        }
        for (let k = 0; k < 4; k++) {
          if (used.has(k)) continue;
          used.add(k);
          ks.push(k);
          pick(i + 1, used, ks);
          ks.pop();
          used.delete(k);
        }
      };
      pick(0, new Set(), []);
      for (const ks of combos) {
        for (let j = 0; j < 2; j++) {
          const v0 = [rep0.x, rep0.y, rep0.yaw + (j * Math.PI) / 4, 0];
          const faces = base.map((f) => ({ ...f }));
          faces.filter((f) => !f.top).forEach((f, i) => (f.k = ks[i]));
          // the corner order for each tag on its face, at the start
          faces.forEach((f) => {
            let best = null;
            for (const flip of [false, true]) {
              for (let shift = 0; shift < 4; shift++) {
                f.flip = flip;
                f.shift = shift;
                const e = sq(cubeResiduals(snap, B, zc, [f], v0, 0));
                if (!best || e < best.e) best = { e, flip, shift };
              }
            }
            f.flip = best.flip;
            f.shift = best.shift;
          });
          const fr = refine(faces, v0);
          const e = sq(fr.r);
          if (!bestFit || e < bestFit.e) bestFit = { e, v: fr.v, r: fr.r, faces };
        }
      }
      const { v, r, faces } = bestFit;
      const rms = Math.sqrt(sq(r) / r.length);
      // (a fit that doesn't match, or a tilt far off what was commanded: not trusted)
      if (Lynx.debugCubeFit) console.log("cube fit", { tags: faces.length, rms: +rms.toFixed(2), tiltDeg: +((v[3] * 180) / Math.PI).toFixed(2), movedMm: +(Math.hypot(v[0] - rep0.x, v[1] - rep0.y) * 1000).toFixed(1) });
      if (!(rms < FIT_MAX_PX) || Math.abs(v[3]) > FIT_MAX_TILT || Math.hypot(v[0] - rep0.x, v[1] - rep0.y) > 1.5 * B) return null;
      return { x: v[0], y: v[1], yaw: v[2], dt: v[3], rms, faces };
    }

    // One still picture's sightings into the map.
    function integrate(dets, snap, now) {
      const obs = dets.map((d) => observe(d, snap)).filter(Boolean);
      if (opts.onStill) opts.onStill(obs, snap);
      // size votes first (a size change restarts that ID's averages)
      obs.forEach((o) => {
        if (!o.vote) return;
        const I = info(o.id);
        if (I.fixed) return; // (known already)
        if (I.votesN >= MAX_VOTES) return;
        I.votesN = (I.votesN || 0) + 1;
        I.votes.set(o.vote, (I.votes.get(o.vote) || 0) + 1);
        let best = I.cm;
        for (const [cm, n] of I.votes) if (!best || n > (I.votes.get(best) || 0)) best = cm;
        if (best !== I.cm) {
          if (I.cm) I.blocks.forEach((b) => (b.n = 0)); // positions were scaled for the old size
          I.cm = best;
          dirtySizes = true;
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
        if (single.has(id)) {
          // the one and only cube with these tags: all its faces in this picture are it
          clusters.push(list);
          if (I.blocks.length > 1) I.blocks = [I.blocks.reduce((a, b) => (b.seen > a.seen ? b : a))];
        } else {
          list.forEach((o) => {
            const c = clusters.find((k) => near(k[0], o, B, OVERLAP));
            if (c) c.push(o);
            else clusters.push([o]);
          });
        }
        I.count = Math.max(I.count, clusters.length); // cubes with this tag seen at once
        // each cluster's representative: its first sighting, at the cluster's mean position
        clusters.forEach((c) => {
          const n = c.length;
          c.rep = { ...c[0], x: c.reduce((m, o) => m + o.x, 0) / n, y: c.reduce((m, o) => m + o.y, 0) / n, h: c.reduce((m, o) => m + o.h, 0) / n };
          // two or more faces: the whole cube fitted (and the camera's real tilt with it)
          const fit = fitCube(c, dets, snap, B);
          if (fit) {
            c.forEach((o) => {
              o.x = fit.x;
              o.y = fit.y;
              o.yaw = modQuarter(fit.yaw);
              const f = fit.faces.find((ff) => ff.det === o.det);
              if (f && !f.top) o.normalYaw = fit.yaw + (f.k * Math.PI) / 2;
            });
            c.rep = { ...c.rep, x: fit.x, y: fit.y, yaw: modQuarter(fit.yaw) };
            // the camera's real tilt at these servo angles: for every overlay
            // (Lynx.cameraFrame) -- on top of any correction already in this picture's camera
            const total = (snap.frame.fixRad || 0) + fit.dt;
            state.tiltFix = { deg: (total * 180) / Math.PI, rms: fit.rms, at: now, tags: fit.faces.length };
            if (snap.frame.panDeg !== undefined && opts.fixCamera !== false) {
              Lynx.camTiltFix = { rad: total, panDeg: snap.frame.panDeg, tiltDeg: snap.frame.tiltDeg, at: now };
            }
          }
        });
        const free = I.blocks.slice();
        const later = [];
        clusters.forEach((c) => {
          // the block it was last seen as, if it's (still) there
          let best = null;
          let bestD = Infinity;
          free.forEach((b) => {
            const dd = Math.hypot(b.x - c.rep.x, b.y - c.rep.y);
            // (also one not seen where it was lately: overlapping it, it's back)
            if (near(b, c.rep, B, OVERLAP) && dd < bestD) {
              best = b;
              bestD = dd;
            }
          });
          if (!best) {
            later.push(c);
            return;
          }
          free.splice(free.indexOf(best), 1);
          if (!best.present) best.n = 0; // (back: where it's seen now, not averaged with where it was)
          c.forEach((o) => update(best, o, now));
          seen.add(best);
        });
        const limit = single.has(id) ? 1 : I.max || Infinity;
        later.forEach((c) => {
          if (I.blocks.length < I.count && I.blocks.length < limit) {
            // another cube with this tag
            const b = { uid: nextUid++, id, x: c.rep.x, y: c.rep.y, h: c.rep.h, level: c.rep.level, yaw: c.rep.yaw, n: 0, ok: false, present: true, miss: 0, seen: now };
            I.blocks.push(b);
            c.forEach((o) => update(b, o, now));
            seen.add(b);
            return;
          }
          // one of this tag's blocks moved here: one that's gone from where it
          // was first (the one seen longest ago), else one not seen in this
          // picture (once confirmed)
          const byAge = free.slice().sort((a, b) => a.seen - b.seen);
          const cand = byAge.find((b) => !b.present) || byAge[0];
          if (!cand) return;
          free.splice(free.indexOf(cand), 1);
          const o = c.rep;
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
          if (!b.ok || !B) return;
          if (expectVisible(b, B, snap)) {
            b.miss++;
            if (b.miss >= MISS_N) {
              if (b.present) {
                // gone from where it was: remembered there (thin magenta) for now
                b.present = false;
                b.move = null;
                b.miss = 0;
              } else b.forget = true; // remembered, in plain view, still not there: forgotten
            }
          }
        });
        if (I.blocks.some((b) => b.forget)) {
          I.blocks = I.blocks.filter((b) => !b.forget);
          if (!single.has(I.id)) I.count = Math.min(I.count, I.blocks.length);
        }
      }
      // two blocks where there's room for one (different tags): the better-known one stays
      const all = present();
      all.forEach((a) =>
        all.forEach((b) => {
          if (a === b || !a.present || !b.present || a.level !== b.level) return;
          const B = Math.min(a.B, b.B);
          if (Math.hypot(a.x - b.x, a.y - b.y) > 0.7 * B) return;
          // the one seen last is where a cube is now (a cube moved onto another's old place)
          (a.seen > b.seen || (a.seen === b.seen && a.n >= b.n) ? b : a).present = false;
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

    // The world frame changed: new = rotate(-alpha) of (old - (cx, cy)).
    function transform(cx, cy, alpha) {
      const c = Math.cos(alpha);
      const s = Math.sin(alpha);
      for (const I of ids.values()) {
        I.blocks.forEach((b) => {
          const dx = b.x - cx;
          const dy = b.y - cy;
          b.x = dx * c + dy * s;
          b.y = -dx * s + dy * c;
          b.yaw = modQuarter(b.yaw - alpha);
          b.move = null;
        });
      }
      history.length = 0; // (the camera "moved")
    }
    // No learning for a while (e.g. until the video catches up with a new frame).
    const pause = (ms) => (pausedUntil = performance.now() + ms);

    // Forget the blocks (a rescan); remembered and fixed sizes stay.
    function clear() {
      for (const I of ids.values()) {
        I.blocks = [];
        I.count = 0;
        if (!I.fixed) Object.assign(I, { cm: 0, guess: 0, votes: new Map(), votesN: 0 });
      }
      state.ids = [];
    }

    // The cubes known but not seen where they were lately (remembered, or found
    // gone from there): [{id, tag, x, y, yaw, h0, h1, half}].
    function remembered() {
      const out = [];
      for (const I of ids.values()) {
        const cm = I.cm || I.guess;
        if (!cm) continue;
        const B = cm / 100;
        I.blocks.forEach((b) => {
          if (b.ok && !b.present) out.push({ id: b.uid, tag: b.id, x: b.x, y: b.y, yaw: b.yaw, h0: b.h - B / 2, h1: b.h + B / 2, half: B / 2 });
        });
      }
      return out;
    }

    return { start, stop, clear, blocks: list, remembered, transform, pause, state, RATIO, observeForTest: observe, integrateForTest: (dets, snap) => integrate(dets, snap, performance.now()), persistForTest: () => persist(Infinity), infoForTest: (id) => info(id), tagPose };
  };
  Lynx.tagMath = { homography, tagPose };
})(window.Lynx);
