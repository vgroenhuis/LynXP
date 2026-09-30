// Shared parts for the Temple of LynXP's later levels (game_temple_sky.js,
// game_temple_cistern.js): the 15 cm cell grid over the 2 x 3 m floor, walls
// that stop the robot, enemies, sun-disk switches, a minimap, items, and the
// timed gate -- a button opens a gate somewhere else for a while, a clock
// ticks until it shuts again.
//
// Temple coordinates as everywhere: f forward from the entrance, r to the
// right, h up (m). A level talks to game_temple.js through `api` (see
// mazeApi there).

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const CELL = 0.15;
  const ROWS = 20; // along f
  const COLS = 12; // along r
  const R_MIN = -0.9;
  const R_MAX = R_MIN + COLS * CELL;
  const LEN = ROWS * CELL;
  const CLEAR = 0.11; // the robot keeps this far from walls
  const STEP_UP = 0.06; // ledges this high you walk onto
  const BODY_H = 0.12; // solids this far above your feet stop you
  const TOUCH_M = 0.11;

  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const cellI = (f) => Math.floor(f / CELL);
  const cellJ = (r) => Math.floor((r - R_MIN) / CELL);
  const cellRect = (i0, i1, j0, j1) => ({ f0: i0 * CELL, f1: (i1 + 1) * CELL, r0: R_MIN + j0 * CELL, r1: R_MIN + (j1 + 1) * CELL });
  const cellCenter = (i, j) => ({ f: (i + 0.5) * CELL, r: R_MIN + (j + 0.5) * CELL });
  const inRect = (f, r, q) => f >= q.f0 && f <= q.f1 && r >= q.r0 && r <= q.r1;
  const grow = (q, m) => ({ ...q, f0: q.f0 - m, f1: q.f1 + m, r0: q.r0 - m, r1: q.r1 + m });
  const overlaps = (a, b) => a.f0 < b.f1 - 1e-6 && b.f0 < a.f1 - 1e-6 && a.r0 < b.r1 - 1e-6 && b.r0 < a.r1 - 1e-6;

  // A map: far end first, as seen from the entrance, one character per cell.
  // Returned as [row i][col j] with row 0 at the entrance.
  function parseMap(lines) {
    if (lines.length !== ROWS || lines.some((l) => l.length !== COLS)) throw new Error("temple map must be 20 x 12");
    return lines.slice().reverse();
  }
  // Cells matching pred merged into few rectangles: runs along r, then equal
  // runs in neighbouring rows joined.
  function mergeCells(pred) {
    const open = new Map();
    const out = [];
    for (let i = 0; i <= ROWS; i++) {
      const runs = new Set();
      if (i < ROWS) {
        for (let j = 0; j < COLS; j++) {
          if (!pred(i, j)) continue;
          let k = j;
          while (k + 1 < COLS && pred(i, k + 1)) k++;
          runs.add(`${j},${k}`);
          j = k;
        }
      }
      for (const [key, rect] of open) {
        if (!runs.has(key)) {
          out.push(rect);
          open.delete(key);
        }
      }
      runs.forEach((key) => {
        const [j0, j1] = key.split(",").map(Number);
        if (open.has(key)) open.get(key).f1 = (i + 1) * CELL;
        else open.set(key, cellRect(i, i, j0, j1));
      });
    }
    return out;
  }
  // bounding rect of the cells matching pred
  function rectWhere(pred) {
    let i0 = ROWS, i1 = -1, j0 = COLS, j1 = -1;
    for (let i = 0; i < ROWS; i++) {
      for (let j = 0; j < COLS; j++) {
        if (!pred(i, j)) continue;
        i0 = Math.min(i0, i); i1 = Math.max(i1, i); j0 = Math.min(j0, j); j1 = Math.max(j1, j);
      }
    }
    return i1 < 0 ? null : cellRect(i0, i1, j0, j1);
  }

  // The invisible walls round the 2 x 3 m (the robot never leaves it).
  function boundary() {
    const OUT = 5;
    return [
      { f0: -OUT, f1: 0, r0: -OUT, r1: OUT, h0: -3, h1: 5 },
      { f0: LEN, f1: OUT, r0: -OUT, r1: OUT, h0: -3, h1: 5 },
      { f0: -OUT, f1: OUT, r0: -OUT, r1: R_MIN, h0: -3, h1: 5 },
      { f0: -OUT, f1: OUT, r0: R_MAX, r1: OUT, h0: -3, h1: 5 },
    ];
  }
  // The outer walls to draw, 0.6 m pieces; `gap`: the entrance's half width.
  function outerWalls(gap) {
    const T = 0.06;
    const out = [];
    for (let f = 0; f < LEN - 1e-6; f += 0.6) {
      out.push({ f0: f, f1: Math.min(LEN, f + 0.6), r0: R_MIN - T, r1: R_MIN });
      out.push({ f0: f, f1: Math.min(LEN, f + 0.6), r0: R_MAX, r1: R_MAX + T });
    }
    out.push({ f0: LEN, f1: LEN + T, r0: R_MIN - T, r1: 0 });
    out.push({ f0: LEN, f1: LEN + T, r0: 0, r1: R_MAX + T });
    out.push({ f0: -T, f1: 0, r0: R_MIN - T, r1: -gap });
    out.push({ f0: -T, f1: 0, r0: gap, r1: R_MAX + T });
    return out;
  }

  // Is an outer wall piece (just outside the grid) backed by wall cells all
  // along its inside? Then those cells' grating stands right in front of it
  // and the piece is left out (two gratings in a row hide the room again).
  function behindRim(q, isWallAt) {
    const E = 0.02;
    let pts;
    const along = (a, b, at) => {
      const out = [];
      for (let s = Math.max(a, 0) + 0.01; s < b - 0.005; s += 0.05) out.push(at(s));
      return out;
    };
    if (q.r1 <= R_MIN + 1e-6) pts = along(q.f0, Math.min(q.f1, LEN), (f) => [f, R_MIN + E]);
    else if (q.r0 >= R_MAX - 1e-6) pts = along(q.f0, Math.min(q.f1, LEN), (f) => [f, R_MAX - E]);
    else if (q.f1 <= 1e-6) pts = along(q.r0 - R_MIN, Math.min(q.r1, R_MAX) - R_MIN, (r) => [E, R_MIN + r]);
    else pts = along(q.r0 - R_MIN, Math.min(q.r1, R_MAX) - R_MIN, (r) => [LEN - E, R_MIN + r]);
    return pts.length > 0 && pts.every(([f, r]) => isWallAt(f, r));
  }

  // Where the camera is, in temple coordinates.
  function camLocal(api) {
    const cw = api.ar.cameraWorld();
    const l = api.toLocal(cw.x, cw.y);
    return { f: l.f, r: l.r, h: cw.h };
  }

  // -- walls stop the robot ------------------------------------------------------------
  // blockers(feet): boxes {f0,f1,r0,r1,h0,h1} in the way of a body standing
  // at `feet`. The part of a drive command pointing into one within CLEAR of
  // the robot is dropped: turning is always fine, and you slide along a wall
  // you drive into at an angle. opts.speed(me) scales the rest (wading).
  function wallStopper(api, blockers, opts = {}) {
    const { ar } = api;
    function contacts(me, feet) {
      const out = [];
      blockers(feet).forEach((b) => {
        const qf = clamp(me.f, b.f0, b.f1);
        const qr = clamp(me.r, b.r0, b.r1);
        const df = me.f - qf;
        const dr = me.r - qr;
        const dist = Math.hypot(df, dr);
        if (dist >= CLEAR) return;
        if (dist > 1e-6) {
          out.push({ f: df / dist, r: dr / dist, b });
          return;
        }
        // inside it (pushed in, or it closed on you): out through the nearest face
        const faces = [[me.f - b.f0, -1, 0], [b.f1 - me.f, 1, 0], [me.r - b.r0, 0, -1], [b.r1 - me.r, 0, 1]];
        faces.sort((x, y) => x[0] - y[0]);
        out.push({ f: faces[0][1], r: faces[0][2], b });
      });
      return out;
    }
    const state = { vf: 0, vr: 0 }; // the last command, in temple coordinates (for pushing things)
    function filterDrive(j1, j2) {
      if (!api.anchor()) return { j1, j2 };
      const t = ar.camTheta;
      const th = api.anchor().th;
      const vx = j2 * Math.cos(t) + j1 * Math.sin(t);
      const vy = j2 * Math.sin(t) - j1 * Math.cos(t);
      let vf = vx * Math.cos(th) + vy * Math.sin(th);
      let vr = vx * Math.sin(th) - vy * Math.cos(th);
      state.vf = vf;
      state.vr = vr;
      const me = api.toLocal(ar.pose.x, ar.pose.y);
      const cs = contacts(me, ar.feet());
      for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        cs.forEach((c) => {
          const dot = vf * c.f + vr * c.r;
          if (dot < -1e-6) {
            vf -= dot * c.f;
            vr -= dot * c.r;
            changed = true;
          }
        });
        if (!changed) break;
      }
      if (cs.some((c) => vf * c.f + vr * c.r < -1e-3)) vf = vr = 0; // wedged in a corner
      const k = opts.speed ? opts.speed(me) : 1;
      vf *= k;
      vr *= k;
      const wx = vf * Math.cos(th) + vr * Math.sin(th);
      const wy = vf * Math.sin(th) - vr * Math.cos(th);
      return { j1: wx * Math.sin(t) - wy * Math.cos(t), j2: wx * Math.cos(t) + wy * Math.sin(t) };
    }
    return { contacts, filterDrive, command: state };
  }

  // -- enemies ---------------------------------------------------------------------------
  const MUMMY = [
    "....gggg....", "...gwwwwg...", "...wrwwrw...", "...wwwwww...", "....wggw....", "..wwwwwwww..", ".wwgwwwwgww.", "ww..wggw..ww",
    "w...wwww...w", "....wggw....", "....wwww....", "...ww..ww...", "...wg..gw...", "...ww..ww...", "..www..www..",
  ];
  // a stone head on a plinth that spits fireballs
  const GARGOYLE = [
    "..kk....kk..", ".kssk..kssk.", ".ksssssssk..", "kssssssssssk", "ksreessserk.", "kssssssssssk", ".ksskkkkssk.",
    ".kskffffksk.", "..kssssssk..", "...kkkkkk...", "..kddddddk..", ".kddddddddk.", "kkkkkkkkkkkk",
  ];
  const ORB = ["..oo..", ".oyyo.", "oyyyyo", "oyyyyo", ".oyyo.", "..oo.."];

  // env: pointSolid(f, r, h) for sight and flying; walkOk(e, f, r): may a
  // walker stand here (at its height e.h). Kinds: scarab, mummy (walk, once
  // they've seen you), bat, wisp (fly; the wisp darts sideways, closes in
  // slowly), gargoyle (fixed; spits fireballs when it sees you).
  function enemyPack(api, env) {
    const { ar, d } = api;
    const img = {
      mummy: Lynx.sprite(MUMMY, { w: "#d8cfae", g: "#9c9272", r: "#ff3020" }),
      gargoyle: Lynx.sprite(GARGOYLE, { k: "#1e1a16", s: "#6e6a64", r: "#ff4020", e: "#ffb040", f: "#ff6a20", d: "#4a4540" }),
      orb: Lynx.sprite(ORB, { o: "#ff5a10", y: "#ffe070" }),
    };
    const hp = { mummy: 4, gargoyle: 4, wisp: d.batHp + 1, bat: d.batHp, scarab: 1 };
    const list = [];
    const orbs = [];
    let losTimer = 0;

    function add(kind, p, h = 0, extra = {}) {
      list.push({
        kind, f: p.f, r: p.r, h, hp: extra.hp || hp[kind] || 1, phase: Math.random() * 6, hit: 0, retreat: 0, wait: 1 + Math.random(),
        sees: false, dir: Math.random() < 0.5 ? -1 : 1, turnT: 1, cool: 2 + Math.random(), rect: null, ...extra,
      });
    }

    function move(e, vf, vr, dt) {
      const flies = e.kind === "bat" || e.kind === "wisp";
      const rad = e.kind === "mummy" ? 0.06 : 0.04;
      const free = (f, r) => {
        for (const [a, b] of [[rad, 0], [-rad, 0], [0, rad], [0, -rad]]) {
          if (env.pointSolid(f + a, r + b, e.h + 0.02)) return false;
          if (!flies && !env.walkOk(e, f + a, r + b)) return false;
        }
        return true;
      };
      const f0 = e.f;
      const r0 = e.r;
      if (free(e.f + vf * dt, e.r)) e.f += vf * dt;
      if (free(e.f, e.r + vr * dt)) e.r += vr * dt;
      return Math.hypot(e.f - f0, e.r - r0);
    }
    function toward(e, tf, tr, speed, dt) {
      const df = tf - e.f;
      const dr = tr - e.r;
      const dist = Math.hypot(df, dr) || 1;
      const sgn = e.retreat > 0 ? -1 : 1;
      e.flip = dr < 0;
      return move(e, (sgn * df * speed) / dist, (sgn * dr * speed) / dist, dt);
    }

    function update(dt, me, c, active = () => true) {
      losTimer -= dt;
      const checkSight = losTimer <= 0;
      if (checkSight) losTimer = 0.25;
      const los = (e) => env.lineOfSight({ f: e.f, r: e.r, h: e.h + 0.05 }, c);
      list.forEach((e) => {
        if (!active(e)) return;
        e.phase += dt * (e.kind === "bat" ? 7 : 5);
        e.hit = Math.max(0, e.hit - dt);
        e.retreat = Math.max(0, e.retreat - dt);
        e.wait = Math.max(0, e.wait - dt);
        if (checkSight) e.sees = los(e);
        const slow = e.hit > 0 ? 0.3 : 1;
        const dist3 = Math.hypot(c.f - e.f, c.r - e.r, c.h - e.h);
        if (e.kind === "gargoyle") {
          e.cool -= dt;
          if (e.cool <= 0 && e.sees && dist3 < 1.8) {
            e.cool = 2.4 / d.speed;
            const n = dist3 || 1;
            const src = { f: e.f, r: e.r, h: e.h + 0.08 };
            const v = 0.4 * d.speed;
            orbs.push({ ...src, vf: ((c.f - src.f) / n) * v, vr: ((c.r - src.r) / n) * v, vh: ((c.h - 0.03 - src.h) / n) * v, t: 0, rect: null });
            Lynx.sfx.play("fireball");
          }
          return;
        }
        if (e.kind === "bat") {
          if (e.wait > 0) return;
          toward(e, c.f, c.r, 0.15 * d.speed * slow, dt);
          const dh = c.h - 0.02 - e.h;
          e.h += Math.sign(dh) * Math.min(Math.abs(dh), 0.1 * dt);
          if (dist3 < TOUCH_M && e.retreat === 0) {
            api.hurt("Bitten by a bat");
            e.retreat = 1.2;
          }
          return;
        }
        if (e.kind === "wisp") {
          e.turnT -= dt;
          if (e.turnT <= 0) {
            e.dir = -e.dir;
            e.turnT = 0.45 + Math.random() * 0.85;
          }
          if (e.wait > 0) return;
          const df = me.f - e.f;
          const dr = me.r - e.r;
          const dist = Math.hypot(df, dr) || 1;
          const side = 0.55 * d.speed * slow;
          const close = e.retreat > 0 ? -0.18 : 0.06 * d.speed;
          const vf = (df / dist) * close - (dr / dist) * e.dir * side;
          const vr = (dr / dist) * close + (df / dist) * e.dir * side;
          if (move(e, vf, vr, dt) < 0.3 * Math.hypot(vf, vr) * dt) e.dir = -e.dir; // blocked sideways: the other way
          e.h += ((c.h - 0.04 - e.h) * 0.4 + Math.sin(e.phase) * 0.05) * dt;
          if (dist3 < TOUCH_M && e.retreat === 0) {
            api.hurt("A spirit's chill");
            e.retreat = 1.5;
          }
          return;
        }
        // walkers, once they've seen you
        if (e.wait > 0 || (!e.sees && e.retreat === 0)) return;
        toward(e, me.f, me.r, (e.kind === "mummy" ? 0.07 : 0.12) * d.speed * slow, dt);
        const close = Math.hypot(me.f - e.f, me.r - e.r) < (e.kind === "mummy" ? 0.14 : 0.1);
        const reach = Math.abs(ar.feet() - e.h) < (e.kind === "mummy" ? 0.12 : 0.05);
        if (close && reach && e.retreat === 0) {
          api.hurt(e.kind === "mummy" ? "The mummy strikes!" : "Scarab bite -- jump over them!");
          e.retreat = 1;
        }
      });
      for (let i = list.length - 1; i >= 0; i--) if (list[i].dead) list.splice(i, 1);
      // fireballs
      for (let i = orbs.length - 1; i >= 0; i--) {
        const o = orbs[i];
        o.t += dt;
        o.f += o.vf * dt;
        o.r += o.vr * dt;
        o.h += o.vh * dt;
        if (Math.hypot(c.f - o.f, c.r - o.r, c.h - o.h) < 0.08) {
          api.hurt("Scorched by a fireball");
          orbs.splice(i, 1);
        } else if (o.t > 6 || env.pointSolid(o.f, o.r, o.h)) orbs.splice(i, 1);
      }
    }

    function queue(c, visible = () => true) {
      list.forEach((e) => {
        e.rect = null;
        if (!visible(e) || !env.lineOfSight({ f: e.f, r: e.r, h: e.h + 0.04 }, c)) return;
        const w = api.toWorld(e.f, e.r);
        if (e.kind === "bat") api.drawSprite(e, api.img.bat, w.x, w.y, e.h + Math.sin(e.phase) * 0.015, 0.06, { flip: Math.sin(e.phase * 0.35) < 0 });
        else if (e.kind === "wisp") api.drawSprite(e, api.img.wisp, w.x, w.y, e.h - 0.035, 0.075, { flip: e.dir < 0 });
        else if (e.kind === "scarab") api.drawSprite(e, api.img.scarab, w.x, w.y, e.h, 0.045, { flip: e.flip });
        else if (e.kind === "gargoyle") api.drawSprite(e, img.gargoyle, w.x, w.y, e.h, 0.13, { flip: c.r < e.r });
        else api.drawSprite(e, img.mummy, w.x, w.y, e.h + Math.abs(Math.sin(e.phase)) * 0.004, 0.2, { flip: e.flip });
      });
      orbs.forEach((o) => {
        const w = api.toWorld(o.f, o.r);
        api.drawSprite(o, img.orb, w.x, w.y, o.h - 0.02, 0.04, {
          before: (rc) => ar.glow(rc.cx, rc.y + rc.h / 2, rc.w * 1.6, [[0, "rgba(255,200,80,0.8)"], [1, "rgba(255,80,0,0)"]]),
        });
      });
    }

    const targets = (visible = () => true) => list.filter((e) => e.rect && visible(e)).map((e) => ({ obj: e, kind: e.kind }));
    function hit(t) {
      const o = t.obj;
      o.hit = 0.15;
      o.hp--;
      if (o.hp > 0) {
        Lynx.sfx.play(o.kind === "gargoyle" ? "knock" : "pain");
        return;
      }
      o.dead = true;
      const w = api.toWorld(o.f, o.r);
      api.puff({ x: w.x, y: w.y, h: o.h + 0.03, t: 0, color: o.kind === "wisp" ? "160,220,255" : o.kind === "gargoyle" ? "160,150,140" : "255,230,200" });
      api.addScore({ mummy: 300, gargoyle: 400, wisp: 200, bat: 100 }[o.kind] || 50);
      Lynx.sfx.play(o.kind === "gargoyle" ? "explode" : "die");
    }
    const blips = (visible = () => true) =>
      list.filter(visible).map((e) => ({ ...api.toWorld(e.f, e.r), color: e.kind === "mummy" ? "#ffffff" : e.kind === "wisp" ? "#60d0ff" : e.kind === "gargoyle" ? "#c0b0a0" : "#ff4040" }))
        .concat(orbs.map((o) => ({ ...api.toWorld(o.f, o.r), color: "#ffa020", r: 2 })));
    function carryOn() {
      list.forEach((e) => (e.retreat = 2));
      orbs.length = 0;
    }
    return { list, orbs, add, update, queue, targets, hit, blips, carryOn };
  }

  // -- the timed gate ----------------------------------------------------------------------
  // press() opens it for `seconds` (again: back to full time); a clock ticks,
  // faster in the last five seconds, and stops when it shuts. hold() keeps
  // it open for good. lift: 0 shut .. 1 open, for drawing and blocking.
  function timedGate(api, seconds) {
    const g = { open: false, held: false, remaining: 0, lift: 0, seconds, tickT: 0, tock: false, flash: 0 };
    g.press = () => {
      if (g.held) return;
      const was = g.open;
      g.open = true;
      g.remaining = g.seconds;
      g.tickT = 0;
      Lynx.sfx.play("gate");
      api.say(was ? "Click -- the clock starts over!" : `Click! Somewhere a gate grinds open -- ${Math.round(g.seconds)} seconds!`, "#ffd84a");
    };
    g.hold = () => {
      g.held = true;
      g.open = true;
    };
    g.shut = () => g.lift < 0.95;
    g.update = (dt) => {
      g.flash = Math.max(0, g.flash - dt);
      g.lift = clamp(g.lift + (g.open ? dt * 1.5 : -dt * 2.5), 0, 1);
      if (!g.open || g.held) return;
      g.remaining -= dt;
      g.tickT -= dt;
      if (g.tickT <= 0) {
        g.tickT += g.remaining < 5 ? 0.25 : 0.5;
        Lynx.sfx.play(g.tock ? "tock" : "tick");
        g.tock = !g.tock;
      }
      if (g.remaining <= 0) {
        g.open = false;
        g.remaining = 0;
        g.flash = 1;
        Lynx.sfx.play("crate");
        api.say("The clock stops -- the gate slams shut. Press the button again", "#ff6060");
      }
    };
    // countdown bar at the top of the view while it runs
    g.hud = () => {
      if (!g.open || g.held) return;
      const { ar } = api;
      const v = ar.view;
      const w = Math.min(260, v.w * 0.4);
      const x = v.cx - w / 2;
      const y = v.y + v.h * 0.18;
      const k = clamp(g.remaining / g.seconds, 0, 1);
      const ctx = ar.ctx;
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(x - 3, y - 3, w + 6, 16);
      ctx.fillStyle = g.remaining < 5 ? (Math.floor(g.remaining * 4) % 2 ? "#ff3030" : "#ffb020") : "#ffd84a";
      ctx.fillRect(x, y, w * k, 10);
      ctx.restore();
      ar.text(`⌛ ${g.remaining.toFixed(1)} s`, v.cx, y + 28, { size: 15, align: "center", color: g.remaining < 5 ? "#ff6060" : "#ffd84a" });
    };
    return g;
  }

  // -- a sun disk on a wall face (a switch or a button you shoot) ----------------------------
  // s: {f, r, h, n: {f, r} (the way the face looks)}; inner: the gem's color.
  // Sets s.rect (for shooting) when you can see it.
  function sunDisk(api, s, c, lineOfSight, inner, glowing = true) {
    const { ar } = api;
    s.rect = null;
    const facing = (c.f - s.f) * s.n.f + (c.r - s.r) * s.n.r;
    if (facing <= 0.01) return;
    const eye = { f: s.f + s.n.f * 0.01, r: s.r + s.n.r * 0.01, h: s.h };
    if (!lineOfSight(eye, c)) return;
    const u = { f: -s.n.r, r: s.n.f };
    const ring = (rad) => {
      const pts = [];
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * 2 * Math.PI;
        const w = api.toWorld(eye.f + u.f * rad * Math.cos(a), eye.r + u.r * rad * Math.cos(a));
        const hh = s.h + rad * Math.sin(a);
        const p = api.camZ(w.x, w.y, hh) >= 0.06 ? ar.project(w.x, w.y, hh) : null;
        if (!p) return null;
        pts.push(p);
      }
      return pts;
    };
    const outer = ring(0.04);
    if (!outer) return;
    const xs = outer.map((p) => p.x);
    const ys = outer.map((p) => p.y);
    const cw = api.toWorld(eye.f, eye.r);
    const center = ar.project(cw.x, cw.y, s.h);
    const rect = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), depth: center ? center.depth : 1, cx: center ? center.x : 0 };
    s.rect = rect;
    ar.queue(rect.depth, () => {
      if (glowing) ar.glow(rect.x + rect.w / 2, rect.y + rect.h / 2, rect.w * 1.4, [[0, "rgba(255,220,100,0.5)"], [1, "rgba(255,200,60,0)"]]);
      api.fillPoly(outer, s.hit > 0 ? "#ffffff" : "#e0b030", "#704810", 2);
      const gem = ring(0.018);
      if (gem) api.fillPoly(gem, inner, "#401000", 1);
    }, api.extent(Math.min(s.f, eye.f), Math.max(s.f, eye.f), Math.min(s.r, eye.r), Math.max(s.r, eye.r), s.h - 0.04, s.h + 0.04));
  }

  // A floor button (a raised stone disc), lit while the clock runs.
  function floorButton(api, b, h, lit) {
    const { ar } = api;
    const w = api.toWorld(b.f, b.r);
    ar.floorCircle(w.x, w.y, 0.07, lit ? "#ffd84a" : "#a08040", "#3a2808", h + 0.004);
    ar.floorCircle(w.x, w.y, 0.045, lit ? "#fff4b0" : "#c8a050", "#5a4010", h + 0.012);
  }

  // Bars across a gate rect (a thin box), raised by lift 0..1 above base.
  function queueBars(api, q, base, height, lift, color = "#2e2e34") {
    const { ar } = api;
    const up = lift * height * 0.95;
    if (up >= height * 0.94) return;
    const alongR = q.r1 - q.r0 >= q.f1 - q.f0;
    const mid = alongR ? (q.f0 + q.f1) / 2 : (q.r0 + q.r1) / 2;
    const w = api.toWorld(alongR ? mid : (q.f0 + q.f1) / 2, alongR ? (q.r0 + q.r1) / 2 : mid);
    const depth = api.camZ(w.x, w.y, base + height / 2);
    if (depth < -0.5) return;
    ar.queue(depth, () => {
      const lo = alongR ? q.r0 : q.f0;
      const hi = alongR ? q.r1 : q.f1;
      const pt = (s, h) => (alongR ? [mid, s, h] : [s, mid, h]);
      for (let s = lo + 0.035; s < hi; s += 0.06) api.line3([pt(s, base + up), pt(s, base + height)], color, 4, 0.05);
      [0.07, 0.2].forEach((h) => h < height && base + h > base + up && api.line3([pt(lo, base + h), pt(hi, base + h)], color, 4, 0.1));
    }, alongR ? api.extent(mid - 0.01, mid + 0.01, q.r0, q.r1, base + up, base + height) : api.extent(q.f0, q.f1, mid - 0.01, mid + 0.01, base + up, base + height));
  }

  // -- items ---------------------------------------------------------------------------------
  // items: {kind, f, r, base}; picked up within 0.13 m and at the right height.
  function drawItems(api, items, c, lineOfSight, extraImg = {}, visible = () => true) {
    const { ar } = api;
    items.forEach((it) => {
      it.rect = null;
      if (!visible(it) || !lineOfSight({ f: it.f, r: it.r, h: it.base + 0.05 }, c)) return;
      const w = api.toWorld(it.f, it.r);
      const bob = Math.sin(api.time() * 3 + it.f * 7) * 0.012;
      const spr = extraImg[it.kind] || api.img[it.kind];
      const size = it.size || (it.kind === "potion" ? 0.06 : 0.05);
      const glow = it.glow || "rgba(255,255,220,0.7)";
      api.drawSprite(it, spr, w.x, w.y, it.base + 0.03 + bob, size, {
        before: (r) => ar.glow(r.cx, r.y + r.h / 2, r.w * 1.3, [[0, glow], [1, "rgba(255,255,200,0)"]]),
      });
    });
  }
  // Takes what you touch; onSpecial(it) handles the level's own kinds
  // (return true once handled). Gems, big gems and potions are handled here.
  function pickUp(api, items, me, feet, onSpecial, visible = () => true) {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (!visible(it)) continue;
      if (Math.hypot(me.f - it.f, me.r - it.r) > 0.13 || feet < it.base - 0.05 || feet > it.base + 0.3) continue;
      if (onSpecial && onSpecial(it)) {
        items.splice(i, 1);
        continue;
      }
      if (it.kind === "potion") {
        api.heal();
        Lynx.sfx.play("pickup");
        api.say("A healing potion");
      } else {
        api.addScore(it.kind === "bigGem" ? 750 : 250);
        Lynx.sfx.play("coin");
      }
      items.splice(i, 1);
    }
  }

  // -- minimap -------------------------------------------------------------------------------
  // color(i, j) -> css color or null (not drawn); marks: [{f, r, color}].
  function minimap(api, color, label, marks = []) {
    const { ar } = api;
    const v = ar.view;
    const s = Math.max(4, Math.min(8, Math.floor((v.h * 0.3) / ROWS)));
    const mx = v.x + v.w - COLS * s - 12;
    const my = v.y + 12;
    const g = ar.ctx;
    g.save();
    g.fillStyle = "rgba(0,0,0,0.45)";
    g.fillRect(mx - 3, my - 3, COLS * s + 6, ROWS * s + 6);
    for (let i = 0; i < ROWS; i++) {
      for (let j = 0; j < COLS; j++) {
        const col = color(i, j);
        if (!col) continue;
        g.fillStyle = col;
        g.fillRect(mx + j * s, my + (ROWS - 1 - i) * s, s, s);
      }
    }
    marks.forEach((m) => {
      g.fillStyle = m.color;
      g.fillRect(mx + ((m.r - R_MIN) / CELL) * s - 2, my + (ROWS - m.f / CELL) * s - 2, 4, 4);
    });
    const me = api.toLocal(ar.pose.x, ar.pose.y);
    const px = mx + ((me.r - R_MIN) / CELL) * s;
    const py = my + (ROWS - me.f / CELL) * s;
    const a = ar.camTheta - api.anchor().th;
    g.fillStyle = "#28c8ff";
    g.beginPath();
    g.moveTo(px - Math.sin(a) * s * 1.6, py - Math.cos(a) * s * 1.6);
    g.lineTo(px + Math.cos(a) * s * 0.7, py - Math.sin(a) * s * 0.7);
    g.lineTo(px - Math.cos(a) * s * 0.7, py + Math.sin(a) * s * 0.7);
    g.closePath();
    g.fill();
    g.restore();
    ar.text(label, mx + (COLS * s) / 2, my + ROWS * s + 16, { size: 11, align: "center", color: "#ffd84a" });
  }

  Lynx.templeKit = {
    CELL, ROWS, COLS, R_MIN, R_MAX, LEN, CLEAR, STEP_UP, BODY_H, TOUCH_M,
    clamp, cellI, cellJ, cellRect, cellCenter, inRect, grow, overlaps,
    parseMap, mergeCells, rectWhere, boundary, outerWalls, behindRim, camLocal,
    wallStopper, enemyPack, timedGate, sunDisk, floorButton, queueBars, drawItems, pickUp, minimap,
  };
})(window.Lynx);
