// David -- shoot open the crates standing on the floor around the robot:
// the golden one in each level holds a new, better pistol (water pistol ->
// laser -> double pistol -> lightning gun -> rainbow cannon), the others
// coins or a heart. Monsters crawl toward you; clear every crate and every
// monster to finish the level. In-game texts are Dutch (the game was made
// for a Dutch player).

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const CRATE_M = 0.16; // crate size (it's a billboard, as tall as it is wide)
  const TOUCH_M = 0.22; // monster this close = it got you
  const INVULNERABLE_S = 1.5;
  const MAX_HEARTS = 9;

  const WEAPONS = [
    { name: "Waterpistool", dmg: 1, cooldown: 0.45, pellets: 1, color: "#40b0ff", sound: "squirt" },
    { name: "Laserpistool", dmg: 2, cooldown: 0.35, pellets: 1, color: "#ff3040", sound: "laser" },
    { name: "Dubbelpistool", dmg: 2, cooldown: 0.35, pellets: 2, color: "#ffd020", sound: "pistol" },
    { name: "Bliksemgeweer", dmg: 2, cooldown: 0.14, pellets: 1, color: "#a0f0ff", sound: "zap", auto: true },
    { name: "Regenboogkanon", dmg: 6, cooldown: 0.5, pellets: 1, color: "rainbow", sound: "rainbow", splashM: 0.5 },
  ];
  const RAINBOW = ["#ff3030", "#ff9020", "#ffe020", "#40e040", "#30a0ff", "#a040ff"];

  const DIFFICULTY = {
    makkelijk: { speed: 0.7, hp: 0.7, spawn: 1.4 },
    normaal: { speed: 1, hp: 1, spawn: 1 },
    moeilijk: { speed: 1.3, hp: 1.3, spawn: 0.75 },
  };

  // -- sprites --------------------------------------------------------------------
  const CRATE = [
    "kkkkkkkkkkkk",
    "kaaaaaaaaaak",
    "kacbbbbbbcak",
    "kabcbbbbcbak",
    "kabbcbbcbbak",
    "kabbbccbbbak",
    "kabbbccbbbak",
    "kabbcbbcbbak",
    "kabcbbbbcbak",
    "kacbbbbbbcak",
    "kaaaaaaaaaak",
    "kkkkkkkkkkkk",
  ];
  const WOOD = { k: "#3a2410", a: "#c88a3c", b: "#9a6428", c: "#5a3814" };
  const GOLD = { k: "#5a3a00", a: "#fff0a0", b: "#f0b820", c: "#a07000" };

  const SLIME = [
    "....gggg....",
    "..gggghhgg..",
    ".gggggghhgg.",
    ".gwwggggwwg.",
    "ggwkggggwkgg",
    "gggggggggggg",
    "gggkggggkggg",
    "ggggkkkkgggg",
    "gggggggggggg",
    ".gggggggggg.",
  ];
  const SLIME_PAL = { g: "#40d040", h: "#b0ffb0", w: "#ffffff", k: "#103010" };

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
  const BAT_PAL = { p: "#9040d0", w: "#ffffff", k: "#200030" };

  const BLOB = [
    "r..........r",
    "rr..rrrr..rr",
    ".rrrrrrrrrr.",
    "rrrrrrrrrrrr",
    "rwwwrrrrwwwr",
    "rwkwrrrrwkwr",
    "rrrrrrrrrrrr",
    "rrrkkkkkkrrr",
    "rrrkwkkwkrrr",
    "rrrrrrrrrrrr",
    ".rrrrrrrrrr.",
    "..rr....rr..",
  ];
  const BLOB_PAL = { r: "#e03030", w: "#ffffff", k: "#300000" };

  // side view, barrel pointing left (toward the crosshair)
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
  const HEART = [
    ".rr.rr.",
    "rrrrrrr",
    "rrrrrrr",
    ".rrrrr.",
    "..rrr..",
    "...r...",
  ];

  const MONSTER = {
    slime: { sprite: SLIME, pal: SLIME_PAL, heightM: 0.11, hp: 3, speed: 0.08, score: 100, fly: 0 },
    bat: { sprite: BAT, pal: BAT_PAL, heightM: 0.07, hp: 2, speed: 0.12, score: 150, fly: 0.2 },
    blob: { sprite: BLOB, pal: BLOB_PAL, heightM: 0.15, hp: 6, speed: 0.06, score: 250, fly: 0 },
    boss: { sprite: BLOB, pal: { r: "#a020c0", w: "#ffffff", k: "#200020" }, heightM: 0.32, hp: 30, speed: 0.045, score: 1500, fly: 0 },
  };

  const rand = (a, b) => a + Math.random() * (b - a);

  Lynx.games.david = (ar, cfg) => {
    const diff = DIFFICULTY[cfg.difficulty] || DIFFICULTY.normaal;
    const areaM = cfg.areaM || 2;
    const aimAssist = cfg.aimAssist !== false;
    const sprites = {
      crate: Lynx.sprite(CRATE, WOOD),
      gold: Lynx.sprite(CRATE, GOLD),
      heart: Lynx.sprite(HEART, { r: "#ff3050" }),
      pistols: WEAPONS.map((w) =>
        Lynx.sprite(PISTOL, { c: w.color === "rainbow" ? "#a040ff" : w.color, h: w.color === "rainbow" ? "#ffe020" : "rgba(255,255,255,0.55)", k: "#202020" })),
    };
    Object.values(MONSTER).forEach((m) => (m.img = Lynx.sprite(m.sprite, m.pal)));

    let state = "title"; // title | playing | cleared | over
    let stateTime = 0;
    let level = 1;
    let score = 0;
    let hearts = cfg.hearts || 5;
    let owned = 1; // weapons unlocked (WEAPONS[0..owned-1])
    let weapon = 0;
    let cooldown = 0;
    let firePressed = false;
    let invulnerable = 0;
    let hurtFlash = 0;
    let message = null; // {text, sub, color, t}
    let crates = [];
    let monsters = [];
    let spawnQueue = [];
    let loot = [];
    let tracers = [];
    let debris = [];
    let puffs = [];
    let best = null;
    let rankMsg = "";
    Lynx.bestScore("david").then((b) => (best = b));

    function say(text, sub, color) {
      message = { text, sub, color, t: 0 };
    }

    // -- level setup ------------------------------------------------------------------
    function startLevel() {
      const cx = ar.pose.x;
      const cy = ar.pose.y;
      const n = Math.min(3 + level, 9);
      crates = [];
      let tries = 0;
      while (crates.length < n && tries++ < 2000) {
        const p = Lynx.randomAround(cx, cy, 0.6, areaM);
        if (crates.some((c) => Math.hypot(c.x - p.x, c.y - p.y) < 0.35)) continue;
        crates.push({ x: p.x, y: p.y, hp: 3 + Math.floor(level / 2), maxHp: 3 + Math.floor(level / 2), shake: 0, golden: false, open: false });
      }
      // The golden crate holds the next pistol (or, once you have them all, a big bonus).
      if (crates.length) crates[Math.floor(Math.random() * crates.length)].golden = true;
      crates.forEach((c) => (c.hp = c.maxHp = c.golden ? c.maxHp + 2 : c.maxHp));

      const count = 2 + 2 * level;
      const kinds = ["slime"];
      if (level >= 2) kinds.push("bat");
      if (level >= 3) kinds.push("blob");
      spawnQueue = [];
      for (let i = 0; i < count; i++) spawnQueue.push({ type: kinds[Math.floor(Math.random() * kinds.length)], at: 4 + i * rand(2.5, 4) * diff.spawn });
      if (level % 3 === 0) spawnQueue.push({ type: "boss", at: 6 + count * 2 * diff.spawn });
      monsters = [];
      loot = [];
      state = "playing";
      stateTime = 0;
      invulnerable = 1;
      say(`LEVEL ${level}`, "Schiet de blokken open!", "#ffd84a");
      Lynx.sfx.play("levelup");
    }

    function newGame() {
      level = 1;
      score = 0;
      hearts = cfg.hearts || 5;
      owned = 1;
      weapon = 0;
      startLevel();
    }

    function spawnMonster(type) {
      const def = MONSTER[type];
      const p = Lynx.randomAround(ar.pose.x, ar.pose.y, Math.max(1.4, areaM - 0.2), areaM + 0.6);
      const hp = Math.round(def.hp * diff.hp * (1 + 0.2 * (level - 1)));
      monsters.push({ type, x: p.x, y: p.y, hp, maxHp: hp, hit: 0, phase: Math.random() * 6, wobble: Math.random() * 6, alive: true, rect: null });
      if (type === "boss") say("DE GROTE BAAS!", "Schiet hem vaak!", "#d060ff");
      Lynx.sfx.play(type === "boss" ? "growl" : "boing");
    }

    // -- shooting ------------------------------------------------------------------------
    function targetAt(px, py) {
      const v = ar.view;
      const assistPx = aimAssist ? 0.04 * v.w : 0;
      let best = null;
      let bestMiss = Infinity;
      const consider = (obj, rect) => {
        if (!rect) return;
        const miss = Math.hypot(Math.max(rect.x - px, 0, px - (rect.x + rect.w)), Math.max(rect.y - py, 0, py - (rect.y + rect.h)));
        if (miss > assistPx) return;
        if (!best || miss < bestMiss - 0.5 || (Math.abs(miss - bestMiss) <= 0.5 && rect.depth < best.rect.depth)) {
          best = { obj, rect };
          bestMiss = miss;
        }
      };
      crates.forEach((c) => !c.open && consider(c, c.rect));
      monsters.forEach((m) => m.alive && consider(m, m.rect));
      return best;
    }

    function tryFire() {
      if (cooldown > 0) return;
      const w = WEAPONS[weapon];
      cooldown = w.cooldown;
      Lynx.sfx.play(w.sound);
      const v = ar.view;
      const offsets = w.pellets === 2 ? [-0.025, 0.025] : [0];
      offsets.forEach((o) => {
        const px = v.cx + o * v.w;
        const py = v.cy;
        const t = targetAt(px, py);
        const endX = t ? t.rect.x + t.rect.w / 2 : px;
        const endY = t ? t.rect.y + t.rect.h / 2 : py;
        tracers.push({ x0: v.cx + (o + 0.1) * v.w, y0: v.y + v.h, x1: endX, y1: endY, t: 0, color: w.color });
        if (!t) return;
        if (t.obj.golden !== undefined) hitCrate(t.obj, w.dmg);
        else hitMonster(t.obj, w.dmg);
        if (w.splashM) {
          monsters.forEach((m) => {
            if (m.alive && m !== t.obj && Math.hypot(m.x - t.obj.x, m.y - t.obj.y) < w.splashM) hitMonster(m, Math.ceil(w.dmg / 2));
          });
        }
      });
    }

    function hitCrate(c, dmg) {
      c.hp -= dmg;
      c.shake = 0.25;
      Lynx.sfx.play("knock");
      if (c.hp > 0) return;
      c.open = true;
      Lynx.sfx.play("crate");
      score += 50;
      if (c.rect) {
        for (let i = 0; i < 14; i++) {
          debris.push({ x: c.rect.cx, y: c.rect.y + c.rect.h / 2, vx: rand(-220, 220), vy: rand(-320, -60), t: 0, size: rand(3, 7), color: (c.golden ? GOLD : WOOD)[["a", "b", "c"][i % 3]] });
        }
      }
      // What comes out:
      if (c.golden && owned < WEAPONS.length) loot.push({ kind: "weapon", index: owned, x: c.x, y: c.y, h: 0.03, t: 0 });
      else if (c.golden) loot.push({ kind: "bonus", x: c.x, y: c.y, h: 0.03, t: 0 });
      else if (hearts < (cfg.hearts || 5) && Math.random() < 0.35) loot.push({ kind: "heart", x: c.x, y: c.y, h: 0.03, t: 0 });
      else loot.push({ kind: "coin", x: c.x, y: c.y, h: 0.03, t: 0 });
    }

    function hitMonster(m, dmg) {
      m.hp -= dmg;
      m.hit = 0.15;
      if (m.hp > 0) {
        Lynx.sfx.play("pain");
        return;
      }
      m.alive = false;
      score += MONSTER[m.type].score;
      Lynx.sfx.play("die");
      puffs.push({ x: m.x, y: m.y, h: MONSTER[m.type].fly + MONSTER[m.type].heightM / 2, t: 0, big: m.type === "boss" });
      if (m.type === "boss") {
        loot.push({ kind: "heart", x: m.x, y: m.y, h: 0.05, t: 0 });
        say("BAAS VERSLAGEN!", "+1500", "#d060ff");
      }
    }

    function collect(l) {
      if (l.kind === "weapon") {
        owned = Math.max(owned, l.index + 1);
        weapon = l.index;
        score += 200;
        say("NIEUW PISTOOL!", WEAPONS[l.index].name, "#40ff80");
        Lynx.sfx.play("power");
      } else if (l.kind === "heart") {
        hearts = Math.min(MAX_HEARTS, hearts + 1);
        Lynx.sfx.play("pickup");
      } else if (l.kind === "bonus") {
        score += 500;
        hearts = Math.min(MAX_HEARTS, hearts + 1);
        say("SUPER BONUS!", "+500 en een hartje", "#ffd84a");
        Lynx.sfx.play("found");
      } else {
        score += 25;
        Lynx.sfx.play("coin");
      }
    }

    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title" || (state === "over" && stateTime > 1.5)) {
        newGame();
        return;
      }
      firePressed = true;
    });
    Lynx.onAction("weapon", (which) => {
      if (which === "next") weapon = (weapon + 1) % owned;
      else if (which === "prev") weapon = (weapon - 1 + owned) % owned;
      else if (which - 1 < owned) weapon = which - 1;
    });
    Lynx.touchButtons().add("\u{1F52B} Wissel", () => (weapon = (weapon + 1) % owned));
    // Optional virtual jumping (off by default): spring over crawling
    // monsters (bats fly too high for that).
    if (cfg.jump) {
      Lynx.onAction("jump", () => state === "playing" && ar.jump());
      Lynx.touchButtons().add("\u2912 Spring", () => Lynx.jumpAction());
    }

    // -- update ----------------------------------------------------------------------------
    function update(dt) {
      stateTime += dt;
      cooldown = Math.max(0, cooldown - dt);
      hurtFlash = Math.max(0, hurtFlash - dt);
      if (message) message.t += dt;
      tracers.forEach((t) => (t.t += dt));
      tracers = tracers.filter((t) => t.t < 0.12);
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
        level++;
        startLevel();
        return;
      }
      if (state !== "playing") return;

      invulnerable = Math.max(0, invulnerable - dt);
      const w = WEAPONS[weapon];
      if (firePressed || (w.auto && Lynx.input.fireHeld)) tryFire();
      firePressed = false;

      spawnQueue = spawnQueue.filter((s) => {
        if (stateTime < s.at) return true;
        const alive = monsters.filter((m) => m.alive).length;
        if (alive >= 3 + Math.floor(level / 2)) return true; // wait for room
        spawnMonster(s.type);
        return false;
      });

      const cam = ar.cameraWorld();
      monsters.forEach((m) => {
        if (!m.alive) return;
        const def = MONSTER[m.type];
        m.phase += dt * 6;
        m.wobble += dt;
        m.hit = Math.max(0, m.hit - dt);
        const dx = ar.pose.x - m.x;
        const dy = ar.pose.y - m.y;
        const d = Math.hypot(dx, dy) || 1;
        // Wiggle sideways while coming closer (bats more than the others).
        const side = Math.sin(m.wobble * (m.type === "bat" ? 2.5 : 1)) * (m.type === "bat" ? 0.8 : 0.35);
        const speed = def.speed * diff.speed * (1 + 0.06 * (level - 1)) * (m.hit > 0 ? 0.3 : 1);
        m.x += ((dx / d) - (dy / d) * side) * speed * dt;
        m.y += ((dy / d) + (dx / d) * side) * speed * dt;
        const jumpedOver = ar.feet() > def.fly + def.heightM * 0.7;
        if (d < TOUCH_M + (m.type === "boss" ? 0.1 : 0) && invulnerable === 0 && !jumpedOver) {
          hearts--;
          invulnerable = INVULNERABLE_S;
          hurtFlash = 0.5;
          Lynx.sfx.play("hurt");
          // knocked back after biting
          m.x -= (dx / d) * 0.6;
          m.y -= (dy / d) * 0.6;
          if (hearts <= 0) {
            state = "over";
            stateTime = 0;
            rankMsg = "";
            Lynx.sfx.play("lose");
            Lynx.submitScore("david", score).then((rank) => {
              rankMsg = rank ? `#${rank} op het scorebord van de robot!` : "";
              if (rank === 1) best = score;
            });
          }
        }
      });
      monsters = monsters.filter((m) => m.alive);

      // Loot pops up out of the crate, then flies to you.
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
          collect(l);
          return false;
        }
        return true;
      });

      if (crates.every((c) => c.open) && spawnQueue.length === 0 && monsters.length === 0 && loot.length === 0) {
        state = "cleared";
        stateTime = 0;
        score += 300 * level;
        say(`LEVEL ${level} GEHAALD!`, `+${300 * level} punten`, "#40ff80");
        Lynx.sfx.play("found");
      }
    }

    // -- drawing ---------------------------------------------------------------------------
    function drawCrate(c) {
      if (c.open) {
        c.rect = null;
        return;
      }
      c.shake = Math.max(0, c.shake - 1 / 60);
      const jiggle = c.shake > 0 ? Math.sin(c.shake * 80) * 0.01 : 0;
      const rect = ar.spriteRect(sprites.crate, c.x + jiggle, c.y, 0, CRATE_M);
      c.rect = rect;
      if (!rect) return;
      ar.queue(rect.depth, () => {
        ar.floorCircle(c.x, c.y, CRATE_M * 0.6, "rgba(0,0,0,0.3)");
        if (c.golden) ar.glow(rect.cx, rect.y + rect.h / 2, rect.w * 1.1, [[0, "rgba(255,230,120,0.6)"], [1, "rgba(255,200,0,0)"]]);
        ar.drawSprite(c.golden ? sprites.gold : sprites.crate, rect);
        if (c.hp < c.maxHp) {
          // cracks: a darker overlay that grows as it breaks
          ar.ctx.save();
          ar.ctx.globalAlpha = 0.5 * (1 - c.hp / c.maxHp);
          ar.ctx.fillStyle = "#000";
          ar.ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
          ar.ctx.restore();
        }
      });
    }

    function drawMonster(m) {
      const def = MONSTER[m.type];
      const bob = m.type === "bat" ? Math.sin(m.phase) * 0.02 : Math.abs(Math.sin(m.phase * 0.5)) * 0.01;
      const rect = ar.spriteRect(def.img, m.x, m.y, def.fly + bob, def.heightM);
      m.rect = rect;
      if (!rect) return;
      ar.queue(rect.depth, () => {
        ar.floorCircle(m.x, m.y, def.heightM * 0.4, "rgba(0,0,0,0.3)");
        ar.drawSprite(def.img, rect, { flip: Math.sin(m.wobble) < 0, tint: m.hit > 0 ? "rgba(255,255,255,0.7)" : null });
        if (m.maxHp > 3) {
          const w = rect.w;
          ar.ctx.fillStyle = "rgba(0,0,0,0.6)";
          ar.ctx.fillRect(rect.x, rect.y - 7, w, 4);
          ar.ctx.fillStyle = m.type === "boss" ? "#d060ff" : "#ff4040";
          ar.ctx.fillRect(rect.x, rect.y - 7, (w * m.hp) / m.maxHp, 4);
        }
      });
    }

    function drawLoot(l) {
      const p = ar.project(l.x, l.y, l.h);
      if (!p) return;
      const spin = Math.abs(Math.cos(l.t * 6));
      ar.queue(p.depth, () => {
        const s = Math.max(10, 0.1 * p.ppm);
        if (l.kind === "coin" || l.kind === "bonus") {
          ar.glow(p.x, p.y, s * 1.2, [[0, "rgba(255,240,150,0.9)"], [1, "rgba(255,200,0,0)"]]);
          ar.ctx.fillStyle = "#ffd84a";
          ar.ctx.beginPath();
          ar.ctx.ellipse(p.x, p.y, Math.max(1, (s / 2) * spin), s / 2, 0, 0, 2 * Math.PI);
          ar.ctx.fill();
          return;
        }
        const img = l.kind === "heart" ? sprites.heart : sprites.pistols[l.index];
        const w = s * (l.kind === "heart" ? 1 : 1.6);
        const h = (w * img.height) / img.width;
        ar.glow(p.x, p.y, w, [[0, "rgba(255,255,255,0.8)"], [1, "rgba(255,255,255,0)"]]);
        ar.drawSprite(img, { x: p.x - (w * spin) / 2, y: p.y - h / 2, w: Math.max(1, w * spin), h });
      });
    }

    function drawGun() {
      const v = ar.view;
      const w = WEAPONS[weapon];
      const img = sprites.pistols[weapon];
      const gw = Math.min(v.w * 0.22, 180);
      const gh = (gw * img.height) / img.width;
      const kick = cooldown > 0 ? (cooldown / w.cooldown) * gh * 0.25 : 0;
      ar.drawSprite(img, { x: v.cx + v.w * 0.05, y: v.y + v.h - gh * 0.95 + kick, w: gw, h: gh });
    }

    function drawTracers() {
      const ctx = ar.ctx;
      tracers.forEach((t) => {
        ctx.save();
        ctx.globalAlpha = 1 - t.t / 0.12;
        ctx.lineCap = "round";
        if (t.color === "rainbow") {
          RAINBOW.forEach((c, i) => {
            ctx.strokeStyle = c;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.moveTo(t.x0 + (i - 2.5) * 3, t.y0);
            ctx.lineTo(t.x1 + (i - 2.5) * 1.5, t.y1);
            ctx.stroke();
          });
        } else {
          ctx.strokeStyle = t.color;
          ctx.lineWidth = 4;
          ctx.beginPath();
          ctx.moveTo(t.x0, t.y0);
          ctx.lineTo(t.x1, t.y1);
          ctx.stroke();
        }
        ctx.restore();
      });
      debris.forEach((d) => {
        ar.ctx.fillStyle = d.color;
        ar.ctx.fillRect(d.x, d.y, d.size, d.size);
      });
    }

    function draw() {
      const v = ar.view;
      crates.forEach(drawCrate);
      monsters.forEach(drawMonster);
      loot.forEach(drawLoot);
      puffs.forEach((p) => {
        const pr = ar.project(p.x, p.y, p.h);
        if (pr) ar.glow(pr.x, pr.y, (p.big ? 0.4 : 0.15) * pr.ppm * (0.5 + p.t * 2), [[0, "rgba(255,255,255,0.9)"], [0.5, "rgba(200,255,200,0.5)"], [1, "rgba(200,255,200,0)"]], 1 - p.t / 0.5);
      });
      ar.flush();
      drawTracers();

      if (state === "playing" || state === "cleared") {
        if (cfg.arrows) {
          crates.forEach((c) => !c.open && ar.edgeArrow(c.x, c.y, CRATE_M / 2, c.golden ? "#ffd84a" : "#c88a3c"));
          monsters.forEach((m) => ar.edgeArrow(m.x, m.y, MONSTER[m.type].fly + 0.05, "#ff4040"));
        }
        if (cfg.radar) {
          const blips = [];
          crates.forEach((c) => !c.open && blips.push({ x: c.x, y: c.y, color: c.golden ? "#ffd84a" : "#c88a3c", r: 3 }));
          monsters.forEach((m) => blips.push({ x: m.x, y: m.y, color: m.type === "boss" ? "#d060ff" : "#ff4040", r: m.type === "boss" ? 5 : 3.5 }));
          ar.radar(blips, areaM + 0.8);
        }
        ar.crosshair("rgba(0,0,0,0.6)", 19, 5);
        ar.crosshair("#ffffff", 17, 6);
        drawGun();
      }

      ar.flash("#ff0000", hurtFlash * 0.6);
      if (invulnerable > 0 && state === "playing" && Math.floor(invulnerable * 8) % 2 === 0) ar.flash("#ffffff", 0.08);

      // HUD -- kept clear of the Menu/Overlays headers (top corners), the
      // radar (top center) and the Wissel/Schiet buttons (bottom right).
      const hudY = v.y + v.h - 16;
      ar.text("❤".repeat(Math.max(0, hearts)), v.x + 14, hudY - 30, { size: 22, color: "#ff3050" });
      ar.text(`SCORE ${score}`, v.x + 14, hudY, { size: 20, color: "#ffd84a" });
      if (state !== "title") {
        const cratesLeft = crates.filter((c) => !c.open).length;
        const monstersLeft = monsters.length + spawnQueue.length;
        ar.text(`LEVEL ${level}`, v.x + 14, v.y + 66, { size: 18, color: "#ffd84a" });
        ar.text(`blokken ${cratesLeft} · monsters ${monstersLeft}`, v.x + 14, v.y + 88, { size: 14 });
        ar.text(WEAPONS[weapon].name, v.x + v.w - 14, v.y + 66, { size: 16, align: "right", color: WEAPONS[weapon].color === "rainbow" ? "#ffe020" : WEAPONS[weapon].color });
      }

      if (message && message.t < 2.2 && state !== "title" && state !== "over") {
        ar.banner(message.text, message.sub, { color: message.color, alpha: Math.min(1, 2.2 - message.t) });
      }
      if (state === "title") {
        ar.flash("#000", 0.45);
        ar.banner("DAVID", "Druk op VUUR om te beginnen", { color: "#ffd84a" });
        ar.text("Schiet de blokken open · in het gouden blok zit een nieuw pistool · versla de monsters", v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
        if (best !== null) ar.text(`Beste score op deze robot: ${best}`, v.cx, v.cy + v.h * 0.27, { size: 14, align: "center", color: "#ffd84a" });
      } else if (state === "over") {
        ar.flash("#000", 0.45);
        ar.banner("GAME OVER", `Score ${score} · level ${level}`);
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.18, { size: 16, align: "center", color: "#ffd84a" });
        if (stateTime > 1.5) ar.text("Druk op VUUR om opnieuw te spelen", v.cx, v.cy + v.h * 0.25, { size: 14, align: "center" });
      }
    }

    ar.onFrame((now, dt) => {
      update(dt);
      draw();
    });

    return {
      actionLabel: "\u{1F52B} Schiet",
      snapshot: () => ({
        state, level, score, hearts, weapon: WEAPONS[weapon].name, owned,
        crates: crates.map((c) => ({ x: +c.x.toFixed(2), y: +c.y.toFixed(2), hp: c.hp, golden: c.golden, open: c.open })),
        monsters: monsters.map((m) => ({ type: m.type, x: +m.x.toFixed(2), y: +m.y.toFixed(2), hp: m.hp })),
        loot: loot.length, queued: spawnQueue.length,
      }),
    };
  };
})(window.Lynx);
