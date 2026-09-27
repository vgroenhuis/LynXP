// In-browser object detection: YOLOv8n (COCO, 80 classes) run by
// onnxruntime-web on this phone/computer, on frames grabbed from the
// camera's MJPEG stream.
//
// - The runtime (JS + an ~11 MB wasm) comes from jsDelivr, pinned to one
//   version; the browser caches it. Plain wasm, single-threaded: pages on
//   http:// aren't "secure contexts", which rules out both WebGPU and the
//   SharedArrayBuffer that multi-threaded wasm needs.
// - The model (~6.8 MB) is served by the robot itself (model_store.cpp),
//   under a URL carrying its checksum, so it's cached for good.
// - Frames: the <img> showing the stream is switched to crossorigin mode
//   (the camera firmware sends Access-Control-Allow-Origin), drawn
//   letterboxed into a square canvas and fed to the model.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const ORT_VERSION = "1.20.1";
  const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
  const IOU_THRESHOLD = 0.45;
  const MAX_BOXES = 40;

  let ortPromise = null;
  function loadOrt() {
    if (!ortPromise) {
      ortPromise = new Promise((resolve, reject) => {
        if (window.ort) return resolve(window.ort);
        const s = document.createElement("script");
        s.src = ORT_BASE + "ort.wasm.min.js";
        s.onload = () => {
          window.ort.env.wasm.wasmPaths = ORT_BASE;
          window.ort.env.wasm.numThreads = 1;
          resolve(window.ort);
        };
        s.onerror = () => {
          ortPromise = null;
          reject(new Error("Couldn't download the ONNX runtime from cdn.jsdelivr.net -- is this device online?"));
        };
        document.head.appendChild(s);
      });
    }
    return ortPromise;
  }

  // Downloads the model from the robot with progress, resolves to bytes.
  function loadModelBytes(onStatus) {
    return fetch("/models/info", { cache: "no-store" })
      .then((r) => r.json())
      .then((info) => {
        if (!info.installed) throw new Error("No detection model installed on the robot yet -- see the Games & apps page.");
        return fetch(`/models/model.onnx?v=${info.version}`).then(async (r) => {
          if (!r.ok || !r.body) throw new Error(`Model download failed (HTTP ${r.status})`);
          const reader = r.body.getReader();
          const buf = new Uint8Array(info.bytes);
          let got = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (got + value.length > buf.length) throw new Error("Model is bigger than the robot said -- reload to retry.");
            buf.set(value, got);
            got += value.length;
            onStatus(`Loading detection model ${Math.round((100 * got) / info.bytes)}%`);
          }
          if (got !== info.bytes) throw new Error("Model download was cut short -- reload to retry.");
          return buf;
        });
      });
  }

  let sessionPromise = null;
  Lynx.loadDetector = (onStatus = () => {}) => {
    if (!sessionPromise) {
      sessionPromise = Promise.all([loadOrt(), loadModelBytes(onStatus)])
        .then(([ort, bytes]) => {
          onStatus("Starting detection model...");
          return ort.InferenceSession.create(bytes, { executionProviders: ["wasm"], graphOptimizationLevel: "all" });
        })
        .catch((e) => {
          sessionPromise = null;
          throw e;
        });
    }
    return sessionPromise;
  };

  function iou(a, b) {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    return inter / (a.w * a.h + b.w * b.h - inter || 1);
  }

  // Runs the model on one source image/canvas. allowed: Set of class
  // indices, or null for all. Returns boxes in source-pixel coordinates.
  Lynx.detectOnce = async (session, source, srcW, srcH, size, confidence, allowed) => {
    const ort = window.ort;
    const canvas = Lynx.detectOnce.canvas || (Lynx.detectOnce.canvas = document.createElement("canvas"));
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext("2d", { willReadFrequently: true });
    g.fillStyle = "rgb(114,114,114)";
    g.fillRect(0, 0, size, size);
    const scale = Math.min(size / srcW, size / srcH);
    g.drawImage(source, 0, 0, srcW * scale, srcH * scale);
    const px = g.getImageData(0, 0, size, size).data; // throws SecurityError if the frame is cross-origin-tainted
    const plane = size * size;
    const input = new Float32Array(3 * plane);
    for (let i = 0; i < plane; i++) {
      input[i] = px[i * 4] / 255;
      input[plane + i] = px[i * 4 + 1] / 255;
      input[2 * plane + i] = px[i * 4 + 2] / 255;
    }
    const out = await session.run({ [session.inputNames[0]]: new ort.Tensor("float32", input, [1, 3, size, size]) });
    const t = out[session.outputNames[0]];
    const n = t.dims[2];
    const d = t.data;
    const cand = [];
    for (let a = 0; a < n; a++) {
      let bestC = -1;
      let bestS = confidence;
      for (let c = 0; c < 80; c++) {
        const s = d[(4 + c) * n + a];
        if (s > bestS && (!allowed || allowed.has(c))) {
          bestS = s;
          bestC = c;
        }
      }
      if (bestC < 0) continue;
      const cx = d[a] / scale;
      const cy = d[n + a] / scale;
      const w = d[2 * n + a] / scale;
      const h = d[3 * n + a] / scale;
      cand.push({ cls: bestC, name: Lynx.COCO_CLASSES[bestC], score: bestS, x: cx - w / 2, y: cy - h / 2, w, h });
    }
    cand.sort((a, b) => b.score - a.score);
    const keep = [];
    for (const c of cand) {
      if (keep.length >= MAX_BOXES) break;
      if (keep.every((k) => k.cls !== c.cls || iou(k, c) < IOU_THRESHOLD)) keep.push(c);
    }
    return keep;
  };

  // Continuous detection on the camera stream. Returns a handle whose
  // .latest = {boxes, at, ms, fps} is updated after every run.
  Lynx.startDetection = (opts) => {
    const img = document.getElementById("camStream");
    const handle = { latest: { boxes: [], at: 0, ms: 0, fps: 0 }, status: "Loading...", error: null, running: true };
    const size = Number(opts.inputSize) || 320;
    const minPeriodMs = 1000 / (opts.maxFps || 8);
    let allowed = null;
    if (opts.classes && opts.classes.length) {
      allowed = new Set(opts.classes.map((c) => Lynx.COCO_CLASSES.indexOf(c)).filter((i) => i >= 0));
    }
    // Needed before any pixel can be read back -- reconnects the stream.
    Lynx.cam.enableCors();

    Lynx.loadDetector((s) => (handle.status = s))
      .then(async (session) => {
        handle.status = "";
        let lastDone = performance.now();
        const times = [];
        while (handle.running) {
          const t0 = performance.now();
          if (!img.naturalWidth || !img.complete) {
            await new Promise((r) => setTimeout(r, 200));
            continue;
          }
          try {
            const boxes = await Lynx.detectOnce(session, img, img.naturalWidth, img.naturalHeight, size, opts.confidence, allowed);
            const now = performance.now();
            times.push(now - lastDone);
            if (times.length > 10) times.shift();
            lastDone = now;
            handle.latest = { boxes, at: now, ms: now - t0, fps: 1000 / (times.reduce((a, b) => a + b, 0) / times.length) };
            handle.error = null;
          } catch (e) {
            handle.error = e && e.name === "SecurityError"
              ? "The camera's frames can't be read (CORS). Update the camera firmware."
              : `Detection error: ${e.message || e}`;
            await new Promise((r) => setTimeout(r, 1000));
          }
          const wait = minPeriodMs - (performance.now() - t0);
          await new Promise((r) => setTimeout(r, Math.max(10, wait)));
        }
      })
      .catch((e) => (handle.error = e.message || String(e)));
    handle.stop = () => (handle.running = false);
    return handle;
  };

  const classColor = (cls) => `hsl(${(cls * 47) % 360}, 90%, 55%)`;

  // Draws detection boxes (image coords) onto the AR canvas.
  Lynx.drawDetections = (ar, boxes, highlight) => {
    const v = ar.view;
    const ctx = ar.ctx;
    boxes.forEach((b) => {
      const x = v.offX + b.x * v.scale;
      const y = v.offY + b.y * v.scale;
      const w = b.w * v.scale;
      const h = b.h * v.scale;
      const hot = highlight ? highlight(b) : true;
      const color = hot ? classColor(b.cls) : "rgba(255,255,255,0.35)";
      ctx.save();
      ctx.lineWidth = hot ? 3 : 1.5;
      ctx.strokeStyle = color;
      ctx.strokeRect(x, y, w, h);
      if (hot) {
        const label = `${b.name} ${Math.round(b.score * 100)}%`;
        ctx.font = "bold 13px system-ui, sans-serif";
        const tw = ctx.measureText(label).width + 8;
        const ly = y > 18 ? y - 18 : y;
        ctx.fillStyle = color;
        ctx.fillRect(x - 1.5, ly, tw, 18);
        ctx.fillStyle = "#000";
        ctx.fillText(label, x + 3, ly + 13);
      }
      ctx.restore();
    });
  };

  // -- Object detection app ----------------------------------------------------
  Lynx.games.detect = (ar, cfg) => {
    const classes = String(cfg.classes || "").split(",").map((s) => s.trim()).filter(Boolean);
    const det = Lynx.startDetection({ inputSize: cfg.inputSize, maxFps: cfg.maxFps, confidence: cfg.confidence, classes });
    ar.onDestroy(det.stop);
    const follow = cfg.follow || "";
    let lastFollowAt = 0;
    let following = false;
    let paused = false;

    Lynx.onAction("fire", () => (paused = !paused));

    // Camera follow: proportional rate control on pan/tilt toward the
    // biggest box of the chosen class, with a deadband so it settles.
    function steer(boxes) {
      if (!follow || paused) return;
      const v = ar.view;
      const target = boxes.filter((b) => b.name === follow).sort((a, b) => b.w * b.h - a.w * a.h)[0];
      if (!target) {
        if (following) {
          Lynx.control.send({ type: "control_frame_rotate", value: 0 });
          Lynx.control.send({ type: "tilt_rate", value: 0 });
          following = false;
        }
        return;
      }
      const ex = (target.x + target.w / 2 - v.imgW / 2) / (v.imgW / 2);
      const ey = (target.y + target.h / 2 - v.imgH / 2) / (v.imgH / 2);
      const dead = (e) => (Math.abs(e) < 0.1 ? 0 : e);
      Lynx.control.send({ type: "control_frame_rotate", value: Math.max(-0.6, Math.min(0.6, -dead(ex) * 0.7)) });
      Lynx.control.send({ type: "tilt_rate", value: Math.max(-0.6, Math.min(0.6, -dead(ey) * 0.7)) });
      following = true;
    }
    ar.onDestroy(() => {
      if (!following) return;
      Lynx.control.send({ type: "control_frame_rotate", value: 0 });
      Lynx.control.send({ type: "tilt_rate", value: 0 });
    });

    ar.onFrame(() => {
      const v = ar.view;
      const l = det.latest;
      if (l.at !== lastFollowAt) {
        lastFollowAt = l.at;
        steer(l.boxes);
      }
      const fresh = performance.now() - l.at < 1500;
      if (fresh) Lynx.drawDetections(ar, l.boxes);

      const counts = {};
      if (fresh) l.boxes.forEach((b) => (counts[b.name] = (counts[b.name] || 0) + 1));
      const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${c}× ${Lynx.emojiFor(n)} ${n}`).join("   ");
      ar.text(summary || (det.status || det.error ? "" : "nothing detected"), v.cx, v.y + 30, { size: 16, align: "center" });
      const info = det.error || det.status || `YOLOv8n · ${cfg.inputSize}px · ${Math.round(l.ms)} ms · ${l.fps.toFixed(1)} fps` +
        (follow ? (paused ? " · follow paused" : ` · following ${follow}`) : "");
      ar.text(info, v.cx, v.y + v.h - 14, { size: 13, align: "center", color: det.error ? "#ff6050" : "#e0e0e0" });
    });
    return { actionLabel: follow ? "⏯ Follow on/off" : null };
  };

  // -- Scavenger Hunt -----------------------------------------------------------
  const CONFIRM_FRAMES = 2; // consecutive detections needed, so one lucky frame doesn't count

  Lynx.games.scavenger = (ar, cfg) => {
    const pool = String(cfg.objects || "").split(",").map((s) => s.trim()).filter((c) => Lynx.COCO_CLASSES.includes(c));
    if (!pool.length) pool.push("cup", "bottle", "chair", "book");
    const det = Lynx.startDetection({ inputSize: 320, maxFps: 10, confidence: Math.min(0.25, cfg.confidence), classes: pool });
    ar.onDestroy(det.stop);
    let state = "title"; // title | hunting | found | timeout | done
    let stateTime = 0;
    let round = 0;
    let score = 0;
    let target = null;
    let remaining = [];
    let streak = 0;
    let lastSeenAt = 0;
    let best = null;
    let rankMsg = "";
    let results = [];
    Lynx.bestScore("scavenger").then((b) => (best = b));

    function nextRound() {
      if (round >= cfg.rounds) {
        state = "done";
        stateTime = 0;
        rankMsg = "";
        Lynx.submitScore("scavenger", score).then((rank) => {
          rankMsg = rank ? `#${rank} on the robot's scoreboard!` : "";
          if (rank === 1) best = score;
        });
        Lynx.sfx.play("found");
        return;
      }
      if (!remaining.length) remaining = pool.slice().sort(() => Math.random() - 0.5);
      target = remaining.pop();
      round++;
      streak = 0;
      state = "hunting";
      stateTime = 0;
      Lynx.sfx.play("beep");
    }

    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title" || (state === "done" && stateTime > 1.5)) {
        round = 0;
        score = 0;
        results = [];
        remaining = [];
        nextRound();
      } else if (state === "hunting") {
        results.push({ target, found: false });
        state = "timeout";
        stateTime = 0;
        Lynx.sfx.play("fail");
      }
    });

    ar.onFrame((now, dt) => {
      stateTime += dt;
      const v = ar.view;
      const l = det.latest;
      const fresh = now - l.at < 1500;

      if (state === "hunting") {
        if (l.at !== lastSeenAt) {
          lastSeenAt = l.at;
          const hit = l.boxes.some((b) => b.name === target && b.score >= cfg.confidence);
          streak = hit ? streak + 1 : 0;
          if (streak >= CONFIRM_FRAMES) {
            const left = Math.max(0, cfg.secondsPerItem - stateTime);
            const pts = 100 + Math.round(left * 5);
            score += pts;
            results.push({ target, found: true, pts, secs: stateTime });
            state = "found";
            stateTime = 0;
            Lynx.sfx.play("found");
          }
        }
        if (state === "hunting" && stateTime > cfg.secondsPerItem) {
          results.push({ target, found: false });
          state = "timeout";
          stateTime = 0;
          Lynx.sfx.play("fail");
        }
      } else if ((state === "found" || state === "timeout") && stateTime > 2.2) {
        nextRound();
      }

      if (fresh && state !== "title") Lynx.drawDetections(ar, l.boxes, (b) => b.name === target);

      if (det.error || det.status) {
        ar.text(det.error || det.status, v.cx, v.y + v.h - 14, { size: 13, align: "center", color: det.error ? "#ff6050" : "#e0e0e0" });
      }
      if (state === "title") {
        ar.flash("#000", 0.45);
        ar.banner("SCAVENGER HUNT", "Press FIRE to start", { color: "#40d0ff" });
        ar.text(`${cfg.rounds} objects · ${cfg.secondsPerItem} s each · drive around and point the camera at them`, v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
        if (best !== null) ar.text(`Best on this robot: ${best}`, v.cx, v.cy + v.h * 0.27, { size: 14, align: "center", color: "#ffd040" });
        return;
      }
      if (state === "hunting") {
        const left = Math.max(0, cfg.secondsPerItem - stateTime);
        ar.text(`Find: ${Lynx.emojiFor(target)} ${target.toUpperCase()}`, v.cx, v.y + 44, { size: 30, align: "center", color: "#40d0ff" });
        const barW = Math.min(v.w * 0.5, 360);
        const ctx = ar.ctx;
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(v.cx - barW / 2, v.y + 56, barW, 8);
        ctx.fillStyle = left < 10 ? "#ff5040" : "#40d0ff";
        ctx.fillRect(v.cx - barW / 2, v.y + 56, (barW * left) / cfg.secondsPerItem, 8);
        if (streak > 0) ar.text("I think I see it...", v.cx, v.y + 86, { size: 15, align: "center", color: "#a0ffb0" });
        ar.text(`Object ${round}/${cfg.rounds}   Score ${score}   (FIRE = skip)`, v.cx, v.y + v.h - 36, { size: 15, align: "center" });
      } else if (state === "found") {
        const r = results[results.length - 1];
        ar.banner(`FOUND ${r.target.toUpperCase()}!`, `+${r.pts} · in ${r.secs.toFixed(1)} s`, { color: "#30ff60" });
      } else if (state === "timeout") {
        ar.banner(`No ${target}...`, "moving on", { color: "#ff6050" });
      } else if (state === "done") {
        ar.flash("#000", 0.4);
        const found = results.filter((r) => r.found).length;
        ar.banner(`SCORE ${score}`, `found ${found} of ${results.length}`, { color: "#40d0ff" });
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.18, { size: 16, align: "center", color: "#ffd040" });
        if (stateTime > 1.5) ar.text("Press FIRE to play again", v.cx, v.cy + v.h * 0.25, { size: 14, align: "center" });
      }
    });
    return { actionLabel: "▶ Start / skip" };
  };
})(window.Lynx);
