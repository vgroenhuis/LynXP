// Temple of LynXP, level 8: the watchers' vault. Run by game_temple.js
// through Lynx.templeVault(api); parts from game_temple_kit.js.
//
// A stealth level. Stone eyes set in the walls sweep their gaze over the
// floor (you see it: a pale wedge, orange when an eye grows suspicious);
// a stone sentinel walks its round with its own gaze ahead of it. Stay in a
// gaze too long and the eye raises the alarm: it zaps you for as long as it
// sees you, and scarabs pour out. Gazes don't pass walls or pillars -- hide
// behind them. Gravel crunches when you drive fast: creep over it, or the
// eyes and the sentinel nearby turn toward the noise. Shoot a gong to make
// them look somewhere else.
// Three eye sigils (one in each hall) open the vault; the Crown of Eyes is
// inside, on a floor of gravel under the fastest eye. Take it and the eyes
// wake fully, and the portcullis at the way out starts to fall: a clock
// ticks. If it shuts, step onto the crown's dais to raise it again.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const K = Lynx.templeKit;
  const { clamp, inRect, cellI, cellJ, cellCenter, CELL, ROWS, COLS, R_MIN, R_MAX } = K;

  // # wall, . floor, g gravel, V the vault door (three sigils), X the
  // portcullis at the way out (falls once you have the crown).
  const MAP = K.parseMap([
    "############", // 19: the fastest eye looks down from here
    "#gggggggggg#", //     the vault: all gravel
    "#gggggggggg#", // 17: the Crown of Eyes
    "#VV#########", //     the vault door (west, out of the fast eye's line)
    "#..........#", // 15: the sentinel's hall
    "#..........#",
    "#..##..##..#", // 13: a niche (sigil)
    "#..######..#",
    "#..........#",
    "#..........#", // 10
    "###..####..#", //     two ways into the sentinel's hall (a sigil in the west one)
    "#..........#", //  8: the gallery of eyes
    "#..........#",
    "#gg##gg##gg#", //     a band of gravel, pillars in it:
    "#gg##gg##gg#", //  5: cover from the eyes on the side walls
    "#..........#",
    "#..........#",
    "#####XX#####", //  2: the portcullis
    "#..........#",
    "#..........#", //  0: the way in
  ]);
  const HALL = ["gallery of eyes", "sentinel's hall", "vault"];
  const hallOf = (f) => (f < 9 * CELL ? 0 : f < 16 * CELL ? 1 : 2);

  const DIFF = {
    easy: { range: 1.0, half: 22, seeS: 1.1, sweep: 14, creep: 0.18, exitS: 60, patrol: 0.07, zapS: 2.6, scarabs: 1, bats: 1 },
    normal: { range: 1.3, half: 25, seeS: 0.8, sweep: 20, creep: 0.15, exitS: 45, patrol: 0.09, zapS: 2.0, scarabs: 2, bats: 2 },
    hard: { range: 1.5, half: 28, seeS: 0.55, sweep: 27, creep: 0.12, exitS: 36, patrol: 0.11, zapS: 1.5, scarabs: 3, bats: 3 },
  };
  const EYE_H = 0.15;
  const CALM_S = 3; // an alarmed eye that's lost you calms down after this long
  const NOISE = { gravel: { rad: 0.9, look: 2.5 }, gong: { rad: 2.0, look: 6 } };
  const TURN_DEG_S = 140; // how fast an eye turns to look at a noise
  const ESCAPE_K = 1.6; // after the crown: sweeps this much faster
  const SENTINEL = { range: 0.7, half: 22, rad: 0.07, stuckS: 1.5 }; // stuckS: blocked this long, it turns back

  // eyes on a wall's face (f, r), sweeping between a0 and a1 (degrees:
  // 0 = north/+f, 90 = east/+r), `fast` times the usual speed
  const EYES = [
    { id: "W1", f: 6 * CELL, r: R_MAX - CELL, a0: -150, a1: -30, fast: 1 }, // the gallery, from the east wall, level with the pillars
    { id: "W2", f: 6 * CELL, r: R_MIN + CELL, a0: 30, a1: 150, fast: 0.75 }, // the same from the west wall
    { id: "W3", f: 16 * CELL, r: R_MIN + 9.5 * CELL, a0: 160, a1: 250, fast: 1 }, // the sentinel's hall, from its north wall: the east corridor
    { id: "W4", f: 19 * CELL, r: 0, a0: 110, a1: 250, fast: 1.6 }, // the vault
  ];
  const GONGS = [
    { f: 9 * CELL, r: R_MIN + 5 * CELL, h: 0.17, n: { f: -1, r: 0 } }, // the gallery's north wall
    { f: 15.5 * CELL, r: R_MIN + CELL, h: 0.17, n: { f: 0, r: 1 } }, // the sentinel's hall, west
    { f: 18 * CELL, r: R_MAX - CELL, h: 0.17, n: { f: 0, r: -1 } }, // the vault, east
  ];
  // the sentinel's round, along the corridors' far sides (room to hide in the niche and the alcove)
  const ROUND = [{ f: 1.7, r: -0.62 }, { f: 1.7, r: 0.62 }, { f: 2.28, r: 0.62 }, { f: 2.28, r: -0.62 }];

  const WALL = { top: "#8a8a92", side: "#62626c", dark: "#46464e", line: "rgba(10,10,15,0.6)", mortar: true, tex: "crypt" };
  const VDOOR = { top: "#a08a50", side: "#7a6430", dark: "#58461e", line: "rgba(30,20,4,0.9)", door: true, doorH: 0.3, symbol: "eye", glyph: "#e8dcb0" };

  const EYE_SPR = ["..kkkkkk..", ".kwwwwwwk.", "kwwiiiiwwk", "kwiippiiwk", "kwwiiiiwwk", ".kwwwwwwk.", "..kkkkkk.."];
  const KNIGHT = [
    "....kkkk....", "...kssssk...", "...ksrrsk...", "...kssssk...", "....kkkk....", "..kssssssk..", ".ksskssksskk", "kssskssksssk",
    "k.ksssssskk.", "k.kssddssk..", "..kssddssk..", "..kssssssk..", "..ksk..ksk..", "..ksk..ksk..", ".kssk..kssk.", ".kkkk..kkkk.",
  ];
  const SIGIL = ["..kkk..", ".kyyyk.", "kyk.kyk", "ky.b.yk", "kyk.kyk", ".kyyyk.", "..kkk.."];
  const CROWN = ["y..y..y", "yy.y.yy", "yyyyyyy", "yrybyry", "yyyyyyy"];

  Lynx.templeVault = (api) => {
    const { ar } = api;
    const diff = api.cfg.difficulty in DIFF ? api.cfg.difficulty : "normal";
    const D = DIFF[diff];
    const img = {
      eye: Lynx.sprite(EYE_SPR, { k: "#2a2a30", w: "#e8e4d8", i: "#c89020", p: "#101010" }),
      eyeWary: Lynx.sprite(EYE_SPR, { k: "#2a2a30", w: "#ffe0b0", i: "#ff8020", p: "#101010" }),
      eyeAlarm: Lynx.sprite(EYE_SPR, { k: "#300808", w: "#ffc0c0", i: "#ff2020", p: "#ffffff" }),
      knight: Lynx.sprite(KNIGHT, { k: "#1e1e22", s: "#8a8a94", r: "#ffb040", d: "#5a5a64" }),
      sigil: Lynx.sprite(SIGIL, { k: "#3a2a08", y: "#e0b030", b: "#40a0ff" }),
      crown: Lynx.sprite(CROWN, { y: "#ffd040", r: "#ff2050", b: "#40a0ff" }),
    };

    const cell = (i, j) => (i < 0 || i >= ROWS || j < 0 || j >= COLS ? "#" : MAP[i][j]);
    const rectOf = (ch) => K.rectWhere((i, j) => MAP[i][j] === ch);
    const walls = K.mergeCells((i, j) => cell(i, j) === "#").map((q) => ({ ...q, h0: 0, h1: 0.3 }));
    const wallsDrawn = K.mergeCells((i, j) => cell(i, j) === "#" && !api.onRim(i, j, ROWS, COLS));
    const rimWalls = K.mergeCells((i, j) => cell(i, j) === "#" && api.onRim(i, j, ROWS, COLS));
    const outer = K.outerWalls(CELL).filter((q) => !K.behindRim(q, (f, r) => cell(cellI(f), cellJ(r)) === "#"));
    const gravel = K.mergeCells((i, j) => cell(i, j) === "g");
    const vaultDoor = { ...rectOf("V"), open: 0 };
    const exitRect = rectOf("X");
    const dais = { f0: 16.8 * CELL, f1: 18.2 * CELL, r0: -0.1, r1: 0.1 }; // where the crown lies: step on it to raise the portcullis again
    let exitGate = null; // K.timedGate once you have the crown

    const eyes = EYES.map((e) => ({ ...e, phi: (e.a0 + e.a1) / 2, dir: 1, sus: 0, alarm: false, lostT: 0, zapT: 0, look: null, lookT: 0, wedge: [], rect: null, flash: 0 }));
    const sentinel = { f: ROUND[0].f, r: ROUND[0].r, k: 1, way: 1, stuck: 0, phi: 90, sus: 0, alarm: false, lostT: 0, zapT: 0, look: null, lookT: 0, wedge: [], rect: null, hit: 0, walk: 0 };
    const gongs = GONGS.map((g) => ({ ...g, hit: 0, cool: 0, rect: null }));
    const items = [
      { kind: "sigil", f: 6 * CELL, r: 0, base: 0 }, // the gallery: in the gravel between the pillars, out of the eyes' sight
      { kind: "sigil", f: 13.5 * CELL - 0.02, r: 0, base: 0 }, // the niche
      { kind: "sigil", f: 9.5 * CELL, r: R_MIN + 4 * CELL, base: 0 }, // the west way into the sentinel's hall
      { kind: "gem", ...cellCenter(3, 1), base: 0 },
      { kind: "gem", ...cellCenter(8, 10), base: 0 },
      { kind: "potion", ...cellCenter(10, 1), base: 0 },
      { kind: "gem", ...cellCenter(15, 1), base: 0 },
      { kind: "bigGem", ...cellCenter(18, 1), base: 0 },
      { kind: "bigGem", ...cellCenter(18, 10), base: 0 },
      { kind: "crown", f: 17.5 * CELL, r: 0, base: 0.02, size: 0.07, glow: "rgba(255,220,120,0.9)" },
    ];
    let sigils = 0;
    let crown = false;
    let everSeen = false; // an alarm was raised (a glimpse doesn't count)
    let speed = 0; // the robot's, smoothed (m/s)
    let lastMe = null;
    let crunchT = 0;
    let loud = 0; // 0..1+: how loud your driving is on gravel (for the meter)
    let onDais = false;
    const woken = new Set();

    // -- solids, sight -----------------------------------------------------------------------
    const exitShut = () => exitGate !== null && exitGate.shut();
    function solids() {
      const out = walls.slice();
      if (vaultDoor.open < 1) out.push({ ...vaultDoor, h0: 0, h1: 0.3 * (1 - vaultDoor.open) });
      if (exitShut()) out.push({ ...exitRect, h0: 0, h1: 0.3 });
      out.push({ f0: sentinel.f - SENTINEL.rad, f1: sentinel.f + SENTINEL.rad, r0: sentinel.r - SENTINEL.rad, r1: sentinel.r + SENTINEL.rad, h0: 0, h1: 0.25 });
      return out;
    }
    const boundary = K.boundary();
    const blockers = (feet) => solids().concat(boundary).filter((b) => b.h1 > feet + K.STEP_UP && b.h0 < feet + K.BODY_H);
    const stopper = K.wallStopper(api, blockers);
    function pointSolid(f, r, h) {
      if (h > 0.3) return false;
      const c = cell(cellI(f), cellJ(r));
      if (c === "#") return true;
      if (c === "V" && h <= 0.3 * (1 - vaultDoor.open)) return true;
      return c === "X" && exitShut();
    }
    function lineOfSight(a, b) {
      const len = Math.hypot(b.f - a.f, b.r - a.r, b.h - a.h);
      const n = Math.max(1, Math.ceil(len / 0.03));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        if (pointSolid(a.f + (b.f - a.f) * t, a.r + (b.r - a.r) * t, a.h + (b.h - a.h) * t)) return false;
      }
      return true;
    }
    const enemies = K.enemyPack(api, {
      pointSolid,
      lineOfSight,
      walkOk: (e, f, r) => !"#VX".includes(cell(cellI(f), cellJ(r))),
    });

    // -- gazes -------------------------------------------------------------------------------
    const rad = (deg) => (deg * Math.PI) / 180;
    const angTo = (from, p) => (Math.atan2(p.r - from.r, p.f - from.f) * 180) / Math.PI;
    const angDiff = (a, b) => ((((a - b) % 360) + 540) % 360) - 180;
    const range = (w) => (w === sentinel ? SENTINEL.range : D.range + (crown ? 0.2 : 0));
    const halfOf = (w) => (w === sentinel ? SENTINEL.half : D.half);
    // the floor a gaze covers: a fan of rays stopped by walls
    function wedge(w) {
      const pts = [{ f: w.f, r: w.r }];
      const half = halfOf(w);
      const reach = range(w);
      for (let a = -half; a <= half + 1e-6; a += 5) {
        const t = rad(w.phi + a);
        const df = Math.cos(t);
        const dr = Math.sin(t);
        let d = 0.02;
        while (d < reach && !pointSolid(w.f + df * d, w.r + dr * d, 0.05)) d += 0.03;
        pts.push({ f: w.f + df * Math.min(d, reach), r: w.r + dr * Math.min(d, reach) });
      }
      return pts;
    }
    function sees(w, me) {
      const dist = Math.hypot(me.f - w.f, me.r - w.r);
      if (dist > range(w) || dist < 0.01) return false;
      if (Math.abs(angDiff(angTo(w, me), w.phi)) > halfOf(w)) return false;
      return lineOfSight({ f: w.f, r: w.r, h: EYE_H }, { f: me.f, r: me.r, h: ar.feet() + 0.06 });
    }
    // a noise at p: the gazes within reach turn to look (no line of sight needed)
    function noise(p, kind) {
      const n = NOISE[kind];
      eyes.concat([sentinel]).forEach((w) => {
        if (w.alarm || Math.hypot(p.f - w.f, p.r - w.r) > n.rad) return;
        w.look = { f: p.f, r: p.r };
        w.lookT = n.look;
      });
    }
    function turnToward(w, target, dt, limits) {
      let want = target;
      if (limits) {
        // an eye in a wall turns no further than 35 degrees past its sweep
        const mid = (limits.a0 + limits.a1) / 2;
        const span = (limits.a1 - limits.a0) / 2 + 35;
        want = mid + clamp(angDiff(target, mid), -span, span);
      }
      const d = angDiff(want, w.phi);
      w.phi += Math.sign(d) * Math.min(Math.abs(d), TURN_DEG_S * dt);
    }
    // one gaze's frame: look (sweep, a noise, or you), grow suspicious, raise the alarm, zap
    function watch(w, dt, me, limits) {
      const seen = sees(w, me);
      if (seen) {
        if (!w.alarm) {
          if (w.sus === 0) Lynx.sfx.play("suspect");
          w.sus += dt / D.seeS;
          if (w.sus >= 1) raiseAlarm(w);
        }
        w.lostT = 0;
      } else if (!w.alarm) w.sus = Math.max(0, w.sus - dt);
      if (w.alarm) {
        if (seen) {
          turnToward(w, angTo(w, me), dt * 3, limits);
          w.zapT -= dt;
          if (w.zapT <= 0) {
            w.zapT = D.zapS;
            w.flash = 0.2;
            Lynx.sfx.play("zap");
            api.hurt(w === sentinel ? "The sentinel's glare burns!" : "The eye's glare burns!");
          }
        } else {
          w.lostT += dt;
          if (w.lostT >= CALM_S) {
            w.alarm = false;
            w.sus = 0;
          }
        }
        return;
      }
      if (w.lookT > 0) {
        w.lookT -= dt;
        turnToward(w, angTo(w, w.look), dt, limits);
        return;
      }
      if (limits && !w.frozen) {
        // sweep to and fro
        const k = w.fast * (crown ? ESCAPE_K : 1);
        w.phi += w.dir * D.sweep * k * dt;
        if (w.phi >= limits.a1) w.dir = -1;
        if (w.phi <= limits.a0) w.dir = 1;
        w.phi = clamp(w.phi, limits.a0 - 40, limits.a1 + 40);
      }
    }
    function raiseAlarm(w) {
      w.alarm = true;
      w.sus = 1;
      w.zapT = 0;
      w.lostT = 0;
      everSeen = true;
      Lynx.sfx.play("alarm");
      api.say(w === sentinel ? "The sentinel has seen you!" : "An eye has seen you -- get out of its sight!", "#ff6060");
      alarmSpawn(w);
    }
    let spawned = 0;
    function alarmSpawn(w) {
      if (spawned >= D.scarabs) return;
      spawned++;
      const t = rad(w.phi);
      enemies.add("scarab", { f: w.f + Math.cos(t) * 0.2, r: w.r + Math.sin(t) * 0.2 }, 0, { wait: 0.5, sees: true });
    }

    function updateSentinel(dt, me) {
      sentinel.hit = Math.max(0, sentinel.hit - dt);
      const busy = sentinel.lookT > 0 && !sentinel.alarm; // it stops to look at a noise; alarmed, it glares as it walks
      if (!busy) {
        const goal = ROUND[sentinel.k];
        const df = goal.f - sentinel.f;
        const dr = goal.r - sentinel.r;
        const dist = Math.hypot(df, dr);
        const v = D.patrol * (crown ? 1.5 : 1);
        // don't walk into the robot: wait, and after a while turn back
        const next = { f: sentinel.f + (df / (dist || 1)) * 0.05, r: sentinel.r + (dr / (dist || 1)) * 0.05 };
        const blocked = Math.hypot(next.f - me.f, next.r - me.r) < SENTINEL.rad + K.CLEAR;
        sentinel.stuck = blocked ? sentinel.stuck + dt : 0;
        if (sentinel.stuck > SENTINEL.stuckS) {
          sentinel.stuck = 0;
          sentinel.k = (sentinel.k - sentinel.way + ROUND.length) % ROUND.length;
          sentinel.way = -sentinel.way;
        } else if (dist < v * dt) {
          sentinel.f = goal.f;
          sentinel.r = goal.r;
          sentinel.k = (sentinel.k + sentinel.way + ROUND.length) % ROUND.length;
        } else if (!blocked) {
          sentinel.f += (df / dist) * v * dt;
          sentinel.r += (dr / dist) * v * dt;
          sentinel.walk += dt;
        }
        turnToward(sentinel, angTo(sentinel, goal), dt, null);
      }
      watch(sentinel, dt, me, null);
      sentinel.phi = angDiff(sentinel.phi, 0); // (it turns all the way round: keep the angle in -180..180)
      // bumping into it
      if (Math.hypot(me.f - sentinel.f, me.r - sentinel.r) < SENTINEL.rad + K.CLEAR + 0.01 && ar.feet() < 0.2 && !sentinel.alarm) {
        raiseAlarm(sentinel);
        sentinel.phi = angTo(sentinel, me);
      }
    }

    // -- every frame ---------------------------------------------------------------------------
    function physics() {
      ar.setGround(0);
    }
    function wake(zone) {
      if (woken.has(zone)) return;
      woken.add(zone);
      if (zone === "escape") [cellCenter(14, 2), cellCenter(10, 9), cellCenter(6, 5)].slice(0, D.bats).forEach((p) => enemies.add("bat", p, 0.25));
    }

    function update(dt, me) {
      const feet = ar.feet();
      // how fast you drive (smoothed), and gravel noise
      if (lastMe && dt > 0) {
        const v = Math.hypot(me.f - lastMe.f, me.r - lastMe.r) / dt;
        speed += (Math.min(v, 1) - speed) * Math.min(1, dt * 10);
      }
      lastMe = { f: me.f, r: me.r };
      const onGravel = cell(cellI(me.f), cellJ(me.r)) === "g" && feet < 0.02;
      loud = onGravel ? speed / D.creep : 0;
      crunchT -= dt;
      if (onGravel && speed > D.creep && crunchT <= 0) {
        crunchT = 0.35;
        Lynx.sfx.play("crunch");
        noise(me, "gravel");
      }
      if (onGravel && justLanded()) {
        Lynx.sfx.play("crunch");
        noise(me, "gravel");
      }

      eyes.forEach((w) => {
        w.flash = Math.max(0, w.flash - dt);
        watch(w, dt, me, w);
        w.wedge = wedge(w);
      });
      updateSentinel(dt, me);
      sentinel.wedge = wedge(sentinel);
      gongs.forEach((g) => {
        g.hit = Math.max(0, g.hit - dt);
        g.cool = Math.max(0, g.cool - dt);
      });

      // doors
      if (sigils >= 3) vaultDoor.open = Math.min(1, vaultDoor.open + dt * 0.8);
      if (exitGate) {
        exitGate.update(dt);
        const on = inRect(me.f, me.r, dais) && feet < 0.05;
        if (on && !onDais && !exitGate.open) exitGate.press();
        onDais = on;
      }

      enemies.update(dt, me, K.camLocal(api));
      K.pickUp(api, items, me, feet, (it) => {
        if (it.kind === "sigil") {
          sigils++;
          api.addScore(500);
          Lynx.sfx.play("power");
          api.say(sigils < 3 ? `An eye sigil -- ${sigils} of 3` : "The third sigil! The vault door grinds open", "#ffd84a");
          if (sigils === 3) Lynx.sfx.play("gate");
          return true;
        }
        if (it.kind === "crown") {
          crown = true;
          api.addScore(3000);
          Lynx.sfx.play("alarm");
          exitGate = K.timedGate(api, D.exitS);
          exitGate.lift = 1;
          exitGate.press();
          onDais = true;
          api.say(`The Crown of Eyes! Every eye wakes -- the portcullis is falling: ${D.exitS} s!`, "#ffd84a");
          wake("escape");
          return true;
        }
        return false;
      });
      if (crown && me.f < 2 * CELL - 0.05) {
        if (!everSeen) {
          api.addScore(2000);
          api.say("Unseen! +2000", "#80ff80");
        }
        api.complete();
      }
    }
    let lastLanding = null;
    function justLanded() {
      if (!ar.landedAt || ar.landedAt === lastLanding) return false;
      lastLanding = ar.landedAt;
      return true;
    }

    // -- shooting ------------------------------------------------------------------------------
    function targets() {
      const out = enemies.targets();
      gongs.forEach((g) => g.rect && out.push({ obj: g, kind: "gong" }));
      if (sentinel.rect) out.push({ obj: sentinel, kind: "sentinel" });
      return out;
    }
    function hit(t) {
      if (t.kind === "gong") {
        const g = t.obj;
        g.hit = 0.3;
        if (g.cool > 0) return;
        g.cool = 3;
        Lynx.sfx.play("gong");
        noise({ f: g.f + g.n.f * 0.05, r: g.r + g.n.r * 0.05 }, "gong");
        return;
      }
      if (t.kind === "sentinel") {
        sentinel.hit = 0.15;
        Lynx.sfx.play("knock"); // stone: shots do nothing
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
    const gazeColor = (w, a) => (w.alarm ? `rgba(255,50,40,${a})` : w.sus > 0 ? `rgba(255,${Math.round(200 - 120 * w.sus)},40,${a})` : `rgba(255,240,160,${a})`);
    function drawGaze(w) {
      const pts = w.wedge;
      if (pts.length < 3) return;
      // as a fan of thin triangles: the lens can't take one big polygon reaching behind the camera
      for (let k = 1; k + 1 < pts.length; k++) {
        const tri = [pts[0], pts[k], pts[k + 1]].map((p) => api.w3(p.f, p.r, 0.004));
        const p = api.polyScreen(tri, 4);
        if (p) api.fillPoly(p, gazeColor(w, 0.22), null);
      }
      const edge = (p) => api.line3([[pts[0].f, pts[0].r, 0.005], [p.f, p.r, 0.005]], gazeColor(w, 0.6), 1.5, 0.06);
      edge(pts[1]);
      edge(pts[pts.length - 1]);
    }
    function drawFloor() {
      K.mergeCells((i, j) => cell(i, j) !== "#").forEach((q) => {
        fillRect(q, 0.001, "rgba(30,30,36,0.3)", "rgba(90,90,100,0.3)");
        if (api.floorDetail) api.floorDetail(q);
      });
      gravel.forEach((q) => {
        fillRect(q, 0.002, "rgba(120,110,95,0.55)", "rgba(60,55,45,0.6)", 1);
        // speckles
        for (let f = q.f0 + 0.04; f < q.f1; f += 0.075) {
          for (let r = q.r0 + 0.03; r < q.r1; r += 0.075) {
            const jf = ((Math.sin(f * 91 + r * 37) + 1) / 2) * 0.03;
            api.line3([[f + jf, r, 0.003], [f + jf + 0.008, r + 0.006, 0.003]], "rgba(40,36,30,0.7)", 2, 0.02);
          }
        }
      });
      if (exitGate) {
        const lit = exitGate.open && !exitGate.held;
        fillRect(dais, 0.004, lit ? "rgba(255,216,74,0.35)" : "rgba(160,128,64,0.5)", "#5a4010", 2);
      }
      eyes.forEach(drawGaze);
      drawGaze(sentinel);
    }
    function queueEye(w, c) {
      // on the wall's face, a little out from it
      const n = { f: Math.cos(rad((w.a0 + w.a1) / 2)), r: Math.sin(rad((w.a0 + w.a1) / 2)) };
      const p = { f: w.f + n.f * 0.015, r: w.r + n.r * 0.015 };
      if ((c.f - w.f) * n.f + (c.r - w.r) * n.r <= 0) return; // behind its wall
      const at = api.toWorld(p.f, p.r);
      const spr = w.alarm ? img.eyeAlarm : w.sus > 0 ? img.eyeWary : img.eye;
      api.drawSprite(w, spr, at.x, at.y, EYE_H - 0.035, 0.07, {
        before: (rc) => (w.alarm || w.flash > 0) && ar.glow(rc.cx, rc.y + rc.h / 2, rc.w * 1.6, [[0, "rgba(255,60,40,0.7)"], [1, "rgba(255,0,0,0)"]]),
      });
    }

    function draw() {
      const c = K.camLocal(api);
      drawFloor();
      wallsDrawn.forEach((q) => api.box(q, 0, 0.3, WALL));
      rimWalls.forEach((q) => api.fence(q, 0, 0.3));
      outer.forEach((q) => api.fence(q, 0, 0.3));
      if (vaultDoor.open < 1) api.box(vaultDoor, 0, 0.3 * (1 - vaultDoor.open), VDOOR);
      K.queueBars(api, exitRect, 0, 0.3, exitGate ? exitGate.lift : 1);
      eyes.forEach((w) => queueEye(w, c));
      gongs.forEach((g) => K.sunDisk(api, g, c, lineOfSight, g.cool > 0 ? "#fff0a0" : "#8a5a18", g.cool > 0));
      const sw = api.toWorld(sentinel.f, sentinel.r);
      if (lineOfSight({ f: sentinel.f, r: sentinel.r, h: 0.15 }, c)) {
        api.drawSprite(sentinel, img.knight, sw.x, sw.y, Math.abs(Math.sin(sentinel.walk * 6)) * 0.004, 0.22, {
          flip: angDiff(sentinel.phi, angTo(sentinel, c)) > 0,
          after: (rc) => sentinel.alarm && ar.glow(rc.cx, rc.y + rc.h * 0.15, rc.w * 0.8, [[0, "rgba(255,60,40,0.8)"], [1, "rgba(255,0,0,0)"]]),
        });
      } else sentinel.rect = null;
      K.drawItems(api, items, c, lineOfSight, img);
      enemies.queue(c);
      ar.flush();
    }

    function hud() {
      if (exitGate) exitGate.hud();
      const v = ar.view;
      // the noise meter, on gravel
      if (loud > 0 || cell(cellI(lastMe ? lastMe.f : 0), cellJ(lastMe ? lastMe.r : 0)) === "g") {
        const w = Math.min(200, v.w * 0.3);
        const x = v.cx - w / 2;
        const y = v.y + v.h * 0.78;
        const g = ar.ctx;
        g.save();
        g.fillStyle = "rgba(0,0,0,0.5)";
        g.fillRect(x - 3, y - 3, w + 6, 14);
        g.fillStyle = loud > 1 ? "#ff5040" : loud > 0.7 ? "#ffb030" : "#80e080";
        g.fillRect(x, y, w * clamp(loud / 1.5, 0, 1), 8);
        g.fillStyle = "#ffffff";
        g.fillRect(x + w / 1.5 - 1, y - 3, 2, 14);
        g.restore();
        ar.text(loud > 1 ? "GRAVEL -- TOO LOUD! Creep" : "gravel: creep", v.cx, y + 24, { size: 12, align: "center", color: loud > 1 ? "#ff6060" : "#c0e0c0" });
      }
      const worst = eyes.concat([sentinel]).reduce((m, w) => Math.max(m, w.alarm ? 2 : w.sus), 0);
      if (worst > 0) ar.text(worst >= 2 ? "👁 SEEN!" : "👁 ?", v.x + 14, v.y + v.h * 0.2, { size: 18, align: "left", color: worst >= 2 ? "#ff4040" : "#ffb030" });
      const map = K.minimap(api, (i, j) => {
        const ch = cell(i, j);
        if (ch === "#") return "#4a4a52";
        if (ch === "g") return "#8a7e68";
        if (ch === "V") return vaultDoor.open < 0.9 ? "#a08a50" : "#9a9a9a";
        if (ch === "X") return exitShut() ? "#2e2e34" : "#9a9a9a";
        return "#9a9a9a";
      }, `${HALL[hallOf(lastMe ? lastMe.f : 0)].toUpperCase()} · SIGILS ${sigils}/3`, [{ f: sentinel.f, r: sentinel.r, color: "#e0e0f0" }]);
      if (!map) return;
      const g = ar.ctx;
      g.save();
      eyes.concat([sentinel]).forEach((w) => {
        const pts = w.wedge;
        if (pts.length < 3) return;
        g.fillStyle = gazeColor(w, 0.45);
        g.beginPath();
        pts.forEach((p, k) => {
          const q = map.at(p.f, p.r);
          if (k) g.lineTo(q.x, q.y);
          else g.moveTo(q.x, q.y);
        });
        g.closePath();
        g.fill();
      });
      g.restore();
    }

    function objective() {
      const me = lastMe || { f: 0, r: 0 };
      const go = (text, p, h = 0.1) => ({ text, at: { f: p.f, r: p.r }, h });
      if (crown) {
        if (exitShut()) return go("The portcullis fell! Back to the crown's dais to raise it, then run", { f: 17.5 * CELL, r: 0 }, 0.02);
        return go(`Out! Past every eye to the portcullis -- ${Math.ceil(exitGate.remaining)} s`, { f: 0.1, r: 0 });
      }
      if (sigils >= 3) return go("The vault is open: creep over the gravel under the eye, take the Crown of Eyes", { f: 17.5 * CELL, r: 0 }, 0.05);
      const next = items.filter((it) => it.kind === "sigil").sort((a, b) => Math.hypot(a.f - me.f, a.r - me.r) - Math.hypot(b.f - me.f, b.r - me.r))[0];
      const tip = hallOf(me.f) === 0 ? "Stay out of the eyes' gaze (hide behind pillars), creep over gravel, shoot a gong to distract them" : "The sentinel walks its round: slip past behind it. Its gaze and the eye's are what matter";
      return go(`Eye sigils ${sigils}/3 -- ${tip}`, next || { f: 17.5 * CELL, r: 0 }, 0.05);
    }

    return {
      physics,
      update,
      draw,
      hud,
      objective,
      blips: () => enemies.blips().concat(items.map((it) => ({ ...api.toWorld(it.f, it.r), color: it.kind === "sigil" || it.kind === "crown" ? "#ffe060" : "#ffd84a", r: 2.5 }))),
      targets,
      hit,
      carryOn: () => {
        enemies.carryOn();
        eyes.concat([sentinel]).forEach((w) => {
          w.alarm = false;
          w.sus = 0;
        });
      },
      filterDrive: stopper.filterDrive,
      floorName: () => HALL[hallOf(lastMe ? lastMe.f : 0)],
      debug: {
        eyes, sentinel, gongs, vaultDoor,
        clear: () => enemies.list.splice(0),
        sees: (id, at) => sees(id === "S" ? sentinel : eyes.find((w) => w.id === id), at || lastMe),
        speed: () => speed,
        exitGate: () => exitGate,
        ring: (k) => hit({ kind: "gong", obj: gongs[k] }),
        freeze: (on) => eyes.forEach((w) => (w.frozen = on)),
      },
      snapshot: () => ({
        hall: HALL[hallOf(lastMe ? lastMe.f : 0)], sigils, crown, everSeen,
        eyes: eyes.map((w) => `${w.id}:${Math.round(w.phi)}${w.alarm ? "!" : w.sus > 0 ? "?" : ""}`).join(" "),
        sentinel: { f: +sentinel.f.toFixed(2), r: +sentinel.r.toFixed(2), phi: Math.round(sentinel.phi), alarm: sentinel.alarm },
        vault: +vaultDoor.open.toFixed(2), exit: exitGate ? (exitGate.open ? +exitGate.remaining.toFixed(1) : "shut") : "open",
        speed: +speed.toFixed(2), loud: +loud.toFixed(2),
        enemies: enemies.list.map((e) => e.kind), items: items.map((it) => it.kind),
      }),
    };
  };
})(window.Lynx);
