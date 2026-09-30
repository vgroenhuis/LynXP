// Temple of LynXP, level 5: the sky citadel. Run by game_temple.js through
// Lynx.templeSky(api); parts from game_temple_kit.js.
//
// No walls this time -- floating stone platforms above a cloud court, in
// four tiers climbing twice round the 2 x 3 m: a spiral you parkour up.
// Tiers are further apart than a jump reaches, so up means stairs, the
// bounce pad or the lift; walking off an edge drops you to whatever is below
// (a long fall hurts). New tricks: tiles that crumble a moment after you step
// on them (and come back later), phase tiles that fade in and out on a beat,
// a bounce pad, a lift, and a gargoyle that spits fireballs.
//
// The timed gate: the button on the far-right ledge of the first tier opens
// the gate to the summit -- right above it -- for less than a minute, and the
// only way up is the whole upper spiral: bounce, run the east ledge, hop the
// phase tiles, ride the lift, cross the west span, climb the summit stairs.
// Time the lift. Behind the gate: the Sky Orb.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const K = Lynx.templeKit;
  const { clamp, inRect, LEN, R_MIN, R_MAX } = K;

  const SLAB = 0.06; // platform thickness
  const T1 = 0.3;
  const T2 = 0.75; // tiers: further apart than a jump reaches (0.28 + a 0.06 step)
  const T3 = 1.1;
  const T4 = 1.4;
  const FALL_HURT = 0.4; // landing this far below where you left the ground hurts (a tier or more)
  const BOUNCE_H = 0.62; // the pad throws you this high
  const PHASE_S = 4.0; // phase tiles: A solid [0, 2.4), B solid [2.0, 4.0) + [0, 0.4) -- cross in the overlaps
  const CRUMBLE_S = 0.8; // after you step on
  const CRUMBLE_BACK_S = 5;
  const LIFT = { lo: T2, hi: T3, wait: 2, ride: 2.5 };
  const GATE_S = { easy: 60, normal: 46, hard: 38 };

  const r = (f0, f1, r0, r1) => ({ f0, f1, r0, r1 });
  // platforms: id, rect, top
  const PLATFORMS = [
    { id: "P1", ...r(1.2, 2.1, R_MIN, -0.45), top: T1 },
    { id: "P2", ...r(2.25, LEN, R_MIN, -0.15), top: T1 },
    { id: "P3", ...r(2.1, LEN, 0.45, R_MAX), top: T1 }, // the button, the bounce pad
    { id: "Q1", ...r(0.45, 2.1, 0.45, R_MAX), top: T2 }, // the east ledge
    { id: "Q3", ...r(0.3, 0.75, R_MIN, -0.45), top: T2 },
    { id: "R3", ...r(1.05, 2.4, R_MIN, -0.45), top: T3 }, // the west span
    { id: "S1", ...r(2.55, LEN, R_MIN, 0.0), top: T3 },
    { id: "SUM", ...r(2.4, LEN, 0.45, R_MAX), top: T4 }, // the summit (the gate stands on its edge)
  ];
  const CRUMBLE = [
    { id: "C1", ...r(2.4, 2.85, -0.15, 0.05), top: T1 },
    { id: "C2", ...r(2.4, 2.85, 0.05, 0.25), top: T1 },
    { id: "C3", ...r(2.4, 2.85, 0.25, 0.45), top: T1 },
  ];
  const PHASE = [
    { id: "X1", ...r(0.45, 0.75, 0.15, 0.45), top: T2, beat: "A" },
    { id: "X2", ...r(0.45, 0.75, -0.15, 0.15), top: T2, beat: "B" },
    { id: "X3", ...r(0.45, 0.75, -0.45, -0.15), top: T2, beat: "A" },
  ];
  const LIFT_RECT = r(0.75, 1.05, R_MIN, -0.45);
  const PAD = { f: 2.225, r: 0.675, rad: 0.1 };
  const BUTTON = { f: 2.7, r: 0.675 };
  const GATE = r(2.55, LEN, 0.45, 0.5);
  const ORB_AT = { f: 2.7, r: 0.7 };

  // Stairs: steps of 0.15 m along an axis, the walking surface a smooth slope
  // that meets each step's top at its front edge.
  // Steps rising more than a step-up are walked by their slope alone
  // (walk: true), not stopped at.
  function stairs(q, axis, from, to, base, grounded) {
    const n = Math.round(((axis === "f" ? q.f1 - q.f0 : q.r1 - q.r0) + 1e-9) / K.CELL);
    const rise = to - from;
    const steps = [];
    for (let k = 0; k < n; k++) {
      const top = from + (rise * (k + 1)) / n;
      const s = axis === "f" ? { ...q, f0: q.f0 + k * K.CELL, f1: q.f0 + (k + 1) * K.CELL } : { ...q, r0: q.r0 + k * K.CELL, r1: q.r0 + (k + 1) * K.CELL };
      steps.push({ ...s, h0: grounded ? base : top - SLAB, h1: top, walk: rise / n > K.STEP_UP });
    }
    // one step's length before the first counts as the foot of the slope
    const foot = axis === "f" ? { ...q, f0: q.f0 - K.CELL } : { ...q, r0: q.r0 - K.CELL };
    const slope = (f, rr) => {
      if (!inRect(f, rr, foot)) return null;
      const t = axis === "f" ? f - q.f0 : rr - q.r0;
      return clamp(from + (rise * (t / K.CELL + 1)) / n, from, to);
    };
    return { steps, slope };
  }
  const STAIRS1 = stairs(r(0.3, 1.2, R_MIN, -0.6), "f", 0, T1, 0, true); // court up to the west ledge
  const STAIRS2 = stairs(r(2.55, LEN, 0.0, 0.45), "r", T3, T4, 0, false); // to the summit

  const MARBLE = { top: "#e8e0cc", side: "#bab09a", dark: "#8c8470", line: "rgba(60,50,30,0.55)", under: "#5e584c" };
  const SUMMIT = { top: "#f0dca0", side: "#c8a860", dark: "#987a38", line: "rgba(70,50,10,0.7)", under: "#5e5030" };
  const CRACKED = { top: "#c8b090", side: "#9a8468", dark: "#6e5c44", line: "rgba(40,25,10,0.8)", under: "#4a3c2c" };
  const PHASE_COL = { top: "rgba(120,220,255,0.75)", side: "rgba(80,170,230,0.75)", dark: "rgba(60,130,200,0.75)", line: "rgba(200,245,255,0.9)", under: "rgba(40,90,150,0.7)" };
  const LIFT_COL = { top: "#c89848", side: "#9a7028", dark: "#6a4c18", line: "rgba(40,24,4,0.9)", under: "#4a3410" };
  const STEP_COL = { top: "#e0d6c0", side: "#b0a690", dark: "#847a66", line: "rgba(60,50,30,0.6)", under: "#5a5446" };

  Lynx.templeSky = (api) => {
    const { ar } = api;
    const cfgDiff = api.cfg.difficulty in GATE_S ? api.cfg.difficulty : "normal";
    const COUNTS = {
      easy: { bats: 1, wisps: 0, scarabs: 0, gargoyles: 1 },
      normal: { bats: 2, wisps: 1, scarabs: 1, gargoyles: 1 },
      hard: { bats: 3, wisps: 2, scarabs: 2, gargoyles: 2 },
    }[cfgDiff];
    const ORB = [".bbbb.", "bwwccb", "bwcccb", "bccccb", "bccccb", ".bbbb."];
    const img = { orb: Lynx.sprite(ORB, { b: "#2060c0", w: "#ffffff", c: "#80d0ff" }) };

    let time = 0;
    const crumble = CRUMBLE.map((c) => ({ ...c, state: "whole", t: 0, drop: 0 })); // whole | shaking | gone
    const phaseSolid = (p, t = time) => {
      const m = t % PHASE_S;
      return p.beat === "A" ? m < 2.4 : m >= 2.0 || m < 0.4;
    };
    const lift = { ...LIFT_RECT, top: LIFT.lo, t: 0 };
    const gate = K.timedGate(api, GATE_S[cfgDiff]);
    let pressedEver = false;
    let onButton = false;
    let orb = false;
    let wasAirborne = false;
    let takeoffZ = 0;
    let woken = new Set();
    const items = [
      { kind: "gem", f: 2.175, r: -0.675, base: T1 + 0.12, float: true }, // over the first gap
      { kind: "gem", f: 2.625, r: 0.15, base: T1 },
      { kind: "potion", f: 2.9, r: -0.7, base: T1 },
      { kind: "bigGem", f: 2.05, r: 0.675, base: T2 + 0.1, float: true }, // grab it at the top of a bounce
      { kind: "gem", f: 1.2, r: 0.8, base: T2 },
      { kind: "gem", f: 0.6, r: 0, base: T2 + 0.08, float: true }, // over the phase tiles
      { kind: "potion", f: 0.4, r: -0.8, base: T2 },
      { kind: "gem", f: 1.8, r: -0.55, base: T3 },
      { kind: "gem", f: 2.475, r: -0.675, base: T3 + 0.12, float: true }, // over the second gap
      { kind: "orb", ...ORB_AT, base: T4, size: 0.08, glow: "rgba(150,210,255,0.9)" },
      { kind: "gem", f: 0.9, r: 0.5, base: 0 }, // the court, for the fallen
      { kind: "gem", f: 1.5, r: 0.0, base: 0 },
    ];

    // -- geometry ----------------------------------------------------------------------
    // Everything solid right now, as boxes.
    function solids() {
      const out = [];
      PLATFORMS.forEach((p) => out.push({ ...p, h0: p.top - SLAB, h1: p.top }));
      crumble.forEach((c) => c.state !== "gone" && out.push({ ...c, h0: c.top - SLAB - c.drop, h1: c.top - c.drop }));
      PHASE.forEach((p) => phaseSolid(p) && out.push({ ...p, h0: p.top - SLAB, h1: p.top }));
      out.push({ ...lift, h0: lift.top - SLAB, h1: lift.top });
      STAIRS1.steps.concat(STAIRS2.steps).forEach((s) => out.push(s));
      if (gate.shut()) out.push({ ...GATE, h0: T4, h1: T4 + 0.3 });
      return out;
    }
    const boundary = K.boundary();
    const blockers = (feet) => solids().concat(boundary).filter((b) => !b.walk && b.h1 > feet + K.STEP_UP && b.h0 < feet + K.BODY_H);
    const stopper = K.wallStopper(api, blockers);

    // heights you could stand at here
    function surfaces(f, rr) {
      const hs = [0]; // the cloud court
      solids().forEach((b) => inRect(f, rr, b) && hs.push(b.h1));
      [STAIRS1, STAIRS2].forEach((s) => {
        const h = s.slope(f, rr);
        if (h !== null) hs.push(h);
      });
      return hs;
    }
    function groundAt(f, rr, feet, fallback) {
      const ok = surfaces(f, rr).filter((h) => h <= feet + K.STEP_UP);
      return ok.length ? Math.max(...ok) : fallback;
    }
    function pointSolid(f, rr, h) {
      if (f < 0 || f > LEN || rr < R_MIN || rr > R_MAX) return true;
      return solids().some((b) => inRect(f, rr, b) && h >= b.h0 && h <= b.h1);
    }
    function lineOfSight(a, b) {
      const len = Math.hypot(b.f - a.f, b.r - a.r, b.h - a.h);
      const n = Math.max(1, Math.ceil(len / 0.05));
      for (let k = 1; k < n; k++) {
        const t = k / n;
        if (pointSolid(a.f + (b.f - a.f) * t, a.r + (b.r - a.r) * t, a.h + (b.h - a.h) * t)) return false;
      }
      return true;
    }
    // the platform (or tile) you stand on, if any
    function standingOn(me) {
      const feet = ar.feet();
      if (ar.airborne) return null;
      const all = PLATFORMS.concat(CRUMBLE, PHASE, [{ id: "LIFT", ...lift }]);
      const p = all.find((q) => inRect(me.f, me.r, q) && Math.abs((q.id === "LIFT" ? lift.top : q.top) - feet) < 0.03);
      if (p) return p.id;
      if (STAIRS2.slope(me.f, me.r) !== null && feet > T3 - 0.02) return "R2";
      return feet < 0.03 ? "court" : "stairs";
    }

    const enemies = K.enemyPack(api, {
      pointSolid,
      lineOfSight,
      walkOk: (e, f, rr) => Math.abs(groundAt(f, rr, e.h, -1) - e.h) < 0.02,
    });
    function wake(zone) {
      if (woken.has(zone)) return;
      woken.add(zone);
      if (zone === "t1") [{ f: 2.8, r: -0.5 }, { f: 2.4, r: -0.8 }].slice(0, COUNTS.scarabs).forEach((p) => enemies.add("scarab", p, T1));
      if (zone === "t2") [{ f: 1.4, r: 0.1 }, { f: 0.9, r: -0.2 }].slice(0, COUNTS.wisps).forEach((p) => enemies.add("wisp", p, T2 + 0.15));
      if (zone === "t3") {
        [{ f: 1.6, r: -0.1 }, { f: 2.2, r: 0.1 }, { f: 1.2, r: 0.2 }].slice(0, COUNTS.bats).forEach((p) => enemies.add("bat", p, T3 + 0.2));
        [{ f: 2.9, r: -0.82 }, { f: 1.12, r: -0.84 }].slice(0, COUNTS.gargoyles).forEach((p) => enemies.add("gargoyle", p, T3, { wait: 0 }));
      }
      Lynx.sfx.play("growl");
    }

    // -- every frame -------------------------------------------------------------------
    function physics(me) {
      const feet = ar.feet();
      ar.setGround(groundAt(me.f, me.r, feet, ar.ground));
      // a platform overhead stops a jump (the camera stays below its underside)
      if (ar.airborne && ar.vz > 0) {
        const cap = solids().filter((b) => inRect(me.f, me.r, b) && b.h0 > feet + 0.02).reduce((m, b) => Math.min(m, b.h0), Infinity);
        const zMax = cap - ar.calib.heightM - 0.04;
        if (ar.z > zMax) {
          ar.z = Math.max(ar.ground, zMax);
          ar.vz = 0;
        }
      }
    }

    function update(dt, me) {
      time += dt;
      gate.update(dt);
      // the lift: wait below, ride up, wait above, ride down
      lift.t = (lift.t + dt) % (2 * (LIFT.wait + LIFT.ride));
      const lt = lift.t;
      const k = lt < LIFT.wait ? 0 : lt < LIFT.wait + LIFT.ride ? (lt - LIFT.wait) / LIFT.ride : lt < 2 * LIFT.wait + LIFT.ride ? 1 : 1 - (lt - 2 * LIFT.wait - LIFT.ride) / LIFT.ride;
      lift.top = LIFT.lo + (LIFT.hi - LIFT.lo) * (0.5 - 0.5 * Math.cos(Math.PI * k));

      const on = standingOn(me);
      // crumbling tiles
      crumble.forEach((c) => {
        if (c.state === "whole" && on === c.id) {
          c.state = "shaking";
          c.t = CRUMBLE_S;
          Lynx.sfx.play("knock");
        } else if (c.state === "shaking") {
          c.t -= dt;
          if (c.t <= 0) {
            c.state = "gone";
            c.t = CRUMBLE_BACK_S;
            Lynx.sfx.play("crate");
          }
        } else if (c.state === "gone") {
          c.t -= dt;
          if (c.t <= 0 && !inRect(me.f, me.r, c)) c.state = "whole";
        }
      });
      // bounce pad
      if (on === "P3" && Math.hypot(me.f - PAD.f, me.r - PAD.r) < PAD.rad) {
        ar.airborne = true;
        ar.vz = Math.sqrt(2 * 3.98 * BOUNCE_H); // ar.js's gravity: 8 * 0.28 / 0.75^2
        Lynx.sfx.play("boing");
      }
      // the button
      const onB = on === "P3" && Math.hypot(me.f - BUTTON.f, me.r - BUTTON.r) < 0.09;
      if (onB && !onButton && !orb) {
        gate.press();
        pressedEver = true;
      }
      onButton = onB;
      // falls
      // falls: measured from where you left the ground (so a bounce that lands
      // back where it started doesn't count)
      if (!ar.airborne) {
        if (wasAirborne && takeoffZ - ar.z > FALL_HURT) api.hurt("A long fall!");
        takeoffZ = ar.z;
      }
      wasAirborne = ar.airborne;

      const feet = ar.feet();
      if (feet > T1 - 0.05) wake("t1");
      if (feet > T2 - 0.05) wake("t2");
      if (feet > T3 - 0.05) wake("t3");
      enemies.update(dt, me, K.camLocal(api));
      K.pickUp(api, items, me, feet, (it) => {
        if (it.kind !== "orb") return false;
        orb = true;
        gate.hold();
        api.addScore(3000);
        Lynx.sfx.play("power");
        api.complete();
        return true;
      });
    }

    // -- shooting --------------------------------------------------------------------------
    const targets = () => enemies.targets();
    const hit = (t) => enemies.hit(t);

    // -- drawing ---------------------------------------------------------------------------
    const rectPoly = (q, h) => [api.w3(q.f0, q.r0, h), api.w3(q.f1, q.r0, h), api.w3(q.f1, q.r1, h), api.w3(q.f0, q.r1, h)];
    function fillRect(q, h, fill, stroke) {
      const p = api.polyScreen(rectPoly(q, h), 3);
      if (p) api.fillPoly(p, fill, stroke);
    }

    function draw() {
      const c = K.camLocal(api);
      // the cloud court: a pale haze over the real floor, drifting wisps of cloud
      fillRect({ f0: 0, f1: LEN, r0: R_MIN, r1: R_MAX }, 0.001, "rgba(215,225,245,0.35)", "rgba(255,255,255,0.5)");
      for (let k = 0; k < 6; k++) {
        const f = (k * 0.53 + time * 0.03) % LEN;
        const w = api.toWorld(f, R_MIN + ((k * 0.71) % 1.8));
        ar.floorCircle(w.x, w.y, 0.12 + 0.04 * Math.sin(k), "rgba(255,255,255,0.22)", null, 0.002);
      }
      PLATFORMS.forEach((p) => api.box(p, p.top - SLAB, p.top, p.id === "SUM" ? SUMMIT : MARBLE));
      crumble.forEach((q) => {
        if (q.state === "gone") return;
        const shake = q.state === "shaking" ? 0.006 * Math.sin(time * 60) : 0;
        api.box({ ...q, r0: q.r0 + shake, r1: q.r1 + shake }, q.top - SLAB, q.top, CRACKED);
      });
      PHASE.forEach((p) => {
        if (phaseSolid(p)) {
          // about to fade: flicker
          const soon = !phaseSolid(p, time + 0.4);
          if (!soon || Math.floor(time * 10) % 2) api.box(p, p.top - SLAB, p.top, PHASE_COL);
          else fillRect(p, p.top, "rgba(120,220,255,0.25)", "rgba(200,245,255,0.8)");
        } else fillRect(p, p.top, null, "rgba(160,230,255,0.45)"); // its outline, while it's away
      });
      api.box(lift, lift.top - SLAB, lift.top, LIFT_COL);
      STAIRS1.steps.forEach((s) => api.box(s, s.h0, s.h1, STEP_COL));
      STAIRS2.steps.forEach((s) => api.box(s, s.h0, s.h1, STEP_COL));
      // bounce pad and button on the first tier's far-right ledge
      if (c.h > T1) {
        const w = api.toWorld(PAD.f, PAD.r);
        const pulse = 0.5 + 0.5 * Math.sin(time * 5);
        ar.floorCircle(w.x, w.y, PAD.rad, `rgba(80,255,120,${0.35 + 0.3 * pulse})`, "#1a6030", T1 + 0.004);
        K.floorButton(api, BUTTON, T1, gate.open && !gate.held);
      }
      K.queueBars(api, GATE, T4, 0.3, gate.lift, "#8a7440");
      K.drawItems(api, items, c, lineOfSight, img);
      enemies.queue(c);
      ar.flush();
    }

    function hud() {
      gate.hud();
      K.minimap(api, (i, j) => {
        const p = K.cellCenter(i, j);
        let best = null;
        PLATFORMS.concat(CRUMBLE, PHASE).forEach((q) => inRect(p.f, p.r, q) && (!best || q.top > best.top) && (best = q));
        if (inRect(p.f, p.r, lift)) return "#c89848";
        if (!best) return STAIRS1.slope(p.f, p.r) !== null || STAIRS2.slope(p.f, p.r) !== null ? "#b0a690" : null;
        return best.top >= T4 ? "#f0dca0" : best.top >= T3 ? "#d8d0bc" : best.top >= T2 ? "#b8b0a0" : "#8c8470";
      }, `${(ar.feet() + 0.001).toFixed(2)} m UP`, [{ ...BUTTON, color: gate.open ? "#ffd84a" : "#a08040" }, { ...ORB_AT, color: "#80d0ff" }]);
    }

    // Where to go: the spiral, from wherever you stand.
    const ROUTE = [
      ["P3", PAD, "The bounce pad -- up to the east ledge"],
      ["Q1", { f: 0.6, r: 0.675 }, "South along the east ledge"],
      ["X1", { f: 0.6, r: 0 }, "Hop the phase tiles on the beat"],
      ["X2", { f: 0.6, r: -0.3 }, "Hop the phase tiles on the beat"],
      ["X3", { f: 0.525, r: -0.675 }, "Across to the west ledge"],
      ["Q3", { f: 0.9, r: -0.675 }, "The lift -- step on when it's down"],
      ["LIFT", { f: 0.9, r: -0.675 }, "Ride it up"],
      ["R3", { f: 2.3, r: -0.675 }, "North along the west span -- jump the gap"],
      ["S1", { f: 2.775, r: 0.1 }, "The summit stairs"],
      ["R2", { f: 2.775, r: 0.6 }, "Through the gate!"],
    ];
    function objective() {
      const me = api.toLocal(ar.pose.x, ar.pose.y);
      const on = standingOn(me);
      const go = (text, p, h) => ({ text, at: { f: p.f, r: p.r }, h });
      if (!gate.open) {
        if (on === "court" || on === "stairs") return go(pressedEver ? "Back up: the stairs on the left" : "Up the sky stairs on the left", { f: 0.9, r: -0.75 }, T1);
        if (on === "P1") return go("Jump the gap to the north ledge", { f: 2.4, r: -0.6 }, T1);
        if (on === "P2" || on === "C1" || on === "C2" || on === "C3") return go("Over the cracked tiles -- don't stop on them", { f: 2.625, r: 0.6 }, T1);
        if (on === "P3") return go(pressedEver ? "The button again -- then run!" : "Step on the button: it opens the summit gate, for a while", BUTTON, T1);
        return go("The gate is shut: back down to the button on the first tier's far-right ledge", BUTTON, T1);
      }
      const k = ROUTE.findIndex(([id]) => id === on);
      if (k >= 0) {
        const [, p, text] = ROUTE[k];
        const h = { P3: T1, Q1: T2, X1: T2, X2: T2, X3: T2, Q3: T2, LIFT: lift.top, R3: T3, S1: T3, R2: T4 }[on];
        return go(`${text} -- ${Math.ceil(gate.remaining)} s`, p, h);
      }
      return go(`Hurry to the summit gate -- ${Math.ceil(gate.remaining)} s`, { f: 2.775, r: 0.47 }, T4 + 0.1);
    }

    return {
      physics,
      update,
      draw,
      hud,
      objective,
      blips: () => enemies.blips().concat(items.map((it) => ({ ...api.toWorld(it.f, it.r), color: it.kind === "orb" ? "#80d0ff" : "#ffd84a", r: 2.5 }))),
      targets,
      hit,
      carryOn: () => enemies.carryOn(),
      filterDrive: stopper.filterDrive,
      floorName: () => `${(ar.feet() + 0.001).toFixed(2)} m up`,
      debug: {
        gate,
        lift,
        crumble,
        standingOn: () => standingOn(api.toLocal(ar.pose.x, ar.pose.y)),
        phaseSolid: (id) => phaseSolid(PHASE.find((p) => p.id === id)),
        time: () => time,
        clear: () => enemies.list.splice(0),
        groundAt,
        lineOfSight,
        PLATFORMS, PAD, BUTTON, ORB_AT, T1, T2, T3, T4,
      },
      snapshot: () => ({
        on: standingOn(api.toLocal(ar.pose.x, ar.pose.y)), feet: +ar.feet().toFixed(3), gate: gate.open ? +gate.remaining.toFixed(1) : "shut",
        lift: +lift.top.toFixed(2), crumble: crumble.map((c) => c.state[0]).join(""), orb,
        enemies: enemies.list.map((e) => e.kind), items: items.map((i) => i.kind),
      }),
    };
  };
})(window.Lynx);
