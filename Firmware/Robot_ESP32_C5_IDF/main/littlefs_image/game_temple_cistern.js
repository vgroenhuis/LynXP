// Temple of LynXP, level 6: the drowned cistern. Run by game_temple.js
// through Lynx.templeCistern(api); parts from game_temple_kit.js.
//
// Two sections over the same 2 x 3 m floor, one below the other: the
// flooded antechamber and, down a shaft, the deep cistern (a lift brings you
// back up -- step off it and on again to ride). New here:
//   - stone blocks you push with the robot: drive against one and keep
//     pushing, it slides a cell. Push one into a water channel and it sinks
//     into a bridge; push one onto a pressure plate and it holds a door open.
//     A sun disk in each section puts its blocks back where they started (if
//     you've pushed one into a corner);
//   - water: wading is slow (the drive commands are scaled down) and eels
//     bite. Bridge it;
//   - flame vents, firing in waves: cross between bursts;
//   - the boulder: take the Tide Chalice and it comes rolling after you. Run,
//     or jump it.
// The timed gate: the button in the cistern's north-east alcove opens the
// gate to the chalice at the far south end for a few seconds only. Straight
// there is through a wave of flame vents and over the water channel -- so
// bridge the channel first, and learn the vents' rhythm.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const K = Lynx.templeKit;
  const { clamp, inRect, cellI, cellJ, cellRect, cellCenter, CELL, ROWS, COLS } = K;

  // # wall, . floor, w water, v flame vent, P pressure plate, D door (held
  // open by the plate), H the shaft down (the lift, when it's up), L the lift
  // (below), T the button, G the timed gate, R the chalice's dais.
  const MAPS = [
    [
      "############", // 19
      "#HH.v..v...#",
      "#HH.v..v...#",
      "#...v..v...#",
      "#...v..v...#", // 15
      "#...v..v...#",
      "#####DD#####",
      "#..........#",
      "#..........#",
      "#........PP#", // 10: the pressure plate
      "#........PP#",
      "#..........#",
      "#..........#",
      "#wwwwwwwwww#",
      "#wwwwwwwwww#", // 5: the flooded channel
      "#..........#",
      "#..........#",
      "#..........#",
      "#..........#",
      "#..........#", // 0: the way in
    ],
    [
      "############", // 19
      "#LL....#.TT#", // the lift | the button's alcove
      "#LL....#.TT#",
      "#..........#",
      "#..........#", // 15
      "#vvvvvvvvvv#", // a wave of flame vents
      "#vvvvvvvvvv#",
      "#..........#",
      "#..........#",
      "#..........#", // 10
      "#wwwwwwwwww#", // the deep channel
      "#wwwwwwwwww#",
      "#..........#",
      "#..........#",
      "#####GG#####", // 5: the timed gate
      "#..........#",
      "#..#....#..#",
      "#..........#",
      "#....RR....#", // 1: the Tide Chalice
      "############", // 0
    ],
  ].map(K.parseMap);
  const SECTION_NAME = ["flooded antechamber", "deep cistern"];

  const BLOCK_H = 0.3;
  const WATER_H = -0.05; // you wade (and can step out)
  const WADE = 0.25; // drive speed in water
  const LIFT_DROP = 0.6; // how far the lift travels
  const LIFT_S = 2;
  const VENT_S = 3.8; // a vent fires for VENT_ON of every VENT_S seconds
  const VENT_ON = 1.2;
  const FLAME_H = 0.3; // jumping doesn't clear them
  const PUSH_S = 0.2; // keep pushing this long before a block moves
  const SLIDE_S = 0.5; // a block slides one cell in this long
  const GATE_S = { easy: 22, normal: 16, hard: 13 }; // the vents' slower rhythm costs a little waiting
  const BOULDER = { rad: 0.12, speed: 0.2, delay: 1.5 };

  // blocks: lower-left cell (2 x 2 cells each)
  const BLOCKS = [
    { sec: 0, i: 2, j: 3 }, { sec: 0, i: 2, j: 7 }, // push north into the channel
    { sec: 0, i: 9, j: 3 }, // push east onto the plate
    { sec: 1, i: 15, j: 5 }, // push south through the vents into the channel
    { sec: 1, i: 11, j: 8 },
  ];
  // the boulder's way out of the chalice's room, cell centers [i, j]
  // (row 1.6: clear of the pillars in row 3)
  const BOULDER_PATH = [[1.6, 9.5], [1.6, 5.5], [11, 5.5], [11.5, 1.5], [16, 1.5]].map(([i, j]) => cellCenter(i, j));

  const STONE = { top: "#c8b890", side: "#9a8a68", dark: "#6e6048", line: "rgba(30,20,8,0.9)", tex: "sandstone" }; // lighter than the walls: these move
  const WALL = { top: "#8a8272", side: "#625b4e", dark: "#474136", line: "rgba(15,12,8,0.6)", mortar: true, tex: "crypt" };
  // the deep cistern's walls: sea-green stone, so you see at once which section you're in
  const DEEP_WALL = { top: "#6a9290", side: "#4a6e6c", dark: "#34504e", line: "rgba(5,20,20,0.6)", mortar: true, tex: "seastone" };
  const DOOR = { top: "#6a7a8a", side: "#4a5a6a", dark: "#34404c", line: "rgba(5,10,20,0.8)", door: true, doorH: 0.3, symbol: "wave", glyph: "#a8e0ff", stud: "rgba(200,230,255,0.6)" };
  const LIFT_COL = { top: "#b08848", side: "#86602a", dark: "#5e4418", line: "rgba(40,24,4,0.9)" };
  const DAIS = { top: "#80a0c0", side: "#587898", dark: "#3e5470", line: "rgba(10,20,40,0.8)" };

  Lynx.templeCistern = (api) => {
    const { ar, d } = api;
    const diff = api.cfg.difficulty in GATE_S ? api.cfg.difficulty : "normal";
    const N = {
      easy: { scarabs: 1, bats: 0, mummies: 1, wisps: 0, biteS: 2.2 },
      normal: { scarabs: 2, bats: 1, mummies: 1, wisps: 1, biteS: 1.5 },
      hard: { scarabs: 3, bats: 2, mummies: 2, wisps: 1, biteS: 1.1 },
    }[diff];
    const CHALICE = ["kkkkkkk", "kwccckk", ".kccck.", "..kck..", "...k...", "..kkk..", ".kkkkk."];
    const BOULDER_SPR = ["..kkkk..", ".kssssk.", "ksswsssk", "kssssssk", "kssssssk", "ksssssdk", ".ksssdk.", "..kkkk.."];
    const img = {
      chalice: Lynx.sprite(CHALICE, { k: "#6a4a10", w: "#ffffff", c: "#40c0ff" }),
      boulder: Lynx.sprite(BOULDER_SPR, { k: "#2a2620", s: "#8a8070", w: "#c8c0b0", d: "#5a5448" }),
    };

    let sec = 0;
    let time = 0;
    const cell = (s, i, j) => (i < 0 || i >= ROWS || j < 0 || j >= COLS ? "#" : MAPS[s][i][j]);
    const rectOf = (s, ch) => K.rectWhere((i, j) => MAPS[s][i][j] === ch);
    const walls = [0, 1].map((s) => K.mergeCells((i, j) => cell(s, i, j) === "#").map((q) => ({ ...q, h0: 0, h1: 0.3 })));
    const outer = [K.outerWalls(CELL), K.outerWalls(0)].map((pieces, s) => pieces.filter((q) => !K.behindRim(q, (f, r) => cell(s, cellI(f), cellJ(r)) === "#")));
    // for drawing: the outer ring's wall cells are grating (api.fence), the rest stone
    const wallsDrawn = [0, 1].map((s) => K.mergeCells((i, j) => cell(s, i, j) === "#" && !api.onRim(i, j, ROWS, COLS)));
    const rimWalls = [0, 1].map((s) => K.mergeCells((i, j) => cell(s, i, j) === "#" && api.onRim(i, j, ROWS, COLS)));
    const bridged = [0, 1].map(() => Array.from({ length: ROWS }, () => new Array(COLS).fill(false)));
    const blocks = BLOCKS.map((b, k) => ({ ...b, id: k, start: { i: b.i, j: b.j }, sunk: false, sink: 0, slide: null, push: 0 }));
    const plate = rectOf(0, "P");
    const door = { ...rectOf(0, "D"), open: 0 };
    const shaft = rectOf(0, "H");
    const button = rectOf(1, "T");
    const buttonAt = { f: (button.f0 + button.f1) / 2, r: (button.r0 + button.r1) / 2 };
    const gateRect = rectOf(1, "G");
    const gate = K.timedGate(api, GATE_S[diff]);
    const dais = { ...rectOf(1, "R"), h0: 0, h1: 0.05 };
    // h: its top, in the section you're in. It starts up, level with the
    // antechamber's floor over the shaft: step on and ride it down. (Only it
    // takes you down, so it's always in the section you're in.)
    const lift = { up: true, h: 0, riding: 0, armed: false };
    const resetDisks = [
      { sec: 0, f: 8.5 * CELL, r: K.R_MIN + CELL, h: 0.17, n: { f: 0, r: 1 }, hit: 0 },
      { sec: 1, f: 11.5 * CELL, r: K.R_MIN + CELL, h: 0.17, n: { f: 0, r: 1 }, hit: 0 },
    ];
    let chalice = false;
    let onButton = false;
    let pressedEver = false;
    let wading = 0;
    let biteT = 0;
    let boulder = null; // {f, r, k (next path point), t, roll}
    let visited = new Set([0]);
    let woken = new Set();
    const items = [
      { sec: 0, kind: "gem", f: 0.825, r: 0.6, base: 0.12, float: true }, // over the channel
      { sec: 0, kind: "potion", ...cellCenter(11, 1.5), base: 0 },
      { sec: 0, kind: "gem", ...cellCenter(17, 9), base: 0 }, // beyond the second line of vents
      { sec: 0, kind: "bigGem", ...cellCenter(18, 10), base: 0 },
      { sec: 1, kind: "gem", ...cellCenter(13.5, 2), base: 0.12, float: true }, // over the vents
      { sec: 1, kind: "gem", ...cellCenter(16, 10), base: 0 },
      { sec: 1, kind: "potion", ...cellCenter(3, 1), base: 0 },
      { sec: 1, kind: "gem", ...cellCenter(3, 10), base: 0 },
      { sec: 1, kind: "chalice", f: (dais.f0 + dais.f1) / 2 - 0.02, r: 0, base: dais.h1, size: 0.07, glow: "rgba(140,220,255,0.9)" },
    ];

    // -- blocks ----------------------------------------------------------------------------
    function blockRect(b) {
      const q = cellRect(b.i, b.i + 1, b.j, b.j + 1);
      if (!b.slide) return q;
      const k = b.slide.t;
      return { f0: q.f0 + b.slide.di * CELL * k, f1: q.f1 + b.slide.di * CELL * k, r0: q.r0 + b.slide.dj * CELL * k, r1: q.r1 + b.slide.dj * CELL * k };
    }
    const blockTop = (b) => (b.sunk ? BLOCK_H * (1 - b.sink) : BLOCK_H); // a sinking block goes down to the floor's level
    const liveBlocks = (s) => blocks.filter((b) => b.sec === s && !b.gone && !(b.sunk && b.sink >= 1));
    function canMove(b, di, dj) {
      const i0 = b.i + di;
      const j0 = b.j + dj;
      for (let i = i0; i <= i0 + 1; i++) {
        for (let j = j0; j <= j0 + 1; j++) {
          const c = cell(b.sec, i, j);
          if ("#HLTGRD".includes(c)) return false;
        }
      }
      const q = cellRect(i0, i0 + 1, j0, j0 + 1);
      return !liveBlocks(b.sec).some((o) => o !== b && K.overlaps(q, blockRect(o)));
    }
    function trySink(b) {
      for (let i = b.i; i <= b.i + 1; i++) for (let j = b.j; j <= b.j + 1; j++) if (cell(b.sec, i, j) !== "w" || bridged[b.sec][i][j]) return;
      b.sunk = true;
      Lynx.sfx.play("explode");
      api.say("Splash -- the block sinks: a bridge!", "#80c0ff");
    }
    function updateBlocks(dt, me) {
      const cmd = stopper.command;
      const mag = Math.hypot(cmd.vf, cmd.vr);
      blocks.forEach((b) => {
        if (b.sunk) {
          if (b.sink < 1) {
            b.sink = Math.min(1, b.sink + dt * 1.5);
            if (b.sink >= 1) for (let i = b.i; i <= b.i + 1; i++) for (let j = b.j; j <= b.j + 1; j++) bridged[b.sec][i][j] = true;
          }
          return;
        }
        if (b.slide) {
          b.slide.t += dt / SLIDE_S;
          if (b.slide.t >= 1) {
            b.i += b.slide.di;
            b.j += b.slide.dj;
            b.slide = null;
            trySink(b);
          }
          return;
        }
        if (b.sec !== sec || ar.airborne || ar.feet() > 0.05) {
          b.push = 0;
          return;
        }
        // pushed? the robot at a face, within reach, driving into it
        const q = blockRect(b);
        const cf = (q.f0 + q.f1) / 2;
        const cr = (q.r0 + q.r1) / 2;
        const reach = K.CLEAR + 0.015;
        let dir = null;
        if (Math.abs(me.r - cr) < 0.12 && me.f < q.f0 && q.f0 - me.f < reach && cmd.vf > 0.5 * mag) dir = [1, 0];
        else if (Math.abs(me.r - cr) < 0.12 && me.f > q.f1 && me.f - q.f1 < reach && cmd.vf < -0.5 * mag) dir = [-1, 0];
        else if (Math.abs(me.f - cf) < 0.12 && me.r < q.r0 && q.r0 - me.r < reach && cmd.vr > 0.5 * mag) dir = [0, 1];
        else if (Math.abs(me.f - cf) < 0.12 && me.r > q.r1 && me.r - q.r1 < reach && cmd.vr < -0.5 * mag) dir = [0, -1];
        if (!dir || mag < 0.05) {
          b.push = 0;
          return;
        }
        b.push += dt;
        if (b.push < PUSH_S) return;
        b.push = 0;
        if (canMove(b, dir[0], dir[1])) {
          b.slide = { di: dir[0], dj: dir[1], t: 0 };
          Lynx.sfx.play("crate");
        } else Lynx.sfx.play("knock");
      });
    }
    function resetBlocks(s) {
      const me = api.toLocal(ar.pose.x, ar.pose.y);
      let moved = 0;
      blocks.filter((b) => b.sec === s && !b.sunk && !b.gone).forEach((b) => {
        const q = cellRect(b.start.i, b.start.i + 1, b.start.j, b.start.j + 1);
        if (inRect(me.f, me.r, K.grow(q, K.CLEAR))) return; // you're standing there
        if (b.i !== b.start.i || b.j !== b.start.j) moved++;
        b.i = b.start.i;
        b.j = b.start.j;
        b.slide = null;
      });
      // blocks that were destroyed come back too
      blocks.filter((b) => b.sec === s && b.gone).forEach((b) => {
        b.gone = false;
        b.i = b.start.i;
        b.j = b.start.j;
        moved++;
      });
      api.say(moved ? "The stones grind back to where they began" : "Nothing to put back", "#ffd84a");
      Lynx.sfx.play(moved ? "crate" : "knock");
    }

    // -- geometry --------------------------------------------------------------------------
    const plateDown = () => {
      if (liveBlocks(0).some((b) => !b.slide && K.overlaps(blockRect(b), plate))) return true;
      if (sec !== 0 || ar.feet() > 0.05) return false;
      const me = api.toLocal(ar.pose.x, ar.pose.y);
      return inRect(me.f, me.r, plate);
    };
    const doorShut = () => door.open < 0.95;
    const inWater = (s, f, r) => {
      const i = cellI(f);
      const j = cellJ(r);
      return cell(s, i, j) === "w" && !bridged[s][i][j];
    };
    const ventCovered = (s, i, j) => liveBlocks(s).some((b) => !b.slide && inRect(cellCenter(i, j).f, cellCenter(i, j).r, blockRect(b)));
    const ventOffset = (s, i, j) => (s === 0 ? (j === 4 ? 0 : 1.5) : j * 0.25);
    const ventOn = (s, i, j, t = time) => cell(s, i, j) === "v" && !ventCovered(s, i, j) && (((t - ventOffset(s, i, j)) % VENT_S) + VENT_S) % VENT_S < VENT_ON;

    function solids(s) {
      const out = walls[s].slice();
      liveBlocks(s).forEach((b) => out.push({ ...blockRect(b), h0: b.sunk ? -1 : 0, h1: b.sunk ? blockTop(b) : BLOCK_H, block: b }));
      if (s === 0 && door.open < 1) out.push({ ...door, h0: 0, h1: 0.3 * (1 - door.open) });
      if (s === 1 && gate.shut()) out.push({ ...gateRect, h0: 0, h1: 0.3 });
      if (s === 1) out.push(dais);
      return out;
    }
    const boundary = K.boundary();
    const blockers = (feet) => solids(sec).concat(boundary).filter((b) => b.h1 > feet + K.STEP_UP && b.h0 < feet + K.BODY_H);
    const stopper = K.wallStopper(api, blockers, {
      speed: (me) => (inWater(sec, me.f, me.r) && ar.feet() < 0.02 ? WADE : 1),
    });

    // the lift's top in section s (A: over the shaft; B: its own shaft)
    const liftTop = (s) => (s === 0 ? (lift.up ? lift.h : null) : lift.up ? null : lift.h);
    function surfaces(f, r) {
      const i = cellI(f);
      const j = cellJ(r);
      const c = cell(sec, i, j);
      const hs = [];
      if (c === "#") hs.push(0.3);
      else if (c === "w" && !bridged[sec][i][j]) hs.push(WATER_H);
      else if (c === "H") {
        const t = liftTop(0);
        hs.push(t === null ? -2 : t);
      } else if (c === "L") {
        const t = liftTop(1);
        hs.push(t === null ? -2 : t);
      } else hs.push(0);
      solids(sec).forEach((b) => inRect(f, r, b) && b.h1 < 0.29 && hs.push(b.h1));
      liveBlocks(sec).forEach((b) => inRect(f, r, blockRect(b)) && hs.push(b.sunk ? blockTop(b) : BLOCK_H)); // you can jump onto a block
      return hs;
    }
    function groundAt(f, r, feet, fallback) {
      const ok = surfaces(f, r).filter((h) => h <= feet + K.STEP_UP);
      return ok.length ? Math.max(...ok) : fallback;
    }
    function pointSolid(f, r, h) {
      if (h > 0.3) return false;
      return solids(sec).some((b) => inRect(f, r, b) && h >= b.h0 && h <= b.h1) || cell(sec, cellI(f), cellJ(r)) === "#";
    }
    function lineOfSight(a, b) {
      const len = Math.hypot(b.f - a.f, b.r - a.r, b.h - a.h);
      const n = Math.max(1, Math.ceil(len / 0.04));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        if (pointSolid(a.f + (b.f - a.f) * t, a.r + (b.r - a.r) * t, a.h + (b.h - a.h) * t)) return false;
      }
      return true;
    }

    const enemies = K.enemyPack(api, {
      pointSolid,
      lineOfSight,
      walkOk: (e, f, r) => {
        const c = cell(e.sec, cellI(f), cellJ(r));
        if ("#wvHLTGR".includes(c) && !(c === "w" && bridged[e.sec][cellI(f)][cellJ(r)])) return false;
        return !liveBlocks(e.sec).some((b) => !b.sunk && inRect(f, r, blockRect(b)));
      },
    });
    const here = (x) => x.sec === sec;
    function wake(zone) {
      if (woken.has(zone)) return;
      woken.add(zone);
      const add = (kind, p, h, s) => enemies.add(kind, p, h, { sec: s });
      if (zone === "plates") [cellCenter(11, 9), cellCenter(8, 6), cellCenter(12, 2)].slice(0, N.scarabs).forEach((p) => add("scarab", p, 0, 0));
      if (zone === "vents") [cellCenter(16, 9), cellCenter(17, 5.5)].slice(0, N.bats).forEach((p) => add("bat", p, 0.2, 0));
      if (zone === "cistern") [cellCenter(11, 2), cellCenter(11, 10)].slice(0, N.mummies).forEach((p) => add("mummy", p, 0, 1));
      if (zone === "chalice") [cellCenter(3, 3)].slice(0, N.wisps).forEach((p) => add("wisp", p, 0.15, 1));
      if (enemies.list.some(here)) Lynx.sfx.play("growl");
    }

    // -- every frame -------------------------------------------------------------------------
    function switchSection(to, z, airborne) {
      sec = to;
      visited.add(to);
      ar.z = z;
      ar.ground = z;
      ar.airborne = airborne;
      ar.vz = 0;
      lift.armed = false;
      api.say(`The ${SECTION_NAME[to]}`, "#c0d8ff");
    }
    function onLiftCells(me) {
      return inRect(me.f, me.r, K.grow(shaft, -0.03)); // the same cells in both sections
    }

    function physics(me) {
      ar.setGround(groundAt(me.f, me.r, ar.feet(), ar.ground));
      // down the shaft: the deep cistern appears, you land on the lift
      if (lift.riding) return; // riding it down, the lift brings you
      if (sec === 0 && ar.feet() < -0.3) switchSection(1, 0.35, true);
      else if (ar.feet() < -0.5) ar.z = ar.ground = 0; // (can't happen: the lift is always in the shaft you're in)
    }

    function updateLift(dt, me) {
      const on = onLiftCells(me) && !ar.airborne;
      if (!onLiftCells(me)) lift.armed = true;
      if (lift.riding) {
        lift.h += lift.riding * (LIFT_DROP / LIFT_S) * dt;
        if (lift.riding > 0 && lift.h >= LIFT_DROP) {
          // up: out into the antechamber, the lift now fills the shaft there
          lift.riding = 0;
          lift.up = true;
          lift.h = 0;
          switchSection(0, 0, false);
        } else if (lift.riding < 0 && lift.h <= -LIFT_DROP) {
          lift.riding = 0;
          lift.up = false;
          lift.h = 0;
          switchSection(1, 0, false);
        }
        return;
      }
      if (on && lift.armed && Math.abs(ar.feet() - lift.h) < 0.03) {
        if (sec === 1 && !lift.up) {
          lift.riding = 1;
          Lynx.sfx.play("power");
        } else if (sec === 0 && lift.up) {
          lift.riding = -1;
          Lynx.sfx.play("power");
        }
      }
    }

    function updateBoulder(dt, me) {
      if (!boulder) return;
      boulder.t += dt;
      if (boulder.t < BOULDER.delay) return;
      const goal = BOULDER_PATH[boulder.k];
      if (!goal) {
        if (!boulder.done) {
          boulder.done = true;
          Lynx.sfx.play("explode");
        }
        return;
      }
      const df = goal.f - boulder.f;
      const dr = goal.r - boulder.r;
      const dist = Math.hypot(df, dr);
      const stepM = BOULDER.speed * d.speed * dt;
      if (dist <= stepM) {
        boulder.f = goal.f;
        boulder.r = goal.r;
        boulder.k++;
      } else {
        boulder.f += (df / dist) * stepM;
        boulder.r += (dr / dist) * stepM;
      }
      boulder.roll += stepM / BOULDER.rad;
      // into unbridged water: it sinks; into a block: both smash
      if (inWater(1, boulder.f, boulder.r)) {
        boulder.k = BOULDER_PATH.length;
        boulder.sunk = true;
        Lynx.sfx.play("explode");
        api.say("The boulder sinks into the channel!", "#80c0ff");
        return;
      }
      const hitBlock = liveBlocks(1).find((b) => !b.sunk && inRect(boulder.f, boulder.r, K.grow(blockRect(b), BOULDER.rad)));
      if (hitBlock) {
        hitBlock.gone = true;
        boulder.k = BOULDER_PATH.length;
        boulder.smashed = true;
        Lynx.sfx.play("explode");
        return;
      }
      if (sec === 1 && Math.hypot(me.f - boulder.f, me.r - boulder.r) < BOULDER.rad + 0.08 && ar.feet() < 2 * BOULDER.rad - 0.02) {
        api.hurt("Flattened by the boulder!");
        boulder.k = BOULDER_PATH.length;
        boulder.smashed = true;
      }
    }

    function update(dt, me) {
      time += dt;
      gate.update(dt);
      resetDisks.forEach((s) => (s.hit = Math.max(0, s.hit - dt)));
      door.open = clamp(door.open + (plateDown() ? dt * 1.2 : -dt * 1.2), 0, 1);
      updateBlocks(dt, me);
      updateLift(dt, me);
      updateBoulder(dt, me);

      const feet = ar.feet();
      const i = cellI(me.f);
      // flames
      if (feet < FLAME_H) {
        const near = [[0, 0], [0.06, 0], [-0.06, 0], [0, 0.06], [0, -0.06]].some(([a, b]) => ventOn(sec, cellI(me.f + a), cellJ(me.r + b)));
        if (near) api.hurt("Burned! Cross the vents between bursts");
      }
      // water: slow, and the eels
      if (inWater(sec, me.f, me.r) && feet < 0.02) {
        wading += dt;
        biteT -= dt;
        if (wading > 0.8 && biteT <= 0) {
          biteT = N.biteS;
          api.hurt("An eel bites! Bridge the water");
        }
      } else {
        wading = 0;
        biteT = 0;
      }
      // the button: step on it (again) to open the gate
      const onB = sec === 1 && feet < 0.05 && inRect(me.f, me.r, button);
      if (onB && !onButton && !chalice) {
        gate.press();
        pressedEver = true;
      }
      onButton = onB;

      if (sec === 0 && i >= 7 && i <= 12) wake("plates");
      if (sec === 0 && i >= 14) wake("vents");
      if (sec === 1 && i <= 12) wake("cistern");
      if (sec === 1 && i <= 4) wake("chalice");
      enemies.update(dt, me, K.camLocal(api), here);
      K.pickUp(api, items, me, feet, (it) => {
        if (it.kind !== "chalice") return false;
        chalice = true;
        gate.hold();
        api.addScore(3000);
        Lynx.sfx.play("power");
        api.say("The Tide Chalice! Something heavy starts to roll... RUN for the lift!", "#ffd84a");
        boulder = { f: BOULDER_PATH[0].f, r: BOULDER_PATH[0].r, k: 1, t: 0, roll: 0 };
        Lynx.sfx.play("growl");
        return true;
      }, here);
      // out through the entrance with the chalice
      if (chalice && sec === 0 && me.f < 0.25) api.complete();
    }

    // -- shooting ------------------------------------------------------------------------------
    function targets() {
      const out = enemies.targets(here);
      resetDisks.forEach((s) => s.sec === sec && s.rect && out.push({ obj: s, kind: "switch" }));
      return out;
    }
    function hit(t) {
      if (t.kind === "switch") {
        t.obj.hit = 0.3;
        if (t.obj.cool > time) return;
        t.obj.cool = time + 1.5;
        Lynx.sfx.play("zap");
        resetBlocks(sec);
        return;
      }
      enemies.hit(t);
    }

    // -- drawing -------------------------------------------------------------------------------
    const rectPoly = (q, h) => [api.w3(q.f0, q.r0, h), api.w3(q.f1, q.r0, h), api.w3(q.f1, q.r1, h), api.w3(q.f0, q.r1, h)];
    function fillRect(q, h, fill, stroke, width) {
      const p = api.polyScreen(rectPoly(q, h), 3);
      if (p) api.fillPoly(p, fill, stroke, width);
    }
    function drawFloor() {
      K.mergeCells((i, j) => cell(sec, i, j) !== "#").forEach((q) => {
        fillRect(q, 0.001, "rgba(30,34,30,0.35)", "rgba(90,90,70,0.3)");
        if (api.floorDetail) api.floorDetail(q);
      });
      // water, where not bridged
      const ripple = 0.5 + 0.5 * Math.sin(time * 2);
      K.mergeCells((i, j) => cell(sec, i, j) === "w" && !bridged[sec][i][j]).forEach((q) => {
        fillRect(q, 0.002, `rgba(30,90,${140 + 30 * ripple},0.7)`, "rgba(150,210,255,0.6)", 2);
        for (let f = q.f0 + 0.05; f < q.f1; f += 0.1) api.line3([[f, q.r0 + 0.02, 0.003], [f, q.r1 - 0.02, 0.003]], `rgba(200,235,255,${0.2 + 0.2 * ripple})`, 1, 0.1);
      });
      // vents: a grate, glowing just before they fire
      for (let i = 0; i < ROWS; i++) {
        for (let j = 0; j < COLS; j++) {
          if (cell(sec, i, j) !== "v") continue;
          const q = cellRect(i, i, j, j);
          const soon = !ventOn(sec, i, j) && ventOn(sec, i, j, time + 0.4);
          fillRect(K.grow(q, -0.015), 0.003, soon ? "#7a3010" : "#262220", "#5a5048", 1);
        }
      }
      // plate, shaft, button, the lift's hole
      if (sec === 0) {
        fillRect(K.grow(plate, -0.02), 0.004, plateDown() ? "#5a5a50" : "#9a8a60", "#3a3020", 2);
        if (!lift.up) fillRect(shaft, 0.003, "#050505", "#3a3020", 2);
      }
      if (sec === 1) {
        K.floorButton(api, buttonAt, 0, gate.open && !gate.held);
        if (lift.up) fillRect(shaft, 0.003, "#050505", "#3a3020", 2);
      }
      const c = K.camLocal(api);
      if (liftSunk() && c.h > 0.02) drawShaftFromAbove(c);
    }
    // Flames: a few tongues per vent, each a teardrop from the grate to a
    // flickering, swaying tip (white-hot core, orange, red and fading), a
    // glow on the floor and embers rising off it. They flare up when the vent
    // fires and die down at the end; while off, a small blue pilot flame.
    const TONGUES = [[0, 0, 1, 0.034], [-0.03, 0.02, 0.75, 0.024], [0.03, -0.015, 0.8, 0.024]]; // [dr, df, height, half width] (m)
    function tongue(c, base, tip, halfW, sway, stops) {
      const ax = tip.x - base.x;
      const ay = tip.y - base.y;
      const len = Math.hypot(ax, ay);
      if (len < 2) return;
      const px = -ay / len;
      const py = ax / len;
      const P = (s, l) => [base.x + ax * s + px * l, base.y + ay * s + py * l];
      const g = c.createLinearGradient(base.x, base.y, tip.x, tip.y);
      stops.forEach(([o, col]) => g.addColorStop(o, col));
      c.fillStyle = g;
      c.beginPath();
      c.moveTo(...P(0, -halfW));
      c.bezierCurveTo(...P(0.35, -halfW * 1.15), ...P(0.72, -halfW * 0.3 + sway * 0.5), ...P(1, sway));
      c.bezierCurveTo(...P(0.72, halfW * 0.3 + sway * 0.5), ...P(0.35, halfW * 1.15), ...P(0, halfW));
      c.quadraticCurveTo(...P(-0.15, 0), ...P(0, -halfW));
      c.fill();
    }
    const OUTER = [[0, "rgba(255,250,210,0.95)"], [0.2, "rgba(255,200,70,0.9)"], [0.55, "rgba(255,110,20,0.75)"], [1, "rgba(190,30,0,0)"]];
    const INNER = [[0, "rgba(255,255,255,0.95)"], [0.35, "rgba(255,240,170,0.85)"], [1, "rgba(255,190,60,0)"]];
    const PILOT = [[0, "rgba(160,210,255,0.9)"], [0.6, "rgba(60,110,255,0.6)"], [1, "rgba(40,60,255,0)"]];
    function queueFlames() {
      for (let i = 0; i < ROWS; i++) {
        for (let j = 0; j < COLS; j++) {
          if (cell(sec, i, j) !== "v" || ventCovered(sec, i, j)) continue;
          const p = cellCenter(i, j);
          const w = api.toWorld(p.f, p.r);
          const pr = api.camZ(w.x, w.y, 0.1) >= 0.06 ? ar.project(w.x, w.y, 0.1) : null;
          if (!pr) continue;
          const phase = (((time - ventOffset(sec, i, j)) % VENT_S) + VENT_S) % VENT_S;
          const on = phase < VENT_ON;
          // flare up over 0.15 s, die down over the last 0.25 s
          const env = on ? Math.min(1, phase / 0.15) * Math.min(1, (VENT_ON - phase) / 0.25) : 0;
          const seed = i * 7.3 + j * 3.1;
          ar.queue(pr.depth, () => {
            const c = ar.ctx;
            c.save();
            c.globalCompositeOperation = "lighter";
            if (!on) {
              const b = ar.project(w.x, w.y, 0.004);
              const t = ar.project(w.x, w.y, 0.03 + 0.004 * Math.sin(time * 20 + seed));
              if (b && t) tongue(c, b, t, 0.012 * b.ppm, 0, PILOT);
              c.restore();
              return;
            }
            const b0 = ar.project(w.x, w.y, 0.004);
            if (b0) ar.glow(b0.x, b0.y, 0.11 * b0.ppm * (0.7 + 0.3 * env), [[0, `rgba(255,140,40,${(0.55 * env).toFixed(3)})`], [1, "rgba(255,60,0,0)"]]);
            TONGUES.forEach(([dr, df, hk, hw], k) => {
              const tw = api.toWorld(p.f + df, p.r + dr);
              const flick = 0.82 + 0.1 * Math.sin(time * 17 + seed + k * 2.1) + 0.08 * Math.sin(time * 31 + seed * 1.7 + k);
              const h = FLAME_H * hk * env * flick;
              const b = ar.project(tw.x, tw.y, 0.004);
              const t = ar.project(tw.x, tw.y, 0.004 + h);
              if (!b || !t) return;
              const sway = (0.012 * Math.sin(time * 6 + seed + k * 1.3) + 0.006 * Math.sin(time * 13 + k)) * b.ppm;
              tongue(c, b, t, hw * b.ppm, sway, OUTER);
              const ti = ar.project(tw.x, tw.y, 0.004 + h * 0.5);
              if (ti) tongue(c, b, ti, hw * 0.5 * b.ppm, sway * 0.5, INNER);
            });
            // embers
            for (let k = 0; k < 4; k++) {
              const s = (time * 0.9 + k / 4 + seed * 0.13) % 1;
              const e = ar.project(w.x + 0.03 * Math.sin(seed + k * 2 + s * 5), w.y + 0.03 * Math.cos(seed * 1.3 + k), 0.03 + s * FLAME_H * 1.3 * env);
              if (!e) continue;
              c.fillStyle = `rgba(255,${Math.round(200 - 120 * s)},60,${(0.9 * (1 - s) * env).toFixed(3)})`;
              c.beginPath();
              c.arc(e.x, e.y, Math.max(1, 0.004 * e.ppm), 0, 2 * Math.PI);
              c.fill();
            }
            c.restore();
          }, api.pointAt(w.x, w.y, 0, FLAME_H));
        }
      }
    }

    // The lift's shaft while the lift is below the floor (on its way down):
    // looking in from above, its walls and the lift inside the opening; from
    // in it, its walls all round, over everything else.
    function drawShaftWalls(lo, c, all) {
      const q = shaft;
      const img = api.texFace && Lynx.texture("crypt");
      [[[q.f0, q.r1], [q.f0, q.r0], 1, 0], [[q.f1, q.r0], [q.f1, q.r1], -1, 0], [[q.f0, q.r0], [q.f1, q.r0], 0, 1], [[q.f1, q.r1], [q.f0, q.r1], 0, -1]].forEach(([a, b, nf, nr]) => {
        if (!all && (c.f - a[0]) * nf + (c.r - a[1]) * nr <= 0) return;
        const p = api.polyScreen([api.w3(a[0], a[1], lo), api.w3(b[0], b[1], lo), api.w3(b[0], b[1], 0), api.w3(a[0], a[1], 0)], 3);
        if (!p) return;
        api.fillPoly(p, "#3a342a", null);
        if (img) api.texFace(a, b, lo, 0, img, true);
        api.fillPoly(p, "rgba(0,0,0,0.4)", "rgba(0,0,0,0.7)", 2);
      });
    }
    const liftSunk = () => {
      const t = liftTop(sec);
      return t !== null && t < -0.005;
    };
    function drawShaftFromAbove(c) {
      const open = api.polyScreen(rectPoly(shaft, 0.003), 3);
      if (!open) return;
      const t = liftTop(sec);
      const g = ar.ctx;
      g.save();
      g.beginPath();
      open.forEach((p, k) => (k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
      g.closePath();
      g.clip();
      api.fillPoly(open, "#050505", null);
      drawShaftWalls(t - 0.06, c, false);
      fillRect(shaft, t, LIFT_COL.top, LIFT_COL.line, 2);
      if (api.texFloor) api.texFloor(shaft, t, "slab");
      g.restore();
      api.fillPoly(open, null, "#3a3020", 2);
    }
    function queueBoulder() {
      if (!boulder || sec !== 1 || boulder.sunk || boulder.smashed || boulder.t < 0) return;
      const w = api.toWorld(boulder.f, boulder.r);
      const b = { f: boulder.f, r: boulder.r, rect: null };
      api.drawSprite(b, img.boulder, w.x, w.y, 0, 2 * BOULDER.rad, { flip: Math.floor(boulder.roll * 2) % 2 === 1 });
    }

    function draw() {
      const c = K.camLocal(api);
      drawFloor();
      wallsDrawn[sec].forEach((q) => api.box(q, 0, 0.3, sec === 1 ? DEEP_WALL : WALL));
      rimWalls[sec].forEach((q) => api.fence(q, 0, 0.3));
      outer[sec].forEach((q) => api.fence(q, 0, 0.3));
      liveBlocks(sec).forEach((b) => {
        const top = b.sunk ? blockTop(b) : BLOCK_H;
        api.box(K.grow(blockRect(b), -0.005), b.sunk ? top - 0.3 : 0, top, STONE);
      });
      // sunk blocks: flat bridges in the channel
      blocks.filter((b) => b.sec === sec && b.sunk && b.sink >= 1).forEach((b) => fillRect(blockRect(b), 0.004, "#7e786e", "#3a362e", 2));
      if (sec === 0 && door.open < 1) api.box(door, 0, 0.3 * (1 - door.open), DOOR);
      if (sec === 1) {
        K.queueBars(api, gateRect, 0, 0.3, gate.lift);
        api.box(dais, 0, dais.h1, DAIS);
      }
      const t = liftTop(sec);
      const inShaft = liftSunk() && c.h <= 0.02;
      if (t !== null && (!liftSunk() || inShaft)) api.box(shaft, t - 0.06, t, LIFT_COL);
      resetDisks.forEach((s) => s.sec === sec && K.sunDisk(api, s, c, lineOfSight, "#40a0ff"));
      queueFlames();
      queueBoulder();
      K.drawItems(api, items, c, lineOfSight, img, here);
      enemies.queue(c, here);
      ar.flush();
      if (inShaft) drawShaftWalls(t - 0.06, c, true);
    }

    function hud() {
      gate.hud();
      K.minimap(api, (i, j) => {
        const ch = cell(sec, i, j);
        const q = cellCenter(i, j);
        if (liveBlocks(sec).some((b) => !b.sunk && inRect(q.f, q.r, blockRect(b)))) return "#a8a298";
        if (ch === "#") return "#4a4336";
        if (ch === "w") return bridged[sec][i][j] ? "#7e786e" : "#2a6aa0";
        if (ch === "v") return ventOn(sec, i, j) ? "#ff8030" : "#5a3020";
        if (ch === "P") return plateDown() ? "#c0b080" : "#8a7a50";
        if (ch === "D") return doorShut() ? "#6a7a8a" : "#9a9280";
        if (ch === "H" || ch === "L") return "#b08848";
        if (ch === "T") return gate.open ? "#ffd84a" : "#a08040";
        if (ch === "G") return gate.shut() ? "#2e2e34" : "#9a9280";
        if (ch === "R") return "#80a0c0";
        return "#9a9280";
      }, SECTION_NAME[sec].toUpperCase(), boulder && sec === 1 && !boulder.sunk && !boulder.smashed ? [{ f: boulder.f, r: boulder.r, color: "#ff4040" }] : []);
    }

    function objective() {
      const me = api.toLocal(ar.pose.x, ar.pose.y);
      const go = (text, p, h = 0.1) => ({ text, at: { f: p.f, r: p.r }, h });
      const center = (q) => ({ f: (q.f0 + q.f1) / 2, r: (q.r0 + q.r1) / 2 });
      const bridgedIn = (s) => bridged[s].some((row) => row.some(Boolean)) || blocks.some((b) => b.sec === s && b.sunk);
      if (chalice) {
        if (sec === 1) return go("The boulder! Back to the lift in the north-west -- step off it and on again to ride", center(shaft), 0.05);
        return go("Out through the entrance with the Tide Chalice", { f: 0.1, r: 0 });
      }
      if (sec === 0) {
        if (me.f < 0.9 && !bridgedIn(0)) return go("Push a stone block north into the water: a bridge (wading is slow, and eels bite)", center(blockRect(blocks[0])), 0.3);
        if (doorShut() && me.f < 2.0) {
          const b = blocks[2];
          if (b.gone || b.i !== 9) return go("The plate's block is stuck? Shoot the blue sun disk on the west wall to put the blocks back", resetDisks[0], 0.17);
          return go("Push the stone block east onto the pressure plate: it holds the door open", center(plate), 0.05);
        }
        return go("Through the door, between the flame bursts, and ride the lift down (north-west)", center(shaft), 0.05);
      }
      const inRoom = me.f < gateRect.f0;
      if (inRoom) return go("Take the Tide Chalice", { f: 0.22, r: 0 }, 0.08);
      if (!bridgedIn(1)) return go("First bridge the channel: push the block south, through the vents, into the water", center(blockRect(blocks[3])), 0.3);
      if (gate.open) return go(`Run! Through the vents, over the bridge, to the gate -- ${Math.ceil(gate.remaining)} s`, center(gateRect), 0.15);
      return go(pressedEver ? "The gate shut. The button again -- learn the vents' rhythm" : "The button in the north-east alcove opens the gate in the south -- for a few seconds", buttonAt, 0.05);
    }

    return {
      physics,
      update,
      draw,
      hud,
      objective,
      blips: () => enemies.blips(here).concat(items.filter(here).map((it) => ({ ...api.toWorld(it.f, it.r), color: it.kind === "chalice" ? "#80d0ff" : "#ffd84a", r: 2.5 }))),
      targets,
      hit,
      carryOn: () => {
        enemies.carryOn();
        if (boulder && boulder.t >= BOULDER.delay) boulder.t = 0; // a moment to breathe
      },
      filterDrive: stopper.filterDrive,
      floorName: () => SECTION_NAME[sec],
      debug: {
        gate, lift, blocks, door,
        section: (s) => (sec = s),
        clear: () => enemies.list.splice(0),
        ventOn: (i, j) => ventOn(sec, i, j),
        time: () => time,
        setTime: (t) => (time = t),
        bridged,
        boulder: () => boulder,
        resetBlocks: () => resetBlocks(sec),
        groundAt,
      },
      snapshot: () => ({
        sec: SECTION_NAME[sec], blocks: blocks.map((b) => `${b.sec}:${b.i},${b.j}${b.sunk ? "s" : ""}${b.gone ? "x" : ""}`).join(" "),
        door: +door.open.toFixed(2), gate: gate.held ? "held" : gate.open ? +gate.remaining.toFixed(1) : "shut",
        lift: { up: lift.up, h: +lift.h.toFixed(2), riding: lift.riding }, chalice,
        boulder: boulder && { f: +boulder.f.toFixed(2), r: +boulder.r.toFixed(2), k: boulder.k, sunk: !!boulder.sunk, smashed: !!boulder.smashed },
        enemies: enemies.list.filter(here).map((e) => e.kind), items: items.filter(here).map((it) => it.kind),
      }),
    };
  };
})(window.Lynx);
