// Camera calibration (Games & apps -> "Camera calibration"): the camera's
// intrinsics -- focal length, optical center, the lens's distortion k1, k2
// (see Lynx.lens) -- from photos of a calibration target: an AprilGrid
// (Kalibr layout, tag36h11 by default; tag_worker.js finds the tags) or a
// checkerboard (camcal_checker.js in checker_worker.js finds its corners;
// the more accurate one). camcal_solver.js does the math.
//
// Put the target upright (e.g. on a wall, near the floor) with the robot in
// front of it, looking at it. Then:
//   Start tour (Fire): the robot finds the target, then drives to viewpoints
//     in front of it -- DISTANCES x ANGLES around its center, never closer to
//     the wall than the nearest distance -- and at each, points the camera so
//     the target lands in the middle, at the sides, top and bottom and the
//     corners of the picture (the edges are where the lens bends most). It
//     only takes a picture with the camera still. Fire again stops it.
//   Capture (C / gamepad Y): one picture now, from wherever you put it.
//   Solve: fit the intrinsics to the pictures so far (done after a tour too).
//   Save: into the robot's camcal for this resolution -- every overlay and
//     game uses it from then on.
// What's found is drawn live (green: tag outlines / corners); the corners
// already captured are dots (yellow), to see which parts of the picture are
// covered.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const DISTANCES = [0.4, 0.55, 0.75]; // m from the target's center
  const ANGLES = [-35, 0, 35]; // deg, viewpoints around it (0 = straight in front)
  const SETTLE_MS = 1000; // after the camera reaches its aim: servos settle, the video catches up
  const STILL_MS = 500;
  const DRIVE_TIMEOUT_MS = 25000;
  const SHOT_TIMEOUT_MS = 6000;
  const LIVE_EVERY_MS = 300;
  const MIN_TAGS = 4;
  const MIN_CORNERS = 12;

  Lynx.games.camcal = (ar, cfg) => {
    const S = Lynx.camcalSolver;
    const grid = {
      tagCols: Math.max(2, Math.round(+cfg.tagCols || 6)),
      tagRows: Math.max(2, Math.round(+cfg.tagRows || 6)),
      tagSize: (+cfg.tagSizeMm || 34) / 1000,
      tagSpacing: Number.isFinite(+cfg.tagSpacing) ? +cfg.tagSpacing : 0.3,
    };
    const G = S.gridInfo(grid);
    const checker = cfg.target === "checkerboard";
    const chk = {
      cols: Math.max(2, Math.round(+cfg.checkerCols || 13)), // inner corners
      rows: Math.max(2, Math.round(+cfg.checkerRows || 14)),
      sq: (+cfg.checkerSquareMm || 20) / 1000,
    };
    const boardW = checker ? (chk.cols + 1) * chk.sq : (grid.tagCols - 1) * G.pitch + G.s;
    const boardH = checker ? (chk.rows + 1) * chk.sq : (grid.tagRows - 1) * G.pitch + G.s;
    const family = cfg.tagFamily === "tag16h5" ? "tag16h5" : "tag36h11";
    const what = checker ? "corners" : "tags";
    const img = document.getElementById("camStream");
    const canvas = document.createElement("canvas");
    const g2 = canvas.getContext("2d", { willReadFrequently: true });

    let state = "idle"; // idle | locate | drive | aim | shoot | solving | done
    // A picture's finds: {dets (tags) | points ([{X, Y, u, v}], checkerboard), n, w, h}
    let views = [];
    let live = { dets: [], points: [], n: 0, w: 640, h: 480, at: 0 };
    let result = null;
    let note = null;
    let tour = null; // {plate, stops: [{x, y, offsets: [[dyaw, dtilt]]}], i, j, t0, reached, ...}
    let alive = true;
    const say = (text, color = "#ffe080") => (note = { text, color, at: performance.now() });

    // -- the AprilTag worker ----------------------------------------------------------------------
    if (Lynx.cam && Lynx.cam.enableCors) Lynx.cam.enableCors();
    const worker = new Worker(checker ? "checker_worker.js" : "tag_worker.js");
    let ready = checker; // (the checkerboard worker needs nothing loaded)
    let busy = false;
    let pending = null; // {cb} -- the detection under way
    worker.onmessage = (ev) => {
      const m = ev.data;
      if (m.type === "ready") ready = true;
      else if (m.type === "error") say(m.message, "#ff8080");
      else if (m.type === "detections" || m.type === "corners") {
        const p = pending;
        pending = null;
        if (p) p.cb(m.type === "corners" ? m.result : m.detections);
      }
    };
    if (!checker) worker.postMessage({ type: "family", family });
    // Each picture is searched twice: as it is, and with black thinned a pixel
    // (camcal_solver.js thinBlack: Kalibr's corner squares touch the tags'
    // corners, so the detector misses them otherwise). A tag found as is keeps
    // the detector's corners; one found only thinned gets its edges moved back
    // out by exactly what the thinning took (camcal_solver.js unthinCorners).
    function detectOnce(rgba, w, h) {
      return new Promise((resolve) => {
        pending = { cb: resolve };
        worker.postMessage({ type: "frame", id: Date.now(), width: w, height: h, rgba: rgba.buffer }, [rgba.buffer]);
      });
    }
    // One picture -> cb(finds, w, h): {dets} (tags) or {points} (checkerboard), and n
    function grab(kind, cb) {
      if (!ready || busy || !img || !img.naturalWidth) return false;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      let data;
      try {
        g2.drawImage(img, 0, 0);
        data = g2.getImageData(0, 0, w, h).data;
      } catch (e) {
        return false; // (CORS: the stream is reconnecting)
      }
      busy = true;
      if (checker) {
        const gray = S.grayOf(data, w, h);
        new Promise((resolve) => {
          pending = { cb: resolve };
          worker.postMessage({ type: "frame", id: Date.now(), width: w, height: h, gray: gray.buffer, opts: { maxCols: chk.cols, maxRows: chk.rows } }, [gray.buffer]);
        }).then((res) => {
          busy = false;
          const points = res ? res.points.map((p) => ({ X: p.i * chk.sq, Y: p.j * chk.sq, u: p.u, v: p.v })) : [];
          cb({ points, n: points.length }, w, h);
        });
        return true;
      }
      const thin = S.thinBlack(data, w, h);
      detectOnce(data, w, h)
        .then((plain) => detectOnce(thin, w, h).then((thinned) => [plain, thinned]))
        .then(([plain, thinned]) => {
          busy = false;
          const ids = new Set(plain.map((d) => d.id));
          const extra = thinned.filter((d) => !ids.has(d.id)).map((d) => ({ ...d, corners: S.unthinCorners(d.corners), refined: true }));
          const dets = plain.concat(extra).filter((d) => d.id < G.n);
          cb({ dets, n: dets.length }, w, h);
        });
      return true;
    }
    // a picture's finds -> the solver's view (corners matched to the board, a first pose)
    const lensInit = (w, h) => {
      const lens = Lynx.lens.params(w, h);
      return { f: lens.f, cx: lens.cx, cy: lens.cy, k1: lens.k1 || 0, k2: lens.k2 || 0 };
    };
    const prepare = (finds, w, h, init) => (finds.points ? S.viewFromPoints(finds.points, w, h, init) : S.prepareView(finds.dets, grid, w, h, init));
    const enough = (finds) => finds.n >= (checker ? MIN_CORNERS : MIN_TAGS);

    // -- the camera and the robot ---------------------------------------------------------------
    const chassis = { x: 0, y: 0, th: 0, at: -1e9 };
    Lynx.control.onMessage("pose", (m) => {
      if (alive && typeof m.theta === "number") Object.assign(chassis, { x: m.x, y: m.y, th: m.theta, at: performance.now() });
    });
    const robotXY = () => (performance.now() - chassis.at < 1000 ? chassis : ar.pose);
    let aim = null; // {yaw (world), tiltDeg}
    function takeControl(on) {
      if (Lynx.control.setDriveFilter) Lynx.control.setDriveFilter(on ? () => null : null);
      if (Lynx.cam && Lynx.cam.setAimOverride) Lynx.cam.setAimOverride(on ? () => aim : null);
      if (!on) aim = null;
    }
    // the aim at a world point, plus offsets (rad)
    function aimAt(p, dyaw = 0, dtilt = 0) {
      const cw = ar.cameraWorld();
      const hd = Math.max(0.05, Math.hypot(p.x - cw.x, p.y - cw.y));
      const down = Math.atan2(cw.h - p.h, hd);
      aim = { yaw: Math.atan2(p.y - cw.y, p.x - cw.x) + dyaw, tiltDeg: ((ar.calib.tiltRad - down + dtilt) * 180) / Math.PI };
    }
    const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    // the camera still (as shown with the video) for STILL_MS
    const history = [];
    function stillFor() {
      const now = performance.now();
      history.push({ t: now, th: ar.camTheta, tilt: ar.tilt, x: ar.pose.x, y: ar.pose.y });
      while (history.length && history[0].t < now - 3000) history.shift();
      const last = history[history.length - 1];
      let since = now;
      for (let i = history.length - 1; i >= 0; i--) {
        const o = history[i];
        if (Math.abs(wrap(o.th - last.th)) > 0.004 || Math.abs(o.tilt - last.tilt) > 0.004 || Math.hypot(o.x - last.x, o.y - last.y) > 0.002) break;
        since = o.t;
      }
      return now - since;
    }
    const aimReached = () => aim && Math.abs(wrap(ar.camTheta - aim.yaw)) < 0.03 && Math.abs(ar.tilt - (ar.calib.tiltRad - (aim.tiltDeg * Math.PI) / 180)) < 0.03;

    // -- the target in the world, from one picture -------------------------------------------------
    function locate(finds, w, h) {
      const v = prepare(finds, w, h, lensInit(w, h));
      if (!v) return null;
      const R = S.rodrigues(v.pose.r);
      const t = v.pose.t;
      const cam = (X, Y) => [R[0][0] * X + R[0][1] * Y + t[0], R[1][0] * X + R[1][1] * Y + t[1], R[2][0] * X + R[2][1] * Y + t[2]];
      // camera frame -> world (as tagblocks.js)
      const ct = Math.cos(ar.tilt);
      const st = Math.sin(ar.tilt);
      const cth = Math.cos(ar.camTheta);
      const sth = Math.sin(ar.camTheta);
      const dir = (q) => {
        const fwd = q[2] * ct - q[1] * st;
        const down = q[2] * st + q[1] * ct;
        return [fwd * cth + q[0] * sth, fwd * sth - q[0] * cth, -down];
      };
      const cw = ar.cameraWorld();
      // the target's center (a checkerboard: the middle of the corners seen)
      const mid = finds.points
        ? [finds.points.reduce((a, p) => a + p.X, 0) / finds.points.length, finds.points.reduce((a, p) => a + p.Y, 0) / finds.points.length]
        : [boardW / 2, boardH / 2];
      const c = dir(cam(mid[0], mid[1]));
      const center = { x: cw.x + c[0], y: cw.y + c[1], h: cw.h + c[2] };
      // its normal, horizontal, toward the camera
      let n = dir([R[0][2], R[1][2], R[2][2]]);
      n = [n[0], n[1]];
      const l = Math.hypot(n[0], n[1]) || 1;
      n = [n[0] / l, n[1] / l];
      if (n[0] * (cw.x - center.x) + n[1] * (cw.y - center.y) < 0) n = [-n[0], -n[1]];
      return { center, n };
    }

    function plan(plate, w, h) {
      const t = [-plate.n[1], plate.n[0]];
      const hfov = Lynx.lens.angleAt(w / 2, w, h);
      const vfov = Lynx.lens.angleAt(h / 2, w, h);
      const half = Math.max(boardW, boardH) / 2;
      const stops = [];
      DISTANCES.forEach((d, di) => {
        const angles = di % 2 ? ANGLES.slice().reverse() : ANGLES; // (a zigzag: less driving)
        angles.forEach((deg) => {
          const a = (deg * Math.PI) / 180;
          const x = plate.center.x + d * (Math.cos(a) * plate.n[0] + Math.sin(a) * t[0]);
          const y = plate.center.y + d * (Math.cos(a) * plate.n[1] + Math.sin(a) * t[1]);
          // the target in the middle, then near the sides, top, bottom and corners of the picture
          const s = Math.atan(half / d);
          const oy = Math.max(0, hfov - 0.6 * s);
          const ov = Math.max(0, vfov - 0.6 * s);
          const offsets = [[0, 0], [oy, 0], [-oy, 0], [0, ov], [0, -ov], [oy, ov], [-oy, -ov], [oy, -ov], [-oy, ov]];
          stops.push({ x, y, offsets });
        });
      });
      return stops;
    }

    // -- the tour --------------------------------------------------------------------------------
    function startTour() {
      if (state !== "idle" && state !== "done") return;
      state = "locate";
      tour = { t0: performance.now() };
      say("Looking for the target...");
    }
    function stopTour(msg) {
      if (!tour) return;
      tour = null;
      state = "idle";
      holdRobot();
      takeControl(false);
      say(msg || "Tour stopped", "#ffe080");
      if (views.length >= 3) solveNow();
    }
    function holdRobot() {
      Lynx.control.send({ type: "joystick", j1: 0, j2: 0 });
    }

    function capture(manual) {
      return grab("shot", (finds, w, h) => {
        const v = prepare(finds, w, h, lensInit(w, h));
        live = { dets: [], points: [], ...finds, w, h, at: performance.now() };
        if (enough(finds) && v) {
          views.push({ ...finds, w, h });
          if (manual) say(`Picture ${views.length}: ${finds.n} ${what}`, "#a0ffa0");
        } else if (manual) say(`Not enough of the target in view (${finds.n} ${what})`, "#ff9090");
        if (tour && state === "shoot") nextShot();
      });
    }

    function nextShot() {
      tour.j++;
      if (tour.j >= tour.stops[tour.i].offsets.length) {
        tour.i++;
        tour.j = 0;
        if (tour.i >= tour.stops.length) {
          tour = null;
          state = "idle";
          holdRobot();
          takeControl(false);
          say("Tour done -- solving", "#a0ffa0");
          solveNow();
          return;
        }
        state = "drive";
        tour.legAt = performance.now();
        return;
      }
      state = "aim";
      tour.aimAt = performance.now();
    }

    function step(now) {
      if (wantShot && !busy && !tour && capture(true)) wantShot = false;
      // live detections (for the outlines, and to find the target)
      if (!busy && !wantShot && now - live.at > LIVE_EVERY_MS && state !== "shoot") {
        grab("live", (finds, w, h) => {
          live = { dets: [], points: [], ...finds, w, h, at: performance.now() };
          if (state === "locate" && tour) {
            if (finds.n < (checker ? 2 * MIN_CORNERS : 6)) {
              if (now - tour.t0 > 8000) stopTour("Target not found -- point the camera at it and try again");
              return;
            }
            if (stillFor() < STILL_MS) return;
            const plate = locate(finds, w, h);
            if (!plate) return;
            tour.plate = plate;
            tour.stops = plan(plate, w, h);
            tour.i = 0;
            tour.j = 0;
            tour.legAt = performance.now();
            takeControl(true);
            state = "drive";
            say(`Target found -- ${tour.stops.length} spots, ${tour.stops.reduce((a, s) => a + s.offsets.length, 0)} pictures`, "#a0ffa0");
          }
        });
      }
      if (!tour || !tour.stops) return;
      const stop = tour.stops[tour.i];
      if (state === "drive") {
        aimAt(tour.plate.center); // (keep the target in view on the way)
        if (now - (tour.gotoAt || 0) > 300) {
          Lynx.control.send({ type: "goto", x: +stop.x.toFixed(4), y: +stop.y.toFixed(4), maintainSpeed: false });
          tour.gotoAt = now;
        }
        const r = robotXY();
        if (Math.hypot(r.x - stop.x, r.y - stop.y) < 0.02 || now - tour.legAt > DRIVE_TIMEOUT_MS) {
          state = "aim";
          tour.aimAt = now;
          tour.j = 0;
        }
      } else if (state === "aim") {
        const [dy, dt] = stop.offsets[tour.j];
        aimAt(tour.plate.center, dy, dt);
        const ok = aimReached() && stillFor() > STILL_MS && now - tour.aimAt > SETTLE_MS;
        if (ok || now - tour.aimAt > SHOT_TIMEOUT_MS) {
          state = "shoot";
          if (!capture(false)) state = "aim"; // (the worker is busy: next frame)
        }
      }
    }

    // -- solving and saving --------------------------------------------------------------------------
    function solveNow() {
      if (views.length < 3) {
        say("Need at least 3 pictures of the target", "#ff9090");
        return;
      }
      state = "solving";
      setTimeout(() => {
        const { w, h } = views[0];
        const same = views.filter((v) => v.w === w && v.h === h);
        const lens = Lynx.lens.params(w, h);
        let init = lensInit(w, h);
        let res = null;
        // twice: the second time the corners are matched (and the poses started) with the first solution
        for (let pass = 0; pass < 2; pass++) {
          const prepared = same.map((v) => prepare(v, w, h, init)).filter(Boolean);
          res = S.solve(prepared, init, w, h);
          if (res.error) break;
          init = { f: res.f, cx: res.cx, cy: res.cy, k1: res.k1, k2: res.k2 };
        }
        state = "done";
        if (res.error) {
          say(res.error, "#ff9090");
          result = null;
          return;
        }
        const ang = (u, v) => {
          const n = S.unproject(res, u, v);
          return Math.atan(Math.hypot(n[0], n[1]));
        };
        res.hfovDeg = ((ang(0, res.cy) + ang(w, res.cy)) * 180) / Math.PI;
        res.vfovDeg = ((ang(res.cx, 0) + ang(res.cx, h)) * 180) / Math.PI;
        res.w = w;
        res.h = h;
        res.old = lens;
        result = res;
        say(`Solved: ${res.rms.toFixed(2)} px RMS over ${res.views} pictures -- Save to keep it`, "#a0ffa0");
      }, 30);
    }

    function save() {
      if (!result) {
        say("Nothing to save yet -- Solve first", "#ff9090");
        return;
      }
      const r = result;
      const key = `${r.w}x${r.h}`;
      fetch("/appdata/camcal", { cache: "no-store" })
        .then((x) => (x.ok ? x.json() : {}))
        .catch(() => ({}))
        .then((doc) => {
          const out = { version: 2, ...doc, measured: new Date().toISOString().slice(0, 19), modes: { ...((doc && doc.modes) || {}) } };
          const old = out.modes[key] || {};
          out.modes[key] = {
            ...old,
            fPx: +r.f.toFixed(2), cx: +r.cx.toFixed(2), cy: +r.cy.toFixed(2), k1: +r.k1.toFixed(4), k2: +r.k2.toFixed(4),
            hfovDeg: +r.hfovDeg.toFixed(2), vfovDeg: +r.vfovDeg.toFixed(2),
            rmsPx: +r.rms.toFixed(3), views: r.views, method: checker ? "checkerboard" : "aprilgrid", at: new Date().toISOString().slice(0, 19),
          };
          return fetch("/appdata/camcal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(out) }).then((x) => {
            if (!x.ok) throw new Error(x.status);
            Lynx.lens.setCalibration(out);
            say(`Saved for ${key} -- every overlay uses it now`, "#a0ffa0");
          });
        })
        .catch(() => say("Couldn't save -- is the robot reachable?", "#ff9090"));
    }

    // -- controls -------------------------------------------------------------------------------------
    Lynx.onAction("fire", () => (tour ? stopTour() : startTour()));
    // (a capture asked for while a detection is under way waits for it)
    let wantShot = false;
    const manualCapture = () => {
      if (!tour && !capture(true)) wantShot = true;
    };
    Lynx.onAction("camera", manualCapture);
    const touch = Lynx.touchButtons();
    touch.add("\u{1F4F7} Capture", manualCapture);
    touch.add("\u{1F9EE} Solve", () => !tour && solveNow());
    touch.add("\u{1F4BE} Save", () => save());
    const panel = [];
    if (Lynx.cam && Lynx.cam.addMenuButton) {
      panel.push(Lynx.cam.addMenuButton("\u{1F5D1} Clear pictures", () => {
        if (tour) return;
        views = [];
        result = null;
        state = "idle";
        say("Pictures cleared");
      }));
    }
    ar.onDestroy(() => {
      alive = false;
      worker.terminate();
      panel.forEach((el) => el.remove());
      if (tour) holdRobot();
      takeControl(false);
    });

    // -- drawing ------------------------------------------------------------------------------------------
    function drawPoly(cs, w, h, color, width) {
      const v = ar.view;
      const sx = v.w / w;
      const sy = v.h / h;
      const g = ar.ctx;
      g.beginPath();
      cs.forEach((p, i) => (i ? g.lineTo(v.x + p.x * sx, v.y + p.y * sy) : g.moveTo(v.x + p.x * sx, v.y + p.y * sy)));
      g.closePath();
      g.strokeStyle = color;
      g.lineWidth = width;
      g.stroke();
    }
    ar.onFrame((now) => {
      step(now);
      const v = ar.view;
      const g = ar.ctx;
      // coverage: every corner captured so far
      g.fillStyle = "rgba(255,220,60,0.75)";
      views.forEach((vw) => {
        const sx = v.w / vw.w;
        const sy = v.h / vw.h;
        if (vw.points) vw.points.forEach((p) => g.fillRect(v.x + p.u * sx - 1.5, v.y + p.v * sy - 1.5, 3, 3));
        else vw.dets.forEach((d) => d.corners.forEach((p) => g.fillRect(v.x + p.x * sx - 1.5, v.y + p.y * sy - 1.5, 3, 3)));
      });
      if (now - live.at < 1000) {
        live.dets.forEach((d) => drawPoly(d.corners, live.w, live.h, "rgba(60,255,120,0.9)", 2));
        // checkerboard corners: small green crosses
        const sx = v.w / live.w;
        const sy = v.h / live.h;
        g.strokeStyle = "rgba(60,255,120,0.95)";
        g.lineWidth = 1.5;
        live.points.forEach((p) => {
          const x = v.x + p.u * sx;
          const y = v.y + p.v * sy;
          g.beginPath();
          g.moveTo(x - 4, y);
          g.lineTo(x + 4, y);
          g.moveTo(x, y - 4);
          g.lineTo(x, y + 4);
          g.stroke();
        });
      }
      // status
      const lines = [];
      const st = { idle: "", locate: "Finding the target...", drive: "Driving to the next spot", aim: "Aiming", shoot: "Taking a picture", solving: "Solving...", done: "" }[state];
      lines.push(`${ready ? `${live.n} ${what} in view` : "Loading the tag detector..."} · ${views.length} pictures${tour && tour.stops ? ` · spot ${tour.i + 1}/${tour.stops.length}, shot ${tour.j + 1}/${tour.stops[tour.i].offsets.length}` : ""}${st ? ` · ${st}` : ""}`);
      if (result) {
        const r = result;
        const o = r.old;
        lines.push(`f ${r.f.toFixed(1)} px (was ${o.f.toFixed(1)}) · center ${r.cx.toFixed(1)}, ${r.cy.toFixed(1)} (was ${o.cx.toFixed(1)}, ${o.cy.toFixed(1)})`);
        lines.push(`k1 ${r.k1.toFixed(4)} (was ${(o.k1 || 0).toFixed(4)}) · k2 ${r.k2.toFixed(4)} · FOV ${r.hfovDeg.toFixed(1)} x ${r.vfovDeg.toFixed(1)} deg`);
        lines.push(`RMS ${r.rms.toFixed(2)} px · ${r.views} pictures, ${r.points} corners${r.dropped ? ` (${r.dropped} outliers dropped)` : ""}`);
      }
      lines.forEach((s, i) => ar.text(s, v.x + 12, v.y + 24 + i * 18, { size: 13, color: i ? "#ffe080" : "#c0f0ff" }));
      if (state === "idle" && !views.length && !result) {
        ar.banner("CAMERA CALIBRATION", `Point the camera at the ${checker ? "checkerboard" : "AprilGrid"} target · Fire: robot tour · C: one picture`, { color: "#80d0ff" });
      }
      if (note && now - note.at < 4000) ar.text(note.text, v.cx, v.y + v.h - 40, { size: 15, align: "center", color: note.color });
    });

    return { actionLabel: "▶ Tour", debug: { views: () => views, result: () => result, tour: () => tour, solveNow, locate, plan } };
  };
})(window.Lynx);
