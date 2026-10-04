// Poop Shooter -- shoot the poops that crawl toward the robot. Ten levels,
// every one with long stone walls standing on the floor. The walls are solid
// for everything: the poops have to walk around them, they stop your shots,
// and they stop the robot itself (the game filters the drive commands, like
// the Temple's walls do), so you have to find a way to a clear line of fire.
// Levels 5 and 10 end with a giant poop.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const TOUCH_M = 0.2; // a poop this close = it splatted on you
  const INVULNERABLE_S = 1.5;
  const MAX_HEARTS = 9;
  const WALL_R = 0.05; // walls are solid this far to each side of their line
  const WALL_H = 0.22;
  const WALL_PIECE_M = 0.1; // a wall is drawn as a row of stone sprites this far apart
  const CLEAR = 0.22; // the robot's centre keeps this far from a wall's line
  const STOP_LOOKAHEAD_S = 0.3; // where the robot will be when a stop command lands
  const FIRE_COOLDOWN = 0.28;
  const WEAPONS = ["Water gun", "Bow & arrow"];
  const BOW_COOLDOWN = 0.75;
  const BOW_DAMAGE = 3;
  const ARROW_SPEED = 3.5; // m/s
  const ARROW_G = 3; // m/s² -- the arrow falls, so aim above the poop
  const ARROW_LEN = 0.12;

  const DIFFICULTY = {
    easy: { speed: 0.7, hp: 0.7, spawn: 1.4 },
    normal: { speed: 1, hp: 1, spawn: 1 },
    hard: { speed: 1.3, hp: 1.3, spawn: 0.75 },
  };

  // -- sprites --------------------------------------------------------------------
  const POOP = [
    ".....kk.....",
    "....kbbk....",
    "...kbhbbk...",
    "..kbbbbbbk..",
    "..kkkkkkkk..",
    ".kbbhbbbbbk.",
    ".kbwkbbwkbk.",
    "kbbbbbbbbbbk",
    "kbbbkkkkbbbk",
    "kbbbbbbbbbbk",
    "kkkkkkkkkkkk",
  ];
  const POOP_PAL = {
    small: { k: "#3a2210", b: "#a8703a", h: "#d8a468", w: "#ffffff" },
    normal: { k: "#3a2210", b: "#8a5a2b", h: "#b98550", w: "#ffffff" },
    big: { k: "#2a1608", b: "#6b4220", h: "#94653a", w: "#ffffff" },
    golden: { k: "#5a3a00", b: "#f0b820", h: "#fff0a0", w: "#ffffff" },
    boss: { k: "#1a0a20", b: "#7a3a60", h: "#b070a0", w: "#ffffff" },
  };
  const PILLAR = [
    ".kkkkkkkk.",
    "kaaaaaaaak",
    "kabbbbbbck",
    "kabbbbbbck",
    "kkkkkkkkkk",
    "kabbbbbbck",
    "kabbbbbbck",
    "kabbbbbbck",
    "kkkkkkkkkk",
    "kabbbbbbck",
    "kabbbbbbck",
    "kabbbbbbck",
    "kkkkkkkkkk",
    "kaaaaaaaak",
    "kkkkkkkkkk",
  ];
  const STONE = { k: "#2a2a30", a: "#c0c0c8", b: "#8c8c96", c: "#62626c" };
  // side view, barrel pointing left (toward the crosshair)
  const GUN = [
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
  const HEART = [
    ".rr.rr.",
    "rrrrrrr",
    "rrrrrrr",
    ".rrrrr.",
    "..rrr..",
    "...r...",
  ];

  const KIND = {
    small: { heightM: 0.07, hp: 1, speed: 0.13, score: 50 },
    normal: { heightM: 0.1, hp: 2, speed: 0.09, score: 100 },
    big: { heightM: 0.15, hp: 5, speed: 0.06, score: 250 },
    golden: { heightM: 0.08, hp: 2, speed: 0.17, score: 500 },
    boss: { heightM: 0.3, hp: 25, speed: 0.045, score: 1500 },
  };

  // Walls as line segments [x0, y0, x1, y1] in metres around the robot's start
  // spot (made for a play area of radius 2 m; see buildWalls for the scaling).
  // Every gap between walls, and between a wall and the start spot, is wide
  // enough for the robot to drive through.
  const FORT = (h, half) => [[h, -half, h, half], [-h, -half, -h, half], [-half, h, half, h], [-half, -h, half, -h]];
  const PINWHEEL = (h, a, b) => [[h, -a, h, b], [a, h, -b, h], [-h, a, -h, -b], [-a, -h, b, -h]];
  const LAYOUTS = [
    [[1.0, -0.7, 1.0, 0.7]], // 1: one long wall
    [[1.0, -0.8, 1.0, 0.8], [-1.0, -0.8, -1.0, 0.8]], // 2: two walls facing each other
    FORT(1.0, 0.6), // 3: a fort, open at the four corners
    PINWHEEL(1.0, 0.9, 0.4), // 4: a pinwheel
    [[1.0, -1.1, 1.0, 1.1], [-1.0, -1.1, -1.0, 1.1]], // 5 (boss): a corridor
    [[0.5, 0.5, 1.2, 1.2], [-0.5, 0.5, -1.2, 1.2], [0.5, -0.5, 1.2, -1.2], [-0.5, -0.5, -1.2, -1.2]], // 6: an X
    [...FORT(0.7, 0.25), ...FORT(1.3, 0.7)], // 7: two forts, one inside the other
    [[0.5, -0.9, 0.5, 0.9], [-0.5, -0.9, -0.5, 0.9], [1.3, -0.3, 1.3, 1.3], [-1.3, 0.3, -1.3, -1.3]], // 8: a lane to drive in
    [[0.55, -0.5, 0.55, 0.5], [-0.55, -0.5, -0.55, 0.5], ...PINWHEEL(1.3, 1.2, 0.3)], // 9: a pinwheel around a lane
    [...FORT(0.7, 0.25), ...PINWHEEL(1.3, 1.2, 0.3)], // 10 (boss): fort inside a pinwheel
  ];

  // kinds: weights of what spawns.
  const LEVELS = [
    { count: 6, kinds: { normal: 1 }, speed: 1 },
    { count: 8, kinds: { small: 1, normal: 2 }, speed: 1 },
    { count: 10, kinds: { small: 2, normal: 2, big: 1 }, speed: 1.05 },
    { count: 12, kinds: { small: 2, normal: 2, big: 1, golden: 0.4 }, speed: 1.1 },
    { count: 10, kinds: { small: 2, normal: 2, big: 1 }, speed: 1.1, boss: true },
    { count: 12, kinds: { small: 2, normal: 2, big: 1 }, speed: 1.1 },
    { count: 14, kinds: { small: 2, normal: 2, big: 2, golden: 0.4 }, speed: 1.15 },
    { count: 14, kinds: { small: 2, normal: 2, big: 2 }, speed: 1.15 },
    { count: 16, kinds: { small: 2, normal: 2, big: 2, golden: 0.5 }, speed: 1.2 },
    { count: 14, kinds: { small: 2, normal: 2, big: 2 }, speed: 1.2, boss: true },
  ];
  LEVELS.forEach((l, i) => (l.walls = LAYOUTS[i]));
  const rand = (a, b) => a + Math.random() * (b - a);

  function pickKind(weights) {
    const total = Object.values(weights).reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    for (const [k, w] of Object.entries(weights)) {
      r -= w;
      if (r <= 0) return k;
    }
    return "normal";
  }

  Lynx.games.poop = (ar, cfg) => {
    const diff = DIFFICULTY[cfg.difficulty] || DIFFICULTY.normal;
    const areaM = cfg.areaM || 2;
    const aimAssist = cfg.aimAssist !== false;
    const levelSet = LEVELS;
    const startLevelNo = Math.max(1, Math.min(LEVELS.length, Math.round(Number(cfg.startLevel) || 1)));
    const wallScale = Math.max(0.75, Math.min(1.25, areaM / 2));
    const sprites = {
      pillar: Lynx.sprite(PILLAR, STONE),
      heart: Lynx.sprite(HEART, { r: "#ff3050" }),
      gun: Lynx.sprite(GUN, { c: "#40b0ff", h: "rgba(255,255,255,0.55)", k: "#202020" }),
    };
    Object.keys(KIND).forEach((k) => (KIND[k].img = Lynx.sprite(POOP, POOP_PAL[k])));

    let state = "title"; // title | playing | cleared | over | won
    let stateTime = 0;
    let level = 1; // 1-based index into levelSet
    let score = 0;
    let hearts = cfg.hearts || 5;
    let cooldown = 0;
    let weapon = 0; // index into WEAPONS
    let arrows = []; // {x, y, h, vx, vy, vh, stuck (seconds since it stopped, or -1 while flying)}
    let firePressed = false;
    let invulnerable = 0;
    let hurtFlash = 0;
    let message = null;
    let poops = [];
    let pillars = [];
    let spawnQueue = [];
    let loot = [];
    let tracers = [];
    let debris = [];
    let puffs = [];
    let best = null;
    let rankMsg = "";
    Lynx.bestScore("poop").then((b) => (best = b));

    const def = () => levelSet[level - 1];
    const say = (text, sub, color) => (message = { text, sub, color, t: 0 });

    // -- level setup ------------------------------------------------------------------
    // The level's walls, placed around where the robot stands now: `walls` are
    // the solid line segments (world metres), `pillars` the row of stone
    // sprites drawn along each (they also stop shots, via their screen rects).
    let walls = [];
    function buildWalls(layout) {
      walls = layout.map(([x0, y0, x1, y1]) => ({
        x0: ar.pose.x + x0 * wallScale, y0: ar.pose.y + y0 * wallScale,
        x1: ar.pose.x + x1 * wallScale, y1: ar.pose.y + y1 * wallScale,
      }));
      pillars = [];
      walls.forEach((w) => {
        const n = Math.max(1, Math.ceil(Math.hypot(w.x1 - w.x0, w.y1 - w.y0) / WALL_PIECE_M));
        for (let i = 0; i <= n; i++) pillars.push({ x: w.x0 + ((w.x1 - w.x0) * i) / n, y: w.y0 + ((w.y1 - w.y0) * i) / n, rect: null });
      });
    }

    // The point on a wall's line nearest to (x, y), and how far away it is.
    function nearestOnWall(w, x, y) {
      const dx = w.x1 - w.x0;
      const dy = w.y1 - w.y0;
      const t = Math.max(0, Math.min(1, ((x - w.x0) * dx + (y - w.y0) * dy) / (dx * dx + dy * dy || 1)));
      const qx = w.x0 + dx * t;
      const qy = w.y0 + dy * t;
      return { qx, qy, d: Math.hypot(x - qx, y - qy) };
    }

    function startLevel() {
      const d = def();
      buildWalls(d.walls);
      spawnQueue = [];
      for (let i = 0; i < d.count; i++) spawnQueue.push({ type: pickKind(d.kinds), at: 3 + i * rand(2, 3.2) * diff.spawn });
      if (d.boss) spawnQueue.push({ type: "boss", at: 5 + d.count * 2.2 * diff.spawn });
      poops = [];
      loot = [];
      state = "playing";
      stateTime = 0;
      invulnerable = 1;
      say(`LEVEL ${level}`, "Walls! Find a clear line of fire", "#c88a3c");
      Lynx.sfx.play("levelup");
    }

    function newGame() {
      arrows = [];
      level = startLevelNo;
      score = 0;
      hearts = cfg.hearts || 5;
      startLevel();
    }

    function spawnPoop(type) {
      const k = KIND[type];
      let p = null;
      for (let tries = 0; tries < 20 && !p; tries++) {
        const c = Lynx.randomAround(ar.pose.x, ar.pose.y, Math.max(1.4, areaM - 0.2), areaM + 0.6);
        if (walls.every((w) => nearestOnWall(w, c.x, c.y).d > 0.2)) p = c; // not inside a wall
      }
      if (!p) p = Lynx.randomAround(ar.pose.x, ar.pose.y, Math.max(1.4, areaM - 0.2), areaM + 0.6);
      const hp = Math.max(1, Math.round(k.hp * diff.hp * (type === "boss" ? 1 : 1 + 0.1 * (level - 1))));
      poops.push({ type, x: p.x, y: p.y, hp, maxHp: hp, hit: 0, phase: Math.random() * 6, wobble: Math.random() * 6, side: Math.random() < 0.5 ? 1 : -1, alive: true, rect: null });
      if (type === "boss") say("THE GIANT POOP!", "Shoot it a lot!", "#d060ff");
      else if (type === "golden") say("Golden poop!", "Quick, it's worth a lot", "#ffd84a");
      Lynx.sfx.play(type === "boss" ? "growl" : "boing");
    }

    // -- shooting ------------------------------------------------------------------------
    function targetAt(px, py) {
      const v = ar.view;
      const assistPx = aimAssist ? 0.04 * v.w : 0;
      let found = null;
      let bestMiss = Infinity;
      poops.forEach((m) => {
        const rect = m.rect;
        if (!m.alive || !rect) return;
        const miss = Math.hypot(Math.max(rect.x - px, 0, px - (rect.x + rect.w)), Math.max(rect.y - py, 0, py - (rect.y + rect.h)));
        if (miss > assistPx) return;
        if (!found || miss < bestMiss - 0.5 || (Math.abs(miss - bestMiss) <= 0.5 && rect.depth < found.rect.depth)) {
          found = { obj: m, rect };
          bestMiss = miss;
        }
      });
      return found;
    }

    // The nearest pillar that covers screen point (x, y) and is in front of `depth`.
    function pillarCovering(x, y, depth) {
      let hit = null;
      pillars.forEach((p) => {
        const r = p.rect;
        if (!r || r.depth >= depth) return;
        if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) return;
        if (!hit || r.depth < hit.rect.depth) hit = p;
      });
      return hit;
    }

    // The arrow leaves the camera along the aim vector and then flies a
    // parabola: gravity pulls it down (see stepArrows).
    function fireArrow() {
      const c = ar.cameraWorld();
      const a = ar.aimVector();
      arrows.push({ x: c.x + a.x * 0.05, y: c.y + a.y * 0.05, h: c.h - 0.03 + a.h * 0.05, vx: a.x * ARROW_SPEED, vy: a.y * ARROW_SPEED, vh: a.h * ARROW_SPEED, stuck: -1 });
      Lynx.sfx.play("laser");
    }

    function stepArrows(dt) {
      arrows.forEach((r) => {
        if (r.stuck >= 0) {
          r.stuck += dt;
          return;
        }
        // small sub-steps so a fast arrow can't skip over a poop or a wall
        const steps = Math.max(1, Math.ceil((ARROW_SPEED * dt) / 0.03));
        const h = dt / steps;
        for (let i = 0; i < steps && r.stuck < 0; i++) {
          r.vh -= ARROW_G * h;
          r.x += r.vx * h;
          r.y += r.vy * h;
          r.h += r.vh * h;
          if (r.h <= 0) {
            r.h = 0;
            r.stuck = 0;
            break;
          }
          if (r.h < WALL_H && walls.some((w) => nearestOnWall(w, r.x, r.y).d < WALL_R + 0.02)) {
            r.stuck = 0;
            Lynx.sfx.play("knock");
            break;
          }
          const m = poops.find((q) => {
            if (!q.alive) return false;
            const k = KIND[q.type];
            return Math.hypot(q.x - r.x, q.y - r.y) < k.heightM * 0.45 + 0.02 && r.h > -0.01 && r.h < k.heightM + 0.02;
          });
          if (m) {
            r.stuck = 1e9; // gone
            hitPoopBy(m, BOW_DAMAGE);
          }
        }
        if (Math.hypot(r.x - ar.pose.x, r.y - ar.pose.y) > areaM + 3) r.stuck = 1e9;
      });
      arrows = arrows.filter((r) => r.stuck < 1.5);
    }

    function tryFire() {
      if (cooldown > 0) return;
      if (weapon === 1) {
        cooldown = BOW_COOLDOWN;
        fireArrow();
        return;
      }
      cooldown = FIRE_COOLDOWN;
      Lynx.sfx.play("squirt");
      const v = ar.view;
      const px = v.cx;
      const py = v.cy;
      const t = targetAt(px, py);
      let endX = px;
      let endY = py;
      let hitPoop = null;
      if (t) {
        endX = t.rect.x + t.rect.w / 2;
        endY = t.rect.y + t.rect.h / 2;
        // A pillar in front of the poop (covering where the shot would land) takes the hit.
        const blocker = pillarCovering(endX, endY, t.rect.depth) || pillarCovering(px, py, t.rect.depth);
        if (blocker) {
          endX = blocker.rect.x + blocker.rect.w / 2;
          endY = py;
          Lynx.sfx.play("knock");
        } else hitPoop = t.obj;
      } else {
        const blocker = pillarCovering(px, py, Infinity);
        if (blocker) Lynx.sfx.play("knock");
      }
      tracers.push({ x0: v.cx + 0.1 * v.w, y0: v.y + v.h, x1: endX, y1: endY, t: 0 });
      if (hitPoop) hitPoopBy(hitPoop, 1);
    }

    function hitPoopBy(m, dmg) {
      m.hp -= dmg;
      m.hit = 0.15;
      if (m.hp > 0) {
        Lynx.sfx.play("pain");
        return;
      }
      m.alive = false;
      const k = KIND[m.type];
      score += k.score;
      Lynx.sfx.play("die");
      puffs.push({ x: m.x, y: m.y, h: k.heightM / 2, t: 0, big: m.type === "boss" });
      const c = POOP_PAL[m.type];
      if (m.rect) {
        for (let i = 0; i < (m.type === "boss" ? 30 : 12); i++) {
          debris.push({ x: m.rect.cx, y: m.rect.y + m.rect.h / 2, vx: rand(-220, 220), vy: rand(-320, -60), t: 0, size: rand(3, 7), color: [c.b, c.h, c.k][i % 3] });
        }
      }
      if (m.type === "boss") {
        loot.push({ kind: "heart", x: m.x, y: m.y, h: 0.05, t: 0 });
        say("GIANT POOP SPLATTED!", "+1500", "#d060ff");
      } else if (m.type === "golden" || (hearts < (cfg.hearts || 5) && Math.random() < 0.2)) {
        loot.push({ kind: "heart", x: m.x, y: m.y, h: 0.05, t: 0 });
      }
    }

    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title" || ((state === "over" || state === "won") && stateTime > 1.5)) {
        newGame();
        return;
      }
      firePressed = true;
    });
    Lynx.onAction("weapon", (which) => {
      if (which === "next" || which === "prev") weapon = (weapon + 1) % WEAPONS.length;
      else if (which >= 1 && which <= WEAPONS.length) weapon = which - 1;
      cooldown = Math.min(cooldown, 0.2);
    });
    Lynx.touchButtons().add("\u{1F3F9} Switch", () => (weapon = (weapon + 1) % WEAPONS.length));
    // Optional virtual jumping (off by default): hop over small poops.
    if (cfg.jump) {
      Lynx.onAction("jump", () => state === "playing" && (ar.jump(), true));
      Lynx.touchButtons().add("⤒ Jump", () => Lynx.jumpAction());
    }

    // -- walls stop the robot ---------------------------------------------------------------
    // Every drive command goes through this: the part of it pointing into a
    // wall that is within CLEAR of where the robot will be is taken out, so it
    // slides along walls and stops at them. (Same idea as the Temple's walls.)
    const vel = { x: 0, y: 0, last: null }; // the shown pose's velocity (world m/s, smoothed)
    function trackVelocity(dt) {
      const p = ar.pose;
      if (vel.last && dt > 0) {
        const k = 1 - Math.exp(-dt / 0.15);
        vel.x += ((p.x - vel.last.x) / dt - vel.x) * k;
        vel.y += ((p.y - vel.last.y) / dt - vel.y) * k;
      }
      vel.last = { x: p.x, y: p.y };
    }

    function filterDrive(j1, j2) {
      if (!walls.length) return { j1, j2 };
      const t = ar.camTheta;
      let vx = j2 * Math.cos(t) + j1 * Math.sin(t);
      let vy = j2 * Math.sin(t) - j1 * Math.cos(t);
      const px = ar.pose.x + vel.x * STOP_LOOKAHEAD_S; // where a stop will take effect
      const py = ar.pose.y + vel.y * STOP_LOOKAHEAD_S;
      const cs = [];
      walls.forEach((w) => {
        const n = nearestOnWall(w, px, py);
        if (n.d >= CLEAR) return;
        if (n.d > 1e-6) cs.push({ x: (px - n.qx) / n.d, y: (py - n.qy) / n.d });
        else { // right on the line: out through either side
          const dx = w.x1 - w.x0;
          const dy = w.y1 - w.y0;
          const l = Math.hypot(dx, dy) || 1;
          cs.push({ x: -dy / l, y: dx / l });
        }
      });
      for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        cs.forEach((c) => {
          const dot = vx * c.x + vy * c.y;
          if (dot < -1e-6) {
            vx -= dot * c.x;
            vy -= dot * c.y;
            changed = true;
          }
        });
        if (!changed) break;
      }
      if (cs.some((c) => vx * c.x + vy * c.y < -1e-3)) vx = vy = 0; // wedged in a corner
      return { j1: vx * Math.sin(t) - vy * Math.cos(t), j2: vx * Math.cos(t) + vy * Math.sin(t) };
    }
    if (Lynx.control && Lynx.control.setDriveFilter) {
      Lynx.control.setDriveFilter(filterDrive);
      ar.onDestroy(() => Lynx.control.setDriveFilter(null));
    }

    // -- update ----------------------------------------------------------------------------
    function endGame() {
      state = "over";
      stateTime = 0;
      rankMsg = "";
      Lynx.sfx.play("lose");
      Lynx.submitScore("poop", score).then((rank) => {
        rankMsg = rank ? `#${rank} on this robot's scoreboard!` : "";
        if (rank === 1) best = score;
      });
    }

    function movePoop(m, dt) {
      const k = KIND[m.type];
      m.phase += dt * 6;
      m.wobble += dt;
      m.hit = Math.max(0, m.hit - dt);
      const dx = ar.pose.x - m.x;
      const dy = ar.pose.y - m.y;
      const d = Math.hypot(dx, dy) || 1;
      let ux = dx / d;
      let uy = dy / d;
      // Walk around walls: when one is close and ahead, slide along it (always
      // the same way for this poop) -- until its end, where it can turn in.
      walls.forEach((w) => {
        const n = nearestOnWall(w, m.x, m.y);
        const clear = n.d - WALL_R;
        if (clear >= 0.3 || n.d < 1e-6) return;
        const nx = (n.qx - m.x) / n.d; // towards the wall
        const ny = (n.qy - m.y) / n.d;
        if (ux * nx + uy * ny <= 0) return; // heading away from it
        const k2 = 1 - Math.max(0, clear - 0.04) / 0.26;
        ux += m.side * -ny * 2.5 * k2;
        uy += m.side * nx * 2.5 * k2;
      });
      const un = Math.hypot(ux, uy) || 1;
      const side = Math.sin(m.wobble) * 0.25;
      const speed = k.speed * diff.speed * def().speed * (m.hit > 0 ? 0.3 : 1);
      m.x += ((ux - uy * side) / un) * speed * dt;
      m.y += ((uy + ux * side) / un) * speed * dt;
      walls.forEach((w) => {
        const n = nearestOnWall(w, m.x, m.y);
        const min = WALL_R + 0.04;
        if (n.d < min) {
          const nd = n.d || 1e-6;
          m.x = n.qx + ((m.x - n.qx) / nd) * min;
          m.y = n.qy + ((m.y - n.qy) / nd) * min;
        }
      });
      return d;
    }

    function update(dt) {
      trackVelocity(dt);
      stateTime += dt;
      cooldown = Math.max(0, cooldown - dt);
      hurtFlash = Math.max(0, hurtFlash - dt);
      if (message) message.t += dt;
      tracers.forEach((t) => (t.t += dt));
      tracers = tracers.filter((t) => t.t < 0.12);
      stepArrows(dt);
      debris.forEach((d) => {
        d.t += dt;
        d.x += d.vx * dt;
        d.y += d.vy * dt;
        d.vy += 900 * dt;
      });
      debris = debris.filter((d) => d.t < 0.8);
      puffs.forEach((p) => (p.t += dt));
      puffs = puffs.filter((p) => p.t < 0.5);

      if (state === "cleared" && stateTime > 3) {
        if (level >= levelSet.length) {
          state = "won";
          stateTime = 0;
          score += 1000;
          Lynx.sfx.play("found");
          Lynx.submitScore("poop", score).then((rank) => (rankMsg = rank ? `#${rank} on this robot's scoreboard!` : ""));
        } else {
          level++;
          startLevel();
        }
        return;
      }
      if (state !== "playing") return;

      invulnerable = Math.max(0, invulnerable - dt);
      if (firePressed || Lynx.input.fireHeld) tryFire();
      firePressed = false;

      spawnQueue = spawnQueue.filter((s) => {
        if (stateTime < s.at) return true;
        if (poops.filter((m) => m.alive).length >= 3 + Math.floor(level / 2)) return true; // wait for room
        spawnPoop(s.type);
        return false;
      });

      poops.forEach((m) => {
        if (!m.alive) return;
        const k = KIND[m.type];
        const d = movePoop(m, dt);
        const jumpedOver = ar.feet() > k.heightM * 0.7;
        if (d < TOUCH_M + (m.type === "boss" ? 0.1 : 0) && invulnerable === 0 && !jumpedOver) {
          hearts--;
          invulnerable = INVULNERABLE_S;
          hurtFlash = 0.5;
          Lynx.sfx.play("hurt");
          m.x -= ((ar.pose.x - m.x) / d) * 0.6; // knocked back
          m.y -= ((ar.pose.y - m.y) / d) * 0.6;
          if (hearts <= 0) endGame();
        }
      });
      poops = poops.filter((m) => m.alive);

      // Hearts pop up, then fly to you.
      const cam = ar.cameraWorld();
      loot = loot.filter((l) => {
        l.t += dt;
        if (l.t < 0.8) {
          l.h = 0.03 + Math.sin((l.t / 0.8) * Math.PI) * 0.12 + l.t * 0.05;
          return true;
        }
        const k = Math.min(1, (l.t - 0.8) / 0.5);
        l.x += (cam.x - l.x) * k * 0.25;
        l.y += (cam.y - l.y) * k * 0.25;
        l.h += (cam.h - l.h) * k * 0.25;
        if (l.t > 1.3) {
          hearts = Math.min(MAX_HEARTS, hearts + 1);
          Lynx.sfx.play("pickup");
          return false;
        }
        return true;
      });

      if (state === "playing" && spawnQueue.length === 0 && poops.length === 0 && loot.length === 0) {
        state = "cleared";
        stateTime = 0;
        score += 300 * level;
        say(`LEVEL ${level} DONE!`, `+${300 * level} points`, "#40ff80");
        Lynx.sfx.play("found");
      }
    }

    // -- drawing ---------------------------------------------------------------------------
    function drawPillar(p) {
      const rect = ar.spriteRect(sprites.pillar, p.x, p.y, 0, WALL_H);
      p.rect = rect;
      if (!rect) return;
      ar.queue(rect.depth, () => {
        ar.floorCircle(p.x, p.y, WALL_R * 1.1, "rgba(0,0,0,0.3)");
        ar.drawSprite(sprites.pillar, rect);
      });
    }

    function drawPoop(m) {
      const k = KIND[m.type];
      const bob = Math.abs(Math.sin(m.phase * 0.5)) * 0.01;
      const rect = ar.spriteRect(k.img, m.x, m.y, bob, k.heightM);
      m.rect = rect;
      if (!rect) return;
      ar.queue(rect.depth, () => {
        ar.floorCircle(m.x, m.y, k.heightM * 0.4, "rgba(0,0,0,0.3)");
        if (m.type === "golden") ar.glow(rect.cx, rect.y + rect.h / 2, rect.w * 1.1, [[0, "rgba(255,230,120,0.6)"], [1, "rgba(255,200,0,0)"]]);
        ar.drawSprite(k.img, rect, { flip: Math.sin(m.wobble) < 0, tint: m.hit > 0 ? "rgba(255,255,255,0.7)" : null });
        if (m.maxHp > 3) {
          ar.ctx.fillStyle = "rgba(0,0,0,0.6)";
          ar.ctx.fillRect(rect.x, rect.y - 7, rect.w, 4);
          ar.ctx.fillStyle = m.type === "boss" ? "#d060ff" : "#ff4040";
          ar.ctx.fillRect(rect.x, rect.y - 7, (rect.w * m.hp) / m.maxHp, 4);
        }
      });
    }

    function drawLoot(l) {
      const p = ar.project(l.x, l.y, l.h);
      if (!p) return;
      const spin = Math.abs(Math.cos(l.t * 6));
      ar.queue(p.depth, () => {
        const s = Math.max(10, 0.1 * p.ppm);
        const img = sprites.heart;
        const h = (s * img.height) / img.width;
        ar.glow(p.x, p.y, s, [[0, "rgba(255,255,255,0.8)"], [1, "rgba(255,255,255,0)"]]);
        ar.drawSprite(img, { x: p.x - (s * spin) / 2, y: p.y - h / 2, w: Math.max(1, s * spin), h });
      });
    }

    // Arrows in flight (a shaft with a head and fletching, drawn in depth order
    // with the sprites) and stuck in the floor or a wall.
    function drawArrow(r) {
      const sp = Math.hypot(r.vx, r.vy, r.vh) || 1;
      // (a stuck arrow keeps pointing the way it was flying)
      const tail = { x: r.x - (r.vx / sp) * ARROW_LEN, y: r.y - (r.vy / sp) * ARROW_LEN, h: r.h - (r.vh / sp) * ARROW_LEN };
      const a = ar.project(r.x, r.y, r.h);
      const b = ar.project(tail.x, tail.y, tail.h);
      if (!a || !b) return;
      ar.queue(a.depth, () => {
        const c = ar.ctx;
        c.save();
        c.globalAlpha = r.stuck >= 0 ? Math.max(0, 1 - r.stuck / 1.5) : 1;
        c.lineCap = "round";
        c.strokeStyle = "#e8d8a8";
        c.lineWidth = Math.max(1.5, 0.006 * a.ppm);
        c.beginPath();
        c.moveTo(a.x, a.y);
        c.lineTo(b.x, b.y);
        c.stroke();
        c.strokeStyle = "#e84040"; // fletching
        c.lineWidth = Math.max(2, 0.012 * a.ppm);
        c.beginPath();
        c.moveTo(b.x, b.y);
        c.lineTo(b.x + (a.x - b.x) * 0.2, b.y + (a.y - b.y) * 0.2);
        c.stroke();
        c.fillStyle = "#c0c0c8"; // head
        c.beginPath();
        c.arc(a.x, a.y, Math.max(1.5, 0.007 * a.ppm), 0, 2 * Math.PI);
        c.fill();
        c.restore();
      });
    }

    function drawBow() {
      const v = ar.view;
      const c = ar.ctx;
      const s = Math.min(v.w * 0.12, 110);
      const bx = v.cx + v.w * 0.14;
      const by = v.y + v.h - s * 0.9;
      const pull = cooldown > 0 ? 0 : 1; // string is slack while "reloading"
      c.save();
      c.lineCap = "round";
      c.strokeStyle = "#6a4020";
      c.lineWidth = 6;
      c.beginPath();
      c.moveTo(bx, by - s);
      c.quadraticCurveTo(bx - s * 0.7, by, bx, by + s);
      c.stroke();
      c.strokeStyle = "#f0e8d0";
      c.lineWidth = 2;
      c.beginPath();
      c.moveTo(bx, by - s);
      c.lineTo(bx + s * 0.15 * pull, by);
      c.lineTo(bx, by + s);
      c.stroke();
      if (pull) { // an arrow nocked, pointing at the crosshair
        c.strokeStyle = "#e8d8a8";
        c.lineWidth = 3;
        c.beginPath();
        c.moveTo(bx + s * 0.15, by);
        c.lineTo(bx - s * 0.9, by - s * 0.25);
        c.stroke();
      }
      c.restore();
    }

    function drawGun() {
      if (weapon === 1) return drawBow();
      const v = ar.view;
      const img = sprites.gun;
      const gw = Math.min(v.w * 0.22, 180);
      const gh = (gw * img.height) / img.width;
      const kick = cooldown > 0 ? (cooldown / FIRE_COOLDOWN) * gh * 0.25 : 0;
      ar.drawSprite(img, { x: v.cx + v.w * 0.05, y: v.y + v.h - gh * 0.95 + kick, w: gw, h: gh });
    }

    function drawTracers() {
      const ctx = ar.ctx;
      tracers.forEach((t) => {
        ctx.save();
        ctx.globalAlpha = 1 - t.t / 0.12;
        ctx.lineCap = "round";
        ctx.strokeStyle = "#40b0ff";
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(t.x0, t.y0);
        ctx.lineTo(t.x1, t.y1);
        ctx.stroke();
        ctx.restore();
      });
      debris.forEach((d) => {
        ar.ctx.fillStyle = d.color;
        ar.ctx.fillRect(d.x, d.y, d.size, d.size);
      });
    }

    function draw() {
      const v = ar.view;
      pillars.forEach(drawPillar);
      arrows.forEach(drawArrow);
      poops.forEach(drawPoop);
      loot.forEach(drawLoot);
      puffs.forEach((p) => {
        const pr = ar.project(p.x, p.y, p.h);
        if (pr) ar.glow(pr.x, pr.y, (p.big ? 0.4 : 0.15) * pr.ppm * (0.5 + p.t * 2), [[0, "rgba(200,140,70,0.9)"], [0.5, "rgba(140,90,40,0.5)"], [1, "rgba(140,90,40,0)"]], 1 - p.t / 0.5);
      });
      ar.flush();
      drawTracers();

      if (state === "playing" || state === "cleared") {
        if (cfg.arrows) poops.forEach((m) => ar.edgeArrow(m.x, m.y, 0.05, m.type === "golden" ? "#ffd84a" : "#c88a3c"));
        if (cfg.radar) {
          const blips = [];
          pillars.forEach((p) => blips.push({ x: p.x, y: p.y, color: "#9a9aa6", r: 4 }));
          poops.forEach((m) => blips.push({ x: m.x, y: m.y, color: m.type === "boss" ? "#d060ff" : m.type === "golden" ? "#ffd84a" : "#c88a3c", r: m.type === "boss" ? 5 : 3.5 }));
          ar.radar(blips, areaM + 0.8);
        }
        ar.crosshair("rgba(0,0,0,0.6)", 19, 5);
        ar.crosshair("#ffffff", 17, 6);
        drawGun();
      }

      ar.flash("#ff0000", hurtFlash * 0.6);
      if (invulnerable > 0 && state === "playing" && Math.floor(invulnerable * 8) % 2 === 0) ar.flash("#ffffff", 0.08);

      // HUD -- kept clear of the Menu/Overlays headers, the radar and the Fire button.
      const hudY = v.y + v.h - 16;
      ar.text("❤".repeat(Math.max(0, hearts)), v.x + 14, hudY - 30, { size: 22, color: "#ff3050" });
      ar.text(`SCORE ${score}`, v.x + 14, hudY, { size: 20, color: "#ffd84a" });
      if (state !== "title") {
        ar.text(`LEVEL ${level}/${levelSet.length}`, v.x + 14, v.y + 66, { size: 18, color: "#ffd84a" });
        ar.text(`poops ${poops.length + spawnQueue.length}`, v.x + 14, v.y + 88, { size: 14 });
        ar.text(WEAPONS[weapon], v.x + v.w - 14, v.y + 66, { size: 16, align: "right", color: "#e8d8a8" });
      }

      if (message && message.t < 2.2 && state !== "title" && state !== "over") {
        ar.banner(message.text, message.sub, { color: message.color, alpha: Math.min(1, 2.2 - message.t) });
      }
      if (state === "title") {
        ar.flash("#000", 0.45);
        ar.banner("POOP SHOOTER", "Press FIRE to start", { color: "#c88a3c" });
        ar.text(`${levelSet.length} levels, each with walls · walls stop your shots and the robot · bow arrows drop: aim high`, v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
        if (best !== null) ar.text(`Best score on this robot: ${best}`, v.cx, v.cy + v.h * 0.27, { size: 14, align: "center", color: "#ffd84a" });
      } else if (state === "over" || state === "won") {
        ar.flash("#000", 0.45);
        ar.banner(state === "won" ? "ALL LEVELS DONE!" : "GAME OVER", `Score ${score} · level ${level}`, state === "won" ? { color: "#40ff80" } : {});
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.18, { size: 16, align: "center", color: "#ffd84a" });
        if (stateTime > 1.5) ar.text("Press FIRE to play again", v.cx, v.cy + v.h * 0.25, { size: 14, align: "center" });
      }
    }

    ar.onFrame((now, dt) => {
      update(dt);
      draw();
    });

    return {
      actionLabel: "\u{1F52B} Fire",
      snapshot: () => ({
        state, level, score, hearts,
        pillars: pillars.map((p) => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2) })),
        poops: poops.map((m) => ({ type: m.type, x: +m.x.toFixed(2), y: +m.y.toFixed(2), hp: m.hp })),
        weapon: WEAPONS[weapon], arrows: arrows.map((r) => ({ x: +r.x.toFixed(2), y: +r.y.toFixed(2), h: +r.h.toFixed(3), stuck: r.stuck >= 0 })), loot: loot.length, queued: spawnQueue.length,
      }),
    };
  };
})(window.Lynx);
