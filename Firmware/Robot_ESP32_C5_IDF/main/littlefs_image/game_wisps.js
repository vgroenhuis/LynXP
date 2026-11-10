// Wisp Hollow -- a quiet puzzle at night, with real cubes. No enemies, no
// way to lose: a handful of wisps drift out of a spring, and you lead them
// home to their shrine across a meadow (20 x 20 tiles of 5 cm, laid out on
// the floor in front of the robot when a level starts).
//
// The cubes are lanterns. A wisp flies to the nearest lantern it can SEE and
// hasn't been to yet (a lantern's light reaches SIGHT tiles, and not through
// hedges or rocks); there it waits, circling. So you lay a trail -- and once
// a lantern has been visited, pick it up and set it down further on: moved,
// it counts as new. From the last lantern the wisps see the shrine itself.
//   Two cubes stacked: a tall lantern -- seen over hedges, twice as far.
//   A cube set in the water: a stepping stone (the wisps cross on it; no light).
//   A cube on a stone plate: a weight -- its gate stays open. The robot
//   itself, driven onto a plate, weighs too.
//   Sleepy moss: wisps crossing it fall asleep. FIRE rings the robot's bell:
//   the wisps near it wake (and stay awake a while), and hurry.
// Every tagged cube does (the frame cube's tags 24-29 aside); what a cube is
// depends only on where it stands. Each level brings one of these, on a card.
//
// Night-blooms open when a wisp passes close by. Stars: one for getting every
// wisp home, two with every bloom open as well, three for that within the
// level's time. P / the button: pause.
//
// Drawing: the 2D canvas through world3d.js -- textured ground (made here:
// night grass, water, moss, leaves, stone), hedges and rocks as boxes, light
// pools on the floor showing how far each lantern is seen, glowing wisps
// with trails -- all depth sorted (ar.queue).

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const N = 20; // tiles per side
  const SIGHT = 6; // tiles a lantern is seen from
  const SIGHT_TALL = 12; // ... a stack of two (and over hedges)
  const SIGHT_HOME = 7; // the shrine's own glow (over hedges too)
  const WISP_V = 0.055; // m/s (in a 1 m arena)
  const BELL_R = 0.4; // m: how far the robot's bell carries
  const AWAKE_S = 7; // a woken wisp isn't sleepy for this long
  const HEDGE_H = 0.05;

  // The levels: rows from the far end, one character a tile:
  //   . grass   # hedge   r rock   ~ water   m sleepy moss   b a night-bloom
  //   S the spring (2 x 2)   H the shrine (2 x 2)
  //   p plate -> G its gate   q plate -> Q its gate
  // wisps: how many; par: seconds for the third star; brings: the card's subject.
  const LEVELS = [
    { name: "First Light", blurb: "Lay a trail of lanterns to the shrine", wisps: 5, par: 100, brings: "lantern", map: [
      "....................",
      ".SS.................",
      ".SS.................",
      "....................",
      "......b.............",
      "....................",
      "........rr..........",
      "........rr..........",
      "....................",
      "...........b........",
      "....................",
      "....................",
      "..............b.....",
      "....................",
      "....................",
      "................HH..",
      "................HH..",
      "....................",
      "....................",
      "....................",
    ] },
    { name: "The Long Way Round", blurb: "More way than lanterns: move them on", wisps: 6, par: 170, brings: "leapfrog", map: [
      "....................",
      ".SS.................",
      ".SS..........b......",
      "....................",
      "....................",
      "....................",
      "################....",
      "....................",
      "....b...............",
      "....................",
      "....................",
      "..........b.........",
      "....################",
      "....................",
      "....................",
      "..............b.....",
      ".................HH.",
      ".................HH.",
      "....................",
      "....................",
    ] },
    { name: "Over the Hedge", blurb: "A spring walled in: stack a tall lantern", wisps: 6, par: 150, brings: "tall", map: [
      "....................",
      "....................",
      "....................",
      "...###########......",
      "...#.........#......",
      "...#.#######.#......",
      "...#.#SS...#.#...b..",
      "...#.#SS...#.#......",
      "...#.#####.#.#......",
      "...#.......#.#......",
      "...#########.#......",
      ".............#......",
      ".....b.......#......",
      "....................",
      "....................",
      "....................",
      "..HH.......b........",
      "..HH................",
      "....................",
      "....................",
    ] },
    { name: "Stepping Stones", blurb: "Two streams to cross", wisps: 6, par: 170, brings: "stone", map: [
      "....................",
      ".SS.................",
      ".SS.......b.........",
      "....................",
      "....................",
      "~~~~~~~~~~~~~~~~~~~~",
      "....................",
      "........rr..........",
      "...b....rr.....b....",
      "....................",
      "....................",
      "~~~~~~~~~~~~~~~~~~~~",
      "~~~~~~~~~~~~~~~~~~~~",
      "....................",
      "....................",
      "................HH..",
      "................HH..",
      "....................",
      "....................",
      "....................",
    ] },
    { name: "The Garden Gates", blurb: "Gates that open under a weight", wisps: 6, par: 170, brings: "plate", map: [
      "....................",
      ".SS.................",
      ".SS.................",
      "..............pp....",
      "......b.......pp....",
      "....................",
      "#########GG#########",
      "....................",
      "....................",
      "..qq.........b......",
      "..qq................",
      "....................",
      "#########QQ#########",
      "....................",
      "......b.............",
      "....................",
      ".........HH.........",
      ".........HH.........",
      "....................",
      "....................",
    ] },
    { name: "Sleepy Moss", blurb: "Moss, a stream, a gate: two ways home", wisps: 8, par: 240, brings: "moss", map: [
      "....................",
      ".SS.................",
      ".SS......#..........",
      ".........#....b.....",
      ".........#..........",
      "....b....#..........",
      "mmmmmmmmm#..........",
      "mmmmmmmmm#....pp....",
      ".........#....pp....",
      ".........#..........",
      "~~~~~~~~~####GG#####",
      "....................",
      "........b...........",
      "....................",
      "..######............",
      "..#....#.....b......",
      "..#.HH.#............",
      "..#.HH..............",
      "..######............",
      "....................",
    ] },
  ];
  const CARDS = {
    lantern: { title: "Lanterns", color: [255, 200, 110], lines: [
      "Your cubes are lanterns. A wisp flies to the nearest lantern it can see",
      "and hasn't visited yet -- the pool of light shows how far that is.",
      "Lay a trail from the spring to the shrine. Rocks block the light."] },
    leapfrog: { title: "Moving on", color: [255, 200, 110], lines: [
      "The way is longer than your lanterns reach.",
      "When the wisps are circling a lantern, pick up one they've left behind",
      "and set it down further on: moved, it is a new light to them."] },
    tall: { title: "A tall lantern", color: [255, 230, 150], lines: [
      "Hedges hide a lantern's light, and the lane is too narrow for a cube.",
      "Stack one cube on another: a tall lantern, seen over the hedges",
      "and from twice as far. The wisps find their own way round to it."] },
    stone: { title: "Stepping stones", color: [130, 200, 255], lines: [
      "Wisps can't cross water.",
      "A cube set down in the stream is a stepping stone: they cross on it.",
      "(A stone gives no light -- and it can be moved on to the next stream.)"] },
    plate: { title: "Plates and gates", color: [200, 190, 170], lines: [
      "A gate opens while something weighs on its stone plate:",
      "a cube -- or the robot itself. Drive onto a plate to hold its gate open.",
      "Each plate shows the colour of its gate."] },
    moss: { title: "Sleepy moss", color: [170, 220, 150], lines: [
      "Wisps that cross the soft moss fall asleep.",
      "FIRE rings the robot's bell: the wisps near the robot wake up,",
      "stay awake for a while, and hurry. Or find them another way."] },
  };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

  // -- textures: made in the browser, 128 x 128 px = 0.3 m, tiling ---------------------------------------------------
  function seeded(seed) {
    let t = seed;
    return () => {
      t = (t + 0x6d2b79f5) | 0;
      let x = Math.imul(t ^ (t >>> 15), 1 | t);
      x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
    };
  }
  function texture(seed, paint) {
    return () => {
      const c = document.createElement("canvas");
      c.width = 128;
      c.height = 128;
      const g = c.getContext("2d");
      const rnd = seeded(seed);
      const wrap = (x, y, r, fn) => {
        for (const dx of [-128, 0, 128]) for (const dy of [-128, 0, 128]) if (x + dx > -r && x + dx < 128 + r && y + dy > -r && y + dy < 128 + r) fn(x + dx, y + dy);
      };
      paint(g, rnd, wrap);
      return c;
    };
  }
  const strokes = (g, rnd, wrap, n, lenMin, lenMax, spread, colors, width = 1) => {
    for (let k = 0; k < n; k++) {
      const x = rnd() * 128;
      const y = rnd() * 128;
      const a = -Math.PI / 2 + (rnd() - 0.5) * spread;
      const l = lenMin + rnd() * (lenMax - lenMin);
      g.strokeStyle = colors[Math.floor(rnd() * colors.length)];
      g.lineWidth = width * (0.7 + rnd() * 0.6);
      wrap(x, y, l, (px, py) => {
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
        g.stroke();
      });
    }
  };
  const dots = (g, rnd, n, colors, size = 1) => {
    for (let k = 0; k < n; k++) {
      g.fillStyle = colors[Math.floor(rnd() * colors.length)];
      g.fillRect(rnd() * 128, rnd() * 128, size, size);
    }
  };
  const TEXTURES = {
    // the meadow at night: deep blue-green, pale blades catching the moon
    wh_grass: texture(101, (g, rnd, wrap) => {
      g.fillStyle = "#1d3a36";
      g.fillRect(0, 0, 128, 128);
      strokes(g, rnd, wrap, 900, 2, 6, 1.6, ["rgba(70,130,110,0.6)", "rgba(20,50,50,0.6)", "rgba(110,170,150,0.35)", "rgba(40,90,80,0.6)"]);
      dots(g, rnd, 60, ["rgba(200,230,255,0.5)"], 1);
    }),
    // water: dark, with pale ripples
    wh_water: texture(103, (g, rnd, wrap) => {
      g.fillStyle = "#12305a";
      g.fillRect(0, 0, 128, 128);
      for (let k = 0; k < 46; k++) {
        const x = rnd() * 128;
        const y = rnd() * 128;
        const l = 8 + rnd() * 18;
        g.strokeStyle = rnd() < 0.5 ? "rgba(150,200,255,0.45)" : "rgba(60,110,190,0.5)";
        g.lineWidth = 1 + rnd();
        wrap(x, y, l, (px, py) => {
          g.beginPath();
          g.moveTo(px - l / 2, py);
          g.quadraticCurveTo(px, py - 3, px + l / 2, py);
          g.stroke();
        });
      }
    }),
    // moss: soft cushions
    wh_moss: texture(107, (g, rnd, wrap) => {
      g.fillStyle = "#3c5a2c";
      g.fillRect(0, 0, 128, 128);
      for (let k = 0; k < 70; k++) {
        const x = rnd() * 128;
        const y = rnd() * 128;
        const r = 5 + rnd() * 9;
        wrap(x, y, r, (px, py) => {
          const gr = g.createRadialGradient(px - r * 0.3, py - r * 0.3, 0, px, py, r);
          gr.addColorStop(0, "rgba(150,200,110,0.75)");
          gr.addColorStop(1, "rgba(50,80,40,0)");
          g.fillStyle = gr;
          g.fillRect(px - r, py - r, 2 * r, 2 * r);
        });
      }
      dots(g, rnd, 500, ["rgba(190,230,150,0.5)", "rgba(20,40,15,0.5)"], 1);
    }),
    // hedges: leaves
    wh_leaves: texture(109, (g, rnd, wrap) => {
      g.fillStyle = "#16301c";
      g.fillRect(0, 0, 128, 128);
      for (let k = 0; k < 1100; k++) {
        const x = rnd() * 128;
        const y = rnd() * 128;
        const a = rnd() * Math.PI;
        const l = 1.5 + rnd() * 2.2;
        const v = 60 + rnd() * 80;
        g.fillStyle = `rgba(${v * 0.45},${v},${v * 0.5},0.85)`;
        wrap(x, y, l, (px, py) => {
          g.beginPath();
          g.ellipse(px, py, l, l * 0.45, a, 0, 2 * Math.PI);
          g.fill();
        });
      }
    }),
    // rocks and the shrine's stone
    wh_stone: texture(113, (g, rnd, wrap) => {
      g.fillStyle = "#5c6068";
      g.fillRect(0, 0, 128, 128);
      for (let k = 0; k < 26; k++) {
        const x = rnd() * 128;
        const y = rnd() * 128;
        const r = 8 + rnd() * 16;
        wrap(x, y, r, (px, py) => {
          const gr = g.createRadialGradient(px, py, 0, px, py, r);
          gr.addColorStop(0, rnd() < 0.5 ? "rgba(30,32,38,0.4)" : "rgba(160,165,175,0.35)");
          gr.addColorStop(1, "rgba(90,94,100,0)");
          g.fillStyle = gr;
          g.fillRect(px - r, py - r, 2 * r, 2 * r);
        });
      }
      dots(g, rnd, 1800, ["rgba(20,20,24,0.45)", "rgba(210,212,220,0.4)"], 1);
    }),
    // a plate: a carved slab
    wh_plate: texture(127, (g, rnd) => {
      g.fillStyle = "#77736a";
      g.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 6; i++) {
        for (let j = 0; j < 6; j++) {
          const x = (i * 128) / 6;
          const y = (j * 128) / 6;
          const s = 128 / 6;
          g.strokeStyle = "rgba(30,28,24,0.7)";
          g.strokeRect(x + 1, y + 1, s - 2, s - 2);
          g.strokeStyle = "rgba(255,250,235,0.35)";
          g.beginPath();
          g.arc(x + s / 2, y + s / 2, s * 0.28, 0, 2 * Math.PI);
          g.stroke();
        }
      }
      dots(g, rnd, 900, ["rgba(20,20,20,0.3)", "rgba(240,240,230,0.25)"], 1);
    }),
  };
  if (Lynx.registerTexture) Object.keys(TEXTURES).forEach((k) => Lynx.registerTexture(k, TEXTURES[k]));

  Lynx.games.wisps = (ar, cfg, app) => {
    const S = clamp(+cfg.arenaM || 1, 0.5, 2.5);
    const T = S / N;
    const w = Lynx.world3d(ar);
    const layer = Lynx.cubeLayer(ar, app, {});
    const frameTags = new Set(Lynx.FRAME_CUBE_TAGS || []);
    const tr = Lynx.tr || ((t) => t);
    const speedK = cfg.wispSpeed === "slow" ? 0.7 : cfg.wispSpeed === "fast" ? 1.4 : 1;

    let state = "title"; // title | playing | won
    let stateTime = 0;
    let time = 0; // the game's clock (stops while paused)
    let L = null;
    let levelIdx = 0;
    let tiles = null; // "grass" | "hedge" | "rock" | "water" | "moss" | "spring" | "home" | "plateP" | "plateQ" | "gateP" | "gateQ"
    let blooms = new Map(); // tile index -> {open, t}
    let springC = null; // world {x, y}: the spring's and the shrine's middles
    let homeC = null;
    let homeK = 0; // a shrine tile's index (the way home is measured to it)
    let wisps = [];
    let homeCount = 0;
    let playTime = 0; // seconds since the card was closed
    let stars = 0;
    let lastScore = 0;
    let lanterns = []; // this frame's: {key, tag, k, i, j, x, y, tall, h1}
    let stones = new Set(); // water tiles a cube stands in
    let cubeTiles = new Set(); // grass tiles a lantern stands on (in the way)
    let weights = { P: false, Q: false }; // a cube or the robot on a plate
    let gateOpen = { P: 0, Q: 0 }; // 0 shut .. 1 open
    let fields = new Map(); // target tile -> steps to it, per tile
    let fieldsAt = -1;
    let card = null; // {id, t}
    let toast = null;
    let rings = []; // the bell: {x, y, t}
    let sparks = []; // {x, y, h, t, color}
    let paused = false;
    let fakeBlocks = null; // (tests and the introduction: pretend cubes)
    let fakeRobot = null; // (... and a pretend robot position)
    let best = null;
    let rankMsg = "";
    Lynx.bestScore("wisps").then((b) => (best = b));

    const say = (text, color = "#ffe9a8", t = 2.4) => (toast = { text, color, t });
    const sfx = (n) => Lynx.sfx.play(n);
    const idx = (i, j) => i * N + j;
    const inside = (i, j) => i >= 0 && i < N && j >= 0 && j < N;
    const tileF = (i) => (N - 1 - i + 0.5) * T;
    const tileR = (j) => -S / 2 + (j + 0.5) * T;
    const tileOf = (x, y) => {
      const l = w.toLocal(x, y);
      const i = N - 1 - Math.floor(l.f / T);
      const j = Math.floor((l.r + S / 2) / T);
      return inside(i, j) ? { i, j } : null;
    };
    const tileWorld = (i, j) => w.toWorld(tileF(i), tileR(j));
    const q = (i, j, m = 0) => ({ f0: (N - 1 - i) * T + m, f1: (N - i) * T - m, r0: -S / 2 + j * T + m, r1: -S / 2 + (j + 1) * T - m });
    const robotXY = () => fakeRobot || { x: ar.pose.x, y: ar.pose.y };

    // -- the level ---------------------------------------------------------------------------------------------------
    const KIND = { ".": "grass", b: "grass", "#": "hedge", r: "rock", "~": "water", m: "moss", S: "spring", H: "home", p: "plateP", q: "plateQ", G: "gateP", Q: "gateQ" };
    function build(lv) {
      tiles = new Array(N * N);
      blooms = new Map();
      const sum = { spring: [0, 0, 0], home: [0, 0, 0] };
      lv.map.forEach((row, i) => {
        for (let j = 0; j < N; j++) {
          const ch = row[j];
          const kind = KIND[ch] || "grass";
          tiles[idx(i, j)] = kind;
          if (ch === "b") blooms.set(idx(i, j), { open: false, t: 0, i, j });
          if (kind === "spring" || kind === "home") {
            const p = tileWorld(i, j);
            sum[kind][0] += p.x;
            sum[kind][1] += p.y;
            sum[kind][2]++;
            if (kind === "home") homeK = idx(i, j);
          }
        }
      });
      springC = { x: sum.spring[0] / sum.spring[2], y: sum.spring[1] / sum.spring[2] };
      homeC = { x: sum.home[0] / sum.home[2], y: sum.home[1] / sum.home[2] };
    }
    // can light pass this tile? can a wisp step on it?
    const opaque = (k) => {
      const t = tiles[k];
      return t === "hedge" || t === "rock" || (t === "gateP" && gateOpen.P < 0.5) || (t === "gateQ" && gateOpen.Q < 0.5);
    };
    const walkable = (k) => {
      const t = tiles[k];
      if (t === "hedge" || t === "rock") return false;
      if (t === "water") return stones.has(k);
      if (t === "gateP") return gateOpen.P >= 0.5;
      if (t === "gateQ") return gateOpen.Q >= 0.5;
      return !cubeTiles.has(k);
    };
    // steps to a target tile from everywhere (the target itself counts even with a cube on it)
    function fieldTo(k0) {
      let d = fields.get(k0);
      if (d) return d;
      d = new Array(N * N).fill(Infinity);
      d[k0] = 0;
      const queue = [k0];
      while (queue.length) {
        const k = queue.shift();
        const i = Math.floor(k / N);
        const j = k % N;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const a = i + di;
          const b = j + dj;
          if (!inside(a, b)) continue;
          const k2 = idx(a, b);
          if (d[k2] !== Infinity || !walkable(k2)) continue;
          d[k2] = d[k] + 1;
          queue.push(k2);
        }
      }
      fields.set(k0, d);
      return d;
    }
    // a clear line between two tiles' middles? (hedges, rocks and shut gates are in the way)
    function clearLine(i0, j0, i1, j1) {
      const n = Math.max(1, Math.ceil(Math.hypot(i1 - i0, j1 - j0) * 2));
      for (let s = 1; s < n; s++) {
        const i = Math.round(i0 + ((i1 - i0) * s) / n);
        const j = Math.round(j0 + ((j1 - j0) * s) / n);
        if ((i === i0 && j === j0) || (i === i1 && j === j1)) continue;
        if (opaque(idx(i, j))) return false;
      }
      return true;
    }

    // -- flow --------------------------------------------------------------------------------------------------------
    function startLevel(n) {
      levelIdx = n;
      L = LEVELS[n];
      const th = ar.pose.theta;
      w.setAnchor({ x: ar.pose.x + Math.cos(th) * 0.2, y: ar.pose.y + Math.sin(th) * 0.2, th });
      build(L);
      wisps = [];
      for (let k = 0; k < L.wisps; k++) {
        const a = (2 * Math.PI * k) / L.wisps;
        wisps.push({
          x: springC.x + Math.cos(a) * T * 0.5, y: springC.y + Math.sin(a) * T * 0.5, anchor: { ...springC }, orbit: a, orbitR: T * (0.45 + 0.25 * (k % 3)),
          target: null, to: null, visited: new Set(), asleep: false, awake: 0, hurry: 0, home: false, think: k * 0.05, phase: Math.random() * 6, trail: [], hue: k / L.wisps,
        });
      }
      homeCount = 0;
      playTime = 0;
      stars = 0;
      rankMsg = "";
      gateOpen = { P: 0, Q: 0 };
      fields = new Map();
      rings = [];
      sparks = [];
      card = { id: L.brings, t: 0 };
      state = "playing";
      stateTime = 0;
      if (paused) togglePause(false);
      sfx("go");
    }

    function finish() {
      const openBlooms = [...blooms.values()].filter((b) => b.open).length;
      stars = 1 + (openBlooms === blooms.size ? 1 : 0) + (openBlooms === blooms.size && playTime <= L.par ? 1 : 0);
      const score = stars * 100 + openBlooms * 20 + Math.max(0, Math.round(L.par - playTime)) + 50 * levelIdx;
      state = "won";
      stateTime = 0;
      sfx("levelup");
      Lynx.submitScore("wisps", score).then((rank) => {
        rankMsg = rank ? `#${rank} on the robot's scoreboard!` : "";
        if (rank === 1) best = score;
      });
      lastScore = score;
      if (levelIdx + 1 < LEVELS.length) menu.select(levelIdx + 1);
    }

    const menu = Lynx.levelMenu(ar, {
      key: "wisps",
      levels: LEVELS.map((l) => ({ name: tr(l.name), note: `${l.wisps} wisps`, blurb: tr(l.blurb) })),
      active: () => state === "title",
      onStart: (i) => startLevel(i),
      color: "#a8e6ff",
    });

    // -- input -------------------------------------------------------------------------------------------------------
    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title") return startLevel(menu.sel);
      if (state === "won" && stateTime > 1.5) {
        state = "title";
        return;
      }
      if (state !== "playing" || paused) return;
      if (card) {
        card = null;
        return;
      }
      ringBell();
    });
    let bellAt = -10;
    function ringBell() {
      if (time - bellAt < 0.8) return;
      bellAt = time;
      const r = robotXY();
      rings.push({ x: r.x, y: r.y, t: 0 });
      sfx("gong");
      let woke = 0;
      wisps.forEach((ws) => {
        if (ws.home || Math.hypot(ws.x - r.x, ws.y - r.y) > BELL_R * S) return;
        if (ws.asleep) woke++;
        ws.asleep = false;
        ws.awake = AWAKE_S;
        ws.hurry = 4;
      });
      if (woke) say(woke === 1 ? "A wisp wakes up" : `${woke} wisps wake up`, "#c8ffd0", 1.6);
    }
    const touch = Lynx.touchButtons();
    const pauseBtn = touch.add("⏸ Pause", () => togglePause());
    function togglePause(on = !paused) {
      if (state !== "playing" && on) return;
      paused = on;
      if (pauseBtn && touch.relabel) touch.relabel(pauseBtn, paused ? "▶ Resume" : "⏸ Pause");
      sfx("click");
    }
    const onKey = (e) => {
      const t = e.target;
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA"))) return;
      if (e.code === "KeyP") togglePause();
    };
    const onHidden = () => document.hidden && state === "playing" && !paused && togglePause(true);
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onHidden);
    ar.onDestroy(() => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onHidden);
    });

    // -- the cubes: lanterns, stepping stones, weights ------------------------------------------------------------------
    function readCubes() {
      const real = (fakeBlocks || layer.blocks() || []).filter((b) => !frameTags.has(b.tag) && !b.inferred);
      const before = `${[...stones].join()}|${[...cubeTiles].join()}`;
      lanterns = [];
      stones = new Set();
      cubeTiles = new Set();
      const onPlate = { P: false, Q: false };
      real.forEach((b) => {
        if (b.level !== 0) return;
        const t = tileOf(b.x, b.y);
        if (!t) return;
        const k = idx(t.i, t.j);
        const kind = tiles[k];
        if (kind === "water") return stones.add(k);
        if (kind === "plateP" || kind === "plateQ") {
          onPlate[kind === "plateP" ? "P" : "Q"] = true;
          return;
        }
        if (kind === "hedge" || kind === "rock" || kind === "gateP" || kind === "gateQ") return;
        const tall = real.some((o) => o !== b && o.level >= 1 && Math.hypot(o.x - b.x, o.y - b.y) < b.half * 1.5);
        cubeTiles.add(k);
        lanterns.push({ key: `${b.tag}@${k}`, tag: b.tag, k, i: t.i, j: t.j, x: b.x, y: b.y, tall, h1: b.h1 + (tall ? 2 * b.half : 0) });
      });
      // the robot weighs too
      const r = robotXY();
      const rt = tileOf(r.x, r.y);
      if (rt) {
        for (let di = -1; di <= 1; di++) {
          for (let dj = -1; dj <= 1; dj++) {
            if (!inside(rt.i + di, rt.j + dj)) continue;
            const kind = tiles[idx(rt.i + di, rt.j + dj)];
            if (kind === "plateP") onPlate.P = true;
            else if (kind === "plateQ") onPlate.Q = true;
          }
        }
      }
      for (const g of ["P", "Q"]) {
        if (onPlate[g] !== weights[g]) sfx(onPlate[g] ? "gate" : "knock");
        weights[g] = onPlate[g];
      }
      if (before !== `${[...stones].join()}|${[...cubeTiles].join()}`) fields = new Map();
    }

    // -- the wisps ---------------------------------------------------------------------------------------------------
    // Seen from where the wisp is -- or from what it's circling (the spring, a
    // lantern): the pool of light on the floor is then exactly where the next
    // lantern can stand.
    function sees(ws, wt, lan) {
      const from = [wt];
      const at = tileOf(ws.anchor.x, ws.anchor.y);
      if (at) from.push(at);
      return from.some((t) => {
        const d = Math.hypot(lan.i - t.i, lan.j - t.j);
        if (lan.tall) return d <= SIGHT_TALL + 0.5;
        return d <= SIGHT + 0.5 && clearLine(t.i, t.j, lan.i, lan.j);
      });
    }
    function think(ws, wt) {
      const here = idx(wt.i, wt.j);
      // (a target gone -- its cube moved -- is dropped)
      if (ws.target && ws.target.key && !lanterns.some((l) => l.key === ws.target.key)) ws.target = null;
      let bestD = Infinity;
      let pick = null;
      lanterns.forEach((lan) => {
        if (ws.visited.has(lan.key) || !sees(ws, wt, lan)) return;
        const d = fieldTo(lan.k)[here];
        if (d < bestD) {
          bestD = d;
          pick = { key: lan.key, k: lan.k, x: lan.x, y: lan.y };
        }
      });
      if (!pick) {
        // no new lantern in sight: the shrine, if its glow reaches here
        const ht = { i: Math.floor(homeK / N), j: homeK % N };
        const at = tileOf(ws.anchor.x, ws.anchor.y) || wt;
        if (Math.min(Math.hypot(ht.i - wt.i, ht.j - wt.j), Math.hypot(ht.i - at.i, ht.j - at.j)) <= SIGHT_HOME + 0.5 && fieldTo(homeK)[here] < Infinity) pick = { key: null, k: homeK, x: homeC.x, y: homeC.y };
      }
      if (pick && (!ws.target || ws.target.k !== pick.k)) {
        ws.target = pick;
        ws.to = null;
      } else if (!pick && ws.target && ws.target.key === null) ws.target = null;
    }
    function stepWisp(ws, dt) {
      if (ws.home) return;
      ws.phase += dt;
      ws.awake = Math.max(0, ws.awake - dt);
      ws.hurry = Math.max(0, ws.hurry - dt);
      let wt = tileOf(ws.x, ws.y);
      if (!wt) {
        // (pushed off the meadow somehow: back to where it was circling)
        ws.x = ws.anchor.x;
        ws.y = ws.anchor.y;
        wt = tileOf(ws.x, ws.y);
        if (!wt) return;
      }
      const here = idx(wt.i, wt.j);
      // night-blooms open as it passes
      for (const b of blooms.values()) {
        if (b.open) continue;
        const p = tileWorld(b.i, b.j);
        if (Math.hypot(p.x - ws.x, p.y - ws.y) < T * 1.15) { // (on its tile, or passing right beside it)
          b.open = true;
          b.t = 0;
          sfx("coin");
          for (let n = 0; n < 6; n++) sparks.push({ x: p.x, y: p.y, h: 0.01, t: -n * 0.03, color: [255, 150, 220], a: n });
        }
      }
      if (tiles[here] === "moss" && ws.awake <= 0 && !ws.asleep) {
        ws.asleep = true;
        say("A wisp nods off in the moss -- ring the bell near it (FIRE)", "#c8ffd0", 2.6);
      }
      if (ws.asleep) return;
      ws.think -= dt;
      if (ws.think <= 0) {
        ws.think = 0.25;
        think(ws, wt);
      }
      const v = WISP_V * S * speedK * (ws.hurry > 0 ? 1.6 : 1);
      if (!ws.target) {
        // circling where it waits
        ws.orbit += dt * 1.1;
        const gx = ws.anchor.x + Math.cos(ws.orbit) * ws.orbitR;
        const gy = ws.anchor.y + Math.sin(ws.orbit) * ws.orbitR;
        const d = Math.hypot(gx - ws.x, gy - ws.y);
        const step = Math.min(d, v * 0.8 * dt);
        if (d > 1e-6) {
          ws.x += ((gx - ws.x) / d) * step;
          ws.y += ((gy - ws.y) / d) * step;
        }
        return;
      }
      const field = fieldTo(ws.target.k);
      // there? a lantern: within a tile and a bit of the cube; the shrine: on it
      if (ws.target.key && Math.hypot(ws.target.x - ws.x, ws.target.y - ws.y) < T * 1.35) {
        ws.visited.add(ws.target.key);
        ws.anchor = { x: ws.target.x, y: ws.target.y };
        ws.orbitR = T * (1.05 + 0.3 * Math.random());
        ws.orbit = Math.atan2(ws.y - ws.anchor.y, ws.x - ws.anchor.x);
        ws.target = null;
        ws.think = 0;
        sfx("tick");
        return;
      }
      if (!ws.target.key && tiles[here] === "home") {
        ws.home = true;
        homeCount++;
        sfx("power");
        for (let n = 0; n < 8; n++) sparks.push({ x: homeC.x, y: homeC.y, h: 0.03, t: -n * 0.03, color: [170, 230, 255], a: n });
        if (homeCount === wisps.length) finish();
        else say(`${homeCount} of ${wisps.length} home`, "#a8e6ff", 1.4);
        return;
      }
      if (field[here] === Infinity) {
        // (cut off -- a gate shut, a stone taken: wait here)
        ws.anchor = { x: ws.x, y: ws.y };
        ws.orbitR = T * 0.3;
        ws.target = null;
        return;
      }
      if (!ws.to || Math.hypot(tileWorld(ws.to.i, ws.to.j).x - ws.x, tileWorld(ws.to.i, ws.to.j).y - ws.y) < T * 0.2 || !walkableOrTarget(ws.to, ws.target.k)) {
        let bestD = field[here];
        let pick = null;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const a = wt.i + di;
          const b = wt.j + dj;
          if (!inside(a, b)) continue;
          const d = field[idx(a, b)];
          if (d < bestD) {
            bestD = d;
            pick = { i: a, j: b };
          }
        }
        ws.to = pick;
      }
      if (!ws.to) return;
      const p = tileWorld(ws.to.i, ws.to.j);
      const d = Math.hypot(p.x - ws.x, p.y - ws.y);
      const step = Math.min(d, v * dt);
      if (d > 1e-6) {
        ws.x += ((p.x - ws.x) / d) * step;
        ws.y += ((p.y - ws.y) / d) * step;
      }
    }
    const walkableOrTarget = (t, targetK) => idx(t.i, t.j) === targetK || walkable(idx(t.i, t.j));

    // -- update ------------------------------------------------------------------------------------------------------
    function update(dt) {
      if (paused && state === "playing") return;
      time += dt;
      stateTime += dt;
      if (toast && (toast.t -= dt) <= 0) toast = null;
      rings.forEach((r) => (r.t += dt));
      rings = rings.filter((r) => r.t < 0.9);
      sparks.forEach((s) => (s.t += dt));
      sparks = sparks.filter((s) => s.t < 0.9);
      blooms.forEach((b) => b.open && (b.t += dt));
      if (state !== "playing") return;
      if (card && (card.t += dt) > 18) card = null;
      readCubes();
      for (const g of ["P", "Q"]) {
        const was = gateOpen[g] >= 0.5;
        gateOpen[g] = clamp(gateOpen[g] + (weights[g] ? dt * 3 : -dt * 2), 0, 1);
        if (was !== gateOpen[g] >= 0.5) fields = new Map();
      }
      // (the ways are worked out afresh now and then: cheap, and nothing is missed)
      if (time - fieldsAt > 1) {
        fields = new Map();
        fieldsAt = time;
      }
      if (!card) playTime += dt;
      wisps.forEach((ws) => {
        stepWisp(ws, dt);
        if (!ws.home) {
          ws.trail.push({ x: ws.x, y: ws.y });
          if (ws.trail.length > 10) ws.trail.shift();
        }
      });
    }

    // -- drawing -----------------------------------------------------------------------------------------------------
    const FLOOR_ALPHA = 0.6;
    const texOn = typeof Lynx.texture === "function" && !!ar.texturedQuad;
    function floorTex(r, h, flat, tex, alpha = FLOOR_ALPHA) {
      if (texOn && Lynx.texture(tex)) w.floor(r, h, null, null, { detail: tex, alpha });
      else w.floor(r, h, flat.replace(/[\d.]+\)$/, `${alpha})`), null);
    }
    const HEDGE = { top: "#2c5a34", side: "#234a2a", dark: "#18361e", line: "rgba(5,20,8,0.6)", tex: "wh_leaves", topTex: "wh_leaves" };
    const ROCK = { top: "#7a7e86", side: "#5e6268", dark: "#44474c", line: "rgba(10,10,14,0.7)", tex: "wh_stone", topTex: "wh_stone" };
    const GATE = { P: [255, 170, 80], Q: [150, 130, 255] };
    const gateCol = (g) => {
      const c = GATE[g];
      return { top: rgb(c.map((v) => v * 0.75)), side: rgb(c.map((v) => v * 0.6)), dark: rgb(c.map((v) => v * 0.42)), line: "rgba(20,10,0,0.7)" };
    };
    const glowAt = (x, y, h, r, color, a = 1) => {
      const p = ar.project(x, y, h);
      if (!p) return;
      ar.queue(p.depth, () => ar.glow(p.x, p.y, Math.max(4, r * p.ppm), [[0, `rgba(255,255,255,${0.95 * a})`], [0.35, rgb(color, 0.75 * a)], [1, rgb(color, 0)]]));
    };

    function drawWorld() {
      // the ground, tile kinds in 2 x 2 patches where they're all grass (see Gem Bastion: no double layers)
      const grassy = (t) => t === "grass" || t === "hedge" || t === "rock";
      for (let a = 0; a < N; a += 2) {
        for (let b = 0; b < N; b += 2) {
          const four = [[0, 0], [0, 1], [1, 0], [1, 1]].map(([da, db]) => grassy(tiles[idx(N - 1 - (a + da), b + db)]));
          if (four.every(Boolean)) floorTex({ f0: a * T, f1: (a + 2) * T, r0: -S / 2 + b * T, r1: -S / 2 + (b + 2) * T }, 0.0002, "rgba(30,60,56,1)", "wh_grass");
          else [[0, 0], [0, 1], [1, 0], [1, 1]].forEach(([da, db], n) => four[n] && floorTex(q(N - 1 - (a + da), b + db), 0.0002, "rgba(30,60,56,1)", "wh_grass"));
        }
      }
      w.line3([[0, -S / 2, 0.0006], [S, -S / 2, 0.0006], [S, S / 2, 0.0006], [0, S / 2, 0.0006], [0, -S / 2, 0.0006]], "rgba(150,200,220,0.6)", 2, T);
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const k = idx(i, j);
          const t = tiles[k];
          if (t === "water") {
            floorTex(q(i, j), 0.0003, "rgba(20,50,100,1)", "wh_water", 0.8);
            w.floor(q(i, j), 0.0005, `rgba(150,200,255,${0.06 + 0.05 * Math.sin(time * 2 + i * 1.3 + j * 0.7)})`, null);
          } else if (t === "moss") floorTex(q(i, j), 0.0003, "rgba(70,100,50,1)", "wh_moss", 0.85);
          else if (t === "plateP" || t === "plateQ") {
            const g = t === "plateP" ? "P" : "Q";
            floorTex(q(i, j), 0.0004, "rgba(120,116,108,1)", "wh_plate", 0.9);
            w.floor(q(i, j, 0.003), 0.0006, rgb(GATE[g], weights[g] ? 0.45 : 0.12), rgb(GATE[g], 0.9), { width: 1.5 });
          } else if (t === "spring") {
            floorTex(q(i, j), 0.0003, "rgba(20,60,110,1)", "wh_water", 0.9);
            w.floor(q(i, j), 0.0005, `rgba(140,230,255,${0.18 + 0.1 * Math.sin(time * 3 + i + j)})`, null);
          } else if (t === "home") {
            floorTex(q(i, j), 0.0003, "rgba(110,112,120,1)", "wh_stone", 0.95);
            w.floor(q(i, j), 0.0005, `rgba(170,230,255,${0.14 + 0.08 * Math.sin(time * 2.2)})`, "rgba(190,235,255,0.7)");
          } else if (t === "hedge") w.box(q(i, j), 0, HEDGE_H, HEDGE);
          else if (t === "rock") w.box(q(i, j, 0.004), 0, 0.032, ROCK);
          else if (t === "gateP" || t === "gateQ") {
            const g = t === "gateP" ? "P" : "Q";
            const up = 1 - gateOpen[g];
            w.floor(q(i, j), 0.0004, rgb(GATE[g], 0.15), rgb(GATE[g], 0.6));
            if (up > 0.03) w.box(q(i, j, 0.006), 0, HEDGE_H * 1.1 * up, gateCol(g), { alpha: 0.85 });
          }
        }
      }
      // the spring's and the shrine's lights
      glowAt(springC.x, springC.y, 0.015 + Math.sin(time * 2) * 0.004, 0.035, [120, 220, 255], 0.8);
      const hp = ar.project(homeC.x, homeC.y, 0.05);
      if (hp) {
        ar.queue(hp.depth, () => {
          // a standing stone with a blue flame over it
          const g = ar.ctx;
          const base = ar.project(homeC.x, homeC.y, 0);
          if (base) {
            const wd = Math.max(4, 0.016 * hp.ppm);
            const gr = g.createLinearGradient(base.x - wd, 0, base.x + wd, 0);
            gr.addColorStop(0, "#8f949c");
            gr.addColorStop(1, "#4a4d54");
            g.fillStyle = gr;
            g.beginPath();
            g.moveTo(base.x - wd, base.y);
            g.lineTo(base.x - wd * 0.7, hp.y);
            g.lineTo(base.x + wd * 0.7, hp.y);
            g.lineTo(base.x + wd, base.y);
            g.closePath();
            g.fill();
          }
          const fl = 1 + 0.15 * Math.sin(time * 9);
          ar.glow(hp.x, hp.y - 0.012 * hp.ppm, Math.max(8, 0.03 * hp.ppm * fl), [[0, "rgba(255,255,255,0.95)"], [0.3, "rgba(150,220,255,0.8)"], [1, "rgba(80,160,255,0)"]]);
        });
      }
      // night-blooms: a bud, or five glowing petals
      blooms.forEach((b) => {
        const p0 = tileWorld(b.i, b.j);
        const p = ar.project(p0.x, p0.y, 0.012);
        if (!p) return;
        ar.queue(p.depth, () => {
          const g = ar.ctx;
          const sz = Math.max(3, 0.011 * p.ppm);
          const stem = ar.project(p0.x, p0.y, 0);
          if (stem) {
            g.strokeStyle = "#4f9a5a";
            g.lineWidth = Math.max(1, sz * 0.2);
            g.beginPath();
            g.moveTo(stem.x, stem.y);
            g.lineTo(p.x, p.y);
            g.stroke();
          }
          if (!b.open) {
            g.fillStyle = "#7a5aa0";
            g.beginPath();
            g.ellipse(p.x, p.y, sz * 0.45, sz * 0.7, 0, 0, 2 * Math.PI);
            g.fill();
            return;
          }
          const k = Math.min(1, b.t * 3);
          ar.glow(p.x, p.y, sz * 2.4 * k, [[0, "rgba(255,200,240,0.7)"], [1, "rgba(255,120,220,0)"]]);
          for (let n = 0; n < 5; n++) {
            const a = (2 * Math.PI * n) / 5 + time * 0.3;
            g.fillStyle = n % 2 ? "#ff9ada" : "#ffc4ec";
            g.beginPath();
            g.ellipse(p.x + Math.cos(a) * sz * 0.6 * k, p.y + Math.sin(a) * sz * 0.4 * k, sz * 0.55 * k, sz * 0.3 * k, a, 0, 2 * Math.PI);
            g.fill();
          }
          g.fillStyle = "#fff4b0";
          g.beginPath();
          g.arc(p.x, p.y, sz * 0.28, 0, 2 * Math.PI);
          g.fill();
        });
      });
    }

    function drawCubes() {
      // lanterns: the pool of light (how far it's seen), a flame over the cube
      lanterns.forEach((lan) => {
        const reach = (lan.tall ? SIGHT_TALL : SIGHT) * T;
        const col = lan.tall ? [255, 235, 170] : [255, 190, 100];
        ar.floorCircle(lan.x, lan.y, reach, rgb(col, lan.tall ? 0.05 : 0.07), rgb(col, 0.4));
        ar.floorCircle(lan.x, lan.y, T * 0.9, rgb(col, 0.25), null);
        const flick = 1 + 0.12 * Math.sin(time * 11 + lan.tag);
        const p = ar.project(lan.x, lan.y, lan.h1 + 0.014);
        if (!p) return;
        ar.queue(p.depth, () => {
          const g = ar.ctx;
          const sz = Math.max(4, (lan.tall ? 0.016 : 0.011) * p.ppm);
          ar.glow(p.x, p.y, sz * 3.2 * flick, [[0, rgb(col, 0.6)], [1, rgb(col, 0)]]);
          // the flame: a teardrop
          g.fillStyle = "#ffd070";
          g.beginPath();
          g.moveTo(p.x, p.y - sz * 1.5 * flick);
          g.quadraticCurveTo(p.x + sz * 0.9, p.y + sz * 0.1, p.x, p.y + sz * 0.7);
          g.quadraticCurveTo(p.x - sz * 0.9, p.y + sz * 0.1, p.x, p.y - sz * 1.5 * flick);
          g.fill();
          g.fillStyle = "#fffbe0";
          g.beginPath();
          g.ellipse(p.x, p.y + sz * 0.15, sz * 0.3, sz * 0.5, 0, 0, 2 * Math.PI);
          g.fill();
          if (lan.tall) ar.text("★", p.x, p.y - sz * 2.2, { size: 12, align: "center", color: "#fff0b0" });
        });
      });
      // stepping stones: ripples round the cube
      stones.forEach((k) => {
        const p = tileWorld(Math.floor(k / N), k % N);
        for (let n = 0; n < 2; n++) {
          const u = (time * 0.5 + n * 0.5) % 1;
          ar.floorCircle(p.x, p.y, T * (0.5 + 0.5 * u), null, `rgba(190,230,255,${0.7 * (1 - u)})`);
        }
      });
    }

    function drawWisps() {
      wisps.forEach((ws) => {
        if (ws.home) return;
        const onStone = (() => {
          const t = tileOf(ws.x, ws.y);
          return t && stones.has(idx(t.i, t.j));
        })();
        const h = (onStone ? 0.055 : 0.022) + (ws.asleep ? -0.012 : Math.sin(ws.phase * 3) * 0.005);
        const col = ws.asleep ? [150, 130, 200] : [150 + 60 * ws.hue, 235, 255 - 40 * ws.hue];
        // the trail
        ws.trail.forEach((pt, n) => {
          if (n % 2 || ws.asleep) return;
          const k = n / ws.trail.length;
          glowAt(pt.x, pt.y, h * 0.8, 0.004 + 0.004 * k, col, 0.35 * k);
        });
        const p = ar.project(ws.x, ws.y, h);
        if (!p) return;
        ar.queue(p.depth, () => {
          const g = ar.ctx;
          const r = Math.max(3, 0.009 * p.ppm);
          ar.floorCircle(ws.x, ws.y, 0.012, rgb(col, 0.12), null);
          ar.glow(p.x, p.y, r * (ws.asleep ? 1.6 : 2.6), [[0, `rgba(255,255,255,${ws.asleep ? 0.6 : 0.95})`], [0.3, rgb(col, ws.asleep ? 0.5 : 0.85)], [1, rgb(col, 0)]]);
          // two little eyes (shut when asleep)
          g.strokeStyle = "rgba(20,40,70,0.85)";
          g.fillStyle = "rgba(20,40,70,0.85)";
          g.lineWidth = Math.max(1, r * 0.14);
          for (const sd of [-1, 1]) {
            g.beginPath();
            if (ws.asleep) {
              g.moveTo(p.x + sd * r * 0.32 - r * 0.14, p.y);
              g.lineTo(p.x + sd * r * 0.32 + r * 0.14, p.y);
              g.stroke();
            } else {
              g.arc(p.x + sd * r * 0.32, p.y - r * 0.05, r * 0.13, 0, 2 * Math.PI);
              g.fill();
            }
          }
          if (ws.asleep) ar.text("z", p.x + r * 1.2, p.y - r * 1.2 - 3 * Math.sin(ws.phase * 2), { size: Math.max(9, r * 1.1), color: "#d8c8ff" });
        });
      });
      rings.forEach((rg) => {
        const u = rg.t / 0.9;
        ar.floorCircle(rg.x, rg.y, BELL_R * S * u, null, `rgba(255,230,150,${1 - u})`);
        ar.floorCircle(rg.x, rg.y, BELL_R * S * u * 0.7, null, `rgba(255,255,220,${0.6 * (1 - u)})`);
      });
      sparks.forEach((s) => {
        if (s.t < 0) return;
        const u = s.t / 0.9;
        const a = s.a * 1.1;
        glowAt(s.x + Math.cos(a) * u * 0.05, s.y + Math.sin(a) * u * 0.05, s.h + u * 0.06, 0.006, s.color, 1 - u);
      });
    }

    function drawCard(v) {
      const g = ar.ctx;
      const C = CARDS[card.id];
      const small = Lynx.smallScreen();
      const wdt = Math.min(660, v.w - 30);
      const size = small ? 12 : 14;
      const lines = C.lines.map((t) => tr(t));
      const hgt = 62 + lines.length * (size + 8) + 34;
      const x0 = v.cx - wdt / 2;
      const y0 = v.cy - hgt / 2;
      g.save();
      g.globalAlpha = Math.min(1, card.t * 4, (18 - card.t) * 2);
      g.fillStyle = "rgba(8,14,30,0.9)";
      g.strokeStyle = rgb(C.color, 0.9);
      g.lineWidth = 2;
      g.beginPath();
      if (g.roundRect) g.roundRect(x0, y0, wdt, hgt, 12);
      else g.rect(x0, y0, wdt, hgt);
      g.fill();
      g.stroke();
      ar.text(tr(C.title), v.cx, y0 + 36, { size: small ? 17 : 22, align: "center", color: rgb(C.color) });
      lines.forEach((t, i) => ar.text(t, v.cx, y0 + 66 + i * (size + 8), { size, align: "center" }));
      ar.text("FIRE / click: begin", v.cx, y0 + hgt - 14, { size: 12, align: "center", color: "#a8e6ff" });
      g.restore();
    }

    function draw() {
      const v = ar.view;
      if (state === "playing" || state === "won") {
        w.beginFrame();
        drawWorld();
        drawCubes();
        drawWisps();
      }
      ar.flush();
      if (state === "title") {
        const small = Lynx.smallScreen();
        ar.flash("#02040c", 0.65);
        ar.text("WISP HOLLOW", v.cx, v.y + (small ? 40 : 62), { size: small ? 28 : 44, align: "center", color: "#a8e6ff", font: "Impact, 'Arial Black', sans-serif", weight: "normal" });
        if (!small) ar.text("Lead the wisps home with your cubes: lanterns, stepping stones, weights -- no enemies, no hurry", v.cx, v.y + 90, { size: 13, align: "center" });
        ar.text(`The meadow (${Math.round(S * 100)} x ${Math.round(S * 100)} cm) is laid out on the floor right in front of the robot`, v.cx, v.y + (small ? 60 : 110), { size: small ? 11 : 13, align: "center" });
        menu.draw(v.y + (small ? 76 : 128), v.y + v.h - 90);
        if (best !== null) ar.text(`Best on this robot: ${best}`, v.cx, v.y + v.h - 36, { size: 14, align: "center", color: "#a8e6ff" });
        return;
      }
      // HUD
      const x0 = v.x + 14;
      const openBlooms = [...blooms.values()].filter((b) => b.open).length;
      ar.text(`Wisps home ${homeCount}/${wisps.length}`, x0, v.y + 26, { size: 17, color: "#a8e6ff" });
      ar.text(`Blooms ${openBlooms}/${blooms.size}`, x0, v.y + 48, { size: 15, color: "#ffb0e0" });
      const s = Math.floor(playTime);
      ar.text(`${tr(L.name)} · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}${playTime <= L.par ? "" : " (past the third star)"}`, v.x + v.w - 14, v.y + 26, { size: 15, align: "right" });
      if (state === "playing" && !card) {
        const asleep = wisps.filter((ws) => ws.asleep).length;
        const waiting = wisps.filter((ws) => !ws.home && !ws.target && !ws.asleep).length;
        const hint = asleep ? `${asleep} asleep in the moss: drive close and ring the bell (FIRE)` : !lanterns.length && !homeCount ? "Set a cube down in the meadow, within the spring's sight: a lantern" : waiting === wisps.length - homeCount ? "The wisps are waiting: they need a new lantern in sight (move one on)" : "";
        if (hint) ar.text(hint, v.cx, v.y + v.h - 18, { size: 13, align: "center", color: "#ffe9a8" });
      }
      if (toast && !card) ar.text(toast.text, v.cx, v.y + v.h * 0.3, { size: 19, align: "center", color: toast.color, alpha: clamp(toast.t * 2, 0, 1) });
      if (layer.drawStatus) layer.drawStatus();
      if (card && state === "playing") drawCard(v);
      if (paused && state === "playing") {
        ar.flash("#000", 0.35);
        ar.banner("PAUSED", "P or the Pause button: carry on", { color: "#a8e6ff" });
      }
      if (state === "won") {
        ar.flash("#02040c", 0.5);
        ar.banner("ALL HOME", `${tr(L.name)} · ${"★".repeat(stars)}${"☆".repeat(3 - stars)} · score ${lastScore}`, { color: "#a8e6ff" });
        const why = stars === 3 ? "Every wisp home, every bloom open, in good time" : stars === 2 ? `Every bloom open -- the third star: within ${L.par} s` : "Two stars: lead a wisp past every night-bloom";
        ar.text(why, v.cx, v.cy + v.h * 0.16, { size: 14, align: "center" });
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.21, { size: 15, align: "center", color: "#a8e6ff" });
        if (stateTime > 1.5) ar.text("Press FIRE for the level menu", v.cx, v.cy + v.h * 0.27, { size: 14, align: "center" });
      }
    }

    ar.onFrame((now, dt) => {
      update(Math.min(dt, 0.1));
      draw();
    });
    return {
      actionLabel: "🔔 Bell",
      snapshot: () => ({
        state, level: L && L.name, home: homeCount, wisps: wisps.length, blooms: [...blooms.values()].filter((b) => b.open).length, time: Math.round(playTime), stars,
        lanterns: lanterns.map((l) => `${l.tag}@${l.i},${l.j}${l.tall ? " tall" : ""}`), stones: stones.size, gates: { ...weights },
        asleep: wisps.filter((ws) => ws.asleep).length, waiting: wisps.filter((ws) => !ws.home && !ws.target && !ws.asleep).length,
      }),
      debug: {
        tileWorld, startLevel: (n) => startLevel(n), closeCard: () => (card = null),
        // pretend cubes [{tag, i, j, level}] on tiles, and a pretend robot on a tile (null: the real ones)
        setCubes(list) {
          fakeBlocks = list ? list.map((c) => ({ id: `fake${c.tag}`, tag: c.tag, ...tileWorld(c.i, c.j), yaw: 0, level: c.level || 0, h0: (c.level || 0) * 0.04, h1: (c.level || 0) * 0.04 + 0.04, half: 0.02, inferred: false, n: 9 })) : null;
        },
        setRobot: (i, j) => (fakeRobot = i === null ? null : tileWorld(i, j)),
        wisps: () => wisps,
      },
    };
  };
})(window.Lynx);
