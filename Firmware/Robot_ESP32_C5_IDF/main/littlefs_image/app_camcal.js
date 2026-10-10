// Camera calibration (Games & apps -> "Camera calibration"): the camera's
// intrinsics -- focal length, optical center, the lens's distortion k1, k2
// (see Lynx.lens) -- from photos of a calibration target: an AprilGrid
// (Kalibr layout, tag36h11 by default; tag_worker.js finds the tags) or a
// checkerboard (camcal_checker.js in checker_worker.js finds its corners;
// the more accurate one). camcal_solver.js does the math.
//
// Put the target upright (e.g. on a wall, near the floor) with the robot in
// front of it, looking at it. Then:
//   ▶ Tour: the robot finds the target, then drives to viewpoints
//     in front of it -- DISTANCES x ANGLES around its center, never closer to
//     the wall than the nearest distance -- and at each, points the camera so
//     the target lands in the middle, at the sides, top and bottom and the
//     corners of the picture (the edges are where the lens bends most). It
//     only takes a picture with the camera still. ■ Stop stops it.
//   Capture (C / gamepad Y): one picture now, from wherever you put it.
//   Solve: fit the intrinsics to the pictures so far (done after a tour too).
//   Save: into the robot's camcal for this resolution -- every overlay and
//     game uses it from then on.
// What's found is drawn live (green: tag outlines / corners); the corners
// already captured are dots (yellow), to see which parts of the picture are
// covered.
//
// The "Calibrate" setting picks the step: 1. the lens (this), 2. the servos
// (app_camservo.js), 3. the camera's mount ("extrinsics"): where the camera
// sits on the robot (camext_solver.js) -- the lens and servos calibrated
// first (the servo terms are held at nominal here), the same tour of the
// checkerboard, and the world-frame cube (tags 24-29) on the floor next to it
// (it fixes the floor's level). Each picture also keeps the commanded pan /
// tilt and the odometry. Save writes the camera height and tilt settings; the
// camera's roll and its offset in front of the tilt axis go into camcal
// ("extrinsics") for the record.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const DISTANCES = [0.4, 0.55, 0.75]; // m from the target's center
  const ANGLES = [-35, 0, 35]; // deg, viewpoints around it (0 = straight in front)
  const SETTLE_MS = 1000; // after the camera reaches its aim: servos settle, the video catches up
  const STILL_MS = 500;
  const DRIVE_TIMEOUT_MS = 25000;
  const ARRIVED_M = 0.035; // the robot's goto stops within 3 cm (GOTO_ARRIVAL_TOLERANCE_M)
  const STOPPED_MS = 1000; // ...or: not moving for this long (it's as close as it gets)
  const SHOT_TIMEOUT_MS = 6000;
  const LIVE_EVERY_MS = 300;
  const MIN_TAGS = 4;
  const MIN_CORNERS = 12;

  Lynx.games.camcal = (ar, cfg, app) => {
    if (cfg.calibrate === "servos") return Lynx.games.camservo(ar, cfg, app); // (step 2: app_camservo.js)
    const S = Lynx.camcalSolver;
    const extr = cfg.calibrate === "extrinsics";
    const general = (app && app.general) || {};
    const cubeM = (+general.frameCubeMm || 40) / 1000;
    const grid = {
      tagCols: Math.max(2, Math.round(+cfg.tagCols || 6)),
      tagRows: Math.max(2, Math.round(+cfg.tagRows || 6)),
      tagSize: (+cfg.tagSizeMm || 34) / 1000,
      tagSpacing: Number.isFinite(+cfg.tagSpacing) ? +cfg.tagSpacing : 0.3,
    };
    const G = S.gridInfo(grid);
    const checker = extr || cfg.target === "checkerboard"; // (the extrinsics use the checkerboard)
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
    // extrinsics: the frame cube's tags too
    let cubeWorker = null;
    let cubePending = null;
    let cubeReady = false; // (the worker drops frames until its detector has loaded)
    if (extr) {
      cubeWorker = new Worker("tag_worker.js");
      cubeWorker.onmessage = (ev) => {
        if (ev.data.type === "ready") cubeReady = true;
        else if (ev.data.type === "error") say(ev.data.message, "#ff9090");
        else if (ev.data.type === "detections" && cubePending) {
          const p = cubePending;
          cubePending = null;
          p(ev.data.detections);
        }
      };
      cubeWorker.postMessage({ type: "family", family: general.tagFamily === "tag36h11" ? "tag36h11" : "tag16h5" });
    }
    // a tag's center in the picture: its diagonals' crossing, straightened through the lens
    function tagCenter(corners, w, h) {
      const K = lensInit(w, h);
      const q = corners.map((c) => S.unproject(K, c.x, c.y));
      const [a, b, c, d] = q;
      const d1 = [c[0] - a[0], c[1] - a[1]];
      const d2 = [d[0] - b[0], d[1] - b[1]];
      const den = d1[0] * d2[1] - d1[1] * d2[0];
      if (Math.abs(den) < 1e-12) return null;
      const t = ((b[0] - a[0]) * d2[1] - (b[1] - a[1]) * d2[0]) / den;
      const uv = S.project(K, a[0] + d1[0] * t, a[1] + d1[1] * t, 1);
      return { u: uv[0], v: uv[1] };
    }
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
        })
          .then((res) => {
            if (!extr || !cubeReady) return [res, []];
            return new Promise((resolve) => {
              cubePending = resolve;
              cubeWorker.postMessage({ type: "frame", id: Date.now(), width: w, height: h, rgba: data.buffer }, [data.buffer]);
            }).then((dets) => [res, dets]);
          })
          .then(([res, cubeDets]) => {
            busy = false;
            const raw = res ? res.points : [];
            const points = raw.map((p) => ({ X: p.i * chk.sq, Y: p.j * chk.sq, u: p.u, v: p.v }));
            const tags = cubeDets
              .filter((d) => d.id >= 24 && d.id <= 29)
              .map((d) => ({ id: d.id, corners: d.corners, ...tagCenter(d.corners, w, h) }))
              .filter((t) => Number.isFinite(t.u));
            cb({ points, raw, tags, n: points.length }, w, h);
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
      if (alive && typeof m.theta === "number") Object.assign(chassis, { x: m.x, y: m.y, th: m.theta, pan: m.servoAngleDeg, tilt: m.tiltAngleDeg, at: performance.now() });
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
          // (extrinsics: the robot as it was -- the camera has been still a while)
          const robot = extr && performance.now() - chassis.at < 1000 ? { pan: chassis.pan, tilt: chassis.tilt, odo: { x: chassis.x, y: chassis.y, th: chassis.th } } : {};
          if (extr && !robot.odo) {
            say("No telemetry from the robot -- picture not used", "#ff9090");
          } else {
            views.push({ ...finds, ...robot, w, h });
            if (manual) say(`Picture ${views.length}: ${finds.n} ${what}${extr ? `, ${finds.tags.length} cube tags` : ""}`, "#a0ffa0");
          }
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
        // (when it last moved or turned, for "stopped" -- the goto turns on the spot first)
        const th = typeof r.th === "number" ? r.th : r.theta;
        if (!tour.lastPos || Math.hypot(r.x - tour.lastPos.x, r.y - tour.lastPos.y) > 0.005 || Math.abs(wrap(th - tour.lastPos.th)) > 0.02) tour.lastPos = { x: r.x, y: r.y, th, at: now };
        const arrived = Math.hypot(r.x - stop.x, r.y - stop.y) < ARRIVED_M;
        const stopped = now - tour.legAt > 1500 && now - tour.lastPos.at > STOPPED_MS;
        if (arrived || stopped || now - tour.legAt > DRIVE_TIMEOUT_MS) {
          tour.lastPos = null;
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
      if (extr) {
        setTimeout(solveExtrinsics, 30);
        return;
      }
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

    // -- extrinsics ------------------------------------------------------------------------------------
    let params = null; // the robot's /params (settings), for the priors and the servo pulses
    fetch("/params", { cache: "no-store" }).then((r) => r.json()).then((p) => (params = p)).catch(() => {});
    let savedLean = null; // the chassis's lean as last measured (camcal "lean"; the servo step)
    fetch("/appdata/camcal", { cache: "no-store" }).then((r) => r.json()).then((d) => (savedLean = d && d.lean)).catch(() => {});
    const D2R = Math.PI / 180;
    function solveExtrinsics() {
      const E = Lynx.camextSolver;
      const w = views[0].w;
      const h = views[0].h;
      const K = lensInit(w, h);
      const prior = {};
      if (params) {
        prior.h = params.cameraHeightMm / 1000;
        prior.mountTilt = params.cameraTiltDeg * D2R;
      }
      if (savedLean) {
        prior.leanFwd = (+savedLean.fwdDeg || 0) * D2R;
        prior.leanLeft = (+savedLean.leftDeg || 0) * D2R;
      }
      const res = E.solve(
        views.filter((v) => v.w === w && v.h === h).map((v) => ({ K, pan: v.pan, tilt: v.tilt, odo: v.odo, points: v.raw, tags: v.tags })),
        { square: chk.sq, cube: cubeM, cols: chk.cols, rows: chk.rows, prior, fixed: ["panOffset", "panGainL", "panGainR", "tiltGainUp", "tiltGainDown"] },
      );
      state = "done";
      if (res.error) {
        say(res.error, "#ff9090");
        result = null;
        return;
      }
      result = { extr: true, ...res, w, h };
      say(`Solved: ${res.rms.toFixed(2)} px RMS over ${res.views} pictures (${res.spots} spots, ${res.tags} cube tags) -- Save to keep it`, "#a0ffa0");
    }
    function saveExtrinsics() {
      const r = result;
      if (!params) {
        say("The robot's settings didn't load -- is it reachable?", "#ff9090");
        return;
      }
      const P = r.params;
      const q = new URLSearchParams({ cameraHeightMm: (P.h * 1000).toFixed(1), cameraTiltDeg: (P.mountTilt / D2R).toFixed(2) });
      fetch(`/set?${q}`)
        .then((x) => {
          if (!x.ok) throw new Error(x.status);
          return fetch("/appdata/camcal", { cache: "no-store" }).then((y) => (y.ok ? y.json() : {})).catch(() => ({}));
        })
        .then((doc) => {
          const out = {
            version: 2, ...doc,
            extrinsics: {
              heightMm: +(P.h * 1000).toFixed(2), offsetMm: +(P.offset * 1000).toFixed(2), mountTiltDeg: +(P.mountTilt / D2R).toFixed(3),
              axisRollDeg: +(P.axisRoll / D2R).toFixed(3), camRollDeg: +(P.camRoll / D2R).toFixed(3),
              leanFwdDeg: +(P.leanFwd / D2R).toFixed(3), leanLeftDeg: +(P.leanLeft / D2R).toFixed(3),
              rmsPx: +r.rms.toFixed(3), views: r.views, at: new Date().toISOString().slice(0, 19),
            },
          };
          // (cameraTiltDeg is now the tilt to the chassis: the overlays add this lean)
          out.lean = { fwdDeg: +(P.leanFwd / D2R).toFixed(2), leftDeg: +(P.leanLeft / D2R).toFixed(2), from: "mount", at: out.extrinsics.at };
          return fetch("/appdata/camcal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(out) });
        })
        .then(() => {
          say("Saved: camera height, tilt and the robot's lean -- reload the page to use them", "#a0ffa0");
          return fetch("/params", { cache: "no-store" }).then((x) => x.json()).then((x) => (params = x));
        })
        .catch(() => say("Couldn't save -- is the robot reachable?", "#ff9090"));
    }

    function save() {
      if (result && result.extr) {
        saveExtrinsics();
        return;
      }
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
    // (only the Tour button starts it -- not fire, which a click anywhere on the picture is too)
    // (a capture asked for while a detection is under way waits for it)
    let wantShot = false;
    const manualCapture = () => {
      if (!tour && !capture(true)) wantShot = true;
    };
    Lynx.onAction("camera", manualCapture);
    const touch = Lynx.touchButtons();
    const tourBtn = touch.add("\u25b6 Tour", () => (tour ? stopTour() : startTour()));
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
      if (cubeWorker) cubeWorker.terminate();
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
      const label = tour ? "\u25a0 Stop" : "\u25b6 Tour";
      if (tourBtn.textContent !== label) tourBtn.textContent = label;
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
        (live.tags || []).forEach((t) => drawPoly(t.corners, live.w, live.h, "rgba(255,180,60,0.95)", 2));
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
      if (result && result.extr) {
        const r = result;
        const P = r.params;
        const sg = r.sigma;
        const pr = r.prior;
        const mm = (x) => (x * 1000).toFixed(1);
        const dg = (x) => (x / D2R).toFixed(2);
        lines.push(`height ${mm(P.h)} \u00b1 ${mm(sg.h)} mm (was ${mm(pr.h)}) \u00b7 lens ${mm(P.offset)} \u00b1 ${mm(sg.offset)} mm in front of the tilt axis`);
        lines.push(`mount tilt ${dg(P.mountTilt)} \u00b1 ${dg(sg.mountTilt)}\u00b0 (was ${dg(pr.mountTilt)})`);
        lines.push(`tilt axis roll ${dg(P.axisRoll)} \u00b1 ${dg(sg.axisRoll)}\u00b0 \u00b7 camera roll ${dg(P.camRoll)} \u00b1 ${dg(sg.camRoll)}\u00b0`);
        lines.push(`robot lean ${dg(P.leanFwd)} ± ${dg(sg.leanFwd)}° forward, ${dg(P.leanLeft)} ± ${dg(sg.leanLeft)}° left${savedLean ? ` (servo step: ${(+savedLean.fwdDeg).toFixed(2)}, ${(+savedLean.leftDeg).toFixed(2)})` : ""}`);
        lines.push(`RMS ${r.rms.toFixed(2)} px \u00b7 ${r.views} pictures (${r.full} whole board), ${r.spots} spots, ${r.corners} corners, ${r.tags} cube tags`);
      } else if (result) {
        const r = result;
        const o = r.old;
        lines.push(`f ${r.f.toFixed(1)} px (was ${o.f.toFixed(1)}) · center ${r.cx.toFixed(1)}, ${r.cy.toFixed(1)} (was ${o.cx.toFixed(1)}, ${o.cy.toFixed(1)})`);
        lines.push(`k1 ${r.k1.toFixed(4)} (was ${(o.k1 || 0).toFixed(4)}) · k2 ${r.k2.toFixed(4)} · FOV ${r.hfovDeg.toFixed(1)} x ${r.vfovDeg.toFixed(1)} deg`);
        lines.push(`RMS ${r.rms.toFixed(2)} px · ${r.views} pictures, ${r.points} corners${r.dropped ? ` (${r.dropped} outliers dropped)` : ""}`);
      }
      lines.forEach((s, i) => ar.text(s, v.x + 12, v.y + 24 + i * 18, { size: 13, color: i ? "#ffe080" : "#c0f0ff" }));
      if (state === "idle" && !views.length && !result) {
        ar.banner(extr ? "CAMERA MOUNT" : "CAMERA CALIBRATION", `Point the camera at the ${checker ? "checkerboard" : "AprilGrid"}${extr ? " (with the cube on the floor next to it)" : ""} target · \u25b6 Tour: the robot takes the pictures · \u{1F4F7} Capture: one picture`, { color: "#80d0ff" });
      }
      if (note && now - note.at < 4000) ar.text(note.text, v.cx, v.y + v.h - 40, { size: 15, align: "center", color: note.color });
    });

    return { debug: { views: () => views, result: () => result, tour: () => tour, solveNow, locate, plan } };
  };
})(window.Lynx);
