// Doom -- a first-person shooter played in augmented reality around the
// real robot. The room is the level: demons spawn in a ring around you in
// world space and close in; you aim by turning the camera (the crosshair is
// the optical axis) and fire hitscan weapons. Their fireballs are real 3D
// projectiles aimed at where the camera WAS -- so physically driving
// sideways dodges them -- and health/ammo pickups lie on the floor, so you
// have to actually drive over them.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  // -- pixel art ---------------------------------------------------------------
  const IMP_PAL = { k: "#24140a", b: "#7c4a26", l: "#b0703c", d: "#4c2a12", r: "#ff3010", w: "#efe6c8", y: "#ffd000" };
  const IMP_TOP = [
    ".w........w.",
    ".wk......kw.",
    "..kbbbbbbk..",
    "..bryybryb..",
    "..bbbbbbbb..",
    "..bkwwwwkb..",
    "...kbbbbk...",
    ".kbbllllbbk.",
    "kbbllllllbbk",
    "kb.kllllk.bk",
    "kw.kbllbk.wk",
    "...kbbbbk...",
    "...kddddk...",
  ];
  const IMP_LEGS_A = [
    "...kbk.kbk..",
    "..kbk..kbk..",
    "..kbk...kbk.",
    ".kbbk...kbbk",
    ".kkkk...kkkk",
  ];
  const IMP_LEGS_B = [
    "..kbk.kbk...",
    "..kbk..kbk..",
    ".kbk...kbk..",
    "kbbk...kbbk.",
    "kkkk...kkkk.",
  ];
  const IMP_DEAD = [
    "............",
    "............",
    "............",
    "............",
    "............",
    "............",
    "............",
    "............",
    "............",
    "............",
    "............",
    "............",
    "....r.r.....",
    "..rkbbbk.r..",
    ".kbbwwbllbk.",
    "kbrllllbbdbk",
    "kkrrkkkkrkkk",
    ".rrr....rr..",
  ];

  const PINKY_PAL = { k: "#2a0a10", p: "#e0708a", q: "#b04a64", r: "#ffe000", w: "#fff4e0", m: "#6a0010" };
  const PINKY_TOP = [
    "...kkkkkkkkkk...",
    ".kkppppppppppkk.",
    "kpppppppppppppqk",
    "kpprrppppprrppqk",
    "kppppppppppppqqk",
    "kpkwkwkwkwkwkpqk",
    "kpmmmmmmmmmmmpqk",
    "kpkwkwkwkwkwkpqk",
    ".kpppppppppppqk.",
    "..kqpppppppqqk..",
  ];
  const PINKY_LEGS_A = [
    ".kqqk.kqqk.kqk..",
    ".kqk..kqk..kqqk.",
    "kqqk.kqqk...kqk.",
    "kkkk.kkkk...kkk.",
  ];
  const PINKY_LEGS_B = [
    "..kqk.kqqk.kqqk.",
    ".kqqk..kqk..kqk.",
    ".kqk...kqqk.kqqk",
    ".kkk...kkkk.kkkk",
  ];
  const PINKY_DEAD = [
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "........m.......",
    "..m.kkkkkkkk.m..",
    ".kkppmmpwkwqqkk.",
    "kpqqppmmmmppqqqk",
    "kkmmkkkkkkkkmmkk",
    "..mm.......mmm..",
    "................",
    "................",
  ];

  const CACO_PAL = { k: "#300000", r: "#d02020", s: "#901010", h: "#f0e0c0", g: "#30ff40", e: "#ffffff", m: "#200000", w: "#fffae8", b: "#4060ff" };
  const CACO = [
    ".h...........h..",
    ".hk.kkkkkkk.kh..",
    "..krrrrrrrrrk...",
    ".krrrrreeerrrk..",
    "krrrrrggggrrrsk.",
    "krrrrrgmmgrrrrsk",
    "krrrrreeeerrrrsk",
    "krrrrrrrrrrrrrsk",
    "krkwkwkwkwkwkrsk",
    "krmmmmmmmmmmmrsk",
    "krkwkwkwkwkwkrsk",
    ".krrrrrrrrrrrsk.",
    "..ksrrrrrrrssk..",
    "...kkssssssk....",
    ".....kkkkkk.....",
  ];
  const CACO_DEAD = [
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "................",
    "....kkkkkkk.....",
    "..kkrrmmrrrkk...",
    ".krrmmbbmmrrsk..",
    "krrrrrmmrrrrrsk.",
    "kkkkkkkkkkkkkkk.",
    ".mm..........mm.",
    "................",
  ];

  const MED_PAL = { k: "#202020", w: "#f4f4f4", r: "#e01010" };
  const MEDKIT = ["kkkkkkkk", "kwwwwwwk", "kwwrrwwk", "kwrrrrwk", "kwrrrrwk", "kwwrrwwk", "kwwwwwwk", "kkkkkkkk"];
  const AMMO_PAL = { k: "#101010", g: "#3c6a2a", y: "#e8c030", b: "#c09020" };
  const AMMO = ["kkkkkkkk", "kgggggkk", "kgyybyyk", "kgyybyyk", "kgyybyyk", "kgggggkk", "kkkkkkkk"];
  const SHELLS_PAL = { k: "#101010", r: "#c01818", y: "#e0b030" };
  const SHELLS = [".kk.kk.kk.", "krrkrrkrrk", "krrkrrkrrk", "krrkrrkrrk", "kyykyykyyk", "kkkkkkkkkk"];
  const ARMOR_PAL = { k: "#082008", g: "#20c040", l: "#80ff90" };
  const ARMOR = [".kk....kk.", "kggkkkkggk", "kglggggglk", "kggggggggk", ".kggggggk.", ".kglgglgk.", "..kggggk..", "...kkkk..."];
  const CHAINGUN_PICK_PAL = { k: "#101010", g: "#808080", l: "#c0c0c0" };
  const CHAINGUN_PICK = ["kkkkkkkkkkkk", "kggglgggglgk", "kllllllllllk", "kggglgggglgk", "kkkkkggkkkkk", ".....kgk....", ".....kkk...."];

  const GUN_PAL = { k: "#141414", g: "#6a6a6a", l: "#a8a8a8", s: "#c88a5a", d: "#8a5a34", w: "#7a4a1e" };
  const PISTOL = [
    ".....kkk.....",
    ".....klk.....",
    ".....kgk.....",
    "....kglgk....",
    "....kgggk....",
    "...kgkkkgk...",
    "..kssgggssk..",
    ".kssssssssdk.",
    "kssssssssssdk",
    "kssssssssssdk",
    "kssssssssssdk",
  ];
  const SHOTGUN = [
    "........kkk.........",
    "........klk.........",
    "........kgk.........",
    ".......kglgk........",
    ".......kgggk........",
    "......kwwwwwk.......",
    "......kwwwwwk.......",
    "......kgglggk.......",
    "....ksskgggkssk.....",
    "...kssssssssssdk....",
    "..kssssssssssssdk...",
    "..kssssssssssssdk...",
    "..kssssssssssssdk...",
  ];
  const CHAINGUN = [
    ".....kkkkkkk.....",
    ".....klglglk.....",
    ".....kgggggk.....",
    ".....klglglk.....",
    "....kgggggggk....",
    "....kglglglgk....",
    "...kgggggggggk...",
    "..ksskgggggkssk..",
    ".kssssssssssssdk.",
    "kssssssssssssssdk",
    "kssssssssssssssdk",
    "kssssssssssssssdk",
  ];

  // Status-bar face: healthy / hurt / wrecked, plus a grin and a wince.
  const FACE_PAL = { k: "#1a0e06", s: "#c8844e", d: "#9a5e30", h: "#5a3212", e: "#f8f8f8", p: "#1850c0", m: "#5a1010", t: "#f4f0e0", r: "#d01010" };
  const FACE_BASE = [
    "..hhhhhhhh..",
    ".hhhhhhhhhh.",
    "hhssssssssh.",
    "hsssssssssd.",
    "hseepssepsd.",
    "hsssssssssd.",
    "hsssskssssd.",
    ".sssskkssd..",
    ".sssmmmmsd..",
    "..ssssssd...",
    "...dssdd....",
  ];
  function faceVariant(kind) {
    const rows = FACE_BASE.slice();
    const set = (y, x, ch) => (rows[y] = rows[y].slice(0, x) + ch + rows[y].slice(x + 1));
    if (kind === "grin") {
      rows[8] = ".ssmttttmd..";
    } else if (kind === "ouch") {
      rows[4] = "hsekpssekpd.";
      rows[8] = ".sssmmmmsd..";
      rows[7] = ".sssmmmmsd..";
    }
    if (kind === "hurt" || kind === "wrecked") {
      set(2, 3, "r");
      set(5, 8, "r");
      set(6, 9, "r");
    }
    if (kind === "wrecked") {
      set(3, 2, "r");
      set(4, 3, "r");
      set(7, 2, "r");
      set(8, 7, "r");
      set(9, 3, "r");
      rows[4] = "hseerssekpd.";
    }
    return rows;
  }

  // -- tuning --------------------------------------------------------------------
  // dmg: damage taken; hp: demon health; count: demons per wave; shotSpeed:
  // fireball speed; attack: time between a demon's attacks (x); gap: time
  // between spawns (x); speed: demon walking speed. Aiming and dodging with a
  // real robot is much slower than with a mouse, so even the default ("Hurt
  // me plenty") is gentle -- "Ultra-Violence" is what the default used to be.
  const DIFFICULTY = {
    itytd: { dmg: 0.35, hp: 0.6, count: 0.6, shotSpeed: 0.7, attack: 1.8, gap: 1.6, speed: 0.7 },
    hmp: { dmg: 0.6, hp: 0.8, count: 0.8, shotSpeed: 0.8, attack: 1.4, gap: 1.3, speed: 0.85 },
    uv: { dmg: 1, hp: 1, count: 1, shotSpeed: 1, attack: 1, gap: 1, speed: 1 },
    nm: { dmg: 1.6, hp: 1.3, count: 1.4, shotSpeed: 1.25, attack: 0.8, gap: 0.85, speed: 1.2 },
  };
  const ENEMY = {
    imp: { hp: 30, speed: 0.12, heightM: 0.34, score: 100, keepAway: [0.9, 1.5] },
    pinky: { hp: 60, speed: 0.26, heightM: 0.28, score: 150, keepAway: null },
    caco: { hp: 100, speed: 0.08, heightM: 0.3, score: 300, keepAway: [1.2, 2.0], floatM: 0.18 },
  };
  const WEAPONS = [
    null,
    { name: "PISTOL", ammo: "bullets", cooldown: 0.4, pellets: 1, spread: 0.004, dmg: [9, 15], sound: "pistol" },
    { name: "SHOTGUN", ammo: "shells", cooldown: 1.0, pellets: 7, spread: 0.06, dmg: [6, 10], sound: "shotgun" },
    { name: "CHAINGUN", ammo: "bullets", cooldown: 0.11, pellets: 1, spread: 0.02, dmg: [8, 13], sound: "chaingun" },
  ];
  const PICKUP_RADIUS_M = 0.2;
  const PLAYER_HIT_RADIUS_M = 0.1;
  const BITE_RANGE_M = 0.3;
  const MAX_BULLETS = 200;
  const MAX_SHELLS = 50;

  const rand = (a, b) => a + Math.random() * (b - a);

  Lynx.games.demons = (ar, cfg) => {
    const diff = DIFFICULTY[cfg.difficulty] || DIFFICULTY.hmp;
    const speedMult = (cfg.enemySpeed || 1) * diff.speed;
    const aimAssist = cfg.aimAssist !== false;
    const spawnR = cfg.spawnRadiusM || 2.5;

    const sprites = {
      imp: [Lynx.sprite(IMP_TOP.concat(IMP_LEGS_A), IMP_PAL), Lynx.sprite(IMP_TOP.concat(IMP_LEGS_B), IMP_PAL)],
      impDead: Lynx.sprite(IMP_DEAD, IMP_PAL),
      pinky: [Lynx.sprite(PINKY_TOP.concat(PINKY_LEGS_A), PINKY_PAL), Lynx.sprite(PINKY_TOP.concat(PINKY_LEGS_B), PINKY_PAL)],
      pinkyDead: Lynx.sprite(PINKY_DEAD, PINKY_PAL),
      caco: [Lynx.sprite(CACO, CACO_PAL)],
      cacoDead: Lynx.sprite(CACO_DEAD, CACO_PAL),
      medkit: Lynx.sprite(MEDKIT, MED_PAL),
      bullets: Lynx.sprite(AMMO, AMMO_PAL),
      shells: Lynx.sprite(SHELLS, SHELLS_PAL),
      armor: Lynx.sprite(ARMOR, ARMOR_PAL),
      chaingun: Lynx.sprite(CHAINGUN_PICK, CHAINGUN_PICK_PAL),
      guns: [null, Lynx.sprite(PISTOL, GUN_PAL), Lynx.sprite(SHOTGUN, GUN_PAL), Lynx.sprite(CHAINGUN, GUN_PAL)],
      faces: {
        ok: Lynx.sprite(FACE_BASE, FACE_PAL),
        hurt: Lynx.sprite(faceVariant("hurt"), FACE_PAL),
        wrecked: Lynx.sprite(faceVariant("wrecked"), FACE_PAL),
        grin: Lynx.sprite(faceVariant("grin"), FACE_PAL),
        ouch: Lynx.sprite(faceVariant("ouch"), FACE_PAL),
      },
    };
    const PICKUP_HEIGHT = { medkit: 0.07, bullets: 0.06, shells: 0.06, armor: 0.08, chaingun: 0.06 };

    let state = "title"; // title | playing | intermission | dead
    let stateTime = 0;
    let best = null;
    let rankMsg = "";
    let p; // player
    let enemies, shots, pickups, effects, spawnQueue;
    let wave, score, kills;
    let cooldown = 0;
    let firePressed = false;
    let muzzle = 0;
    let hurtFlash = 0;
    let pickupFlash = 0;
    let faceTimer = 0;
    let faceKind = "ok";
    let bob = 0;
    let lastPose = null;

    Lynx.bestScore("demons").then((b) => (best = b));

    function reset() {
      p = { health: 100, armor: 0, bullets: 50, shells: 8, weapon: 1, owned: [false, true, true, false] };
      enemies = [];
      shots = [];
      pickups = [];
      effects = [];
      spawnQueue = [];
      wave = 0;
      score = 0;
      kills = 0;
      cooldown = 0;
    }
    reset();

    function startWave() {
      wave++;
      const n = (k) => Math.max(0, Math.round(k * diff.count));
      const list = [];
      for (let i = 0; i < n(2 + wave); i++) list.push("imp");
      for (let i = 0; i < n(wave - 1); i++) list.push("pinky");
      for (let i = 0; i < n(Math.floor((wave - 1) / 2)); i++) list.push("caco");
      list.sort(() => Math.random() - 0.5);
      spawnQueue = list.map((type, i) => ({ type, at: 1.2 + i * rand(1.0, 2.2) * diff.gap }));
      stateTime = 0;
      state = "playing";
      Lynx.sfx.play("wave");
      // Supplies each wave -- on the floor nearby, so you have to go get them.
      dropPickup(Lynx.randomAround(ar.pose.x, ar.pose.y, 0.5, 1.2), p.health < 60 ? "medkit" : "bullets");
      dropPickup(Lynx.randomAround(ar.pose.x, ar.pose.y, 0.6, 1.4), "shells");
      if (wave === 3) dropPickup(Lynx.randomAround(ar.pose.x, ar.pose.y, 0.5, 1.0), "chaingun");
      if (wave >= 2 && wave % 2 === 0) dropPickup(Lynx.randomAround(ar.pose.x, ar.pose.y, 0.8, 1.6), "armor");
    }

    function dropPickup(pos, kind) {
      pickups.push({ x: pos.x, y: pos.y, kind, phase: Math.random() * 6 });
    }

    function spawnEnemy(type) {
      const pos = Lynx.randomAround(ar.pose.x, ar.pose.y, spawnR - 0.3, spawnR + 0.5);
      const def = ENEMY[type];
      enemies.push({
        type, x: pos.x, y: pos.y, hp: def.hp * diff.hp, state: "alive", pain: 0, anim: Math.random(),
        attackTimer: rand(1.5, 3.5) * diff.attack, attackAnim: 0, strafeDir: Math.random() < 0.5 ? -1 : 1, strafeTimer: rand(1, 3), deadTime: 0,
      });
      if (Math.random() < 0.4) Lynx.sfx.play("growl");
    }

    function damagePlayer(amount) {
      if (state !== "playing" && state !== "intermission") return;
      amount *= diff.dmg;
      const saved = Math.min(p.armor, amount / 3);
      p.armor -= saved;
      p.health -= amount - saved;
      hurtFlash = Math.min(0.6, hurtFlash + 0.35);
      faceKind = "ouch";
      faceTimer = 0.6;
      if (p.health <= 0) {
        p.health = 0;
        state = "dead";
        stateTime = 0;
        rankMsg = "";
        Lynx.sfx.play("die");
        Lynx.submitScore("demons", score).then((rank) => {
          rankMsg = rank ? `#${rank} on the robot's scoreboard!` : "";
          if (rank === 1) best = score;
        });
      } else {
        Lynx.sfx.play("hurt");
      }
    }

    // -- shooting ------------------------------------------------------------------
    function tryFire() {
      const w = WEAPONS[p.weapon];
      if (cooldown > 0) return;
      if (p[w.ammo] <= 0) {
        Lynx.sfx.play("click");
        cooldown = 0.3;
        // Out of ammo: fall back to whatever still has some.
        const alt = [1, 2, 3].find((i) => p.owned[i] && p[WEAPONS[i].ammo] > 0);
        if (alt) p.weapon = alt;
        return;
      }
      p[w.ammo]--;
      cooldown = w.cooldown;
      muzzle = 0.08;
      Lynx.sfx.play(w.sound);
      const v = ar.view;
      const hits = new Map();
      // Aim assist: a shot that lands this close to a demon (screen pixels)
      // still counts -- lining up a crosshair by turning a robot is coarse.
      const assistPx = aimAssist ? 0.04 * v.w : 0;
      for (let i = 0; i < w.pellets; i++) {
        const px = v.cx + rand(-1, 1) * w.spread * v.w;
        const py = v.cy + rand(-1, 1) * w.spread * v.w * 0.6;
        let target = null;
        let targetMiss = Infinity;
        enemies.forEach((e) => {
          if (e.state !== "alive" || !e.rect) return;
          const r = e.rect;
          const miss = Math.hypot(Math.max(r.x - px, 0, px - (r.x + r.w)), Math.max(r.y - py, 0, py - (r.y + r.h)));
          if (miss > assistPx) return;
          // a direct hit beats a near miss; among equals, the nearer demon
          if (!target || miss < targetMiss - 0.5 || (Math.abs(miss - targetMiss) <= 0.5 && r.depth < target.rect.depth)) {
            target = e;
            targetMiss = miss;
          }
        });
        if (!target) continue;
        // Damage falls off with distance, shotgun most of all.
        const dist = Math.hypot(target.x - ar.pose.x, target.y - ar.pose.y);
        const falloff = w.pellets > 1 ? Math.max(0.35, 1 - (dist - 0.8) / 3) : 1;
        hits.set(target, (hits.get(target) || 0) + rand(w.dmg[0], w.dmg[1]) * falloff);
      }
      hits.forEach((dmg, e) => hurtEnemy(e, dmg));
    }

    function hurtEnemy(e, dmg) {
      e.hp -= dmg;
      e.pain = 0.18;
      if (e.hp <= 0) {
        e.state = "dead";
        e.deadTime = 0;
        kills++;
        score += ENEMY[e.type].score;
        Lynx.sfx.play("die");
        if (Math.random() < 0.3) dropPickup({ x: e.x, y: e.y }, Math.random() < 0.4 ? "medkit" : Math.random() < 0.6 ? "bullets" : "shells");
      } else {
        Lynx.sfx.play("pain");
        // Getting shot makes them flinch -- delays their next attack a bit.
        e.attackTimer = Math.max(e.attackTimer, 0.5);
      }
    }

    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title" || (state === "dead" && stateTime > 1.5)) {
        reset();
        startWave();
        return;
      }
      firePressed = true;
    });
    Lynx.onAction("weapon", (which) => {
      if (which === "next") switchNext();
      else if (which === "prev") switchNext(-1);
      else if (p.owned[which]) p.weapon = which;
    });

    Lynx.touchButtons().add("\u{1F52B} Weapon", () => switchNext());
    // Optional virtual jumping (off by default): jump over pinky bites and
    // incoming fireballs (those already aim at, and hit, the camera's height).
    if (cfg.jump) {
      Lynx.onAction("jump", () => state === "playing" || state === "intermission" ? ar.jump() : null);
      Lynx.touchButtons().add("\u2912 Jump", () => Lynx.jumpAction());
    }
    function switchNext(step = 1) {
      for (let i = 1; i <= 3; i++) {
        const cand = ((((p.weapon - 1 + step * i) % 3) + 3) % 3) + 1;
        if (p.owned[cand]) {
          p.weapon = cand;
          return;
        }
      }
    }

    // -- simulation -------------------------------------------------------------
    function update(dt) {
      stateTime += dt;
      cooldown = Math.max(0, cooldown - dt);
      muzzle = Math.max(0, muzzle - dt);
      hurtFlash = Math.max(0, hurtFlash - dt * 1.2);
      pickupFlash = Math.max(0, pickupFlash - dt * 1.5);
      faceTimer = Math.max(0, faceTimer - dt);
      if (faceTimer === 0) faceKind = "ok";

      // Weapon bob follows how fast the robot is actually moving.
      if (lastPose) {
        const moved = Math.hypot(ar.pose.x - lastPose.x, ar.pose.y - lastPose.y);
        bob += Math.min(moved / Math.max(dt, 0.001), 0.5) * dt * 18;
      }
      lastPose = { x: ar.pose.x, y: ar.pose.y };

      // Holding fire keeps shooting at each weapon's own rate, like Doom.
      if ((state === "playing" || state === "intermission") && (firePressed || Lynx.input.fireHeld)) tryFire();
      firePressed = false;

      if (state === "playing") {
        spawnQueue = spawnQueue.filter((s) => {
          if (stateTime >= s.at) {
            spawnEnemy(s.type);
            return false;
          }
          return true;
        });
        if (spawnQueue.length === 0 && enemies.every((e) => e.state === "dead")) {
          state = "intermission";
          stateTime = 0;
          score += 500 * wave;
          Lynx.sfx.play("pickup");
        }
      } else if (state === "intermission" && stateTime > 4) {
        startWave();
      }

      const px = ar.pose.x;
      const py = ar.pose.y;
      const cam = ar.cameraWorld();

      enemies.forEach((e) => {
        if (e.state === "dead") {
          e.deadTime += dt;
          return;
        }
        const def = ENEMY[e.type];
        e.pain = Math.max(0, e.pain - dt);
        e.anim += dt * 3;
        const dx = px - e.x;
        const dy = py - e.y;
        const dist = Math.hypot(dx, dy) || 0.001;
        const ux = dx / dist;
        const uy = dy / dist;
        let mx = 0;
        let my = 0;
        if (def.keepAway) {
          e.strafeTimer -= dt;
          if (e.strafeTimer <= 0) {
            e.strafeDir *= -1;
            e.strafeTimer = rand(1.5, 3.5);
          }
          if (dist > def.keepAway[1]) {
            mx = ux;
            my = uy;
          } else if (dist < def.keepAway[0]) {
            mx = -ux;
            my = -uy;
          } else {
            mx = -uy * e.strafeDir;
            my = ux * e.strafeDir;
          }
        } else if (dist > BITE_RANGE_M * 0.75) {
          mx = ux;
          my = uy;
        }
        // Keep demons from stacking into one sprite.
        enemies.forEach((o) => {
          if (o === e || o.state === "dead") return;
          const sx = e.x - o.x;
          const sy = e.y - o.y;
          const d = Math.hypot(sx, sy);
          if (d > 0 && d < 0.3) {
            mx += (sx / d) * (0.3 - d) * 3;
            my += (sy / d) * (0.3 - d) * 3;
          }
        });
        const mlen = Math.hypot(mx, my);
        const speed = def.speed * speedMult * (e.pain > 0 ? 0.3 : 1) * (e.attackAnim > 0 ? 0.2 : 1);
        if (mlen > 0) {
          e.x += (mx / mlen) * speed * dt;
          e.y += (my / mlen) * speed * dt;
        }

        if (state !== "playing" && state !== "intermission") return;
        e.attackTimer -= dt;
        if (e.type === "pinky") {
          if (dist < BITE_RANGE_M && e.attackTimer <= 0 && ar.feet() < 0.12) {
            e.attackTimer = 1.1 * diff.attack;
            e.attackAnim = 0.25;
            damagePlayer(rand(10, 15));
          }
        } else if (e.attackTimer <= 0 && dist < 5) {
          e.attackAnim = 0.45;
          e.attackTimer = (e.type === "caco" ? rand(3.5, 6) : rand(2.5, 4.5)) * diff.attack;
        }
        if (e.attackAnim > 0) {
          e.attackAnim -= dt;
          if (e.attackAnim <= 0 && e.type !== "pinky") launchFireball(e, cam);
        }
      });
      enemies = enemies.filter((e) => e.state !== "dead" || e.deadTime < 6);

      // Projectiles fly in 3D toward where the camera was at launch.
      shots.forEach((s) => {
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.h += s.vh * dt;
        s.age += dt;
        const d = Math.hypot(s.x - cam.x, s.y - cam.y, s.h - cam.h);
        if (d < PLAYER_HIT_RADIUS_M + s.r) {
          s.dead = true;
          damagePlayer(s.dmg);
          effects.push({ x: s.x, y: s.y, h: s.h, t: 0, big: s.r > 0.05 });
          Lynx.sfx.play("explode");
        } else if (s.h < 0 || s.age > 12) {
          s.dead = true;
          effects.push({ x: s.x, y: s.y, h: Math.max(s.h, 0.02), t: 0, big: false });
        }
      });
      shots = shots.filter((s) => !s.dead);
      effects.forEach((f) => (f.t += dt));
      effects = effects.filter((f) => f.t < 0.5);

      // Pickups: drive over them.
      pickups = pickups.filter((k) => {
        k.phase += dt * 3;
        if (state !== "playing" && state !== "intermission") return true;
        if (Math.hypot(k.x - px, k.y - py) > PICKUP_RADIUS_M) return true;
        if (k.kind === "medkit") {
          if (p.health >= 100) return true; // leave it for later
          p.health = Math.min(100, p.health + 25);
        } else if (k.kind === "bullets") p.bullets = Math.min(MAX_BULLETS, p.bullets + 20);
        else if (k.kind === "shells") p.shells = Math.min(MAX_SHELLS, p.shells + 4);
        else if (k.kind === "armor") p.armor = Math.min(200, p.armor + 50);
        else if (k.kind === "chaingun") {
          p.owned[3] = true;
          p.weapon = 3;
          p.bullets = Math.min(MAX_BULLETS, p.bullets + 20);
        }
        pickupFlash = 0.3;
        faceKind = "grin";
        faceTimer = 0.8;
        Lynx.sfx.play("pickup");
        return false;
      });
    }

    function launchFireball(e, cam) {
      const def = ENEMY[e.type];
      const startH = (def.floatM || 0) + def.heightM * 0.6;
      const dx = cam.x - e.x;
      const dy = cam.y - e.y;
      const dh = cam.h - startH;
      const len = Math.hypot(dx, dy, dh) || 1;
      const big = e.type === "caco";
      const speed = (big ? 0.4 : 0.55) * diff.shotSpeed;
      shots.push({
        x: e.x + (dx / len) * 0.08, y: e.y + (dy / len) * 0.08, h: startH,
        vx: (dx / len) * speed, vy: (dy / len) * speed, vh: (dh / len) * speed,
        r: big ? 0.06 : 0.04, dmg: big ? rand(15, 20) : rand(8, 12), age: 0, big,
      });
      Lynx.sfx.play("fireball");
    }

    // -- drawing ------------------------------------------------------------------
    const FIRE_STOPS = [[0, "rgba(255,255,210,1)"], [0.35, "rgba(255,170,40,0.95)"], [0.75, "rgba(255,60,10,0.6)"], [1, "rgba(255,30,0,0)"]];
    const PLASMA_STOPS = [[0, "rgba(255,230,255,1)"], [0.4, "rgba(255,80,220,0.9)"], [1, "rgba(160,0,255,0)"]];

    function drawWorld() {
      const ctx = ar.ctx;
      enemies.forEach((e) => {
        const def = ENEMY[e.type];
        const dead = e.state === "dead";
        let spr;
        if (dead) spr = sprites[e.type + "Dead"];
        else {
          const frames = sprites[e.type];
          spr = frames[Math.floor(e.anim) % frames.length];
        }
        const floatH = dead ? 0 : (def.floatM || 0) + (def.floatM ? Math.sin(e.anim * 1.3) * 0.02 : 0);
        const rect = ar.spriteRect(spr, e.x, e.y, floatH, def.heightM * (dead ? 1.0 : 1));
        e.rect = dead ? null : rect;
        if (!rect) return;
        ar.queue(rect.depth, () => {
          // contact shadow
          ar.floorCircle(e.x, e.y, def.heightM * 0.3, "rgba(0,0,0,0.35)");
          ar.drawSprite(spr, rect, {
            alpha: dead ? Math.min(1, (6 - e.deadTime) / 1.5) : 1,
            flip: !dead && Math.floor(e.anim * 0.5) % 2 === 1 && e.type !== "caco",
            tint: e.pain > 0 ? "rgba(255,255,255,0.55)" : null,
          });
          if (!dead && e.attackAnim > 0 && e.type !== "pinky") {
            const s = e.type === "caco" ? PLASMA_STOPS : FIRE_STOPS;
            const glowR = rect.w * 0.25 * (1 + (0.45 - e.attackAnim) * 2);
            ar.glow(rect.x + rect.w * 0.5, rect.y + rect.h * 0.35, glowR, s);
          }
        });
      });

      shots.forEach((s) => {
        const pr = ar.project(s.x, s.y, s.h);
        if (!pr) return;
        ar.queue(pr.depth, () => {
          ar.floorCircle(s.x, s.y, s.r * 0.8, "rgba(0,0,0,0.25)");
          ar.glow(pr.x, pr.y, Math.max(3, s.r * 1.6 * pr.ppm), s.big ? PLASMA_STOPS : FIRE_STOPS);
        });
      });

      effects.forEach((f) => {
        const pr = ar.project(f.x, f.y, f.h);
        if (!pr) return;
        const r = (f.big ? 0.18 : 0.12) * (0.3 + f.t * 2) * pr.ppm;
        ar.queue(pr.depth, () => ar.glow(pr.x, pr.y, r, FIRE_STOPS, 1 - f.t / 0.5));
      });

      pickups.forEach((k) => {
        const spr = sprites[k.kind];
        const hover = 0.02 + Math.sin(k.phase) * 0.01;
        const rect = ar.spriteRect(spr, k.x, k.y, hover, PICKUP_HEIGHT[k.kind]);
        if (!rect) return;
        ar.queue(rect.depth, () => {
          ar.floorCircle(k.x, k.y, 0.07, "rgba(120,255,140,0.18)", "rgba(120,255,140,0.5)");
          ar.drawSprite(spr, rect);
        });
      });
      ar.flush();
    }

    function drawHud() {
      const ctx = ar.ctx;
      const v = ar.view;
      ar.flash("#ff0000", hurtFlash * 0.6);
      ar.flash("#ffe070", pickupFlash * 0.4);

      if (state === "playing" || state === "intermission") {
        if (cfg.arrows) {
          enemies.forEach((e) => e.state === "alive" && ar.edgeArrow(e.x, e.y, ENEMY[e.type].heightM / 2, "#ff4030"));
        }
        if (cfg.radar) {
          const blips = [];
          enemies.forEach((e) => e.state === "alive" && blips.push({ x: e.x, y: e.y, color: "#ff4030", r: e.type === "caco" ? 4 : 3 }));
          pickups.forEach((k) => blips.push({ x: k.x, y: k.y, color: k.kind === "medkit" ? "#ffffff" : "#ffd040", r: 2.5 }));
          shots.forEach((s) => blips.push({ x: s.x, y: s.y, color: "#ffa000", r: 2 }));
          ar.radar(blips, spawnR + 0.8);
        }
        ar.crosshair("rgba(255,255,255,0.9)", 10, 3);
      }

      // Weapon, bottom center, bobbing as the robot drives.
      const barH = Math.max(40, Math.min(v.h * 0.13, 84));
      const barW = Math.min(v.w * 0.86, 720);
      const barX = v.cx - barW / 2;
      const barY = v.y + v.h - barH;
      if (state !== "title") {
        const gun = sprites.guns[p.weapon];
        const gh = v.h * (p.weapon === 2 ? 0.24 : p.weapon === 3 ? 0.22 : 0.19);
        const gw = (gh * gun.width) / gun.height;
        const kick = cooldown > 0 ? Math.max(0, cooldown / WEAPONS[p.weapon].cooldown - 0.6) * gh * 0.3 : 0;
        const gx = v.cx - gw / 2 + Math.sin(bob) * v.w * 0.012;
        const gy = barY - gh + Math.abs(Math.cos(bob)) * gh * 0.05 + kick + (state === "dead" ? stateTime * gh : 0);
        if (muzzle > 0) ar.glow(v.cx, gy - gh * 0.05, gh * 0.35, FIRE_STOPS);
        ctx.save();
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(gun, gx, gy, gw, gh);
        ctx.restore();
      }

      // Status bar: AMMO | HEALTH | ARMS | face | ARMOR | WAVE/SCORE
      ctx.save();
      const grd = ctx.createLinearGradient(0, barY, 0, barY + barH);
      grd.addColorStop(0, "rgba(90,86,80,0.92)");
      grd.addColorStop(1, "rgba(50,46,42,0.92)");
      ctx.fillStyle = grd;
      ctx.fillRect(barX, barY, barW, barH);
      ctx.strokeStyle = "rgba(20,20,20,0.9)";
      ctx.lineWidth = 2;
      ctx.strokeRect(barX, barY, barW, barH);
      ctx.restore();
      const cols = [0.15, 0.13, 0.13, 0.12, 0.13, 0.34];
      let cx = barX;
      const cells = cols.map((c) => {
        const cell = { x: cx, w: c * barW };
        cx += cell.w;
        return cell;
      });
      const bigSize = barH * 0.46;
      const labelSize = Math.max(9, barH * 0.17);
      const digit = (txt, cell, color = "#e02010") =>
        ar.text(txt, cell.x + cell.w / 2, barY + barH * 0.58, { size: bigSize, align: "center", color, font: "Impact, 'Arial Black', sans-serif", weight: "normal" });
      const label = (txt, cell) => ar.text(txt, cell.x + cell.w / 2, barY + barH * 0.9, { size: labelSize, align: "center", color: "#d8d0c0" });
      const w = WEAPONS[p.weapon];
      digit(String(p[w.ammo]), cells[0]);
      label("AMMO", cells[0]);
      digit(`${Math.ceil(p.health)}%`, cells[1]);
      label("HEALTH", cells[1]);
      [1, 2, 3].forEach((i) => {
        ar.text(String(i), cells[2].x + cells[2].w * (0.25 + (i - 1) * 0.25), barY + barH * 0.52, {
          size: barH * 0.3, align: "center", color: p.weapon === i ? "#ffe040" : p.owned[i] ? "#f0e8d0" : "#6a6258", outline: false,
        });
      });
      label("ARMS", cells[2]);
      const face = state === "dead" ? sprites.faces.wrecked
        : faceKind !== "ok" ? sprites.faces[faceKind]
        : p.health > 60 ? sprites.faces.ok : p.health > 30 ? sprites.faces.hurt : sprites.faces.wrecked;
      const fh = barH * 0.86;
      const fw = (fh * face.width) / face.height;
      ar.ctx.save();
      ar.ctx.imageSmoothingEnabled = false;
      ar.ctx.fillStyle = "#1a1612";
      ar.ctx.fillRect(cells[3].x + cells[3].w / 2 - fw / 2 - 3, barY + (barH - fh) / 2 - 2, fw + 6, fh + 4);
      ar.ctx.drawImage(face, cells[3].x + cells[3].w / 2 - fw / 2, barY + (barH - fh) / 2, fw, fh);
      ar.ctx.restore();
      digit(`${Math.floor(p.armor)}%`, cells[4]);
      label("ARMOR", cells[4]);
      ar.text(`WAVE ${wave}   KILLS ${kills}`, cells[5].x + 10, barY + barH * 0.38, { size: labelSize * 1.2, color: "#f0e8d0" });
      ar.text(`SCORE ${score}`, cells[5].x + 10, barY + barH * 0.75, { size: labelSize * 1.5, color: "#ffd040" });
      ar.text(`${w.name}  bullets ${p.bullets}  shells ${p.shells}`, barX + 4, barY - 6, { size: labelSize, color: "#e8e0d0", alpha: 0.9 });

      if (state === "title") {
        ar.flash("#000", 0.45);
        ar.banner("DOOM", "Press FIRE to start  (Space / \u{1F525} button)");
        ar.text("WASD drive · arrows / Q E look · 1-3 or Tab weapons · drive over pickups", v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
        if (best !== null) ar.text(`Best on this robot: ${best}`, v.cx, v.cy + v.h * 0.27, { size: 14, align: "center", color: "#ffd040" });
      } else if (state === "intermission") {
        ar.banner(`WAVE ${wave} CLEARED`, `+${500 * wave} bonus · next wave in ${Math.max(0, Math.ceil(4 - stateTime))}`, { color: "#ffd040" });
      } else if (state === "playing" && stateTime < 2.5) {
        ar.banner(`WAVE ${wave}`, wave === 3 ? "Chaingun dropped nearby!" : "", { alpha: Math.min(1, 2.5 - stateTime) });
      } else if (state === "dead") {
        ar.flash("#600000", Math.min(0.5, stateTime * 0.3));
        ar.banner("YOU DIED", `Score ${score} · wave ${wave} · ${kills} kills`);
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.18, { size: 16, align: "center", color: "#ffd040" });
        if (stateTime > 1.5) ar.text("Press FIRE to play again", v.cx, v.cy + v.h * 0.25, { size: 14, align: "center" });
      }
    }

    ar.onFrame((now, dt) => {
      update(dt);
      drawWorld();
      drawHud();
    });

    return {
      actionLabel: "\u{1F525} Fire",
      // Read-only snapshot for debugging from the browser console.
      snapshot: () => ({ state, wave, score, kills, health: p.health, weapon: p.weapon, bullets: p.bullets,
        enemies: enemies.map((e) => ({ type: e.type, x: +e.x.toFixed(2), y: +e.y.toFixed(2), hp: Math.round(e.hp), state: e.state })) }),
    };
  };
})(window.Lynx);
