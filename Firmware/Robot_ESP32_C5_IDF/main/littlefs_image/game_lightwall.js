// Lightwall -- Tron on your floor, in the third person. You ride a light-cycle
// on the floor in front of the robot; the game drives the robot after it (the
// "goto" position control, like Pocket Knight) and points the camera at it.
// The cycle never stops: the stick says which way to head (camera-relative:
// up = the way the view looks) and it leans round to that heading. It lays a
// wall of light behind it, and so do the rival cycles. Anything that touches
// a wall of light -- or the arena's edge -- is derezzed. Your own wall is
// harmless to you but deadly to them: cut them off and box them in.
//
// There are no levels: the arena keeps going. Rivals that survive stay; a
// derezzed one comes back along the edge a few seconds later, and every
// RIVAL_EVERY_S another rival joins (up to MAX_RIVALS), a little faster.
// The rivals look ahead: each think they try a few turns, follow each one
// round for a second or so and take the one with the most free room (other
// cycles' heads are where they'll be by then), now and then cutting across
// your path. FIRE: a pulse that wipes the rival walls close to you.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const STEP_M = 0.03; // spacing of the wall's sample points
  const WALL_H = 0.07; // how tall the walls are drawn
  const HIT_R = 0.04; // a head this close to a wall point touches it
  const HEAD_R = 0.07; // two heads this close collide
  const PULSE_R = 0.6;
  const PULSE_COOLDOWN_S = 7;
  const INVULN_S = 2.5;
  const MAX_RIVALS = 6;
  const RIVAL_TRAIL = 0.6; // rivals' walls last this part of yours (else the arena fills up)
  const START_RIVALS = 2;
  const RIVAL_EVERY_S = 25;
  const RESPAWN_S = 3;
  const TURN_RATE = 2.6; // rad/s, the player's cycle
  const RIVAL_TURNS = [-2.6, -1.3, 0, 1.3, 2.6]; // what a rival tries, rad/s
  const LOOK_S = 1.3; // how far ahead a rival plans
  const THINK_S = 0.12;
  const FOLLOW_M = 0.4; // the robot keeps this far behind the cycle
  const BEHIND_RATE = 1.0; // rad/s: how fast the robot swings round behind it
  const GOTO_EVERY_MS = 250;
  const GOTO_MOVE_M = 0.01;
  const CELL = 0.02; // the occupancy grid the rivals plan with
  const RIVALS = ["#ff3b8a", "#ffb020", "#a060ff", "#60ff80", "#ff6040", "#f0f040", "#ff80ff", "#80ffd0"];
  const PLAYER_COLOR = "#30e0ff";

  const clamp01 = (t) => Math.min(1, Math.max(0, t));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  Lynx.games.lightwall = (ar, cfg) => {
    const R = cfg.areaRadiusM;
    const V0 = cfg.enemySpeedMps;
    let state = "title"; // title | playing | over
    let stateTime = 0;
    let center = { x: 0, y: 0 };
    let score = 0;
    let lives = cfg.lives;
    let invuln = 0;
    let pulseCd = 0;
    let pulses = []; // {x, y, t}
    let clock = 0;
    let playTime = 0;
    let cycle = null; // the player's: {x, y, dir, trail, lastX, lastY}
    let rivals = [];
    let wanted = START_RIVALS;
    let nextRivalAt = RIVAL_EVERY_S;
    let colorN = 0;
    let toast = null;
    let flash = 0;
    let best = null;
    let rankMsg = "";
    let reason = "";
    let grid = new Map();
    const cam = { b: null, lastGoto: null, lastGotoMs: -1e9, lastAimMs: -1e9, aimYaw: null, aimTilt: 0 };
    Lynx.bestScore("lightwall").then((b) => (best = b));

    function say(text, color, t = 1.6) {
      toast = { text, color, t };
    }
    const rivalSpeed = () => V0 * (0.9 + 0.04 * (wanted - START_RIVALS));
    const inArena = (x, y, m = 0) => Math.hypot(x - center.x, y - center.y) < R - m;

    // -- a rival comes in along the edge, as far from the player as it can --------------------------
    function spawnRival(first) {
      let bestA = 0;
      let bestD = -1;
      for (let i = 0; i < 12; i++) {
        const a = Math.random() * 2 * Math.PI;
        const x = center.x + R * 0.85 * Math.cos(a);
        const y = center.y + R * 0.85 * Math.sin(a);
        let d = Math.hypot(x - cycle.x, y - cycle.y);
        rivals.forEach((r) => r.alive && (d = Math.min(d, Math.hypot(x - r.x, y - r.y) * 1.5)));
        if (d > bestD) {
          bestD = d;
          bestA = a;
        }
      }
      const x = center.x + R * 0.85 * Math.cos(bestA);
      const y = center.y + R * 0.85 * Math.sin(bestA);
      const r = {
        x,
        y,
        dir: bestA + Math.PI + (Math.random() - 0.5) * 0.8, // roughly inward
        color: RIVALS[colorN++ % RIVALS.length],
        trail: [],
        lastX: x,
        lastY: y,
        grace: first ? 0.8 + rivals.length * 0.3 : 1.2, // sits as a glow before it sets off
        turn: 0,
        think: 0,
        alive: true,
        fade: 0,
      };
      rivals.push(r);
      return r;
    }

    function start() {
      const th = ar.pose.theta;
      center = { x: ar.pose.x + Math.cos(th) * FOLLOW_M, y: ar.pose.y + Math.sin(th) * FOLLOW_M };
      cycle = { x: center.x, y: center.y, dir: th, trail: [], lastX: center.x, lastY: center.y };
      cam.b = th + Math.PI;
      cam.lastGoto = null;
      score = 0;
      lives = cfg.lives;
      rankMsg = "";
      pulses = [];
      pulseCd = 0;
      invuln = INVULN_S;
      playTime = 0;
      wanted = START_RIVALS;
      nextRivalAt = RIVAL_EVERY_S;
      colorN = 0;
      rivals = [];
      for (let i = 0; i < wanted; i++) spawnRival(true);
      state = "playing";
      stateTime = 0;
      takeControl(true);
      say("Ride!  Trap them in your light", PLAYER_COLOR);
      Lynx.sfx.play("go");
    }

    function gameOver(why) {
      reason = why;
      state = "over";
      stateTime = 0;
      stopRobot();
      Lynx.sfx.play("lose");
      score = Math.floor(score);
      Lynx.submitScore("lightwall", score).then((rank) => {
        rankMsg = rank ? `#${rank} on the robot's scoreboard!` : "";
        if (rank === 1) best = score;
      });
    }

    function wipeNear(x, y, rad) {
      let wiped = 0;
      rivals.forEach((r) => {
        const keep = r.trail.filter((p) => Math.hypot(p.x - x, p.y - y) > rad);
        wiped += r.trail.length - keep.length;
        r.trail = keep;
      });
      return wiped;
    }

    function crash(why) {
      if (invuln > 0 || state !== "playing") return;
      lives--;
      flash = 1;
      Lynx.sfx.play("hurt");
      if (lives <= 0) {
        gameOver(why);
        return;
      }
      // back on its wheels: the walls round it gone, pointing into the arena
      invuln = INVULN_S;
      wipeNear(cycle.x, cycle.y, PULSE_R * 0.6);
      pulses.push({ x: cycle.x, y: cycle.y, t: 0 });
      if (!inArena(cycle.x, cycle.y, 0.15)) {
        const a = Math.atan2(cycle.y - center.y, cycle.x - center.x);
        cycle.x = center.x + (R - 0.15) * Math.cos(a);
        cycle.y = center.y + (R - 0.15) * Math.sin(a);
        cycle.dir = a + Math.PI;
      }
      cycle.lastX = cycle.x;
      cycle.lastY = cycle.y;
      cycle.trail.push({ x: cycle.x, y: cycle.y, t: clock, gap: true });
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
      pulses.push({ x: cycle.x, y: cycle.y, t: 0 });
      Lynx.sfx.play(wipeNear(cycle.x, cycle.y, PULSE_R) ? "plasma" : "zap");
    });

    // -- the rivals' map: every wall point, on a grid --------------------------------------------------
    const key = (i, j) => i * 65536 + j;
    // Each cell: who laid the newest wall point near it, and when (a rival
    // ignores its own last half second of wall, right behind its head).
    function buildGrid() {
      grid = new Map();
      const mark = (pts, owner) => {
        for (const p of pts) {
          const i0 = Math.round(p.x / CELL);
          const j0 = Math.round(p.y / CELL);
          for (let i = i0 - 2; i <= i0 + 2; i++) {
            for (let j = j0 - 2; j <= j0 + 2; j++) {
              const k = key(i, j);
              const c = grid.get(k);
              if (!c || c.t < p.t) grid.set(k, { owner, t: p.t });
            }
          }
        }
      };
      mark(cycle.trail, cycle);
      rivals.forEach((r) => mark(r.trail, r)); // (all of it: right behind a head is a wall too)
    }
    function wallAtGrid(x, y, self) {
      const c = grid.get(key(Math.round(x / CELL), Math.round(y / CELL)));
      return !!c && !(c.owner === self && clock - c.t < 0.6);
    }

    // How far a rival gets turning at this rate before it hits something.
    function freeRun(r, turn, v) {
      const dt = STEP_M / v;
      let x = r.x;
      let y = r.y;
      let dir = r.dir;
      // the other cycles, and where they'll be by then
      const heads = rivals.filter((o) => o !== r && o.alive).map((o) => ({ x: o.x, y: o.y, dir: o.dir, v: o.grace > 0 ? 0 : v }));
      heads.push({ x: cycle.x, y: cycle.y, dir: cycle.dir, v: V0 });
      for (let t = dt; t <= LOOK_S; t += dt) {
        dir += turn * dt;
        x += Math.cos(dir) * STEP_M;
        y += Math.sin(dir) * STEP_M;
        if (!inArena(x, y, 0.05)) return t;
        if (wallAtGrid(x, y, r)) return t;
        for (const o of heads) {
          const ox = o.x + Math.cos(o.dir) * o.v * t;
          const oy = o.y + Math.sin(o.dir) * o.v * t;
          if (Math.hypot(ox - x, oy - y) < HEAD_R * 1.6) return t;
        }
      }
      return LOOK_S;
    }

    function steer(r, dt) {
      const v = rivalSpeed();
      r.think -= dt;
      if (r.think <= 0) {
        r.think = THINK_S;
        const runs = RIVAL_TURNS.map((turn) => ({ turn, free: freeRun(r, turn, v) }));
        const most = Math.max(...runs.map((o) => o.free));
        // of the safest, the straightest -- or now and then the one that cuts across the player's path
        const hunt = Math.random() < 0.25 + 0.03 * wanted;
        const tx = cycle.x + Math.cos(cycle.dir) * 0.35;
        const ty = cycle.y + Math.sin(cycle.dir) * 0.35;
        const want = wrapPi(Math.atan2(ty - r.y, tx - r.x) - r.dir);
        let pick = null;
        let pickScore = -1e9;
        runs.forEach((o) => {
          if (o.free < most - 0.05) return;
          let s = -Math.abs(o.turn) * 0.1 - Math.abs(o.turn - r.turn) * 0.05;
          if (hunt) s -= Math.abs(wrapPi(want - Math.sign(o.turn) * 0.5)) * (o.turn === 0 ? 1 : 0.6);
          if (s > pickScore) {
            pickScore = s;
            pick = o;
          }
        });
        r.turn = pick.turn;
      }
      r.dir += r.turn * dt;
      r.x += Math.cos(r.dir) * v * dt;
      r.y += Math.sin(r.dir) * v * dt;
    }

    // Does a head here touch a wall? ("me", "rival", "edge" or null; own newest points skipped)
    function touching(self, x, y) {
      if (!inArena(x, y, 0.02)) return "edge";
      if (self !== cycle) {
        for (const p of cycle.trail) if (Math.hypot(p.x - x, p.y - y) < HIT_R) return "me";
      }
      for (const r of rivals) {
          const t = r.trail;
        const n = r === self ? t.length - 4 : t.length;
        for (let i = 0; i < n; i++) if (Math.hypot(t[i].x - x, t[i].y - y) < HIT_R) return "rival";
      }
      return null;
    }

    const crashes = {}; // (why rivals crash, for tuning)
    function derez(r, by, what = by) {
      crashes[what] = (crashes[what] || 0) + 1;
      r.alive = false;
      r.fade = 1;
      r.respawn = RESPAWN_S;
      const pts = by === "me" ? 100 + 10 * wanted : 30;
      score += pts;
      say(by === "me" ? `Derezzed!  +${pts}` : `Crashed  +${pts}`, r.color, 1.2);
      Lynx.sfx.play(by === "me" ? "explode" : "pain");
    }

    function layTrail(c) {
      if (Math.hypot(c.x - c.lastX, c.y - c.lastY) >= STEP_M) {
        c.trail.push({ x: c.x, y: c.y, t: clock, gap: false });
        c.lastX = c.x;
        c.lastY = c.y;
      }
      const life = c === cycle ? cfg.trailS : cfg.trailS * RIVAL_TRAIL;
      while (c.trail.length && clock - c.trail[0].t > life) c.trail.shift();
    }

    function stepCycle(dt) {
      const d = Lynx.control.driveInput();
      if (Math.hypot(d.j1, d.j2) > 0.3) {
        const want = ar.camTheta + Math.atan2(-d.j1, d.j2);
        const diff = wrapPi(want - cycle.dir);
        cycle.dir += clamp(diff, -TURN_RATE * dt, TURN_RATE * dt);
      }
      cycle.x += Math.cos(cycle.dir) * V0 * dt;
      cycle.y += Math.sin(cycle.dir) * V0 * dt;
      layTrail(cycle);
    }

    function update(dt, now) {
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
      if (state !== "playing") return;
      playTime += dt;
      invuln = Math.max(0, invuln - dt);
      pulseCd = Math.max(0, pulseCd - dt);
      score += dt * 2; // (staying alive)

      stepCycle(dt);
      steerRobot(dt, now);

      // more rivals as time goes on; the derezzed ones come back along the edge
      if (playTime > nextRivalAt && wanted < MAX_RIVALS) {
        wanted++;
        nextRivalAt += RIVAL_EVERY_S;
        say(`A new rival!  (${wanted})`, "#ffd84a");
      }
      rivals = rivals.filter((r) => r.alive || r.fade > 0 || r.trail.length || r.respawn > 0);
      rivals.forEach((r) => !r.alive && r.respawn > 0 && (r.respawn -= dt));
      const slots = rivals.filter((r) => r.alive || r.respawn > 0).length;
      for (let i = slots; i < wanted; i++) spawnRival(false);
      // a derezzed rival's wall fades out like any other
      rivals.forEach((r) => {
        if (!r.alive) while (r.trail.length && clock - r.trail[0].t > cfg.trailS * RIVAL_TRAIL) r.trail.shift();
      });

      buildGrid();
      for (const r of rivals) {
        if (!r.alive) continue;
        if (r.grace > 0) {
          r.grace -= dt;
          continue;
        }
        steer(r, dt);
        layTrail(r);
        const hit = touching(r, r.x, r.y);
        if (hit === "edge" || hit === "rival") derez(r, "wall", hit);
        else if (hit === "me") derez(r, "me");
      }
      // heads together: both crash
      const live = rivals.filter((r) => r.alive && r.grace <= 0);
      for (let i = 0; i < live.length; i++) {
        for (let j = i + 1; j < live.length; j++) {
          if (live[i].alive && live[j].alive && Math.hypot(live[i].x - live[j].x, live[i].y - live[j].y) < HEAD_R) {
            derez(live[i], "wall", "head");
            derez(live[j], "wall", "head");
          }
        }
      }
      // the player's cycle
      if (invuln <= 0) {
        const hit = touching(cycle, cycle.x, cycle.y);
        if (hit === "edge") crash("Hit the arena's edge");
        else if (hit === "rival") crash("Hit a light wall");
        else if (live.some((r) => r.alive && Math.hypot(r.x - cycle.x, r.y - cycle.y) < HEAD_R)) crash("Collided with a rival");
      }
    }

    // -- the robot: behind the cycle, camera on it ------------------------------------------------------
    function steerRobot(dt, now) {
      const d = wrapPi(cycle.dir + Math.PI - cam.b);
      cam.b = wrapPi(cam.b + clamp(d, -BEHIND_RATE * dt, BEHIND_RATE * dt));
      const t = { x: cycle.x + FOLLOW_M * Math.cos(cam.b), y: cycle.y + FOLLOW_M * Math.sin(cam.b) };
      const moved = !cam.lastGoto || Math.hypot(t.x - cam.lastGoto.x, t.y - cam.lastGoto.y) > GOTO_MOVE_M;
      if (moved || now - cam.lastGotoMs > GOTO_EVERY_MS) {
        Lynx.control.send({ type: "goto", x: +t.x.toFixed(4), y: +t.y.toFixed(4), maintainSpeed: false });
        cam.lastGoto = t;
        cam.lastGotoMs = now;
      }
      // aim: a little ahead of the cycle
      const cw = ar.cameraWorld();
      const px = cycle.x + Math.cos(cycle.dir) * 0.1;
      const py = cycle.y + Math.sin(cycle.dir) * 0.1;
      const hd = Math.hypot(px - cw.x, py - cw.y);
      if (hd > 0.03 || cam.aimYaw === null) cam.aimYaw = Math.atan2(py - cw.y, px - cw.x);
      const down = Math.atan2(cw.h - 0.02, Math.max(hd, 0.03));
      cam.aimTilt = ((ar.calib.tiltRad - down) * 180) / Math.PI;
      if (!Lynx.control.absoluteAim() && now - cam.lastAimMs > 50) {
        Lynx.control.send({ type: "aim", heading: +wrapPi(cam.aimYaw).toFixed(4), tilt: +cam.aimTilt.toFixed(2) });
        cam.lastAimMs = now;
      }
    }
    function stopRobot() {
      const cw = ar.cameraWorld();
      Lynx.control.send({ type: "goto", x: +cw.x.toFixed(4), y: +cw.y.toFixed(4), maintainSpeed: false });
      cam.lastGoto = null;
      takeControl(false);
    }
    // While playing, the stick steers the cycle, and the game drives the robot and points the camera.
    function takeControl(on) {
      if (Lynx.control.setDriveFilter) Lynx.control.setDriveFilter(on ? () => null : null);
      if (Lynx.cam && Lynx.cam.setAimOverride) Lynx.cam.setAimOverride(on ? () => (cam.aimYaw === null ? null : { yaw: cam.aimYaw, tiltDeg: cam.aimTilt }) : null);
    }
    ar.onDestroy(() => {
      Lynx.control.send({ type: "joystick", j1: 0, j2: 0 }); // out of goto: stop
      takeControl(false);
    });

    // -- drawing ----------------------------------------------------------------------------------------
    function hexA(hex, a) {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
    }

    function drawWall(pts, color, alphaScale, life) {
      const ctx = ar.ctx;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1];
        const b = pts[i];
        if (b.gap) continue;
        const age = clamp01((clock - b.t) / life);
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

    function glow(x, y, h, color, size, a) {
      const p = ar.project(x, y, h);
      if (!p) return;
      ar.glow(p.x, p.y, Math.max(5, size * p.ppm), [[0, hexA("#ffffff", 0.9)], [0.3, hexA(color, 0.85)], [1, hexA(color, 0)]], a);
    }

    function hull(pts) {
      pts = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
      const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
      const lo = [];
      for (const p of pts) {
        while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
        lo.push(p);
      }
      const up = [];
      for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop();
        up.push(p);
      }
      return lo.slice(0, -1).concat(up.slice(0, -1));
    }
    // A solid block in the cycle's frame (u forward, s left), as its outline on screen.
    function block(x, y, dir, u0, u1, s0, s1, h0, h1) {
      const c = Math.cos(dir);
      const sn = Math.sin(dir);
      const out = [];
      for (const u of [u0, u1]) {
        for (const s of [s0, s1]) {
          for (const h of [h0, h1]) {
            const p = ar.project(x + u * c - s * sn, y + u * sn + s * c, h);
            if (!p) return null;
            out.push(p);
          }
        }
      }
      return hull(out);
    }
    function fillPoly(pts, fill, stroke, lw = 1.5) {
      if (!pts || pts.length < 3) return;
      const ctx = ar.ctx;
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = lw;
        ctx.stroke();
      }
    }
    function wheel(x, y, dir, u, color, a) {
      const c = Math.cos(dir);
      const sn = Math.sin(dir);
      const pts = [];
      for (let k = 0; k < 14; k++) {
        const ang = (k / 14) * 2 * Math.PI;
        const uu = u + Math.cos(ang) * 0.018;
        const p = ar.project(x + uu * c, y + uu * sn, 0.018 + Math.sin(ang) * 0.018);
        if (!p) return;
        pts.push(p);
      }
      fillPoly(pts, "rgba(8,10,16,0.95)", hexA(color, a), 2.5);
    }
    // A light-cycle: two glowing wheels, a dark body with a light stripe, a canopy.
    function drawCycle(x, y, dir, color, a) {
      const ctx = ar.ctx;
      ctx.save();
      ctx.globalAlpha = a;
      ar.floorCircle(x, y, 0.045, "rgba(0,0,0,0.35)", null);
      wheel(x, y, dir, -0.032, color, 1);
      fillPoly(block(x, y, dir, -0.045, 0.05, -0.012, 0.012, 0.012, 0.034), "#0c1018", hexA(color, 0.9));
      fillPoly(block(x, y, dir, -0.01, 0.03, -0.009, 0.009, 0.032, 0.046), hexA(color, 0.55), hexA(color, 1), 1);
      wheel(x, y, dir, 0.034, color, 1);
      ctx.restore();
      glow(x - Math.cos(dir) * 0.05, y - Math.sin(dir) * 0.05, 0.02, color, 0.05, 0.7 * a);
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

        drawWall(cycle.trail, PLAYER_COLOR, 1, cfg.trailS);
        rivals.forEach((r) => drawWall(r.trail, r.color, 1, cfg.trailS * RIVAL_TRAIL));
        pulses.forEach((p) => {
          const k = p.t / 0.7;
          ar.floorCircle(p.x, p.y, PULSE_R * k, null, hexA(PLAYER_COLOR, 1 - k));
        });
        // cycles, far ones first
        const cw = ar.cameraWorld();
        const items = rivals.filter((r) => r.alive || r.fade > 0).map((r) => ({ c: r, color: r.color }));
        items.push({ c: cycle, color: PLAYER_COLOR, me: true });
        items.sort((p, q) => Math.hypot(q.c.x - cw.x, q.c.y - cw.y) - Math.hypot(p.c.x - cw.x, p.c.y - cw.y));
        items.forEach(({ c, color, me }) => {
          if (me) {
            if (state !== "over" && (invuln <= 0 || Math.floor(clock * 10) % 2)) drawCycle(c.x, c.y, c.dir, color, 1);
          } else if (c.alive) {
            const spawning = c.grace > 0;
            if (spawning) glow(c.x, c.y, 0.03, c.color, 0.08, 0.5 + 0.5 * Math.sin(clock * 14));
            else drawCycle(c.x, c.y, c.dir, color, 1);
          } else {
            glow(c.x, c.y, 0.03, "#ffffff", 0.08 + 0.35 * (1 - c.fade), c.fade);
          }
        });
      }
      ar.flush();

      if (state === "playing") {
        rivals.forEach((r) => {
          if (r.alive) ar.edgeArrow(r.x, r.y, WALL_H * 0.5, r.color);
        });
        if (cfg.radar) {
          ar.radar(
            rivals.filter((r) => r.alive).map((r) => ({ x: r.x, y: r.y, color: r.color, r: 3.5 })).concat([{ x: cycle.x, y: cycle.y, color: PLAYER_COLOR, r: 4 }]),
            R * 1.4
          );
        }
        // Pulse readiness.
        const frac = 1 - clamp01(pulseCd / PULSE_COOLDOWN_S);
        ctx.fillStyle = frac >= 1 ? PLAYER_COLOR : "rgba(255,255,255,0.35)";
        ctx.fillRect(v.cx - 60, v.y + v.h - 44, 120 * frac, 4);
        ar.text(frac >= 1 ? "PULSE READY (FIRE)" : "pulse charging", v.cx, v.y + v.h - 50, { size: 12, align: "center", color: frac >= 1 ? PLAYER_COLOR : "#a0a0a0" });
      }
      ar.flash("#ff0000", flash * 0.35);

      const hudY = v.y + v.h - 16;
      ar.text(`SCORE ${Math.floor(score)}`, v.x + 16, hudY, { size: 20, color: PLAYER_COLOR });
      if (state !== "title") {
        ar.text(`RIVALS ${wanted}   ${"◆".repeat(Math.max(0, lives))}`, v.x + v.w - 16, hudY, { size: 16, align: "right" });
      }
      if (toast) ar.text(toast.text, v.cx, v.y + v.h * 0.3, { size: 24, align: "center", color: toast.color, alpha: clamp01(toast.t * 2) });

      if (state === "title") {
        ar.flash("#000", 0.45);
        ar.banner("LIGHTWALL", "Press FIRE to enter the arena -- you ride, the robot follows", { color: PLAYER_COLOR });
        ar.text("Stick: which way to ride · your trail is a wall of light · trap the rivals in it · never touch theirs", v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
        if (best !== null) ar.text(`Best on this robot: ${best}`, v.cx, v.cy + v.h * 0.27, { size: 14, align: "center", color: PLAYER_COLOR });
      } else if (state === "over") {
        ar.flash("#000", 0.4);
        ar.banner("DEREZZED", `${reason} · Score ${Math.floor(score)} · ${wanted} rivals`);
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.18, { size: 16, align: "center", color: PLAYER_COLOR });
        if (stateTime > 1.5) ar.text("Press FIRE to play again", v.cx, v.cy + v.h * 0.25, { size: 14, align: "center" });
      }
    }

    ar.onFrame((now, dt) => {
      update(Math.min(dt, 0.1), now);
      draw();
    });
    return {
      actionLabel: "▶ Start",
      snapshot: () => ({ state, score: Math.floor(score), lives, rivals: rivals.filter((r) => r.alive).length, wanted }),
      debug: {
        cycle: () => (cycle ? { x: cycle.x, y: cycle.y, h: 0.03, yaw: cycle.dir } : null),
        crashes: () => ({ ...crashes }),
        god(on) {
          invuln = on ? 1e9 : 0;
        },
      },
    };
  };
})(window.Lynx);
