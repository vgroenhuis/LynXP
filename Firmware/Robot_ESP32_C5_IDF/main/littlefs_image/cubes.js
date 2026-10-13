// The tagged cubes for a game or an overlay: one call gives the cube finder
// (tagblocks.js) with the general AprilTag settings (Games & apps page:
// tag family, tag size on a face, the frame cube's size), the block map
// remembered on the robot (the Tags page), the drawing free drive does
// (footprints, outlines, cubes gone from where they were, the tags found)
// and the geometry a game needs (what stands where, how high, what a line
// of sight or a shot runs into) -- all in world coordinates.
//
// The frame cube: one cube with a different tag on each face, numbered like
// a die (opposite faces add up to 24 + 29) -- 24 facing +X, 25 +Y, 26 +Z
// (up), 27 -Z (down), 28 -Y, 29 -X (frameCubeMm, 40 mm by default). With
// opts.frame() true, once its side tags are seen steadily (a still camera,
// FRAME_SAMPLES pictures agreeing) the world's origin goes to the cube's
// center on the floor and +X along tag 24's facing: the robot's pose is set
// to match (/set?set_pose -- the robot doesn't move, the world does), and the
// map moves along. Only the side tags count for the heading (a top tag's turn
// on its face isn't known). Done again whenever the cube is seen more than
// FRAME_TOL_M / FRAME_TOL_RAD off the origin / axes. (Games leave it off:
// the world moving under a game is a surprise.)
//
// Lynx.cubeLayer(ar, app, opts) -> layer; it stops with the ar.
//   opts: {frame: () => bool (the frame cube sets the world frame),
//          onStill(obs, snap): every still picture's sightings (tagblocks.js)}
//   layer.tb: the cube finder (blocks(), remembered(), clear(), state, ...)
//   layer.blocks(): the cubes seen: [{id, tag, x, y, yaw, level, h0, h1, half,
//     inferred, n, seen}] (world; inferred: one underneath a stack, not seen)
//   layer.frameCube(tag): is this tag on the frame cube?
//   Geometry (world, m):
//   layer.topAt(x, y, margin = 0) -> the top of the highest cube under the
//     point (within margin of it), or 0 (the floor)
//   layer.hit(x, y, z, margin = 0) -> the cube that point is in, or null
//   layer.rayHit(a, b, margin = 0) -> {block, t (0..1 along a -> b), point}
//     for the first cube the segment a -> b ([x, y, z]) runs into, or null
//   Drawing (w: a Lynx.world3d of this ar -- with {lens: true} the outlines
//   sit on the video right to the picture's edges; its anchor may be anything):
//   layer.draw(w, {blocks = true, tags = true}): everything below, for an overlay
//   layer.drawFootprints(w), layer.drawOutline(w, b), layer.drawGone(w),
//   layer.drawTags(), layer.drawStatus(): the pieces, e.g. an outline inside
//   a game's own depth-sorted drawing (ar.queue)

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

  const COL = {
    seen: "rgba(80,230,255,0.85)",
    inferred: "rgba(200,200,200,0.55)",
    frame: "rgba(255,210,80,0.9)",
    gone: "rgba(255,90,220,0.6)",
    footSeen: ["rgba(80,230,255,0.28)", "rgba(170,245,255,0.95)"],
    footInferred: ["rgba(200,200,200,0.2)", "rgba(170,245,255,0.95)"],
    footFrame: ["rgba(255,210,80,0.28)", "rgba(255,230,140,0.95)"],
  };

  Lynx.FRAME_CUBE_TAGS = FRAME_ALL;
  Lynx.frameCubeSizes = (general) => {
    const cm = Math.max(1, Math.round((+(general && general.frameCubeMm) || 40) / 10));
    const out = {};
    FRAME_ALL.forEach((id) => (out[id] = cm));
    return out;
  };
  // the general AprilTag settings (Games & apps page)
  Lynx.tagSettings = (app) => {
    const general = (app && app.general) || {};
    return {
      family: general.tagFamily === "tag36h11" ? "tag36h11" : "tag16h5",
      tagRatio: Math.min(0.95, Math.max(0.3, (+general.tagPercent || 75) / 100)),
      fixedSizes: Lynx.frameCubeSizes(general),
    };
  };

  const wrap = (v) => Math.atan2(Math.sin(v), Math.cos(v));

  Lynx.cubeLayer = (ar, app, opts = {}) => {
    const set = Lynx.tagSettings(app);
    const frame = { samples: [], appliedAt: -1e9, note: null, noteAt: -1e9, seenAt: -1e9, progress: 0 };
    const chassis = { x: 0, y: 0, th: 0, at: -1e9 };
    const offPose = Lynx.control && Lynx.control.onMessage
      ? Lynx.control.onMessage("pose", (m) => {
          if (typeof m.theta === "number") Object.assign(chassis, { x: m.x, y: m.y, th: m.theta, at: performance.now() });
        })
      : null;
    const tb = Lynx.tagBlocks(ar, {
      family: set.family,
      tagRatio: set.tagRatio,
      persist: true,
      fixedSizes: set.fixedSizes,
      cubes: [FRAME_ALL], // its six faces are one block
      onStill: (obs, snap) => {
        if (opts.frame && opts.frame()) frameCube(obs, snap);
        if (opts.onStill) opts.onStill(obs, snap);
      },
    });
    tb.start();
    ar.onDestroy(() => {
      tb.stop();
      if (typeof offPose === "function") offPose();
    });
    const isFrame = (tag) => FRAME_ALL.includes(tag);

    // -- the frame cube sets the world frame ----------------------------------------------------
    function frameCube(obs, snap) {
      const now = snap.t;
      obs.forEach((o) => {
        if (!(o.tag in FRAME_IDS) || o.normalYaw === null) return;
        frame.samples.push({ t: now, x: o.x, y: o.y, a: o.normalYaw - FRAME_IDS[o.tag] });
      });
      frame.samples = frame.samples.filter((s) => now - s.t < FRAME_WINDOW_MS);
      if (now - frame.appliedAt < FRAME_COOLDOWN_MS) return;
      if (frame.samples.length) frame.seenAt = performance.now();
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
      frame.note = `World frame set from the frame cube (moved ${(Math.hypot(cx, cy) * 100).toFixed(1)} cm, turned ${((wrap(alpha) * 180) / Math.PI).toFixed(1)}°)`;
      frame.noteAt = performance.now();
      frame.progress = 0;
    }

    // -- geometry ---------------------------------------------------------------------------------
    // a world point in a cube's frame (u along its heading, v across, z up from its bottom)
    const local = (b, x, y) => {
      const c = Math.cos(b.yaw);
      const s = Math.sin(b.yaw);
      const dx = x - b.x;
      const dy = y - b.y;
      return [dx * c + dy * s, -dx * s + dy * c];
    };
    function topAt(x, y, margin = 0) {
      let top = 0;
      tb.blocks().forEach((b) => {
        const [u, v] = local(b, x, y);
        if (Math.abs(u) <= b.half + margin && Math.abs(v) <= b.half + margin) top = Math.max(top, b.h1);
      });
      return top;
    }
    function hit(x, y, z, margin = 0) {
      return (
        tb.blocks().find((b) => {
          const [u, v] = local(b, x, y);
          return Math.abs(u) <= b.half + margin && Math.abs(v) <= b.half + margin && z >= b.h0 - margin && z <= b.h1 + margin;
        }) || null
      );
    }
    function rayHit(a, p, margin = 0) {
      let best = null;
      tb.blocks().forEach((b) => {
        const A = [...local(b, a[0], a[1]), a[2] - (b.h0 + b.h1) / 2];
        const P = [...local(b, p[0], p[1]), p[2] - (b.h0 + b.h1) / 2];
        const hb = [b.half + margin, b.half + margin, (b.h1 - b.h0) / 2 + margin];
        let t0 = 0;
        let t1 = 1;
        for (let i = 0; i < 3; i++) {
          const d = P[i] - A[i];
          if (Math.abs(d) < 1e-12) {
            if (Math.abs(A[i]) > hb[i]) return;
            continue;
          }
          let ta = (-hb[i] - A[i]) / d;
          let tc = (hb[i] - A[i]) / d;
          if (ta > tc) [ta, tc] = [tc, ta];
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tc);
          if (t0 > t1) return;
        }
        if (!best || t0 < best.t) best = { block: b, t: t0 };
      });
      if (best) best.point = [0, 1, 2].map((k) => a[k] + (p[k] - a[k]) * best.t);
      return best;
    }

    // -- drawing ----------------------------------------------------------------------------------
    // a cube's corners in w's local (forward, right) floor coordinates
    function cornersIn(w, b) {
      const a = w.anchor();
      const l = w.toLocal(b.x, b.y);
      const yaw = a.th - b.yaw;
      const c = Math.cos(yaw);
      const s = Math.sin(yaw);
      return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [l.f + (u * c - v * s) * b.half, l.r + (u * s + v * c) * b.half]);
    }
    // where each cube standing on the floor meets it: its footprint, filled
    function drawFootprints(w) {
      const g = ar.ctx;
      tb.blocks().forEach((b) => {
        if (b.h0 > 0.005) return; // (stacked: not on the floor)
        const pts = cornersIn(w, b).map(([f, r]) => w.project(f, r, 0));
        if (pts.some((p) => !p)) return;
        const [fill, stroke] = isFrame(b.tag) ? COL.footFrame : b.inferred ? COL.footInferred : COL.footSeen;
        g.save();
        g.beginPath();
        pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        g.fillStyle = fill;
        g.fill();
        g.strokeStyle = stroke;
        g.lineWidth = 2;
        g.stroke();
        g.restore();
      });
    }
    // a cube's wireframe (seen: cyan, the frame cube yellow, inferred: grey, gone: thin magenta)
    function drawOutline(w, b) {
      const cs = cornersIn(w, b);
      const col = b.gone ? COL.gone : b.inferred ? COL.inferred : isFrame(b.tag) ? COL.frame : COL.seen;
      const top = cs.map(([f, r]) => [f, r, b.h1]);
      const bottom = cs.map(([f, r]) => [f, r, b.h0]);
      w.line3([...top, top[0]], col, b.gone ? 1 : 1.5, 0.01);
      w.line3([...bottom, bottom[0]], col, 1, 0.01);
      cs.forEach(([f, r]) => w.line3([[f, r, b.h0], [f, r, b.h1]], col, 1, 0.01));
    }
    // cubes known but not seen where they were lately: dim magenta, with their tag
    function drawGone(w) {
      tb.remembered().forEach((r) => {
        const b = { ...r, gone: true };
        drawOutline(w, b);
        const l = w.toLocal(b.x, b.y);
        const m = w.project(l.f, l.r, b.h1 + 0.01);
        if (m) ar.text(String(b.tag), m.x, m.y, { size: 12, align: "center", color: "rgba(255,120,230,0.9)" });
      });
    }
    // the tags found in the last picture, outlined where they were
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
    // a failure, and the frame cube's progress
    function drawStatus() {
      const s = tb.state;
      const v = ar.view;
      if (s.error) ar.text(s.error, v.x + 12, v.y + v.h - 14, { size: 12, color: "#ff8080" });
      const nowMs = performance.now();
      if (frame.note && nowMs - frame.noteAt < 3000) ar.text(frame.note, v.cx, v.y + 70, { size: 16, align: "center", color: "#ffe080" });
      else if (opts.frame && opts.frame() && nowMs - frame.seenAt < 1500) {
        const p = frame.progress;
        const msg = p > FRAME_SAMPLES ? "Frame cube: world frame aligned" : p < 0 ? "Frame cube: too unsteady -- get closer or look more squarely" : `Frame cube: measuring ${p}/${FRAME_SAMPLES} (keep the camera still)`;
        ar.text(msg, v.cx, v.y + 70, { size: 14, align: "center", color: "#ffe080" });
      }
    }
    function draw(w, show = {}) {
      if (show.blocks !== false) {
        drawFootprints(w);
        drawGone(w);
        tb.blocks().forEach((b) => drawOutline(w, b));
      }
      if (show.tags !== false) drawTags();
      drawStatus();
    }

    return {
      tb,
      blocks: () => tb.blocks(),
      frameCube: isFrame,
      settings: set,
      topAt,
      hit,
      rayHit,
      draw,
      drawFootprints,
      drawOutline,
      drawGone,
      drawTags,
      drawStatus,
    };
  };
})(window.Lynx);
