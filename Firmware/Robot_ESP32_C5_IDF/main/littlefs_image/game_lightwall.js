// Lightwall -- Tron on your floor. The robot lays a glowing wall behind it as
// it drives; rival light-cycles race round the arena doing the same. Anything
// that touches a wall of light -- or the arena's edge -- is derezzed. Your own
// wall is harmless to you but deadly to them: cut them off, box them in,
// and stay clear of their trails. FIRE sends a pulse that wipes the rivals'
// walls close by when you are boxed in. Clear the arena for the next level.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const STEP_M = 0.03; // spacing of the wall's sample points
  const WALL_H = 0.07; // how tall the walls are drawn
  const HIT_R = 0.045; // a head this close to a wall point touches it
  const ROBOT_R = 0.1; // the robot's body, for rivals' walls and heads
  const PULSE_R = 0.7;
  const PULSE_COOLDOWN_S = 7;
  const INVULN_S = 2;
  const OUT_GRACE_S = 1.5;
  const MAX_RIVALS = 6;
  const RIVALS = ["#ff3b8a", "#ffb020", "#a060ff", "#60ff80", "#ff6040", "#f0f040"];
  const PLAYER_COLOR = "#30e0ff";

  const clamp01 = (t) => Math.min(1, Math.max(0, t));
  const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  Lynx.games.lightwall = (ar, cfg) => {
    const R = cfg.areaRadiusM;
    let state = "title"; // title | playing | clear | over
    let stateTime = 0;
    let center = { x: 0, y: 0 };
    let level = 1;
    let score = 0;
    let lives = cfg.lives;
    let invuln = 0;
    let pulseCd = 0;
    let pulses = []; // {x, y, t}
    let outTime = 0;
    let clock = 0;
    let me = []; // the player's wall: {x, y, t, gap}
    let rivals = [];
    let toast = null;
    let flash = 0;
    let best = null;
    let rankMsg = "";
    let reason = "";
    let lastX = 0;
    let lastY = 0;
    Lynx.bestScore("lightwall").then((b) => (best = b));

    function say(text, color, t = 1.6) {
      toast = { text, color, t };
    }

    function spawnRivals() {
      const n = Math.min(MAX_RIVALS, level + 1);
      const a0 = ar.pose.theta + Math.PI + Math.random(); // away from where the robot faces
      rivals = [];
      for (let i = 0; i < n; i++) {
        const a = a0 + (i * 2 * Math.PI) / n;
        const rr = R * 0.8;
        rivals.push({
          x: center.x + rr * Math.cos(a),
          y: center.y + rr * Math.sin(a),
          dir: a + Math.PI + (Math.random() - 0.5) * 0.8, // roughly inward
          color: RIVALS[i % RIVALS.length],
          trail: [],
          lastX: 0,
          lastY: 0,
          grace: 0.6 + i * 0.25, // sits as a glow before it sets off
          turn: 0,
          think: 0,
          alive: true,
          fade: 0,
        });
        const r = rivals[i];
        r.lastX = r.x;
        r.lastY = r.y;
      }
    }

    function startLevel() {
      center = center || { x: ar.pose.x, y: ar.pose.y };
      me = [];
      lastX = ar.pose.x;
      lastY = ar.pose.y;
      pulses = [];
      pulseCd = 0;
      outTime = 0;
      invuln = INVULN_S;
      spawnRivals();
      state = "playing";
      stateTime = 0;
      say(`Level ${level}: ${rivals.length} rivals`, PLAYER_COLOR);
      Lynx.sfx.play("go");
    }

    function start() {
      center = { x: ar.pose.x, y: ar.pose.y };
      level = 1;
      score = 0;
      lives = cfg.lives;
      rankMsg = "";
      startLevel();
    }

    function gameOver(why) {
      reason = why;
      state = "over";
      stateTime = 0;
      Lynx.sfx.play("lose");
      Lynx.submitScore("lightwall", score).then((rank) => {
        rankMsg = rank ? `#${rank} on the robot's scoreboard!` : "";
        if (rank === 1) best = score;
      });
    }

    function hurt(why) {
      if (invuln > 0 || state !== "playing") return;
      lives--;
      flash = 1;
      Lynx.sfx.play("hurt");
      if (lives <= 0) {
        gameOver(why);
        return;
      }
      invuln = INVULN_S;
      say(why, "#ff6060");
    }

    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title" || (state === "over" && stateTime > 1.5)) {
        start();
        return;
      }
      if (state !== "playing" || pulseCd > 0) return;
      pulseCd = PULSE_COOLDOWN_S;
      pulses.push({ x: ar.pose.x, y: ar.pose.y, t: 0 });
      let wiped = 0;
      rivals.forEach((r) => {
        const keep = r.trail.filter((p) => Math.hypot(p.x - ar.pose.x, p.y - ar.pose.y) > PULSE_R);
        wiped += r.trail.length - keep.length;
        r.trail = keep;
      });
      Lynx.sfx.play(wiped ? "plasma" : "zap");
    });

    // Is this spot deadly to a rival (not counting its own newest wall)?
    // Returns "edge", "me", "robot", "rival" or null.
    function blocked(self, x, y, ownSkip) {
      if (Math.hypot(x - center.x, y - center.y) > R - 0.03) return "edge";
      if (Math.hypot(x - ar.pose.x, y - ar.pose.y) < ROBOT_R) return "robot";
      for (let i = 0; i < me.length; i++) {
        if (Math.hypot(me[i].x - x, me[i].y - y) < HIT_R) return "me";
      }
      for (const r of rivals) {
        if (!r.alive) continue;
        const t = r.trail;
        const n = r === self ? t.length - ownSkip : t.length;
        for (let i = 0; i < n; i++) {
          if (Math.hypot(t[i].x - x, t[i].y - y) < HIT_R) return "rival";
        }
        if (r !== self && Math.hypot(r.x - x, r.y - y) < HIT_R * 1.5) return "rival";
      }
      return null;
    }

    function derez(r, by) {
      r.alive = false;
      r.fade = 1;
      const pts = by === "me" ? 100 + 25 * level : 40;
      score += pts;
      say(by === "me" ? `Derezzed!  +${pts}` : `Crashed  +${pts}`, r.color, 1.2);
      Lynx.sfx.play(by === "me" ? "explode" : "pain");
    }

    function steer(r, dt) {
      const v = cfg.enemySpeedMps * (1 + 0.08 * (level - 1));
      r.think -= dt;
      if (r.think <= 0) {
        r.think = 0.1;
        const look = 0.17 + v * 0.35;
        const free = (da, d) => !blocked(r, r.x + Math.cos(r.dir + da) * d, r.y + Math.sin(r.dir + da) * d, 6);
        const ahead = free(0, look) && free(0, look * 0.5);
        if (!ahead) {
          const l = free(-0.9, look) + (free(-0.5, look) ? 1 : 0);
          const rt = free(0.9, look) + (free(0.5, look) ? 1 : 0);
          r.turn = l === rt ? (Math.random() < 0.5 ? -2.8 : 2.8) : l > rt ? -2.8 : 2.8;
        } else if (Math.random() < 0.06 + 0.02 * level) {
          // sometimes cut towards the robot: that is how they box you in
          const want = Math.atan2(ar.pose.y - r.y, ar.pose.x - r.x);
          const d = wrapPi(want - r.dir);
          r.turn = Math.abs(d) < 0.15 ? 0 : d > 0 ? 2.2 : -2.2;
          r.think = 0.25;
        } else if (Math.abs(r.turn) > 0.01) {
          r.turn = 0;
        }
      }
      r.dir += r.turn * dt;
      r.x += Math.cos(r.dir) * v * dt;
      r.y += Math.sin(r.dir) * v * dt;
    }

    function update(dt) {
      clock += dt;
      stateTime += dt;
      flash = Math.max(0, flash - dt * 2);
      if (toast) {
        toast.t -= dt;
        if (toast.t <= 0) toast = null;
      }
      pulses.forEach((p) => (p.t += dt));
      pulses = pulses.filter((p) => p.t < 0.7);
      rivals.forEach((r) => {
        if (!r.alive) r.fade = Math.max(0, r.fade - dt * 0.8);
      });
      if (state === "clear") {
        if (stateTime > 2.5) {
          level++;
          startLevel();
        }
        return;
      }
      if (state !== "playing") return;
      invuln = Math.max(0, invuln - dt);
      pulseCd = Math.max(0, pulseCd - dt);

      // The player's wall.
      const px = ar.pose.x;
      const py = ar.pose.y;
      if (Math.hypot(px - lastX, py - lastY) >= STEP_M) {
        const gap = Math.hypot(px - lastX, py - lastY) > 0.2;
        me.push({ x: px, y: py, t: clock, gap });
        lastX = px;
        lastY = py;
      }
      while (me.length && clock - me[0].t > cfg.trailS) me.shift();

      // Out of the arena for too long.
      if (Math.hypot(px - center.x, py - center.y) > R) {
        outTime += dt;
        if (outTime > OUT_GRACE_S) {
          outTime = 0;
          hurt("Left the arena");
        }
      } else {
        outTime = 0;
      }

      let alive = 0;
      for (const r of rivals) {
        if (!r.alive) continue;
        alive++;
        if (r.grace > 0) {
          r.grace -= dt;
          continue;
        }
        steer(r, dt);
        if (Math.hypot(r.x - r.lastX, r.y - r.lastY) >= STEP_M) {
          r.trail.push({ x: r.x, y: r.y, t: clock, gap: false });
          r.lastX = r.x;
          r.lastY = r.y;
        }
        while (r.trail.length && clock - r.trail[0].t > cfg.trailS) r.trail.shift();
        // Did it hit something? (A little look ahead is in steer(); this is the touch.)
        const hit = blocked(r, r.x, r.y, 8);
        if (hit === "edge" || hit === "rival") derez(r, "wall");
        else if (hit === "me") derez(r, "me");
        else if (hit === "robot") {
          derez(r, "wall");
          hurt("Rammed by a rival");
        }
      }
      // A rival's head or wall under the robot.
      if (invuln <= 0) {
        for (const r of rivals) {
          if (!r.alive) continue;
          if (Math.hypot(r.x - px, r.y - py) < ROBOT_R * 0.8) {
            hurt("Hit a rival");
            break;
          }
          if (r.trail.some((p) => Math.hypot(p.x - px, p.y - py) < ROBOT_R * 0.7)) {
            hurt("Hit a light wall");
            break;
          }
        }
      }
      if (state === "playing" && alive > 0 && rivals.every((r) => !r.alive)) {
        const bonus = 150 * level + 50 * lives;
        score += bonus;
        state = "clear";
        stateTime = 0;
        say(`Arena clear!  +${bonus}`, "#ffd84a", 2.3);
        Lynx.sfx.play("levelup");
      }
    }

    // -- drawing --------------------------------------------------------------

    function hexA(hex, a) {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
    }

    function drawWall(pts, color, alphaScale) {
      const ctx = ar.ctx;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        if (b.gap) continue;
        const age = clamp01((clock - b.t) / cfg.trailS);
        const al = alphaScale * (age > 0.7 ? 1 - (age - 0.7) / 0.3 : 1);
        if (al <= 0.02) continue;
        const p0 = ar.project(a.x, a.y, 0);
        const p1 = ar.project(b.x, b.y, 0);
        const p2 = ar.project(b.x, b.y, WALL_H);
        const p3 = ar.project(a.x, a.y, WALL_H);
        if (!p0 || !p1 || !p2 || !p3) continue;
        ctx.fillStyle = hexA(color, 0.4 * al);
        ctx.beginPath();
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.lineTo(p3.x, p3.y);
        ctx.closePath();
        ctx.fill();
        ctx.strokeStyle = hexA(color, 0.95 * al);
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(p3.x, p3.y);
        ctx.lineTo(p2.x, p2.y);
        ctx.stroke();
      }
      ctx.restore();
    }

    function drawHead(x, y, color, size, a) {
      const p = ar.project(x, y, WALL_H * 0.5);
      if (!p) return;
      ar.glow(p.x, p.y, Math.max(6, size * p.ppm), [[0, hexA("#ffffff", 0.9)], [0.3, hexA(color, 0.85)], [1, hexA(color, 0)]], a);
    }

    function draw() {
      const v = ar.view;
      const ctx = ar.ctx;
      if (state !== "title") {
        // The arena's edge: a ring on the floor and a thin wall of light.
        ar.floorCircle(center.x, center.y, R, "rgba(40,120,255,0.05)", "rgba(60,150,255,0.8)");
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        ar.floorCircle(center.x, center.y, R, null, "rgba(60,150,255,0.5)", WALL_H);
        ctx.restore();

        drawWall(me, PLAYER_COLOR, 1);
        rivals.forEach((r) => {
          drawWall(r.trail, r.color, 1);
          if (r.alive) {
            const spawning = r.grace > 0;
            const pulse = spawning ? 0.5 + 0.5 * Math.sin(clock * 14) : 1;
            drawHead(r.x, r.y, r.color, 0.07, pulse);
          } else if (r.fade > 0) {
            const k = 1 - r.fade;
            drawHead(r.x, r.y, "#ffffff", 0.08 + 0.35 * k, r.fade);
          }
        });
        pulses.forEach((p) => {
          const k = p.t / 0.7;
          ar.floorCircle(p.x, p.y, PULSE_R * k, null, hexA(PLAYER_COLOR, 1 - k));
        });
        if (state === "playing") {
          // The player's own head: blinks while invulnerable.
          if (invuln <= 0 || Math.floor(clock * 10) % 2) drawHead(ar.pose.x, ar.pose.y, PLAYER_COLOR, 0.09, 0.8);
        }
      }
      ar.flush();

      if (state === "playing" || state === "clear") {
        rivals.forEach((r) => {
          if (r.alive) ar.edgeArrow(r.x, r.y, WALL_H * 0.5, r.color);
        });
        if (cfg.radar) {
          ar.radar(
            rivals.filter((r) => r.alive).map((r) => ({ x: r.x, y: r.y, color: r.color, r: 3.5 })),
            R * 1.4
          );
        }
        if (outTime > 0) {
          ar.text("BACK INTO THE ARENA!", v.cx, v.y + v.h * 0.3, { size: 22, align: "center", color: "#ff6060", alpha: 0.6 + 0.4 * Math.sin(clock * 12) });
        }
        // Pulse readiness.
        const frac = 1 - clamp01(pulseCd / PULSE_COOLDOWN_S);
        ctx.fillStyle = frac >= 1 ? PLAYER_COLOR : "rgba(255,255,255,0.35)";
        ctx.fillRect(v.cx - 60, v.y + v.h - 44, 120 * frac, 4);
        ar.text(frac >= 1 ? "PULSE READY (FIRE)" : "pulse charging", v.cx, v.y + v.h - 50, { size: 12, align: "center", color: frac >= 1 ? PLAYER_COLOR : "#a0a0a0" });
      }
      ar.flash("#ff0000", flash * 0.35);

      const hudY = v.y + v.h - 16;
      ar.text(`SCORE ${score}`, v.x + 16, hudY, { size: 20, color: PLAYER_COLOR });
      if (state !== "title") {
        ar.text(`LEVEL ${level}   ${"◆".repeat(Math.max(0, lives))}`, v.x + v.w - 16, hudY, { size: 16, align: "right" });
      }
      if (toast) ar.text(toast.text, v.cx, v.y + v.h * 0.42, { size: 24, align: "center", color: toast.color, alpha: clamp01(toast.t * 2) });

      if (state === "title") {
        ar.flash("#000", 0.45);
        ar.banner("LIGHTWALL", "Press FIRE to enter the arena", { color: PLAYER_COLOR });
        ar.text("Your trail is a wall of light · trap the rivals in it · never touch theirs", v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
        if (best !== null) ar.text(`Best on this robot: ${best}`, v.cx, v.cy + v.h * 0.27, { size: 14, align: "center", color: PLAYER_COLOR });
      } else if (state === "over") {
        ar.flash("#000", 0.4);
        ar.banner("DEREZZED", `${reason} · Score ${score} · level ${level}`);
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.18, { size: 16, align: "center", color: PLAYER_COLOR });
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
