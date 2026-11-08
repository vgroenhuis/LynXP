// Rune Stones -- a puzzle game for the knight of Knight on Blocks
// (game_knightblocks.js: its knight, the robot's drive and camera, the cube
// finder), with no fighting and no enemies: the knight crosses a level of
// chasms, fire, spikes, ghostly bridges and gates to a portal, and the
// PLAYER makes the way, by setting down the six rune stones -- the tagged
// cubes 0-5, by hand, wherever they're needed:
//   0 Island  -- raises a square of ground round itself (over a chasm)
//   1 Weight  -- holds a pressure plate down: its gate opens
//   2 Rain    -- puts out the fire near it
//   3 Lantern -- lights the ghost bridges near it: lit, they hold the knight
//   4 Key     -- set in the socket next to the portal, opens it
//   5 Earth   -- sinks the spikes near it
// A stone works wherever it stands -- on the floor in a chasm too (a pillar
// the knight can climb, like every real cube) -- and keeps working while it
// stands there: one Rain stone for two fires means putting it out at one,
// then carrying it on to the other while the knight waits. Every level needs
// all six (but the River). Moving a stone the knight is relying on (an island it stands on,
// the light of a bridge) drops it -- careful.
//
// Raised ground (as in Temple of LynXP), in 4 cm steps -- a cube's height:
// the explorer climbs one step, not two, so a stone doubles as a step up, or
// as a stepping stone across a gap between two ledges.
//
// No setup: the level is laid out on the floor in front of the robot from
// where it stands when the level starts (its drive axle; ahead is up the
// level's map), and the stones count wherever the cube finder sees them --
// the frame cube isn't used. Hazards hurt (hearts); a fall into a chasm
// costs a heart too and puts the knight back where it last stood safely;
// no hearts left: the level again, the stones where they are.
//
// Light on the GPU and CPU: everything is flat colour on the 2D canvas --
// the chasms (dark, in runs per row), a few outlines, small flames and spikes,
// bars for the gates -- no textures, no WebGL.
//
// The River (the last level) is different: two shores 4 cm up, a river
// between them (its water 4 cm up as well, level with a cube's top) and a
// ship. One stone, the Helm (cube 4 there), steers it: set down in the river,
// the ship sails to it (to the cube's top, on the water); on the shore or out
// of sight, the ship stays where it is. At a harbour the explorer boards
// (Fire / A) and goes ashore again at the other harbour; on board she can't
// walk, the ship carries her.
//
// Keys (on top of Knight on Blocks's): L the level menu, H the level's hint.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  Lynx.games.runes = (ar, cfg, app) => Lynx.games.knightblocks(ar, cfg, app, (api) => Lynx.runeStones(api));

  // The level maps, far end first (the first string is the row furthest from
  // the robot), one character per cell (cfg.cellCm, 5 cm):
  //   .  chasm           #  ground          S  start         E  portal
  //   K  the Key stone's socket              ~  ghost bridge (needs light)
  //   F  fire            f  fire, on and off (cross between bursts)
  //   ^  spikes          v  spikes, up and down
  //   a b  pressure plates   A B  their gates (plate a opens every A)
  //   w  water           h  water, a ship's berth   H  a harbour's pier (ground)
  // and optionally `rise`, the same shape: how high each cell is raised, in
  // 4 cm steps -- the height of a tag cube (. or 0 the floor, 1 4 cm, 2 8 cm,
  // 3 12 cm). Raised ground is a column from the floor up; a raised ghost
  // bridge (~) hangs in the air, held only while lit. The explorer (3 cm)
  // climbs 4 cm, not 8: a cube is a step, and a stepping stone over a gap
  // between two ledges (she jumps about 6 cm). Stones only work on the floor.
  // `riseAll`: every cell but the chasm that many steps up (water included:
  // its surface). `stones`: the only tags that count in the level, `helm`: the
  // tag that steers the ship. A level without a socket (K) has its portal open.
  const LEVELS = [
    {
      id: "first",
      name: "Six Stones",
      intro: "Every rune stone once: make the explorer's way to the portal",
      hint: "Island in the chasm, Weight on the plate, Rain at the fire, Lantern at the ghost bridge, Earth at the spikes, Key in the socket",
      map: [
        "..KE...",
        "...#...",
        "..^^^..",
        "..###..",
        "..~~~..",
        "..###..",
        "..FFF..",
        "..###..",
        "..AAA.a",
        "..###..",
        ".......",
        ".......",
        "..#S#..",
      ],
    },
    {
      id: "fires",
      name: "Fire Twice",
      intro: "Two fires, one Rain stone: carry it on while the explorer waits",
      hint: "Put out the first fire, walk past it, then move the Rain stone to the second fire",
      map: [
        ".E.......",
        ".#K......",
        "~~~......",
        "###FF####",
        "........#",
        "........^",
        "........#",
        "###FFF###",
        "#........",
        "A...a....",
        "#........",
        ".........",
        ".........",
        "S........",
      ],
    },
    {
      id: "causeway",
      name: "The Dark Causeway",
      intro: "Two ghost bridges, one Lantern: wait on the stone between them",
      hint: "Light the first bridge, cross to the ground between the two, then move the Lantern on",
      map: [
        "E~~~#~~~#",
        "K.......#",
        "........^",
        "........^",
        "........#",
        "........f",
        "........F",
        "........#",
        "........A",
        "......a.#",
        "........#",
        ".........",
        ".........",
        "........S",
      ],
    },
    {
      id: "gates",
      name: "Two Gates",
      intro: "Two gates, one Weight: the first gate may close behind the explorer",
      hint: "Weight on plate a, through gate A, then move the Weight to plate b",
      map: [
        "E~~#.....",
        "K..#.....",
        "...B..b..",
        "...#.....",
        "...^.....",
        "...^.....",
        "...#FF#A#",
        "........#",
        "....a...#",
        "........#",
        "........#",
        ".........",
        ".........",
        "........S",
      ],
    },
    {
      id: "vault",
      name: "The Rune Vault",
      intro: "Two chasms, two ghost bridges and a fire that comes and goes",
      hint: "The Island and the Lantern each go twice: move them on behind the explorer",
      map: [
        "..K.......",
        "..E.......",
        "..#.......",
        "..#.......",
        "..~.......",
        "..#.......",
        "..#..#f#^#",
        ".........~",
        ".........~",
        ".........~",
        ".#FF#vv#A#",
        "..........",
        ".......a..",
        ".S........",
      ],
    },
    {
      id: "steps",
      name: "Stepping Stones",
      intro: "Raised ground, 4 cm a step, like the stones: hop across a stone, climb onto one",
      hint: "A stone in the gap between the two ledges to hop across; the Weight on its plate is the step up onto the high ground",
      map: [
        ".E.......",
        ".~.......",
        ".~..K....",
        ".#.......",
        ".#vA#a...",
        ".....#...",
        ".....F...",
        ".....#...",
        ".........",
        ".........",
        ".....#...",
        ".....#...",
        ".....#...",
        ".....S...",
      ],
      rise: [
        ".2.......",
        ".2.......",
        ".2.......",
        ".2.......",
        ".2222....",
        ".........",
        ".........",
        ".....1...",
        ".........",
        ".........",
        ".....1...",
        ".........",
        ".........",
        ".........",
      ],
    },
    {
      id: "towers",
      name: "The Towers",
      intro: "Up to the 12 cm tower: the Key is a stepping stone before it goes in its socket",
      hint: "Island over the first chasm, Earth at the spikes; the Key between the towers to hop across, Rain at the fire up there, Weight on plate b, Lantern at the high bridge, then the Key in its socket",
      map: [
        "......E..",
        "...K..~..",
        "....b.~..",
        "..#F#B#..",
        ".........",
        ".........",
        "..#......",
        "..##.....",
        "...^.....",
        "...#.....",
        ".........",
        ".........",
        "...#.....",
        "...S.....",
      ],
      rise: [
        "......3..",
        "......3..",
        "......3..",
        "..22223..",
        ".........",
        ".........",
        "..2......",
        "..21.....",
        ".........",
        ".........",
        ".........",
        ".........",
        ".........",
        ".........",
      ],
    },
    {
      id: "river",
      name: "The River",
      intro: "Two shores and a river, 4 cm up: steer the ship across with the Helm stone (cube 4)",
      hint: "Board at the harbour (Fire / A), then set cube 4 down in the river, a bit at a time, round the rocks to the far harbour; go ashore with Fire / A",
      stones: [4],
      helm: 4,
      riseAll: 1,
      map: [
        "......E..",
        ".....###.",
        "....####.",
        "....#H##.",
        "wwwwwhwww",
        "wwwwwwwww",
        "www###www",
        "www###www",
        "wwwwwwwww",
        "wwwwwwwww",
        "whwwwwwww",
        "#H#######",
        "#########",
        "..##S##..",
      ],
    },
  ];

  const STONES = [
    { tag: 0, name: "Island", icon: "\u{1F3DD}", color: [120, 200, 90], tip: "ground round it" },
    { tag: 1, name: "Weight", icon: "\u{2693}", color: [190, 190, 200], tip: "holds a plate down" },
    { tag: 2, name: "Rain", icon: "\u{1F327}", color: [90, 160, 255], tip: "puts out fire" },
    { tag: 3, name: "Lantern", icon: "\u{1F3EE}", color: [255, 210, 90], tip: "lights ghost bridges" },
    { tag: 4, name: "Key", icon: "\u{1F5DD}", color: [240, 190, 40], tip: "opens the portal" },
    { tag: 5, name: "Earth", icon: "\u{26F0}", color: [190, 130, 70], tip: "sinks spikes" },
  ];
  // reach, in cells (from the stone's center): the Rain's, Lantern's and
  // Earth's a circle to a cell's center, the Island's a square round it
  // (turned with the cube), the Weight's and the Key's the plate / socket
  const REACH = 2.2;
  const ISLAND_HALF = 1.6;
  const ON_SPOT = 0.75; // a stone within this much of a plate's / socket's center (each way) presses it
  const FIRE_H = 0.035; // m
  const SPIKE_H = 0.012;
  const GATE_H = 0.07;
  const RISE = 0.04; // m: one step of raised ground (a tag cube's height)
  const SLAB = 0.008; // a raised ghost bridge's thickness
  const FIRE_PERIOD = 3.2; // s (f: on for the first FIRE_ON of it)
  const FIRE_ON = 1.5;
  const SPIKE_PERIOD = 2.4; // s (v: up for the first SPIKE_UP of it)
  const SPIKE_UP = 1.1;
  const INV_S = 1.2; // after a hurt, safe for this long
  const FALL_S = 0.8;
  const MAP_AHEAD_M = 0.12; // the map's near edge, ahead of the robot's drive axle at the start
  const STORE = "runesDone";
  // the ship (m, m/s): the hull's half length and half beam, its deck above the water
  const SHIP_L = 0.042;
  const SHIP_B = 0.018;
  const SHIP_DECK = 0.009;
  const SHIP_V = 0.05;
  const SHIP_TURN = 1.6; // rad/s
  const DOCK = 0.8; // cells: this close to a berth's center, the ship is in harbour
  const HELM = { name: "Helm", icon: "\u{2638}", color: [110, 210, 255], tip: "steers the ship (in the river)" };

  Lynx.runeStones = (api) => {
    const { ar, w, C, hero, cfg } = api;
    const { clamp, wrap } = api.util;
    const T = (s) => (Lynx.tr ? Lynx.tr(s) : s);
    const CELL = clamp((+cfg.cellCm || 5) / 100, 0.03, 0.1);
    const maxHearts = clamp(Math.round(+cfg.hearts) || 3, 1, 9);
    const store = {
      get() {
        try {
          return JSON.parse(localStorage.getItem(STORE) || "[]");
        } catch (e) {
          return [];
        }
      },
      set(v) {
        try {
          localStorage.setItem(STORE, JSON.stringify(v));
        } catch (e) {
          // (not remembered)
        }
      },
    };
    const G = {
      phase: "menu", // menu | play | won | lost
      sel: 0, idx: -1, lv: null, t: 0, time: 0, levelTime: 0,
      hearts: maxHearts, falls: 0, hurts: 0, flash: null, hint: false,
      done: new Set(store.get()),
      O: null, // the level's frame: {f, r, th} (local floor frame), rows, H, W
      safe: null, // where the knight last stood safely (local f, r)
      fallT: 0, inv: 0, hurtT: 0,
      stones: [], // per tag 0-5: {b, u, v} (the cube, its place in cells) or null
      gates: {}, // letter -> {open, lift}
      portalOpen: false,
      ship: null, // the river's ship: {f, r, yaw, tf, tr, aboard, berth: [i, j] or null}
    };
    const say = (text, color) => api.say(T(text), color);
    const sfx = (n) => api.sfx(n);

    // -- the level's frame: cells (row i from the far end, column j from the left) <-> the floor frame ----
    // level coordinates: u forward (toward the far end), v to the right, in m from the start's axle
    const cellUV = (i, j) => [MAP_AHEAD_M + (G.O.H - 1 - i + 0.5) * CELL, (j - (G.O.W - 1) / 2) * CELL];
    function toFR(u, v) {
      const o = G.O;
      const c = Math.cos(o.th);
      const s = Math.sin(o.th);
      return [o.f + u * c - v * s, o.r + u * s + v * c];
    }
    function toUV(f, r) {
      const o = G.O;
      const c = Math.cos(o.th);
      const s = Math.sin(o.th);
      const df = f - o.f;
      const dr = r - o.r;
      return [df * c + dr * s, -df * s + dr * c];
    }
    // floor point -> its cell (fractional: i, j)
    function cellAt(f, r) {
      const [u, v] = toUV(f, r);
      return [G.O.H - 1 + 0.5 - (u - MAP_AHEAD_M) / CELL, v / CELL + (G.O.W - 1) / 2];
    }
    const tileAt = (i, j) => (i < 0 || j < 0 || i >= G.O.H || j >= G.O.W ? "." : G.O.rows[i][j]);
    // a cell's raised height (m; 0 on the floor, and for a chasm)
    const baseAt = (i, j) => (i < 0 || j < 0 || i >= G.O.H || j >= G.O.W || G.O.rows[i][j] === "." ? 0 : G.O.base[i][j]);
    const cellCenterFR = (i, j) => toFR(...cellUV(i, j));
    const isWater = (ch) => ch === "w" || ch === "h";
    const waterAt = (f, r) => {
      const [ci, cj] = cellAt(f, r);
      return isWater(tileAt(Math.round(ci), Math.round(cj)));
    };
    // what a stone is in this level: the River's Helm, or its own
    const stoneInfo = (tag) => (G.lv && G.lv.helm === tag ? { tag, ...HELM } : STONES[tag]);
    const levelStones = () => (G.lv && G.lv.stones ? STONES.filter((st) => G.lv.stones.includes(st.tag)) : STONES);

    // -- the stones ------------------------------------------------------------------------------------------
    function findStones() {
      G.stones = STONES.map((st) => {
        if (G.lv && G.lv.stones && !G.lv.stones.includes(st.tag)) return null;
        const list = api.realSolids.filter((b) => b.tag === st.tag);
        const b = list.find((x) => !x.inferred) || list[0];
        if (!b) return null;
        const [i, j] = cellAt(b.cf, b.cr);
        return { b, i, j };
      });
    }
    const stone = (tag) => G.stones[tag];
    const near = (tag, i, j, reach) => {
      const s = stone(tag);
      return !!s && Math.hypot(s.i - i, s.j - j) <= reach;
    };
    const onSpot = (tag, i, j) => {
      const s = stone(tag);
      return !!s && Math.abs(s.i - i) <= ON_SPOT && Math.abs(s.j - j) <= ON_SPOT;
    };
    function onIsland(f, r) {
      const s = stone(0);
      if (!s) return false;
      const [u, v] = api.toB(s.b, f, r);
      const h = ISLAND_HALF * CELL;
      return Math.abs(u) <= h && Math.abs(v) <= h;
    }
    const lit = (i, j) => near(3, i, j, REACH);
    const doused = (i, j) => near(2, i, j, REACH);
    const sunk = (i, j) => near(5, i, j, REACH);
    const fireOn = (ch, i, j) => !doused(i, j) && (ch === "F" || (G.levelTime + j * 0.37) % FIRE_PERIOD < FIRE_ON);
    const spikesUp = (ch, i, j) => !sunk(i, j) && (ch === "^" || (G.levelTime + i * 0.29) % SPIKE_PERIOD < SPIKE_UP);

    // Can the knight stand on the floor here? (on a real cube's top it always can)
    function floorAt(f, r) {
      if (onIsland(f, r)) return "island";
      const [ci, cj] = cellAt(f, r);
      const i = Math.round(ci);
      const j = Math.round(cj);
      const ch = tileAt(i, j);
      if (ch === "." || isWater(ch)) return null;
      if (ch === "~") return lit(i, j) && !baseAt(i, j) ? "bridge" : null; // (under a raised bridge: the chasm)
      return ch;
    }
    // Where the explorer stands on the level's own ground -- the floor, or the
    // top of raised ground -- its cell [i, j] (else null: in the air, hanging,
    // on a cube)
    function groundCell() {
      if (hero.mode !== "move" || !hero.onGround || G.fallT > 0) return null;
      const s = hero.standOn;
      if (s === null ? hero.z >= 0.003 : !(typeof s === "string" && s.startsWith("plat"))) return null;
      if (s !== null) return s.slice(4).split("_").map(Number); // (the column she stands on)
      const [ci, cj] = cellAt(hero.f, hero.r);
      return [Math.round(ci), Math.round(cj)];
    }

    // -- plates, gates, the portal ------------------------------------------------------------------------------
    function updateMechanisms(dt) {
      const o = G.O;
      const pressed = {};
      const gc = groundCell();
      for (let i = 0; i < o.H; i++) {
        for (let j = 0; j < o.W; j++) {
          const ch = o.rows[i][j];
          if (ch !== "a" && ch !== "b") continue;
          const byKnight = !!gc && gc[0] === i && gc[1] === j;
          if (onSpot(1, i, j) || byKnight) pressed[ch.toUpperCase()] = true;
        }
      }
      Object.keys(G.gates).forEach((k) => {
        const g = G.gates[k];
        const was = g.open;
        g.open = !!pressed[k];
        if (g.open !== was) sfx(g.open ? "gate" : "clang");
        g.lift = clamp(g.lift + (g.open ? dt * 1.6 : -dt * 2.4), 0, 1);
      });
      let open = !o.hasKey; // (no socket in the level: open from the start)
      for (let i = 0; i < o.H; i++) for (let j = 0; j < o.W; j++) if (o.rows[i][j] === "K" && onSpot(4, i, j)) open = true;
      if (open !== G.portalOpen) {
        sfx(open ? "power" : "beep");
        if (open) say("The portal opens!", "#e0b0ff");
      }
      G.portalOpen = open;
    }
    function gateSolids() {
      const out = [];
      if (!G.O) return out;
      const o = G.O;
      for (let i = 0; i < o.H; i++) {
        for (let j = 0; j < o.W; j++) {
          const ch = o.rows[i][j];
          if (ch !== "A" && ch !== "B") continue;
          const g = G.gates[ch];
          const h1 = GATE_H * (1 - g.lift);
          if (h1 < 0.004) continue;
          const [cf, cr] = cellCenterFR(i, j);
          const b0 = baseAt(i, j);
          out.push({ id: `gate${i}_${j}`, cf, cr, yaw: o.th, half: CELL * 0.48, h0: b0, h1: b0 + h1 });
        }
      }
      return out;
    }
    // raised ground: a column per cell (climbed, stood on like a cube); a
    // raised ghost bridge, a thin slab, there only while lit
    function platSolids() {
      const out = [];
      const o = G.O;
      for (let i = 0; i < o.H; i++) {
        for (let j = 0; j < o.W; j++) {
          const h = baseAt(i, j);
          if (!h || isWater(o.rows[i][j])) continue;
          const bridge = o.rows[i][j] === "~";
          if (bridge && !lit(i, j)) continue;
          const [cf, cr] = cellCenterFR(i, j);
          out.push({ id: `plat${i}_${j}`, cf, cr, yaw: o.th, half: CELL * 0.5, h0: bridge ? h - SLAB : 0, h1: h });
        }
      }
      return out;
    }

    // -- the knight: hazards, falls, the portal --------------------------------------------------------------------------
    function hurt(why) {
      if (G.inv > 0 || G.phase !== "play") return;
      G.hearts = Math.max(0, G.hearts - 1);
      G.hurts++;
      G.inv = INV_S;
      G.hurtT = 0.35;
      G.flash = { color: "rgba(255,40,20,0.28)", t: 0 };
      if (G.hearts <= 0) return lose(why);
      // thrown back onto the last safe ground (a knight standing still in a
      // fire would otherwise burn through every heart)
      respawn();
      sfx("pain");
      say(why, "#ff9080");
    }
    function lose(why) {
      G.phase = "lost";
      G.t = 0;
      G.lostWhy = why;
      sfx("lose");
    }
    function startFall() {
      G.fallT = 0.001;
      G.fellInWater = waterAt(hero.f, hero.r);
      hero.vf *= 0.3;
      hero.vr *= 0.3;
      sfx("die");
    }
    function respawn() {
      let spot = G.safe;
      if (!spot || !floorAt(spot.f, spot.r)) spot = G.start;
      api.placeHero(spot.f, spot.r, hero.yaw);
      G.inv = Math.max(G.inv, 0.8);
    }
    function updateKnight(dt) {
      G.inv = Math.max(0, G.inv - dt);
      G.hurtT = Math.max(0, G.hurtT - dt);
      if (G.fallT > 0) {
        G.fallT += dt;
        hero.z -= dt * (0.05 + G.fallT * 0.25);
        if (G.fallT >= FALL_S) {
          G.fallT = 0;
          G.falls++;
          G.hearts = Math.max(0, G.hearts - 1);
          if (G.hearts <= 0) {
            respawn();
            return lose(G.fellInWater ? "The explorer fell into the river" : "The explorer fell into the chasm");
          }
          respawn();
          say(G.fellInWater ? "Splash! Into the river -- back to the shore" : "Into the chasm! Back to firm ground", "#ff9080");
        }
        return;
      }
      // (hanging on / climbing a ledge, on a cube, in the air: safe)
      const gc = groundCell();
      if (!gc) return;
      const [i, j] = gc;
      const raised = hero.standOn !== null; // (on raised ground: no chasm under her feet)
      const fl = raised ? tileAt(i, j) : floorAt(hero.f, hero.r);
      if (!fl) return startFall();
      const ch = fl === "island" ? "#" : tileAt(i, j);
      if ((ch === "F" || ch === "f") && fireOn(ch, i, j) && hero.z - baseAt(i, j) < FIRE_H) hurt("Burned! Put the fire out with the Rain stone");
      else if ((ch === "^" || ch === "v") && spikesUp(ch, i, j)) hurt("Spikes! The Earth stone sinks them");
      else if (ch === "E" && G.portalOpen) win();
      else if (ch !== "F" && ch !== "f" && ch !== "^" && ch !== "v" && ch !== "A" && ch !== "B") G.safe = { f: hero.f, r: hero.r };
    }

    // -- the River's ship -----------------------------------------------------------------------------------------------
    // It sails toward the Helm stone while the stone stands in the water (its
    // top is the water's level), and stays put when the stone is on the shore
    // or out of sight. Its hull keeps to the water.
    const berths = () => {
      const out = [];
      G.O.rows.forEach((row, i) => [...row].forEach((ch, j) => ch === "h" && out.push([i, j])));
      return out;
    };
    function resetShip() {
      G.ship = null;
      if (G.lv.helm === undefined) return;
      // at the berth nearest the start
      let best = null;
      berths().forEach(([i, j]) => {
        const [f, r] = cellCenterFR(i, j);
        const d = Math.hypot(f - G.start.f, r - G.start.r);
        if (!best || d < best.d) best = { d, f, r };
      });
      if (!best) return;
      G.ship = { f: best.f, r: best.r, yaw: G.O.th + Math.PI / 2, tf: best.f, tr: best.r, aboard: false, berth: null, target: false };
      shipBerth();
    }
    // the hull's points that must all be over water
    function hullFits(f, r, yaw) {
      const c = Math.cos(yaw);
      const sn = Math.sin(yaw);
      for (const [x, y] of [[0, 0], [SHIP_L * 0.75, 0], [-SHIP_L * 0.75, 0], [0, SHIP_B * 0.8], [0, -SHIP_B * 0.8]]) {
        if (!waterAt(f + x * c - y * sn, r + x * sn + y * c)) return false;
      }
      return true;
    }
    function shipBerth() {
      const sh = G.ship;
      sh.berth = null;
      const [ci, cj] = cellAt(sh.f, sh.r);
      berths().forEach(([i, j]) => {
        if (Math.hypot(ci - i, cj - j) <= DOCK) sh.berth = [i, j];
      });
    }
    // the pier next to a berth (where the explorer goes ashore)
    function pierOf([i, j]) {
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (tileAt(i + di, j + dj) === "H") return [i + di, j + dj];
      return null;
    }
    function updateShip(dt) {
      const sh = G.ship;
      if (!sh) return;
      const helm = stone(G.lv.helm);
      sh.target = false;
      if (helm && isWater(tileAt(Math.round(helm.i), Math.round(helm.j)))) {
        sh.tf = helm.b.cf;
        sh.tr = helm.b.cr;
        sh.target = true;
      } else {
        sh.tf = sh.f; // (on the shore or out of sight: it stays)
        sh.tr = sh.r;
      }
      const df = sh.tf - sh.f;
      const dr = sh.tr - sh.r;
      const d = Math.hypot(df, dr);
      if (d > 0.003) {
        const v = Math.min(SHIP_V, d / 0.4);
        const want = Math.atan2(dr, df);
        // a ship has two ends: turn whichever is nearer toward the way it goes
        let turn = wrap(want - sh.yaw);
        if (Math.abs(turn) > Math.PI / 2) turn = wrap(turn + Math.PI);
        const yaw = sh.yaw + clamp(turn, -SHIP_TURN * dt, SHIP_TURN * dt);
        if (hullFits(sh.f, sh.r, yaw)) sh.yaw = yaw;
        const sf = (df / d) * v * dt;
        const sr = (dr / d) * v * dt;
        // straight on, or sliding along the shore
        for (const [mf, mr] of [[sf, sr], [sf, 0], [0, sr]]) {
          if ((mf || mr) && hullFits(sh.f + mf, sh.r + mr, sh.yaw)) {
            sh.f += mf;
            sh.r += mr;
            break;
          }
        }
      }
      shipBerth();
      if (sh.aboard) {
        // the explorer stands on the deck, a little aft, facing the bow
        const c = Math.cos(sh.yaw);
        const sn = Math.sin(sh.yaw);
        Object.assign(hero, { f: sh.f - 0.01 * c, r: sh.r - 0.01 * sn, z: RISE + SHIP_DECK, yaw: sh.yaw, vf: 0, vr: 0, vz: 0, onGround: true, standOn: null, mode: "move" });
        G.safe = null;
      }
    }
    // Fire / A on the River: board, or go ashore
    function canBoard() {
      const sh = G.ship;
      if (!sh || sh.aboard || !sh.berth || G.fallT > 0 || !groundCell()) return false;
      const [bf, br] = cellCenterFR(...sh.berth);
      return Math.hypot(hero.f - bf, hero.r - br) <= 1.7 * CELL;
    }
    function boardOrLeave() {
      const sh = G.ship;
      if (!sh || G.phase !== "play") return false;
      if (sh.aboard) {
        const pier = sh.berth && pierOf(sh.berth);
        if (!pier) {
          say("Steer to a harbour to go ashore", "#9fe3ff");
          sfx("beep");
          return true;
        }
        sh.aboard = false;
        const [pf, pr] = cellCenterFR(...pier);
        api.placeHero(pf, pr, sh.yaw);
        G.safe = { f: pf, r: pr };
        sfx("click");
        return true;
      }
      if (!canBoard()) return false;
      sh.aboard = true;
      say("On board! Set the Helm stone (cube 4) down in the river to steer", "#9fe3ff");
      sfx("click");
      return true;
    }

    // -- levels ------------------------------------------------------------------------------------------------------------
    function loadLevel(k) {
      const lv = LEVELS[k];
      G.idx = k;
      G.lv = lv;
      G.phase = "play";
      G.t = 0;
      G.levelTime = 0;
      G.hearts = maxHearts;
      G.falls = G.hurts = 0;
      G.fallT = 0;
      G.inv = 0;
      G.hint = false;
      G.portalOpen = false;
      // the map in front of the robot, from where it stands now
      const ch = api.chassis();
      G.O = { f: ch.f, r: ch.r, th: ch.th, rows: lv.map, H: lv.map.length, W: Math.max(...lv.map.map((s) => s.length)) };
      G.O.rows = lv.map.map((s) => s.padEnd(G.O.W, "."));
      G.O.base = G.O.rows.map((row, i) => [...row].map((c, j) => clamp(+((lv.rise && lv.rise[i] && lv.rise[i][j]) || (lv.riseAll && c !== "." ? lv.riseAll : 0)) || 0, 0, 9) * RISE));
      G.O.hasKey = G.O.rows.some((row) => row.includes("K"));
      G.portalOpen = !G.O.hasKey;
      G.gates = {};
      lv.map.join("").replace(/[AB]/g, (c) => (G.gates[c] = { open: false, lift: 0 }));
      let si = G.O.H - 1;
      let sj = 0;
      G.O.rows.forEach((row, i) => {
        const j = row.indexOf("S");
        if (j >= 0) [si, sj] = [i, j];
      });
      const [sf, sr] = cellCenterFR(si, sj);
      G.start = { f: sf, r: sr };
      G.safe = null;
      api.placeHero(sf, sr, G.O.th);
      api.recenter();
      resetShip();
      findStones();
      say(`Level ${k + 1}: ${lv.name}`, "#ffe080");
      sfx("go");
    }
    function win() {
      if (G.phase !== "play") return;
      G.phase = "won";
      G.t = 0;
      G.done.add(G.lv.id);
      store.set([...G.done]);
      sfx("levelup");
    }
    function startSelected(state) {
      if (state === "title") api.startPlay();
      loadLevel(G.sel);
    }
    function retry() {
      // the same level, the same stones: the knight back at the start
      G.phase = "play";
      G.hearts = maxHearts;
      G.fallT = 0;
      G.inv = 0;
      G.safe = null;
      api.placeHero(G.start.f, G.start.r, G.O.th);
      api.recenter();
      resetShip();
      sfx("go");
    }
    function nextLevel() {
      if (G.idx + 1 < LEVELS.length) {
        G.sel = G.idx + 1;
        loadLevel(G.sel);
      } else {
        G.phase = "menu";
        G.O = null;
        say("Every level done!", "#ffe080");
      }
    }
    function toMenu() {
      G.phase = "menu";
      G.O = null;
    }
    function choose(dir) {
      G.sel = (G.sel + dir + LEVELS.length) % LEVELS.length;
      sfx("click");
    }

    // -- drawing: flat and batched, cheap on an old phone -----------------------------------------------------------
    // The floor goes through the calibrated lens (world3d's lens option),
    // which gives nothing for points past the lens's edge: a long polygon
    // reaching out there loses corners and turns into a wedge. So the floor
    // is drawn cell by cell -- a cell that doesn't project whole, or is big
    // on the screen (near the camera: the lens's curve shows), is split in
    // four (twice at most) -- and the cells of one look go into one path,
    // filled once.
    const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
    const V = {
      add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
      mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
    };
    // a quad of cells (rows i0..i1, columns j0..j1, inclusive) on the floor at
    // height h, shrunk by `inset` cells each side (negative: grown)
    function cellQuad(i0, j0, i1, j1, h = 0, inset = 0) {
      const [u0, v0] = [MAP_AHEAD_M + (G.O.H - 1 - i1 + inset) * CELL, (j0 - (G.O.W - 1) / 2 - 0.5 + inset) * CELL];
      const [u1, v1] = [MAP_AHEAD_M + (G.O.H - i0 - inset) * CELL, (j1 - (G.O.W - 1) / 2 + 0.5 - inset) * CELL];
      return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => [...toFR(u, v), h]);
    }
    function offView(s, m) {
      const v = ar.view;
      return s.every((p) => p.x < v.x - m) || s.every((p) => p.x > v.x + v.w + m) || s.every((p) => p.y < v.y - m) || s.every((p) => p.y > v.y + v.h + m);
    }
    // a floor quad (4 points [f, r, h]) into `path` (a list of screen quads)
    function addQuad(path, pts, depth = 0) {
      let s = [];
      for (const p of pts) {
        const q = w.project(p[0], p[1], p[2]);
        if (!q) {
          s = null;
          break;
        }
        s.push(q);
      }
      if (s) {
        if (offView(s, 4)) return;
        const size = Math.max(Math.abs(s[0].x - s[2].x), Math.abs(s[0].y - s[2].y), Math.abs(s[1].x - s[3].x), Math.abs(s[1].y - s[3].y));
        if (size < 110 || depth >= 2) {
          path.push(s);
          return;
        }
      } else if (depth >= 2) return;
      const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
      const [a, b, c, d] = pts;
      const ab = mid(a, b);
      const bc = mid(b, c);
      const cd = mid(c, d);
      const da = mid(d, a);
      const m = mid(a, c);
      addQuad(path, [a, ab, m, da], depth + 1);
      addQuad(path, [ab, b, bc, m], depth + 1);
      addQuad(path, [m, bc, c, cd], depth + 1);
      addQuad(path, [da, m, cd, d], depth + 1);
    }
    // a turned square (a stone's frame: half-size in m) in n x n pieces
    function addSquare(path, b, half, n = 4) {
      for (let a = 0; a < n; a++) {
        for (let c = 0; c < n; c++) {
          const u0 = -half + (2 * half * a) / n;
          const u1 = -half + (2 * half * (a + 1)) / n;
          const v0 = -half + (2 * half * c) / n;
          const v1 = -half + (2 * half * (c + 1)) / n;
          addQuad(path, [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => [...api.fromB(b, u, v), 0]));
        }
      }
    }
    function fillPath(path, fill, stroke, width = 1) {
      if (!path.length) return;
      const g = ar.ctx;
      g.beginPath();
      for (const s of path) {
        g.moveTo(s[0].x, s[0].y);
        for (let k = 1; k < s.length; k++) g.lineTo(s[k].x, s[k].y);
        g.closePath();
      }
      if (fill) {
        g.fillStyle = fill;
        g.fill();
      }
      if (stroke) {
        g.strokeStyle = stroke;
        g.lineWidth = width;
        g.stroke();
      }
    }
    // a small floor shape (a socket, a portal ring): all of it or nothing
    function poly(pts, fill, stroke, width = 1) {
      const s = [];
      for (const p of pts) {
        const q = w.project(p[0], p[1], p[2]);
        if (!q) return;
        s.push(q);
      }
      fillPath([s], fill, stroke, width);
    }
    function ring(f, r, rad, h, n = 20) {
      const pts = [];
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        pts.push([f + Math.cos(a) * rad, r + Math.sin(a) * rad, h]);
      }
      return pts;
    }
    // a circle on the floor, outlined (line3 breaks where it leaves the lens)
    function ringLine(f, r, rad, color, width, dash) {
      const pts = ring(f, r, rad, 0, 28);
      pts.push(pts[0]);
      const g = ar.ctx;
      if (dash) g.setLineDash(dash);
      w.line3(pts, color, width, 0.02);
      if (dash) g.setLineDash([]);
    }
    // a disc on the floor, filled: a fan of small pieces (only those that project)
    function addDisc(path, f, r, rad, n = 16) {
      for (let k = 0; k < n; k++) {
        const a0 = (k / n) * Math.PI * 2;
        const a1 = ((k + 1) / n) * Math.PI * 2;
        const p = (a, s) => [f + Math.cos(a) * rad * s, r + Math.sin(a) * rad * s, 0];
        addQuad(path, [p(a0, 0.5), p(a0, 1), p(a1, 1), p(a1, 0.5)]);
        addQuad(path, [[f, r, 0], p(a0, 0.5), p((a0 + a1) / 2, 0.5), p(a1, 0.5)]);
      }
    }

    const PAD = 2; // chasm drawn this many cells round the map (it's all chasm out there)
    const LOOK = {
      chasm: "rgba(6,5,18,0.84)",
      path: "rgba(226,198,138,0.66)", // the walkable stones
      grout: "rgba(70,48,22,0.8)",
      bridge: "rgba(150,235,255,0.5)",
      bridgeLine: "rgba(225,252,255,0.95)",
      ghost: "rgba(150,230,255,0.5)",
      fire: "rgba(210,60,20,0.5)",
      doused: "rgba(70,85,110,0.5)",
      spikes: "rgba(80,80,92,0.55)",
      sand: "rgba(236,208,140,0.92)",
      grass: "rgba(104,170,64,0.92)",
    };
    const walkTile = (ch) => "#SKEabABFf^vH".indexOf(ch) >= 0;
    const WATER = { top: "rgba(40,120,200,0.78)", side: "rgba(24,80,150,0.85)", ripple: "rgba(200,235,255,0.55)", berth: "rgba(255,255,255,0.85)" };

    // little waves drifting over the river, and the harbours' berths
    function drawRipples() {
      const o = G.O;
      const t = G.time;
      for (let i = 0; i < o.H; i++) {
        for (let j = 0; j < o.W; j++) {
          const ch = o.rows[i][j];
          if (!isWater(ch)) continue;
          const h = baseAt(i, j) + 0.0005;
          const [u, v] = cellUV(i, j);
          if (ch === "h") {
            const [cf, cr] = cellCenterFR(i, j);
            const pts = ring(cf, cr, CELL * 0.48, h, 24);
            pts.push(pts[0]);
            ar.ctx.setLineDash([5, 4]);
            w.line3(pts, WATER.berth, 2, 0.02);
            ar.ctx.setLineDash([]);
          }
          if ((i + j) % 2) continue;
          const k = (t * 0.25 + (i * 0.37 + j * 0.61)) % 1;
          const du = (k - 0.5) * CELL * 0.8;
          const a = toFR(u + du, v - CELL * 0.22);
          const b = toFR(u + du + CELL * 0.06, v);
          const c = toFR(u + du, v + CELL * 0.22);
          w.line3([[...a, h], [...b, h], [...c, h]], `rgba(200,235,255,${(0.55 * Math.sin(k * Math.PI)).toFixed(2)})`, 1.5, 0.01);
        }
      }
    }
    // the Helm stone: where the ship sails to (on the cube's top), or why it won't
    function drawHelmMark(s) {
      const b = s.b;
      const ok = !!G.ship && G.ship.target;
      const pts = ring(b.cf, b.cr, b.half * 1.5, b.h1 + 0.001, 24);
      pts.push(pts[0]);
      w.line3(pts, ok ? rgba(HELM.color, 0.95) : "rgba(255,120,90,0.9)", 2.5, 0.02);
      if (ok && Math.hypot(G.ship.f - b.cf, G.ship.r - b.cr) > 0.01) {
        ar.ctx.setLineDash([6, 5]);
        w.line3([[G.ship.f, G.ship.r, RISE + 0.001], [b.cf, b.cr, b.h1 + 0.001]], rgba(HELM.color, 0.8), 2, 0.01);
        ar.ctx.setLineDash([]);
      }
    }

    function drawFloor() {
      if (!G.O || G.phase === "menu") return;
      const o = G.O;
      const t = G.time;
      const chasm = [];
      const path = [];
      const bridges = [];
      const ghosts = [];
      const fires = [];
      const wet = [];
      const spikes = [];
      const water = [];
      const waterSide = [];
      const cam = w.camLocal();
      for (let i = -PAD; i < o.H + PAD; i++) {
        for (let j = -PAD; j < o.W + PAD; j++) {
          const ch = tileAt(i, j);
          if (isWater(ch)) {
            // the river: its surface up at the shores' height, its sides down to the floor where it meets the chasm
            const h = baseAt(i, j);
            addQuad(water, cellQuad(i, j, i, j, h, -0.02));
            const top = cellQuad(i, j, i, j, h);
            const nb = [[0, -1], [-1, 0], [0, 1], [1, 0]];
            const [cf, cr] = cellCenterFR(i, j);
            for (let k = 0; k < 4; k++) {
              if (tileAt(i + nb[k][0], j + nb[k][1]) !== ".") continue;
              const a = top[k];
              const b = top[(k + 1) % 4];
              const mf = (a[0] + b[0]) / 2;
              const mr = (a[1] + b[1]) / 2;
              if ((cam.f - mf) * (mf - cf) + (cam.r - mr) * (mr - cr) <= 0) continue;
              addQuad(waterSide, [[a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], h], [a[0], a[1], h]]);
            }
            continue;
          }
          if (baseAt(i, j)) {
            // raised: drawn standing (queued); under a raised bridge, the chasm
            if (ch === "~") addQuad(chasm, cellQuad(i, j, i, j, 0, -0.02));
            continue;
          }
          if (ch === "." || (ch === "~" && !lit(i, j))) {
            addQuad(chasm, cellQuad(i, j, i, j, 0, -0.02)); // (a hair bigger: no seams)
            if (ch === "~") addQuad(ghosts, cellQuad(i, j, i, j, 0, 0.08));
            continue;
          }
          if (ch === "~") {
            addQuad(bridges, cellQuad(i, j, i, j, 0, 0.05));
            continue;
          }
          if (!walkTile(ch)) continue;
          addQuad(path, cellQuad(i, j, i, j, 0, 0.05));
          if (ch === "F" || ch === "f") addQuad(doused(i, j) ? wet : fires, cellQuad(i, j, i, j, 0, 0.12));
          else if (ch === "^" || ch === "v") addQuad(spikes, cellQuad(i, j, i, j, 0, 0.12));
        }
      }
      fillPath(chasm, LOOK.chasm, null);
      fillPath(waterSide, WATER.side, null);
      fillPath(water, WATER.top, null);
      if (water.length) drawRipples();
      fillPath(path, LOOK.path, LOOK.grout, 1.2);
      fillPath(bridges, LOOK.bridge, LOOK.bridgeLine, 1.5);
      const g = ar.ctx;
      g.setLineDash([4, 4]);
      fillPath(ghosts, null, LOOK.ghost, 1);
      g.setLineDash([]);
      fillPath(fires, LOOK.fire, null);
      fillPath(wet, LOOK.doused, null);
      fillPath(spikes, LOOK.spikes, null);

      // the special cells (on raised ground: drawn with its top)
      for (let i = 0; i < o.H; i++) for (let j = 0; j < o.W; j++) if (!baseAt(i, j)) cellMark(i, j, 0);

      // the stones' reach
      G.stones.forEach((s, tag) => {
        if (!s) return;
        if (G.lv.helm === tag) return drawHelmMark(s);
        const st = STONES[tag];
        const { cf, cr } = s.b;
        if (tag === 0) {
          // the island: a sandy beach round a grassy middle
          const sand = [];
          const grass = [];
          addSquare(sand, s.b, ISLAND_HALF * CELL, 4);
          addSquare(grass, s.b, ISLAND_HALF * CELL * 0.7, 3);
          fillPath(sand, LOOK.sand, null);
          fillPath(grass, LOOK.grass, null);
          const h = ISLAND_HALF * CELL;
          const edge = [[h, h], [h, -h], [-h, -h], [-h, h], [h, h]].map(([u, v]) => [...api.fromB(s.b, u, v), 0]);
          w.line3(edge, "rgba(120,90,40,0.95)", 2, 0.02);
        } else if (tag === 2) {
          const wetDisc = [];
          addDisc(wetDisc, cf, cr, REACH * CELL);
          fillPath(wetDisc, "rgba(80,140,255,0.16)", null);
          ringLine(cf, cr, REACH * CELL, rgba(st.color, 0.8), 1.5, [6, 4]);
        } else if (tag === 3) {
          // the lantern's light: a yellow disc and the cone from the lantern down to it
          const disc = [];
          addDisc(disc, cf, cr, REACH * CELL);
          fillPath(disc, `rgba(255,214,90,${0.24 + 0.04 * Math.sin(t * 3)})`, null);
          ringLine(cf, cr, REACH * CELL, "rgba(255,214,90,0.85)", 1.5);
          drawLightCone(s.b);
        } else if (tag === 5) {
          ringLine(cf, cr, REACH * CELL, rgba(st.color, 0.85), 2, [3, 3]);
        } else ringLine(cf, cr, s.b.half * 1.5, rgba(st.color, 0.9), 2);
      });
    }

    // a plate, the Key's socket, the portal, the start: on the cell's ground at height h
    function cellMark(i, j, h) {
      const ch = G.O.rows[i][j];
      if ("abKES".indexOf(ch) < 0) return;
      const [cf, cr] = cellCenterFR(i, j);
      if (ch === "a" || ch === "b") {
        const down = G.gates[ch.toUpperCase()] && G.gates[ch.toUpperCase()].open;
        poly(cellQuad(i, j, i, j, h, 0.2), down ? "rgba(70,150,70,0.85)" : "rgba(190,140,50,0.9)", "rgba(40,30,10,0.9)", 2);
      } else if (ch === "K") {
        poly(ring(cf, cr, CELL * 0.42, h, 4), G.portalOpen ? "rgba(240,200,60,0.55)" : "rgba(240,200,60,0.2)", "rgba(240,200,60,0.95)", 2);
      } else if (ch === "E") {
        poly(ring(cf, cr, CELL * 0.45, h, 16), G.portalOpen ? `rgba(190,110,255,${0.45 + 0.15 * Math.sin(G.time * 5)})` : "rgba(120,110,140,0.45)", G.portalOpen ? "rgba(230,190,255,0.95)" : "rgba(160,150,180,0.8)", 2);
      } else if (ch === "S") {
        poly(ring(cf, cr, CELL * 0.35, h, 12), null, "rgba(255,255,255,0.6)", 1);
      }
    }

    // -- raised ground: a stone column per cell, its sides in 4 cm courses (a
    // cube's height: so the eye can count them), queued with its box so the
    // explorer and the real cubes go in front / behind right ----------------------------------------------------------------
    const RAISED = {
      top: ["rgba(214,184,128,0.97)", "rgba(226,200,146,0.97)", "rgba(238,218,170,0.97)"], // 4, 8, 12+ cm: lighter higher up
      side: "rgba(150,110,62,0.97)",
      sideDark: "rgba(112,80,44,0.97)",
      line: "rgba(60,40,18,0.9)",
    };
    function queueRaised() {
      const o = G.O;
      const cam = w.camLocal();
      for (let i = 0; i < o.H; i++) {
        for (let j = 0; j < o.W; j++) {
          const h = baseAt(i, j);
          if (!h) continue;
          const ch = o.rows[i][j];
          if (isWater(ch)) continue; // (drawn with the floor)
          const bridge = ch === "~";
          const on = !bridge || lit(i, j);
          const h0 = bridge ? h - SLAB : 0;
          const [cf, cr] = cellCenterFR(i, j);
          const top = cellQuad(i, j, i, j, h);
          const z = w.camZ(cf, cr, (h0 + h) / 2);
          if (z < w.near && top.every((p) => w.camZ(...p) < w.near)) continue;
          const fs = top.map((p) => p[0]);
          const rs = top.map((p) => p[1]);
          ar.queue(z, () => {
            if (!on) {
              // an unlit raised bridge: only its ghostly outline, up in the air
              const g = ar.ctx;
              const q = [];
              addQuad(q, cellQuad(i, j, i, j, h, 0.08));
              g.setLineDash([4, 4]);
              fillPath(q, null, LOOK.ghost, 1);
              g.setLineDash([]);
              return;
            }
            // the sides that face the camera, down to the lower neighbour (or the floor)
            const sides = [];
            const dark = [];
            const nb = [[0, -1], [-1, 0], [0, 1], [1, 0]]; // corner k -> k+1: left, far, right, near
            for (let k = 0; k < 4; k++) {
              const a = top[k];
              const b = top[(k + 1) % 4];
              const [ni, nj] = [i + nb[k][0], j + nb[k][1]];
              const nc = tileAt(ni, nj);
              const nh = bridge ? (baseAt(ni, nj) >= h - 1e-6 && (nc !== "~" || lit(ni, nj)) ? h : h0) : nc === "~" ? 0 : isWater(nc) ? Math.min(h, baseAt(ni, nj)) : baseAt(ni, nj);
              if (nh >= h - 1e-6) continue;
              const mf = (a[0] + b[0]) / 2;
              const mr = (a[1] + b[1]) / 2;
              if ((cam.f - mf) * (mf - cf) + (cam.r - mr) * (mr - cr) <= 0) continue; // (faces away)
              const out = k % 2 ? sides : dark;
              for (let lo = nh; lo < h - 1e-6; lo += bridge ? SLAB : RISE) {
                const hi = Math.min(h, lo + (bridge ? SLAB : RISE));
                addQuad(out, [[a[0], a[1], lo], [b[0], b[1], lo], [b[0], b[1], hi], [a[0], a[1], hi]]);
              }
            }
            fillPath(sides, bridge ? LOOK.bridge : RAISED.side, RAISED.line, 1);
            fillPath(dark, bridge ? LOOK.bridge : RAISED.sideDark, RAISED.line, 1);
            if (cam.h <= h) return;
            const tp = [];
            addQuad(tp, top);
            if (bridge) fillPath(tp, LOOK.bridge, LOOK.bridgeLine, 1.5);
            else if (ch === "H") {
              // a harbour's pier: wooden planks
              fillPath(tp, "rgba(150,100,56,0.97)", RAISED.line, 1.2);
              for (let k = 1; k < 4; k++) {
                const q = cellQuad(i, j, i, j, h + 0.0005);
                const lerp2 = (a, b, x) => [a[0] + (b[0] - a[0]) * x, a[1] + (b[1] - a[1]) * x, a[2]];
                w.line3([lerp2(q[0], q[1], k / 4), lerp2(q[3], q[2], k / 4)], "rgba(70,44,20,0.85)", 1.2, 0.01);
              }
            } else fillPath(tp, RAISED.top[clamp(Math.round(h / RISE) - 1, 0, 2)], RAISED.line, 1.2);
            const inner = [];
            if (ch === "F" || ch === "f") addQuad(inner, cellQuad(i, j, i, j, h, 0.12));
            else if (ch === "^" || ch === "v") addQuad(inner, cellQuad(i, j, i, j, h, 0.12));
            if (inner.length) fillPath(inner, ch === "^" || ch === "v" ? LOOK.spikes : doused(i, j) ? LOOK.doused : LOOK.fire, null);
            cellMark(i, j, h);
          }, w.extent(Math.min(...fs), Math.max(...fs), Math.min(...rs), Math.max(...rs), h0, h, top));
        }
      }
    }

    // -- the stones' looks -------------------------------------------------------------------------------------------
    const LANTERN_H = 0.13; // m above the floor
    const CLOUD_H = 0.16;
    function hull(pts) {
      const p = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
      const cr = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
      const lo = [];
      for (const q of p) {
        while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
        lo.push(q);
      }
      const up = [];
      for (let k = p.length - 1; k >= 0; k--) {
        const q = p[k];
        while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
        up.push(q);
      }
      return lo.slice(0, -1).concat(up.slice(0, -1));
    }
    function drawLightCone(b) {
      const top = w.project(b.cf, b.cr, LANTERN_H - 0.01);
      if (!top) return;
      const pts = [top];
      ring(b.cf, b.cr, REACH * CELL, 0, 24).forEach((p) => {
        const q = w.project(...p);
        if (q) pts.push(q);
      });
      if (pts.length < 6) return;
      const hp = hull(pts);
      const g = ar.ctx;
      g.beginPath();
      hp.forEach((q, k) => (k ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
      g.closePath();
      g.fillStyle = "rgba(255,225,120,0.13)";
      g.fill();
    }
    // a lantern hanging in the air above the stone
    function queueLantern(b) {
      const p = w.project(b.cf, b.cr, LANTERN_H);
      if (!p) return;
      ar.queue(p.depth, () => {
        const g = ar.ctx;
        const s = Math.max(6, p.ppm * 0.022); // half its height, px
        const glow = 0.85 + 0.15 * Math.sin(G.time * 7);
        const halo = g.createRadialGradient(p.x, p.y, s * 0.2, p.x, p.y, s * 2.6);
        halo.addColorStop(0, `rgba(255,230,120,${0.55 * glow})`);
        halo.addColorStop(1, "rgba(255,230,120,0)");
        g.fillStyle = halo;
        g.beginPath();
        g.arc(p.x, p.y, s * 2.6, 0, Math.PI * 2);
        g.fill();
        g.lineJoin = "round";
        g.strokeStyle = "#1c1a18";
        g.lineWidth = Math.max(1.5, s * 0.14);
        // the handle
        g.beginPath();
        g.arc(p.x, p.y - s * 1.05, s * 0.32, Math.PI, 0);
        g.stroke();
        // the cap and the base
        g.fillStyle = "#3a2c1e";
        g.beginPath();
        g.moveTo(p.x - s * 0.62, p.y - s * 0.62);
        g.lineTo(p.x - s * 0.3, p.y - s * 1.0);
        g.lineTo(p.x + s * 0.3, p.y - s * 1.0);
        g.lineTo(p.x + s * 0.62, p.y - s * 0.62);
        g.closePath();
        g.fill();
        g.stroke();
        g.fillRect(p.x - s * 0.62, p.y + s * 0.62, s * 1.24, s * 0.26);
        g.strokeRect(p.x - s * 0.62, p.y + s * 0.62, s * 1.24, s * 0.26);
        // the glass, glowing
        g.fillStyle = `rgba(255,${Math.round(200 + 40 * glow)},90,1)`;
        g.beginPath();
        g.rect(p.x - s * 0.5, p.y - s * 0.62, s, s * 1.24);
        g.fill();
        g.stroke();
        // the frame's bars and the flame
        g.lineWidth = Math.max(1, s * 0.08);
        g.beginPath();
        g.moveTo(p.x, p.y - s * 0.62);
        g.lineTo(p.x, p.y + s * 0.62);
        g.stroke();
        g.fillStyle = "rgba(255,255,230,0.95)";
        g.beginPath();
        g.ellipse(p.x, p.y + s * 0.1, s * 0.16, s * 0.3, 0, 0, Math.PI * 2);
        g.fill();
      });
    }
    // a rain cloud above the stone, and its rain falling on the reach
    const DROPS = Array.from({ length: 22 }, (_, k) => {
      const a = k * 2.39996; // (golden angle: spread evenly over the disc)
      const rr = Math.sqrt((k + 0.5) / 22);
      return { u: Math.cos(a) * rr, v: Math.sin(a) * rr, ph: (k * 0.618) % 1 };
    });
    function queueRain(b) {
      const c = w.project(b.cf, b.cr, CLOUD_H);
      const mid = w.camZ(b.cf, b.cr, CLOUD_H / 2);
      if (mid < w.near) return;
      ar.queue(mid, () => {
        const g = ar.ctx;
        const R = REACH * CELL * 0.9;
        // the drops: short blue streaks, falling from the cloud to the floor
        g.strokeStyle = "rgba(80,150,255,0.9)";
        g.lineWidth = 1.6;
        g.lineCap = "round";
        g.beginPath();
        for (const d of DROPS) {
          const f = b.cf + d.u * R;
          const r = b.cr + d.v * R;
          const k = (G.time * 1.8 + d.ph) % 1;
          const h = CLOUD_H * 0.92 * (1 - k);
          const a = w.project(f, r, h + 0.014);
          const z = w.project(f, r, h);
          if (!a || !z) continue;
          g.moveTo(a.x, a.y);
          g.lineTo(z.x, z.y);
        }
        g.stroke();
        if (!c) return;
        // the cloud: cartoon puffs, a grey underside
        const s = Math.max(10, c.ppm * REACH * CELL * 0.5);
        const puffs = [[-0.55, 0.05, 0.42], [-0.2, -0.22, 0.5], [0.25, -0.18, 0.48], [0.6, 0.06, 0.38], [0.02, 0.1, 0.45]];
        const draw = (color, dy, grow) => {
          g.fillStyle = color;
          g.beginPath();
          for (const [x, y, r] of puffs) {
            g.moveTo(c.x + x * s + r * s * grow, c.y + y * s + dy);
            g.arc(c.x + x * s, c.y + y * s + dy, r * s * grow, 0, Math.PI * 2);
          }
          g.fill();
        };
        draw("rgba(40,48,64,0.9)", 0, 1.08); // outline
        draw("rgba(150,162,185,1)", s * 0.08, 1);
        draw("rgba(236,241,250,1)", -s * 0.04, 0.9);
      });
    }
    // the Weight stone: a cartoon weight in place of the cube
    function weightOver(b) {
      const cs = [];
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const [f, r] = api.fromB(b, u * b.half, v * b.half);
        for (const h of [b.h0, b.h1]) {
          const q = w.project(f, r, h);
          if (!q) return;
          cs.push(q);
        }
      }
      const x0 = Math.min(...cs.map((q) => q.x));
      const x1 = Math.max(...cs.map((q) => q.x));
      const y0 = Math.min(...cs.map((q) => q.y));
      const y1 = Math.max(...cs.map((q) => q.y));
      const wd = x1 - x0;
      const ht = y1 - y0;
      const cx = (x0 + x1) / 2;
      const g = ar.ctx;
      const top = y0 + ht * 0.2;
      g.save();
      g.lineJoin = "round";
      g.lineWidth = Math.max(2, wd * 0.05);
      // the handle (a ring on top)
      g.strokeStyle = "#151518";
      g.lineWidth = Math.max(3, wd * 0.11);
      g.beginPath();
      g.ellipse(cx, top, wd * 0.2, ht * 0.17, 0, Math.PI, 0);
      g.stroke();
      // the body: a trapezoid, rounded
      g.beginPath();
      g.moveTo(x0 + wd * 0.2, top);
      g.lineTo(x1 - wd * 0.2, top);
      g.quadraticCurveTo(x1 - wd * 0.12, top, x1 - wd * 0.1, top + ht * 0.08);
      g.lineTo(x1, y1 - ht * 0.06);
      g.quadraticCurveTo(x1, y1, x1 - wd * 0.06, y1);
      g.lineTo(x0 + wd * 0.06, y1);
      g.quadraticCurveTo(x0, y1, x0, y1 - ht * 0.06);
      g.lineTo(x0 + wd * 0.1, top + ht * 0.08);
      g.quadraticCurveTo(x0 + wd * 0.12, top, x0 + wd * 0.2, top);
      g.closePath();
      g.fillStyle = "#1e1e24";
      g.fill();
      g.strokeStyle = "#050507";
      g.lineWidth = Math.max(1.5, wd * 0.03);
      g.stroke();
      // a shine down the left side
      g.strokeStyle = "rgba(255,255,255,0.18)";
      g.lineWidth = Math.max(2, wd * 0.06);
      g.beginPath();
      g.moveTo(x0 + wd * 0.2, top + ht * 0.15);
      g.lineTo(x0 + wd * 0.12, y1 - ht * 0.12);
      g.stroke();
      // 100t
      g.fillStyle = "#ffffff";
      g.font = `900 ${Math.max(8, Math.round(wd * 0.3))}px Impact, 'Arial Black', sans-serif`;
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText("100t", cx, top + (y1 - top) * 0.55);
      g.restore();
    }
    // a palm tree on the island, by a corner
    function queuePalm(b) {
      const h = ISLAND_HALF * CELL;
      const [bf, br] = api.fromB(b, h * 0.55, -h * 0.55);
      const [lf, lr] = api.fromB(b, h * 0.75, -h * 0.85); // the way it leans
      const baseZ = w.camZ(bf, br, 0.04);
      if (baseZ < w.near) return;
      ar.queue(baseZ, () => {
        const g = ar.ctx;
        const H = 0.085;
        const pts = [];
        for (let k = 0; k <= 6; k++) {
          const u = k / 6;
          const lean = u * u;
          const q = w.project(bf + (lf - bf) * lean, br + (lr - br) * lean, H * u);
          if (!q) return;
          pts.push(q);
        }
        const tip = pts[pts.length - 1];
        const ppm = tip.ppm;
        g.save();
        g.lineCap = "round";
        g.lineJoin = "round";
        const trunk = (color, wd) => {
          g.strokeStyle = color;
          g.lineWidth = wd;
          g.beginPath();
          pts.forEach((q, k) => (k ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
          g.stroke();
        };
        trunk("rgba(30,20,10,0.9)", Math.max(3, ppm * 0.0075));
        trunk("#8a5a2e", Math.max(2, ppm * 0.0055));
        // the trunk's rings
        g.strokeStyle = "rgba(60,36,14,0.8)";
        g.lineWidth = 1;
        for (let k = 1; k < pts.length - 1; k++) {
          const a = pts[k - 1];
          const c = pts[k + 1];
          const nx = -(c.y - a.y);
          const ny = c.x - a.x;
          const n = Math.hypot(nx, ny) || 1;
          const r = Math.max(1.5, ppm * 0.0028);
          g.beginPath();
          g.moveTo(pts[k].x - (nx / n) * r, pts[k].y - (ny / n) * r);
          g.lineTo(pts[k].x + (nx / n) * r, pts[k].y + (ny / n) * r);
          g.stroke();
        }
        // the fronds: arching out and down, round the top
        const [tf, tr] = [bf + (lf - bf), br + (lr - br)];
        const sway = Math.sin(G.time * 1.3) * 0.004;
        for (let k = 0; k < 6; k++) {
          const a = (k / 6) * Math.PI * 2 + 0.4;
          const rad = 0.034;
          const midP = w.project(tf + Math.cos(a) * rad * 0.5, tr + Math.sin(a) * rad * 0.5 + sway, H + 0.008);
          const endP = w.project(tf + Math.cos(a) * rad, tr + Math.sin(a) * rad + sway, H - 0.016);
          if (!midP || !endP) continue;
          for (const [col, wd] of [["rgba(20,40,10,0.9)", 0.0085], ["#3f9a2e", 0.0062]]) {
            g.strokeStyle = col;
            g.lineWidth = Math.max(2, ppm * wd);
            g.beginPath();
            g.moveTo(tip.x, tip.y);
            g.quadraticCurveTo(midP.x, midP.y, endP.x, endP.y);
            g.stroke();
          }
          g.strokeStyle = "rgba(200,240,140,0.6)";
          g.lineWidth = 1;
          g.beginPath();
          g.moveTo(tip.x, tip.y);
          g.quadraticCurveTo(midP.x, midP.y, endP.x, endP.y);
          g.stroke();
        }
        // coconuts
        g.fillStyle = "#5a3a1c";
        g.strokeStyle = "rgba(20,12,6,0.9)";
        for (const dx of [-1, 1]) {
          g.beginPath();
          g.arc(tip.x + dx * ppm * 0.003, tip.y + ppm * 0.003, Math.max(2, ppm * 0.0028), 0, Math.PI * 2);
          g.fill();
          g.stroke();
        }
        g.restore();
      });
    }

    // a gate: a portcullis of thick iron bars between two posts, sliding up
    // into its beam as it opens
    function queueGate(i, j, gt) {
      const o = G.O;
      // across the way the path runs (the path continues in front and behind)
      const along = walkTile(tileAt(i - 1, j)) || walkTile(tileAt(i + 1, j)) || tileAt(i - 1, j) === "~" || tileAt(i + 1, j) === "~";
      const [u, v] = cellUV(i, j);
      const b0 = baseAt(i, j);
      const P = (s, h) => [...(along ? toFR(u, v + s * CELL) : toFR(u + s * CELL, v)), b0 + h];
      const z = w.camZ(...P(0, GATE_H / 2));
      if (z < w.near) return;
      ar.queue(z, () => {
        const g = ar.ctx;
        const seg = (a, b, color, wM, minPx) => {
          const pa = w.project(...a);
          const pb = w.project(...b);
          if (!pa || !pb) return;
          g.strokeStyle = color;
          g.lineWidth = Math.max(minPx, wM * (pa.ppm + pb.ppm) / 2);
          g.beginPath();
          g.moveTo(pa.x, pa.y);
          g.lineTo(pb.x, pb.y);
          g.stroke();
        };
        g.save();
        g.lineCap = "butt";
        const bottom = GATE_H * gt.lift;
        const topH = GATE_H;
        if (topH - bottom > 0.002) {
          // the grille: bars close enough that nobody gets through
          const n = 7;
          for (let k = 0; k < n; k++) {
            const s = -0.42 + (0.84 * k) / (n - 1);
            seg(P(s, bottom), P(s, topH), "#15171b", 0.0058, 3);
            seg(P(s, bottom), P(s, topH), "#4a505a", 0.0038, 2);
          }
          for (const f of [0.12, 0.45, 0.78]) {
            const h = bottom + (topH - bottom) * f;
            seg(P(-0.46, h), P(0.46, h), "#15171b", 0.005, 3);
            seg(P(-0.46, h), P(0.46, h), "#5a606a", 0.0032, 2);
          }
          // spikes along the bottom edge
          for (let k = 0; k < n; k++) {
            const s = -0.42 + (0.84 * k) / (n - 1);
            seg(P(s, bottom), P(s, Math.max(0, bottom - 0.004)), "#2a2d33", 0.003, 2);
          }
        }
        // the posts and the beam
        for (const s of [-0.5, 0.5]) {
          seg(P(s, 0), P(s, GATE_H + 0.012), "#20160c", 0.011, 4);
          seg(P(s, 0), P(s, GATE_H + 0.012), "#7a5430", 0.008, 3);
        }
        seg(P(-0.56, GATE_H + 0.008), P(0.56, GATE_H + 0.008), "#20160c", 0.012, 4);
        seg(P(-0.56, GATE_H + 0.008), P(0.56, GATE_H + 0.008), "#8a6238", 0.009, 3);
        g.restore();
      });
    }

    // A real cube standing in the river: its sides are under water (the water
    // is a cube's height deep), so they are painted over with the river; its
    // top, at the water's level, stays the real cube.
    function submerged(b) {
      const top = Math.min(b.h1, RISE);
      if (top <= b.h0) return;
      const c = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => api.fromB(b, u * b.half, v * b.half));
      const faces = [];
      for (let k = 0; k < 4; k++) {
        const a = c[k];
        const d = c[(k + 1) % 4];
        addQuad(faces, [[a[0], a[1], b.h0], [d[0], d[1], b.h0], [d[0], d[1], top], [a[0], a[1], top]]);
      }
      // one by one: as one path, a face and the one behind it (wound the other way) would cancel out
      const g = ar.ctx;
      g.save();
      g.globalAlpha = 0.92;
      faces.forEach((q) => fillPath([q], "rgb(40,120,200)", null));
      g.restore();
    }

    // the River's ship: a wooden hull sitting in the water, a deck, a mast with a sail
    const HULL = [[1, 0], [0.72, 0.62], [0.2, 1], [-0.75, 1], [-1, 0.72], [-1, -0.72], [-0.75, -1], [0.2, -1], [0.72, -0.62]];
    function queueShip() {
      const sh = G.ship;
      if (!sh) return;
      const c = Math.cos(sh.yaw);
      const sn = Math.sin(sh.yaw);
      const P = (x, y, h) => [sh.f + x * c - y * sn, sh.r + x * sn + y * c, h];
      const bob = 0.0006 * Math.sin(G.time * 2.3);
      const wl = RISE - 0.003 + bob; // the waterline (the hull's bottom shows a little under the surface)
      const deck = RISE + SHIP_DECK + bob;
      const outer = HULL.map(([x, y]) => P(x * SHIP_L, y * SHIP_B, deck));
      const low = HULL.map(([x, y]) => P(x * SHIP_L * 0.92, y * SHIP_B * 0.8, wl));
      const z = w.camZ(sh.f, sh.r, (wl + deck) / 2);
      if (z < w.near) return;
      const corners = [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([x, y]) => P(x * SHIP_L, y * SHIP_B, deck));
      const fs = corners.map((p) => p[0]);
      const rs = corners.map((p) => p[1]);
      const cam = w.camLocal();
      ar.queue(z, () => {
        // the sides facing the camera
        const sides = [];
        for (let k = 0; k < HULL.length; k++) {
          const a = outer[k];
          const b = outer[(k + 1) % HULL.length];
          const mf = (a[0] + b[0]) / 2;
          const mr = (a[1] + b[1]) / 2;
          if ((cam.f - mf) * (mf - sh.f) + (cam.r - mr) * (mr - sh.r) <= 0) continue;
          addQuad(sides, [low[k], low[(k + 1) % HULL.length], b, a]);
        }
        fillPath(sides, "rgba(110,64,30,0.98)", "rgba(40,22,8,0.95)", 1.2);
        if (cam.h > deck) {
          const top = [];
          for (let k = 0; k < HULL.length; k++) {
            const q = w.project(...outer[k]);
            if (!q) return;
            top.push(q);
          }
          fillPath([top], "rgba(196,150,96,0.98)", "rgba(60,34,12,0.95)", 1.5);
          // the deck's planks
          for (const y of [-0.5, 0, 0.5]) w.line3([P(SHIP_L * 0.62, y * SHIP_B, deck + 0.0003), P(-SHIP_L * 0.9, y * SHIP_B, deck + 0.0003)], "rgba(110,70,34,0.7)", 1, 0.01);
        }
      }, w.extent(Math.min(...fs), Math.max(...fs), Math.min(...rs), Math.max(...rs), wl, deck, corners));
      // the mast and its sail, a queue item of their own (in front of or behind the explorer on deck)
      const mz = w.camZ(...P(SHIP_L * 0.25, 0, deck + 0.03));
      if (mz < w.near) return;
      ar.queue(mz, () => {
        const g = ar.ctx;
        const foot = w.project(...P(SHIP_L * 0.25, 0, deck));
        const head = w.project(...P(SHIP_L * 0.25, 0, deck + 0.065));
        if (!foot || !head) return;
        g.save();
        g.lineCap = "round";
        g.strokeStyle = "#3a2410";
        g.lineWidth = Math.max(2, head.ppm * 0.0026);
        g.beginPath();
        g.moveTo(foot.x, foot.y);
        g.lineTo(head.x, head.y);
        g.stroke();
        // the sail: square, across the ship, bellied a little by the wind
        const sail = [P(SHIP_L * 0.28, -SHIP_B * 1.05, deck + 0.058), P(SHIP_L * 0.28, SHIP_B * 1.05, deck + 0.058), P(SHIP_L * 0.36, SHIP_B * 0.95, deck + 0.02), P(SHIP_L * 0.36, -SHIP_B * 0.95, deck + 0.02)];
        const sp = sail.map((p) => w.project(...p));
        if (sp.every(Boolean)) {
          g.beginPath();
          sp.forEach((q, k) => (k ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
          g.closePath();
          g.fillStyle = "rgba(246,240,224,0.96)";
          g.fill();
          g.strokeStyle = "rgba(90,70,50,0.9)";
          g.lineWidth = 1.2;
          g.stroke();
          // a red stripe across it
          const mid = (a, b, x) => ({ x: a.x + (b.x - a.x) * x, y: a.y + (b.y - a.y) * x });
          g.strokeStyle = "rgba(200,50,40,0.9)";
          g.lineWidth = Math.max(2, head.ppm * 0.003);
          g.beginPath();
          const l = mid(sp[0], sp[3], 0.45);
          const r = mid(sp[1], sp[2], 0.45);
          g.moveTo(l.x, l.y);
          g.lineTo(r.x, r.y);
          g.stroke();
        }
        g.restore();
      });
    }

    // the things that stand up: queued, so the explorer and the cubes go in front / behind right
    function drawStanding() {
      if (!G.O || G.phase === "menu") return;
      const o = G.O;
      const t = G.time;
      const g = ar.ctx;
      queueRaised();
      queueShip();
      G.stones.forEach((s, tag) => {
        if (!s) return;
        if (tag === 0) queuePalm(s.b);
        else if (tag === 2) queueRain(s.b);
        else if (tag === 3) queueLantern(s.b);
      });
      for (let i = 0; i < o.H; i++) {
        for (let j = 0; j < o.W; j++) {
          const ch = o.rows[i][j];
          if ("FfvA^BE".indexOf(ch) < 0) continue;
          if (ch === "A" || ch === "B") {
            queueGate(i, j, G.gates[ch]);
            continue;
          }
          const [cf, cr] = cellCenterFR(i, j);
          const hb = baseAt(i, j); // (on raised ground: on its top)
          const z = w.camZ(cf, cr, hb + 0.02);
          if (z < w.near) continue;
          if ((ch === "F" || ch === "f") && fireOn(ch, i, j)) {
            ar.queue(z, () => {
              for (let k = 0; k < 3; k++) {
                const a = (k / 3) * Math.PI * 2 + t * 0.7;
                const ff = cf + Math.cos(a) * CELL * 0.22;
                const rr = cr + Math.sin(a) * CELL * 0.22;
                const hgt = FIRE_H * (0.7 + 0.3 * Math.sin(t * 11 + k * 2.1 + j));
                const b0 = w.project(ff - CELL * 0.12, rr, hb);
                const b1 = w.project(ff + CELL * 0.12, rr, hb);
                const top = w.project(ff, rr, hb + hgt);
                if (!b0 || !b1 || !top) continue;
                g.beginPath();
                g.moveTo(b0.x, b0.y);
                g.lineTo(top.x, top.y);
                g.lineTo(b1.x, b1.y);
                g.closePath();
                g.fillStyle = k === 1 ? "rgba(255,220,80,0.85)" : "rgba(255,110,20,0.8)";
                g.fill();
              }
            });
          } else if ((ch === "^" || ch === "v") && spikesUp(ch, i, j)) {
            ar.queue(z, () => {
              g.fillStyle = "rgba(200,205,215,0.95)";
              for (const [du, dv] of [[-0.22, -0.22], [-0.22, 0.22], [0.22, -0.22], [0.22, 0.22]]) {
                const ff = cf + du * CELL;
                const rr = cr + dv * CELL;
                const b0 = w.project(ff, rr - CELL * 0.1, hb);
                const b1 = w.project(ff, rr + CELL * 0.1, hb);
                const top = w.project(ff, rr, hb + SPIKE_H);
                if (!b0 || !b1 || !top) continue;
                g.beginPath();
                g.moveTo(b0.x, b0.y);
                g.lineTo(top.x, top.y);
                g.lineTo(b1.x, b1.y);
                g.closePath();
                g.fill();
              }
            });
          } else if (ch === "E" && G.portalOpen) {
            ar.queue(z, () => {
              const pts = [];
              for (let k = 0; k <= 16; k++) {
                const a = (k / 16) * Math.PI * 2;
                const [pf, pr] = toFR(cellUV(i, j)[0], cellUV(i, j)[1] + Math.cos(a) * CELL * 0.4);
                pts.push([pf, pr, hb + CELL * 0.6 + Math.sin(a) * CELL * 0.6]);
              }
              w.line3(pts, `rgba(210,150,255,${0.7 + 0.3 * Math.sin(t * 6)})`, 3, 0.01);
            });
          }
        }
      }
    }

    // -- the explorer: a new character on the knight's skeleton (same cartoon style, no armour, no sword) -------------
    const EXPLORER = {
      outline: "rgba(15,12,10,0.85)", skin: "#eab48e", hair: "#b4502a", tie: "#f2c14e", tunic: "#2a9d8f", skirt: "#1f7f72",
      belt: "#7a4a1e", legs: "#3d3552", boots: "#6b4226", eye: "#1a1410", satchel: "#9a6a34",
    };
    function explorerPrims(J, P) {
      const L = EXPLORER;
      const out = [];
      const seg = (a, b, rad, color) => out.push({ k: "seg", a: P(a), b: P(b), rad, color });
      const ball = (c, rad, color) => out.push({ k: "ball", c: P(c), rad, color });
      const fwd = [Math.cos(J.twist), Math.sin(J.twist), 0];
      const right = [-Math.sin(J.twist), Math.cos(J.twist), 0];
      const back = V.mul(fwd, -1);
      const speed = Math.hypot(hero.vf, hero.vr) / api.S;
      const flow = Math.min(0.006, speed * 0.05);
      for (const s of [-1, 1]) {
        seg(J.hip[s], J.knee[s], 0.0022, L.legs);
        seg(J.knee[s], J.ankle[s], 0.0019, L.legs);
        seg(J.ankle[s], J.toe[s], 0.0019, L.boots);
      }
      // the skirt of the tunic: from the waist to above the knees, flaring
      const waist = V.add(J.pelvis, V.mul(J.up, 0.004));
      const hemC = V.add(V.add(J.pelvis, V.mul(J.up, -0.0085)), V.mul(back, flow * 0.6));
      out.push({
        k: "poly",
        pts: [P(V.add(waist, V.mul(right, -0.0052))), P(V.add(waist, V.mul(right, 0.0052))), P(V.add(hemC, V.mul(right, 0.0095))), P(V.add(hemC, V.mul(right, -0.0095)))],
        color: L.skirt,
        lines: [[P(V.add(waist, V.mul(right, -0.0015))), P(V.add(hemC, V.mul(right, -0.0024)))], [P(V.add(waist, V.mul(right, 0.0015))), P(V.add(hemC, V.mul(right, 0.0024)))]],
        lineColor: "rgba(0,40,36,0.5)",
      });
      seg(V.add(J.pelvis, V.mul(J.up, 0.003)), J.chest, 0.0045, L.tunic);
      seg(V.add(J.pelvis, V.mul(J.up, 0.0035)), V.add(J.pelvis, V.mul(J.up, 0.0055)), 0.0049, L.belt);
      ball(V.add(V.add(J.pelvis, V.mul(right, 0.0058)), V.mul(J.up, 0.001)), 0.0024, L.satchel); // a satchel at the hip
      seg(J.sh[-1], J.sh[1], 0.0024, L.tunic);
      seg(V.add(J.chest, V.mul(V.add(J.neck, V.mul(J.chest, -1)), 0.35)), J.neck, 0.0019, L.skin);
      for (const s of [-1, 1]) {
        seg(J.sh[s], J.elbow[s], 0.0017, L.tunic);
        seg(J.elbow[s], J.hand[s], 0.0013, L.skin);
        ball(J.hand[s], 0.0015, L.skin);
      }
      // the head: face, hair (a cap a little behind and above: the face covers
      // it from the front), a fringe, and a ponytail swinging behind
      // long hair down both sides, to the shoulders (behind the face from the front)
      for (const s of [-1, 1]) {
        const top = V.add(V.add(J.head, V.mul(right, s * 0.0036)), V.add(V.mul(fwd, -0.0012), [0, 0, 0.0012]));
        const low = V.add(V.add(J.head, V.mul(right, s * 0.0046)), V.add(V.mul(fwd, -0.0016), [0, 0, -0.0068]));
        seg(top, low, 0.0024, L.hair);
      }
      ball(J.head, 0.0055, L.skin);
      ball(V.add(J.head, V.add(V.mul(fwd, -0.0014), [0, 0, 0.0013])), 0.0055, L.hair);
      ball(V.add(J.head, V.add(V.mul(fwd, 0.003), [0, 0, 0.0036])), 0.0027, L.hair);
      for (const s of [-1, 1]) ball(V.add(V.add(J.head, V.mul(fwd, 0.0052)), V.add(V.mul(right, s * 0.0019), [0, 0, 0.0004])), 0.0008, L.eye);
      ball(V.add(J.head, V.add(V.mul(fwd, 0.0053), [0, 0, -0.0021])), 0.0007, "#c0504a"); // the mouth
      const tieP = V.add(V.add(J.head, V.mul(back, 0.0046)), [0, 0, 0.0022]);
      const swing = Math.sin(G.time * 7 + hero.phase) * 0.0012 * Math.min(1, speed * 20);
      const tailEnd = V.add(V.add(tieP, V.mul(back, 0.0035 + flow)), V.add(V.mul(right, swing), [0, 0, -0.0085 + flow * 0.5]));
      seg(tieP, tailEnd, 0.0021, L.hair);
      ball(tieP, 0.0016, L.tie);
      return out;
    }
    function drawExplorer(J, alpha) {
      const K = api.K;
      const prims = explorerPrims(J, K.placer(hero.f, hero.r, hero.z, hero.yaw, api.S));
      prims.forEach((p) => p.rad && (p.rad *= api.S));
      K.drawPrims(w, prims, ar, EXPLORER.outline, alpha);
      return true;
    }

    // each stone's mark above its cube: its number and name (on top, small)
    function drawStoneLabels() {
      if (!G.O) return;
      // which plate opens which gate (only where there's more than one)
      if (Object.keys(G.gates).length > 1) {
        G.O.rows.forEach((row, i) =>
          [...row].forEach((ch, j) => {
            if ("abAB".indexOf(ch) < 0) return;
            const [cf, cr] = cellCenterFR(i, j);
            const p = w.project(cf, cr, baseAt(i, j) + (ch === "a" || ch === "b" ? 0.004 : GATE_H * (1 - G.gates[ch.toUpperCase()].lift) + 0.01));
            if (p) ar.text(ch, p.x, p.y, { size: 13, align: "center", color: "#ffe9a8" });
          }),
        );
      }
      G.stones.forEach((s, tag) => {
        if (!s) return;
        const st = stoneInfo(tag);
        const p = w.project(s.b.cf, s.b.cr, s.b.h1 + 0.012);
        if (!p) return;
        ar.text(`${st.icon} ${T(st.name)}`, p.x, p.y, { size: 12, align: "center", color: rgba(st.color, 1) });
      });
    }

    function wrapText(text, width, size) {
      const g = ar.ctx;
      g.save();
      g.font = `bold ${size}px system-ui, sans-serif`;
      const out = [];
      let line = "";
      T(text).split(" ").forEach((word) => {
        const t2 = line ? `${line} ${word}` : word;
        if (line && g.measureText(t2).width > width) {
          out.push(line);
          line = word;
        } else line = t2;
      });
      if (line) out.push(line);
      g.restore();
      return out;
    }
    function drawHud() {
      const v = ar.view;
      const small = Lynx.smallScreen();
      // top centre (the corners hold the Menu / Overlays buttons and the drive status)
      let y = v.y + (small ? 16 : 20);
      const lv = G.lv;
      ar.text(`${G.idx + 1}. ${T(lv.name)}`, v.cx, y, { size: small ? 13 : 16, align: "center", color: "#ffe9a8" });
      y += small ? 16 : 20;
      ar.text("♥".repeat(G.hearts) + "♡".repeat(Math.max(0, maxHearts - G.hearts)), v.cx, y, { size: small ? 14 : 18, align: "center", color: "#ff5a5a" });
      // the stones: which the robot has seen, and what each does (under the Overlays button)
      const sx = v.x + v.w - 12;
      let sy = v.y + (small ? 52 : 60);
      levelStones().forEach(({ tag }) => {
        const st = stoneInfo(tag);
        const seen = !!G.stones[tag];
        ar.text(small ? `${tag} ${st.icon}` : `${tag} ${st.icon} ${T(st.name)}: ${T(st.tip)}`, sx, sy, { size: small ? 11 : 12, align: "right", color: seen ? rgba(st.color, 1) : "rgba(170,170,170,0.75)" });
        sy += small ? 14 : 16;
      });
      if (!small) ar.text("(grey: not seen yet -- let the camera see it)", sx, sy, { size: 11, align: "right", color: "rgba(190,190,190,0.8)" });
      if (G.hint && lv.hint) {
        const lines = wrapText(lv.hint, Math.min(520, v.w - 40), small ? 12 : 14);
        let hy = v.y + v.h - (small ? 60 : 50) - lines.length * 18;
        lines.forEach((l) => {
          ar.text(l, v.cx, hy, { size: small ? 12 : 14, align: "center", color: "#c8f0ff" });
          hy += 18;
        });
      }
      // the River: board / go ashore
      const sh = G.ship;
      if (sh && G.phase === "play") {
        let msg = null;
        if (canBoard()) msg = "\u{26F5} Fire / A: board the ship";
        else if (sh.aboard) msg = sh.berth && pierOf(sh.berth) ? "Fire / A: go ashore" : "Steer with the Helm stone (cube 4) in the river";
        const p = msg && w.project(hero.f, hero.r, hero.z + 0.05);
        if (p) ar.text(T(msg), p.x, p.y, { size: small ? 12 : 14, align: "center", color: "#bfeaff" });
      }
      if (G.flash) {
        ar.flash(G.flash.color, clamp(1 - G.flash.t / 0.4, 0, 1));
      }
      if (G.phase === "won") {
        ar.flash("rgba(20,10,40,0.55)", 1);
        ar.banner(T("THROUGH THE PORTAL!"), T(G.idx + 1 < LEVELS.length ? "Fire / A: the next level" : "Fire / A: back to the menu"), { color: "#d8a8ff" });
        ar.text(`${T("falls")}: ${G.falls} · ${T("hurt")}: ${G.hurts} · ${T("time")}: ${Math.round(G.levelTime)} s`, v.cx, v.cy + 60, { size: 14, align: "center", color: "#e8dcff" });
      } else if (G.phase === "lost") {
        ar.flash("rgba(40,0,0,0.5)", 1);
        ar.banner(T("NO HEARTS LEFT"), T("Fire / A: try again (the stones stay where they are)"), { color: "#ff7060" });
        if (G.lostWhy) ar.text(G.lostWhy, v.cx, v.cy + 60, { size: 14, align: "center", color: "#ffd0c8" });
      }
    }

    let menuRows = [];
    function drawMenu() {
      const v = ar.view;
      const small = Lynx.smallScreen();
      ar.flash("rgba(6,8,16,0.8)", 1);
      const titleSize = Math.max(22, Math.min(54, v.w / 11, v.h / 8));
      let y = v.y + titleSize + 8;
      ar.text(T("RUNE STONES"), v.cx, y, { size: titleSize, align: "center", color: "#c8a8ff", font: "Impact, 'Arial Black', sans-serif", weight: "normal" });
      y += small ? 18 : 24;
      ar.text("No fighting: set the rune stones (cubes 0-5) down by hand to make the explorer's way", v.cx, y, { size: small ? 11 : 13, align: "center", color: "#d8d0f0" });
      const rw = Math.min(460, v.w - 40);
      const top = y + (small ? 16 : 24);
      const rowH = small ? 20 : 26;
      const rowSize = small ? 12 : 15;
      menuRows = [];
      LEVELS.forEach((l, i) => {
        const ry = top + i * rowH + rowSize;
        const sel = i === G.sel;
        menuRows.push({ i, x0: v.cx - rw / 2, x1: v.cx + rw / 2, y0: ry - rowSize * 1.1, y1: ry - rowSize * 1.1 + rowH });
        if (sel) {
          ar.ctx.fillStyle = "rgba(180,140,255,0.2)";
          ar.ctx.fillRect(v.cx - rw / 2, ry - rowSize * 1.1, rw, rowH - 2);
        }
        ar.text(`${i + 1}. ${T(l.name)}`, v.cx - rw / 2 + 14, ry, { size: rowSize, color: sel ? "#f0e4ff" : "#b8acd0" });
        if (G.done.has(l.id)) ar.text("✔", v.cx + rw / 2 - 14, ry, { size: rowSize, align: "right", color: "#80ff9c" });
      });
      let by = top + LEVELS.length * rowH + (small ? 16 : 24);
      const l = LEVELS[G.sel];
      wrapText(l.intro, rw, small ? 11 : 13).forEach((t) => {
        ar.text(t, v.cx, by, { size: small ? 11 : 13, align: "center", color: "#e8e0ff" });
        by += small ? 14 : 18;
      });
      by += 4;
      if (!small) {
        STONES.forEach((st) => {
          ar.text(`${st.tag} ${st.icon} ${T(st.name)}: ${T(st.tip)}`, v.cx, by, { size: 12, align: "center", color: rgba(st.color, 1) });
          by += 15;
        });
      }
      ar.text(
        small ? "Tap a level · tap it again (or ▶): start" : `The level appears in front of the robot · click a level, again to start · LB / RB, Tab, 1-${LEVELS.length}: choose · Fire / A: start`,
        v.cx, v.y + v.h - 22, { size: small ? 11 : 12, align: "center", color: "#ffe9a8" },
      );
    }
    function rowAt(e) {
      if (G.phase !== "menu" || !menuRows.length) return null;
      const pt = e.touches ? e.touches[0] : e;
      if (!pt) return null;
      const r = ar.ctx.canvas.getBoundingClientRect();
      const x = pt.clientX - r.left;
      const y = pt.clientY - r.top;
      return menuRows.find((m) => x >= m.x0 && x <= m.x1 && y >= m.y0 && y <= m.y1) || null;
    }
    const onRowDown = (e) => {
      const m = rowAt(e);
      if (!m) return;
      e.stopPropagation();
      if (e.type !== "pointerdown") return; // (the touch / mouse events of the same press: only kept away)
      e.preventDefault();
      if (m.i === G.sel) startSelected(api.state);
      else {
        G.sel = m.i;
        sfx("click");
      }
    };
    ["pointerdown", "mousedown", "touchstart"].forEach((t) => window.addEventListener(t, onRowDown, { capture: true, passive: false }));
    ar.onDestroy(() => ["pointerdown", "mousedown", "touchstart"].forEach((t) => window.removeEventListener(t, onRowDown, { capture: true })));

    function onKey(e) {
      const t = e.target;
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA"))) return;
      if (e.code === "KeyH" && G.phase === "play") G.hint = !G.hint;
      else if (e.code === "KeyL" && api.state === "playing") toMenu();
    }
    window.addEventListener("keydown", onKey);
    ar.onDestroy(() => window.removeEventListener("keydown", onKey));
    const touch = Lynx.touchButtons();
    const menuBtns = [touch.add("▲ Previous level", () => G.phase === "menu" && choose(-1)), touch.add("▼ Next level", () => G.phase === "menu" && choose(1))];
    const hintBtn = touch.add("\u{1F4A1} Hint", () => G.phase === "play" && (G.hint = !G.hint));
    const shipBtn = touch.add("\u{26F5} Board / ashore", () => boardOrLeave());
    const touchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    function showButtons() {
      menuBtns.forEach((b) => (b.style.display = G.phase === "menu" && touchDevice ? "" : "none"));
      hintBtn.style.display = G.phase === "play" ? "" : "none";
      shipBtn.style.display = G.phase === "play" && G.ship && touchDevice ? "" : "none";
    }

    function confirm(state) {
      if (G.phase === "menu") startSelected(state);
      else if (G.phase === "won" && G.t > 0.6) nextLevel();
      else if (G.phase === "lost" && G.t > 0.6) retry();
    }

    return {
      actionLabel: "▶ OK",
      frozen: () => G.phase !== "play" || G.fallT > 0 || !!(G.ship && G.ship.aboard),
      solids: () => (G.phase === "menu" || !G.O ? [] : gateSolids().concat(platSolids())),
      drawFloor,
      draw() {
        drawStanding();
      },
      update(dt) {
        G.time += dt;
        showButtons();
        if (G.flash) {
          G.flash.t += dt;
          if (G.flash.t > 0.4) G.flash = null;
        }
        if (G.phase === "menu" || !G.O) return;
        findStones();
        G.t += dt;
        if (G.phase !== "play") return;
        G.levelTime += dt;
        updateMechanisms(dt);
        updateShip(dt);
        if (!(G.ship && G.ship.aboard)) updateKnight(dt); // (on board: the ship carries her)
        if (hero.z < -0.05 && G.fallT <= 0) respawn(); // (stuck under the floor somehow)
      },
      hud() {
        if (G.phase === "menu") {
          drawMenu();
          return;
        }
        drawStoneLabels();
        drawHud();
      },
      title() {
        showButtons();
        drawMenu();
        return true;
      },
      helpLine: () =>
        G.phase === "menu"
          ? ""
          : "Explorer: stick / WASD · Jump: Space / A · Robot: right stick / arrows · Hint: H · Levels: L · Center: V",
      onFire(state) {
        if (G.phase === "play" && G.ship) boardOrLeave();
        else confirm(state);
        return true; // (no sword)
      },
      // Jump (Space / gamepad A) does the same outside play: start, go on, try again
      onJump(state) {
        if (G.phase === "play") return false;
        confirm(state);
        return true;
      },
      unarmed: true,
      drawHero: drawExplorer,
      blockOver(b) {
        if (b.tag === 1 && G.phase !== "menu") weightOver(b);
        if (G.O && G.phase !== "menu" && waterAt(b.cf, b.cr)) submerged(b);
      },
      onWeapon(wpn) {
        if (G.phase !== "menu") return false;
        if (wpn === "next") choose(1);
        else if (wpn === "prev") choose(-1);
        else if (typeof wpn === "number" && wpn >= 1 && wpn <= LEVELS.length) {
          G.sel = wpn - 1;
          sfx("click");
        }
        return true;
      },
      hideHero: () => G.phase === "menu",
      heroAlpha: () => (G.fallT > 0 ? clamp(1 - G.fallT / FALL_S, 0, 1) : G.inv > 0.3 && G.inv < INV_S - 0.2 ? (Math.sin(G.time * 36) > 0 ? 0.45 : 1) : 1),
      snapshot: () => ({
        phase: G.phase, level: G.lv && G.lv.id, hearts: G.hearts, falls: G.falls, hurts: G.hurts, portal: G.portalOpen,
        gates: Object.fromEntries(Object.entries(G.gates).map(([k, g]) => [k, g.open])),
        stones: G.stones.map((s, tag) => (s ? `${tag}@${s.i.toFixed(2)},${s.j.toFixed(2)}` : `${tag}:-`)),
        hero: G.O ? cellAt(hero.f, hero.r).map((x) => +x.toFixed(2)) : null, floor: G.O ? floorAt(hero.f, hero.r) : null,
        ship: G.ship && { cell: cellAt(G.ship.f, G.ship.r).map((x) => +x.toFixed(2)), aboard: G.ship.aboard, berth: G.ship.berth, target: G.ship.target },
      }),
      debug: { G, LEVELS, loadLevel, cellAt, cellCenterFR, floorAt, findStones, win, retry, baseAt, platSolids, groundCell, boardOrLeave, canBoard },
    };
  };
})(window.Lynx);
