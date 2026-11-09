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
// standing in the arena and the walls you build: aim the middle of the
// camera at a tile and press FIRE (FIRE on a wall takes it down again, half
// its price back). A wall may not shut the way completely; if the cubes do,
// the monsters climb over them. Space / gamepad A / the touch button (or
// FIRE on a road level): call the next wave now (bonus mana).
//
// Drawing: flat colour on the 2D canvas through world3d.js (floor, walls),
// the gems as faceted solids (back faces culled: a convex shape needs no
// sorting), the monsters as shaded blobs; all depth sorted (ar.queue).

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
      road: [[[0, 4], [5, 4], [5, 15], [10, 15], [10, 4], [15, 4], [15, 10], [17, 10]]], base: [17, 10], home: [17, 1] },
    { name: "Twin Gates", blurb: "Two roads, one crystal", waves: 10, mana: 50,
      road: [[[0, 3], [8, 3], [8, 9], [16, 9]], [[0, 16], [8, 16], [8, 10], [16, 10]]], base: [16, 9], home: [17, 1] },
    { name: "Open Field", blurb: "No road: build walls and make them walk", waves: 10, mana: 90,
      entries: [[0, 8], [0, 9], [0, 10], [0, 11]], base: [17, 9], home: [17, 1],
      rocks: [[5, 3], [5, 4], [6, 15], [7, 15], [11, 6], [11, 13], [12, 13]] },
    { name: "The Spiral", blurb: "A long road coiled round the crystal", waves: 12, mana: 50,
      road: [[[0, 2], [17, 2], [17, 17], [2, 17], [2, 5], [14, 5], [14, 14], [5, 14], [5, 8], [11, 8], [11, 11]]], base: [12, 10], home: [18, 0] },
    { name: "Crossroads", blurb: "Open field, two ways in, quick monsters", waves: 12, mana: 110, speed: 1.15,
      entries: [[8, 0], [9, 0], [10, 0], [11, 0], [0, 8], [0, 9], [0, 10], [0, 11]], base: [17, 15], home: [17, 1],
      rocks: [[4, 4], [4, 5], [5, 4], [9, 12], [10, 12], [14, 7], [14, 8], [3, 15], [3, 16]] },
    { name: "Last Stand", blurb: "Three gates, fifteen waves", waves: 15, mana: 130, hp: 1.2,
      entries: [[9, 0], [10, 0], [0, 9], [0, 10], [9, 19], [10, 19]], base: [17, 9], home: [18, 0] },
  ];

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
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
    }

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
      say(`${L.name}: set your cubes out round the road -- monsters in ${START_WAIT_S} s`, "#ffe9a8", 4);
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
      if (L.road || !aimTile) return callWave();
      // a wall: build it, or take it down
      const k = idx(aimTile.i, aimTile.j);
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
        return t && t.i === aimTile.i && t.j === aimTile.j;
      })) return say("A monster is on that tile", "#ff9a7a", 1.4);
      if (!reachable(bfs(null, k))) return say("That would shut the way completely", "#ff9a7a", 1.6);
      tiles[k] = "wall";
      wallsVersion++;
      mana -= WALL_COST;
      sfx("tick");
    });
    Lynx.onAction("jump", () => state === "playing" && callWave());
    Lynx.touchButtons().add("⏩ Next wave", () => callWave());

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
        if (pick) m.to = pick;
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
      mana += dt * 0.5;
      // waves
      if (wave < L.waves) {
        nextWaveIn -= dt;
        if (nextWaveIn <= 0) sendWave();
      }
      while (spawnQ.length && spawnQ[0].at <= time) spawn(spawnQ.shift());
      monsters.forEach((m) => stepMonster(m, dt));
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
    const WALL = { top: "#a29a8a", side: "#7d766a", dark: "#5f594f", line: "rgba(20,15,10,0.6)", detail: "slab" };
    const ROCK = { top: "#6f6a62", side: "#57534c", dark: "#3f3c37", line: "rgba(10,8,5,0.7)" };
    const q = (i, j, m = 0) => ({ f0: (N - 1 - i) * T + m, f1: (N - i) * T - m, r0: -S / 2 + j * T + m, r1: -S / 2 + (j + 1) * T - m });

    function drawArena() {
      // the grass in 2 x 2 tile patches (one big polygon, clipped where it
      // runs under the camera, came out cut off), the border as a line
      const grass = L.road ? "rgba(60,110,50,0.28)" : "rgba(70,105,55,0.25)";
      for (let a = 0; a < N; a += 2) for (let b = 0; b < N; b += 2) w.floor({ f0: a * T, f1: (a + 2) * T, r0: -S / 2 + b * T, r1: -S / 2 + (b + 2) * T }, 0.0002, grass, null);
      w.line3([[0, -S / 2, 0.0006], [S, -S / 2, 0.0006], [S, S / 2, 0.0006], [0, S / 2, 0.0006], [0, -S / 2, 0.0006]], "rgba(160,220,140,0.75)", 2, T);
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const t = tiles[idx(i, j)];
          if (t === "road") w.floor(q(i, j), 0.0004, "rgba(150,115,70,0.6)", null);
          else if (t === "entry") w.floor(q(i, j), 0.0004, `rgba(170,60,255,${0.45 + 0.2 * Math.sin(time * 4 + i + j)})`, null);
          else if (t === "home") w.floor(q(i, j), 0.0004, "rgba(255,210,80,0.45)", "rgba(255,230,140,0.9)");
          else if (t === "base") w.floor(q(i, j), 0.0004, "rgba(255,120,255,0.3)", null);
        }
      }
      // the grid (the open fields: where a wall can go)
      const gc = L.road ? "rgba(200,240,190,0.14)" : "rgba(220,255,210,0.25)";
      for (let k = 1; k < N; k++) {
        w.line3([[k * T, -S / 2, 0.0005], [k * T, S / 2, 0.0005]], gc, 1, T);
        w.line3([[0, -S / 2 + k * T, 0.0005], [S, -S / 2 + k * T, 0.0005]], gc, 1, T);
      }
      if (aimTile && !L.road && state === "playing") {
        const t = tiles[idx(aimTile.i, aimTile.j)];
        const ok = t === "grass" || t === "wall";
        w.floor(q(aimTile.i, aimTile.j), 0.0008, ok ? "rgba(120,255,160,0.25)" : "rgba(255,100,100,0.2)", ok ? "rgba(160,255,190,0.95)" : "rgba(255,120,120,0.9)", { width: 2 });
      }
      for (let i = 0; i < N; i++) {
        for (let j = 0; j < N; j++) {
          const t = tiles[idx(i, j)];
          if (t === "wall") w.box(q(i, j, 0.002), 0, T * 0.5, WALL);
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
      for (let k = 0; k < K; k++) {
        const prev = C[(k - 1 + K) % K];
        const cur = C[k];
        const next = C[(k + 1) % K];
        // the rounded corner: from a little before it to a little after
        const a = lerp2(cur, prev, ROUND);
        const b = lerp2(cur, next, ROUND);
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
      outlines.set(grade, o);
      return o;
    }
    function drawCutGem(x, y, h, R, grade, rock, color, alpha) {
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
        g.strokeStyle = rgb(color.map((q2) => Math.min(255, q2 * 0.45 + 150)), (table ? 0.7 : 0.35) * alpha);
        g.lineWidth = table ? 1.2 : 0.6;
        g.stroke();
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
      const h = b.h1 + 0.012 + R + Math.sin(time * 2 + b.tag) * 0.003;
      const p = ar.project(b.x, b.y, h);
      if (!p) return;
      const col = gemColor(g);
      ar.queue(p.depth, () => {
        ar.glow(p.x, p.y, Math.max(8, R * 2.4 * p.ppm), [[0, rgb(col, 0.45)], [1, rgb(col, 0)]]);
        drawCutGem(b.x, b.y, h, R, g.grade, g.spin, col, c.tower || c.stacked ? 0.94 : 0.5);
        if (g.grade > 1) ar.text(String(g.grade), p.x, p.y - R * 1.6 * p.ppm - 4, { size: 11, align: "center", color: "#ffffff", alpha: 0.85 });
      });
      // its ring on the floor (a tower: the reach, when the camera points at it)
      if (c.tower) {
        w.floor(footQ(b), 0.0009, null, rgb(col, 0.9), { width: 2 });
        if (aimTile && c.tile && Math.abs(aimTile.i - c.tile.i) <= 1 && Math.abs(aimTile.j - c.tile.j) <= 1) ar.floorCircle(b.x, b.y, stats(g).range, rgb(col, 0.06), rgb(col, 0.6));
      }
    }
    // a cube's footprint in the arena's frame
    function footQ(b) {
      const l = w.toLocal(b.x, b.y);
      const hh = b.half * 1.15;
      return { f0: l.f - hh, f1: l.f + hh, r0: l.r - hh, r1: l.r + hh };
    }

    function drawMonster(m) {
      const r = m.def.r * 1.35 * Math.sqrt(S);
      const bob = Math.abs(Math.sin(time * 9 + m.wob)) * r * 0.25;
      const p = ar.project(m.x, m.y, r + bob);
      if (!p) return;
      ar.queue(p.depth, () => {
        const g = ar.ctx;
        const rp = Math.max(3, r * p.ppm);
        ar.floorCircle(m.x, m.y, r * 0.9, "rgba(0,0,0,0.3)");
        const grad = g.createRadialGradient(p.x - rp * 0.35, p.y - rp * 0.4, rp * 0.1, p.x, p.y, rp);
        const base = m.hitT > 0 ? "#ffffff" : m.slowT > 0 ? "#80c8ff" : m.poisonT > 0 ? "#90ff70" : m.def.color;
        grad.addColorStop(0, "rgba(255,255,255,0.9)");
        grad.addColorStop(0.25, base);
        grad.addColorStop(1, "rgba(20,10,20,0.95)");
        g.fillStyle = grad;
        g.beginPath();
        g.ellipse(p.x, p.y, rp * 1.1, rp * 0.9, 0, 0, 2 * Math.PI);
        g.fill();
        // eyes, toward where it's going
        const look = m.dir === undefined ? 0 : m.dir;
        const e = ar.project(m.x + Math.cos(look) * r * 0.7, m.y + Math.sin(look) * r * 0.7, r * 1.2 + bob);
        if (e) {
          g.fillStyle = "#fff";
          for (const sd of [-1, 1]) {
            g.beginPath();
            g.arc(e.x + sd * rp * 0.28, e.y, rp * 0.18, 0, 2 * Math.PI);
            g.fill();
          }
          g.fillStyle = "#200";
          for (const sd of [-1, 1]) {
            g.beginPath();
            g.arc(e.x + sd * rp * 0.28, e.y + rp * 0.04, rp * 0.08, 0, 2 * Math.PI);
            g.fill();
          }
        }
        // health
        if (m.hp < m.max) {
          const bw = Math.max(14, rp * 2.2);
          g.fillStyle = "rgba(0,0,0,0.6)";
          g.fillRect(p.x - bw / 2, p.y - rp * 1.4 - 5, bw, 3);
          g.fillStyle = m.poisonT > 0 ? "#80ff60" : "#ff5050";
          g.fillRect(p.x - bw / 2, p.y - rp * 1.4 - 5, (bw * Math.max(0, m.hp)) / m.max, 3);
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
      if (state === "playing" && wave < L.waves) ar.text(`next wave in ${Math.ceil(nextWaveIn)} s  (${L.road ? "FIRE / " : ""}Space / A: now)`, v.x + v.w - 14, v.y + 46, { size: 13, align: "right", color: "#c8c0a8" });
      ar.text(`SCORE ${Math.round(score)}`, x0, v.y + v.h - 16, { size: 18, color: "#9ad8ff" });
      const towers = cubes.filter((c) => c.tower).length;
      const empty = cubes.filter((c) => c.gem.grade <= 0).length;
      ar.text(`${towers} tower${towers === 1 ? "" : "s"}${empty ? ` · ${empty} empty cube${empty > 1 ? "s" : ""}: to the home field (${GEM_COST} mana)` : ""}`, v.cx, v.y + v.h - 16, { size: 13, align: "center" });
      if (state === "playing" && !L.road && aimTile) {
        const t = tiles[idx(aimTile.i, aimTile.j)];
        const hint = t === "wall" ? "FIRE: take the wall down" : t === "grass" ? `FIRE: wall (${WALL_COST} mana)` : "";
        if (hint) ar.text(hint, v.cx, v.cy + 26, { size: 13, align: "center", color: "#c8ffd0" });
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
      if (state === "won" || state === "over") {
        ar.flash("#000", 0.45);
        ar.banner(state === "won" ? "THE CRYSTAL HOLDS" : "THE CRYSTAL SHATTERED", `${tr(L.name)} · score ${Math.round(score)} · wave ${wave}/${L.waves}`, { color: state === "won" ? "#9ad8ff" : "#ff6080" });
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.18, { size: 16, align: "center", color: "#9ad8ff" });
        if (stateTime > 1.5) ar.text("Press FIRE for the level menu", v.cx, v.cy + v.h * 0.25, { size: 14, align: "center" });
      }
    }

    ar.onFrame((now, dt) => {
      update(Math.min(dt, 0.1));
      draw();
    });
    return {
      actionLabel: "🧱 Wall / wave",
      snapshot: () => ({
        state, level: L && L.name, wave, mana: Math.floor(mana), baseHp, score: Math.round(score), monsters: monsters.length,
        gems: [...gems].map(([tag, g]) => `${tag}:${g.grade > 0 ? gemName(g) : "empty"}`), cubesIgnored,
      }),
      debug: { tileWorld, sendWave, gems: () => gems, aimTile: () => aimTile },
    };
  };
})(window.Lynx);
