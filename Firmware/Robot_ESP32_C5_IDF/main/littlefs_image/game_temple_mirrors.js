// Temple of LynXP, level 7: the hall of mirrors. Run by game_temple.js
// through Lynx.templeMirrors(api); parts from game_temple_kit.js.
//
// Sunbeams through three halls, one behind the other. Light is the key:
//   - a beam runs low over the floor, from a sun window, until it hits
//     something. It burns -- jump over it. The robot's body stops it (and
//     whatever it was lighting goes dark), and so does a mummy (which burns);
//   - mirrors (shoot one to turn it a quarter) bend a beam 90 degrees;
//     prisms let it through and bend a copy;
//   - crystals: a gold one, once lit, keeps its door open; a blue one holds
//     its door open only while it's lit;
//   - the Sun Shield (in the last hall): with it the robot itself is a
//     mirror. Stand in a beam and turn: it bends the beam the way you face
//     (face diagonally across it for a quarter turn).
// Take the Sun Disc and the shield cracks, and the mirrors start spinning on
// their own: get out through all three halls, jumping the beams.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const K = Lynx.templeKit;
  const { clamp, inRect, cellI, cellJ, cellCenter, CELL, ROWS, COLS, R_MIN, R_MAX, LEN } = K;

  // # wall, . floor, A the entry hall's door (gold crystal), B the court's
  // door (both blue crystals), C the bars before the Sun Disc's alcove.
  const MAP = K.parseMap([
    "############", // 19: the skylight shines down column 8
    "#..#.......#", //     the Sun Disc's alcove (west)
    "#..#.......#",
    "#CC........#",
    "#..........#", // 15: the shrine
    "#..........#",
    "#####BB#####",
    "#..........#",
    "#..#....#..#",
    "#..........#", // 10: the mirror court
    "#..........#",
    "#..........#",
    "#..........#",
    "#####AA#####",
    "#..........#", // 5: the entry hall
    "#..........#",
    "#..........#", // 3: the sun window in the east wall
    "#..........#",
    "#..........#",
    "#..........#", // 0: the way in
  ]);
  const HALL = ["entry hall", "mirror court", "sun shrine"];
  const hallOf = (f) => (f < 6 * CELL ? 0 : f < 13 * CELL ? 1 : 2);

  const BEAM_H = 0.04; // low over the floor: jump it
  const ROBOT_R = 0.06; // the robot stops a beam this close to its middle
  const MUMMY_R = 0.05;
  const BURN_S = 0.25; // this long in a beam burns
  const ENEMY_BURN_S = 0.5; // a mummy in a beam loses a life this often
  const TURN_S = 0.3; // a mirror's quarter turn (drawn)
  const TURN_COOL_S = 0.6; // shots at a turning mirror do nothing (auto-fire)
  const SPIN_S = { easy: 2.6, normal: 1.8, hard: 1.3 }; // the escape: a mirror turns on its own this often
  const STEP = 0.01; // beam tracing step (m)

  // a sun window: the beam starts at the wall's inner face
  const SOURCES = [
    { f: 3.5 * CELL, r: R_MAX - CELL, d: [0, -1] }, // the entry hall's, heading west
    { f: 19 * CELL, r: R_MIN + 8.5 * CELL, d: [-1, 0] }, // the shrine's skylight, heading south
  ];
  // o: "/" or "\" as on the map (north up): "/" bends an eastbound beam north
  const MIRRORS = [
    { id: "m0", kind: "mirror", i: 3, j: 2, o: "/" },
    { id: "p1", kind: "prism", i: 3, j: 5, o: "\\" },
    { id: "m4", kind: "mirror", i: 9, j: 2, o: "/" },
    { id: "p3", kind: "prism", i: 9, j: 5, o: "/" },
    { id: "m5", kind: "mirror", i: 9, j: 9, o: "\\" },
    { id: "p5", kind: "prism", i: 10, j: 5, o: "\\" },
    { id: "m7", kind: "mirror", i: 17, j: 4, o: "\\" },
  ];
  const CRYSTALS = [
    { id: "A", i: 5, j: 2, latch: true }, // the entry hall's door
    { id: "B1", i: 12, j: 2, latch: false }, // the court's door: both at once
    { id: "B2", i: 10, j: 10, latch: false },
    { id: "C1", i: 14, j: 4, latch: true }, // the Sun Disc's bars: both
    { id: "C2", i: 16, j: 10, latch: true },
  ];

  const WALL = { top: "#b8a070", side: "#8a7248", dark: "#665234", line: "rgba(30,20,8,0.6)", mortar: true, tex: "sandstone" };
  const DOOR = { top: "#c8a040", side: "#9a7a28", dark: "#6e5818", line: "rgba(40,24,4,0.9)" };
  const PLINTH = { top: "#9a9080", side: "#746a5a", dark: "#554c40", line: "rgba(20,15,8,0.8)" };
  const GLASS = { top: "rgba(200,245,255,0.35)", side: "rgba(150,220,255,0.3)", dark: "rgba(110,180,230,0.3)", line: "rgba(230,250,255,0.8)" };

  const SHIELD = ["..kkkk..", ".kyyyyk.", "kyywwyyk", "kywooowk", "kywooowk", "kyywwyyk", ".kyyyyk.", "..kkkk.."];
  const DISC = ["...kkkk...", ".kkyyyykk.", ".kyywwyyk.", "kyywooowyk", "kywooooowk", "kywooooowk", "kyywooowyk", ".kyywwyyk.", ".kkyyyykk.", "...kkkk..."];
  const CRYSTAL = ["..k..", ".kck.", "kcwck", "kccck", ".kck.", "..k.."];

  Lynx.templeMirrors = (api) => {
    const { ar } = api;
    const diff = api.cfg.difficulty in SPIN_S ? api.cfg.difficulty : "normal";
    const N = {
      easy: { scarabs: 1, mummies: 1, wisps: 0, bats: 1 },
      normal: { scarabs: 2, mummies: 2, wisps: 1, bats: 2 },
      hard: { scarabs: 3, mummies: 3, wisps: 2, bats: 3 },
    }[diff];
    const img = {
      shield: Lynx.sprite(SHIELD, { k: "#5a3a08", y: "#e0b030", w: "#fff4c0", o: "#ffffff" }),
      disc: Lynx.sprite(DISC, { k: "#6a4008", y: "#ffc020", w: "#fff080", o: "#ffffff" }),
      gold: Lynx.sprite(CRYSTAL, { k: "#6a4a08", c: "#e0a020", w: "#fff4c0" }),
      goldLit: Lynx.sprite(CRYSTAL, { k: "#8a6a10", c: "#ffe060", w: "#ffffff" }),
      blue: Lynx.sprite(CRYSTAL, { k: "#0a2a5a", c: "#3070c0", w: "#c0e0ff" }),
      blueLit: Lynx.sprite(CRYSTAL, { k: "#2050a0", c: "#70d0ff", w: "#ffffff" }),
    };

    let time = 0;
    const cell = (i, j) => (i < 0 || i >= ROWS || j < 0 || j >= COLS ? "#" : MAP[i][j]);
    const rectOf = (ch) => K.rectWhere((i, j) => MAP[i][j] === ch);
    const walls = K.mergeCells((i, j) => cell(i, j) === "#").map((q) => ({ ...q, h0: 0, h1: 0.3 }));
    const wallsDrawn = K.mergeCells((i, j) => cell(i, j) === "#" && !api.onRim(i, j, ROWS, COLS));
    const rimWalls = K.mergeCells((i, j) => cell(i, j) === "#" && api.onRim(i, j, ROWS, COLS));
    const outer = K.outerWalls(CELL).filter((q) => !K.behindRim(q, (f, r) => cell(cellI(f), cellJ(r)) === "#"));
    const doors = { A: { ...rectOf("A"), open: 0 }, B: { ...rectOf("B"), open: 0 }, C: { ...rectOf("C"), open: 0 } };
    const mirrors = MIRRORS.map((m) => ({ ...m, ...cellCenter(m.i, m.j), start: m.o, angle: m.o === "/" ? 45 : -45, spin: 0, cool: 0, hit: 0, rect: null }));
    const crystals = CRYSTALS.map((c) => ({ ...c, ...cellCenter(c.i, c.j), lit: false, latched: false, rect: null }));
    const objAt = Array.from({ length: ROWS }, () => new Array(COLS).fill(null));
    mirrors.forEach((m) => (objAt[m.i][m.j] = m));
    crystals.forEach((c) => (objAt[c.i][c.j] = c));
    const crystal = (id) => crystals.find((c) => c.id === id);
    const plinthRect = (o) => ({ f0: o.f - 0.05, f1: o.f + 0.05, r0: o.r - 0.05, r1: o.r + 0.05 });

    let shield = false;
    let disc = false; // taken: the escape
    let spinT = 0;
    let burnT = 0;
    let beams = []; // this frame's segments {a, b}
    let robotInBeam = false;
    let visited = new Set([0]);
    const woken = new Set();
    const items = [
      { kind: "gem", ...cellCenter(3, 8), base: 0.1, float: true }, // over the first beam
      { kind: "gem", ...cellCenter(1, 1), base: 0 },
      { kind: "potion", ...cellCenter(7, 10), base: 0 },
      { kind: "gem", ...cellCenter(12, 10), base: 0 },
      { kind: "gem", ...cellCenter(8, 1), base: 0 },
      { kind: "bigGem", ...cellCenter(18, 5), base: 0 },
      { kind: "potion", ...cellCenter(14, 9), base: 0 },
      { kind: "shield", ...cellCenter(18, 10), base: 0, size: 0.07, glow: "rgba(255,230,140,0.9)" },
      { kind: "disc", f: 17.8 * CELL, r: R_MIN + 1.5 * CELL, base: 0, size: 0.09, glow: "rgba(255,220,80,0.95)" },
    ];

    // -- solids ------------------------------------------------------------------------------
    const doorShut = (k) => doors[k].open < 0.9;
    function solids() {
      const out = walls.slice();
      Object.keys(doors).forEach((k) => doors[k].open < 1 && out.push({ ...doors[k], h0: 0, h1: 0.3 * (1 - doors[k].open) }));
      mirrors.forEach((m) => out.push({ ...plinthRect(m), h0: 0, h1: 0.3, plinth: true }));
      crystals.forEach((c) => out.push({ ...plinthRect(c), h0: 0, h1: 0.3, plinth: true }));
      return out;
    }
    const boundary = K.boundary();
    const blockers = (feet) => solids().concat(boundary).filter((b) => b.h1 > feet + K.STEP_UP && b.h0 < feet + K.BODY_H);
    const stopper = K.wallStopper(api, blockers);
    // sight: walls and doors (the plinths are low, the glass you see through)
    function pointSolid(f, r, h) {
      if (h > 0.3) return false;
      if (cell(cellI(f), cellJ(r)) === "#") return true;
      return Object.keys(doors).some((k) => inRect(f, r, doors[k]) && h <= 0.3 * (1 - doors[k].open));
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
      walkOk: (e, f, r) => cell(cellI(f), cellJ(r)) !== "#" && !"ABC".includes(cell(cellI(f), cellJ(r))) && !solids().some((b) => b.plinth && inRect(f, r, K.grow(b, 0.02))),
    });

    // -- light -------------------------------------------------------------------------------
    // The robot's heading in temple coordinates.
    function heading() {
      const a = ar.pose.theta - api.anchor().th;
      return { f: Math.cos(a), r: -Math.sin(a) };
    }
    // A beam along d bent by the robot's shield: mirrored in the plane the
    // robot faces, then to the nearest of the four directions.
    function shieldBend(d) {
      const n = heading();
      const dot = d[0] * n.f + d[1] * n.r;
      const wf = d[0] - 2 * dot * n.f;
      const wr = d[1] - 2 * dot * n.r;
      return Math.abs(wf) >= Math.abs(wr) ? [Math.sign(wf), 0] : [0, Math.sign(wr)];
    }
    const bend = (o, d) => (o === "/" ? [d[1], d[0]] : [-d[1], -d[0]]);
    // All beams this frame: segments, lit crystals, what's standing in them.
    function trace(me) {
      const segs = [];
      const lit = new Set();
      const burning = new Set();
      let robot = false;
      const feet = ar.feet();
      const robotLow = feet < BEAM_H && feet + K.BODY_H > BEAM_H;
      const mummies = enemies.list.filter((e) => e.kind === "mummy");
      const rays = SOURCES.map((s) => ({ f: s.f, r: s.r, d: s.d, skip: null, fromRobot: false }));
      let budget = 40;
      while (rays.length && budget-- > 0) {
        const ray = rays.shift();
        const [di, dj] = ray.d;
        let f = ray.f;
        let r = ray.r;
        let end = null;
        for (let k = 0; k < 500 && !end; k++) {
          const nf = f + di * STEP;
          const nr = r + dj * STEP;
          if (nf < 0 || nf > LEN || nr < R_MIN || nr > R_MAX) {
            end = { f: clamp(nf, 0, LEN), r: clamp(nr, R_MIN, R_MAX) };
            break;
          }
          const i = cellI(nf);
          const j = cellJ(nr);
          const c = cell(i, j);
          if (c === "#" || ("ABC".includes(c) && doorShut(c))) {
            end = { f, r };
            break;
          }
          const o = objAt[i][j];
          if (o && o !== ray.skip) {
            const perp = di ? Math.abs(nr - o.r) : Math.abs(nf - o.f);
            const along = di ? (o.f - nf) * di : (o.r - nr) * dj;
            if (perp < 0.05 && along <= 0) {
              end = { f: o.f, r: o.r };
              if (o.kind === "mirror") rays.push({ f: o.f, r: o.r, d: bend(o.o, ray.d), skip: o });
              else if (o.kind === "prism") {
                rays.push({ f: o.f, r: o.r, d: ray.d, skip: o });
                rays.push({ f: o.f, r: o.r, d: bend(o.o, ray.d), skip: o });
              } else lit.add(o.id);
              break;
            }
          }
          if (!ray.fromRobot && robotLow && Math.hypot(nf - me.f, nr - me.r) < ROBOT_R) {
            end = { f: nf, r: nr };
            robot = true;
            if (shield) {
              const w = shieldBend(ray.d);
              if (w[0] === di && w[1] === dj) rays.push({ f: nf, r: nr, d: ray.d, skip: null, fromRobot: true }); // grazing: on it goes
              else rays.push({ f: me.f, r: me.r, d: w, skip: null, fromRobot: true });
            }
            break;
          }
          const m = mummies.find((e) => Math.hypot(nf - e.f, nr - e.r) < MUMMY_R);
          if (m) {
            end = { f: nf, r: nr };
            burning.add(m);
            break;
          }
          f = nf;
          r = nr;
        }
        segs.push({ a: { f: ray.f, r: ray.r }, b: end || { f, r } });
      }
      return { segs, lit, burning, robot };
    }

    // -- every frame ---------------------------------------------------------------------------
    function physics() {
      ar.setGround(0);
    }
    function wake(zone) {
      if (woken.has(zone)) return;
      woken.add(zone);
      if (zone === "entry") [cellCenter(4, 9), cellCenter(5, 7), cellCenter(1, 9)].slice(0, N.scarabs).forEach((p) => enemies.add("scarab", p, 0));
      if (zone === "court") [cellCenter(12, 8), cellCenter(7, 1), cellCenter(12, 4)].slice(0, N.mummies).forEach((p) => enemies.add("mummy", p, 0));
      if (zone === "shrine") [cellCenter(16, 7), cellCenter(15, 2)].slice(0, N.wisps).forEach((p) => enemies.add("wisp", p, 0.12));
      if (zone === "escape") [cellCenter(11, 7), cellCenter(8, 3), cellCenter(4, 8)].slice(0, N.bats).forEach((p) => enemies.add("bat", p, 0.25));
      if (enemies.list.length) Lynx.sfx.play("growl");
    }
    function turn(m) {
      m.o = m.o === "/" ? "\\" : "/";
      m.cool = TURN_COOL_S;
      m.spin += 90;
    }

    function update(dt, me) {
      time += dt;
      const feet = ar.feet();
      mirrors.forEach((m) => {
        m.cool = Math.max(0, m.cool - dt);
        m.hit = Math.max(0, m.hit - dt);
        // a quarter turn, drawn over TURN_S
        const a = Math.min(m.spin, (90 / TURN_S) * dt);
        m.angle += a;
        m.spin -= a;
      });

      // the light
      const res = trace(me);
      beams = res.segs;
      crystals.forEach((c) => {
        const was = c.lit;
        c.lit = res.lit.has(c.id);
        if (c.lit && !was) Lynx.sfx.play(c.latch && !c.latched ? "power" : "coin");
        if (c.lit && c.latch && !c.latched) {
          c.latched = true;
          api.say(c.id === "A" ? "The gold crystal blazes -- the door grinds open!" : "A gold crystal blazes!", "#ffd84a");
        }
      });
      robotInBeam = res.robot;
      if (res.robot && !shield) {
        burnT += dt;
        if (burnT >= BURN_S) {
          burnT = 0;
          api.hurt(disc ? "Burned! Jump the beams" : "Burned by the sunbeam -- jump over it");
        }
      } else burnT = 0;
      enemies.list.forEach((e) => {
        if (!res.burning.has(e)) {
          e.burnT = 0;
          return;
        }
        e.burnT = (e.burnT || 0) + dt;
        if (e.burnT >= ENEMY_BURN_S) {
          e.burnT = 0;
          enemies.hit({ obj: e });
        }
      });

      // doors (never shut on the robot)
      const inDoor = (q) => inRect(me.f, me.r, K.grow(q, K.CLEAR));
      const want = {
        A: crystal("A").latched || disc,
        B: (crystal("B1").lit && crystal("B2").lit) || disc,
        C: (crystal("C1").latched && crystal("C2").latched) || disc,
      };
      Object.keys(doors).forEach((k) => {
        const q = doors[k];
        const was = q.open >= 1;
        if (want[k] || (q.open > 0 && inDoor(q))) q.open = Math.min(1, q.open + dt * 1.5);
        else q.open = Math.max(0, q.open - dt * 1.5);
        if (q.open >= 1 && !was && k !== "A") Lynx.sfx.play("gate");
      });

      // the escape: the mirrors spin
      if (disc) {
        spinT -= dt;
        if (spinT <= 0) {
          spinT = SPIN_S[diff] * (0.7 + 0.6 * Math.random());
          const pick = mirrors.filter((m) => m.cool === 0);
          if (pick.length) {
            turn(pick[Math.floor(Math.random() * pick.length)]);
            Lynx.sfx.play("knock");
          }
        }
      }

      const hall = hallOf(me.f);
      visited.add(hall);
      if (hall === 0 && me.f > 0.3) wake("entry");
      if (hall === 1) wake("court");
      if (hall === 2) wake("shrine");
      enemies.update(dt, me, K.camLocal(api));
      K.pickUp(api, items, me, feet, (it) => {
        if (it.kind === "shield") {
          shield = true;
          Lynx.sfx.play("power");
          api.addScore(500);
          api.say("The Sun Shield! Beams no longer burn -- they bounce off you, the way you face", "#ffd84a");
          return true;
        }
        if (it.kind === "disc") {
          disc = true;
          shield = false;
          spinT = 1;
          api.addScore(3000);
          Lynx.sfx.play("growl");
          api.say("The Sun Disc! The shield cracks -- and the mirrors start to spin. Get out!", "#ffd84a");
          wake("escape");
          return true;
        }
        return false;
      });
      if (disc && me.f < 0.25) api.complete();
    }

    // -- shooting ------------------------------------------------------------------------------
    function targets() {
      const out = enemies.targets();
      mirrors.forEach((m) => m.rect && out.push({ obj: m, kind: "mirror" }));
      return out;
    }
    function hit(t) {
      if (t.kind === "mirror") {
        const m = t.obj;
        m.hit = 0.15;
        if (m.cool > 0) return;
        turn(m);
        Lynx.sfx.play("zap");
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
    function queueBeams() {
      const flick = 0.85 + 0.15 * Math.sin(time * 20);
      beams.forEach((s) => {
        const len = Math.hypot(s.b.f - s.a.f, s.b.r - s.a.r);
        const n = Math.max(1, Math.ceil(len / CELL));
        for (let k = 0; k < n; k++) {
          const f0 = s.a.f + ((s.b.f - s.a.f) * k) / n;
          const r0 = s.a.r + ((s.b.r - s.a.r) * k) / n;
          const f1 = s.a.f + ((s.b.f - s.a.f) * (k + 1)) / n;
          const r1 = s.a.r + ((s.b.r - s.a.r) * (k + 1)) / n;
          const w = api.toWorld((f0 + f1) / 2, (r0 + r1) / 2);
          const depth = api.camZ(w.x, w.y, BEAM_H);
          if (depth < -0.2) continue;
          ar.queue(depth, () => {
            api.line3([[f0, r0, BEAM_H], [f1, r1, BEAM_H]], `rgba(255,200,80,${(0.35 * flick).toFixed(2)})`, 9, 0.05);
            api.line3([[f0, r0, BEAM_H], [f1, r1, BEAM_H]], "rgba(255,250,210,0.95)", 2.5, 0.05);
          }, api.extent(Math.min(f0, f1), Math.max(f0, f1), Math.min(r0, r1), Math.max(r0, r1), BEAM_H - 0.01, BEAM_H + 0.01));
        }
        // a glint where it stops
        const w = api.toWorld(s.b.f, s.b.r);
        if (api.camZ(w.x, w.y, BEAM_H) >= 0.06) {
          const p = ar.project(w.x, w.y, BEAM_H);
          if (p) ar.queue(p.depth - 0.01, () => ar.glow(p.x, p.y, 0.035 * p.ppm * flick, [[0, "rgba(255,255,230,0.9)"], [1, "rgba(255,200,80,0)"]]), api.pointAt(w.x, w.y, BEAM_H, BEAM_H));
        }
      });
      // the sun windows
      SOURCES.forEach((s) => {
        const w = api.toWorld(s.f, s.r);
        if (api.camZ(w.x, w.y, 0.1) < 0.06) return;
        const p = ar.project(w.x, w.y, 0.08);
        if (p) ar.queue(p.depth, () => ar.glow(p.x, p.y, 0.12 * p.ppm, [[0, "rgba(255,250,220,0.95)"], [0.5, "rgba(255,210,100,0.5)"], [1, "rgba(255,180,60,0)"]]), api.pointAt(w.x, w.y, 0, 0.16));
      });
    }
    // A mirror: a plinth and a pane across the cell on its diagonal (a
    // prism: in a glass block). Sets m.rect for shooting.
    function queueMirror(m, c) {
      api.box(plinthRect(m), 0, 0.03, PLINTH);
      if (m.kind === "prism") api.box(K.grow(plinthRect(m), -0.01), 0.03, 0.13, GLASS);
      const a = (m.angle * Math.PI) / 180;
      const u = { f: Math.cos(a) * 0.055, r: Math.sin(a) * 0.055 };
      const corners = [[m.f - u.f, m.r - u.r, 0.03], [m.f + u.f, m.r + u.r, 0.03], [m.f + u.f, m.r + u.r, 0.13], [m.f - u.f, m.r - u.r, 0.13]];
      const w = api.toWorld(m.f, m.r);
      const depth = api.camZ(w.x, w.y, 0.08);
      m.rect = null;
      if (depth < 0.06) return;
      const pts = corners.map(([f, r, h]) => {
        const p = api.toWorld(f, r);
        return api.camZ(p.x, p.y, h) >= 0.05 ? ar.project(p.x, p.y, h) : null;
      });
      if (pts.some((p) => !p)) return;
      if (lineOfSight({ f: m.f, r: m.r, h: 0.1 }, c)) {
        const xs = pts.map((p) => p.x);
        const ys = pts.map((p) => p.y);
        const pad = 4;
        m.rect = { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + 2 * pad, h: Math.max(...ys) - Math.min(...ys) + 2 * pad, depth, cx: (Math.min(...xs) + Math.max(...xs)) / 2 };
      }
      ar.queue(depth - 0.005, () => {
        api.fillPoly(pts, m.hit > 0 ? "#ffffff" : m.kind === "prism" ? "rgba(210,240,255,0.55)" : "rgba(200,225,245,0.9)", "#5a6878", 2);
        api.line3([[m.f - u.f * 0.8, m.r - u.r * 0.8, 0.11], [m.f + u.f * 0.3, m.r + u.r * 0.3, 0.06]], "rgba(255,255,255,0.8)", 1.5, 0.05);
      }, api.extent(m.f - 0.055, m.f + 0.055, m.r - 0.055, m.r + 0.055, 0.03, 0.13));
    }
    function queueCrystal(cr) {
      api.box(plinthRect(cr), 0, 0.03, PLINTH);
      const w = api.toWorld(cr.f, cr.r);
      const on = cr.lit || cr.latched;
      const spr = cr.latch ? (on ? img.goldLit : img.gold) : on ? img.blueLit : img.blue;
      api.drawSprite(cr, spr, w.x, w.y, 0.03, 0.08, {
        before: (rc) => on && ar.glow(rc.cx, rc.y + rc.h / 2, rc.w * 2.2, [[0, cr.latch ? "rgba(255,230,120,0.8)" : "rgba(140,220,255,0.8)"], [1, "rgba(255,255,255,0)"]]),
      });
    }

    function draw() {
      const c = K.camLocal(api);
      K.mergeCells((i, j) => cell(i, j) !== "#").forEach((q) => fillRect(q, 0.001, "rgba(40,32,20,0.3)", "rgba(110,90,60,0.3)"));
      wallsDrawn.forEach((q) => api.box(q, 0, 0.3, WALL));
      rimWalls.forEach((q) => api.fence(q, 0, 0.3));
      outer.forEach((q) => api.fence(q, 0, 0.3));
      ["A", "B"].forEach((k) => doors[k].open < 1 && api.box(doors[k], 0, 0.3 * (1 - doors[k].open), DOOR));
      K.queueBars(api, doors.C, 0, 0.3, doors.C.open);
      mirrors.forEach((m) => queueMirror(m, c));
      crystals.forEach(queueCrystal);
      queueBeams();
      K.drawItems(api, items, c, lineOfSight, img);
      enemies.queue(c);
      ar.flush();
    }

    function hud() {
      const map = K.minimap(api, (i, j) => {
        const ch = cell(i, j);
        if (ch === "#") return "#5a4c36";
        if ("ABC".includes(ch)) return doorShut(ch) ? "#8a6a20" : "#9a9280";
        const o = objAt[i][j];
        if (o && o.kind) return o.kind === "prism" ? "#a0d8f0" : "#c8d0d8";
        if (o) return o.lit || o.latched ? (o.latch ? "#ffe060" : "#70d0ff") : o.latch ? "#806020" : "#204870";
        return "#9a9280";
      }, HALL[hallOf(api.toLocal(ar.pose.x, ar.pose.y).f)].toUpperCase());
      if (!map) return;
      const g = ar.ctx;
      g.save();
      g.strokeStyle = "rgba(255,230,120,0.95)";
      g.lineWidth = 1.5;
      beams.forEach((s) => {
        const a = map.at(s.a.f, s.a.r);
        const b = map.at(s.b.f, s.b.r);
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.stroke();
      });
      // the mirrors' panes
      g.strokeStyle = "#20303a";
      g.lineWidth = 2;
      mirrors.forEach((m) => {
        const p = map.at(m.f, m.r);
        const k = map.s * 0.45;
        const sg = m.o === "/" ? 1 : -1;
        g.beginPath();
        g.moveTo(p.x - k, p.y + sg * k);
        g.lineTo(p.x + k, p.y - sg * k);
        g.stroke();
      });
      g.restore();
    }

    function objective() {
      const me = api.toLocal(ar.pose.x, ar.pose.y);
      const hall = hallOf(me.f);
      const go = (text, p, h = 0.1) => ({ text, at: { f: p.f, r: p.r }, h });
      const center = (q) => ({ f: (q.f0 + q.f1) / 2, r: (q.r0 + q.r1) / 2 });
      if (disc) return go("The mirrors spin on their own! Out through all three halls -- jump the beams", { f: 0.1, r: 0 });
      if (hall === 0) {
        if (!crystal("A").latched) return go("Shoot a mirror to turn it: bend the sunbeam onto the gold crystal. Beams burn -- jump them", crystal("A"), 0.06);
        return go("Through the door -- jump the beam in the doorway", center(doors.A), 0.1);
      }
      if (hall === 1) {
        if (doorShut("B")) {
          const dark = ["B1", "B2"].map(crystal).find((cr) => !cr.lit);
          return go("Both blue crystals must shine at once to open the north door (the robot's shadow counts!)", dark || center(doors.B), 0.06);
        }
        return go("Through the north door -- jump the beam", center(doors.B), 0.1);
      }
      if (!shield && !crystal("C1").latched) return go("Take the Sun Shield in the north-east (jump the skylight's beam)", items.find((it) => it.kind === "shield") || { f: 2.7, r: 0.7 }, 0.05);
      if (!crystal("C2").latched) return go("Shielded, you're a mirror: stand in the court's beam and face diagonally across it -- light the east crystal", crystal("C2"), 0.06);
      if (!crystal("C1").latched) return go("Now the skylight: bend its beam west, onto the mirror by the alcove, and down onto the gold crystal", crystal("C1"), 0.06);
      return go("The bars are up: take the Sun Disc", items.find((it) => it.kind === "disc") || center(doors.C), 0.05);
    }

    return {
      physics,
      update,
      draw,
      hud,
      objective,
      blips: () => enemies.blips().concat(items.map((it) => ({ ...api.toWorld(it.f, it.r), color: it.kind === "disc" || it.kind === "shield" ? "#ffe060" : "#ffd84a", r: 2.5 }))),
      targets,
      hit,
      carryOn: () => {
        enemies.carryOn();
        burnT = 0;
      },
      filterDrive: stopper.filterDrive,
      floorName: () => HALL[hallOf(api.toLocal(ar.pose.x, ar.pose.y).f)],
      debug: {
        mirrors, crystals, doors,
        turn: (id) => turn(mirrors.find((m) => m.id === id)),
        clear: () => enemies.list.splice(0),
        beams: () => beams,
        shield: (on) => (shield = on),
        spin: (on) => (spinT = on ? 0 : 1e9),
      },
      snapshot: () => ({
        hall: HALL[hallOf(api.toLocal(ar.pose.x, ar.pose.y).f)],
        mirrors: mirrors.map((m) => m.id + m.o).join(" "),
        lit: crystals.filter((cr) => cr.lit).map((cr) => cr.id).join(","),
        latched: crystals.filter((cr) => cr.latched).map((cr) => cr.id).join(","),
        doors: Object.fromEntries(Object.keys(doors).map((k) => [k, +doors[k].open.toFixed(2)])),
        shield, disc, inBeam: robotInBeam, beams: beams.length,
        enemies: enemies.list.map((e) => e.kind), items: items.map((it) => it.kind),
      }),
    };
  };
})(window.Lynx);
