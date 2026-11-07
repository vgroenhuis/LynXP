// Crossing -- Frogger on your floor. Strips of "road" lie ahead of the robot,
// each with its own traffic (cars and trucks driving sideways at their own
// speed, alternating direction). Drive across them to the far side without
// being run over; safe median strips every three lanes give a breather.
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
          ln.cars.push({
            s: -P / 2 + off + i * slot + rnd(-slot * 0.12, slot * 0.12),
            len: i && Math.random() < 0.7 ? len : len + rnd(-0.05, 0.1),
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
      const pts = [toWorld(u0, s0), toWorld(u0, s1), toWorld(u1, s1), toWorld(u1, s0)].map((w) => ar.project(w.x, w.y, h));
      if (pts.some((q) => !q)) return;
      const ctx = ar.ctx;
      ctx.beginPath();
      pts.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
      ctx.closePath();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.stroke();
      }
    }

    function draw() {
      const v = ar.view;
      const ctx = ar.ctx;
      if (state !== "title") {
        const cars = [];
        lanes.forEach((ln, k) => {
          const u0 = k * LW - LW / 2;
          const u1 = k * LW + LW / 2;
          const last = k === lanes.length - 1;
          if (ln.type === "road") {
            quad(u0, -W, u1, W, 0, "rgba(40,40,50,0.55)", "rgba(255,255,255,0.25)");
            ctx.save();
            ctx.setLineDash([6, 8]);
            quad(k * LW, -W, k * LW, W, 0, null, "rgba(255,230,120,0.45)");
            ctx.restore();
            ln.cars.forEach((c) => cars.push({ ln, k, c }));
          } else {
            quad(u0, -W, u1, W, 0, last ? "rgba(255,216,74,0.35)" : "rgba(60,200,100,0.28)", last ? "#ffd84a" : "rgba(120,255,160,0.6)");
          }
        });
        // far cars first
        const depth = (o) => {
          const w = toWorld(o.k * LW, o.c.s);
          return Math.hypot(w.x - ar.pose.x, w.y - ar.pose.y);
        };
        cars.sort((a, b) => depth(b) - depth(a));
        cars.forEach(({ ln, k, c }) => {
          const u0 = k * LW - LW * 0.3;
          const u1 = k * LW + LW * 0.3;
          const a = c.s - c.len / 2;
          const b = c.s + c.len / 2;
          const col = freeze > 0 && stateTime > 0 ? c.color : c.color;
          ctx.lineWidth = 1.5;
          quad(u0, a, u1, b, 0, "rgba(0,0,0,0.35)", null);
          quad(u0 + 0.01, a + 0.01, u1 - 0.01, b - 0.01, 0.07, col, "rgba(0,0,0,0.6)");
          // windscreen toward the driving direction
          const f = ln.dir > 0 ? b : a;
          const g = ln.dir > 0 ? b - 0.07 : a + 0.07;
          quad(u0 + 0.04, Math.min(f, g), u1 - 0.04, Math.max(f, g), 0.075, "rgba(20,30,60,0.85)", null);
          if (freeze > 0.01 && state === "playing") quad(u0, a, u1, b, 0.075, "rgba(120,200,255,0.25)", null);
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
        ar.text("Drive straight ahead across the traffic lanes · green strips are safe · FIRE honks and stops the cars", v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
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
    return { actionLabel: "📯 Honk" };
  };
})(window.Lynx);
