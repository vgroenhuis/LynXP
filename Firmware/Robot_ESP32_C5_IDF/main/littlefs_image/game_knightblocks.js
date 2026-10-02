// Knight on Blocks -- the Pocket Knight (game_knight.js) on real blocks:
// 40 mm cubes with AprilTags, found by tagblocks.js. The knight walks
// around them, jumps or vaults onto them, catches the edge of a stack and
// climbs it -- and walks behind them: a real block nearer than the knight
// hides it (its silhouette is cut out of the overlay, so the video shows
// through).
//
// The robot follows the knight as in Pocket Knight (a leash at ~15 cm, the
// camera button circles it round behind, the look controls orbit it), but
// keeps its body clear of every block it knows: it only drives to a spot
// where its whole footprint fits -- from the drive wheels back to the
// caster, oriented the way it will arrive -- and that it can reach, turning
// and driving, without touching one; else via a detour point; with none, it
// holds still (or eases off a block it's touching).
// It can only avoid blocks it has seen: the game starts straight away with
// the ones in view (looking around first, turning on the spot, is a
// setting), and Rescan forgets them all and looks again.
// It moves slowly and smoothly -- the spot it drives to glides along at a
// few cm/s, the camera eases round -- so the video and the overlay (which
// lags it a little) stay lined up, and estimates jittering a few mm don't
// shake the picture.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const SCAN_RATE = 0.4; // rad/s turning while looking around
  const SCAN_TILT_DEG = -24; // looking down at the floor around the robot
  const ROBOT_MARGIN_M = 0.01;
  const PLAN_EVERY_MS = 150;
  const ROBOT_GLIDE_MPS = 0.05; // how fast the spot the robot drives to may move
  const PLAN_DEADBAND_M = 0.015; // a new plan this close to the old one isn't worth moving for
  const AIM_EASE = 2.5; // 1/s: the camera eases toward the knight (time constant 0.4 s)
  const AIM_MAX_RAD_S = 0.5; // and pans no faster than this (the tag finder skips blurred pictures above 0.6)

  Lynx.games.knightblocks = (ar, cfg) => {
    const K = Lynx.knightKit;
    const { clamp, lerp, ease, wrap } = K.util;
    // The knight at its size here (3 cm by default; the Pocket Knight is 7):
    // lengths, speeds and gravity scale with it, time doesn't -- a stride, a
    // climb take as long as a person's -- so it walks like a person its size.
    // Its jump is a bit heroic (60% of its height), enough to vault onto a
    // block as tall as itself; a stack goes a block at a time.
    const S = clamp((+cfg.knightCm || 3) / 100, 0.02, 0.07) / K.C.BODY_H;
    const C = { ...K.C };
    ["BODY_H", "BODY_R", "STEP_UP", "AIR_STEP_UP", "GRAVITY", "WALK_V", "RUN_V", "ACCEL", "DECEL", "AIR_ACCEL", "MANTLE_MIN", "GRAB_MIN", "GRAB_MAX", "HANG_DROP", "SHIMMY_V"].forEach((k) => (C[k] = K.C[k] * S));
    C.JUMP_V = Math.sqrt(2 * C.GRAVITY * 0.6 * C.BODY_H);
    // In-game choices remembered in this browser (the settings give the defaults).
    const remembered = (key, def) => {
      try {
        const v = localStorage.getItem(key);
        return v === null ? def : JSON.parse(v);
      } catch (e) {
        return def; // (storage blocked)
      }
    };
    const remember = (key, v) => {
      try {
        localStorage.setItem(key, JSON.stringify(v));
      } catch (e) {
        // (not remembered)
      }
    };
    // Zoom: how far the robot keeps from the knight (+ / - keys, RB / LB, the buttons).
    const ZOOM_MIN = 0.1;
    const ZOOM_MAX = 0.4;
    const ZOOM_STEP = 0.025;
    let camDist = clamp(+remembered("knightblocksCamDist", (+cfg.camDistCm || 15) / 100) || 0.15, ZOOM_MIN, ZOOM_MAX);
    // the robot's footprint (see bodyMargin): half its width, and how far it reaches behind the drive wheels' axle
    const robotHalf = clamp((+cfg.robotRadiusCm || 9.5) / 100, 0.04, 0.2) + ROBOT_MARGIN_M;
    const robotRear = Math.max(robotHalf, clamp((+cfg.robotRearCm || 18) / 100, 0.04, 0.4) + ROBOT_MARGIN_M);
    // the cyan block outlines and the green tag outlines: switches in the game
    let showBlocks = Boolean(remembered("knightblocksShowBlocks", cfg.showBlocks !== false));
    let showTags = Boolean(remembered("knightblocksShowTags", cfg.showTags !== false)); // (older versions stored 0 / 1)
    const doScan = cfg.scan === true;
    const w = Lynx.world3d(ar, { textures: false });
    const family = cfg.tagFamily === "tag36h11" ? "tag36h11" : "tag16h5";
    const tb = Lynx.tagBlocks(ar, { family, tagMm: +cfg.tagMm || 30, blockMm: +cfg.blockMm || 40 });
    tb.start();

    let state = "title"; // title | scan | playing
    let stateTime = 0;
    let time = 0;
    let note = null;
    let solids = []; // the blocks, in the floor frame: {id, cf, cr, yaw, half, h0, h1, inferred}
    let lastPos = new Map(); // block id -> [cf, cr, h1] last frame (to carry the knight)
    const hero = {
      f: 0, r: 0, z: 0, vf: 0, vr: 0, vz: 0, yaw: 0, onGround: true, standOn: null, mode: "move", coyote: 0, jumpBuf: 0, fallFrom: 0,
      hang: null, climb: null, attack: null, attackQueued: false, landT: 0, phase: 0, speed: 0, grabCool: 0, towardT: 0,
    };
    const cam = { b: Math.PI, behind: false, orbitAt: -1e9, tiltOff: 0, aimYaw: null, aimTilt: 0, aimPt: null, lastGoto: null, lastGotoMs: -1e9, lastAimMs: -1e9, planMs: -1e9, target: null, cmd: null, why: "" };
    const scan = { yaw0: 0 };

    const say = (text, color = "#ffe080") => (note = { text, color, t: 0 });
    const sfx = (name) => Lynx.sfx.play(name);

    // -- the blocks in the floor frame ---------------------------------------------------------
    function refreshSolids() {
      const a = w.anchor();
      const prev = new Map(solids.map((s) => [s.id, s]));
      solids = tb.blocks().map((b) => {
        const l = w.toLocal(b.x, b.y);
        return { id: b.id, cf: l.f, cr: l.r, yaw: a.th - b.yaw, half: b.half, h0: b.h0, h1: b.h1, inferred: b.inferred, n: b.n };
      });
      // a block's estimate shifting a little under the knight carries it along
      if (hero.onGround && hero.standOn !== null && hero.mode === "move") {
        const now = solids.find((s) => s.id === hero.standOn);
        const before = prev.get(hero.standOn);
        if (now && before) {
          const df = now.cf - before.cf;
          const dr = now.cr - before.cr;
          if (Math.hypot(df, dr) < 0.02) {
            hero.f += df;
            hero.r += dr;
          }
        }
      }
    }
    const rot = (b) => [Math.cos(b.yaw), Math.sin(b.yaw)];
    // floor point -> block frame (u along its yaw, v across), and back
    function toB(b, f, r) {
      const [c, s] = rot(b);
      const df = f - b.cf;
      const dr = r - b.cr;
      return [df * c + dr * s, -df * s + dr * c];
    }
    function fromB(b, u, v) {
      const [c, s] = rot(b);
      return [b.cf + u * c - v * s, b.cr + u * s + v * c];
    }
    const dirFromB = (b, du, dv) => {
      const [c, s] = rot(b);
      return [du * c - dv * s, du * s + dv * c];
    };
    const inFoot = (b, f, r, m = 0) => {
      const [u, v] = toB(b, f, r);
      return Math.abs(u) <= b.half + m && Math.abs(v) <= b.half + m;
    };
    // distance from a floor point to a block's footprint (0 inside)
    const footDist = (b, f, r) => {
      const [u, v] = toB(b, f, r);
      return Math.hypot(Math.max(0, Math.abs(u) - b.half), Math.max(0, Math.abs(v) - b.half));
    };

    function groundAt(f, r, z, up = C.STEP_UP) {
      let best = { h: 0, ref: null };
      for (const b of solids) {
        if (b.h1 > z + up + 1e-6 || !inFoot(b, f, r, C.BODY_R * 0.6)) continue;
        if (b.h1 > best.h) best = { h: b.h1, ref: b.id };
      }
      return best;
    }

    // -- the knight -------------------------------------------------------------------------------------
    function stickInput() {
      const d = Lynx.control.driveInput();
      const m = clamp(Math.hypot(d.j1, d.j2) / 0.8, 0, 1);
      if (m < 0.06) return { df: 0, dr: 0, speed: 0, m: 0 };
      const cy = w.anchor().th - ar.camTheta;
      const n = Math.hypot(d.j1, d.j2);
      const df = (d.j2 * Math.cos(cy) - d.j1 * Math.sin(cy)) / n;
      const dr = (d.j2 * Math.sin(cy) + d.j1 * Math.cos(cy)) / n;
      const speed = m <= 0.55 ? (C.WALK_V * m) / 0.55 : C.WALK_V + ((C.RUN_V - C.WALK_V) * (m - 0.55)) / 0.45;
      return { df, dr, speed, m };
    }
    function placeHero(f, r, yaw) {
      Object.assign(hero, { f, r, z: groundAt(f, r, 1).h, yaw, vf: 0, vr: 0, vz: 0, onGround: true, standOn: null, mode: "move", hang: null, climb: null, attack: null, jumpBuf: 0, coyote: 0, landT: 0, grabCool: 0 });
    }

    function stepHero(dt) {
      const h = hero;
      h.landT = Math.max(0, h.landT - dt);
      h.grabCool = Math.max(0, h.grabCool - dt);
      h.jumpBuf -= dt;
      h.coyote -= dt;
      if (h.mode === "hang") return stepHang(dt);
      if (h.mode === "climb") return stepClimb(dt);
      const inp = stickInput();
      let tvf = inp.df * inp.speed;
      let tvr = inp.dr * inp.speed;
      if (h.attack && h.onGround) {
        tvf *= 0.25;
        tvr *= 0.25;
      }
      const acc = h.onGround ? (inp.speed > 0.001 ? C.ACCEL : C.DECEL) : C.AIR_ACCEL;
      const dvf = tvf - h.vf;
      const dvr = tvr - h.vr;
      const dv = Math.hypot(dvf, dvr);
      if (dv > acc * dt) {
        h.vf += (dvf / dv) * acc * dt;
        h.vr += (dvr / dv) * acc * dt;
      } else {
        h.vf = tvf;
        h.vr = tvr;
      }
      if (inp.speed > 0.004 * S && !(h.attack && h.attack.u > 0.15)) {
        const target = Math.atan2(inp.dr, inp.df);
        h.yaw = wrap(h.yaw + clamp(wrap(target - h.yaw), -C.TURN_RATE * dt, C.TURN_RATE * dt));
      }
      if (h.jumpBuf > 0 && (h.onGround || h.coyote > 0)) {
        h.vz = C.JUMP_V;
        h.onGround = false;
        h.standOn = null;
        h.coyote = 0;
        h.jumpBuf = 0;
        h.fallFrom = h.z;
        h.attack = null;
        sfx("jump");
      }
      if (!h.onGround) {
        h.vz -= C.GRAVITY * dt;
        h.z += h.vz * dt;
      }
      h.f += h.vf * dt;
      h.r += h.vr * dt;
      const up = h.onGround ? C.STEP_UP : C.AIR_STEP_UP;
      collide(up);
      const g = groundAt(h.f, h.r, h.z, up);
      if (h.onGround) {
        if (g.h >= h.z - 0.006 * S) {
          h.z = g.h;
          h.standOn = g.ref;
        } else {
          h.onGround = false;
          h.standOn = null;
          h.coyote = C.COYOTE_S;
          h.vz = 0;
          h.fallFrom = h.z;
        }
      } else {
        h.fallFrom = Math.max(h.fallFrom, h.z);
        if (h.vz > 0) {
          for (const b of solids) {
            if (b.h0 > h.z + 0.01 * S && b.h0 < h.z + C.BODY_H && inFoot(b, h.f, h.r, C.BODY_R * 0.5)) {
              h.z = b.h0 - C.BODY_H;
              h.vz = 0;
            }
          }
        }
        if (h.vz <= 0 && h.z <= g.h) {
          const drop = h.fallFrom - g.h;
          h.z = g.h;
          h.vz = 0;
          h.onGround = true;
          h.standOn = g.ref;
          h.landT = clamp((drop * 4) / S, 0.05, 0.18);
          if (drop > 0.02 * S) sfx("knock");
          if (h.jumpBuf > 0) {
            h.vz = C.JUMP_V;
            h.onGround = false;
            h.standOn = null;
            h.jumpBuf = 0;
            h.fallFrom = h.z;
            sfx("jump");
          }
        } else if (h.vz < 0.07 * S && h.grabCool <= 0 && !h.attack) tryGrab();
      }
      if (h.z < 0) h.z = 0; // (the floor is everywhere)
      if (h.attack) {
        h.attack.u += dt / C.SWINGS[h.attack.n];
        if (h.attack.u >= 1) {
          if (h.attackQueued && h.attack.n < 3) startSwing(h.attack.n + 1);
          else h.attack = null;
        }
      }
    }

    function collide(up) {
      const h = hero;
      for (const b of solids) {
        if (b.h1 <= h.z + up || b.h0 >= h.z + C.BODY_H - 0.004 * S) continue;
        const [u, v] = toB(b, h.f, h.r);
        const e = b.half + C.BODY_R;
        if (Math.abs(u) >= e || Math.abs(v) >= e) continue;
        const pen = [[e - u, 1, 0], [e + u, -1, 0], [e - v, 0, 1], [e + v, 0, -1]];
        pen.sort((a, c) => a[0] - c[0]);
        const [d, nu, nv] = pen[0];
        const [f, r] = fromB(b, u + nu * d, v + nv * d);
        h.f = f;
        h.r = r;
        const [nf, nr] = dirFromB(b, nu, nv);
        const vn = h.vf * nf + h.vr * nr;
        if (vn < 0) {
          h.vf -= vn * nf;
          h.vr -= vn * nr;
        }
      }
    }

    // -- ledges ----------------------------------------------------------------------------------
    function tryGrab() {
      const h = hero;
      const fx = Math.cos(h.yaw);
      const fy = Math.sin(h.yaw);
      const pf = h.f + fx * (C.BODY_R + 0.005 * S);
      const pr = h.r + fy * (C.BODY_R + 0.005 * S);
      for (const b of solids) {
        if (!inFoot(b, pf, pr)) continue;
        const rise = b.h1 - h.z;
        if (rise < C.MANTLE_MIN || rise > C.GRAB_MAX) continue;
        if (solids.some((o) => o !== b && o.h0 < b.h1 + C.BODY_H && o.h1 > b.h1 + 0.002 * S && inFoot(o, pf, pr, 0.004 * S))) continue; // no room on top
        const [u, v] = toB(b, h.f, h.r);
        const [c, s] = rot(b);
        const lu = fx * c + fy * s; // facing, in the block's frame
        const lv = -fx * s + fy * c;
        const faces = [];
        if (u >= b.half) faces.push([1, 0]);
        if (u <= -b.half) faces.push([-1, 0]);
        if (v >= b.half) faces.push([0, 1]);
        if (v <= -b.half) faces.push([0, -1]);
        if (!faces.length) continue;
        faces.sort((a, d) => a[0] * lu + a[1] * lv - (d[0] * lu + d[1] * lv));
        const [nu, nv] = faces[0];
        if (nu * lu + nv * lv > -0.4) continue;
        const out = b.half + C.BODY_R + 0.0008 * S;
        const along = clamp(nu ? v : u, -b.half + 0.004 * S, b.half - 0.004 * S);
        const [f, r] = nu ? fromB(b, nu * out, along) : fromB(b, along, nv * out);
        h.f = f;
        h.r = r;
        const [nf, nr] = dirFromB(b, nu, nv);
        h.yaw = Math.atan2(-nr, -nf);
        h.attack = null;
        if (rise < C.GRAB_MIN) {
          startClimb(b, nu, nv, rise);
          return;
        }
        h.mode = "hang";
        h.hang = { id: b.id, nu, nv, along, t: 0 };
        h.z = b.h1 - C.HANG_DROP;
        h.vf = h.vr = h.vz = 0;
        h.towardT = 0;
        sfx("click");
        return;
      }
    }
    function stepHang(dt) {
      const h = hero;
      const g = h.hang;
      g.t += dt;
      const b = solids.find((s) => s.id === g.id);
      if (!b) {
        dropHang(0);
        return;
      }
      const inp = stickInput();
      const [nf, nr] = dirFromB(b, g.nu, g.nv);
      const toward = -(inp.df * nf + inp.dr * nr) * inp.m;
      const [tf, tr] = dirFromB(b, -g.nv, g.nu); // along the edge
      const side = (inp.df * tf + inp.dr * tr) * inp.m;
      h.towardT = toward > 0.5 ? h.towardT + dt : 0;
      if ((h.jumpBuf > 0 || h.towardT > 0.18) && g.t > 0.2) {
        h.jumpBuf = 0;
        startClimb(b, g.nu, g.nv, C.HANG_DROP);
        return;
      }
      if (toward < -0.5 && g.t > 0.2) {
        dropHang(0.02 * S);
        return;
      }
      if (Math.abs(side) > 0.3) {
        // the edge's coordinate runs along (-nv, nu) in the block's frame
        const sgn = g.nu ? g.nu : -g.nv;
        g.along = clamp(g.along + Math.sign(side) * sgn * C.SHIMMY_V * dt, -b.half + 0.004 * S, b.half - 0.004 * S);
        h.phase += dt * 6;
      }
      // follow the block (its estimate can still shift)
      const out = b.half + C.BODY_R + 0.0008 * S;
      const [f, r] = g.nu ? fromB(b, g.nu * out, g.along) : fromB(b, g.along, g.nv * out);
      h.f = f;
      h.r = r;
      h.z = b.h1 - C.HANG_DROP;
      h.yaw = Math.atan2(-nr, -nf);
    }
    function dropHang(push) {
      const h = hero;
      const b = solids.find((s) => s.id === h.hang.id);
      const [nf, nr] = b ? dirFromB(b, h.hang.nu, h.hang.nv) : [0, 0];
      h.mode = "move";
      h.onGround = false;
      h.vz = 0;
      h.vf = nf * push;
      h.vr = nr * push;
      h.fallFrom = h.z;
      h.hang = null;
      h.grabCool = 0.35;
    }
    function startClimb(b, nu, nv, rise) {
      const h = hero;
      const k = clamp(rise / C.HANG_DROP, 0, 1);
      const into = C.BODY_R + 0.0008 * S + C.BODY_R + 0.006 * S;
      const [nf, nr] = dirFromB(b, nu, nv);
      h.mode = "climb";
      h.vf = h.vr = h.vz = 0;
      h.climb = {
        t: 0, dur: C.CLIMB_S * (0.35 + 0.65 * k), a0: 0.5 * (1 - k), anim: 0.5 * (1 - k), id: b.id,
        from: { f: h.f, r: h.r, z: h.z }, to: { f: h.f - nf * into, r: h.r - nr * into, z: b.h1 },
      };
      sfx(k > 0.6 ? "jump" : "click");
    }
    function stepClimb(dt) {
      const h = hero;
      const c = h.climb;
      c.t += dt / c.dur;
      c.anim = c.a0 + (1 - c.a0) * Math.min(1, c.t);
      h.z = lerp(c.from.z, c.to.z, ease(c.t / 0.6));
      const over = ease((c.t - 0.4) / 0.6);
      h.f = lerp(c.from.f, c.to.f, over);
      h.r = lerp(c.from.r, c.to.r, over);
      if (c.t >= 1) {
        h.mode = "move";
        h.climb = null;
        h.hang = null;
        h.onGround = true;
        h.standOn = c.id;
        h.z = c.to.z;
        h.vf = h.vr = h.vz = 0;
      }
    }
    function startSwing(n) {
      hero.attack = { n, u: 0 };
      hero.attackQueued = false;
      sfx("swing");
    }

    // -- the robot ----------------------------------------------------------------------------------
    // Its footprint: from the drive wheels' axle (the odometry point) back to
    // the caster, robotRear behind it, and robotHalf to each side (and in
    // front of the axle) -- a capsule along the chassis heading. The chassis
    // heading is the robot's own (its pose messages): the page's smooth aim
    // gives the camera's heading instead.
    const chassis = { x: 0, y: 0, th: 0, at: -1e9 };
    let alive = true;
    Lynx.control.onMessage("pose", (m) => {
      if (alive && typeof m.theta === "number") Object.assign(chassis, { x: m.x, y: m.y, th: m.theta, at: performance.now() });
    });
    function chassisLocal() {
      const fresh = performance.now() - chassis.at < 1000;
      const x = fresh ? chassis.x : ar.pose.x;
      const y = fresh ? chassis.y : ar.pose.y;
      const th = fresh ? chassis.th : ar.pose.theta; // (no telemetry: the view's heading)
      const l = w.toLocal(x, y);
      return { f: l.f, r: l.r, th: wrap(w.anchor().th - th) };
    }
    const clearance = (f, r) => solids.reduce((m, b) => Math.min(m, footDist(b, f, r)), Infinity);
    // how far the footprint at (f, r) facing th (floor frame) stays from the blocks, beyond robotHalf
    function bodyMargin(f, r, th) {
      const c = Math.cos(th);
      const s = Math.sin(th);
      const len = Math.max(0, robotRear - robotHalf);
      const n = Math.max(1, Math.ceil(len / 0.02));
      let m = Infinity;
      for (let i = 0; i <= n; i++) {
        const d = (len * i) / n;
        m = Math.min(m, clearance(f - c * d, r - s * d) - robotHalf);
      }
      return m;
    }
    const bodyClear = (f, r, th) => bodyMargin(f, r, th) >= 0;
    // Driving from (f0, r0) facing th0 to (f1, r1): goto turns toward the
    // target -- or its back to it, reversing to one behind -- then drives
    // straight. Checks the body over the turn on the spot and all the way;
    // returns the heading it arrives with, or null if it would touch a block.
    function moveClear(f0, r0, th0, f1, r1) {
      const dist = Math.hypot(f1 - f0, r1 - r0);
      if (dist < 0.01) return bodyClear(f1, r1, th0) ? th0 : null;
      const dir = Math.atan2(r1 - r0, f1 - f0);
      const th1 = Math.cos(dir - th0) >= 0 ? dir : wrap(dir + Math.PI);
      const turn = wrap(th1 - th0);
      const nt = Math.ceil(Math.abs(turn) / 0.2);
      for (let i = 1; i <= nt; i++) if (!bodyClear(f0, r0, th0 + (turn * i) / nt)) return null;
      const n = Math.max(1, Math.ceil(dist / 0.02));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        if (!bodyClear(f0 + (f1 - f0) * t, r0 + (r1 - r0) * t, th1)) return null;
      }
      return th1;
    }
    // does a block stand between the camera and the knight?
    function hidden(c, p) {
      return solids.some((b) => {
        let t0 = 0;
        let t1 = 1;
        const [ua, va] = toB(b, c.f, c.r);
        const [ub, vb] = toB(b, p[0], p[1]);
        const A = [ua, va, c.h];
        const B = [ub, vb, p[2]];
        const lo = [-b.half, -b.half, b.h0];
        const hi = [b.half, b.half, b.h1];
        for (let i = 0; i < 3; i++) {
          const d = B[i] - A[i];
          if (Math.abs(d) < 1e-9) {
            if (A[i] < lo[i] || A[i] > hi[i]) return false;
            continue;
          }
          let ta = (lo[i] - A[i]) / d;
          let tc = (hi[i] - A[i]) / d;
          if (ta > tc) [ta, tc] = [tc, ta];
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tc);
          if (t0 > t1) return false;
        }
        return true;
      });
    }
    // Where the robot should go: a spot at ~camDist from the knight at bearing
    // `want` (or as near it as possible) where its whole footprint fits, and
    // that it can drive to (turn included) without touching a block -- else a
    // detour point first; holds still if there's none, and eases forward or
    // back if it's touching one already.
    function planRobot(want) {
      const h = hero;
      const ch = chassisLocal();
      if (!bodyClear(ch.f, ch.r, ch.th)) {
        // too close (a block just found, or the estimate moved): straight forward or back, whichever frees it most
        let best = null;
        for (const d of [0.03, -0.03, 0.06, -0.06, 0.1, -0.1]) {
          const f = ch.f + d * Math.cos(ch.th);
          const r = ch.r + d * Math.sin(ch.th);
          const m = bodyMargin(f, r, ch.th);
          if (!best || m > best.m + 1e-4) best = { f, r, m };
        }
        return { f: best.f, r: best.r, why: "backing off a block" };
      }
      const eye = [h.f, h.r, h.z + 0.04 * S];
      const camH = ar.cameraWorld().h;
      // viewpoints round the knight, best first
      const spots = [];
      for (const extra of [0, 0.04, 0.08, 0.13, -0.03]) {
        const dist = camDist + 0.8 * Math.max(0, h.z - 0.04 * S) + extra;
        for (let k = 0; k <= 48; k++) {
          const off = (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.13; // 0, +-7.5 deg, ... +-179 deg
          const b = want + off;
          const f = h.f + dist * Math.cos(b);
          const r = h.r + dist * Math.sin(b);
          if (clearance(f, r) < robotHalf) continue; // (the axle at least; the rest once the heading is known)
          let cost = Math.abs(off) + Math.abs(extra) * 4;
          if (hidden({ f, r, h: camH }, eye)) cost += 3.5; // (going all the way round beats losing sight of the knight)
          spots.push({ f, r, cost, why: off || extra ? "around the blocks" : "" });
        }
      }
      spots.sort((a, b) => a.cost - b.cost);
      // the best one it can drive straight to...
      const direct = spots.find((s) => moveClear(ch.f, ch.r, ch.th, s.f, s.r) !== null);
      if (direct) return direct;
      // ...or a detour: a point from which one is in a straight line
      let best = null;
      for (const s of spots.slice(0, 8)) {
        for (const d of [0.08, 0.15, 0.22]) {
          for (let k = 0; k < 12; k++) {
            const a = (k / 12) * 2 * Math.PI;
            const f = ch.f + d * Math.cos(a);
            const r = ch.r + d * Math.sin(a);
            const cost = s.cost + 2 * (d + Math.hypot(s.f - f, s.r - r));
            if (best && cost >= best.cost) continue;
            if (clearance(f, r) < robotHalf) continue;
            const th = moveClear(ch.f, ch.r, ch.th, f, r);
            if (th === null || moveClear(f, r, th, s.f, s.r) === null) continue;
            best = { f, r, cost, why: "going round the blocks" };
          }
        }
      }
      return best || { f: ch.f, r: ch.r, why: "no clear way: holding" };
    }

    function steerRobot(dt, now) {
      const cw = ar.cameraWorld();
      const rl = w.toLocal(cw.x, cw.y);
      const h = hero;
      const actual = Math.atan2(rl.r - h.r, rl.f - h.f);
      const look = Lynx.control.aimInput;
      const rotIn = now - look.rotAt < 300 ? look.rot : 0;
      const tiltIn = now - look.tiltAt < 300 ? look.tilt : 0;
      if (Math.abs(rotIn) > 0.05) {
        cam.behind = false;
        cam.b = wrap(cam.b - rotIn * C.ORBIT_RATE * dt);
        cam.orbitAt = now;
      } else if (cam.behind) {
        const d = wrap(h.yaw + Math.PI - cam.b);
        cam.b = wrap(cam.b + clamp(d, -C.BEHIND_RATE * dt, C.BEHIND_RATE * dt));
        if (Math.abs(d) < 0.05) cam.behind = false;
        cam.orbitAt = now;
      } else if (now - cam.orbitAt > 1500) cam.b = actual;
      cam.tiltOff = clamp(cam.tiltOff + tiltIn * 25 * dt, -20, 20);
      if (now - cam.planMs > PLAN_EVERY_MS) {
        cam.planMs = now;
        const p = planRobot(cam.b);
        // (a spot hardly different from the last one: stay with that -- no creeping on jitter)
        const same = cam.target && p.why === cam.target.why && Math.hypot(p.f - cam.target.f, p.r - cam.target.r) < PLAN_DEADBAND_M;
        if (!same) cam.target = p;
        cam.why = p.why;
      }
      if (cam.target) {
        // the spot sent to the robot glides toward the planned one
        if (!cam.cmd) {
          const ch = chassisLocal();
          cam.cmd = { f: ch.f, r: ch.r };
        }
        const df = cam.target.f - cam.cmd.f;
        const dr = cam.target.r - cam.cmd.r;
        const d = Math.hypot(df, dr);
        const step = ROBOT_GLIDE_MPS * dt;
        if (d > step) {
          cam.cmd.f += (df / d) * step;
          cam.cmd.r += (dr / d) * step;
        } else cam.cmd = { f: cam.target.f, r: cam.target.r };
        const t = w.toWorld(cam.cmd.f, cam.cmd.r);
        const moved = !cam.lastGoto || Math.hypot(t.x - cam.lastGoto.x, t.y - cam.lastGoto.y) > C.GOTO_MOVE_M;
        if (moved || now - cam.lastGotoMs > C.GOTO_EVERY_MS) {
          Lynx.control.send({ type: "goto", x: +t.x.toFixed(4), y: +t.y.toFixed(4), maintainSpeed: false });
          cam.lastGoto = t;
          cam.lastGotoMs = now;
        }
      }
      aimAt([h.f + h.vf * 0.3, h.r + h.vr * 0.3, h.z + 0.04 * S], dt, now);
    }
    // the camera eases toward the point, panning and tilting at a limited rate
    function aimAt(pt, dt, now) {
      const cw = ar.cameraWorld();
      const fresh = !cam.aimPt;
      if (fresh) cam.aimPt = pt;
      const k = 1 - Math.exp(-dt * AIM_EASE);
      cam.aimPt = cam.aimPt.map((v, i) => v + (pt[i] - v) * k);
      const P = w.toWorld(cam.aimPt[0], cam.aimPt[1]);
      const hd = Math.hypot(P.x - cw.x, P.y - cw.y);
      const yaw = Math.atan2(P.y - cw.y, P.x - cw.x);
      const turn = AIM_MAX_RAD_S * dt;
      if (fresh || cam.aimYaw === null) cam.aimYaw = yaw;
      else if (hd > 0.03) cam.aimYaw = wrap(cam.aimYaw + clamp(wrap(yaw - cam.aimYaw), -turn, turn));
      const down = Math.atan2(cw.h - cam.aimPt[2], Math.max(hd, 0.03));
      const tilt = ((ar.calib.tiltRad - down) * 180) / Math.PI + cam.tiltOff;
      const tiltStep = (turn * 180) / Math.PI;
      cam.aimTilt = fresh ? tilt : cam.aimTilt + clamp(tilt - cam.aimTilt, -tiltStep, tiltStep);
      sendAimIfNeeded(now);
    }
    function sendAimIfNeeded(now) {
      if (!Lynx.control.absoluteAim() && now - cam.lastAimMs > 50 && cam.aimYaw !== null) {
        Lynx.control.send({ type: "aim", heading: +wrap(cam.aimYaw).toFixed(4), tilt: +cam.aimTilt.toFixed(2) });
        cam.lastAimMs = now;
      }
    }
    // while playing or looking around: the knight's input, the game's camera
    function takeControl(on) {
      if (Lynx.control.setDriveFilter) Lynx.control.setDriveFilter(on ? () => null : null);
      if (Lynx.cam && Lynx.cam.setAimOverride) Lynx.cam.setAimOverride(on ? () => (cam.aimYaw === null ? null : { yaw: cam.aimYaw, tiltDeg: cam.aimTilt }) : null);
    }
    function holdRobot() {
      const cw = ar.cameraWorld();
      Lynx.control.send({ type: "goto", x: +cw.x.toFixed(4), y: +cw.y.toFixed(4), maintainSpeed: false });
    }

    // -- flow ---------------------------------------------------------------------------------------
    function startScan() {
      const cw = ar.cameraWorld();
      w.setAnchor({ x: cw.x, y: cw.y, th: ar.camTheta });
      state = "scan";
      stateTime = 0;
      scan.yaw0 = ar.camTheta;
      cam.aimYaw = ar.camTheta;
      takeControl(true);
      holdRobot();
      say("Looking around for blocks -- Fire to skip");
    }
    function startPlay() {
      if (state === "title") {
        const cw = ar.cameraWorld();
        w.setAnchor({ x: cw.x, y: cw.y, th: ar.camTheta });
        takeControl(true);
      }
      refreshSolids();
      // the knight: ~camDist in front of the camera, on free floor
      const cw = ar.cameraWorld();
      const rl = w.toLocal(cw.x, cw.y);
      const cy = w.anchor().th - ar.camTheta;
      let spot = null;
      for (let k = 0; k < 24 && !spot; k++) {
        const a = cy + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * 0.25;
        for (const d of [camDist, camDist + 0.05, camDist + 0.1]) {
          const f = rl.f + d * Math.cos(a);
          const r = rl.r + d * Math.sin(a);
          if (solids.every((b) => footDist(b, f, r) > C.BODY_R + 0.004 * S)) {
            spot = { f, r, a };
            break;
          }
        }
      }
      if (!spot) spot = { f: rl.f + camDist * Math.cos(cy), r: rl.r + camDist * Math.sin(cy), a: cy };
      placeHero(spot.f, spot.r, spot.a);
      cam.b = Math.atan2(rl.r - hero.r, rl.f - hero.f);
      cam.aimPt = null;
      cam.cmd = null;
      cam.target = null;
      state = "playing";
      stateTime = 0;
      sfx("go");
      say(solids.length ? `${solids.filter((b) => !b.inferred).length} blocks -- climb them!` : "No blocks seen yet -- put the tagged blocks in view");
    }
    function rescan() {
      tb.clear();
      solids = [];
      if (hero.mode !== "move") {
        hero.mode = "move";
        hero.hang = hero.climb = null;
      }
      startScan();
    }

    Lynx.onAction("fire", () => {
      if (state === "title") {
        if (doScan) startScan();
        else startPlay();
      } else if (state === "scan") startPlay();
      else if (state === "playing" && hero.mode === "move") {
        if (!hero.attack) startSwing(1);
        else if (hero.attack.n < 3 && hero.attack.u > 0.2) hero.attackQueued = true;
      }
    });
    Lynx.onAction("jump", () => {
      if (state !== "playing") return false;
      hero.jumpBuf = C.JUMP_BUFFER_S;
      return true;
    });
    Lynx.onAction("camera", () => state === "playing" && (cam.behind = true));
    function zoom(dir) {
      // dir +1: closer (zoom in), -1: farther
      camDist = clamp(Math.round((camDist - dir * ZOOM_STEP) / ZOOM_STEP) * ZOOM_STEP, ZOOM_MIN, ZOOM_MAX);
      remember("knightblocksCamDist", camDist);
      cam.planMs = -1e9; // plan for it straight away
      say(`Camera ${Math.round(camDist * 100)} cm from the knight`, "#c0f0ff");
    }
    // RB / Tab: zoom in, LB: out (the weapon buttons -- no weapons to switch here)
    Lynx.onAction("weapon", (wpn) => (wpn === "prev" ? zoom(-1) : wpn === "next" ? zoom(1) : null));
    const onKey = (e) => {
      const t = e.target;
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA"))) return;
      if (e.key === "+" || e.key === "=") zoom(1);
      else if (e.key === "-" || e.key === "_") zoom(-1);
      else if (e.code === "KeyR" && state !== "title") rescan();
    };
    window.addEventListener("keydown", onKey);
    const touch = Lynx.touchButtons();
    touch.add("⤒ Jump", () => Lynx.jumpAction());
    touch.add("\u{1F3A5} Behind", () => Lynx.cameraAction());
    touch.add("\u2795 Zoom in", () => zoom(1));
    touch.add("\u2796 Zoom out", () => zoom(-1));
    touch.add("\u{1F50D} Rescan", () => state !== "title" && rescan());
    const toggle = (label, get, set, key) => {
      const text = () => `${label}: ${get() ? "on" : "off"}`;
      const btn = touch.add(text(), () => {
        set(!get());
        btn.textContent = text();
        remember(key, get());
      });
    };
    toggle("\u{1F9F1} Blocks", () => showBlocks, (v) => (showBlocks = v), "knightblocksShowBlocks");
    toggle("\u{1F3F7}\uFE0F Tags", () => showTags, (v) => (showTags = v), "knightblocksShowTags");
    ar.onDestroy(() => {
      window.removeEventListener("keydown", onKey);
      alive = false;
      tb.stop();
      if (state !== "title") Lynx.control.send({ type: "joystick", j1: 0, j2: 0 }); // out of goto: stop
      takeControl(false);
    });

    function update(dt, now) {
      time += dt;
      stateTime += dt;
      if (note) note.t += dt;
      if (state === "title") return;
      refreshSolids();
      if (state === "scan") {
        // turn the camera all the way round, looking down at the floor
        cam.aimYaw = scan.yaw0 + SCAN_RATE * stateTime;
        cam.aimTilt = SCAN_TILT_DEG;
        sendAimIfNeeded(now);
        if (now - cam.lastGotoMs > 1000) {
          holdRobot();
          cam.lastGotoMs = now;
        }
        if (SCAN_RATE * stateTime > 2 * Math.PI + 0.3) startPlay();
        return;
      }
      const n = Math.max(1, Math.ceil(dt / (1 / 120)));
      for (let i = 0; i < n; i++) stepHero(dt / n);
      const h = hero;
      h.speed = h.onGround && h.mode === "move" ? Math.hypot(h.vf, h.vr) : 0;
      const run = clamp((h.speed - C.WALK_V) / (C.RUN_V - C.WALK_V), 0, 1);
      h.phase += (dt * 2 * Math.PI * h.speed) / (lerp(0.056, 0.12, run) * S);
      steerRobot(dt, now);
    }

    // -- drawing ------------------------------------------------------------------------------------
    const corners = (b) => {
      const pts = [];
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const [f, r] = fromB(b, u * b.half, v * b.half);
        pts.push([f, r]);
      }
      return pts;
    };
    function hull(points) {
      const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
      const crossZ = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
      const lower = [];
      for (const q of p) {
        while (lower.length >= 2 && crossZ(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
        lower.push(q);
      }
      const upper = [];
      for (const q of p.slice().reverse()) {
        while (upper.length >= 2 && crossZ(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
        upper.push(q);
      }
      return lower.slice(0, -1).concat(upper.slice(0, -1));
    }
    // A real block: in front of the knight it cuts the knight out (the video
    // shows the block); optionally outlined (seen: cyan, inferred: grey).
    function queueBlock(b) {
      const cs = corners(b);
      const pts = [];
      for (const [f, r] of cs) for (const h of [b.h0, b.h1]) pts.push(w.project(f, r, h));
      const fs = cs.map((c) => c[0]);
      const rs = cs.map((c) => c[1]);
      const mid = w.project(b.cf, b.cr, (b.h0 + b.h1) / 2);
      if (!mid) return;
      ar.queue(mid.depth, () => {
        const g = ar.ctx;
        if (pts.every(Boolean)) {
          const hp = hull(pts);
          g.save();
          g.globalCompositeOperation = "destination-out";
          g.beginPath();
          hp.forEach((q, i) => (i ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
          g.closePath();
          g.fillStyle = "#000";
          g.fill();
          g.restore();
        }
        if (showBlocks) {
          const col = b.inferred ? "rgba(200,200,200,0.55)" : "rgba(80,230,255,0.85)";
          const top = cs.map(([f, r]) => [f, r, b.h1]);
          w.line3([...top, top[0]], col, 1.5, 0.01);
          cs.forEach(([f, r]) => w.line3([[f, r, b.h0], [f, r, b.h1]], col, 1, 0.01));
        }
      }, w.extent(Math.min(...fs), Math.max(...fs), Math.min(...rs), Math.max(...rs), b.h0, b.h1));
    }
    function queueShadow() {
      const h = hero;
      const g = groundAt(h.f, h.r, h.z + 0.0005, 0.0005);
      const k = clamp(1 - (h.z - g.h) / (0.12 * S), 0.3, 1);
      const rad = 0.007 * S * (0.6 + 0.4 * k);
      const pts = [];
      for (let i = 0; i < 12; i++) pts.push([h.f + rad * Math.cos((i / 12) * 2 * Math.PI), h.r + rad * Math.sin((i / 12) * 2 * Math.PI), g.h + 0.0008]);
      const m = w.project(h.f, h.r, g.h);
      if (!m) return;
      ar.queue(m.depth, () => {
        const p = w.polyScreen(pts, 1);
        if (p) w.fillPoly(p, `rgba(0,0,0,${(0.35 * k).toFixed(3)})`, null);
      }, w.extent(h.f - rad, h.f + rad, h.r - rad, h.r + rad, g.h, g.h + 0.0008));
    }
    let heroPrims = null; // the knight's last drawn primitives (for its silhouette behind blocks)
    function queueHero() {
      const h = hero;
      heroPrims = null;
      queueShadow();
      const m = w.project(h.f, h.r, h.z + 0.035 * S);
      if (!m) return;
      ar.queue(m.depth, () => {
        const J = K.bodyJoints({
          // (the body's animation is in Pocket Knight units: speeds at its size)
          time, speed: h.speed / S, phase: h.phase, air: h.mode === "move" && !h.onGround ? h.vz / S : null, land: h.landT > 0 ? h.landT / 0.18 : 0,
          hang: h.mode === "hang", climb: h.mode === "climb" ? h.climb.anim : null, attack: h.attack ? { n: h.attack.n, u: h.attack.u } : null,
          hurt: 0, dead: 0, brace: 0, armed: true,
        });
        const prims = K.knightPrims(J, K.placer(h.f, h.r, h.z, h.yaw, S), K.KNIGHT_LOOK, { speed: h.speed / S, time });
        prims.forEach((p) => p.rad && (p.rad *= S)); // limbs as thick as the knight is small
        heroPrims = prims;
        const c = w.camLocal();
        const near = clamp((Math.hypot(c.f - h.f, c.r - h.r) - 0.05) / 0.04, 0.35, 1);
        K.drawPrims(w, prims, ar, K.KNIGHT_LOOK.outline, near);
      }, w.extent(h.f - 0.014 * S, h.f + 0.014 * S, h.r - 0.014 * S, h.r + 0.014 * S, h.z, h.z + C.BODY_H));
    }
    // Behind a block (hanging on its far side, say) the knight would be lost
    // from view: a faint silhouette shows where it is, over the block.
    function drawHeroSilhouette() {
      if (!heroPrims) return;
      const h = hero;
      const c = w.camLocal();
      const pts = [0.1, 0.5, 0.9].map((k) => [h.f, h.r, h.z + k * C.BODY_H]);
      if (!pts.some((p) => hidden(c, p))) return;
      K.drawPrims(w, heroPrims, ar, "rgba(255,255,255,0.9)", 0.55);
    }
    // the tags found in the last picture, outlined where they were
    function drawTags() {
      const v = ar.view;
      const now = performance.now();
      const g = ar.ctx;
      tb.state.lastDetections.forEach((d) => {
        if (now - d.at > 400) return;
        const sx = v.w / d.w;
        const sy = v.h / d.h;
        g.beginPath();
        d.corners.forEach((p, i) => (i ? g.lineTo(v.x + p.x * sx, v.y + p.y * sy) : g.moveTo(v.x + p.x * sx, v.y + p.y * sy)));
        g.closePath();
        g.strokeStyle = "rgba(60,255,120,0.9)";
        g.lineWidth = 2;
        g.stroke();
        const c = d.corners.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 });
        ar.text(String(d.id), v.x + c.x * sx, v.y + c.y * sy + 4, { size: 11, align: "center", color: "#80ffa0" });
      });
    }

    function hud() {
      const v = ar.view;
      const s = tb.state;
      const real = solids.filter((b) => !b.inferred).length;
      const status = s.error ? s.error : !s.ready ? "Loading the tag detector..." : `${real} block${real === 1 ? "" : "s"} · ${s.tags} tag${s.tags === 1 ? "" : "s"} in view · ${s.fps.toFixed(1)}/s`;
      ar.text(status, v.x + 12, v.y + 24, { size: 13, color: s.error ? "#ff8080" : "#c0f0ff" });
      if (state === "title") {
        ar.banner("KNIGHT ON BLOCKS", doScan ? "Fire to start -- the robot looks around for the tagged blocks first" : "Fire to start -- with the tagged blocks in view");
        ar.text(`Blocks: ${+cfg.blockMm || 40} mm cubes with ${+cfg.tagMm || 30} mm ${family} AprilTags`, v.cx, v.cy + 70, { size: 14, align: "center" });
        ar.text(`Tags to print: ${location.host}/tags.html`, v.cx, v.cy + 92, { size: 13, align: "center", color: "#c0f0ff" });
        return;
      }
      if (state === "scan") ar.text(`Looking around... ${Math.min(100, Math.round((SCAN_RATE * stateTime * 100) / (2 * Math.PI)))}%  (Fire: start now)`, v.cx, v.y + v.h - 20, { size: 14, align: "center" });
      if (state === "playing") {
        ar.text("Run: stick / WASD · Jump: A / Space · Behind: Y / C · Zoom: + / \u2212, RB / LB · Rescan: R", v.cx, v.y + v.h - 20, { size: 13, align: "center" });
        if (cam.why) ar.text(`Robot: ${cam.why}`, v.x + 12, v.y + 42, { size: 12, color: "#ffd080" });
        const k = w.toWorld(hero.f, hero.r);
        ar.edgeArrow(k.x, k.y, hero.z + 0.035 * S, "#80d0ff");
      }
      if (note && note.t < 3) ar.text(note.text, v.cx, v.y + 70, { size: 16, align: "center", color: note.color, alpha: clamp(3 - note.t, 0, 1) });
    }

    function draw() {
      w.beginFrame();
      if (state !== "title") {
        solids.forEach(queueBlock);
        if (state === "playing") queueHero();
        ar.flush();
        if (state === "playing") drawHeroSilhouette();
      }
      if (showTags) drawTags();
      hud();
    }

    ar.onFrame((now, dt) => {
      update(dt, now);
      draw();
    });

    return {
      actionLabel: "⚔️ Sword",
      debug: { hero: () => hero, cam: () => cam, world: () => w, tags: () => tb, solids: () => solids, startPlay, startScan, rescan, teleport: (f, r) => placeHero(f, r, hero.yaw) },
      snapshot: () => ({
        state, blocks: solids.map((b) => `${b.id}${b.inferred ? "i" : ""}@${b.cf.toFixed(3)},${b.cr.toFixed(3)} h${(b.h0 * 1000).toFixed(0)}..${(b.h1 * 1000).toFixed(0)}mm`),
        hero: { f: +hero.f.toFixed(3), r: +hero.r.toFixed(3), z: +hero.z.toFixed(3), mode: hero.mode, onGround: hero.onGround, on: hero.standOn },
        detector: { ready: tb.state.ready, error: tb.state.error, fps: +tb.state.fps.toFixed(1), ms: +tb.state.detectMs.toFixed(1), tags: tb.state.tags },
        robot: cam.why,
      }),
    };
  };
})(window.Lynx);
