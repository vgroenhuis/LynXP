// Weapons shared by the shooter games (Doom, David, Poop Shooter): things
// that fly or lie in the room rather than hitting at once -- arrows (falling
// with gravity: aim above the target), projectiles (rockets, plasma, the
// BFG's ball; optionally exploding), bombs rolling along the floor -- plus
// close combat (sword, fist, chainsaw...) and a shield.
//
//   const kit = Lynx.weaponKit(ar, {
//     targets: () => [{obj, x, y, h0, h1, r}],   // what can be hit: upright cylinders (world m)
//     hit: (obj, dmg, info) => {},               // info: {kind: "arrow" | "shot" | "blast" | "melee", dx, dy (away from the source)}
//     wallAt: (x, y, h) => bool,                 // optional: solid there (stops arrows, shots, bombs)
//     blocked: (x0, y0, x1, y1) => bool,         // optional: a wall between (a blast doesn't reach through)
//     hurtPlayer: (fraction) => {},              // optional: caught in your own blast (0..1, 1 = at its middle)
//   });
//
// Bombs: fire rolls one along the floor, at a steady speed, toward where the
// crosshair meets the floor (or as far as it goes when aiming higher) -- it
// stops there and waits. Fire again to set it off, or it goes off by itself
// when the fuse burns down. Its blast reaches as far as the red ring drawn
// around it, you too.
//
// Shield: held up (Lynx.input.shieldHeld: X, gamepad B, the touch button), it
// blocks what comes at it from the front (within SHIELD_ARC of where the
// camera looks) -- while it has energy: holding it up drains some, every
// block costs more, and it recharges while lowered.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const GRAVITY = 3; // m/s² for arrows (gentle: they're slow enough to see)
  const ARROW_LEN = 0.12;
  const BOMB_R = 0.025; // m
  const SHIELD_ARC = (70 * Math.PI) / 180;
  const SHIELD_DRAIN = 0.08; // energy per second held up
  const SHIELD_BLOCK = 0.22; // energy per blocked hit
  const SHIELD_RECHARGE = 0.12; // per second, lowered
  const FIRE_STOPS = [[0, "rgba(255,255,210,1)"], [0.35, "rgba(255,170,40,0.95)"], [0.75, "rgba(255,60,10,0.6)"], [1, "rgba(255,30,0,0)"]];
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const rand = (a, b) => a + Math.random() * (b - a);
  const dmgOf = (d) => (Array.isArray(d) ? rand(d[0], d[1]) : d);

  Lynx.weaponKit = (ar, opts) => {
    const targets = () => (opts.targets ? opts.targets() : []);
    const hit = (obj, dmg, info) => opts.hit && opts.hit(obj, dmg, info);
    const wallAt = (x, y, h) => !!(opts.wallAt && opts.wallAt(x, y, h));
    const blocked = (x0, y0, x1, y1) => !!(opts.blocked && opts.blocked(x0, y0, x1, y1));
    let arrows = []; // {x, y, h, vx, vy, vh, dmg, stuck (s since it stopped, -1 flying)}
    let shots = []; // {x, y, h, vx, vy, vh, r, dmg, splash, stops, range}
    let bombs = []; // {x, y, dx, dy, left (m still to roll), fuse, splash, t}
    let blasts = []; // {x, y, h, r, t}
    let swing = null; // {kind, t, dur}
    const shield = { energy: 1, up: false, raise: 0, flash: 0, empty: 0 };

    // which target a point inside, if any (cylinders, a little margin)
    function targetAtPoint(x, y, h, margin) {
      let best = null;
      targets().forEach((t) => {
        const d = Math.hypot(t.x - x, t.y - y);
        if (d < t.r + margin && h > t.h0 - margin && h < t.h1 + margin && (!best || d < best.d)) best = { t, d };
      });
      return best && best.t;
    }

    // -- arrows ---------------------------------------------------------------------------
    // From the camera along the aim, then a parabola.
    function fireArrow(o = {}) {
      const c = ar.cameraWorld();
      const a = ar.aimVector();
      const sp = o.speed || 3.5;
      arrows.push({ x: c.x + a.x * 0.05, y: c.y + a.y * 0.05, h: c.h - 0.03 + a.h * 0.05, vx: a.x * sp, vy: a.y * sp, vh: a.h * sp, dmg: o.dmg || 3, g: o.g ?? GRAVITY, stuck: -1, color: o.color || "#e8d8a8" });
      Lynx.sfx.play("twang");
    }
    function stepArrows(dt) {
      arrows.forEach((r) => {
        if (r.stuck >= 0) {
          r.stuck += dt;
          return;
        }
        const sp = Math.hypot(r.vx, r.vy, r.vh);
        const steps = Math.max(1, Math.ceil((sp * dt) / 0.03)); // (small steps: it can't skip a target)
        const h = dt / steps;
        for (let i = 0; i < steps && r.stuck < 0; i++) {
          r.vh -= r.g * h;
          r.x += r.vx * h;
          r.y += r.vy * h;
          r.h += r.vh * h;
          if (r.h <= 0) {
            r.h = 0;
            r.stuck = 0;
            break;
          }
          if (wallAt(r.x, r.y, r.h)) {
            r.stuck = 0;
            Lynx.sfx.play("knock");
            break;
          }
          const t = targetAtPoint(r.x, r.y, r.h, 0.02);
          if (t) {
            r.stuck = 1e9; // (gone)
            const l = Math.hypot(r.vx, r.vy) || 1;
            hit(t.obj, r.dmg, { kind: "arrow", dx: r.vx / l, dy: r.vy / l });
          }
        }
        const c = ar.cameraWorld();
        if (Math.hypot(r.x - c.x, r.y - c.y) > 8) r.stuck = 1e9;
      });
      arrows = arrows.filter((r) => r.stuck < 1.5);
    }

    // -- projectiles ----------------------------------------------------------------------
    // Straight from the camera along the aim. o: {speed, r, dmg, splash: {r, dmg}, stops, range}
    function fireProjectile(o) {
      const c = ar.cameraWorld();
      const a = ar.aimVector();
      const sp = o.speed || 2;
      shots.push({ x: c.x + a.x * 0.08, y: c.y + a.y * 0.08, h: c.h - 0.02 + a.h * 0.08, vx: a.x * sp, vy: a.y * sp, vh: a.h * sp,
        r: o.r || 0.03, dmg: o.dmg || 10, splash: o.splash || null, stops: o.stops || FIRE_STOPS, range: o.range || 8, went: 0, trail: [] });
    }
    function stepShots(dt) {
      shots.forEach((s) => {
        const sp = Math.hypot(s.vx, s.vy, s.vh);
        const steps = Math.max(1, Math.ceil((sp * dt) / 0.03));
        const h = dt / steps;
        s.trail.push({ x: s.x, y: s.y, h: s.h });
        if (s.trail.length > 6) s.trail.shift();
        for (let i = 0; i < steps && !s.dead; i++) {
          s.x += s.vx * h;
          s.y += s.vy * h;
          s.h += s.vh * h;
          s.went += sp * h;
          const t = targetAtPoint(s.x, s.y, s.h, s.r);
          if (t || s.h <= 0 || wallAt(s.x, s.y, s.h) || s.went > s.range) {
            s.dead = true;
            if (t) {
              const l = Math.hypot(s.vx, s.vy) || 1;
              hit(t.obj, dmgOf(s.dmg), { kind: "shot", dx: s.vx / l, dy: s.vy / l });
            }
            if (s.splash) explode(s.x, s.y, Math.max(0.02, s.h), s.splash, t && t.obj);
            else blasts.push({ x: s.x, y: s.y, h: Math.max(0.02, s.h), r: s.r * 3, t: 0, stops: s.stops, small: true });
          }
        }
      });
      shots = shots.filter((s) => !s.dead);
    }

    // -- bombs ----------------------------------------------------------------------------
    // o: {fuse (s), speed (m/s), maxM, splash: {r, dmg}}. A bomb already out
    // goes off instead: "detonated"; else "thrown".
    function bomb(o) {
      const out = bombs.find((b) => !b.dead);
      if (out) {
        out.fuse = 0;
        return "detonated";
      }
      const c = ar.cameraWorld();
      const a = ar.aimVector();
      const l = Math.hypot(a.x, a.y) || 1;
      const dx = a.x / l;
      const dy = a.y / l;
      const maxM = o.maxM || 2.5;
      // where the crosshair meets the floor (from the robot's middle)
      let dist = maxM;
      if (a.h < -0.02) dist = Math.max(0.25, Math.min(maxM, (c.h / -a.h) * l));
      const start = 0.1;
      bombs.push({ x: c.x + dx * start, y: c.y + dy * start, dx, dy, left: Math.max(0, dist - start), speed: o.speed || 0.6,
        fuse: o.fuse || 5, fuse0: o.fuse || 5, splash: o.splash || { r: 0.45, dmg: 10 }, t: 0, spin: 0 });
      Lynx.sfx.play("throw");
      return "thrown";
    }
    const hasBomb = () => bombs.some((b) => !b.dead);
    function stepBombs(dt) {
      bombs.forEach((b) => {
        b.t += dt;
        if (b.left > 0) {
          const step = Math.min(b.left, b.speed * dt);
          const nx = b.x + b.dx * step;
          const ny = b.y + b.dy * step;
          if (wallAt(nx, ny, BOMB_R)) b.left = 0; // (stops against a wall)
          else {
            b.x = nx;
            b.y = ny;
            b.left -= step;
            b.spin += step / BOMB_R;
          }
        }
        b.fuse -= dt;
        const tickEvery = b.fuse < 1.5 ? 0.15 : 0.5;
        if (Math.floor((b.fuse + dt) / tickEvery) !== Math.floor(b.fuse / tickEvery)) Lynx.sfx.play("tick");
        if (b.fuse <= 0 && !b.dead) {
          b.dead = true;
          explode(b.x, b.y, BOMB_R, b.splash);
        }
      });
      bombs = bombs.filter((b) => !b.dead);
    }

    // -- blasts ---------------------------------------------------------------------------
    // Everything within splash.r takes damage, less toward the edge -- unless
    // a wall is in between. `skip`: already hit directly.
    function explode(x, y, h, splash, skip) {
      blasts.push({ x, y, h, r: splash.r, t: 0, stops: splash.stops || FIRE_STOPS });
      Lynx.sfx.play(splash.sound || "explode");
      targets().forEach((t) => {
        if (t.obj === skip) return;
        const dxy = Math.max(0, Math.hypot(t.x - x, t.y - y) - t.r);
        const dh = h < t.h0 ? t.h0 - h : h > t.h1 ? h - t.h1 : 0;
        const d = Math.hypot(dxy, dh);
        if (d > splash.r || blocked(x, y, t.x, t.y)) return;
        const l = Math.hypot(t.x - x, t.y - y) || 1;
        hit(t.obj, splash.dmg * (1 - (0.6 * d) / splash.r), { kind: "blast", dx: (t.x - x) / l, dy: (t.y - y) / l });
      });
      const c = ar.cameraWorld();
      const dc = Math.hypot(c.x - x, c.y - y, Math.max(0, ar.feet() - h));
      if (opts.hurtPlayer && splash.self !== false && dc < splash.r && !blocked(x, y, c.x, c.y)) opts.hurtPlayer(1 - dc / splash.r);
    }

    // -- close combat ---------------------------------------------------------------------
    // Everything within range (from the robot's middle, to the target's edge)
    // and within cone (rad) of where the camera looks. o: {range, cone, dmg, kind}
    function melee(o) {
      const c = ar.cameraWorld();
      const range = o.range || 0.45;
      const cone = o.cone || 0.6;
      let n = 0;
      targets().forEach((t) => {
        const d = Math.hypot(t.x - c.x, t.y - c.y);
        if (d - t.r > range) return;
        if (Math.abs(wrap(Math.atan2(t.y - c.y, t.x - c.x) - ar.camTheta)) > cone && d > t.r) return;
        if (blocked(c.x, c.y, t.x, t.y)) return;
        const l = d || 1;
        hit(t.obj, dmgOf(o.dmg), { kind: "melee", dx: (t.x - c.x) / l, dy: (t.y - c.y) / l });
        n++;
      });
      swing = { kind: o.kind || "sword", t: 0, dur: o.swingS || 0.22 };
      Lynx.sfx.play(n ? o.hitSound || "punch" : o.sound || "swing");
      return n;
    }

    // -- shield ---------------------------------------------------------------------------
    function updateShield(dt, held) {
      shield.flash = Math.max(0, shield.flash - dt);
      shield.empty = Math.max(0, shield.empty - dt);
      const want = held && shield.energy > 0.02 && shield.empty === 0;
      if (want && !shield.up) Lynx.sfx.play("shieldUp");
      shield.up = want;
      shield.raise += ((want ? 1 : 0) - shield.raise) * Math.min(1, dt * 14);
      if (shield.up) {
        shield.energy = Math.max(0, shield.energy - SHIELD_DRAIN * dt);
        if (shield.energy <= 0.02) shield.empty = 1.5; // (empty: can't come up again at once)
      } else shield.energy = Math.min(1, shield.energy + SHIELD_RECHARGE * dt);
    }
    // Does the shield stop something coming from (x, y)? (Costs energy if so.)
    function blocks(x, y) {
      if (!shield.up) return false;
      const c = ar.cameraWorld();
      if (Math.abs(wrap(Math.atan2(y - c.y, x - c.x) - ar.camTheta)) > SHIELD_ARC) return false;
      shield.energy = Math.max(0, shield.energy - SHIELD_BLOCK);
      shield.flash = 0.25;
      Lynx.sfx.play("clang");
      return true;
    }

    function update(dt) {
      stepArrows(dt);
      stepShots(dt);
      stepBombs(dt);
      blasts.forEach((b) => (b.t += dt));
      blasts = blasts.filter((b) => b.t < (b.small ? 0.25 : 0.6));
      if (swing) {
        swing.t += dt;
        if (swing.t > swing.dur) swing = null;
      }
    }
    function clear() {
      arrows = [];
      shots = [];
      bombs = [];
      blasts = [];
      swing = null;
    }

    // -- drawing: the room ------------------------------------------------------------------
    // (queued in depth order with the game's sprites -- call before ar.flush())
    function drawWorld() {
      arrows.forEach((r) => {
        const sp = Math.hypot(r.vx, r.vy, r.vh) || 1;
        const a = ar.project(r.x, r.y, r.h);
        const b = ar.project(r.x - (r.vx / sp) * ARROW_LEN, r.y - (r.vy / sp) * ARROW_LEN, r.h - (r.vh / sp) * ARROW_LEN);
        if (!a || !b) return;
        ar.queue(a.depth, () => {
          const c = ar.ctx;
          c.save();
          c.globalAlpha = r.stuck >= 0 ? Math.max(0, 1 - r.stuck / 1.5) : 1;
          c.lineCap = "round";
          c.strokeStyle = r.color;
          c.lineWidth = Math.max(1.5, 0.006 * a.ppm);
          c.beginPath();
          c.moveTo(a.x, a.y);
          c.lineTo(b.x, b.y);
          c.stroke();
          c.strokeStyle = "#e84040"; // fletching
          c.lineWidth = Math.max(2, 0.012 * a.ppm);
          c.beginPath();
          c.moveTo(b.x, b.y);
          c.lineTo(b.x + (a.x - b.x) * 0.2, b.y + (a.y - b.y) * 0.2);
          c.stroke();
          c.fillStyle = "#c0c0c8"; // head
          c.beginPath();
          c.arc(a.x, a.y, Math.max(1.5, 0.007 * a.ppm), 0, 2 * Math.PI);
          c.fill();
          c.restore();
        });
      });
      shots.forEach((s) => {
        const p = ar.project(s.x, s.y, s.h);
        if (!p) return;
        ar.queue(p.depth, () => {
          ar.floorCircle(s.x, s.y, s.r * 0.8, "rgba(0,0,0,0.25)");
          s.trail.forEach((q, i) => {
            const tp = ar.project(q.x, q.y, q.h);
            if (tp) ar.glow(tp.x, tp.y, Math.max(2, s.r * pr(tp) * (0.4 + i * 0.1)), s.stops, 0.25 + i * 0.08);
          });
          ar.glow(p.x, p.y, Math.max(3, s.r * 1.6 * p.ppm), s.stops);
        });
      });
      bombs.forEach((b) => {
        const p = ar.project(b.x, b.y, BOMB_R);
        if (!p) return;
        const blink = b.fuse < 1.5 ? Math.floor(b.fuse * 8) % 2 === 0 : Math.floor(b.fuse * 2) % 2 === 0;
        ar.queue(p.depth, () => {
          const c = ar.ctx;
          // the blast's reach on the floor
          ar.floorCircle(b.x, b.y, b.splash.r, blink ? "rgba(255,40,20,0.10)" : "rgba(255,40,20,0.04)", "rgba(255,60,30,0.55)");
          ar.floorCircle(b.x, b.y, BOMB_R * 1.2, "rgba(0,0,0,0.35)");
          const rr = Math.max(3, BOMB_R * p.ppm);
          c.save();
          c.fillStyle = "#1a1a1e";
          c.beginPath();
          c.arc(p.x, p.y, rr, 0, 2 * Math.PI);
          c.fill();
          c.fillStyle = "rgba(255,255,255,0.35)";
          c.beginPath();
          c.arc(p.x - rr * 0.35, p.y - rr * 0.35, rr * 0.3, 0, 2 * Math.PI);
          c.fill();
          c.strokeStyle = "#8a6a40"; // fuse
          c.lineWidth = Math.max(1, rr * 0.18);
          c.beginPath();
          c.moveTo(p.x + rr * 0.5, p.y - rr * 0.8);
          c.quadraticCurveTo(p.x + rr * 0.9, p.y - rr * 1.6, p.x + rr * 0.4, p.y - rr * 1.9);
          c.stroke();
          c.restore();
          ar.glow(p.x + rr * 0.4, p.y - rr * 1.9, rr * (blink ? 1.1 : 0.7), FIRE_STOPS);
          ar.text(b.fuse.toFixed(1), p.x, p.y - rr * 2.6, { size: 12, align: "center", color: b.fuse < 1.5 ? "#ff6040" : "#ffe080" });
        });
      });
      blasts.forEach((b) => {
        const p = ar.project(b.x, b.y, b.h);
        if (!p) return;
        const dur = b.small ? 0.25 : 0.6;
        const k = b.t / dur;
        ar.queue(p.depth, () => {
          if (!b.small) ar.floorCircle(b.x, b.y, b.r * Math.min(1, k * 2.5), `rgba(255,140,40,${(0.35 * (1 - k)).toFixed(3)})`, `rgba(255,200,80,${(0.8 * (1 - k)).toFixed(3)})`);
          ar.glow(p.x, p.y, Math.max(4, b.r * (0.4 + k * 1.2) * p.ppm), b.stops, 1 - k);
        });
      });
    }
    const pr = (p) => p.ppm;

    // -- drawing: what you hold -------------------------------------------------------------
    // kind: "bow" | "sword" | "brush" | "bomb" ; o: {ready (0..1: reloaded), color}
    function drawHand(kind, o = {}) {
      const v = ar.view;
      const c = ar.ctx;
      const s = Math.min(v.w * 0.12, 110);
      const bx = v.cx + v.w * 0.16;
      const by = v.y + v.h - s * 0.9;
      const ready = o.ready ?? 1;
      c.save();
      c.lineCap = "round";
      if (kind === "bow") {
        const pull = ready >= 1 ? 1 : 0;
        c.strokeStyle = "#6a4020";
        c.lineWidth = 6;
        c.beginPath();
        c.moveTo(bx, by - s);
        c.quadraticCurveTo(bx - s * 0.7, by, bx, by + s);
        c.stroke();
        c.strokeStyle = "#f0e8d0";
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(bx, by - s);
        c.lineTo(bx + s * 0.15 * pull, by);
        c.lineTo(bx, by + s);
        c.stroke();
        if (pull) {
          c.strokeStyle = "#e8d8a8";
          c.lineWidth = 3;
          c.beginPath();
          c.moveTo(bx + s * 0.15, by);
          c.lineTo(bx - s * 0.9, by - s * 0.25);
          c.stroke();
        }
      } else if (kind === "sword" || kind === "brush") {
        // resting up and to the right; a swing sweeps it across to the lower left
        const k = swing ? Math.min(1, swing.t / swing.dur) : 0;
        if (swing && k < 0.8) {
          c.strokeStyle = `rgba(255,255,255,${(0.5 * (1 - k)).toFixed(2)})`;
          c.lineWidth = s * 0.12;
          c.beginPath();
          c.arc(v.cx + s * 0.6, by + s * 0.6, s * 1.3, Math.PI * 1.15, Math.PI * (1.15 + 0.6 * k + 0.1));
          c.stroke();
        }
        const ang = -0.5 - Math.sin(k * Math.PI) * 1.6;
        c.translate(bx + s * 0.2 - Math.sin(k * Math.PI) * s * 0.9, by + s * 0.6);
        c.rotate(ang);
        if (kind === "sword") {
          c.fillStyle = "#5a3818"; // grip
          c.fillRect(-s * 0.06, 0, s * 0.12, s * 0.35);
          c.fillStyle = "#c8a040"; // crossguard
          c.fillRect(-s * 0.22, -s * 0.05, s * 0.44, s * 0.08);
          c.fillStyle = o.color || "#d8dce4"; // blade
          c.beginPath();
          c.moveTo(-s * 0.07, -s * 0.05);
          c.lineTo(s * 0.07, -s * 0.05);
          c.lineTo(s * 0.05, -s * 1.15);
          c.lineTo(0, -s * 1.3);
          c.lineTo(-s * 0.05, -s * 1.15);
          c.closePath();
          c.fill();
          c.strokeStyle = "rgba(255,255,255,0.7)";
          c.lineWidth = 1.5;
          c.beginPath();
          c.moveTo(0, -s * 0.1);
          c.lineTo(0, -s * 1.2);
          c.stroke();
        } else {
          c.fillStyle = "#f4f4f0"; // handle
          c.fillRect(-s * 0.04, -s * 0.8, s * 0.08, s * 1.15);
          c.fillStyle = o.color || "#3a8ad8"; // bristles
          c.beginPath();
          c.ellipse(0, -s * 0.95, s * 0.17, s * 0.24, 0, 0, 2 * Math.PI);
          c.fill();
          c.strokeStyle = "rgba(255,255,255,0.45)";
          c.lineWidth = 1;
          for (let i = -3; i <= 3; i++) {
            c.beginPath();
            c.moveTo(i * s * 0.04, -s * 0.75);
            c.lineTo(i * s * 0.05, -s * 1.15);
            c.stroke();
          }
        }
      } else if (kind === "bomb") {
        const out = hasBomb();
        const rr = s * 0.32;
        const y = by + (out ? s * 0.25 : 0) + (1 - Math.min(1, ready)) * s * 0.6;
        if (out) {
          // a detonator: press fire to set it off
          c.fillStyle = "#3a3a40";
          c.fillRect(bx - s * 0.25, y - s * 0.1, s * 0.5, s * 0.6);
          c.fillStyle = "#e02020";
          c.beginPath();
          c.arc(bx, y - s * 0.12, s * 0.14, 0, 2 * Math.PI);
          c.fill();
          ar.text("FIRE: BOOM", bx, y - s * 0.4, { size: 13, align: "center", color: "#ff8060" });
        } else {
          c.fillStyle = "#1a1a1e";
          c.beginPath();
          c.arc(bx, y, rr, 0, 2 * Math.PI);
          c.fill();
          c.fillStyle = "rgba(255,255,255,0.3)";
          c.beginPath();
          c.arc(bx - rr * 0.35, y - rr * 0.35, rr * 0.3, 0, 2 * Math.PI);
          c.fill();
          c.strokeStyle = "#8a6a40";
          c.lineWidth = 3;
          c.beginPath();
          c.moveTo(bx + rr * 0.5, y - rr * 0.8);
          c.quadraticCurveTo(bx + rr * 0.9, y - rr * 1.5, bx + rr * 0.3, y - rr * 1.8);
          c.stroke();
        }
      }
      c.restore();
    }

    // The shield, lower left while up; its energy bar always (style: "wood" | "lid" | "steel").
    function drawShield(style = "wood") {
      const v = ar.view;
      const c = ar.ctx;
      const s = Math.min(v.w * 0.16, 150);
      // energy, above the hearts / score
      const bw = Math.min(v.w * 0.18, 140);
      const bx = v.x + 14;
      const by = v.y + v.h - 78;
      c.save();
      c.fillStyle = "rgba(0,0,0,0.5)";
      c.fillRect(bx, by, bw, 7);
      c.fillStyle = shield.empty > 0 ? "#a04040" : shield.flash > 0 ? "#ffffff" : "#60c0ff";
      c.fillRect(bx, by, bw * shield.energy, 7);
      c.restore();
      ar.text("\u{1F6E1}", bx + bw + 6, by + 8, { size: 13, align: "left" });
      if (shield.raise < 0.03) return;
      const cx = v.cx - v.w * 0.2;
      const cy = v.y + v.h - s * 0.55 + (1 - shield.raise) * s * 1.2;
      c.save();
      c.globalAlpha = 0.82;
      if (style === "lid") {
        c.fillStyle = "#f4f4f0";
        c.beginPath();
        c.ellipse(cx, cy, s * 0.5, s * 0.62, 0, 0, 2 * Math.PI);
        c.fill();
        c.strokeStyle = "#b8b8b0";
        c.lineWidth = s * 0.06;
        c.stroke();
        c.fillStyle = "#c8c8c0"; // hinge
        c.fillRect(cx - s * 0.25, cy + s * 0.55, s * 0.5, s * 0.08);
      } else {
        const g = c.createRadialGradient(cx - s * 0.15, cy - s * 0.2, s * 0.05, cx, cy, s * 0.6);
        g.addColorStop(0, style === "steel" ? "#e0e4ec" : "#d8a060");
        g.addColorStop(1, style === "steel" ? "#7a8090" : "#8a5420");
        c.fillStyle = g;
        c.beginPath();
        c.moveTo(cx - s * 0.48, cy - s * 0.55);
        c.lineTo(cx + s * 0.48, cy - s * 0.55);
        c.lineTo(cx + s * 0.45, cy + s * 0.1);
        c.quadraticCurveTo(cx + s * 0.3, cy + s * 0.55, cx, cy + s * 0.7);
        c.quadraticCurveTo(cx - s * 0.3, cy + s * 0.55, cx - s * 0.45, cy + s * 0.1);
        c.closePath();
        c.fill();
        c.strokeStyle = "#c8a040";
        c.lineWidth = s * 0.05;
        c.stroke();
        c.fillStyle = "#c8a040"; // boss
        c.beginPath();
        c.arc(cx, cy - s * 0.05, s * 0.08, 0, 2 * Math.PI);
        c.fill();
      }
      if (shield.flash > 0) {
        c.globalAlpha = shield.flash * 3;
        c.fillStyle = "#ffffff";
        c.beginPath();
        c.ellipse(cx, cy, s * 0.55, s * 0.65, 0, 0, 2 * Math.PI);
        c.fill();
      }
      c.restore();
    }

    // radar blips for what's out there (bombs: red; rockets etc.: orange)
    const blips = () => [...bombs.map((b) => ({ x: b.x, y: b.y, color: "#ff3020", r: 3 })), ...shots.map((s) => ({ x: s.x, y: s.y, color: "#ffb040", r: 2 }))];

    return {
      fireArrow, fireProjectile, bomb, hasBomb, melee, explode, update, clear, drawWorld, drawHand, drawShield, updateShield, blocks, blips,
      shield, swinging: () => !!swing,
      snapshot: () => ({ arrows: arrows.length, shots: shots.length, bombs: bombs.map((b) => ({ x: +b.x.toFixed(2), y: +b.y.toFixed(2), fuse: +b.fuse.toFixed(1) })), shield: +shield.energy.toFixed(2) }),
    };
  };
})(window.Lynx);
