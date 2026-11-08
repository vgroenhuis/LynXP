// Crossing -- Frogger on your floor. Strips of "road" lie ahead of the robot,
// each with its own traffic (cars, trucks and motorcycles, in 3D, driving
// sideways at their own speed, alternating direction). Drive across them to
// the far side without being run over; a raised sidewalk every three lanes
// gives a breather.
// Reaching the goal flips the course: now cross back, with faster, denser
// traffic. FIRE honks and freezes the traffic for a moment (slow recharge).

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const ROBOT_R = 0.09;
  const CAR_COLORS = ["#ff5060", "#ffb040", "#50d0ff", "#c070ff", "#70e070", "#ffffff"];
  const HONK_FREEZE_S = 2.2;
  const HONK_CD_S = 14;
  const clamp01 = (t) => Math.min(1, Math.max(0, t));

  Lynx.games.crossing = (ar, cfg) => {
    const LW = cfg.laneM; // lane depth (along the course)
    const W = cfg.widthM / 2; // half width of the course
    let state = "title"; // title | playing | clear | over
    let stateTime = 0;
    let origin = { x: 0, y: 0 };
    let heading = 0;
    let lanes = []; // {type:"safe"|"road", cars:[]}
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

    const say = (text, color, t = 1.5) => (toast = { text, color, t });
    const rnd = (a, b) => a + Math.random() * (b - a);

    // world <-> course coordinates: u along the course, s sideways
    const toCourse = (x, y) => {
      const dx = x - origin.x;
      const dy = y - origin.y;
      return { u: dx * Math.cos(heading) + dy * Math.sin(heading), s: -dx * Math.sin(heading) + dy * Math.cos(heading) };
    };
    const toWorld = (u, s) => ({
      x: origin.x + u * Math.cos(heading) - s * Math.sin(heading),
      y: origin.y + u * Math.sin(heading) + s * Math.cos(heading),
    });

    function build() {
      lanes = [{ type: "safe", cars: [] }];
      for (let r = 0; r < cfg.lanesCount; r++) {
        lanes.push({ type: "road", cars: [], speed: 0, dir: 1 });
        if (r % 3 === 2 && r < cfg.lanesCount - 1) lanes.push({ type: "safe", cars: [] });
      }
      lanes.push({ type: "safe", cars: [] });
      const P = 2 * W + 1.2; // loop length cars wrap around
      const baseV = cfg.carSpeedMps * (1 + 0.15 * (level - 1));
      let dir = Math.random() < 0.5 ? 1 : -1;
      lanes.forEach((ln) => {
        if (ln.type !== "road") return;
        ln.dir = dir;
        dir = -dir;
        ln.speed = baseV * rnd(0.6, 1.5);
        const len = rnd(0.25, 0.4) + (Math.random() < 0.3 ? 0.25 : 0);
        const want = Math.min(2 + Math.floor((level + Math.random() * 3) / 2), Math.floor(P / (len + 0.6)));
        const slot = P / Math.max(1, want);
        const off = rnd(0, slot);
        for (let i = 0; i < want; i++) {
          const moto = Math.random() < 0.2;
          const l = moto ? 0.14 : i && Math.random() < 0.7 ? len : len + rnd(-0.05, 0.1);
          ln.cars.push({
            s: -P / 2 + off + i * slot + rnd(-slot * 0.12, slot * 0.12),
            len: l,
            kind: moto ? "moto" : l > 0.5 ? "truck" : "car",
            color: CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)],
          });
        }
        ln.P = P;
      });
      bestLane = 0;
    }

    function startLevel(flip) {
      origin = { x: ar.pose.x, y: ar.pose.y };
      heading = flip === undefined ? ar.pose.theta : heading + Math.PI;
      build();
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

      if (freeze <= 0) {
        lanes.forEach((ln) => {
          ln.cars.forEach((c) => {
            c.s += ln.dir * ln.speed * dt;
            if (c.s > ln.P / 2) c.s -= ln.P;
            if (c.s < -ln.P / 2) c.s += ln.P;
          });
        });
      }

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
        // car body: LW*0.6 deep, c.len long, in lane k; wrapped copies too
        const du = Math.abs(p.u - k * LW);
        if (du > LW * 0.3 + ROBOT_R) continue;
        let ds = Math.abs(p.s - c.s);
        ds = Math.min(ds, ln.P - ds);
        if (ds < c.len / 2 + ROBOT_R) return hit("Run over!");
      }
    }

    function quad(u0, s0, u1, s1, h, fill, stroke) {
      poly([[u0, s0, h], [u0, s1, h], [u1, s1, h], [u1, s0, h]], fill, stroke);
    }
    // a polygon of course points [u, s, h] (all or nothing)
    function poly(pts, fill, stroke, width = 1) {
      const sp = [];
      for (const [u, s1, h] of pts) {
        const w = toWorld(u, s1);
        const q = ar.project(w.x, w.y, h);
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
    // a long strip across the course, in pieces (a piece near or behind the camera drops out alone)
    function strip(u0, u1, h, fill, stroke, piece = 0.25) {
      for (let a = -W; a < W - 1e-6; a += piece) quad(u0, a, u1, Math.min(W, a + piece), h, fill, stroke);
    }

    // -- 3D vehicles: boxes (only the faces the camera sees), shaded ---------------------------------------
    let cam = { u: 0, s: 0, h: 0.1 };
    const shade = (hex, k) => {
      const n = parseInt(hex.slice(1), 16);
      const c = (v) => Math.max(0, Math.min(255, Math.round(v * k)));
      return `rgb(${c(n >> 16)},${c((n >> 8) & 255)},${c(n & 255)})`;
    };
    // a box: u0..u1 (across the lane), s0..s1 (along it), h0..h1; colour, and the top's own colour
    function box(u0, u1, s0, s1, h0, h1, color, topColor, line = "rgba(0,0,0,0.55)") {
      if (cam.s < s0) poly([[u0, s0, h0], [u1, s0, h0], [u1, s0, h1], [u0, s0, h1]], shade(color, 0.72), line);
      if (cam.s > s1) poly([[u0, s1, h0], [u1, s1, h0], [u1, s1, h1], [u0, s1, h1]], shade(color, 0.72), line);
      if (cam.u < u0) poly([[u0, s0, h0], [u0, s1, h0], [u0, s1, h1], [u0, s0, h1]], shade(color, 0.88), line);
      if (cam.u > u1) poly([[u1, s0, h0], [u1, s1, h0], [u1, s1, h1], [u1, s0, h1]], shade(color, 0.88), line);
      if (cam.h > h1) poly([[u0, s0, h1], [u0, s1, h1], [u1, s1, h1], [u1, s0, h1]], topColor || color, line);
    }
    const TIRE = "#1b1b1f";
    function wheels(uc, halfU, sList, r) {
      for (const s1 of sList) for (const side of [-1, 1]) box(uc + side * halfU - r * 0.35, uc + side * halfU + r * 0.35, s1 - r, s1 + r, 0, r * 2, TIRE, "#2a2a30", null);
    }
    // the front's lights: headlights toward where it drives, tail lights behind
    function lights(uc, halfU, front, back, h) {
      const f = front > back ? -0.004 : 0.004;
      for (const side of [-0.65, 0.65]) {
        const u = uc + side * halfU;
        if ((cam.s - front) * (front - back) > 0) poly([[u - 0.008, front, h - 0.006], [u + 0.008, front, h - 0.006], [u + 0.008, front, h + 0.004], [u - 0.008, front, h + 0.004]], "#fff6c0", null);
        if ((cam.s - back) * (back - front) > 0) poly([[u - 0.008, back + f, h - 0.006], [u + 0.008, back + f, h - 0.006], [u + 0.008, back + f, h + 0.002], [u - 0.008, back + f, h + 0.002]], "#ff3030", null);
      }
    }
    function drawVehicle(k, c, dir) {
      const uc = k * LW;
      const a = c.s - c.len / 2;
      const b = c.s + c.len / 2;
      const front = dir > 0 ? b : a;
      const back = dir > 0 ? a : b;
      const at = (t) => back + (front - back) * t; // 0 at the back, 1 at the front
      const lo = (x, y) => Math.min(x, y);
      const hi = (x, y) => Math.max(x, y);
      // its shadow
      quad(uc - LW * 0.3, a, uc + LW * 0.3, b, 0.001, "rgba(0,0,0,0.3)", null);
      if (c.kind === "moto") {
        const half = LW * 0.06;
        wheels(uc, 0, [at(0.18), at(0.82)], 0.016);
        box(uc - half, uc + half, lo(at(0.15), at(0.85)), hi(at(0.15), at(0.85)), 0.016, 0.034, c.color, null);
        // the rider: legs, torso leaning forward, a helmet
        box(uc - half * 1.3, uc + half * 1.3, lo(at(0.3), at(0.55)), hi(at(0.3), at(0.55)), 0.03, 0.05, "#2b3550", null);
        box(uc - half * 1.2, uc + half * 1.2, lo(at(0.38), at(0.62)), hi(at(0.38), at(0.62)), 0.05, 0.078, "#3a4a6a", null);
        box(uc - half * 1.1, uc + half * 1.1, lo(at(0.46), at(0.68)), hi(at(0.46), at(0.68)), 0.078, 0.098, c.color, shade(c.color, 1.15));
        poly([[uc - half, at(0.7), 0.083], [uc + half, at(0.7), 0.083], [uc + half, at(0.7), 0.093], [uc - half, at(0.7), 0.093]], "rgba(20,30,60,0.9)", null); // visor
        return;
      }
      const half = LW * 0.27;
      if (c.kind === "truck") {
        const H = 0.13;
        wheels(uc, half * 0.95, [at(0.12), at(0.3), at(0.82)], 0.018);
        // the cargo box (white, with a coloured stripe) and the cab in front
        box(uc - half, uc + half, lo(at(0.02), at(0.72)), hi(at(0.02), at(0.72)), 0.022, H, "#e8e8ea", "#f4f4f6");
        poly(cam.u < uc - half
          ? [[uc - half, at(0.06), H * 0.45], [uc - half, at(0.68), H * 0.45], [uc - half, at(0.68), H * 0.6], [uc - half, at(0.06), H * 0.6]]
          : [[uc + half, at(0.06), H * 0.45], [uc + half, at(0.68), H * 0.45], [uc + half, at(0.68), H * 0.6], [uc + half, at(0.06), H * 0.6]], c.color, null);
        box(uc - half, uc + half, lo(at(0.75), at(1)), hi(at(0.75), at(1)), 0.022, H * 0.78, c.color, shade(c.color, 1.1));
        box(uc - half * 0.9, uc + half * 0.9, lo(at(0.9), at(1)), hi(at(0.9), at(1)), H * 0.5, H * 0.74, "#1c2a48", "#1c2a48", null); // windscreen
        lights(uc, half, front, back, 0.04);
        return;
      }
      // a car: body, then the cabin with its windows, set back a little
      const H = Math.min(0.1, 0.3 * c.len);
      wheels(uc, half * 0.92, [at(0.2), at(0.8)], 0.017);
      box(uc - half, uc + half, a, b, 0.016, H * 0.55, c.color, shade(c.color, 1.08));
      box(uc - half * 0.86, uc + half * 0.86, lo(at(0.25), at(0.7)), hi(at(0.25), at(0.7)), H * 0.55, H, "#22304e", shade(c.color, 1.12));
      // the roof's pillars: the cabin's top edge in the body colour
      poly([[uc - half * 0.86, at(0.25), H], [uc + half * 0.86, at(0.25), H], [uc + half * 0.86, at(0.7), H], [uc - half * 0.86, at(0.7), H]], shade(c.color, 1.12), "rgba(0,0,0,0.5)");
      lights(uc, half, front, back, H * 0.4);
    }

    function draw() {
      const v = ar.view;
      const ctx = ar.ctx;
      if (state !== "title") {
        const cw = ar.cameraWorld();
        const cc = toCourse(cw.x, cw.y);
        cam = { u: cc.u, s: cc.s, h: cw.h };
        const cars = [];
        const CURB = 0.016;
        lanes.forEach((ln, k) => {
          const u0 = k * LW - LW / 2;
          const u1 = k * LW + LW / 2;
          const last = k === lanes.length - 1;
          if (ln.type === "road") {
            // asphalt, white edge lines, a dashed middle line
            strip(u0, u1, 0, "rgba(46,46,52,0.82)", null);
            strip(u0 + 0.012, u0 + 0.02, 0.0005, "rgba(240,240,240,0.8)", null);
            strip(u1 - 0.02, u1 - 0.012, 0.0005, "rgba(240,240,240,0.8)", null);
            for (let a = -W; a < W; a += 0.16) quad(k * LW - 0.005, a, k * LW + 0.005, Math.min(W, a + 0.08), 0.0005, "rgba(255,220,90,0.85)", null);
            ln.cars.forEach((c) => cars.push({ ln, k, c }));
          } else {
            // a sidewalk: a raised slab of paving stones, its curb edges facing the road
            const top = last ? "rgba(214,206,170,0.95)" : "rgba(196,196,200,0.95)";
            for (const face of [cam.u < u0 ? u0 : null, cam.u > u1 ? u1 : null]) {
              if (face === null) continue;
              for (let a = -W; a < W - 1e-6; a += 0.25) poly([[face, a, 0], [face, Math.min(W, a + 0.25), 0], [face, Math.min(W, a + 0.25), CURB], [face, a, CURB]], "rgba(140,140,146,0.95)", "rgba(60,60,66,0.6)");
            }
            strip(u0, u1, CURB, top, null);
            // the slabs' joints
            for (let a = -W; a <= W + 1e-6; a += 0.15) quad(u0, a - 0.002, u1, a + 0.002, CURB + 0.0005, "rgba(90,90,96,0.6)", null);
            quad(k * LW - 0.002, -W, k * LW + 0.002, W, CURB + 0.0005, "rgba(90,90,96,0.6)", null);
            if (last) strip(u1 - 0.03, u1 - 0.012, CURB + 0.0006, "rgba(255,216,74,0.95)", null); // the goal line
          }
        });
        // far vehicles first
        const depth = (o) => Math.hypot(o.k * LW - cam.u, o.c.s - cam.s);
        cars.sort((a, b) => depth(b) - depth(a));
        cars.forEach(({ ln, k, c }) => {
          if (Math.abs(c.s) > W + 0.25) return; // (off the road's ends: on its way round)
          ctx.lineWidth = 1;
          drawVehicle(k, c, ln.dir);
          if (freeze > 0.01 && state === "playing") quad(k * LW - LW * 0.3, c.s - c.len / 2, k * LW + LW * 0.3, c.s + c.len / 2, 0.002, "rgba(120,200,255,0.35)", null);
        });
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
        ar.text("Drive straight ahead across the traffic lanes · sidewalks are safe · FIRE honks and stops the cars", v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
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
    return { actionLabel: "📯 Honk", debug: { lanes: () => lanes, toCourse, LW, W, state: () => state, freeze: () => freeze, lives: () => lives } };
  };
})(window.Lynx);
