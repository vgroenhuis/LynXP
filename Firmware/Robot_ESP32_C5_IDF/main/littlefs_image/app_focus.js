// Focus check (Games & apps -> "Focus check"): how sharp the camera's
// picture is, live, for turning the lens to its best focus.
//
// Sharpness: the mean squared brightness gradient (Sobel; "Tenengrad")
// divided by the picture's brightness variance -- edges count, the scene's
// contrast and the light much less -- times 100. Higher is sharper; it only
// compares like with like (the same scene, the camera still), so it's best
// with a fixed target in view (the calibration board is ideal). Shown for
// the whole picture (big number, with the best so far and a graph of the
// last seconds) and for 3 x 3 regions (an even focus over the picture, or a
// tilted lens / soft corners), and a magnified crop of the center.
// Fire (or the button) resets the best-so-far.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const EVERY_MS = 150;
  const HISTORY_S = 12;
  const ZOOM = 3;

  Lynx.games.focus = (ar) => {
    if (Lynx.cam && Lynx.cam.enableCors) Lynx.cam.enableCors();
    const img = document.getElementById("camStream");
    const canvas = document.createElement("canvas");
    const g2 = canvas.getContext("2d", { willReadFrequently: true });
    let last = 0;
    let cur = null; // {all, regions: [9], w, h}
    let best = 0;
    const history = []; // {t, v}
    let error = null;

    // the measurement
    function measure() {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w) return null;
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      let d;
      try {
        g2.drawImage(img, 0, 0);
        d = g2.getImageData(0, 0, w, h).data;
        error = null;
      } catch (e) {
        error = "Can't read the camera picture (CORS) -- waiting for the stream to reconnect";
        return null;
      }
      const gray = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) gray[i] = 0.299 * d[4 * i] + 0.587 * d[4 * i + 1] + 0.114 * d[4 * i + 2];
      // per region: sums of I, I^2 and G^2 (Sobel), 1 px border skipped
      const R = Array.from({ length: 9 }, () => ({ n: 0, s: 0, s2: 0, g2: 0 }));
      const all = { n: 0, s: 0, s2: 0, g2: 0 };
      for (let y = 1; y < h - 1; y++) {
        const ry = Math.min(2, Math.floor((3 * y) / h));
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const gx = gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1];
          const gy = gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1] - gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1];
          const gg = gx * gx + gy * gy;
          const v = gray[i];
          const r = R[ry * 3 + Math.min(2, Math.floor((3 * x) / w))];
          r.n++;
          r.s += v;
          r.s2 += v * v;
          r.g2 += gg;
          all.n++;
          all.s += v;
          all.s2 += v * v;
          all.g2 += gg;
        }
      }
      const score = (a) => {
        const mean = a.s / a.n;
        const variance = a.s2 / a.n - mean * mean;
        return variance > 4 ? (100 * (a.g2 / a.n)) / (16 * variance) : 0; // (/16: Sobel's gain)
      };
      return { all: score(all), regions: R.map(score), w, h };
    }

    const reset = () => {
      best = 0;
      history.length = 0;
    };
    Lynx.onAction("fire", reset);

    ar.onFrame((now) => {
      if (now - last > EVERY_MS) {
        last = now;
        const m = measure();
        if (m) {
          cur = m;
          best = Math.max(best, m.all);
          history.push({ t: now, v: m.all });
          while (history.length && history[0].t < now - HISTORY_S * 1000) history.shift();
        }
      }
      const v = ar.view;
      const g = ar.ctx;
      if (error) ar.text(error, v.x + 12, v.y + 24, { size: 13, color: "#ff8080" });
      if (!cur) {
        ar.text("Waiting for the camera picture...", v.cx, v.cy, { size: 16, align: "center" });
        return;
      }
      // 3 x 3 regions: their sharpness, colored relative to the sharpest one
      const top = Math.max(...cur.regions, 1e-9);
      g.save();
      g.strokeStyle = "rgba(255,255,255,0.35)";
      g.lineWidth = 1;
      for (let k = 1; k < 3; k++) {
        g.beginPath();
        g.moveTo(v.x + (v.w * k) / 3, v.y);
        g.lineTo(v.x + (v.w * k) / 3, v.y + v.h);
        g.moveTo(v.x, v.y + (v.h * k) / 3);
        g.lineTo(v.x + v.w, v.y + (v.h * k) / 3);
        g.stroke();
      }
      g.restore();
      cur.regions.forEach((s, k) => {
        const rel = s / top;
        const col = rel > 0.85 ? "#80ff90" : rel > 0.6 ? "#ffe060" : "#ff8070";
        const cx = v.x + (v.w * ((k % 3) + 0.5)) / 3;
        const cy = v.y + (v.h * (Math.floor(k / 3) + 0.5)) / 3;
        ar.text(s.toFixed(1), cx, cy, { size: 18, align: "center", color: col });
      });
      // the whole picture: now, best so far, a bar
      const x0 = v.x + 12;
      const y0 = v.y + 16;
      g.fillStyle = "rgba(0,0,0,0.55)";
      g.fillRect(x0 - 6, y0 - 4, 250, 118);
      ar.text(`Sharpness ${cur.all.toFixed(2)}`, x0, y0 + 20, { size: 22, color: "#ffffff" });
      ar.text(`best ${best.toFixed(2)} · ${best > 0 ? Math.round((100 * cur.all) / best) : 0}% of it`, x0, y0 + 42, { size: 14, color: cur.all >= 0.97 * best ? "#80ff90" : "#ffe060" });
      // history graph
      const gx0 = x0;
      const gy0 = y0 + 52;
      const gw = 236;
      const gh = 54;
      g.strokeStyle = "rgba(255,255,255,0.3)";
      g.strokeRect(gx0, gy0, gw, gh);
      const vmax = Math.max(best, 1e-9) * 1.05;
      if (history.length > 1) {
        const t1 = history[history.length - 1].t;
        g.beginPath();
        history.forEach((p, i) => {
          const x = gx0 + gw * (1 - (t1 - p.t) / (HISTORY_S * 1000));
          const y = gy0 + gh * (1 - p.v / vmax);
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        });
        g.strokeStyle = "#80d0ff";
        g.lineWidth = 2;
        g.stroke();
        const yb = gy0 + gh * (1 - best / vmax);
        g.strokeStyle = "rgba(128,255,144,0.7)";
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(gx0, yb);
        g.lineTo(gx0 + gw, yb);
        g.stroke();
      }
      // magnified center (the picture as it is, ZOOM x)
      const cw = Math.min(220, v.w * 0.32);
      const srcW = (cw / ZOOM) * (cur.w / v.w);
      const sx = cur.w / 2 - srcW / 2;
      const sy = cur.h / 2 - srcW / 2;
      const dx = v.x + v.w - cw - 12;
      const dy = v.y + 12;
      g.save();
      g.imageSmoothingEnabled = false;
      try {
        g.drawImage(canvas, sx, sy, srcW, srcW, dx, dy, cw, cw);
      } catch (e) {
        // (no picture yet)
      }
      g.strokeStyle = "#ffffff";
      g.lineWidth = 2;
      g.strokeRect(dx, dy, cw, cw);
      g.restore();
      ar.text(`center ×${ZOOM}`, dx + cw / 2, dy + cw + 16, { size: 12, align: "center", color: "#ffffff" });
    });

    return { actionLabel: "↻ Reset best", debug: { current: () => cur, best: () => best } };
  };
})(window.Lynx);
