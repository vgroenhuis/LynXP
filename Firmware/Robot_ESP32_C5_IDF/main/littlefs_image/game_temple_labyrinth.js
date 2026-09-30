// Temple of LynXP, level 4: the clockwork labyrinth. Run by game_temple.js
// (score, hearts, shooting, HUD, game flow) through Lynx.templeLabyrinth(),
// the same way as level 2's game_temple_sanctum.js.
//
// Huge, on the same 2 x 3 m of floor: three wings -- the hall of gears, the
// bone crypt and the moon sanctum -- each a full 2 x 3 m labyrinth of 15 cm
// cells, laid over the same floor and linked by portals. A portal sits at the
// same spot in both wings it joins: step into it and the other wing appears
// around you (the robot doesn't move).
//
// Walls stop the robot (drive commands lose their part into a wall, as in the
// sanctum). The hall of gears and the bone crypt each have a rotating door at
// their crossroads, hinged at a corner: it blocks either the passage north or
// the one east, and swings 90 degrees when its switch -- a sun disk you shoot,
// usable again and again -- is operated. Each door's switch is in the OTHER
// wing. So:
//   - the gears door starts across the east passage (the vault, a moon stone);
//     its switch is in the crypt's east room;
//   - the bones door starts across the crypt's north passage (the second moon
//     stone); its switch is in the gear hall's vault, behind the gears door;
//   - the moon sanctum's gate (through the portal in the north hall) wants
//     both stones -- and the north hall is only open while the gears door is
//     across the east passage.
// The way through: crypt (turn the gears), vault (stone, turn the bones),
// crypt (stone), vault (turn the bones back), crypt (turn the gears back),
// moon sanctum (the idol) -- and taking the idol turns the gears once more,
// sealing you in the north hall until you find the switch hidden there.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const CELL = 0.15;
  const ROWS = 20; // along f
  const COLS = 12; // along r
  const R_MIN = -0.9; // r of column 0's left edge
  const WALL_H = 0.3; // a jump is 0.28: no jumping over walls
  const STEP_UP = 0.06;
  const BODY_H = 0.12;
  const CLEAR = 0.11; // the robot keeps this far from walls
  const PIT_D = 0.12;
  const DAIS_H = 0.05; // the idol's dais: low enough to walk onto
  const DOOR_LEN = 2 * CELL; // a rotating door spans a two-cell passage
  const DOOR_T = 0.05; // its thickness
  const SWING_S = 0.9; // a quarter turn takes this long
  const SWITCH_COOLDOWN_S = 1.5; // after a switch turns, shots at it do nothing for a moment (auto-fire!)

  // Far end first, as seen from the entrance; one character per cell.
  // # wall, . floor, O portal, x spike pit, M the moon gate (two moon
  // stones), I the idol's dais.
  const WINGS = [
    {
      id: "gears",
      name: "hall of gears",
      map: [
        "###......###", // 19
        "###..OO..###", // portal to the moon sanctum
        "###..OO..###",
        "###......###",
        "###.#..#.###", // 15
        "###......###",
        "#####..#####",
        "#OO.#..#...#", // portal to the bone crypt | north passage | the vault
        "#OO.#..#...#",
        "#..........#", // 10: the crossroads (cols 5-6)
        "#..........#",
        "#...#..#...#",
        "#...#..#...#",
        "#####..#####",
        "#####xx#####", // 5: spikes across the way in
        "#####..#####",
        "##........##",
        "##........##",
        "##........##",
        "##........##", // 0
      ],
      wall: "sandstone",
      tint: "rgba(35,26,16,0.35)",
      entrance: true,
    },
    {
      id: "bones",
      name: "bone crypt",
      map: [
        "##........##", // 19
        "##..####..##",
        "##........##",
        "##........##",
        "##.#.xx.#.##", // 15: a pit to jump, pillars beside it
        "##........##",
        "#####..#####",
        "#OO.#..#...#", // portal to the hall of gears | north passage | the east room
        "#OO.#..#...#",
        "#..........#", // 10: the crossroads
        "#..........#",
        "#...#..#...#",
        "#...#..#...#",
        "#####..#####",
        "###......###", // 5: the ossuary
        "###.#..#.###",
        "###......###",
        "############",
        "############",
        "############", // 0
      ],
      wall: "crypt",
      tint: "rgba(20,18,14,0.45)",
    },
    {
      id: "moon",
      name: "moon sanctum",
      map: [
        "##........##", // 19
        "##...OO...##", // portal to the hall of gears
        "##...OO...##",
        "##........##",
        "##.##..##.##", // 15
        "##........##",
        "#####MM#####", // the moon gate
        "###......###",
        "###.#..#.###",
        "###..II..###", // 10: the idol's dais
        "###..II..###",
        "###.#..#.###",
        "###......###",
        "############",
        "############", // 5
        "############",
        "############",
        "############",
        "############",
        "############", // 0
      ],
      wall: "moon", // each wing its own stone: you see at once where a portal took you
      tint: "rgba(20,30,60,0.35)",
    },
  ].map((w) => ({ ...w, map: w.map.slice().reverse() })); // [row i][col j]

  const COUNTS = {
    easy: { westScarabs: 0, vaultMummies: 0, cryptMummies: 1, ossuary: 1, eastBats: 0, moonWisps: 1, escape: 1, mummyHp: 3 },
    normal: { westScarabs: 1, vaultMummies: 1, cryptMummies: 1, ossuary: 2, eastBats: 1, moonWisps: 2, escape: 2, mummyHp: 4 },
    hard: { westScarabs: 2, vaultMummies: 1, cryptMummies: 2, ossuary: 3, eastBats: 2, moonWisps: 3, escape: 3, mummyHp: 5 },
  };

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
  const STONE = ["..www..", ".wbbbw.", "wbbwbbw", "wbwbbbw", "wbbbbbw", ".wbbbw.", "..www.."];
  const IDOL = [
    "...kkkk...",
    "..kwwwwk..",
    ".kwkwwkwk.",
    ".kwwwwwwk.",
    "..kwkkwk..",
    "...kwwk...",
    "..kwwwwk..",
    ".kwwwwwwk.",
    ".kwwbbwwk.",
    ".kwwwwwwk.",
    "..kkkkkk..",
  ];

  const WALL_COL = {
    sandstone: { top: "#c8a868", side: "#98783c", dark: "#705426", line: "rgba(40,25,10,0.6)", mortar: true, tex: "sandstone" },
    crypt: { top: "#9a8866", side: "#6e5e44", dark: "#4e412e", line: "rgba(20,12,5,0.6)", mortar: true, tex: "crypt" },
    moon: { top: "#8a90b8", side: "#62688e", dark: "#464a6a", line: "rgba(10,10,30,0.6)", mortar: true, tex: "moonstone" },
  };
  const DOOR_COL = { top: "#b08840", side: "#8a6428", dark: "#5e4418", line: "rgba(40,24,4,0.9)", door: true, doorH: WALL_H - 0.03, symbol: "gear", glyph: "#e8c060" }; // bronze, a gear on each leaf
  const POST_COL = { top: "#d0b060", side: "#9a7a30", dark: "#6a5220", line: "rgba(40,24,4,0.9)" };
  const DAIS_COL = { top: "#8090c0", side: "#5a6898", dark: "#3e4a70", line: "rgba(10,10,40,0.8)" };
  const GATE_BAR = "#b8c4e8";

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const cellI = (f) => Math.floor(f / CELL);
  const cellJ = (r) => Math.floor((r - R_MIN) / CELL);
  const cellRect = (i0, i1, j0, j1) => ({ f0: i0 * CELL, f1: (i1 + 1) * CELL, r0: R_MIN + j0 * CELL, r1: R_MIN + (j1 + 1) * CELL });
  const cellCenter = (i, j) => ({ f: (i + 0.5) * CELL, r: R_MIN + (j + 0.5) * CELL });
  const inRect = (f, r, q) => f >= q.f0 && f <= q.f1 && r >= q.r0 && r <= q.r1;
  const grow = (q, m) => ({ f0: q.f0 - m, f1: q.f1 + m, r0: q.r0 - m, r1: q.r1 + m });
  function cell(w, i, j) {
    if (i < 0 || i >= ROWS || j < 0 || j >= COLS) return "#";
    return WINGS[w].map[i][j];
  }
  function rectOf(w, ch, rows) {
    let i0 = ROWS, i1 = -1, j0 = COLS, j1 = -1;
    for (let i = 0; i < ROWS; i++) {
      if (rows && (i < rows[0] || i > rows[1])) continue;
      for (let j = 0; j < COLS; j++) {
        if (WINGS[w].map[i][j] !== ch) continue;
        i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
      }
    }
    return cellRect(i0, i1, j0, j1);
  }
  // Cells matching pred merged into few rectangles (runs along r, joined
  // across rows), as in the sanctum.
  function mergeCells(pred) {
    const open = new Map();
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

  Lynx.templeLabyrinth = (api) => {
    const { ar, d } = api;
    const n = COUNTS[api.cfg.difficulty] || COUNTS.normal;
    const img = {
      mummy: Lynx.sprite(MUMMY, MUMMY_PAL),
      stone: Lynx.sprite(STONE, { w: "#e8f0ff", b: "#6080ff" }),
      idol: Lynx.sprite(IDOL, { k: "#302810", w: "#f0f4ff", b: "#60a0ff" }),
    };

    // -- the building ----------------------------------------------------------------
    const LEN = ROWS * CELL;
    const R_MAX = R_MIN + COLS * CELL;
    const OUT = 5;
    const boundary = [
      { f0: -OUT, f1: 0, r0: -OUT, r1: OUT, h0: -1, h1: 3 },
      { f0: LEN, f1: OUT, r0: -OUT, r1: OUT, h0: -1, h1: 3 },
      { f0: -OUT, f1: OUT, r0: -OUT, r1: R_MIN, h0: -1, h1: 3 },
      { f0: -OUT, f1: OUT, r0: R_MAX, r1: OUT, h0: -1, h1: 3 },
    ];
    const THICK = 0.06;
    const wings = WINGS.map((W, w) => {
      const outer = [];
      for (let f = 0; f < LEN - 1e-6; f += 0.6) {
        outer.push({ f0: f, f1: Math.min(LEN, f + 0.6), r0: R_MIN - THICK, r1: R_MIN });
        outer.push({ f0: f, f1: Math.min(LEN, f + 0.6), r0: R_MAX, r1: R_MAX + THICK });
      }
      outer.push({ f0: LEN, f1: LEN + THICK, r0: R_MIN - THICK, r1: 0 });
      outer.push({ f0: LEN, f1: LEN + THICK, r0: 0, r1: R_MAX + THICK });
      const gap = W.entrance ? CELL : 0; // the way in (and out)
      outer.push({ f0: -THICK, f1: 0, r0: R_MIN - THICK, r1: -gap });
      outer.push({ f0: -THICK, f1: 0, r0: gap, r1: R_MAX + THICK });
      return {
        ...W,
        walls: mergeCells((i, j) => cell(w, i, j) === "#").map((q) => ({ ...q, h0: 0, h1: WALL_H })),
        // for drawing: the outer ring's wall cells are grating (api.fence), the rest stone
        wallsDrawn: mergeCells((i, j) => cell(w, i, j) === "#" && !api.onRim(i, j, ROWS, COLS)),
        rimWalls: mergeCells((i, j) => cell(w, i, j) === "#" && api.onRim(i, j, ROWS, COLS)),
        outer: outer.filter((q) => !Lynx.templeKit.behindRim(q, (f, r) => cell(w, Math.floor(f / CELL), Math.floor((r - R_MIN) / CELL)) === "#")),
        floors: mergeCells((i, j) => cell(w, i, j) !== "#"),
        pits: mergeCells((i, j) => cell(w, i, j) === "x"),
        seen: Array.from({ length: ROWS }, () => new Array(COLS).fill(false)),
      };
    });

    // Portals: [wing, wing] joined at the same cells.
    const portals = [
      { wings: [0, 1], ...rectOf(0, "O", [10, 13]) },
      { wings: [0, 2], ...rectOf(0, "O", [16, 19]) },
    ];
    const portalAt = (w, f, r) => portals.find((p) => p.wings.includes(w) && inRect(f, r, p)) || null;

    // Rotating doors, hinged at the crossroads' north-east corner. State
    // "north": along the crossroads' north side, across the north passage;
    // "east": along its east side, across the east passage.
    const HINGE = { f: 11 * CELL, r: R_MIN + 7 * CELL };
    const ANGLE = { north: -Math.PI / 2, east: -Math.PI }; // direction hinge -> tip: (cos a, sin a) in (f, r)
    const doors = [
      { id: "gears", wing: 0, state: "east" },
      { id: "bones", wing: 1, state: "north" },
    ].map((o) => ({ ...o, hinge: HINGE, angle: ANGLE[o.state], from: null }));
    const doorById = (id) => doors.find((o) => o.id === id);
    const doorBox = (o, state) =>
      state === "north"
        ? { f0: o.hinge.f - DOOR_T / 2, f1: o.hinge.f + DOOR_T / 2, r0: o.hinge.r - DOOR_LEN, r1: o.hinge.r }
        : { f0: o.hinge.f - DOOR_LEN, f1: o.hinge.f, r0: o.hinge.r - DOOR_T / 2, r1: o.hinge.r + DOOR_T / 2 };
    const swinging = (o) => Math.abs(o.angle - ANGLE[o.state]) > 1e-3;
    // what it blocks: its resting place, or while it swings both ends of the turn
    const doorBoxes = (o) => (swinging(o) && o.from ? [doorBox(o, o.from), doorBox(o, o.state)] : [doorBox(o, o.state)]);

    // The moon gate: bars that rise once you bring both moon stones.
    const gate = { wing: 2, ...rectOf(2, "M"), open: false, lift: 0, warned: false };
    const gateShut = () => !gate.open || gate.lift < 0.95;
    const dais = { ...rectOf(2, "I"), h0: 0, h1: DAIS_H };
    const daisCenter = { f: (dais.f0 + dais.f1) / 2, r: (dais.r0 + dais.r1) / 2 };

    // Switches: sun disks on wall faces, shot to turn a door (again and again).
    // n: the way the face looks. The one in the north hall stays dark until
    // the idol is taken.
    const switches = [
      { id: "turnGears", wing: 1, door: "gears", f: 10.5 * CELL, r: R_MIN + 11 * CELL, h: 0.17, n: { f: 0, r: -1 } }, // the crypt's east room
      { id: "turnBones", wing: 0, door: "bones", f: 11.5 * CELL, r: R_MIN + 11 * CELL, h: 0.17, n: { f: 0, r: -1 } }, // the vault
      { id: "northHall", wing: 0, door: "gears", f: LEN, r: R_MIN + 7.5 * CELL, h: 0.19, n: { f: -1, r: 0 }, dormant: true },
    ].map((s) => ({ ...s, rect: null, hit: 0, cool: 0, uses: 0 }));
    const sw = (id) => switches.find((s) => s.id === id);

    // enemies wake the first time you enter their zone
    const zones = {
      west: { wing: 0, ...cellRect(7, 12, 1, 3) },
      vault: { wing: 0, ...cellRect(7, 12, 8, 10) },
      crypt: { wing: 1, ...cellRect(14, 19, 2, 9) },
      ossuary: { wing: 1, ...cellRect(3, 6, 3, 8) },
      east: { wing: 1, ...cellRect(7, 12, 8, 10) },
      moon: { wing: 2, ...cellRect(7, 12, 3, 8) },
    };

    let wing = 0;
    let armed = false; // a portal takes you only after you've stepped out of the last one
    let warp = 0; // the flash when you go through a portal
    let stones = { gears: false, bones: false };
    let idol = false;
    let wasAirborne = false;
    let enemies = [];
    let woken = new Set();
    let visited = new Set(["gears"]);
    let losTimer = 0;
    let items = [
      { kind: "stone", id: "gears", wing: 0, ...cellCenter(12, 9), base: 0 },
      { kind: "potion", wing: 0, ...cellCenter(8, 2), base: 0 },
      { kind: "gem", wing: 0, ...cellCenter(5, 5.5), base: 0.1, float: true }, // over the spikes
      { kind: "gem", wing: 0, ...cellCenter(19, 3), base: 0 },
      { kind: "gem", wing: 0, ...cellCenter(19, 8), base: 0 },
      { kind: "stone", id: "bones", wing: 1, ...cellCenter(19, 2.5), base: 0 }, // behind the block at the far end
      { kind: "potion", wing: 1, ...cellCenter(3, 5.5), base: 0 },
      { kind: "gem", wing: 1, ...cellCenter(15, 5.5), base: 0.1, float: true }, // over the crypt's pit
      { kind: "bigGem", wing: 1, ...cellCenter(12, 9), base: 0 },
      { kind: "gem", wing: 1, ...cellCenter(4, 3), base: 0 },
      { kind: "idol", wing: 2, ...daisCenter, base: DAIS_H },
      { kind: "gem", wing: 2, ...cellCenter(19, 2), base: 0 },
      { kind: "gem", wing: 2, ...cellCenter(19, 9), base: 0 },
      { kind: "potion", wing: 2, ...cellCenter(7, 3), base: 0 },
    ];

    // -- geometry ------------------------------------------------------------------------
    function surfaces(w, f, r) {
      const c = cell(w, cellI(f), cellJ(r));
      if (c === "#") return [WALL_H];
      if (c === "x") return [-PIT_D];
      if (w === gate.wing && inRect(f, r, gate) && gateShut()) return [WALL_H];
      if (w === 2 && inRect(f, r, dais)) return [DAIS_H];
      return [0];
    }
    function groundAt(f, r, feet, fallback) {
      const ok = surfaces(wing, f, r).filter((h) => h <= feet + STEP_UP);
      return ok.length ? Math.max(...ok) : fallback;
    }

    // everything solid in a wing, as boxes
    function solids(w) {
      const out = wings[w].walls.concat(boundary);
      doors.filter((o) => o.wing === w).forEach((o) => doorBoxes(o).forEach((q) => out.push({ ...q, h0: 0, h1: WALL_H, door: o })));
      if (w === gate.wing && gateShut()) out.push({ f0: gate.f0, f1: gate.f1, r0: gate.r0, r1: gate.r1, h0: 0, h1: WALL_H, gate: true });
      if (w === 2) out.push({ ...dais });
      return out;
    }
    const blockers = (feet) => solids(wing).filter((b) => b.h1 > feet + STEP_UP && b.h0 < feet + BODY_H);

    function pointSolid(w, f, r, h) {
      if (h > WALL_H) return false;
      const c = cell(w, cellI(f), cellJ(r));
      if (c === "#") return true;
      if (w === gate.wing && inRect(f, r, gate) && gateShut()) return true;
      if (w === 2 && inRect(f, r, dais) && h < DAIS_H) return true;
      return doors.some((o) => o.wing === w && doorBoxes(o).some((q) => inRect(f, r, q)));
    }
    function lineOfSight(a, b) {
      const len = Math.hypot(b.f - a.f, b.r - a.r, b.h - a.h);
      const steps = Math.max(1, Math.ceil(len / 0.04));
      for (let k = 1; k < steps; k++) {
        const t = k / steps;
        if (pointSolid(wing, a.f + (b.f - a.f) * t, a.r + (b.r - a.r) * t, a.h + (b.h - a.h) * t)) return false;
      }
      return true;
    }

    const cam = () => {
      const cw = ar.cameraWorld();
      const l = api.toLocal(cw.x, cw.y);
      return { f: l.f, r: l.r, h: cw.h };
    };

    // -- walls stop the robot (as in the sanctum) ----------------------------------------
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
        const faces = [[me.f - b.f0, -1, 0], [b.f1 - me.f, 1, 0], [me.r - b.r0, 0, -1], [b.r1 - me.r, 0, 1]];
        faces.sort((x, y) => x[0] - y[0]);
        out.push({ f: faces[0][1], r: faces[0][2] });
      });
      return out;
    }
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
      if (cs.some((c) => vf * c.f + vr * c.r < -1e-3)) vf = vr = 0;
      const wx = vf * Math.cos(th) + vr * Math.sin(th);
      const wy = vf * Math.sin(th) - vr * Math.cos(th);
      return { j1: wx * Math.sin(t) - wy * Math.cos(t), j2: wx * Math.cos(t) + wy * Math.sin(t) };
    }

    function physics(me) {
      ar.setGround(groundAt(me.f, me.r, ar.feet(), ar.ground));
    }

    // -- update --------------------------------------------------------------------------
    function wake(zone) {
      if (woken.has(zone)) return;
      woken.add(zone);
      const w = zones[zone] ? zones[zone].wing : 0;
      const add = (kind, p, h = 0) => enemies.push({
        kind, wing: w, f: p.f, r: p.r, h, hp: kind === "mummy" ? n.mummyHp : kind === "wisp" ? d.batHp + 1 : kind === "bat" ? d.batHp : 1,
        phase: Math.random() * 6, hit: 0, retreat: 0, wait: 1 + Math.random(), sees: false, dir: Math.random() < 0.5 ? -1 : 1, turnT: 1, rect: null,
      });
      const spot = cellCenter;
      if (zone === "west") [spot(12, 3), spot(7, 1)].slice(0, n.westScarabs).forEach((p) => add("scarab", p));
      if (zone === "vault") [spot(8, 9)].slice(0, n.vaultMummies).forEach((p) => add("mummy", p));
      if (zone === "crypt") [spot(19, 2), spot(19, 9)].slice(0, n.cryptMummies).forEach((p) => add("mummy", p));
      if (zone === "ossuary") [spot(3, 3), spot(3, 8), spot(5, 5)].slice(0, n.ossuary).forEach((p) => add("scarab", p));
      if (zone === "east") [spot(12, 9), spot(7, 9)].slice(0, n.eastBats).forEach((p) => add("bat", p, 0.2));
      if (zone === "moon") [spot(11, 4), spot(11, 7), spot(8, 5.5)].slice(0, n.moonWisps).forEach((p) => add("wisp", p, 0.15));
      if (zone === "escape") {
        [spot(16, 4), spot(16, 7), spot(18, 8)].slice(0, n.escape).forEach((p, k) => add(k === 0 ? "wisp" : "bat", p, 0.18));
      }
      if (enemies.some((e) => e.wing === wing)) Lynx.sfx.play("growl");
    }

    function moveEnemy(e, tf, tr, speed, dt) {
      const df = tf - e.f;
      const dr = tr - e.r;
      const dist = Math.hypot(df, dr) || 1;
      const sgn = e.retreat > 0 ? -1 : 1;
      const stepF = (sgn * df * speed * dt) / dist;
      const stepR = (sgn * dr * speed * dt) / dist;
      const rad = e.kind === "mummy" ? 0.06 : 0.04;
      const flies = e.kind === "bat" || e.kind === "wisp";
      const free = (f, r) => {
        for (const [a, b] of [[rad, 0], [-rad, 0], [0, rad], [0, -rad]]) {
          if (pointSolid(e.wing, f + a, r + b, e.h + 0.02)) return false;
          if (!flies && "xOI".includes(cell(e.wing, cellI(f + a), cellJ(r + b)))) return false; // walkers keep off pits, portals and the dais
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
        if (e.wing !== wing) return; // the other wings wait
        e.phase += dt * (e.kind === "bat" ? 7 : 5);
        e.hit = Math.max(0, e.hit - dt);
        e.retreat = Math.max(0, e.retreat - dt);
        e.wait = Math.max(0, e.wait - dt);
        if (checkSight) e.sees = lineOfSight({ f: e.f, r: e.r, h: e.h + 0.05 }, c);
        const slow = e.hit > 0 ? 0.3 : 1;
        if (e.kind === "bat") {
          if (e.wait > 0) return;
          moveEnemy(e, c.f, c.r, 0.15 * d.speed * slow, dt);
          const dh = c.h - 0.02 - e.h;
          e.h = clamp(e.h + Math.sign(dh) * Math.min(Math.abs(dh), 0.1 * dt), 0.06, WALL_H - 0.03);
          if (Math.hypot(c.f - e.f, c.r - e.r, c.h - e.h) < 0.11 && e.retreat === 0) {
            api.hurt("Bitten by a bat");
            e.retreat = 1.2;
          }
          return;
        }
        if (e.kind === "wisp") {
          // fast sideways across your line of sight, slow toward you (see game_temple.js)
          e.turnT -= dt;
          if (e.turnT <= 0) {
            e.dir = -e.dir;
            e.turnT = 0.45 + Math.random() * 0.85;
          }
          if (e.wait > 0) return;
          const df = me.f - e.f;
          const dr = me.r - e.r;
          const dist = Math.hypot(df, dr) || 1;
          const side = 0.55 * d.speed * slow;
          const close = e.retreat > 0 ? -0.18 : 0.06 * d.speed;
          const vf = (df / dist) * close - (dr / dist) * e.dir * side;
          const vr = (dr / dist) * close + (df / dist) * e.dir * side;
          const before = { f: e.f, r: e.r };
          moveEnemy(e, e.f + vf, e.r + vr, Math.hypot(vf, vr), dt);
          if (Math.hypot(e.f - before.f, e.r - before.r) < 0.3 * Math.hypot(vf, vr) * dt) e.dir = -e.dir; // blocked sideways: the other way
          e.h += ((c.h - 0.04 - e.h) * 0.4 + Math.sin(e.phase) * 0.05) * dt;
          if (Math.hypot(c.f - e.f, c.r - e.r, c.h - e.h) < 0.11 && e.retreat === 0) {
            api.hurt("A spirit's chill");
            e.retreat = 1.5;
          }
          return;
        }
        // walkers: only once they've seen you
        if (e.wait > 0 || (!e.sees && e.retreat === 0)) return;
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

    function turnDoor(o, toState) {
      if (o.state === toState) return;
      o.from = o.state;
      o.state = toState;
      Lynx.sfx.play("crate");
    }

    function operate(s) {
      const o = doorById(s.door);
      turnDoor(o, o.state === "north" ? "east" : "north");
      s.uses++;
      const here = o.wing === wing;
      const where = o.state === "north" ? "north" : "east";
      if (here) api.say(`The door turns: the ${where} passage is shut, the ${where === "north" ? "east" : "north"} one open`, "#ffd84a");
      else api.say(`Far off, in the ${wings[o.wing].name}, stone grinds -- a door turns`, "#ffd84a");
    }

    function takeIdol() {
      idol = true;
      api.addScore(2500);
      Lynx.sfx.play("power");
      turnDoor(doorById("gears"), "north"); // the gears turn: sealed in the north hall
      sw("northHall").dormant = false;
      api.say("The Moon Idol! Somewhere the gears turn... Get out through the entrance!", "#ffd84a");
      wake("escape");
    }

    function updateItems(me) {
      const feet = ar.feet();
      items = items.filter((it) => {
        if (it.wing !== wing) return true;
        if (Math.hypot(me.f - it.f, me.r - it.r) > 0.13 || feet < it.base - 0.05 || feet > it.base + 0.3) return true;
        if (it.kind === "idol") {
          takeIdol();
          return false;
        }
        if (it.kind === "stone") {
          stones[it.id] = true;
          api.addScore(400);
          Lynx.sfx.play("pickup");
          api.say(stones.gears && stones.bones ? "The second moon stone! Now the moon gate" : "A moon stone! The moon gate wants two", "#a0c0ff");
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

    function updatePortals(me) {
      const p = portalAt(wing, me.f, me.r);
      if (!p) {
        armed = true;
        return;
      }
      // well inside it, not just brushing its edge
      if (!armed || ar.airborne || !inRect(me.f, me.r, grow(p, -0.04))) return;
      armed = false;
      wing = p.wings[0] === wing ? p.wings[1] : p.wings[0];
      visited.add(wings[wing].id);
      warp = 1;
      Lynx.sfx.play("levelup");
      api.say(`The ${wings[wing].name}`, "#c0a0ff");
    }

    function update(dt, me) {
      warp = Math.max(0, warp - dt * 1.5);
      switches.forEach((s) => {
        s.hit = Math.max(0, s.hit - dt);
        s.cool = Math.max(0, s.cool - dt);
      });
      doors.forEach((o) => {
        const target = ANGLE[o.state];
        const stepA = (Math.PI / 2 / SWING_S) * dt;
        o.angle = Math.abs(target - o.angle) <= stepA ? target : o.angle + Math.sign(target - o.angle) * stepA;
      });
      gate.lift = clamp(gate.lift + (gate.open ? dt * 0.7 : -dt), 0, 1);

      if (wasAirborne && !ar.airborne && ar.ground < 0) {
        api.hurt("Spikes! Jump across");
        ar.jump();
      }
      wasAirborne = ar.airborne;

      updatePortals(me);

      // the moon gate
      // the moon gate (you come to it from the portal, at the far end)
      if (wing === gate.wing && !gate.open && me.f > gate.f1 && me.f < gate.f1 + 0.35 && Math.abs(me.r) < 0.3) {
        if (stones.gears && stones.bones) {
          gate.open = true;
          Lynx.sfx.play("gate");
          api.say("The moon stones glow -- the gate rises", "#a0c0ff");
        } else if (!gate.warned) {
          gate.warned = true;
          Lynx.sfx.play("knock");
          api.say(`The moon gate: it wants two moon stones (you have ${(stones.gears ? 1 : 0) + (stones.bones ? 1 : 0)})`, "#ffb060");
        }
      } else if (me.f > gate.f1 + 0.5) gate.warned = false;

      Object.entries(zones).forEach(([name, z]) => {
        if (z.wing === wing && inRect(me.f, me.r, z)) wake(name);
      });

      const i0 = cellI(me.f);
      const j0 = cellJ(me.r);
      for (let i = i0 - 3; i <= i0 + 3; i++) {
        for (let j = j0 - 3; j <= j0 + 3; j++) {
          if (i >= 0 && i < ROWS && j >= 0 && j < COLS) wings[wing].seen[i][j] = true;
        }
      }

      updateItems(me);
      updateEnemies(dt, me);

      // out through the entrance with the idol
      if (idol && wing === 0 && me.f < 0.25) api.complete();
    }

    // -- shooting ------------------------------------------------------------------------
    function targets() {
      const out = [];
      enemies.forEach((e) => e.wing === wing && e.rect && out.push({ obj: e, kind: e.kind }));
      switches.forEach((s) => s.wing === wing && !s.dormant && s.rect && out.push({ obj: s, kind: "switch" }));
      return out;
    }

    function hit(t) {
      const o = t.obj;
      o.hit = 0.15;
      if (t.kind === "switch") {
        if (o.cool > 0) {
          Lynx.sfx.play("knock");
          return;
        }
        o.cool = SWITCH_COOLDOWN_S;
        if (o.uses === 0) api.addScore(100);
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
      api.puff({ x: w.x, y: w.y, h: o.h + 0.03, t: 0, color: o.kind === "wisp" ? "160,220,255" : "255,230,200" });
      api.addScore(o.kind === "mummy" ? 300 : o.kind === "wisp" ? 200 : o.kind === "bat" ? 100 : 50);
      Lynx.sfx.play("die");
    }

    // -- drawing -------------------------------------------------------------------------
    const rectPoly = (q, h) => [api.w3(q.f0, q.r0, h), api.w3(q.f1, q.r0, h), api.w3(q.f1, q.r1, h), api.w3(q.f0, q.r1, h)];
    function fillRect(q, h, fill, stroke, width) {
      const p = api.polyScreen(rectPoly(q, h), 3);
      if (p) api.fillPoly(p, fill, stroke, width);
    }

    function drawFloor() {
      const W = wings[wing];
      W.floors.forEach((q) => {
        fillRect(q, 0.001, W.tint, "rgba(90,70,40,0.3)");
        if (api.floorDetail) api.floorDetail(q);
      });
      W.pits.forEach((q) => {
        fillRect(q, 0.002, "#1a1410", "rgba(120,90,60,0.9)", 2);
        for (let f = q.f0 + 0.03; f < q.f1; f += 0.06) {
          for (let r = q.r0 + 0.04; r < q.r1; r += 0.08) api.line3([[f, r - 0.012, 0.003], [f, r, 0.03], [f, r + 0.012, 0.003]], "#b8b0a0", 2, 0.02);
        }
      });
      // portals: a swirl of light on the floor
      const t = api.time();
      portals.filter((p) => p.wings.includes(wing)).forEach((p) => {
        const cf = (p.f0 + p.f1) / 2;
        const cr = (p.r0 + p.r1) / 2;
        const other = p.wings[0] === wing ? p.wings[1] : p.wings[0];
        const hue = other === 2 ? "150,170,255" : other === 1 ? "180,255,190" : "255,210,120";
        for (let k = 3; k >= 1; k--) {
          const rad = 0.045 * k + 0.012 * Math.sin(t * 3 + k);
          const w = api.toWorld(cf, cr);
          ar.floorCircle(w.x, w.y, rad, `rgba(${hue},${0.12 + 0.08 * (3 - k)})`, `rgba(${hue},0.7)`, 0.003);
        }
      });
    }

    function queueWalls() {
      const W = wings[wing];
      const col = WALL_COL[W.wall];
      W.wallsDrawn.forEach((q) => api.box(q, 0, WALL_H, col));
      W.rimWalls.forEach((q) => api.fence(q, 0, WALL_H));
      W.outer.forEach((q) => api.fence(q, 0, WALL_H));
      if (wing === 2) api.box(dais, 0, DAIS_H, DAIS_COL);
    }

    // A rotating door: a bronze slab from its hinge post, drawn as a box at
    // rest and as its turning faces while it swings.
    function queueDoor(o) {
      const post = { f0: o.hinge.f - 0.035, f1: o.hinge.f + 0.035, r0: o.hinge.r - 0.035, r1: o.hinge.r + 0.035 };
      api.box(post, 0, WALL_H + 0.03, POST_COL);
      if (!swinging(o)) {
        api.box(doorBox(o, o.state), 0.01, WALL_H - 0.02, DOOR_COL);
        return;
      }
      const df = Math.cos(o.angle);
      const dr = Math.sin(o.angle);
      const nf = -dr * (DOOR_T / 2);
      const nr = df * (DOOR_T / 2);
      const a = { f: o.hinge.f, r: o.hinge.r };
      const b = { f: a.f + df * DOOR_LEN, r: a.r + dr * DOOR_LEN };
      const corners = [[a.f + nf, a.r + nr], [b.f + nf, b.r + nr], [b.f - nf, b.r - nr], [a.f - nf, a.r - nr]];
      const mid = api.toWorld((a.f + b.f) / 2, (a.r + b.r) / 2);
      const depth = api.camZ(mid.x, mid.y, WALL_H / 2);
      if (depth < -0.3) return;
      const fs = corners.map((p) => p[0]);
      const rs = corners.map((p) => p[1]);
      ar.queue(depth, () => {
        const c = cam();
        [[0, 1], [1, 2], [2, 3], [3, 0]].forEach(([i, k]) => {
          const p = corners[i];
          const q = corners[k];
          const outF = (p[0] + q[0]) / 2 - (a.f + b.f) / 2;
          const outR = (p[1] + q[1]) / 2 - (a.r + b.r) / 2;
          if ((c.f - (p[0] + q[0]) / 2) * outF + (c.r - (p[1] + q[1]) / 2) * outR <= 0) return; // faces away
          const poly = api.polyScreen([api.w3(p[0], p[1], 0.01), api.w3(q[0], q[1], 0.01), api.w3(q[0], q[1], WALL_H - 0.02), api.w3(p[0], p[1], WALL_H - 0.02)], 3);
          if (poly) api.fillPoly(poly, i % 2 ? DOOR_COL.dark : DOOR_COL.side, DOOR_COL.line);
          if (poly && api.doorFace && Math.hypot(q[0] - p[0], q[1] - p[1]) > DOOR_T * 1.5) api.doorFace(p, q, 0.01, WALL_H - 0.02, DOOR_COL);
        });
        const top = api.polyScreen(corners.map((p) => api.w3(p[0], p[1], WALL_H - 0.02)), 2);
        if (top) api.fillPoly(top, DOOR_COL.top, DOOR_COL.line);
      }, api.extent(Math.min(...fs), Math.max(...fs), Math.min(...rs), Math.max(...rs), 0, WALL_H));
    }

    function queueGate() {
      const up = gate.lift * WALL_H * 0.95;
      if (up >= WALL_H * 0.94) return;
      const mf = (gate.f0 + gate.f1) / 2;
      const mid = api.toWorld(mf, 0);
      const depth = api.camZ(mid.x, mid.y, 0.15);
      if (depth < -0.5) return;
      ar.queue(depth, () => {
        for (let r = gate.r0 + 0.035; r < gate.r1; r += 0.06) api.line3([[mf, r, up], [mf, r, WALL_H]], GATE_BAR, 4, 0.05);
        [0.07, 0.2].forEach((h) => h > up && api.line3([[mf, gate.r0, h], [mf, gate.r1, h]], "#8090c0", 4, 0.1));
        // two sockets for the moon stones, lit for the ones you carry
        [-0.07, 0.07].forEach((r, k) => {
          const w = api.toWorld(gate.f0 - 0.005, r);
          const p = api.camZ(w.x, w.y, WALL_H - 0.05) >= 0.06 ? ar.project(w.x, w.y, WALL_H - 0.05) : null;
          const lit = k === 0 ? stones.gears : stones.bones;
          if (p) ar.glow(p.x, p.y, 0.03 * p.ppm, lit ? [[0, "rgba(200,220,255,1)"], [1, "rgba(100,140,255,0)"]] : [[0, "rgba(40,40,60,0.9)"], [1, "rgba(40,40,60,0)"]]);
        });
      }, api.extent(mf - 0.01, mf + 0.01, gate.r0, gate.r1, up, WALL_H));
    }

    function queueThings() {
      const c = cam();
      items.forEach((it) => {
        if (it.wing !== wing) return;
        it.rect = null;
        if (!lineOfSight({ f: it.f, r: it.r, h: it.base + 0.05 }, c)) return;
        const w = api.toWorld(it.f, it.r);
        const bob = Math.sin(api.time() * 3 + it.f * 7) * 0.012;
        const spr = img[it.kind] || api.img[it.kind];
        const size = it.kind === "idol" ? 0.1 : it.kind === "potion" ? 0.06 : it.kind === "stone" ? 0.045 : 0.05;
        const glow = it.kind === "stone" || it.kind === "idol" ? "rgba(170,200,255,0.8)" : "rgba(255,255,220,0.7)";
        api.drawSprite(it, spr, w.x, w.y, it.base + 0.03 + bob, size, {
          before: (r) => ar.glow(r.cx, r.y + r.h / 2, r.w * 1.3, [[0, glow], [1, "rgba(255,255,200,0)"]]),
        });
      });
      enemies.forEach((e) => {
        if (e.wing !== wing) return;
        e.rect = null;
        if (!lineOfSight({ f: e.f, r: e.r, h: e.h + 0.04 }, c)) return;
        const w = api.toWorld(e.f, e.r);
        if (e.kind === "bat") api.drawSprite(e, api.img.bat, w.x, w.y, e.h + Math.sin(e.phase) * 0.015, 0.06, { flip: Math.sin(e.phase * 0.35) < 0 });
        else if (e.kind === "wisp") api.drawSprite(e, api.img.wisp, w.x, w.y, e.h - 0.035, 0.075, { flip: e.dir < 0 });
        else if (e.kind === "scarab") api.drawSprite(e, api.img.scarab, w.x, w.y, e.h, 0.045, { flip: e.flip });
        else api.drawSprite(e, img.mummy, w.x, w.y, e.h + Math.abs(Math.sin(e.phase)) * 0.004, 0.2, { flip: e.flip });
      });
      switches.forEach((s) => s.wing === wing && queueSwitch(s, c));
    }

    // A sun disk: gold ring; its gem shows which way its door stands --
    // green: across the north passage, orange: across the east one. Dark
    // until it wakes (the north hall's).
    function queueSwitch(s, c) {
      s.rect = null;
      const facing = (c.f - s.f) * s.n.f + (c.r - s.r) * s.n.r;
      if (facing <= 0.01) return;
      const eye = { f: s.f + s.n.f * 0.01, r: s.r + s.n.r * 0.01, h: s.h };
      if (!lineOfSight(eye, c)) return;
      const u = { f: -s.n.r, r: s.n.f };
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
      const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), depth: center ? center.depth : 1, cx: center ? center.x : 0 };
      if (!s.dormant) s.rect = rect;
      const state = doorById(s.door).state;
      ar.queue(rect.depth, () => {
        if (!s.dormant && s.cool === 0) ar.glow(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w * 1.4, [[0, "rgba(255,220,100,0.5)"], [1, "rgba(255,200,60,0)"]]);
        api.fillPoly(outer, s.dormant ? "#5a5040" : s.hit > 0 ? "#ffffff" : "#e0b030", "#704810", 2);
        const inner = ring(0.018);
        if (inner) api.fillPoly(inner, s.dormant ? "#302820" : state === "north" ? "#40ff70" : "#ff9030", "#401000", 1);
      }, api.extent(Math.min(s.f, eye.f), Math.max(s.f, eye.f), Math.min(s.r, eye.r), Math.max(s.r, eye.r), s.h - 0.04, s.h + 0.04));
    }

    function queuePortalLights() {
      portals.filter((p) => p.wings.includes(wing)).forEach((p) => {
        const cf = (p.f0 + p.f1) / 2;
        const cr = (p.r0 + p.r1) / 2;
        const w = api.toWorld(cf, cr);
        const h = 0.12;
        const pr = api.camZ(w.x, w.y, h) >= 0.06 ? ar.project(w.x, w.y, h) : null;
        if (!pr) return;
        ar.queue(pr.depth, () => {
          const pulse = 1 + 0.15 * Math.sin(api.time() * 4 + cf);
          ar.glow(pr.x, pr.y, 0.12 * pr.ppm * pulse, [[0, "rgba(230,220,255,0.55)"], [0.5, "rgba(160,120,255,0.25)"], [1, "rgba(120,80,255,0)"]]);
        }, api.pointAt(w.x, w.y, h, h));
      });
    }

    function drawTorches() {
      const spots = [[0.6, R_MIN + 0.01], [0.6, R_MAX - 0.01], [1.2, R_MIN + 0.01], [2.4, R_MIN + 3 * CELL + 0.01], [2.4, R_MAX - 3 * CELL - 0.01]];
      const c = cam();
      spots.forEach(([f, r]) => {
        if (cell(wing, cellI(f), cellJ(r - Math.sign(r) * 0.05)) === "#") return; // only on walls that border a room
        const w = api.toWorld(f, r);
        const h = 0.2;
        const p = api.camZ(w.x, w.y, h) >= 0.06 ? ar.project(w.x, w.y, h) : null;
        if (!p || !lineOfSight({ f, r: r - Math.sign(r) * 0.02, h }, c)) return;
        ar.queue(p.depth - 0.01, () => {
          const flick = 0.85 + 0.15 * Math.sin(api.time() * 17 + f * 5 + r);
          const blue = wing === 2;
          ar.glow(p.x, p.y, 0.09 * p.ppm * flick, blue
            ? [[0, "rgba(220,235,255,0.95)"], [0.35, "rgba(120,150,255,0.6)"], [1, "rgba(80,100,255,0)"]]
            : [[0, "rgba(255,240,160,0.95)"], [0.35, "rgba(255,150,40,0.6)"], [1, "rgba(255,100,0,0)"]]);
        }, api.pointAt(w.x, w.y, h, h));
      });
    }

    function draw() {
      drawFloor();
      queueWalls();
      doors.filter((o) => o.wing === wing).forEach(queueDoor);
      if (wing === gate.wing) queueGate();
      queueThings();
      queuePortalLights();
      drawTorches();
      ar.flush();
      if (warp > 0) ar.flash("rgba(200,180,255,1)", warp * 0.8);
    }

    // -- HUD -----------------------------------------------------------------------------
    function hud() {
      const v = ar.view;
      let x = v.x + 14;
      ["gears", "bones"].forEach((id) => {
        if (!stones[id]) return;
        ar.drawSprite(img.stone, { x, y: v.y + v.h - 116, w: 20, h: 20 });
        x += 26;
      });
      if (idol) ar.drawSprite(img.idol, { x, y: v.y + v.h - 120, w: 20, h: 22 });
      // minimap of this wing, far end up, what you've seen of it
      const s = Math.max(4, Math.min(8, Math.floor((v.h * 0.3) / ROWS)));
      const mx = v.x + v.w - COLS * s - 12;
      const my = v.y + 12;
      const g = ar.ctx;
      const W = wings[wing];
      g.save();
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.fillRect(mx - 3, my - 3, COLS * s + 6, ROWS * s + 6);
      for (let i = 0; i < ROWS; i++) {
        for (let j = 0; j < COLS; j++) {
          if (!W.seen[i][j]) continue;
          const ch = cell(wing, i, j);
          let col = "#c8b890";
          if (ch === "#") col = "#6a5638";
          else if (ch === "x") col = "#402010";
          else if (ch === "O") col = "#a080ff";
          else if (ch === "M") col = gateShut() ? "#8090c0" : "#c8b890";
          else if (ch === "I") col = "#8090c0";
          g.fillStyle = col;
          g.fillRect(mx + j * s, my + (ROWS - 1 - i) * s, s, s);
        }
      }
      // the rotating door, where it stands
      doors.filter((o) => o.wing === wing && W.seen[cellI(o.hinge.f)][cellJ(o.hinge.r) - 1]).forEach((o) => {
        const q = doorBox(o, o.state);
        g.fillStyle = "#e0a040";
        g.fillRect(mx + ((q.r0 - R_MIN) / CELL) * s, my + (ROWS - q.f1 / CELL) * s, Math.max(2, ((q.r1 - q.r0) / CELL) * s), Math.max(2, ((q.f1 - q.f0) / CELL) * s));
      });
      const me = api.toLocal(ar.pose.x, ar.pose.y);
      const px = mx + ((me.r - R_MIN) / CELL) * s;
      const py = my + (ROWS - me.f / CELL) * s;
      const a = ar.camTheta - api.anchor().th;
      g.fillStyle = "#28c8ff";
      g.beginPath();
      g.moveTo(px - Math.sin(a) * s * 1.6, py - Math.cos(a) * s * 1.6);
      g.lineTo(px + Math.cos(a) * s * 0.7, py - Math.sin(a) * s * 0.7);
      g.lineTo(px - Math.cos(a) * s * 0.7, py + Math.sin(a) * s * 0.7);
      g.closePath();
      g.fill();
      g.restore();
      ar.text(W.name.toUpperCase(), mx + (COLS * s) / 2, my + ROWS * s + 16, { size: 11, align: "center", color: "#ffd84a" });
    }

    // Where to go next, worked out from where things stand (the doors can be
    // turned any number of times, so this follows along).
    function objective() {
      const at = (p, h) => ({ at: { f: p.f, r: p.r }, h });
      const portalTo = (other) => {
        const p = portals.find((q) => q.wings.includes(wing) && q.wings.includes(other));
        return { f: (p.f0 + p.f1) / 2, r: (p.r0 + p.r1) / 2 };
      };
      const gearsDoor = doorById("gears").state; // "east": the north passage is open
      const bonesDoor = doorById("bones").state; // "north": the east passage is open
      const itemAt = (kind, id) => items.find((it) => it.kind === kind && (!id || it.id === id));
      const go = (text, p, h = 0.1) => ({ text, ...at(p, h) });
      // every portal joins the hall of gears: from elsewhere, go there first
      const toWing = (target, text) => {
        if (wing === target) return null;
        const hop = wing === 0 ? target : 0;
        return go(text || `The portal to the ${wings[hop].name}`, portalTo(hop));
      };
      // turning a door means reaching its switch, in the other wing
      const turn = (switchId, why) => {
        const s = sw(switchId);
        return toWing(s.wing, why) || go(`${why} -- shoot the sun disk`, s, s.h);
      };
      if (idol) {
        if (wing !== 0) return toWing(0, "Back to the hall of gears -- the way out");
        const me = api.toLocal(ar.pose.x, ar.pose.y);
        if (gearsDoor === "north" && me.f > 11 * CELL) return turn("northHall", "The door has turned: a sun disk woke up on the north wall");
        return go("Out through the entrance with the Moon Idol!", { f: 0.1, r: 0 });
      }
      if (!visited.has("moon")) return toWing(2, "A portal glows in the north hall") || go("Find the Moon Idol", daisCenter, 0.1);
      if (!stones.gears) {
        if (gearsDoor === "east") return turn("turnGears", "The vault's door is shut: its switch is in the bone crypt's east room");
        return toWing(0) || go("The vault, east of the crossroads: a moon stone", itemAt("stone", "gears"), 0.05);
      }
      if (!stones.bones) {
        if (bonesDoor === "north") return turn("turnBones", "The crypt's north passage is shut: its switch is in the vault");
        return toWing(1) || go("The crypt's north hall: the second moon stone", itemAt("stone", "bones"), 0.05);
      }
      if (gearsDoor === "north") {
        if (bonesDoor === "east") return turn("turnBones", "To reach the crypt's east room again, turn the crypt's door back (the vault)");
        return turn("turnGears", "Open the north passage again: the switch in the crypt's east room");
      }
      if (wing !== 2) return toWing(2, "To the moon sanctum: the portal in the north hall");
      return go(gate.open ? "Take the Moon Idol" : "The moon gate -- you have both stones", gate.open ? daisCenter : { f: gate.f1, r: 0 }, 0.1);
    }

    function blips() {
      const out = [];
      enemies.forEach((e) => e.wing === wing && out.push({ ...api.toWorld(e.f, e.r), color: e.kind === "mummy" ? "#ffffff" : e.kind === "wisp" ? "#60d0ff" : "#ff4040" }));
      items.forEach((it) => it.wing === wing && out.push({ ...api.toWorld(it.f, it.r), color: it.kind === "stone" || it.kind === "idol" ? "#a0c0ff" : "#ffd84a", r: 2.5 }));
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
      floorName: () => wings[wing].name,
      debug: {
        shoot: (id) => operate(sw(id)),
        give: (k) => (k === "idol" ? takeIdol() : (stones[k] = true)),
        wing: (w) => (wing = w),
        clear: () => (enemies = enemies.filter((e) => e.wing !== wing)), // testing: this wing's enemies gone
        switches: () => switches.map((s) => ({ id: s.id, wing: s.wing, dormant: !!s.dormant, rect: s.rect })),
        blockers,
        groundAt,
        lineOfSight,
        cellCenter,
        portals: () => portals.map((p) => ({ wings: p.wings, f: (p.f0 + p.f1) / 2, r: (p.r0 + p.r1) / 2 })),
        CELL, R_MIN,
      },
      snapshot: () => ({
        wing: wings[wing].id,
        doors: Object.fromEntries(doors.map((o) => [o.id, o.state])),
        stones: { ...stones }, idol, gate: gate.open ? "open" : "shut",
        switches: Object.fromEntries(switches.map((s) => [s.id, s.dormant ? "dormant" : s.uses])),
        enemies: enemies.filter((e) => e.wing === wing).map((e) => e.kind),
        items: items.filter((it) => it.wing === wing).map((it) => it.kind),
        woken: [...woken],
      }),
    };
  };
})(window.Lynx);
