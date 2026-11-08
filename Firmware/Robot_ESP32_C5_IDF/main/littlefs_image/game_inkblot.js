// Inkblot -- a clean-up game, the opposite of painting. Ink wells out of a
// few leaky spots in the floor, each one a single blot that spreads slowly and
// unevenly -- a smooth, glossy blob bulging out further here than there.
// Driving over a blot scrubs it back (its edge retreats where the robot
// passes); to stop a well for good, sit on it until it is capped. If the ink
// covers too much of the arena it is over. FIRE throws a soap bubble that
// wipes a wide patch. Slow on purpose: the camera only sees part of the floor,
// so there's time to look round and plan a route.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const SCRUB_R = 0.17; // the robot's scrubbing radius
  const WELL_R = 0.16;
  const CAP_S = 1.2; // seconds on a well to cap it
  const SOAP_R = 0.6;
  const SOAP_COOLDOWN_S = 12;
  const WELL_COLOR = "#ff40c0";
  const LOSE_FRACTION = 0.5;
  const K = 28; // a blot's edge: its distance from the well in this many directions
  const START_R = 0.06;
  const GROW = 0.021; // m/s at level 1, on average (each direction its own pace)
  const GROW_LEVEL = 0.005; // ... plus this much per level
  const DIFFICULTY = { easy: 0.6, normal: 1, hard: 1.5 }; // times the spread

  const clamp01 = (t) => Math.min(1, Math.max(0, t));
  const rand = (a, b) => a + Math.random() * (b - a);

  Lynx.games.inkblot = (ar, cfg) => {
    const R = cfg.areaRadiusM;
    let state = "title"; // title | playing | clear | over
    let stateTime = 0;
    let center = { x: 0, y: 0 };
    let wells = []; // {x, y, hp, alive, t, r: [K], pace: [K], drift: [K]}
    let level = 1;
    let score = 0;
    let clock = 0;
    let soapCd = 0;
    let soaps = [];
    let coverage = 0;
    let toast = null;
    let best = null;
    let rankMsg = "";
    Lynx.bestScore("inkblot").then((b) => (best = b));

    function say(text, color, t = 1.4) {
      toast = { text, color, t };
    }

    // how far a blot may reach in direction k before the arena's edge
    function edgeLimit(w, k) {
      const a = (k / K) * 2 * Math.PI;
      const dx = w.x - center.x;
      const dy = w.y - center.y;
      const b = dx * Math.cos(a) + dy * Math.sin(a);
      const c = dx * dx + dy * dy - R * R;
      return Math.max(0, -b + Math.sqrt(Math.max(0, b * b - c)));
    }

    function startLevel() {
      center = level === 1 ? { x: ar.pose.x, y: ar.pose.y } : center;
      wells = [];
      const n = Math.min(2 + level, 6);
      let tries = 0;
      while (wells.length < n && tries++ < 3000) {
        const a = Math.random() * 2 * Math.PI;
        const r = (0.35 + 0.55 * Math.sqrt(Math.random())) * R;
        const w = { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a), hp: 1, alive: true, t: Math.random() * 6 };
        if (Math.hypot(w.x - ar.pose.x, w.y - ar.pose.y) < 0.5) continue;
        if (wells.some((o) => Math.hypot(o.x - w.x, o.y - w.y) < 0.55 * Math.min(1, R / 1.5) + 0.2)) continue;
        // the edge: a little lumpy from the start; each direction grows at its own (slowly changing) pace
        w.r = Array.from({ length: K }, () => START_R * rand(0.7, 1.3));
        w.pace = Array.from({ length: K }, () => rand(0.3, 1.7));
        w.drift = Array.from({ length: K }, () => rand(-1, 1));
        wells.push(w);
      }
      soaps = [];
      soapCd = 0;
      state = "playing";
      stateTime = 0;
      say(`Level ${level}: cap ${wells.length} wells`, "#ffffff", 2);
      Lynx.sfx.play("go");
    }

    function finish() {
      state = "over";
      stateTime = 0;
      rankMsg = "";
      Lynx.sfx.play("lose");
      Lynx.submitScore("inkblot", score).then((rank) => {
        rankMsg = rank ? `#${rank} on the robot's scoreboard!` : "";
        if (rank === 1) best = score;
      });
    }

    // Wipe a disc (radius rad round x, y) out of every blot: where it covers a
    // blot's edge, the edge pulls back to the disc's near side. Returns the
    // ink removed (m^2, roughly).
    function wipe(x, y, rad) {
      let removed = 0;
      wells.forEach((w) => {
        const dx = x - w.x;
        const dy = y - w.y;
        const d = Math.hypot(dx, dy);
        const at = Math.atan2(dy, dx);
        for (let k = 0; k < K; k++) {
          const a = (k / K) * 2 * Math.PI;
          // the disc's reach along direction a: where the ray enters it
          const along = d * Math.cos(a - at);
          const off = d * Math.abs(Math.sin(a - at));
          if (along < -rad || off >= rad) continue;
          const enter = Math.max(0, along - Math.sqrt(rad * rad - off * off));
          if (w.r[k] > enter) {
            removed += (w.r[k] * w.r[k] - enter * enter) * (Math.PI / K);
            w.r[k] = enter;
          }
        }
      });
      return removed;
    }

    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title" || (state === "over" && stateTime > 1.5)) {
        level = 1;
        score = 0;
        startLevel();
        return;
      }
      if (state === "clear" && stateTime > 1.2) {
        level++;
        startLevel();
        return;
      }
      if (state !== "playing" || soapCd > 0) return;
      soapCd = SOAP_COOLDOWN_S;
      soaps.push({ x: ar.pose.x, y: ar.pose.y, t: 0 });
      score += Math.round(wipe(ar.pose.x, ar.pose.y, SOAP_R) * 400);
      Lynx.sfx.play("rainbow");
    });

    function update(dt) {
      stateTime += dt;
      clock += dt;
      if (toast && (toast.t -= dt) <= 0) toast = null;
      soaps.forEach((s) => (s.t += dt));
      soaps = soaps.filter((s) => s.t < 0.9);
      if (state !== "playing") return;
      soapCd = Math.max(0, soapCd - dt);
      const px = ar.pose.x;
      const py = ar.pose.y;

      // Scrub where the robot drives.
      const scrubbed = wipe(px, py, SCRUB_R);
      if (scrubbed > 0) {
        score += scrubbed * 400;
        if (Math.random() < dt * 6) Lynx.sfx.play("crunch");
      }

      // Wells leak: their blots spread, each direction at its own pace (which
      // wanders), smoothed with its neighbours so the edge stays a soft curve.
      const grow = (GROW + GROW_LEVEL * (level - 1)) * (DIFFICULTY[cfg.difficulty] || 1);
      let area = 0;
      for (const w of wells) {
        if (w.alive) {
          for (let k = 0; k < K; k++) {
            w.drift[k] = Math.max(-1, Math.min(1, w.drift[k] + rand(-1, 1) * dt * 0.8));
            w.pace[k] = Math.max(0.15, Math.min(2, w.pace[k] + w.drift[k] * dt * 0.3));
            w.r[k] = Math.min(edgeLimit(w, k), w.r[k] + grow * w.pace[k] * dt * (w.hp < 1 ? 0.5 : 1));
          }
          // a well keeps a little puddle round itself
          for (let k = 0; k < K; k++) w.r[k] = Math.max(w.r[k], START_R * 0.6);
          if (Math.hypot(w.x - px, w.y - py) < WELL_R) {
            w.hp -= dt / CAP_S;
            if (w.hp <= 0) {
              w.alive = false;
              const pts = 100 + 25 * level;
              score += pts;
              say(`Well capped  +${pts}`, WELL_COLOR, 1.3);
              Lynx.sfx.play("found");
            }
          } else {
            w.hp = Math.min(1, w.hp + dt * 0.25); // it works loose again
          }
        }
        // (smoothing: a dent or a spike evens out a little)
        const sm = w.r.slice();
        for (let k = 0; k < K; k++) {
          const avg = (w.r[(k + K - 1) % K] + w.r[(k + 1) % K]) / 2;
          if (w.r[k] > avg) sm[k] = w.r[k] + (avg - w.r[k]) * Math.min(1, dt * 0.6);
        }
        w.r = sm;
        for (let k = 0; k < K; k++) area += 0.5 * w.r[k] * w.r[k] * ((2 * Math.PI) / K);
      }
      coverage = area / (Math.PI * R * R);
      if (coverage > LOSE_FRACTION) {
        say("Swamped!", "#ff6060", 2);
        finish();
        return;
      }
      if (wells.every((w) => !w.alive) && wells.every((w) => w.r.every((r) => r < 0.03))) {
        const bonus = Math.round(150 * (1 - coverage / LOSE_FRACTION)) + 50 * level;
        score += bonus;
        state = "clear";
        stateTime = 0;
        say(`Spotless!  +${bonus}`, "#ffd84a", 2);
        Lynx.sfx.play("levelup");
      }
    }

    function hexA(hex, a) {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
    }

    // A blot: a closed smooth curve (Catmull-Rom through its edge points, as
    // Bezier pieces) on the floor, shrunk by `s` (for the inner shades).
    function blotPath(ctx, w, s, wob) {
      const pts = [];
      for (let k = 0; k < K; k++) {
        const a = (k / K) * 2 * Math.PI;
        const r = w.r[k] * s * (1 + wob * Math.sin(clock * 1.3 + k * 1.7 + w.t));
        const p = ar.project(w.x + r * Math.cos(a), w.y + r * Math.sin(a), 0.001);
        if (p) pts.push(p);
      }
      const n = pts.length;
      if (n < 4) return false;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 0; i < n; i++) {
        const p0 = pts[(i + n - 1) % n];
        const p1 = pts[i];
        const p2 = pts[(i + 1) % n];
        const p3 = pts[(i + 2) % n];
        ctx.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6, p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
      }
      ctx.closePath();
      return true;
    }
    function drawBlot(w) {
      if (w.r.every((r) => r < 0.008)) return;
      const ctx = ar.ctx;
      ctx.save();
      // a dark wet rim, the ink, a lighter sheen inside, and a glint
      if (blotPath(ctx, w, 1.04, 0.012)) {
        ctx.fillStyle = "rgba(20,6,50,0.55)";
        ctx.fill();
      }
      if (blotPath(ctx, w, 1, 0.012)) {
        const c = ar.project(w.x, w.y, 0);
        const edge = ar.project(w.x + Math.max(...w.r), w.y, 0);
        if (c && edge) {
          const rr = Math.max(8, Math.hypot(edge.x - c.x, edge.y - c.y));
          const g = ctx.createRadialGradient(c.x, c.y, rr * 0.1, c.x, c.y, rr);
          g.addColorStop(0, "rgba(70,22,170,0.92)");
          g.addColorStop(0.7, "rgba(92,36,220,0.86)");
          g.addColorStop(1, "rgba(120,60,255,0.8)");
          ctx.fillStyle = g;
        } else ctx.fillStyle = "rgba(90,36,220,0.86)";
        ctx.fill();
        ctx.strokeStyle = "rgba(170,130,255,0.55)";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (blotPath(ctx, w, 0.55, 0.03)) {
        ctx.fillStyle = "rgba(150,110,255,0.18)";
        ctx.fill();
      }
      const gl = ar.project(w.x - 0.25 * w.r[Math.round(K * 0.6) % K], w.y + 0.25 * w.r[Math.round(K * 0.6) % K], 0.001);
      if (gl) {
        ctx.fillStyle = "rgba(255,255,255,0.22)";
        ctx.beginPath();
        ctx.ellipse(gl.x, gl.y, Math.max(2, gl.ppm * 0.02), Math.max(1, gl.ppm * 0.008), -0.3, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }

    function draw() {
      const v = ar.view;
      const ctx = ar.ctx;
      if (state !== "title") {
        ar.floorCircle(center.x, center.y, R, null, "rgba(255,255,255,0.35)");
        wells.forEach(drawBlot);
        for (const w of wells) {
          if (!w.alive) {
            ar.floorCircle(w.x, w.y, WELL_R * 0.6, "rgba(120,120,130,0.6)", "rgba(220,220,230,0.8)"); // its cap
            continue;
          }
          const pulse = 0.5 + 0.5 * Math.sin(clock * 4 + w.t);
          ar.floorCircle(w.x, w.y, WELL_R, hexA(WELL_COLOR, 0.15 + 0.25 * pulse), hexA(WELL_COLOR, 0.95));
          if (w.hp < 1) ar.floorCircle(w.x, w.y, WELL_R * clamp01(1 - w.hp), hexA("#ffffff", 0.7));
        }
        soaps.forEach((s) => {
          const k = s.t / 0.9;
          ar.floorCircle(s.x, s.y, SOAP_R * k, hexA("#c0f8ff", 0.25 * (1 - k)), hexA("#80f0ff", 1 - k));
        });
        if (state === "playing") ar.floorCircle(ar.pose.x, ar.pose.y, SCRUB_R, null, "rgba(128,240,255,0.7)");
      }
      ar.flush();

      if (state === "playing" || state === "clear") {
        wells.forEach((w) => w.alive && ar.edgeArrow(w.x, w.y, 0.05, WELL_COLOR));
        if (cfg.radar) {
          ar.radar(
            wells.filter((w) => w.alive).map((w) => ({ x: w.x, y: w.y, color: WELL_COLOR, r: 4 })),
            R * 1.4
          );
        }
        // Swamp meter and soap readiness.
        const frac = clamp01(coverage / LOSE_FRACTION);
        ctx.fillStyle = "rgba(255,255,255,0.2)";
        ctx.fillRect(v.cx - 80, v.y + 20, 160, 6);
        ctx.fillStyle = frac > 0.7 ? "#ff5050" : "#6a2cff";
        ctx.fillRect(v.cx - 80, v.y + 20, 160 * frac, 6);
        ar.text("ink", v.cx, v.y + 40, { size: 11, align: "center", color: "#c0b0ff" });
        const sf = 1 - clamp01(soapCd / SOAP_COOLDOWN_S);
        ar.text(sf >= 1 ? "SOAP READY (FIRE)" : "soap charging", v.cx, v.y + v.h - 50, { size: 12, align: "center", color: sf >= 1 ? "#80f0ff" : "#a0a0a0" });
        ctx.fillStyle = sf >= 1 ? "#80f0ff" : "rgba(255,255,255,0.35)";
        ctx.fillRect(v.cx - 60, v.y + v.h - 44, 120 * sf, 4);
      }

      const hudY = v.y + v.h - 16;
      ar.text(`SCORE ${Math.round(score)}`, v.x + 16, hudY, { size: 20, color: "#c0b0ff" });
      if (state !== "title") ar.text(`LEVEL ${level}   WELLS ${wells.filter((w) => w.alive).length}`, v.x + v.w - 16, hudY, { size: 16, align: "right" });
      if (toast) ar.text(toast.text, v.cx, v.y + v.h * 0.35, { size: 24, align: "center", color: toast.color, alpha: clamp01(toast.t * 2) });

      if (state === "title") {
        ar.flash("#000", 0.45);
        ar.banner("INKBLOT", "Press FIRE to start cleaning", { color: "#c0b0ff" });
        ar.text("Drive over ink to scrub it · sit on a pink well to cap it · don't let the ink swamp the floor", v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
        if (best !== null) ar.text(`Best on this robot: ${best}`, v.cx, v.cy + v.h * 0.27, { size: 14, align: "center", color: "#c0b0ff" });
      } else if (state === "clear") {
        ar.banner("SPOTLESS", `Score ${Math.round(score)}`, { color: "#ffd84a" });
        if (stateTime > 1.2) ar.text("Press FIRE for the next level", v.cx, v.cy + v.h * 0.25, { size: 14, align: "center" });
      } else if (state === "over") {
        ar.flash("#000", 0.4);
        ar.banner("SWAMPED", `Score ${Math.round(score)} · level ${level}`);
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.18, { size: 16, align: "center", color: "#c0b0ff" });
        if (stateTime > 1.5) ar.text("Press FIRE to play again", v.cx, v.cy + v.h * 0.25, { size: 14, align: "center" });
      }
    }

    ar.onFrame((now, dt) => {
      update(Math.min(dt, 0.1));
      draw();
    });
    return {
      actionLabel: "▶ Start",
      snapshot: () => ({ state, level, score: Math.round(score), coverage: +coverage.toFixed(3), wells: wells.map((w) => `${w.alive ? "open" : "capped"} r~${(w.r.reduce((a, b) => a + b, 0) / K).toFixed(3)}`) }),
    };
  };
})(window.Lynx);
