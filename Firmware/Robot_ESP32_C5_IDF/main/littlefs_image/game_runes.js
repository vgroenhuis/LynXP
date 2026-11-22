// Rune Stones -- a puzzle game for the knight of Knight on Blocks
// (game_knightblocks.js: its knight, the robot's drive and camera, the cube
// finder), with no fighting and no enemies: the explorer crosses a level of
// water, fire, spikes, ghostly bridges and gates to a portal, and the
// PLAYER makes the way, by setting down the six rune stones -- the tagged
// cubes 0-5, by hand, wherever they're needed:
//   0 Bridge  -- a plank bridge over the water, laid along the cube's own X
//                axis (a directional cube -- CAD Generators' AprilTag Cube
//                -- turns it with itself), out both ways to the banks
//   1 Weight  -- holds a pressure plate down: its gate opens
//   2 Rain    -- puts out the fire near it
//   3 Lantern -- lights the ghost bridges near it: lit, they hold the knight
//   4 Key     -- an upright key: set on the keyhole in the socket next to the
//                portal, it slides down into it and the portal opens
//   5 Earth   -- sinks the spikes near it
// Each stone is drawn as a stone with its rune big inside (its tags not
// shown), and can't be climbed. A stone works wherever it stands -- on the
// floor in the water too -- and keeps working while it
// stands there: one Rain stone for two fires means putting it out at one,
// then carrying it on to the other while the knight waits. The first two
// levels start with one stone, then three; each level counts only the
// stones it needs (`stones`). The Bridge stands only in open water, never in
// the ravine or on fire, spikes or a ghost bridge. Moving a stone the knight is relying on (a bridge it stands on,
// the light of a bridge) drops it -- careful.
//
// Raised ground (as in Temple of LynXP), in 4 cm steps -- a cube's height:
// the explorer climbs one step, not two (the levels' own steps: the stones
// can't be climbed).
//
// No setup: the level is laid out on the floor in front of the robot from
// where it stands when the level starts (its drive axle; ahead is up the
// level's map), and the stones count wherever the cube finder sees them --
// the frame cube isn't used. Hazards hurt (hearts); a fall into the water or the ravine
// costs a heart too and puts the knight back where it last stood safely;
// no hearts left: the level again, the stones where they are.
//
// On the 2D canvas, no WebGL: the ground textured (grass, sand, a path's
// earth; the ravine's cliffs rock -- the "textures" setting, off: flat
// colours for an old phone), with gentle hills a few mm high that the
// explorer walks up and down (X.floorH: only on plain ground, flat at every
// edge); the sea and the river in 3D waves that stay under the shore, with
// surf running up the beaches; trees and rocks round the levels; a quiet
// surf-and-stream ambience (the "ambience" setting; it also keeps the sound
// output awake, else the first sound after a quiet spell came late).
//
// The River (the last level) is different: two shores 4 cm up, a river
// between them (its water 4 cm up as well, level with a cube's top) and a
// ship. One stone, the Helm (cube 4 there), steers it: set down in the river,
// the ship sails to it (to the cube's top, on the water -- the cube itself is
// under the water, not shown); on the shore or out
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
  //   .  open water, a river (the Bridge stands there)
  //   o  the sea (round the map it's all sea; no Bridge there)
  //   :  the ravine (bottomless: no Bridge there)
  //   T  a tree, R a rock: solid, too high to climb (they hem the way in)
  //   #  ground          S  start         E  portal
  //   K  the Key stone's socket              ~  ghost bridge (needs light)
  //   F  fire            f  fire, on and off (cross between bursts)
  //   ^  spikes          v  spikes, up and down
  //   a b  pressure plates   A B  their gates (plate a opens every A)
  //   w  water           h  water, a ship's berth   H  a harbour's pier (ground)
  // and optionally `rise`, the same shape: how high each cell is raised, in
  // 4 cm steps -- the height of a tag cube (. or 0 the floor, 1 4 cm, 2 8 cm,
  // 3 12 cm). Raised ground is a column from the floor up; a raised ghost
  // bridge (~) hangs in the air, held only while lit. The explorer (3 cm)
  // climbs 4 cm, not 8 (she jumps about 6 cm); the stones can't be climbed.
  // Stones only work on the floor.
  // Every obstacle is at least two cells deep (the explorer's running jump
  // clears one), hemmed in by trees, rocks, the ravine or the sea on both
  // sides (no Bridge round it) -- the river crosses the whole map, so each
  // stone is needed where it's meant to go (tools/runes_check.js checks: no
  // level can be won with one of its stones left out).
  // `riseAll`: every cell but the gaps that many steps up (water included:
  // its surface). `stones`: the only tags that count in the level, `helm`: the
  // tag that steers the ship. A level without a socket (K) has its portal open.
  const LEVELS = [
    {
      id: "island",
      name: "The Bridge",
      intro: "One stone to start with: the Bridge (cube 0). Set it down in the river and walk across",
      hint: "Put cube 0 in the river: a bridge runs along the cube's X axis to the banks -- turn the cube so it goes across",
      stones: [0],
      map: [
        "ooTTT#E#TTToo",
        "oTT#######TTo",
        "oT####T####To",
        "oR#########Ro",
        "o###########o",
        ".............",
        ".............",
        "o###########o",
        "oR####R####To",
        "oT#########To",
        "oTT###S###TTo",
        "ooTTT###TTToo",
      ],
    },
    {
      id: "three",
      name: "Three Stones",
      intro: "Three stones: the Bridge for the river, Rain for the fire, the Key for the portal",
      hint: "Bridge across the river, Rain beside the fire, the Key on the keyhole next to the portal",
      stones: [0, 2, 4],
      map: [
        "ooTTRKERTTToo",
        "oTT#######TTo",
        "oT####T####To",
        "oRRRR###RRRRo",
        "oRRTTFFFTTRRo",
        "oRTTTFFFTTTRo",
        "oRRT#####TRRo",
        "oT#########To",
        "o####T######o",
        ".............",
        ".............",
        "o###########o",
        "oT####R####To",
        "oTT###S###TTo",
        "ooTTT###TTToo",
      ],
    },
    {
      id: "first",
      name: "Six Stones",
      intro: "Every rune stone once: make the explorer's way to the portal",
      hint: "Bridge across the river, Weight on the plate among the rocks, Rain at the fire, Lantern at the ghost bridge, Earth at the spikes, Key on the keyhole",
      map: [
        "ooTTRKERTTToo",
        "oTT#######TTo",
        "oRRRR###RRRRo",
        "oRRTT^^^TTRRo",
        "oRTTT^^^TTTRo",
        "oT#########To",
        "oR####T####Ro",
        "RR:::~~~:::RR",
        "RR:::~~~:::RR",
        "oT#########To",
        "oTRRR###RRRTo",
        "oTTTTFFFTTTTo",
        "oRTTTFFFTTTRo",
        "oT########TTo",
        "oRRRRAAARRaRo",
        "oT########TTo",
        "o####T######o",
        ".............",
        ".............",
        "o###########o",
        "oT####R####To",
        "oTT###S###TTo",
        "ooTTT###TTToo",
      ],
    },
    {
      id: "fires",
      name: "Fire Twice",
      intro: "Two fires, one Rain stone: carry it on while the explorer waits",
      hint: "Put out the first fire, walk past it, then move the Rain stone to the second fire",
      stones: [2, 4],
      map: [
        "ooTTRKERTTToo",
        "oTT#######TTo",
        "oTRRR###RRRTo",
        "oTTTTFFFTTTTo",
        "oRTTTFFFTTTRo",
        "oT#########To",
        "o###T###R###o",
        "oR#########To",
        "oT###R######o",
        "o#########T#o",
        "oTRRR###RRRTo",
        "oTTTTFFFTTTTo",
        "oRTTTFFFTTTRo",
        "oT#########To",
        "oTT###S###TTo",
        "ooTTT###TTToo",
      ],
    },
    {
      id: "causeway",
      name: "The Dark Causeway",
      intro: "Two ghost bridges over the ravine, one Lantern: wait on the ground between them",
      hint: "Light the first bridge, cross to the ground between the two, then move the Lantern on",
      stones: [3, 4],
      map: [
        "ooTTRKERTTToo",
        "oTT#######TTo",
        "RR:::~~~:::RR",
        "R::::~~~::::R",
        "RR:::~~~:::RR",
        "oT#########To",
        "o##T#####R##o",
        "oT#########To",
        "RR:::~~~:::RR",
        "R::::~~~::::R",
        "RR:::~~~:::RR",
        "oT#########To",
        "oTT###S###TTo",
        "ooTTT###TTToo",
      ],
    },
    {
      id: "gates",
      name: "Two Gates",
      intro: "Two gates, one Weight: the first gate may close behind the explorer",
      hint: "Weight on plate a, through gate A, then move the Weight to plate b",
      stones: [1, 4],
      map: [
        "ooTTRKERTTToo",
        "oTT#######TTo",
        "oRRRRBBBRRRRo",
        "oT#########To",
        "o####R####b#o",
        "oT#########To",
        "oRRRRAAARRRRo",
        "oT#########To",
        "o#a##T######o",
        "oTT###S###TTo",
        "ooTTT###TTToo",
      ],
    },
    {
      id: "vault",
      name: "The Rune Vault",
      intro: "Two rivers, two ghost bridges and a fire that comes and goes",
      hint: "The Bridge and the Lantern each go twice: move them on behind the explorer",
      stones: [0, 3, 4],
      map: [
        "ooTTRKERTTToo",
        "oTT#######TTo",
        "RR:::~~~:::RR",
        "RR:::~~~:::RR",
        "oT#########To",
        ".............",
        ".............",
        "oR####f####Ro",
        "RR:::~~~:::RR",
        "RR:::~~~:::RR",
        "oT#########To",
        ".............",
        ".............",
        "o###########o",
        "oT####R####To",
        "oTT###S###TTo",
        "ooTTT###TTToo",
      ],
    },
    {
      id: "steps",
      name: "Up and Down",
      intro: "Raised ground, 4 cm a step: the explorer climbs one step at a time (the stones can't be climbed)",
      hint: "Down onto the Bridge across the river between the two ledges, up the other side, then Rain at the fire up on the high ground",
      stones: [0, 2, 4],
      map: [
        "ooTTRKERTTToo",
        "oTT#######TTo",
        "oT####T####To",
        "oRRTTFFFTTRRo",
        "oRTTTFFFTTTRo",
        "oT#########To",
        "oT###R#####To",
        ".............",
        ".............",
        "oT#########To",
        "oR####T####Ro",
        "oT#########To",
        "oTT###S###TTo",
        "ooTTT###TTToo",
      ],
      rise: [
        "2222222222222",
        "2222222222222",
        "2222222222222",
        "2222222222222",
        "2222222222222",
        "2222222222222",
        "1111111111111",
        ".............",
        ".............",
        "1111111111111",
        "1111111111111",
        ".............",
        ".............",
        ".............",
      ],
    },
    {
      id: "towers",
      name: "The Towers",
      intro: "Up to the 12 cm heights, a step at a time, every stone on the way",
      hint: "Bridge across the river, Earth at the spikes, Weight on plate a, Rain at the fire up there, Lantern at the high bridge, then the Key on its keyhole",
      map: [
        "ooTTRKERTTToo",
        "RR:::~~~:::RR",
        "RR:::~~~:::RR",
        "oT#########To",
        "oRRTTFFFTTRRo",
        "oRTTTFFFTTTRo",
        "oT########TTo",
        "oRRRRAAARRaRo",
        "oT########TTo",
        "oT####R####To",
        "oRRTT^^^TTRRo",
        "oRTTT^^^TTTRo",
        "oT#########To",
        ".............",
        ".............",
        "oT####S####To",
        "ooTTT###TTToo",
      ],
      rise: [
        "3333333333333",
        "3333333333333",
        "3333333333333",
        "3333333333333",
        "3333333333333",
        "3333333333333",
        "3333333333333",
        "2222222222222",
        "2222222222222",
        "1111111111111",
        ".............",
        ".............",
        ".............",
        ".............",
        ".............",
        ".............",
        ".............",
      ],
    },
    {
      id: "river",
      name: "The River",
      intro: "Two shores and a river, 4 cm up: steer the ship across with the Helm stone (cube 4)",
      hint: "Board at the harbour (Fire / A), then set cube 4 down in the river, a bit at a time, round the islets to the far harbour; go ashore with Fire / A",
      stones: [4],
      helm: 4,
      riseAll: 1,
      map: [
        "oooooTT#E#TTooo",
        "ooooT#######Too",
        "oooT###T#####To",
        "ooT#####H####To",
        "wwwwwwwwhwwwwww",
        "wwwwwwwwwwwwwww",
        "wwwww#T#wwwwwww",
        "wwwwwT##wwwwwww",
        "wwwwwwwwwwww#Tw",
        "wwwwwwwwwwwwwww",
        "wwwwwwwwwwwwwww",
        "wwhwwwwwwwwwwww",
        "oTH##########To",
        "oT#####T#####To",
        "ooTT###S###TToo",
      ],
    },
  ];

  const STONES = [
    { tag: 0, name: "Bridge", icon: "\u{1F309}", color: [170, 120, 66], tip: "a bridge along the cube's X axis (only in water)" },
    { tag: 1, name: "Weight", icon: "\u{2693}", color: [190, 190, 200], tip: "holds a plate down" },
    { tag: 2, name: "Rain", icon: "\u{1F327}", color: [90, 160, 255], tip: "puts out fire" },
    { tag: 3, name: "Lantern", icon: "\u{1F3EE}", color: [255, 210, 90], tip: "lights ghost bridges" },
    { tag: 4, name: "Key", icon: "\u{1F5DD}", color: [240, 190, 40], tip: "opens the portal" },
    { tag: 5, name: "Earth", icon: "\u{26F0}", color: [190, 130, 70], tip: "sinks spikes" },
  ];
  // reach, in cells (from the stone's center): the Rain's, Lantern's and
  // Earth's a circle to a cell's center, the Bridge's its deck (along the
  // cube's X axis), the Weight's and the Key's the plate / socket
  const REACH = 2.2;
  const BRIDGE_W = 0.5; // the Bridge: half its width, in cells
  const BRIDGE_MAX = 4.5; // ...how far it reaches each way at most, in cells
  const BRIDGE_LAND = 0.35; // ...how far onto the bank
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
    // the surf and a stream, quietly, while the game is open (it also keeps the sound output awake)
    if (cfg.ambience !== false && Lynx.sfx.ambient) {
      Lynx.sfx.ambient("shore");
      if (ar.onDestroy) ar.onDestroy(() => Lynx.sfx.ambient(null));
    }

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
    // (round the map: the sea)
    const tileAt = (i, j) => (i < 0 || j < 0 || i >= G.O.H || j >= G.O.W ? "o" : G.O.rows[i][j]);
    // a gap: open water (.: the Bridge stands there), the sea (o) or the ravine (:, bottomless)
    const isGap = (ch) => ch === "." || ch === ":" || ch === "o";
    // a tree or a rock: on ground, solid and too high to climb
    const isScenery = (ch) => ch === "T" || ch === "R";
    // a cell's raised height (m; 0 on the floor, and for a chasm)
    const baseAt = (i, j) => (i < 0 || j < 0 || i >= G.O.H || j >= G.O.W || isGap(G.O.rows[i][j]) ? 0 : G.O.base[i][j]);
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
    // The Bridge: a plank bridge laid along the cube's own X axis, its middle on
    // the cube -- by the cube's full heading where it has one (its side tags
    // each turned a quarter: tagblocks.js), else its yaw (known only to a
    // quarter turn, as any cube's). From the cube it reaches out both ways
    // over the open water to the bank (and a little onto it), at most
    // BRIDGE_MAX cells each way; at the ravine or the sea it just ends.
    const bridgeYaw = (b) => (b.world && typeof b.world.heading === "number" ? w.anchor().th - b.world.heading : b.yaw);
    const bridgeFrame = (b) => ({ ...b, yaw: bridgeYaw(b) });
    // The Bridge only stands in open water (.): not in the ravine, not on
    // the ground, fire, spikes or a ghost bridge -- so it never stands in for
    // another stone. On anything else it's just a stone.
    const bridgeWorks = (s) => !!s && tileAt(Math.round(s.i), Math.round(s.j)) === ".";
    // how far it reaches each way (m): {a: back along -X, b: on along +X, land: [back, on] reaches a bank}
    function bridgeSpan(s) {
      const fb = bridgeFrame(s.b);
      const key = `${fb.cf.toFixed(4)},${fb.cr.toFixed(4)},${fb.yaw.toFixed(3)}`;
      if (s.span && s.span.key === key) return s.span;
      const step = 0.1 * CELL;
      const out = { key, a: 0, b: 0, land: [false, false] };
      [-1, 1].forEach((dir, n) => {
        let u = 0;
        let end = BRIDGE_MAX * CELL;
        for (; u <= BRIDGE_MAX * CELL; u += step) {
          const [f, r] = api.fromB(fb, dir * u, 0);
          const [ci, cj] = cellAt(f, r);
          const ch = tileAt(Math.round(ci), Math.round(cj));
          if (ch === ".") continue;
          if (ch === ":" || ch === "o") end = Math.max(0, u - step); // (no bank: it ends over the water)
          else {
            end = u + BRIDGE_LAND * CELL; // (the bank: a little onto it)
            out.land[n] = true;
          }
          break;
        }
        out[n ? "b" : "a"] = end;
      });
      s.span = out;
      return out;
    }
    function onBridge(f, r) {
      const s = stone(0);
      if (!bridgeWorks(s)) return false;
      const sp = bridgeSpan(s);
      const [u, v] = api.toB(bridgeFrame(s.b), f, r);
      return Math.abs(v) <= BRIDGE_W * CELL && u >= -sp.a && u <= sp.b;
    }
    // The stones can't be climbed (else a stone is a step over any gap): an
    // invisible column stands on each, too high to step or reach up to.
    function stoneColumns() {
      return api.realSolids
        .filter((b) => !b.inferred && !waterAt(b.cf, b.cr) && !(bareTag(b.tag) && liveStone(b)) && !(b.tag === 0 && liveStone(b) && bridgeWorks(G.stones[0])))
        .map((b) => ({ id: `col${b.id}`, cf: b.cf, cr: b.cr, yaw: b.yaw, half: b.half, h0: b.h1, h1: b.h1 + 0.3 }));
    }
    const lit = (i, j) => near(3, i, j, REACH);
    const doused = (i, j) => near(2, i, j, REACH);
    const sunk = (i, j) => near(5, i, j, REACH);
    const fireOn = (ch, i, j) => !doused(i, j) && (ch === "F" || (G.levelTime + j * 0.37) % FIRE_PERIOD < FIRE_ON);
    const spikesUp = (ch, i, j) => !sunk(i, j) && (ch === "^" || (G.levelTime + i * 0.29) % SPIKE_PERIOD < SPIKE_UP);

    // Can the knight stand on the floor here? (on a real cube's top it always can)
    function floorAt(f, r) {
      const [ci, cj] = cellAt(f, r);
      const i = Math.round(ci);
      const j = Math.round(cj);
      const ch = tileAt(i, j);
      if (ch === ".") return onBridge(f, r) ? "deck" : null; // (the bridge: only over open water)
      if (ch === ":" || ch === "o" || isWater(ch)) return null;
      if (isScenery(ch)) return "#"; // (the ground under a tree: she can't be in it anyway)
      if (ch === "~") return lit(i, j) && !baseAt(i, j) ? "bridge" : null; // (under a raised bridge: the chasm)
      return ch;
    }
    // Where the explorer stands on the level's own ground -- the floor, or the
    // top of raised ground -- its cell [i, j] (else null: in the air, hanging,
    // on a cube)
    function groundCell() {
      if (hero.mode !== "move" || !hero.onGround || G.fallT > 0) return null;
      const s = hero.standOn;
      if (s === null ? hero.z >= floorH(hero.f, hero.r) + 0.003 : !(typeof s === "string" && s.startsWith("plat"))) return null;
      if (s !== null) return s.slice(4).split("_").map(Number); // (the column she stands on)
      const [ci, cj] = cellAt(hero.f, hero.r);
      return [Math.round(ci), Math.round(cj)];
    }

    // -- the ground: its kinds, its gentle hills, its shores, its trees and rocks (worked out once a level) ----------
    const HILL_A = 0.005; // m: the hills' height at most (her step up is far more)
    // the hills' shape over the level (u, v in m): 0..1, a few cells across
    const hillShape = (u, v) => clamp(0.5 + 0.6 * (0.55 * Math.sin(u * 38 + 1.7 * Math.sin(v * 21)) * Math.sin(v * 31 + 0.8) + 0.3 * Math.sin(u * 23 - v * 29 + 2.1) + 0.15 * Math.sin(u * 71 + v * 13)), 0, 1);
    const wetTile = (ch) => ch === "." || ch === "o" || isWater(ch);
    function prepareGround() {
      const o = G.O;
      // grass; sand along the water; a path's bare earth under the marks, the fires, the spikes and the gates
      o.kind = o.rows.map((row, i) => [...row].map((ch, j) => {
        if ("SEKabABFf^vH".indexOf(ch) >= 0) return "dirt";
        for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) if (wetTile(tileAt(i + di, j + dj)) && baseAt(i + di, j + dj) <= baseAt(i, j) + 1e-6) return "sand";
        return "grass";
      }));
      // the hills: only where every cell round a corner is plain ground on the floor (flat at every edge, mark, step)
      const plain = (i, j) => {
        const ch = tileAt(i, j);
        return (ch === "#" || isScenery(ch)) && !baseAt(i, j);
      };
      o.hillW = [];
      for (let i = 0; i <= o.H; i++) {
        const row = [];
        for (let j = 0; j <= o.W; j++) row.push(plain(i - 1, j - 1) && plain(i - 1, j) && plain(i, j - 1) && plain(i, j) ? 1 : 0);
        o.hillW.push(row);
      }
      o.hillCells = [];
      for (let i = 0; i < o.H; i++) for (let j = 0; j < o.W; j++) if (o.hillW[i][j] + o.hillW[i + 1][j] + o.hillW[i][j + 1] + o.hillW[i + 1][j + 1] > 0 && !isScenery(o.rows[i][j])) o.hillCells.push([i, j]);
      // the beaches: a floor-level ground cell's side on the sea or a river (the surf runs up them)
      o.shore = [];
      const NB4 = [[0, -1], [-1, 0], [0, 1], [1, 0]];
      for (let i = 0; i < o.H; i++) {
        for (let j = 0; j < o.W; j++) {
          const ch = o.rows[i][j];
          if (!(walkTile(ch) || isScenery(ch)) || baseAt(i, j)) continue;
          for (let k = 0; k < 4; k++) {
            const nc = tileAt(i + NB4[k][0], j + NB4[k][1]);
            if (nc === "." || nc === "o") o.shore.push({ i, j, k, ph: (((0.061 * j + 0.047 * i + (k === 1 || k === 3 ? 0.013 * j : 0.017 * i)) % 1) + 1) % 1 });
          }
        }
      }
      // the trees and the rocks: each its own look (from its cell, the same every time)
      o.scenery = [];
      for (let i = 0; i < o.H; i++) {
        for (let j = 0; j < o.W; j++) {
          const ch = o.rows[i][j];
          if (!isScenery(ch)) continue;
          let seed = (i * 73856093) ^ (j * 19349663) ^ (G.idx * 83492791);
          const rnd = () => {
            seed = (seed * 1103515245 + 12345) & 0x7fffffff;
            return seed / 0x7fffffff;
          };
          const [cf, cr] = cellCenterFR(i, j);
          const it = { i, j, ch, cf, cr, scale: 0.85 + 0.3 * rnd(), conifer: rnd() < 0.4, du: (rnd() - 0.5) * 0.25, dv: (rnd() - 0.5) * 0.25, tint: rnd(), moss: rnd() < 0.45 };
          if (ch === "R") it.rock = rockShape(rnd);
          o.scenery.push(it);
        }
      }
      o.scenerySolids = o.scenery.map((s) => ({ id: `tree${s.i}_${s.j}`, cf: s.cf, cr: s.cr, yaw: o.th, half: CELL * 0.47, h0: baseAt(s.i, s.j), h1: baseAt(s.i, s.j) + 0.3 }));
    }
    // the floor's height (m) at a level point (u, v): the hills
    function hillAtUV(u, v) {
      const o = G.O;
      if (!o || !o.hillW) return 0;
      const x = o.H - (u - MAP_AHEAD_M) / CELL; // (corner rows: corner i is the far edge of row i)
      const y = v / CELL + (o.W - 1) / 2 + 0.5;
      const i0 = Math.floor(x);
      const j0 = Math.floor(y);
      if (i0 < 0 || j0 < 0 || i0 >= o.H || j0 >= o.W) return 0;
      const fx = x - i0;
      const fy = y - j0;
      const W = o.hillW;
      const wgt = (W[i0][j0] * (1 - fx) + W[i0 + 1][j0] * fx) * (1 - fy) + (W[i0][j0 + 1] * (1 - fx) + W[i0 + 1][j0 + 1] * fx) * fy;
      if (wgt <= 0) return 0;
      return HILL_A * wgt * wgt * (3 - 2 * wgt) * hillShape(u, v);
    }
    // ...and at a floor point (the knight's X.floorH)
    function floorH(f, r) {
      if (!G.O || G.phase === "menu") return 0;
      const [u, v] = toUV(f, r);
      return hillAtUV(u, v);
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
      let sock = null;
      for (let i = 0; i < o.H; i++) {
        for (let j = 0; j < o.W; j++) {
          if (o.rows[i][j] === "K" && onSpot(4, i, j)) {
            open = true;
            sock = [i, j];
          }
        }
      }
      // the key over the keyhole slides down into it (and up out of it, taken away)
      if (sock) G.keySock = sock;
      G.keySink = clamp((G.keySink || 0) + (sock ? dt * 1.4 : -dt * 3), 0, 1);
      if (!sock && G.keySink === 0) G.keySock = null;
      if (o.hasKey) open = !!sock && G.keySink >= 1; // (the portal opens once the key is all the way in)
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
      const [fi, fj] = cellAt(hero.f, hero.r);
      const fc = tileAt(Math.round(fi), Math.round(fj));
      G.fellInRavine = fc === ":" || fc === "~"; // (the ravine, an unlit bridge; else the water or the sea)
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
            return lose(G.fellInWater ? "The explorer fell into the river" : G.fellInRavine ? "The explorer fell into the ravine" : "The explorer fell into the water");
          }
          respawn();
          say(G.fellInWater ? "Splash! Into the river -- back to the shore" : G.fellInRavine ? "Down into the ravine! Back to firm ground" : "Splash! Into the water -- back to firm ground", "#ff9080");
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
      const ch = fl === "deck" ? "#" : tileAt(i, j);
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
      G.keySink = 0;
      G.keySock = null;
      // the map in front of the robot, from where it stands now
      const ch = api.chassis();
      G.O = { f: ch.f, r: ch.r, th: ch.th, rows: lv.map, H: lv.map.length, W: Math.max(...lv.map.map((s) => s.length)) };
      G.O.rows = lv.map.map((s) => s.padEnd(G.O.W, ":"));
      G.O.base = G.O.rows.map((row, i) => [...row].map((c, j) => clamp(+((lv.rise && lv.rise[i] && lv.rise[i][j]) || (lv.riseAll && c !== "." && c !== ":" ? lv.riseAll : 0)) || 0, 0, 9) * RISE));
      G.O.hasKey = G.O.rows.some((row) => row.includes("K"));
      prepareGround();
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
      // (the level's raised ground made solid first: else she'd start on the
      // floor, inside a raised start -- the River's shore)
      if (api.refreshSolids) api.refreshSolids();
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
      hero.vf = hero.vr = 0; // (she stops where she stands, no walking on the spot)
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
    // (off the whole canvas -- not just the camera's picture, which is only
    // part of the window: the floor goes on beside it)
    function offView(s, m) {
      const cv = ar.ctx.canvas;
      return s.every((p) => p.x < -m) || s.every((p) => p.x > cv.width + m) || s.every((p) => p.y < -m) || s.every((p) => p.y > cv.height + m);
    }
    // Past the calibrated lens's edge (beside the picture) the lens gives no
    // point: there the plain pinhole projection draws the floor on.
    const wp = Lynx.world3d(ar, { textures: false });
    function projectAll(pts) {
      const a = w.anchor();
      wp.setAnchor(a);
      const lens = pts.map((p) => w.project(p[0], p[1], p[2]));
      if (lens.every(Boolean)) return lens;
      const pin = pts.map((p) => wp.project(p[0], p[1], p[2]));
      return pin.every(Boolean) ? pin : null;
    }
    // a floor quad (4 points [f, r, h]) into `path` (a list of screen quads): whole if it projects
    // whole and is small on the screen, else cut into a grid of pieces (gridQuad)
    function addQuad(path, pts) {
      const s = projectAll(pts);
      let n = 4;
      if (s) {
        if (offView(s, 4)) return;
        const size = quadSize(s);
        if (size < 110) {
          path.push(s);
          return;
        }
        n = Math.min(6, Math.ceil(size / 110));
      }
      gridQuad(path, null, pts, null, n);
    }
    const quadSize = (s) => Math.max(Math.abs(s[0].x - s[2].x), Math.abs(s[0].y - s[2].y), Math.abs(s[1].x - s[3].x), Math.abs(s[1].y - s[3].y));
    // A world quad (corners a, b, c, d in order round it) cut into n x n pieces, its grid of points
    // projected once each -- through the lens, else (beside the picture, where the lens gives
    // nothing) the plain pinhole; a piece still partly behind the lens is cut at its near plane (no
    // texture there). Pieces into `path` (screen quads) and, with texture coordinates uv (the
    // corners' {u, v}), into texOut as [screen quad, its uv].
    function gridQuad(path, texOut, pts, uv, n) {
      const [a, b, c, d] = pts;
      const G1 = n + 1;
      const gp = [];
      const gs = [];
      const gt = [];
      const gpin = [];
      for (let x = 0; x <= n; x++) {
        for (let y = 0; y <= n; y++) {
          const fx = x / n;
          const fy = y / n;
          const p = [0, 1, 2].map((k) => (a[k] * (1 - fx) + b[k] * fx) * (1 - fy) + (d[k] * (1 - fx) + c[k] * fx) * fy);
          gp.push(p);
          gs.push(w.project(p[0], p[1], p[2]));
          gpin.push(undefined);
          if (uv) gt.push({ u: (uv[0].u * (1 - fx) + uv[1].u * fx) * (1 - fy) + (uv[3].u * (1 - fx) + uv[2].u * fx) * fy, v: (uv[0].v * (1 - fx) + uv[1].v * fx) * (1 - fy) + (uv[3].v * (1 - fx) + uv[2].v * fx) * fy });
        }
      }
      const pin = (k) => {
        if (gpin[k] === undefined) {
          wp.setAnchor(w.anchor());
          gpin[k] = wp.project(gp[k][0], gp[k][1], gp[k][2]);
        }
        return gpin[k];
      };
      for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) {
          const ids = [x * G1 + y, (x + 1) * G1 + y, (x + 1) * G1 + y + 1, x * G1 + y + 1];
          let s = ids.map((k) => gs[k]);
          if (!s.every(Boolean)) s = ids.map(pin);
          if (!s.every(Boolean)) {
            if (!path) continue;
            const pc = w.polyScreen(ids.map((k) => gp[k]), 2);
            if (pc && !offView(pc, 4)) path.push(pc);
            continue;
          }
          if (offView(s, 4)) continue;
          if (path) path.push(s);
          if (texOut) texOut.push([s, ids.map((k) => gt[k])]);
        }
      }
    }
    // Can any of a cell's box (heights h0..h1) be on the canvas? A cheap test through the camera
    // frame (no lens: generous margins, the lens sees wider at its edges), before projecting anything.
    // frustum() once a frame first.
    let frus = null;
    function frustum() {
      const v = ar.view;
      const cv = ar.ctx.canvas;
      frus = null;
      if (!v) return; // (no view yet: everything counts as seen)
      const k = v.f * v.scale;
      frus = { x0: ((-v.cx - 60) / k) * 1.5, x1: ((cv.width - v.cx + 60) / k) * 1.5, y0: ((-v.cy - 60) / k) * 1.5, y1: ((cv.height - v.cy + 60) / k) * 1.5 };
    }
    function cellSeen(i, j, h0, h1) {
      if (!frus || !ar.camPoint) return true;
      const q = cellQuad(i, j, i, j, 0, -0.05);
      let l = 0;
      let rr = 0;
      let t = 0;
      let b = 0;
      let behind = 0;
      for (const p of q) {
        const wp0 = w.toWorld(p[0], p[1]);
        for (const h of [h0, h1]) {
          const [x, y, z] = ar.camPoint(wp0.x, wp0.y, h);
          if (z < 0.005) {
            behind++;
            continue;
          }
          if (x < frus.x0 * z) l++;
          else if (x > frus.x1 * z) rr++;
          if (y < frus.y0 * z) t++;
          else if (y > frus.y1 * z) b++;
        }
      }
      return !(behind === 8 || l === 8 || rr === 8 || t === 8 || b === 8);
    }
    // a quad already projected (corners s, or null): straight into `path` when it's whole and small,
    // else cut up by addQuad from its world points
    function addProjected(path, s, pts) {
      if (s && s.every(Boolean)) {
        if (offView(s, 4)) return;
        if (quadSize(s) < 110) {
          path.push(s);
          return;
        }
      }
      addQuad(path, pts);
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

    const ABYSS_D = 0.12; // m: how deep the ravine is drawn
    const ABYSS_COL = ["rgb(112,98,96)", "rgb(84,74,76)", "rgb(56,48,54)"]; // (under the rock texture, or without one)
    // the cliffs' shading: deeper darker; by the way a face turns from the light (left, far, right, near side of its cell)
    const ABYSS_SHADE = [0.04, 0.24, 0.46];
    const SIDE_SHADE = [0.0, 0.18, 0.3, 0.08];
    const PAD = 3; // sea drawn this many cells round the map (it's all sea out there)
    const WATER_DROP = 0.0045; // m: the water's rest level under its shore (its crests stay under the beach)
    // (scenery colours are opaque: the opacity slider alone lets the room show through -- Lynx.asScene)
    const LOOK = {
      ravine: "rgb(16,13,22)", // the ravine's bottom, far down
      path: "rgb(226,198,138)",
      grout: "rgba(70,48,22,0.8)",
      bridge: "rgba(150,235,255,0.85)",
      bridgeLine: "rgba(225,252,255,0.95)",
      ghost: "rgba(150,230,255,0.5)",
      fire: "rgba(150,50,20,0.55)",
      doused: "rgba(70,85,110,0.5)",
      spikes: "rgba(80,80,92,0.55)",
      sand: "rgb(236,208,140)",
      grass: "rgb(104,170,64)",
      bank: "rgb(150,118,74)", // the beach's edge down to the water
    };
    const GROUND = { grass: "rgb(98,150,60)", sand: "rgb(222,196,142)", dirt: "rgb(164,128,88)" };
    const GROUND_KINDS = ["grass", "sand", "dirt"];
    const walkTile = (ch) => "#SKEabABFf^vH".indexOf(ch) >= 0;
    const WATER = { top: "rgb(40,120,200)", side: "rgb(24,80,150)", ripple: "rgba(200,235,255,0.55)", berth: "rgba(255,255,255,0.85)" };

    // -- water in 3D: a swell of crests and troughs (mm high) rolling over every water cell, each
    // cell in 2 x 2 pieces whose corners rise and fall with it; the pieces are shaded by how high
    // they sit (troughs dark, crests light and frothy), one fill per shade
    const WAVE_A = 0.0055;
    const waveH = (f, r, t) => WAVE_A * (0.6 * Math.sin((f * 0.9 + r * 0.35) * 45 - t * 2.4) + 0.4 * Math.sin((r * 0.8 - f * 0.25) * 57 + t * 1.9));
    const NB = 6; // shades
    const shades = (a, b, alpha) => Array.from({ length: NB }, (_, k) => {
      const u = k / (NB - 1);
      return `rgba(${a.map((v, n) => Math.round(v + (b[n] - v) * u)).join(",")},${alpha})`;
    });
    const SEAS = {
      sea: shades([12, 50, 100], [150, 196, 232], 1),
      river: shades([30, 98, 172], [176, 216, 244], 1),
    };
    const newBuckets = () => Array.from({ length: NB }, () => []);
    // cell (i, j)'s water (its shore at height h) into buckets; `grow`: a hair bigger than the cell (no
    // seams). It rests WATER_DROP under the shore, and its waves die down toward the shore -- full
    // only a cell out -- so no crest rises over the beach (the surf runs up it instead: drawSwash).
    // Nearer cells in more pieces (3 x 3), far ones in fewer.
    function addWater(buckets, i, j, h, grow) {
      const [cf, cr] = cellCenterFR(i, j);
      const cam = w.camLocal();
      const dist = Math.hypot(cf - cam.f, cr - cam.r);
      const N = dist < 0.3 ? 3 : dist < 0.65 ? 2 : 1;
      const q = cellQuad(i, j, i, j, 0, -grow);
      const c0 = q[0];
      const du = [q[1][0] - q[0][0], q[1][1] - q[0][1]];
      const dv = [q[3][0] - q[0][0], q[3][1] - q[0][1]];
      const t = G.time;
      const lvl = h - WATER_DROP;
      // how far each corner is out on the water (1: open water all round it; 0: on a shore)
      const kind = (ii, jj) => {
        const c = tileAt(ii, jj);
        return wetTile(c) && Math.abs((isWater(c) ? baseAt(ii, jj) : 0) - h) < 1e-6;
      };
      const open = (a, b, c, d) => (kind(...a) && kind(...b) && kind(...c) && kind(...d) ? 1 : 0);
      const wNL = open([i, j], [i + 1, j], [i, j - 1], [i + 1, j - 1]);
      const wFL = open([i, j], [i - 1, j], [i, j - 1], [i - 1, j - 1]);
      const wFR = open([i, j], [i - 1, j], [i, j + 1], [i - 1, j + 1]);
      const wNR = open([i, j], [i + 1, j], [i, j + 1], [i + 1, j + 1]);
      // (along a shore, a flat layer under the pieces: the waves' edges leave no gap against the ground beside them)
      if (wNL + wFL + wFR + wNR < 4) addQuad(buckets.base, cellQuad(i, j, i, j, lvl, -grow));
      const pt = (a, b) => {
        const x = a / N;
        const y = b / N;
        const f = c0[0] + du[0] * x + dv[0] * y;
        const r = c0[1] + du[1] * x + dv[1] * y;
        const wg = (wNL * (1 - x) + wFL * x) * (1 - y) + (wNR * (1 - x) + wFR * x) * y;
        return [f, r, lvl + waveH(f, r, t) * wg];
      };
      const G1 = N + 1;
      const grid = [];
      for (let a = 0; a <= N; a++) {
        for (let b = 0; b <= N; b++) {
          const p = pt(a, b);
          grid.push({ p, s: w.project(p[0], p[1], p[2]) });
        }
      }
      for (let a = 0; a < N; a++) {
        for (let b = 0; b < N; b++) {
          const c4 = [grid[a * G1 + b], grid[(a + 1) * G1 + b], grid[(a + 1) * G1 + b + 1], grid[a * G1 + b + 1]];
          const pts = c4.map((c) => c.p);
          const e = (pts[0][2] + pts[1][2] + pts[2][2] + pts[3][2]) / 4 - lvl; // -A..A
          const k = Math.max(0, Math.min(NB - 1, Math.floor(((e / WAVE_A + 0.8) / 1.6) * NB)));
          addProjected(buckets[k], c4.map((c) => c.s), pts);
        }
      }
    }
    // the berths of the harbours (the waves themselves are the water's own now)
    function drawBerths() {
      const o = G.O;
      for (let i = 0; i < o.H; i++) {
        for (let j = 0; j < o.W; j++) {
          if (o.rows[i][j] !== "h") continue;
          const h = baseAt(i, j) - WATER_DROP + 0.0005 + waveH(...cellCenterFR(i, j), G.time);
          const [cf, cr] = cellCenterFR(i, j);
          const pts = ring(cf, cr, CELL * 0.48, h, 24);
          pts.push(pts[0]);
          ar.ctx.setLineDash([5, 4]);
          w.line3(pts, WATER.berth, 2, 0.02);
          ar.ctx.setLineDash([]);
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

    // -- textures: painted in the browser once (Lynx.paintedTexture), 128 px = two cells; the rock 256 px = four ---
    const TEX_ON = cfg.textures !== false && !!ar.texturedQuadScreen && !!Lynx.paintedTexture && !!Lynx.registerTexture;
    const TEX_CELL = 64; // texture pixels per cell
    if (TEX_ON) registerTextures();
    const tex = (name) => (TEX_ON ? Lynx.texture(name) : null);
    function registerTextures() {
      const blob = (g, wrap, x, y, r, inner, outer) =>
        wrap(x, y, r, (px, py) => {
          const gr = g.createRadialGradient(px, py, 0, px, py, r);
          gr.addColorStop(0, inner);
          gr.addColorStop(1, outer);
          g.fillStyle = gr;
          g.fillRect(px - r, py - r, 2 * r, 2 * r);
        });
      Lynx.registerTexture("runes_grass", Lynx.paintedTexture(41, (g, rnd, wrap, size, noise) => {
        g.fillStyle = GROUND.grass;
        g.fillRect(0, 0, size, size);
        for (let n = 0; n < 28; n++) blob(g, wrap, rnd() * size, rnd() * size, 8 + rnd() * 18, rnd() < 0.5 ? "rgba(150,196,84,0.35)" : "rgba(46,96,32,0.35)", "rgba(0,0,0,0)");
        g.lineWidth = 1;
        for (let n = 0; n < 1100; n++) {
          const x = rnd() * size;
          const y = rnd() * size;
          const l = 2 + rnd() * 4;
          const a = -Math.PI / 2 + (rnd() - 0.5) * 1.1;
          const c = rnd();
          g.strokeStyle = c < 0.45 ? "rgba(52,104,34,0.75)" : c < 0.85 ? "rgba(130,184,76,0.7)" : "rgba(176,214,104,0.75)";
          wrap(x, y, l, (px, py) => {
            g.beginPath();
            g.moveTo(px, py);
            g.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
            g.stroke();
          });
        }
        ["#fff6c8", "#f4d040", "#e88ab8", "#ffffff", "#f4d040", "#c8a0f0"].forEach((col) => {
          const x = rnd() * size;
          const y = rnd() * size;
          wrap(x, y, 2, (px, py) => {
            g.fillStyle = col;
            g.beginPath();
            g.arc(px, py, 1.4, 0, 2 * Math.PI);
            g.fill();
          });
        });
        noise(10);
      }));
      Lynx.registerTexture("runes_sand", Lynx.paintedTexture(43, (g, rnd, wrap, size, noise) => {
        g.fillStyle = GROUND.sand;
        g.fillRect(0, 0, size, size);
        for (let n = 0; n < 16; n++) blob(g, wrap, rnd() * size, rnd() * size, 10 + rnd() * 20, rnd() < 0.5 ? "rgba(246,226,176,0.4)" : "rgba(186,156,102,0.3)", "rgba(0,0,0,0)");
        // ripples the wind left: soft wavy lines across
        for (let n = 0; n < 9; n++) {
          const y0 = (n + rnd() * 0.5) * (size / 9);
          for (const [dy, col] of [[0, "rgba(255,240,200,0.35)"], [1.5, "rgba(150,118,70,0.28)"]]) {
            g.strokeStyle = col;
            g.lineWidth = 1.2;
            g.beginPath();
            for (let x = 0; x <= size; x += 4) {
              const y = y0 + dy + 2.2 * Math.sin((x / size) * Math.PI * 2 * 2 + n);
              if (x) g.lineTo(x, y);
              else g.moveTo(x, y);
            }
            g.stroke();
          }
        }
        for (let n = 0; n < 9; n++) {
          const x = rnd() * size;
          const y = rnd() * size;
          const rr = 0.8 + rnd() * 1.4;
          wrap(x, y, rr + 1, (px, py) => {
            g.fillStyle = rnd() < 0.5 ? "rgba(250,244,232,0.9)" : "rgba(140,120,100,0.8)";
            g.beginPath();
            g.ellipse(px, py, rr * 1.3, rr, rnd() * 3, 0, 2 * Math.PI);
            g.fill();
          });
        }
        noise(16);
      }));
      Lynx.registerTexture("runes_dirt", Lynx.paintedTexture(47, (g, rnd, wrap, size, noise) => {
        g.fillStyle = GROUND.dirt;
        g.fillRect(0, 0, size, size);
        for (let n = 0; n < 22; n++) blob(g, wrap, rnd() * size, rnd() * size, 8 + rnd() * 16, rnd() < 0.5 ? "rgba(196,160,112,0.4)" : "rgba(110,80,50,0.35)", "rgba(0,0,0,0)");
        for (let n = 0; n < 40; n++) {
          const x = rnd() * size;
          const y = rnd() * size;
          const rr = 1.2 + rnd() * 2.6;
          const shade = 110 + Math.floor(rnd() * 70);
          wrap(x, y, rr + 2, (px, py) => {
            g.fillStyle = "rgba(40,28,16,0.45)";
            g.beginPath();
            g.ellipse(px + 0.8, py + 0.9, rr * 1.2, rr, 0, 0, 2 * Math.PI);
            g.fill();
            g.fillStyle = `rgb(${shade},${shade - 8},${shade - 20})`;
            g.beginPath();
            g.ellipse(px, py, rr * 1.2, rr, 0, 0, 2 * Math.PI);
            g.fill();
            g.fillStyle = "rgba(255,255,255,0.25)";
            g.beginPath();
            g.ellipse(px - rr * 0.35, py - rr * 0.35, rr * 0.45, rr * 0.35, 0, 0, 2 * Math.PI);
            g.fill();
          });
        }
        noise(14);
      }));
      // the ravine's cliffs: layers of rock, worn, cracked down their faces
      Lynx.registerTexture("runes_rock", Lynx.paintedTexture(53, (g, rnd, wrap, size, noise) => {
        let y = 0;
        const tones = [[132, 118, 108], [112, 100, 96], [148, 132, 112], [96, 86, 86], [124, 108, 100], [140, 126, 120]];
        while (y < size) {
          const hgt = Math.min(size - y, 10 + Math.floor(rnd() * 22));
          const c = tones[Math.floor(rnd() * tones.length)];
          g.fillStyle = `rgb(${c[0]},${c[1]},${c[2]})`;
          g.fillRect(0, y, size, hgt);
          // (its lower edge: a dark seam, a lit lip over it)
          g.fillStyle = "rgba(30,22,26,0.45)";
          g.fillRect(0, y + hgt - 2, size, 2);
          g.fillStyle = "rgba(255,240,220,0.18)";
          g.fillRect(0, y, size, 1);
          y += hgt;
        }
        for (let n = 0; n < 40; n++) blob(g, wrap, rnd() * size, rnd() * size, 6 + rnd() * 18, rnd() < 0.5 ? "rgba(190,176,160,0.25)" : "rgba(40,30,40,0.3)", "rgba(0,0,0,0)");
        g.lineWidth = 1;
        for (let n = 0; n < 26; n++) {
          let x = rnd() * size;
          let yy = rnd() * size;
          g.strokeStyle = `rgba(26,18,22,${(0.35 + rnd() * 0.3).toFixed(2)})`;
          g.beginPath();
          g.moveTo(x, yy);
          const len = 8 + rnd() * 30;
          for (let s = 0; s < len; s += 3) {
            x += (rnd() - 0.5) * 3;
            yy += 3;
            g.lineTo(x, yy);
          }
          g.stroke();
        }
        noise(14);
      }, 256));
    }
    // A world quad with texture coordinates ([{u, v}] in texture pixels, its corners' order) -> pieces
    // small enough on the screen for the affine mapping (gridQuad), each with its coordinates
    function texPieces(out, pts, uv) {
      const s = projectAll(pts);
      let n = 4;
      if (s) {
        if (offView(s, 4)) return;
        const size = quadSize(s);
        if (size < 160) {
          out.push([s, uv]);
          return;
        }
        n = Math.min(5, Math.ceil(size / 160));
      }
      gridQuad(null, out, pts, uv, n);
    }
    const drawPieces = (list, img) => {
      if (!img) return;
      for (const [s, uv] of list) ar.texturedQuadScreen(s, img, uv);
    };
    // a cell's ground (its kind's colour, and its texture) at height h; on the floor it follows the hills
    function addGround(i, j, kind, h, flat, texd) {
      const q = cellQuad(i, j, i, j, h, -0.01);
      if (!h) {
        for (const p of q) p[2] = floorH(p[0], p[1]);
      }
      const u0 = (j & 1) * TEX_CELL;
      const v0 = (i & 1) * TEX_CELL;
      const uv = [{ u: u0, v: v0 + TEX_CELL }, { u: u0, v: v0 }, { u: u0 + TEX_CELL, v: v0 }, { u: u0 + TEX_CELL, v: v0 + TEX_CELL }];
      // (projected once: small and whole, the same corners take the colour and the texture)
      const s = q.map((p) => w.project(p[0], p[1], p[2]));
      if (s.every(Boolean)) {
        if (offView(s, 4)) return;
        const size = quadSize(s);
        if (size < 110) {
          flat[kind].push(s);
          if (TEX_ON) texd[kind].push([s, uv]);
          return;
        }
        // (big, near the camera: one grid for the colour and the texture)
        gridQuad(flat[kind], TEX_ON ? texd[kind] : null, q, uv, Math.min(6, Math.ceil(size / 110)));
        return;
      }
      addQuad(flat[kind], q);
      if (TEX_ON) texPieces(texd[kind], q, uv);
    }
    // The hills' light and shade: each plain cell in 3 x 3 pieces on the hills, darker where a slope
    // turns from the light, lighter where it faces it (the light low over the near left)
    const HILL_L = [-0.5, -0.85];
    const HILL_DARK = [1, 2, 3, 4].map((n) => `rgba(26,36,12,${(0.07 * n).toFixed(2)})`);
    const HILL_LIGHT = [1, 2, 3].map((n) => `rgba(255,248,214,${(0.06 * n).toFixed(2)})`);
    function drawHillShade() {
      const o = G.O;
      if (!o.hillCells || !o.hillCells.length) return;
      const dark = HILL_DARK.map(() => []);
      const light = HILL_LIGHT.map(() => []);
      const N = 3;
      const cv = ar.ctx.canvas;
      for (const [i, j] of o.hillCells) {
        if (!cellSeen(i, j, 0, HILL_A)) continue;
        const [cu, cvv] = cellUV(i, j);
        const [cf, cr] = toFR(cu, cvv);
        const c = w.project(cf, cr, 0);
        if (!c || c.x < -80 || c.y < -80 || c.x > cv.width + 80 || c.y > cv.height + 80 || c.ppm * CELL < 14) continue;
        const pts = [];
        for (let a = 0; a <= N; a++) {
          for (let b = 0; b <= N; b++) {
            const u = cu - CELL / 2 + (CELL * a) / N;
            const v = cvv - CELL / 2 + (CELL * b) / N;
            const [f, r] = toFR(u, v);
            const h = hillAtUV(u, v);
            pts.push({ h, s: w.project(f, r, h) });
          }
        }
        const P = (a, b) => pts[a * (N + 1) + b];
        for (let a = 0; a < N; a++) {
          for (let b = 0; b < N; b++) {
            const p00 = P(a, b);
            const p10 = P(a + 1, b);
            const p11 = P(a + 1, b + 1);
            const p01 = P(a, b + 1);
            if (!p00.s || !p10.s || !p11.s || !p01.s) continue;
            const hu = (p10.h + p11.h - p00.h - p01.h) / ((2 * CELL) / N);
            const hv = (p01.h + p11.h - p00.h - p10.h) / ((2 * CELL) / N);
            const d = -1.4 * (hu * HILL_L[0] + hv * HILL_L[1]);
            const k = Math.round(d / 0.045);
            if (!k) continue;
            const quad = [p00.s, p10.s, p11.s, p01.s];
            if (k < 0) dark[Math.min(dark.length - 1, -k - 1)].push(quad);
            else light[Math.min(light.length - 1, k - 1)].push(quad);
          }
        }
      }
      dark.forEach((p, n) => fillPath(p, HILL_DARK[n], null));
      light.forEach((p, n) => fillPath(p, HILL_LIGHT[n], null));
    }
    // The surf on the beaches: a sheet of water runs up the sand and slips back (quickly in, slowly
    // out), foam at its edge, the sand darker where it's wet
    const smooth = (x) => x * x * (3 - 2 * x);
    function drawSwash(t) {
      const o = G.O;
      if (!o.shore || !o.shore.length) return;
      const sheet = [];
      const foam = [];
      const damp = [];
      for (const e of o.shore) {
        if (!cellSeen(e.i, e.j, -WATER_DROP, 0.001)) continue;
        const [cf, cr] = cellCenterFR(e.i, e.j);
        const q = cellQuad(e.i, e.j, e.i, e.j, 0);
        const a = q[e.k];
        const b = q[(e.k + 1) % 4];
        const mf = (a[0] + b[0]) / 2;
        const mr = (a[1] + b[1]) / 2;
        // (d: a fraction of a cell, in from the water's edge)
        const inn = (p, d) => [p[0] + (cf - mf) * 2 * d, p[1] + (cr - mr) * 2 * d, 0.0006];
        const ph = (t * 0.16 + e.ph) % 1;
        const reach = ph < 0.25 ? smooth(ph / 0.25) : 1 - smooth((ph - 0.25) / 0.75);
        const s = 0.05 + 0.3 * reach;
        addQuad(damp, [inn(a, 0), inn(b, 0), inn(b, 0.42), inn(a, 0.42)]);
        addQuad(sheet, [inn(a, -0.03), inn(b, -0.03), inn(b, s), inn(a, s)]);
        if (reach > 0.06) addQuad(foam, [inn(a, s - 0.045), inn(b, s - 0.045), inn(b, s + 0.012), inn(a, s + 0.012)]);
      }
      fillPath(damp, "rgba(80,58,26,0.2)", null);
      fillPath(sheet, "rgba(150,206,236,0.55)", null);
      fillPath(foam, "rgba(250,252,255,0.8)", null);
    }

    function drawFloor() {
      if (!G.O || G.phase === "menu") return;
      const o = G.O;
      const t = G.time;
      const sea = newBuckets();
      const riverW = newBuckets();
      sea.base = [];
      riverW.base = [];
      const abyss = [0, 1, 2].map(() => [[], [], [], []]); // the cliffs down into the ravine: [depth band][side]
      const abyssTex = [];
      const ground = { grass: [], sand: [], dirt: [] };
      const groundTex = { grass: [], sand: [], dirt: [] };
      const bank = [];
      const ghostCells = [];
      const ravine = [];
      const bridges = [];
      const ghosts = [];
      const fires = [];
      const wet = [];
      const spikes = [];
      const waterSide = [];
      const cam = w.camLocal();
      const facing = (a, b, cf, cr) => {
        const mf = (a[0] + b[0]) / 2;
        const mr = (a[1] + b[1]) / 2;
        return (cam.f - mf) * (mf - cf) + (cam.r - mr) * (mr - cr) > 0;
      };
      const NB4 = [[0, -1], [-1, 0], [0, 1], [1, 0]]; // corner k -> k+1 of a cellQuad: its left, far, right, near side
      frustum();
      for (let i = -PAD; i < o.H + PAD; i++) {
        for (let j = -PAD; j < o.W + PAD; j++) {
          const ch = tileAt(i, j);
          const [cf, cr] = cellCenterFR(i, j);
          const hb = baseAt(i, j);
          if (!cellSeen(i, j, Math.min(0, hb) - ABYSS_D, hb + 0.01)) continue; // (off the canvas: nothing of it to draw)
          if (isWater(ch)) {
            // the river: its surface up at the shores' height, its sides down to the floor where it meets a gap
            const h = baseAt(i, j);
            addWater(riverW, i, j, h, 0.02);
            const top = cellQuad(i, j, i, j, h - WATER_DROP);
            for (let k = 0; k < 4; k++) {
              if (!isGap(tileAt(i + NB4[k][0], j + NB4[k][1]))) continue;
              const a = top[k];
              const b = top[(k + 1) % 4];
              if (!facing(a, b, cf, cr)) continue;
              addQuad(waterSide, [[a[0], a[1], 0], [b[0], b[1], 0], [b[0], b[1], a[2]], [a[0], a[1], a[2]]]);
            }
            continue;
          }
          if (baseAt(i, j)) {
            // raised: drawn standing (queued); under a raised bridge, the ravine
            if (ch === "~") addQuad(ravine, cellQuad(i, j, i, j, -ABYSS_D, -0.02));
            continue;
          }
          if (ch === "." || ch === "o") {
            addWater(sea, i, j, 0, 0.02); // (a hair bigger: no seams)
            continue;
          }
          if (ch === ":" || (ch === "~" && !lit(i, j))) {
            addQuad(ravine, cellQuad(i, j, i, j, -ABYSS_D, -0.02));
            if (ch === "~") {
              addQuad(ghosts, cellQuad(i, j, i, j, 0, -0.01)); // (one filled shape: no outline round each cell)
              ghostCells.push([i, j]);
            }
            continue;
          }
          if (ch === "~") {
            addQuad(bridges, cellQuad(i, j, i, j, 0, -0.01));
            continue;
          }
          if (!walkTile(ch) && !isScenery(ch)) continue;
          addGround(i, j, o.kind[i][j], 0, ground, groundTex);
          // the ground's edges: a cliff of rock down into the ravine, a bank down to the water (the sides the camera sees)
          const rim = cellQuad(i, j, i, j, 0);
          for (let k = 0; k < 4; k++) {
            const ni = i + NB4[k][0];
            const nj = j + NB4[k][1];
            const nc = tileAt(ni, nj);
            const a = rim[k];
            const b = rim[(k + 1) % 4];
            if (nc === ":" || (nc === "~" && !lit(ni, nj) && !baseAt(ni, nj))) {
              if (!facing(a, b, cf, cr)) continue;
              const u0 = ((i * 3 + j + k) & 3) * TEX_CELL;
              for (let n = 0; n < 3; n++) {
                const hi = (-n * ABYSS_D) / 3;
                const lo = hi - ABYSS_D / 3 - 0.0005;
                const quad = [[a[0], a[1], lo], [b[0], b[1], lo], [b[0], b[1], hi], [a[0], a[1], hi]];
                addQuad(abyss[n][k], quad);
                const v0 = n * 51;
                if (TEX_ON) texPieces(abyssTex, quad, [{ u: u0, v: v0 + 51 }, { u: u0 + TEX_CELL, v: v0 + 51 }, { u: u0 + TEX_CELL, v: v0 }, { u: u0, v: v0 }]);
              }
            } else if (nc === "." || nc === "o") {
              if (!facing(a, b, cf, cr)) continue;
              addQuad(bank, [[a[0], a[1], -WATER_DROP - 0.003], [b[0], b[1], -WATER_DROP - 0.003], [b[0], b[1], 0], [a[0], a[1], 0]]);
            }
          }
          if (ch === "F" || ch === "f") addQuad(doused(i, j) ? wet : fires, cellQuad(i, j, i, j, 0, 0.12));
          else if (ch === "^" || ch === "v") addQuad(spikes, cellQuad(i, j, i, j, 0, 0.12));
        }
      }
      // the ground and the water: scenery, at the scene's opacity (the camera view through it: the
      // setting; at 100% solid); fire, spikes, marks: solid
      Lynx.asScene(ar.ctx, () => {
        fillPath(ravine, LOOK.ravine, null);
        abyss.forEach((band, n) => band.forEach((side) => fillPath(side, ABYSS_COL[n], null)));
        drawPieces(abyssTex, tex("runes_rock"));
        abyss.forEach((band, n) => band.forEach((side, k) => fillPath(side, `rgba(12,8,22,${Math.min(0.9, ABYSS_SHADE[n] + SIDE_SHADE[k]).toFixed(3)})`, null)));
        fillPath(sea.base, SEAS.sea[1], null);
        sea.forEach((bucket, n) => fillPath(bucket, SEAS.sea[n], null));
        fillPath(bank, LOOK.bank, null);
        fillPath(waterSide, WATER.side, null);
        fillPath(riverW.base, SEAS.river[1], null);
        riverW.forEach((bucket, n) => fillPath(bucket, SEAS.river[n], null));
        for (const kind of GROUND_KINDS) {
          fillPath(ground[kind], GROUND[kind], null);
          drawPieces(groundTex[kind], tex(`runes_${kind}`));
        }
        drawHillShade();
        drawSwash(t);
        fillPath(bridges, LOOK.bridge, null);
      });
      drawBerths();
      const g = ar.ctx;
      // the ghost bridges nobody lights: a faint shimmer over where they would be, with a few
      // motes of light drifting over it (the Lantern stone makes them solid)
      fillPath(ghosts, `rgba(150,230,255,${(0.1 + 0.05 * Math.sin(t * 2.2)).toFixed(3)})`, null);
      for (const [i, j] of ghostCells) {
        const [cf, cr] = cellCenterFR(i, j);
        const a = t * 0.9 + i * 1.7 + j * 2.3;
        const q = w.project(cf + Math.cos(a) * CELL * 0.3, cr + Math.sin(a * 1.3) * CELL * 0.3, 0.012 + 0.005 * Math.sin(a * 2));
        if (q) ar.glow(q.x, q.y, Math.max(3, q.ppm * 0.006), [[0, "rgba(235,252,255,0.8)"], [1, "rgba(150,230,255,0)"]]);
      }
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
          if (!bridgeWorks(s)) return;
          drawBridgeDeck(s);
        } else if (tag === 2) {
          const wetDisc = [];
          addDisc(wetDisc, cf, cr, REACH * CELL);
          fillPath(wetDisc, "rgba(80,140,255,0.16)", null);
          ringLine(cf, cr, REACH * CELL, rgba(st.color, 0.8), 1.5, [6, 4]);
        } else if (tag === 3) {
          // the lantern's light: a pool on the floor, soft at its edge like a spotlight's (round, and drawn
          // piece by piece: what is out of the frame doesn't take the rest with it), and the cone from the lantern
          const wo = w.toWorld(cf, cr);
          ar.floorGlow(wo.x, wo.y, REACH * CELL, [255, 214, 90], 0.3 + 0.04 * Math.sin(t * 3), 0.3, 0, (x, y, h) => {
            const l = w.toLocal(x, y);
            return w.project(l.f, l.r, h);
          });
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
        // the keyhole: a black circle and a triangle below it (the circle towards the far end of the level)
        const [ff, fr] = cellCenterFR(i - 1, j);
        const l = Math.hypot(ff - cf, fr - cr) || 1;
        const df = (ff - cf) / l;
        const dr = (fr - cr) / l;
        const at = (a, b) => [cf + df * a - dr * b, cr + dr * a + df * b, h + 0.0004];
        const hole = "rgba(8,6,4,0.95)";
        poly([at(0.06 * CELL, 0), at(-0.24 * CELL, -0.1 * CELL), at(-0.24 * CELL, 0.1 * CELL)], hole, null);
        poly(ring(...at(0.08 * CELL, 0).slice(0, 2), CELL * 0.11, h + 0.0005, 14), hole, null);
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
      top: ["rgb(214,184,128)", "rgb(226,200,146)", "rgb(238,218,170)"], // 4, 8, 12+ cm: lighter higher up
      side: "rgb(150,110,62)",
      sideDark: "rgb(112,80,44)",
      line: "rgba(60,40,18,0.9)",
      course: "rgba(70,48,22,0.55)",
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
          // (skipped only when every corner, top and bottom, is behind the lens: with the camera
          // tilted down, a face's foot can be in front of it while its top is not)
          if (z < w.near && top.every((p) => w.camZ(...p) < w.near && w.camZ(p[0], p[1], h0) < w.near)) continue;
          const fs = top.map((p) => p[0]);
          const rs = top.map((p) => p[1]);
          ar.queue(z, () => {
            if (!on) {
              // an unlit raised bridge: only its ghostly outline, up in the air
              const g = ar.ctx;
              const q = [];
              addQuad(q, cellQuad(i, j, i, j, h, -0.01));
              fillPath(q, `rgba(150,230,255,${(0.12 + 0.05 * Math.sin(G.time * 2.2)).toFixed(3)})`, null);
              return;
            }
            // the sides that face the camera, down to the lower neighbour (or the floor)
            const sides = [];
            const dark = [];
            const rims = []; // the top's edges where the ground drops: the only lines (no tile borders)
            const courses = []; // a face's 4 cm courses: a line between each
            const sideTex = []; // (the sides' stone texture pieces)
            const allSides = [];
            const nb = [[0, -1], [-1, 0], [0, 1], [1, 0]]; // corner k -> k+1: left, far, right, near
            for (let k = 0; k < 4; k++) {
              const a = top[k];
              const b = top[(k + 1) % 4];
              const [ni, nj] = [i + nb[k][0], j + nb[k][1]];
              const nc = tileAt(ni, nj);
              const nh = bridge ? (baseAt(ni, nj) >= h - 1e-6 && (nc !== "~" || lit(ni, nj)) ? h : h0) : nc === ":" || (nc === "~" && !lit(ni, nj)) ? -ABYSS_D : nc === "~" ? 0 : isWater(nc) ? Math.min(h, baseAt(ni, nj) - WATER_DROP - 0.001) : nc === "." || nc === "o" ? -WATER_DROP - 0.001 : baseAt(ni, nj);
              if (nh >= h - 1e-6) continue;
              rims.push([a, b]);
              const mf = (a[0] + b[0]) / 2;
              const mr = (a[1] + b[1]) / 2;
              if ((cam.f - mf) * (mf - cf) + (cam.r - mr) * (mr - cr) <= 0) continue; // (faces away)
              const out = k % 2 ? sides : dark;
              // (in 4 cm courses from the top down: the stone's courses line up with the steps)
              for (let hi = h; hi > nh + 1e-6; hi -= bridge ? SLAB : RISE) {
                const lo = Math.max(nh, hi - (bridge ? SLAB : RISE));
                const quad = [[a[0], a[1], lo], [b[0], b[1], lo], [b[0], b[1], hi], [a[0], a[1], hi]];
                addQuad(out, quad);
                allSides.push(quad);
                if (TEX_ON && !bridge) {
                  const u0 = ((i + j * 3 + k) & 3) * TEX_CELL;
                  const v0 = (Math.round(hi / RISE) & 3) * 32;
                  const v1 = v0 + (32 * (hi - lo)) / RISE;
                  texPieces(sideTex, quad, [{ u: u0, v: v1 }, { u: u0 + TEX_CELL, v: v1 }, { u: u0 + TEX_CELL, v: v0 }, { u: u0, v: v0 }]);
                }
                if (lo > nh + 1e-6) courses.push([[a[0], a[1], lo], [b[0], b[1], lo]]);
              }
            }
            const g = ar.ctx;
            const ga = g.globalAlpha;
            g.globalAlpha = ga * Lynx.sceneAlpha(); // (scenery: see Lynx.sceneOpacity)
            fillPath(sides, bridge ? LOOK.bridge : RAISED.side, null);
            fillPath(dark, bridge ? LOOK.bridge : RAISED.sideDark, null);
            if (sideTex.length) {
              drawPieces(sideTex, tex("sandstone"));
              fillPath(dark, "rgba(30,18,6,0.3)", null); // (the faces turned from the light)
            }
            for (const c of courses) w.line3(c, RAISED.course, 1, 0.01);
            const rim = () => rims.forEach(([a, b]) => w.line3([[a[0], a[1], h], [b[0], b[1], h]], RAISED.line, 1.2, 0.01));
            if (cam.h <= h) {
              rim();
              g.globalAlpha = ga;
              return;
            }
            const tp = [];
            addQuad(tp, bridge ? top : cellQuad(i, j, i, j, h, -0.01)); // (a hair bigger: seamless)
            if (bridge) fillPath(tp, LOOK.bridge, LOOK.bridgeLine, 1.5);
            else if (ch === "H") {
              // a harbour's pier: wooden planks
              fillPath(tp, "rgb(150,100,56)", null);
              for (let k = 1; k < 4; k++) {
                const q = cellQuad(i, j, i, j, h + 0.0005);
                const lerp2 = (a, b, x) => [a[0] + (b[0] - a[0]) * x, a[1] + (b[1] - a[1]) * x, a[2]];
                w.line3([lerp2(q[0], q[1], k / 4), lerp2(q[3], q[2], k / 4)], "rgba(70,44,20,0.85)", 1.2, 0.01);
              }
            } else {
              const kind = G.O.kind[i][j];
              const gt = { grass: [], sand: [], dirt: [] };
              const gf = { grass: [], sand: [], dirt: [] };
              addGround(i, j, kind, h, gf, gt);
              fillPath(gf[kind], GROUND[kind], null);
              drawPieces(gt[kind], tex(`runes_${kind}`));
              // (higher up, a little lighter: the eye counts the steps)
              fillPath(tp, `rgba(255,246,220,${(0.05 * clamp(Math.round(h / RISE) - 1, 0, 2)).toFixed(2)})`, null);
            }
            if (!bridge) rim();
            g.globalAlpha = ga;
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
    const POLE_R = 0.0025; // m: the Lantern's pole (the only part of the stone the explorer bumps into)
    // Rain, Lantern, Key and Earth are drawn as what they do (a cloud, a lantern on a pole, a key, a heap
    // of sand), not as the cube; the explorer walks through the cube (the Lantern's pole aside). The
    // Helm in the River, the Bridge (out of the water) and the Weight stay stones.
    const bareTag = (tag) => (tag === 2 || tag === 3 || tag === 4 || tag === 5) && !(G.lv && G.lv.helm === tag);
    // (by its id: the engine makes the cubes anew each time it reads them -- before the stones are
    // found again from them -- so the very object is often the last time's)
    const liveStone = (b) => !!G.stones && !!G.stones[b.tag] && G.stones[b.tag].b.id === b.id;
    // the highest raised ground within a cell of a stone: what it hangs over (a cloud inside a block is no cloud)
    function groundNear(b) {
      const [ci, cj] = cellAt(b.cf, b.cr);
      let m = 0;
      for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) m = Math.max(m, baseAt(Math.round(ci) + di, Math.round(cj) + dj));
      return m;
    }
    const LANTERN_H = 0.13; // m above the floor
    const CLOUD_H = 0.075; // (low: in view with the stone)
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
      const top = w.project(b.cf, b.cr, groundNear(b) + LANTERN_H - 0.01);
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
      g.fillStyle = "rgba(255,225,120,0.09)";
      g.fill();
    }
    // a lantern hanging in the air above the stone
    function queueLantern(b) {
      const top = groundNear(b) + LANTERN_H;
      const p = w.project(b.cf, b.cr, top);
      if (!p) return;
      ar.queue(p.depth, () => {
        const g = ar.ctx;
        const s = Math.max(6, p.ppm * 0.022); // half its height, px
        // the pole: thin and black, from the floor up to the lantern's base
        const foot = w.project(b.cf, b.cr, b.h0);
        if (foot) {
          g.strokeStyle = "#0a0a0c";
          g.lineWidth = Math.max(1.5, p.ppm * POLE_R * 2);
          g.lineCap = "round";
          g.beginPath();
          g.moveTo(foot.x, foot.y);
          g.lineTo(p.x, p.y + s * 0.85);
          g.stroke();
        }
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
    let rainCloudCanvas = null;
    function queueRain(b) {
      const base = groundNear(b);
      const CH = base + CLOUD_H;
      const c = w.project(b.cf, b.cr, CH);
      const mid = w.camZ(b.cf, b.cr, CH / 2);
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
          const h = CH * 0.92 * (1 - k);
          const a = w.project(f, r, h + 0.014);
          const z = w.project(f, r, h);
          if (!a || !z) continue;
          g.moveTo(a.x, a.y);
          g.lineTo(z.x, z.y);
        }
        g.stroke();
        if (!c) return;
        // the cloud: cartoon puffs, a grey underside -- half see-through (what's behind it shows),
        // drawn whole on a canvas of its own first so its layers don't show through each other
        const s = Math.max(10, c.ppm * REACH * CELL * 0.5);
        const puffs = [[-0.55, 0.05, 0.42], [-0.2, -0.22, 0.5], [0.25, -0.18, 0.48], [0.6, 0.06, 0.38], [0.02, 0.1, 0.45]];
        const half = Math.ceil(s * 1.3);
        if (!rainCloudCanvas) rainCloudCanvas = document.createElement("canvas");
        const oc = rainCloudCanvas;
        if (oc.width < 2 * half || oc.height < 2 * half) {
          oc.width = Math.max(oc.width, 2 * half);
          oc.height = Math.max(oc.height, 2 * half);
        }
        const og = oc.getContext("2d");
        og.clearRect(0, 0, 2 * half, 2 * half);
        const draw = (color, dy, grow) => {
          og.fillStyle = color;
          og.beginPath();
          for (const [x, y, r] of puffs) {
            og.moveTo(half + x * s + r * s * grow, half + y * s + dy);
            og.arc(half + x * s, half + y * s + dy, r * s * grow, 0, Math.PI * 2);
          }
          og.fill();
        };
        draw("rgba(40,48,64,0.9)", 0, 1.08); // outline
        draw("rgba(150,162,185,1)", s * 0.08, 1);
        draw("rgba(236,241,250,1)", -s * 0.04, 0.9);
        const ga = g.globalAlpha;
        g.globalAlpha = ga * 0.5;
        g.drawImage(oc, 0, 0, 2 * half, 2 * half, c.x - half, c.y - half, 2 * half, 2 * half);
        g.globalAlpha = ga;
      });
    }
    // The Key: a golden key standing upright on its tip on the ground at the
    // stone's spot, turned to face the camera (no cube). Over the keyhole
    // (the socket, K) it slides down into it, up to its bow (G.keySink).
    function queueKey(b0) {
      const sink = G.keySock ? G.keySink || 0 : 0;
      let kf = b0.cf;
      let kr = b0.cr;
      if (G.keySock && sink > 0) {
        // (it slides in where the keyhole is: drawn to its middle as it goes down)
        const [sf, sr] = cellCenterFR(...G.keySock);
        const e = clamp(sink * 2.5, 0, 1);
        kf += (sf - kf) * e;
        kr += (sr - kr) * e;
      }
      const [ci, cj] = cellAt(kf, kr);
      const z0 = baseAt(Math.round(ci), Math.round(cj));
      const SHAFT = 0.03;
      const down = sink * (SHAFT - 0.003); // (into the keyhole: all of the shaft, the bow stays out)
      // its plane: upright, square to the way the camera looks at it
      const cam = w.camLocal();
      const a = Math.atan2(kr - cam.r, kf - cam.f);
      const sa = -Math.sin(a);
      const ca = Math.cos(a);
      const pt = (u, z) => [kf + sa * u, kr + ca * u, z0 + z - down];
      const mid = w.camZ(...pt(0, 0.02));
      if (mid < w.near) return;
      ar.queue(mid, () => {
        const g = ar.ctx;
        const P = (u, z) => w.project(...pt(u, z));
        // a rectangle of the key (u0..u1, z0..z1), only what's above the ground
        const rect = (u0, u1, za, zb, fill, stroke, lw) => {
          const lo = Math.max(za, down);
          if (zb <= lo) return;
          const q = [P(u0, lo), P(u1, lo), P(u1, zb), P(u0, zb)];
          if (q.some((x) => !x)) return;
          g.beginPath();
          q.forEach((x, k) => (k ? g.lineTo(x.x, x.y) : g.moveTo(x.x, x.y)));
          g.closePath();
          g.fillStyle = fill;
          g.fill();
          g.strokeStyle = stroke;
          g.lineWidth = lw;
          g.stroke();
        };
        const c = P(0, 0.03);
        if (!c) return;
        ar.glow(c.x, c.y, Math.max(8, c.ppm * 0.04), [[0, "rgba(255,230,120,0.45)"], [1, "rgba(255,210,60,0)"]]);
        g.save();
        g.lineJoin = "round";
        const lw = Math.max(1, c.ppm * 0.0011);
        const gold = "#f2c230";
        const edge = "rgba(90,60,6,0.95)";
        // the teeth near the tip, the shaft up from the ground
        rect(0.0018, 0.0085, 0.0035, 0.0085, gold, edge, lw);
        rect(0.0018, 0.0065, 0.0115, 0.016, gold, edge, lw);
        rect(-0.0022, 0.0022, 0, SHAFT, gold, edge, lw);
        // the bow on top: a ring
        const n = 16;
        const ringPts = (rad) => Array.from({ length: n }, (_, k) => P(Math.cos((k / n) * Math.PI * 2) * rad, SHAFT + 0.0095 + Math.sin((k / n) * Math.PI * 2) * rad));
        const outer = ringPts(0.0105);
        const inner = ringPts(0.0048);
        if (outer.every(Boolean) && inner.every(Boolean)) {
          g.beginPath();
          outer.forEach((x, k) => (k ? g.lineTo(x.x, x.y) : g.moveTo(x.x, x.y)));
          g.closePath();
          inner.forEach((x, k) => (k ? g.lineTo(x.x, x.y) : g.moveTo(x.x, x.y)));
          g.closePath();
          g.fillStyle = gold;
          g.fill("evenodd");
          g.strokeStyle = edge;
          g.lineWidth = lw;
          g.stroke();
        }
        // its shadow, where it stands
        const f0 = P(0, down);
        if (f0 && sink < 0.95) {
          g.fillStyle = "rgba(0,0,0,0.25)";
          g.beginPath();
          g.ellipse(f0.x, f0.y, Math.max(2, c.ppm * 0.004), Math.max(1, c.ppm * 0.0015), 0, 0, Math.PI * 2);
          g.fill();
        }
        g.restore();
      });
    }
    // The Earth: a heap of sand over the stone's reach, rounded, rising to the stone's spot; no cube
    function queueSand(b) {
      const R = REACH * CELL * 0.92;
      const H = 0.011;
      const N = 7;
      const mid = w.camZ(b.cf, b.cr, H / 2);
      if (mid < w.near) return;
      ar.queue(mid + R * 0.4, () => {
        const g = ar.ctx;
        for (let k = 0; k < N; k++) {
          const u = k / N; // 0: the foot, up to the top
          const rad = R * Math.sqrt(1 - u * u * 0.96); // (a dome: steep at the top, long gentle foot)
          const h = H * (1 - (1 - u) * (1 - u)) * 1.0;
          const shade = [188 + 50 * u, 154 + 56 * u, 98 + 52 * u];
          const pts = [];
          for (let n = 0; n < 28; n++) {
            const a = (n / 28) * Math.PI * 2;
            const rr = rad * (1 + 0.05 * Math.sin(3 * a + 1.3) + 0.03 * Math.sin(5 * a));
            const q = w.project(b.cf + Math.cos(a) * rr, b.cr + Math.sin(a) * rr, h);
            if (!q) return;
            pts.push(q);
          }
          g.beginPath();
          pts.forEach((q, n) => (n ? g.lineTo(q.x, q.y) : g.moveTo(q.x, q.y)));
          g.closePath();
          g.fillStyle = `rgba(${shade[0] | 0},${shade[1] | 0},${shade[2] | 0},0.97)`;
          g.fill();
          if (k === 0) {
            g.strokeStyle = "rgba(110,80,40,0.5)";
            g.lineWidth = 1;
            g.stroke();
          }
        }
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
    // The Bridge's planks (on the floor pass: under everything standing on it):
    // planks across, a beam along each side, the cube's pier in the middle
    const PLANK = ["rgb(160,112,62)", "rgb(146,100,54)", "rgb(171,122,70)"];
    function drawBridgeDeck(s) {
      const fb = bridgeFrame(s.b);
      const sp = bridgeSpan(s);
      const hw = BRIDGE_W * CELL;
      const P3 = (u, v, h) => [...api.fromB(fb, u, v), h];
      const H = 0.0015;
      const pl = 0.28 * CELL;
      const n = Math.max(1, Math.round((sp.a + sp.b) / pl));
      const d = (sp.a + sp.b) / n;
      Lynx.asScene(ar.ctx, () => {
        // its shadow on the water
        const sh = [];
        addQuad(sh, [P3(-sp.a, -hw * 1.15, 0), P3(sp.b, -hw * 1.15, 0), P3(sp.b, hw * 1.15, 0), P3(-sp.a, hw * 1.15, 0)]);
        fillPath(sh, "rgba(10,30,50,0.3)", null);
        for (let k = 0; k < n; k++) {
          const u0 = -sp.a + k * d + d * 0.06;
          const u1 = -sp.a + (k + 1) * d - d * 0.06;
          const q = [];
          addQuad(q, [P3(u0, -hw, H), P3(u1, -hw, H), P3(u1, hw, H), P3(u0, hw, H)]);
          fillPath(q, PLANK[k % 3], "rgba(60,36,16,0.85)", 1);
        }
        for (const sd of [-1, 1]) {
          const beam = [];
          addQuad(beam, [P3(-sp.a, sd * hw * 0.82, H + 0.0004), P3(sp.b, sd * hw * 0.82, H + 0.0004), P3(sp.b, sd * hw, H + 0.0004), P3(-sp.a, sd * hw, H + 0.0004)]);
          fillPath(beam, "rgb(110,72,36)", "rgba(50,30,12,0.9)", 1);
        }
      });
    }
    // its handrails: a post on each side every cell or so, a rail along their tops (queued, piece by piece)
    function queueBridgeRails(s) {
      const fb = bridgeFrame(s.b);
      const sp = bridgeSpan(s);
      const hw = BRIDGE_W * CELL;
      const RAIL = 0.011;
      const n = Math.max(1, Math.round((sp.a + sp.b) / CELL));
      const d = (sp.a + sp.b) / n;
      for (const sd of [-1, 1]) {
        for (let k = 0; k < n; k++) {
          const u0 = -sp.a + k * d;
          const u1 = u0 + d;
          const a3 = [...api.fromB(fb, u0, sd * hw * 0.92), 0];
          const b3 = [...api.fromB(fb, u1, sd * hw * 0.92), 0];
          const mid = w.camZ((a3[0] + b3[0]) / 2, (a3[1] + b3[1]) / 2, RAIL / 2);
          if (mid < w.near) continue;
          ar.queue(mid, () => {
            const p0 = w.project(a3[0], a3[1], RAIL);
            if (!p0) return;
            const lw = Math.max(1.5, p0.ppm * 0.0016);
            Lynx.asScene(ar.ctx, () => {
              const post = (q) => w.line3([[q[0], q[1], 0.0015], [q[0], q[1], RAIL + 0.001]], "rgb(96,62,30)", lw * 1.3, 0.01);
              post(a3);
              if (k === n - 1) post(b3);
              w.line3([[a3[0], a3[1], RAIL], [b3[0], b3[1], RAIL]], "rgb(122,82,42)", lw, 0.01);
            });
          });
        }
      }
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

    // the River's ship: a wooden hull sitting in the water, a deck, a mast with a sail
    const HULL = [[1, 0], [0.72, 0.62], [0.2, 1], [-0.75, 1], [-1, 0.72], [-1, -0.72], [-0.75, -1], [0.2, -1], [0.72, -0.62]];
    function queueShip() {
      const sh = G.ship;
      if (!sh) return;
      const c = Math.cos(sh.yaw);
      const sn = Math.sin(sh.yaw);
      // a ship at sea: it rolls side to side, pitches bow to stern, heaves up and down and
      // yaws a little, each at its own pace (so it never repeats exactly)
      const tm = G.time;
      const roll = 0.13 * Math.sin(tm * 1.45) + 0.04 * Math.sin(tm * 3.3 + 1);
      const pitch = 0.08 * Math.sin(tm * 1.1 + 0.8) + 0.025 * Math.sin(tm * 2.6);
      const heave = 0.0012 * Math.sin(tm * 1.9) + 0.0006 * Math.sin(tm * 3.7);
      const yawW = 0.05 * Math.sin(tm * 0.85 + 2);
      const cy = Math.cos(sh.yaw + yawW);
      const sy = Math.sin(sh.yaw + yawW);
      const cR = Math.cos(roll);
      const sR = Math.sin(roll);
      const cP = Math.cos(pitch);
      const sP = Math.sin(pitch);
      const P = (x, y, h) => {
        const hh = h - RISE; // above the water's surface
        const y1 = y * cR - hh * sR; // rolled about the ship's length
        const h1 = y * sR + hh * cR;
        const x1 = x * cP - h1 * sP; // pitched about its beam
        const h2 = x * sP + h1 * cP;
        return [sh.f + x1 * cy - y1 * sy, sh.r + x1 * sy + y1 * cy, RISE + h2 + heave];
      };
      const wl = RISE - 0.003; // the waterline (the hull's bottom shows a little under the surface)
      const deck = RISE + SHIP_DECK;
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

    // A real cube as a rune stone: dark carved stone at the back, its rune
    // large inside, the front faces like clouded glass so the rune shows
    // through -- the tag never shows. (No rune: a plain stone.)
    function queueStoneCube(b, st) {
      const cs = [];
      for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) cs.push(api.fromB(b, u * b.half, v * b.half));
      const mid = w.project(b.cf, b.cr, (b.h0 + b.h1) / 2);
      if (!mid) return;
      const fs = cs.map((c) => c[0]);
      const rs = cs.map((c) => c[1]);
      const col = st ? st.color : [150, 150, 160];
      ar.queue(mid.depth, () => {
        const c = w.camLocal();
        const g = ar.ctx;
        const front = [];
        const back = [];
        for (let k = 0; k < 4; k++) {
          const a = cs[k];
          const e = cs[(k + 1) % 4];
          const mf = (a[0] + e[0]) / 2;
          const mr = (a[1] + e[1]) / 2;
          const q = [[a[0], a[1], b.h0], [e[0], e[1], b.h0], [e[0], e[1], b.h1], [a[0], a[1], b.h1]];
          ((c.f - mf) * (mf - b.cf) + (c.r - mr) * (mr - b.cr) > 0 ? front : back).push(q);
        }
        const face = (q, fill, stroke, width = 1) => {
          const p = w.polyScreen(q, 1);
          if (p) w.fillPoly(p, fill, stroke, width);
        };
        // the back: solid stone, a little lit by the rune
        back.forEach((q) => face(q, `rgba(${(52 + col[0] * 0.12) | 0},${(54 + col[1] * 0.12) | 0},${(66 + col[2] * 0.12) | 0},0.97)`, null));
        face(cs.map(([f, r]) => [f, r, b.h0 + 0.0005]), "rgba(30,30,38,0.95)", null);
        // the rune, large, in the middle of the cube
        const top = w.project(b.cf, b.cr, b.h1);
        const bot = w.project(b.cf, b.cr, b.h0);
        if (top && bot) {
          const hpx = Math.max(10, Math.hypot(top.x - bot.x, top.y - bot.y));
          const glow = g.createRadialGradient(mid.x, mid.y, 0, mid.x, mid.y, hpx * 0.75);
          glow.addColorStop(0, `rgba(${col[0]},${col[1]},${col[2]},${st ? 0.55 + 0.15 * Math.sin(G.time * 3 + b.tag) : 0.15})`);
          glow.addColorStop(1, `rgba(${col[0]},${col[1]},${col[2]},0)`);
          g.fillStyle = glow;
          g.fillRect(mid.x - hpx, mid.y - hpx, 2 * hpx, 2 * hpx);
          if (st && b.tag === 1) weightOver(b);
          else if (st) {
            g.save();
            g.font = `${Math.round(hpx * 0.9)}px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif`;
            g.textAlign = "center";
            g.textBaseline = "middle";
            g.fillText(st.icon, mid.x, mid.y + hpx * 0.04);
            g.restore();
          }
        }
        // the front: clouded glass with the stone's edges, then the top
        front.forEach((q) => face(q, `rgba(${(170 + col[0] * 0.2) | 0},${(175 + col[1] * 0.2) | 0},${(190 + col[2] * 0.2) | 0},0.26)`, `rgba(${col[0]},${col[1]},${col[2]},0.9)`, 1.5));
        if (c.h > b.h1) face(cs.map(([f, r]) => [f, r, b.h1]), "rgba(200,205,220,0.3)", `rgba(${col[0]},${col[1]},${col[2]},0.9)`, 1.5);
      }, w.extent(Math.min(...fs), Math.max(...fs), Math.min(...rs), Math.max(...rs), b.h0, b.h1, cs));
    }

    // the things that stand up: queued, so the explorer and the cubes go in front / behind right
    // -- trees and rocks: round broadleaves and pointed firs; boulders, faceted and lit from one side ------------
    // A boulder: three rings of corners (foot, middle, top) round its cell's middle, a little irregular
    function rockShape(rnd) {
      const n = 8;
      const R = CELL * (0.4 + 0.06 * rnd());
      const H = 0.03 + 0.022 * rnd();
      const rings = [[0, 1], [0.5, 0.94], [1, 0.52]].map(([hf, rf]) =>
        Array.from({ length: n }, (_, k) => {
          const a = ((k + 0.25 * (rnd() - 0.5)) / n) * 2 * Math.PI;
          const rr = R * rf * (0.85 + 0.25 * rnd());
          return [Math.cos(a) * rr, Math.sin(a) * rr, H * hf * (hf === 1 ? 0.85 + 0.3 * rnd() : 1)];
        }),
      );
      const shade = 0.85 + 0.3 * rnd();
      return { rings, H, color: [128 * shade, 120 * shade, 112 * shade] };
    }
    const LIGHT3 = (() => {
      const l = [-0.5, -0.85, 1.1]; // (u, v, up): low over the near left, as the hills' light
      const n = Math.hypot(...l);
      return l.map((x) => x / n);
    })();
    // seen through when it stands between the camera and the explorer (or right in front of the lens)
    function sceneryAlpha(s, rad) {
      const cam = w.camLocal();
      const df = hero.f - cam.f;
      const dr = hero.r - cam.r;
      const L2 = df * df + dr * dr;
      const tt = L2 > 1e-9 ? ((s.cf - cam.f) * df + (s.cr - cam.r) * dr) / L2 : 0;
      let a = 1;
      if (tt > 0 && tt < 1) {
        const d = Math.hypot(cam.f + df * tt - s.cf, cam.r + dr * tt - s.cr);
        if (d < rad + 0.012) a = 0.3;
      }
      // (right in front of the lens it would fill the view: faded out as it comes nearer)
      const near = Math.hypot(s.cf - cam.f, s.cr - cam.r);
      return Math.min(a, clamp((near - 0.05) / 0.07, 0.25, 1));
    }
    function queueScenery() {
      const o = G.O;
      if (!o.scenery) return;
      const g = ar.ctx;
      for (const s of o.scenery) {
        const hb = baseAt(s.i, s.j) + floorH(s.cf, s.cr);
        const z = w.camZ(s.cf, s.cr, hb + 0.03);
        if (z < w.near) continue;
        const c = w.project(s.cf, s.cr, hb);
        if (!c || c.x < -300 || c.x > g.canvas.width + 300 || c.y < -400 || c.y > g.canvas.height + 300) continue;
        const ext = w.extent(s.cf - CELL / 2, s.cf + CELL / 2, s.cr - CELL / 2, s.cr + CELL / 2, hb, hb + (s.ch === "T" ? 0.085 * s.scale : 0.05));
        if (s.ch === "T") ar.queue(z, () => drawTree(s, hb), ext);
        else ar.queue(z, () => drawRock(s, hb), ext);
      }
    }
    function drawTree(s, hb) {
      const g = ar.ctx;
      const sc = s.scale;
      const [u0, v0] = cellUV(s.i, s.j);
      const at = (du, dv, h) => {
        const [f, r] = toFR(u0 + (s.du + du) * CELL, v0 + (s.dv + dv) * CELL);
        return w.project(f, r, hb + h);
      };
      const foot = at(0, 0, 0);
      if (!foot) return;
      g.save();
      g.globalAlpha *= Lynx.sceneAlpha() * sceneryAlpha(s, 0.02 * sc);
      // its shadow on the ground
      const sh = [];
      for (let k = 0; k < 12; k++) {
        const a = (k / 12) * 2 * Math.PI;
        const p = at(Math.cos(a) * 0.36 + 0.12, Math.sin(a) * 0.36 + 0.18, 0.0008);
        if (p) sh.push(p);
      }
      if (sh.length >= 3) fillPath([sh], "rgba(10,24,6,0.28)", null);
      const trunkTop = at(0, 0, (s.conifer ? 0.025 : 0.034) * sc);
      if (trunkTop) {
        const wd = Math.max(2, 0.0055 * sc * foot.ppm);
        g.lineCap = "round";
        g.strokeStyle = "rgba(30,18,10,0.9)";
        g.lineWidth = wd + 2;
        g.beginPath();
        g.moveTo(foot.x, foot.y);
        g.lineTo(trunkTop.x, trunkTop.y);
        g.stroke();
        g.strokeStyle = "rgb(110,74,44)";
        g.lineWidth = wd;
        g.stroke();
        g.strokeStyle = "rgba(255,230,190,0.25)";
        g.lineWidth = wd * 0.3;
        g.beginPath();
        g.moveTo(foot.x - wd * 0.2, foot.y);
        g.lineTo(trunkTop.x - wd * 0.2, trunkTop.y);
        g.stroke();
      }
      const green = s.tint < 0.5 ? [64, 132, 52] : [84, 146, 50];
      const rgb = (c, k) => `rgb(${Math.round(c[0] * k)},${Math.round(c[1] * k)},${Math.round(c[2] * k)})`;
      if (s.conifer) {
        // three tiers, each a cone: lit on its left, in shade on its right, an outline
        for (const [hBase, hTop, rad] of [[0.018, 0.05, 0.36], [0.036, 0.068, 0.28], [0.054, 0.088, 0.19]]) {
          const b = at(0, 0, hBase * sc);
          const tp = at(0, 0, hTop * sc);
          if (!b || !tp) continue;
          const half = rad * CELL * sc * b.ppm;
          const ry = half * 0.32;
          g.beginPath();
          g.moveTo(tp.x, tp.y);
          g.lineTo(b.x - half, b.y);
          g.ellipse(b.x, b.y, half, Math.max(1, ry), 0, Math.PI, 0, true);
          g.closePath();
          const gr = g.createLinearGradient(b.x - half, 0, b.x + half, 0);
          gr.addColorStop(0, rgb([50, 128, 74], 1.15));
          gr.addColorStop(0.55, rgb([40, 104, 60], 1));
          gr.addColorStop(1, rgb([24, 70, 40], 1));
          g.fillStyle = gr;
          g.fill();
          g.strokeStyle = "rgba(10,30,14,0.8)";
          g.lineWidth = 1.2;
          g.stroke();
        }
      } else {
        // a round crown of leaves: four clumps, far ones first, each lit from the upper left
        const clumps = [[0, 0, 0.06, 0.3], [0.17, 0.1, 0.05, 0.24], [-0.15, -0.12, 0.052, 0.24], [0.04, -0.14, 0.075, 0.21], [-0.06, 0.12, 0.073, 0.2]]
          .map(([du, dv, h, rad]) => ({ p: at(du, dv, h * sc), rad: rad * CELL * sc }))
          .filter((cl) => cl.p)
          .sort((x, y) => y.p.depth - x.p.depth);
        for (const cl of clumps) {
          const rr = Math.max(2, cl.rad * cl.p.ppm);
          g.beginPath();
          g.arc(cl.p.x, cl.p.y, rr + 1.2, 0, 2 * Math.PI);
          g.fillStyle = "rgba(14,34,10,0.85)";
          g.fill();
          g.beginPath();
          g.arc(cl.p.x, cl.p.y, rr, 0, 2 * Math.PI);
          const gr = g.createRadialGradient(cl.p.x - rr * 0.4, cl.p.y - rr * 0.45, rr * 0.1, cl.p.x, cl.p.y, rr);
          gr.addColorStop(0, rgb(green, 1.35));
          gr.addColorStop(0.6, rgb(green, 1));
          gr.addColorStop(1, rgb(green, 0.62));
          g.fillStyle = gr;
          g.fill();
          if (rr > 6) {
            // a few leaves catching the light
            g.fillStyle = "rgba(200,240,150,0.35)";
            for (let k = 0; k < 4; k++) {
              const a = k * 1.9 + s.i;
              g.beginPath();
              g.arc(cl.p.x - rr * 0.3 + Math.cos(a) * rr * 0.35, cl.p.y - rr * 0.3 + Math.sin(a) * rr * 0.3, rr * 0.12, 0, 2 * Math.PI);
              g.fill();
            }
          }
        }
      }
      g.restore();
    }
    function drawRock(s, hb) {
      const g = ar.ctx;
      const rk = s.rock;
      const [u0, v0] = cellUV(s.i, s.j);
      const cu = u0 + s.du * CELL * 0.4;
      const cv = v0 + s.dv * CELL * 0.4;
      const cam = w.camLocal();
      const [camU, camV] = toUV(cam.f, cam.r);
      const P = (p) => {
        const [f, r] = toFR(cu + p[0], cv + p[1]);
        return w.project(f, r, hb + p[2]);
      };
      const n = rk.rings[0].length;
      const faces = [];
      for (let ring = 0; ring < 2; ring++) {
        for (let k = 0; k < n; k++) {
          const a = rk.rings[ring][k];
          const b = rk.rings[ring][(k + 1) % n];
          faces.push([a, b, rk.rings[ring + 1][(k + 1) % n], rk.rings[ring + 1][k]]);
        }
      }
      faces.push(rk.rings[2].slice());
      const mid = [0, 0, rk.H * 0.45];
      g.save();
      g.globalAlpha *= Lynx.sceneAlpha() * sceneryAlpha(s, CELL * 0.45);
      g.lineJoin = "round";
      // (convex: the faces turned toward the camera are all there is to draw)
      for (const fc of faces) {
        const c = fc.reduce((m, p) => [m[0] + p[0] / fc.length, m[1] + p[1] / fc.length, m[2] + p[2] / fc.length], [0, 0, 0]);
        const e1 = [fc[1][0] - fc[0][0], fc[1][1] - fc[0][1], fc[1][2] - fc[0][2]];
        const e2 = [fc[2][0] - fc[0][0], fc[2][1] - fc[0][1], fc[2][2] - fc[0][2]];
        let nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const len = Math.hypot(...nn) || 1;
        nn = nn.map((x) => x / len);
        if (nn[0] * (c[0] - mid[0]) + nn[1] * (c[1] - mid[1]) + nn[2] * (c[2] - mid[2]) < 0) nn = nn.map((x) => -x);
        const toCam = [camU - cu - c[0], camV - cv - c[1], cam.h - hb - c[2]];
        if (nn[0] * toCam[0] + nn[1] * toCam[1] + nn[2] * toCam[2] <= 0) continue;
        const pts = fc.map(P);
        if (pts.some((p) => !p)) continue;
        const lit = 0.5 + 0.55 * Math.max(0, nn[0] * LIGHT3[0] + nn[1] * LIGHT3[1] + nn[2] * LIGHT3[2]);
        let col = rk.color.map((x) => x * lit);
        if (s.moss && nn[2] > 0.75) col = [col[0] * 0.75, col[1] * 1.05, col[2] * 0.6]; // (moss on its top)
        g.beginPath();
        pts.forEach((p, m) => (m ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        g.fillStyle = `rgb(${col.map((x) => Math.round(Math.min(255, x))).join(",")})`;
        g.fill();
        g.strokeStyle = "rgba(36,30,28,0.55)";
        g.lineWidth = 1;
        g.stroke();
      }
      g.restore();
    }

    function drawStanding() {
      if (!G.O || G.phase === "menu") return;
      const o = G.O;
      const t = G.time;
      const g = ar.ctx;
      queueRaised();
      queueScenery();
      queueShip();
      G.stones.forEach((s, tag) => {
        if (!s) return;
        if (tag === 0) {
          if (bridgeWorks(s)) queueBridgeRails(s);
        } else if (G.lv.helm === tag) {
          // (the River's Helm: a stone, drawn below)
        } else if (tag === 2) queueRain(s.b);
        else if (tag === 3) queueLantern(s.b);
        else if (tag === 4) queueKey(s.b);
        else if (tag === 5) queueSand(s.b);
      });
      // every real cube: a rune stone (the bridge's is under its middle, the river's under the water)
      api.realSolids.forEach((b) => {
        if (b.inferred || waterAt(b.cf, b.cr)) return;
        const st = G.stones[b.tag];
        if (b.tag === 0 && st && st.b === b && bridgeWorks(st)) return; // (the bridge's: under it, in the water; out of the water, a stone)
        if (bareTag(b.tag) && liveStone(b)) return; // (a cloud, a lantern, a key, a heap of sand: no cube)
        queueStoneCube(b, st && st.b === b ? stoneInfo(b.tag) : null);
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
    // A field archaeologist of this game's own: a wide-brimmed sun hat, auburn
    // hair in a low bun, a sage shirt with its sleeves rolled up, a red
    // neckerchief, khaki trousers into lace-up boots, and a leather satchel on
    // a strap across her chest. Each leg, each arm and the body is one part
    // (game_knight.js drawPrims): drawn whole, its outline under it, so its
    // pieces meet without lines or flicker between them.
    const EXPLORER = {
      outline: "rgba(22,16,12,0.92)", skin: "#d9a07a", hair: "#7a3a1e", hat: "#d2b67e", hatBand: "#5a3a22", shirt: "#8fa77a", cuff: "#78926a",
      scarf: "#c0392b", trousers: "#b59b6e", belt: "#4a2f1c", buckle: "#d8b45a", boots: "#5a3820", laces: "#2e1c10",
      satchel: "#8a5a32", strap: "#5e3a1e", eye: "#1a1410", mouth: "#9c4a40",
    };
    function explorerPrims(J, P) {
      const L = EXPLORER;
      const out = [];
      const seg = (a, b, rad, color, grp, bias) => out.push({ k: "seg", a: P(a), b: P(b), rad, color, grp, bias });
      const ball = (c, rad, color, grp, extra = {}) => out.push({ k: "ball", c: P(c), rad, color, grp, ...extra });
      const fwd = [Math.cos(J.twist), Math.sin(J.twist), 0];
      const right = [-Math.sin(J.twist), Math.cos(J.twist), 0];
      const back = V.mul(fwd, -1);
      const lerp3 = (a, b, t) => V.add(a, V.mul(V.add(b, V.mul(a, -1)), t));
      const body = "body";
      // legs: trousers to below the knee, lace-up boots
      for (const s2 of [-1, 1]) {
        const grp = `leg${s2}`;
        const bootTop = lerp3(J.knee[s2], J.ankle[s2], 0.42);
        seg(J.hip[s2], J.knee[s2], 0.0025, L.trousers, grp);
        seg(J.knee[s2], bootTop, 0.0022, L.trousers, grp);
        seg(bootTop, J.ankle[s2], 0.0021, L.boots, grp);
        seg(J.ankle[s2], J.toe[s2], 0.002, L.boots, grp);
        seg(lerp3(bootTop, J.ankle[s2], 0.25), lerp3(bootTop, J.ankle[s2], 0.3), 0.0022, L.laces, grp);
      }
      // the body: the trousers' seat, the shirt, the belt and its buckle, the shoulders
      seg(J.hip[-1], J.hip[1], 0.0033, L.trousers, body);
      seg(V.add(J.pelvis, V.mul(J.up, 0.002)), J.chest, 0.0046, L.shirt, body);
      seg(V.add(J.pelvis, V.mul(J.up, 0.0022)), V.add(J.pelvis, V.mul(J.up, 0.0036)), 0.0049, L.belt, body);
      ball(V.add(V.add(J.pelvis, V.mul(J.up, 0.0029)), V.mul(fwd, 0.0048)), 0.0009, L.buckle, body, { flat: true, noOutline: true });
      seg(J.sh[-1], J.sh[1], 0.0025, L.shirt, body);
      // the satchel at her left hip, its strap from the right shoulder across her chest
      const bag = V.add(V.add(J.pelvis, V.mul(right, -0.0064)), V.mul(J.up, 0.0012));
      seg(V.add(V.add(J.sh[1], V.mul(fwd, 0.0024)), [0, 0, 0.0004]), V.add(lerp3(J.pelvis, J.chest, 0.3), V.add(V.mul(fwd, 0.0046), V.mul(right, -0.0042))), 0.0007, L.strap, body, -0.0012);
      seg(V.add(V.add(J.sh[1], V.mul(back, 0.0024)), [0, 0, 0.0004]), V.add(lerp3(J.pelvis, J.chest, 0.3), V.add(V.mul(back, 0.0046), V.mul(right, -0.0042))), 0.0007, L.strap, body);
      seg(V.add(bag, V.mul(J.up, 0.0016)), V.add(bag, V.mul(J.up, -0.0016)), 0.0026, L.satchel, body);
      // the neck, the neckerchief knotted at the front
      seg(J.chest, J.neck, 0.0017, L.skin, body);
      ball(V.add(lerp3(J.chest, J.neck, 0.5), V.mul(fwd, 0.0017)), 0.0019, L.scarf, body);
      // arms: the sleeves rolled up above the elbow, bare forearms
      for (const s2 of [-1, 1]) {
        const grp = `arm${s2}`;
        const roll = lerp3(J.sh[s2], J.elbow[s2], 0.62);
        const cuffEnd = lerp3(J.sh[s2], J.elbow[s2], 0.82);
        seg(J.sh[s2], roll, 0.0018, L.shirt, grp);
        seg(roll, cuffEnd, 0.0019, L.cuff, grp);
        seg(cuffEnd, J.elbow[s2], 0.0014, L.skin, grp);
        seg(J.elbow[s2], J.hand[s2], 0.0013, L.skin, grp);
        ball(J.hand[s2], 0.0015, L.skin, grp);
      }
      // the head: her hair, a low bun, the face
      const hd = J.head;
      ball(V.add(hd, V.add(V.mul(back, 0.0012), [0, 0, 0.0004])), 0.0051, L.hair, body);
      ball(hd, 0.0047, L.skin, body);
      ball(V.add(V.add(hd, V.mul(back, 0.0052)), [0, 0, -0.0024]), 0.0022, L.hair, body);
      for (const s2 of [-1, 1]) ball(V.add(V.add(hd, V.mul(fwd, 0.0043)), V.add(V.mul(right, s2 * 0.0017), [0, 0, 0.0004])), 0.0006, L.eye, body, { flat: true, noOutline: true });
      ball(V.add(hd, V.add(V.mul(fwd, 0.0045), [0, 0, -0.0019])), 0.0006, L.mouth, body, { flat: true, noOutline: true });
      // the sun hat: a wide brim (dipping a little at the front), its band, its crown -- over the head
      const brimC = V.add(hd, [0, 0, 0.0033]);
      const brim = [];
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * 2 * Math.PI;
        brim.push(P(V.add(brimC, V.add(V.add(V.mul(fwd, Math.cos(a) * 0.0088), V.mul(right, Math.sin(a) * 0.0088)), [0, 0, -0.0007 * Math.cos(a)]))));
      }
      out.push({ k: "poly", pts: brim, color: L.hat, grp: body, bias: -0.0015 });
      seg(V.add(brimC, [0, 0, 0.0003]), V.add(brimC, [0, 0, 0.0011]), 0.004, L.hatBand, body, -0.0025);
      seg(V.add(brimC, [0, 0, 0.0011]), V.add(brimC, [0, 0, 0.0031]), 0.0036, L.hat, body, -0.003);
      return out;
    }
    // (opaque: only a fall or a hurt's blink makes her see-through -- not the camera's nearness)
    function drawExplorer(J) {
      const K = api.K;
      const prims = explorerPrims(J, K.placer(hero.f, hero.r, hero.z, hero.yaw, api.S));
      prims.forEach((p) => {
        if (p.rad) p.rad *= api.S;
        if (p.bias) p.bias *= api.S;
      });
      const alpha = G.fallT > 0 ? clamp(1 - G.fallT / FALL_S, 0, 1) : G.inv > 0.3 && G.inv < INV_S - 0.2 ? (Math.sin(G.time * 36) > 0 ? 0.45 : 1) : 1;
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
      // (the stones need no labels: each shows its rune inside, large)
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
        small ? "Tap a level · tap it again (or ▶): start" : `The level appears in front of the robot · click a level, again to start · LB / RB, Tab, 1-${Math.min(9, LEVELS.length)}: choose · Fire / A: start`,
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
      solids: () => (G.phase === "menu" || !G.O ? [] : gateSolids().concat(platSolids(), stoneColumns(), G.O.scenerySolids || [])),
      floorH,
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
          : "Explorer: stick / WASD · Jump: Space / A · Robot: right stick / arrows · Hint: H · Levels: L · Center: V · Opacity: RB / LB",
      onFire(state) {
        if (G.phase === "play" && G.ship) boardOrLeave();
        else confirm(state);
        return true; // (no sword)
      },
      // Jump (Space / gamepad A) does the same outside play: start, go on, try again
      onJump(state) {
        // (on the River, A boards / goes ashore where it can, as the hint says -- else it jumps)
        if (G.phase === "play") {
          if (G.ship && (G.ship.aboard || canBoard())) {
            boardOrLeave();
            return true;
          }
          return false;
        }
        confirm(state);
        return true;
      },
      unarmed: true,
      // a real cube in the river is under the water (a cube's height deep): not shown at all
      // every real cube in play is drawn by the game (a rune stone, under the
      // bridge, under the river) -- its tags never show
      hideBlock: (b) => !!G.O && G.phase !== "menu",
      // what the explorer bumps into: through the cloud, the key and the heap of sand; a thin
      // pole for the Lantern; the bridge's cube is under its deck (walked over)
      heroSolid: (b) => {
        if (!G.O || G.phase === "menu" || b.inferred || !liveStone(b)) return b;
        if (bareTag(b.tag)) return b.tag === 3 ? { ...b, half: POLE_R, h1: groundNear(b) + LANTERN_H } : null;
        if (b.tag === 0 && bridgeWorks(G.stones[0])) return null; // (the bridge's: under its deck)
        return b;
      },
      lowerView: true,
      drawHero: drawExplorer,
      onWeapon(wpn) {
        // in play: RB / LB (Tab / Shift + Tab) set the floors' and walls' opacity (more / less), not the camera zoom
        if (G.phase !== "menu") return Lynx.stepSceneOpacity(wpn);
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
