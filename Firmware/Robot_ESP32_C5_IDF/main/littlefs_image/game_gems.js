// Gem Bastion -- tower defense with real cubes. The arena (1 x 1 m by
// default: 20 x 20 tiles of 5 cm) is laid out on the floor in front of the
// robot when a level starts. Monsters come in at the entries and walk to the
// crystal; every one that gets there cracks it. Every tagged cube (the frame
// cube's tags 24-29 aside) is a tower: a gem floats above it and shoots the
// monsters in reach.
//
// Gems: each cube's tag decides its kind (tag mod 4): ruby (heavy hits that
// splash), emerald (poison), sapphire (slows), topaz (lightning that jumps on
// to more monsters). A cube seen for the first time in a level gets a grade 1
// gem -- a rounded triangle; every grade has its own shape (see gemOutline:
// triangle, the same with its bottom curved in, square, ... stars from 10)
// and more power and reach.
//   Merging: stack one cube on another. After a moment the two gems become
//   one, in the bottom cube: two of the same grade make one grade higher;
//   different grades give the higher one -- the kinds mix either way (colour
//   and effects by the gems' weight). The top cube is then empty.
//   A new gem: put an empty cube on the golden home field for a moment
//   (costs mana; mana comes from monsters slain, and slowly by itself).
//
// Levels: a road (the monsters keep to it) or an open field, where the
// monsters find their own way to the crystal -- around the rocks, the cubes
// standing in the arena and the walls you build: click a tile with the
// mouse, or aim the middle of the camera at it and press FIRE (again on a
// wall: taken down, half its price back). A wall may not shut the way
// completely; if the cubes do, the monsters climb over them. Space /
// gamepad A / the touch button: call the next wave now (bonus mana).
// P / the Pause button (or the tab hidden): pause -- walls can still be built.
// A tower's reach (a circle on the floor; a monster is in reach when its
// centre is): shown when the crosshair is on it or next to it, for 10 s after
// its cube was moved or set down, and for all of them with R / the button.
//
// Drawing: the 2D canvas through world3d.js, textured (textures made here,
// in the browser: grass, earth, bricks, granite, gold, crystal, the gates'
// swirl), the gems as cut stones, the monsters as bodies of a few 3D parts
// (a beetle, a sprinter, a wasp, a stone golem, a crystal giant); all depth
// sorted (ar.queue).

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const N = 20; // tiles per side
  const KINDS = [
    { id: "ruby", name: "ruby", color: [255, 48, 72] },
    { id: "emerald", name: "emerald", color: [48, 224, 112] },
    { id: "sapphire", name: "sapphire", color: [58, 123, 255] },
    { id: "topaz", name: "topaz", color: [255, 192, 32] },
  ];
  const START_WAIT_S = 25; // before the first wave: time to set the cubes out
  const WAVE_GAP_S = 14;
  const HOME_S = 1.2; // an empty cube this long on the home field: a new gem
  const MERGE_S = 0.8; // two cubes stacked this long: merged
  const WALL_COST = 4;
  const GEM_COST = 30;
  const DIFF = { easy: 0.7, normal: 1, hard: 1.4 };
  const MONSTERS = {
    crawler: { hp: 1, speed: 0.05, r: 0.012, color: "#6ab04c", bounty: 3, harm: 1, armor: 0 },
    runner: { hp: 0.5, speed: 0.09, r: 0.009, color: "#a05ae0", bounty: 2, harm: 1, armor: 0 },
    swarm: { hp: 0.3, speed: 0.065, r: 0.007, color: "#e0a030", bounty: 1, harm: 1, armor: 0 },
    brute: { hp: 3.2, speed: 0.032, r: 0.017, color: "#a0503a", bounty: 7, harm: 3, armor: 3 },
    boss: { hp: 14, speed: 0.028, r: 0.024, color: "#5a2a70", bounty: 40, harm: 8, armor: 5 },
  };

  // The levels. Rows are counted from the far end (0) toward the robot (19),
  // columns from the left. road: polylines of [row, col] corners (the first
  // point an entry); base / home: a 2 x 2 square's top-left; entries: open
  // field's entry tiles; rocks: blocked tiles.
  const LEVELS = [
    { name: "Meadow Road", blurb: "A winding road -- learn to merge your gems", waves: 8, mana: 40,
      road: [[[0, 4], [5, 4], [5, 15], [10, 15], [10, 4], [15, 4], [15, 10], [17, 10]]], base: [17, 10], home: [17, 13] },
    { name: "Twin Gates", blurb: "Two roads, one crystal", waves: 10, mana: 50,
      road: [[[0, 3], [8, 3], [8, 9], [16, 9]], [[0, 16], [8, 16], [8, 10], [16, 10]]], base: [16, 9], home: [16, 12] },
    { name: "Open Field", blurb: "No road: build walls and make them walk", waves: 10, mana: 90,
      entries: [[0, 8], [0, 9], [0, 10], [0, 11]], base: [17, 9], home: [17, 12],
      rocks: [[5, 3], [5, 4], [6, 15], [7, 15], [11, 6], [11, 13], [12, 13]] },
    { name: "The Spiral", blurb: "A long road coiled round the crystal", waves: 12, mana: 50,
      road: [[[0, 2], [17, 2], [17, 17], [2, 17], [2, 5], [14, 5], [14, 14], [5, 14], [5, 8], [11, 8], [11, 11]]], base: [12, 10], home: [12, 12] },
    { name: "Crossroads", blurb: "Open field, two ways in, quick monsters", waves: 12, mana: 110, speed: 1.15,
      entries: [[8, 0], [9, 0], [10, 0], [11, 0], [0, 8], [0, 9], [0, 10], [0, 11]], base: [17, 15], home: [17, 12],
      rocks: [[4, 4], [4, 5], [5, 4], [9, 12], [10, 12], [14, 7], [14, 8], [3, 15], [3, 16]] },
    { name: "Last Stand", blurb: "Three gates, fifteen waves", waves: 15, mana: 130, hp: 1.2,
      entries: [[9, 0], [10, 0], [0, 9], [0, 10], [9, 19], [10, 19]], base: [17, 9], home: [17, 12] },
  ];

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // -- textures: made in the browser, 128 x 128 px = 0.3 m, tiling ------------------------------------------------
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
      // draws at (x, y) and wherever it wraps round the edges
      const wrap = (x, y, r, fn) => {
        for (const dx of [-128, 0, 128]) for (const dy of [-128, 0, 128]) if (x + dx > -r && x + dx < 128 + r && y + dy > -r && y + dy < 128 + r) fn(x + dx, y + dy);
      };
      paint(g, rnd, wrap);
      return c;
    };
  }
  const blobs = (g, rnd, wrap, n, rMin, rMax, colors) => {
    for (let k = 0; k < n; k++) {
      const x = rnd() * 128;
      const y = rnd() * 128;
      const r = rMin + rnd() * (rMax - rMin);
      const col = colors[Math.floor(rnd() * colors.length)];
      wrap(x, y, r, (px, py) => {
        const gr = g.createRadialGradient(px, py, 0, px, py, r);
        gr.addColorStop(0, col);
        gr.addColorStop(1, col.replace(/[\d.]+\)$/, "0)"));
        g.fillStyle = gr;
        g.fillRect(px - r, py - r, 2 * r, 2 * r);
      });
    }
  };
  const TEXTURES = {
    // grass: mottled ground, then hundreds of short blades and a few clover leaves
    gb_grass: texture(31, (g, rnd, wrap) => {
      g.fillStyle = "#4a7334";
      g.fillRect(0, 0, 128, 128);
      blobs(g, rnd, wrap, 40, 8, 26, ["rgba(90,130,50,0.35)", "rgba(40,70,25,0.35)", "rgba(110,120,50,0.25)"]);
      for (let k = 0; k < 900; k++) {
        const x = rnd() * 128;
        const y = rnd() * 128;
        const a = -Math.PI / 2 + (rnd() - 0.5) * 1.6;
        const l = 2 + rnd() * 4;
        const shade = rnd();
        g.strokeStyle = shade < 0.5 ? `rgba(${120 + rnd() * 60},${170 + rnd() * 50},${70 + rnd() * 30},0.7)` : `rgba(${30 + rnd() * 20},${70 + rnd() * 30},${20 + rnd() * 15},0.6)`;
        g.lineWidth = 0.8 + rnd() * 0.6;
        wrap(x, y, l, (px, py) => {
          g.beginPath();
          g.moveTo(px, py);
          g.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
          g.stroke();
        });
      }
      for (let k = 0; k < 14; k++) {
        const x = rnd() * 128;
        const y = rnd() * 128;
        g.fillStyle = "rgba(150,200,90,0.55)";
        wrap(x, y, 3, (px, py) => {
          for (let l = 0; l < 3; l++) {
            g.beginPath();
            g.arc(px + Math.cos(l * 2.1) * 1.4, py + Math.sin(l * 2.1) * 1.4, 1.3, 0, 2 * Math.PI);
            g.fill();
          }
        });
      }
    }),
    // the road: packed earth, ruts, gravel and pebbles
    gb_dirt: texture(37, (g, rnd, wrap) => {
      g.fillStyle = "#8a6a44";
      g.fillRect(0, 0, 128, 128);
      blobs(g, rnd, wrap, 40, 6, 22, ["rgba(120,92,60,0.4)", "rgba(96,72,46,0.4)", "rgba(150,120,84,0.3)"]);
      for (let k = 0; k < 1400; k++) {
        const x = rnd() * 128;
        const y = rnd() * 128;
        g.fillStyle = rnd() < 0.5 ? "rgba(60,44,28,0.45)" : "rgba(190,160,120,0.35)";
        g.fillRect(x, y, 1, 1);
      }
      for (let k = 0; k < 26; k++) {
        const x = rnd() * 128;
        const y = rnd() * 128;
        const r = 1.2 + rnd() * 2.6;
        const v = 120 + rnd() * 70;
        wrap(x, y, r + 1, (px, py) => {
          g.fillStyle = "rgba(40,30,20,0.4)";
          g.beginPath();
          g.ellipse(px + 0.6, py + 0.8, r, r * 0.75, 0, 0, 2 * Math.PI);
          g.fill();
          g.fillStyle = `rgb(${v},${v - 6},${v - 14})`;
          g.beginPath();
          g.ellipse(px, py, r, r * 0.75, 0, 0, 2 * Math.PI);
          g.fill();
          g.fillStyle = "rgba(255,255,255,0.35)";
          g.beginPath();
          g.ellipse(px - r * 0.3, py - r * 0.3, r * 0.35, r * 0.25, 0, 0, 2 * Math.PI);
          g.fill();
        });
      }
    }),
    // walls: small stone bricks in courses
    gb_brick: texture(41, (g, rnd) => {
      g.fillStyle = "#5c574e";
      g.fillRect(0, 0, 128, 128);
      const bh = 8;
      for (let row = 0; row < 128 / bh; row++) {
        let x = row % 2 ? -6 : 0;
        while (x < 128) {
          const bw = 12 + Math.floor(rnd() * 6);
          const v = 140 + (rnd() - 0.5) * 34;
          const w2 = Math.min(bw, 128 - x);
          for (const dx of [0, x < 0 ? 128 : 0]) {
            g.fillStyle = `rgb(${v + 8},${v},${v - 12})`;
            g.fillRect(x + dx + 1, row * bh + 1, w2 - 2, bh - 2);
            g.fillStyle = "rgba(255,250,235,0.22)";
            g.fillRect(x + dx + 1, row * bh + 1, w2 - 2, 1);
            g.fillStyle = "rgba(0,0,0,0.25)";
            g.fillRect(x + dx + 1, row * bh + bh - 2, w2 - 2, 1);
          }
          x += bw;
        }
      }
      for (let k = 0; k < 900; k++) {
        g.fillStyle = rnd() < 0.5 ? "rgba(0,0,0,0.12)" : "rgba(255,255,255,0.08)";
        g.fillRect(rnd() * 128, rnd() * 128, 1, 1);
      }
    }),
    // the walls' tops: flat capstones
    gb_cap: texture(43, (g, rnd) => {
      g.fillStyle = "#56524a";
      g.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) {
          const v = 150 + (rnd() - 0.5) * 30;
          g.fillStyle = `rgb(${v + 6},${v},${v - 10})`;
          g.fillRect(i * 16 + 1, j * 16 + 1, 14, 14);
          g.fillStyle = "rgba(255,255,255,0.12)";
          g.fillRect(i * 16 + 1, j * 16 + 1, 14, 1.5);
        }
      }
    }),
    // rocks: speckled granite with cracks
    gb_granite: texture(47, (g, rnd, wrap) => {
      g.fillStyle = "#6a655d";
      g.fillRect(0, 0, 128, 128);
      blobs(g, rnd, wrap, 30, 6, 20, ["rgba(40,36,32,0.35)", "rgba(150,144,134,0.3)"]);
      for (let k = 0; k < 2500; k++) {
        const t = rnd();
        g.fillStyle = t < 0.4 ? "rgba(20,18,16,0.5)" : t < 0.8 ? "rgba(200,195,185,0.45)" : "rgba(160,110,90,0.5)";
        g.fillRect(rnd() * 128, rnd() * 128, 1 + (rnd() < 0.2), 1);
      }
      g.strokeStyle = "rgba(20,16,12,0.5)";
      for (let k = 0; k < 5; k++) {
        let x = rnd() * 128;
        let y = rnd() * 128;
        g.beginPath();
        g.moveTo(x, y);
        for (let n = 0; n < 6; n++) {
          x += (rnd() - 0.5) * 20;
          y += (rnd() - 0.5) * 20;
          g.lineTo(x, y);
        }
        g.stroke();
      }
    }),
    // the home field: gold plates with engraved rings
    gb_gold: texture(53, (g, rnd) => {
      const gr = g.createLinearGradient(0, 0, 128, 128);
      gr.addColorStop(0, "#c89a30");
      gr.addColorStop(0.5, "#f0cc60");
      gr.addColorStop(1, "#b0842a");
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 4; j++) {
          const x = i * 32;
          const y = j * 32;
          g.strokeStyle = "rgba(90,60,10,0.7)";
          g.lineWidth = 1.5;
          g.strokeRect(x + 1, y + 1, 30, 30);
          g.strokeStyle = "rgba(255,240,180,0.6)";
          g.lineWidth = 1;
          g.strokeRect(x + 2.5, y + 2.5, 27, 27);
          g.strokeStyle = "rgba(110,70,10,0.55)";
          g.beginPath();
          g.arc(x + 16, y + 16, 8 + rnd() * 2, 0, 2 * Math.PI);
          g.stroke();
          g.beginPath();
          g.moveTo(x + 16, y + 6);
          g.lineTo(x + 16, y + 26);
          g.moveTo(x + 6, y + 16);
          g.lineTo(x + 26, y + 16);
          g.stroke();
        }
      }
    }),
    // under the crystal: violet crystal tiles
    gb_crystal: texture(59, (g, rnd) => {
      g.fillStyle = "#3a1e52";
      g.fillRect(0, 0, 128, 128);
      for (let i = 0; i < 8; i++) {
        for (let j = 0; j < 8; j++) {
          const x = i * 16;
          const y = j * 16;
          const v = rnd();
          g.fillStyle = `rgb(${120 + v * 60},${60 + v * 30},${170 + v * 60})`;
          g.beginPath();
          g.moveTo(x + 8, y + 1);
          g.lineTo(x + 15, y + 8);
          g.lineTo(x + 8, y + 15);
          g.lineTo(x + 1, y + 8);
          g.closePath();
          g.fill();
          g.fillStyle = "rgba(255,220,255,0.35)";
          g.beginPath();
          g.moveTo(x + 8, y + 1);
          g.lineTo(x + 15, y + 8);
          g.lineTo(x + 8, y + 8);
          g.closePath();
          g.fill();
        }
      }
    }),
    // the gates: a violet swirl
    gb_portal: texture(61, (g, rnd) => {
      g.fillStyle = "#2a0848";
      g.fillRect(0, 0, 128, 128);
      for (let k = 0; k < 4; k++) {
        const cx = (k % 2) * 64 + 32;
        const cy = Math.floor(k / 2) * 64 + 32;
        for (let a = 0; a < 40; a += 0.15) {
          const r = a * 0.75;
          g.fillStyle = `rgba(${180 + rnd() * 60},${80 + rnd() * 60},255,0.5)`;
          g.fillRect(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 1.6, 1.6);
        }
      }
    }),
  };
  // the monsters' skins: grey around mid-tone, laid over a part's own colour
  // and shading ("overlay": light lightens, dark darkens, mid grey nothing)
  Object.assign(TEXTURES, {
    // a beetle's shell: fine lengthwise lines, pits, a few pale spots
    gb_chitin: texture(67, (g, rnd, wrap) => {
      g.fillStyle = "#808080";
      g.fillRect(0, 0, 128, 128);
      for (let x = 0; x < 128; x += 4) {
        g.fillStyle = "rgba(40,40,40,0.35)";
        g.fillRect(x, 0, 1, 128);
        g.fillStyle = "rgba(220,220,220,0.25)";
        g.fillRect(x + 1, 0, 1, 128);
      }
      for (let k = 0; k < 160; k++) {
        const x = rnd() * 128;
        const y = rnd() * 128;
        g.fillStyle = "rgba(30,30,30,0.5)";
        g.fillRect(x, y, 1.5, 1.5);
      }
      for (let k = 0; k < 7; k++) {
        const x = rnd() * 128;
        const y = rnd() * 128;
        const r = 5 + rnd() * 7;
        wrap(x, y, r, (px, py) => {
          g.fillStyle = "rgba(235,235,225,0.55)";
          g.beginPath();
          g.ellipse(px, py, r, r * 0.8, 0, 0, 2 * Math.PI);
          g.fill();
        });
      }
    }),
    // a sprinter's hide: overlapping scales in rows
    gb_scales: texture(71, (g, rnd) => {
      g.fillStyle = "#6a6a6a";
      g.fillRect(0, 0, 128, 128);
      for (let row = 0; row < 18; row++) {
        for (let col = -1; col < 18; col++) {
          const x = col * 8 + (row % 2) * 4;
          const y = row * 8 - 4;
          const gr = g.createRadialGradient(x, y - 2, 0.5, x, y, 6);
          const v = 150 + rnd() * 50;
          gr.addColorStop(0, `rgb(${v},${v},${v})`);
          gr.addColorStop(1, "rgb(70,70,70)");
          g.fillStyle = gr;
          g.beginPath();
          g.arc(x, y, 5.5, 0, Math.PI);
          g.fill();
        }
      }
    }),
    // a wasp's fuzz: short hairs every way
    gb_fuzz: texture(73, (g, rnd, wrap) => {
      g.fillStyle = "#808080";
      g.fillRect(0, 0, 128, 128);
      for (let k = 0; k < 1500; k++) {
        const x = rnd() * 128;
        const y = rnd() * 128;
        const a = rnd() * Math.PI * 2;
        const l = 1.5 + rnd() * 3;
        g.strokeStyle = rnd() < 0.5 ? "rgba(230,230,230,0.5)" : "rgba(30,30,30,0.45)";
        g.lineWidth = 0.7;
        wrap(x, y, l, (px, py) => {
          g.beginPath();
          g.moveTo(px, py);
          g.lineTo(px + Math.cos(a) * l, py + Math.sin(a) * l);
          g.stroke();
        });
      }
    }),
    // a golem's stone: blotches, grit, cracks
    gb_stoneskin: texture(79, (g, rnd, wrap) => {
      g.fillStyle = "#808080";
      g.fillRect(0, 0, 128, 128);
      blobs(g, rnd, wrap, 30, 6, 20, ["rgba(40,40,40,0.4)", "rgba(210,210,210,0.35)"]);
      for (let k = 0; k < 1800; k++) {
        g.fillStyle = rnd() < 0.5 ? "rgba(20,20,20,0.45)" : "rgba(235,235,235,0.4)";
        g.fillRect(rnd() * 128, rnd() * 128, 1, 1);
      }
      g.strokeStyle = "rgba(15,15,15,0.6)";
      g.lineWidth = 1;
      for (let k = 0; k < 6; k++) {
        let x = rnd() * 128;
        let y = rnd() * 128;
        g.beginPath();
        g.moveTo(x, y);
        for (let n = 0; n < 5; n++) {
          x += (rnd() - 0.5) * 22;
          y += (rnd() - 0.5) * 22;
          g.lineTo(x, y);
        }
        g.stroke();
      }
    }),
    // the giant's crystal: sharp light and dark shards
    gb_shards: texture(83, (g, rnd) => {
      g.fillStyle = "#808080";
      g.fillRect(0, 0, 128, 128);
      for (let k = 0; k < 40; k++) {
        const x = rnd() * 128;
        const y = rnd() * 128;
        const a = rnd() * Math.PI;
        const l = 8 + rnd() * 20;
        g.fillStyle = rnd() < 0.5 ? "rgba(250,250,250,0.45)" : "rgba(20,20,20,0.4)";
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l);
        g.lineTo(x + Math.cos(a + 0.35) * l * 0.6, y + Math.sin(a + 0.35) * l * 0.6);
        g.closePath();
        g.fill();
      }
    }),
  });
  if (Lynx.registerTexture) Object.keys(TEXTURES).forEach((k) => Lynx.registerTexture(k, TEXTURES[k]));

  const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;

  Lynx.games.gems = (ar, cfg, app) => {
    const S = clamp(+cfg.arenaM || 1, 0.5, 2.5); // arena side
    const T = S / N; // tile
    const diffK = DIFF[cfg.difficulty] || 1;
    const w = Lynx.world3d(ar);
    const layer = Lynx.cubeLayer(ar, app, {});
    const frameTags = new Set(Lynx.FRAME_CUBE_TAGS || []);

    let state = "title"; // title | playing | won | over
    let stateTime = 0;
    let time = 0;
    let L = null; // the level
    let levelIdx = 0;
    let tiles = null; // per tile: "grass" | "road" | "rock" | "wall" | "base" | "home" | "entry"
    let entries = [];
    let baseTiles = [];
    let dist = null; // steps to the crystal, per tile
    let cubesIgnored = false;
    let blockedKey = "";
    let wallsVersion = 0; // (a wall built or taken down: the ways again)
    let mana = 0;
    let baseHp = 20;
    let score = 0;
    let wave = 0; // waves sent
    let nextWaveIn = 0;
    let spawnQ = []; // {type, at, hp}
    let monsters = [];
    let shots = [];
    let bolts = []; // lightning: {pts, t}
    let puffs = []; // {x, y, h, r, color, t}
    let gems = new Map(); // tag -> gem
    let stacks = new Map(); // "top>bottom" -> seconds stacked
    let toast = null;
    let best = null;
    let rankMsg = "";
    let aimTile = null;
    Lynx.bestScore("gems").then((b) => (best = b));

    const say = (text, color = "#ffe9a8", t = 2.2) => (toast = { text, color, t });
    const tr = Lynx.tr || ((t) => t); // (names inside longer lines: translated on their own)
    const sfx = (n) => Lynx.sfx.play(n);
    const idx = (i, j) => i * N + j;
    const inside = (i, j) => i >= 0 && i < N && j >= 0 && j < N;
    // tiles: i the row from the far end, j the column from the left; the arena's
    // near edge is the anchor, f forward, r to the right
    const tileF = (i) => (N - 1 - i + 0.5) * T;
    const tileR = (j) => -S / 2 + (j + 0.5) * T;
    const tileOf = (x, y) => {
      const l = w.toLocal(x, y);
      const i = N - 1 - Math.floor(l.f / T);
      const j = Math.floor((l.r + S / 2) / T);
      return inside(i, j) ? { i, j } : null;
    };
    const tileWorld = (i, j) => w.toWorld(tileF(i), tileR(j));

    // -- gems -----------------------------------------------------------------------------------------------
    const kindOf = (tag) => ((tag % 4) + 4) % 4;
    function newGem(tag, grade = 1) {
      const comp = [0, 0, 0, 0];
      comp[kindOf(tag)] = 1;
      return { grade, comp, cd: 0, spin: Math.random() * 6 };
    }
    const gemColor = (g) => {
      const c = [0, 0, 0];
      g.comp.forEach((k, i) => KINDS[i].color.forEach((v, n) => (c[n] += v * k)));
      // (an average of two colours goes grey: pushed back out to a vivid one)
      const grey = (c[0] + c[1] + c[2]) / 3;
      const vivid = c.map((v) => grey + (v - grey) * 1.9);
      const top = Math.max(...vivid, 1);
      return vivid.map((v) => clamp((v * 255) / Math.max(top, 200), 0, 255));
    };
    const gemName = (g) => {
      const parts = g.comp.map((k, i) => [k, KINDS[i].name]).filter(([k]) => k >= 0.2).sort((a, b) => b[0] - a[0]).map(([, n]) => n);
      return `grade ${g.grade} ${parts.join("-")}`;
    };
    function stats(g) {
      const [ru, em, sa, to] = g.comp;
      return {
        dmg: 6 * Math.pow(1.75, g.grade - 1) * (1 + 0.5 * ru),
        range: (0.14 + 0.025 * g.grade) * S,
        rate: 1 + 0.12 * g.grade,
        splash: ru > 0.15 ? 0.04 * S * ru : 0,
        poison: em,
        slow: sa,
        chain: Math.round(to * 3),
      };
    }
    function merge(a, b) {
      const grade = a.grade === b.grade ? a.grade + 1 : Math.max(a.grade, b.grade);
      const wa = Math.pow(2, a.grade - 1);
      const wb = Math.pow(2, b.grade - 1);
      const comp = a.comp.map((v, i) => (v * wa + b.comp[i] * wb) / (wa + wb));
      return { grade, comp, cd: 0.5, spin: a.spin };
    }

    // -- the arena --------------------------------------------------------------------------------------------
    function build(lv) {
      tiles = new Array(N * N).fill(lv.road ? "grass" : "grass");
      entries = [];
      baseTiles = [];
      const set = (i, j, t) => inside(i, j) && (tiles[idx(i, j)] = t);
      (lv.road || []).forEach((line) => {
        for (let k = 0; k + 1 < line.length; k++) {
          const [i0, j0] = line[k];
          const [i1, j1] = line[k + 1];
          const n = Math.max(Math.abs(i1 - i0), Math.abs(j1 - j0));
          for (let s = 0; s <= n; s++) set(i0 + Math.sign(i1 - i0) * s, j0 + Math.sign(j1 - j0) * s, "road");
        }
        entries.push(line[0]);
      });
      (lv.entries || []).forEach((e) => entries.push(e));
      entries.forEach(([i, j]) => set(i, j, "entry"));
      (lv.rocks || []).forEach(([i, j]) => set(i, j, "rock"));
      for (const [di, dj] of [[0, 0], [0, 1], [1, 0], [1, 1]]) {
        set(lv.base[0] + di, lv.base[1] + dj, "base");
        baseTiles.push([lv.base[0] + di, lv.base[1] + dj]);
        set(lv.home[0] + di, lv.home[1] + dj, "home");
      }
    }
    const passable = (t, cubeSet, k) => {
      if (L.road) return t === "road" || t === "entry" || t === "base";
      if (t === "rock" || t === "wall") return false;
      return !(cubeSet && cubeSet.has(k));
    };
    function bfs(cubeSet, extraWall = -1) {
      const d = new Array(N * N).fill(Infinity);
      const q = [];
      baseTiles.forEach(([i, j]) => {
        d[idx(i, j)] = 0;
        q.push([i, j]);
      });
      while (q.length) {
        const [i, j] = q.shift();
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const a = i + di;
          const b = j + dj;
          if (!inside(a, b)) continue;
          const k = idx(a, b);
          if (d[k] !== Infinity || k === extraWall || !passable(tiles[k], cubeSet, k)) continue;
          d[k] = d[idx(i, j)] + 1;
          q.push([a, b]);
        }
      }
      return d;
    }
    const reachable = (d) => entries.every(([i, j]) => d[idx(i, j)] < Infinity);
    // the tiles cubes stand on (open fields: they're in the way)
    function cubeTiles(blocks) {
      const out = new Set();
      blocks.forEach((b) => {
        if (b.level !== 0) return;
        for (const dx of [-0.8, 0.8]) {
          for (const dy of [-0.8, 0.8]) {
            const t = tileOf(b.x + dx * b.half, b.y + dy * b.half);
            if (t && tiles[idx(t.i, t.j)] === "grass") out.add(idx(t.i, t.j));
          }
        }
      });
      return out;
    }
    function updatePaths(blocks) {
      const cs = L.road ? null : cubeTiles(blocks);
      const key = (cs ? [...cs].sort().join(",") : "") + "|" + wallsVersion;
      if (key === blockedKey && dist) return;
      blockedKey = key;
      let d = bfs(cs);
      cubesIgnored = false;
      if (!reachable(d)) {
        d = bfs(null);
        cubesIgnored = true;
      }
      dist = d;
      cubeSet = cubesIgnored ? null : cs;
    }
    let cubeSet = null; // the tiles cubes stand on, while they count as in the way
    // a tile a monster can't step onto now: a wall, a rock, a cube (unless they climb over cubes)
    const blockedTile = (t) => {
      const k = idx(t.i, t.j);
      return tiles[k] === "wall" || tiles[k] === "rock" || (!!cubeSet && cubeSet.has(k));
    };

    // -- flow --------------------------------------------------------------------------------------------------------
    function startLevel(n) {
      levelIdx = n;
      L = LEVELS[n];
      const th = ar.pose.theta;
      // the near edge of the arena: a little ahead of the robot
      w.setAnchor({ x: ar.pose.x + Math.cos(th) * 0.2, y: ar.pose.y + Math.sin(th) * 0.2, th });
      build(L);
      dist = null;
      blockedKey = "";
      mana = L.mana;
      baseHp = 20;
      score = 0;
      wave = 0;
      nextWaveIn = START_WAIT_S;
      spawnQ = [];
      monsters = [];
      shots = [];
      bolts = [];
      puffs = [];
      gems = new Map();
      stacks = new Map();
      state = "playing";
      stateTime = 0;
      if (paused) togglePause(false);
      say(`${L.name}: set your cubes out ${L.road ? "round the road" : "in the field"} -- monsters in ${START_WAIT_S} s`, "#ffe9a8", 4);
      sfx("go");
    }

    function sendWave() {
      if (wave >= L.waves) return false;
      wave++;
      const k = wave % 4;
      const type = wave % 5 === 0 ? "boss" : k === 1 ? "crawler" : k === 2 ? "runner" : k === 3 ? "swarm" : "brute";
      const count = type === "boss" ? 1 + Math.floor(wave / 10) : type === "crawler" ? 8 + wave : type === "runner" ? 6 + wave : type === "swarm" ? 14 + 2 * wave : 3 + Math.floor(wave / 2);
      const gap = type === "swarm" ? 0.35 : type === "boss" ? 3 : type === "brute" ? 1.6 : 0.9;
      const hp = 18 * Math.pow(1.22, wave - 1) * (1 + 0.25 * levelIdx) * (L.hp || 1) * diffK;
      const t0 = spawnQ.length ? spawnQ[spawnQ.length - 1].at + 1 : time;
      for (let i = 0; i < count; i++) spawnQ.push({ type, at: t0 + i * gap, hp: hp * MONSTERS[type].hp });
      nextWaveIn = WAVE_GAP_S + count * gap;
      say(`Wave ${wave}/${L.waves}: ${count} ${type === "boss" ? "giant" : type}${count > 1 ? "s" : ""}`, "#ff9a7a");
      sfx("alarm");
      return true;
    }
    function callWave() {
      if (state !== "playing" || wave >= L.waves) return false;
      const bonus = Math.round(nextWaveIn * 0.6);
      mana += bonus;
      score += bonus;
      sendWave();
      if (bonus > 0) say(`Early call: +${bonus} mana`, "#9ad8ff");
      return true;
    }

    function finish(won) {
      state = won ? "won" : "over";
      stateTime = 0;
      if (won) score += baseHp * 25 + 200 * (levelIdx + 1);
      sfx(won ? "levelup" : "lose");
      Lynx.submitScore("gems", Math.round(score)).then((rank) => {
        rankMsg = rank ? `#${rank} on the robot's scoreboard!` : "";
        if (rank === 1) best = Math.round(score);
      });
      if (won && levelIdx + 1 < LEVELS.length) menu.select(levelIdx + 1);
    }

    const menu = Lynx.levelMenu(ar, {
      key: "gems",
      levels: LEVELS.map((l) => ({ name: tr(l.name), note: `${l.road ? "road" : "open field"} · ${l.waves} waves`, blurb: tr(l.blurb) })),
      active: () => state === "title",
      onStart: (i) => startLevel(i),
      color: "#9ad8ff",
    });

    // -- input --------------------------------------------------------------------------------------------------
    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title") return startLevel(menu.sel);
      if ((state === "won" || state === "over") && stateTime > 1.5) {
        state = "title";
        return;
      }
      if (state !== "playing") return;
      // (FIRE never calls a wave: Space / A / the touch button do)
      if (L.road) return;
      if (!aimTile) return say("Aim the middle of the camera at a tile -- or click one with the mouse", "#ff9a7a", 1.8);
      toggleWall(aimTile);
    });
    // A wall on this tile: built, or taken down (half its price back).
    function toggleWall(tile) {
      const k = idx(tile.i, tile.j);
      if (tiles[k] === "wall") {
        tiles[k] = "grass";
        wallsVersion++;
        mana += WALL_COST / 2;
        sfx("click");
        return;
      }
      if (tiles[k] !== "grass") return say("Walls go on the grass", "#ff9a7a", 1.4);
      if (mana < WALL_COST) return say(`A wall costs ${WALL_COST} mana`, "#ff9a7a", 1.4);
      if (monsters.some((m) => {
        const t = tileOf(m.x, m.y);
        return t && t.i === tile.i && t.j === tile.j;
      })) return say("A monster is on that tile", "#ff9a7a", 1.4);
      if (!reachable(bfs(null, k))) return say("That would shut the way completely", "#ff9a7a", 1.6);
      tiles[k] = "wall";
      wallsVersion++;
      mana -= WALL_COST;
      sfx("tick");
    }
    // The mouse: the tile under it lights up, a click builds / takes down a
    // wall there (and isn't Fire). Touches are left alone: on a touch screen a
    // touch on the picture drives (the crosshair and Fire build there).
    let mouse = null; // {x, y} in the canvas, while over it
    let hoverTile = null;
    function tileAtScreen(x, y) {
      const inPoly = (pts) => {
        let c = false;
        for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) {
          if (pts[a].y > y !== pts[b].y > y && x < ((pts[b].x - pts[a].x) * (y - pts[a].y)) / (pts[b].y - pts[a].y) + pts[a].x) c = !c;
        }
        return c;
      };
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const r = q(i, j);
          const pts = w.polyScreen([[r.f0, r.r0, 0], [r.f1, r.r0, 0], [r.f1, r.r1, 0], [r.f0, r.r1, 0]], 1);
          if (pts && inPoly(pts)) return { i, j };
        }
      }
      return null;
    }
    const canvasPoint = (e) => {
      const r = ar.ctx.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const mouseOn = () => state === "playing" && L && !L.road && !document.pointerLockElement;
    const onMove = (e) => {
      if (e.pointerType && e.pointerType !== "mouse") return;
      mouse = canvasPoint(e);
    };
    const onDown = (e) => {
      const isMouse = e.type === "mousedown" || (e.type === "pointerdown" && e.pointerType === "mouse");
      if (!isMouse || !mouseOn() || e.button !== 0) return;
      const pt = canvasPoint(e);
      const tile = tileAtScreen(pt.x, pt.y);
      if (!tile) return; // (off the arena: an ordinary click)
      e.stopPropagation(); // (not Fire)
      if (e.type !== "pointerdown") return; // (the same press's mousedown: only kept away)
      e.preventDefault();
      toggleWall(tile);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("mouseleave", () => (mouse = null));
    ["pointerdown", "mousedown"].forEach((t) => window.addEventListener(t, onDown, { capture: true }));
    ar.onDestroy(() => {
      window.removeEventListener("pointermove", onMove);
      ["pointerdown", "mousedown"].forEach((t) => window.removeEventListener(t, onDown, { capture: true }));
    });
    Lynx.onAction("jump", () => state === "playing" && !paused && callWave());
    Lynx.touchButtons().add("⏩ Next wave", () => !paused && callWave());
    // Pause: P, the button, or the tab hidden. Paused, the cubes still count
    // where they're moved (merges and the home field wait) and walls can be built.
    let paused = false;
    const touch = Lynx.touchButtons();
    const pauseBtn = touch.add("⏸ Pause", () => togglePause());
    // Every tower's reach on the floor: R or the button
    let showRanges = false;
    let wall = 0; // seconds, running while paused too (a moved cube's reach shows this long after)
    const RANGE_AFTER_S = 10;
    const rangeBtn = touch.add("◎ Show ranges", () => toggleRanges());
    function toggleRanges() {
      showRanges = !showRanges;
      if (rangeBtn && touch.relabel) touch.relabel(rangeBtn, showRanges ? "◎ Hide ranges" : "◎ Show ranges");
      sfx("click");
    }
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
      else if (e.code === "KeyR") toggleRanges();
    };
    const onHidden = () => document.hidden && state === "playing" && !paused && togglePause(true);
    window.addEventListener("keydown", onKey);
    document.addEventListener("visibilitychange", onHidden);
    ar.onDestroy(() => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("visibilitychange", onHidden);
    });

    // -- the cubes: towers, stacks, the home field ------------------------------------------------------------------
    let cubes = []; // this frame's: {b, gem, tile, tower}
    function readCubes(dt) {
      const all = (layer.blocks() || []).filter((b) => !frameTags.has(b.tag));
      const real = all.filter((b) => !b.inferred);
      cubes = [];
      const stackedNow = new Set();
      real.forEach((b) => {
        if (!gems.has(b.tag)) {
          gems.set(b.tag, newGem(b.tag));
          if (state === "playing") say(`Cube ${b.tag}: ${/^[aeiou]/.test(KINDS[kindOf(b.tag)].name) ? "an" : "a"} ${KINDS[kindOf(b.tag)].name} gem`, rgb(KINDS[kindOf(b.tag)].color), 1.6);
        }
        const gem = gems.get(b.tag);
        // moved (or just set down, or a new gem): its reach shows for RANGE_AFTER_S
        if (!gem.anchor || Math.hypot(gem.anchor.x - b.x, gem.anchor.y - b.y) > 0.01) {
          gem.anchor = { x: b.x, y: b.y };
          gem.movedAt = wall;
        }
        const tile = tileOf(b.x, b.y);
        if (b.level === 0) {
          gem.pos = { x: b.x, y: b.y };
          const onHome = tile && tiles[idx(tile.i, tile.j)] === "home";
          cubes.push({ b, gem, tile, tower: !!tile && !onHome && gem.grade > 0, home: onHome });
          if (onHome && state === "playing") homeTick(b, gem, dt);
          else gem.homeT = 0;
          return;
        }
        // stacked: on which cube? (its own tag seen, or a gem cube last seen there)
        cubes.push({ b, gem, tile, tower: false, stacked: true });
        const under = real.find((o) => o.level === b.level - 1 && o.tag !== b.tag && Math.hypot(o.x - b.x, o.y - b.y) < b.half * 1.5);
        let bottomTag = under ? under.tag : null;
        if (bottomTag === null) {
          for (const [tag, g] of gems) {
            if (tag !== b.tag && g.pos && Math.hypot(g.pos.x - b.x, g.pos.y - b.y) < b.half * 1.5) bottomTag = tag;
          }
        }
        if (bottomTag === null || state !== "playing") return;
        const key = `${b.tag}>${bottomTag}`;
        stackedNow.add(key);
        const t = (stacks.get(key) || 0) + dt;
        stacks.set(key, t);
        const bottom = gems.get(bottomTag);
        if (t >= MERGE_S && gem.grade > 0) {
          const before = bottom.grade;
          const m = bottom.grade > 0 ? merge(bottom, gem) : { ...gem, cd: 0.5 };
          m.pos = bottom.pos;
          gems.set(bottomTag, m);
          gem.grade = 0; // (the top cube: empty now)
          const p = bottom.pos || { x: b.x, y: b.y };
          puffs.push({ x: p.x, y: p.y, h: 0.06, r: 0.06, color: gemColor(m), t: 0, ring: true });
          say(m.grade > before && before > 0 ? `Merged: ${gemName(m)}!` : `Merged into cube ${bottomTag}: ${gemName(m)}`, rgb(gemColor(m)), 2.4);
          sfx("levelup");
        }
      });
      for (const k of [...stacks.keys()]) if (!stackedNow.has(k)) stacks.delete(k);
    }
    function homeTick(b, gem, dt) {
      if (gem.grade > 0) {
        gem.homeT = 0;
        return;
      }
      gem.homeT = (gem.homeT || 0) + dt;
      if (gem.homeT < HOME_S) return;
      if (mana < GEM_COST) {
        if (gem.homeT < HOME_S + dt * 1.5) say(`A new gem costs ${GEM_COST} mana`, "#ff9a7a", 1.6);
        return;
      }
      mana -= GEM_COST;
      const g = newGem(b.tag);
      g.pos = gem.pos;
      gems.set(b.tag, g);
      puffs.push({ x: b.x, y: b.y, h: b.h1 + 0.02, r: 0.05, color: gemColor(g), t: 0, ring: true });
      say(`A new ${KINDS[kindOf(b.tag)].name} gem`, rgb(gemColor(g)), 1.6);
      sfx("pickup");
    }

    // -- monsters --------------------------------------------------------------------------------------------------
    function spawn(q) {
      const def = MONSTERS[q.type];
      const [i, j] = entries[Math.floor(Math.random() * entries.length)];
      const p = tileWorld(i, j);
      const jit = (Math.random() - 0.5) * T * 0.4;
      monsters.push({ type: q.type, def, x: p.x, y: p.y, hp: q.hp, max: q.hp, to: null, jit, slowT: 0, slowK: 0, poisonT: 0, poisonDps: 0, wob: Math.random() * 6, hitT: 0 });
    }
    function stepMonster(m, dt) {
      if (m.poisonT > 0) {
        m.poisonT -= dt;
        hurt(m, m.poisonDps * dt, true);
      }
      if (m.slowT > 0) m.slowT -= dt;
      m.hitT = Math.max(0, m.hitT - dt);
      const here = tileOf(m.x, m.y);
      if (!here) return;
      const k = idx(here.i, here.j);
      if (tiles[k] === "base") {
        m.dead = true;
        baseHp -= m.def.harm;
        puffs.push({ x: m.x, y: m.y, h: 0.03, r: 0.05, color: [255, 120, 255], t: 0, ring: true });
        sfx("hurt");
        say(baseHp > 0 ? "The crystal cracks!" : "The crystal shatters!", "#ff7aff", 1.2);
        if (baseHp <= 0) finish(false);
        return;
      }
      // The tile it was walking into is blocked now (a wall built, a cube put
      // down): back to the tile it came from -- or, that one blocked too, the
      // free neighbour nearest the crystal; nowhere free: on over it.
      if (m.to && blockedTile(m.to) && !(m.to.i === here.i && m.to.j === here.j)) {
        if (m.from && !blockedTile(m.from) && !(m.from.i === m.to.i && m.from.j === m.to.j)) {
          m.to = m.from;
          m.from = null;
        } else {
          let bestD = Infinity;
          let pick = null;
          for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const t2 = { i: here.i + di, j: here.j + dj };
            if (!inside(t2.i, t2.j) || blockedTile(t2) || (t2.i === m.to.i && t2.j === m.to.j)) continue;
            const dd = dist[idx(t2.i, t2.j)];
            if (pick === null || dd < bestD) {
              bestD = dd;
              pick = t2;
            }
          }
          if (pick) m.to = pick;
        }
      }
      if (!m.to || near(m, m.to)) {
        // the next tile: the neighbour nearest the crystal
        let bestD = Infinity;
        let pick = null;
        for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const a = here.i + di;
          const b2 = here.j + dj;
          if (!inside(a, b2)) continue;
          const dd = dist[idx(a, b2)] + Math.random() * 0.01; // (ties: either way)
          if (dd < bestD && dd < dist[k]) {
            bestD = dd;
            pick = { i: a, j: b2 };
          }
        }
        if (pick) {
          m.from = { i: here.i, j: here.j };
          m.to = pick;
        }
      }
      if (!m.to) return;
      const tw = tileWorld(m.to.i, m.to.j);
      const l = w.toLocal(tw.x, tw.y);
      // (a little to the side of the tile's middle, each its own way)
      const goal = w.toWorld(l.f, l.r + m.jit);
      const dx = goal.x - m.x;
      const dy = goal.y - m.y;
      const d = Math.hypot(dx, dy);
      const v = m.def.speed * S * (L.speed || 1) * (m.slowT > 0 ? 1 - m.slowK : 1);
      const step = Math.min(d, v * dt);
      if (d > 1e-6) {
        m.x += (dx / d) * step;
        m.y += (dy / d) * step;
        m.dir = Math.atan2(dy, dx);
      }
    }
    const near = (m, t) => {
      const p = tileWorld(t.i, t.j);
      return Math.hypot(p.x - m.x, p.y - m.y) < T * 0.35;
    };
    // how far it still has to go (for the towers: the first in line)
    const togo = (m) => {
      const t = tileOf(m.x, m.y);
      return t ? dist[idx(t.i, t.j)] : 1e9;
    };
    function hurt(m, dmg, quiet) {
      if (m.dead) return;
      m.hp -= dmg;
      if (!quiet) m.hitT = 0.12;
      if (m.hp <= 0) {
        m.dead = true;
        const bounty = Math.round(m.def.bounty * (1 + wave * 0.08));
        mana += bounty;
        score += bounty * 5;
        puffs.push({ x: m.x, y: m.y, h: m.def.r, r: m.def.r * 3, color: [200, 200, 200], t: 0 });
        sfx("pain");
      }
    }

    // -- towers ------------------------------------------------------------------------------------------------------
    function stepTowers(dt) {
      cubes.forEach((c) => {
        if (!c.tower) return;
        const g = c.gem;
        g.cd -= dt;
        if (g.cd > 0) return;
        const st = stats(g);
        const gx = c.b.x;
        const gy = c.b.y;
        let target = null;
        let bestTogo = Infinity;
        monsters.forEach((m) => {
          if (m.dead || Math.hypot(m.x - gx, m.y - gy) > st.range) return;
          const tg = togo(m);
          if (tg < bestTogo) {
            bestTogo = tg;
            target = m;
          }
        });
        if (!target) return;
        g.cd = 1 / st.rate;
        shots.push({ x: gx, y: gy, h: c.b.h1 + 0.03, target, st, color: gemColor(g), grade: g.grade });
        sfx("zap");
      });
    }
    function stepShots(dt) {
      shots.forEach((s) => {
        const m = s.target;
        if (m.dead) {
          s.done = true;
          return;
        }
        const th = m.def.r;
        const dx = m.x - s.x;
        const dy = m.y - s.y;
        const dh = th - s.h;
        const d = Math.hypot(dx, dy, dh);
        const v = 1.2 * S;
        if (d < v * dt + 0.005) {
          s.done = true;
          impact(s, m);
          return;
        }
        s.x += (dx / d) * v * dt;
        s.y += (dy / d) * v * dt;
        s.h += (dh / d) * v * dt;
      });
      shots = shots.filter((s) => !s.done);
    }
    function impact(s, m) {
      const st = s.st;
      const dmg = (x) => Math.max(1, x - m.def.armor);
      hurt(m, dmg(st.dmg));
      if (st.poison > 0.05) {
        m.poisonT = 3;
        m.poisonDps = Math.max(m.poisonDps, st.dmg * 0.3 * st.poison);
      }
      if (st.slow > 0.05) {
        m.slowT = 1.5;
        m.slowK = Math.max(m.slowK, 0.45 * st.slow);
      }
      if (st.splash > 0) {
        monsters.forEach((o) => o !== m && !o.dead && Math.hypot(o.x - m.x, o.y - m.y) < st.splash && hurt(o, Math.max(1, st.dmg * 0.4 - o.def.armor)));
        puffs.push({ x: m.x, y: m.y, h: 0.002, r: st.splash, color: s.color, t: 0, ring: true });
      }
      if (st.chain > 0) {
        let from = m;
        const hit = new Set([m]);
        const pts = [[m.x, m.y, m.def.r]];
        for (let n = 0; n < st.chain; n++) {
          let next = null;
          let bd = 0.12 * S;
          monsters.forEach((o) => {
            if (o.dead || hit.has(o)) return;
            const d = Math.hypot(o.x - from.x, o.y - from.y);
            if (d < bd) {
              bd = d;
              next = o;
            }
          });
          if (!next) break;
          hit.add(next);
          pts.push([next.x, next.y, next.def.r]);
          hurt(next, Math.max(1, st.dmg * 0.6 - next.def.armor));
          from = next;
        }
        if (pts.length > 1) bolts.push({ pts, t: 0, color: s.color });
      }
    }

    // -- update ------------------------------------------------------------------------------------------------------
    function aim() {
      const F = ar.frame;
      if (!F || F.fwd[2] > -0.05) return null;
      const t = -(F.C[2] + ar.z) / F.fwd[2];
      return tileOf(F.C[0] + F.fwd[0] * t, F.C[1] + F.fwd[1] * t);
    }
    function update(dt) {
      if (paused && state === "playing") {
        // (frozen: only where the mouse and the crosshair point)
        aimTile = aim();
        hoverTile = mouse && mouseOn() ? tileAtScreen(mouse.x, mouse.y) : null;
        return;
      }
      time += dt;
      stateTime += dt;
      if (toast && (toast.t -= dt) <= 0) toast = null;
      puffs.forEach((p) => (p.t += dt));
      puffs = puffs.filter((p) => p.t < 0.6);
      bolts.forEach((b) => (b.t += dt));
      bolts = bolts.filter((b) => b.t < 0.18);
      gems.forEach((g) => (g.spin += dt * 1.2));
      if (state !== "playing") return;
      readCubes(dt);
      updatePaths(cubes.map((c) => c.b));
      aimTile = aim();
      hoverTile = mouse && mouseOn() ? tileAtScreen(mouse.x, mouse.y) : null;
      mana += dt * 0.5;
      // waves
      if (wave < L.waves) {
        nextWaveIn -= dt;
        if (nextWaveIn <= 0) sendWave();
      }
      while (spawnQ.length && spawnQ[0].at <= time) spawn(spawnQ.shift());
      monsters.forEach((m) => !m.frozen && stepMonster(m, dt));
      if (state !== "playing") return;
      stepTowers(dt);
      stepShots(dt);
      monsters = monsters.filter((m) => !m.dead);
      if (wave >= L.waves && !spawnQ.length && !monsters.length) {
        say("The crystal holds!", "#9ad8ff", 3);
        finish(true);
      }
    }

    // -- drawing -----------------------------------------------------------------------------------------------------
    const WALL = { top: "#a29a8a", side: "#7d766a", dark: "#5f594f", line: "rgba(20,15,10,0.6)", tex: "gb_brick", topTex: "gb_cap" };
    const ROCK = { top: "#6f6a62", side: "#57534c", dark: "#3f3c37", line: "rgba(10,8,5,0.7)", tex: "gb_granite", topTex: "gb_granite" };
    const q = (i, j, m = 0) => ({ f0: (N - 1 - i) * T + m, f1: (N - i) * T - m, r0: -S / 2 + j * T + m, r1: -S / 2 + (j + 1) * T - m });

    const FLOOR_ALPHA = 0.5;
    const texOn = typeof Lynx.texture === "function" && !!ar.texturedQuad;
    function floorTex(r, h, flat, tex, alpha = FLOOR_ALPHA) {
      if (texOn && Lynx.texture(tex)) w.floor(r, h, null, null, { detail: tex, alpha });
      else w.floor(r, h, flat.replace(/[\d.]+\)$/, `${alpha})`), null);
    }
    function drawArena() {
      // the grass in 2 x 2 tile patches (one big polygon, clipped where it
      // runs under the camera, came out cut off), the border as a line
      // (textured: grass, the road's earth, gold, crystal, the gates' swirl -- over a flat colour)
      // Half see-through (the camera's picture shows through): the texture
      // alone at FLOOR_ALPHA (the flat colour too only without textures), and
      // nothing under another surface -- two layers would add up.
      const grassy = (t) => t === "grass" || t === "wall" || t === "rock";
      for (let a = 0; a < N; a += 2) {
        for (let b = 0; b < N; b += 2) {
          // (rows a.., columns b.. from the near left corner: tile i = N - 1 - a)
          const four = [[0, 0], [0, 1], [1, 0], [1, 1]].map(([da, db]) => grassy(tiles[idx(N - 1 - (a + da), b + db)]));
          if (four.every(Boolean)) floorTex({ f0: a * T, f1: (a + 2) * T, r0: -S / 2 + b * T, r1: -S / 2 + (b + 2) * T }, 0.0002, "rgba(70,110,50,1)", "gb_grass");
          else {
            [[0, 0], [0, 1], [1, 0], [1, 1]].forEach(([da, db], n) => {
              if (four[n]) floorTex(q(N - 1 - (a + da), b + db), 0.0002, "rgba(70,110,50,1)", "gb_grass");
            });
          }
        }
      }
      w.line3([[0, -S / 2, 0.0006], [S, -S / 2, 0.0006], [S, S / 2, 0.0006], [0, S / 2, 0.0006], [0, -S / 2, 0.0006]], "rgba(160,220,140,0.75)", 2, T);
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const t = tiles[idx(i, j)];
          if (t === "road") floorTex(q(i, j), 0.0004, "rgba(150,115,70,1)", "gb_dirt");
          else if (t === "entry") {
            floorTex(q(i, j), 0.0004, "rgba(60,10,100,1)", "gb_portal", FLOOR_ALPHA * (0.85 + 0.3 * Math.sin(time * 4 + i + j)));
            w.floor(q(i, j), 0.0005, `rgba(190,90,255,${0.15 + 0.15 * Math.sin(time * 5 + i * 2 + j)})`, null);
          } else if (t === "home") {
            floorTex(q(i, j), 0.0004, "rgba(255,210,80,1)", "gb_gold");
            w.floor(q(i, j), 0.0005, null, "rgba(255,230,140,0.9)");
          } else if (t === "base") floorTex(q(i, j), 0.0004, "rgba(160,80,220,1)", "gb_crystal");
        }
      }
      // the grid (the open fields: where a wall can go)
      const gc = L.road ? "rgba(200,240,190,0.14)" : "rgba(220,255,210,0.25)";
      for (let k = 1; k < N; k++) {
        w.line3([[k * T, -S / 2, 0.0005], [k * T, S / 2, 0.0005]], gc, 1, T);
        w.line3([[0, -S / 2 + k * T, 0.0005], [S, -S / 2 + k * T, 0.0005]], gc, 1, T);
      }
      // the tiles a wall would go on: the crosshair's, the mouse's
      for (const at of [aimTile, hoverTile]) {
        if (!at || L.road || state !== "playing") continue;
        const t = tiles[idx(at.i, at.j)];
        const ok = t === "grass" || t === "wall";
        w.floor(q(at.i, at.j), 0.0008, ok ? "rgba(120,255,160,0.25)" : "rgba(255,100,100,0.2)", ok ? "rgba(160,255,190,0.95)" : "rgba(255,120,120,0.9)", { width: 2 });
      }
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const t = tiles[idx(i, j)];
          if (t === "wall") w.box(q(i, j, 0.002), 0, T * 0.5, WALL, { alpha: 0.75 }); // (a little see-through: what walks behind shows)
          else if (t === "rock") w.box(q(i, j, 0.004), 0, T * 0.7, ROCK);
        }
      }
      // the crystal
      const c = w.toWorld(tileF(L.base[0]) - T / 2, tileR(L.base[1]) + T / 2);
      const pr = ar.project(c.x, c.y, 0.05);
      if (pr) {
        ar.queue(pr.depth, () => {
          const hurtK = 1 - baseHp / 20;
          drawGemSolid(c.x, c.y, 0.045 + Math.sin(time * 2) * 0.004, 0.022, 6, time * 0.4, [255, 120 + 100 * (1 - hurtK), 255], 0.92);
        });
      }
    }

    // A gem: a rounded K-sided cut -- a table on top, the crown, the girdle, the
    // pavilion down to a point -- convex, so its faces turned away are left out.
    const LIGHT = (() => {
      const v = [-0.35, 0.45, 0.82];
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    })();
    function drawGemSolid(x, y, h, R, K, rot, color, alpha = 0.9) {
      const cam = ar.cameraWorld();
      const girdle = [];
      for (let k = 0; k < K; k++) {
        const a0 = rot + (2 * Math.PI * k) / K;
        const corner = [Math.cos(a0), Math.sin(a0)];
        const prev = [Math.cos(a0 - (2 * Math.PI) / K), Math.sin(a0 - (2 * Math.PI) / K)];
        const next = [Math.cos(a0 + (2 * Math.PI) / K), Math.sin(a0 + (2 * Math.PI) / K)];
        const mix = (p, t) => [corner[0] * (1 - t) + p[0] * t, corner[1] * (1 - t) + p[1] * t];
        // a rounded corner: three points
        girdle.push(mix(prev, 0.2), [corner[0] * 0.93, corner[1] * 0.93], mix(next, 0.2));
      }
      const P = (u, hh) => [x + u[0] * R, y + u[1] * R, h + hh];
      const ht = R * 0.45;
      const hb = R * 1.0;
      const table = girdle.map((u) => P([u[0] * 0.55, u[1] * 0.55], ht));
      const gird = girdle.map((u) => P(u, 0));
      const culet = [x, y, h - hb];
      const faces = [table.slice().reverse()];
      const n = gird.length;
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        faces.push([table[k], gird[k], gird[k2], table[k2]].reverse());
        faces.push([gird[k], culet, gird[k2]].reverse());
      }
      const g = ar.ctx;
      faces.forEach((f) => {
        // normal (outward: the points go round counter-clockwise seen from outside)
        const a = f[0];
        const b = f[1];
        const c = f[2];
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const nl = Math.hypot(...nn) || 1;
        nn = nn.map((q2) => q2 / nl);
        const ctr = [0, 0, 0];
        f.forEach((p) => p.forEach((q2, i) => (ctr[i] += q2 / f.length)));
        const toCam = [cam.x - ctr[0], cam.y - ctr[1], cam.h - ctr[2]];
        // (outward normals: flip if this face's points went the other way round)
        const out = [ctr[0] - x, ctr[1] - y, ctr[2] - h];
        if (nn[0] * out[0] + nn[1] * out[1] + nn[2] * out[2] < 0) nn = nn.map((q2) => -q2);
        if (nn[0] * toCam[0] + nn[1] * toCam[1] + nn[2] * toCam[2] <= 0) return;
        const pts = f.map((p) => ar.project(p[0], p[1], p[2]));
        if (pts.some((p) => !p)) return;
        const tl = Math.hypot(...toCam);
        const V = toCam.map((q2) => q2 / tl);
        const H = [LIGHT[0] + V[0], LIGHT[1] + V[1], LIGHT[2] + V[2]];
        const hl = Math.hypot(...H);
        const spec = Math.pow(Math.max(0, (nn[0] * H[0] + nn[1] * H[1] + nn[2] * H[2]) / hl), 24);
        const lam = 0.35 + 0.65 * Math.max(0, nn[0] * LIGHT[0] + nn[1] * LIGHT[1] + nn[2] * LIGHT[2]);
        const col = color.map((q2) => Math.min(255, q2 * lam + 255 * spec * 0.9));
        g.beginPath();
        pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        g.fillStyle = rgb(col, alpha);
        g.fill();
        g.strokeStyle = rgb(color.map((q2) => Math.min(255, q2 * 0.5 + 140)), 0.55 * alpha);
        g.lineWidth = 0.8;
        g.stroke();
      });
    }

    // -- the gems' shapes, by grade -----------------------------------------------------------------------------
    // A 2D outline per grade (unit size, v up), cut into a stone: a flat front
    // face (the outline shrunk), bevels out to the full outline, the same at the
    // back. It keeps facing the camera, rocking a little, so the outline reads
    // at a glance while the bevels show it's solid.
    //   odd grades: rounded regular shapes, more corners each time -- 1 a
    //   triangle, 3 a square, 5 a pentagon, 7 a hexagon, 9 an octagon;
    //   even grades: the shape before with its bottom edge curved in;
    //   10 and up: every edge curved in (stars).
    const outlines = new Map();
    function gemOutline(grade) {
      if (outlines.has(grade)) return outlines.get(grade);
      const K = [3, 3, 4, 4, 5, 5, 6, 6, 8][Math.min(grade, 9) - 1] || 8;
      const concave = (e) => grade >= 10 || (grade % 2 === 0 && e === K - 1); // edge e: from corner e to e+1 (K-1: the bottom one)
      // corners, the bottom edge level
      const C = [];
      for (let k = 0; k < K; k++) {
        const a = -Math.PI / 2 + Math.PI / K + (2 * Math.PI * k) / K;
        C.push([Math.cos(a), Math.sin(a)]);
      }
      const lerp2 = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const quadB = (a, c, b, t) => lerp2(lerp2(a, c, t), lerp2(c, b, t), t);
      const ROUND = 0.2; // how much of each edge goes into the rounded corners
      const out = [];
      const corners = [];
      for (let k = 0; k < K; k++) {
        const prev = C[(k - 1 + K) % K];
        const cur = C[k];
        const next = C[(k + 1) % K];
        // the rounded corner: from a little before it to a little after
        const a = lerp2(cur, prev, ROUND);
        const b = lerp2(cur, next, ROUND);
        corners.push(out.length + 2); // (the arc's middle point: the corner)
        for (let t = 0; t <= 1.001; t += 0.25) out.push(quadB(a, cur, b, t));
        // the edge on to the next corner: straight, or curved in
        if (concave(k)) {
          const e0 = b;
          const e1 = lerp2(next, cur, ROUND);
          const mid = lerp2(cur, next, 0.5);
          const k2 = grade >= 10 ? 0.62 : 0.25; // (pulled toward the middle; a star's edges less deep)
          const ctl = [mid[0] * k2, mid[1] * k2];
          for (let t = 0.2; t < 0.81; t += 0.2) out.push(quadB(e0, ctl, e1, t));
        }
      }
      // centred on its own middle, scaled to radius 1
      const cx = out.reduce((s2, p) => s2 + p[0], 0) / out.length;
      const cy = out.reduce((s2, p) => s2 + p[1], 0) / out.length;
      const r = Math.max(...out.map((p) => Math.hypot(p[0] - cx, p[1] - cy)));
      const o = out.map((p) => [(p[0] - cx) / r, (p[1] - cy) / r]);
      o.corners = corners;
      outlines.set(grade, o);
      return o;
    }
    function drawCutGem(x, y, h, R, grade, rock, color, alpha, seed = 0) {
      const cam = ar.cameraWorld();
      const outl = gemOutline(grade);
      // its frame: W toward the camera (level), rocked a little; U across, V up
      const face = Math.atan2(cam.y - y, cam.x - x) + Math.sin(rock * 0.9) * 0.55;
      const W = [Math.cos(face), Math.sin(face), 0];
      const U = [-Math.sin(face), Math.cos(face), 0];
      const P = (u, v, d) => [x + (U[0] * u + W[0] * d) * R, y + (U[1] * u + W[1] * d) * R, h + v * R];
      const D = 0.42; // half thickness (of R)
      const INSET = 0.6; // the flat faces: the outline at this size
      const n = outl.length;
      const front = outl.map(([u, v]) => P(u * INSET, v * INSET, D));
      const back = outl.map(([u, v]) => P(u * INSET, v * INSET, -D));
      const rim = outl.map(([u, v]) => P(u, v, 0));
      const faces = [{ pts: front, table: true }, { pts: back, table: true }];
      for (let k = 0; k < n; k++) {
        const k2 = (k + 1) % n;
        faces.push({ pts: [front[k], front[k2], rim[k2], rim[k]] });
        faces.push({ pts: [back[k], back[k2], rim[k2], rim[k]] });
      }
      const ctr = [x, y, h];
      const g = ar.ctx;
      const drawn = [];
      faces.forEach((f) => {
        const m = [0, 0, 0];
        f.pts.forEach((p) => p.forEach((q2, i) => (m[i] += q2 / f.pts.length)));
        // the normal: from three of its points, turned outward
        const [a, b, c] = f.table ? [f.pts[0], f.pts[Math.floor(n / 3)], f.pts[Math.floor((2 * n) / 3)]] : f.pts;
        const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        let nn = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
        const nl = Math.hypot(...nn) || 1;
        nn = nn.map((q2) => q2 / nl);
        if (nn[0] * (m[0] - ctr[0]) + nn[1] * (m[1] - ctr[1]) + nn[2] * (m[2] - ctr[2]) < 0) nn = nn.map((q2) => -q2);
        const toCam = [cam.x - m[0], cam.y - m[1], cam.h - m[2]];
        if (nn[0] * toCam[0] + nn[1] * toCam[1] + nn[2] * toCam[2] <= 0) return;
        const pts = f.pts.map((p) => ar.project(p[0], p[1], p[2]));
        if (pts.some((p) => !p)) return;
        drawn.push({ pts, nn, toCam, depth: Math.hypot(...toCam), table: f.table });
      });
      // (a concave outline isn't convex: far faces first)
      drawn.sort((p, q2) => q2.depth - p.depth);
      drawn.forEach(({ pts, nn, toCam, depth, table }) => {
        const V = toCam.map((q2) => q2 / depth);
        const H = [LIGHT[0] + V[0], LIGHT[1] + V[1], LIGHT[2] + V[2]];
        const hl = Math.hypot(...H);
        const spec = Math.pow(Math.max(0, (nn[0] * H[0] + nn[1] * H[1] + nn[2] * H[2]) / hl), table ? 40 : 18);
        const lam = (table ? 0.55 : 0.3) + 0.6 * Math.max(0, nn[0] * LIGHT[0] + nn[1] * LIGHT[1] + nn[2] * LIGHT[2]);
        const col = color.map((q2) => Math.min(255, q2 * lam + 255 * spec * 0.85));
        g.beginPath();
        pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        g.fillStyle = rgb(col, alpha);
        g.fill();
        // a real stone's look: each facet shades across (light at one edge, deep
        // colour at the other); the face toward the camera gets the cut's star,
        // an inner rim, a glowing core, a few inclusions and a moving twinkle
        let x0 = Infinity;
        let y0 = Infinity;
        let x1 = -Infinity;
        let y1 = -Infinity;
        pts.forEach((p) => {
          x0 = Math.min(x0, p.x);
          y0 = Math.min(y0, p.y);
          x1 = Math.max(x1, p.x);
          y1 = Math.max(y1, p.y);
        });
        const sheen = g.createLinearGradient(x0, y0, x1, y1);
        sheen.addColorStop(0, `rgba(255,255,255,${(0.22 + 0.4 * spec) * alpha})`);
        sheen.addColorStop(0.45, "rgba(255,255,255,0)");
        sheen.addColorStop(1, rgb(color.map((q2) => q2 * 0.25), 0.35 * alpha));
        g.fillStyle = sheen;
        g.fill();
        g.strokeStyle = rgb(color.map((q2) => Math.min(255, q2 * 0.45 + 150)), (table ? 0.7 : 0.35) * alpha);
        g.lineWidth = table ? 1.2 : 0.6;
        g.stroke();
        if (table && x1 - x0 > 6) {
          const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
          const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
          const rad = Math.max(x1 - x0, y1 - y0) / 2;
          // the glowing core
          const core = g.createRadialGradient(cx, cy, 0, cx, cy, rad * 0.9);
          core.addColorStop(0, rgb(color.map((q2) => Math.min(255, q2 * 0.6 + 120)), 0.55 * alpha));
          core.addColorStop(1, rgb(color, 0));
          g.fillStyle = core;
          g.beginPath();
          pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
          g.closePath();
          g.fill();
          // the star: lines from the middle to the corners, and an inner rim
          g.strokeStyle = `rgba(255,255,255,${0.32 * alpha})`;
          g.lineWidth = 0.7;
          g.beginPath();
          (outl.corners || []).forEach((k) => {
            const p = pts[k];
            if (!p) return;
            g.moveTo(cx, cy);
            g.lineTo(p.x, p.y);
          });
          g.stroke();
          g.strokeStyle = rgb(color.map((q2) => q2 * 0.4), 0.55 * alpha);
          g.beginPath();
          pts.forEach((p, i) => {
            const qx = cx + (p.x - cx) * 0.55;
            const qy = cy + (p.y - cy) * 0.55;
            if (i) g.lineTo(qx, qy);
            else g.moveTo(qx, qy);
          });
          g.closePath();
          g.stroke();
          // inclusions: a few specks, always the same for this cube
          const rnd = seeded(seed * 31 + grade);
          for (let k = 0; k < 3; k++) {
            const a = rnd() * Math.PI * 2;
            const d = rnd() * rad * 0.45;
            g.fillStyle = `rgba(${rnd() < 0.5 ? "255,255,255" : "20,10,30"},${0.45 * alpha})`;
            g.beginPath();
            g.arc(cx + Math.cos(a) * d, cy + Math.sin(a) * d, Math.max(0.6, rad * 0.05), 0, 2 * Math.PI);
            g.fill();
          }
          // a twinkle wandering over it
          const tw = Math.pow(Math.max(0, Math.sin(time * 2.3 + seed * 1.7)), 10);
          if (tw > 0.05) {
            const a = time * 1.1 + seed;
            const sx = cx + Math.cos(a) * rad * 0.45;
            const sy = cy + Math.sin(a * 1.3) * rad * 0.35;
            const L2 = rad * (0.25 + 0.35 * tw);
            g.strokeStyle = `rgba(255,255,255,${tw * alpha})`;
            g.lineWidth = 1.2;
            g.beginPath();
            g.moveTo(sx - L2, sy);
            g.lineTo(sx + L2, sy);
            g.moveTo(sx, sy - L2);
            g.lineTo(sx, sy + L2);
            g.stroke();
            g.fillStyle = `rgba(255,255,255,${tw * alpha})`;
            g.beginPath();
            g.arc(sx, sy, Math.max(1, rad * 0.06), 0, 2 * Math.PI);
            g.fill();
          }
        }
      });
    }

    function drawGem(c) {
      const g = c.gem;
      const b = c.b;
      if (g.grade <= 0) {
        // an empty cube: a faint ring, and the home field's progress
        const p = ar.project(b.x, b.y, b.h1 + 0.015);
        if (!p) return;
        ar.queue(p.depth, () => {
          ar.ctx.strokeStyle = "rgba(220,220,220,0.7)";
          ar.ctx.setLineDash([4, 4]);
          ar.ctx.lineWidth = 2;
          ar.ctx.beginPath();
          ar.ctx.arc(p.x, p.y, Math.max(6, 0.012 * p.ppm), 0, 2 * Math.PI);
          ar.ctx.stroke();
          ar.ctx.setLineDash([]);
          if (c.home && g.homeT > 0) {
            ar.ctx.strokeStyle = "#ffd84a";
            ar.ctx.lineWidth = 4;
            ar.ctx.beginPath();
            ar.ctx.arc(p.x, p.y, Math.max(9, 0.018 * p.ppm), -Math.PI / 2, -Math.PI / 2 + 2 * Math.PI * Math.min(1, g.homeT / HOME_S));
            ar.ctx.stroke();
          }
        });
        return;
      }
      const R = Math.min(0.036, 0.015 + 0.003 * g.grade);
      // (close over its cube: which gem is whose shows at a glance)
      const h = b.h1 + 0.004 + R + Math.sin(time * 2 + b.tag) * 0.0015;
      const p = ar.project(b.x, b.y, h);
      if (!p) return;
      const col = gemColor(g);
      ar.queue(p.depth, () => {
        ar.glow(p.x, p.y, Math.max(8, R * 2.4 * p.ppm), [[0, rgb(col, 0.45)], [1, rgb(col, 0)]]);
        drawCutGem(b.x, b.y, h, R, g.grade, g.spin, col, c.tower || c.stacked ? 0.94 : 0.5, b.tag);
        if (g.grade > 1) ar.text(String(g.grade), p.x, p.y - R * 1.6 * p.ppm - 4, { size: 11, align: "center", color: "#ffffff", alpha: 0.85 });
      });
      // its ring on the floor (a tower: the reach, when the camera points at it)
      if (c.tower) {
        w.floor(footQ(b), 0.0009, null, rgb(col, 0.9), { width: 2 });
        // its reach: all shown (R / the button), aimed at, or moved in the last RANGE_AFTER_S
        const aimedAt = aimTile && c.tile && Math.abs(aimTile.i - c.tile.i) <= 1 && Math.abs(aimTile.j - c.tile.j) <= 1;
        const moved = g.movedAt !== undefined && wall - g.movedAt < RANGE_AFTER_S;
        if (showRanges || aimedAt || moved) {
          const fade = aimedAt || showRanges ? 1 : Math.min(1, (RANGE_AFTER_S - (wall - g.movedAt)) / 2);
          ar.floorCircle(b.x, b.y, stats(g).range, rgb(col, 0.06 * fade), rgb(col, 0.6 * fade));
        }
      }
    }
    // a cube's footprint in the arena's frame
    function footQ(b) {
      const l = w.toLocal(b.x, b.y);
      const hh = b.half * 1.15;
      return { f0: l.f - hh, f1: l.f + hh, r0: l.r - hh, r1: l.r + hh };
    }

    // -- the monsters: each kind its own body ---------------------------------------------------------------------
    // Built from a few 3D parts in the monster's own frame (f ahead, s to its
    // left, h up): shaded ellipsoids (drawn as ellipses turned along their
    // long axis), limbs (tapered lines), flat pieces (wings, horns, spikes) and
    // faceted solids; the parts far from the camera first.
    const hexRgb = (h) => {
      const n = parseInt(h.slice(1), 16);
      return [n >> 16, (n >> 8) & 255, n & 255];
    };
    const mixC = (a, b2, t) => a.map((v, i) => v + (b2[i] - v) * t);
    const patterns = new Map();
    function skinPattern(g, tex) {
      if (!patterns.has(tex)) {
        const img = Lynx.texture ? Lynx.texture(tex) : null;
        patterns.set(tex, img ? g.createPattern(img, "repeat") : null);
      }
      return patterns.get(tex);
    }
    function drawMonster(m) {
      const r = m.def.r * (m.type === "swarm" ? 1.9 : 1.35) * Math.sqrt(S);
      const dir = m.dir === undefined ? 0 : m.dir;
      const cf = Math.cos(dir);
      const sf = Math.sin(dir);
      const P = (f, sd, h) => [m.x + cf * f - sf * sd, m.y + sf * f + cf * sd, h];
      const head = ar.project(m.x, m.y, r);
      if (!head) return;
      let base = hexRgb(m.def.color);
      if (m.slowT > 0) base = mixC(base, [150, 210, 255], 0.5);
      if (m.poisonT > 0) base = mixC(base, [120, 255, 90], 0.35);
      if (m.hitT > 0) base = mixC(base, [255, 255, 255], 0.7);
      const dark = mixC(base, [10, 6, 12], 0.6);
      const light = mixC(base, [255, 255, 255], 0.35);
      const cam = ar.cameraWorld();
      const t = time * (m.slowT > 0 ? 0.55 : 1) + m.wob;
      const parts = []; // {at: [x, y, h], fn}
      const add = (at, fn) => parts.push({ at, fn });
      const g = ar.ctx;
      const pr = (p) => ar.project(p[0], p[1], p[2]);
      // the current path, overlaid with a skin texture (scale: px per texture px)
      const skin = (tex, cx, cy, scale, alpha = 0.75) => {
        const pat = skinPattern(g, tex);
        if (!pat) return;
        if (pat.setTransform && typeof DOMMatrix === "function") pat.setTransform(new DOMMatrix([scale, 0, 0, scale, cx, cy]));
        g.save();
        g.globalCompositeOperation = "overlay";
        g.globalAlpha = alpha;
        g.fillStyle = pat;
        g.fill();
        g.restore();
      };
      // an ellipsoid: centre, half-length along f, half-width, half-height (its long axis along f)
      const ell = (c, lf, ls, lh, col, glossy = true, tex = null) => add(c, () => {
        const pc = pr(c);
        const pa = pr([c[0] + cf * lf, c[1] + sf * lf, c[2]]); // (the end of its long axis)
        if (!pc || !pa) return;
        const rx = Math.max(1.5, Math.hypot(pa.x - pc.x, pa.y - pc.y), ls * pc.ppm * 0.6);
        const ry = Math.max(1.5, Math.max(ls, lh) * pc.ppm);
        const ang = Math.atan2(pa.y - pc.y, pa.x - pc.x);
        const R2 = Math.max(rx, ry);
        const gr = g.createRadialGradient(pc.x - R2 * 0.3, pc.y - ry * 0.45, R2 * 0.05, pc.x, pc.y, R2 * 1.05);
        gr.addColorStop(0, rgb(glossy ? mixC(col, [255, 255, 255], 0.6) : mixC(col, [255, 255, 255], 0.25)));
        gr.addColorStop(0.35, rgb(col));
        gr.addColorStop(1, rgb(mixC(col, [0, 0, 0], 0.65)));
        g.fillStyle = gr;
        g.beginPath();
        g.ellipse(pc.x, pc.y, rx, ry, ang, 0, 2 * Math.PI);
        g.fill();
        if (tex) skin(tex, pc.x, pc.y, Math.max(0.08, R2 / 48));
      });
      // a limb: a tapered line through points
      const limb = (pts, w0, w1, col) => add(pts[Math.floor(pts.length / 2)], () => {
        const sp = pts.map(pr);
        if (sp.some((q2) => !q2)) return;
        g.strokeStyle = rgb(col);
        g.lineCap = "round";
        g.lineJoin = "round";
        for (let i = 0; i + 1 < sp.length; i++) {
          const wdt = w0 + ((w1 - w0) * (i + 0.5)) / (sp.length - 1);
          g.lineWidth = Math.max(1, wdt * sp[i].ppm);
          g.beginPath();
          g.moveTo(sp[i].x, sp[i].y);
          g.lineTo(sp[i + 1].x, sp[i + 1].y);
          g.stroke();
        }
      });
      // a flat piece (a wing, a horn, a spike): lit by which way it faces
      const flat = (pts, col, alpha = 1) => add(pts.reduce((acc, q2) => acc.map((v, i) => v + q2[i] / pts.length), [0, 0, 0]), () => {
        const sp = pts.map(pr);
        if (sp.some((q2) => !q2)) return;
        const u = pts[1].map((v, i) => v - pts[0][i]);
        const v2 = pts[2].map((v, i) => v - pts[0][i]);
        const nn = [u[1] * v2[2] - u[2] * v2[1], u[2] * v2[0] - u[0] * v2[2], u[0] * v2[1] - u[1] * v2[0]];
        const nl = Math.hypot(...nn) || 1;
        const lam = 0.45 + 0.55 * Math.abs((nn[0] * LIGHT[0] + nn[1] * LIGHT[1] + nn[2] * LIGHT[2]) / nl);
        g.fillStyle = rgb(col.map((c) => Math.min(255, c * lam)), alpha);
        g.beginPath();
        sp.forEach((q2, i) => (i ? g.lineTo(q2.x, q2.y) : g.moveTo(q2.x, q2.y)));
        g.closePath();
        g.fill();
        g.strokeStyle = rgb(mixC(col, [0, 0, 0], 0.5), 0.6 * alpha);
        g.lineWidth = 0.7;
        g.stroke();
      });
      // a faceted solid round centre c: rings of points [[f, s, h]...] in the monster's frame, joined ring to ring
      const solid = (rings, col, tex = null) => {
        const R3 = rings.map((ring) => ring.map(([f, sd, h]) => P(f, sd, h)));
        const ctr = R3.flat().reduce((acc, q2, _, arr) => acc.map((v, i) => v + q2[i] / arr.length), [0, 0, 0]);
        const faces = [];
        for (let k = 0; k + 1 < R3.length; k++) {
          const A = R3[k];
          const B2 = R3[k + 1];
          const n = Math.max(A.length, B2.length);
          for (let i = 0; i < n; i++) faces.push([A[i % A.length], A[(i + 1) % A.length], B2[(i + 1) % B2.length], B2[i % B2.length]].filter((q2, j, arr) => arr.findIndex((o) => o === q2) === j));
        }
        // its ends closed (a ring of points, not a tip: a lid)
        if (R3[0].length >= 3) faces.push(R3[0]);
        if (R3.length > 1 && R3[R3.length - 1].length >= 3) faces.push(R3[R3.length - 1]);
        {
          for (const quad of faces) {
            const fc = quad.reduce((acc, q2) => acc.map((v, j) => v + q2[j] / quad.length), [0, 0, 0]);
            const out = fc.map((v, j) => v - ctr[j]);
            const u = quad[1].map((v, j) => v - quad[0][j]);
            const v2 = quad[2].map((v, j) => v - quad[0][j]);
            let nn = [u[1] * v2[2] - u[2] * v2[1], u[2] * v2[0] - u[0] * v2[2], u[0] * v2[1] - u[1] * v2[0]];
            if (nn[0] * out[0] + nn[1] * out[1] + nn[2] * out[2] < 0) nn = nn.map((v) => -v);
            if (nn[0] * (cam.x - fc[0]) + nn[1] * (cam.y - fc[1]) + nn[2] * (cam.h - fc[2]) <= 0) continue;
            add(fc, () => {
              const sp = quad.map(pr);
              if (sp.some((q2) => !q2)) return;
              const nl = Math.hypot(...nn) || 1;
              const lam = 0.32 + 0.68 * Math.max(0, (nn[0] * LIGHT[0] + nn[1] * LIGHT[1] + nn[2] * LIGHT[2]) / nl);
              g.fillStyle = rgb(col.map((c) => Math.min(255, c * lam)));
              g.beginPath();
              sp.forEach((q2, j) => (j ? g.lineTo(q2.x, q2.y) : g.moveTo(q2.x, q2.y)));
              g.closePath();
              g.fill();
              if (tex) {
                const c0 = pr(ctr);
                if (c0) skin(tex, c0.x, c0.y, Math.max(0.08, (r * c0.ppm) / 40));
              }
              g.strokeStyle = rgb(mixC(col, [0, 0, 0], 0.55), 0.7);
              g.lineWidth = 0.7;
              g.stroke();
            });
          }
        }
      };
      const ring = (n, rf, rs, h, f0 = 0, rot = 0) => Array.from({ length: n }, (_, i) => {
        const a = rot + (2 * Math.PI * i) / n;
        return [f0 + Math.cos(a) * rf, Math.sin(a) * rs, h];
      });
      const eyes = (f, sd, h, size, col = [255, 250, 220]) => {
        for (const side of [-1, 1]) {
          const c = P(f, side * sd, h);
          add(c, () => {
            const q2 = pr(c);
            if (!q2) return;
            const rr = Math.max(1.2, size * q2.ppm);
            g.fillStyle = rgb(col);
            g.beginPath();
            g.arc(q2.x, q2.y, rr, 0, 2 * Math.PI);
            g.fill();
            g.fillStyle = "#120808";
            g.beginPath();
            g.arc(q2.x, q2.y, rr * 0.45, 0, 2 * Math.PI);
            g.fill();
          });
        }
      };

      if (m.type === "crawler") {
        // a beetle: shell with a seam, head, mandibles, six legs walking
        const h = r * 0.75;
        ell(P(0, 0, h), r * 1.25, r * 0.95, r * 0.75, base, true, "gb_chitin");
        limb([P(-r * 1.1, 0, h + r * 0.55), P(r * 0.6, 0, h + r * 0.72)], r * 0.08, r * 0.08, dark);
        for (const side of [-1, 1]) limb([P(-r * 0.9, side * r * 0.5, h + r * 0.4), P(r * 0.4, side * r * 0.62, h + r * 0.55)], r * 0.05, r * 0.05, light);
        ell(P(r * 1.15, 0, h * 0.8), r * 0.45, r * 0.45, r * 0.38, dark, true, "gb_chitin");
        for (const side of [-1, 1]) {
          limb([P(r * 1.4, side * r * 0.2, h * 0.6), P(r * 1.85, side * r * 0.35, h * 0.55), P(r * 1.95, side * r * 0.1, h * 0.5)], r * 0.12, r * 0.06, dark);
          for (const k of [-1, 0, 1]) {
            const sw = Math.sin(t * 14 + k * 2.1 + (side > 0 ? 0 : Math.PI)) * r * 0.3;
            limb([P(k * r * 0.55, side * r * 0.7, h * 0.7), P(k * r * 0.6 + sw * 0.5, side * r * 1.35, h * 1.05), P(k * r * 0.75 + sw, side * r * 1.7, 0)], r * 0.13, r * 0.07, dark);
          }
        }
        eyes(r * 1.45, r * 0.22, h * 0.95, r * 0.1);
      } else if (m.type === "runner") {
        // a sprinter: a lean body on two long legs, a tail for balance, a crest
        const stride = Math.sin(t * 16);
        const h = r * 2.1 + Math.abs(stride) * r * 0.15;
        for (const side of [-1, 1]) {
          const sw = stride * side * r * 0.9;
          limb([P(0, side * r * 0.35, h - r * 0.2), P(sw * 0.4 - r * 0.25, side * r * 0.4, h * 0.5), P(sw, side * r * 0.4, 0)], r * 0.22, r * 0.1, dark);
        }
        limb([P(-r * 0.7, 0, h), P(-r * 1.7, 0, h + r * 0.3), P(-r * 2.5, 0, h + r * 0.15 + Math.sin(t * 8) * r * 0.2)], r * 0.32, r * 0.05, base);
        ell(P(0, 0, h), r * 1.0, r * 0.62, r * 0.6, base, true, "gb_scales");
        limb([P(r * 0.6, 0, h + r * 0.3), P(r * 1.0, 0, h + r * 0.9)], r * 0.32, r * 0.25, base);
        ell(P(r * 1.25, 0, h + r * 1.0), r * 0.55, r * 0.36, r * 0.34, light, true, "gb_scales");
        flat([P(r * 0.9, 0, h + r * 1.25), P(r * 1.5, 0, h + r * 1.35), P(r * 0.7, 0, h + r * 1.75)], mixC(base, [255, 200, 60], 0.5));
        eyes(r * 1.5, r * 0.22, h + r * 1.1, r * 0.11, [255, 230, 80]);
      } else if (m.type === "swarm") {
        // a wasp: hovering, striped sting, beating wings
        const h = r * 3.2 + Math.sin(t * 6) * r * 0.5;
        ell(P(-r * 0.9, 0, h - r * 0.15), r * 0.85, r * 0.55, r * 0.55, [235, 190, 40], false, "gb_fuzz");
        for (const k of [-1.25, -0.85, -0.45]) limb([P(r * k, -r * 0.5, h - r * 0.1), P(r * k, r * 0.5, h - r * 0.1)], r * 0.16, r * 0.16, [30, 24, 10]);
        flat([P(-r * 1.7, r * 0.12, h - r * 0.25), P(-r * 1.7, -r * 0.12, h - r * 0.25), P(-r * 2.3, 0, h - r * 0.45)], [40, 30, 10]);
        ell(P(r * 0.3, 0, h), r * 0.55, r * 0.45, r * 0.45, base, false, "gb_fuzz");
        ell(P(r * 0.95, 0, h + r * 0.05), r * 0.35, r * 0.35, r * 0.32, dark);
        eyes(r * 1.15, r * 0.2, h + r * 0.12, r * 0.12, [255, 60, 40]);
        const flap = Math.sin(time * 55 + m.wob) * 0.9;
        for (const side of [-1, 1]) {
          const tip = P(-r * 0.4, side * r * 2.0 * Math.cos(flap), h + r * 0.4 + r * 1.6 * Math.abs(Math.sin(flap)));
          flat([P(r * 0.5, side * r * 0.3, h + r * 0.35), tip, P(-r * 0.6, side * r * 0.25, h + r * 0.3)], [200, 230, 255], 0.45);
        }
      } else if (m.type === "brute") {
        // a stone golem: a faceted block body, a boxy head, horns, heavy arms and feet
        const step = Math.sin(t * 6);
        const h = r * 0.6;
        for (const side of [-1, 1]) {
          limb([P(0, side * r * 0.5, h), P(step * side * r * 0.35, side * r * 0.55, 0)], r * 0.45, r * 0.5, dark);
          limb([P(r * 0.1, side * r * 1.05, h + r * 1.2), P(-step * side * r * 0.4 + r * 0.2, side * r * 1.25, h + r * 0.55), P(r * 0.4, side * r * 1.2, h + r * 0.1)], r * 0.36, r * 0.42, mixC(base, [90, 80, 70], 0.4));
        }
        solid([ring(4, r * 0.75, r * 0.8, h, 0, Math.PI / 4), ring(4, r * 1.0, r * 1.1, h + r * 0.75, 0, Math.PI / 4), ring(4, r * 0.8, r * 0.95, h + r * 1.5, 0, Math.PI / 4)], base, "gb_stoneskin");
        solid([ring(4, r * 0.4, r * 0.42, h + r * 1.5, r * 0.25, Math.PI / 4), ring(4, r * 0.38, r * 0.4, h + r * 2.1, r * 0.3, Math.PI / 4)], light, "gb_stoneskin");
        for (const side of [-1, 1]) flat([P(r * 0.35, side * r * 0.25, h + r * 2.0), P(r * 0.3, side * r * 0.45, h + r * 2.05), P(r * 0.4, side * r * 0.7, h + r * 2.6)], [235, 225, 200]);
        eyes(r * 0.62, r * 0.17, h + r * 1.8, r * 0.09, [255, 140, 40]);
      } else {
        // the giant: a floating crystal demon -- a faceted spindle, a ring of spikes, horns, burning eyes
        const h = r * 1.6 + Math.sin(t * 2) * r * 0.2;
        const spin = t * 0.8;
        solid([[[0, 0, h + r * 1.3]], ring(6, r * 0.95, r * 0.95, h + r * 0.15, 0, spin), ring(6, r * 0.7, r * 0.7, h - r * 0.5, 0, spin + 0.5), [[0, 0, h - r * 1.2]]], base, "gb_shards");
        for (let k = 0; k < 6; k++) {
          const a = spin + (2 * Math.PI * k) / 6;
          const c = [Math.cos(a), Math.sin(a)];
          const b0 = P(c[0] * r * 0.8, c[1] * r * 0.8, h + r * 0.25);
          const b1 = P(c[0] * r * 0.8, c[1] * r * 0.8, h);
          flat([b0, P(c[0] * r * 1.8, c[1] * r * 1.8, h + r * 0.25), b1], mixC(base, [255, 120, 255], 0.4));
        }
        for (const side of [-1, 1]) flat([P(r * 0.2, side * r * 0.3, h + r * 1.0), P(r * 0.1, side * r * 0.55, h + r * 1.0), P(r * 0.3, side * r * 0.75, h + r * 1.9)], [40, 20, 40]);
        eyes(r * 0.7, r * 0.3, h + r * 0.45, r * 0.13, [255, 220, 120]);
      }

      // the shadow, the parts far to near, the health bar
      ar.queue(head.depth, () => {
        ar.floorCircle(m.x, m.y, r * (m.type === "brute" ? 1.3 : 1.0), "rgba(0,0,0,0.3)");
        parts
          .map((pt) => ({ ...pt, d: Math.hypot(pt.at[0] - cam.x, pt.at[1] - cam.y, pt.at[2] - cam.h) }))
          .sort((p1, p2) => p2.d - p1.d)
          .forEach((pt) => pt.fn());
        if (m.hp < m.max) {
          const top = ar.project(m.x, m.y, r * (m.type === "boss" ? 3.6 : m.type === "swarm" ? 4.2 : m.type === "runner" ? 3.8 : 2.8));
          if (!top) return;
          const bw = Math.max(14, r * 2.4 * top.ppm);
          g.fillStyle = "rgba(0,0,0,0.6)";
          g.fillRect(top.x - bw / 2, top.y - 6, bw, 3);
          g.fillStyle = m.poisonT > 0 ? "#80ff60" : "#ff5050";
          g.fillRect(top.x - bw / 2, top.y - 6, (bw * Math.max(0, m.hp)) / m.max, 3);
        }
      });
    }

    function draw() {
      const v = ar.view;
      if (state === "playing" || state === "won" || state === "over") {
        w.beginFrame();
        drawArena();
        cubes.forEach((c) => drawGem(c));
        monsters.forEach((m) => drawMonster(m));
        shots.forEach((s) => {
          const p = ar.project(s.x, s.y, s.h);
          if (!p) return;
          ar.queue(p.depth, () => ar.glow(p.x, p.y, Math.max(4, (0.006 + 0.001 * s.grade) * p.ppm), [[0, "rgba(255,255,255,0.95)"], [0.4, rgb(s.color, 0.9)], [1, rgb(s.color, 0)]]));
        });
        puffs.forEach((pf) => {
          const k = pf.t / 0.6;
          if (pf.ring) ar.floorCircle(pf.x, pf.y, pf.r * (0.3 + k), null, rgb(pf.color, 1 - k));
          else {
            const p = ar.project(pf.x, pf.y, pf.h + k * 0.02);
            if (p) ar.queue(p.depth, () => ar.glow(p.x, p.y, Math.max(4, pf.r * (0.5 + k) * p.ppm), [[0, rgb(pf.color, 0.6 * (1 - k))], [1, rgb(pf.color, 0)]]));
          }
        });
        bolts.forEach((b) => {
          const pts = b.pts.map(([x, y, h]) => ar.project(x, y, h)).filter(Boolean);
          if (pts.length < 2) return;
          const g = ar.ctx;
          g.strokeStyle = rgb([255, 255, 200], 1 - b.t / 0.18);
          g.lineWidth = 2;
          g.beginPath();
          pts.forEach((p, i) => {
            if (!i) return g.moveTo(p.x, p.y);
            const a = pts[i - 1];
            const mx = (a.x + p.x) / 2 + (Math.random() - 0.5) * 10;
            const my = (a.y + p.y) / 2 + (Math.random() - 0.5) * 10;
            g.lineTo(mx, my);
            g.lineTo(p.x, p.y);
          });
          g.stroke();
        });
      }
      ar.flush();

      // the aim
      if (state === "playing" && !L.road) {
        const g = ar.ctx;
        g.strokeStyle = "rgba(255,255,255,0.7)";
        g.lineWidth = 1.5;
        g.beginPath();
        g.moveTo(v.cx - 10, v.cy);
        g.lineTo(v.cx + 10, v.cy);
        g.moveTo(v.cx, v.cy - 10);
        g.lineTo(v.cx, v.cy + 10);
        g.stroke();
      }

      if (state === "title") {
        const small = Lynx.smallScreen();
        ar.flash("#000", 0.55);
        ar.text("GEM BASTION", v.cx, v.y + (small ? 40 : 62), { size: small ? 28 : 44, align: "center", color: "#9ad8ff", font: "Impact, 'Arial Black', sans-serif", weight: "normal" });
        if (!small) ar.text("Your tagged cubes are gem towers · stack two to merge their gems · an empty cube on the home field gets a new one", v.cx, v.y + 90, { size: 13, align: "center" });
        ar.text(`The arena (${Math.round(S * 100)} x ${Math.round(S * 100)} cm) is laid out on the floor right in front of the robot`, v.cx, v.y + (small ? 60 : 110), { size: small ? 11 : 13, align: "center" });
        menu.draw(v.y + (small ? 76 : 128), v.y + v.h - 90);
        if (best !== null) ar.text(`Best on this robot: ${best}`, v.cx, v.y + v.h - 36, { size: 14, align: "center", color: "#9ad8ff" });
        return;
      }
      // HUD
      const x0 = v.x + 14;
      ar.text(`◆ ${Math.floor(mana)} mana`, x0, v.y + 26, { size: 18, color: "#9ad8ff" });
      ar.text(`Crystal ${Math.max(0, baseHp)}/20`, x0, v.y + 48, { size: 15, color: "#ff9aff" });
      ar.text(`${tr(L.name)} · wave ${wave}/${L.waves}`, v.x + v.w - 14, v.y + 26, { size: 15, align: "right" });
      if (state === "playing" && wave < L.waves) ar.text(`next wave in ${Math.ceil(nextWaveIn)} s  (Space / A: now)`, v.x + v.w - 14, v.y + 46, { size: 13, align: "right", color: "#c8c0a8" });
      ar.text(`SCORE ${Math.round(score)}`, x0, v.y + v.h - 16, { size: 18, color: "#9ad8ff" });
      const towers = cubes.filter((c) => c.tower).length;
      const empty = cubes.filter((c) => c.gem.grade <= 0).length;
      ar.text(`${towers} tower${towers === 1 ? "" : "s"}${empty ? ` · ${empty} empty cube${empty > 1 ? "s" : ""}: to the home field (${GEM_COST} mana)` : ""}`, v.cx, v.y + v.h - 16, { size: 13, align: "center" });
      if (state === "playing" && !L.road && aimTile) {
        const t = tiles[idx(aimTile.i, aimTile.j)];
        const hint = t === "wall" ? "FIRE: take the wall down" : t === "grass" ? `FIRE: wall (${WALL_COST} mana)` : "";
        if (hint) ar.text(hint, v.cx, v.cy + 26, { size: 13, align: "center", color: "#c8ffd0" });
      }
      if (state === "playing" && hoverTile && mouse) {
        const t = tiles[idx(hoverTile.i, hoverTile.j)];
        const hint = t === "wall" ? "click: take the wall down" : t === "grass" ? `click: wall (${WALL_COST} mana)` : "";
        if (hint) ar.text(hint, mouse.x + 14, mouse.y - 10, { size: 12, color: "#c8ffd0" });
      }
      // what's aimed at: a tower's gem
      const aimed = aimTile && cubes.find((c) => c.tile && c.gem.grade > 0 && Math.abs(c.tile.i - aimTile.i) <= 1 && Math.abs(c.tile.j - aimTile.j) <= 1);
      if (aimed && state === "playing") {
        const st = stats(aimed.gem);
        const fx = [st.splash ? "splash" : "", st.poison > 0.05 ? "poison" : "", st.slow > 0.05 ? "slow" : "", st.chain ? `chain ${st.chain}` : ""].filter(Boolean).join(", ");
        ar.text(`Cube ${aimed.b.tag}: ${gemName(aimed.gem)} · damage ${Math.round(st.dmg)} · reach ${Math.round(st.range * 100)} cm${fx ? " · " + fx : ""}`, v.cx, v.cy + 44, { size: 13, align: "center", color: rgb(gemColor(aimed.gem)) });
      }
      if (cubesIgnored && state === "playing") ar.text("The cubes shut the way: the monsters climb over them", v.cx, v.y + 70, { size: 13, align: "center", color: "#ffb080" });
      if (toast) ar.text(toast.text, v.cx, v.y + v.h * 0.3, { size: 20, align: "center", color: toast.color, alpha: clamp(toast.t * 2, 0, 1) });
      if (layer.drawStatus) layer.drawStatus();
      if (paused && state === "playing") {
        ar.flash("#000", 0.35);
        ar.banner("PAUSED", "P or the Pause button: carry on · walls can still be built meanwhile", { color: "#9ad8ff" });
      }
      if (state === "won" || state === "over") {
        ar.flash("#000", 0.45);
        ar.banner(state === "won" ? "THE CRYSTAL HOLDS" : "THE CRYSTAL SHATTERED", `${tr(L.name)} · score ${Math.round(score)} · wave ${wave}/${L.waves}`, { color: state === "won" ? "#9ad8ff" : "#ff6080" });
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.18, { size: 16, align: "center", color: "#9ad8ff" });
        if (stateTime > 1.5) ar.text("Press FIRE for the level menu", v.cx, v.cy + v.h * 0.25, { size: 14, align: "center" });
      }
    }

    ar.onFrame((now, dt) => {
      wall += Math.min(dt, 0.1);
      update(Math.min(dt, 0.1));
      draw();
    });
    return {
      actionLabel: "🧱 Wall",
      snapshot: () => ({
        state, level: L && L.name, wave, mana: Math.floor(mana), baseHp, score: Math.round(score), monsters: monsters.length,
        gems: [...gems].map(([tag, g]) => `${tag}:${g.grade > 0 ? gemName(g) : "empty"}`), cubesIgnored,
      }),
      debug: { tileWorld, sendWave,
        // (tests: a monster of this kind on this tile, standing still)
        monster(type, i, j) {
          const p = tileWorld(i, j);
          monsters.push({ type, def: MONSTERS[type], x: p.x, y: p.y, hp: 100, max: 100, to: null, jit: 0, slowT: 0, slowK: 0, poisonT: 0, poisonDps: 0, wob: Math.random() * 6, hitT: 0, dir: 0.8, frozen: true });
        },
        paused: () => paused,
        toggleWall,
        monsters: () => monsters, gems: () => gems, aimTile: () => aimTile, tileAtScreen, tileScreen: (i, j) => {
        const r = q(i, j);
        return w.project((r.f0 + r.f1) / 2, (r.r0 + r.r1) / 2, 0);
      } },
    };
  };
})(window.Lynx);
