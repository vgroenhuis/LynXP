// Pacman -- Pac-Man on the living-room floor. Coins are laid out on the
// floor around where you start; drive the robot over them. Ghosts glide
// after you (each with its own personality, like the arcade original); a
// power coin turns them blue for a few seconds so you can drive into them.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const COIN_RADIUS_M = 0.03;
  const POWER_RADIUS_M = 0.05;
  const COLLECT_RADIUS_M = 0.13;
  const GHOST_HEIGHT_M = 0.16;
  const GHOST_WIDTH_M = 0.14;
  const GHOST_TOUCH_M = 0.16;
  const FRIGHT_S = 7;
  const INVULNERABLE_S = 2.5;
  const GHOST_COLORS = ["#ff2020", "#ffb0e0", "#20e0ff", "#ffa030", "#a0ff40", "#c080ff"];

  const rand = (a, b) => a + Math.random() * (b - a);

  Lynx.games.coins = (ar, cfg) => {
    const R = cfg.areaRadiusM;
    let state = "title"; // title | playing | caught | clear | over
    let stateTime = 0;
    let center = { x: 0, y: 0 };
    let coins = [];
    let ghosts = [];
    let level = 1;
    let score = 0;
    let lives = cfg.lives;
    let fright = 0;
    let chain = 0;
    let invulnerable = 0;
    let best = null;
    let rankMsg = "";
    let heading = 0;
    let lastPos = null;
    Lynx.bestScore("coins").then((b) => (best = b));

    function layOutLevel() {
      center = { x: ar.pose.x, y: ar.pose.y };
      coins = [];
      const total = cfg.coinCount + 2;
      let tries = 0;
      while (coins.length < total && tries++ < 4000) {
        const a = Math.random() * 2 * Math.PI;
        const r = Math.sqrt(Math.random()) * R;
        const c = { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) };
        if (Math.hypot(c.x - center.x, c.y - center.y) < 0.25) continue;
        if (coins.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < 0.2)) continue;
        c.power = coins.length < 2; // first two placed are power coins
        c.spin = Math.random() * 6;
        coins.push(c);
      }
      const count = Math.min(6, cfg.ghostCount + (level - 1));
      ghosts = [];
      for (let i = 0; i < count; i++) ghosts.push(newGhost(i));
      fright = 0;
    }

    function newGhost(i) {
      const a = (i / Math.max(1, cfg.ghostCount)) * 2 * Math.PI + rand(-0.3, 0.3);
      return {
        i, color: GHOST_COLORS[i % GHOST_COLORS.length],
        x: center.x + (R + 0.3) * Math.cos(a), y: center.y + (R + 0.3) * Math.sin(a),
        eaten: false, wander: Math.random() * 6, phase: Math.random() * 6, delay: 1.5 + i * 1.2,
      };
    }

    function start() {
      level = 1;
      score = 0;
      lives = cfg.lives;
      layOutLevel();
      state = "playing";
      stateTime = 0;
      invulnerable = 1.5;
      Lynx.sfx.play("power");
    }

    // Optional virtual jumping (off by default): hop over a ghost.
    if (cfg.jump) {
      Lynx.onAction("jump", () => state === "playing" && (ar.jump(), true));
      Lynx.touchButtons().add("\u2912 Jump", () => Lynx.jumpAction());
    }

    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title" || (state === "over" && stateTime > 1.5)) start();
    });

    function ghostSpeed() {
      return cfg.ghostSpeedMps * Math.pow(1.12, level - 1);
    }

    function update(dt) {
      stateTime += dt;
      const px = ar.pose.x;
      const py = ar.pose.y;
      if (lastPos) {
        const d = Math.hypot(px - lastPos.x, py - lastPos.y);
        if (d > 0.005) heading = Math.atan2(py - lastPos.y, px - lastPos.x);
      }
      lastPos = { x: px, y: py };
      coins.forEach((c) => (c.spin += dt * 3));
      ghosts.forEach((g) => (g.phase += dt * 6));

      if (state === "caught" && stateTime > 1.6) {
        if (lives <= 0) {
          state = "over";
          stateTime = 0;
          rankMsg = "";
          Lynx.submitScore("coins", score).then((rank) => {
            rankMsg = rank ? `#${rank} on the robot's scoreboard!` : "";
            if (rank === 1) best = score;
          });
        } else {
          state = "playing";
          stateTime = 0;
          invulnerable = INVULNERABLE_S;
          ghosts = ghosts.map((g) => newGhost(g.i));
        }
      }
      if (state === "clear" && stateTime > 2.5) {
        level++;
        layOutLevel();
        state = "playing";
        stateTime = 0;
        invulnerable = 1.5;
      }
      if (state !== "playing") return;

      invulnerable = Math.max(0, invulnerable - dt);
      fright = Math.max(0, fright - dt);
      if (fright === 0) chain = 0;

      coins = coins.filter((c) => {
        if (Math.hypot(c.x - px, c.y - py) > COLLECT_RADIUS_M) return true;
        if (c.power) {
          score += 50;
          fright = FRIGHT_S;
          chain = 0;
          Lynx.sfx.play("power");
        } else {
          score += 10;
          Lynx.sfx.play("coin");
        }
        return false;
      });
      if (coins.length === 0) {
        state = "clear";
        stateTime = 0;
        score += 250 * level;
        Lynx.sfx.play("found");
        return;
      }

      const speed = ghostSpeed();
      ghosts.forEach((g) => {
        if (g.delay > 0) {
          g.delay -= dt;
          return;
        }
        let tx;
        let ty;
        let s = speed;
        if (g.eaten) {
          // Eyes head back to the edge, then the ghost re-forms.
          const a = Math.atan2(g.y - center.y, g.x - center.x);
          tx = center.x + (R + 0.3) * Math.cos(a);
          ty = center.y + (R + 0.3) * Math.sin(a);
          s = speed * 3;
          if (Math.hypot(tx - g.x, ty - g.y) < 0.05) {
            g.eaten = false;
            g.delay = 2;
          }
        } else if (fright > 0) {
          tx = g.x + (g.x - px);
          ty = g.y + (g.y - py);
          s = speed * 0.55;
        } else if (g.i % 4 === 0) {
          tx = px; // straight at you
          ty = py;
        } else if (g.i % 4 === 1) {
          tx = px + Math.cos(heading) * 0.4; // cuts you off
          ty = py + Math.sin(heading) * 0.4;
        } else if (g.i % 4 === 2) {
          g.wander += dt * 0.7; // circles in from the side
          tx = px + Math.cos(g.wander) * 0.35;
          ty = py + Math.sin(g.wander) * 0.35;
        } else {
          const d = Math.hypot(px - g.x, py - g.y); // shy: chases from afar, backs off up close
          tx = d > 0.6 ? px : center.x + Math.cos(g.wander) * R;
          ty = d > 0.6 ? py : center.y + Math.sin(g.wander) * R;
          g.wander += dt * 0.3;
        }
        const dx = tx - g.x;
        const dy = ty - g.y;
        const d = Math.hypot(dx, dy);
        if (d > 0.001) {
          g.x += (dx / d) * Math.min(s * dt, d);
          g.y += (dy / d) * Math.min(s * dt, d);
        }
        if (g.eaten || Math.hypot(g.x - px, g.y - py) > GHOST_TOUCH_M) return;
        if (ar.feet() > GHOST_HEIGHT_M * 0.7) return; // jumped over it
        if (fright > 0) {
          g.eaten = true;
          chain++;
          score += 100 * Math.pow(2, chain);
          Lynx.sfx.play("eat");
        } else if (invulnerable === 0) {
          lives--;
          state = "caught";
          stateTime = 0;
          Lynx.sfx.play("lose");
        }
      });
    }

    function drawGhost(g) {
      const rect = ar.spriteRect({ width: GHOST_WIDTH_M, height: GHOST_HEIGHT_M }, g.x, g.y, 0.03 + Math.sin(g.phase * 0.5) * 0.01, GHOST_HEIGHT_M);
      if (!rect) return;
      const ctx = ar.ctx;
      ar.queue(rect.depth, () => {
        ar.floorCircle(g.x, g.y, 0.06, "rgba(0,0,0,0.3)");
        const { x, y, w, h } = rect;
        const flashing = fright > 0 && fright < 2 && Math.floor(fright * 4) % 2 === 0;
        if (!g.eaten) {
          ctx.fillStyle = fright > 0 ? (flashing ? "#f0f0ff" : "#2040ff") : g.color;
          ctx.beginPath();
          ctx.moveTo(x, y + h);
          ctx.lineTo(x, y + w / 2);
          ctx.arc(x + w / 2, y + w / 2, w / 2, Math.PI, 0);
          ctx.lineTo(x + w, y + h);
          const waves = 4;
          for (let i = waves; i >= 0; i--) {
            const wx = x + (w * i) / waves;
            const up = (i + Math.floor(g.phase)) % 2 === 0;
            ctx.lineTo(wx, y + h - (up ? h * 0.12 : 0));
          }
          ctx.closePath();
          ctx.fill();
        }
        // Eyes look toward the camera (i.e. at you).
        const eyeY = y + h * 0.35;
        [0.32, 0.68].forEach((fx) => {
          const ex = x + w * fx;
          if (fright > 0 && !g.eaten) {
            ctx.fillStyle = flashing ? "#ff2020" : "#ffd0a0";
            ctx.fillRect(ex - w * 0.05, eyeY - w * 0.05, w * 0.1, w * 0.1);
            return;
          }
          ctx.fillStyle = "#fff";
          ctx.beginPath();
          ctx.ellipse(ex, eyeY, w * 0.12, w * 0.15, 0, 0, 2 * Math.PI);
          ctx.fill();
          ctx.fillStyle = "#1030c0";
          ctx.beginPath();
          ctx.arc(ex, eyeY + w * 0.05, w * 0.06, 0, 2 * Math.PI);
          ctx.fill();
        });
      });
    }

    function drawCoin(c) {
      const r = c.power ? POWER_RADIUS_M : COIN_RADIUS_M;
      const bob = c.power ? Math.sin(c.spin) * 0.01 : 0;
      const pr = ar.project(c.x, c.y, r + 0.01 + bob);
      if (!pr) return;
      const ctx = ar.ctx;
      ar.queue(pr.depth, () => {
        ar.floorCircle(c.x, c.y, r * 0.8, "rgba(0,0,0,0.25)");
        const rr = r * pr.ppm;
        const squash = Math.abs(Math.cos(c.spin)) * 0.85 + 0.15; // spinning on its edge
        if (c.power) ar.glow(pr.x, pr.y, rr * 2.2, [[0, "rgba(255,240,150,0.9)"], [1, "rgba(255,200,0,0)"]]);
        ctx.fillStyle = "#c8960a";
        ctx.beginPath();
        ctx.ellipse(pr.x, pr.y, Math.max(rr * squash, 1), Math.max(rr, 1), 0, 0, 2 * Math.PI);
        ctx.fill();
        ctx.fillStyle = "#ffd84a";
        ctx.beginPath();
        ctx.ellipse(pr.x, pr.y, Math.max(rr * squash * 0.75, 0.5), Math.max(rr * 0.75, 0.5), 0, 0, 2 * Math.PI);
        ctx.fill();
      });
    }

    function draw() {
      const v = ar.view;
      if (state !== "title") {
        // Play-area boundary, dashed on the floor.
        ar.ctx.save();
        ar.ctx.setLineDash([6, 6]);
        ar.ctx.lineWidth = 1.5;
        ar.floorCircle(center.x, center.y, R + 0.1, null, "rgba(80,160,255,0.55)");
        ar.ctx.restore();
      }
      coins.forEach(drawCoin);
      ghosts.forEach(drawGhost);
      ar.flush();

      if (cfg.radar && state !== "title") {
        const blips = coins.map((c) => ({ x: c.x, y: c.y, color: c.power ? "#fff080" : "#e0b020", r: c.power ? 3.5 : 2 }));
        ghosts.forEach((g) => blips.push({ x: g.x, y: g.y, color: g.eaten ? "#ffffff" : fright > 0 ? "#4060ff" : g.color, r: 4 }));
        ar.radar(blips, R + 0.6);
      }
      if (state === "playing") {
        const next = coins.reduce((best, c) => {
          const d = Math.hypot(c.x - ar.pose.x, c.y - ar.pose.y);
          return !best || d < best.d ? { c, d } : best;
        }, null);
        if (next) ar.edgeArrow(next.c.x, next.c.y, 0.03, "#ffd040");
        ghosts.forEach((g) => !g.eaten && fright === 0 && Math.hypot(g.x - ar.pose.x, g.y - ar.pose.y) < 0.8 && ar.edgeArrow(g.x, g.y, 0.08, g.color));
      }

      const hudY = v.y + v.h - 16;
      const hearts = "❤".repeat(Math.max(0, lives));
      ar.text(`SCORE ${score}`, v.x + 16, hudY, { size: 20, color: "#ffd84a" });
      ar.text(`LEVEL ${level}   ${hearts}   coins left ${coins.length}`, v.cx, hudY, { size: 16, align: "center" });
      if (fright > 0) ar.text(`POWER ${fright.toFixed(1)}s`, v.cx, v.y + v.h * 0.3, { size: 22, align: "center", color: "#6080ff" });
      if (invulnerable > 0 && state === "playing") ar.text("get ready...", v.cx, v.y + v.h * 0.36, { size: 16, align: "center", alpha: 0.8 });

      if (state === "title") {
        ar.flash("#000", 0.45);
        ar.banner("PACMAN", "Press FIRE to lay out the coins around you", { color: "#ffd84a" });
        ar.text("Drive over every coin · avoid the ghosts · power coins let you eat them", v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
        if (best !== null) ar.text(`Best on this robot: ${best}`, v.cx, v.cy + v.h * 0.27, { size: 14, align: "center", color: "#ffd84a" });
      } else if (state === "caught") {
        ar.flash("#000080", 0.3);
        ar.banner("CAUGHT!", lives > 0 ? `${lives} ${lives === 1 ? "life" : "lives"} left` : "", { color: "#ff4040" });
      } else if (state === "clear") {
        ar.banner(`LEVEL ${level} CLEAR`, `+${250 * level} · the ghosts get faster...`, { color: "#ffd84a" });
      } else if (state === "over") {
        ar.flash("#000", 0.4);
        ar.banner("GAME OVER", `Score ${score} · level ${level}`);
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.18, { size: 16, align: "center", color: "#ffd84a" });
        if (stateTime > 1.5) ar.text("Press FIRE to play again", v.cx, v.cy + v.h * 0.25, { size: 14, align: "center" });
      }
    }

    ar.onFrame((now, dt) => {
      update(dt);
      draw();
    });
    return { actionLabel: "▶ Start" };
  };
})(window.Lynx);
