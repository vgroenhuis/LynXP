// Temple of LynXP -- a small Tomb Raider-style adventure laid out on the
// floor in front of the robot (about 2 x 3 m). Six levels, laid out afresh
// in front of the robot each time; the corridor levels (1 and 3) have three
// chambers, level 2 is the two-storey maze of game_temple_sanctum.js, level 4
// the three-wing labyrinth of game_temple_labyrinth.js, level 5 the floating
// sky citadel (game_temple_sky.js), level 6 the drowned cistern with its
// push blocks (game_temple_cistern.js); 5 and 6 build on game_temple_kit.js.
// Level 1, the upper temple:
//   1. the hall of pits: jump a spike pit and a lava channel, climb stone
//      blocks for treasure, fend off bats and a spirit;
//   2. the glyph floor: a lights-out puzzle (stepping on a glyph flips it and
//      its neighbours -- jump over the ones you don't want to flip) that opens
//      the portcullis, while scarabs crawl in;
//   3. the guardian: shoot its three crystals to drop its shield, then shoot
//      it; jump its floor shockwaves, dodge its fireballs.
// Level 2, the sunken sanctum: see game_temple_sanctum.js.
// Level 3, the lower temple:
//   1. the dart hall: a wide spike pit with a stepping stone in the middle, a
//      lava channel, and dart traps that shoot low across the floor -- jump
//      the darts;
//   2. the memory floor: glyphs light up one by one; step on them in the same
//      order (step off the floor to see it again). Mistakes call a scarab;
//   3. the obsidian guardian: four crystals, more health, angrier sooner.
// Jumping is virtual (ar.jump): the view rises, the robot stays on the floor.
// Temple coordinates: f = forward from the entrance, r = to the right (m),
// fixed where the robot stands when the game starts.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const HALF_W = 0.9; // half the corridor width
  const LEN = 3.05; // entrance (f = 0) to the back wall
  const START_F = 0.15;
  const WALL_H = 0.22;
  const PIT_D = 0.12; // pit depth below the floor
  const INVULNERABLE_S = 1.5;
  const TOUCH_M = 0.11;
  const NEAR = 0.06; // polygons are clipped this far in front of the lens
  const RING_SPEED = 0.45;

  const DIFFICULTY = {
    // scarabs: how many come to the glyph floor in all, one at a time, each
    // `scarabQuiet` seconds after the previous one is gone (time to think)
    // bats: how many guard the hall of pits, released one at a time; wisps: the spirits that
    // follow them (they dart sideways, hard to hit, but close in slowly); bossWisps: with the guardian
    // grid: the glyph floor's size (level 1); seqGrid, seq: the memory floor's size and how many
    // glyphs to remember (level 3); dartEvery: seconds between a trap's darts
    easy: { speed: 0.7, bossHp: 16, gap: 0.13, grid: 3, presses: 3, scarabs: 2, scarabQuiet: 25, bats: 1, batHp: 1, wisps: 1, bossWisps: 0, attackEvery: 5, vulnerable: 10, seqGrid: 4, seq: 7, dartEvery: 3.4 },
    normal: { speed: 1, bossHp: 24, gap: 0.16, grid: 3, presses: 5, scarabs: 4, scarabQuiet: 18, bats: 2, batHp: 1, wisps: 1, bossWisps: 1, attackEvery: 4, vulnerable: 8, seqGrid: 4, seq: 10, dartEvery: 2.8 },
    hard: { speed: 1.3, bossHp: 34, gap: 0.2, grid: 4, presses: 7, scarabs: 6, scarabQuiet: 12, bats: 3, batHp: 2, wisps: 2, bossWisps: 2, attackEvery: 3, vulnerable: 6, seqGrid: 4, seq: 12, dartEvery: 2.2 },
  };
  const LAST_LEVEL = 8;
  const SEQ_STEP_S = 0.9; // memory floor: each glyph shows this long (lit for SEQ_ON_S of it)
  const SEQ_ON_S = 0.65;
  const DART_H = 0.05; // darts fly this high: jump over them
  const DART_SPEED = 1.4;

  // -- sprites --------------------------------------------------------------------
  const GUARDIAN = [
    "..kk........kk..",
    "..kak......kak..",
    "..kaak....kaak..",
    "..kaaakkkkaaak..",
    ".kaaaaaaaaaaaak.",
    ".kaaaaaaaaaaaak.",
    "kaaeeeaaaaeeeaak",
    "kaaerraaaarreaak",
    "kaaeeeaaaaeeeaak",
    "kaaaaaaaaaaaaaak",
    ".kaaaaakkaaaaak.",
    ".kaaaaakkaaaaak.",
    "..kaaaaaaaaaak..",
    "..kggggggggggk..",
    "..kgbgbgbgbgbk..",
    "..kggggggggggk..",
    ".kkaaaaaaaaaakk.",
    "kaaaaaaaaaaaaaak",
    "kaaaakaaaakaaaak",
    "kkkkkkkkkkkkkkkk",
  ];
  const GUARDIAN_PAL = { k: "#2a1a08", a: "#c8a050", e: "#101010", r: "#ff3020", g: "#2050c0", b: "#e0c040" };
  const OBSIDIAN_PAL = { k: "#050508", a: "#3c3c4a", e: "#101010", r: "#40ff70", g: "#8a2090", b: "#e0c040" };
  const BAT = [
    "p............p",
    "pp...pppp...pp",
    "ppp.pppppp.ppp",
    "pppppwppwppppp",
    "pppppkppkppppp",
    ".pp.pppppp.pp.",
    "p....pwwp....p",
    "......pp......",
  ];
  const BAT_PAL = { p: "#6a4a3a", w: "#ffe060", k: "#200000" };
  const WISP = [
    "....cc....",
    "...cwwc...",
    "..cwwwwc..",
    ".cwwwwwwc.",
    ".cwkwwkwc.",
    ".cwkwwkwc.",
    "cwwwwwwwwc",
    "cwwwkkwwwc",
    "cwwwwwwwwc",
    "cwwwwwwwwc",
    "cwcwwcwwcc",
    "c..cc..c..",
  ];
  const WISP_PAL = { c: "#3aa0d8", w: "#d8f4ff", k: "#08243a" };
  // Sideways across your line of sight: lead your shots. It speeds up and
  // slows down (WISP_SIDE_ACCEL) instead of flipping direction on the spot,
  // which made it near impossible to hit.
  const WISP_SIDE_SPEED = 0.42; // m/s
  const WISP_SIDE_ACCEL = 0.9; // m/s^2: a full turnaround takes ~1 s
  const WISP_TURN_S = [0.9, 2.0]; // between changes of direction (random)
  const WISP_CLOSE_SPEED = 0.06; // m/s toward you: slow, so it never rushes you
  const SCARAB = [
    ".k......k.",
    "..kkkkkk..",
    ".kgghhggk.",
    "kkggggggkk",
    ".kggggggk.",
    "k.k.kk.k.k",
  ];
  const SCARAB_PAL = { k: "#101010", g: "#207060", h: "#60e0c0" };
  const GEM = ["..ccc..", ".cwccc.", "ccccccc", ".ccccc.", "..ccc..", "...c..."];
  const POTION = [".kkk.", "..k..", ".krk.", "krrrk", "krwrk", "krrrk", ".kkk."];
  const EYE = ["..kkkkk..", ".kwwwwwk.", "kwwgggwwk", "kwggkggwk", "kwwgggwwk", ".kwwwwwk.", "..kkkkk.."];
  const PISTOL = [
    "kkkkkkkkkkkkk.",
    "kcccccccccccck",
    "khhhhhhhhhhhck",
    "kkkkkkkcccccck",
    "......kcckcck.",
    "......kckkcck.",
    ".......kccck..",
    ".......kccck..",
    ".......kkkkk..",
  ];

  // Glyph shapes on the puzzle tiles: polylines in tile units (-0.5..0.5).
  const circle = (cx, cy, r, n = 10) => Array.from({ length: n + 1 }, (_, i) => [cx + r * Math.cos((i / n) * 2 * Math.PI), cy + r * Math.sin((i / n) * 2 * Math.PI)]);
  const GLYPHS = [
    [circle(0, -0.18, 0.12), [[0, -0.06], [0, 0.3]], [[-0.18, 0.06], [0.18, 0.06]]], // ankh
    [[[-0.3, 0], [-0.1, -0.13], [0.1, -0.13], [0.3, 0], [0.1, 0.13], [-0.1, 0.13], [-0.3, 0]], circle(0, 0, 0.06, 6)], // eye
    [[[0, -0.28], [0.26, 0.2], [-0.26, 0.2], [0, -0.28]], [[0, -0.05], [0, 0.1]]], // pyramid
    [[[-0.3, 0.15], [-0.15, -0.1], [0, 0.15], [0.15, -0.1], [0.3, 0.15]], [[-0.3, -0.2], [0.3, -0.2]]], // water
    [circle(0, 0, 0.12), [[0, -0.3], [0, -0.18]], [[0, 0.18], [0, 0.3]], [[-0.3, 0], [-0.18, 0]], [[0.18, 0], [0.3, 0]]], // sun
  ];

  const rand = (a, b) => a + Math.random() * (b - a);
  const inRect = (p, q) => p.f >= q.f0 && p.f <= q.f1 && p.r >= q.r0 && p.r <= q.r1;

  Lynx.games.temple = (ar, cfg) => {
    const d = DIFFICULTY[cfg.difficulty] || DIFFICULTY.normal;
    const maxHearts = cfg.hearts || 5;
    const aimAssist = cfg.aimAssist !== false;
    const firstLevel = Math.min(LAST_LEVEL, Math.max(1, Math.round(+cfg.startLevel) || 1));
    const img = {
      guardian1: Lynx.sprite(GUARDIAN, GUARDIAN_PAL),
      guardian2: Lynx.sprite(GUARDIAN, OBSIDIAN_PAL),
      heart: Lynx.sprite(EYE, { k: "#400010", w: "#ffc0d0", g: "#ff2050" }),
      bat: Lynx.sprite(BAT, BAT_PAL),
      wisp: Lynx.sprite(WISP, WISP_PAL),
      scarab: Lynx.sprite(SCARAB, SCARAB_PAL),
      gem: Lynx.sprite(GEM, { c: "#30e0a0", w: "#ffffff" }),
      bigGem: Lynx.sprite(GEM, { c: "#ff40a0", w: "#ffffff" }),
      potion: Lynx.sprite(POTION, { k: "#402020", r: "#ff3050", w: "#ffffff" }),
      eye: Lynx.sprite(EYE, { k: "#402800", w: "#fff0a0", g: "#30c0ff" }),
      pistol: Lynx.sprite(PISTOL, { c: "#505058", h: "rgba(255,255,255,0.45)", k: "#181818" }),
    };

    // -- the temple -------------------------------------------------------------------
    const G = d.gap;
    // An n x n floor of glyph tiles centered at f = fc (tiles: t m square).
    const makeGrid = (fc, n) => {
      const t = n === 3 ? 0.25 : 0.2;
      return { n, t, f0: fc - (n * t) / 2, f1: fc + (n * t) / 2, r0: (-n * t) / 2, r1: (n * t) / 2 };
    };
    const BOSS = { f: 2.85, r: 0 };
    const STONE = { f0: 0.3 + G, f1: 0.42 + G }; // level 3: the stepping stone in the wide spike pit
    const LEVELS = {
      1: {
        name: "the upper temple",
        startF: START_F, // where the robot stands when the level is laid out
        gateF: 2.07, // the portcullis
        grid: makeGrid(1.575, d.grid),
        puzzle: "lights",
        platforms: [
          { f0: 0.62, f1: 0.87, r0: -HALF_W, r1: -0.5, h: 0.15 },
          { f0: 0.87, f1: 1.07, r0: -HALF_W, r1: -0.5, h: 0.32 },
          { f0: 0.58, f1: 0.8, r0: 0.55, r1: HALF_W, h: 0.2 },
          { f0: 2.3, f1: 2.5, r0: -HALF_W, r1: -0.62, h: 0.15, pedestal: true },
          { f0: 2.3, f1: 2.5, r0: 0.62, r1: HALF_W, h: 0.15, pedestal: true },
        ],
        pits: [
          { f0: 0.38, f1: 0.38 + G, r0: -HALF_W, r1: HALF_W, kind: "spikes" },
          { f0: 0.9, f1: 0.9 + G, r0: -0.5, r1: HALF_W, kind: "lava" },
        ],
        traps: [],
        crystals: [{ f: 2.25, r: -0.55, h: 0.3 }, { f: 2.25, r: 0.55, h: 0.3 }, { f: 2.62, r: 0, h: 0.38 }],
        items: () => [
          { kind: "potion", f: 0.745, r: -0.7, base: 0.15 },
          { kind: "bigGem", f: 0.97, r: -0.7, base: 0.32 },
          { kind: "gem", f: 0.69, r: 0.72, base: 0.2 },
          // over the pits: grab them mid-jump
          { kind: "gem", f: 0.38 + G / 2, r: 0.3, base: 0.1, float: true },
          { kind: "gem", f: 0.9 + G / 2, r: 0.45, base: 0.1, float: true },
        ],
        bossHp: 1, // times the difficulty's
        rage: 0.5, // below this share of its health the guardian attacks double
        relic: "the Eye of LynXP",
        guardian: "guardian1",
        intro: "Chamber 1 -- the hall of pits: jump!",
        chamber2: "Chamber 2 -- light every glyph",
      },
      // a two-storey maze with keys, doors and switches: game_temple_sanctum.js
      2: {
        name: "the sunken sanctum",
        maze: "sanctum",
        startF: 0.15,
        gateF: 99,
        grid: makeGrid(-10, 3),
        puzzle: "none",
        platforms: [],
        pits: [],
        traps: [],
        crystals: [],
        items: () => [],
        bossHp: 1,
        rage: 0.5,
        relic: "the Sun Crown",
        winTitle: "THE CROWN IS YOURS",
        intro: "Level 2 -- the sunken sanctum: walls stop you here. Find a way up!",
      },
      3: {
        name: "the lower temple",
        // in the entrance, clear of the first dart lane (0.18 +- 0.08), so no dart hits you right at the start
        startF: -0.05,
        gateF: 2.2,
        grid: makeGrid(1.7, d.seqGrid),
        puzzle: "sequence",
        platforms: [
          { f0: STONE.f0, f1: STONE.f1, r0: -0.3, r1: 0.3, h: 0.1 },
          { f0: 0.06, f1: 0.26, r0: 0.55, r1: HALF_W, h: 0.18 },
          { f0: 2.45, f1: 2.65, r0: -HALF_W, r1: -0.62, h: 0.15, pedestal: true },
          { f0: 2.45, f1: 2.65, r0: 0.62, r1: HALF_W, h: 0.15, pedestal: true },
        ],
        pits: [
          // the stepping stone (a platform) stands in the middle of this one
          { f0: 0.3, f1: STONE.f1 + G, r0: -HALF_W, r1: HALF_W, kind: "spikes" },
          { f0: 1.05, f1: 1.05 + G, r0: -HALF_W, r1: HALF_W, kind: "lava" },
        ],
        // dart traps: a lane across the floor at f, shooting from the wall on `side` (-1 left, +1 right);
        // a dart hits within 0.08 m of the lane, so there's safe floor between the lane and the lava
        traps: [{ f: 0.18, side: -1 }, { f: 0.87, side: 1 }],
        // well past the portcullis (2.2), so they're in view when you come through
        crystals: [{ f: 2.45, r: -0.45, h: 0.3 }, { f: 2.45, r: 0.45, h: 0.3 }, { f: 2.7, r: 0, h: 0.38 }, { f: 2.55, r: -0.76, h: 0.45 }],
        items: () => [
          { kind: "potion", f: 0.16, r: 0.72, base: 0.18 },
          // high above the stepping stone: jump from the stone to reach it
          { kind: "bigGem", f: (STONE.f0 + STONE.f1) / 2, r: 0, base: 0.34, float: true },
          { kind: "gem", f: 0.3 + G / 2, r: 0.6, base: 0.1, float: true },
          { kind: "gem", f: 1.05 + G / 2, r: -0.4, base: 0.1, float: true },
          { kind: "gem", f: 2.55, r: 0.76, base: 0.15 },
        ],
        bossHp: 1.3,
        rage: 0.75,
        relic: "the Heart of LynXP",
        relicSprite: "heart", // what the relic (item "eye") looks like
        guardian: "guardian2",
        intro: "Level 3 -- the dart hall: jump the pits and the darts!",
        chamber2: "Chamber 2 -- watch the glyphs, then step on them in order",
      },
      // three wings over the same floor, portals, rotating doors: game_temple_labyrinth.js
      4: {
        name: "the clockwork labyrinth",
        maze: "labyrinth",
        startF: 0.15,
        gateF: 99,
        grid: makeGrid(-10, 3),
        puzzle: "none",
        platforms: [],
        pits: [],
        traps: [],
        crystals: [],
        items: () => [],
        bossHp: 1,
        rage: 0.5,
        relic: "the Moon Idol",
        winTitle: "THE MOON IDOL IS YOURS",
        intro: "Level 4 -- the clockwork labyrinth: doors turn, portals lead to other wings. Find the Moon Idol!",
      },
      // floating platforms in four tiers, climbing twice round: game_temple_sky.js
      5: {
        name: "the sky citadel",
        maze: "sky",
        startF: 0.15,
        gateF: 99,
        grid: makeGrid(-10, 3),
        puzzle: "none",
        platforms: [],
        pits: [],
        traps: [],
        crystals: [],
        items: () => [],
        bossHp: 1,
        rage: 0.5,
        relic: "the Sky Orb",
        winTitle: "THE SKY ORB IS YOURS",
        intro: "Level 5 -- the sky citadel: climb to the summit!",
      },
      // two sections, push blocks, flame vents, a boulder: game_temple_cistern.js
      6: {
        name: "the drowned cistern",
        maze: "cistern",
        startF: 0.15,
        gateF: 99,
        grid: makeGrid(-10, 3),
        puzzle: "none",
        platforms: [],
        pits: [],
        traps: [],
        crystals: [],
        items: () => [],
        bossHp: 1,
        rage: 0.5,
        relic: "the Tide Chalice",
        winTitle: "THE TIDE CHALICE IS YOURS",
        intro: "Level 6 -- the drowned cistern: drive into a stone block to push it",
      },
      // sunbeams, mirrors you shoot to turn, the robot as a mirror: game_temple_mirrors.js
      7: {
        name: "the hall of mirrors",
        maze: "mirrors",
        startF: 0.15,
        gateF: 99,
        grid: makeGrid(-10, 3),
        puzzle: "none",
        platforms: [],
        pits: [],
        traps: [],
        crystals: [],
        items: () => [],
        bossHp: 1,
        rage: 0.5,
        relic: "the Sun Disc",
        winTitle: "THE SUN DISC IS YOURS",
        intro: "Level 7 -- the hall of mirrors: shoot a mirror to turn it, and bend the sunbeams. They burn!",
      },
      // stealth: watchers' gazes, patrols, noisy gravel, gongs: game_temple_vault.js
      8: {
        name: "the watchers' vault",
        maze: "vault",
        startF: 0.15,
        gateF: 99,
        grid: makeGrid(-10, 3),
        puzzle: "none",
        platforms: [],
        pits: [],
        traps: [],
        crystals: [],
        items: () => [],
        bossHp: 1,
        rage: 0.5,
        relic: "the Crown of Eyes",
        winTitle: "THE CROWN OF EYES IS YOURS",
        intro: "Level 8 -- the watchers' vault: stay out of their gaze, and drive slowly on gravel",
      },
    };
    let level = firstLevel;
    let lv = LEVELS[level];
    let platforms = lv.platforms;
    let pits = lv.pits;
    let grid = lv.grid;
    let N = grid.n; // glyph tiles per side, and their size (m): the level's grid
    let T = grid.t;
    let gateF = lv.gateF;
    const tileCenter = (i, j) => ({ f: grid.f0 + (i + 0.5) * T, r: grid.r0 + (j + 0.5) * T });

    let anchor = null; // {x, y, th}: temple origin in the world
    let state = "title"; // title | playing | dead | levelDone | won
    let stateTime = 0;
    let elapsed = 0;
    let levelElapsed = 0;
    let levelBonus = 0;
    let traps = []; // level 3 dart traps: {f, side, t, dart: null | {r, hit}}
    let seq = []; // level 3 memory floor: tile indices to step on, in order
    let seqPos = 0;
    let seqPhase = "wait"; // wait | show | input
    let seqT = 0;
    let seqShown = -1;
    let score = 0;
    let hearts = maxHearts;
    let deaths = 0;
    let invulnerable = 0;
    let hurtFlash = 0;
    let cooldown = 0;
    let firePressed = false;
    let leftGun = false;
    let note = null; // {text, color, t}
    let chamber = 1;
    let batsReleased = false;
    let standingOn = null;
    let stuckIn = null; // platform entered below its top (you're "inside" it)
    let solid = null; // null | "block" | "gate"
    let outside = false;
    let wasAirborne = false;
    let items = [];
    let lit = [];
    let onTile = null; // "i,j" | "off"
    let gateOpen = false;
    let gateLift = 0;
    let scarabTimer = 0;
    let scarabsSent = 0;
    let batsSent = 0;
    let batTimer = 0;
    let bats = [];
    let wisps = []; // {f, r, h, dir, turnT, hp, phase, hit, retreat, rect}
    let wispsSent = 0;
    let wispTimer = 0;
    let scarabs = [];
    let boss = null;
    let crystals = [];
    let fireballs = [];
    let rings = [];
    let pendingRings = [];
    let tracers = [];
    let puffs = [];
    let best = null;
    let rankMsg = "";
    let godMode = false; // testing: Lynx.activeGame.debug.god(true) from the console
    let maze = null; // levels 2 and 4 to 8: their own file (game_temple_sanctum.js ...), while one is on
    Lynx.bestScore("temple").then((b) => (best = b));

    // -- coordinates -----------------------------------------------------------------
    function toWorld(f, r) {
      return {
        x: anchor.x + f * Math.cos(anchor.th) + r * Math.sin(anchor.th),
        y: anchor.y + f * Math.sin(anchor.th) - r * Math.cos(anchor.th),
      };
    }
    function toLocal(wx, wy) {
      const dx = wx - anchor.x;
      const dy = wy - anchor.y;
      return { f: dx * Math.cos(anchor.th) + dy * Math.sin(anchor.th), r: dx * Math.sin(anchor.th) - dy * Math.cos(anchor.th) };
    }
    const w3 = (f, r, h) => {
      const w = toWorld(f, r);
      return [w.x, w.y, h];
    };
    // distance of a world point in front of the lens (the projection's z)
    function camZ(x, y, h) {
      const rel = ar.toCamera(x, y);
      const vert = ar.cameraWorld().h - h;
      return rel.forward * Math.cos(ar.tilt) + vert * Math.sin(ar.tilt);
    }

    // World polygon -> screen polygon: edges subdivided (the lens bends
    // straight lines) and clipped just in front of the camera, so big floor
    // shapes around the robot still draw. Null if nothing is in front.
    function polyScreen(pts, seg = 4) {
      const dense = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        for (let k = 0; k < seg; k++) {
          const t = k / seg;
          dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
        }
      }
      const z = dense.map((p) => camZ(p[0], p[1], p[2]));
      const clipped = [];
      for (let i = 0; i < dense.length; i++) {
        const j = (i - 1 + dense.length) % dense.length;
        const inCur = z[i] >= NEAR;
        const inPrev = z[j] >= NEAR;
        if (inCur !== inPrev) {
          const t = (NEAR - z[j]) / (z[i] - z[j]);
          clipped.push(dense[j].map((v, k) => v + (dense[i][k] - v) * t));
        }
        if (inCur) clipped.push(dense[i]);
      }
      if (clipped.length < 3) return null;
      const out = [];
      clipped.forEach((p) => {
        const s = ar.project(p[0], p[1], p[2]);
        if (s) out.push(s);
      });
      return out.length >= 3 ? out : null;
    }

    function fillPoly(pts, fill, stroke, width = 1) {
      const c = ar.ctx;
      c.beginPath();
      pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.closePath();
      if (fill) {
        c.fillStyle = fill;
        c.fill();
      }
      if (stroke) {
        c.strokeStyle = stroke;
        c.lineWidth = width;
        c.stroke();
      }
    }

    // A line through temple points [f, r, h], sampled so it bends with the lens.
    function line3(points, color, width, stepM = 0.06) {
      const c = ar.ctx;
      c.strokeStyle = color;
      c.lineWidth = width;
      c.beginPath();
      let pen = false;
      for (let i = 0; i + 1 < points.length; i++) {
        const [f0, r0, h0] = points[i];
        const [f1, r1, h1] = points[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(f1 - f0, r1 - r0, h1 - h0) / stepM));
        for (let k = i ? 1 : 0; k <= n; k++) {
          const t = k / n;
          const w = toWorld(f0 + (f1 - f0) * t, r0 + (r1 - r0) * t);
          const h = h0 + (h1 - h0) * t;
          const p = camZ(w.x, w.y, h) >= NEAR ? ar.project(w.x, w.y, h) : null;
          if (!p) {
            pen = false;
            continue;
          }
          if (pen) c.lineTo(p.x, p.y);
          else c.moveTo(p.x, p.y);
          pen = true;
        }
      }
      c.stroke();
    }

    // Temple frame for exact draw ordering (ar.queue's box); cam is set at
    // the start of each frame.
    const frame = { cam: { f: 0, r: 0, h: 0 }, toWorld: (f, r) => toWorld(f, r) }; // toWorld: so ar.flush can tell which boxes overlap on screen
    const extent = (f0, f1, r0, r1, h0, h1) => ({ frame, f0, f1, r0, r1, h0, h1 });
    const pointAt = (wx, wy, h0, h1) => {
      const l = toLocal(wx, wy);
      return extent(l.f, l.f, l.r, l.r, h0, h1);
    };

    // Anything of a block in front of the lens? Its corners, not its middle:
    // at the end of a long ledge, looking away from its middle, the middle is
    // well behind you while the end you stand on is right in view.
    function boxInFront(q, h0, h1) {
      for (const f of [q.f0, q.f1]) {
        for (const r of [q.r0, q.r1]) {
          const w = toWorld(f, r);
          if (camZ(w.x, w.y, h0) >= NEAR || camZ(w.x, w.y, h1) >= NEAR) return true;
        }
      }
      return false;
    }

    // A stone block from (f0..f1, r0..r1), h0..h1: the sides that face the
    // camera, then the top if it's below the camera. Queued by depth.
    function box(q, h0, h1, col) {
      const cw = ar.cameraWorld();
      const me = toLocal(cw.x, cw.y);
      const mid = toWorld((q.f0 + q.f1) / 2, (q.r0 + q.r1) / 2);
      const depth = camZ(mid.x, mid.y, (h0 + h1) / 2);
      if (!boxInFront(q, h0, h1)) return;
      ar.queue(depth, () => {
        const faces = [];
        if (me.f < q.f0) faces.push([[q.f0, q.r0], [q.f0, q.r1], col.side]);
        if (me.f > q.f1) faces.push([[q.f1, q.r1], [q.f1, q.r0], col.side]);
        if (me.r < q.r0) faces.push([[q.f1, q.r0], [q.f0, q.r0], col.dark]);
        if (me.r > q.r1) faces.push([[q.f0, q.r1], [q.f1, q.r1], col.dark]);
        const img = texturesOn && col.tex ? Lynx.texture(col.tex) : null;
        faces.forEach(([a, b, fill]) => {
          const p = polyScreen([w3(a[0], a[1], h0), w3(b[0], b[1], h0), w3(b[0], b[1], h1), w3(a[0], a[1], h1)], 3);
          if (!p) return;
          fillPoly(p, fill, img ? null : col.line);
          if (img) {
            // textured stone, shaded by which way the face looks, and hazier with distance
            const m = toWorld((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
            const d = camZ(m.x, m.y, (h0 + h1) / 2);
            texFace(a, b, h0, h1, img, d < 0.7);
            const shade = (fill === col.dark ? 0.3 : 0.1) + Math.max(0, Math.min(0.3, (d - 0.6) * 0.12));
            fillPoly(p, `rgba(20,12,4,${shade.toFixed(3)})`, col.line);
          } else if (col.mortar && h1 - h0 > 0.1) {
            for (let h = h0 + 0.07; h < h1 - 0.02; h += 0.07) line3([[a[0], a[1], h], [b[0], b[1], h]], col.line, 1, 0.1);
          }
          // a door: decorate its broad faces (not the edges of a thin slab)
          if (col.door && Math.hypot(b[0] - a[0], b[1] - a[1]) >= 0.8 * Math.max(q.f1 - q.f0, q.r1 - q.r0)) doorFace(a, b, h0, h1, col);
        });
        if (cw.h > h1) {
          const p = polyScreen([w3(q.f0, q.r0, h1), w3(q.f1, q.r0, h1), w3(q.f1, q.r1, h1), w3(q.f0, q.r1, h1)], 3);
          if (p) {
            fillPoly(p, col.top, col.line);
            // stone tops get flagstones; any other color its own color with
            // slab joints and wear laid over it (col.topTex: which overlay,
            // false for none)
            if (img) texFloor(q, h1, "flagstone");
            else if (col.topTex !== false && (q.f1 - q.f0) * (q.r1 - q.r0) > 0.004) texFloor(q, h1, col.topTex || "slab");
          }
        }
        // a floating block seen from below (col.under: the color of its underside)
        if (col.under && cw.h < h0) {
          const p = polyScreen([w3(q.f0, q.r0, h0), w3(q.f0, q.r1, h0), w3(q.f1, q.r1, h0), w3(q.f1, q.r0, h0)], 3);
          if (p) fillPoly(p, col.under, col.line);
        }
      }, extent(q.f0, q.f1, q.r0, q.r1, h0, h1));
    }
    // The outer walls: a see-through bronze grating instead of stone, so near
    // the edge of the play area the camera still shows the real room beyond
    // (you'd drive into what a stone wall hides). Like box, each face the
    // camera sees: a faint tint, bars, and rails at the bottom, middle, top.
    const GRATE = { bar: "rgba(70,48,22,0.9)", rail: "rgba(120,86,40,0.95)", tint: "rgba(60,40,20,0.12)" };
    function fence(q, h0, h1) {
      const cw = ar.cameraWorld();
      const me = toLocal(cw.x, cw.y);
      const mid = toWorld((q.f0 + q.f1) / 2, (q.r0 + q.r1) / 2);
      const depth = camZ(mid.x, mid.y, (h0 + h1) / 2);
      if (!boxInFront(q, h0, h1)) return;
      ar.queue(depth, () => {
        const faces = [];
        if (me.f < q.f0) faces.push([[q.f0, q.r0], [q.f0, q.r1]]);
        if (me.f > q.f1) faces.push([[q.f1, q.r1], [q.f1, q.r0]]);
        if (me.r < q.r0) faces.push([[q.f1, q.r0], [q.f0, q.r0]]);
        if (me.r > q.r1) faces.push([[q.f0, q.r1], [q.f1, q.r1]]);
        faces.forEach(([a, b]) => {
          const p = polyScreen([w3(a[0], a[1], h0), w3(b[0], b[1], h0), w3(b[0], b[1], h1), w3(a[0], a[1], h1)], 3);
          if (p) fillPoly(p, GRATE.tint, null);
          const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
          const n = Math.max(1, Math.round(len / 0.05));
          // copper bars ~7 mm thick (in pixels at each one's own distance)
          const hm = (h0 + h1) / 2;
          let nearestPpm = 0;
          for (let k = 0; k <= n; k++) {
            const f = a[0] + ((b[0] - a[0]) * k) / n;
            const r = a[1] + ((b[1] - a[1]) * k) / n;
            const w = toWorld(f, r);
            const s = camZ(w.x, w.y, hm) >= NEAR ? ar.project(w.x, w.y, hm) : null;
            const ppm = s ? s.ppm : 400;
            nearestPpm = Math.max(nearestPpm, ppm);
            const barW = Math.max(2, Math.min(8, 0.007 * ppm));
            line3([[f, r, h0], [f, r, h1]], GRATE.bar, k === 0 || k === n ? barW * 1.6 : barW, 0.1);
          }
          const railW = Math.max(3, Math.min(9, 0.009 * nearestPpm));
          [h0 + 0.01, (h0 + h1) / 2, h1].forEach((h) => line3([[a[0], a[1], h], [b[0], b[1], h]], GRATE.rail, railW, 0.1));
        });
      }, extent(q.f0, q.f1, q.r0, q.r1, h0, h1));
    }
    // Does a map cell lie on the outer ring (drawn as grating: see fence)?
    const onRim = (i, j, rows, cols) => i === 0 || j === 0 || i === rows - 1 || j === cols - 1;

    // -- stone textures (ar.js makes them): fixed to the world in tiles of
    // TEX_WALL_M x TEX_STOREY_M on walls, TEX_FLOOR_M on floors, so the stone
    // stays put as you move. Surfaces are cut into small quads for drawing
    // (finer close up); quads the lens can't take are left to the flat fill
    // drawn under them.
    const texturesOn = cfg.textures !== false && typeof Lynx.texture === "function" && !!ar.texturedQuad;
    const TEX_PPM = 256 / 0.6; // texture pixels per meter
    const TEX_W = 256;
    const TEX_H = 128;
    const mod = (a, n) => {
      const m = ((a % n) + n) % n;
      return n - m < 0.01 ? 0 : m;
    };
    const cuts = (lo, hi, step) => {
      const out = [lo];
      for (let s = (Math.floor(lo / step + 1e-6) + 1) * step; s < hi - 1e-6; s += step) out.push(s);
      out.push(hi);
      return out;
    };
    // A wall face from temple point a to b ([f, r] each), h0..h1.
    function texFace(a, b, h0, h1, img, near) {
      const alongR = Math.abs(a[0] - b[0]) < 1e-9;
      const sA = alongR ? a[1] : a[0];
      const sB = alongR ? b[1] : b[0];
      const pt = (s, h) => (alongR ? w3(a[0], s, h) : w3(s, a[1], h));
      const ss = cuts(Math.min(sA, sB), Math.max(sA, sB), near ? 0.1 : 0.3);
      const hs = cuts(h0, h1, near ? 0.1 : 0.15);
      for (let i = 0; i + 1 < ss.length; i++) {
        const u0 = mod(ss[i] * TEX_PPM, TEX_W);
        const u1 = u0 + (ss[i + 1] - ss[i]) * TEX_PPM;
        for (let k = 0; k + 1 < hs.length; k++) {
          const v0 = mod(-hs[k + 1] * TEX_PPM, TEX_H); // the top of each storey is the texture's top
          const v1 = v0 + (hs[k + 1] - hs[k]) * TEX_PPM;
          ar.texturedQuad([pt(ss[i], hs[k + 1]), pt(ss[i + 1], hs[k + 1]), pt(ss[i + 1], hs[k]), pt(ss[i], hs[k])], img,
            [{ u: u0, v: v0 }, { u: u1, v: v0 }, { u: u1, v: v1 }, { u: u0, v: v1 }]);
        }
      }
    }
    // A floor rectangle at height h, textured where it's within reach of the
    // camera (beyond that the flat fill under it is enough). No-op if off.
    // Cut into 0.3 m pieces (one texture tile), quartered close to the
    // camera where the affine mapping needs smaller pieces. alpha: for the
    // detail overlays (ar.js) laid over a see-through floor.
    function texFloor(q, h, name, shade = 0, alpha = 1) {
      if (!texturesOn) return;
      const img = Lynx.texture(name);
      const cw = ar.cameraWorld();
      const me = toLocal(cw.x, cw.y);
      const R = 2.2;
      const f0 = Math.max(q.f0, me.f - R);
      const f1 = Math.min(q.f1, me.f + R);
      const r0 = Math.max(q.r0, me.r - R);
      const r1 = Math.min(q.r1, me.r + R);
      if (f0 >= f1 || r0 >= r1) return;
      const quad = (fa, fb, ra, rb) => {
        const u0 = mod(ra * TEX_PPM, 128);
        const v0 = mod(-fb * TEX_PPM, 128);
        const u1 = u0 + (rb - ra) * TEX_PPM;
        const v1 = v0 + (fb - fa) * TEX_PPM;
        ar.texturedQuad([w3(fb, ra, h), w3(fb, rb, h), w3(fa, rb, h), w3(fa, ra, h)], img,
          [{ u: u0, v: v0 }, { u: u1, v: v0 }, { u: u1, v: v1 }, { u: u0, v: v1 }]);
      };
      // (a faint overlay hides the affine warp: only right by the camera)
      const nearM = alpha < 1 ? 0.4 : 0.8 + Math.abs(cw.h - h);
      const c = ar.ctx;
      const oldAlpha = c.globalAlpha;
      c.globalAlpha = oldAlpha * alpha;
      const fs = cuts(f0, f1, 0.3);
      const rs = cuts(r0, r1, 0.3);
      for (let i = 0; i + 1 < fs.length; i++) {
        for (let j = 0; j + 1 < rs.length; j++) {
          const df = Math.max(0, fs[i] - me.f, me.f - fs[i + 1]);
          const dr = Math.max(0, rs[j] - me.r, me.r - rs[j + 1]);
          if (Math.hypot(df, dr) > nearM) {
            quad(fs[i], fs[i + 1], rs[j], rs[j + 1]);
            continue;
          }
          const sf = cuts(fs[i], fs[i + 1], 0.15);
          const sr = cuts(rs[j], rs[j + 1], 0.15);
          for (let a = 0; a + 1 < sf.length; a++) for (let b = 0; b + 1 < sr.length; b++) quad(sf[a], sf[a + 1], sr[b], sr[b + 1]);
        }
      }
      c.globalAlpha = oldAlpha;
      if (shade > 0) {
        const p = polyScreen([w3(q.f0, q.r0, h), w3(q.f1, q.r0, h), w3(q.f1, q.r1, h), w3(q.f0, q.r1, h)], 3);
        if (p) fillPoly(p, `rgba(20,12,4,${shade})`, null);
      }
    }

    // -- doors: a frame, a seam down the middle of a wide one, rows of studs
    // and a symbol, on a door face from temple point a to b ([f, r]), h0..h1
    // (a box face, or a swinging door's). Measured down from the top edge
    // over col.doorH (the door's full height), so on a door sinking into the
    // floor they sink with it (cut off at h0). col.symbol: keyhole, eye, sun,
    // wave or gear, in col.glyph.
    function doorFace(a, b, h0, h1, col) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.08 || h1 - h0 < 0.02) return;
      const H = col.doorH || h1 - h0;
      const at = (u, v) => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, Math.max(h0, h1 - v)];
      const trim = col.trim || "rgba(30,18,4,0.75)";
      const m = Math.min(0.018, len * 0.1);
      const mu = m / len;
      // frame and (wide doors) the seam between two leaves
      line3([at(mu, m), at(1 - mu, m), at(1 - mu, H - m), at(mu, H - m), at(mu, m)], trim, 2, 0.05);
      if (len > 0.2) line3([at(0.5, m), at(0.5, H - m)], trim, 2, 0.05);
      // studs along the top and bottom rails
      const c = ar.ctx;
      c.fillStyle = col.stud || "rgba(255,230,160,0.7)";
      const nStud = Math.max(2, Math.round(len / 0.05));
      for (let k = 1; k < nStud; k++) {
        for (const v of [m * 2, H - m * 2]) {
          if (h1 - v < h0) continue;
          const p = at(k / nStud, v);
          const w = toWorld(p[0], p[1]);
          const s = camZ(w.x, w.y, p[2]) >= NEAR ? ar.project(w.x, w.y, p[2]) : null;
          if (s) {
            c.beginPath();
            c.arc(s.x, s.y, Math.max(1, Math.min(4, 0.004 * s.ppm)), 0, 2 * Math.PI);
            c.fill();
          }
        }
      }
      if (!col.symbol) return;
      // the symbol, centered a little above the middle; on a double door one on each leaf
      const R = Math.min(len > 0.2 ? len / 4 : len / 2, H / 2) * 0.55;
      const centers = len > 0.2 ? [0.25, 0.75] : [0.5];
      const glyph = col.glyph || "#ffd84a";
      const shape = (uc, vc, pts, fill, stroke = "rgba(20,10,0,0.8)") => {
        const poly = polyScreen(pts.map(([x, y]) => {
          const p = at(uc + (x * R) / len, vc - y * R);
          return w3(p[0], p[1], p[2]);
        }), 2);
        if (poly) fillPoly(poly, fill, stroke, 1.5);
      };
      const circle = (n, rad, x0 = 0, y0 = 0) => Array.from({ length: n }, (_, i) => [x0 + rad * Math.cos((i / n) * 2 * Math.PI), y0 + rad * Math.sin((i / n) * 2 * Math.PI)]);
      centers.forEach((uc) => {
        const vc = H * 0.45;
        if (h1 - vc - R < h0) return; // sunk out of sight
        switch (col.symbol) {
          case "keyhole":
            shape(uc, vc, circle(16, 0.95), glyph);
            shape(uc, vc, circle(12, 0.32, 0, 0.25), "#140a02", null);
            shape(uc, vc, [[-0.14, 0.2], [0.14, 0.2], [0.24, -0.6], [-0.24, -0.6]], "#140a02", null);
            break;
          case "eye":
            shape(uc, vc, Array.from({ length: 16 }, (_, i) => {
              const t = (i / 16) * 2 * Math.PI;
              return [Math.cos(t), 0.5 * Math.sin(t) * Math.abs(Math.sin(t)) ** 0.2];
            }), glyph);
            shape(uc, vc, circle(12, 0.36), "#1a4060", null);
            shape(uc, vc, circle(8, 0.14), "#050505", null);
            break;
          case "sun":
            for (let k = 0; k < 8; k++) {
              const t = (k / 8) * 2 * Math.PI;
              const n = [Math.cos(t), Math.sin(t)];
              const s = [-n[1] * 0.14, n[0] * 0.14];
              shape(uc, vc, [[n[0] * 0.55 + s[0], n[1] * 0.55 + s[1]], [n[0] * 1.0, n[1] * 1.0], [n[0] * 0.55 - s[0], n[1] * 0.55 - s[1]]], glyph);
            }
            shape(uc, vc, circle(14, 0.5), glyph);
            break;
          case "wave":
            for (let k = -1; k <= 1; k++) {
              const pts = [];
              for (let i = 0; i <= 8; i++) pts.push([-0.9 + (1.8 * i) / 8, k * 0.5 + 0.12 * Math.sin((i / 8) * 4 * Math.PI)]);
              for (let i = 8; i >= 0; i--) pts.push([-0.9 + (1.8 * i) / 8, k * 0.5 - 0.14 + 0.12 * Math.sin((i / 8) * 4 * Math.PI)]);
              shape(uc, vc, pts, glyph, null);
            }
            break;
          case "gear": {
            const pts = [];
            for (let i = 0; i < 32; i++) {
              const t = (i / 32) * 2 * Math.PI;
              const rr = i % 4 < 2 ? 1 : 0.78;
              pts.push([rr * Math.cos(t), rr * Math.sin(t)]);
            }
            shape(uc, vc, pts, glyph);
            shape(uc, vc, circle(12, 0.3), "#2a1a06", null);
            break;
          }
        }
      });
    }

    // The see-through floors (the real one shows through): slab joints and
    // wear laid lightly over them, so they read as stone.
    const FLOOR_DETAIL_ALPHA = 0.55;
    const floorDetail = (q, h = 0.001) => texFloor(q, h, "slab", 0, FLOOR_DETAIL_ALPHA);

    const SANDSTONE = { top: "#d8b878", side: "#a88848", dark: "#806430", line: "rgba(40,25,10,0.55)", mortar: true, tex: "sandstone" };
    const BLOCK = { top: "#c8a868", side: "#98783c", dark: "#705426", line: "rgba(40,25,10,0.6)", mortar: true, tex: "sandstone" };
    const PEDESTAL = { top: "#b0a090", side: "#807060", dark: "#605040", line: "rgba(20,15,10,0.6)", tex: "crypt" };

    // -- game flow -------------------------------------------------------------------
    function say(text, color = "#ffe080") {
      note = { text, color, t: 0 };
    }

    function newGame() {
      score = 0;
      hearts = maxHearts;
      deaths = 0;
      elapsed = 0;
      startLevel(firstLevel);
    }

    // Lay out a level in front of the robot, where it stands now.
    function startLevel(n) {
      level = n;
      lv = LEVELS[n];
      platforms = lv.platforms;
      pits = lv.pits;
      grid = lv.grid;
      N = grid.n;
      T = grid.t;
      gateF = lv.gateF;
      if (ar.setCeiling) ar.setCeiling(Infinity); // (level 2 sets one under its upper floor)
      anchor = {
        x: ar.pose.x - lv.startF * Math.cos(ar.pose.theta),
        y: ar.pose.y - lv.startF * Math.sin(ar.pose.theta),
        th: ar.pose.theta,
      };
      hearts = maxHearts;
      levelElapsed = 0;
      chamber = 1;
      batsReleased = false;
      scarabsSent = 0;
      batsSent = 0;
      wispsSent = 0;
      wispTimer = 0;
      gateOpen = false;
      gateLift = 0;
      standingOn = stuckIn = null;
      onTile = null;
      bats = [];
      wisps = [];
      scarabs = [];
      fireballs = [];
      rings = [];
      pendingRings = [];
      items = lv.items();
      traps = lv.traps.map((t, k) => ({ ...t, t: (d.dartEvery * (k + 1)) / (lv.traps.length + 1), dart: null }));
      if (lv.puzzle === "lights") {
        // glyph floor: all lit, then scrambled by random presses (so it's solvable)
        lit = new Array(N * N).fill(true);
        do {
          const picks = new Set();
          while (picks.size < d.presses) picks.add(Math.floor(Math.random() * N * N));
          lit.fill(true);
          picks.forEach((k) => flip(Math.floor(k / N), k % N));
        } while (lit.every(Boolean));
      } else if (lv.puzzle === "sequence") {
        // memory floor: a random order of glyphs, never the same one twice in a row
        seq = [];
        while (seq.length < d.seq) {
          const k = Math.floor(Math.random() * N * N);
          if (k !== seq[seq.length - 1]) seq.push(k);
        }
        seqPos = 0;
        seqPhase = "wait";
        seqT = 1.5;
        seqShown = -1;
        lit = new Array(N * N).fill(false);
      }
      const hp = Math.round(d.bossHp * lv.bossHp);
      boss = { hp, maxHp: hp, state: "sleep", attackT: 3, attackN: 0, openT: 0, hit: 0, t: 0, rect: null };
      spawnCrystals();
      const MAZES = { sanctum: "templeSanctum", labyrinth: "templeLabyrinth", sky: "templeSky", cistern: "templeCistern", mirrors: "templeMirrors", vault: "templeVault" };
      maze = lv.maze ? Lynx[MAZES[lv.maze]](mazeApi) : null;
      state = "playing";
      stateTime = 0;
      invulnerable = 1;
      wasAirborne = false;
      say(lv.intro);
      Lynx.sfx.play("levelup");
    }

    function spawnCrystals() {
      crystals = lv.crystals.map((c) => ({ ...c, hp: 3, alive: true, spin: Math.random() * 6, rect: null }));
    }

    // memory floor: show the order again from the start
    function replaySequence(wait) {
      seqPos = 0;
      seqPhase = "wait";
      seqT = wait;
      seqShown = -1;
    }

    // lights-out: a glyph and its four neighbours flip
    function flip(i, j) {
      [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([di, dj]) => {
        const a = i + di;
        const b = j + dj;
        if (a >= 0 && a < N && b >= 0 && b < N) lit[a * N + b] = !lit[a * N + b];
      });
    }

    function hurt(why) {
      if (invulnerable > 0 || state !== "playing") return false;
      if (godMode) {
        invulnerable = INVULNERABLE_S;
        return false;
      }
      hearts--;
      invulnerable = INVULNERABLE_S;
      hurtFlash = 0.5;
      Lynx.sfx.play("hurt");
      if (why) say(why, "#ff6060");
      if (hearts <= 0) {
        state = "dead";
        stateTime = 0;
        deaths++;
        Lynx.sfx.play("lose");
      }
      return true;
    }

    // Back to life where you are: this chamber's enemies (and the guardian) start over.
    function carryOn() {
      hearts = maxHearts;
      score = Math.max(0, score - 500);
      bats = [];
      wisps = [];
      scarabs = [];
      fireballs = [];
      rings = [];
      pendingRings = [];
      if (boss.state !== "sleep" && boss.state !== "dead") {
        boss.hp = boss.maxHp;
        boss.state = "shielded";
        boss.attackT = 3;
        spawnCrystals();
      }
      if (lv.puzzle === "sequence" && !gateOpen) replaySequence(1.5);
      traps.forEach((t) => (t.dart = null));
      if (maze) maze.carryOn();
      state = "playing";
      stateTime = 0;
      invulnerable = 2;
      say("Back on your feet (-500)");
    }

    // The level's relic is taken: on to the next level, or the end.
    function relicTaken() {
      stateTime = 0;
      levelBonus = Math.max(0, Math.round(3000 - levelElapsed * 10)) + hearts * 300;
      score += levelBonus;
      if (level < LAST_LEVEL) {
        state = "levelDone";
        Lynx.sfx.play("levelup");
        return;
      }
      state = "won";
      rankMsg = "";
      Lynx.sfx.play("found");
      Lynx.submitScore("temple", score).then((rank) => {
        rankMsg = rank ? `#${rank} on this robot's scoreboard!` : "";
        if (rank === 1) best = score;
      });
    }

    // -- input -----------------------------------------------------------------------
    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title" || (state === "won" && stateTime > 2)) newGame();
      else if (state === "levelDone" && stateTime > 2) startLevel(level + 1);
      else if (state === "dead" && stateTime > 1.5) carryOn();
      else firePressed = true;
    });
    // returns whether jumping applies right now (see Lynx.jumpAction)
    Lynx.onAction("jump", () => state === "playing" && (ar.jump(), true));
    Lynx.touchButtons().add("⤒ Jump", () => Lynx.jumpAction());

    // -- shooting --------------------------------------------------------------------
    function targetAt(px, py) {
      const assistPx = aimAssist ? 0.04 * ar.view.w : 0;
      let hit = null;
      let bestMiss = Infinity;
      const consider = (obj, kind) => {
        const rect = obj.rect;
        if (!rect) return;
        const miss = Math.hypot(Math.max(rect.x - px, 0, px - (rect.x + rect.w)), Math.max(rect.y - py, 0, py - (rect.y + rect.h)));
        if (miss > assistPx) return;
        if (!hit || miss < bestMiss - 0.5 || (Math.abs(miss - bestMiss) <= 0.5 && rect.depth < hit.obj.rect.depth)) {
          hit = { obj, kind };
          bestMiss = miss;
        }
      };
      if (maze) {
        maze.targets().forEach((t) => consider(t.obj, t.kind));
        return hit;
      }
      bats.forEach((b) => consider(b, "bat"));
      wisps.forEach((w) => consider(w, "wisp"));
      scarabs.forEach((s) => consider(s, "scarab"));
      crystals.forEach((c) => c.alive && consider(c, "crystal"));
      if (boss.state !== "sleep" && boss.state !== "dead") consider(boss, "boss");
      return hit;
    }

    function tryFire() {
      if (cooldown > 0) return;
      cooldown = 0.26;
      leftGun = !leftGun;
      Lynx.sfx.play("pistol");
      const v = ar.view;
      const t = targetAt(v.cx, v.cy);
      const x0 = v.cx + (leftGun ? -0.2 : 0.2) * v.w;
      tracers.push({ x0, y0: v.y + v.h * 0.9, x1: t ? t.obj.rect.x + t.obj.rect.w / 2 : v.cx, y1: t ? t.obj.rect.y + t.obj.rect.h / 2 : v.cy, t: 0 });
      if (!t) return;
      if (maze) {
        maze.hit(t);
        return;
      }
      const o = t.obj;
      if (t.kind === "boss") {
        if (boss.state !== "open") {
          Lynx.sfx.play("knock"); // bounces off the shield
          return;
        }
        boss.hp--;
        boss.hit = 0.15;
        Lynx.sfx.play("pain");
        if (boss.hp <= 0) {
          boss.state = "dead";
          score += 3000;
          fireballs = [];
          rings = [];
          pendingRings = [];
          const w = toWorld(BOSS.f, BOSS.r);
          puffs.push({ x: w.x, y: w.y, h: 0.2, t: 0, big: true });
          Lynx.sfx.play("explode");
          items.push({ kind: "eye", f: BOSS.f - 0.15, r: BOSS.r, base: 0 });
          say(`The guardian crumbles! Take ${lv.relic}`, "#ffd84a");
        }
        return;
      }
      o.hp--;
      o.hit = 0.15;
      if (o.hp > 0) {
        Lynx.sfx.play(t.kind === "crystal" ? "zap" : "pain");
        return;
      }
      const p = o.x !== undefined ? o : { ...toWorld(o.f, o.r), h: o.h };
      puffs.push({ x: p.x, y: p.y, h: p.h || 0.03, t: 0, color: t.kind === "crystal" ? "120,200,255" : "255,230,200" });
      if (t.kind === "crystal") {
        o.alive = false;
        score += 150;
        Lynx.sfx.play("explode");
      } else {
        o.dead = true;
        score += t.kind === "wisp" ? 200 : t.kind === "bat" ? 100 : 50;
        Lynx.sfx.play("die");
      }
    }

    // -- update ----------------------------------------------------------------------
    function updateGround(me) {
      solid = null;
      let ground = 0;
      const plat = platforms.find((p) => inRect(me, p));
      if (stuckIn && stuckIn !== plat) stuckIn = null;
      if (plat && !stuckIn && (standingOn === plat || ar.feet() >= plat.h - 0.04)) {
        ground = plat.h;
        standingOn = plat;
      } else if (plat) {
        stuckIn = plat;
        standingOn = null;
        solid = "block";
      } else {
        standingOn = null;
        if (pits.some((p) => inRect(me, p))) ground = -PIT_D;
      }
      if (!gateOpen && me.f > gateF - 0.02 && me.f < LEN) solid = solid || "gate";
      outside = Math.abs(me.r) > HALF_W + 0.05 || me.f < -0.2 || me.f > LEN + 0.03;
      ar.setGround(ground);
    }

    function updateGlyphs(me) {
      if (ar.airborne || ar.ground !== 0 || solid) return; // only a foot on the floor presses
      let cand;
      if (me.f < grid.f0 - 0.02 || me.f > grid.f1 + 0.02 || me.r < grid.r0 - 0.02 || me.r > grid.r1 + 0.02) cand = "off";
      else {
        const i = Math.floor((me.f - grid.f0) / T);
        const j = Math.floor((me.r - grid.r0) / T);
        if (i < 0 || i >= N || j < 0 || j >= N) return;
        const c = tileCenter(i, j);
        if (Math.abs(me.f - c.f) > T * 0.36 || Math.abs(me.r - c.r) > T * 0.36) return; // near an edge: wait
        cand = `${i},${j}`;
      }
      if (cand === onTile) return;
      onTile = cand;
      if (gateOpen) return;
      if (lv.puzzle === "sequence") {
        pressSequence(cand);
        return;
      }
      if (cand === "off") return;
      const [i, j] = cand.split(",").map(Number);
      flip(i, j);
      Lynx.sfx.play("click");
      if (lit.every(Boolean)) {
        gateOpen = true;
        score += 1000;
        Lynx.sfx.play("gate");
        say("The portcullis rises! (+1000)", "#50ff78");
      }
    }

    // Memory floor: a foot came down on tile "i,j" (or left the floor: "off").
    function pressSequence(cand) {
      if (cand === "off") {
        // stepping off the floor shows the order again
        if (seqPhase === "input" && chamber >= 2) {
          replaySequence(0.8);
          say("Watch again...", "#ffd84a");
        }
        return;
      }
      if (seqPhase !== "input") return; // no pressing while it's showing
      const [i, j] = cand.split(",").map(Number);
      const k = i * N + j;
      if (k === seq[seqPos]) {
        seqPos++;
        Lynx.sfx.play("beep");
        if (seqPos === seq.length) {
          gateOpen = true;
          score += 1000;
          Lynx.sfx.play("gate");
          say("The portcullis rises! (+1000)", "#50ff78");
        }
        return;
      }
      Lynx.sfx.play("fail");
      say("Wrong glyph -- something stirs... watch again", "#ff6060");
      spawnScarab();
      replaySequence(1.5);
    }

    function updateSequence(dt) {
      if (lv.puzzle !== "sequence" || chamber < 2 || gateOpen) return;
      if (seqPhase === "wait") {
        seqT -= dt;
        if (seqT <= 0) {
          seqPhase = "show";
          seqT = 0;
          seqShown = -1;
        }
      } else if (seqPhase === "show") {
        seqT += dt;
        const idx = Math.floor(seqT / SEQ_STEP_S);
        if (idx >= seq.length) {
          seqPhase = "input";
          seqPos = 0;
          say("Your turn: step on the glyphs in that order", "#ffd84a");
        } else if (idx !== seqShown) {
          seqShown = idx;
          Lynx.sfx.play("click");
        }
      }
    }

    // The glyph the memory floor is showing right now (tile index), or -1.
    function seqLit() {
      if (seqPhase !== "show") return -1;
      const idx = Math.floor(seqT / SEQ_STEP_S);
      return idx < seq.length && seqT - idx * SEQ_STEP_S < SEQ_ON_S ? seq[idx] : -1;
    }

    // Dart traps shoot low across the hall; stand in a lane when a dart passes
    // and it hits you, unless you're in the air (or up on a block).
    function updateTraps(dt, me) {
      traps.forEach((trap) => {
        if (chamber === 1) trap.t -= dt;
        if (trap.t <= 0) {
          trap.t += d.dartEvery;
          trap.dart = { r: trap.side * HALF_W, hit: false };
          Lynx.sfx.play("squirt");
        }
        const dart = trap.dart;
        if (!dart) return;
        dart.r -= trap.side * DART_SPEED * d.speed * dt;
        if (Math.abs(dart.r) > HALF_W + 0.01) {
          trap.dart = null;
          return;
        }
        if (!dart.hit && Math.abs(me.f - trap.f) < 0.08 && Math.abs(me.r - dart.r) < 0.07 && ar.feet() < DART_H + 0.03) {
          dart.hit = true;
          hurt("A dart! Jump when they fly");
        }
      });
    }

    function spawnScarab() {
      const corner = toWorld(Math.random() < 0.5 ? grid.f0 - 0.05 : grid.f1 + 0.05, (Math.random() < 0.5 ? -1 : 1) * (HALF_W - 0.1));
      scarabs.push({ x: corner.x, y: corner.y, hp: 1, phase: 0, hit: 0, retreat: 0, rect: null });
    }

    function updateItems(me) {
      const feet = ar.feet();
      items = items.filter((it) => {
        const near = Math.hypot(me.f - it.f, me.r - it.r) < (it.kind === "eye" ? 0.2 : 0.15);
        if (!near || feet < it.base - 0.03 || feet > it.base + 0.3) return true;
        if (it.kind === "eye") {
          relicTaken();
          return false;
        }
        if (it.kind === "potion") {
          if (hearts < maxHearts) hearts++;
          else score += 100;
          Lynx.sfx.play("pickup");
          say("A healing potion");
        } else {
          score += it.kind === "bigGem" ? 750 : 250;
          Lynx.sfx.play("coin");
          if (it.kind === "bigGem") say("The ruby of the high ledge! (+750)", "#ff60b0");
        }
        return false;
      });
    }

    // A bat first flutters where it appears for a while (time to aim), then swoops.
    function spawnBat(f, r) {
      const w = toWorld(f, r);
      const h = rand(0.18, 0.28);
      bats.push({ x: w.x, y: w.y, h, homeX: w.x, homeY: w.y, homeH: h, wait: rand(2.5, 4), hp: d.batHp, phase: Math.random() * 6, hit: 0, retreat: 0, rect: null });
      Lynx.sfx.play("growl");
    }

    // A wisp (temple coordinates f, r, h up) hovers for a moment where it
    // appears, then weaves: fast sideways across your line of sight, changing
    // direction at random, while it only creeps toward you.
    function spawnWisp(f, r) {
      wisps.push({ f, r, h: rand(0.12, 0.2), dir: Math.random() < 0.5 ? -1 : 1, turnT: rand(1.5, 2.5), sv: 0, wait: 1.2, hp: d.batHp + 1, phase: Math.random() * 6, hit: 0, retreat: 0, rect: null });
      Lynx.sfx.play("growl");
    }

    function updateWisps(dt, me) {
      const cam = ar.cameraWorld();
      wisps.forEach((w) => {
        w.phase += dt * 5;
        w.hit = Math.max(0, w.hit - dt);
        w.retreat = Math.max(0, w.retreat - dt);
        w.turnT -= dt;
        if (w.turnT <= 0) {
          w.dir = -w.dir;
          w.turnT = rand(...WISP_TURN_S);
        }
        if (w.wait > 0) {
          w.wait -= dt;
          return;
        }
        const df = me.f - w.f;
        const dr = me.r - w.r;
        const dist = Math.hypot(df, dr) || 1;
        const uf = df / dist;
        const ur = dr / dist;
        const side = WISP_SIDE_SPEED * d.speed * (w.hit > 0 ? 0.4 : 1);
        const dv = w.dir * side - w.sv;
        w.sv += Math.sign(dv) * Math.min(Math.abs(dv), WISP_SIDE_ACCEL * d.speed * dt);
        const close = w.retreat > 0 ? -3 * WISP_CLOSE_SPEED : dist > 0.35 ? WISP_CLOSE_SPEED * d.speed : WISP_CLOSE_SPEED * 0.6;
        w.f += (uf * close - ur * w.sv) * dt;
        w.r += (ur * close + uf * w.sv) * dt;
        // the corridor's walls turn it around
        const lim = HALF_W - 0.1;
        if (Math.abs(w.r) > lim) {
          w.r = Math.sign(w.r) * lim;
          w.dir = uf * w.r > 0 ? -1 : 1; // sideways = (uf, ur) turned right: away from this wall
          w.sv = 0;
          w.turnT = rand(...WISP_TURN_S);
        }
        w.f = Math.max(0.05, Math.min(LEN - 0.1, w.f));
        w.h += ((cam.h - 0.04 - w.h) * 0.4 + Math.sin(w.phase) * 0.05) * dt;
        const ww = toWorld(w.f, w.r);
        if (Math.hypot(ww.x - cam.x, ww.y - cam.y, w.h - cam.h) < TOUCH_M && w.retreat === 0) {
          hurt("A spirit's chill");
          w.retreat = 1.5;
        }
      });
      wisps = wisps.filter((w) => !w.dead);
      // the hall's wisps come after its bats, one at a time
      if (batsReleased && chamber === 1 && batsSent >= d.bats && bats.length === 0 && wisps.length === 0 && wispsSent < d.wisps) {
        wispTimer -= dt;
        if (wispTimer <= 0) {
          wispsSent++;
          wispTimer = 4;
          spawnWisp(Math.min(me.f + rand(0.8, 1.1), gateF - 0.15), rand(-0.4, 0.4));
        }
      }
    }

    function updateEnemies(dt, me) {
      const cam = ar.cameraWorld();
      const aimH = cam.h - 0.02;
      bats.forEach((b) => {
        b.phase += dt * 7;
        b.hit = Math.max(0, b.hit - dt);
        b.retreat = Math.max(0, b.retreat - dt);
        if (b.wait > 0) {
          b.wait -= dt;
          b.x = b.homeX + 0.06 * Math.cos(b.phase * 0.3);
          b.y = b.homeY + 0.06 * Math.sin(b.phase * 0.3);
          b.h = b.homeH + 0.02 * Math.sin(b.phase);
          return;
        }
        const dx = cam.x - b.x;
        const dy = cam.y - b.y;
        const dh = aimH - b.h;
        const dist = Math.hypot(dx, dy, dh) || 1;
        const sgn = b.retreat > 0 ? -1 : 1;
        const speed = 0.15 * d.speed * (b.hit > 0 ? 0.3 : 1);
        const side = Math.sin(b.phase * 0.35) * 0.9;
        b.x += sgn * ((dx / dist) - (dy / dist) * side) * speed * dt;
        b.y += sgn * ((dy / dist) + (dx / dist) * side) * speed * dt;
        b.h = Math.max(0.06, b.h + sgn * (dh / dist) * speed * dt + Math.sin(b.phase) * 0.02 * dt * 7);
        if (dist < TOUCH_M && b.retreat === 0) {
          hurt("Bitten by a bat");
          b.retreat = 1.2;
        }
      });
      scarabs.forEach((s) => {
        s.phase += dt * 10;
        s.hit = Math.max(0, s.hit - dt);
        s.retreat = Math.max(0, s.retreat - dt);
        const dx = ar.pose.x - s.x;
        const dy = ar.pose.y - s.y;
        const dist = Math.hypot(dx, dy) || 1;
        const sgn = s.retreat > 0 ? -1 : 1;
        const speed = 0.12 * d.speed * (s.hit > 0 ? 0.3 : 1);
        s.x += (sgn * dx * speed * dt) / dist;
        s.y += (sgn * dy * speed * dt) / dist;
        s.flip = dx < 0;
        if (dist < TOUCH_M && s.retreat === 0 && ar.feet() < 0.05) {
          hurt("Scarab bite -- jump over them!");
          s.retreat = 1;
        }
      });
      bats = bats.filter((b) => !b.dead);
      scarabs = scarabs.filter((s) => !s.dead);
      updateWisps(dt, me);

      // the hall's bats: one at a time, the next a few seconds after the last is gone
      if (!batsReleased && me.f > 0.25) {
        batsReleased = true;
        batTimer = 1.5;
      }
      if (batsReleased && chamber === 1 && batsSent < d.bats && bats.length === 0) {
        batTimer -= dt;
        if (batTimer <= 0) {
          batsSent++;
          batTimer = 5;
          spawnBat(rand(1.0, 1.3), rand(-0.5, 0.5));
        }
      }
      // the glyph floor's scarabs (on the memory floor they come for mistakes instead)
      if (lv.puzzle === "lights" && chamber >= 2 && !gateOpen && scarabsSent < d.scarabs && scarabs.length === 0) {
        scarabTimer -= dt;
        if (scarabTimer <= 0) {
          scarabTimer = d.scarabQuiet;
          scarabsSent++;
          spawnScarab();
        }
      }
    }

    function updateBoss(dt, me) {
      if (boss.state === "sleep") {
        if (gateOpen && me.f > gateF + 0.08 && !solid) {
          boss.state = "shielded";
          chamber = 3;
          Lynx.sfx.play("growl");
          say("The guardian wakes! Shoot its crystals", "#ff8040");
          for (let k = 0; k < d.bossWisps; k++) spawnWisp(BOSS.f - 0.35, k % 2 ? 0.5 : -0.5);
        }
        return;
      }
      if (boss.state === "dead") return;
      boss.t += dt;
      boss.hit = Math.max(0, boss.hit - dt);
      if (boss.state === "shielded" && crystals.every((c) => !c.alive)) {
        boss.state = "open";
        boss.openT = d.vulnerable;
        Lynx.sfx.play("power");
        say("Its shield is down -- shoot it!", "#50ff78");
      } else if (boss.state === "open") {
        boss.openT -= dt;
        if (boss.openT <= 0) {
          boss.state = "shielded";
          spawnCrystals();
          spawnBat(2.7, -0.5);
          spawnBat(2.7, 0.5);
          if (d.bossWisps > 0 && wisps.length === 0) spawnWisp(BOSS.f - 0.35, 0);
          Lynx.sfx.play("growl");
          say("The crystals grow back!", "#ff8040");
        }
      }
      // attacks, faster as it weakens
      boss.attackT -= dt;
      if (boss.attackT <= 0) {
        const rage = boss.hp < boss.maxHp * lv.rage;
        boss.attackT = d.attackEvery * (0.6 + (0.4 * boss.hp) / boss.maxHp);
        const kind = boss.attackN++ % 3;
        if (kind === 1) {
          const n = rage ? 3 : 1;
          for (let i = 0; i < n; i++) launchFireball(i - (n - 1) / 2);
        } else {
          rings.push({ r: 0.25, hit: false });
          Lynx.sfx.play("explode");
          if (rage) pendingRings.push(0.7);
        }
      }
      pendingRings = pendingRings.map((t) => t - dt).filter((t) => {
        if (t > 0) return true;
        rings.push({ r: 0.25, hit: false });
        Lynx.sfx.play("explode");
        return false;
      });
      if (Math.hypot(me.f - BOSS.f, me.r - BOSS.r) < 0.3 && ar.feet() < 0.3) hurt("Too close to the guardian!");
    }

    function launchFireball(spread) {
      const from = toWorld(BOSS.f - 0.08, BOSS.r);
      const cam = ar.cameraWorld();
      const tx = cam.x + spread * 0.25 * Math.sin(anchor.th);
      const ty = cam.y - spread * 0.25 * Math.cos(anchor.th);
      const th = cam.h - 0.02;
      const dist = Math.hypot(tx - from.x, ty - from.y, th - 0.3) || 1;
      const sp = 0.55 * d.speed;
      fireballs.push({ x: from.x, y: from.y, h: 0.3, vx: ((tx - from.x) / dist) * sp, vy: ((ty - from.y) / dist) * sp, vh: ((th - 0.3) / dist) * sp, t: 0 });
      Lynx.sfx.play("fireball");
    }

    function updateProjectiles(dt, me) {
      const cam = ar.cameraWorld();
      fireballs = fireballs.filter((b) => {
        b.t += dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.h += b.vh * dt;
        if (Math.hypot(b.x - cam.x, b.y - cam.y, b.h - (cam.h - 0.02)) < 0.09) {
          hurt("Burned -- dodge the fireballs");
          return false;
        }
        if (b.h < 0 || b.t > 7) {
          puffs.push({ x: b.x, y: b.y, h: 0.02, t: 0, color: "255,140,40" });
          return false;
        }
        return true;
      });
      const dBoss = Math.hypot(me.f - BOSS.f, me.r - BOSS.r);
      rings = rings.filter((ring) => {
        ring.r += RING_SPEED * d.speed * dt;
        if (!ring.hit && me.f > gateF && Math.abs(dBoss - ring.r) < 0.05 && ar.feet() < 0.06) {
          ring.hit = true;
          hurt("Jump over the shockwaves!");
        }
        return ring.r < 3.3;
      });
    }

    function update(dt) {
      stateTime += dt;
      hurtFlash = Math.max(0, hurtFlash - dt);
      cooldown = Math.max(0, cooldown - dt);
      if (note) note.t += dt;
      tracers.forEach((t) => (t.t += dt));
      tracers = tracers.filter((t) => t.t < 0.1);
      puffs.forEach((p) => (p.t += dt));
      puffs = puffs.filter((p) => p.t < 0.5);
      if (gateOpen) gateLift = Math.min(0.3, gateLift + dt * 0.2);
      if (!anchor) return;
      const me = toLocal(ar.pose.x, ar.pose.y);
      if (maze) {
        maze.physics(me);
        if (Lynx.control && Lynx.control.refreshDrive) Lynx.control.refreshDrive(); // stop at a wall now, not at the next input resend
      } else updateGround(me);
      if (state !== "playing") return;

      elapsed += dt;
      levelElapsed += dt;
      invulnerable = Math.max(0, invulnerable - dt);
      if (firePressed || Lynx.input.fireHeld) tryFire();
      firePressed = false;
      if (maze) {
        maze.update(dt, me);
        return;
      }

      // landed in a pit: hurt, and bounced up out of it
      if (wasAirborne && !ar.airborne && ar.ground < 0) {
        const pit = pits.find((p) => inRect(me, p));
        hurt(pit && pit.kind === "lava" ? "Lava! Jump across" : "Spikes! Jump across");
        ar.jump();
      }
      wasAirborne = ar.airborne;

      if (!solid && !outside) {
        if (chamber === 1 && me.f > grid.f0 - 0.1) {
          chamber = 2;
          scarabTimer = 10; // a quiet start to look at the puzzle
          traps.forEach((t) => (t.dart = null));
          say(lv.chamber2, "#ffd84a");
        }
        updateGlyphs(me);
        updateItems(me);
      }
      updateTraps(dt, me);
      updateSequence(dt);
      updateEnemies(dt, me);
      updateBoss(dt, me);
      updateProjectiles(dt, me);
      crystals.forEach((c) => {
        c.spin += dt * 2;
        c.hit = Math.max(0, (c.hit || 0) - dt);
      });
    }

    // -- drawing ---------------------------------------------------------------------
    function drawFloor() {
      floorDetail({ f0: 0, f1: LEN, r0: -HALF_W, r1: HALF_W });
      // faint slab lines outlining the temple
      const col = "rgba(230,200,140,0.22)";
      [-HALF_W, -HALF_W / 2, 0, HALF_W / 2, HALF_W].forEach((r) => line3([[0, r, 0], [LEN, r, 0]], col, 1, 0.1));
      for (let f = 0; f <= LEN; f += 0.5) line3([[f, -HALF_W, 0], [f, HALF_W, 0]], col, 1, 0.1);
    }

    function drawPit(p) {
      const corners = (h) => [w3(p.f0, p.r0, h), w3(p.f1, p.r0, h), w3(p.f1, p.r1, h), w3(p.f0, p.r1, h)];
      const opening = polyScreen(corners(0));
      if (!opening) return;
      const c = ar.ctx;
      const cw = ar.cameraWorld();
      const me = toLocal(cw.x, cw.y);
      const lava = p.kind === "lava";
      c.save();
      c.beginPath();
      opening.forEach((q, i) => (i ? c.lineTo(q.x, q.y) : c.moveTo(q.x, q.y)));
      c.closePath();
      c.clip();
      const bottom = polyScreen(corners(-PIT_D));
      if (bottom) fillPoly(bottom, lava ? `rgb(255,${Math.round(90 + 30 * Math.sin(stateTime * 3))},20)` : "#1a1410");
      else fillPoly(opening, lava ? "#ff6010" : "#1a1410");
      // inner walls that face the camera
      const walls = [];
      if (me.f > p.f0) walls.push([[p.f0, p.r1], [p.f0, p.r0]]);
      if (me.f < p.f1) walls.push([[p.f1, p.r0], [p.f1, p.r1]]);
      if (me.r > p.r0) walls.push([[p.f0, p.r0], [p.f1, p.r0]]);
      if (me.r < p.r1) walls.push([[p.f1, p.r1], [p.f0, p.r1]]);
      walls.forEach(([a, b]) => {
        const q = polyScreen([w3(a[0], a[1], 0), w3(b[0], b[1], 0), w3(b[0], b[1], -PIT_D), w3(a[0], a[1], -PIT_D)], 3);
        if (q) fillPoly(q, lava ? "rgba(90,30,10,0.9)" : "#3a2c20", "rgba(0,0,0,0.4)");
      });
      if (lava) {
        for (let k = 0; k < 6; k++) {
          const f = p.f0 + ((k * 0.37 + 0.2) % 1) * (p.f1 - p.f0);
          const r = p.r0 + ((k * 0.61 + stateTime * 0.05) % 1) * (p.r1 - p.r0);
          const w = toWorld(f, r);
          const s = ar.project(w.x, w.y, -PIT_D + 0.01);
          if (s) ar.glow(s.x, s.y, Math.max(3, 0.05 * s.ppm * (0.6 + 0.4 * Math.sin(stateTime * 4 + k))), [[0, "rgba(255,240,120,0.9)"], [1, "rgba(255,120,0,0)"]]);
        }
      } else if (Math.hypot(me.f - (p.f0 + p.f1) / 2, 0) < 2) {
        c.fillStyle = "#b8b0a0";
        for (let f = p.f0 + 0.03; f < p.f1; f += 0.06) {
          for (let r = p.r0 + 0.04; r < p.r1; r += 0.08) {
            const w = toWorld(f, r);
            const tip = camZ(w.x, w.y, -PIT_D + 0.06) >= NEAR ? ar.project(w.x, w.y, -PIT_D + 0.06) : null;
            const a = toWorld(f, r - 0.015);
            const b = toWorld(f, r + 0.015);
            const pa = camZ(a.x, a.y, -PIT_D) >= NEAR ? ar.project(a.x, a.y, -PIT_D) : null;
            const pb = camZ(b.x, b.y, -PIT_D) >= NEAR ? ar.project(b.x, b.y, -PIT_D) : null;
            if (!tip || !pa || !pb) continue;
            c.beginPath();
            c.moveTo(pa.x, pa.y);
            c.lineTo(tip.x, tip.y);
            c.lineTo(pb.x, pb.y);
            c.closePath();
            c.fill();
          }
        }
      }
      c.restore();
      fillPoly(opening, null, lava ? "rgba(255,160,40,0.8)" : "rgba(120,90,60,0.9)", 2);
      if (lava) {
        const mid = toWorld((p.f0 + p.f1) / 2, (p.r0 + p.r1) / 2);
        const s = ar.project(mid.x, mid.y, 0);
        if (s) ar.glow(s.x, s.y, 0.35 * s.ppm, [[0, "rgba(255,120,20,0.35)"], [1, "rgba(255,80,0,0)"]]);
      }
    }

    function drawGlyphs() {
      const me = toLocal(ar.pose.x, ar.pose.y);
      const memory = lv.puzzle === "sequence";
      const showing = memory ? seqLit() : -1;
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const k = i * N + j;
          // memory floor: the glyph being shown is lit; ones already stepped on
          // in the right order glow green
          const done = memory && !gateOpen && seqPhase === "input" && seq.slice(0, seqPos).includes(k);
          const on = memory ? gateOpen || k === showing : lit[k];
          const f0 = grid.f0 + i * T;
          const r0 = grid.r0 + j * T;
          const inset = 0.012;
          const q = polyScreen([w3(f0 + inset, r0 + inset, 0.002), w3(f0 + T - inset, r0 + inset, 0.002), w3(f0 + T - inset, r0 + T - inset, 0.002), w3(f0 + inset, r0 + T - inset, 0.002)], 2);
          if (!q) continue;
          const here = onTile === `${i},${j}` && me.f >= f0 && me.f <= f0 + T && me.r >= r0 && me.r <= r0 + T;
          const fill = on ? "rgba(255,200,60,0.42)" : done ? "rgba(60,200,100,0.35)" : "rgba(25,20,45,0.6)";
          fillPoly(q, fill, here ? "#28c8ff" : on ? "#ffd84a" : done ? "#50ff78" : "#6a5a90", here ? 3 : 1.5);
          const c = tileCenter(i, j);
          GLYPHS[(i * 7 + j * 3) % GLYPHS.length].forEach((pl) =>
            line3(pl.map(([u, v]) => [c.f - v * T, c.r + u * T, 0.003]), on ? "#fff4c0" : "rgba(160,140,220,0.8)", on ? 2.5 : 1.5, 0.03));
        }
      }
    }

    // Dart traps: a faint lane across the floor, a glowing hole in the wall
    // just before a dart flies, and the dart itself.
    function drawTraps() {
      traps.forEach((trap) => {
        line3([[trap.f, -HALF_W, 0.002], [trap.f, HALF_W, 0.002]], "rgba(220,90,60,0.35)", 2, 0.1);
        const warn = chamber === 1 && trap.t < 0.6;
        const hole = toWorld(trap.f, trap.side * (HALF_W - 0.005));
        if (camZ(hole.x, hole.y, DART_H) >= NEAR) {
          const p = ar.project(hole.x, hole.y, DART_H);
          if (p) {
            ar.queue(p.depth - 0.01, () => {
              ar.glow(p.x, p.y, Math.max(3, 0.03 * p.ppm), warn ? [[0, "rgba(255,90,40,0.95)"], [1, "rgba(255,40,0,0)"]] : [[0, "rgba(20,10,5,0.9)"], [1, "rgba(20,10,5,0)"]]);
            }, pointAt(hole.x, hole.y, DART_H, DART_H));
          }
        }
        if (trap.dart) {
          const r = trap.dart.r;
          const tail = r + trap.side * 0.08;
          const mid = toWorld(trap.f, r);
          const depth = camZ(mid.x, mid.y, DART_H);
          if (depth >= NEAR) {
            ar.queue(depth, () => line3([[trap.f, tail, DART_H], [trap.f, r, DART_H]], "#d8c8a0", 3, 0.02), pointAt(mid.x, mid.y, DART_H, DART_H));
          }
        }
      });
    }

    function drawRings() {
      const c = ar.ctx;
      rings.forEach((ring) => {
        [[0.004, "rgba(255,120,30,0.9)", 4], [0.05, "rgba(255,220,120,0.9)", 2]].forEach(([h, color, width]) => {
          c.strokeStyle = color;
          c.lineWidth = width;
          c.beginPath();
          let pen = false;
          const n = 72;
          for (let k = 0; k <= n; k++) {
            const a = (k / n) * 2 * Math.PI;
            const f = BOSS.f + ring.r * Math.cos(a);
            const r = BOSS.r + ring.r * Math.sin(a);
            const inside = f > gateF && f < LEN && Math.abs(r) < HALF_W;
            const w = toWorld(f, r);
            const p = inside && camZ(w.x, w.y, h) >= NEAR ? ar.project(w.x, w.y, h) : null;
            if (!p) {
              pen = false;
              continue;
            }
            if (pen) c.lineTo(p.x, p.y);
            else c.moveTo(p.x, p.y);
            pen = true;
          }
          c.stroke();
        });
      });
    }

    function drawWalls() {
      for (let f = 0; f < LEN; f += 0.25) {
        const f1 = Math.min(LEN, f + 0.25);
        fence({ f0: f, f1, r0: -HALF_W - 0.06, r1: -HALF_W }, 0, WALL_H);
        fence({ f0: f, f1, r0: HALF_W, r1: HALF_W + 0.06 }, 0, WALL_H);
      }
      for (let r = -HALF_W - 0.06; r < HALF_W + 0.06; r += 0.32) {
        fence({ f0: LEN, f1: LEN + 0.06, r0: r, r1: Math.min(HALF_W + 0.06, r + 0.32) }, 0, WALL_H);
      }
      // entrance pillars
      box({ f0: -0.07, f1: 0.05, r0: -HALF_W - 0.1, r1: -HALF_W + 0.02 }, 0, 0.32, SANDSTONE);
      box({ f0: -0.07, f1: 0.05, r0: HALF_W - 0.02, r1: HALF_W + 0.1 }, 0, 0.32, SANDSTONE);
      platforms.forEach((p) => box(p, 0, p.h, p.pedestal ? PEDESTAL : BLOCK));
      // torches on the walls
      for (let f = 0.3; f < LEN; f += 0.75) {
        [-1, 1].forEach((side) => {
          const w = toWorld(f, side * (HALF_W - 0.01));
          const p = ar.project(w.x, w.y, 0.19);
          if (!p || camZ(w.x, w.y, 0.19) < NEAR) return;
          ar.queue(p.depth - 0.01, () => {
            const flick = 0.85 + 0.15 * Math.sin(stateTime * 17 + f * 5 + side);
            ar.glow(p.x, p.y, 0.09 * p.ppm * flick, [[0, "rgba(255,240,160,0.95)"], [0.35, "rgba(255,150,40,0.6)"], [1, "rgba(255,100,0,0)"]]);
          }, pointAt(w.x, w.y, 0.19, 0.19));
        });
      }
    }

    function drawGate() {
      const mid = toWorld(gateF, 0);
      if (camZ(mid.x, mid.y, 0.1) < -0.5) return;
      const p = ar.project(mid.x, mid.y, 0.1);
      ar.queue(p ? p.depth : camZ(mid.x, mid.y, 0.1), () => {
        const lift = gateLift;
        if (lift >= 0.3) return;
        for (let r = -HALF_W + 0.05; r < HALF_W; r += 0.1) line3([[gateF, r, lift], [gateF, r, lift + 0.26]], "#2e2e34", 4, 0.05);
        [0.06, 0.18].forEach((h) => line3([[gateF, -HALF_W, lift + h], [gateF, HALF_W, lift + h]], "#3c3c44", 4, 0.1));
      }, extent(gateF - 0.01, gateF + 0.01, -HALF_W, HALF_W, gateLift, gateLift + 0.26));
    }

    function drawSprite(obj, spr, x, y, base, heightM, opts = {}) {
      const rect = ar.spriteRect(spr, x, y, base, heightM);
      obj.rect = rect;
      if (!rect || camZ(x, y, base) < NEAR) {
        obj.rect = null;
        return;
      }
      ar.queue(rect.depth, () => {
        if (opts.before) opts.before(rect);
        ar.drawSprite(spr, rect, { flip: opts.flip, tint: obj.hit > 0 ? "rgba(255,255,255,0.7)" : null });
        if (opts.after) opts.after(rect);
      }, pointAt(x, y, base, base + heightM));
    }

    function drawActors() {
      bats.forEach((b) => drawSprite(b, img.bat, b.x, b.y, b.h + Math.sin(b.phase) * 0.015, 0.06, { flip: Math.sin(b.phase * 0.35) < 0 }));
      scarabs.forEach((s) => drawSprite(s, img.scarab, s.x, s.y, 0, 0.045, { flip: s.flip }));
      wisps.forEach((w) => {
        const p = toWorld(w.f, w.r);
        drawSprite(w, img.wisp, p.x, p.y, w.h - 0.035, 0.075, { flip: w.dir < 0 });
      });
      items.forEach((it) => {
        const w = toWorld(it.f, it.r);
        const bob = Math.sin(stateTime * 3 + it.f * 7) * 0.012;
        const spr = it.kind === "eye" && lv.relicSprite ? img[lv.relicSprite] : img[it.kind];
        const size = it.kind === "eye" ? 0.1 : it.kind === "potion" ? 0.06 : 0.05;
        drawSprite(it, spr, w.x, w.y, it.base + 0.03 + bob, size, {
          before: (r) => ar.glow(r.cx, r.y + r.h / 2, r.w * 1.3, [[0, "rgba(255,255,220,0.7)"], [1, "rgba(255,255,200,0)"]]),
        });
      });
      crystals.forEach((c) => {
        if (!c.alive || boss.state === "sleep") {
          c.rect = null;
          return;
        }
        const w = toWorld(c.f, c.r);
        const p = camZ(w.x, w.y, c.h) >= NEAR ? ar.project(w.x, w.y, c.h) : null;
        if (!p) {
          c.rect = null;
          return;
        }
        const s = Math.max(6, 0.05 * p.ppm);
        c.rect = { x: p.x - s * 0.6, y: p.y - s, w: s * 1.2, h: s * 2, depth: p.depth, cx: p.x };
        ar.queue(p.depth, () => {
          // tether to the guardian
          line3([[c.f, c.r, c.h], [BOSS.f, BOSS.r, 0.25]], "rgba(120,200,255,0.35)", 2, 0.08);
          ar.glow(p.x, p.y, s * 2.2, [[0, "rgba(160,220,255,0.8)"], [1, "rgba(80,160,255,0)"]]);
          const k = Math.abs(Math.cos(c.spin));
          fillPoly([{ x: p.x, y: p.y - s }, { x: p.x + s * 0.6 * k + 1, y: p.y }, { x: p.x, y: p.y + s }, { x: p.x - s * 0.6 * k - 1, y: p.y }], c.hit > 0 ? "#ffffff" : "#60c0ff", "#e0f4ff", 1.5);
        }, extent(c.f, c.f, c.r, c.r, c.h, c.h));
      });
      if (boss.state !== "dead") {
        const w = toWorld(BOSS.f, BOSS.r);
        drawSprite(boss, img[lv.guardian], w.x, w.y, 0, 0.45, {
          after: (rect) => {
            if (boss.state === "shielded") {
              ar.glow(rect.cx, rect.y + rect.h / 2, rect.h * 0.75, [[0, "rgba(80,160,255,0)"], [0.75, "rgba(80,160,255,0.18)"], [1, "rgba(120,200,255,0)"]]);
            } else if (boss.state === "sleep") {
              ar.ctx.save();
              ar.ctx.globalAlpha = 0.4;
              ar.ctx.fillStyle = "#000";
              ar.ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
              ar.ctx.restore();
            }
          },
        });
      } else boss.rect = null;
      fireballs.forEach((b) => {
        const p = camZ(b.x, b.y, b.h) >= NEAR ? ar.project(b.x, b.y, b.h) : null;
        if (!p) return;
        ar.queue(p.depth, () => ar.glow(p.x, p.y, Math.max(5, 0.05 * p.ppm), [[0, "rgba(255,255,200,1)"], [0.4, "rgba(255,150,30,0.9)"], [1, "rgba(255,60,0,0)"]]), pointAt(b.x, b.y, b.h, b.h));
      });
    }

    function drawGuns() {
      const v = ar.view;
      const gw = Math.min(v.w * 0.16, 130);
      const gh = (gw * img.pistol.height) / img.pistol.width;
      const kick = cooldown > 0 ? (cooldown / 0.26) * gh * 0.25 : 0;
      ar.drawSprite(img.pistol, { x: v.cx + v.w * 0.12, y: v.y + v.h - gh * 0.9 + (leftGun ? 0 : kick), w: gw, h: gh });
      ar.drawSprite(img.pistol, { x: v.cx - v.w * 0.12 - gw, y: v.y + v.h - gh * 0.9 + (leftGun ? kick : 0), w: gw, h: gh }, { flip: true });
    }

    function objective() {
      const mid = tileCenter((N - 1) / 2, (N - 1) / 2);
      if (chamber === 1) {
        const text = traps.length ? "Cross the pits, jump the darts (Space / gamepad A / ⤒ = jump)" : "Cross the pits (Space / gamepad A / ⤒ = jump)";
        return { text, at: mid, h: 0 };
      }
      if (!gateOpen && lv.puzzle === "sequence") {
        if (seqPhase !== "input") return { text: "Watch the glyphs light up, one by one...", at: mid, h: 0 };
        return { text: `Step on the glyphs in that order (${seqPos}/${seq.length}) -- step off the floor to see it again`, at: mid, h: 0 };
      }
      if (!gateOpen) return { text: "Light every glyph -- each step flips its neighbours too", at: mid, h: 0 };
      if (boss.state === "sleep") return { text: "Go through the portcullis", at: { f: gateF + 0.3, r: 0 }, h: 0.1 };
      if (boss.state === "shielded") {
        const c = crystals.find((x) => x.alive);
        return { text: "Shoot the crystals (jump to reach them)", at: c || BOSS, h: c ? c.h : 0.2 };
      }
      if (boss.state === "open") return { text: `Shoot the guardian! ${Math.ceil(boss.openT)}s`, at: BOSS, h: 0.2 };
      return { text: `Take ${lv.relic}`, at: { f: BOSS.f - 0.15, r: BOSS.r }, h: 0.05 };
    }

    function draw() {
      const v = ar.view;
      if (anchor) {
        const cw = ar.cameraWorld();
        const cl = toLocal(cw.x, cw.y);
        frame.cam = { f: cl.f, r: cl.r, h: cw.h };
        const drawPuffs = () => puffs.forEach((p) => {
          const pr = camZ(p.x, p.y, p.h) >= NEAR ? ar.project(p.x, p.y, p.h) : null;
          const col = p.color || "255,255,255";
          if (pr) ar.glow(pr.x, pr.y, (p.big ? 0.4 : 0.12) * pr.ppm * (0.5 + p.t * 2), [[0, `rgba(${col},0.9)`], [1, `rgba(${col},0)`]], 1 - p.t / 0.5);
        });
        if (maze) {
          maze.draw();
          drawPuffs();
        } else {
          drawFloor();
          pits.forEach(drawPit);
          drawGlyphs();
          drawTraps();
          drawRings();
          drawWalls();
          drawGate();
          drawActors();
          drawPuffs();
          ar.flush();
        }
      }
      tracers.forEach((t) => {
        const c = ar.ctx;
        c.save();
        c.globalAlpha = 1 - t.t / 0.1;
        c.strokeStyle = "#ffe8a0";
        c.lineWidth = 3;
        c.beginPath();
        c.moveTo(t.x0, t.y0);
        c.lineTo(t.x1, t.y1);
        c.stroke();
        c.restore();
      });

      if (state === "playing" || state === "dead") {
        const o = maze ? maze.objective() : objective();
        const ow = toWorld(o.at.f, o.at.r);
        ar.edgeArrow(ow.x, ow.y, o.h, "#ffd84a");
        if (cfg.radar) {
          const blips = [];
          bats.forEach((b) => blips.push({ x: b.x, y: b.y, color: "#ff4040" }));
          wisps.forEach((w) => blips.push({ ...toWorld(w.f, w.r), color: "#60d0ff" }));
          scarabs.forEach((s) => blips.push({ x: s.x, y: s.y, color: "#ff8040" }));
          crystals.forEach((c) => c.alive && boss.state !== "sleep" && blips.push({ ...toWorld(c.f, c.r), color: "#60c0ff" }));
          items.forEach((it) => blips.push({ ...toWorld(it.f, it.r), color: "#ffd84a", r: 2.5 }));
          fireballs.forEach((b) => blips.push({ x: b.x, y: b.y, color: "#ffa020", r: 2 }));
          traps.forEach((t) => t.dart && blips.push({ ...toWorld(t.f, t.dart.r), color: "#d8c8a0", r: 2 }));
          if (maze) blips.push(...maze.blips());
          ar.radar(blips, 1.5);
        }
        ar.crosshair("rgba(0,0,0,0.6)", 19, 5);
        ar.crosshair("#ffffff", 17, 6);
        drawGuns();
        ar.text(`TEMPLE OF LYNXP · level ${level} · ${maze ? maze.floorName() : `chamber ${chamber}`}`, v.x + 14, v.y + 66, { size: 16, color: "#ffd84a" });
        if (maze) maze.hud();
        ar.text(o.text, v.x + 14, v.y + 88, { size: 14 });
        if (boss.state !== "sleep" && boss.state !== "dead") {
          const bw = Math.min(200, v.w * 0.3);
          ar.ctx.fillStyle = "rgba(0,0,0,0.6)";
          ar.ctx.fillRect(v.x + 14, v.y + 98, bw, 8);
          ar.ctx.fillStyle = boss.state === "open" ? "#ff4040" : "#6080ff";
          ar.ctx.fillRect(v.x + 14, v.y + 98, (bw * boss.hp) / boss.maxHp, 8);
          ar.text("GUARDIAN", v.x + 18 + bw, v.y + 106, { size: 11 });
        }
      }

      if (solid) {
        ar.flash("#2a1e10", 0.6);
        ar.text(solid === "gate" ? "The portcullis is shut -- back out" : "Inside the stone -- back out and jump onto it", v.cx, v.cy, { size: 18, align: "center", color: "#ffb060" });
      } else if (outside && state === "playing") {
        ar.text("You left the temple -- drive back in", v.cx, v.cy - 30, { size: 18, align: "center", color: "#ffb060" });
      }
      ar.flash("#ff0000", hurtFlash * 0.6);
      if (invulnerable > 0 && state === "playing" && Math.floor(invulnerable * 8) % 2 === 0) ar.flash("#ffffff", 0.07);

      const hudY = v.y + v.h - 16;
      ar.text("❤".repeat(Math.max(0, hearts)), v.x + 14, hudY - 30, { size: 22, color: "#ff3050" });
      ar.text(`SCORE ${score}`, v.x + 14, hudY, { size: 20, color: "#ffd84a" });
      if (state === "playing") {
        const s = Math.floor(elapsed);
        ar.text(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`, v.x + 14, hudY - 58, { size: 14 });
      }
      if (note && note.t < 2.6 && state === "playing") ar.text(note.text, v.cx, v.y + v.h * 0.3, { size: 18, align: "center", color: note.color, alpha: Math.min(1, 2.6 - note.t) });

      if (state === "title") {
        ar.flash("#000", 0.45);
        ar.banner("TEMPLE OF LYNXP", "Press FIRE to enter", { color: "#ffd84a" });
        ar.text("Jump pits (Space / gamepad A / ⤒), climb for treasure, solve the glyph floor, defeat the guardian.", v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
        const where = firstLevel < LAST_LEVEL ? `${LAST_LEVEL - firstLevel + 1} levels, each` : `Level ${firstLevel} is`;
        ar.text(`${where} laid out in front of the robot: about 2 m wide and 3 m deep.`, v.cx, v.cy + v.h * 0.26, { size: 13, align: "center" });
        if (best !== null) ar.text(`Best score on this robot: ${best}`, v.cx, v.cy + v.h * 0.32, { size: 14, align: "center", color: "#ffd84a" });
      } else if (state === "dead") {
        ar.flash("#000", 0.5);
        ar.banner("YOU DIED", `Score ${score}`);
        if (stateTime > 1.5) ar.text("Press FIRE to get up again (-500)", v.cx, v.cy + v.h * 0.22, { size: 14, align: "center" });
      } else if (state === "levelDone") {
        ar.flash("#000", 0.45);
        ar.banner(`LEVEL ${level} COMPLETE`, `${lv.relic.replace(/^the /, "The ")} is yours · bonus ${levelBonus} · score ${score}`, { color: "#ffd84a" });
        ar.text(`Next: level ${level + 1}, ${LEVELS[level + 1].name}. It is laid out afresh in front of the robot:`, v.cx, v.cy + v.h * 0.18, { size: 14, align: "center" });
        ar.text("place it with about 2 m x 3 m of free floor ahead.", v.cx, v.cy + v.h * 0.23, { size: 14, align: "center" });
        if (stateTime > 2) ar.text("Press FIRE to descend", v.cx, v.cy + v.h * 0.3, { size: 16, align: "center", color: "#ffd84a" });
      } else if (state === "won") {
        ar.flash("#000", 0.4);
        const s = Math.floor(elapsed);
        const title = firstLevel < LAST_LEVEL ? "THE TEMPLE IS CONQUERED" : lv.winTitle || "THE HEART IS YOURS";
        ar.banner(title, `Score ${score} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")} · ${deaths} deaths`, { color: "#ffd84a" });
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.18, { size: 16, align: "center", color: "#ffd84a" });
        if (stateTime > 2) ar.text("Press FIRE to play again", v.cx, v.cy + v.h * 0.25, { size: 14, align: "center" });
      }
    }

    // What levels 2 and 4 to 8 (game_temple_sanctum.js etc.) get to work with.
    const mazeApi = {
      ar, d, cfg, img, frame,
      anchor: () => anchor,
      time: () => stateTime,
      toWorld, toLocal, w3, camZ, polyScreen, fillPoly, line3, box, fence, onRim, extent, pointAt, drawSprite, texFloor, floorDetail, doorFace,
      hurt, say,
      addScore: (n) => (score += n),
      heal: () => (hearts < maxHearts ? hearts++ : (score += 100)),
      puff: (p) => puffs.push(p),
      complete: () => relicTaken(),
    };
    // The mazes' walls stop the robot: drive commands go through the maze first.
    if (Lynx.control && Lynx.control.setDriveFilter) {
      Lynx.control.setDriveFilter((j1, j2) => (maze && state !== "title" ? maze.filterDrive(j1, j2) : { j1, j2 }));
      ar.onDestroy(() => Lynx.control.setDriveFilter(null));
    }

    ar.onFrame((now, dt) => {
      update(dt);
      draw();
    });

    return {
      actionLabel: "\u{1F52B} Fire",
      debug: {
        god: (on) => (godMode = on),
        killScarabs: () => (scarabs = []),
        killBats: () => (bats = []),
        killWisps: () => (wisps = []),
        wisps: () => wisps.map((w) => ({ f: w.f, r: w.r, h: w.h })),
        solveGlyphs: () => {
          // memory floor: the order to step in
          if (lv.puzzle === "sequence") return seq.map((k) => [Math.floor(k / N), k % N]);
          // the presses that light every glyph (brute force), as "i,j" tiles
          for (let m = 0; m < 1 << (N * N); m++) {
            const save = lit.slice();
            for (let k = 0; k < N * N; k++) if (m & (1 << k)) flip(Math.floor(k / N), k % N);
            const ok = lit.every(Boolean);
            lit = save;
            if (ok) return [...Array(N * N).keys()].filter((k) => m & (1 << k)).map((k) => [Math.floor(k / N), k % N]);
          }
          return null;
        },
        tileCenter,
        crystals: () => crystals.filter((c) => c.alive).map((c) => ({ f: c.f, r: c.r, h: c.h })),
        level: (n) => startLevel(n), // jump straight to a level (1 to 8)
        maze: () => maze && maze.debug,
      },
      snapshot: () => {
        const me = anchor ? toLocal(ar.pose.x, ar.pose.y) : null;
        return {
          state, level, chamber, hearts, score, elapsed: +elapsed.toFixed(1),
          maze: maze && maze.snapshot(),
          seq: lv.puzzle === "sequence" ? { phase: seqPhase, pos: seqPos, len: seq.length } : null,
          darts: traps.filter((t) => t.dart).length,
          me: me && { f: +me.f.toFixed(3), r: +me.r.toFixed(3) },
          feet: +ar.feet().toFixed(3), ground: ar.ground, airborne: ar.airborne, solid, outside,
          lit: lit.map((x) => (x ? 1 : 0)).join(""), onTile, gateOpen,
          boss: boss && { state: boss.state, hp: boss.hp }, crystals: crystals.filter((c) => c.alive).length,
          bats: bats.length, wisps: wisps.length, scarabs: scarabs.length, fireballs: fireballs.length, rings: rings.length, items: items.map((i) => i.kind),
        };
      },
    };
  };
})(window.Lynx);
