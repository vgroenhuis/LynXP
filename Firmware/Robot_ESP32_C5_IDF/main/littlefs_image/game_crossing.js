// Crossing -- Frogger on your floor. A street lies across the way ahead of
// the robot: lanes of traffic (cars, vans, trucks and motorcycles, one
// vehicle per lane, at their own speeds), grouped into roads between raised
// sidewalks. Drive across to the far side without being run over; the
// sidewalks are safe. Reaching the goal flips the course: now cross back,
// with faster, denser traffic. FIRE honks and freezes the traffic for a
// moment (slow recharge).
//
// The traffic isn't a conveyor belt: every vehicle has its own cruising
// speed that changes now and then, keeps its distance from the one ahead
// (braking, queueing), and the street runs on far beyond the course on both
// sides, where vehicles sometimes wait a while before they come -- so gaps
// open and close irregularly.
//
// Drawing: with WebGL2, the street and the vehicles are real 3D models, lit
// and textured on the GPU (blockquest_gl.js: asphalt, worn markings, paving,
// paint, glass, rubber, chrome; a depth buffer, so whatever is nearer hides
// what's behind it, and surfaces are clipped at the camera). Without it, a
// plain 2D drawing.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const ROBOT_R = 0.09;
  const CAR_COLORS = ["#c8202c", "#e8a020", "#2a6ad0", "#7a3ac0", "#2a9a4a", "#f2f2f2", "#202226", "#8a8f98", "#5a7fa8", "#b04a20"];
  const HONK_FREEZE_S = 2.2;
  const HONK_CD_S = 14;
  const STREET_M = 3; // how far the street runs on beyond the course's sides (drawn)
  const HIDDEN_M = 0.5; // and beyond that, out of sight, where vehicles turn round
  const CURB = 0.018; // sidewalk height
  const clamp01 = (t) => Math.min(1, Math.max(0, t));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  // A vehicle's real-world-ish proportions from its length (scale k: meters per real meter).
  function dims(c) {
    if (c.kind === "moto") {
      const k = c.len / 2.1;
      return { k, halfW: 0.42 * k, H: 1.55 * k };
    }
    if (c.kind === "truck") {
      const k = c.len / 8.5;
      return { k, halfW: 1.25 * k, H: 3.4 * k };
    }
    const k = c.len / (c.kind === "van" ? 5 : 4.5);
    return { k, halfW: 0.9 * k, H: (c.kind === "van" ? 1.95 : 1.45) * k };
  }

  Lynx.games.crossing = (ar, cfg) => {
    const LW = cfg.laneM; // lane depth (along the course)
    const W = cfg.widthM / 2; // half width of the course
    const P = 2 * (W + STREET_M + HIDDEN_M); // the loop vehicles drive round
    let state = "title"; // title | playing | clear | over
    let stateTime = 0;
    let origin = { x: 0, y: 0 };
    let heading = 0;
    let lanes = []; // {type: "safe"|"road", cars, dir, speed}
    let level = 1;
    let score = 0;
    let lives = cfg.lives;
    let bestLane = 0;
    let freeze = 0;
    let honkCd = 0;
    let invuln = 0;
    let toast = null;
    let best = null;
    let rankMsg = "";
    Lynx.bestScore("crossing").then((b) => (best = b));

    // the 3D renderer (null: the 2D drawing)
    const w = Lynx.world3d ? Lynx.world3d(ar) : null;
    const R = w && Lynx.bqGL ? Lynx.bqGL(ar, w, {}) : null;
    const gl = () => R && R.ok;

    const say = (text, color, t = 1.5) => (toast = { text, color, t });
    const rnd = (a, b) => a + Math.random() * (b - a);
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

    // world <-> course coordinates: u along the course, s sideways (to the left)
    const toCourse = (x, y) => {
      const dx = x - origin.x;
      const dy = y - origin.y;
      return { u: dx * Math.cos(heading) + dy * Math.sin(heading), s: -dx * Math.sin(heading) + dy * Math.cos(heading) };
    };
    const toWorld = (u, s) => ({
      x: origin.x + u * Math.cos(heading) - s * Math.sin(heading),
      y: origin.y + u * Math.sin(heading) + s * Math.cos(heading),
    });

    // -- the traffic --------------------------------------------------------------------------------------------
    function cruise(ln, c) {
      const kindK = c.kind === "moto" ? 1.3 : c.kind === "truck" ? 0.82 : 1;
      return ln.speed * rnd(0.75, 1.3) * kindK;
    }
    function newVehicle(ln, c) {
      const r = Math.random();
      c.kind = r < 0.16 ? "moto" : r < 0.3 + 0.03 * level ? "truck" : r < 0.42 + 0.03 * level ? "van" : "car";
      c.len = c.kind === "moto" ? rnd(0.13, 0.15) : c.kind === "truck" ? rnd(0.5, 0.62) : c.kind === "van" ? rnd(0.3, 0.34) : rnd(0.25, 0.33);
      c.style = Math.random() < 0.5 ? "sedan" : "hatch";
      c.color = pick(CAR_COLORS);
      c.cargo = Math.random() < 0.5 ? "#ecebe6" : pick(["#d8d4c8", "#c03020", "#2050a0", "#e0b020"]);
      c.v0 = cruise(ln, c);
      return c;
    }

    function build() {
      lanes = [{ type: "safe", cars: [] }];
      for (let r = 0; r < cfg.lanesCount; r++) {
        lanes.push({ type: "road", cars: [], speed: 0, dir: 1 });
        if (r % 3 === 2 && r < cfg.lanesCount - 1) lanes.push({ type: "safe", cars: [] });
      }
      lanes.push({ type: "safe", cars: [] });
      const baseV = cfg.carSpeedMps * (1 + 0.15 * (level - 1));
      // each road: its first half of lanes one way, the rest the other way
      for (let k = 0; k < lanes.length; k++) {
        if (lanes[k].type !== "road") continue;
        let e = k;
        while (e + 1 < lanes.length && lanes[e + 1].type === "road") e++;
        const n = e - k + 1;
        const d = Math.random() < 0.5 ? 1 : -1;
        for (let i = 0; i < n; i++) lanes[k + i].dir = n === 1 ? d : i < Math.ceil(n / 2) ? d : -d;
        k = e;
      }
      lanes.forEach((ln) => {
        if (ln.type !== "road") return;
        ln.speed = baseV * rnd(0.7, 1.4);
        ln.P = P; // (the loop's length, for the intro's staging)
        // density: vehicles per meter of street, more each level
        const want = Math.max(2, Math.round(P * rnd(0.3, 0.45) * (1 + 0.12 * (level - 1))));
        const slot = P / want;
        const off = rnd(0, slot);
        for (let i = 0; i < want; i++) {
          const c = newVehicle(ln, {});
          c.s = -P / 2 + off + i * slot + rnd(-slot * 0.2, slot * 0.2);
          c.v = c.v0;
          c.hold = 0;
          ln.cars.push(c);
        }
      });
      bestLane = 0;
    }

    function moveTraffic(dt) {
      lanes.forEach((ln) => {
        if (ln.type !== "road" || !ln.cars.length) return;
        const d = ln.dir;
        const order = ln.cars.slice().sort((a, b) => d * b.s - d * a.s); // the leader first
        const n = order.length;
        order.forEach((c, i) => {
          if (Math.random() < dt * 0.12) c.v0 = cruise(ln, c); // a mood change
          let want = c.hold > 0 ? 0 : c.v0;
          if (c.hold > 0) c.hold -= dt;
          if (n > 1) {
            const lead = order[(i - 1 + n) % n];
            let gap = (((lead.s - c.s) * d) % P + P) % P - (lead.len + c.len) / 2;
            const safe = 0.1 + c.v * 1.1;
            if (gap < safe) want = Math.min(want, c.v0 * clamp((gap - 0.05) / (safe - 0.05), 0, 1));
            if (gap < 0.03) c.v = 0;
          }
          c.v += clamp(want - c.v, -1.2 * dt, 0.35 * dt);
          c.s += d * c.v * dt;
          if (d * c.s > P / 2) {
            // out of sight at the far end: back round to the start, as a new vehicle that sometimes waits a while
            c.s -= d * P;
            newVehicle(ln, c);
            c.hold = Math.random() < 0.45 ? rnd(0.3, 3.5 - 0.3 * Math.min(level, 6)) : 0;
            c.v = c.hold > 0 ? 0 : c.v0;
          }
        });
      });
    }

    function startLevel(flip) {
      origin = { x: ar.pose.x, y: ar.pose.y };
      heading = flip === undefined ? ar.pose.theta : heading + Math.PI;
      if (w) w.setAnchor({ x: origin.x, y: origin.y, th: heading });
      build();
      // let the traffic settle into its own rhythm before it's seen
      for (let i = 0; i < 300; i++) moveTraffic(0.05);
      state = "playing";
      stateTime = 0;
      invuln = 2;
      freeze = 1.5; // a moment to look before the traffic starts
    }

    function start() {
      level = 1;
      score = 0;
      lives = cfg.lives;
      honkCd = 0;
      startLevel();
      Lynx.sfx.play("go");
    }

    function finish() {
      state = "over";
      stateTime = 0;
      rankMsg = "";
      Lynx.sfx.play("fail");
      Lynx.submitScore("crossing", score).then((rank) => {
        rankMsg = rank ? `#${rank} on the robot's scoreboard!` : "";
        if (rank === 1) best = score;
      });
    }

    function hit(why) {
      lives--;
      Lynx.sfx.play("alarm");
      say(why, "#ff6060", 2);
      invuln = 2.5;
      freeze = Math.max(freeze, 1.2);
      if (lives <= 0) finish();
    }

    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title" || (state === "over" && stateTime > 1.5)) return start();
      if (state === "playing" && honkCd <= 0) {
        honkCd = HONK_CD_S;
        freeze = HONK_FREEZE_S;
        Lynx.sfx.play("honk");
        say("HONK! traffic stops", "#ffd84a", 1.2);
      }
    });

    const laneAt = (u) => Math.round(u / LW);

    function update(dt) {
      stateTime += dt;
      if (toast && (toast.t -= dt) <= 0) toast = null;
      if (state === "clear") {
        if (stateTime > 2.2) {
          level++;
          startLevel(true);
        }
        return;
      }
      if (state !== "playing") return;
      honkCd = Math.max(0, honkCd - dt);
      invuln = Math.max(0, invuln - dt);
      freeze = Math.max(0, freeze - dt);
      if (freeze <= 0) moveTraffic(dt);

      const p = toCourse(ar.pose.x, ar.pose.y);
      const k = laneAt(p.u);
      if (k > bestLane && k < lanes.length) {
        score += 10 * (k - bestLane);
        bestLane = k;
        Lynx.sfx.play("tick");
      }
      if (k >= lanes.length - 1 && p.u > (lanes.length - 1) * LW - LW * 0.25 && Math.abs(p.s) <= W + 0.2) {
        const bonus = 100 * level;
        score += bonus;
        say(`Crossed! +${bonus}`, "#ffd84a", 2);
        Lynx.sfx.play("levelup");
        state = "clear";
        stateTime = 0;
        return;
      }
      const ln = lanes[k];
      if (!ln || ln.type !== "road" || invuln > 0) return;
      if (Math.abs(p.s) > W) return hit("Off the road!");
      for (const c of ln.cars) {
        const du = Math.abs(p.u - k * LW);
        if (du > dims(c).halfW + ROBOT_R) continue;
        if (Math.abs(p.s - c.s) < c.len / 2 + ROBOT_R) return hit("Run over!");
      }
    }

    // -- 3D drawing ---------------------------------------------------------------------------------------------
    // Parts go in a figure's body frame: x along the course (u), y to the
    // right (-s), z up, relative to the figure's origin (Ou, Os).
    let Ou = 0;
    let Os = 0;
    const B = (u, s, h) => [u - Ou, Os - s, h];

    function drawStreet3D() {
      const F = R.figure({ f: Ou, r: -Os, z: 0, yaw: 0, scale: 1, height: 0.02, far: 9, full: true, aoH: 0.0015 });
      if (!F) return false;
      const L = W + STREET_M; // half length drawn
      lanes.forEach((ln, k) => {
        const uc = k * LW;
        if (ln.type === "road") {
          // the asphalt: one piece for the whole road (lanes side by side left a seam)
          if (!lanes[k - 1] || lanes[k - 1].type !== "road") {
            let e = k;
            while (lanes[e + 1] && lanes[e + 1].type === "road") e++;
            F.box(B((k + e) * LW / 2, 0, 0.0008), ((e - k + 1) * LW) / 2, L, 0.0008, "#3a3b40", "asphalt", { sharp: true, seed: 0 });
          }
          const prev = lanes[k - 1];
          const next = lanes[k + 1];
          // edge lines next to the sidewalks
          if (!prev || prev.type !== "road") F.box(B(uc - LW / 2 + 0.022, 0, 0.0017), 0.004, L, 0.0003, "#e8e8e2", "marking", { sharp: true });
          if (!next || next.type !== "road") F.box(B(uc + LW / 2 - 0.022, 0, 0.0017), 0.004, L, 0.0003, "#e8e8e2", "marking", { sharp: true });
          // between this lane and the next: double yellow (opposite ways) or dashed white (the same way)
          if (next && next.type === "road") {
            const ub = uc + LW / 2;
            if (next.dir !== ln.dir) {
              for (const o of [-0.006, 0.006]) F.box(B(ub + o, 0, 0.0017), 0.0028, L, 0.0003, "#e8b820", "marking", { sharp: true });
            } else {
              for (let a = -L; a < L; a += 0.24) F.box(B(ub, a + 0.06, 0.0017), 0.0035, 0.06, 0.0003, "#e8e8e2", "marking", { sharp: true });
            }
          }
        } else {
          // a sidewalk: paving slabs on a raised bed, curbstones along the road side(s)
          const last = k === lanes.length - 1;
          F.box(B(uc, 0, CURB / 2), LW / 2, L, CURB / 2, last ? "#c9c0a0" : "#b8b5ad", "paving", { sharp: true, seed: 0 });
          if (k > 0) F.box(B(uc - LW / 2 + 0.012, 0, CURB / 2 + 0.0006), 0.012, L, CURB / 2 + 0.0006, "#9d9b96", "concrete", { sharp: true });
          if (!last) F.box(B(uc + LW / 2 - 0.012, 0, CURB / 2 + 0.0006), 0.012, L, CURB / 2 + 0.0006, "#9d9b96", "concrete", { sharp: true });
          if (last) F.box(B(uc + LW / 2 - 0.05, 0, CURB + 0.0004), 0.012, L, 0.0004, "#ffd84a", "marking", { sharp: true }); // the goal
          // traffic cones where the course ends, left and right
          for (const sd of [-W, W]) {
            const cu = uc;
            F.box(B(cu, sd, CURB + 0.002), 0.022, 0.022, 0.002, "#202022", "rubber", { sharp: true });
            F.seg(B(cu, sd, CURB + 0.003), B(cu, sd, CURB + 0.06), 0.016, 0.004, "#ff6a10", "paint");
            F.seg(B(cu, sd, CURB + 0.03), B(cu, sd, CURB + 0.04), 0.0105, 0.0085, "#f4f4f4", "paint");
          }
        }
      });
      R.setTime(stateTime);
      F.draw({ shadow: 0 });
      return true;
    }

    // one vehicle, into the vehicles' figure
    function vehicle(F, k, c, dir) {
      const uc = k * LW;
      const { k: m, halfW, H } = dims(c);
      // P3(along, across, up): along toward its front, across along the course
      const P3 = (al, ac, up) => B(uc + ac, c.s + dir * al, up);
      const box = (al, ac, up, hl, hw, hh, col, mat, op) => F.box(P3(al, ac, up), hw, hl, hh, col, mat, op);
      const wheel = (al, ac, r, wdt) => {
        F.seg(P3(al, ac - wdt / 2, r), P3(al, ac + wdt / 2, r), r, r, "#151517", "rubber");
        const side = ac > 0 ? ac + wdt / 2 : ac - wdt / 2;
        F.seg(P3(al, side, r), P3(al, side + (ac > 0 ? 0.0006 : -0.0006), r), r * 0.96, r * 0.96, "#151517", "rubber", { rust: 1 }); // the sidewall (no tread)
        const out = ac > 0 ? ac + wdt / 2 : ac - wdt / 2;
        F.seg(P3(al, out, r), P3(al, out + (ac > 0 ? 0.0012 : -0.0012), r), r * 0.6, r * 0.6, "#c8ccd2", "chrome");
      };
      const lamps = (al, up, ac, sz, col) => {
        for (const sd of [-1, 1]) F.ell(P3(al, sd * ac, up), sz * 0.5, sz, sz * 0.7, col, "lamp");
      };
      const L2 = c.len / 2;
      if (c.kind === "moto") {
        const r = 0.33 * m;
        for (const al of [-0.72 * m, 0.72 * m]) {
          F.seg(P3(al, -0.06 * m, r), P3(al, 0.06 * m, r), r, r, "#151517", "rubber");
          for (const sd of [-1, 1]) {
            F.seg(P3(al, sd * 0.06 * m, r), P3(al, sd * 0.062 * m, r), r * 0.97, r * 0.97, "#151517", "rubber", { rust: 1 }); // sidewalls
            F.seg(P3(al, sd * 0.061 * m, r), P3(al, sd * 0.064 * m, r), r * 0.55, r * 0.55, "#b8bcc2", "chrome"); // the rim
          }
        }
        F.cap(P3(0.72 * m, 0, r), P3(0.45 * m, 0, 0.95 * m), 0.025 * m, 0.025 * m, "#c8ccd2", "chrome"); // the fork
        F.cap(P3(0.45 * m, -0.32 * m, 1.0 * m), P3(0.45 * m, 0.32 * m, 1.0 * m), 0.02 * m, 0.02 * m, "#202022", "chrome"); // handlebars
        box(-0.05 * m, 0, 0.5 * m, 0.35 * m, 0.13 * m, 0.16 * m, "#5a5c60", "chrome"); // the engine
        F.ell(P3(0.2 * m, 0, 0.85 * m), 0.12 * m, 0.3 * m, 0.11 * m, c.color, "paint"); // the tank
        box(-0.35 * m, 0, 0.82 * m, 0.3 * m, 0.12 * m, 0.05 * m, "#1c1c1e", "leather"); // the seat
        F.ell(P3(-0.8 * m, 0, 0.7 * m), 0.1 * m, 0.16 * m, 0.06 * m, c.color, "paint"); // the tail
        lamps(0.62 * m, 0.95 * m, 0, 0.06 * m, "#fff4cc");
        F.ell(P3(-0.95 * m, 0, 0.72 * m), 0.05 * m, 0.03 * m, 0.03 * m, "#ff2a20", "lamp");
        // the rider
        const jacket = c.color === "#202226" ? "#7a2020" : "#24282e";
        for (const sd of [-1, 1]) {
          F.cap(P3(-0.25 * m, sd * 0.13 * m, 0.95 * m), P3(0.1 * m, sd * 0.15 * m, 0.75 * m), 0.06 * m, 0.05 * m, "#2a3040", "cloth");
          F.cap(P3(0.1 * m, sd * 0.15 * m, 0.75 * m), P3(0.0, sd * 0.16 * m, 0.42 * m), 0.05 * m, 0.04 * m, "#2a3040", "cloth");
          F.cap(P3(0.0, sd * 0.2 * m, 1.42 * m), P3(0.42 * m, sd * 0.3 * m, 1.05 * m), 0.045 * m, 0.04 * m, jacket, "leather");
        }
        F.cap(P3(-0.22 * m, 0, 1.0 * m), P3(0.02 * m, 0, 1.45 * m), 0.15 * m, 0.13 * m, jacket, "leather");
        F.ball(P3(0.06 * m, 0, 1.68 * m), 0.14 * m, c.color, "paint");
        F.ell(P3(0.15 * m, 0, 1.66 * m), 0.06 * m, 0.11 * m, 0.06 * m, "#101418", "glass");
        return;
      }
      if (c.kind === "truck") {
        const cab = 2.3 * m;
        const fr = L2;
        const wr = 0.5 * m;
        for (const al of [fr - 1.4 * m, -L2 + 1.6 * m, -L2 + 2.7 * m]) for (const sd of [-1, 1]) wheel(al, sd * (halfW - 0.18 * m), wr, 0.32 * m);
        box(-0.6 * m, 0, 0.72 * m, L2 - 0.4 * m, halfW * 0.8, 0.18 * m, "#2a2b2e", "rubber", { sharp: true, rust: 1 }); // chassis
        // the cab: body, windscreen, side windows, roof spoiler
        box(fr - cab / 2, 0, 1.75 * m, cab / 2, halfW, 1.15 * m, c.color, "paint");
        box(fr - 0.08 * m, 0, 2.2 * m, 0.06 * m, halfW * 0.86, 0.45 * m, "#101418", "glass");
        for (const sd of [-1, 1]) box(fr - 0.75 * m, sd * (halfW - 0.005 * m), 2.25 * m, 0.45 * m, 0.03 * m, 0.38 * m, "#101418", "glass");
        box(fr - 0.03 * m, 0, 1.0 * m, 0.04 * m, halfW * 0.7, 0.3 * m, "#202226", "chrome"); // the grille
        box(fr + 0.02 * m, 0, 0.62 * m, 0.08 * m, halfW * 0.96, 0.14 * m, "#2a2b2e", "rubber", { sharp: true, rust: 1 }); // bumper
        lamps(fr + 0.04 * m, 0.95 * m, halfW * 0.72, 0.13 * m, "#fff4cc");
        // the cargo box, with a coloured band along its sides
        const bl = c.len - cab - 0.2 * m;
        const bc = -L2 + bl / 2;
        box(bc, 0, 2.15 * m, bl / 2, halfW * 1.02, 1.25 * m, c.cargo, "paint", { sharp: true });
        for (const sd of [-1, 1]) box(bc, sd * halfW * 1.03, 2.4 * m, bl / 2 - 0.15 * m, 0.01 * m, 0.22 * m, c.color, "paint", { sharp: true });
        box(-L2 - 0.01 * m, 0, 2.15 * m, 0.02 * m, halfW * 0.95, 1.15 * m, "#b8b8b4", "paint", { sharp: true }); // the doors
        lamps(-L2 - 0.03 * m, 0.85 * m, halfW * 0.8, 0.1 * m, "#ff2a20");
        return;
      }
      // a car or a van: wheels, the body, the greenhouse (glass) and roof, bumpers, lights
      const van = c.kind === "van";
      const wr = 0.32 * m;
      for (const al of [L2 - 0.85 * m, -L2 + 0.85 * m]) for (const sd of [-1, 1]) wheel(al, sd * (halfW - 0.13 * m), wr, 0.22 * m);
      const sill = 0.24 * m;
      const belt = (van ? 1.05 : 0.86) * m;
      box(0, 0, (sill + belt) / 2, L2 - 0.02 * m, halfW, (belt - sill) / 2, c.color, "paint");
      // greenhouse: from the windscreen's foot to the rear window (a hatch: right to the back)
      const g0 = van ? -L2 + 0.25 * m : c.style === "hatch" ? -L2 + 0.35 * m : -L2 + 1.0 * m;
      const g1 = van ? L2 - 0.9 * m : L2 - 1.45 * m;
      const top = H - 0.06 * m;
      box((g0 + g1) / 2, 0, (belt + top) / 2 - 0.02 * m, (g1 - g0) / 2, halfW * 0.9, (top - belt) / 2 + 0.02 * m, "#101418", "glass");
      box((g0 + g1) / 2 - 0.05 * m, 0, top, (g1 - g0) / 2 - 0.12 * m, halfW * 0.88, 0.06 * m, c.color, "paint"); // roof
      // the pillars between the windows
      for (const sd of [-1, 1]) {
        box(g1 - 0.08 * m, sd * halfW * 0.9, (belt + top) / 2, 0.06 * m, 0.012 * m, (top - belt) / 2, c.color, "paint");
        box((g0 + g1) / 2, sd * halfW * 0.9, (belt + top) / 2, 0.045 * m, 0.012 * m, (top - belt) / 2, c.color, "paint");
        F.box(P3(g1 - 0.15 * m, sd * (halfW + 0.06 * m), belt + 0.08 * m), 0.05 * m, 0.06 * m, 0.04 * m, c.color, "paint"); // mirrors
      }
      for (const sd of [-1, 1]) box(sd * (L2 - 0.08 * m), 0, sill + 0.18 * m, 0.1 * m, halfW * 0.97, 0.16 * m, "#26272b", "rubber", { sharp: true, rust: 1 }); // bumpers
      box(L2 - 0.03 * m, 0, 0.52 * m, 0.03 * m, halfW * 0.45, 0.08 * m, "#18191c", "rubber", { rust: 1 }); // grille
      lamps(L2 - 0.02 * m, 0.66 * m, halfW * 0.7, 0.1 * m, "#fff4cc");
      lamps(-L2 + 0.02 * m, 0.72 * m, halfW * 0.74, 0.09 * m, "#ff2a20");
      box(-L2 + 0.02 * m, 0, 0.45 * m, 0.02 * m, 0.25 * m, 0.06 * m, "#f0f0e8", "paint", { sharp: true }); // number plate
    }

    function drawVehicles3D(cars) {
      if (!cars.length) return;
      const F = R.figure({ f: Ou, r: -Os, z: 0, yaw: 0, scale: 1, height: 0.02, far: 9, full: true, aoH: 0.004 });
      if (!F) return;
      cars.forEach(({ ln, k, c }) => vehicle(F, k, c, ln.dir));
      F.draw({ shadow: 0.9 });
    }

    // -- 2D drawing (no WebGL2) -----------------------------------------------------------------------------------
    function poly(pts, fill, stroke, width = 1) {
      const sp = [];
      for (const [u, s1, h] of pts) {
        const wp = toWorld(u, s1);
        const q = ar.project(wp.x, wp.y, h);
        if (!q) return;
        sp.push(q);
      }
      const ctx = ar.ctx;
      ctx.beginPath();
      sp.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.lineWidth = width;
        ctx.stroke();
      }
    }
    const quad = (u0, s0, u1, s1, h, fill, stroke) => poly([[u0, s0, h], [u0, s1, h], [u1, s1, h], [u1, s0, h]], fill, stroke);
    let cam = { u: 0, s: 0, h: 0.1 };
    const shade = (hex, k) => {
      const n = parseInt(hex.slice(1), 16);
      const c = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
      return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
    };
    // a box's faces the camera sees
    function box2(u0, u1, s0, s1, h0, h1, color) {
      const line = "rgba(0,0,0,0.5)";
      if (cam.s < s0) poly([[u0, s0, h0], [u1, s0, h0], [u1, s0, h1], [u0, s0, h1]], shade(color, 0.72), line);
      if (cam.s > s1) poly([[u0, s1, h0], [u1, s1, h0], [u1, s1, h1], [u0, s1, h1]], shade(color, 0.72), line);
      if (cam.u < u0) poly([[u0, s0, h0], [u0, s1, h0], [u0, s1, h1], [u0, s0, h1]], shade(color, 0.88), line);
      if (cam.u > u1) poly([[u1, s0, h0], [u1, s1, h0], [u1, s1, h1], [u1, s0, h1]], shade(color, 0.88), line);
      if (cam.h > h1) poly([[u0, s0, h1], [u0, s1, h1], [u1, s1, h1], [u1, s0, h1]], shade(color, 1.08), line);
    }
    function drawStreet2D() {
      const L = W + 1;
      lanes.forEach((ln, k) => {
        const u0 = k * LW - LW / 2;
        const u1 = k * LW + LW / 2;
        for (let a = -L; a < L - 1e-6; a += 0.25) {
          quad(u0, a, u1, Math.min(L, a + 0.25), ln.type === "road" ? 0 : CURB, ln.type === "road" ? "rgba(52,52,58,0.85)" : "rgba(196,196,200,0.95)", null);
        }
        if (ln.type === "road" && lanes[k + 1] && lanes[k + 1].type === "road") {
          for (let a = -L; a < L; a += 0.24) quad(u1 - 0.004, a, u1 + 0.004, a + 0.12, 0.0005, lanes[k + 1].dir !== ln.dir ? "rgba(232,184,32,0.9)" : "rgba(240,240,240,0.85)", null);
        }
      });
    }
    function drawVehicle2D(k, c, dir) {
      const uc = k * LW;
      const { halfW, H } = dims(c);
      const a = c.s - c.len / 2;
      const b = c.s + c.len / 2;
      quad(uc - halfW, a, uc + halfW, b, 0.001, "rgba(0,0,0,0.3)", null);
      const parts = [[uc - halfW, uc + halfW, a, b, 0.02, H * 0.6, c.kind === "truck" ? c.cargo : c.color]];
      const front = dir > 0 ? b : a;
      if (c.kind !== "moto") {
        const g0 = c.s - dir * c.len * 0.2;
        const g1 = c.s + dir * c.len * 0.15;
        parts.push([uc - halfW * 0.88, uc + halfW * 0.88, Math.min(g0, g1), Math.max(g0, g1), H * 0.6, H, c.kind === "truck" ? c.cargo : "#22304e"]);
      }
      if (c.kind === "truck") {
        const f0 = front - dir * c.len * 0.25;
        parts.length = 0;
        parts.push([uc - halfW, uc + halfW, Math.min(f0, front), Math.max(f0, front), 0.02, H * 0.8, c.color]);
        const b0 = dir > 0 ? a : b;
        parts.push([uc - halfW, uc + halfW, Math.min(b0, f0), Math.max(b0, f0), 0.03, H, c.cargo]);
      }
      // far parts first
      parts.sort((p, q) => Math.abs((q[2] + q[3]) / 2 - cam.s) - Math.abs((p[2] + p[3]) / 2 - cam.s));
      parts.forEach((p) => box2(...p));
    }

    function draw() {
      const v = ar.view;
      const ctx = ar.ctx;
      if (state !== "title") {
        const cw = ar.cameraWorld();
        const cc = toCourse(cw.x, cw.y);
        cam = { u: cc.u, s: cc.s, h: cw.h };
        // the 3D figures' origin: on the floor a little ahead of the camera
        const a = ar.camTheta - heading;
        Ou = cc.u + Math.cos(a) * 0.6;
        Os = cc.s + Math.sin(a) * 0.6;
        const cars = [];
        const shown = gl() ? W + STREET_M + 0.1 : W + 1;
        lanes.forEach((ln, k) => ln.type === "road" && ln.cars.forEach((c) => Math.abs(c.s) < shown + c.len / 2 && cars.push({ ln, k, c })));
        const in3d = gl() && drawStreet3D();
        if (!in3d) drawStreet2D();
        if (freeze > 0.01 && state === "playing") {
          cars.forEach(({ k, c }) => {
            const hw = dims(c).halfW + 0.02;
            quad(k * LW - hw, c.s - c.len / 2 - 0.02, k * LW + hw, c.s + c.len / 2 + 0.02, CURB * 0, "rgba(120,200,255,0.35)", null);
          });
        }
        if (in3d) drawVehicles3D(cars);
        else {
          const depth = (o) => Math.hypot(o.k * LW - cam.u, o.c.s - cam.s);
          cars.sort((p, q) => depth(q) - depth(p));
          ctx.lineWidth = 1;
          cars.forEach(({ ln, k, c }) => drawVehicle2D(k, c, ln.dir));
        }
      }
      ar.flush();

      const hudY = v.y + v.h - 16;
      ar.text(`SCORE ${score}`, v.x + 16, hudY, { size: 20, color: "#a0ffb0" });
      if (state !== "title") {
        ar.text(`LEVEL ${level}`, v.cx, hudY, { size: 16, align: "center" });
        ar.text("♥".repeat(Math.max(0, lives)), v.x + v.w - 16, hudY, { size: 20, align: "right", color: "#ff6070" });
        const frac = 1 - clamp01(honkCd / HONK_CD_S);
        ctx.fillStyle = frac >= 1 ? "#ffd84a" : "rgba(255,255,255,0.35)";
        ctx.fillRect(v.cx - 40, v.y + 12, 80 * frac, 5);
        ar.text(frac >= 1 ? "HONK ready" : "HONK", v.cx, v.y + 32, { size: 11, align: "center", alpha: 0.8 });
        if (invuln > 0 && state === "playing") ar.flash("#ff4040", Math.min(0.25, invuln * 0.1) * (Math.sin(stateTime * 20) > 0 ? 1 : 0.4));
      }
      if (toast) ar.text(toast.text, v.cx, v.y + v.h * 0.35, { size: 24, align: "center", color: toast.color, alpha: clamp01(toast.t * 2) });

      if (state === "title") {
        ar.flash("#000", 0.45);
        ar.banner("CROSSING", "Press FIRE to start", { color: "#a0ffb0" });
        ar.text("Drive straight ahead across the traffic lanes · sidewalks are safe · stay between the cones · FIRE honks and stops the cars", v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
        if (best !== null) ar.text(`Best on this robot: ${best}`, v.cx, v.cy + v.h * 0.27, { size: 14, align: "center", color: "#a0ffb0" });
      } else if (state === "over") {
        ar.flash("#000", 0.4);
        ar.banner("FLATTENED", `Score ${score} · reached level ${level}`);
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.18, { size: 16, align: "center", color: "#a0ffb0" });
        if (stateTime > 1.5) ar.text("Press FIRE to play again", v.cx, v.cy + v.h * 0.25, { size: 14, align: "center" });
      }
    }

    ar.onFrame((now, dt) => {
      update(dt);
      draw();
    });
    return { actionLabel: "📯 Honk", debug: { lanes: () => lanes, toCourse, LW, W, state: () => state, freeze: () => freeze, lives: () => lives, gl } };
  };
})(window.Lynx);
