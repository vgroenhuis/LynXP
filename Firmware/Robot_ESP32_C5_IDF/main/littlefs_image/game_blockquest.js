// Block Quest -- Knight on Blocks (game_knightblocks.js) with real levels.
//
// The knight, the robot's drive and camera, the cube finder and the blocks
// are Knight on Blocks's, unchanged: this file is the game that rides on it
// (the `ext` hooks there). What it adds:
//   - levels (blockquest_levels.js) laid out round the FRAME CUBE: each one
//     starts with a placement guide -- a checklist and ghost footprints on
//     the floor in the video -- telling where each tagged cube goes, and
//     starts when they stand there (the frame cube sets the world frame, so
//     the layout lines up with the real cubes wherever the robot is);
//   - combat: sword (a three-hit combo), shield (hold it up to block, raise
//     it just as a blow lands to parry), shield bash, bombs set by hand and
//     set off from a distance, enemies that wind up before they strike;
//   - things painted over the video: lava and stone floors, skins on the
//     real blocks (stone, timber, basalt...), props, fire, explosions;
//   - hearts, pickups, hazards (lava, geysers), barricades, gates.
//
// Controls (on top of Knight on Blocks's): hold X / gamepad B / touch Shield
// to block; Fire while the shield is up: bash; B / RB / Tab: set a bomb;
// E / LB: detonate every bomb set; H: show where the cubes go; L: level menu.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  Lynx.games.blockquest = (ar, cfg, app) => Lynx.games.knightblocks(ar, cfg, app, (api) => Lynx.blockQuest(api));

  const DIFF = {
    easy: { hp: 0.7, windup: 1.35, speed: 0.8, dmg: 1 },
    normal: { hp: 1, windup: 1, speed: 1, dmg: 1 },
    hard: { hp: 1.3, windup: 0.78, speed: 1.2, dmg: 1 },
  };
  const PARRY_S = 0.26; // a shield raised this recently when the blow lands parries it
  const INV_S = 1.3;
  const HIT = { 1: [0.32, 0.56], 2: [0.32, 0.56], 3: [0.4, 0.62] };
  const POWER = { 1: 1, 2: 1, 3: 2 };
  const SETUP_OK_S = 2.0;
  const FRAME_AHEAD_M = 0.3; // laying out, the frame cube not found yet: the camera looks this far ahead of the robot
  const STORE = "blockquestDone";

  Lynx.blockQuest = (api) => {
    const { ar, w, K, C, S, hero, cfg, cubes } = api;
    const { clamp, wrap } = api.util;
    const LEVELS = Lynx.blockQuestLevels || [];
    const fx = Lynx.bqFx(ar, w);
    const diffKey = cfg.difficulty in DIFF ? cfg.difficulty : "normal";
    const BODY = C.BODY_H;
    const maxHearts = clamp(Math.round(+cfg.hearts) || 5, 1, 9);
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
      phase: "menu", // menu | setup | play | won | lost
      sel: 0, idx: -1, lv: null, t: 0, time: 0, levelTime: 0,
      maxHearts, hearts: maxHearts, bombs: 0, score: 0, U: clamp((+cfg.blockCm || 5) / 100, 0.02, 0.1), diff: DIFF[diffKey], diffKey,
      stats: { kills: 0, damage: 0, bombs: 0, parries: 0 },
      okT: 0, anywayAt: -1e9, focus: 0, focusManual: null, focusManualOk: false, items: null, done: new Set(store.get()), userCam: api.camDist(), frameOk: false, shake: 0, flash: null, hint: false, wonT: 0, lostT: 0,
      get heroAlive() { return this.hearts > 0; },
      skins: cfg.skins !== false,
    };
    const SH = { up: false, raisedT: 0, energy: 1, broken: 0, bashCd: 0, bashT: 0 };
    hero.inv = 0;
    hero.hurtT = 0;
    hero.deadT = 0;

    // -- coordinates: the level's own frame is the world frame (x away from the robot, y to the left), in cube sizes
    const toF = (x, y) => w.toLocal(x * G.U, y * G.U);
    const toUnits = (f, r) => {
      const p = w.toWorld(f, r);
      return [p.x / G.U, p.y / G.U];
    };
    const floorYaw = (deg) => w.anchor().th - (deg * Math.PI) / 180;
    const heroU = () => toUnits(hero.f, hero.r);
    const inRect = (u, r) => u[0] >= r[0] && u[0] <= r[2] && u[1] >= r[1] && u[1] <= r[3];

    // -- the cubes ---------------------------------------------------------------------------------------
    const frameBlock = () => api.realSolids.find((b) => cubes.frameCube(b.tag));
    const blockOf = (tag) => (tag === "frame" ? frameBlock() : api.realSolids.find((b) => b.tag === tag && !b.inferred) || api.realSolids.find((b) => b.tag === tag));
    function cube(tag) {
      const b = blockOf(tag);
      if (!b) return null;
      const p = w.toWorld(b.cf, b.cr);
      const size = b.half * 2;
      return { b, tag, x: p.x / G.U, y: p.y / G.U, mx: p.x, my: p.y, f: b.cf, r: b.cr, size, stack: Math.round(b.h0 / size), top: b.h1, h0: b.h0, yawW: b.world ? b.world.yaw : 0 };
    }
    // the size of the cubes in use: the median of what the cube finder has measured for the tags 0-5 (else the setting)
    function measureU() {
      const ids = (api.tb.state.ids || []).filter((i) => i.id >= 0 && i.id <= 5 && i.cm > 0);
      if (!ids.length) return clamp((+cfg.blockCm || 5) / 100, 0.02, 0.1);
      const v = ids.map((i) => i.cm).sort((a, b) => a - b);
      return v[v.length >> 1] / 100;
    }
    const heroOnTag = () => {
      if (!hero.onGround || hero.standOn === null) return null;
      const b = api.realSolids.find((s) => s.id === hero.standOn);
      if (!b) return null;
      return cubes.frameCube(b.tag) ? "frame" : b.tag;
    };

    // -- the level's things ------------------------------------------------------------------------------
    const E = { pickups: [], geysers: [], barricades: [], gates: [], walls: [], props: [], zones: {}, lava: null, flags: {}, plates: [], beams: null, extraSolids: [], effects: [] };
    let time = 0;
    function say(text, color) {
      api.say(text, color);
    }
    const sfx = (n) => api.sfx(n);
    const addScore = (n) => (G.score += n);
    const cx = {
      api, fx, hero, G, say, sfx, addScore,
      photo: () => photo(),
      hurtHero: (...a) => hurtHero(...a),
      dropPickup: (kind, f, r, z) => addPickup(kind, { f, r, z, dyn: true }),
      shake: (k) => (G.shake = Math.max(G.shake, k)),
      onKill: (e) => lv() && lv().onKill && lv().onKill(L, e),
      onBlast: (f, r, z, rad, o) => {
        // barricades in reach crumble
        E.barricades.forEach((b) => {
          if (b.dead) return;
          const c = barricadeCenter(b);
          if (Math.hypot(c.f - f, c.r - r) < rad + b.len * G.U * 0.5 + 0.01) destroyBarricade(b);
        });
        if (lv() && lv().onBlast) lv().onBlast(L, f, r, z, rad, o);
      },
      onKeg: (k) => lv() && lv().onKeg && lv().onKeg(L, k),
    };
    const A = Lynx.bqActors(cx);
    const lv = () => G.lv;

    // -- lit 3D figures (blockquest_gl.js / blockquest_figures.js), or the flat sprites without WebGL2 --------------
    let PH = null;
    let phTried = false;
    function photo() {
      if (cfg.photoreal === false || cfg.photoreal === "false" || cfg.photoreal === "off") return null;
      if (!phTried) {
        phTried = true;
        try {
          const R = Lynx.bqGL && Lynx.bqFigures ? Lynx.bqGL(ar, w, cfg) : null;
          if (R && R.ok) PH = { R, M: Lynx.bqFigures(R) };
        } catch {
          PH = null;
        }
      }
      return PH && PH.R.ok ? PH : null;
    }
    // what lights the figures this frame: braziers, fuses, blasts, geysers, the glow of lava underfoot
    function photoEnv() {
      const ph = photo();
      if (!ph) return;
      const lights = [];
      E.props.forEach((p) => {
        if (p.kind !== "brazier") return;
        let l;
        let z = 0;
        if (p.tag !== null && p.tag !== undefined) {
          const c = cube(p.tag);
          if (!c) return;
          l = { f: c.f, r: c.r };
          z = c.top;
        } else {
          l = toF(p.at[0], p.at[1]);
          z = api.groundAt(l.f, l.r, 1, 1).h;
        }
        lights.push({ f: l.f, r: l.r, h: z + 0.02, col: [1, 0.52, 0.2], rad: 0.13, k: 1.7 + 0.35 * Math.sin(time * 13 + l.f * 50) });
      });
      A.bombs.forEach((b) => lights.push({ f: b.f, r: b.r, h: b.z + 0.012, col: b.fuse ? [1, 0.7, 0.3] : [1, 0.1, 0.06], rad: b.fuse ? 0.06 : 0.03, k: b.fuse ? 1.8 : 0.9 * (0.5 + 0.5 * Math.sin(time * 5 + b.blink * 6)) }));
      A.kegs.forEach((k) => k.state === "fuse" && lights.push({ f: k.f, r: k.r, h: k.z + k.height + 0.01, col: [1, 0.7, 0.3], rad: 0.07, k: 1.8 }));
      A.blasts.forEach((b) => {
        const a = clamp(1 - b.t / 0.8, 0, 1);
        if (a > 0) lights.push({ f: b.f, r: b.r, h: b.z + 0.025, col: [1, 0.72, 0.4], rad: b.rad * 3 + 0.06, k: 5 * a });
      });
      E.geysers.forEach((g) => (g.state === "erupt" || g.state === "warn") && lights.push({ f: g.f, r: g.r, h: 0.015, col: [1, 0.45, 0.12], rad: 0.1, k: g.state === "erupt" ? 2.4 : 0.9 }));
      const lava = !!E.lava && G.phase !== "menu";
      ph.R.setEnv({
        ground: lava ? [0.95, 0.34, 0.09] : [0.30, 0.27, 0.24],
        sky: lava ? [0.55, 0.45, 0.45] : [0.62, 0.68, 0.8],
        key: lava ? [1.0, 0.82, 0.62] : [1.0, 0.94, 0.82],
        lights,
      });
      ph.R.setTime(time);
    }

    // pickups
    function addPickup(kind, o = {}) {
      const p = { kind, at: o.at || null, f: o.f || 0, r: o.r || 0, z: o.z || 0, tag: o.tag === undefined ? null : o.tag, lift: o.lift || 0, taken: false, t: Math.random() * 6, dyn: !!o.dyn, onTake: o.onTake || null, color: o.color, name: o.name || null, size: o.size || 1, id: o.id || null, hidden: !!o.hidden, art: o.art || null, need: o.need || null };
      E.pickups.push(p);
      return p;
    }
    function pickupPos(p) {
      if (p.at) {
        const l = toF(p.at[0], p.at[1]);
        p.f = l.f;
        p.r = l.r;
      }
      if (p.tag !== null) {
        const c = cube(p.tag);
        if (c) {
          p.f = c.f;
          p.r = c.r;
          p.z = c.top + p.lift;
        } else p.missing = true;
        if (c) p.missing = false;
      } else if (p.at && p.autoZ !== false && !p.fixedZ) {
        p.z = api.groundAt(p.f, p.r, 1, 1).h + p.lift;
      }
    }

    // barricades: a wall of rubble across a way, brought down by a blast only
    function barricadeSquares(b) {
      const thick = (b.thick || 0.6) * G.U;
      const n = Math.max(1, Math.round((b.len * G.U) / thick));
      const out = [];
      const ang = (b.angle * Math.PI) / 180; // the wall's long axis, a world heading
      for (let i = 0; i < n; i++) {
        const s = ((i + 0.5) / n - 0.5) * b.len * G.U;
        const c = toF((b.at[0] * G.U + Math.cos(ang) * s) / G.U, (b.at[1] * G.U + Math.sin(ang) * s) / G.U);
        out.push({ id: `bar${b.id}:${i}`, cf: c.f, cr: c.r, yaw: w.anchor().th - ang, half: thick / 2 * 1.02, h0: 0, h1: b.height * G.U * (0.9 + 0.2 * ((i * 7 + b.id) % 3) / 2), virtual: true, barricade: b, tag: -1 });
      }
      return out;
    }
    function barricadeCenter(b) {
      return toF(b.at[0], b.at[1]);
    }
    function destroyBarricade(b) {
      if (b.dead) return;
      b.dead = true;
      b.deadT = 0;
      const c = barricadeCenter(b);
      for (let i = 0; i < 26; i++) {
        const a = Math.random() * 6.28;
        const d = Math.random() * b.len * G.U * 0.5;
        fx.parts.emit("debris", c.f + Math.cos(a) * d, c.r + Math.sin(a) * d, rnd(0.004, b.height * G.U), 1, 0.002, { speed: 0.06, up: 0.08 });
      }
      fx.parts.emit("dust", c.f, c.r, 0.01, 10, b.len * G.U * 0.4, { speed: 0.03, up: 0.02 });
      sfx("crate");
      if (b.onBreak) b.onBreak(L);
    }
    const rnd = (a, b) => a + Math.random() * (b - a);

    // gates (portcullis): shut until opened
    function gateSquares(g) {
      if (g.lift >= 0.97) return [];
      const thick = 0.35 * G.U;
      const n = Math.max(1, Math.round((g.len * G.U) / thick));
      const ang = (g.angle * Math.PI) / 180;
      const out = [];
      for (let i = 0; i < n; i++) {
        const s = ((i + 0.5) / n - 0.5) * g.len * G.U;
        const c = toF((g.at[0] * G.U + Math.cos(ang) * s) / G.U, (g.at[1] * G.U + Math.sin(ang) * s) / G.U);
        out.push({ id: `gate${g.id}:${i}`, cf: c.f, cr: c.r, yaw: w.anchor().th - ang, half: thick / 2, h0: 0, h1: g.height * G.U * (1 - g.lift), virtual: true, tag: -1 });
      }
      return out;
    }

    // -- the level's context: what a level uses to lay itself out ------------------------------------------
    const L = {
      api, w, fx, A, G, E, hero, K,
      get U() { return G.U; },
      f: toF, world: (x, y) => ({ x: x * G.U, y: y * G.U }), units: toUnits, heroU, yawOf: floorYaw, rnd,
      cube, frame: () => cube("frame"), heroOn: heroOnTag, inRect,
      say, sfx, score: addScore, time: () => G.levelTime, clock: () => time,
      enemy(kind, at, o = {}) {
        const l = toF(at[0], at[1]);
        const e = A.spawn(kind, l.f, l.r, { ...o, yaw: o.yawDeg === undefined ? (o.yaw === undefined ? undefined : o.yaw) : floorYaw(o.yawDeg) });
        return e;
      },
      pickup(kind, at, o = {}) {
        return addPickup(kind, { ...o, at });
      },
      geyser(at, o = {}) {
        E.geysers.push({ at, period: o.period || 4.6, phase: o.phase || 0, warn: o.warn || 1.1, erupt: o.erupt || 1.1, radius: (o.radius || 0.3) * G.U, tall: o.tall || 0.07 });
      },
      barricade(o) {
        const b = { id: E.barricades.length + 1, at: o.at, len: o.len || 3, angle: o.angle || 90, height: o.height || 1.2, thick: o.thick || 0.6, dead: false, deadT: 0, onBreak: o.onBreak || null };
        E.barricades.push(b);
        return b;
      },
      gate(o) {
        const g = { id: E.gates.length + 1, at: o.at, len: o.len || 3, angle: o.angle || 90, height: o.height || 1.3, lift: o.open ? 1 : 0, open: !!o.open };
        E.gates.push(g);
        return g;
      },
      // a plain wall (never falls): at the middle, len along its axis (a world heading in degrees), in cube sizes
      wall(o) {
        const b = { id: 100 + E.walls.length, at: o.at, len: o.len || 3, angle: o.angle === undefined ? 90 : o.angle, height: o.height || 1.3, thick: o.thick || 0.7, style: o.style || "dark" };
        E.walls.push(b);
        return b;
      },
      keg(o) {
        if (o.at) {
          const l = toF(o.at[0], o.at[1]);
          return A.addKeg({ f: l.f, r: l.r });
        }
        return A.addKeg({ tag: o.tag });
      },
      brazier(at, o = {}) {
        E.props.push({ kind: "brazier", at, h: o.h || 0.012, tag: o.tag === undefined ? null : o.tag });
      },
      prop(p) {
        E.props.push(p);
        return p;
      },
      zone(name, rect) {
        E.zones[name] = rect;
      },
      inZone: (name, u) => inRect(u || heroU(), E.zones[name]),
      lava(rect) {
        E.lava = { rect, burnT: 0 };
      },
      flag: (k, v) => (v === undefined ? E.flags[k] : (E.flags[k] = v)),
      win: (msg) => winLevel(msg),
      target: null,
      obj: "",
      bombs: (n) => (G.bombs += n),
      hurt: (dmg, f, r, o) => hurtHero(dmg, f, r, o),
      heal: () => {
        if (G.hearts < G.maxHearts) {
          G.hearts++;
          return true;
        }
        addScore(100);
        return false;
      },
      toast: say,
      shake: cx.shake,
      respawnAt: null,
    };

    // -- the knight: shield, hurt, die ------------------------------------------------------------------------
    function hurtHero(dmg, sf, sr, o = {}) {
      if (!G.heroAlive || G.phase !== "play") return { hurt: false };
      if (hero.inv > 0 && !o.force) return { hurt: false, blocked: false };
      const ang = Math.atan2(sr - hero.r, sf - hero.f);
      const front = Math.abs(wrap(ang - hero.yaw)) < 1.35;
      if (SH.up && front && !o.unblockable) {
        const parry = !!o.parryable && SH.raisedT < PARRY_S;
        SH.energy = Math.max(0, SH.energy - (parry ? 0 : o.energy !== undefined ? o.energy : 0.25));
        const px = hero.f + Math.cos(hero.yaw) * 0.008;
        const py = hero.r + Math.sin(hero.yaw) * 0.008;
        fx.parts.emit("spark", px, py, hero.z + BODY * 0.55, parry ? 14 : 7, 0.003, { speed: 0.08 });
        sfx(parry ? "zap" : "knock");
        hero.inv = 0.25;
        if (parry) {
          G.stats.parries++;
          say("PARRY!", "#a0e8ff");
          addScore(50);
          G.flash = { color: "rgba(160,230,255,0.18)", t: 0 };
        } else if (SH.energy <= 0.001) {
          SH.up = false;
          SH.broken = 1.2;
          say("Your shield arm gives out!", "#ff9070");
        }
        return { hurt: false, blocked: true, parried: parry };
      }
      G.hearts = Math.max(0, G.hearts - dmg);
      G.stats.damage += dmg;
      hero.hurtT = 0.35;
      hero.inv = INV_S;
      hero.attack = null;
      const k = Math.atan2(hero.r - sr, hero.f - sf);
      hero.vf += Math.cos(k) * 0.1;
      hero.vr += Math.sin(k) * 0.1;
      sfx("hurt");
      G.flash = { color: "rgba(255,30,20,0.28)", t: 0 };
      G.shake = Math.max(G.shake, 0.4);
      if (!G.heroAlive) {
        hero.deadT = 0.001;
        SH.up = false;
        sfx("lose");
      } else if (o.say) say(o.say, "#ff8070");
      return { hurt: true };
    }
    function updateShield(dt) {
      const want = !!Lynx.input.shieldHeld && G.phase === "play" && G.heroAlive && hero.mode === "move" && !hero.attack && SH.broken <= 0;
      if (want && !SH.up) {
        SH.up = true;
        SH.raisedT = 0;
        sfx("click");
      }
      if (!want) SH.up = false;
      SH.broken = Math.max(0, SH.broken - dt);
      SH.bashCd = Math.max(0, SH.bashCd - dt);
      SH.bashT = Math.max(0, SH.bashT - dt);
      if (SH.up) {
        SH.raisedT += dt;
        SH.energy = Math.max(0, SH.energy - 0.035 * dt);
        if (SH.energy <= 0) {
          SH.up = false;
          SH.broken = 1.2;
          say("Your shield arm gives out!", "#ff9070");
        }
      } else SH.energy = Math.min(1, SH.energy + 0.14 * dt);
    }
    function bash() {
      if (SH.bashCd > 0) return;
      SH.bashCd = 0.8;
      SH.bashT = 0.22;
      SH.energy = Math.max(0, SH.energy - 0.1);
      hero.vf += Math.cos(hero.yaw) * 0.05;
      hero.vr += Math.sin(hero.yaw) * 0.05;
      A.bash();
      sfx("swing");
    }
    // the sword's blow: what the swing reaches while its edge is out
    function swordHits() {
      const a = hero.attack;
      if (!a || hero.mode !== "move") return;
      const win = HIT[a.n];
      if (!win || a.u < win[0] || a.u > win[1]) return;
      a.hits = a.hits || new Set();
      const res = A.swordHit(a, win, POWER[a.n]);
      if (res.length && res.some(Boolean)) {
        G.flash = G.flash || { color: "rgba(255,255,255,0.05)", t: 0 };
      }
    }
    function updateHeroTimers(dt) {
      hero.inv = Math.max(0, hero.inv - dt);
      hero.hurtT = Math.max(0, hero.hurtT - dt);
      if (hero.deadT > 0) {
        hero.deadT += dt;
        if (hero.deadT > 2.2 && G.phase === "play") {
          G.phase = "lost";
          G.t = 0;
        }
      }
    }

    // -- hazards: lava and geysers ----------------------------------------------------------------------------
    let safeSpot = null;
    function updateHazards(dt) {
      // the last block it stood on
      if (hero.onGround && hero.standOn !== null && hero.mode === "move") {
        const b = api.realSolids.find((s) => s.id === hero.standOn);
        if (b) {
          const [u, v] = api.toB(b, hero.f, hero.r);
          safeSpot = { tag: b.tag, u: clamp(u, -b.half * 0.5, b.half * 0.5), v: clamp(v, -b.half * 0.5, b.half * 0.5), t: safeSpot && safeSpot.tag === b.tag ? safeSpot.t + dt : 0 };
        }
      }
      if (E.lava) {
        const hu = heroU();
        const inLava = inRect(hu, E.lava.rect) && hero.onGround && hero.standOn === null && hero.z < 0.003 && hero.mode === "move";
        if (inLava) {
          E.lava.burnT += dt;
          if (Math.random() < dt * 30) fx.parts.emit("ember", hero.f, hero.r, hero.z + 0.002, 1, 0.004, { up: 0.05 });
          if (E.lava.burnT > 0.2) {
            E.lava.burnT = 0;
            lavaBurn();
          }
        } else E.lava.burnT = 0;
      }
      E.geysers.forEach((g) => {
        const t = (G.levelTime + g.phase) % g.period;
        g.state = t < g.period - g.warn - g.erupt ? "idle" : t < g.period - g.erupt ? "warn" : "erupt";
        const l = toF(g.at[0], g.at[1]);
        g.f = l.f;
        g.r = l.r;
        if (g.state === "warn" && Math.random() < dt * 16) fx.parts.emit("ember", g.f, g.r, 0.002, 1, g.radius * 0.7, { up: 0.04 });
        if (g.state === "erupt") {
          if (Math.random() < dt * 40) fx.parts.emit("ember", g.f, g.r, 0.01 + Math.random() * 0.05, 1, g.radius * 0.6, { up: 0.1 });
          if (G.heroAlive && !g.harmless && Math.hypot(hero.f - g.f, hero.r - g.r) < g.radius && hero.z < g.tall) {
            hurtHero(1, g.f, g.r, { unblockable: true, say: "Scorched by a lava geyser -- cross between eruptions" });
          }
        }
        if (g.state !== g.last && g.state === "erupt") sfx("fireball");
        g.last = g.state;
      });
    }
    function lavaBurn() {
      sfx("hurt");
      const res = hurtHero(1, hero.f, hero.r, { unblockable: true, force: false, say: "The lava burns! Back to the last stone" });
      fx.parts.emit("spark", hero.f, hero.r, 0.003, 10, 0.004, { speed: 0.08, up: 0.1 });
      if (!G.heroAlive) return;
      if (res.hurt || hero.inv > 0) respawnOnStone();
    }
    function respawnOnStone() {
      let spot = null;
      if (safeSpot) {
        const b = api.realSolids.find((s) => s.tag === safeSpot.tag);
        if (b) {
          const [f, r] = api.fromB(b, safeSpot.u * 0.3, safeSpot.v * 0.3);
          spot = { f, r };
        }
      }
      if (!spot) {
        const sp = lv().spawn;
        const l = toF(sp.at[0], sp.at[1]);
        spot = { f: l.f, r: l.r };
      }
      api.placeHero(spot.f, spot.r, hero.yaw);
    }

    // -- pickups -----------------------------------------------------------------------------------------------
    function updatePickups(dt) {
      E.pickups.forEach((p) => {
        p.t += dt;
        pickupPos(p);
        if (p.taken || p.hidden || p.missing || !G.heroAlive) return;
        if (p.need && !p.need(L)) return;
        const zc = p.z + 0.006;
        if (Math.hypot(hero.f - p.f, hero.r - p.r) < 0.011 * Math.max(1, p.size) && hero.z < zc + 0.004 && hero.z + BODY > zc - 0.006) take(p);
      });
    }
    function take(p) {
      p.taken = true;
      switch (p.kind) {
        case "coin":
          addScore(25);
          sfx("coin");
          break;
        case "heart":
          if (G.hearts < G.maxHearts) G.hearts++;
          else addScore(100);
          sfx("pickup");
          say("A heart", "#ff9090");
          break;
        case "bomb":
          G.bombs += p.size > 1 ? 2 : 1;
          sfx("pickup");
          say("Bomb picked up", "#ffd080");
          break;
        default:
          sfx("found");
          addScore(300);
          break;
      }
      fx.parts.emit("spark", p.f, p.r, p.z + 0.006, 8, 0.004, { speed: 0.05, up: 0.06 });
      if (p.onTake) p.onTake(L, p);
    }

    // -- the level's life ------------------------------------------------------------------------------------------
    function resetEntities() {
      A.reset();
      E.pickups.length = E.geysers.length = E.barricades.length = E.gates.length = E.props.length = E.walls.length = 0;
      E.zones = {};
      E.lava = null;
      E.flags = {};
      E.beams = null;
      L.target = null;
      L.obj = "";
      fx.parts.list.length = 0;
      safeSpot = null;
    }
    function placeSpawn() {
      const sp = lv().spawn;
      const l = toF(sp.at[0], sp.at[1]);
      api.placeHero(l.f, l.r, floorYaw(sp.yaw === undefined ? 0 : sp.yaw));
    }
    function loadLevel(i) {
      G.idx = i;
      G.lv = LEVELS[i];
      G.phase = "setup";
      G.t = 0;
      G.okT = 0;
      G.focusManual = null;
      G.hint = false;
      G.U = measureU();
      resetEntities();
      Object.assign(hero, { inv: 0, hurtT: 0, deadT: 0 });
      G.hearts = G.maxHearts;
      SH.up = false;
      SH.energy = 1;
      SH.broken = 0;
      api.setFrameFromCube(true);
      api.setShowBlocks(false);
      api.setCamDist(Math.max(api.camDist(), 0.34));
      placeSpawn();
      api.recenter();
      say(`Level ${i + 1}: ${lv().name}`, "#ffe080");
      sfx("go");
    }
    function beginPlay() {
      G.phase = "play";
      G.t = 0;
      G.levelTime = 0;
      G.U = measureU();
      resetEntities();
      G.hearts = G.maxHearts;
      G.bombs = lv().bombs || 0;
      G.stats = { kills: 0, damage: 0, bombs: 0, parries: 0 };
      G.wonT = 0;
      Object.assign(hero, { inv: 0, hurtT: 0, deadT: 0 });
      api.setFrameFromCube(false);
      api.setCamDist(G.userCam);
      placeSpawn();
      lv().init(L);
      api.recenter();
      say(lv().intro || lv().name, "#ffe080");
      sfx("go");
    }
    function winLevel(msg) {
      if (G.phase !== "play") return;
      G.phase = "won";
      G.t = 0;
      G.wonT = 0.001;
      G.wonMsg = msg || "";
      const bonus = G.hearts * 100 + Math.max(0, Math.round(300 - G.levelTime));
      addScore(500 + bonus);
      G.bonus = bonus;
      G.done.add(lv().id);
      store.set([...G.done]);
      A.enemies.forEach((e) => e.state !== "dead" && (e.state = "idle", e.dormant = true));
      sfx("levelup");
    }
    function startSelected(state) {
      if (state === "title") api.startPlay();
      G.userCam = api.camDist();
      loadLevel(G.sel);
    }
    function nextLevel() {
      if (G.idx + 1 < LEVELS.length) {
        G.sel = G.idx + 1;
        loadLevel(G.sel);
      } else {
        G.phase = "menu";
        say("All levels done!", "#ffe080");
      }
    }
    function retry() {
      loadLevel(G.idx);
    }

    // -- the placement guide ---------------------------------------------------------------------------------------
    const frameStatus = () => {
      const b = frameBlock();
      if (!b) return { s: "missing" };
      const p = w.toWorld(b.cf, b.cr);
      const yaw = b.world ? b.world.yaw : 0;
      const q = Math.PI / 2;
      const off = Math.abs(wrap(yaw - Math.round(yaw / q) * q));
      if (Math.hypot(p.x, p.y) < 0.02 && off < 0.09) return { s: "ok", b };
      return { s: "measuring", b, d: Math.hypot(p.x, p.y) };
    };
    function entryStatus(en) {
      const c = cube(en.tag);
      if (!c) return { s: "missing" };
      const ex = en.at[0] * G.U;
      const ey = en.at[1] * G.U;
      const dx = ex - c.mx;
      const dy = ey - c.my;
      const dist = Math.hypot(dx, dy);
      const tol = (en.tol || 0.55) * G.U;
      const stackOk = Math.abs(c.h0 - (en.stack || 0) * c.size) < 0.45 * c.size;
      if (en.free) return { s: Math.hypot(c.mx - ex, c.my - ey) < en.free * G.U ? "ok" : "off", dx, dy, dist, c, stackOk: true };
      return { s: dist < tol && stackOk ? "ok" : "off", dx, dy, dist, c, stackOk };
    }
    function setupState() {
      const fr = frameStatus();
      const list = (lv().cubes || []).filter((c) => !(c.soloSkip && cfg.solo)).map((en) => ({ en, st: entryStatus(en) }));
      const required = list.filter((x) => !x.en.optional);
      const allOk = fr.s === "ok" && required.every((x) => x.st.s === "ok");
      return { fr, list, allOk, missing: required.filter((x) => x.st.s !== "ok").length + (fr.s === "ok" ? 0 : 1) };
    }
    const cmText = (u) => `${Math.round(Math.abs(u) * G.U * 100)} cm`;
    // Places are given from the frame cube's own faces (they're printed on
    // it): +x is the way face 24 points, +y the way face 25 points -- "in
    // front of the robot" was ambiguous (the robot's front or the camera's?).
    const towards = (v, pos, neg) => `face ${v > 0 ? pos : neg}`;
    function moveText(st) {
      const parts = [];
      if (Math.abs(st.dx) > 0.004) parts.push(`${Math.round(Math.abs(st.dx) * 100)} cm toward ${towards(st.dx, 24, 29)}`);
      if (Math.abs(st.dy) > 0.004) parts.push(`${Math.round(Math.abs(st.dy) * 100)} cm toward ${towards(st.dy, 25, 28)}`);
      return parts.join(", ") || "";
    }
    function placeText(en) {
      const [x, y] = en.at;
      const name = en.label ? `${en.label} (cube #${en.tag})` : `cube #${en.tag}`;
      const out = (v, pos, neg) => `${cmText(v)} out from ${towards(v, pos, neg)}`;
      if (en.free) return `${name}: anywhere in the ringed area, ${out(x, 24, 29)} of the frame cube`;
      const parts = [];
      if (Math.abs(x) >= 0.15) parts.push(out(x, 24, 29));
      if (Math.abs(y) >= 0.15) parts.push(out(y, 25, 28));
      const stack = en.stack ? ` -- on top of ${en.onTag !== undefined ? `cube ${en.onTag}` : "the cube below"}` : "";
      return `${name}: ${parts.join(", ") || "right next to the frame cube"}${stack}`;
    }
    // What the camera looks at while the cubes are laid out: the frame cube's
    // spot first, then the next cube still to place (Tab / RB, LB: another).
    function setupItems(S2) {
      return [
        { at: [0, 0], z: 0.5, ok: S2.fr.s === "ok", tag: "frame" },
        ...S2.list.map(({ en, st }) => ({ at: en.at, z: (en.stack || 0) + 0.5, ok: st.s === "ok", tag: en.tag, optional: !!en.optional })),
      ];
    }
    // another cube for the camera to look at (Tab / RB, LB, the touch button)
    function focusStep(d) {
      if (G.phase !== "setup" || !G.items) return;
      const n = G.items.length;
      G.focusManual = (((G.focus + d) % n) + n) % n;
      G.focusManualOk = G.items[G.focusManual].ok;
      G.focus = G.focusManual;
      api.recenter();
      sfx("click");
    }
    function updateFocus(S2) {
      const items = setupItems(S2);
      // (a cube chosen by hand stays chosen till it falls into place -- or, chosen in place already, till another is chosen)
      const m = G.focusManual !== null ? items[G.focusManual] : null;
      if (m && (G.focusManualOk || !m.ok)) G.focus = G.focusManual;
      else {
        G.focusManual = null;
        const i = items.findIndex((it) => !it.ok && !it.optional);
        G.focus = i >= 0 ? i : 0;
      }
      G.items = items;
    }
    function updateSetup(dt) {
      G.t += dt;
      const S2 = setupState();
      G.frameOk = S2.fr.s === "ok";
      G.U = measureU();
      placeSpawn();
      if (S2.allOk) {
        G.okT += dt;
        if (G.okT >= SETUP_OK_S) beginPlay();
      } else G.okT = 0;
      G.setup = S2;
      updateFocus(S2);
    }
    function setupFire() {
      const S2 = G.setup || setupState();
      if (S2.fr.s !== "ok") {
        say("Put the frame cube in view first (tags 24-29)", "#ff9070");
        return;
      }
      if (S2.allOk || performance.now() - G.anywayAt < 3000) {
        beginPlay();
        return;
      }
      G.anywayAt = performance.now();
      say(`${S2.missing} cube${S2.missing > 1 ? "s" : ""} not in place -- Fire again to start anyway`, "#ffd080");
    }

    // -- drawing: the floor --------------------------------------------------------------------------------------------
    const unitRect = (r) => ({ f0: r[0] * G.U, f1: r[2] * G.U, r0: r[1] * G.U, r1: r[3] * G.U });
    function drawFloor() {
      const l = lv();
      if (!l || G.phase === "menu" || G.phase === "setup") return; // (laying out: the video itself)
      const area = l.area ? unitRect(l.area) : null;
      if (l.floor === "lava" && area) {
        fx.patch("lava", area, 0, { world: true, time, tile: 0.2, flow: [0.004, 0.009], quality: cfg.quality === "low" ? 2 : 1 });
        fx.patch("lavaHot", area, 0.0004, { world: true, time, tile: 0.2, flow: [0.004, 0.009], blend: "lighter", alpha: 0.22 + 0.14 * Math.sin(time * 2.1) });
        rim(area, "rgba(20,12,8,0.9)", 4);
        // the heat: a glow along the lava at the edge of the view
      } else if ((l.floor === "flags" || l.floor === "stone") && area) {
        fx.patch(l.floorTex || "darkflag", area, 0, { world: true, time: 0, tile: l.floorTile || 0.14, alpha: 0.88 });
        rim(area, "rgba(10,8,6,0.8)", 2.5);
      } else if (l.floor === "water" && area) {
        fx.patch("water", area, 0, { world: true, time, tile: 0.22, flow: [0.006, 0.01] });
        rim(area, "rgba(30,50,60,0.9)", 3);
      }
      if (l.drawFloor) l.drawFloor(L);
    }
    function rim(a, color, width) {
      const c = [[a.f0, a.r0], [a.f1, a.r0], [a.f1, a.r1], [a.f0, a.r1], [a.f0, a.r0]].map(([x, y]) => {
        const p = w.toLocal(x, y);
        return [p.f, p.r, 0.0012];
      });
      w.line3(c, color, width, 0.02);
    }

    // -- drawing: the things of a level ----------------------------------------------------------------------------------
    function drawPickup(p) {
      if (p.taken || p.hidden || p.missing) return;
      const bob = Math.sin(p.t * 3) * 0.0016;
      const m = w.project(p.f, p.r, p.z + 0.007 + bob);
      if (!m) return;
      ar.queue(m.depth, () => {
        const g = ar.ctx;
        const R = 0.0055 * p.size * m.ppm;
        const spin = Math.cos(p.t * 2.2);
        fx.shadow(p.f, p.r, p.z - 0.0002, 0.004 * p.size, 0.25);
        g.save();
        const glowC = { coin: "255,210,80", heart: "255,80,100", bomb: "255,120,60", key: "255,220,100", gem: p.color || "90,230,255", crown: "255,220,100", feather: "255,150,50", sunstone: "255,230,120" }[p.kind] || "255,240,200";
        g.globalCompositeOperation = "lighter";
        ar.glow(m.x, m.y, R * 3.2, [[0, `rgba(${glowC},0.5)`], [1, `rgba(${glowC},0)`]]);
        g.globalCompositeOperation = "source-over";
        g.translate(m.x, m.y);
        const shape = (fn) => {
          g.beginPath();
          fn();
        };
        if (p.art) p.art(g, R, p, spin);
        else if (p.kind === "coin") {
          const rx = Math.max(0.15, Math.abs(spin)) * R;
          const gr = g.createLinearGradient(-rx, -R, rx, R);
          gr.addColorStop(0, "#fff0a0");
          gr.addColorStop(0.5, "#d8a020");
          gr.addColorStop(1, "#8a5a10");
          shape(() => g.ellipse(0, 0, rx, R, 0, 0, 2 * Math.PI));
          g.fillStyle = gr;
          g.fill();
          g.strokeStyle = "rgba(60,36,6,0.8)";
          g.lineWidth = 1;
          g.stroke();
        } else if (p.kind === "heart") {
          const gr = g.createRadialGradient(-R * 0.3, -R * 0.4, R * 0.1, 0, 0, R * 1.2);
          gr.addColorStop(0, "#ff9aa8");
          gr.addColorStop(0.45, "#d01030");
          gr.addColorStop(1, "#600010");
          shape(() => {
            g.moveTo(0, R * 0.9);
            g.bezierCurveTo(-R * 1.6, -R * 0.1, -R * 0.8, -R * 1.2, 0, -R * 0.4);
            g.bezierCurveTo(R * 0.8, -R * 1.2, R * 1.6, -R * 0.1, 0, R * 0.9);
          });
          g.fillStyle = gr;
          g.fill();
          g.strokeStyle = "rgba(40,0,8,0.8)";
          g.stroke();
        } else if (p.kind === "bomb") {
          const gr = g.createRadialGradient(-R * 0.3, -R * 0.3, R * 0.1, 0, 0, R);
          gr.addColorStop(0, "#777");
          gr.addColorStop(1, "#111");
          shape(() => g.arc(0, R * 0.15, R * 0.85, 0, 2 * Math.PI));
          g.fillStyle = gr;
          g.fill();
          g.strokeStyle = "#4a3320";
          g.lineWidth = 2;
          g.beginPath();
          g.moveTo(0, -R * 0.7);
          g.quadraticCurveTo(R * 0.5, -R * 1.2, R * 0.7, -R * 0.9);
          g.stroke();
        } else if (p.kind === "key") {
          g.rotate(0.5 + spin * 0.15);
          g.strokeStyle = "#e8c040";
          g.lineWidth = Math.max(2, R * 0.3);
          shape(() => g.arc(-R * 0.5, 0, R * 0.45, 0, 2 * Math.PI));
          g.stroke();
          g.beginPath();
          g.moveTo(-R * 0.05, 0);
          g.lineTo(R * 1.1, 0);
          g.moveTo(R * 0.8, 0);
          g.lineTo(R * 0.8, R * 0.45);
          g.moveTo(R * 1.1, 0);
          g.lineTo(R * 1.1, R * 0.35);
          g.stroke();
        } else if (p.kind === "crown") {
          const gr = g.createLinearGradient(0, -R, 0, R);
          gr.addColorStop(0, "#fff0a0");
          gr.addColorStop(1, "#b07818");
          shape(() => {
            g.moveTo(-R, R * 0.6);
            g.lineTo(-R, -R * 0.2);
            g.lineTo(-R * 0.5, R * 0.2);
            g.lineTo(0, -R * 0.8);
            g.lineTo(R * 0.5, R * 0.2);
            g.lineTo(R, -R * 0.2);
            g.lineTo(R, R * 0.6);
            g.closePath();
          });
          g.fillStyle = gr;
          g.fill();
          g.strokeStyle = "rgba(60,36,6,0.9)";
          g.stroke();
          [[-R * 0.6, R * 0.3, "#d02040"], [0, R * 0.25, "#2080e0"], [R * 0.6, R * 0.3, "#20c070"]].forEach(([x, y, c]) => {
            g.fillStyle = c;
            g.beginPath();
            g.arc(x, y, R * 0.16, 0, 2 * Math.PI);
            g.fill();
          });
        } else if (p.kind === "feather") {
          g.rotate(-0.5);
          const gr = g.createLinearGradient(0, R * 1.2, 0, -R * 1.2);
          gr.addColorStop(0, "#ff4010");
          gr.addColorStop(0.5, "#ff9a20");
          gr.addColorStop(1, "#fff0a0");
          shape(() => {
            g.moveTo(0, R * 1.3);
            g.bezierCurveTo(-R * 1.1, 0, -R * 0.5, -R * 1.0, 0, -R * 1.4);
            g.bezierCurveTo(R * 0.7, -R * 0.8, R * 0.9, 0, 0, R * 1.3);
          });
          g.fillStyle = gr;
          g.fill();
          g.strokeStyle = "rgba(255,240,180,0.9)";
          g.beginPath();
          g.moveTo(0, R * 1.3);
          g.lineTo(0, -R * 1.2);
          g.stroke();
        } else {
          // a cut gem
          const col = p.color ? `rgb(${p.color})` : "#4ee0ff";
          shape(() => {
            g.moveTo(0, -R);
            g.lineTo(R * 0.8, -R * 0.2);
            g.lineTo(R * 0.5, R * 0.8);
            g.lineTo(-R * 0.5, R * 0.8);
            g.lineTo(-R * 0.8, -R * 0.2);
            g.closePath();
          });
          const gr = g.createLinearGradient(-R, -R, R, R);
          gr.addColorStop(0, "#ffffff");
          gr.addColorStop(0.4, col);
          gr.addColorStop(1, "rgba(0,20,40,0.9)");
          g.fillStyle = gr;
          g.fill();
          g.strokeStyle = "rgba(255,255,255,0.7)";
          g.lineWidth = 1;
          g.stroke();
          g.beginPath();
          g.moveTo(-R * 0.8, -R * 0.2);
          g.lineTo(R * 0.8, -R * 0.2);
          g.moveTo(0, -R);
          g.lineTo(-R * 0.3, R * 0.8);
          g.moveTo(0, -R);
          g.lineTo(R * 0.3, R * 0.8);
          g.stroke();
        }
        g.restore();
      });
    }
    function drawGeyser(g) {
      if (g.f === undefined) return;
      const m = w.project(g.f, g.r, 0.004);
      if (!m) return;
      ar.queue(m.depth, () => {
        if (g.state === "warn") {
          const k = (G.levelTime + g.phase) % g.period;
          const pulse = 0.5 + 0.5 * Math.sin(time * 14);
          fx.disc(g.f, g.r, 0.002, g.radius * 1.2, `rgba(255,${120 + 60 * pulse | 0},20,${0.28 + 0.2 * pulse})`);
          fx.ring(g.f, g.r, 0.0025, g.radius * (1.1 + 0.2 * pulse), "rgba(255,200,90,0.8)", 1.5);
          void k;
        } else if (g.state === "erupt") {
          fx.disc(g.f, g.r, 0.002, g.radius * 1.3, "rgba(255,200,80,0.45)");
          for (let k = 0; k < 3; k++) fx.flame(g.f + Math.cos(time * 30 + k) * g.radius * 0.3, g.r + Math.sin(time * 27 + k) * g.radius * 0.3, 0.002 + k * 0.012, g.tall * 0.7, time + k, { seed: k * 2, light: k === 0 });
        }
      });
    }
    function drawBarricades() {
      E.barricades.forEach((b) => {
        if (b.dead) {
          b.deadT += 0;
          return;
        }
        const sq = barricadeSquares(b);
        sq.forEach((s, i) => {
          const m = w.project(s.cf, s.cr, s.h1 * 0.5);
          if (!m) return;
          ar.queue(m.depth, () => {
            fx.skin(s, "basalt");
            // fresh cracks glow, a fuse of old powder: it wants a blast
            const top = w.project(s.cf, s.cr, s.h1 * 0.6);
            if (top) {
              const g = ar.ctx;
              g.save();
              g.globalCompositeOperation = "lighter";
              ar.glow(top.x, top.y, 0.012 * top.ppm, [[0, `rgba(255,120,40,${0.12 + 0.06 * Math.sin(time * 3 + i)})`], [1, "rgba(255,80,0,0)"]]);
              g.restore();
            }
          }, w.extent(s.cf - s.half, s.cf + s.half, s.cr - s.half, s.cr + s.half, 0, s.h1, fx.corners(s)));
        });
      });
    }
    function drawWalls() {
      E.walls.forEach((b) => {
        barricadeSquares(b).forEach((s) => {
          const m = w.project(s.cf, s.cr, s.h1 * 0.5);
          if (!m) return;
          ar.queue(m.depth, () => {
            fx.skin(s, b.style);
            const top = w.project(s.cf, s.cr, s.h1 + 0.001);
            void top;
          }, w.extent(s.cf - s.half, s.cf + s.half, s.cr - s.half, s.cr + s.half, 0, s.h1, fx.corners(s)));
        });
      });
    }
    function drawGates() {
      E.gates.forEach((g) => {
        if (g.lift >= 0.97) return;
        const sq = gateSquares(g);
        if (!sq.length) return;
        const first = sq[0];
        const last = sq[sq.length - 1];
        const m = w.project((first.cf + last.cf) / 2, (first.cr + last.cr) / 2, g.height * G.U * 0.5);
        if (!m) return;
        ar.queue(m.depth, () => {
          const up = g.lift * g.height * G.U * 0.95;
          const top = g.height * G.U;
          sq.forEach((s) => {
            w.line3([[s.cf, s.cr, up], [s.cf, s.cr, top]], "rgba(30,30,34,0.95)", Math.max(2, 0.0022 * m.ppm), 0.02);
            w.line3([[s.cf, s.cr, up], [s.cf, s.cr, top]], "rgba(130,134,142,0.5)", Math.max(1, 0.0008 * m.ppm), 0.02);
          });
          [0.25, 0.6].forEach((k) => w.line3([[first.cf, first.cr, up + (top - up) * k], [last.cf, last.cr, up + (top - up) * k]], "rgba(36,36,40,0.95)", Math.max(2, 0.0022 * m.ppm), 0.02));
        });
      });
    }
    function drawProps() {
      E.props.forEach((p) => {
        if (p.draw) {
          p.draw(L, p);
          return;
        }
        let l;
        let z = 0;
        if (p.tag !== null && p.tag !== undefined) {
          const c = cube(p.tag);
          if (!c) return;
          l = { f: c.f, r: c.r };
          z = c.top;
        } else {
          l = toF(p.at[0], p.at[1]);
          z = api.groundAt(l.f, l.r, 1, 1).h;
        }
        const m = w.project(l.f, l.r, z + 0.01);
        if (!m) return;
        ar.queue(m.depth, () => {
          if (p.kind === "brazier") {
            fx.shadow(l.f, l.r, z, 0.008, 0.3);
            fx.barrel(l.f, l.r, z, 0.0055, 0.012, { color: [70, 66, 62], hoop: "rgba(30,30,34,0.9)" });
            fx.flame(l.f, l.r, z + 0.012, 0.022, time, { seed: l.f * 50 });
            if (Math.random() < 0.15) fx.parts.emit("ember", l.f, l.r, z + 0.02, 1, 0.003, { up: 0.04 });
          }
        });
      });
    }

    // -- drawing: the placement guide, the HUD, the menu ----------------------------------------------------------
    function ghost(en, st, t) {
      const half = G.U / 2;
      const ex = en.at[0] * G.U;
      const ey = en.at[1] * G.U;
      const h0 = (en.stack || 0) * G.U;
      const h1 = h0 + G.U;
      const ok = st.s === "ok";
      const miss = st.s === "missing";
      const pulse = 0.5 + 0.5 * Math.sin(t * 4);
      const col = ok ? "90,255,150" : miss ? "255,214,90" : "255,150,60";
      const alpha = ok ? 0.25 : 0.22 + 0.2 * pulse;
      const rad = en.free ? en.free * G.U : null;
      if (rad) {
        const pts = [];
        for (let k = 0; k < 28; k++) {
          const p = w.toLocal(ex + rad * Math.cos((k / 28) * 2 * Math.PI), ey + rad * Math.sin((k / 28) * 2 * Math.PI));
          pts.push([p.f, p.r, 0.001]);
        }
        const sp = w.polyScreen(pts, 1);
        if (sp) w.fillPoly(sp, `rgba(${col},${alpha * 0.5})`, `rgba(${col},0.9)`, 2);
      } else {
        const cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => w.toLocal(ex + a * half, ey + b * half));
        const floorP = (h) => cs.map((c) => [c.f, c.r, h]);
        const bottom = w.polyScreen(floorP(h0 + 0.001), 2);
        if (bottom) w.fillPoly(bottom, `rgba(${col},${alpha})`, `rgba(${col},0.95)`, 2.2);
        const top = w.polyScreen(floorP(h1), 2);
        if (top && !ok) w.fillPoly(top, `rgba(${col},${alpha * 0.45})`, `rgba(${col},0.7)`, 1.2);
        cs.forEach((c) => w.line3([[c.f, c.r, h0 + 0.001], [c.f, c.r, h1]], `rgba(${col},0.55)`, 1, 0.02));
      }
      const lab = w.project(...(() => {
        const l = w.toLocal(ex, ey);
        return [l.f, l.r, (en.stack || 0) * G.U + G.U + 0.004];
      })());
      if (lab) {
        ar.text(en.label ? `${en.label}` : `${en.tag}`, lab.x, lab.y - 2, { size: 15, align: "center", color: `rgb(${col})` });
        if (!en.free) ar.text(`#${en.tag}`, lab.x, lab.y + 12, { size: 11, align: "center", color: "rgba(255,255,255,0.85)" });
      }
      // an arrow from where it is to where it goes
      if (st.s === "off" && st.c && st.dist < 0.45) {
        const a = w.toLocal(st.c.mx, st.c.my);
        const b = w.toLocal(ex, ey);
        w.line3([[a.f, a.r, st.c.top + 0.002], [b.f, b.r, h1 + 0.002]], "rgba(255,170,80,0.9)", 2, 0.02);
      }
    }
    function wrapText(text, width, size) {
      const g = ar.ctx;
      g.save();
      g.font = `bold ${size}px system-ui, sans-serif`;
      const words = String(text).split(/\s+/);
      const lines = [];
      let cur = "";
      words.forEach((wd) => {
        const t = cur ? `${cur} ${wd}` : wd;
        if (g.measureText(t).width > width && cur) {
          lines.push(cur);
          cur = wd;
        } else cur = t;
      });
      if (cur) lines.push(cur);
      g.restore();
      return lines;
    }
    function panel(x, y, wd, ht, alpha = 0.72) {
      const g = ar.ctx;
      g.save();
      g.fillStyle = `rgba(14,10,6,${alpha})`;
      g.strokeStyle = "rgba(210,170,80,0.7)";
      g.lineWidth = 1.5;
      g.beginPath();
      g.roundRect ? g.roundRect(x, y, wd, ht, 8) : g.rect(x, y, wd, ht);
      g.fill();
      g.stroke();
      g.restore();
    }
    function drawSetup() {
      const l = lv();
      const S2 = G.setup || setupState();
      const v = ar.view;
      const pw = Lynx.smallScreen() ? Math.min(250, v.w * 0.42) : Math.min(330, v.w * 0.4); // (compact: the video is what matters while laying out)
      const size = v.w < 700 ? 10 : 12;
      const lines = [];
      lines.push({ t: Lynx.smallScreen() ? `Level ${G.idx + 1}: lay out the cubes` : `LEVEL ${G.idx + 1} -- ${l.name.toUpperCase()}: lay out the cubes`, c: "#ffd870", s: size + 1 });
      const fr = S2.fr;
      const focusMark = (i) => (G.focus === i ? "\u25b6 " : "");
      if (!Lynx.smallScreen() || G.focus === 0) lines.push({ t: `${focusMark(0)}${fr.s === "ok" ? "✔" : fr.s === "measuring" ? "…" : "✖"} ${Lynx.smallScreen() ? "Frame cube (24-29): ~30 cm ahead, where the camera looks; face 24 away from the robot" : "Frame cube (24-29) on the floor about 30 cm ahead of the robot, where the camera looks, face 24 pointing away from the robot. Everything below is measured from it."}`, c: fr.s === "ok" ? "#80ff9c" : "#ffc060", s: size, wrap: true });
      const small = Lynx.smallScreen();
      S2.list.forEach(({ en, st }, i) => {
        // (a phone: only the one the camera is on -- the rest are on the map)
        if (small && G.focus !== i + 1) return;
        const mark = st.s === "ok" ? "✔" : st.s === "missing" ? "✖" : "→";
        const col = st.s === "ok" ? "#80ff9c" : st.s === "missing" ? "#ffc060" : "#ffa060";
        let t = `${focusMark(i + 1)}${mark} ${placeText(en)}`;
        if (st.s === "off") t += st.stackOk === false ? " -- not stacked right" : ` -- move it ${moveText(st)}`;
        lines.push({ t: en.optional ? `${t} (optional)` : t, c: col, s: size, wrap: true });
      });
      if (small) {
        const placed = (G.items || []).filter((it) => it.ok).length;
        lines.push({ t: `${placed} of ${(G.items || []).length} in place · \u21c4: another`, c: "#e8dcc0", s: size });
      }
      const out = [];
      lines.forEach((ln) => {
        if (ln.wrap) wrapText(ln.t, pw - 24, ln.s).forEach((t, i) => out.push({ ...ln, t: i ? `   ${t}` : t }));
        else out.push(ln);
      });
      const lh = (ln) => ln.s * 1.3;
      const ht = out.reduce((m, ln) => m + lh(ln), 0) + 28;
      const x = v.x + 12;
      const y = Lynx.smallScreen() ? v.y + 4 : v.y + 56; // (a phone: right at the top, out of the middle of the picture)
      panel(x, y, pw, ht, 0.55);
      let yy = y + 20;
      out.forEach((ln) => {
        if (ln.t) ar.text(ln.t, x + 12, yy, { size: ln.s, color: ln.c, outline: false, weight: ln.s > size + 1 ? "bold" : "600" });
        yy += lh(ln);
      });
      const msg = S2.allOk ? `All in place -- starting in ${Math.max(0, SETUP_OK_S - G.okT).toFixed(1)} s (Fire: now)` : "The camera looks where the \u25b6 cube goes · Tab / RB, LB: another · Fire: start anyway · R: look again";
      if (!Lynx.smallScreen() || S2.allOk) ar.text(msg, v.cx, v.y + v.h - 40, { size: Lynx.smallScreen() ? 12 : 14, align: "center", color: S2.allOk ? "#80ff9c" : "#ffe9a8" });
    }
    // A small map while laying out (top right): the robot in the middle, its
    // front up -- the way the right stick drives it -- the frame cube, the
    // cubes it has seen (cyan, the frame cube yellow) and where each one goes
    // (dashed: green in place, orange not yet; the camera's one ringed).
    function drawMap() {
      const v = ar.view;
      const g = ar.ctx;
      const S2 = G.setup || setupState();
      const size = Lynx.smallScreen() ? Math.min(160, v.w * 0.26, v.h * 0.36) : Math.min(200, v.w * 0.3, v.h * 0.42);
      const x0 = v.x + v.w - size - 12;
      const y0 = Lynx.smallScreen() ? v.y + 4 : v.y + 56;
      const ch = api.chassis();
      const body = api.robotBody();
      const c = Math.cos(ch.th);
      const sn = Math.sin(ch.th);
      // a floor point -> the robot's frame (u ahead, v to its right)
      const rel = (f, r) => [(f - ch.f) * c + (r - ch.r) * sn, -(f - ch.f) * sn + (r - ch.r) * c];
      const spots = [[0, 0], ...S2.list.map((x) => x.en.at)].map(([x, y]) => {
        const l = toF(x, y);
        return rel(l.f, l.r);
      });
      const reach = Math.max(0.25, body.front + 0.03, body.rear, body.half, ...spots.map(([u, vv]) => Math.max(Math.abs(u), Math.abs(vv)) + G.U));
      const sc = (size * 0.46) / reach;
      const cx = x0 + size / 2;
      const cy = y0 + size / 2;
      const P = ([u, vv]) => [cx + vv * sc, cy - u * sc];
      const poly = (pts, fill, stroke, dash) => {
        g.beginPath();
        pts.forEach((q, i) => (i ? g.lineTo(q[0], q[1]) : g.moveTo(q[0], q[1])));
        g.closePath();
        if (fill) {
          g.fillStyle = fill;
          g.fill();
        }
        if (stroke) {
          g.setLineDash(dash || []);
          g.strokeStyle = stroke;
          g.lineWidth = 1.5;
          g.stroke();
          g.setLineDash([]);
        }
      };
      const squareAt = (x, y) => {
        const half = G.U / 2;
        return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
          const l = w.toLocal(x + a * half, y + b * half);
          return P(rel(l.f, l.r));
        });
      };
      panel(x0, y0, size, size, 0.55);
      g.save();
      g.beginPath();
      g.rect(x0, y0, size, size);
      g.clip();
      // what the camera sees: a wedge from the robot the way the camera looks
      // (it pans on its own -- the robot may face elsewhere), as wide as the lens
      {
        const v2 = ar.view;
        const halfFov = Math.atan(v2.imgW / 2 / Math.max(1, v2.f));
        const camYaw = wrap(w.anchor().th - ar.camTheta - ch.th); // (the floor frame's headings run clockwise)
        const len = reach * 1.6;
        const ray = (a) => P([Math.cos(a) * len, Math.sin(a) * len]);
        const fan = [P([0, 0])];
        for (let k = 0; k <= 8; k++) fan.push(ray(camYaw - halfFov + (2 * halfFov * k) / 8));
        poly(fan, "rgba(255,255,255,0.1)", null);
        g.save();
        g.strokeStyle = "rgba(255,255,255,0.45)";
        g.lineWidth = 1;
        g.setLineDash([4, 3]);
        [camYaw - halfFov, camYaw + halfFov].forEach((a) => {
          const e = ray(a);
          const o = P([0, 0]);
          g.beginPath();
          g.moveTo(o[0], o[1]);
          g.lineTo(e[0], e[1]);
          g.stroke();
        });
        g.restore();
      }
      // where they go
      const fm = squareAt(0, 0);
      poly(fm, null, G.focus === 0 ? "rgba(255,255,255,0.95)" : S2.fr.s === "ok" ? "rgba(90,255,150,0.9)" : "rgba(255,214,90,0.9)", [3, 3]);
      S2.list.forEach(({ en, st }, i) => {
        const q = squareAt(en.at[0] * G.U, en.at[1] * G.U);
        const col = st.s === "ok" ? "rgba(90,255,150,0.9)" : "rgba(255,160,70,0.9)";
        poly(q, null, G.focus === i + 1 ? "rgba(255,255,255,0.95)" : col, [3, 3]);
        const m = P(rel(...(() => {
          const l = w.toLocal(en.at[0] * G.U, en.at[1] * G.U);
          return [l.f, l.r];
        })()));
        ar.text(String(en.label || en.tag), m[0], m[1] + 4, { size: 10, align: "center", color: col });
      });
      // the cubes seen
      api.realSolids.forEach((b) => {
        if (b.inferred) return;
        const q = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, bb]) => P(rel(...api.fromB(b, a * b.half, bb * b.half))));
        poly(q, cubes.frameCube(b.tag) ? "rgba(255,210,80,0.85)" : "rgba(80,230,255,0.75)", null);
        if (!cubes.frameCube(b.tag)) {
          const m = P(rel(b.cf, b.cr));
          ar.text(String(b.tag), m[0], m[1] + 4, { size: 10, align: "center", color: "#062030", outline: false, weight: "bold" });
        }
      });
      // the robot, its front up
      const R = [[body.front, -body.half], [body.front, body.half], [-body.rear, body.half], [-body.rear, -body.half]].map(P);
      poly(R, "rgba(255,255,255,0.12)", "rgba(255,255,255,0.8)");
      poly([P([body.front + 0.03, 0]), P([body.front - 0.005, -body.half * 0.45]), P([body.front - 0.005, body.half * 0.45])], "rgba(255,255,255,0.85)", null);
      g.restore();
      ar.text("map: robot's front up · light: camera view", x0 + size / 2, y0 + size - 6, { size: 10, align: "center", color: "rgba(255,255,255,0.6)" });
    }
    // laying out: each cube seen labelled with its tag number, on top of it
    function drawCubeNumbers() {
      api.realSolids.forEach((b) => {
        if (b.inferred) return;
        const m = w.project(b.cf, b.cr, b.h1 + 0.006);
        if (!m) return;
        const frame = cubes.frameCube(b.tag);
        ar.queue(m.depth - 0.001, () => ar.text(frame ? "frame" : `#${b.tag}`, m.x, m.y, { size: 17, align: "center", color: frame ? "#ffd870" : "#ffffff", weight: "bold" }));
      });
    }
    function drawGhosts() {
      const l = lv();
      if (!l || G.phase !== "setup" || !G.setup) return;
      // the frame cube's own mark
      G.setup.list.forEach(({ en, st }) => {
        const m = w.project(...(() => {
          const p = w.toLocal(en.at[0] * G.U, en.at[1] * G.U);
          return [p.f, p.r, 0.01];
        })());
        if (!m) return;
        ar.queue(m.depth + 0.2, () => ghost(en, st, time));
      });
    }
    function heart(g, x, y, R, fill) {
      g.beginPath();
      g.moveTo(x, y + R * 0.9);
      g.bezierCurveTo(x - R * 1.6, y - R * 0.1, x - R * 0.8, y - R * 1.2, x, y - R * 0.4);
      g.bezierCurveTo(x + R * 0.8, y - R * 1.2, x + R * 1.6, y - R * 0.1, x, y + R * 0.9);
      if (fill) {
        const gr = g.createRadialGradient(x - R * 0.3, y - R * 0.4, R * 0.1, x, y, R * 1.3);
        gr.addColorStop(0, "#ff9aa8");
        gr.addColorStop(0.5, "#d01030");
        gr.addColorStop(1, "#5a0010");
        g.fillStyle = gr;
        g.fill();
      } else {
        g.fillStyle = "rgba(0,0,0,0.45)";
        g.fill();
      }
      g.strokeStyle = fill ? "rgba(255,200,200,0.8)" : "rgba(160,150,140,0.6)";
      g.lineWidth = 1.2;
      g.stroke();
    }
    function drawHud() {
      const v = ar.view;
      const g = ar.ctx;
      const l = lv();
      // hearts, shield, bombs
      const x0 = v.x + 14;
      const y0 = v.y + 64;
      g.save();
      for (let i = 0; i < G.maxHearts; i++) heart(g, x0 + 10 + i * 22, y0 + 6, 8, i < G.hearts);
      g.fillStyle = "rgba(0,0,0,0.5)";
      g.fillRect(x0, y0 + 22, 110, 7);
      const gr = g.createLinearGradient(x0, 0, x0 + 110, 0);
      gr.addColorStop(0, SH.broken > 0 ? "#a04030" : "#7f9fc0");
      gr.addColorStop(1, SH.broken > 0 ? "#c06050" : "#d0e4f8");
      g.fillStyle = gr;
      g.fillRect(x0, y0 + 22, 110 * SH.energy, 7);
      g.strokeStyle = SH.up ? "rgba(255,255,255,0.9)" : "rgba(200,200,200,0.4)";
      g.strokeRect(x0, y0 + 22, 110, 7);
      if (l && (l.bombs || G.bombs || A.bombs.length)) {
        for (let i = 0; i < Math.min(G.bombs, 8); i++) {
          const bx = x0 + 8 + i * 16;
          const by = y0 + 44;
          const rg = g.createRadialGradient(bx - 2, by - 2, 1, bx, by, 7);
          rg.addColorStop(0, "#777");
          rg.addColorStop(1, "#111");
          g.fillStyle = rg;
          g.beginPath();
          g.arc(bx, by, 6, 0, 2 * Math.PI);
          g.fill();
          g.strokeStyle = "#caa060";
          g.beginPath();
          g.moveTo(bx + 1, by - 6);
          g.lineTo(bx + 4, by - 10);
          g.stroke();
        }
        if (A.bombs.length) ar.text(`${A.bombs.length} set`, x0 + 8 + Math.min(G.bombs, 8) * 16 + 4, y0 + 49, { size: 12, color: "#ff9070" });
      }
      g.restore();
      ar.text(`${G.score}`, v.x + v.w - 16, v.y + v.h - 20, { size: 15, align: "right", color: "#ffe9a8" });
      // the objective
      if (l && L.obj) {
        const lines = wrapText(L.obj, Math.min(560, v.w * 0.75), 14);
        lines.forEach((t, i) => ar.text(t, v.cx, v.y + v.h - 44 - (lines.length - 1 - i) * 17, { size: 14, align: "center", color: "#ffe9a8" }));
      }
      if (l && l.hud) l.hud(L);
      if (l && L.target) {
        const p = world(L.target.at);
        ar.edgeArrow(p.x, p.y, L.target.h || 0.02, "#ffd870");
      }
      if (G.flash) {
        G.flash.t += 0.03;
        ar.flash(G.flash.color, Math.max(0, 1 - G.flash.t * 2.5));
        if (G.flash.t > 0.4) G.flash = null;
      }
      if (hero.deadT > 0.6 || G.phase === "lost") {
        const k = clamp((hero.deadT - 0.6) / 1.2, 0, 1);
        ar.flash("rgba(40,0,0,0.9)", 0.5 * k);
      }
      if (G.phase === "lost") {
        ar.banner("DEFEATED", "Fire: try the level again · L: menu", { color: "#c0302a" });
      }
      if (G.phase === "won") {
        const a = clamp(G.wonT / 0.6, 0, 1);
        ar.banner("LEVEL COMPLETE", G.wonMsg || l.name, { color: "#e8c050", alpha: a });
        ar.text(`Hearts ${G.hearts}/${G.maxHearts} · kills ${G.stats.kills} · parries ${G.stats.parries} · time ${Math.round(G.levelTime)} s · bonus ${G.bonus}`, v.cx, v.cy + 70, { size: 14, align: "center", alpha: a });
        ar.text(G.idx + 1 < LEVELS.length ? "Fire: next level · L: menu" : "Fire: back to the menu", v.cx, v.cy + 94, { size: 14, align: "center", color: "#ffe9a8", alpha: a });
      }
    }
    const world = (at) => ({ x: at[0] * G.U, y: at[1] * G.U });
    // The level menu, laid out to the screen: the title, the levels (rows as
    // high as there's room for), the chosen one's description, and the line
    // at the bottom kept clear of the buttons in the corner.
    function drawMenu() {
      const v = ar.view;
      const small = Lynx.smallScreen();
      ar.flash("rgba(8,5,2,0.78)", 1);
      const titleSize = Math.max(22, Math.min(56, v.w / 11, v.h / 8));
      let y = v.y + titleSize + 8;
      ar.text("BLOCK QUEST", v.cx, y, { size: titleSize, align: "center", color: "#e8c050", font: "Impact, 'Arial Black', sans-serif", weight: "normal" });
      if (!small) {
        y += 24;
        ar.text("Knight on Blocks, with real levels", v.cx, y, { size: 14, align: "center", color: "#d8c8a0" });
      }
      const bottomY = v.y + v.h - (small ? 64 : 58); // (above the buttons in the bottom corners)
      const rw = Math.min(500, v.w - 40);
      const l = LEVELS[G.sel];
      const blurbSize = small ? 11 : 13;
      const blurb = l ? wrapText(l.blurb || l.story, rw - 20, blurbSize) : [];
      const blurbShown = small ? blurb.slice(0, 2) : blurb;
      const blurbH = (blurbShown.length + 1) * (blurbSize + 4) + 10;
      const top = y + (small ? 20 : 28);
      const rowH = clamp((bottomY - top - blurbH) / Math.max(1, LEVELS.length), 14, 26);
      const rowSize = clamp(rowH * 0.62, 10, 16);
      menuRows = [];
      LEVELS.forEach((lv2, i) => {
        const ry = top + i * rowH + rowSize * 0.5;
        const sel = i === G.sel;
        menuRows.push({ i, x0: v.cx - rw / 2, x1: v.cx + rw / 2, y0: ry - rowSize * 1.05, y1: ry - rowSize * 1.05 + rowH });
        if (sel) {
          ar.ctx.fillStyle = "rgba(210,170,80,0.18)";
          ar.ctx.fillRect(v.cx - rw / 2, ry - rowSize * 1.05, rw, rowH - 1);
        }
        ar.text(`${i + 1}. ${lv2.name}`, v.cx - rw / 2 + 14, ry, { size: rowSize, color: sel ? "#ffe9a8" : "#c8b890" });
        if (rw > 380) ar.text(lv2.tags || "", v.cx + rw / 2 - 14, ry, { size: rowSize - 2, align: "right", color: sel ? "#a0e0ff" : "#8aa0b0" });
        if (G.done.has(lv2.id)) ar.text("✔", v.cx - rw / 2 - 2, ry, { size: rowSize, color: "#80ff9c" });
      });
      if (l) {
        let by = top + LEVELS.length * rowH + blurbSize + 8;
        blurbShown.forEach((t) => {
          ar.text(t, v.cx, by, { size: blurbSize, align: "center", color: "#e8dcc0" });
          by += blurbSize + 4;
        });
        const need = `Cubes: frame cube${(l.cubes || []).length ? ` + tags ${[...new Set(l.cubes.map((c) => c.tag))].sort().join(", ")}` : ""}`;
        ar.text(need, v.cx, by + 2, { size: blurbSize, align: "center", color: "#a0e0ff" });
      }
      ar.text(
        small ? "Tap a level · tap it again (or \u2694 Sword): start" : "Click a level, again to start · LB / RB, Tab, 1-7: choose · Fire: start · tags: /tags.html",
        v.cx, bottomY + 26, { size: small ? 12 : 13, align: "center", color: "#ffe9a8" },
      );
    }

    // A level in the menu clicked or tapped: chosen -- and, already chosen,
    // started. Caught before the page's own handlers (a click on the picture
    // is Fire in a game; a touch there starts a stick), and kept from them.
    let menuRows = [];
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
      if (e.type !== "pointerdown") return; // (the touch and mouse events of the same press: only kept away)
      e.preventDefault();
      if (m.i === G.sel) startSelected(api.state);
      else {
        G.sel = m.i;
        sfx("click");
      }
    };
    ["pointerdown", "mousedown", "touchstart"].forEach((t) => window.addEventListener(t, onRowDown, { capture: true, passive: false }));
    ar.onDestroy(() => ["pointerdown", "mousedown", "touchstart"].forEach((t) => window.removeEventListener(t, onRowDown, { capture: true })));

    // -- input -------------------------------------------------------------------------------------------------------------
    function choose(dir) {
      if (!LEVELS.length) return;
      G.sel = (G.sel + dir + LEVELS.length) % LEVELS.length;
      sfx("click");
    }
    function onKey(e) {
      const t = e.target;
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA"))) return;
      if (e.code === "KeyB" && G.phase === "play") placeBomb();
      else if (e.code === "KeyE" && G.phase === "play") A.detonate();
      else if (e.code === "KeyH" && (G.phase === "setup" || G.phase === "play")) G.hint = !G.hint;
      else if (e.code === "KeyL" && api.state === "playing") {
        G.phase = "menu";
        api.setFrameFromCube(false);
        api.setCamDist(G.userCam);
        resetEntities();
        G.lv = null;
      }
    }
    function placeBomb() {
      if (!G.heroAlive) return;
      A.placeBomb();
    }
    window.addEventListener("keydown", onKey);
    ar.onDestroy(() => window.removeEventListener("keydown", onKey));
    Lynx.onAction("shield", () => {});
    const touch = Lynx.touchButtons();
    const shieldBtn = touch.addHold ? touch.addHold("🛡 Shield", () => Lynx.shieldAction("touch", true), () => Lynx.shieldAction("touch", false)) : null;
    const nextBtn = touch.add("⇄ Next cube", () => focusStep(1));
    // the level menu: choosing with the touch buttons (a phone has no LB / RB / Tab)
    const menuBtns = [touch.add("\u25b2 Previous level", () => G.phase === "menu" && choose(-1)), touch.add("\u25bc Next level", () => G.phase === "menu" && choose(1))];
    // laying out: of the touch buttons only Next cube; the menu: only the level choice
    // (the rest out of the way); afterwards as they were
    function setupBar() {
      if (!touch.el) return;
      // (the level buttons: on a touch screen only -- with a mouse, a level is clicked)
      const touchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;
      const keep = G.phase === "setup" ? [nextBtn] : G.phase === "menu" ? (touchDevice ? menuBtns : []) : null;
      const on = !!keep;
      [...touch.el.children].forEach((b) => {
        if (b === nextBtn || menuBtns.includes(b)) {
          b.style.display = keep && keep.includes(b) ? "" : "none";
          return;
        }
        if (on && !("setupHidden" in b.dataset)) {
          b.dataset.setupHidden = b.style.display;
          b.style.display = "none";
        } else if (!on && "setupHidden" in b.dataset) {
          b.style.display = b.dataset.setupHidden;
          delete b.dataset.setupHidden;
        }
      });
    }
    const bombBtns = [touch.add("💣 Bomb", () => G.phase === "play" && placeBomb()), touch.add("💥 Detonate", () => G.phase === "play" && A.detonate())];
    // only what can be used now: the shield while playing, bombs in a level that has them
    function showGameBtns() {
      const play = G.phase === "play";
      if (shieldBtn) shieldBtn.style.display = play ? "" : "none";
      const bombs = play && !!(lv() && (lv().bombs || G.bombs || A.bombs.length));
      bombBtns.forEach((b) => (b.style.display = bombs ? "" : "none"));
    }

    // -- the hooks ------------------------------------------------------------------------------------------------------------
    function skinOf(b) {
      const l = lv();
      if (!l || !G.skins || G.phase === "menu") return null;
      if (cubes.frameCube(b.tag)) return l.frameSkin || "ivory";
      return (l.skins && l.skins[b.tag]) || l.skinDefault || null;
    }
    return {
      actionLabel: "⚔️ Sword",
      frozen: () => G.phase !== "play" || hero.deadT > 0,
      moveScale: () => (SH.up ? 0.5 : 1),
      solids() {
        if (G.phase === "menu") return [];
        const out = [];
        E.barricades.forEach((b) => !b.dead && out.push(...barricadeSquares(b)));
        E.walls.forEach((b) => out.push(...barricadeSquares(b)));
        E.gates.forEach((g) => out.push(...gateSquares(g)));
        if (lv() && lv().solids) out.push(...lv().solids(L));
        return out;
      },
      blockOver(b) {
        if (G.phase === "setup") return; // (laying out: the real cubes and their tags as they are)
        const st = skinOf(b);
        if (st) fx.skin(b, st);
        if (E.lava && G.phase !== "menu") fx.glowSides(b, [255, 96, 18], 0.5, 0.75, { flicker: time });
        if (lv() && lv().blockOver) lv().blockOver(L, b);
      },
      drawFloor() {
        drawFloor();
        photoEnv();
      },
      // the knight itself, lit and in 3D
      drawHero(J, alpha) {
        const ph = photo();
        if (!ph) return false;
        const F = ph.R.figure({ f: hero.f, r: hero.r, z: hero.z, yaw: hero.yaw, scale: S, height: 0.07 });
        if (F) {
          ph.M.knight(F, J, { time, speed: hero.speed / S });
          F.draw({ alpha, flash: hero.hurtT > 0 ? 0.55 * (hero.hurtT / 0.35) : 0, shadow: clamp(1 - (hero.z - api.groundAt(hero.f, hero.r, hero.z + 0.0005, 0.0005).h) / (0.2 * S), 0.2, 1) });
        }
        return true;
      },
      draw() {
        // laying out the cubes: only the guide -- the video is what matters
        if (G.phase === "setup") {
          drawGhosts();
          drawCubeNumbers();
          return;
        }
        const l = lv();
        if (l && l.draw) l.draw(L);
        drawBarricades();
        drawWalls();
        drawGates();
        drawProps();
        E.pickups.forEach(drawPickup);
        E.geysers.forEach(drawGeyser);
        A.draw(time);
        if (G.phase === "setup") drawGhosts();
        fx.parts.draw();
      },
      update(dt) {
        time += dt;
        // laying out the cubes: the game's touch buttons out of the video's way
        setupBar();
        showGameBtns();
        G.time += dt;
        fx.parts.update(dt);
        G.shake = Math.max(0, G.shake - dt * 2.5);
        if (G.phase === "setup") return updateSetup(dt);
        if (G.phase === "won") {
          G.wonT += dt;
          return;
        }
        if (G.phase !== "play" && G.phase !== "lost") return;
        updateHeroTimers(dt);
        if (G.phase === "lost") return;
        G.levelTime += dt;
        updateShield(dt);
        swordHits();
        A.update(dt);
        updateHazards(dt);
        updatePickups(dt);
        E.gates.forEach((g) => (g.lift = clamp(g.lift + (g.open ? dt * 0.8 : -dt * 1.2), 0, 1)));
        const l = lv();
        if (l.update) l.update(L, dt);
        const o = l.objective ? l.objective(L) : null;
        if (o) {
          L.obj = typeof o === "string" ? o : o.text;
          L.target = typeof o === "string" ? null : o.at ? o : null;
        }
        // stuck far below, or off the area: back to the start
        if (hero.z < -0.02) respawnOnStone();
      },
      hud() {
        if (G.phase === "menu") {
          drawMenu();
          return;
        }
        if (G.phase === "setup") {
          drawSetup();
          drawMap();
        } else drawHud();
      },
      title() {
        setupBar(); // (before the game starts its updates don't run)
        drawMenu();
        return true;
      },
      // laying out: no knight, the wheel tracks on, the camera on the next cube's place
      hideHero: () => G.phase === "setup",
      forceTracks: () => G.phase === "setup",
      forceTags: () => G.phase === "setup",
      camTarget() {
        if (G.phase !== "setup" || !G.items) return null;
        const focus = G.focus || 0;
        const it = G.items[focus] || G.items[0];
        const l = toF(it.at[0], it.at[1]);
        // The frame cube not found yet: the world's origin is just where the
        // robot started (it's on top of it -- the camera looked straight
        // down). Then the camera looks ahead, where the frame cube should go.
        const ch = api.chassis();
        if (focus === 0 && (!G.setup || G.setup.fr.s !== "ok" || Math.hypot(l.f - ch.f, l.r - ch.r) < 0.15)) {
          return [ch.f + Math.cos(ch.th) * FRAME_AHEAD_M, ch.r + Math.sin(ch.th) * FRAME_AHEAD_M, G.U / 2];
        }
        return [l.f, l.r, it.z * G.U];
      },
      helpLine(auto) {
        if (G.phase === "setup") return "Robot: right stick / arrows (the map: its front up) · Tab / RB, LB: look at another cube · L: menu";
        const bombs = lv() && (lv().bombs || G.bombs) ? " · Bomb B · Detonate E" : "";
        return `Knight: stick / WASD · Jump: Space · Sword: Fire · Shield: hold X${bombs} · L: menu`;
      },
      onFire(state) {
        if (G.phase === "menu") {
          startSelected(state);
          return true;
        }
        if (G.phase === "setup") {
          setupFire();
          return true;
        }
        if (G.phase === "won") {
          if (G.wonT > 0.6) nextLevel();
          return true;
        }
        if (G.phase === "lost") {
          retry();
          return true;
        }
        if (G.phase === "play") {
          if (!G.heroAlive) return true;
          if (SH.up) {
            bash();
            return true;
          }
          return false;
        }
        return true;
      },
      onWeapon(wpn) {
        const inMenu = G.phase === "menu";
        if (inMenu) {
          if (wpn === "next") choose(1);
          else if (wpn === "prev") choose(-1);
          else if (typeof wpn === "number" && wpn >= 1 && wpn <= LEVELS.length) {
            G.sel = wpn - 1;
            sfx("click");
          }
          return true;
        }
        if (G.phase === "setup" && G.items) {
          focusStep(wpn === "prev" ? -1 : 1);
          return true;
        }
        if (G.phase !== "play" || !(lv() && (lv().bombs || G.bombs || A.bombs.length))) return false;
        if (wpn === "next" || wpn === 1) placeBomb();
        else if (wpn === "prev" || wpn === 2) A.detonate();
        else return false;
        return true;
      },
      heroJoints(J) {
        if (!SH.up && SH.bashT <= 0) return;
        const k = SH.bashT > 0 ? 1 : 0;
        const c = [0.014 + 0.007 * k, -0.004, J.chest[2] + 0.001];
        J.hand[-1] = [c[0] - 0.002, c[1] - 0.004, c[2] - 0.002];
        J.elbow[-1] = [(J.sh[-1][0] + c[0]) / 2 - 0.002, (J.sh[-1][1] + c[1]) / 2 - 0.006, (J.sh[-1][2] + c[2]) / 2 - 0.005];
        J.shield = c;
      },
      heroPrims(J, prims, P) {
        if (!J.shield) return;
        const c = J.shield;
        const pt = (dy, dz) => P([c[0], c[1] + dy, c[2] + dz]);
        const poly = [pt(-0.0085, 0.011), pt(0.0085, 0.011), pt(0.0085, -0.002), pt(0, -0.014), pt(-0.0085, -0.002)];
        prims.push({ k: "poly", pts: poly, color: "#7d8794", lines: [[pt(0, 0.011), pt(0, -0.014)], [pt(-0.0085, 0.003), pt(0.0085, 0.003)]], lineColor: "rgba(200,170,70,0.9)" });
        for (let i = 0; i < poly.length; i++) prims.push({ k: "seg", a: poly[i], b: poly[(i + 1) % poly.length], rad: 0.0006 * S, color: "#c8a040" });
        prims.push({ k: "ball", c: pt(0, 0.003), rad: 0.0026 * S, color: "#d8b050" });
      },
      heroAlpha: () => (hero.inv > 0 && G.heroAlive && hero.inv < INV_S - 0.2 && hero.inv > 0.3 ? (Math.sin(time * 36) > 0 ? 0.45 : 1) : 1),
      snapshot: () => ({
        phase: G.phase, level: G.lv && G.lv.id, hearts: G.hearts, bombs: G.bombs, score: G.score, U: +G.U.toFixed(4), time: +G.levelTime.toFixed(1),
        shield: { up: SH.up, energy: +SH.energy.toFixed(2) }, frameOk: G.frameOk,
        setup: G.setup && { allOk: G.setup.allOk, missing: G.setup.missing, frame: G.setup.fr.s, cubes: G.setup.list.map((x) => `${x.en.tag}:${x.st.s}`) },
        enemies: A.enemies.map((e) => `${e.kind}:${e.state}:${e.hp}`), pickups: E.pickups.filter((p) => !p.taken).map((p) => p.kind), flags: { ...E.flags }, obj: L.obj,
      }),
      debug: { G, E, A, L, SH, LEVELS, loadLevel, beginPlay, winLevel, hurtHero, fx, setupState, cube, startSelected },
    };
  };
})(window.Lynx);
