// Pocket Knight -- a third-person sword-and-parkour adventure at 1:25 scale.
//
// You don't drive the robot: you control a 7 cm knight on the floor in front
// of it, and the game drives the robot -- it keeps about 15 cm from the
// knight, looking at it from wherever it is (the robot's "goto" position
// control, see sendFollow()), and points the camera at it (absolute aim,
// Lynx.cam.setAimOverride). Camera button (C / gamepad Y / touch): the robot
// circles round behind the knight; the look controls (right stick, arrow
// keys) orbit it round the knight.
//
// Moves (camera-relative: up = away from the camera): walk / run (stick
// deflection; Shift / LT = walk), jump, catch a ledge you jump at (hang;
// push toward the wall or jump to climb up, sideways to shimmy, away to let
// go), step up small ledges, push crates, sword: a three-hit combo (fire),
// a plunging strike in the air. Enemies (skeletons, a brute) wind up before
// they strike: step out of reach or hit them first.
//
// Scale: lengths are 1:25, time is not -- a stride or a jump takes as long
// as a person's -- so gravity is scaled too (g / 25, a bit more for snappy
// jumps). Levels are blocks in a floor frame laid out from where the robot
// stands at the start (f forward, r right, h up, meters; see world3d.js);
// everything solid is in one list (solids()), so real objects found by AR
// tags can join it later.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  // -- the knight's moves --------------------------------------------------------------
  const BODY_H = 0.07;
  const BODY_R = 0.006; // for collisions
  const STEP_UP = 0.009;
  const GRAVITY = 0.46;
  const JUMP_V = 0.185; // apex ~3.7 cm, ~0.8 s in the air
  const WALK_V = 0.06;
  const RUN_V = 0.18;
  const ACCEL = 1.3;
  const DECEL = 1.8;
  const AIR_ACCEL = 0.4;
  const TURN_RATE = 12;
  const COYOTE_S = 0.1;
  const JUMP_BUFFER_S = 0.14;
  const MANTLE_MIN = 0.003; // in the air, a ledge this far above the feet (up to GRAB_MIN) is vaulted onto
  const GRAB_MIN = 0.035; // higher (up to GRAB_MAX), the hands catch it: hang, then climb
  const GRAB_MAX = 0.08;
  const AIR_STEP_UP = 0.003; // (on the ground, STEP_UP)
  const HANG_DROP = 0.076; // hanging: the feet this far below the ledge (hands on it)
  const CLIMB_S = 0.85;
  const SHIMMY_V = 0.035;
  const FALL_HURT_M = 0.12;
  const VOID_Z = -0.07; // fallen this far into a chasm: lost
  const INVULN_S = 1.2;
  const REACH = 0.032; // the sword, from the body's center
  const PUSH_V = 0.045; // crates
  const CRATE_DELAY_S = 0.2;
  const SWINGS = { 1: 0.36, 2: 0.36, 3: 0.5 }; // combo swing durations (s); 4 = plunge, until landing
  const HIT_WINDOW = { 1: [0.32, 0.56], 2: [0.32, 0.56], 3: [0.4, 0.62] };

  // -- the robot ---------------------------------------------------------------------------
  const CAM_DIST = 0.15; // from the knight (more when it's high up)
  const ORBIT_RATE = 1.4; // rad/s, look controls
  const BEHIND_RATE = 1.6; // rad/s, the camera button's circling
  const GOTO_EVERY_MS = 250;
  const GOTO_MOVE_M = 0.005;

  const DIFFICULTY = {
    easy: { windup: 1.4, speed: 0.8, enemyHp: 0.7 },
    normal: { windup: 1, speed: 1, enemyHp: 1 },
    hard: { windup: 0.75, speed: 1.2, enemyHp: 1.3 },
  };
  const ENEMY = {
    skeleton: { hp: 3, speed: 0.07, windup: 0.55, strike: 0.14, recover: 0.7, reach: 0.031, scale: 1, score: 250, sight: 0.35 },
    brute: { hp: 7, speed: 0.05, windup: 0.85, strike: 0.18, recover: 0.9, reach: 0.041, scale: 1.25, score: 750, sight: 0.4 },
  };

  // -- looks ---------------------------------------------------------------------------------
  const STONE = { top: "#c8b088", side: "#9c8462", dark: "#76603f", line: "rgba(40,25,10,0.5)", tex: "sandstone" };
  const DARK = { top: "#8a8070", side: "#6a6254", dark: "#4e483c", line: "rgba(20,15,10,0.5)", tex: "crypt" };
  const WOOD = { top: "#a8743e", side: "#82562c", dark: "#5e3c1c", line: "rgba(30,15,5,0.8)", detail: "slab" };
  const MARBLE = { top: "#e4ddcc", side: "#bdb5a2", dark: "#958d7a", line: "rgba(60,50,30,0.5)", detail: "marble", under: "#6e685a" };
  const BRONZE = { top: "#c09450", side: "#946c32", dark: "#6a4c1e", line: "rgba(40,24,4,0.8)", detail: "slab", under: "#4a3410" };
  const STYLES = { stone: STONE, dark: DARK, wood: WOOD, marble: MARBLE, bronze: BRONZE };

  const KNIGHT_LOOK = {
    outline: "rgba(15,12,10,0.85)", helmet: "#aab4be", visor: "#1a1c20", plume: "#d03030", tunic: "#2f5fb0", belt: "#5a3a1a",
    mail: "#8e98a2", glove: "#5a3a28", legs: "#5b4430", boots: "#2a1e16", neck: "#d8a880", blade: "#e8eef4", hilt: "#c8a040", grip: "#4a2c14", cape: "#9c2424",
  };
  const SKELETON_LOOK = { outline: "rgba(40,34,24,0.9)", bone: "#e8e2cc", socket: "#201810", eye: "#ff3020", blade: "#b0a088", hilt: "#6a5a40", grip: "#3a2a18" };
  const BRUTE_LOOK = { outline: "rgba(10,10,12,0.9)", bone: "#d8d0b8", armor: "#4a4e58", trim: "#8a6a30", socket: "#100808", eye: "#ff6010", blade: "#9aa0a8", hilt: "#8a6a30", grip: "#2a1a10", horn: "#e0d8c0" };

  // -- levels -------------------------------------------------------------------------------------
  // Blocks: {f0, f1, r0, r1, h1 (top), h0 (default 0), style}. Pits: chasms
  // in the floor (fall in: back to the last checkpoint, a heart less).
  // Spikes: a bed of spikes on the floor. Gates: bars across a gap, opened by
  // a lever (by: its id), a pressure plate (plate: its id, open while
  // pressed) or by beating the enemies (by: "enemies"). Movers: platforms
  // gliding between two places (ping-pong). Crates: pushed by walking into
  // them. Checkpoints: flags; the goal: the level's prize.
  const box = (f0, f1, r0, r1, h1, style = "stone", h0 = 0) => ({ f0, f1, r0, r1, h0, h1, style });
  const LEVELS = [
    {
      name: "The Ruined Keep",
      intro: "Level 1 -- the ruined keep: climb, fight, pull the lever, take the banner!",
      bounds: { f0: -0.05, f1: 2.36, r0: -0.62, r1: 0.62 },
      spawn: { f: 0.15, r: 0, yaw: 0 },
      floors: [{ f0: 0, f1: 2.33, r0: -0.6, r1: 0.6 }],
      blocks: [
        // tutorial steps: step up, jump up, catch the ledge
        box(0.32, 0.42, -0.15, 0.15, 0.008),
        box(0.42, 0.52, -0.15, 0.15, 0.025),
        box(0.52, 0.62, -0.15, 0.15, 0.1), // too high to vault: catch it, climb
        // ruined side walls
        box(0, 0.7, -0.63, -0.6, 0.05, "dark"), box(0, 0.7, 0.6, 0.63, 0.05, "dark"),
        box(0.92, 1.5, -0.63, -0.6, 0.05, "dark"), box(0.92, 1.5, 0.6, 0.63, 0.05, "dark"),
        box(1.53, 2.36, -0.63, -0.6, 0.05, "dark"), box(1.53, 2.36, 0.6, 0.63, 0.05, "dark"),
        box(2.33, 2.36, -0.6, 0.6, 0.05, "dark"),
        // the plank over the chasm
        box(0.735, 0.885, 0.42, 0.45, 0.004, "wood"),
        // the arena's wall, with the gate in the middle
        box(1.5, 1.53, -0.63, -0.08, 0.065, "dark"), box(1.5, 1.53, 0.08, 0.63, 0.065, "dark"),
        // the lever tower: a step, then a ledge to catch
        box(1.1, 1.2, 0.42, 0.58, 0.03),
        box(1.2, 1.32, 0.42, 0.58, 0.065),
        // pillars over the spikes, up to the keep
        box(1.66, 1.72, -0.05, 0.01, 0.015, "marble"),
        box(1.78, 1.84, 0.05, 0.11, 0.03, "marble"),
        box(1.9, 1.96, -0.07, -0.01, 0.045, "marble"),
        box(2.02, 2.08, 0.03, 0.09, 0.06, "marble"),
        box(2.12, 2.3, -0.15, 0.15, 0.09),
      ],
      pits: [{ f0: 0.75, f1: 0.87, r0: -0.6, r1: 0.6 }],
      spikes: [{ f0: 1.64, f1: 2.11, r0: -0.26, r1: 0.26 }],
      gates: [{ id: "keepGate", f0: 1.505, f1: 1.525, r0: -0.08, r1: 0.08, h1: 0.065, by: "lever1" }],
      levers: [{ id: "lever1", f: 1.27, r: 0.5, h: 0.065 }],
      plates: [], crates: [], movers: [],
      coins: [
        [0.37, 0, 0.008], [0.47, 0, 0.025], [0.57, 0.08, 0.1], [0.57, -0.08, 0.1],
        [0.81, 0.435, 0.03], [0.81, -0.2, 0.035], [0.81, 0.15, 0.035],
        [1.0, -0.4, 0], [1.4, 0.35, 0], [1.15, 0.5, 0.03], [1.26, 0.45, 0.065],
        [1.69, -0.02, 0.015], [1.81, 0.08, 0.03], [1.93, -0.04, 0.045], [2.05, 0.06, 0.06],
      ],
      checkpoints: [{ f: 0.97, r: -0.3, h: 0 }, { f: 1.6, r: 0.2, h: 0 }],
      enemies: [
        { kind: "skeleton", f: 1.15, r: -0.2 },
        { kind: "skeleton", f: 1.32, r: 0.2 },
        { kind: "skeleton", f: 2.24, r: -0.08, h: 0.09, minDiff: "normal" },
      ],
      goal: { f: 2.21, r: 0.06, h: 0.09, kind: "banner" },
      hints: [
        { until: (g) => g.me.f > 0.45, text: "Run: stick / WASD. Jump: A / Space. Climb the steps" },
        { until: (g) => g.me.f > 0.65, text: "Too high to jump? Jump at the ledge to catch it, then push on to climb" },
        { until: (g) => g.me.f > 0.9, text: "The chasm: a running jump -- or the plank on the right" },
        { until: (g) => g.gateOpen("keepGate"), text: "Strike the lever on the tower (right) with your sword (X / Z) -- mind the skeletons" },
        { until: (g) => g.me.f > 1.6, text: "The gate is open!" },
        { until: () => false, text: "Up the pillars to the keep -- don't touch the spikes" },
      ],
    },
    {
      name: "The Clockwork Bridge",
      intro: "Level 2 -- the clockwork bridge: push the crate, ride the platforms, beat the guardians!",
      bounds: { f0: -0.05, f1: 2.42, r0: -0.62, r1: 0.62 },
      spawn: { f: 0.15, r: -0.2, yaw: 0 },
      floors: [{ f0: 0, f1: 2.4, r0: -0.6, r1: 0.6 }],
      blocks: [
        box(0, 0.62, -0.63, -0.6, 0.05, "dark"), box(0, 0.62, 0.6, 0.63, 0.05, "dark"),
        // the door's wall (the gate in its middle opens while the plate is down)
        box(0.6, 0.63, -0.63, -0.08, 0.07, "dark"), box(0.6, 0.63, 0.08, 0.63, 0.07, "dark"),
        // the landing past the chasm, and down into the guardians' hall
        box(1.5, 1.62, -0.6, 0.6, 0.04, "stone"),
        box(1.62, 2.4, -0.63, -0.6, 0.05, "dark"), box(1.62, 2.4, 0.6, 0.63, 0.05, "dark"), box(2.37, 2.4, -0.6, 0.6, 0.05, "dark"),
        // a still island in the middle of the chasm
        box(1.06, 1.16, -0.1, 0.1, 0.02, "marble", 0.0),
        // the goal's dais
        box(2.15, 2.27, -0.06, 0.06, 0.015, "marble"),
      ],
      pits: [{ f0: 0.72, f1: 1.5, r0: -0.6, r1: 0.6 }],
      spikes: [],
      gates: [
        { id: "door", f0: 0.605, f1: 0.625, r0: -0.08, r1: 0.08, h1: 0.07, plate: "plate1" },
        { id: "hallGate", f0: 2.09, f1: 2.11, r0: -0.1, r1: 0.1, h1: 0.05, by: "enemies" },
      ],
      levers: [],
      plates: [{ id: "plate1", f0: 0.42, f1: 0.48, r0: 0.32, r1: 0.38 }],
      crates: [{ f: 0.25, r: 0.35, size: 0.035 }],
      movers: [
        { f0: 0.76, f1: 0.82, r0: -0.03, r1: 0.03, h0: 0.006, h1: 0.016, from: [0, 0, 0], to: [0.2, 0, 0], period: 4.5 },
        { f0: 1.2, f1: 1.26, r0: -0.33, r1: -0.27, h0: 0.01, h1: 0.02, from: [0, 0, 0], to: [0, 0.6, 0], period: 5.5 },
        { f0: 1.3, f1: 1.36, r0: 0.24, r1: 0.3, h0: 0.01, h1: 0.02, from: [0, 0, 0], to: [0.12, 0, 0.012], period: 4 },
      ],
      coins: [
        [0.25, -0.35, 0], [0.4, -0.35, 0], [0.25, 0.35, 0.035],
        [0.85, 0, 0.03], [0.95, 0, 0.03], [1.11, 0, 0.02], [1.23, 0.0, 0.035], [1.4, 0.27, 0.04],
        [1.55, -0.4, 0.04], [1.55, 0.4, 0.04], [1.8, -0.4, 0], [1.8, 0.4, 0], [2.0, 0, 0],
      ],
      checkpoints: [{ f: 0.68, r: 0.0, h: 0 }, { f: 1.11, r: 0.05, h: 0.02 }, { f: 1.56, r: 0, h: 0.04 }],
      enemies: [
        { kind: "skeleton", f: 1.8, r: -0.25 },
        { kind: "skeleton", f: 1.85, r: 0.3, minDiff: "normal" },
        { kind: "brute", f: 2.0, r: 0 },
      ],
      goal: { f: 2.21, r: 0, h: 0.015, kind: "crown" },
      hints: [
        { until: (g) => g.gateOpen("door"), text: "Walk into the crate to push it onto the plate: it holds the door open" },
        { until: (g) => g.me.f > 0.7, text: "Through the door!" },
        { until: (g) => g.me.f > 1.5, text: "Ride the moving platforms over the chasm -- time your jumps" },
        { until: (g) => g.gateOpen("hallGate"), text: "Beat the guardians -- the brute's swing is slow, but long" },
        { until: () => false, text: "Take the crown!" },
      ],
    },
  ];

  // -- helpers ----------------------------------------------------------------------------------------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const ease = (t) => {
    const x = clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
  };
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const approach = (v, target, step) => (v < target ? Math.min(target, v + step) : Math.max(target, v - step));
  const inRect = (f, r, q, m = 0) => f >= q.f0 - m && f <= q.f1 + m && r >= q.r0 - m && r <= q.r1 + m;
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const len3 = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a) => mul(a, 1 / (len3(a) || 1));
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  // a limb's direction in the body frame (x forward, y right, z up): fwd = swing
  // in the sagittal plane (0 hanging down, pi/2 forward, pi up), out = abduction
  // to the side s (-1 left, +1 right)
  const limbDir = (fwd, out, s) => [Math.sin(fwd) * Math.cos(out), s * Math.sin(out), -Math.cos(fwd) * Math.cos(out)];
  // elbow for a hand target (two bones, the elbow bending toward `pole`)
  function ik(root, target, l1, l2, pole) {
    let d = sub(target, root);
    let dist = len3(d);
    const maxD = (l1 + l2) * 0.999;
    if (dist > maxD) {
      d = mul(d, maxD / dist);
      dist = maxD;
      target = add(root, d);
    }
    const dir = norm(d);
    const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const hgt = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    let p = sub(pole, mul(dir, pole[0] * dir[0] + pole[1] * dir[1] + pole[2] * dir[2]));
    p = norm(len3(p) < 1e-6 ? [0, 0, -1] : p);
    return { elbow: add(add(root, mul(dir, a)), mul(p, hgt)), hand: target };
  }

  // -- the body ----------------------------------------------------------------------------------------
  // Joints in the body frame (meters, x forward, y right, z up, the feet at
  // the origin) for an animation state: {time, speed, phase (gait), air (vz
  // or null), land (0..1), hang (bool), climb (0..1 or null), attack ({n, u}
  // or null), hurt (0..1), dead (0..1), brace (0..1, enemy wind-up), armed}.
  const L = { thigh: 0.0175, shin: 0.0165, upper: 0.012, fore: 0.011, hipH: 0.036, torso: 0.022, shoulderW: 0.0085, hipW: 0.0045 };
  function bodyJoints(a) {
    const amp = clamp(a.speed / WALK_V, 0, 1);
    const run = clamp((a.speed - WALK_V) / (RUN_V - WALK_V), 0, 1);
    const p = a.phase;
    const breathe = Math.sin(a.time * 2.2) * (1 - amp);
    let hipZ = L.hipH + lerp(0.0007, -0.0016, run) * amp * Math.cos(2 * p) - lerp(0.0004, 0.0022, run) * amp;
    let lean = lerp(0.03, 0.24, run) * amp;
    let twist = 0;
    // legs: [fwd swing, knee bend] per side (s = -1 left, +1 right)
    const legs = {};
    const arms = {};
    for (const s of [-1, 1]) {
      const lp = p + (s < 0 ? 0 : Math.PI);
      const A = lerp(0.42, 0.9, run) * amp;
      const swing = Math.max(0, Math.cos(lp));
      legs[s] = { fwd: A * Math.sin(lp), knee: 0.06 + lerp(0.12, 0.25, run) * amp + lerp(0.5, 1.6, run) * amp * Math.pow(swing, 1.3) };
      const ap = p + (s < 0 ? Math.PI : 0);
      arms[s] = { fwd: lerp(0.35, 0.95, run) * amp * Math.sin(ap) + 0.08 + 0.02 * breathe, out: 0.12 + 0.05 * run, elbow: lerp(0.25, 1.5, run) * Math.max(amp, 0.2) + 0.15 };
    }
    // in the air: rising, one knee up; falling, legs reaching down, arms out
    if (a.air !== null) {
      const k = clamp(a.air / 0.12, -1, 1);
      const up = Math.max(0, k);
      const down = Math.max(0, -k);
      legs[-1] = { fwd: lerp(0.35, 1.0, up), knee: lerp(0.5, 1.5, up) - 0.2 * down };
      legs[1] = { fwd: lerp(0.1, -0.25, up), knee: lerp(0.8, 0.5, up) };
      arms[-1] = { fwd: lerp(0.6, 1.3, up), out: lerp(0.3, 1.0, down), elbow: 0.5 };
      arms[1] = { fwd: lerp(0.4, 0.8, up), out: lerp(0.3, 1.0, down), elbow: 0.5 };
      lean = 0.1 * up;
      hipZ = L.hipH;
    }
    if (a.land > 0) {
      const l = a.land;
      hipZ -= 0.006 * l;
      lean += 0.3 * l;
      for (const s of [-1, 1]) {
        legs[s].fwd += 0.5 * l;
        legs[s].knee += 1.0 * l;
      }
    }
    if (a.hang) {
      const sway = Math.sin(a.time * 1.7) * 0.08;
      legs[-1] = { fwd: 0.12 + sway, knee: 0.25 };
      legs[1] = { fwd: 0.05 - sway, knee: 0.35 };
      arms[-1] = { fwd: Math.PI - 0.12, out: 0.22, elbow: 0.05 };
      arms[1] = { fwd: Math.PI - 0.12, out: 0.22, elbow: 0.05 };
      hipZ = L.hipH;
      lean = -0.04;
    }
    if (a.climb !== null) {
      const c = a.climb;
      const pull = ease(c / 0.5);
      const stand = ease((c - 0.5) / 0.5);
      for (const s of [-1, 1]) arms[s] = { fwd: lerp(Math.PI - 0.12, 0.35, pull), out: 0.3, elbow: lerp(0.05, 1.5, pull) * (1 - stand) + 0.2 * stand };
      legs[-1] = { fwd: lerp(0.1, 1.4, pull) * (1 - stand), knee: lerp(0.3, 1.9, pull) * (1 - stand) + 0.06 };
      legs[1] = { fwd: lerp(0.05, 0.3, pull) * (1 - stand), knee: lerp(0.3, 0.8, pull) * (1 - stand) + 0.06 };
      lean = lerp(0, 0.5, pull) * (1 - stand);
      hipZ = L.hipH - 0.008 * pull * (1 - stand);
    }
    if (a.hurt > 0) {
      lean -= 0.35 * a.hurt;
      arms[-1].out += 0.8 * a.hurt;
      arms[1].out += 0.8 * a.hurt;
    }
    if (a.brace > 0) {
      lean -= 0.12 * a.brace;
      twist = 0.35 * a.brace;
    }

    // sword: sweep angle s (0 = straight ahead, + = to the left), elevation e
    let sword = null;
    let guard = 0;
    if (a.attack) {
      const { n, u } = a.attack;
      let s = 0;
      let e = 0.1;
      if (n === 1) {
        s = u < 0.3 ? lerp(-0.5, -1.6, ease(u / 0.3)) : u < 0.6 ? lerp(-1.6, 1.4, ease((u - 0.3) / 0.3)) : lerp(1.4, 0.3, ease((u - 0.6) / 0.4));
        e = 0.15;
      } else if (n === 2) {
        s = u < 0.3 ? lerp(0.3, 1.5, ease(u / 0.3)) : u < 0.6 ? lerp(1.5, -1.4, ease((u - 0.3) / 0.3)) : lerp(-1.4, -0.3, ease((u - 0.6) / 0.4));
        e = 0.05;
      } else if (n === 3) {
        s = 0.15;
        e = u < 0.35 ? lerp(0.4, 2.3, ease(u / 0.35)) : u < 0.6 ? lerp(2.3, -0.55, ease((u - 0.35) / 0.25)) : lerp(-0.55, 0.3, ease((u - 0.6) / 0.4));
      } else {
        s = 0.1;
        e = u < 0.3 ? lerp(0.5, 1.9, ease(u / 0.3)) : lerp(1.9, -1.2, ease((u - 0.3) / 0.25));
      }
      sword = { s, e };
      twist = -s * 0.32;
      lean += n === 3 || n === 4 ? 0.25 * Math.max(0, -Math.sin(e)) : 0.1;
      guard = 1;
      if (a.air === null && n !== 4) {
        legs[1] = { fwd: 0.38, knee: 0.45 };
        legs[-1] = { fwd: -0.32, knee: 0.22 };
        hipZ = L.hipH - 0.0025;
      }
    } else if (a.brace > 0) {
      sword = { s: -0.4 * a.brace, e: lerp(0.4, 2.1, a.brace) }; // raised for the blow
    }

    // assemble
    const up = [Math.sin(lean), 0, Math.cos(lean)];
    const pelvis = [0, 0, hipZ];
    const rotZ = (v, ang) => [v[0] * Math.cos(ang) - v[1] * Math.sin(ang), v[0] * Math.sin(ang) + v[1] * Math.cos(ang), v[2]];
    const chest = add(pelvis, mul(up, 0.019));
    const neck = add(pelvis, mul(up, L.torso));
    const head = add(neck, mul(up, 0.0058));
    const J = { pelvis, chest, neck, head, up, hip: {}, knee: {}, ankle: {}, toe: {}, sh: {}, elbow: {}, hand: {}, twist };
    for (const s of [-1, 1]) {
      const hip = add(pelvis, [0, s * L.hipW, 0]);
      const kneeP = add(hip, mul(limbDir(legs[s].fwd, 0.03, s), L.thigh));
      const ankle = add(kneeP, mul(limbDir(legs[s].fwd - legs[s].knee, 0.03, s), L.shin));
      const footAng = Math.min(0, legs[s].fwd - legs[s].knee) * 0.5;
      J.hip[s] = hip;
      J.knee[s] = kneeP;
      J.ankle[s] = ankle;
      J.toe[s] = add(ankle, [0.0055 * Math.cos(footAng), 0, -0.0012 + 0.0055 * Math.sin(footAng)]);
      const sh = add(chest, rotZ([0, s * L.shoulderW, 0], twist));
      J.sh[s] = sh;
      const ad = limbDir(arms[s].fwd, arms[s].out, s);
      const el = add(sh, mul(ad, L.upper));
      J.elbow[s] = el;
      J.hand[s] = add(el, mul(limbDir(arms[s].fwd + arms[s].elbow, arms[s].out * 0.6, s), L.fore));
    }
    // the sword arm (right) follows the sword when it swings; the left guards
    if (sword) {
      const d = [Math.cos(sword.s) * Math.cos(sword.e), -Math.sin(sword.s) * Math.cos(sword.e), Math.sin(sword.e)];
      const target = add(J.sh[1], add(mul(d, 0.017), [0, -0.003, -0.002]));
      const sol = ik(J.sh[1], target, L.upper, L.fore, [0, 0.6, -0.8]);
      J.elbow[1] = sol.elbow;
      J.hand[1] = sol.hand;
      J.swordDir = d;
    }
    if (guard) {
      const sol = ik(J.sh[-1], add(J.chest, [0.012, -0.006, 0.004]), L.upper, L.fore, [0, -0.6, -0.8]);
      J.elbow[-1] = sol.elbow;
      J.hand[-1] = sol.hand;
    }
    if (a.armed && !J.swordDir) {
      // carried: forward and up at rest, forward and low running
      const fore = norm(sub(J.hand[1], J.elbow[1]));
      J.swordDir = norm(add(mul(fore, 0.3), [lerp(0.7, 0.6, run), lerp(0.1, 0.18, run), lerp(0.5, -0.12, run)]));
    }
    // on the ground: the lowest foot on the floor (a stride's hip dip)
    if (a.air === null && !a.hang && a.climb === null && !(a.dead > 0)) {
      let lowest = Infinity;
      for (const s of [-1, 1]) lowest = Math.min(lowest, J.ankle[s][2], J.toe[s][2]);
      const drop = lowest - 0.0012;
      const shift = (v) => [v[0], v[1], v[2] - drop];
      for (const k of ["pelvis", "chest", "neck", "head"]) J[k] = shift(J[k]);
      for (const k of ["hip", "knee", "ankle", "toe", "sh", "elbow", "hand"]) for (const s of [-1, 1]) J[k][s] = shift(J[k][s]);
    }
    // dying: tip over backward about the feet
    if (a.dead > 0) {
      const ang = -1.45 * ease(a.dead);
      const rot = (v) => [v[0] * Math.cos(ang) - v[2] * Math.sin(ang), v[1], v[0] * Math.sin(ang) + v[2] * Math.cos(ang) + 0.004 * ease(a.dead)];
      for (const k of ["pelvis", "chest", "neck", "head"]) J[k] = rot(J[k]);
      for (const k of ["hip", "knee", "ankle", "toe", "sh", "elbow", "hand"]) for (const s of [-1, 1]) J[k][s] = rot(J[k][s]);
      if (J.swordDir) J.swordDir = rot(J.swordDir);
      J.up = rot(J.up);
    }
    return J;
  }

  // Body-frame point -> floor frame [f, r, h] for a figure at (f, r, z) facing yaw.
  const placer = (f, r, z, yaw, scale = 1) => (v) => [
    f + scale * (v[0] * Math.cos(yaw) - v[1] * Math.sin(yaw)),
    r + scale * (v[0] * Math.sin(yaw) + v[1] * Math.cos(yaw)),
    z + scale * v[2],
  ];

  // Drawing primitives for a figure: segments (round-capped, `rad` thick),
  // balls and polygons, in floor-frame points; sorted far-to-near and drawn
  // with an outline and a highlight, like the pixel-art sprites elsewhere
  // but in 3D.
  function knightPrims(J, P, look, opts = {}) {
    const out = [];
    const seg = (a, b, rad, color) => out.push({ k: "seg", a: P(a), b: P(b), rad, color });
    const ball = (c, rad, color) => out.push({ k: "ball", c: P(c), rad, color });
    const fwd = [Math.cos(J.twist), Math.sin(J.twist), 0];
    const right = [-Math.sin(J.twist), Math.cos(J.twist), 0];
    // cape: from between the shoulders down to the hips, flowing back with
    // speed, a little wider at the hem, with two folds
    const back = mul(fwd, -1);
    const flow = 0.004 + clamp(opts.speed || 0, 0, RUN_V) * 0.07;
    const flutter = Math.sin((opts.time || 0) * 9) * 0.0015 * clamp((opts.speed || 0) / RUN_V, 0, 1);
    const neckBack = add(J.chest, mul(back, 0.0045));
    const top = [add(neckBack, mul(right, -0.0048)), add(neckBack, mul(right, 0.0048))];
    const low = add(add(J.pelvis, mul(back, flow)), [0, 0, 0.001 + flow * 0.4 + flutter]);
    const hem = [add(low, mul(right, -0.0062)), add(low, mul(right, 0.0062))];
    const fold = (k) => [P(add(mul(top[0], 1 - k), mul(top[1], k))), P(add(mul(hem[0], 1 - k), mul(hem[1], k)))];
    out.push({ k: "poly", pts: [P(top[0]), P(top[1]), P(hem[1]), P(hem[0])], color: look.cape, lines: [fold(0.33), fold(0.67)], lineColor: "rgba(60,0,0,0.55)" });
    for (const s of [-1, 1]) {
      seg(J.hip[s], J.knee[s], 0.0026, look.legs);
      seg(J.knee[s], J.ankle[s], 0.0022, look.legs);
      seg(J.ankle[s], J.toe[s], 0.0019, look.boots);
    }
    seg(J.pelvis, J.chest, 0.0058, look.tunic);
    seg(add(J.pelvis, mul(J.up, 0.002)), add(J.pelvis, mul(J.up, 0.0045)), 0.0061, look.belt);
    seg(J.sh[-1], J.sh[1], 0.0032, look.mail);
    seg(J.chest, J.neck, 0.0021, look.neck);
    for (const s of [-1, 1]) {
      seg(J.sh[s], J.elbow[s], 0.0019, look.mail);
      seg(J.elbow[s], J.hand[s], 0.0016, look.mail);
      ball(J.hand[s], 0.0018, look.glove);
    }
    ball(J.head, 0.0052, look.helmet);
    const face = add(J.head, mul(fwd, 0.0046));
    seg(add(face, mul(right, -0.0026)), add(face, mul(right, 0.0026)), 0.0009, look.visor);
    seg(add(J.head, [0, 0, 0.0048]), add(add(J.head, [0, 0, 0.0062]), mul(fwd, -0.0062)), 0.0014, look.plume);
    if (J.swordDir) swordPrims(out, J.hand[1], J.swordDir, 0.017, P, look);
    return out;
  }
  function swordPrims(out, hand, d, length, P, look) {
    const side = norm(cross(d, [0, 0, 1]));
    const perp = len3(side) > 0.1 ? side : [0, 1, 0];
    out.push({ k: "seg", a: P(add(hand, mul(d, 0.0015))), b: P(add(hand, mul(d, length))), rad: 0.0007, color: look.blade, shine: true });
    out.push({ k: "seg", a: P(add(add(hand, mul(d, 0.0015)), mul(perp, -0.0035))), b: P(add(add(hand, mul(d, 0.0015)), mul(perp, 0.0035))), rad: 0.0006, color: look.hilt });
    out.push({ k: "seg", a: P(add(hand, mul(d, -0.003))), b: P(hand), rad: 0.0007, color: look.grip });
    out.push({ k: "ball", c: P(add(hand, mul(d, -0.0036))), rad: 0.0009, color: look.hilt });
  }
  function skeletonPrims(J, P, look, opts = {}) {
    const out = [];
    const seg = (a, b, rad, color) => out.push({ k: "seg", a: P(a), b: P(b), rad, color });
    const ball = (c, rad, color) => out.push({ k: "ball", c: P(c), rad, color });
    const fwd = [Math.cos(J.twist), Math.sin(J.twist), 0];
    const right = [-Math.sin(J.twist), Math.cos(J.twist), 0];
    const armored = !!look.armor;
    for (const s of [-1, 1]) {
      seg(J.hip[s], J.knee[s], armored ? 0.0024 : 0.0013, armored ? look.armor : look.bone);
      seg(J.knee[s], J.ankle[s], armored ? 0.002 : 0.0012, look.bone);
      seg(J.ankle[s], J.toe[s], 0.0012, armored ? look.armor : look.bone);
    }
    seg(J.hip[-1], J.hip[1], 0.0018, look.bone);
    seg(J.pelvis, J.neck, 0.0012, look.bone); // spine
    if (armored) {
      seg(add(J.pelvis, mul(J.up, 0.004)), add(J.pelvis, mul(J.up, 0.017)), 0.0068, look.armor);
      seg(add(J.pelvis, mul(J.up, 0.004)), add(J.pelvis, mul(J.up, 0.006)), 0.0071, look.trim);
    } else {
      seg(add(J.pelvis, mul(J.up, 0.009)), add(J.pelvis, mul(J.up, 0.018)), 0.0042, look.bone); // ribcage
      for (const k of [0.011, 0.014, 0.017]) {
        const c = add(J.pelvis, mul(J.up, k));
        seg(add(c, mul(right, -0.0047)), add(c, mul(right, 0.0047)), 0.0006, look.socket);
      }
    }
    seg(J.sh[-1], J.sh[1], armored ? 0.0034 : 0.0011, armored ? look.armor : look.bone);
    for (const s of [-1, 1]) {
      seg(J.sh[s], J.elbow[s], armored ? 0.0018 : 0.0011, look.bone);
      seg(J.elbow[s], J.hand[s], armored ? 0.0016 : 0.001, look.bone);
      ball(J.hand[s], 0.0013, look.bone);
    }
    ball(J.head, armored ? 0.0056 : 0.0048, armored ? look.armor : look.bone);
    if (armored) {
      for (const s of [-1, 1]) seg(add(J.head, add(mul(right, s * 0.004), [0, 0, 0.003])), add(J.head, add(mul(right, s * 0.0085), [0, 0, 0.0085])), 0.0011, look.horn);
    }
    const face = add(J.head, mul(fwd, armored ? 0.005 : 0.0042));
    for (const s of [-1, 1]) ball(add(add(face, mul(right, s * 0.0017)), [0, 0, 0.0008]), 0.0011, opts.angry ? look.eye : look.socket);
    if (!armored) seg(add(face, [0, 0, -0.0025]), add(face, [0, 0, -0.0028]), 0.0012, look.socket); // jaw
    if (J.swordDir) swordPrims(out, J.hand[1], J.swordDir, armored ? 0.024 : 0.016, P, look);
    return out;
  }

  // Draws a figure's primitives (floor-frame points) through world3d.
  function drawPrims(w, prims, ar, outline, alpha = 1, flash = 0) {
    const c = ar.ctx;
    const items = [];
    prims.forEach((p) => {
      if (p.k === "seg") {
        const a = w.project(...p.a);
        const b = w.project(...p.b);
        if (a && b) items.push({ p, a, b, z: (a.depth + b.depth) / 2 });
      } else if (p.k === "ball") {
        const s = w.project(...p.c);
        if (s) items.push({ p, s, z: s.depth });
      } else {
        const pts = p.pts.map((q) => w.project(...q));
        if (pts.every(Boolean)) items.push({ p, pts, z: pts.reduce((m, q) => m + q.depth, 0) / pts.length });
      }
    });
    items.sort((x, y) => y.z - x.z);
    c.save();
    c.globalAlpha *= alpha;
    c.lineCap = "round";
    c.lineJoin = "round";
    items.forEach((it) => {
      const col = flash > 0 ? mix(it.p.color, "#ffffff", flash) : it.p.color;
      if (it.p.k === "seg") {
        const width = Math.max(1, 2 * it.p.rad * (it.a.ppm + it.b.ppm) / 2);
        const line = (color, wd, dx = 0, dy = 0) => {
          c.strokeStyle = color;
          c.lineWidth = wd;
          c.beginPath();
          c.moveTo(it.a.x + dx, it.a.y + dy);
          c.lineTo(it.b.x + dx, it.b.y + dy);
          c.stroke();
        };
        line(outline, width + Math.min(3, 1 + width * 0.25));
        line(col, width);
        if (width > 3) line(it.p.shine ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.28)", width * 0.35, -width * 0.18, -width * 0.2);
      } else if (it.p.k === "ball") {
        const rad = Math.max(1, it.p.rad * it.s.ppm);
        c.beginPath();
        c.arc(it.s.x, it.s.y, rad + Math.min(1.5, 0.5 + rad * 0.12), 0, 2 * Math.PI);
        c.fillStyle = outline;
        c.fill();
        c.beginPath();
        c.arc(it.s.x, it.s.y, rad, 0, 2 * Math.PI);
        c.fillStyle = col;
        c.fill();
        if (rad > 3) {
          c.beginPath();
          c.arc(it.s.x - rad * 0.3, it.s.y - rad * 0.35, rad * 0.35, 0, 2 * Math.PI);
          c.fillStyle = "rgba(255,255,255,0.3)";
          c.fill();
        }
      } else {
        c.beginPath();
        it.pts.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));
        c.closePath();
        c.fillStyle = col;
        c.fill();
        c.strokeStyle = outline;
        c.lineWidth = 1.5;
        c.stroke();
        (it.p.lines || []).forEach(([a, b]) => {
          const pa = w.project(...a);
          const pb = w.project(...b);
          if (!pa || !pb) return;
          c.strokeStyle = it.p.lineColor;
          c.lineWidth = Math.max(1, 0.0007 * pa.ppm);
          c.beginPath();
          c.moveTo(pa.x, pa.y);
          c.lineTo(pb.x, pb.y);
          c.stroke();
        });
      }
    });
    c.restore();
  }
  function mix(hex, other, t) {
    if (!hex || hex[0] !== "#") return hex;
    const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    const a = p(hex);
    const b = p(other);
    return `rgb(${a.map((v, i) => Math.round(lerp(v, b[i], t))).join(",")})`;
  }

  // The knight -- body, animation, drawing, moves -- for other games (game_knightblocks.js).
  Lynx.knightKit = {
    bodyJoints, knightPrims, placer, drawPrims, KNIGHT_LOOK,
    C: {
      BODY_H, BODY_R, STEP_UP, AIR_STEP_UP, GRAVITY, JUMP_V, WALK_V, RUN_V, ACCEL, DECEL, AIR_ACCEL, TURN_RATE, COYOTE_S, JUMP_BUFFER_S,
      MANTLE_MIN, GRAB_MIN, GRAB_MAX, HANG_DROP, CLIMB_S, SHIMMY_V, FALL_HURT_M, SWINGS, CAM_DIST, ORBIT_RATE, BEHIND_RATE, GOTO_EVERY_MS, GOTO_MOVE_M,
    },
    util: { clamp, lerp, ease, wrap, approach },
  };

  const DIFF_RANK = { easy: 0, normal: 1, hard: 2 };

  Lynx.games.knight = (ar, cfg) => {
    const diffKey = cfg.difficulty in DIFFICULTY ? cfg.difficulty : "normal";
    const D = DIFFICULTY[diffKey];
    const maxHearts = clamp(Math.round(+cfg.hearts) || 5, 1, 9);
    const camDist = clamp((+cfg.camDistCm || CAM_DIST * 100) / 100, 0.1, 0.3);
    const firstLevel = clamp(Math.round(+cfg.startLevel) || 1, 1, LEVELS.length);
    const w = Lynx.world3d(ar, { textures: cfg.textures !== false });

    let state = "title"; // title | playing | dead | levelDone | won
    let stateTime = 0;
    let time = 0;
    let levelN = firstLevel;
    let L = null; // the level being played
    let score = 0;
    let levelStartScore = 0;
    let hearts = maxHearts;
    let levelTime = 0;
    let note = null; // {text, color, t}
    let godMode = false;
    let gates = [];
    let levers = [];
    let plates = [];
    let crates = [];
    let movers = [];
    let coins = [];
    let checkpoints = [];
    let enemies = [];
    let goal = null;
    let respawn = null;
    let sparks = [];
    const hero = {
      f: 0, r: 0, z: 0, vf: 0, vr: 0, vz: 0, yaw: 0, onGround: true, standOn: null, mode: "move", coyote: 0, jumpBuf: 0, fallFrom: 0,
      hang: null, climb: null, attack: null, attackQueued: false, inv: 0, hurtT: 0, landT: 0, phase: 0, speed: 0, deadT: 0, push: null,
      pushT: 0, pushing: null, pushLost: 0, grabCool: 0, towardT: 0,
    };
    // the robot: bearing b (floor frame) from the knight to where it should be
    const cam = { b: Math.PI, behind: false, orbitAt: -1e9, tiltOff: 0, aimYaw: null, aimTilt: 0, aimPt: null, lastGoto: null, lastGotoMs: -1e9, lastAimMs: -1e9 };

    const say = (text, color = "#ffe080") => (note = { text, color, t: 0 });
    const sfx = (name) => Lynx.sfx.play(name);

    // -- the level ---------------------------------------------------------------------------------
    function loadLevel(n) {
      levelN = n;
      L = LEVELS[n - 1];
      // laid out from where the camera is now, facing where it looks
      const cw = ar.cameraWorld();
      w.setAnchor({ x: cw.x, y: cw.y, th: ar.camTheta });
      gates = L.gates.map((g) => ({ ...g, h0: 0, open: 0, target: 0, gate: true }));
      levers = L.levers.map((l) => ({ ...l, on: false, t: 0 }));
      plates = L.plates.map((p) => ({ ...p, down: false }));
      crates = L.crates.map((c) => ({ f0: c.f - c.size / 2, f1: c.f + c.size / 2, r0: c.r - c.size / 2, r1: c.r + c.size / 2, h0: 0, h1: c.size, crate: true }));
      movers = L.movers.map((m) => ({ ...m, base: { f0: m.f0, f1: m.f1, r0: m.r0, r1: m.r1, h0: m.h0, h1: m.h1 }, t: 0, step: [0, 0, 0], mover: true }));
      coins = L.coins.map(([f, r, h]) => ({ f, r, h, taken: false }));
      checkpoints = L.checkpoints.map((c) => ({ ...c, on: false }));
      enemies = L.enemies.filter((e) => !e.minDiff || DIFF_RANK[diffKey] >= DIFF_RANK[e.minDiff]).map((e) => {
        const def = ENEMY[e.kind];
        return {
          kind: e.kind, def, f: e.f, r: e.r, z: e.h || 0, yaw: Math.PI, hp: Math.max(1, Math.round(def.hp * D.enemyHp)), state: "idle", t: 0,
          home: { f: e.f, r: e.r }, phase: Math.random() * 6, speed: 0, flash: 0, deadT: 0, kf: 0, kr: 0, struck: false,
        };
      });
      goal = { ...L.goal, taken: false };
      respawn = { f: L.spawn.f, r: L.spawn.r, z: 0, yaw: L.spawn.yaw };
      placeHero(respawn);
      levelTime = 0;
      levelStartScore = score;
      cam.behind = false;
      cam.aimPt = null;
      const rl = w.toLocal(cw.x, cw.y);
      cam.b = Math.atan2(rl.r - hero.r, rl.f - hero.f);
      say(L.intro);
    }
    function placeHero(p) {
      Object.assign(hero, {
        f: p.f, r: p.r, z: p.z, yaw: p.yaw, vf: 0, vr: 0, vz: 0, onGround: true, standOn: null, mode: "move", hang: null, climb: null,
        attack: null, attackQueued: false, hurtT: 0, landT: 0, deadT: 0, fallFrom: p.z, jumpBuf: 0, coyote: 0, grabCool: 0, pushing: null, pushT: 0,
      });
    }

    // Everything solid now: blocks, shut gates, crates, platforms (and,
    // one day, real objects found by their AR tags).
    function solids() {
      const out = L.blocks.slice();
      gates.forEach((g) => g.open < 0.85 && out.push(g));
      crates.forEach((c) => out.push(c));
      movers.forEach((m) => out.push(m));
      return out;
    }
    const inPit = (f, r) => L.pits.some((p) => inRect(f, r, p));
    // the highest surface under a body at (f, r) that it can stand on from z
    function groundAt(f, r, z, rad = BODY_R * 0.6, list = solids(), up = STEP_UP) {
      let best = inPit(f, r) ? { h: -Infinity, ref: null } : { h: 0, ref: null };
      for (const s of list) {
        if (s.h1 > z + up + 1e-6) continue;
        if (f <= s.f0 - rad || f >= s.f1 + rad || r <= s.r0 - rad || r >= s.r1 + rad) continue;
        if (s.h1 > best.h) best = { h: s.h1, ref: s };
      }
      return best;
    }
    const gateOpen = (id) => gates.some((g) => g.id === id && g.open > 0.85);

    // -- the knight ------------------------------------------------------------------------------------
    function stickInput() {
      const d = Lynx.control.driveInput();
      const m = clamp(Math.hypot(d.j1, d.j2) / 0.8, 0, 1);
      if (m < 0.06) return { df: 0, dr: 0, speed: 0, m: 0 };
      const cy = w.anchor().th - ar.camTheta; // the view's heading in the floor frame (+ = to the right)
      const n = Math.hypot(d.j1, d.j2);
      const df = (d.j2 * Math.cos(cy) - d.j1 * Math.sin(cy)) / n;
      const dr = (d.j2 * Math.sin(cy) + d.j1 * Math.cos(cy)) / n;
      const speed = m <= 0.55 ? (WALK_V * m) / 0.55 : WALK_V + ((RUN_V - WALK_V) * (m - 0.55)) / 0.45;
      return { df, dr, speed, m };
    }

    function stepHero(dt) {
      const h = hero;
      h.inv = Math.max(0, h.inv - dt);
      h.hurtT = Math.max(0, h.hurtT - dt);
      h.landT = Math.max(0, h.landT - dt);
      h.grabCool = Math.max(0, h.grabCool - dt);
      h.jumpBuf -= dt;
      h.coyote -= dt;
      if (h.mode === "dead") {
        h.deadT += dt;
        return;
      }
      if (h.mode === "hang") return stepHang(dt);
      if (h.mode === "climb") return stepClimb(dt);
      // carried by a platform
      if (h.onGround && h.standOn && h.standOn.mover) {
        h.f += h.standOn.step[0];
        h.r += h.standOn.step[1];
        h.z += h.standOn.step[2];
      }
      const inp = stickInput();
      let tvf = inp.df * inp.speed;
      let tvr = inp.dr * inp.speed;
      if (h.attack && h.onGround) {
        tvf *= 0.25;
        tvr *= 0.25;
      }
      if (h.hurtT > 0) {
        tvf = h.vf;
        tvr = h.vr;
      }
      // speed up / slow down toward the stick
      const acc = h.onGround ? (inp.speed > 0.001 ? ACCEL : DECEL) : AIR_ACCEL;
      const dvf = tvf - h.vf;
      const dvr = tvr - h.vr;
      const dv = Math.hypot(dvf, dvr);
      const maxDv = acc * dt;
      if (dv > maxDv) {
        h.vf += (dvf / dv) * maxDv;
        h.vr += (dvr / dv) * maxDv;
      } else {
        h.vf = tvf;
        h.vr = tvr;
      }
      // pushing a crate: lean into it a moment, then it slides and the
      // knight walks along behind it (contact can flicker for a step)
      const pressing = h.push && h.onGround && inp.speed > 0.02 && -(inp.df * h.push.nf + inp.dr * h.push.nr) > 0.7;
      if (pressing) {
        h.pushing = h.push;
        h.pushLost = 0;
        h.pushT += dt;
      } else if (h.pushing) {
        h.pushLost += dt;
        if (h.pushLost > 0.15 || inp.speed <= 0.02) {
          h.pushing = null;
          h.pushT = 0;
        }
      }
      if (h.pushing && h.pushT > CRATE_DELAY_S) {
        const p = h.pushing;
        if (moveCrate(p.crate, -p.nf * PUSH_V * dt, -p.nr * PUSH_V * dt)) {
          h.vf = tvf = -p.nf * PUSH_V;
          h.vr = tvr = -p.nr * PUSH_V;
        }
      }
      // face where you go (not mid-swing)
      if (inp.speed > 0.004 && !(h.attack && h.attack.u > 0.15 && h.attack.n !== 4) && h.hurtT <= 0) {
        const target = Math.atan2(inp.dr, inp.df);
        h.yaw = wrap(h.yaw + clamp(wrap(target - h.yaw), -TURN_RATE * dt, TURN_RATE * dt));
      }
      // jump (buffered; a moment's grace after walking off an edge)
      if (h.jumpBuf > 0 && (h.onGround || h.coyote > 0) && h.hurtT <= 0) {
        h.vz = JUMP_V;
        h.onGround = false;
        h.standOn = null;
        h.coyote = 0;
        h.jumpBuf = 0;
        h.fallFrom = h.z;
        if (h.attack && h.attack.n !== 4) h.attack = null;
        sfx("jump");
      }
      if (!h.onGround) {
        h.vz -= GRAVITY * dt;
        h.z += h.vz * dt;
      }
      h.f += h.vf * dt;
      h.r += h.vr * dt;
      const list = solids();
      const up = h.onGround ? STEP_UP : AIR_STEP_UP; // steps are walked onto, not jumped onto
      collideHero(list, up);
      // the ground
      const g = groundAt(h.f, h.r, h.z, BODY_R * 0.6, list, up);
      if (h.onGround) {
        if (g.h >= h.z - 0.006) {
          h.z = g.h;
          h.standOn = g.ref;
        } else {
          h.onGround = false;
          h.standOn = null;
          h.coyote = COYOTE_S;
          h.vz = 0;
          h.fallFrom = h.z;
        }
      } else {
        h.fallFrom = Math.max(h.fallFrom, h.z);
        // a ceiling stops a jump
        if (h.vz > 0) {
          for (const s of list) {
            if (s.h0 > h.z + 0.01 && s.h0 < h.z + BODY_H && inRect(h.f, h.r, s, BODY_R * 0.5)) {
              h.z = s.h0 - BODY_H;
              h.vz = 0;
            }
          }
        }
        if (h.vz <= 0 && h.z <= g.h) {
          land(g);
        } else if (h.vz < 0.07 && h.grabCool <= 0 && !h.attack) tryGrab(list);
      }
      // the level's edges
      const B = L.bounds;
      h.f = clamp(h.f, B.f0, B.f1);
      h.r = clamp(h.r, B.r0, B.r1);
      // down in a chasm: its walls hold you in it
      if (h.z < -0.003) {
        const pit = L.pits.find((p) => inRect(h.f, h.r, p, BODY_R * 2));
        if (pit) {
          h.f = clamp(h.f, pit.f0 + 0.001, pit.f1 - 0.001);
          h.r = clamp(h.r, pit.r0 + 0.001, pit.r1 - 0.001);
        }
      }
      if (h.z < VOID_Z) fellOff();
      // hazards and pickups
      if (h.z < 0.008 && L.spikes.some((q) => inRect(h.f, h.r, q)) && groundAt(h.f, h.r, h.z, BODY_R * 0.6, list).ref === null) {
        hurtHero(null, "Spikes!");
        h.vz = 0.12;
        h.onGround = false;
      }
      updateAttack(dt);
    }

    function land(g) {
      const h = hero;
      const drop = h.fallFrom - g.h;
      h.z = g.h;
      h.vz = 0;
      h.onGround = true;
      h.standOn = g.ref;
      h.landT = clamp(drop * 4, 0.05, 0.18);
      if (h.attack && h.attack.n === 4) plungeLanding();
      if (drop > FALL_HURT_M) hurtHero(null, "A long fall!");
      else if (drop > 0.02) sfx("knock");
      if (h.jumpBuf > 0 && h.hurtT <= 0) {
        // a jump pressed just before landing
        h.vz = JUMP_V;
        h.onGround = false;
        h.standOn = null;
        h.jumpBuf = 0;
        h.fallFrom = h.z;
        sfx("jump");
      }
    }

    function collideHero(list, up) {
      const h = hero;
      h.push = null;
      for (const s of list) {
        if (s.h1 <= h.z + up || s.h0 >= h.z + BODY_H - 0.004) continue;
        const f0 = s.f0 - BODY_R;
        const f1 = s.f1 + BODY_R;
        const r0 = s.r0 - BODY_R;
        const r1 = s.r1 + BODY_R;
        if (h.f <= f0 || h.f >= f1 || h.r <= r0 || h.r >= r1) continue;
        const pen = [[h.f - f0, -1, 0], [f1 - h.f, 1, 0], [h.r - r0, 0, -1], [r1 - h.r, 0, 1]];
        pen.sort((a, b) => a[0] - b[0]);
        const [d, nf, nr] = pen[0];
        h.f += nf * d;
        h.r += nr * d;
        const vn = h.vf * nf + h.vr * nr;
        if (vn < 0) {
          h.vf -= vn * nf;
          h.vr -= vn * nr;
        }
        if (s.crate) h.push = { crate: s, nf, nr };
      }
    }

    // A crate slides if nothing's in the way (and it doesn't go over a chasm).
    function moveCrate(c, df, dr) {
      const n = { f0: c.f0 + df, f1: c.f1 + df, r0: c.r0 + dr, r1: c.r1 + dr };
      const cf = (n.f0 + n.f1) / 2;
      const cr = (n.r0 + n.r1) / 2;
      if (inPit(cf, cr) || !inRect(cf, cr, L.bounds)) return false;
      for (const s of solids()) {
        if (s === c || s.h1 <= c.h0 + 0.002 || s.h0 >= c.h1) continue;
        if (n.f0 < s.f1 && n.f1 > s.f0 && n.r0 < s.r1 && n.r1 > s.r0) return false;
      }
      if (enemies.some((e) => e.state !== "dead" && inRect(e.f, e.r, n, 0.005))) return false;
      Object.assign(c, n);
      return true;
    }

    // -- ledges --------------------------------------------------------------------------------
    function tryGrab(list) {
      const h = hero;
      const fx = Math.cos(h.yaw);
      const fy = Math.sin(h.yaw);
      const pf = h.f + fx * (BODY_R + 0.005);
      const pr = h.r + fy * (BODY_R + 0.005);
      for (const s of list) {
        if (s.mover || s.gate || !inRect(pf, pr, s)) continue;
        const rise = s.h1 - h.z;
        if (rise < MANTLE_MIN || rise > GRAB_MAX) continue;
        // room on top to climb onto
        if (list.some((o) => o !== s && inRect(pf, pr, o, 0.004) && o.h0 < s.h1 + BODY_H && o.h1 > s.h1 + 0.002)) continue;
        // the face you're hanging from: the one facing you
        const faces = [];
        if (h.f <= s.f0) faces.push([-1, 0]);
        if (h.f >= s.f1) faces.push([1, 0]);
        if (h.r <= s.r0) faces.push([0, -1]);
        if (h.r >= s.r1) faces.push([0, 1]);
        if (!faces.length) continue;
        faces.sort((a, b) => a[0] * fx + a[1] * fy - (b[0] * fx + b[1] * fy));
        const [nf, nr] = faces[0];
        if (nf * fx + nr * fy > -0.4) continue; // not facing it
        if (nf) {
          h.f = (nf < 0 ? s.f0 : s.f1) + nf * (BODY_R + 0.0008);
          h.r = clamp(h.r, s.r0 + 0.004, s.r1 - 0.004);
        } else {
          h.r = (nr < 0 ? s.r0 : s.r1) + nr * (BODY_R + 0.0008);
          h.f = clamp(h.f, s.f0 + 0.004, s.f1 - 0.004);
        }
        h.yaw = Math.atan2(-nr, -nf);
        h.attack = null;
        if (rise < GRAB_MIN) {
          // waist high: vault straight on
          startClimb(s, nf, nr, rise);
          return;
        }
        h.mode = "hang";
        h.hang = { s, nf, nr, t: 0 };
        h.z = s.h1 - HANG_DROP;
        h.vf = h.vr = h.vz = 0;
        h.yaw = Math.atan2(-nr, -nf);
        h.attack = null;
        h.towardT = 0;
        sfx("click");
        return;
      }
    }
    function stepHang(dt) {
      const h = hero;
      const g = h.hang;
      g.t += dt;
      const s = g.s;
      if (s.crate) h.z = s.h1 - HANG_DROP; // (a crate doesn't move while you hang on it, but just in case)
      const inp = stickInput();
      const toward = -(inp.df * g.nf + inp.dr * g.nr) * inp.m;
      const along = (inp.df * -g.nr + inp.dr * g.nf) * inp.m; // tangent: the face's normal turned right
      h.towardT = toward > 0.5 ? h.towardT + dt : 0;
      if ((h.jumpBuf > 0 || h.towardT > 0.18) && g.t > 0.2) {
        h.jumpBuf = 0;
        startClimb(s, g.nf, g.nr, HANG_DROP);
        return;
      }
      if (toward < -0.5 && g.t > 0.2) {
        dropHang(0.02);
        return;
      }
      if (Math.abs(along) > 0.3) {
        const tf = -g.nr;
        const tr = g.nf;
        const k = Math.sign(along) * SHIMMY_V * dt;
        if (g.nf) h.r = clamp(h.r + tr * k, s.r0 + 0.004, s.r1 - 0.004);
        else h.f = clamp(h.f + tf * k, s.f0 + 0.004, s.f1 - 0.004);
        h.phase += dt * 6;
      }
    }
    function dropHang(push) {
      const h = hero;
      const g = h.hang;
      h.mode = "move";
      h.onGround = false;
      h.vz = 0;
      h.vf = g.nf * push;
      h.vr = g.nr * push;
      h.fallFrom = h.z;
      h.hang = null;
      h.grabCool = 0.35;
    }
    // Up onto a ledge `rise` above the feet (from hanging: HANG_DROP): a
    // lower one takes less time, its animation starting part-way.
    function startClimb(s, nf, nr, rise) {
      const h = hero;
      const into = BODY_R + 0.006;
      const k = clamp(rise / HANG_DROP, 0, 1);
      h.mode = "climb";
      h.vf = h.vr = h.vz = 0;
      h.climb = {
        t: 0, dur: CLIMB_S * (0.35 + 0.65 * k), a0: 0.5 * (1 - k), anim: 0.5 * (1 - k), s,
        from: { f: h.f, r: h.r, z: h.z }, to: { f: h.f - nf * (BODY_R + 0.0008 + into), r: h.r - nr * (BODY_R + 0.0008 + into), z: s.h1 },
      };
      sfx(k > 0.6 ? "jump" : "click");
    }
    function stepClimb(dt) {
      const h = hero;
      const c = h.climb;
      c.t += dt / c.dur;
      c.anim = c.a0 + (1 - c.a0) * Math.min(1, c.t);
      const rise = ease(c.t / 0.6);
      const over = ease((c.t - 0.4) / 0.6);
      h.z = lerp(c.from.z, c.to.z, rise);
      h.f = lerp(c.from.f, c.to.f, over);
      h.r = lerp(c.from.r, c.to.r, over);
      if (c.t >= 1) {
        h.mode = "move";
        h.climb = null;
        h.hang = null;
        h.onGround = true;
        h.standOn = c.s;
        h.z = c.to.z;
        h.vf = h.vr = h.vz = 0;
      }
    }

    // -- the sword ---------------------------------------------------------------------------------
    function attackPressed() {
      const h = hero;
      if (h.mode !== "move" || h.hurtT > 0) return;
      if (!h.onGround) {
        if (!h.attack && h.z > 0.015) {
          h.attack = { n: 4, u: 0, hit: new Set(), landT: 0 };
          h.vz = Math.min(h.vz, -0.06);
          sfx("swing");
        }
        return;
      }
      if (!h.attack) startSwing(1);
      else if (h.attack.n < 3 && h.attack.u > 0.2) h.attackQueued = true;
    }
    function startSwing(n) {
      const h = hero;
      h.attack = { n, u: 0, hit: new Set() };
      h.attackQueued = false;
      // a step into the blow
      h.vf += Math.cos(h.yaw) * 0.05;
      h.vr += Math.sin(h.yaw) * 0.05;
      sfx("swing");
    }
    function updateAttack(dt) {
      const h = hero;
      const a = h.attack;
      if (!a) return;
      if (a.n === 4) {
        a.u = Math.min(0.55, a.u + dt / 0.45);
        if (a.landT > 0) {
          a.landT -= dt;
          if (a.landT <= 0) h.attack = null;
        }
        return;
      }
      a.u += dt / SWINGS[a.n];
      const [w0, w1] = HIT_WINDOW[a.n];
      if (a.u >= w0 && a.u <= w1) swordHits(a, a.n === 3 ? 2 : 1, a.n === 3 ? 0.9 : 1.35);
      if (a.u >= 1) {
        if (a.attackQueued || h.attackQueued) startSwing(a.n + 1);
        else h.attack = null;
      }
    }
    function plungeLanding() {
      const a = hero.attack;
      a.landT = 0.2;
      a.u = 0.55;
      sfx("crate");
      swordHits(a, 2, Math.PI, 0.036);
    }
    function swordHits(a, dmg, arc, reach = REACH) {
      const h = hero;
      enemies.forEach((e) => {
        if (e.state === "dead" || a.hit.has(e)) return;
        const df = e.f - h.f;
        const dr = e.r - h.r;
        const dist = Math.hypot(df, dr);
        if (dist > reach + 0.006 * e.def.scale || Math.abs(e.z - h.z) > 0.035) return;
        if (Math.abs(wrap(Math.atan2(dr, df) - h.yaw)) > arc) return;
        a.hit.add(e);
        hitEnemy(e, dmg, df / (dist || 1), dr / (dist || 1));
      });
      levers.forEach((l) => {
        if (l.on || a.hit.has(l)) return;
        const df = l.f - h.f;
        const dr = l.r - h.r;
        if (Math.hypot(df, dr) > reach + 0.006 || Math.abs(l.h - h.z) > 0.03) return;
        if (Math.abs(wrap(Math.atan2(dr, df) - h.yaw)) > arc) return;
        a.hit.add(l);
        l.on = true;
        sfx("gate");
        gates.forEach((g) => g.by === l.id && (g.target = 1));
        say("The lever! A gate opens");
      });
    }

    function hitEnemy(e, dmg, nf, nr) {
      e.hp -= dmg;
      e.flash = 0.15;
      e.kf = nf * 0.09;
      e.kr = nr * 0.09;
      sparks.push({ f: (hero.f + e.f) / 2, r: (hero.r + e.r) / 2, h: e.z + 0.04 * e.def.scale, t: 0 });
      if (e.hp <= 0) {
        e.state = "dead";
        e.deadT = 0;
        score += e.def.score;
        sfx("die");
        if (L.gates.some((g) => g.by === "enemies") && enemies.every((x) => x.state === "dead")) {
          gates.forEach((g) => g.by === "enemies" && (g.target = 1));
          sfx("gate");
          say("The guardians are beaten -- the gate opens!");
        }
        return;
      }
      sfx("knock");
      // a skeleton's wind-up breaks when it's hit; the brute's doesn't
      if (e.kind === "skeleton" || e.state !== "windup") {
        e.state = "stagger";
        e.t = 0;
      }
    }

    function hurtHero(from, why) {
      const h = hero;
      if (h.inv > 0 || godMode || h.mode === "dead") return;
      hearts--;
      h.inv = INVULN_S;
      h.hurtT = 0.35;
      sfx("hurt");
      if (why) say(why, "#ff8080");
      if (h.mode === "hang" || h.mode === "climb") {
        h.mode = "hang";
        h.climb = null;
        if (h.hang) dropHang(0.03);
      }
      if (from) {
        const df = h.f - from.f;
        const dr = h.r - from.r;
        const d = Math.hypot(df, dr) || 1;
        h.vf = (df / d) * 0.14;
        h.vr = (dr / d) * 0.14;
        if (h.onGround) {
          h.vz = 0.09;
          h.onGround = false;
          h.standOn = null;
          h.fallFrom = h.z;
        }
      }
      h.attack = null;
      if (hearts <= 0) die();
    }
    function die() {
      const h = hero;
      hearts = 0;
      h.mode = "dead";
      h.deadT = 0;
      state = "dead";
      stateTime = 0;
      sfx("lose");
      Lynx.submitScore("knight", score).catch(() => {});
    }
    function fellOff() {
      if (godMode) {
        placeHero(respawn);
        return;
      }
      hearts--;
      sfx("fail");
      if (hearts <= 0) {
        die();
        return;
      }
      say("You fell! Back to the last flag", "#ff8080");
      placeHero(respawn);
      hero.inv = 1;
    }

    // -- enemies --------------------------------------------------------------------------------
    function enemyGroundOk(e, f, r) {
      const g = groundAt(f, r, e.z + 0.002, 0.003);
      if (Math.abs(g.h - e.z) > 0.004) return false; // never off its own level
      const rad = 0.006 * e.def.scale;
      for (const s of solids()) {
        if (s.h1 <= e.z + STEP_UP || s.h0 >= e.z + BODY_H * e.def.scale) continue;
        if (f > s.f0 - rad && f < s.f1 + rad && r > s.r0 - rad && r < s.r1 + rad) return false;
      }
      return inRect(f, r, L.bounds);
    }
    function moveEnemy(e, df, dr) {
      if (enemyGroundOk(e, e.f + df, e.r)) e.f += df;
      if (enemyGroundOk(e, e.f, e.r + dr)) e.r += dr;
    }
    function stepEnemy(e, dt) {
      const def = e.def;
      e.flash = Math.max(0, e.flash - dt);
      if (e.state === "dead") {
        e.deadT += dt;
        return;
      }
      e.t += dt;
      // knocked back
      if (Math.abs(e.kf) + Math.abs(e.kr) > 1e-4) {
        moveEnemy(e, e.kf * dt, e.kr * dt);
        const k = Math.exp(-8 * dt);
        e.kf *= k;
        e.kr *= k;
      }
      const h = hero;
      const df = h.f - e.f;
      const dr = h.r - e.r;
      const dist = Math.hypot(df, dr);
      const toHero = Math.atan2(dr, df);
      const sameLevel = Math.abs(h.z - e.z) < 0.035;
      const sees = h.mode !== "dead" && state === "playing" && dist < def.sight && sameLevel;
      const turn = (target, rate) => (e.yaw = wrap(e.yaw + clamp(wrap(target - e.yaw), -rate * dt, rate * dt)));
      const speed = def.speed * D.speed;
      e.speed = 0;
      if (e.state === "idle") {
        if (sees) {
          e.state = "chase";
          e.t = 0;
          sfx("growl");
        } else {
          const hf = e.home.f - e.f;
          const hr = e.home.r - e.r;
          const hd = Math.hypot(hf, hr);
          if (hd > 0.01) {
            turn(Math.atan2(hr, hf), 4);
            moveEnemy(e, (hf / hd) * speed * 0.5 * dt, (hr / hd) * speed * 0.5 * dt);
            e.speed = speed * 0.5;
          }
        }
      } else if (e.state === "chase") {
        if (!sees && dist > def.sight * 1.3) {
          e.state = "idle";
          return;
        }
        turn(toHero, 5);
        if (dist > def.reach * 0.85) {
          if (Math.abs(wrap(toHero - e.yaw)) < 1.2) {
            moveEnemy(e, Math.cos(e.yaw) * speed * dt, Math.sin(e.yaw) * speed * dt);
            e.speed = speed;
          }
        } else if (Math.abs(wrap(toHero - e.yaw)) < 0.6 && sameLevel && h.mode !== "dead") {
          e.state = "windup";
          e.t = 0;
          sfx("suspect");
        }
      } else if (e.state === "windup") {
        turn(toHero, 2);
        if (e.t > def.windup * D.windup) {
          e.state = "strike";
          e.t = 0;
          e.struck = false;
          moveEnemy(e, Math.cos(e.yaw) * 0.006, Math.sin(e.yaw) * 0.006);
          sfx("swing");
        }
      } else if (e.state === "strike") {
        if (!e.struck && e.t > def.strike * 0.5) {
          e.struck = true;
          if (dist < def.reach + 0.005 && Math.abs(wrap(toHero - e.yaw)) < 0.95 && sameLevel) hurtHero(e, e.kind === "brute" ? "The brute's blade!" : "A skeleton's blade!");
        }
        if (e.t > def.strike) {
          e.state = "recover";
          e.t = 0;
        }
      } else if (e.state === "recover") {
        if (e.t > def.recover) {
          e.state = "chase";
          e.t = 0;
        }
      } else if (e.state === "stagger") {
        if (e.t > 0.35) {
          e.state = "chase";
          e.t = 0;
        }
      }
      // keep apart from the knight and each other
      const minD = 0.012 * def.scale + 0.004;
      if (dist < minD && dist > 1e-6 && h.mode === "move") moveEnemy(e, (-df / dist) * (minD - dist), (-dr / dist) * (minD - dist));
      enemies.forEach((o) => {
        if (o === e || o.state === "dead") return;
        const of = e.f - o.f;
        const or = e.r - o.r;
        const od = Math.hypot(of, or);
        const m = 0.014 * Math.max(def.scale, o.def.scale);
        if (od < m && od > 1e-6) moveEnemy(e, (of / od) * (m - od) * 0.5, (or / od) * (m - od) * 0.5);
      });
      e.phase += (dt * 2 * Math.PI * e.speed) / 0.06;
    }

    // -- the world's moving parts ---------------------------------------------------------------
    function stepWorld(dt) {
      movers.forEach((m) => {
        m.t += dt;
        const k = (1 - Math.cos((2 * Math.PI * m.t) / m.period)) / 2;
        const off = [0, 1, 2].map((i) => m.from[i] + (m.to[i] - m.from[i]) * k);
        const prev = [m.f0, m.r0, m.h0];
        m.f0 = m.base.f0 + off[0];
        m.f1 = m.base.f1 + off[0];
        m.r0 = m.base.r0 + off[1];
        m.r1 = m.base.r1 + off[1];
        m.h0 = m.base.h0 + off[2];
        m.h1 = m.base.h1 + off[2];
        m.step = [m.f0 - prev[0], m.r0 - prev[1], m.h0 - prev[2]];
      });
      plates.forEach((p) => {
        const was = p.down;
        p.down = (hero.onGround && hero.z < 0.004 && inRect(hero.f, hero.r, p)) || crates.some((c) => inRect((c.f0 + c.f1) / 2, (c.r0 + c.r1) / 2, p));
        if (p.down !== was) sfx(p.down ? "click" : "tock");
        gates.forEach((g) => g.plate === p.id && (g.target = p.down ? 1 : 0));
      });
      gates.forEach((g) => {
        const before = g.open;
        g.open = approach(g.open, g.target, dt / 1.2);
        // a closing gate doesn't shut on the knight
        if (g.open < before && g.open < 0.86 && inRect(hero.f, hero.r, g, BODY_R) && hero.z < g.h1) g.open = before;
      });
      levers.forEach((l) => (l.t = approach(l.t, l.on ? 1 : 0, dt * 4)));
    }

    function stepPickups() {
      const h = hero;
      if (h.mode === "dead") return;
      coins.forEach((c) => {
        if (c.taken || Math.hypot(c.f - h.f, c.r - h.r) > 0.014 || h.z > c.h + 0.012 || h.z + BODY_H < c.h) return;
        c.taken = true;
        score += 100;
        sfx("coin");
      });
      checkpoints.forEach((c) => {
        if (c.on || Math.hypot(c.f - h.f, c.r - h.r) > 0.025 || Math.abs(h.z - c.h) > 0.02 || !h.onGround) return;
        checkpoints.forEach((o) => (o.on = false));
        c.on = true;
        respawn = { f: c.f, r: c.r, z: c.h, yaw: h.yaw };
        sfx("pickup");
        say("Checkpoint");
      });
      if (!goal.taken && Math.hypot(goal.f - h.f, goal.r - h.r) < 0.022 && Math.abs(h.z - goal.h) < 0.03) {
        goal.taken = true;
        const bonus = Math.max(0, Math.round(1500 - 10 * levelTime));
        score += 2000 + bonus + hearts * 200;
        sfx("found");
        if (levelN >= LEVELS.length) {
          state = "won";
          Lynx.submitScore("knight", score).catch(() => {});
        } else state = "levelDone";
        stateTime = 0;
        say(`Time bonus ${bonus}, hearts ${hearts * 200}`, "#ffd84a");
        stopRobot();
      }
    }

    // -- the robot -----------------------------------------------------------------------------
    // Drives (goto) to camDist from the knight, viewed from where the robot
    // already is -- unless orbiting (look controls) or circling round behind
    // the knight (camera button) -- and points the camera at the knight.
    function steerRobot(dt, now) {
      const cw = ar.cameraWorld();
      const rl = w.toLocal(cw.x, cw.y);
      const h = hero;
      const actual = Math.atan2(rl.r - h.r, rl.f - h.f);
      const look = Lynx.control.aimInput;
      const rot = now - look.rotAt < 300 ? look.rot : 0;
      const tilt = now - look.tiltAt < 300 ? look.tilt : 0;
      if (Math.abs(rot) > 0.05) {
        cam.behind = false;
        cam.b = wrap(cam.b - rot * ORBIT_RATE * dt);
        cam.orbitAt = now;
      } else if (cam.behind) {
        const d = wrap(h.yaw + Math.PI - cam.b);
        cam.b = wrap(cam.b + clamp(d, -BEHIND_RATE * dt, BEHIND_RATE * dt));
        if (Math.abs(d) < 0.05) cam.behind = false;
        cam.orbitAt = now;
      } else if (now - cam.orbitAt > 1500) cam.b = actual; // a leash: from where it is
      cam.tiltOff = clamp(cam.tiltOff + tilt * 25 * dt, -20, 20);
      const dist = camDist + 0.8 * Math.max(0, h.z - 0.04);
      if (state === "playing") {
        const tf = h.f + dist * Math.cos(cam.b);
        const tr = h.r + dist * Math.sin(cam.b);
        const t = w.toWorld(tf, tr);
        const moved = !cam.lastGoto || Math.hypot(t.x - cam.lastGoto.x, t.y - cam.lastGoto.y) > GOTO_MOVE_M;
        if (moved || now - cam.lastGotoMs > GOTO_EVERY_MS) {
          Lynx.control.send({ type: "goto", x: +t.x.toFixed(4), y: +t.y.toFixed(4), maintainSpeed: false });
          cam.lastGoto = t;
          cam.lastGotoMs = now;
        }
      }
      // aim: at the knight's chest, a little ahead of where it's going
      const pt = [h.f + h.vf * 0.15, h.r + h.vr * 0.15, h.z + 0.04];
      if (!cam.aimPt) cam.aimPt = pt;
      const k = 1 - Math.exp(-dt * 8);
      cam.aimPt = cam.aimPt.map((v, i) => v + (pt[i] - v) * k);
      const P = w.toWorld(cam.aimPt[0], cam.aimPt[1]);
      const hd = Math.hypot(P.x - cw.x, P.y - cw.y);
      if (hd > 0.03 || cam.aimYaw === null) cam.aimYaw = Math.atan2(P.y - cw.y, P.x - cw.x);
      const down = Math.atan2(cw.h - cam.aimPt[2], Math.max(hd, 0.03));
      cam.aimTilt = ((ar.calib.tiltRad - down) * 180) / Math.PI + cam.tiltOff;
      // without absolute aim on the page, send it ourselves
      if (!Lynx.control.absoluteAim() && now - cam.lastAimMs > 50) {
        Lynx.control.send({ type: "aim", heading: +wrap(cam.aimYaw).toFixed(4), tilt: +cam.aimTilt.toFixed(2) });
        cam.lastAimMs = now;
      }
    }
    function stopRobot() {
      // stop where it is (the goto target = here); the drive input is the player's again
      const cw = ar.cameraWorld();
      Lynx.control.send({ type: "goto", x: +cw.x.toFixed(4), y: +cw.y.toFixed(4), maintainSpeed: false });
      cam.lastGoto = null;
      takeControl(false);
    }
    // While playing, the drive input is the knight's, and the game points the camera.
    function takeControl(on) {
      if (Lynx.control.setDriveFilter) Lynx.control.setDriveFilter(on ? () => null : null);
      if (Lynx.cam && Lynx.cam.setAimOverride) Lynx.cam.setAimOverride(on ? () => (cam.aimYaw === null ? null : { yaw: cam.aimYaw, tiltDeg: cam.aimTilt }) : null);
    }

    // -- flow ----------------------------------------------------------------------------------------
    function start(n) {
      if (n === firstLevel && state !== "levelDone") {
        score = 0;
        hearts = maxHearts;
      }
      loadLevel(n);
      state = "playing";
      stateTime = 0;
      takeControl(true);
      sfx("go");
    }
    Lynx.onAction("fire", () => {
      if (state === "title") start(firstLevel);
      else if (state === "playing") attackPressed();
      else if (state === "dead" && stateTime > 1.5) {
        // again, from the start of this level
        score = levelStartScore;
        hearts = maxHearts;
        state = "levelDone"; // (keeps the score)
        start(levelN);
      } else if (state === "levelDone" && stateTime > 1.5) start(levelN + 1);
      else if (state === "won" && stateTime > 2) {
        state = "title";
        start(firstLevel);
      }
    });
    Lynx.onAction("jump", () => {
      if (state !== "playing") return false;
      hero.jumpBuf = JUMP_BUFFER_S;
      return true;
    });
    Lynx.onAction("camera", () => {
      if (state === "playing") cam.behind = true;
    });
    const touch = Lynx.touchButtons();
    touch.add("⤒ Jump", () => Lynx.jumpAction());
    touch.add("\u{1F3A5} Behind", () => Lynx.cameraAction());
    ar.onDestroy(() => {
      Lynx.control.send({ type: "joystick", j1: 0, j2: 0 }); // out of goto: stop
      takeControl(false);
    });

    function update(dt, now) {
      time += dt;
      stateTime += dt;
      if (note) note.t += dt;
      sparks.forEach((s) => (s.t += dt));
      sparks = sparks.filter((s) => s.t < 0.3);
      if (!L) return;
      if (state === "playing") levelTime += dt;
      const n = Math.max(1, Math.ceil(dt / (1 / 120)));
      for (let i = 0; i < n; i++) {
        const sdt = dt / n;
        stepWorld(sdt);
        stepHero(sdt);
        enemies.forEach((e) => stepEnemy(e, sdt));
        if (state === "playing") stepPickups();
      }
      // the gait
      const h = hero;
      h.speed = h.onGround && h.mode === "move" ? Math.hypot(h.vf, h.vr) : 0;
      const run = clamp((h.speed - WALK_V) / (RUN_V - WALK_V), 0, 1);
      h.phase += (dt * 2 * Math.PI * h.speed) / lerp(0.056, 0.12, run);
      if (state === "playing" || state === "dead") steerRobot(dt, now);
    }

    // -- drawing ------------------------------------------------------------------------------------
    const OCC_ALPHA = 0.3;
    // Does a block hide the knight (between it and the camera, or round the camera)?
    function occludes(b, c, target) {
      const lo = [b.f0 - 0.003, b.r0 - 0.003, b.h0];
      const hi = [b.f1 + 0.003, b.r1 + 0.003, b.h1];
      const a = [c.f, c.r, c.h];
      let t0 = 0;
      let t1 = 1;
      for (let i = 0; i < 3; i++) {
        const d = target[i] - a[i];
        if (Math.abs(d) < 1e-9) {
          if (a[i] < lo[i] || a[i] > hi[i]) return false;
          continue;
        }
        let ta = (lo[i] - a[i]) / d;
        let tb = (hi[i] - a[i]) / d;
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta);
        t1 = Math.min(t1, tb);
        if (t0 > t1) return false;
      }
      return true;
    }

    function drawPit(p) {
      const depth = 0.07;
      const open = w.polyScreen([[p.f0, p.r0, 0.0006], [p.f1, p.r0, 0.0006], [p.f1, p.r1, 0.0006], [p.f0, p.r1, 0.0006]]);
      if (!open) return;
      const c = ar.ctx;
      const cl = w.camLocal();
      c.save();
      c.beginPath();
      open.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));
      c.closePath();
      c.clip();
      w.fillPoly(open, "#050403", null);
      const walls = [];
      if (cl.f > p.f0) walls.push([[p.f0, p.r1], [p.f0, p.r0]]);
      if (cl.f < p.f1) walls.push([[p.f1, p.r0], [p.f1, p.r1]]);
      if (cl.r > p.r0) walls.push([[p.f0, p.r0], [p.f1, p.r0]]);
      if (cl.r < p.r1) walls.push([[p.f1, p.r1], [p.f0, p.r1]]);
      walls.forEach(([a, b]) => {
        for (let k = 0; k < 3; k++) {
          const h0 = (-depth * k) / 3;
          const h1 = (-depth * (k + 1)) / 3;
          const q = w.polyScreen([[a[0], a[1], h0], [b[0], b[1], h0], [b[0], b[1], h1], [a[0], a[1], h1]]);
          if (q) w.fillPoly(q, `rgb(${70 - k * 22},${56 - k * 18},${40 - k * 13})`, null);
        }
      });
      c.restore();
      w.fillPoly(open, null, "rgba(30,20,10,0.9)", 2);
    }
    function drawSpikes(q) {
      w.floor(q, 0.0006, "rgba(40,36,32,0.75)", "rgba(20,16,12,0.9)");
      const c = ar.ctx;
      const cl = w.camLocal();
      c.beginPath();
      const S = 0.012;
      for (let f = q.f0 + S / 2; f < q.f1; f += S) {
        for (let r = q.r0 + S / 2; r < q.r1; r += S) {
          if (Math.hypot(f - cl.f, r - cl.r) > 0.9) continue;
          const tip = w.project(f, r, 0.008);
          const a = w.project(f, r - 0.003, 0.0006);
          const b = w.project(f, r + 0.003, 0.0006);
          if (!tip || !a || !b) continue;
          c.moveTo(a.x, a.y);
          c.lineTo(tip.x, tip.y);
          c.lineTo(b.x, b.y);
        }
      }
      c.fillStyle = "#c8c4bc";
      c.strokeStyle = "rgba(30,26,22,0.8)";
      c.lineWidth = 1;
      c.fill();
      c.stroke();
    }
    // a crate's face: a plank frame and a diagonal brace
    function crateFace(a, b, h0, h1) {
      const m = w.project((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (h0 + h1) / 2);
      if (!m) return;
      const px = Math.max(1.5, 0.0022 * m.ppm);
      const i = 0.0025;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const u = [(b[0] - a[0]) / len, (b[1] - a[1]) / len];
      const at = (s, h) => [a[0] + u[0] * s, a[1] + u[1] * s, h];
      const col = "rgba(60,34,12,0.9)";
      w.line3([at(i, h0 + i), at(len - i, h0 + i), at(len - i, h1 - i), at(i, h1 - i), at(i, h0 + i)], col, px, 0.01);
      w.line3([at(i, h0 + i), at(len - i, h1 - i)], col, px, 0.01);
    }
    function drawPlate(p) {
      w.floor(p, p.down ? 0.0008 : 0.002, p.down ? "#7a7060" : "#b0a080", "#3a3020", { width: 2 });
    }
    function queueGate(g) {
      if (g.open >= 0.99) return;
      const lift = g.open * g.h1 * 0.95;
      const alongR = g.r1 - g.r0 >= g.f1 - g.f0;
      const mid = alongR ? (g.f0 + g.f1) / 2 : (g.r0 + g.r1) / 2;
      const p = (s, h) => (alongR ? [mid, s, h] : [s, mid, h]);
      const lo = alongR ? g.r0 : g.f0;
      const hi = alongR ? g.r1 : g.f1;
      const m = w.project(...p((lo + hi) / 2, g.h1 / 2));
      if (!m) return;
      ar.queue(m.depth, () => {
        const px = Math.max(1.5, 0.0014 * m.ppm);
        for (let s = lo + 0.006; s < hi; s += 0.012) w.line3([p(s, lift), p(s, g.h1)], "#2e2e34", px, 0.01);
        [0.012, g.h1 * 0.55, g.h1 - 0.003].forEach((h) => h > lift && w.line3([p(lo, h), p(hi, h)], "#3c3c44", px, 0.01));
      }, alongR ? w.extent(mid - 0.003, mid + 0.003, g.r0, g.r1, lift, g.h1) : w.extent(g.f0, g.f1, mid - 0.003, mid + 0.003, lift, g.h1));
    }
    function queueLever(l) {
      w.box({ f0: l.f - 0.006, f1: l.f + 0.006, r0: l.r - 0.004, r1: l.r + 0.004 }, l.h, l.h + 0.006, DARK);
      const base = [l.f, l.r, l.h + 0.006];
      const ang = lerp(-0.7, 0.7, ease(l.t));
      const tip = [l.f + Math.sin(ang) * 0.015, l.r, l.h + 0.006 + Math.cos(ang) * 0.015];
      const m = w.project(...tip);
      if (!m) return;
      ar.queue(m.depth, () => {
        w.line3([base, tip], "#4a3a2a", Math.max(2, 0.0018 * m.ppm), 0.01);
        const s = w.project(...tip);
        if (s) {
          ar.ctx.beginPath();
          ar.ctx.arc(s.x, s.y, Math.max(2, 0.0026 * s.ppm), 0, 2 * Math.PI);
          ar.ctx.fillStyle = l.on ? "#ffd84a" : "#d03030";
          ar.ctx.fill();
          ar.ctx.strokeStyle = "rgba(0,0,0,0.6)";
          ar.ctx.stroke();
        }
      }, w.extent(l.f - 0.016, l.f + 0.016, l.r - 0.003, l.r + 0.003, l.h + 0.006, l.h + 0.024));
    }
    function queueFlag(cp) {
      const top = cp.h + 0.035;
      const m = w.project(cp.f, cp.r, top);
      if (!m) return;
      ar.queue(m.depth, () => {
        w.line3([[cp.f, cp.r, cp.h], [cp.f, cp.r, top]], "#5a4a3a", Math.max(1.5, 0.0012 * m.ppm), 0.01);
        const wave = Math.sin(time * 5 + cp.f * 30) * 0.002;
        const pts = [[cp.f, cp.r, top], [cp.f + wave, cp.r + 0.014, top - 0.004 + wave], [cp.f, cp.r, top - 0.009]].map((p) => w.project(...p));
        if (pts.every(Boolean)) w.fillPoly(pts, cp.on ? "#ffd84a" : "#3070d0", "rgba(0,0,0,0.6)", 1);
      }, w.extent(cp.f - 0.002, cp.f + 0.002, cp.r - 0.001, cp.r + 0.015, cp.h, top));
    }
    function queueCoin(c) {
      if (c.taken) return;
      const h = c.h + 0.012 + Math.sin(time * 3 + c.f * 20) * 0.0015;
      const m = w.project(c.f, c.r, h);
      if (!m) return;
      ar.queue(m.depth, () => {
        const g = ar.ctx;
        const ry = Math.max(2, 0.0045 * m.ppm);
        const rx = Math.max(1, ry * Math.abs(Math.cos(time * 3 + c.r * 10)));
        ar.glow(m.x, m.y, ry * 2.2, [[0, "rgba(255,230,120,0.35)"], [1, "rgba(255,230,120,0)"]]);
        g.beginPath();
        g.ellipse(m.x, m.y, rx, ry, 0, 0, 2 * Math.PI);
        g.fillStyle = "#ffd040";
        g.fill();
        g.lineWidth = Math.max(1, ry * 0.18);
        g.strokeStyle = "#a07010";
        g.stroke();
      }, w.extent(c.f - 0.004, c.f + 0.004, c.r - 0.004, c.r + 0.004, h - 0.0045, h + 0.0045));
    }
    function queueGoal() {
      if (goal.taken) return;
      const g = goal;
      const m = w.project(g.f, g.r, g.h + 0.02);
      if (!m) return;
      ar.queue(m.depth, () => {
        const c = ar.ctx;
        ar.glow(m.x, m.y, 0.03 * m.ppm, [[0, "rgba(255,230,140,0.45)"], [1, "rgba(255,230,140,0)"]]);
        if (g.kind === "banner") {
          const top = g.h + 0.05;
          w.line3([[g.f, g.r, g.h], [g.f, g.r, top]], "#3a2a1a", Math.max(2, 0.0016 * m.ppm), 0.01);
          const wave = Math.sin(time * 4) * 0.003;
          const pts = [[g.f, g.r, top], [g.f + wave, g.r + 0.022, top - 0.002], [g.f + wave * 1.5, g.r + 0.022, top - 0.018], [g.f, g.r, top - 0.016]].map((p) => w.project(...p));
          if (pts.every(Boolean)) {
            w.fillPoly(pts, "#c02828", "#ffd84a", 2);
          }
        } else {
          // a crown, turning
          const spin = time * 1.5;
          const pts = [];
          const n = 10;
          for (let k = 0; k <= n; k++) {
            const a = spin + (k / n) * Math.PI * 2;
            pts.push([g.f + 0.007 * Math.cos(a), g.r + 0.007 * Math.sin(a), g.h + 0.012 + (k % 2 ? 0.006 : 0.012)]);
          }
          const rim = [];
          for (let k = 0; k <= n; k++) {
            const a = spin + (k / n) * Math.PI * 2;
            rim.push([g.f + 0.007 * Math.cos(a), g.r + 0.007 * Math.sin(a), g.h + 0.008]);
          }
          w.line3(rim, "#c8a020", Math.max(2, 0.002 * m.ppm), 0.003);
          w.line3(pts, "#ffd84a", Math.max(2, 0.0016 * m.ppm), 0.003);
        }
      }, w.extent(g.f - 0.01, g.f + 0.02, g.r - 0.01, g.r + 0.025, g.h, g.h + 0.05));
    }
    function queueShadow(f, r, z, size) {
      const g = groundAt(f, r, z + 0.0005, 0.002);
      if (!Number.isFinite(g.h)) return;
      const k = clamp(1 - (z - g.h) / 0.12, 0.3, 1);
      const rad = size * (0.6 + 0.4 * k);
      const pts = [];
      for (let i = 0; i < 12; i++) pts.push([f + rad * Math.cos((i / 12) * 2 * Math.PI), r + rad * Math.sin((i / 12) * 2 * Math.PI), g.h + 0.0008]);
      const m = w.project(f, r, g.h);
      if (!m) return;
      ar.queue(m.depth, () => {
        const p = w.polyScreen(pts, 1);
        if (p) w.fillPoly(p, `rgba(0,0,0,${(0.35 * k).toFixed(3)})`, null);
      }, w.extent(f - rad, f + rad, r - rad, r + rad, g.h, g.h + 0.0008));
    }
    function heroAnim() {
      const h = hero;
      return {
        time, speed: h.speed, phase: h.phase,
        air: h.mode === "move" && !h.onGround ? h.vz : null,
        land: h.landT > 0 ? h.landT / 0.18 : 0,
        hang: h.mode === "hang", climb: h.mode === "climb" ? h.climb.anim : null,
        attack: h.attack ? { n: h.attack.n, u: h.attack.u } : null,
        hurt: h.hurtT > 0 ? h.hurtT / 0.35 : 0, dead: h.mode === "dead" ? clamp(h.deadT / 0.7, 0, 1) : 0, brace: 0, armed: true,
      };
    }
    function queueHero(c) {
      const h = hero;
      queueShadow(h.f, h.r, h.z, 0.007);
      const m = w.project(h.f, h.r, h.z + 0.035);
      if (!m) return;
      ar.queue(m.depth, () => {
        const J = bodyJoints(heroAnim());
        const prims = knightPrims(J, placer(h.f, h.r, h.z, h.yaw), KNIGHT_LOOK, { speed: h.speed, time });
        const blink = h.inv > 0 && h.mode !== "dead" ? (Math.sin(time * 30) > 0 ? 0.45 : 1) : 1;
        // close in front of the camera: see-through, not a wall of knight
        const near = clamp((Math.hypot(c.f - h.f, c.r - h.r) - 0.05) / 0.04, 0.35, 1);
        drawPrims(w, prims, ar, KNIGHT_LOOK.outline, blink * near);
      }, w.extent(h.f - 0.014, h.f + 0.014, h.r - 0.014, h.r + 0.014, h.z, h.z + BODY_H));
    }
    function queueEnemy(e) {
      const sc = e.def.scale;
      if (e.state === "dead" && e.deadT > 2.5) return;
      if (e.state !== "dead") queueShadow(e.f, e.r, e.z, 0.007 * sc);
      const m = w.project(e.f, e.r, e.z + 0.035 * sc);
      if (!m) return;
      ar.queue(m.depth, () => {
        const windT = e.state === "windup" ? clamp(e.t / (e.def.windup * D.windup), 0, 1) : 0;
        const anim = {
          time: time + e.home.f * 10, speed: e.speed, phase: e.phase, air: null, land: 0, hang: false, climb: null,
          attack: e.state === "strike" ? { n: 3, u: lerp(0.35, 0.62, clamp(e.t / e.def.strike, 0, 1)) } : e.state === "recover" ? { n: 3, u: lerp(0.62, 1, clamp(e.t / e.def.recover, 0, 1)) } : null,
          hurt: e.state === "stagger" ? 1 - e.t / 0.35 : 0, dead: 0, brace: windT, armed: true,
        };
        const J = bodyJoints(anim);
        let P = placer(e.f, e.r, e.z, e.yaw, sc);
        if (e.state === "dead") {
          // falls apart: the bones sink into a heap
          const k = ease(e.deadT / 0.6);
          const base = P;
          P = (v) => {
            const q = base([v[0] * (1 + k * 0.6), v[1] * (1 + k * 0.6), v[2] * (1 - 0.9 * k)]);
            return q;
          };
        }
        const look = e.kind === "brute" ? BRUTE_LOOK : SKELETON_LOOK;
        const prims = skeletonPrims(J, P, look, { angry: e.state !== "idle" && e.state !== "dead" });
        const fade = e.state === "dead" ? clamp(1 - (e.deadT - 1.5), 0, 1) : 1;
        drawPrims(w, prims, ar, look.outline, fade, e.flash > 0 ? 0.7 : windT > 0.6 ? (Math.sin(time * 40) > 0 ? 0.35 : 0) : 0);
        // the wind-up's tell: a glint on the raised blade
        if (windT > 0 && J.swordDir) {
          const tipB = add(J.hand[1], mul(J.swordDir, e.kind === "brute" ? 0.024 : 0.016));
          const s = w.project(...P(tipB));
          if (s) ar.glow(s.x, s.y, Math.max(4, 0.006 * s.ppm) * (0.5 + windT), [[0, "rgba(255,255,255,0.95)"], [0.4, "rgba(255,120,80,0.6)"], [1, "rgba(255,60,0,0)"]]);
        }
      }, w.extent(e.f - 0.012 * sc, e.f + 0.012 * sc, e.r - 0.012 * sc, e.r + 0.012 * sc, e.z, e.z + BODY_H * sc));
    }
    function drawSparks() {
      sparks.forEach((s) => {
        const m = w.project(s.f, s.r, s.h);
        if (!m) return;
        const k = s.t / 0.3;
        ar.glow(m.x, m.y, 0.012 * m.ppm * (0.5 + k), [[0, `rgba(255,255,220,${(1 - k).toFixed(3)})`], [1, "rgba(255,200,80,0)"]]);
      });
    }

    function hint() {
      if (!L || !L.hints) return null;
      const g = { me: hero, gateOpen };
      return L.hints.find((x) => !x.until(g)) || null;
    }

    function hud() {
      const v = ar.view;
      const x0 = v.x + 12;
      if (state === "title") {
        ar.banner("POCKET KNIGHT", "Fire to start -- you play the knight, the robot follows it");
        ar.text("Clear a floor of about 1.3 x 2.5 m in front of the robot", v.cx, v.cy + 70, { size: 14, align: "center" });
        return;
      }
      for (let i = 0; i < maxHearts; i++) ar.text("♥", x0 + i * 18, v.y + 26, { size: 18, color: i < hearts ? "#ff3040" : "rgba(255,255,255,0.3)" });
      ar.text(`${L.name} · ${score} pts · ${coins.filter((c) => c.taken).length}/${coins.length} coins`, x0, v.y + 48, { size: 13 });
      const hn = hint();
      if (hn && state === "playing") ar.text(hn.text, v.cx, v.y + v.h - 20, { size: 14, align: "center" });
      if (note && note.t < 3) ar.text(note.text, v.cx, v.y + 80, { size: 16, align: "center", color: note.color, alpha: clamp(3 - note.t, 0, 1) });
      // where to go next, and where the knight is if it's off the screen
      if (state === "playing") {
        const target = !gateOpenFor() ? leverTarget() : goal.taken ? null : goal;
        if (target) {
          const t = w.toWorld(target.f, target.r);
          ar.edgeArrow(t.x, t.y, target.h + 0.02, "#ffd84a");
        }
        const k = w.toWorld(hero.f, hero.r);
        ar.edgeArrow(k.x, k.y, hero.z + 0.035, "#80d0ff");
      }
      if (state === "dead") ar.banner("YOU FELL", stateTime > 1.5 ? "Fire to try this level again" : "");
      if (state === "levelDone") ar.banner(`${L.name.toUpperCase()} -- DONE`, stateTime > 1.5 ? "Drive the robot to clear floor if you need to, then Fire for the next level" : "", { color: "#ffd84a" });
      if (state === "won") ar.banner("YOU WIN!", `${score} points -- Fire to play again`, { color: "#ffd84a" });
    }
    const gateOpenFor = () => levers.every((l) => l.on);
    const leverTarget = () => levers.find((l) => !l.on) || null;

    function draw() {
      w.beginFrame();
      if (!L) {
        hud();
        return;
      }
      const c = w.camLocal();
      const heroMid = [hero.f, hero.r, hero.z + 0.04];
      L.floors.forEach((q) => w.floor(q, 0.0004, "rgba(60,50,35,0.22)", "rgba(120,100,70,0.35)", { detail: "slab", alpha: 0.4 }));
      L.pits.forEach(drawPit);
      L.spikes.forEach(drawSpikes);
      plates.forEach(drawPlate);
      L.blocks.forEach((b) => w.box(b, b.h0, b.h1, STYLES[b.style] || STONE, occludes(b, c, heroMid) ? { alpha: OCC_ALPHA } : {}));
      movers.forEach((m) => w.box(m, m.h0, m.h1, BRONZE, occludes(m, c, heroMid) ? { alpha: OCC_ALPHA } : {}));
      crates.forEach((k) => w.box(k, k.h0, k.h1, WOOD, { ...(occludes(k, c, heroMid) ? { alpha: OCC_ALPHA } : {}), faceDeco: crateFace }));
      gates.forEach(queueGate);
      levers.forEach(queueLever);
      checkpoints.forEach(queueFlag);
      coins.forEach(queueCoin);
      queueGoal();
      enemies.forEach(queueEnemy);
      queueHero(c);
      ar.flush();
      drawSparks();
      hud();
    }

    ar.onFrame((now, dt) => {
      update(dt, now);
      draw();
    });

    return {
      actionLabel: "⚔️ Sword",
      debug: {
        god: (on) => (godMode = on),
        level: (n) => start(n),
        teleport: (f, r, z = 0) => placeHero({ f, r, z, yaw: hero.yaw }),
        hero: () => hero,
        enemies: () => enemies,
        solids: () => solids(),
        world: () => w,
        cam: () => cam,
      },
      snapshot: () => ({
        state, level: levelN, score, hearts, time: +levelTime.toFixed(1),
        hero: { f: +hero.f.toFixed(3), r: +hero.r.toFixed(3), z: +hero.z.toFixed(3), mode: hero.mode, onGround: hero.onGround, yaw: +hero.yaw.toFixed(2), attack: hero.attack && hero.attack.n },
        enemies: enemies.map((e) => `${e.kind}:${e.state}:${e.hp}`),
        gates: gates.map((g) => `${g.id}:${g.open.toFixed(2)}`),
        crates: crates.map((k) => `${((k.f0 + k.f1) / 2).toFixed(3)},${((k.r0 + k.r1) / 2).toFixed(3)}`),
        coins: coins.filter((x) => x.taken).length,
        camB: +cam.b.toFixed(2),
      }),
    };
  };
})(window.Lynx);
