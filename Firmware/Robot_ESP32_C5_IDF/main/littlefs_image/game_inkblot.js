// Inkblot -- a clean-up game, the opposite of painting. Ink seeps up through
// the floor from a few leaky wells and creeps from tile to tile like a slow
// cellular automaton. Driving over ink scrubs it away; to stop a well for good
// you have to sit on it until it is capped. If the ink covers too much of the
// arena it is over. FIRE throws a soap bubble that wipes a wide patch.
// Nothing to aim, nothing to dodge: pure area management and route planning.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const SCRUB_R = 0.17; // robot's scrubbing radius
  const WELL_R = 0.2;
  const CAP_S = 1.4; // seconds on a well to cap it
  const SOAP_R = 0.55;
  const SOAP_COOLDOWN_S = 14;
  const INK_COLOR = "#6a2cff";
  const WELL_COLOR = "#ff40c0";
  const LOSE_FRACTION = 0.45;

  const clamp01 = (t) => Math.min(1, Math.max(0, t));

  Lynx.games.inkblot = (ar, cfg) => {
    const R = cfg.areaRadiusM;
    const CELL = cfg.cellM;
    let state = "title"; // title | playing | clear | over
    let stateTime = 0;
    let center = { x: 0, y: 0 };
    let N = 0;
    let cells = []; // {x, y, ink, nb:[idx]}
    let wells = [];
    let level = 1;
    let score = 0;
    let spreadClock = 0;
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

    function build() {
      center = { x: ar.pose.x, y: ar.pose.y };
      N = Math.ceil((2 * R) / CELL);
      cells = [];
      const idx = {};
      for (let j = 0; j < N; j++) {
        for (let i = 0; i < N; i++) {
          const x = center.x - R + (i + 0.5) * CELL;
          const y = center.y - R + (j + 0.5) * CELL;
          if (Math.hypot(x - center.x, y - center.y) > R) continue;
          idx[i + "," + j] = cells.length;
          cells.push({ x, y, i, j, ink: 0, nb: [] });
        }
      }
      cells.forEach((c) => {
        [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]].forEach(([di, dj]) => {
          const k = idx[c.i + di + "," + (c.j + dj)];
          if (k !== undefined) c.nb.push(k);
        });
      });
    }

    function startLevel() {
      build();
      wells = [];
      const n = Math.min(2 + level, 7);
      let tries = 0;
      while (wells.length < n && tries++ < 3000) {
        const a = Math.random() * 2 * Math.PI;
        const r = (0.35 + 0.6 * Math.sqrt(Math.random())) * R;
        const w = { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a), hp: 1, alive: true, t: Math.random() * 6 };
        if (Math.hypot(w.x - ar.pose.x, w.y - ar.pose.y) < 0.5) continue;
        if (wells.some((o) => Math.hypot(o.x - w.x, o.y - w.y) < 0.6 * Math.min(1, R / 1.5) + 0.2)) continue;
        wells.push(w);
      }
      soaps = [];
      soapCd = 0;
      spreadClock = 0;
      state = "playing";
      stateTime = 0;
      say(`Level ${level}: cap ${wells.length} wells`, "#ffffff", 2);
      Lynx.sfx.play("go");
    }

    function nearestCell(x, y) {
      let b = null;
      let bd = Infinity;
      for (const c of cells) {
        const d = (c.x - x) ** 2 + (c.y - y) ** 2;
        if (d < bd) { bd = d; b = c; }
      }
      return b;
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
      let n = 0;
      cells.forEach((c) => {
        if (c.ink > 0 && Math.hypot(c.x - ar.pose.x, c.y - ar.pose.y) < SOAP_R) {
          n += c.ink;
          c.ink = 0;
        }
      });
      score += Math.round(n);
      Lynx.sfx.play("rainbow");
    });

    function update(dt) {
      stateTime += dt;
      clock += dt;
      if (toast && (toast.t -= dt) <= 0) toast = null;
      soaps.forEach((s) => (s.t += dt));
      soaps = soaps.filter((s) => s.t < 0.7);
      if (state !== "playing") return;
      soapCd = Math.max(0, soapCd - dt);
      const px = ar.pose.x;
      const py = ar.pose.y;

      // Scrub the tiles under the robot.
      let scrubbed = 0;
      for (const c of cells) {
        if (c.ink > 0 && Math.hypot(c.x - px, c.y - py) < SCRUB_R + CELL * 0.3) {
          const d = Math.min(c.ink, dt * 3);
          c.ink -= d;
          scrubbed += d;
        }
      }
      if (scrubbed > 0) {
        score += scrubbed * 4;
        if (Math.random() < dt * 6) Lynx.sfx.play("crunch");
      }

      // Wells: leak while uncapped; the robot sitting on one caps it.
      for (const w of wells) {
        if (!w.alive) continue;
        const wc = nearestCell(w.x, w.y);
        const leak = (0.35 + 0.08 * level) * dt;
        wc.ink = Math.min(1, wc.ink + leak * (w.hp < 1 ? 0.5 : 1));
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

      // The ink creeps: every tick each saturated tile may seed a neighbour.
      const period = Math.max(0.12, 0.55 - 0.045 * level);
      spreadClock += dt;
      while (spreadClock >= period) {
        spreadClock -= period;
        const add = [];
        for (const c of cells) {
          if (c.ink < 0.6) continue;
          const k = c.nb[Math.floor(Math.random() * c.nb.length)];
          if (Math.random() < 0.55) add.push(k);
        }
        add.forEach((k) => (cells[k].ink = Math.min(1, cells[k].ink + 0.45)));
      }

      let covered = 0;
      for (const c of cells) if (c.ink > 0.5) covered++;
      coverage = covered / cells.length;
      if (coverage > LOSE_FRACTION) {
        say("Swamped!", "#ff6060", 2);
        finish();
        return;
      }
      if (wells.every((w) => !w.alive)) {
        let ink = 0;
        for (const c of cells) ink += c.ink;
        if (ink < 0.04 * cells.length) {
          const bonus = Math.round(150 * (1 - coverage / LOSE_FRACTION)) + 50 * level;
          score += bonus;
          state = "clear";
          stateTime = 0;
          say(`Spotless!  +${bonus}`, "#ffd84a", 2);
          Lynx.sfx.play("levelup");
        }
      }
    }

    function hexA(hex, a) {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
    }

    function draw() {
      const v = ar.view;
      const ctx = ar.ctx;
      if (state !== "title") {
        ar.floorCircle(center.x, center.y, R, null, "rgba(255,255,255,0.35)");
        for (const c of cells) {
          if (c.ink < 0.03) continue;
          ar.floorCircle(c.x, c.y, CELL * 0.62, hexA(INK_COLOR, 0.2 + 0.6 * c.ink), null);
        }
        for (const w of wells) {
          if (!w.alive) continue;
          const pulse = 0.5 + 0.5 * Math.sin(clock * 6 + w.t);
          ar.floorCircle(w.x, w.y, WELL_R, hexA(WELL_COLOR, 0.15 + 0.25 * pulse), hexA(WELL_COLOR, 0.95));
          if (w.hp < 1) ar.floorCircle(w.x, w.y, WELL_R * clamp01(1 - w.hp), hexA("#ffffff", 0.7));
        }
        soaps.forEach((s) => {
          const k = s.t / 0.7;
          ar.floorCircle(s.x, s.y, SOAP_R * k, null, hexA("#80f0ff", 1 - k));
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
        ctx.fillStyle = frac > 0.7 ? "#ff5050" : INK_COLOR;
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
    return { actionLabel: "▶ Start" };
  };
})(window.Lynx);
