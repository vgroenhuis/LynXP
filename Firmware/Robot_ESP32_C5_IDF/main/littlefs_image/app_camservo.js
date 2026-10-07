// Camera calibration, step 2: the pan / tilt servos (the calibration app's
// "Calibrate: servos"; the math is camservo.js).
//
// Put the robot about half a metre in front of the checkerboard, facing it,
// with the whole board in view, and press ▶ Start. The robot then, by itself:
//   - drives 25 cm straight back and returns (pan 0): where "straight ahead"
//     really is;
//   - turns on the spot by -30, -60, -90, +30, +60, +90 deg while the pan
//     servo is told the opposite, so the board stays in view: what the servo
//     really turns;
//   - tilts up and down (pan 0): what the tilt servo really turns -- from
//     where it starts and then closer and closer to the board (down to
//     CLOSEST_M), so the camera can tilt further and still see part of it.
//     Which angles show enough of the board at each distance is worked out
//     from the first picture.
// Then it shows commanded -> measured angles and the new servo pulses; Save
// writes those (the pan's min / center / max, the tilt's min / max -- its
// center offset is the camera's mount tilt, the next step's).

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const PANS = [30, 60, 90, -30, -60, -90]; // deg
  const TILT_STEP = 6; // deg: tilt angles tried, -90..90 in these steps
  const DISTANCES = [0.35, 0.25, 0.17]; // m, camera to board: the tilt sweeps after the one where it starts
  const CLOSEST_M = 0.17; // (the robot's front stays clear of the board)
  const TILT_MIN_CORNERS = 30; // a tilt picture needs this many (part of the board)
  const PREDICT_MARGIN_PX = 12;
  const BACK_M = 0.25;
  const SETTLE_MS = 1200; // arrived and still: servos settle, the video catches up
  const STOPPED_MS = 800;
  const MOVE_TIMEOUT_MS = 20000;
  const SHOT_TIMEOUT_MS = 5000;
  const MIN_CORNERS = 40;
  const D2R = Math.PI / 180;
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  Lynx.games.camservo = (ar, cfg) => {
    const S = Lynx.camcalSolver;
    const E = Lynx.camextSolver;
    const CS = Lynx.camServo;
    const chk = {
      cols: Math.max(2, Math.round(+cfg.checkerCols || 13)),
      rows: Math.max(2, Math.round(+cfg.checkerRows || 14)),
      sq: (+cfg.checkerSquareMm || 20) / 1000,
    };
    const mid = [((chk.cols - 1) * chk.sq) / 2, ((chk.rows - 1) * chk.sq) / 2];
    const img = document.getElementById("camStream");
    const canvas = document.createElement("canvas");
    const g2 = canvas.getContext("2d", { willReadFrequently: true });
    let alive = true;
    let note = null;
    const say = (text, color = "#ffe080") => (note = { text, color, at: performance.now() });
    let live = { points: [], n: 0, full: false, w: 640, h: 480, at: 0 };
    let run = null; // {steps, i, phase, t, ...}
    let samples = [];
    let result = null;

    if (Lynx.cam && Lynx.cam.enableCors) Lynx.cam.enableCors();
    const worker = new Worker("checker_worker.js");
    let busy = false;
    let pending = null;
    worker.onmessage = (ev) => {
      if (ev.data.type === "corners" && pending) {
        const p = pending;
        pending = null;
        p(ev.data.result);
      }
    };
    let params = null;
    const loadParams = () => fetch("/params", { cache: "no-store" }).then((r) => r.json()).then((p) => (params = p)).catch(() => {});
    loadParams();
    const panMap = () => ({ minA: params.servoMinAngleDeg, maxA: params.servoMaxAngleDeg, minP: params.servoMinPulseUs, cenP: params.servoCenterPulseUs, maxP: params.servoMaxPulseUs });
    const tiltMap = () => ({ minA: params.tiltMinAngleDeg, maxA: params.tiltMaxAngleDeg, minP: params.tiltMinPulseUs, cenP: params.tiltCenterPulseUs, maxP: params.tiltMaxPulseUs });

    // the robot as it reports itself (odometry; the servos' commanded angles)
    const robot = { x: 0, y: 0, th: 0, pan: 0, tilt: 0, at: -1e9, movedAt: 0 };
    Lynx.control.onMessage("pose", (m) => {
      if (!alive || typeof m.theta !== "number") return;
      const now = performance.now();
      if (Math.hypot(m.x - robot.x, m.y - robot.y) > 0.002 || Math.abs(wrap(m.theta - robot.th)) > 0.003) robot.movedAt = now;
      Object.assign(robot, { x: m.x, y: m.y, th: m.theta, pan: m.servoAngleDeg, tilt: m.tiltAngleDeg, at: now });
    });
    const fresh = () => performance.now() - robot.at < 1000;

    // One picture -> cb({points (labeled: col, row, u, v), full, n}, w, h)
    function grab(cb) {
      if (busy || !img || !img.naturalWidth) return false;
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
        return false;
      }
      busy = true;
      const gray = S.grayOf(data, w, h);
      new Promise((resolve) => {
        pending = resolve;
        worker.postMessage({ type: "frame", id: Date.now(), width: w, height: h, gray: gray.buffer, opts: { maxCols: chk.cols, maxRows: chk.rows } }, [gray.buffer]);
      }).then((res) => {
        busy = false;
        const raw = res ? res.points : [];
        if (raw.length < 4) {
          cb({ points: [], full: false, n: raw.length }, w, h);
          return;
        }
        const lab = E.labelView(raw, chk.cols, chk.rows);
        cb({ points: lab.corners, full: lab.absolute, n: raw.length }, w, h);
      });
      return true;
    }
    // a picture's attitude to the board (the lens as calibrated)
    function measure(finds, w, h) {
      const lens = Lynx.lens.params(w, h);
      const K = { f: lens.f, cx: lens.cx, cy: lens.cy, k1: lens.k1 || 0, k2: lens.k2 || 0 };
      const pose = S.refinePose(finds.points.map((c) => ({ X: c.col * chk.sq, Y: c.row * chk.sq, u: c.u, v: c.v })), K);
      if (!pose || !(pose.rms < 2)) return null;
      const R = S.rodrigues(pose.r);
      return { att: CS.attitude(R, pose.t, finds.full ? mid : null), rms: pose.rms, R, t: pose.t, K };
    }

    // -- the tilt plan ------------------------------------------------------------------------------
    // From the first picture (the whole board, pan 0, tilt 0): the board's
    // corners in the camera's frame. Moved ahead by s and tilted up by t, how
    // many of them would be in the picture?
    function tiltPlan(m, w, h) {
      const corners = [];
      for (let c = 0; c < chk.cols; c++) {
        for (let r = 0; r < chk.rows; r++) {
          const X = c * chk.sq;
          const Y = r * chk.sq;
          corners.push([0, 1, 2].map((k) => m.R[k][0] * X + m.R[k][1] * Y + m.t[k]));
        }
      }
      const d0 = m.att.mid[2]; // the board's middle, straight ahead
      const seen = (s, tDeg) => {
        const t = tDeg * D2R;
        let n = 0;
        corners.forEach(([x, y, z0]) => {
          const z = z0 - s;
          const zz = -y * Math.sin(t) + z * Math.cos(t);
          const yy = y * Math.cos(t) + z * Math.sin(t);
          if (zz < 0.05) return;
          const [u, v] = S.project(m.K, x, yy, zz);
          if (u > PREDICT_MARGIN_PX && v > PREDICT_MARGIN_PX && u < w - PREDICT_MARGIN_PX && v < h - PREDICT_MARGIN_PX) n++;
        });
        return n;
      };
      const stops = [d0, ...DISTANCES.filter((d) => d < d0 - 0.05 && d >= CLOSEST_M)];
      // each angle once, from the farthest stop that sees enough of the board
      const done = new Set();
      const plan = [];
      stops.forEach((d) => {
        const tilts = [];
        for (let t = -90 + TILT_STEP; t < 90; t += TILT_STEP) {
          if (t !== 0 && !done.has(t) && seen(d0 - d, t) >= TILT_MIN_CORNERS + 10) {
            tilts.push(t);
            done.add(t);
          }
        }
        // (each stop: a tilt-0 picture first -- the reference -- then up, then down)
        if (tilts.length) plan.push({ ahead: d0 - d, d, tilts: [0, ...tilts.filter((t) => t > 0), ...tilts.filter((t) => t < 0).reverse()] });
      });
      return plan;
    }

    // -- the run ------------------------------------------------------------------------------------
    function takeControl(on) {
      if (Lynx.control.setDriveFilter) Lynx.control.setDriveFilter(on ? () => null : null);
    }
    function start() {
      if (run) return;
      if (!params) {
        say("The robot's settings didn't load -- is it reachable?", "#ff9090");
        loadParams();
        return;
      }
      if (!fresh()) {
        say("No telemetry from the robot", "#ff9090");
        return;
      }
      const m0 = live.full && performance.now() - live.at < 1500 && measure(live, live.w, live.h);
      if (!m0) {
        say("Point the camera at the checkerboard: the whole board in view", "#ff9090");
        return;
      }
      const { x, y, th } = robot;
      const tilts = tiltPlan(m0, live.w, live.h);
      const tiltSteps = [];
      tilts.forEach((stop) => {
        const at = { x: x + stop.ahead * Math.cos(th), y: y + stop.ahead * Math.sin(th) };
        stop.tilts.forEach((t) => tiltSteps.push({ kind: "tilt", ...at, heading: th, pan: 0, tilt: t, what: `${(stop.d * 100).toFixed(0)} cm from the board: tilt ${t > 0 ? "up " : t < 0 ? "down " : ""}${Math.abs(t)}\u00b0` }));
      });
      const back = { x: x - BACK_M * Math.cos(th), y: y - BACK_M * Math.sin(th) };
      const steps = [
        { kind: "zero", x, y, heading: th, pan: 0, tilt: 0, what: "straight ahead" },
        { kind: "zero", ...back, heading: th, pan: 0, tilt: 0, what: "straight back" },
        { kind: "zero", x, y, heading: th, pan: 0, tilt: 0, what: "and forward" },
        ...PANS.map((c) => ({ kind: "pan", x, y, heading: wrap(th - c * D2R), pan: c, tilt: 0, what: `pan ${c > 0 ? "left" : "right"} ${Math.abs(c)}°` })),
        { kind: "pan", x, y, heading: th, pan: 0, tilt: 0, what: "pan 0" },
        ...tiltSteps,
        { kind: "back", x, y, heading: th, pan: 0, tilt: 0, what: "back to the start" },
      ];
      samples = [];
      result = null;
      run = { steps, i: 0, phase: "move", t: performance.now(), gotoAt: 0, camAt: 0 };
      takeControl(true);
      say("Servo calibration: hands off -- the robot moves by itself", "#a0ffa0");
    }
    function finish(msg, color) {
      run = null;
      Lynx.control.send({ type: "camera_relative", pan: 0, tilt: 0 });
      Lynx.control.send({ type: "joystick", j1: 0, j2: 0 });
      takeControl(false);
      if (msg) say(msg, color);
    }
    function analyze() {
      const r = CS.analyze(samples, panMap(), tiltMap());
      if (r.error) {
        say(r.error, "#ff9090");
        result = null;
        return;
      }
      result = r;
      say("Done -- Save to use the new servo pulses", "#a0ffa0");
    }

    function step(now) {
      if (!run) return;
      const s = run.steps[run.i];
      // the camera: told its angles to the chassis, kept up (the robot drops it after 0.5 s silent)
      if (now - run.camAt > 100) {
        Lynx.control.send({ type: "camera_relative", pan: s.pan, tilt: s.tilt });
        run.camAt = now;
      }
      if (run.phase === "move") {
        if (now - run.gotoAt > 300) {
          Lynx.control.send({ type: "goto", x: +s.x.toFixed(4), y: +s.y.toFixed(4), heading: +s.heading.toFixed(4), forceHeading: true, maintainSpeed: false });
          run.gotoAt = now;
        }
        const there = Math.hypot(robot.x - s.x, robot.y - s.y) < 0.035 && Math.abs(wrap(robot.th - s.heading)) < 0.07;
        const aimed = Math.abs(robot.pan - s.pan) < 0.2 && Math.abs(robot.tilt - s.tilt) < 0.2;
        const still = now - robot.movedAt > STOPPED_MS && now - run.t > 1000;
        if ((there && aimed && still) || now - run.t > MOVE_TIMEOUT_MS) {
          if (now - run.t > MOVE_TIMEOUT_MS) say(`Didn't quite get there (${s.what}) -- measuring anyway`, "#ffb060");
          run.phase = "settle";
          run.t = now;
        }
      } else if (run.phase === "settle" && s.kind === "back") {
        next(); // (no picture: just out of the board's way)
      } else if (run.phase === "settle") {
        if (now - run.t > SETTLE_MS) {
          run.phase = "shoot";
          run.t = now;
        }
      } else if (run.phase === "shoot") {
        if (busy) return;
        grab((finds, w, h) => {
          if (!run) return;
          live = { ...finds, w, h, at: performance.now() };
          const ok = finds.n >= (s.kind === "tilt" ? TILT_MIN_CORNERS : MIN_CORNERS) && (s.kind !== "zero" || finds.full);
          const m = ok && measure(finds, w, h);
          if (m) {
            samples.push({ kind: s.kind, pan: s.pan, tilt: s.tilt, x: robot.x, y: robot.y, th: robot.th, att: m.att, rms: m.rms, n: finds.n });
            next();
          } else if (performance.now() - run.t > SHOT_TIMEOUT_MS) {
            say(`Board not seen well enough (${s.what}${s.kind === "zero" ? ": needs the whole board" : ""}) -- skipped`, "#ffb060");
            next();
          }
        });
      }
    }
    function next() {
      run.i++;
      run.phase = "move";
      run.t = performance.now();
      if (run.i >= run.steps.length) {
        finish();
        analyze();
      }
    }

    function save() {
      if (!result) {
        say("Nothing to save yet -- run it first (\u25b6 Start)", "#ff9090");
        return;
      }
      const P = result.newPan;
      const T = result.newTilt;
      const old = [params.servoMinPulseUs, params.servoCenterPulseUs, params.servoMaxPulseUs, params.tiltMinPulseUs, params.tiltMaxPulseUs];
      const now = [P.minP, P.cenP, P.maxP, T.minP, T.maxP];
      if (now.some((v, i) => !Number.isFinite(v) || Math.abs(v - old[i]) > 250)) {
        say("The new pulses are too far from the old ones -- not saved (check the setup and run it again)", "#ff9090");
        return;
      }
      const q = new URLSearchParams({ servoMinPulseUs: P.minP, servoCenterPulseUs: P.cenP, servoMaxPulseUs: P.maxP, tiltMinPulseUs: T.minP, tiltMaxPulseUs: T.maxP });
      fetch(`/set?${q}`)
        .then((x) => {
          if (!x.ok) throw new Error(x.status);
          return fetch("/appdata/camcal", { cache: "no-store" }).then((y) => (y.ok ? y.json() : {})).catch(() => ({}));
        })
        .then((doc) => {
          const r = result;
          const out = {
            version: 2, ...doc,
            servos: {
              panZeroDeg: +r.p0Deg.toFixed(2), horizonDeg: +r.horizonDeg.toFixed(2), rollDeg: +r.rollDeg.toFixed(2),
              pan: r.pan.map((p) => [p.cmd, +p.actual.toFixed(2)]), tilt: r.tilt.map((p) => [p.cmd, +p.actual.toFixed(2)]),
              oldPulses: old, newPulses: now, at: new Date().toISOString().slice(0, 19),
            },
          };
          return fetch("/appdata/camcal", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(out) });
        })
        .then(() => {
          say("Saved: the new servo pulses are in use", "#a0ffa0");
          result = null;
          return loadParams();
        })
        .catch(() => say("Couldn't save -- is the robot reachable?", "#ff9090"));
    }

    // -- controls ------------------------------------------------------------------------------------------
    // (only this button starts it -- not fire, which a click anywhere on the picture is too)
    const touch = Lynx.touchButtons();
    const startBtn = touch.add("\u25b6 Start", () => (run ? finish("Stopped", "#ffe080") : start()));
    touch.add("\u{1F4BE} Save", () => save());
    ar.onDestroy(() => {
      alive = false;
      worker.terminate();
      if (run) finish();
    });

    // -- drawing ------------------------------------------------------------------------------------------
    let liveAt = 0;
    ar.onFrame((now) => {
      step(now);
      const label = run ? "\u25a0 Stop" : "\u25b6 Start";
      if (startBtn.textContent !== label) startBtn.textContent = label;
      if (!run && !busy && now - liveAt > 300) {
        liveAt = now;
        grab((finds, w, h) => (live = { ...finds, w, h, at: performance.now() }));
      }
      const v = ar.view;
      const g = ar.ctx;
      if (now - live.at < 1000) {
        const sx = v.w / live.w;
        const sy = v.h / live.h;
        g.strokeStyle = live.full ? "rgba(60,255,120,0.95)" : "rgba(255,200,60,0.95)";
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
      const lines = [];
      const s = run && run.steps[run.i];
      lines.push(`${live.n} corners${live.full ? " (whole board)" : ""} \u00b7 ${samples.length} pictures${s ? ` \u00b7 ${run.i + 1}/${run.steps.length}: ${s.what} (${{ move: "moving", settle: "settling", shoot: "picture" }[run.phase]})` : ""}`);
      if (run && run.i === 0 && run.phase === "move") lines.push(`tilt: ${run.steps.filter((q) => q.kind === "tilt" && q.tilt).length} pictures planned, ${Math.min(...run.steps.map((q) => q.tilt))}\u00b0 to ${Math.max(...run.steps.map((q) => q.tilt))}\u00b0`);
      if (result) {
        const r = result;
        const f = (x) => (x >= 0 ? "+" : "") + x.toFixed(1);
        lines.push(`straight ahead is at pan ${f(r.p0Deg)}° (legs ${r.legs.map((l) => f(l.p0Deg)).join(", ")}) · camera roll ${f(r.rollDeg)}° · horizon ${f(r.horizonDeg)}° (if the board is upright)`);
        lines.push(`pan: ${r.pan.map((p) => `${p.cmd}→${p.actual.toFixed(1)}`).join("  ")}`);
        lines.push(`tilt: ${r.tilt.map((p) => `${p.cmd}→${p.actual.toFixed(1)}`).join("  ")}`);
        const P = r.newPan;
        const T = r.newTilt;
        const p = params;
        lines.push(`pan pulses ${p.servoMinPulseUs}/${p.servoCenterPulseUs}/${p.servoMaxPulseUs} → ${P.minP}/${P.cenP}/${P.maxP} · tilt ${p.tiltMinPulseUs}/${p.tiltCenterPulseUs}/${p.tiltMaxPulseUs} → ${T.minP}/${T.cenP}/${T.maxP}`);
        const worst = Math.max(...r.pan.map((q) => Math.abs(q.after)), ...r.tilt.map((q) => Math.abs(q.after)));
        lines.push(`with them, the measured angles are within ${worst.toFixed(1)}° of the commanded ones`);
      }
      lines.forEach((t, i) => ar.text(t, v.x + 12, v.y + 24 + i * 18, { size: 13, color: i ? "#ffe080" : "#c0f0ff" }));
      if (!run && !samples.length && !result) {
        ar.banner("SERVO CALIBRATION", "Robot ~0.5 m in front of the checkerboard, facing it, whole board in view · \u25b6 Start: it drives and turns by itself", { color: "#80d0ff" });
      }
      if (note && now - note.at < 5000) ar.text(note.text, v.cx, v.y + v.h - 40, { size: 15, align: "center", color: note.color });
    });

    return { debug: { samples: () => samples, result: () => result, run: () => run, analyze, tiltPlan } };
  };
})(window.Lynx);
