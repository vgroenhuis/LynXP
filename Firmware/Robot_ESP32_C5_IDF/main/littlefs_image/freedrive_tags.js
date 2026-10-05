// Free drive's AprilTag cube detection (cam.js starts it with Free drive):
// switches in the Overlays panel turn the detection on (tagblocks.js, the
// same block map as Knight on Blocks, remembered on the robot -- see the
// Tags page), show the blocks' outlines (cyan; grey for ones inferred
// underneath a stack) and the tags found in the picture (green), and let
// the frame cube set the world frame.
//
// The frame cube: one cube with a different tag on each face, numbered like
// a die (opposite faces add up to 24 + 29) -- 24 facing +X, 25 +Y, 26 +Z
// (up), 27 -Z (down), 28 -Y, 29 -X (frameCubeMm, 40 mm by default). With "World frame from cube" on, once its side tags are seen
// steadily (a still camera, FRAME_SAMPLES pictures agreeing) the world's
// origin goes to the cube's center on the floor and +X along tag 24's
// facing: the robot's pose is set to match (/set?set_pose -- the robot
// doesn't move, the world does), and the map moves along. Only the side
// tags count for the heading (a top tag's turn on its face isn't known).
// Done again whenever the cube is seen more than FRAME_TOL_M / FRAME_TOL_RAD
// off the origin / axes.
//
// Lynx.frameCubeSizes(general) -> {24..29: cm}; Lynx.freeDriveTags.setup(calib,
// app) once, then .setActive(bool) as Free drive starts / stops.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const FRAME_IDS = { 24: 0, 25: Math.PI / 2, 28: -Math.PI / 2, 29: Math.PI }; // side tags: their facing, from +X (26 top, 27 bottom)
  const FRAME_ALL = [24, 25, 26, 27, 28, 29];
  const FRAME_SAMPLES = 5; // still pictures of the cube...
  const FRAME_WINDOW_MS = 4000; // ...within this long; their average counts once the
  const FRAME_SPREAD_M = 0.015; // ...typical (RMS) scatter is within this
  const FRAME_SPREAD_RAD = 0.052; // (3 deg) -- sightings much further off than that are dropped first
  const FRAME_OUTLIER_M = 0.03;
  const FRAME_OUTLIER_RAD = 0.14; // (8 deg)
  const FRAME_TOL_M = 0.01; // re-set the frame when the cube is this far off the origin...
  const FRAME_TOL_RAD = 0.02; // ...or its X axis this far off (1.1 deg)
  const FRAME_COOLDOWN_MS = 5000;
  const KEYS = { on: "freeDriveTags", blocks: "freeDriveShowBlocks", tags: "freeDriveShowTags", frame: "freeDriveAutoFrame" };

  Lynx.FRAME_CUBE_TAGS = FRAME_ALL;
  Lynx.frameCubeSizes = (general) => {
    const cm = Math.max(1, Math.round((+(general && general.frameCubeMm) || 40) / 10));
    const out = {};
    FRAME_ALL.forEach((id) => (out[id] = cm));
    return out;
  };

  const remembered = (key, def) => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? def : v === "1";
    } catch (e) {
      return def;
    }
  };
  const remember = (key, on) => {
    try {
      localStorage.setItem(key, on ? "1" : "0");
    } catch (e) {
      // (not remembered)
    }
  };

  let calib = null;
  let app = null;
  let active = false; // Free drive is running
  const opt = { on: remembered(KEYS.on, false), blocks: remembered(KEYS.blocks, true), tags: remembered(KEYS.tags, true), frame: remembered(KEYS.frame, false) };
  let run = null; // {ar, w, tb} while detecting
  let toggles = [];
  const chassis = { x: 0, y: 0, th: 0, at: -1e9 };

  function setup(c, a) {
    calib = c;
    app = a;
    Lynx.control.onMessage("pose", (m) => {
      if (typeof m.theta === "number") Object.assign(chassis, { x: m.x, y: m.y, th: m.theta, at: performance.now() });
    });
  }

  function setActive(on) {
    active = on;
    toggles.forEach((el) => el.remove());
    toggles = [];
    if (on && Lynx.cam && Lynx.cam.addOverlayToggle) {
      const t = (text, key) => Lynx.cam.addOverlayToggle(text, opt[key], (v) => {
        opt[key] = v;
        remember(KEYS[key], v);
        refresh();
      });
      toggles = [t("Cube detection", "on"), t("Cube outlines", "blocks"), t("Cube tags", "tags"), t("World frame from cube", "frame")];
    }
    refresh();
  }

  function refresh() {
    const want = active && opt.on && calib;
    if (want && !run) startRun();
    else if (!want && run) {
      run.tb.stop();
      run.ar.destroy();
      run = null;
    }
  }

  function startRun() {
    const general = (app && app.general) || {};
    const ar = Lynx.createAr(calib);
    const w = Lynx.world3d(ar, { textures: false });
    w.setAnchor({ x: 0, y: 0, th: 0 });
    const frame = { samples: [], appliedAt: -1e9, note: null, noteAt: -1e9, seenAt: -1e9, progress: 0 };
    const tb = Lynx.tagBlocks(ar, {
      family: general.tagFamily === "tag36h11" ? "tag36h11" : "tag16h5",
      tagRatio: Math.min(0.95, Math.max(0.3, (+general.tagPercent || 75) / 100)),
      persist: true,
      fixedSizes: Lynx.frameCubeSizes(general),
      cubes: [FRAME_ALL], // its six faces are one block
      onStill: (obs, snap) => opt.frame && frameCube(obs, snap),
    });
    run = { ar, w, tb, frame };
    tb.start();

    function frameCube(obs, snap) {
      const now = snap.t;
      obs.forEach((o) => {
        if (!(o.tag in FRAME_IDS) || o.normalYaw === null) return;
        frame.samples.push({ t: now, x: o.x, y: o.y, a: o.normalYaw - FRAME_IDS[o.tag] });
      });
      frame.samples = frame.samples.filter((s) => now - s.t < FRAME_WINDOW_MS);
      if (now - frame.appliedAt < FRAME_COOLDOWN_MS) return;
      if (frame.samples.length) frame.seenAt = performance.now();
      const wrap = (v) => Math.atan2(Math.sin(v), Math.cos(v));
      // the average, from the median sighting's neighbourhood (outliers out)
      const med = (vals) => vals.slice().sort((a, b) => a - b)[vals.length >> 1];
      const all = frame.samples;
      if (!all.length) return;
      const mx = med(all.map((q) => q.x));
      const my = med(all.map((q) => q.y));
      const a0 = all[0].a;
      const ma = a0 + med(all.map((q) => wrap(q.a - a0)));
      const good = all.filter((q) => Math.hypot(q.x - mx, q.y - my) < FRAME_OUTLIER_M && Math.abs(wrap(q.a - ma)) < FRAME_OUTLIER_RAD);
      const pics = new Set(good.map((q) => q.t)).size;
      frame.progress = Math.min(pics, FRAME_SAMPLES);
      if (pics < FRAME_SAMPLES) return;
      const n = good.length;
      const cx = good.reduce((m, q) => m + q.x, 0) / n;
      const cy = good.reduce((m, q) => m + q.y, 0) / n;
      const alpha = ma + good.reduce((m, q) => m + wrap(q.a - ma), 0) / n;
      const rmsM = Math.sqrt(good.reduce((m, q) => m + (q.x - cx) ** 2 + (q.y - cy) ** 2, 0) / n);
      const rmsA = Math.sqrt(good.reduce((m, q) => m + wrap(q.a - alpha) ** 2, 0) / n);
      if (rmsM > FRAME_SPREAD_M || rmsA > FRAME_SPREAD_RAD) {
        frame.progress = -1; // (seen, but too unsteady -- closer, or a straighter view, helps)
        return;
      }
      if (Math.hypot(cx, cy) < FRAME_TOL_M && Math.abs(wrap(alpha)) < FRAME_TOL_RAD) {
        frame.progress = FRAME_SAMPLES + 1; // (already the world frame)
        return;
      }
      // the robot's pose now (its telemetry; else the view's, the same with the camera still)
      const fresh = performance.now() - chassis.at < 1000;
      const rp = fresh ? chassis : { x: ar.pose.x, y: ar.pose.y, th: ar.pose.theta };
      // the robot's pose in the cube's frame: new = rotate(-alpha) of (old - cube)
      const dx = rp.x - cx;
      const dy = rp.y - cy;
      const c = Math.cos(alpha);
      const s = Math.sin(alpha);
      const x = dx * c + dy * s;
      const y = -dx * s + dy * c;
      const th = wrap(rp.th - alpha);
      fetch(`/set?set_pose=1&x=${x.toFixed(4)}&y=${y.toFixed(4)}&theta=${th.toFixed(5)}`).catch(() => {});
      tb.transform(cx, cy, alpha);
      tb.pause(1500); // until the video's poses are in the new frame
      frame.samples = [];
      frame.appliedAt = now;
      frame.note = `World frame set from the frame cube (moved ${(Math.hypot(cx, cy) * 100).toFixed(1)} cm, turned ${((wrap(alpha) * 180) / Math.PI).toFixed(1)}\u00b0)`;
      frame.noteAt = performance.now();
      frame.progress = 0;
    }

    ar.onFrame(() => {
      w.beginFrame();
      if (opt.blocks) drawBlocks();
      if (opt.tags) drawTags();
      // (no status line -- the Tags page lists the cubes; only a failure shows here)
      const s = tb.state;
      const v = ar.view;
      if (s.error) ar.text(s.error, v.x + 12, v.y + v.h - 14, { size: 12, color: "#ff8080" });
      const nowMs = performance.now();
      if (frame.note && nowMs - frame.noteAt < 3000) ar.text(frame.note, v.cx, v.y + 70, { size: 16, align: "center", color: "#ffe080" });
      else if (opt.frame && nowMs - frame.seenAt < 1500) {
        const p = frame.progress;
        const msg = p > FRAME_SAMPLES ? "Frame cube: world frame aligned" : p < 0 ? "Frame cube: too unsteady -- get closer or look more squarely" : `Frame cube: measuring ${p}/${FRAME_SAMPLES} (keep the camera still)`;
        ar.text(msg, v.cx, v.y + 70, { size: 14, align: "center", color: "#ffe080" });
      }
    });

    function drawBlocks() {
      const a = w.anchor();
      tb.blocks().forEach((b) => {
        const l = w.toLocal(b.x, b.y);
        const yaw = a.th - b.yaw;
        const c = Math.cos(yaw);
        const s = Math.sin(yaw);
        const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [l.f + (u * c - v * s) * b.half, l.r + (u * s + v * c) * b.half]);
        const col = b.inferred ? "rgba(200,200,200,0.55)" : FRAME_ALL.includes(b.tag) ? "rgba(255,210,80,0.9)" : "rgba(80,230,255,0.85)";
        const top = cs.map(([f, r]) => [f, r, b.h1]);
        const bottom = cs.map(([f, r]) => [f, r, b.h0]);
        w.line3([...top, top[0]], col, 1.5, 0.01);
        w.line3([...bottom, bottom[0]], col, 1, 0.01);
        cs.forEach(([f, r]) => w.line3([[f, r, b.h0], [f, r, b.h1]], col, 1, 0.01));
      });
    }
    function drawTags() {
      const v = ar.view;
      const now = performance.now();
      const g = ar.ctx;
      tb.state.lastDetections.forEach((d) => {
        if (now - d.at > 400) return;
        const sx = v.w / d.w;
        const sy = v.h / d.h;
        g.beginPath();
        d.corners.forEach((p, i) => (i ? g.lineTo(v.x + p.x * sx, v.y + p.y * sy) : g.moveTo(v.x + p.x * sx, v.y + p.y * sy)));
        g.closePath();
        g.strokeStyle = "rgba(60,255,120,0.9)";
        g.lineWidth = 2;
        g.stroke();
        const cc = d.corners.reduce((m, p) => ({ x: m.x + p.x / 4, y: m.y + p.y / 4 }), { x: 0, y: 0 });
        ar.text(String(d.id), v.x + cc.x * sx, v.y + cc.y * sy + 4, { size: 11, align: "center", color: "#80ffa0" });
      });
    }
  }

  Lynx.freeDriveTags = { setup, setActive, debug: () => run };
})(window.Lynx);
