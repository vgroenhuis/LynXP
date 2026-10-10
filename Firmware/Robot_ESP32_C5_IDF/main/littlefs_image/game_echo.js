// Echo -- Simon on your floor. Four coloured pads lie around where you
// start. The robot lights them up in a sequence (with a note each); then you
// repeat it by driving onto the pads in the same order and waiting a moment on
// each. Every round adds one more step. Cut across the wrong pad, or dawdle too
// long, and it is over. Pure memory and steering: nothing to shoot.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const PAD_R = 0.22;
  const DWELL_S = 0.35; // time on a pad to register it
  const SHOW_ON_S = 0.55;
  const SHOW_GAP_S = 0.25;
  const PADS = [
    { color: "#ff4060", name: "RED", freq: 262 },
    { color: "#40d070", name: "GREEN", freq: 330 },
    { color: "#4090ff", name: "BLUE", freq: 392 },
    { color: "#ffd040", name: "YELLOW", freq: 523 },
  ];

  const clamp01 = (t) => Math.min(1, Math.max(0, t));

  Lynx.games.echo = (ar, cfg) => {
    const D = cfg.padDistM;
    let state = "title"; // title | show | input | over
    let stateTime = 0;
    let center = { x: 0, y: 0 };
    let pads = [];
    let seq = [];
    let step = 0; // index in seq while showing / repeating
    let lit = -1; // pad index currently lit
    let showClock = 0;
    let dwell = 0;
    let armed = true;
    let wait = 0; // input time left for this step
    let score = 0;
    let toast = null;
    let best = null;
    let rankMsg = "";
    let wrong = -1;
    Lynx.bestScore("echo").then((b) => (best = b));

    function layout() {
      center = { x: ar.pose.x, y: ar.pose.y };
      // Pads at N, E, S, W of the starting spot (in the world frame).
      pads = PADS.map((p, i) => {
        const a = (i * Math.PI) / 2;
        return { ...p, x: center.x + D * Math.cos(a), y: center.y + D * Math.sin(a), glow: 0 };
      });
    }

    function light(i, on = true) {
      lit = on ? i : -1;
      if (on) {
        pads[i].glow = 1;
        Lynx.sfx.play("echo" + i);
      }
    }

    function addStep() {
      seq.push(Math.floor(Math.random() * 4));
      state = "show";
      stateTime = 0;
      step = 0;
      showClock = 0.8;
      lit = -1;
      dwell = 0;
    }

    function start() {
      layout();
      seq = [];
      score = 0;
      wrong = -1;
      for (let i = 1; i < (cfg.startLen || 1); i++) seq.push(Math.floor(Math.random() * 4));
      addStep();
      Lynx.sfx.play("go");
    }

    function fail(w) {
      wrong = w;
      state = "over";
      stateTime = 0;
      rankMsg = "";
      Lynx.sfx.play("fail");
      Lynx.submitScore("echo", score).then((rank) => {
        rankMsg = rank ? `#${rank} on the robot's scoreboard!` : "";
        if (rank === 1) best = score;
      });
    }

    function startInput() {
      state = "input";
      stateTime = 0;
      step = 0;
      lit = -1;
      dwell = 0;
      armed = false; // leave whatever pad you're on first
      wait = cfg.stepTimeS + 2;
      toast = { text: "Your turn!", color: "#ffffff", t: 1.2 };
    }

    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title" || (state === "over" && stateTime > 1.5)) start();
    });

    function update(dt) {
      stateTime += dt;
      pads.forEach((p) => (p.glow = Math.max(0, p.glow - dt * 2.5)));
      if (toast) {
        toast.t -= dt;
        if (toast.t <= 0) toast = null;
      }

      if (state === "show") {
        const speed = Math.pow(0.96, seq.length); // gets quicker
        showClock -= dt;
        if (showClock <= 0) {
          if (lit >= 0) {
            light(lit, false);
            showClock = SHOW_GAP_S * speed;
            step++;
          } else if (step >= seq.length) {
            startInput();
          } else {
            light(seq[step]);
            showClock = SHOW_ON_S * speed;
          }
        }
        return;
      }
      if (state !== "input") return;

      const px = ar.pose.x;
      const py = ar.pose.y;
      const on = pads.findIndex((p) => Math.hypot(p.x - px, p.y - py) < PAD_R);
      wait -= dt;
      if (wait <= 0) {
        toast = { text: "Too slow!", color: "#ff6060", t: 2 };
        fail(-1);
        return;
      }
      if (on < 0) {
        armed = true;
        dwell = 0;
        return;
      }
      if (!armed) return;
      // Wrong pad as soon as you touch it; the right one needs a short dwell.
      if (on !== seq[step]) {
        toast = { text: `That was ${pads[on].name}`, color: pads[on].color, t: 2 };
        fail(on);
        return;
      }
      dwell += dt;
      if (dwell < DWELL_S) return;
      light(on);
      lit = -1;
      score += 10 + seq.length * 2;
      step++;
      dwell = 0;
      armed = false;
      wait = cfg.stepTimeS;
      if (step >= seq.length) {
        score += 20 * seq.length;
        toast = { text: `Round ${seq.length} clear!  +${20 * seq.length}`, color: "#ffd84a", t: 1.5 };
        Lynx.sfx.play("levelup");
        addStep();
      }
    }

    function draw() {
      const v = ar.view;
      const ctx = ar.ctx;
      if (state !== "title") {
        pads.forEach((p, i) => {
          const g = Math.max(p.glow, lit === i ? 1 : 0);
          const col = p.color;
          ar.floorCircle(p.x, p.y, PAD_R, hexA(col, 0.18 + 0.6 * g), hexA(col, 0.9));
          if (g > 0.05) {
            const pr = ar.project(p.x, p.y, 0.05);
            if (pr) ar.glow(pr.x, pr.y, PAD_R * pr.ppm * (1.5 + g), [[0, hexA(col, 0.8 * g)], [1, "rgba(255,255,255,0)"]], 1);
          }
          if (state === "input" && on(i) && armed && dwell > 0) {
            ar.floorCircle(p.x, p.y, PAD_R * clamp01(dwell / DWELL_S), hexA(col, 0.85));
          }
          if (state === "over" && wrong === i) {
            ctx.save();
            ctx.lineWidth = 4;
            ar.floorCircle(p.x, p.y, PAD_R + 0.04, null, "#ffffff");
            ctx.restore();
          }
        });
      }
      ar.flush();

      if (state === "input") {
        // Progress through this round, as dots under the top edge.
        const n = seq.length;
        const gap = 18;
        const x0 = v.cx - ((n - 1) * gap) / 2;
        for (let i = 0; i < n; i++) {
          ctx.fillStyle = i < step ? "#ffffff" : "rgba(255,255,255,0.3)";
          ctx.beginPath();
          ctx.arc(x0 + i * gap, v.y + 24, 5, 0, 2 * Math.PI);
          ctx.fill();
        }
        const frac = clamp01(wait / cfg.stepTimeS);
        ctx.fillStyle = frac < 0.3 ? "#ff6060" : "rgba(255,255,255,0.6)";
        ctx.fillRect(v.cx - 60, v.y + 38, 120 * frac, 4);
      }

      const hudY = v.y + v.h - 16;
      ar.text(`SCORE ${score}`, v.x + 16, hudY, { size: 20, color: "#a0c0ff" });
      if (state !== "title") ar.text(`ROUND ${seq.length}   ${state === "show" ? "WATCH" : state === "input" ? "REPEAT" : ""}`, v.cx + 40, hudY, { size: 16, align: "center" });
      if (toast) ar.text(toast.text, v.cx, v.y + v.h * 0.35, { size: 24, align: "center", color: toast.color, alpha: clamp01(toast.t * 2) });

      if (state === "title") {
        ar.flash("#000", 0.45);
        ar.banner("ECHO", "Press FIRE to lay out the pads", { color: "#a0c0ff" });
        ar.text("Watch the pads light up · drive onto them in the same order · pause on each", v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
        if (best !== null) ar.text(`Best on this robot: ${best}`, v.cx, v.cy + v.h * 0.27, { size: 14, align: "center", color: "#a0c0ff" });
      } else if (state === "over") {
        ar.flash("#000", 0.4);
        ar.banner(wrong >= 0 ? "WRONG PAD" : "TOO SLOW", `Score ${score} · ${seq.length - 1} rounds cleared`);
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.18, { size: 16, align: "center", color: "#a0c0ff" });
        if (stateTime > 1.5) ar.text("Press FIRE to play again", v.cx, v.cy + v.h * 0.25, { size: 14, align: "center" });
      }
    }

    function on(i) {
      return Math.hypot(pads[i].x - ar.pose.x, pads[i].y - ar.pose.y) < PAD_R;
    }

    function hexA(hex, a) {
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
    }

    ar.onFrame((now, dt) => {
      update(dt);
      draw();
    });
    return { actionLabel: "▶ Start" };
  };
})(window.Lynx);
