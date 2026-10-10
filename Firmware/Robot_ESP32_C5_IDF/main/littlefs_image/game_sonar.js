// Sonar -- a treasure hunt with nothing to see. Gems are buried somewhere on
// the floor around where you start, and the robot only has its sonar: a
// ping that comes faster and higher the closer you are to the nearest gem.
// Hunt by ear (and the hot/cold meter), then press FIRE to dig where you
// stand. Digs are limited, and so is time -- a miss costs a dig.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const DIG_RADIUS_M = 0.18;
  const MIN_GEM_GAP_M = 0.45;
  const MIN_START_DIST_M = 0.4;
  const PING_FAR_S = 1.8;
  const PING_NEAR_S = 0.1;
  const RING_LIFE_S = 0.9;
  const RING_MAX_M = 0.7;
  const GEM_COLORS = ["#40e0ff", "#ff5080", "#80ff60", "#ffd040", "#c080ff"];

  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp01 = (t) => Math.min(1, Math.max(0, t));

  Lynx.games.sonar = (ar, cfg) => {
    const R = cfg.areaRadiusM;
    let state = "title"; // title | playing | over
    let stateTime = 0;
    let center = { x: 0, y: 0 };
    let gems = [];
    let holes = []; // misses: {x, y, near}
    let rings = []; // sonar pulses: {x, y, t, hue}
    let timeLeft = 0;
    let digs = 0;
    let score = 0;
    let round = 1;
    let pingClock = 0;
    let pingParity = false;
    let heat = 0; // 0 (cold) .. 1 (on top of it)
    let nearest = Infinity;
    let toast = null; // {text, color, t}
    let best = null;
    let rankMsg = "";
    let won = false;
    Lynx.bestScore("sonar").then((b) => (best = b));

    function bury() {
      center = { x: ar.pose.x, y: ar.pose.y };
      gems = [];
      holes = [];
      rings = [];
      const gap = MIN_GEM_GAP_M * Math.min(1, R / 1.5);
      let tries = 0;
      while (gems.length < cfg.gemCount && tries++ < 5000) {
        const a = Math.random() * 2 * Math.PI;
        const r = Math.sqrt(Math.random()) * R;
        const g = { x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a), found: false, spin: Math.random() * 6, color: GEM_COLORS[gems.length % GEM_COLORS.length] };
        if (Math.hypot(g.x - center.x, g.y - center.y) < MIN_START_DIST_M) continue;
        if (gems.some((o) => Math.hypot(o.x - g.x, o.y - g.y) < gap)) continue;
        gems.push(g);
      }
      timeLeft = Math.max(20, cfg.timeS - (round - 1) * 10);
      digs = cfg.digs;
      pingClock = 0.3;
    }

    function start() {
      round = 1;
      score = 0;
      bury();
      state = "playing";
      stateTime = 0;
      Lynx.sfx.play("go");
    }

    function finish(allFound) {
      won = allFound;
      if (allFound) {
        const bonus = Math.round(timeLeft * 2) + digs * 25;
        score += 200 + bonus;
        toast = { text: `Round clear!  +${200 + bonus}`, color: "#ffd84a", t: 2.2 };
        Lynx.sfx.play("levelup");
        round++;
        stateTime = 0;
        state = "clear";
        return;
      }
      state = "over";
      stateTime = 0;
      rankMsg = "";
      Lynx.sfx.play("fail");
      Lynx.submitScore("sonar", score).then((rank) => {
        rankMsg = rank ? `#${rank} on the robot's scoreboard!` : "";
        if (rank === 1) best = score;
      });
    }

    function dig() {
      const px = ar.pose.x;
      const py = ar.pose.y;
      const hit = gems.find((g) => !g.found && Math.hypot(g.x - px, g.y - py) < DIG_RADIUS_M);
      digs--;
      if (hit) {
        hit.found = true;
        const pts = 100 + Math.round(timeLeft);
        score += pts;
        toast = { text: `Gem!  +${pts}`, color: hit.color, t: 1.4 };
        Lynx.sfx.play("found");
        if (gems.every((g) => g.found)) {
          finish(true);
          return;
        }
      } else {
        const d = Math.min(...gems.filter((g) => !g.found).map((g) => Math.hypot(g.x - px, g.y - py)));
        const word = d < 0.35 ? "so close!" : d < 0.8 ? "warm..." : "nothing here";
        holes.push({ x: px, y: py });
        toast = { text: `Dud -- ${word}`, color: "#c0a080", t: 1.4 };
        Lynx.sfx.play("knock");
      }
      if (digs <= 0 && state === "playing") finish(false);
    }

    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title" || (state === "over" && stateTime > 1.5)) start();
      else if (state === "playing") dig();
    });

    function update(dt) {
      stateTime += dt;
      gems.forEach((g) => (g.spin += dt * 2.5));
      rings.forEach((r) => (r.t += dt));
      rings = rings.filter((r) => r.t < RING_LIFE_S);
      if (toast) {
        toast.t -= dt;
        if (toast.t <= 0) toast = null;
      }
      if (state === "clear" && stateTime > 2.4) {
        bury();
        state = "playing";
        stateTime = 0;
      }
      if (state !== "playing") return;

      timeLeft -= dt;
      if (timeLeft <= 0) {
        timeLeft = 0;
        toast = { text: "Time's up!", color: "#ff6060", t: 2 };
        finish(false);
        return;
      }
      const px = ar.pose.x;
      const py = ar.pose.y;
      nearest = Infinity;
      gems.forEach((g) => {
        if (!g.found) nearest = Math.min(nearest, Math.hypot(g.x - px, g.y - py));
      });
      heat = clamp01(1 - nearest / (R * 0.9));
      heat = heat * heat;
      pingClock -= dt;
      if (pingClock <= 0) {
        const interval = lerp(PING_FAR_S, PING_NEAR_S, Math.sqrt(heat));
        pingClock = interval;
        pingParity = !pingParity;
        rings.push({ x: px, y: py, t: 0, heat });
        Lynx.sfx.play(heat > 0.85 ? "click" : pingParity ? "tick" : "tock");
        if (heat > 0.35 && !cfg.quiet) Lynx.sfx.play("beep");
      }
    }

    const heatColor = (h, a = 1) => `hsla(${Math.round(lerp(220, 0, h))},90%,60%,${a})`;
    const heatWord = (h) => (h > 0.8 ? "BURNING" : h > 0.5 ? "HOT" : h > 0.25 ? "WARM" : h > 0.08 ? "COOL" : "COLD");

    function drawGem(g) {
      const pr = ar.project(g.x, g.y, 0.05);
      if (!pr) return;
      const ctx = ar.ctx;
      ar.queue(pr.depth, () => {
        ar.floorCircle(g.x, g.y, 0.05, "rgba(0,0,0,0.3)");
        const rr = Math.max(0.045 * pr.ppm, 2);
        ar.glow(pr.x, pr.y, rr * 2.4, [[0, g.color], [1, "rgba(255,255,255,0)"]], 0.6);
        const sq = Math.abs(Math.cos(g.spin)) * 0.7 + 0.3;
        ctx.fillStyle = g.color;
        ctx.beginPath();
        ctx.moveTo(pr.x, pr.y - rr * 1.2);
        ctx.lineTo(pr.x + rr * sq, pr.y);
        ctx.lineTo(pr.x, pr.y + rr * 1.2);
        ctx.lineTo(pr.x - rr * sq, pr.y);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.beginPath();
        ctx.moveTo(pr.x, pr.y - rr * 1.2);
        ctx.lineTo(pr.x + rr * sq * 0.4, pr.y - rr * 0.2);
        ctx.lineTo(pr.x - rr * sq * 0.4, pr.y - rr * 0.2);
        ctx.closePath();
        ctx.fill();
      });
    }

    function draw() {
      const v = ar.view;
      const ctx = ar.ctx;
      if (state !== "title") {
        ctx.save();
        ctx.setLineDash([6, 6]);
        ctx.lineWidth = 1.5;
        ar.floorCircle(center.x, center.y, R + 0.1, null, "rgba(80,200,160,0.5)");
        ctx.restore();
        holes.forEach((h) => ar.floorCircle(h.x, h.y, DIG_RADIUS_M * 0.8, "rgba(60,40,20,0.55)", "rgba(20,10,0,0.7)"));
        rings.forEach((r) => {
          const k = r.t / RING_LIFE_S;
          ctx.save();
          ctx.lineWidth = 2.5 * (1 - k) + 0.5;
          ar.floorCircle(r.x, r.y, 0.05 + k * RING_MAX_M, null, heatColor(r.heat, 0.8 * (1 - k)));
          ctx.restore();
        });
        // The dig reach, so you can line up the robot over a suspected spot.
        if (state === "playing") {
          ctx.save();
          ctx.setLineDash([3, 4]);
          ctx.lineWidth = 1;
          ar.floorCircle(ar.pose.x, ar.pose.y, DIG_RADIUS_M, null, "rgba(255,255,255,0.35)");
          ctx.restore();
        }
      }
      // Found gems stay on show; buried ones are never drawn.
      gems.filter((g) => g.found).forEach(drawGem);
      ar.flush();

      if (state === "playing" || state === "clear") {
        // Hot/cold thermometer, centred under the top edge.
        const bw = v.w * 0.5;
        const bx = v.cx - bw / 2;
        const by = v.y + 14;
        ctx.fillStyle = "rgba(0,0,0,0.5)";
        ctx.fillRect(bx - 2, by - 2, bw + 4, 14);
        const grad = ctx.createLinearGradient(bx, 0, bx + bw, 0);
        grad.addColorStop(0, heatColor(0));
        grad.addColorStop(0.5, heatColor(0.5));
        grad.addColorStop(1, heatColor(1));
        ctx.fillStyle = grad;
        ctx.fillRect(bx, by, bw * Math.max(0.02, state === "playing" ? Math.sqrt(heat) : 1), 10);
        ar.text(state === "playing" ? heatWord(heat) : "", v.cx, by + 34, { size: 18, align: "center", color: heatColor(heat) });
      }

      const hudY = v.y + v.h - 16;
      ar.text(`SCORE ${score}`, v.x + 16, hudY, { size: 20, color: "#80ffd0" });
      ar.text(`ROUND ${round}   gems ${gems.filter((g) => g.found).length}/${gems.length}   digs ${digs}   ${Math.ceil(timeLeft)}s`, v.cx + 40, hudY, { size: 16, align: "center" });
      if (toast) ar.text(toast.text, v.cx, v.y + v.h * 0.35, { size: 24, align: "center", color: toast.color, alpha: clamp01(toast.t * 2) });
      if (state === "playing" && stateTime < 5) ar.text("FIRE = dig where you stand", v.cx, v.y + v.h * 0.45, { size: 14, align: "center", alpha: 0.8 });

      if (state === "title") {
        ar.flash("#000", 0.45);
        ar.banner("SONAR", "Press FIRE to bury the gems", { color: "#80ffd0" });
        ar.text("Nothing is visible · listen to the pings · faster = closer · FIRE digs", v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
        if (best !== null) ar.text(`Best on this robot: ${best}`, v.cx, v.cy + v.h * 0.27, { size: 14, align: "center", color: "#80ffd0" });
      } else if (state === "over") {
        ar.flash("#000", 0.4);
        // Reveal what was left buried.
        gems.filter((g) => !g.found).forEach(drawGem);
        ar.flush();
        ar.banner(digs <= 0 ? "OUT OF DIGS" : "TIME'S UP", `Score ${score} · round ${round}`);
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.18, { size: 16, align: "center", color: "#80ffd0" });
        if (stateTime > 1.5) ar.text("Press FIRE to play again", v.cx, v.cy + v.h * 0.25, { size: 14, align: "center" });
      }
    }

    ar.onFrame((now, dt) => {
      update(dt);
      draw();
    });
    return { actionLabel: "⛏ Dig" };
  };
})(window.Lynx);
