// Knight on Blocks -- the Pocket Knight (game_knight.js) on real blocks:
// cubes of any size with AprilTags (each tag ID on cubes of one size,
// measured to the cm), found by the cube layer (cubes.js). The knight walks
// around them, jumps or vaults onto them, catches the edge of a stack and
// climbs it -- and walks behind them: a real block nearer than the knight
// hides it (its silhouette is cut out of the overlay, so the video shows
// through).
//
// Manual drive (the default; "Auto drive" in the Overlays panel, or M,
// switches): the left stick moves the knight, the right stick (arrows) drives
// the robot in its own frame, as Free drive's robot mode -- up/down forward /
// back, left/right turning on the spot -- quick, short moves, so the camera is
// still most of the time (the settings driveSpeedCmS, turnSpeedDeg: 16 cm/s,
// 60 deg/s by default), and -- with "Auto stop" on (the default) -- it
// won't drive into a block it knows. The robot's outline: a rectangle round the
// drive wheels' axle (robotFrontCm ahead, robotRearCm behind, robotRadiusCm to
// each side, see bodyMargin). The camera
// keeps the knight in the middle of the view by itself ("camera_relative":
// the robot doesn't turn to help it, as it does for "aim").
//
// Auto drive: the robot follows the knight as in Pocket Knight (a leash at ~15 cm, the
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
  const ROBOT_GLIDE_MPS = 0.03; // how fast the spot the robot drives to may move (slow: the tags stay sharp)
  const PLAN_DEADBAND_M = 0.015; // a new plan this close to the old one isn't worth moving for
  // The camera: the cube finder only learns from still pictures (the camera
  // turned less than 0.6 deg in 0.4 s, see tagblocks.js), so it doesn't
  // follow the knight all the time -- it holds still while the knight stays
  // within the dead zone (the settings camDeadzoneDeg / camDeadzoneTiltDeg)
  // of the middle of the view, then turns at camSpeedDeg until it's within
  // AIM_SETTLE_DEG again, and holds still again. Re-center (V, the camera
  // button in manual drive, a touch / Menu button) turns it there right away.
  const AIM_EASE = 0.8; // 1/s: the spot looked at eases toward the knight (time constant 1.25 s)
  const AIM_SETTLE_DEG = 2;
  // Manual drive: the robot's top speeds (the "joystick" message's j2 / j1 at
  // full stick: ~5 cm/s, and ~20 deg/s turning on the spot) and how the speed
  // eases toward the stick's -- slow and smooth, so the tags stay sharp
  const WHEEL_TOP_MPS = 0.4; // a wheel at "joystick" 1 (maxWheelSpeedRevPerSec 1.8 x 71 mm wheels)
  const MANUAL_EASE = 8; // 1/s: the speed follows the stick quickly (starts and stops in ~0.1 s)
  const MANUAL_SEND_MS = 100; // drive and camera resent this often (the robot stops without)

  Lynx.games.knightblocks = (ar, cfg, app) => {
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
    // the robot's footprint (see bodyMargin): half its width, and how far it reaches in front of and behind the drive wheels' axle
    const robotHalf = clamp((+cfg.robotRadiusCm || 9.5) / 100, 0.04, 0.2) + ROBOT_MARGIN_M;
    const robotFront = clamp((+cfg.robotFrontCm || 5) / 100, 0.02, 0.2) + ROBOT_MARGIN_M;
    const robotRear = clamp((+cfg.robotRearCm || 18) / 100, 0.04, 0.4) + ROBOT_MARGIN_M;
    // the cyan block outlines and the green tag outlines: switches in the game
    let showBlocks = Boolean(remembered("knightblocksShowBlocks", cfg.showBlocks !== false));
    let showTags = Boolean(remembered("knightblocksShowTags", cfg.showTags !== false)); // (older versions stored 0 / 1)
    // the wheel tracks driving straight forward / back, and where the body would touch a cube (cubes.js)
    let showTracks = Boolean(remembered("knightblocksWheelTracks", true));
    // manual drive: the robot won't drive into a block it knows (off: it goes where it's driven)
    let autoStop = Boolean(remembered("knightblocksAutoStop", true));
    // where a jump would land (predictJump), shown while running or in the air
    let showJumpHint = Boolean(remembered("knightblocksJumpHint", true));
    const doScan = cfg.scan === true;
    // the camera (see AIM_EASE): how fast it turns, and its dead zone
    const num = (v, def) => (Number.isFinite(+v) && v !== "" && v !== null && v !== undefined ? +v : def);
    const aimRate = (clamp(num(cfg.camSpeedDeg, 40), 1, 60) * Math.PI) / 180;
    const deadYawDeg = clamp(num(cfg.camDeadzoneDeg, 12), 0, 40);
    const deadTiltDeg = clamp(num(cfg.camDeadzoneTiltDeg, 8), 0, 40);
    // manual drive's top speeds as "joystick" j2 / j1 (the wheels' speeds, a turn on the spot: v = omega x wheelbase / 2)
    const manualFwd = clamp(num(cfg.driveSpeedCmS, 16) / 100 / WHEEL_TOP_MPS, 0.02, 1);
    const manualTurn = clamp((((num(cfg.turnSpeedDeg, 60) * Math.PI) / 180) * 0.085) / WHEEL_TOP_MPS, 0.02, 1);
    // manual drive (default) or auto drive: a switch in the game, remembered
    let autoDrive = Boolean(remembered("knightblocksAutoDrive", cfg.autoDrive === true));
    const man = { fwd: 0, turn: 0, sentAt: -1e9, sent: null, camAt: -1e9, camSent: null, viewYaw: null };
    // through the calibrated lens: the knight and the outlines sit on the video right to the picture's edges
    const w = Lynx.world3d(ar, { textures: false, lens: true });
    // the tagged cubes: the cube layer every game with cubes uses (cubes.js --
    // the AprilTag settings are general, shared with Free drive's cube detection)
    // "World frame from cube" (Overlays panel, remembered): the frame cube sets
    // the world frame (cubes.js) -- and the knight's floor frame (the anchor),
    // the camera's aim and the robot's target move along with the world
    let frameFromCube = Boolean(remembered("knightblocksAutoFrame", false));
    const cubes = Lynx.cubeLayer(ar, app, { frame: () => frameFromCube, onWorldMoved: (cx, cy, alpha) => worldMoved(cx, cy, alpha) });
    const tb = cubes.tb;
    const { family, tagRatio } = cubes.settings;

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
        return { id: b.id, cf: l.f, cr: l.r, yaw: a.th - b.yaw, half: b.half, h0: b.h0, h1: b.h1, inferred: b.inferred, n: b.n, world: b };
      });
      // The block the knight stands on (or is climbing onto) moving -- its
      // estimate shifting, or the block itself pushed somewhere else (by the
      // robot, by hand) -- carries the knight along: the same spot on it,
      // turned with it. (Hanging from an edge follows the block by itself.)
      const h = hero;
      const ref = h.mode === "move" && h.onGround ? h.standOn : h.mode === "climb" && h.climb ? h.climb.id : null;
      if (ref === null) return;
      const now = solids.find((s) => s.id === ref);
      const before = prev.get(ref);
      if (!now || !before || (now.cf === before.cf && now.cr === before.cr && now.yaw === before.yaw)) return;
      // (a cube looks the same every quarter turn: its heading is only known
      // modulo 90 deg -- the turn is the smallest one that matches)
      const Q = Math.PI / 2;
      let turn = wrap(now.yaw - before.yaw);
      turn -= Math.round(turn / Q) * Q;
      const to = { ...now, yaw: before.yaw + turn };
      const carry = (p) => {
        const [u, v] = toB(before, p.f, p.r);
        [p.f, p.r] = fromB(to, u, v);
      };
      carry(h);
      h.yaw = wrap(h.yaw + turn);
      const c = Math.cos(turn);
      const sn = Math.sin(turn);
      [h.vf, h.vr] = [h.vf * c - h.vr * sn, h.vf * sn + h.vr * c];
      if (h.mode === "climb") {
        carry(h.climb.from);
        carry(h.climb.to);
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

    // -- where a jump lands ---------------------------------------------------------------------
    // The knight's flight as stepHero would fly it -- jumping now if it's on
    // the ground (else the jump it's in), the stick held as it is: air
    // control, gravity, bumping into blocks, landing on the floor or a block,
    // or catching a ledge on the way down (tryGrab's test, facing where it
    // flies). No side effects. -> {f, r, h (where it lands), on (a block's
    // id, or null: the floor), grab (catches that block's edge), path: [[f, r, z]] (the flight)} or null
    function predictJump() {
      const h = hero;
      if (h.mode !== "move") return null;
      const p = { f: h.f, r: h.r, z: h.z, vf: h.vf, vr: h.vr, vz: h.vz };
      const inp = stickInput();
      const tvf = inp.df * inp.speed;
      const tvr = inp.dr * inp.speed;
      if (h.onGround) {
        if (inp.speed < 0.004 * S) return null; // (standing still: a jump straight up)
        p.vz = C.JUMP_V;
      }
      const dt = 1 / 120;
      const path = [[p.f, p.r, p.z]];
      for (let i = 1; i < 360; i++) {
        const dvf = tvf - p.vf;
        const dvr = tvr - p.vr;
        const dv = Math.hypot(dvf, dvr);
        const a = C.AIR_ACCEL * dt;
        if (dv > a) {
          p.vf += (dvf / dv) * a;
          p.vr += (dvr / dv) * a;
        } else {
          p.vf = tvf;
          p.vr = tvr;
        }
        p.vz -= C.GRAVITY * dt;
        p.z += p.vz * dt;
        p.f += p.vf * dt;
        p.r += p.vr * dt;
        // bumping into blocks (as collide)
        for (const b of solids) {
          if (b.h1 <= p.z + C.AIR_STEP_UP || b.h0 >= p.z + C.BODY_H - 0.004 * S) continue;
          const [u, v] = toB(b, p.f, p.r);
          const e = b.half + C.BODY_R;
          if (Math.abs(u) >= e || Math.abs(v) >= e) continue;
          const pen = [[e - u, 1, 0], [e + u, -1, 0], [e - v, 0, 1], [e + v, 0, -1]].sort((x, y) => x[0] - y[0]);
          const [d, nu, nv] = pen[0];
          [p.f, p.r] = fromB(b, u + nu * d, v + nv * d);
          const [nf, nr] = dirFromB(b, nu, nv);
          const vn = p.vf * nf + p.vr * nr;
          if (vn < 0) {
            p.vf -= vn * nf;
            p.vr -= vn * nr;
          }
        }
        if (i % 4 === 0) path.push([p.f, p.r, p.z]);
        const g = groundAt(p.f, p.r, p.z, C.AIR_STEP_UP);
        if (p.vz <= 0 && p.z <= g.h) {
          path.push([p.f, p.r, g.h]);
          return { f: p.f, r: p.r, h: g.h, on: g.ref, grab: false, path };
        }
        // catching a ledge on the way down (tryGrab: a block's edge in front, high enough)
        if (p.vz < 0.07 * S && Math.hypot(p.vf, p.vr) > 1e-4) {
          const n = Math.hypot(p.vf, p.vr);
          const pf = p.f + (p.vf / n) * (C.BODY_R + 0.005 * S);
          const pr = p.r + (p.vr / n) * (C.BODY_R + 0.005 * S);
          for (const b of solids) {
            if (!inFoot(b, pf, pr)) continue;
            const rise = b.h1 - p.z;
            if (rise < C.MANTLE_MIN || rise > C.GRAB_MAX) continue;
            if (solids.some((o) => o !== b && o.h0 < b.h1 + C.BODY_H && o.h1 > b.h1 + 0.002 * S && inFoot(o, pf, pr, 0.004 * S))) continue;
            path.push([p.f, p.r, p.z]);
            return { f: pf, r: pr, h: b.h1, on: b.id, grab: true, path };
          }
        }
      }
      return null;
    }
    // The hint: a ring where it lands -- white on the floor, gold on a block
    // (and a mark when it would catch the edge and climb up) -- in the depth
    // order with the blocks, so a block in front of it hides it.
    function queueJumpHint() {
      const j = predictJump();
      if (!j) return;
      const col = j.on === null ? "rgba(255,255,255,0.9)" : "rgba(255,205,70,0.95)";
      const rad = C.BODY_R * 1.6;
      const m = w.project(j.f, j.r, j.h);
      if (!m) return;
      ar.queue(m.depth, () => {
        const ring = [];
        for (let k = 0; k <= 24; k++) ring.push([j.f + rad * Math.cos((k / 24) * 2 * Math.PI), j.r + rad * Math.sin((k / 24) * 2 * Math.PI), j.h + 0.0008]);
        w.line3(ring, col, 2.5, 0.003);
        if (j.grab) {
          const q = w.project(j.f, j.r, j.h + 0.004 * S);
          if (q) ar.text("\u2934 climbs", q.x, q.y - 10, { size: 12, align: "center", color: col });
        }
      }, w.extent(j.f - rad, j.f + rad, j.r - rad, j.r + rad, j.h, j.h + 0.001));
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
    // Its footprint: a rectangle along the chassis heading, from robotFront in
    // front of the drive wheels' axle (the odometry point) to the caster's
    // end robotRear behind it, robotHalf to each side. The chassis heading is
    // the robot's own (its pose messages): the page's smooth aim gives the
    // camera's heading instead.
    const chassis = { x: 0, y: 0, th: 0, at: -1e9 };
    let alive = true;
    ar.onDestroy(
      Lynx.control.onMessage("pose", (m) => {
        if (alive && typeof m.theta === "number") Object.assign(chassis, { x: m.x, y: m.y, th: m.theta, at: performance.now() });
      }),
    );
    function chassisLocal() {
      const fresh = performance.now() - chassis.at < 1000;
      const x = fresh ? chassis.x : ar.pose.x;
      const y = fresh ? chassis.y : ar.pose.y;
      const th = fresh ? chassis.th : ar.pose.theta; // (no telemetry: the view's heading)
      const l = w.toLocal(x, y);
      return { f: l.f, r: l.r, th: wrap(w.anchor().th - th) };
    }
    const clearance = (f, r) => solids.reduce((m, b) => Math.min(m, footDist(b, f, r)), Infinity);
    // Two convex outlines ([f, r] corners in order): the gap between them, or
    // (overlapping) minus how deep (the least overlap along an edge's normal).
    function polyGap(A, B) {
      let sep = -Infinity;
      for (const P of [A, B]) {
        for (let i = 0; i < P.length; i++) {
          const p = P[i];
          const q = P[(i + 1) % P.length];
          const l = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
          const n = [(q[1] - p[1]) / l, -(q[0] - p[0]) / l];
          const proj = (X) => X.map((x) => x[0] * n[0] + x[1] * n[1]);
          const a = proj(A);
          const b = proj(B);
          sep = Math.max(sep, Math.min(...b) - Math.max(...a), Math.min(...a) - Math.max(...b));
        }
      }
      if (sep < 0) return sep;
      const segDist = (x, p, q) => {
        const dx = q[0] - p[0];
        const dy = q[1] - p[1];
        const t = clamp(((x[0] - p[0]) * dx + (x[1] - p[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1);
        return Math.hypot(x[0] - p[0] - t * dx, x[1] - p[1] - t * dy);
      };
      let m = Infinity;
      for (const [X, Y] of [[A, B], [B, A]]) for (const x of X) for (let i = 0; i < Y.length; i++) m = Math.min(m, segDist(x, Y[i], Y[(i + 1) % Y.length]));
      return m;
    }
    // the robot's footprint at (f, r) facing th (floor frame): its corners
    function bodyCorners(f, r, th) {
      const c = Math.cos(th);
      const s = Math.sin(th);
      return [[robotFront, robotHalf], [robotFront, -robotHalf], [-robotRear, -robotHalf], [-robotRear, robotHalf]].map(([x, y]) => [f + c * x - s * y, r + s * x + c * y]);
    }
    // how far that footprint stays from the blocks it could touch (below its top); negative: in one
    function bodyMargin(f, r, th) {
      const R = bodyCorners(f, r, th);
      let m = Infinity;
      for (const b of solids) {
        if (b.h0 > 0.06) continue;
        const B = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => fromB(b, u * b.half, v * b.half));
        m = Math.min(m, polyGap(R, B));
      }
      return m;
    }
    const axleRoom = Math.min(robotHalf, robotFront); // (the axle can't be nearer a block than this)
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
          if (clearance(f, r) < axleRoom) continue; // (the axle at least; the rest once the heading is known)
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
            if (clearance(f, r) < axleRoom) continue;
            const th = moveClear(ch.f, ch.r, ch.th, f, r);
            if (th === null || moveClear(f, r, th, s.f, s.r) === null) continue;
            best = { f, r, cost, why: "going round the blocks" };
          }
        }
      }
      return best || { f: ch.f, r: ch.r, why: "no clear way: holding" };
    }

    // the chassis's heading in the world (rad)
    function chassisTheta() {
      if (performance.now() - chassis.at < 1000) return chassis.th;
      return typeof ar.pose.chassisTheta === "number" ? ar.pose.chassisTheta : ar.pose.theta - ((ar.pose.servoAngleDeg || 0) * Math.PI) / 180;
    }
    // Manual drive: the right stick (arrows) drives the robot in its own frame,
    // eased and slow, never into a block it knows; the camera looks at the
    // knight in the middle of the view.
    function manualDrive(dt, now) {
      const look = Lynx.control.aimInput;
      // (the look input as sent: stick x TURN_SPEED 0.7 / TILT_SPEED 0.8, see controls.js)
      const turnIn = now - look.rotAt < 300 ? clamp(look.rot / 0.7, -1, 1) : 0;
      const fwdIn = now - look.tiltAt < 300 ? clamp(look.tilt / 0.8, -1, 1) : 0;
      const k = 1 - Math.exp(-dt * MANUAL_EASE);
      man.fwd += (fwdIn - man.fwd) * k;
      man.turn += (turnIn - man.turn) * k;
      if (!fwdIn && Math.abs(man.fwd) < 0.03) man.fwd = 0;
      if (!turnIn && Math.abs(man.turn) < 0.03) man.turn = 0;
      cam.why = "";
      // not into a block it knows: forward / back, or its tail swinging round
      const ch = chassisLocal();
      const m0 = autoStop ? bodyMargin(ch.f, ch.r, ch.th) : 0;
      if (autoStop && man.fwd) {
        // (looking further ahead the faster it goes: it stops within ~a third of a second)
        const s = Math.sign(man.fwd) * Math.max(0.03, Math.abs(man.fwd) * manualFwd * WHEEL_TOP_MPS * 0.35);
        const m1 = bodyMargin(ch.f + s * Math.cos(ch.th), ch.r + s * Math.sin(ch.th), ch.th);
        if (m1 < 0.003 && m1 < m0) {
          man.fwd = 0;
          cam.why = "a block in the way";
        }
      }
      if (autoStop && man.turn) {
        // (turning left: the heading in the floor frame goes down)
        const m1 = bodyMargin(ch.f, ch.r, ch.th - Math.sign(man.turn) * 0.15);
        if (m1 < 0.003 && m1 < m0) {
          man.turn = 0;
          cam.why = "a block in the way";
        }
      }
      const r2 = (v) => Math.round(v * 100) / 100;
      const cmd = { j1: r2(-man.turn * manualTurn), j2: r2(man.fwd * manualFwd) }; // (j1: right)
      const moving = cmd.j1 !== 0 || cmd.j2 !== 0;
      const changed = !man.sent || cmd.j1 !== man.sent.j1 || cmd.j2 !== man.sent.j2;
      if ((changed || moving) && now - man.sentAt > (changed ? 40 : MANUAL_SEND_MS)) {
        Lynx.control.send({ type: "joystick", ...cmd });
        man.sent = cmd;
        man.sentAt = now;
      }
      // the camera: the knight in the middle (no lead -- as little camera movement as can be)
      aimAt(knightMiddle(), dt, now, false);
      // pointed relative to the chassis (the robot doesn't turn to help, as with "aim")
      const th = chassisTheta();
      const panDeg = clamp((wrap(cam.aimYaw - th) * 180) / Math.PI, -88, 88);
      man.viewYaw = th + (panDeg * Math.PI) / 180;
      const c = { pan: +panDeg.toFixed(1), tilt: +cam.aimTilt.toFixed(1) };
      const camChanged = !man.camSent || c.pan !== man.camSent.pan || c.tilt !== man.camSent.tilt;
      if (now - man.camAt > (camChanged ? 50 : MANUAL_SEND_MS)) {
        Lynx.control.send({ type: "camera_relative", ...c });
        man.camSent = c;
        man.camAt = now;
      }
    }
    function stopRobot() {
      Lynx.control.send({ type: "joystick", j1: 0, j2: 0 }); // (out of goto too)
      man.fwd = man.turn = 0;
      man.sent = { j1: 0, j2: 0 };
    }
    // the world frame just moved (the frame cube): everything kept in world coordinates along with it
    let worldHoldUntil = -1e9;
    function worldMoved(cx, cy, alpha) {
      worldHoldUntil = performance.now() + 1500; // (as the cube finder's pause: till the poses are in the new frame)
      const a = w.anchor();
      const c = Math.cos(alpha);
      const s = Math.sin(alpha);
      const dx = a.x - cx;
      const dy = a.y - cy;
      w.setAnchor({ x: dx * c + dy * s, y: -dx * s + dy * c, th: wrap(a.th - alpha) }); // (the knight's floor frame: the knight stays put)
      if (cam.aimYaw !== null) cam.aimYaw = wrap(cam.aimYaw - alpha);
      if (man.viewYaw !== null) man.viewYaw -= alpha;
      cam.lastGoto = null; // (the goto target: planned again in the new frame)
      cam.cmd = null;
      cam.target = null;
      cam.planMs = -1e9;
    }
    function setAutoDrive(on) {
      if (on === autoDrive) return;
      autoDrive = on;
      remember("knightblocksAutoDrive", on);
      if (driveToggle) driveToggle.querySelector("input").checked = on;
      cam.target = null;
      cam.cmd = null;
      cam.lastGoto = null;
      cam.planMs = -1e9;
      cam.why = "";
      if (state === "playing") stopRobot();
      applyControl();
      say(on ? "Auto drive: the robot follows the knight" : "Manual drive: right stick / arrows drive the robot", "#c0f0ff");
    }

    function steerRobot(dt, now) {
      if (!autoDrive) return manualDrive(dt, now);
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
      aimAt(knightMiddle(), dt, now);
    }
    // what the camera keeps in the middle of the view: the knight, half way up
    const knightMiddle = () => [hero.f, hero.r, hero.z + C.BODY_H / 2];
    // the camera eases toward the point, panning and tilting at a limited rate
    // (send: as "aim"; manual drive sends it itself)
    function aimAt(pt, dt, now, send = true) {
      const cw = ar.cameraWorld();
      const fresh = !cam.aimPt;
      if (fresh) cam.aimPt = pt;
      const k = 1 - Math.exp(-dt * AIM_EASE);
      cam.aimPt = cam.aimPt.map((v, i) => v + (pt[i] - v) * k);
      const P = w.toWorld(cam.aimPt[0], cam.aimPt[1]);
      const hd = Math.hypot(P.x - cw.x, P.y - cw.y);
      const yaw = Math.atan2(P.y - cw.y, P.x - cw.x);
      const turn = aimRate * dt;
      const down = Math.atan2(cw.h - cam.aimPt[2], Math.max(hd, 0.03));
      const tilt = ((ar.calib.tiltRad - down) * 180) / Math.PI + cam.tiltOff;
      if (fresh || cam.aimYaw === null) {
        cam.aimYaw = yaw;
        cam.aimTilt = tilt;
        cam.aimMoving = false;
      } else {
        // held still in the dead zone; past it, turned slowly till it's in the middle again
        const errYawDeg = hd > 0.03 ? (wrap(yaw - cam.aimYaw) * 180) / Math.PI : 0;
        const errTilt = tilt - cam.aimTilt;
        if (!cam.aimMoving && (Math.abs(errYawDeg) > deadYawDeg || Math.abs(errTilt) > deadTiltDeg)) cam.aimMoving = true;
        if (cam.aimMoving) {
          const tiltStep = (turn * 180) / Math.PI;
          cam.aimYaw = wrap(cam.aimYaw + clamp((errYawDeg * Math.PI) / 180, -turn, turn));
          cam.aimTilt += clamp(errTilt, -tiltStep, tiltStep);
          if (Math.abs(errYawDeg) < AIM_SETTLE_DEG && Math.abs(errTilt) < AIM_SETTLE_DEG) cam.aimMoving = false;
        }
      }
      if (send) sendAimIfNeeded(now);
    }
    function sendAimIfNeeded(now) {
      if (!Lynx.control.absoluteAim() && now - cam.lastAimMs > 50 && cam.aimYaw !== null) {
        Lynx.control.send({ type: "aim", heading: +wrap(cam.aimYaw).toFixed(4), tilt: +cam.aimTilt.toFixed(2) });
        cam.lastAimMs = now;
      }
    }
    // while playing or looking around: the knight's input (the left stick),
    // the game's camera -- and in manual drive the right stick (the robot's
    // drive), with the camera pointed relative to the chassis by the game
    let controlling = false;
    function takeControl(on) {
      controlling = on;
      applyControl();
    }
    function applyControl() {
      const on = controlling;
      const manual = on && !autoDrive && state === "playing";
      if (Lynx.control.setDriveFilter) Lynx.control.setDriveFilter(on ? () => null : null);
      if (Lynx.control.setLookCapture) Lynx.control.setLookCapture(manual);
      if (Lynx.cam && Lynx.cam.setAimOverride) {
        Lynx.cam.setAimOverride(
          !on
            ? null
            : manual
              ? () => (man.viewYaw === null ? null : { yaw: man.viewYaw, tiltDeg: cam.aimTilt, noSend: true })
              : () => (cam.aimYaw === null ? null : { yaw: cam.aimYaw, tiltDeg: cam.aimTilt }),
        );
      }
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
      if (!autoDrive) stopRobot(); // (out of the scan's goto)
      applyControl();
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
    // Re-center: the camera turns to the knight now (dead zone or not), and the
    // spot it looks at jumps to the knight (no easing)
    function recenter() {
      if (state !== "playing") return;
      if (cam.aimYaw === null) return;
      cam.aimPt = knightMiddle(); // (turned there at the camera's speed: aimAt)
      cam.aimMoving = true;
      say("Camera: re-centering on the knight", "#c0f0ff");
    }
    // the camera button: in auto drive the robot circles round behind the knight; in manual drive, re-center
    Lynx.onAction("camera", () => state === "playing" && (autoDrive ? (cam.behind = true) : recenter()));
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
      else if (e.code === "KeyM") setAutoDrive(!autoDrive);
      else if (e.code === "KeyV") recenter();
    };
    window.addEventListener("keydown", onKey);
    const touch = Lynx.touchButtons();
    touch.add("⤒ Jump", () => Lynx.jumpAction());
    touch.add("\u{1F3A5} Behind", () => Lynx.cameraAction());
    touch.add("\u2316 Center", () => recenter());
    touch.add("\u2795 Zoom in", () => zoom(1));
    touch.add("\u2796 Zoom out", () => zoom(-1));
    // Rescan in the Menu panel, the outline switches with the other overlays
    const panelItems = [];
    let driveToggle = null;
    if (Lynx.cam && Lynx.cam.addMenuButton) {
      driveToggle = Lynx.cam.addOverlayToggle("Auto drive", autoDrive, (on) => setAutoDrive(on));
      panelItems.push(driveToggle);
      panelItems.push(Lynx.cam.addMenuButton("\u{1F50D} Rescan blocks", () => state !== "title" && rescan()));
      panelItems.push(Lynx.cam.addMenuButton("\u2316 Re-center camera", () => recenter()));
      panelItems.push(Lynx.cam.addOverlayToggle("Blocks", showBlocks, (on) => remember("knightblocksShowBlocks", (showBlocks = on))));
      panelItems.push(Lynx.cam.addOverlayToggle("Tags", showTags, (on) => remember("knightblocksShowTags", (showTags = on))));
      panelItems.push(Lynx.cam.addOverlayToggle("Wheel tracks", showTracks, (on) => remember("knightblocksWheelTracks", (showTracks = on))));
      panelItems.push(Lynx.cam.addOverlayToggle("Auto stop", autoStop, (on) => remember("knightblocksAutoStop", (autoStop = on))));
      panelItems.push(Lynx.cam.addOverlayToggle("Jump hint", showJumpHint, (on) => remember("knightblocksJumpHint", (showJumpHint = on))));
      panelItems.push(Lynx.cam.addOverlayToggle("World frame from cube", frameFromCube, (on) => remember("knightblocksAutoFrame", (frameFromCube = on))));
    }
    ar.onDestroy(() => {
      panelItems.forEach((el) => el.remove());
      window.removeEventListener("keydown", onKey);
      alive = false; // (the cube layer stops with the ar)
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
      // (just after the world moved, the robot's pose is still in the old frame for a moment: no steering)
      if (performance.now() >= worldHoldUntil) steerRobot(dt, now);
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
    // shows the block); optionally outlined (the cube layer's: seen cyan, the
    // frame cube yellow, inferred grey).
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
          cubes.drawOutline(w, b.world);
        }
      }, w.extent(Math.min(...fs), Math.max(...fs), Math.min(...rs), Math.max(...rs), b.h0, b.h1, cs)); // (cs: the cube as turned, see ar.js boxOrder)
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
    function queueHero() {
      const h = hero;
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
        const c = w.camLocal();
        const near = clamp((Math.hypot(c.f - h.f, c.r - h.r) - 0.05) / 0.04, 0.35, 1);
        K.drawPrims(w, prims, ar, K.KNIGHT_LOOK.outline, near);
      }, w.extent(h.f - 0.014 * S, h.f + 0.014 * S, h.r - 0.014 * S, h.r + 0.014 * S, h.z, h.z + C.BODY_H));
    }
    function hud() {
      const v = ar.view;
      const s = tb.state;
      // (no status line -- the Tags page lists the cubes; a failure shows at the bottom, cubes.js)
      if (!s.ready && !s.error) ar.text("Loading the tag detector...", v.x + 12, v.y + 24, { size: 13, color: "#c0f0ff" });
      if (state === "title") {
        ar.banner("KNIGHT ON BLOCKS", doScan ? "Fire to start -- the robot looks around for the tagged blocks first" : "Fire to start -- with the tagged blocks in view");
        ar.text(`Blocks: cubes of any size with ${family} AprilTags filling ${Math.round(tagRatio * 100)}% of a face`, v.cx, v.cy + 70, { size: 14, align: "center" });
        ar.text(`Tags to print: ${location.host}/tags.html`, v.cx, v.cy + 92, { size: 13, align: "center", color: "#c0f0ff" });
        return;
      }
      if (state === "scan") ar.text(`Looking around... ${Math.min(100, Math.round((SCAN_RATE * stateTime * 100) / (2 * Math.PI)))}%  (Fire: start now)`, v.cx, v.y + v.h - 20, { size: 14, align: "center" });
      if (state === "playing") {
        ar.text(
          autoDrive
            ? "Run: stick / WASD · Jump: A / Space · Behind: Y / C · Center: V · Zoom: + / \u2212, RB / LB · Rescan: R · Manual drive: M"
            : "Knight: left stick / WASD · Robot: right stick / arrows · Jump: A / Space · Center: V / Y · Rescan: R · Auto drive: M",
          v.cx, v.y + v.h - 20, { size: 13, align: "center" },
        );
        const mode = autoDrive ? "auto drive" : "manual drive";
        ar.text(`Robot: ${mode}${cam.why ? ` -- ${cam.why}` : ""}`, v.x + 12, v.y + 42, { size: 12, color: cam.why ? "#ffd080" : "#c0f0ff" });
        const k = w.toWorld(hero.f, hero.r);
        ar.edgeArrow(k.x, k.y, hero.z + 0.035 * S, "#80d0ff");
      }
      if (note && note.t < 3) ar.text(note.text, v.cx, v.y + 70, { size: 16, align: "center", color: note.color, alpha: clamp(3 - note.t, 0, 1) });
    }

    function draw() {
      w.beginFrame();
      if (state !== "title") {
        // on the floor, under everything: the cubes gone from where they were
        // (each cube's own footprint goes with it, queueBlock)
        if (showBlocks) cubes.drawGone(w);
        // (its body as the game keeps it clear of the blocks)
        if (showTracks) Lynx.drawWheelTracks(ar, w, { blocks: cubes.blocks, halfWidthM: robotHalf, frontM: robotFront, rearM: robotRear });
        solids.forEach(queueBlock);
        if (state === "playing") queueHero();
        if (state === "playing" && showJumpHint) queueJumpHint();
        ar.flush();
      }
      if (showTags) cubes.drawTags();
      cubes.drawStatus();
      hud();
    }

    ar.onFrame((now, dt) => {
      update(dt, now);
      draw();
    });

    return {
      actionLabel: "⚔️ Sword",
      debug: { hero: () => hero, cam: () => cam, world: () => w, tags: () => tb, solids: () => solids, startPlay, startScan, rescan, teleport: (f, r) => placeHero(f, r, hero.yaw), predictJump },
      snapshot: () => ({
        state, blocks: solids.map((b) => `${b.id}${b.inferred ? "i" : ""}@${b.cf.toFixed(3)},${b.cr.toFixed(3)} h${(b.h0 * 1000).toFixed(0)}..${(b.h1 * 1000).toFixed(0)}mm`),
        hero: { f: +hero.f.toFixed(3), r: +hero.r.toFixed(3), z: +hero.z.toFixed(3), mode: hero.mode, onGround: hero.onGround, on: hero.standOn },
        detector: { ready: tb.state.ready, error: tb.state.error, fps: +tb.state.fps.toFixed(1), ms: +tb.state.detectMs.toFixed(1), tags: tb.state.tags },
        robot: cam.why,
      }),
    };
  };
})(window.Lynx);
