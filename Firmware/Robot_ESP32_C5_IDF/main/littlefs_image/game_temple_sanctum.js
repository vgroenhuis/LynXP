// Temple of LynXP, level 2: the sunken sanctum. A two-storey maze on the same
// 2 x 3 m of floor as the other levels, run by game_temple.js (which keeps
// the score, hearts, shooting, HUD and game flow) through Lynx.templeSanctum().
//
// The sanctum is a grid of 15 cm cells, two maps: the ground floor and an
// upper floor FLOOR_H up. Walls fill a storey and really stop the robot: the
// part of a drive command that points into a wall is dropped (turning is
// always fine, and you slide along a wall you drive into at an angle). Stairs
// climb one step per cell; holes in the upper floor, the stairwell and the
// double-height hall let you look down to the ground floor -- and fall.
//
// The way through: a sun disk high up in the hall extends a bridge upstairs;
// over it lies the blue key, and a hole down into the west wing. A lever there
// opens its gate; the blue door leads to the crypt and the red key; the red
// door to the vault, where a pressure plate seals the door behind you. Take
// the Sun Crown: its dais lifts you to the upper floor, the ground floor
// floods with lava, and the way to the sun gate at the front opens.
//
// Drawing, two storeys with the painter's algorithm: nothing on one side of
// the upper floor's plane can hide anything on the other side of it from a
// camera on that same side. So from above: the ground floor, then the upper
// floor's slab (hiding what's under it, except through voids), then the
// upper floor; from below: the upper floor, its ceiling, the ground floor.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const CELL = 0.15;
  const ROWS = 20; // along f
  const COLS = 12; // along r
  const R_MIN = -0.9; // r of column 0's left edge
  const FLOOR_H = 0.3; // the upper floor
  const WALL_H = 0.3; // walls fill a storey (a jump is 0.28: no jumping over walls)
  const STEP_UP = 0.06; // ledges this high you walk onto (stairs); higher needs a jump
  const BODY_H = 0.12; // walls this far above your feet stop you
  const CLEAR = 0.11; // the robot keeps this far from walls
  const PIT_D = 0.12;
  const BLOCK_H = 0.15; // the low block in the hall
  const TOUCH_M = 0.11;

  // Far end first, as seen from the entrance; one character per cell.
  // Ground floor: # wall, . floor, S stairs (up toward the far end),
  // G gate (lever), R red door, B blue door, P pressure plate, D the dais
  // (a lift), x spike pit, o low block.
  // Upper floor: # wall, . floor, space/h void (h: the hole), = bridge,
  // D lift shaft, 2 3 gates (open with the crown), E the sun gate.
  const MAP0 = [
    "...#.....###", // 19
    "...#.DD..###",
    "...#.DD..###",
    "xxx#.....###",
    "...#.PP..###", // 15
    "...##RR#####",
    "...#.....###",
    "BBB#.....###",
    "...#...oo#SS",
    "...#...oo#SS", // 10
    "...#.....#SS",
    "...#.....#SS",
    "...#.....#SS",
    "...#.....#SS",
    "GGG##..###..", // 5
    "............",
    "............",
    "..#......#..",
    "............",
    "............", // 0
  ];
  const MAP1 = [
    "............", // 19
    ".....DD.....",
    ".....DD.....",
    "............",
    "333#########", // 15
    ".....==.....",
    ".....==.....",
    ".....==.....",
    "...#     #  ",
    "...#     #  ", // 10
    "...#     #  ",
    "hhh#     #  ",
    "...#     #  ",
    "...#     #  ",
    "222#########", // 5
    "............",
    "............",
    "..#......#..", // pillars: clear of gate 2 by 0.3 m, room for the robot
    ".....EE.....",
    "............", // 0
  ];
  const MAPS = [MAP0.slice().reverse(), MAP1.slice().reverse()]; // [floor][row i][col j]
  const STAIRS = { i0: 6, i1: 11, j0: 10, j1: 11 };
  const stepH = (i) => (FLOOR_H * (i - STAIRS.i0 + 1)) / (STAIRS.i1 - STAIRS.i0 + 1);
  // What you walk on along the stairs: a smooth slope rather than the steps,
  // so the view glides up instead of jumping at every edge. It starts one
  // cell before the first step and meets each step's top at its front edge
  // (so it's never below the step you're on), reaching the upper floor at
  // the last step. The steps are still drawn as blocks.
  const stairRampH = (f) =>
    Math.max(0, Math.min(FLOOR_H, (FLOOR_H * (f / CELL - STAIRS.i0 + 1)) / (STAIRS.i1 - STAIRS.i0 + 1)));

  const COUNTS = {
    easy: { hall: 1, wing: 0, crypt: 1, vault: 0, bats: 1, mummyHp: 3, lavaS: 40 },
    normal: { hall: 2, wing: 1, crypt: 1, vault: 1, bats: 2, mummyHp: 4, lavaS: 30 },
    hard: { hall: 3, wing: 1, crypt: 2, vault: 1, bats: 3, mummyHp: 5, lavaS: 22 },
  };
  const LAVA_TOP = 0.1; // lava rises this high on the ground floor

  const MUMMY = [
    "....gggg....",
    "...gwwwwg...",
    "...wrwwrw...",
    "...wwwwww...",
    "....wggw....",
    "..wwwwwwww..",
    ".wwgwwwwgww.",
    "ww..wggw..ww",
    "w...wwww...w",
    "....wggw....",
    "....wwww....",
    "...ww..ww...",
    "...wg..gw...",
    "...ww..ww...",
    "..www..www..",
  ];
  const MUMMY_PAL = { w: "#d8cfae", g: "#9c9272", r: "#ff3020" };
  const KEY = [".kkk......", "k.w.kkkkkk", "k...k..k.k", ".kkk......"];
  const CROWN = ["y....y....y", "yy..yyy..yy", "yyyyyryyyyy", "yyyyyyyyyyy", "ybyryyyrbyy", "yyyyyyyyyyy"];

  const SANDSTONE = { top: "#c8a868", side: "#98783c", dark: "#705426", line: "rgba(40,25,10,0.6)", mortar: true, tex: "sandstone" };
  const CRYPT = { top: "#9a8866", side: "#6e5e44", dark: "#4e412e", line: "rgba(20,12,5,0.6)", mortar: true, tex: "crypt" };
  const STEP_COL = { top: "#d0b070", side: "#a08040", dark: "#7a5e2c", line: "rgba(40,25,10,0.7)", tex: "sandstone" };
  const DAIS_COL = { top: "#e0c060", side: "#b08830", dark: "#806018", line: "rgba(60,40,0,0.8)" };
  const DOOR_COL = {
    red: { top: "#c03030", side: "#a02020", dark: "#801818", line: "rgba(40,0,0,0.8)" },
    blue: { top: "#3050c0", side: "#2040a0", dark: "#183080", line: "rgba(0,0,40,0.8)" },
  };

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const cellI = (f) => Math.floor(f / CELL);
  const cellJ = (r) => Math.floor((r - R_MIN) / CELL);
  const cellRect = (i0, i1, j0, j1) => ({ f0: i0 * CELL, f1: (i1 + 1) * CELL, r0: R_MIN + j0 * CELL, r1: R_MIN + (j1 + 1) * CELL });
  const cellCenter = (i, j) => ({ f: (i + 0.5) * CELL, r: R_MIN + (j + 0.5) * CELL });
  const inRect = (f, r, q) => f >= q.f0 && f <= q.f1 && r >= q.r0 && r <= q.r1;
  function cell(fl, i, j) {
    if (i < 0 || i >= ROWS || j < 0 || j >= COLS) return "#";
    return MAPS[fl][i][j];
  }
  // bounding rect of the cells of one kind
  function rectOf(fl, ch) {
    let i0 = ROWS, i1 = -1, j0 = COLS, j1 = -1;
    for (let i = 0; i < ROWS; i++) {
      for (let j = 0; j < COLS; j++) {
        if (MAPS[fl][i][j] !== ch) continue;
        i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
      }
    }
    return cellRect(i0, i1, j0, j1);
  }
  // Cells matching pred merged into few rectangles: runs along r, then
  // equal runs in neighbouring rows joined.
  function mergeCells(pred) {
    const open = new Map(); // "j0,j1" -> rect still growing
    const out = [];
    for (let i = 0; i <= ROWS; i++) {
      const runs = new Set();
      if (i < ROWS) {
        for (let j = 0; j < COLS; j++) {
          if (!pred(i, j)) continue;
          let k = j;
          while (k + 1 < COLS && pred(i, k + 1)) k++;
          runs.add(`${j},${k}`);
          j = k;
        }
      }
      for (const [key, rect] of open) {
        if (!runs.has(key)) {
          out.push(rect);
          open.delete(key);
        }
      }
      runs.forEach((key) => {
        const [j0, j1] = key.split(",").map(Number);
        if (open.has(key)) open.get(key).f1 = (i + 1) * CELL;
        else open.set(key, cellRect(i, i, j0, j1));
      });
    }
    return out;
  }

  Lynx.templeSanctum = (api) => {
    const { ar, d } = api;
    const n = COUNTS[api.cfg.difficulty] || COUNTS.normal;
    const img = {
      mummy: Lynx.sprite(MUMMY, MUMMY_PAL),
      keyRed: Lynx.sprite(KEY, { k: "#ff4040", w: "#ffd0d0" }),
      keyBlue: Lynx.sprite(KEY, { k: "#4080ff", w: "#d0e0ff" }),
      crown: Lynx.sprite(CROWN, { y: "#ffd040", r: "#ff2050", b: "#40a0ff" }),
    };

    // -- the building ----------------------------------------------------------
    const walls = [0, 1].map((fl) =>
      mergeCells((i, j) => cell(fl, i, j) === "#").map((q) => ({ ...q, h0: fl * FLOOR_H, h1: fl * FLOOR_H + WALL_H, fl })));
    const OUT = 5;
    const boundary = [
      { f0: -OUT, f1: 0, r0: -OUT, r1: OUT, h0: -1, h1: 3 },
      { f0: ROWS * CELL, f1: OUT, r0: -OUT, r1: OUT, h0: -1, h1: 3 },
      { f0: -OUT, f1: OUT, r0: -OUT, r1: R_MIN, h0: -1, h1: 3 },
      { f0: -OUT, f1: OUT, r0: R_MIN + COLS * CELL, r1: OUT, h0: -1, h1: 3 },
    ];
    // the outer walls, drawn only (the boundary above does the stopping):
    // sides in 0.6 m pieces, the entrance a gap in the front
    const THICK = 0.06;
    const LEN = ROWS * CELL;
    const R_MAX = R_MIN + COLS * CELL;
    const outer = [];
    [0, 1].forEach((fl) => {
      const h0 = fl * FLOOR_H;
      for (let f = 0; f < LEN - 1e-6; f += 0.6) {
        outer.push({ f0: f, f1: Math.min(LEN, f + 0.6), r0: R_MIN - THICK, r1: R_MIN, h0 });
        outer.push({ f0: f, f1: Math.min(LEN, f + 0.6), r0: R_MAX, r1: R_MAX + THICK, h0 });
      }
      outer.push({ f0: LEN, f1: LEN + THICK, r0: R_MIN - THICK, r1: 0, h0 });
      outer.push({ f0: LEN, f1: LEN + THICK, r0: 0, r1: R_MAX + THICK, h0 });
      const gap = fl === 0 ? CELL : 0; // the way in
      outer.push({ f0: -THICK, f1: 0, r0: R_MIN - THICK, r1: -gap, h0 });
      outer.push({ f0: -THICK, f1: 0, r0: gap, r1: R_MAX + THICK, h0 });
    });
    const lowBlock = { ...rectOf(0, "o"), h0: 0, h1: BLOCK_H };
    const floorRects = mergeCells((i, j) => cell(0, i, j) !== "#");
    const pitRect = rectOf(0, "x");
    const plateRect = rectOf(0, "P");
    const bridgeRect = rectOf(1, "=");
    const exitRect = rectOf(1, "E");
    const holeRect = rectOf(1, "h");
    const lift = { ...rectOf(0, "D"), h: 0.05, target: 0.05 };
    const liftCenter = { f: (lift.f0 + lift.f1) / 2, r: (lift.r0 + lift.r1) / 2 };
    const doors = [
      { id: "g1", fl: 0, ch: "G", kind: "gate" },
      { id: "red", fl: 0, ch: "R", kind: "door", color: "red" },
      { id: "blue", fl: 0, ch: "B", kind: "door", color: "blue" },
      { id: "g2", fl: 1, ch: "2", kind: "gate" },
      { id: "g3", fl: 1, ch: "3", kind: "gate" },
    ].map((o) => ({ ...o, ...rectOf(o.fl, o.ch), open: false, lift: 0, sealed: false, warned: false }));
    const door = (id) => doors.find((o) => o.id === id);
    const doorAt = (fl, i, j) => {
      const ch = cell(fl, i, j);
      return doors.find((o) => o.fl === fl && o.ch === ch) || null;
    };
    const doorShut = (o) => !o.open || o.lift < 0.95;

    // switches: sun disks on wall faces, shot to operate them. n: the way the face looks.
    const switches = [
      { id: "bridge", f: 9.5 * CELL, r: R_MIN + 9 * CELL, h: FLOOR_H + 0.13, n: { f: 0, r: -1 }, on: false },
      { id: "g1", f: 7.5 * CELL, r: R_MIN + 3 * CELL, h: 0.17, n: { f: 0, r: -1 }, on: false },
    ].map((s) => ({ ...s, rect: null, hit: 0 }));
    const sw = (id) => switches.find((s) => s.id === id);

    // enemies wake up the first time you enter their zone
    const zones = {
      hall: { fl: 0, ...cellRect(6, 13, 4, 8) },
      wing: { fl: 0, ...cellRect(6, 11, 0, 2) },
      crypt: { fl: 0, ...cellRect(13, 19, 0, 2) },
    };

    let bridge = 0; // 0..1: how far it's out
    let keys = { red: false, blue: false };
    let crown = false;
    let lavaH = -0.05;
    let plateDone = false;
    let wasAirborne = false;
    let feetFloor = 0; // which storey you stand on
    let items = [];
    let enemies = [];
    let woken = new Set();
    let visited = new Set();
    let seen = [0, 1].map(() => Array.from({ length: ROWS }, () => new Array(COLS).fill(false)));
    let losTimer = 0;

    items = [
      { kind: "keyBlue", ...cellCenter(11, 1), base: FLOOR_H },
      { kind: "keyRed", ...cellCenter(18, 1), base: 0 },
      { kind: "crown", f: liftCenter.f, r: liftCenter.r, base: 0.05, onLift: true },
      { kind: "potion", ...cellCenter(7, 8), base: 0 },
      { kind: "potion", ...cellCenter(14, 1), base: 0 },
      { kind: "gem", f: (lowBlock.f0 + lowBlock.f1) / 2, r: (lowBlock.r0 + lowBlock.r1) / 2, base: BLOCK_H }, // jump onto the block
      { kind: "gem", ...cellCenter(16, 1), base: 0.1, float: true }, // over the spike pit
      { kind: "gem", ...cellCenter(8, 1), base: FLOOR_H - 0.15, float: true }, // in the hole: grab it on the way down
      { kind: "gem", ...cellCenter(13, 10), base: FLOOR_H },
      { kind: "bigGem", ...cellCenter(19, 11), base: FLOOR_H }, // the back gallery, after the crown
      { kind: "gem", ...cellCenter(3, 10), base: FLOOR_H },
    ];

    // -- geometry queries ----------------------------------------------------------------
    const bridgeCovers = (f, r) => inRect(f, r, bridgeRect) && r <= bridgeRect.r0 + (bridgeRect.r1 - bridgeRect.r0) * bridge + 1e-6 && bridge >= 1;
    // something to stand on in the upper floor at this cell (no matter what's below)
    function upperSurface(i, j, f, r) {
      const c = cell(1, i, j);
      if (c === "." || c === "E") return true;
      if (c === "=") return bridgeCovers(f, r);
      if (c === "D") return lift.h >= FLOOR_H - 0.005;
      const o = doorAt(1, i, j);
      return !!o && !doorShut(o);
    }
    // what's above you on the ground floor: a ceiling unless it's a void
    function upperSolid(i, j, f, r) {
      const c = cell(1, i, j);
      if (c === " " || c === "h") return false;
      if (c === "=") return bridge > 0 && r <= bridgeRect.r0 + (bridgeRect.r1 - bridgeRect.r0) * bridge;
      if (c === "D") return lift.h >= FLOOR_H - 0.005;
      return true;
    }

    // Heights you could stand at here, from the ground floor up.
    function surfaces(f, r) {
      const i = cellI(f);
      const j = cellJ(r);
      const hs = [];
      const c0 = cell(0, i, j);
      if (c0 === "#") hs.push(FLOOR_H);
      else if (c0 === "x") hs.push(-PIT_D);
      else if (c0 === "S") hs.push(stairRampH(f));
      else if (c0 === "o") hs.push(BLOCK_H);
      else {
        const o = doorAt(0, i, j);
        hs.push(o && doorShut(o) ? FLOOR_H : 0);
      }
      if (i === STAIRS.i0 - 1 && j >= STAIRS.j0 && j <= STAIRS.j1) hs.push(stairRampH(f)); // the foot of the slope
      if (inRect(f, r, lift)) hs.push(lift.h);
      if (upperSurface(i, j, f, r)) hs.push(FLOOR_H);
      if (cell(1, i, j) === "#") hs.push(FLOOR_H + WALL_H);
      return hs;
    }

    // The highest thing under your feet you can stand on. None (you've been
    // pushed into a wall): stay at the height you're at, rather than pop up.
    function groundAt(f, r, feet, fallback) {
      const ok = surfaces(f, r).filter((h) => h <= feet + STEP_UP);
      return ok.length ? Math.max(...ok) : fallback;
    }

    // Everything solid, as boxes in temple coordinates.
    function solids() {
      const out = walls[0].concat(walls[1], boundary);
      out.push(lowBlock);
      doors.forEach((o) => {
        if (!doorShut(o)) return;
        const h0 = o.fl * FLOOR_H;
        out.push({ f0: o.f0, f1: o.f1, r0: o.r0, r1: o.r1, h0, h1: h0 + WALL_H, door: o });
      });
      out.push({ f0: lift.f0, f1: lift.f1, r0: lift.r0, r1: lift.r1, h0: 0, h1: lift.h });
      return out;
    }
    // the ones in the way of a body standing at `feet`
    const blockers = (feet) => solids().filter((b) => b.h1 > feet + STEP_UP && b.h0 < feet + BODY_H);

    // Is a point inside something solid (for sight lines and flying things)?
    function pointSolid(f, r, h) {
      const i = cellI(f);
      const j = cellJ(r);
      if (i < 0 || i >= ROWS || j < 0 || j >= COLS) return true;
      const fl = h < FLOOR_H ? 0 : 1;
      if (fl === 1 && h > FLOOR_H + WALL_H) return false;
      if (cell(fl, i, j) === "#") return true;
      const o = doorAt(fl, i, j);
      if (o && doorShut(o)) return true;
      if (fl === 0 && cell(0, i, j) === "o" && h < BLOCK_H) return true;
      if (fl === 0 && inRect(f, r, lift) && h < lift.h) return true;
      return false;
    }
    // Clear line between two points? Walls, doors, and the upper floor's slab
    // (except where it's open) are in the way.
    function lineOfSight(a, b) {
      const len = Math.hypot(b.f - a.f, b.r - a.r, b.h - a.h);
      const steps = Math.max(1, Math.ceil(len / 0.04));
      let prev = a;
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        const p = { f: a.f + (b.f - a.f) * t, r: a.r + (b.r - a.r) * t, h: a.h + (b.h - a.h) * t };
        if (pointSolid(p.f, p.r, p.h)) return false;
        if ((prev.h - FLOOR_H) * (p.h - FLOOR_H) < 0) {
          const s = (FLOOR_H - prev.h) / (p.h - prev.h);
          const cf = prev.f + (p.f - prev.f) * s;
          const cr = prev.r + (p.r - prev.r) * s;
          if (upperSolid(cellI(cf), cellJ(cr), cf, cr)) return false;
        }
        prev = p;
      }
      return true;
    }

    const cam = () => {
      const cw = ar.cameraWorld();
      const l = api.toLocal(cw.x, cw.y);
      return { f: l.f, r: l.r, h: cw.h };
    };

    // -- walls stop the robot -----------------------------------------------------------
    // Directions pointing into a wall within CLEAR of the robot, as outward normals.
    function contacts(me, feet) {
      const out = [];
      blockers(feet).forEach((b) => {
        const qf = clamp(me.f, b.f0, b.f1);
        const qr = clamp(me.r, b.r0, b.r1);
        const df = me.f - qf;
        const dr = me.r - qr;
        const dist = Math.hypot(df, dr);
        if (dist >= CLEAR) return;
        if (dist > 1e-6) {
          out.push({ f: df / dist, r: dr / dist });
          return;
        }
        // inside it (pushed in, or it closed on you): out through the nearest face
        const faces = [[me.f - b.f0, -1, 0], [b.f1 - me.f, 1, 0], [me.r - b.r0, 0, -1], [b.r1 - me.r, 0, 1]];
        faces.sort((x, y) => x[0] - y[0]);
        out.push({ f: faces[0][1], r: faces[0][2] });
      });
      return out;
    }

    // The drive command (control-frame j1 = right, j2 = forward) with its
    // part into any wall taken out.
    function filterDrive(j1, j2) {
      if (!api.anchor()) return { j1, j2 };
      const t = ar.camTheta;
      const th = api.anchor().th;
      const vx = j2 * Math.cos(t) + j1 * Math.sin(t);
      const vy = j2 * Math.sin(t) - j1 * Math.cos(t);
      let vf = vx * Math.cos(th) + vy * Math.sin(th);
      let vr = vx * Math.sin(th) - vy * Math.cos(th);
      const me = api.toLocal(ar.pose.x, ar.pose.y);
      const cs = contacts(me, ar.feet());
      for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        cs.forEach((c) => {
          const dot = vf * c.f + vr * c.r;
          if (dot < -1e-6) {
            vf -= dot * c.f;
            vr -= dot * c.r;
            changed = true;
          }
        });
        if (!changed) break;
      }
      if (cs.some((c) => vf * c.f + vr * c.r < -1e-3)) vf = vr = 0; // wedged in a corner
      const wx = vf * Math.cos(th) + vr * Math.sin(th);
      const wy = vf * Math.sin(th) - vr * Math.cos(th);
      return { j1: wx * Math.sin(t) - wy * Math.cos(t), j2: wx * Math.cos(t) + wy * Math.sin(t) };
    }

    // -- every frame, playing or not: where you stand ------------------------------
    function physics(me) {
      const feet = ar.feet();
      ar.setGround(groundAt(me.f, me.r, feet, ar.ground));
      // Under the upper floor a jump stops at the ceiling (the camera must
      // stay below it, or the two storeys would be drawn in the wrong order).
      const i = cellI(me.f);
      const j = cellJ(me.r);
      if (ar.airborne && ar.vz > 0 && feet < FLOOR_H - 0.05 && upperSolid(i, j, me.f, me.r)) {
        const zMax = Math.max(0, FLOOR_H - 0.03 - ar.calib.heightM);
        if (ar.z > zMax) {
          ar.z = zMax;
          ar.vz = 0;
        }
      }
      feetFloor = ar.ground >= FLOOR_H - 0.01 && feet >= FLOOR_H - 0.03 ? 1 : 0;
    }

    // -- update --------------------------------------------------------------------------
    function wake(zone) {
      if (woken.has(zone)) return;
      woken.add(zone);
      const spot = (i, j) => cellCenter(i, j);
      const add = (kind, p, h = 0) => enemies.push({ kind, f: p.f, r: p.r, h, hp: kind === "mummy" ? n.mummyHp : kind === "bat" ? d.batHp : 1, phase: Math.random() * 6, hit: 0, retreat: 0, wait: 1 + Math.random(), sees: false, rect: null });
      if (zone === "hall") [spot(13, 4), spot(13, 8), spot(12, 6)].slice(0, n.hall).forEach((p) => add("scarab", p));
      if (zone === "wing") [spot(11, 2)].slice(0, n.wing).forEach((p) => add("scarab", p));
      if (zone === "crypt") [spot(14, 1), spot(19, 1)].slice(0, n.crypt).forEach((p) => add("mummy", p));
      if (zone === "vault") [spot(19, 8), spot(19, 4)].slice(0, n.vault).forEach((p) => add("mummy", p));
      if (zone === "escape") [spot(18, 2), spot(13, 1), spot(18, 9)].slice(0, n.bats).forEach((p) => add("bat", p, FLOOR_H + 0.2));
      if (zone !== "escape" && enemies.length) Lynx.sfx.play("growl");
    }

    // Walk or fly toward (tf, tr), sliding along walls.
    function moveEnemy(e, tf, tr, speed, dt) {
      const df = tf - e.f;
      const dr = tr - e.r;
      const dist = Math.hypot(df, dr) || 1;
      const sgn = e.retreat > 0 ? -1 : 1;
      const stepF = (sgn * df * speed * dt) / dist;
      const stepR = (sgn * dr * speed * dt) / dist;
      const rad = e.kind === "mummy" ? 0.06 : 0.04;
      const free = (f, r) => {
        for (const [a, b] of [[rad, 0], [-rad, 0], [0, rad], [0, -rad]]) {
          if (pointSolid(f + a, r + b, e.h + 0.02)) return false;
          if (e.kind !== "bat" && "xS".includes(cell(0, cellI(f + a), cellJ(r + b)))) return false; // walkers keep out of pits and off the stairs
        }
        return true;
      };
      if (free(e.f + stepF, e.r)) e.f += stepF;
      if (free(e.f, e.r + stepR)) e.r += stepR;
      e.flip = dr < 0;
    }

    function updateEnemies(dt, me) {
      const c = cam();
      losTimer -= dt;
      const checkSight = losTimer <= 0;
      if (checkSight) losTimer = 0.25;
      enemies.forEach((e) => {
        e.phase += dt * (e.kind === "bat" ? 7 : 5);
        e.hit = Math.max(0, e.hit - dt);
        e.retreat = Math.max(0, e.retreat - dt);
        e.wait = Math.max(0, e.wait - dt);
        if (checkSight) e.sees = lineOfSight({ f: e.f, r: e.r, h: e.h + 0.05 }, c);
        const slow = e.hit > 0 ? 0.3 : 1;
        if (e.kind === "bat") {
          if (e.wait > 0 || feetFloor !== 1) {
            e.h = FLOOR_H + 0.2 + 0.02 * Math.sin(e.phase);
            return;
          }
          moveEnemy(e, c.f, c.r, 0.15 * d.speed * slow, dt);
          const dh = c.h - 0.02 - e.h;
          e.h = clamp(e.h + Math.sign(dh) * Math.min(Math.abs(dh), 0.1 * dt), FLOOR_H + 0.06, FLOOR_H + WALL_H - 0.03);
          if (Math.hypot(c.f - e.f, c.r - e.r, c.h - e.h) < TOUCH_M && e.retreat === 0) {
            api.hurt("Bitten by a bat");
            e.retreat = 1.2;
          }
          return;
        }
        // walkers: only on the ground floor, and only after you once they see you
        if (e.wait > 0 || (!e.sees && e.retreat === 0) || feetFloor !== 0) return;
        const speed = (e.kind === "mummy" ? 0.07 : 0.12) * d.speed * slow;
        moveEnemy(e, me.f, me.r, speed, dt);
        const close = Math.hypot(me.f - e.f, me.r - e.r) < (e.kind === "mummy" ? 0.14 : 0.1);
        if (close && e.retreat === 0 && ar.feet() < (e.kind === "mummy" ? 0.12 : 0.05)) {
          api.hurt(e.kind === "mummy" ? "The mummy strikes!" : "Scarab bite -- jump over them!");
          e.retreat = 1;
        }
      });
      enemies = enemies.filter((e) => !e.dead);
    }

    function updateDoors(dt, me) {
      doors.forEach((o) => {
        o.lift = clamp(o.lift + (o.open ? dt : -dt * 2), 0, 1);
        if (o.kind !== "door" || o.open || o.sealed) return;
        const near = feetFloor === o.fl && me.f > o.f0 - 0.3 && me.f < o.f1 + 0.3 && me.r > o.r0 - 0.1 && me.r < o.r1 + 0.1;
        if (!near) {
          o.warned = false;
          return;
        }
        if (keys[o.color]) {
          o.open = true;
          Lynx.sfx.play("gate");
          api.say(`The ${o.color} door opens`, "#50ff78");
        } else if (!o.warned) {
          o.warned = true;
          Lynx.sfx.play("knock");
          api.say(`Locked -- it needs the ${o.color} key`, "#ffb060");
        }
      });
    }

    function operate(s) {
      if (s.id === "bridge") {
        api.say("Stone grinds somewhere above...", "#ffd84a");
        Lynx.sfx.play("crate");
      } else if (s.id === "g1") {
        door("g1").open = true;
        api.say("The gate rises", "#50ff78");
        Lynx.sfx.play("gate");
      }
    }

    function takeCrown() {
      crown = true;
      lift.target = FLOOR_H;
      door("g2").open = true;
      door("g3").open = true;
      api.addScore(2000);
      Lynx.sfx.play("power");
      api.say("The Sun Crown! Lava floods the sanctum -- escape upstairs to the sun gate!", "#ffd84a");
      wake("escape");
    }

    function updateItems(me) {
      const feet = ar.feet();
      items = items.filter((it) => {
        const base = it.onLift ? lift.h : it.base;
        if (Math.hypot(me.f - it.f, me.r - it.r) > 0.13 || feet < base - 0.05 || feet > base + 0.3) return true;
        if (it.kind === "crown") {
          takeCrown();
          return false;
        }
        if (it.kind === "keyRed" || it.kind === "keyBlue") {
          const color = it.kind === "keyRed" ? "red" : "blue";
          keys[color] = true;
          api.addScore(200);
          Lynx.sfx.play("pickup");
          api.say(`The ${color} key!`, color === "red" ? "#ff6060" : "#60a0ff");
        } else if (it.kind === "potion") {
          api.heal();
          Lynx.sfx.play("pickup");
          api.say("A healing potion");
        } else {
          api.addScore(it.kind === "bigGem" ? 750 : 250);
          Lynx.sfx.play("coin");
        }
        return false;
      });
    }

    function update(dt, me) {
      bridge = sw("bridge").on ? Math.min(1, bridge + dt / 2.5) : bridge;
      if (lift.h < lift.target) lift.h = Math.min(lift.target, lift.h + dt * 0.08);
      if (crown) lavaH = Math.min(LAVA_TOP, lavaH + ((LAVA_TOP + 0.05) / n.lavaS) * dt);
      switches.forEach((s) => (s.hit = Math.max(0, s.hit - dt)));

      // pits: land in one and you're hurt and bounced out
      if (wasAirborne && !ar.airborne && ar.ground < 0) {
        api.hurt("Spikes! Jump across");
        ar.jump();
      }
      wasAirborne = ar.airborne;
      // lava on the ground floor
      if (lavaH > 0 && feetFloor === 0 && !ar.airborne && ar.feet() < lavaH + 0.005) api.hurt("Lava! Get upstairs");

      // the vault's pressure plate slams the red door behind you
      if (!plateDone && feetFloor === 0 && inRect(me.f, me.r, plateRect) && ar.feet() < 0.03) {
        plateDone = true;
        const red = door("red");
        red.open = false;
        red.sealed = true;
        Lynx.sfx.play("explode");
        api.say("Click... the door slams shut behind you!", "#ff6060");
        wake("vault");
      }

      Object.entries(zones).forEach(([name, z]) => {
        if (feetFloor === z.fl && inRect(me.f, me.r, z)) {
          wake(name);
          visited.add(name);
        }
      });

      // fog of war for the minimap: what you've been near
      const i0 = cellI(me.f);
      const j0 = cellJ(me.r);
      for (let i = i0 - 3; i <= i0 + 3; i++) {
        for (let j = j0 - 3; j <= j0 + 3; j++) {
          if (i >= 0 && i < ROWS && j >= 0 && j < COLS) seen[feetFloor][i][j] = true;
        }
      }

      updateDoors(dt, me);
      updateItems(me);
      updateEnemies(dt, me);

      // the sun gate
      if (crown && feetFloor === 1 && inRect(me.f, me.r, { f0: exitRect.f0 - 0.1, f1: exitRect.f1 + 0.1, r0: exitRect.r0, r1: exitRect.r1 })) {
        api.complete();
      }
    }

    // -- shooting ------------------------------------------------------------------------
    function targets() {
      const out = [];
      enemies.forEach((e) => e.rect && out.push({ obj: e, kind: e.kind }));
      switches.forEach((s) => s.rect && !s.on && out.push({ obj: s, kind: "switch" }));
      return out;
    }

    function hit(t) {
      const o = t.obj;
      o.hit = 0.15;
      if (t.kind === "switch") {
        o.on = true;
        api.addScore(100);
        Lynx.sfx.play("zap");
        operate(o);
        return;
      }
      o.hp--;
      if (o.hp > 0) {
        Lynx.sfx.play("pain");
        return;
      }
      o.dead = true;
      const w = api.toWorld(o.f, o.r);
      api.puff({ x: w.x, y: w.y, h: o.h + 0.03, t: 0, color: "255,230,200" });
      api.addScore(o.kind === "mummy" ? 300 : o.kind === "bat" ? 100 : 50);
      Lynx.sfx.play("die");
    }

    // -- drawing -------------------------------------------------------------------------
    const rectPoly = (q, h) => [api.w3(q.f0, q.r0, h), api.w3(q.f1, q.r0, h), api.w3(q.f1, q.r1, h), api.w3(q.f0, q.r1, h)];

    function fillRect(q, h, fill, stroke) {
      const p = api.polyScreen(rectPoly(q, h), 3);
      if (p) api.fillPoly(p, fill, stroke);
    }

    // the upper floor's walkable (or, from below, solid) cells as rectangles
    function upperRects(pred) {
      const rects = mergeCells((i, j) => {
        const c = cellCenter(i, j);
        return pred(i, j, c.f, c.r);
      });
      return rects;
    }

    function drawGroundFloorBase() {
      // Seen from the ground floor, the floor is the real one in the video
      // (a light tint); from higher up the video shows it from the wrong
      // height, so looking down a hole or the stairwell you see stone.
      const above = cam().h >= FLOOR_H;
      floorRects.forEach((q) => {
        fillRect(q, 0.001, above ? "#4a3a26" : "rgba(35,26,16,0.35)", above ? "rgba(20,12,4,0.7)" : "rgba(90,70,40,0.35)");
        if (above && api.texFloor) api.texFloor(q, 0.001, "darkflag", 0.15);
      });
      // spike pit
      const pit = api.polyScreen(rectPoly(pitRect, 0.002), 3);
      if (pit) api.fillPoly(pit, "#1a1410", "rgba(120,90,60,0.9)", 2);
      for (let f = pitRect.f0 + 0.03; f < pitRect.f1; f += 0.06) {
        for (let r = pitRect.r0 + 0.04; r < pitRect.r1; r += 0.08) api.line3([[f, r - 0.012, 0.003], [f, r, 0.03], [f, r + 0.012, 0.003]], "#b8b0a0", 2, 0.02);
      }
      // pressure plate
      fillRect({ f0: plateRect.f0 + 0.02, f1: plateRect.f1 - 0.02, r0: plateRect.r0 + 0.02, r1: plateRect.r1 - 0.02 }, 0.004, plateDone ? "#606060" : "#8a7a60", "#3a3020");
      // lava
      if (lavaH > 0) {
        const glow = Math.round(90 + 30 * Math.sin(api.time() * 3));
        floorRects.forEach((q) => fillRect(q, lavaH, `rgba(255,${glow},20,0.8)`, null));
      }
    }

    function queueGroundFloor() {
      const c = cam();
      walls[0].forEach((q) => api.box(q, 0, WALL_H, q.f0 >= 13 * CELL - 1e-6 && q.r1 <= R_MIN + 3 * CELL + 1e-6 ? CRYPT : SANDSTONE));
      outer.filter((q) => q.h0 === 0).forEach((q) => api.box(q, 0, WALL_H, SANDSTONE));
      for (let i = STAIRS.i0; i <= STAIRS.i1; i++) api.box(cellRect(i, i, STAIRS.j0, STAIRS.j1), 0, stepH(i), STEP_COL);
      api.box(lowBlock, 0, BLOCK_H, SANDSTONE);
      api.box(lift, 0, lift.h, DAIS_COL);
      doors.filter((o) => o.fl === 0).forEach(queueDoor);
      queueThings(0, c);
    }

    function queueUpperFloor() {
      const c = cam();
      walls[1].forEach((q) => api.box(q, FLOOR_H, FLOOR_H + WALL_H, SANDSTONE));
      outer.filter((q) => q.h0 === FLOOR_H).forEach((q) => api.box(q, FLOOR_H, FLOOR_H + WALL_H, SANDSTONE));
      doors.filter((o) => o.fl === 1).forEach(queueDoor);
      queueThings(1, c);
      queueExit();
    }

    // A door (a colored slab that slides up) or a gate (bars), in the middle of its cells.
    function queueDoor(o) {
      const base = o.fl * FLOOR_H;
      const mf = (o.f0 + o.f1) / 2;
      const up = o.lift * WALL_H * 0.95;
      if (up >= WALL_H * 0.94) return;
      if (o.kind === "door") {
        api.box({ f0: mf - 0.025, f1: mf + 0.025, r0: o.r0, r1: o.r1 }, base + up, base + WALL_H, DOOR_COL[o.color]);
        return;
      }
      const mid = api.toWorld(mf, (o.r0 + o.r1) / 2);
      const depth = api.camZ(mid.x, mid.y, base + 0.15);
      if (depth < -0.5) return;
      ar.queue(depth, () => {
        for (let r = o.r0 + 0.04; r < o.r1; r += 0.07) api.line3([[mf, r, base + up], [mf, r, base + WALL_H]], "#2e2e34", 4, 0.05);
        [0.07, 0.2].forEach((h) => base + h > base + up && api.line3([[mf, o.r0, base + h], [mf, o.r1, base + h]], "#3c3c44", 4, 0.1));
      }, api.extent(mf - 0.01, mf + 0.01, o.r0, o.r1, base + up, base + WALL_H));
    }

    // items, enemies and switches of one storey (by height)
    function queueThings(fl, c) {
      const onFloor = (h) => (h < FLOOR_H - 0.001 ? 0 : 1) === fl;
      items.forEach((it) => {
        const base = it.onLift ? lift.h : it.base;
        if (!onFloor(base + 0.01)) return;
        const w = api.toWorld(it.f, it.r);
        const bob = Math.sin(api.time() * 3 + it.f * 7) * 0.012;
        const spr = img[it.kind] || api.img[it.kind];
        const size = it.kind === "crown" ? 0.07 : it.kind === "potion" ? 0.06 : it.kind.startsWith("key") ? 0.035 : 0.05;
        if (!lineOfSight({ f: it.f, r: it.r, h: base + 0.05 }, c)) {
          it.rect = null;
          return;
        }
        api.drawSprite(it, spr, w.x, w.y, base + 0.03 + bob, size, {
          before: (r) => ar.glow(r.cx, r.y + r.h / 2, r.w * 1.3, [[0, "rgba(255,255,220,0.7)"], [1, "rgba(255,255,200,0)"]]),
        });
      });
      enemies.forEach((e) => {
        if (!onFloor(e.h + 0.01)) return;
        const visible = lineOfSight({ f: e.f, r: e.r, h: e.h + 0.04 }, c);
        if (!visible) {
          e.rect = null;
          return;
        }
        const w = api.toWorld(e.f, e.r);
        if (e.kind === "bat") api.drawSprite(e, api.img.bat, w.x, w.y, e.h + Math.sin(e.phase) * 0.015, 0.06, { flip: Math.sin(e.phase * 0.35) < 0 });
        else if (e.kind === "scarab") api.drawSprite(e, api.img.scarab, w.x, w.y, e.h, 0.045, { flip: e.flip });
        else api.drawSprite(e, img.mummy, w.x, w.y, e.h + Math.abs(Math.sin(e.phase)) * 0.004, 0.2, { flip: e.flip });
      });
      switches.forEach((s) => {
        if (!onFloor(s.h)) return;
        queueSwitch(s, c);
      });
    }

    // A sun disk on a wall face: gold ring, a gem that turns green when shot.
    function queueSwitch(s, c) {
      s.rect = null;
      const facing = (c.f - s.f) * s.n.f + (c.r - s.r) * s.n.r;
      if (facing <= 0.01) return;
      const eye = { f: s.f + s.n.f * 0.01, r: s.r + s.n.r * 0.01, h: s.h };
      if (!lineOfSight(eye, c)) return;
      const u = { f: -s.n.r, r: s.n.f }; // along the wall
      const ring = (rad) => {
        const pts = [];
        for (let k = 0; k < 16; k++) {
          const a = (k / 16) * 2 * Math.PI;
          const w = api.toWorld(eye.f + u.f * rad * Math.cos(a), eye.r + u.r * rad * Math.cos(a));
          const p = api.camZ(w.x, w.y, s.h + rad * Math.sin(a)) >= 0.06 ? ar.project(w.x, w.y, s.h + rad * Math.sin(a)) : null;
          if (!p) return null;
          pts.push(p);
        }
        return pts;
      };
      const outer = ring(0.04);
      if (!outer) return;
      const xs = outer.map((p) => p.x);
      const ys = outer.map((p) => p.y);
      const cw = api.toWorld(eye.f, eye.r);
      const center = ar.project(cw.x, cw.y, s.h);
      s.rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), depth: center ? center.depth : 1, cx: center ? center.x : 0 };
      ar.queue(s.rect.depth, () => {
        if (!s.on) ar.glow(s.rect.x + s.rect.w / 2, s.rect.y + s.rect.h / 2, s.rect.w * 1.4, [[0, "rgba(255,220,100,0.5)"], [1, "rgba(255,200,60,0)"]]);
        api.fillPoly(outer, s.hit > 0 ? "#ffffff" : "#e0b030", "#704810", 2);
        const inner = ring(0.018);
        if (inner) api.fillPoly(inner, s.on ? "#40ff70" : "#ff3030", "#401000", 1);
      }, api.extent(Math.min(s.f, eye.f), Math.max(s.f, eye.f), Math.min(s.r, eye.r), Math.max(s.r, eye.r), s.h - 0.04, s.h + 0.04));
    }

    // The sun gate: a ring of stone, alight once you carry the crown.
    function queueExit() {
      const cf = exitRect.f0 + CELL / 2;
      const cr = (exitRect.r0 + exitRect.r1) / 2;
      const ch = FLOOR_H + 0.16;
      const mid = api.toWorld(cf, cr);
      const depth = api.camZ(mid.x, mid.y, ch);
      if (depth < 0.06) return;
      ar.queue(depth, () => {
        const pts = [];
        for (let k = 0; k <= 24; k++) {
          const a = (k / 24) * 2 * Math.PI;
          pts.push([cf, cr + 0.13 * Math.cos(a), ch + 0.14 * Math.sin(a)]);
        }
        api.line3(pts, crown ? "#ffe060" : "#6a6050", crown ? 6 : 8, 0.03);
        if (crown) {
          const p = ar.project(mid.x, mid.y, ch);
          if (p) ar.glow(p.x, p.y, 0.16 * p.ppm * (1 + 0.1 * Math.sin(api.time() * 5)), [[0, "rgba(255,255,220,0.9)"], [0.6, "rgba(255,200,80,0.5)"], [1, "rgba(255,160,40,0)"]]);
        }
      }, api.extent(cf - 0.01, cf + 0.01, cr - 0.13, cr + 0.13, ch - 0.14, ch + 0.14));
    }

    function drawSlabTop() {
      upperRects((i, j, f, r) => upperSurface(i, j, f, r) && cell(1, i, j) !== "D" && cell(1, i, j) !== "=").forEach((q) => {
        fillRect(q, FLOOR_H, "#b09060", "rgba(50,32,12,0.6)");
        if (api.texFloor) api.texFloor(q, FLOOR_H, "flagstone", 0.08);
      });
      // the bridge while it slides out
      if (bridge > 0 && bridge < 1) fillRect({ ...bridgeRect, r1: bridgeRect.r0 + (bridgeRect.r1 - bridgeRect.r0) * bridge }, FLOOR_H, "#9a7a4a", "#3a2810");
      if (bridge >= 1) fillRect(bridgeRect, FLOOR_H + 0.001, "#9a7a4a", "#3a2810");
      const end = bridgeRect.r0 + (bridgeRect.r1 - bridgeRect.r0) * bridge;
      for (let r = bridgeRect.r0 + 0.05; r < end; r += 0.05) api.line3([[bridgeRect.f0, r, FLOOR_H + 0.002], [bridgeRect.f1, r, FLOOR_H + 0.002]], "rgba(40,25,10,0.7)", 1.5, 0.1);
    }

    function drawCeiling() {
      upperRects((i, j, f, r) => upperSolid(i, j, f, r)).forEach((q) => fillRect(q, FLOOR_H, "#2a2016", "rgba(0,0,0,0.5)"));
    }

    function drawTorches(fl) {
      const base = fl * FLOOR_H;
      const spots = fl === 0 ? [[0.6, R_MIN + 0.01], [0.6, -R_MIN - 0.01], [1.6, R_MIN + 3 * CELL + 0.01], [2.6, R_MIN + 4 * CELL + 0.01], [2.4, R_MIN + 0.01]]
        : [[1.2, R_MIN + 0.01], [2.9, 0], [0.6, -R_MIN - 0.01]];
      spots.forEach(([f, r]) => {
        const w = api.toWorld(f, r);
        const h = base + 0.2;
        const p = api.camZ(w.x, w.y, h) >= 0.06 ? ar.project(w.x, w.y, h) : null;
        if (!p || !lineOfSight({ f, r: r + Math.sign(-r) * 0.02, h }, cam())) return;
        ar.queue(p.depth - 0.01, () => {
          const flick = 0.85 + 0.15 * Math.sin(api.time() * 17 + f * 5 + r);
          ar.glow(p.x, p.y, 0.09 * p.ppm * flick, [[0, "rgba(255,240,160,0.95)"], [0.35, "rgba(255,150,40,0.6)"], [1, "rgba(255,100,0,0)"]]);
        }, api.pointAt(w.x, w.y, h, h));
      });
    }

    function draw() {
      const c = cam();
      if (c.h >= FLOOR_H) {
        drawGroundFloorBase();
        queueGroundFloor();
        drawTorches(0);
        ar.flush();
        drawSlabTop();
        queueUpperFloor();
        drawTorches(1);
        ar.flush();
      } else {
        queueUpperFloor();
        ar.flush();
        drawCeiling();
        drawGroundFloorBase();
        queueGroundFloor();
        drawTorches(0);
        ar.flush();
      }
    }

    // -- HUD -----------------------------------------------------------------------------
    function hud() {
      const v = ar.view;
      // keys held
      let x = v.x + 14;
      ["red", "blue"].forEach((color) => {
        if (!keys[color]) return;
        const spr = color === "red" ? img.keyRed : img.keyBlue;
        ar.drawSprite(spr, { x, y: v.y + v.h - 110, w: 34, h: 14 });
        x += 40;
      });
      if (crown) ar.drawSprite(img.crown, { x, y: v.y + v.h - 114, w: 28, h: 16 });
      // minimap of the storey you're on, far end up, what you've been near
      const s = Math.max(4, Math.min(8, Math.floor((v.h * 0.3) / ROWS)));
      const mx = v.x + v.w - COLS * s - 12;
      const my = v.y + 12;
      const g = ar.ctx;
      g.save();
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.fillRect(mx - 3, my - 3, COLS * s + 6, ROWS * s + 6);
      const fl = feetFloor;
      for (let i = 0; i < ROWS; i++) {
        for (let j = 0; j < COLS; j++) {
          if (!seen[fl][i][j]) continue;
          const ch = cell(fl, i, j);
          const cc = cellCenter(i, j);
          const o = doorAt(fl, i, j);
          let col;
          if (o) col = doorShut(o) ? (o.color === "red" ? "#e04040" : o.color === "blue" ? "#4070e0" : "#707078") : "#c8b890";
          else if (ch === "#") col = "#6a5638";
          else if (fl === 1 && !upperSurface(i, j, cc.f, cc.r)) col = ch === "=" ? "#3a2a14" : "#120c06";
          else if (ch === "S") col = "#e0c080";
          else if (ch === "x") col = "#402010";
          else col = lavaH > 0 && fl === 0 ? "#c05010" : "#c8b890";
          g.fillStyle = col;
          g.fillRect(mx + j * s, my + (ROWS - 1 - i) * s, s, s);
        }
      }
      const me = api.toLocal(ar.pose.x, ar.pose.y);
      const px = mx + ((me.r - R_MIN) / CELL) * s;
      const py = my + (ROWS - me.f / CELL) * s;
      const a = ar.camTheta - api.anchor().th; // 0 = toward the far end
      g.fillStyle = "#28c8ff";
      g.beginPath();
      g.moveTo(px - Math.sin(a) * s * 1.6, py - Math.cos(a) * s * 1.6);
      g.lineTo(px + Math.cos(a) * s * 0.7, py - Math.sin(a) * s * 0.7);
      g.lineTo(px - Math.cos(a) * s * 0.7, py + Math.sin(a) * s * 0.7);
      g.closePath();
      g.fill();
      g.restore();
      ar.text(fl ? "UPPER FLOOR" : "GROUND FLOOR", mx + (COLS * s) / 2, my + ROWS * s + 16, { size: 11, align: "center", color: "#ffd84a" });
    }

    function objective() {
      const at = (p, h) => ({ at: { f: p.f, r: p.r }, h });
      const s1 = sw("bridge");
      const itemAt = (kind) => items.find((it) => it.kind === kind);
      if (!s1.on) return { text: "A sun disk glints high up in the hall -- tilt up and shoot it", ...at(s1, s1.h) };
      if (!keys.blue) return { text: "Up the stairs and over the bridge: the blue key", ...at(itemAt("keyBlue"), FLOOR_H) };
      if (!keys.red) {
        if (!visited.has("wing")) return { text: "Drop through the hole in the west gallery", ...at({ f: (holeRect.f0 + holeRect.f1) / 2, r: -0.75 }, FLOOR_H) };
        if (!door("blue").open) return { text: "The blue door, north of the west wing", ...at({ f: door("blue").f0, r: -0.75 }, 0.15) };
        return { text: "Find the red key in the crypt (mind the spikes)", ...at(itemAt("keyRed"), 0.02) };
      }
      if (!crown) {
        if (!door("red").open && !plateDone) return { text: "The red door, at the back of the hall", ...at({ f: door("red").f0, r: 0 }, 0.15) };
        return { text: "Take the Sun Crown from its dais", ...at(liftCenter, lift.h) };
      }
      return { text: "Escape! The sun gate at the front of the upper floor", ...at({ f: exitRect.f0 + CELL / 2, r: 0 }, FLOOR_H + 0.16) };
    }

    function blips() {
      const out = [];
      enemies.forEach((e) => out.push({ ...api.toWorld(e.f, e.r), color: e.kind === "mummy" ? "#ffffff" : "#ff4040" }));
      items.forEach((it) => out.push({ ...api.toWorld(it.f, it.r), color: it.kind === "keyRed" ? "#ff4040" : it.kind === "keyBlue" ? "#4080ff" : "#ffd84a", r: 2.5 }));
      return out;
    }

    function carryOn() {
      enemies.forEach((e) => (e.retreat = 2));
    }

    return {
      physics,
      update,
      draw,
      hud,
      objective,
      blips,
      targets,
      hit,
      carryOn,
      filterDrive,
      floorName: () => (feetFloor ? "upper floor" : "ground floor"),
      debug: {
        give: (k) => (k === "crown" ? takeCrown() : (keys[k] = true)),
        shoot: (id) => {
          const s = sw(id);
          s.on = true;
          operate(s);
        },
        switches: () => switches.map((s) => ({ id: s.id, on: s.on, rect: s.rect })),
        blockers,
        groundAt,
        lineOfSight,
        cellCenter,
        stepH,
        CELL, FLOOR_H, R_MIN,
      },
      snapshot: () => ({
        floor: feetFloor, keys: { ...keys }, crown, bridge: +bridge.toFixed(2), lift: +lift.h.toFixed(3), lava: +lavaH.toFixed(3),
        doors: Object.fromEntries(doors.map((o) => [o.id, o.open ? "open" : "shut"])),
        switches: Object.fromEntries(switches.map((s) => [s.id, s.on])),
        enemies: enemies.map((e) => e.kind), items: items.map((it) => it.kind), woken: [...woken],
      }),
    };
  };
})(window.Lynx);
