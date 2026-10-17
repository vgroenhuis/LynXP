// Shepherd -- the robot is the sheepdog. A flock grazes on your floor and shies
// away from the robot; drive round behind it to steer the sheep through the gap
// into the pen. Foxes sneak in from the edge to catch strays, and they flee
// from you too, so keep them off the flock. FIRE barks: a short, wide scare.
// Nothing to shoot, nothing to remember: it is all about positioning.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const SHEEP_R = 0.05;
  const FLEE_R = 0.55; // a sheep starts to run when the robot is this close
  const BARK_R = 1.0;
  const BARK_COOLDOWN_S = 2.5;
  const SHEEP_SPEED = 0.28; // m/s at full panic
  const GRAZE_SPEED = 0.03;
  const FOX_SPEED = 0.2;
  const FOX_FLEE_R = 0.45;
  const FOX_CATCH_R = 0.09;
  const PEN_HALF = 0.28;
  const GAP_HALF = 0.17; // the opening in the pen's wall facing the middle

  const SHEEP = [
    "..kkkk....",
    ".kwwwwk.kk",
    "kwwwwwwkdk",
    "kwwwwwwkdk",
    "kwwwwwwwkk",
    ".kwwwwwk..",
    "..k.k.k...",
  ];
  const SHEEP_PAL = { k: "#202020", w: "#f4f4f0", d: "#4a3a30" };
  const FOX = [
    "k.....k...",
    "kok..kok..",
    "koooooook.",
    ".oooooowok",
    "..ooooooww",
    "..oo.oo.o.",
    "..k..k..k.",
  ];
  const FOX_PAL = { k: "#2a1a0a", o: "#e07828", w: "#fff0e0" };

  const clamp01 = (t) => Math.min(1, Math.max(0, t));
  const lerp = (a, b, t) => a + (b - a) * t;

  Lynx.games.shepherd = (ar, cfg) => {
    const R = cfg.areaRadiusM;
    const sprites = { sheep: Lynx.sprite(SHEEP, SHEEP_PAL), fox: Lynx.sprite(FOX, FOX_PAL) };
    let state = "title"; // title | playing | clear | over
    let stateTime = 0;
    let center = { x: 0, y: 0 };
    let pen = { x: 0, y: 0, a: 0 }; // a = direction from the middle to the pen
    let sheep = [];
    let foxes = [];
    let rings = []; // barks: {x, y, t}
    let level = 1;
    let score = 0;
    let lost = 0;
    let timeLeft = 0;
    let barkCd = 0;
    let foxClock = 0;
    let toast = null;
    let best = null;
    let rankMsg = "";
    Lynx.bestScore("shepherd").then((b) => (best = b));

    // Pen coordinates: u along the pen's outward axis (away from the middle),
    // v sideways. The wall facing the middle (u = -PEN_HALF) has the gap.
    function toPen(x, y) {
      const dx = x - pen.x;
      const dy = y - pen.y;
      const c = Math.cos(pen.a);
      const s = Math.sin(pen.a);
      return { u: dx * c + dy * s, v: -dx * s + dy * c };
    }
    function fromPen(u, v) {
      const c = Math.cos(pen.a);
      const s = Math.sin(pen.a);
      return { x: pen.x + u * c - v * s, y: pen.y + u * s + v * c };
    }
    const inPen = (x, y) => {
      const p = toPen(x, y);
      return Math.abs(p.u) < PEN_HALF - 0.02 && Math.abs(p.v) < PEN_HALF - 0.02;
    };

    function setup() {
      center = { x: ar.pose.x, y: ar.pose.y };
      pen.a = Math.random() * 2 * Math.PI;
      const pd = Math.max(R * 0.8, PEN_HALF + 0.5);
      pen.x = center.x + pd * Math.cos(pen.a);
      pen.y = center.y + pd * Math.sin(pen.a);
      const n = Math.min(12, 3 + level);
      sheep = [];
      let tries = 0;
      while (sheep.length < n && tries++ < 2000) {
        const a = Math.random() * 2 * Math.PI;
        const r = Math.sqrt(Math.random()) * R * 0.75;
        const x = center.x + r * Math.cos(a);
        const y = center.y + r * Math.sin(a);
        if (Math.hypot(x - ar.pose.x, y - ar.pose.y) < 0.35) continue;
        if (Math.hypot(x - pen.x, y - pen.y) < PEN_HALF + 0.3) continue;
        sheep.push({ x, y, vx: 0, vy: 0, penned: false, caught: false, wob: Math.random() * 6, dir: 1 });
      }
      foxes = [];
      foxClock = Math.max(6, 16 - level);
      rings = [];
      barkCd = 0;
      lost = 0;
      timeLeft = Math.max(35, cfg.timeS - (level - 1) * 5);
    }

    function start() {
      level = 1;
      score = 0;
      setup();
      state = "playing";
      stateTime = 0;
      Lynx.sfx.play("go");
    }

    function end() {
      state = "over";
      stateTime = 0;
      rankMsg = "";
      Lynx.sfx.play("fail");
      Lynx.submitScore("shepherd", score).then((rank) => {
        rankMsg = rank ? `#${rank} on the robot's scoreboard!` : "";
        if (rank === 1) best = score;
      });
    }

    function bark() {
      if (state !== "playing" || barkCd > 0) return;
      barkCd = BARK_COOLDOWN_S;
      rings.push({ x: ar.pose.x, y: ar.pose.y, t: 0 });
      Lynx.sfx.play("knock");
      const px = ar.pose.x;
      const py = ar.pose.y;
      const scare = (o, k) => {
        const d = Math.hypot(o.x - px, o.y - py) || 0.01;
        if (d < BARK_R) {
          o.vx += ((o.x - px) / d) * k;
          o.vy += ((o.y - py) / d) * k;
        }
      };
      sheep.forEach((s) => !s.penned && !s.caught && scare(s, SHEEP_SPEED * 1.6));
      foxes.forEach((f) => scare(f, FOX_SPEED * 2));
    }

    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title" || (state === "over" && stateTime > 1.5)) start();
      else bark();
    });

    // Keep a point inside the play circle.
    function clampArea(o, m) {
      const dx = o.x - center.x;
      const dy = o.y - center.y;
      const d = Math.hypot(dx, dy);
      const lim = R - m;
      if (d > lim) {
        o.x = center.x + (dx / d) * lim;
        o.y = center.y + (dy / d) * lim;
        const dot = (o.vx * dx + o.vy * dy) / d;
        if (dot > 0) {
          o.vx -= (dx / d) * dot * 1.5;
          o.vy -= (dy / d) * dot * 1.5;
        }
      }
    }

    // The pen's three walls (solid for sheep and foxes), as a push-out.
    function penWalls(o) {
      const p = toPen(o.x, o.y);
      const m = SHEEP_R;
      if (o.penned) {
        // once in, a sheep stays in: bounce off all four sides
        let { u, v } = p;
        const lim = PEN_HALF - m - 0.02;
        if (Math.abs(u) > lim) u = Math.sign(u) * lim;
        if (Math.abs(v) > lim) v = Math.sign(v) * lim;
        const q = fromPen(u, v);
        o.x = q.x;
        o.y = q.y;
        return;
      }
      // Outside: the walls at v = +-PEN_HALF and u = +PEN_HALF are solid; the
      // wall at u = -PEN_HALF is solid except for the gap.
      const near = (a, b) => Math.abs(a) < b;
      let { u, v } = p;
      let hit = false;
      const thick = 0.02 + m;
      const gapOpen = near(v, GAP_HALF);
      // side walls
      if (u > -PEN_HALF - thick && u < PEN_HALF + thick) {
        for (const s of [-1, 1]) {
          const wv = s * PEN_HALF;
          if (Math.abs(v - wv) < thick) {
            v = wv + (v - wv >= 0 ? thick : -thick);
            hit = true;
          }
        }
      }
      // back wall
      if (Math.abs(v) < PEN_HALF + thick && Math.abs(u - PEN_HALF) < thick) {
        u = PEN_HALF + (u >= PEN_HALF ? thick : -thick);
        hit = true;
      }
      // front wall, with the gap
      if (!gapOpen && Math.abs(v) < PEN_HALF + thick && Math.abs(u + PEN_HALF) < thick) {
        u = -PEN_HALF + (u >= -PEN_HALF ? thick : -thick);
        hit = true;
      }
      if (hit) {
        const q = fromPen(u, v);
        o.vx *= 0.3;
        o.vy *= 0.3;
        o.x = q.x;
        o.y = q.y;
      }
    }

    function update(dt) {
      stateTime += dt;
      rings.forEach((r) => (r.t += dt));
      rings = rings.filter((r) => r.t < 0.7);
      if (toast) {
        toast.t -= dt;
        if (toast.t <= 0) toast = null;
      }
      if (state === "clear" && stateTime > 2.4) {
        level++;
        setup();
        state = "playing";
        stateTime = 0;
        Lynx.sfx.play("go");
      }
      if (state !== "playing") return;

      const px = ar.pose.x;
      const py = ar.pose.y;
      barkCd = Math.max(0, barkCd - dt);
      timeLeft -= dt;
      if (timeLeft <= 0) {
        toast = { text: "Time's up!", color: "#ff6060", t: 2 };
        end();
        return;
      }

      const live = sheep.filter((s) => !s.caught);
      const free = live.filter((s) => !s.penned);
      // flock centre for cohesion
      let gx = 0;
      let gy = 0;
      free.forEach((s) => ((gx += s.x), (gy += s.y)));
      if (free.length) {
        gx /= free.length;
        gy /= free.length;
      }

      sheep.forEach((s) => {
        if (s.caught) return;
        s.wob += dt * 6;
        let ax = 0;
        let ay = 0;
        const dd = Math.hypot(s.x - px, s.y - py) || 0.01;
        if (s.penned) {
          // graze about in the pen, away from the robot only a little
          ax += Math.sin(s.wob * 0.3 + s.x * 9) * GRAZE_SPEED;
          ay += Math.cos(s.wob * 0.27 + s.y * 9) * GRAZE_SPEED;
        } else {
          if (dd < FLEE_R) {
            const panic = 1 - dd / FLEE_R;
            ax += ((s.x - px) / dd) * SHEEP_SPEED * (0.4 + panic) * 6;
            ay += ((s.y - py) / dd) * SHEEP_SPEED * (0.4 + panic) * 6;
          }
          if (free.length > 1) {
            ax += (gx - s.x) * 0.25;
            ay += (gy - s.y) * 0.25;
          }
          // separate from neighbours
          free.forEach((o) => {
            if (o === s) return;
            const d = Math.hypot(s.x - o.x, s.y - o.y);
            if (d < 0.14 && d > 0.001) {
              ax += ((s.x - o.x) / d) * 0.6;
              ay += ((s.y - o.y) / d) * 0.6;
            }
          });
          ax += Math.sin(s.wob * 0.2 + s.y * 7) * GRAZE_SPEED;
          ay += Math.cos(s.wob * 0.23 + s.x * 7) * GRAZE_SPEED;
        }
        s.vx += ax * dt * 4;
        s.vy += ay * dt * 4;
        const sp = Math.hypot(s.vx, s.vy);
        const cap = s.penned ? 0.08 : SHEEP_SPEED;
        if (sp > cap) {
          s.vx *= cap / sp;
          s.vy *= cap / sp;
        }
        s.vx *= Math.pow(0.35, dt);
        s.vy *= Math.pow(0.35, dt);
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        if (Math.abs(s.vx) > 0.01) s.dir = s.vx > 0 ? 1 : -1;
        if (!s.penned) clampArea(s, 0.08);
        penWalls(s);
        if (!s.penned && inPen(s.x, s.y)) {
          s.penned = true;
          const pts = 100 + Math.round(timeLeft);
          score += pts;
          toast = { text: `Penned!  +${pts}`, color: "#ffffff", t: 1.1 };
          Lynx.sfx.play("found");
        }
      });

      // foxes
      foxClock -= dt;
      if (foxClock <= 0 && foxes.length < Math.min(1 + Math.floor(level / 2), 3) && free.length) {
        const a = Math.random() * 2 * Math.PI;
        foxes.push({ wob: 0, x: center.x + (R - 0.05) * Math.cos(a), y: center.y + (R - 0.05) * Math.sin(a), vx: 0, vy: 0, dir: 1, stun: 0 });
        foxClock = Math.max(7, 18 - level * 1.5);
        toast = { text: "A fox!", color: "#ff9040", t: 1.3 };
        Lynx.sfx.play("suspect");
      }
      foxes.forEach((f) => {
        f.stun = Math.max(0, f.stun - dt);
        let tx = 0;
        let ty = 0;
        let best = Infinity;
        free.forEach((s) => {
          if (s.caught) return;
          const d = Math.hypot(s.x - f.x, s.y - f.y);
          if (d < best) {
            best = d;
            tx = s.x;
            ty = s.y;
          }
        });
        let ax = 0;
        let ay = 0;
        if (f.fled) {
          ax += ((f.x - center.x) / R) * FOX_SPEED * 6;
          ay += ((f.y - center.y) / R) * FOX_SPEED * 6;
        } else if (best < Infinity && f.stun <= 0) {
          ax += ((tx - f.x) / best) * FOX_SPEED * 3;
          ay += ((ty - f.y) / best) * FOX_SPEED * 3;
        } else if (best === Infinity) {
          // nothing left to catch: slink off
          ax += ((f.x - center.x) / R) * FOX_SPEED * 3;
          ay += ((f.y - center.y) / R) * FOX_SPEED * 3;
        }
        const dd = Math.hypot(f.x - px, f.y - py) || 0.01;
        if (dd < FOX_FLEE_R) {
          ax += ((f.x - px) / dd) * FOX_SPEED * 10;
          ay += ((f.y - py) / dd) * FOX_SPEED * 10;
        }
        f.vx += ax * dt * 4;
        f.vy += ay * dt * 4;
        const sp = Math.hypot(f.vx, f.vy);
        const cap = FOX_SPEED * (dd < FOX_FLEE_R ? 1.5 : 1);
        if (sp > cap) {
          f.vx *= cap / sp;
          f.vy *= cap / sp;
        }
        f.vx *= Math.pow(0.5, dt);
        f.vy *= Math.pow(0.5, dt);
        f.x += f.vx * dt;
        f.y += f.vy * dt;
        if (Math.abs(f.vx) > 0.01) f.dir = f.vx > 0 ? 1 : -1;
        penWalls(f);
        // the robot ramming it makes it drop everything
        if (dd < 0.15) f.stun = 1.2;
        const c = free.find((s) => !s.caught && Math.hypot(s.x - f.x, s.y - f.y) < FOX_CATCH_R);
        if (c && f.stun <= 0) {
          c.caught = true;
          lost++;
          f.vx = (f.x - center.x) * 0.5;
          f.vy = (f.y - center.y) * 0.5;
          f.fled = true;
          toast = { text: "Lost a sheep!", color: "#ff6060", t: 1.6 };
          Lynx.sfx.play("hurt");
        }
      });
      foxes = foxes.filter((f) => !(f.fled && Math.hypot(f.x - center.x, f.y - center.y) > R + 0.1));

      const alive = sheep.filter((s) => !s.caught);
      if (alive.length === 0) {
        toast = { text: "The flock is gone!", color: "#ff6060", t: 2 };
        end();
      } else if (alive.every((s) => s.penned)) {
        const bonus = Math.round(timeLeft * 5) + (lost === 0 ? 200 : 0);
        score += bonus;
        toast = { text: `Flock home!  +${bonus}${lost === 0 ? " (no losses)" : ""}`, color: "#ffd84a", t: 2.2 };
        Lynx.sfx.play("levelup");
        state = "clear";
        stateTime = 0;
      }
    }

    function drawPen() {
      const corner = (u, v) => fromPen(u, v);
      const seg = (u0, v0, u1, v1, col) => {
        const n = Math.max(2, Math.round(Math.hypot(u1 - u0, v1 - v0) / 0.07));
        for (let i = 0; i <= n; i++) {
          const q = corner(lerp(u0, u1, i / n), lerp(v0, v1, i / n));
          ar.floorCircle(q.x, q.y, 0.018, col, "rgba(60,40,20,0.9)", 0);
        }
      };
      ar.floorCircle(pen.x, pen.y, PEN_HALF * 0.9, "rgba(90,200,90,0.18)", null);
      const wood = "#b48850";
      seg(-PEN_HALF, -PEN_HALF, PEN_HALF, -PEN_HALF, wood);
      seg(-PEN_HALF, PEN_HALF, PEN_HALF, PEN_HALF, wood);
      seg(PEN_HALF, -PEN_HALF, PEN_HALF, PEN_HALF, wood);
      seg(-PEN_HALF, -PEN_HALF, -PEN_HALF, -GAP_HALF, wood);
      seg(-PEN_HALF, GAP_HALF, -PEN_HALF, PEN_HALF, wood);
    }

    function drawAnimal(o, spr, hM, extra) {
      const rect = ar.spriteRect(spr, o.x, o.y, 0, hM);
      if (!rect) return;
      ar.queue(rect.depth, () => {
        ar.floorCircle(o.x, o.y, hM * 0.45, "rgba(0,0,0,0.25)");
        const bob = Math.abs(Math.sin(o.wob || 0)) * rect.h * 0.06;
        ar.drawSprite(spr, { ...rect, y: rect.y - bob }, { flip: o.dir < 0, ...(extra || {}) });
      });
    }

    function draw() {
      const v = ar.view;
      const ctx = ar.ctx;
      if (state !== "title") {
        ar.floorCircle(center.x, center.y, R, null, "rgba(120,220,120,0.4)");
        drawPen();
        rings.forEach((r) => {
          const k = r.t / 0.7;
          ar.floorCircle(r.x, r.y, 0.1 + k * BARK_R, null, `rgba(255,255,255,${0.7 * (1 - k)})`);
        });
        if (barkCd <= 0 && state === "playing") ar.floorCircle(ar.pose.x, ar.pose.y, FLEE_R, null, "rgba(255,255,255,0.12)");
        sheep.forEach((s) => !s.caught && drawAnimal(s, sprites.sheep, 0.07));
        foxes.forEach((f) => drawAnimal(f, sprites.fox, 0.07, f.stun > 0 ? { alpha: 0.5 } : null));
        // arrows to sheep that are off-screen
        sheep.forEach((s) => {
          if (s.caught || s.penned) return;
          const p = ar.project(s.x, s.y, 0.04);
          if (!p || !ar.onScreen(p, 10)) ar.edgeArrow(s.x, s.y, 0.04, "#ffffff");
        });
      }
      ar.flush();

      const hudY = v.y + v.h - 16;
      ar.text(`SCORE ${score}`, v.x + 16, hudY, { size: 20, color: "#90e090" });
      if (state !== "title") {
        const alive = sheep.filter((s) => !s.caught);
        ar.text(`LEVEL ${level}   penned ${alive.filter((s) => s.penned).length}/${alive.length}   ${Math.ceil(timeLeft)}s`, v.cx + 40, hudY, { size: 16, align: "center" });
        // bark cooldown
        const frac = 1 - clamp01(barkCd / BARK_COOLDOWN_S);
        ctx.fillStyle = frac >= 1 ? "#90e090" : "rgba(255,255,255,0.4)";
        ctx.fillRect(v.cx - 40, v.y + 20, 80 * frac, 4);
        ar.text(frac >= 1 ? "FIRE = bark" : "", v.cx, v.y + 40, { size: 12, align: "center", alpha: 0.8 });
      }
      if (toast) ar.text(toast.text, v.cx, v.y + v.h * 0.35, { size: 24, align: "center", color: toast.color, alpha: clamp01(toast.t * 2) });

      if (state === "title") {
        ar.flash("#000", 0.45);
        ar.banner("SHEPHERD", "Press FIRE to call the flock", { color: "#90e090" });
        ar.text("Sheep run from the robot · drive round behind them · herd them into the pen · foxes steal strays", v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
        if (best !== null) ar.text(`Best on this robot: ${best}`, v.cx, v.cy + v.h * 0.27, { size: 14, align: "center", color: "#90e090" });
      } else if (state === "over") {
        ar.flash("#000", 0.4);
        ar.banner(sheep.every((s) => s.caught) ? "NO SHEEP LEFT" : "TIME'S UP", `Score ${score} · level ${level}`);
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.18, { size: 16, align: "center", color: "#90e090" });
        if (stateTime > 1.5) ar.text("Press FIRE to play again", v.cx, v.cy + v.h * 0.25, { size: 14, align: "center" });
      }
    }

    ar.onFrame((now, dt) => {
      update(dt);
      draw();
    });
    return { actionLabel: "▶ Start" };
  };
})(window.Lynx);
