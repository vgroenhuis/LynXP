// Camera calibration, step 4: a check -- the checkerboard drawn over the
// video (the calibration app's "Calibrate: check").
//
// "Locate board" (with the whole board in view and the camera still) fixes
// the board's corners in the room: their pose from that picture (the lens as
// calibrated), put in the world with the camera model (Lynx.cameraFrame:
// servos, mount, lean, rolls). Kept on the robot (appdata "boardcheck") in
// odometry coordinates -- until the odometry is reset. From then on its
// corners and grid are drawn where the camera model says they are, from
// wherever the camera looks; the corners the camera actually sees are
// marked (green), with how far the drawing is off them (pixels): pan, tilt
// or drive around and watch it stay on the board -- or not.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const LIVE_EVERY_MS = 350;
  const MATCH_PX = 25; // a seen corner this close to a drawn one is that one
  const STILL_MS = 800;

  Lynx.games.boardcheck = (ar, cfg) => {
    const S = Lynx.camcalSolver;
    const E = Lynx.camextSolver;
    const chk = {
      cols: Math.max(2, Math.round(+cfg.checkerCols || 13)),
      rows: Math.max(2, Math.round(+cfg.checkerRows || 14)),
      sq: (+cfg.checkerSquareMm || 20) / 1000,
    };
    const img = document.getElementById("camStream");
    const canvas = document.createElement("canvas");
    const g2 = canvas.getContext("2d", { willReadFrequently: true });
    let alive = true;
    let note = null;
    const say = (text, color = "#ffe080") => (note = { text, color, at: performance.now() });
    let board = null; // {cols, rows, corners: [[x, y, h]] (col-major: col * rows + row), at}
    let live = { points: [], n: 0, full: false, turned: false, w: 640, h: 480, at: 0, frame: null };
    let busy = false;
    let pending = null;
    let wantLocate = false;
    let err = null; // {mean, max, n}

    if (Lynx.cam && Lynx.cam.enableCors) Lynx.cam.enableCors();
    const worker = new Worker("checker_worker.js");
    worker.onmessage = (ev) => {
      if (ev.data.type === "corners" && pending) {
        const p = pending;
        pending = null;
        p(ev.data.result);
      }
    };
    fetch("/appdata/boardcheck", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d && Array.isArray(d.o) && Array.isArray(d.ex) && Array.isArray(d.ey)) board = expand(d);
      })
      .catch(() => {});

    // the camera still (as shown with the video): the board's pose can be trusted
    const history = [];
    function stillFor(now) {
      history.push({ t: now, th: ar.camTheta, tilt: ar.tilt, x: ar.pose.x, y: ar.pose.y });
      while (history.length && history[0].t < now - 3000) history.shift();
      const last = history[history.length - 1];
      let since = now;
      for (let i = history.length - 1; i >= 0; i--) {
        const o = history[i];
        if (Math.abs(o.th - last.th) > 0.003 || Math.abs(o.tilt - last.tilt) > 0.003 || Math.hypot(o.x - last.x, o.y - last.y) > 0.002) break;
        since = o.t;
      }
      return now - since;
    }

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
      const frame = ar.frame; // (the camera as the picture was shown)
      const gray = S.grayOf(data, w, h);
      new Promise((resolve) => {
        pending = resolve;
        worker.postMessage({ type: "frame", id: Date.now(), width: w, height: h, gray: gray.buffer, opts: { maxCols: chk.cols, maxRows: chk.rows } }, [gray.buffer]);
      }).then((res) => {
        busy = false;
        const raw = res ? res.points : [];
        if (raw.length < 4) {
          cb({ points: [], n: raw.length, full: false, w, h, frame });
          return;
        }
        const lab = E.labelView(raw, chk.cols, chk.rows);
        cb({ points: lab.corners, n: raw.length, full: lab.absolute, turned: lab.turned, w, h, frame });
      });
      return true;
    }

    // Kept compact (the robot's documents are small): the first corner and
    // the steps along a row (ex) and a column (ey), world metres.
    function expand(d) {
      const corners = [];
      for (let c = 0; c < d.cols; c++) {
        for (let r = 0; r < d.rows; r++) corners.push([0, 1, 2].map((k) => d.o[k] + c * d.ex[k] + r * d.ey[k]));
      }
      return { ...d, corners };
    }

    // The board's corners in the world, from one picture with all of them.
    function locate(f) {
      const lens = Lynx.lens.params(f.w, f.h);
      const K = { f: lens.f, cx: lens.cx, cy: lens.cy, k1: lens.k1 || 0, k2: lens.k2 || 0 };
      const pose = S.refinePose(f.points.map((c) => ({ X: c.col * chk.sq, Y: c.row * chk.sq, u: c.u, v: c.v })), K);
      if (!pose || !(pose.rms < 1.5)) return null;
      const R = S.rodrigues(pose.r);
      const F = f.frame;
      const cols = f.turned ? chk.rows : chk.cols;
      const rows = f.turned ? chk.cols : chk.rows;
      const world = (X, Y) => {
        const p = [0, 1, 2].map((k) => R[k][0] * X + R[k][1] * Y + pose.t[k]);
        return [0, 1, 2].map((k) => F.C[k] + p[0] * F.right[k] + p[1] * F.down[k] + p[2] * F.fwd[k]);
      };
      const o = world(0, 0);
      const ex = world(chk.sq, 0).map((v, k) => v - o[k]);
      const ey = world(0, chk.sq).map((v, k) => v - o[k]);
      const r6 = (a) => a.map((v) => +v.toFixed(6));
      return { cols, rows, o: r6(o), ex: r6(ex), ey: r6(ey), rmsPx: +pose.rms.toFixed(2), at: new Date().toISOString().slice(0, 19) };
    }

    function step(now) {
      if (busy || now - live.at < LIVE_EVERY_MS) return;
      const still = stillFor(now) > STILL_MS;
      grab((f) => {
        live = { ...f, at: performance.now() };
        if (wantLocate) {
          if (!still) return; // (wait for the camera to be still)
          wantLocate = false;
          if (!f.full) {
            say("Locate: the whole board must be in view", "#ff9090");
            return;
          }
          const b = locate(f);
          if (!b) {
            say("Couldn't place the board from this picture -- try again", "#ff9090");
            return;
          }
          board = expand(b);
          fetch("/appdata/boardcheck", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(b) }).catch(() => {});
          say("Board located -- now pan, tilt or drive: the drawn grid should stay on it", "#a0ffa0");
        }
      });
    }

    const touch = Lynx.touchButtons();
    touch.add("\u{1F4CC} Locate board", () => {
      wantLocate = true;
      say("Hold still...");
    });
    ar.onDestroy(() => {
      alive = false;
      worker.terminate();
    });

    // -- drawing --------------------------------------------------------------------------------
    ar.onFrame((now) => {
      if (!alive) return;
      step(now);
      const v = ar.view;
      const g = ar.ctx;
      // the board where the camera model puts it
      let drawn = [];
      if (board) {
        drawn = board.corners.map((p) => (ar.projectLens || ar.project)(p[0], p[1], p[2])); // (through the lens: on the video)
        g.save();
        g.strokeStyle = "rgba(255,80,220,0.55)";
        g.lineWidth = 1;
        const at = (c, r) => drawn[c * board.rows + r];
        const line = (pts) => {
          g.beginPath();
          let pen = false;
          pts.forEach((p) => {
            if (!p) {
              pen = false;
              return;
            }
            if (pen) g.lineTo(p.x, p.y);
            else g.moveTo(p.x, p.y);
            pen = true;
          });
          g.stroke();
        };
        for (let c = 0; c < board.cols; c++) line(Array.from({ length: board.rows }, (_, r) => at(c, r)));
        for (let r = 0; r < board.rows; r++) line(Array.from({ length: board.cols }, (_, c) => at(c, r)));
        g.fillStyle = "rgba(255,80,220,0.95)";
        drawn.forEach((p) => {
          if (p) g.fillRect(p.x - 2, p.y - 2, 4, 4);
        });
        g.restore();
      }
      // the corners seen (green), and how far the drawing is off them
      if (now - live.at < 1000 && live.points.length) {
        const sx = v.w / live.w;
        const sy = v.h / live.h;
        g.save();
        g.strokeStyle = "rgba(60,255,120,0.95)";
        g.lineWidth = 1.5;
        const ds = [];
        live.points.forEach((p) => {
          const x = v.x + p.u * sx;
          const y = v.y + p.v * sy;
          g.beginPath();
          g.moveTo(x - 5, y);
          g.lineTo(x + 5, y);
          g.moveTo(x, y - 5);
          g.lineTo(x, y + 5);
          g.stroke();
          let best = Infinity;
          drawn.forEach((q) => {
            if (q) best = Math.min(best, Math.hypot(q.x - x, q.y - y));
          });
          if (best < MATCH_PX * Math.max(sx, sy)) ds.push(best / sx); // (in picture pixels)
        });
        g.restore();
        err = ds.length ? { mean: ds.reduce((a, b) => a + b, 0) / ds.length, max: Math.max(...ds), n: ds.length } : null;
      }
      const lines = [];
      lines.push(`${live.n} corners seen${live.full ? " (whole board)" : ""}${board ? ` · board located ${board.at.slice(5, 16).replace("T", " ")}` : " · no board located yet"}`);
      if (board && err) lines.push(`drawn vs seen: ${err.mean.toFixed(1)} px on average, ${err.max.toFixed(1)} px worst (${err.n} corners)`);
      if (Lynx.camTiltFix) lines.push(`camera tilt corrected by ${((Lynx.camTiltFix.rad * 180) / Math.PI).toFixed(2)}° (from a cube, at pan ${Lynx.camTiltFix.panDeg.toFixed(0)}° tilt ${Lynx.camTiltFix.tiltDeg.toFixed(0)}°)`);
      lines.forEach((t, i) => ar.text(t, v.x + 12, v.y + 24 + i * 18, { size: 13, color: i ? "#ffe080" : "#c0f0ff" }));
      if (!board) ar.banner("CALIBRATION CHECK", "Whole checkerboard in view, camera still · \u{1F4CC} Locate board", { color: "#80d0ff" });
      if (note && now - note.at < 5000) ar.text(note.text, v.cx, v.y + v.h - 40, { size: 15, align: "center", color: note.color });
    });

    return { debug: { board: () => board, live: () => live, err: () => err } };
  };
})(window.Lynx);
