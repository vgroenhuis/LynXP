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
// all six. Moving a stone the knight is relying on (an island it stands on,
// the light of a bridge) drops it -- careful.
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
  const LEVELS = [
    {
      id: "first",
      name: "Six Stones",
      intro: "Every rune stone once: make the knight's way to the portal",
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
      intro: "Two fires, one Rain stone: carry it on while the knight waits",
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
      intro: "Two gates, one Weight: the first gate may close behind the knight",
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
      hint: "The Island and the Lantern each go twice: move them on behind the knight",
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
  const FIRE_PERIOD = 3.2; // s (f: on for the first FIRE_ON of it)
  const FIRE_ON = 1.5;
  const SPIKE_PERIOD = 2.4; // s (v: up for the first SPIKE_UP of it)
  const SPIKE_UP = 1.1;
  const INV_S = 1.2; // after a hurt, safe for this long
  const FALL_S = 0.8;
  const MAP_AHEAD_M = 0.12; // the map's near edge, ahead of the robot's drive axle at the start
  const STORE = "runesDone";

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
    const cellCenterFR = (i, j) => toFR(...cellUV(i, j));

    // -- the stones ------------------------------------------------------------------------------------------
    function findStones() {
      G.stones = STONES.map((st) => {
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
      if (ch === ".") return null;
      if (ch === "~") return lit(i, j) ? "bridge" : null;
      return ch;
    }

    // -- plates, gates, the portal ------------------------------------------------------------------------------
    function updateMechanisms(dt) {
      const o = G.O;
      const pressed = {};
      const [hi, hj] = cellAt(hero.f, hero.r);
      const heroOnFloor = hero.onGround && hero.standOn === null && hero.z < 0.003 && G.fallT <= 0;
      for (let i = 0; i < o.H; i++) {
        for (let j = 0; j < o.W; j++) {
          const ch = o.rows[i][j];
          if (ch !== "a" && ch !== "b") continue;
          const byKnight = heroOnFloor && Math.round(hi) === i && Math.round(hj) === j;
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
      let open = false;
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
          out.push({ id: `gate${i}_${j}`, cf, cr, yaw: o.th, half: CELL * 0.48, h0: 0, h1 });
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
            return lose("The knight fell into the chasm");
          }
          respawn();
          say("Into the chasm! Back to firm ground", "#ff9080");
        }
        return;
      }
      if (hero.mode !== "move") return; // (hanging on / climbing a cube: safe)
      const onFloor = hero.onGround && hero.standOn === null && hero.z < 0.003;
      if (!onFloor) return;
      const fl = floorAt(hero.f, hero.r);
      if (!fl) return startFall();
      const [ci, cj] = cellAt(hero.f, hero.r);
      const i = Math.round(ci);
      const j = Math.round(cj);
      const ch = fl === "island" ? "#" : tileAt(i, j);
      if ((ch === "F" || ch === "f") && fireOn(ch, i, j) && hero.z < FIRE_H) hurt("Burned! Put the fire out with the Rain stone");
      else if ((ch === "^" || ch === "v") && spikesUp(ch, i, j)) hurt("Spikes! The Earth stone sinks them");
      else if (ch === "E" && G.portalOpen) win();
      else if (ch !== "F" && ch !== "f" && ch !== "^" && ch !== "v" && ch !== "A" && ch !== "B") G.safe = { f: hero.f, r: hero.r };
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

    // -- drawing: all flat, cheap -----------------------------------------------------------------------------------------
    const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
    // a quad of cells (rows i0..i1, columns j0..j1, inclusive) on the floor, at height h
    function cellQuad(i0, j0, i1, j1, h = 0) {
      const [u0, v0] = [MAP_AHEAD_M + (G.O.H - 1 - i1) * CELL, (j0 - (G.O.W - 1) / 2 - 0.5) * CELL];
      const [u1, v1] = [MAP_AHEAD_M + (G.O.H - i0) * CELL, (j1 - (G.O.W - 1) / 2 + 0.5) * CELL];
      return [[u0, v0], [u1, v0], [u1, v1], [u0, v1]].map(([u, v]) => [...toFR(u, v), h]);
    }
    function poly(pts, fill, stroke, width = 1) {
      const p = w.polyScreen(pts, 2);
      if (p) w.fillPoly(p, fill, stroke, width);
    }
    function ring(f, r, rad, h, n = 20) {
      const pts = [];
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        pts.push([f + Math.cos(a) * rad, r + Math.sin(a) * rad, h]);
      }
      return pts;
    }
    const PAD = 2; // chasm drawn this many cells round the map (it's all chasm out there)
    const CHASM = "rgba(6,5,18,0.82)";
    function drawFloor() {
      if (!G.O || G.phase === "menu") return;
      const o = G.O;
      // the chasm: per row, runs of cells the knight would fall through (unlit bridges too)
      for (let i = -PAD; i < o.H + PAD; i++) {
        let j0 = null;
        for (let j = -PAD; j <= o.W + PAD; j++) {
          const ch = j < o.W + PAD ? tileAt(i, j) : "#";
          const hole = ch === "." || (ch === "~" && !lit(i, j));
          if (hole && j0 === null) j0 = j;
          if (!hole && j0 !== null) {
            poly(cellQuad(i, j0, i, j - 1), CHASM, null);
            j0 = null;
          }
        }
      }
      const t = G.time;
      // the stones' reach, under the rest
      G.stones.forEach((s, tag) => {
        if (!s) return;
        const st = STONES[tag];
        const { cf, cr } = s.b;
        if (tag === 0) {
          const h = ISLAND_HALF * CELL;
          const pts = [[h, h], [h, -h], [-h, -h], [-h, h]].map(([u, v]) => [...api.fromB(s.b, u, v), 0]);
          poly(pts, "rgba(96,140,64,0.78)", rgba(st.color, 0.95), 2);
        } else if (tag === 2 || tag === 3 || tag === 5) {
          const a = tag === 3 ? 0.16 + 0.04 * Math.sin(t * 3) : 0.12;
          poly(ring(cf, cr, REACH * CELL, 0), rgba(st.color, a), rgba(st.color, 0.7), 1.5);
        } else poly(ring(cf, cr, s.b.half * 1.5, 0, 12), null, rgba(st.color, 0.9), 2);
      });
      for (let i = 0; i < o.H; i++) {
        for (let j = 0; j < o.W; j++) {
          const ch = o.rows[i][j];
          const [cf, cr] = cellCenterFR(i, j);
          if (ch === "~") {
            const on = lit(i, j);
            poly(cellQuad(i, j, i, j), on ? "rgba(150,235,255,0.42)" : null, on ? "rgba(200,250,255,0.9)" : "rgba(120,220,255,0.35)", on ? 1.5 : 1);
          } else if (ch === "a" || ch === "b") {
            const down = G.gates[ch.toUpperCase()] && G.gates[ch.toUpperCase()].open;
            poly(cellQuad(i, j, i, j), down ? "rgba(70,150,70,0.75)" : "rgba(180,140,60,0.8)", "rgba(40,30,10,0.9)", 1.5);
          } else if (ch === "K") {
            poly(ring(cf, cr, CELL * 0.42, 0, 4), G.portalOpen ? "rgba(240,200,60,0.5)" : "rgba(240,200,60,0.18)", "rgba(240,200,60,0.95)", 2);
          } else if (ch === "E") {
            poly(ring(cf, cr, CELL * 0.45, 0, 16), G.portalOpen ? `rgba(190,110,255,${0.45 + 0.15 * Math.sin(t * 5)})` : "rgba(120,110,140,0.4)", G.portalOpen ? "rgba(230,190,255,0.95)" : "rgba(160,150,180,0.8)", 2);
          } else if (ch === "F" || ch === "f") {
            poly(cellQuad(i, j, i, j), doused(i, j) ? "rgba(60,60,70,0.55)" : "rgba(120,30,10,0.6)", null);
          } else if (ch === "^" || ch === "v") {
            poly(cellQuad(i, j, i, j), sunk(i, j) ? "rgba(90,70,50,0.4)" : "rgba(70,70,80,0.6)", null);
          } else if (ch === "S") {
            poly(ring(cf, cr, CELL * 0.35, 0, 12), null, "rgba(255,255,255,0.45)", 1);
          }
        }
      }
    }
    // the things that stand up: queued, so the knight and the cubes go in front / behind right
    function drawStanding() {
      if (!G.O || G.phase === "menu") return;
      const o = G.O;
      const t = G.time;
      const g = ar.ctx;
      for (let i = 0; i < o.H; i++) {
        for (let j = 0; j < o.W; j++) {
          const ch = o.rows[i][j];
          if ("FfvA^BE".indexOf(ch) < 0) continue;
          const [cf, cr] = cellCenterFR(i, j);
          const z = w.camZ(cf, cr, 0.02);
          if (z < w.near) continue;
          if ((ch === "F" || ch === "f") && fireOn(ch, i, j)) {
            ar.queue(z, () => {
              for (let k = 0; k < 3; k++) {
                const a = (k / 3) * Math.PI * 2 + t * 0.7;
                const ff = cf + Math.cos(a) * CELL * 0.22;
                const rr = cr + Math.sin(a) * CELL * 0.22;
                const hgt = FIRE_H * (0.7 + 0.3 * Math.sin(t * 11 + k * 2.1 + j));
                const b0 = w.project(ff - CELL * 0.12, rr, 0);
                const b1 = w.project(ff + CELL * 0.12, rr, 0);
                const top = w.project(ff, rr, hgt);
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
                const b0 = w.project(ff, rr - CELL * 0.1, 0);
                const b1 = w.project(ff, rr + CELL * 0.1, 0);
                const top = w.project(ff, rr, SPIKE_H);
                if (!b0 || !b1 || !top) continue;
                g.beginPath();
                g.moveTo(b0.x, b0.y);
                g.lineTo(top.x, top.y);
                g.lineTo(b1.x, b1.y);
                g.closePath();
                g.fill();
              }
            });
          } else if (ch === "A" || ch === "B") {
            const gt = G.gates[ch];
            const h1 = GATE_H * (1 - gt.lift);
            if (h1 < 0.004) continue;
            ar.queue(z, () => {
              // bars across the cell (the way the path doesn't run: both ways, it's a cage)
              const bars = [];
              for (const d of [-0.35, 0, 0.35]) {
                bars.push([toFR(...cellUV(i, j).map((x, k) => x + (k === 1 ? d * CELL : 0))), h1]);
                bars.push([toFR(...cellUV(i, j).map((x, k) => x + (k === 0 ? d * CELL : 0))), h1]);
              }
              bars.forEach(([[bf, br], hh]) => w.line3([[bf, br, 0], [bf, br, hh]], "rgba(70,75,85,0.95)", 3, 0.03));
              const top = cellQuad(i, j, i, j, h1);
              w.line3([...top, top[0]], "rgba(150,155,165,0.95)", 2, 0.03);
            });
          } else if (ch === "E" && G.portalOpen) {
            ar.queue(z, () => {
              const pts = [];
              for (let k = 0; k <= 16; k++) {
                const a = (k / 16) * Math.PI * 2;
                const [pf, pr] = toFR(cellUV(i, j)[0], cellUV(i, j)[1] + Math.cos(a) * CELL * 0.4);
                pts.push([pf, pr, CELL * 0.6 + Math.sin(a) * CELL * 0.6]);
              }
              w.line3(pts, `rgba(210,150,255,${0.7 + 0.3 * Math.sin(t * 6)})`, 3, 0.01);
            });
          }
        }
      }
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
            const p = w.project(cf, cr, ch === "a" || ch === "b" ? 0.004 : GATE_H * (1 - G.gates[ch.toUpperCase()].lift) + 0.01);
            if (p) ar.text(ch, p.x, p.y, { size: 13, align: "center", color: "#ffe9a8" });
          }),
        );
      }
      G.stones.forEach((s, tag) => {
        if (!s) return;
        const st = STONES[tag];
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
      STONES.forEach((st, tag) => {
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
      if (G.flash) {
        ar.flash(G.flash.color, clamp(1 - G.flash.t / 0.4, 0, 1));
      }
      if (G.phase === "won") {
        ar.flash("rgba(20,10,40,0.55)", 1);
        ar.banner(T("THROUGH THE PORTAL!"), T(G.idx + 1 < LEVELS.length ? "Fire: the next level" : "Fire: back to the menu"), { color: "#d8a8ff" });
        ar.text(`${T("falls")}: ${G.falls} · ${T("hurt")}: ${G.hurts} · ${T("time")}: ${Math.round(G.levelTime)} s`, v.cx, v.cy + 60, { size: 14, align: "center", color: "#e8dcff" });
      } else if (G.phase === "lost") {
        ar.flash("rgba(40,0,0,0.5)", 1);
        ar.banner(T("NO HEARTS LEFT"), T("Fire: try again (the stones stay where they are)"), { color: "#ff7060" });
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
      ar.text("No fighting: set the rune stones (cubes 0-5) down by hand to make the knight's way", v.cx, y, { size: small ? 11 : 13, align: "center", color: "#d8d0f0" });
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
        small ? "Tap a level · tap it again (or ▶): start" : "The level appears in front of the robot · click a level, again to start · LB / RB, Tab, 1-5: choose · Fire: start",
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
    const touchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    function showButtons() {
      menuBtns.forEach((b) => (b.style.display = G.phase === "menu" && touchDevice ? "" : "none"));
      hintBtn.style.display = G.phase === "play" ? "" : "none";
    }

    return {
      actionLabel: "▶ OK",
      frozen: () => G.phase !== "play" || G.fallT > 0,
      solids: () => (G.phase === "menu" ? [] : gateSolids()),
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
        updateKnight(dt);
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
          : "Knight: stick / WASD · Jump: Space / A · Robot: right stick / arrows · Hint: H · Levels: L · Center: V",
      onFire(state) {
        if (G.phase === "menu") startSelected(state);
        else if (G.phase === "won" && G.t > 0.6) nextLevel();
        else if (G.phase === "lost" && G.t > 0.6) retry();
        return true; // (no sword)
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
      }),
      debug: { G, LEVELS, loadLevel, cellAt, cellCenterFR, floorAt, findStones, win, retry },
    };
  };
})(window.Lynx);
