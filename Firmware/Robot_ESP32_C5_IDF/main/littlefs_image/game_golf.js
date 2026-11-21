// Mini Golf -- nine holes of crazy golf on your floor, and the robot is the
// putter. Each hole is laid out in front of the robot, from where it stands
// when the hole starts: a fairway with wooden rails, and on later holes
// bumpers, a bunker, a windmill's turning sails, a pond, a hill and a zigzag
// of walls. Drive up to your ball, turn the camera to aim (the dashed line
// shows where it goes), hold FIRE to swing -- the power meter swings up and
// down -- and let go to putt. The ball rolls with real-ish physics: it
// bounces off rails and bumpers, slows in sand, rolls back down the hill, and
// a ball in the pond costs a stroke and comes back to where it was hit. The
// robot is solid too: bump a resting ball and that counts as a stroke.
// Fewest strokes over the nine holes wins.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const BALL_R = 0.024; // (a touch bigger than a real golf ball, to see it from afar)
  const CUP_R = 0.055;
  const ROBOT_R = 0.11; // the robot as a solid disc around its pose
  const REACH = 0.42; // how near the ball the robot must be to putt
  const RAIL_H = 0.035;
  const ROLL = 0.32; // rolling friction (m/s^2) on the green
  const SAND = 2.4; // ... in the bunker
  const WALL_E = 0.72; // restitution of the rails
  const POST_E = 0.95; // ... of the bumpers (they kick a little, below)
  const SINK_SPEED = 0.95; // faster than this over the cup: it lips out
  const MAX_PUTT = 1.35; // m/s at full power (scale 1)
  const MIN_PUTT = 0.12;
  const SWING_PERIOD = 1.8; // s for the power meter to go up and down
  const NEAR = 0.05;
  const MAX_OVER_PAR = 4; // picked up at par + 4

  const clamp01 = (t) => Math.min(1, Math.max(0, t));
  const lerp = (a, b, t) => a + (b - a) * t;

  // The holes, in the robot's frame at the start of the hole: f metres
  // ahead, l metres to the left. The tee is a little ahead of the robot.
  // border: the rails all round (closed polygon); walls: rails inside it;
  // posts: round bumpers {f, l, r}; sand / water: polygons; slopes: a polygon
  // with its downhill pull {af, al} (m/s^2); spinners: a turning bar {f, l,
  // len, w (rad/s), a0}.
  const rect = (f0, f1, l0, l1) => [[f0, l0], [f1, l0], [f1, l1], [f0, l1]];
  const HOLES = [
    {
      name: "First Putt", par: 2, tee: [0.3, 0], cup: [1.7, 0],
      border: rect(0, 2.0, -0.32, 0.32),
    },
    {
      name: "Dogleg", par: 3, tee: [0.3, 0], cup: [1.32, 0.95],
      border: [[0, -0.3], [1.6, -0.3], [1.6, 1.2], [1.05, 1.2], [1.05, 0.3], [0, 0.3]],
      posts: [{ f: 1.6, l: -0.3, r: 0.05 }],
    },
    {
      name: "Bumper Alley", par: 3, tee: [0.3, 0], cup: [2.0, 0],
      border: rect(0, 2.25, -0.4, 0.4),
      posts: [{ f: 0.95, l: 0, r: 0.05 }, { f: 1.35, l: -0.2, r: 0.05 }, { f: 1.35, l: 0.2, r: 0.05 }, { f: 1.75, l: 0, r: 0.05 }],
    },
    {
      name: "The Bunker", par: 3, tee: [0.3, 0.15], cup: [1.95, -0.15],
      border: rect(0, 2.2, -0.4, 0.4),
      sand: [[[1.0, -0.4], [1.5, -0.4], [1.55, -0.1], [1.45, 0.22], [1.05, 0.2], [0.95, -0.1]]],
    },
    {
      name: "Windmill", par: 3, tee: [0.3, 0], cup: [1.85, 0],
      border: rect(0, 2.15, -0.35, 0.35),
      walls: [[[1.3, -0.35], [1.3, -0.075]], [[1.3, 0.075], [1.3, 0.35]]],
      spinners: [{ f: 1.2, l: 0, len: 0.34, w: 1.4, a0: 0 }],
    },
    {
      name: "The Pond", par: 3, tee: [0.3, 0], cup: [2.05, -0.1],
      border: rect(0, 2.35, -0.4, 0.4),
      water: [rect(0.95, 1.4, -0.4, 0.08), rect(0.95, 1.4, 0.26, 0.4)],
    },
    {
      name: "The Hill", par: 3, tee: [0.3, 0], cup: [1.95, 0],
      border: rect(0, 2.2, -0.35, 0.35),
      slopes: [{ poly: rect(0.85, 1.65, -0.35, 0.35), af: -0.55, al: 0 }],
    },
    {
      name: "Bank Shot", par: 3, tee: [0.3, -0.25], cup: [1.65, 0.1],
      border: rect(0, 1.9, -0.45, 0.45),
      walls: [[[0.85, -0.45], [0.85, 0.22]], [[1.3, -0.22], [1.3, 0.45]]],
      posts: [{ f: 1.07, l: 0.4, r: 0.045 }],
    },
    {
      name: "The Gauntlet", par: 4, tee: [0.3, 0], cup: [2.3, 0.12],
      border: rect(0, 2.55, -0.4, 0.4),
      slopes: [{ poly: rect(0.6, 1.15, -0.4, 0.4), af: 0, al: 0.45 }],
      spinners: [{ f: 1.6, l: 0.19, len: 0.36, w: 1.6, a0: 0 }, { f: 1.6, l: -0.19, len: 0.36, w: -1.6, a0: 0.8 }],
      water: [[[2.0, -0.4], [2.45, -0.4], [2.45, -0.12], [2.1, -0.05]]],
      posts: [{ f: 2.3, l: 0.38, r: 0.04 }],
    },
  ];
  const PAR_TOTAL = HOLES.reduce((s, h) => s + h.par, 0);

  const RESULT_NAMES = { "-3": "Albatross!", "-2": "Eagle!", "-1": "Birdie!", 0: "Par", 1: "Bogey", 2: "Double bogey", 3: "Triple bogey" };
  const resultName = (strokes, par) => (strokes === 1 ? "Hole in one!" : RESULT_NAMES[strokes - par] || `${strokes - par > 0 ? "+" : ""}${strokes - par}`);
  const overPar = (n) => (n === 0 ? "E" : n > 0 ? `+${n}` : `${n}`);

  function inPoly(x, y, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function closestOnSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t = l2 > 0 ? clamp01(((px - ax) * dx + (py - ay) * dy) / l2) : 0;
    return [ax + dx * t, ay + dy * t];
  }

  Lynx.games.golf = (ar, cfg) => {
    const S = Math.min(1.5, Math.max(0.6, cfg.scale || 1));
    const nHoles = Math.min(HOLES.length, Math.max(1, Math.round(cfg.holes || HOLES.length)));
    let state = "title"; // title | tee | play | sunk | done
    let stateTime = 0;
    let clock = 0;
    let holeIx = 0;
    let course = null; // the current hole in world coordinates
    let ball = { x: 0, y: 0, vx: 0, vy: 0, moving: false, z: 0 };
    let lie = { x: 0, y: 0 }; // where the ball was last hit from (the pond sends it back here)
    let strokes = 0;
    let card = []; // strokes per hole played
    let swing = null; // {t}: FIRE held at the ball
    let robotV = { x: 0, y: 0 };
    let lastPose = null;
    let toast = null;
    let splashes = [];
    let sinkAnim = 0;
    let lipped = false;
    let best = null;
    let rankMsg = "";
    let pickedUp = false;
    Lynx.bestScore("golf").then((b) => (best = b));

    function say(text, color = "#ffffff", t = 1.6) {
      toast = { text, color, t };
    }

    // -- the hole in the world ----------------------------------------------------
    function layout(hole) {
      const p = ar.pose;
      const c = Math.cos(p.theta);
      const s = Math.sin(p.theta);
      const W = ([f, l]) => [p.x + S * (f * c - l * s), p.y + S * (f * s + l * c)];
      const segsOf = (pts, closed) => {
        const out = [];
        for (let i = 0; i < pts.length - (closed ? 0 : 1); i++) out.push([pts[i], pts[(i + 1) % pts.length]]);
        return out;
      };
      const border = hole.border.map(W);
      const walls = segsOf(border, true);
      (hole.walls || []).forEach((w) => walls.push(...segsOf(w.map(W), false)));
      return {
        hole,
        frame: { x: p.x, y: p.y, c, s },
        fwd: [c, s],
        left: [-s, c],
        tee: W(hole.tee),
        cup: W(hole.cup),
        border,
        walls,
        posts: (hole.posts || []).map((o) => {
          const [x, y] = W([o.f, o.l]);
          return { x, y, r: o.r * S, flash: 0 };
        }),
        sand: (hole.sand || []).map((poly) => poly.map(W)),
        water: (hole.water || []).map((poly) => poly.map(W)),
        slopes: (hole.slopes || []).map((sl) => ({
          poly: sl.poly.map(W),
          ax: sl.af * c - sl.al * s,
          ay: sl.af * s + sl.al * c,
        })),
        spinners: (hole.spinners || []).map((sp) => {
          const [x, y] = W([sp.f, sp.l]);
          return { x, y, len: sp.len * S, w: sp.w, a: sp.a0 + p.theta };
        }),
        speckles: [],
      };
    }

    function startHole() {
      course = layout(HOLES[holeIx]);
      // bunker speckles, fixed per hole
      course.sand.forEach((poly) => {
        const xs = poly.map((q) => q[0]);
        const ys = poly.map((q) => q[1]);
        for (let i = 0; i < 90; i++) {
          const x = lerp(Math.min(...xs), Math.max(...xs), Math.random());
          const y = lerp(Math.min(...ys), Math.max(...ys), Math.random());
          if (inPoly(x, y, poly)) course.speckles.push([x, y]);
        }
      });
      ball = { x: course.tee[0], y: course.tee[1], vx: 0, vy: 0, moving: false, z: 0 };
      lie = { x: ball.x, y: ball.y };
      strokes = 0;
      swing = null;
      sinkAnim = 0;
      lipped = false;
      pickedUp = false;
      state = "tee";
      stateTime = 0;
      Lynx.sfx.play("go");
    }

    function newGame() {
      holeIx = 0;
      card = [];
      rankMsg = "";
      startHole();
    }

    function holeDone(picked) {
      card[holeIx] = strokes;
      pickedUp = picked;
      state = "sunk";
      stateTime = 0;
      swing = null;
      if (picked) {
        say("Picked up", "#ffb060", 2);
        Lynx.sfx.play("fail");
        return;
      }
      const d = strokes - course.hole.par;
      say(resultName(strokes, course.hole.par), d < 0 ? "#ffd84a" : d === 0 ? "#80ff9a" : "#ffffff", 2.4);
      Lynx.sfx.play(d < 0 ? "levelup" : "found");
    }

    function finishRound() {
      state = "done";
      stateTime = 0;
      const total = card.reduce((a, b) => a + b, 0);
      // (the scoreboard: the full course at the normal size only)
      if (nHoles === HOLES.length) {
        Lynx.submitScore("golf", total).then((rank) => {
          rankMsg = rank ? `#${rank} on the robot's scoreboard!` : "";
          if (rank === 1) best = total;
        });
      }
      Lynx.sfx.play("levelup");
    }

    const atBall = () => Math.hypot(ball.x - ar.pose.x, ball.y - ar.pose.y) < REACH * Math.max(1, S);
    // where a putt goes: the camera's heading, flat on the floor
    function aimDir() {
      const a = ar.aimVector();
      const n = Math.hypot(a.x, a.y);
      if (n < 1e-6) return [Math.cos(ar.camTheta), Math.sin(ar.camTheta)];
      return [a.x / n, a.y / n];
    }
    const swingPower = (t) => {
      const u = (t / SWING_PERIOD) % 1;
      return u < 0.5 ? u * 2 : 2 - u * 2; // up and down
    };

    function putt(power) {
      const [dx, dy] = aimDir();
      const v = (MIN_PUTT + (MAX_PUTT - MIN_PUTT) * power * power) * Math.sqrt(S);
      lie = { x: ball.x, y: ball.y };
      ball.vx = dx * v;
      ball.vy = dy * v;
      ball.moving = true;
      lipped = false;
      strokes++;
      Lynx.sfx.play("knock");
    }

    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title" || (state === "done" && stateTime > 2)) {
        newGame();
        return;
      }
      if (state === "sunk" && stateTime > 1.2) {
        holeIx++;
        if (holeIx >= nHoles) finishRound();
        else startHole();
        return;
      }
      if (state === "tee") {
        state = "play";
        stateTime = 0;
      }
      if (state !== "play" || ball.moving) return;
      if (!atBall()) {
        say("Drive up to your ball first", "#ffffff", 1.4);
        return;
      }
      swing = { t: 0 };
      Lynx.sfx.play("tick");
    });

    // -- physics ------------------------------------------------------------------
    function bounce(nx, ny, sx, sy, e) {
      const rvx = ball.vx - sx;
      const rvy = ball.vy - sy;
      const vn = rvx * nx + rvy * ny;
      if (vn >= 0) return 0;
      ball.vx -= (1 + e) * vn * nx;
      ball.vy -= (1 + e) * vn * ny;
      return -vn;
    }

    function collide(px, py) {
      let hit = 0;
      const R = BALL_R;
      for (const [a, b] of course.walls) {
        const [cx, cy] = closestOnSeg(ball.x, ball.y, a[0], a[1], b[0], b[1]);
        const d = Math.hypot(ball.x - cx, ball.y - cy);
        if (d < R && d > 1e-9) {
          const nx = (ball.x - cx) / d;
          const ny = (ball.y - cy) / d;
          ball.x = cx + nx * R;
          ball.y = cy + ny * R;
          hit = Math.max(hit, bounce(nx, ny, 0, 0, WALL_E));
        }
      }
      for (const o of course.posts) {
        const d = Math.hypot(ball.x - o.x, ball.y - o.y);
        if (d < R + o.r && d > 1e-9) {
          const nx = (ball.x - o.x) / d;
          const ny = (ball.y - o.y) / d;
          ball.x = o.x + nx * (R + o.r);
          ball.y = o.y + ny * (R + o.r);
          const vn = bounce(nx, ny, 0, 0, POST_E);
          if (vn > 0.05) {
            // the bumper kicks
            ball.vx += nx * 0.12;
            ball.vy += ny * 0.12;
            o.flash = 1;
            Lynx.sfx.play("boing");
          }
        }
      }
      for (const sp of course.spinners) {
        const hx = Math.cos(sp.a) * sp.len;
        const hy = Math.sin(sp.a) * sp.len;
        const [cx, cy] = closestOnSeg(ball.x, ball.y, sp.x - hx, sp.y - hy, sp.x + hx, sp.y + hy);
        const d = Math.hypot(ball.x - cx, ball.y - cy);
        const th = 0.012;
        if (d < R + th && d > 1e-9) {
          const nx = (ball.x - cx) / d;
          const ny = (ball.y - cy) / d;
          ball.x = cx + nx * (R + th);
          ball.y = cy + ny * (R + th);
          // the sail's own speed where it touches
          const sx = -sp.w * (cy - sp.y);
          const sy = sp.w * (cx - sp.x);
          const vs = bounce(nx, ny, sx, sy, 0.6);
          hit = Math.max(hit, vs);
          if (vs > 0) ball.moving = true;
        }
        // the hub
        const dh = Math.hypot(ball.x - sp.x, ball.y - sp.y);
        if (dh < R + 0.025 && dh > 1e-9) {
          const nx = (ball.x - sp.x) / dh;
          const ny = (ball.y - sp.y) / dh;
          ball.x = sp.x + nx * (R + 0.025);
          ball.y = sp.y + ny * (R + 0.025);
          bounce(nx, ny, 0, 0, 0.6);
        }
      }
      // the robot (solid): a resting ball it bumps is a stroke
      const dr = Math.hypot(ball.x - ar.pose.x, ball.y - ar.pose.y);
      if (dr < R + ROBOT_R && dr > 1e-9) {
        const nx = (ball.x - ar.pose.x) / dr;
        const ny = (ball.y - ar.pose.y) / dr;
        ball.x = ar.pose.x + nx * (R + ROBOT_R);
        ball.y = ar.pose.y + ny * (R + ROBOT_R);
        const wasResting = !ball.moving;
        const vn = bounce(nx, ny, robotV.x, robotV.y, 0.5);
        if (vn > 0.03) {
          ball.moving = true;
          if (wasResting && state === "play") {
            lie = { x: px, y: py };
            strokes++;
            swing = null;
            say("Bumped it -- that's a stroke", "#ffb060", 1.6);
            Lynx.sfx.play("knock");
          }
        }
      }
      // (never through a rail: if the ball got out anyway, back where it was)
      if (!inPoly(ball.x, ball.y, course.border) && inPoly(px, py, course.border)) {
        ball.x = px;
        ball.y = py;
        ball.vx *= -0.5;
        ball.vy *= -0.5;
      }
      if (hit > 0.08) Lynx.sfx.play("clang");
    }

    function stepBall(dt) {
      // slopes pull, sand and grass slow it
      let ax = 0;
      let ay = 0;
      for (const sl of course.slopes) {
        if (inPoly(ball.x, ball.y, sl.poly)) {
          ax += sl.ax;
          ay += sl.ay;
        }
      }
      const inSand = course.sand.some((p) => inPoly(ball.x, ball.y, p));
      if (ax || ay) ball.moving = true;
      if (!ball.moving) {
        // (a resting ball can still be swept by a sail or bumped by the robot)
        collide(ball.x, ball.y);
        if (!ball.moving) return;
      }
      ball.vx += ax * dt;
      ball.vy += ay * dt;
      const fr = (inSand ? SAND : ROLL) * dt;
      const sp2 = Math.hypot(ball.vx, ball.vy);
      if (sp2 <= fr) {
        ball.vx = 0;
        ball.vy = 0;
      } else {
        ball.vx -= (ball.vx / sp2) * fr;
        ball.vy -= (ball.vy / sp2) * fr;
      }
      const px = ball.x;
      const py = ball.y;
      ball.x += ball.vx * dt;
      ball.y += ball.vy * dt;
      collide(px, py);

      // the cup: a slow ball drops in, a fast one lips out (once per pass)
      const dc = Math.hypot(ball.x - course.cup[0], ball.y - course.cup[1]);
      const v = Math.hypot(ball.vx, ball.vy);
      if (dc < CUP_R) {
        if (v < SINK_SPEED) {
          ball.moving = false;
          ball.vx = ball.vy = 0;
          sinkAnim = 0.001;
          Lynx.sfx.play("coin");
          holeDone(false);
          return;
        }
        if (!lipped) {
          lipped = true;
          const a = (Math.random() - 0.5) * 0.9;
          const c = Math.cos(a);
          const s = Math.sin(a);
          [ball.vx, ball.vy] = [(ball.vx * c - ball.vy * s) * 0.75, (ball.vx * s + ball.vy * c) * 0.75];
          say("Lipped out!", "#ffb060", 1.2);
          Lynx.sfx.play("twang");
        }
      } else if (dc < CUP_R * 1.5 && v < 0.3) {
        // the cup's edge draws a slow ball in
        ball.vx += ((course.cup[0] - ball.x) / dc) * 0.4 * dt;
        ball.vy += ((course.cup[1] - ball.y) / dc) * 0.4 * dt;
      } else if (dc > CUP_R * 1.5) lipped = false;

      // the pond
      if (course.water.some((p) => inPoly(ball.x, ball.y, p))) {
        splashes.push({ x: ball.x, y: ball.y, t: 0 });
        Lynx.sfx.play("squirt");
        strokes++;
        say("Splash! +1 stroke", "#60c0ff", 1.8);
        ball.x = lie.x;
        ball.y = lie.y;
        ball.vx = ball.vy = 0;
        ball.moving = false;
        return;
      }
      if (Math.hypot(ball.vx, ball.vy) < 0.004 && !ax && !ay) {
        ball.vx = ball.vy = 0;
        ball.moving = false;
      }
    }

    function update(dt) {
      stateTime += dt;
      clock += dt;
      if (toast && (toast.t -= dt) <= 0) toast = null;
      splashes.forEach((s) => (s.t += dt));
      splashes = splashes.filter((s) => s.t < 1.2);
      // the robot's own speed (for bumping the ball)
      const p = ar.pose;
      if (lastPose && dt > 0) {
        robotV.x = lerp(robotV.x, (p.x - lastPose.x) / dt, 0.35);
        robotV.y = lerp(robotV.y, (p.y - lastPose.y) / dt, 0.35);
      }
      lastPose = { x: p.x, y: p.y };
      if (!course) return;
      course.spinners.forEach((sp) => (sp.a += sp.w * dt));
      course.posts.forEach((o) => (o.flash = Math.max(0, o.flash - dt * 3)));
      if (sinkAnim > 0) sinkAnim = Math.min(1, sinkAnim + dt * 3);
      if (state === "tee" && stateTime > 2.2) {
        state = "play";
        stateTime = 0;
      }
      if (state !== "play" && state !== "tee") return;

      if (swing) {
        if (!atBall() || ball.moving) swing = null;
        else if (!Lynx.input.fireHeld) {
          putt(swingPower(swing.t));
          swing = null;
        } else swing.t += dt;
      }
      const n = Math.min(40, Math.ceil((Math.hypot(ball.vx, ball.vy) * dt) / 0.006) + 1);
      for (let i = 0; i < n && state === "play"; i++) stepBall(dt / n);
      if (state === "play" && !ball.moving && strokes >= course.hole.par + MAX_OVER_PAR) {
        strokes = course.hole.par + MAX_OVER_PAR;
        holeDone(true);
      }
    }

    // -- drawing --------------------------------------------------------------------
    // Polygons in the world ([x, y, h] corners) onto the screen, clipped at
    // the lens (a fairway reaches behind the camera).
    function screenPoly(pts3) {
      const v = ar.view;
      const cam = pts3.map(([x, y, h]) => ar.camPoint(x, y, h));
      const out = [];
      for (let i = 0; i < cam.length; i++) {
        const a = cam[i];
        const b = cam[(i + 1) % cam.length];
        if (a[2] >= NEAR) out.push(a);
        if (a[2] >= NEAR !== b[2] >= NEAR) {
          const t = (NEAR - a[2]) / (b[2] - a[2]);
          out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, NEAR]);
        }
      }
      return out.map(([x, y, z]) => ({ x: v.cx + ((v.f * x) / z) * v.scale, y: v.cy + ((v.f * y) / z) * v.scale }));
    }
    function pathPoly(ctx, pts2, h = 0) {
      const s = screenPoly(pts2.map(([x, y]) => [x, y, h]));
      if (s.length < 3) return false;
      ctx.beginPath();
      s.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      return true;
    }
    function fillPoly(pts2, fill, stroke, lw = 1.5) {
      const ctx = ar.ctx;
      if (!pathPoly(ctx, pts2)) return;
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.lineWidth = lw;
        ctx.strokeStyle = stroke;
        ctx.stroke();
      }
    }
    // A thin upright slab from a to b (h0..h1), queued by depth.
    function slab(a, b, h0, h1, side, top) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const n = Math.max(1, Math.ceil(len / 0.12));
      for (let i = 0; i < n; i++) {
        const p0 = [lerp(a[0], b[0], i / n), lerp(a[1], b[1], i / n)];
        const p1 = [lerp(a[0], b[0], (i + 1) / n), lerp(a[1], b[1], (i + 1) / n)];
        const mid = ar.project((p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2, (h0 + h1) / 2);
        if (!mid) continue;
        ar.queue(mid.depth, () => {
          const ctx = ar.ctx;
          const s = screenPoly([[p0[0], p0[1], h0], [p1[0], p1[1], h0], [p1[0], p1[1], h1], [p0[0], p0[1], h1]]);
          if (s.length < 3) return;
          ctx.beginPath();
          s.forEach((p, k) => (k ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
          ctx.closePath();
          ctx.fillStyle = side;
          ctx.fill();
          const t0 = ar.project(p0[0], p0[1], h1);
          const t1 = ar.project(p1[0], p1[1], h1);
          if (t0 && t1) {
            ctx.strokeStyle = top;
            ctx.lineWidth = Math.max(1.5, Math.min(6, 0.012 * (t0.ppm + t1.ppm) / 2));
            ctx.lineCap = "round";
            ctx.beginPath();
            ctx.moveTo(t0.x, t0.y);
            ctx.lineTo(t1.x, t1.y);
            ctx.stroke();
          }
        });
      }
    }
    function cylinder(x, y, r, h, side, topFill) {
      const mid = ar.project(x, y, h / 2);
      if (!mid) return;
      ar.queue(mid.depth, () => {
        const ctx = ar.ctx;
        const b = ar.project(x, y, 0);
        const t = ar.project(x, y, h);
        if (!b || !t) return;
        const w = r * mid.ppm;
        ctx.fillStyle = side;
        ctx.fillRect(Math.min(b.x, t.x) - w, t.y, w * 2, Math.max(1, b.y - t.y));
        ar.floorCircle(x, y, r, side, null, 0);
        ar.floorCircle(x, y, r, topFill, "rgba(0,0,0,0.35)", h);
      });
    }

    function drawCourse(ctx) {
      const c = course;
      // the green, with mown stripes across it
      fillPoly(c.border, "rgba(46,160,78,0.62)");
      ctx.save();
      if (pathPoly(ctx, c.border)) {
        ctx.clip();
        const [fx, fy] = c.fwd;
        const [lx, ly] = c.left;
        const o = c.frame;
        for (let k = 0; k < 14; k += 2) {
          const f0 = k * 0.2 * S;
          const f1 = f0 + 0.2 * S;
          const P = (f, l) => [o.x + f * fx + l * lx, o.y + f * fy + l * ly];
          fillPoly([P(f0, -2 * S), P(f1, -2 * S), P(f1, 2 * S), P(f0, 2 * S)], "rgba(120,220,120,0.14)");
        }
        // slopes: lighter, with chevrons rolling downhill
        c.slopes.forEach((sl) => {
          fillPoly(sl.poly, "rgba(170,210,90,0.35)");
          ctx.save();
          if (pathPoly(ctx, sl.poly)) {
            ctx.clip();
            const g = Math.hypot(sl.ax, sl.ay);
            const ux = sl.ax / g;
            const uy = sl.ay / g;
            const xs = sl.poly.map((q) => q[0]);
            const ys = sl.poly.map((q) => q[1]);
            const mx = (Math.min(...xs) + Math.max(...xs)) / 2;
            const my = (Math.min(...ys) + Math.max(...ys)) / 2;
            const span = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
            const off = ((clock * 0.12) % 0.16);
            for (let d = -span; d <= span; d += 0.16) {
              for (let w = -span; w <= span; w += 0.2) {
                const cx = mx + ux * (d + off) - uy * w;
                const cy = my + uy * (d + off) + ux * w;
                const tip = [cx + ux * 0.04, cy + uy * 0.04];
                const l = [cx - uy * 0.045, cy + ux * 0.045];
                const r = [cx + uy * 0.045, cy - ux * 0.045];
                const sTip = ar.project(tip[0], tip[1], 0);
                const sL = ar.project(l[0], l[1], 0);
                const sR = ar.project(r[0], r[1], 0);
                if (!sTip || !sL || !sR) continue;
                ctx.strokeStyle = "rgba(255,255,220,0.45)";
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(sL.x, sL.y);
                ctx.lineTo(sTip.x, sTip.y);
                ctx.lineTo(sR.x, sR.y);
                ctx.stroke();
              }
            }
          }
          ctx.restore();
        });
      }
      ctx.restore();
      // bunkers
      c.sand.forEach((poly) => fillPoly(poly, "rgba(232,205,140,0.92)", "rgba(190,160,100,0.9)", 2));
      ctx.fillStyle = "rgba(170,140,80,0.7)";
      c.speckles.forEach(([x, y]) => {
        const p = ar.project(x, y, 0);
        if (p) ctx.fillRect(p.x, p.y, 2, 2);
      });
      // ponds, with rings rippling out
      c.water.forEach((poly, wi) => {
        fillPoly(poly, "rgba(40,120,220,0.85)", "rgba(150,210,255,0.9)", 2);
        ctx.save();
        if (pathPoly(ctx, poly)) {
          ctx.clip();
          const xs = poly.map((q) => q[0]);
          const ys = poly.map((q) => q[1]);
          for (let i = 0; i < 4; i++) {
            const ph = (clock * 0.35 + i * 0.25 + wi * 0.13) % 1;
            const x = lerp(Math.min(...xs), Math.max(...xs), (Math.sin(i * 12.9 + wi * 3.1) + 1) / 2);
            const y = lerp(Math.min(...ys), Math.max(...ys), (Math.sin(i * 78.2 + wi * 1.7) + 1) / 2);
            ctx.lineWidth = 1.5;
            ar.floorCircle(x, y, 0.02 + ph * 0.12, null, `rgba(220,240,255,${0.6 * (1 - ph)})`);
          }
        }
        ctx.restore();
      });
      // the tee mat
      const T = c.tee;
      const [fx, fy] = c.fwd;
      const [lx, ly] = c.left;
      const m = 0.07 * S;
      fillPoly([[T[0] - m * fx - m * lx, T[1] - m * fy - m * ly], [T[0] + m * fx - m * lx, T[1] + m * fy - m * ly], [T[0] + m * fx + m * lx, T[1] + m * fy + m * ly], [T[0] - m * fx + m * lx, T[1] - m * fy + m * ly]], "rgba(30,90,50,0.7)", "rgba(255,255,255,0.5)");
      // the cup
      ar.floorCircle(c.cup[0], c.cup[1], CUP_R + 0.008, "rgba(255,255,255,0.9)");
      ar.floorCircle(c.cup[0], c.cup[1], CUP_R, "rgba(10,20,10,0.95)");
    }

    function drawSolids() {
      const c = course;
      const WOOD = "rgba(150,96,52,0.95)";
      const WOOD_TOP = "rgba(232,184,120,1)";
      c.walls.forEach(([a, b]) => slab(a, b, 0, RAIL_H, WOOD, WOOD_TOP));
      c.posts.forEach((o) => cylinder(o.x, o.y, o.r, 0.05, o.flash > 0 ? `rgba(255,${Math.round(120 + 135 * o.flash)},120,1)` : "rgba(220,60,70,1)", o.flash > 0 ? "#fff6c0" : "rgba(255,140,140,1)"));
      // windmill sails: a turning bar on a hub
      c.spinners.forEach((sp) => {
        const hx = Math.cos(sp.a) * sp.len;
        const hy = Math.sin(sp.a) * sp.len;
        slab([sp.x - hx, sp.y - hy], [sp.x, sp.y], 0.005, 0.05, "rgba(240,240,250,0.92)", "rgba(200,60,60,1)");
        slab([sp.x, sp.y], [sp.x + hx, sp.y + hy], 0.005, 0.05, "rgba(240,240,250,0.92)", "rgba(60,90,200,1)");
        cylinder(sp.x, sp.y, 0.025, 0.08, "rgba(120,80,60,1)", "rgba(250,210,80,1)");
      });
      // the flag (lifted out while the ball rolls up close)
      const near = Math.hypot(ball.x - c.cup[0], ball.y - c.cup[1]) < 0.25 * S && ball.moving;
      const poleH = near ? 0 : 0.26;
      if (poleH > 0) {
        const pb = ar.project(c.cup[0], c.cup[1], 0);
        if (pb) {
          ar.queue(pb.depth - 0.001, () => {
            const ctx = ar.ctx;
            const b = ar.project(c.cup[0], c.cup[1], 0);
            const t = ar.project(c.cup[0], c.cup[1], poleH);
            if (!b || !t) return;
            ctx.strokeStyle = "#f4f4f4";
            ctx.lineWidth = Math.max(1.5, 0.006 * b.ppm);
            ctx.beginPath();
            ctx.moveTo(b.x, b.y);
            ctx.lineTo(t.x, t.y);
            ctx.stroke();
            // a waving pennant, toward the camera's right
            const w = 0.1 * t.ppm;
            const hgt = 0.06 * t.ppm;
            ctx.fillStyle = "#ff3040";
            ctx.beginPath();
            ctx.moveTo(t.x, t.y);
            for (let i = 1; i <= 6; i++) {
              const u = i / 6;
              ctx.lineTo(t.x + w * u, t.y + hgt * 0.5 * u + Math.sin(clock * 6 - u * 4) * hgt * 0.12 * u);
            }
            ctx.lineTo(t.x, t.y + hgt);
            ctx.closePath();
            ctx.fill();
          });
        }
      }
      // the ball, and its shadow
      if (sinkAnim < 1) {
        const z = -BALL_R * 2 * sinkAnim;
        const p = ar.project(ball.x, ball.y, BALL_R + z);
        if (p) {
          ar.queue(p.depth, () => {
            const ctx = ar.ctx;
            if (sinkAnim === 0) ar.floorCircle(ball.x + 0.006, ball.y - 0.004, BALL_R * 0.9, "rgba(0,0,0,0.35)");
            const r = Math.max(2.5, BALL_R * p.ppm);
            const g = ctx.createRadialGradient(p.x - r * 0.35, p.y - r * 0.4, r * 0.1, p.x, p.y, r);
            g.addColorStop(0, "#ffffff");
            g.addColorStop(0.7, "#e8ecf0");
            g.addColorStop(1, "#9aa4ae");
            ctx.globalAlpha = 1 - sinkAnim;
            ctx.fillStyle = g;
            ctx.beginPath();
            ctx.arc(p.x, p.y, r, 0, 2 * Math.PI);
            ctx.fill();
            ctx.globalAlpha = 1;
          });
        }
      }
    }

    function drawAim(ctx) {
      if (state !== "play" || ball.moving || !atBall()) return;
      const [dx, dy] = aimDir();
      const pw = swing ? swingPower(swing.t) : 0.35;
      const len = (0.18 + 0.9 * pw * pw) * S;
      ctx.save();
      ctx.setLineDash([8, 7]);
      ctx.lineDashOffset = -clock * 30;
      ctx.lineWidth = 3;
      ctx.strokeStyle = swing ? "rgba(255,230,90,0.95)" : "rgba(255,255,255,0.8)";
      const a = ar.project(ball.x, ball.y, 0.002);
      const b = ar.project(ball.x + dx * len, ball.y + dy * len, 0.002);
      if (a && b) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      ctx.restore();
      ar.floorCircle(ball.x, ball.y, BALL_R * 2.2, null, "rgba(255,255,255,0.7)");
    }

    function draw() {
      const v = ar.view;
      const ctx = ar.ctx;
      if (course && state !== "title" && state !== "done") {
        drawCourse(ctx);
        splashes.forEach((s) => {
          const k = s.t / 1.2;
          ctx.lineWidth = 2;
          ar.floorCircle(s.x, s.y, 0.03 + 0.15 * k, null, `rgba(200,235,255,${1 - k})`);
          ar.floorCircle(s.x, s.y, 0.015 + 0.08 * k, null, `rgba(255,255,255,${1 - k})`);
        });
        drawAim(ctx);
        drawSolids();
      }
      ar.flush();

      const hudY = v.y + v.h - 16;
      if (course && (state === "play" || state === "tee" || state === "sunk")) {
        const hole = course.hole;
        const played = card.reduce((a, b) => a + b, 0) + (state === "sunk" ? 0 : strokes);
        const parSoFar = HOLES.slice(0, holeIx + (state === "sunk" ? 1 : 0)).reduce((s, h) => s + h.par, 0);
        ar.text(`HOLE ${holeIx + 1}/${nHoles}  ·  PAR ${hole.par}  ·  STROKES ${strokes}`, v.x + 16, hudY - 28, { size: 15, color: "#c8ffcf" });
        const round = holeIx > 0 || state === "sunk" ? `  (${overPar(card.reduce((a, b) => a + b, 0) - parSoFar)})` : "";
        ar.text(`TOTAL ${played}${round}`, v.x + 16, hudY, { size: 20, color: "#c8ffcf" });
        if (state === "play") {
          if (!ball.moving) {
            ar.edgeArrow(ball.x, ball.y, BALL_R, "#ffffff");
            if (!atBall()) ar.text("Drive up to your ball", v.cx, v.y + v.h - 46, { size: 14, align: "center", alpha: 0.9 });
            else if (!swing) ar.text("Turn to aim · hold FIRE to swing, let go to putt", v.cx, v.y + v.h - 46, { size: 14, align: "center", alpha: 0.9 });
          }
          ar.edgeArrow(course.cup[0], course.cup[1], 0.1, "#ff3040");
          if (cfg.radar) {
            ar.radar([
              { x: course.cup[0], y: course.cup[1], color: "#ff3040", r: 4 },
              { x: ball.x, y: ball.y, color: "#ffffff", r: 3 },
            ], 2.5 * S);
          }
        }
        if (swing) {
          // the power meter
          const pw = swingPower(swing.t);
          const w = Math.min(240, v.w * 0.5);
          const x0 = v.cx - w / 2;
          const y0 = v.y + v.h - 70;
          ctx.fillStyle = "rgba(0,0,0,0.55)";
          ctx.fillRect(x0 - 3, y0 - 3, w + 6, 18);
          const grad = ctx.createLinearGradient(x0, 0, x0 + w, 0);
          grad.addColorStop(0, "#60e070");
          grad.addColorStop(0.6, "#ffe060");
          grad.addColorStop(1, "#ff4040");
          ctx.fillStyle = grad;
          ctx.fillRect(x0, y0, w * pw, 12);
          ar.text("POWER", v.cx, y0 - 8, { size: 12, align: "center" });
        }
      }
      if (toast) ar.text(toast.text, v.cx, v.y + v.h * 0.33, { size: 26, align: "center", color: toast.color, alpha: clamp01(toast.t * 2) });

      if (state === "title") {
        ar.flash("#000", 0.45);
        ar.banner("MINI GOLF", "Press FIRE to lay out the first hole", { color: "#80ff9a" });
        ar.text("The robot is the putter · drive to the ball · turn to aim · hold FIRE, let go to putt", v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
        ar.text(`${nHoles} holes · par ${HOLES.slice(0, nHoles).reduce((s, h) => s + h.par, 0)} · each hole appears ahead of the robot (about ${(0.9 * S).toFixed(1)} x ${(2.6 * S).toFixed(1)} m)`, v.cx, v.cy + v.h * 0.26, { size: 12, align: "center", alpha: 0.85 });
        if (best !== null) ar.text(`Best on this robot: ${best} strokes`, v.cx, v.cy + v.h * 0.32, { size: 14, align: "center", color: "#80ff9a" });
      } else if (state === "tee") {
        ar.banner(`HOLE ${holeIx + 1}`, `${course.hole.name} · par ${course.hole.par}`, { color: "#80ff9a", alpha: clamp01(2.2 - stateTime) });
      } else if (state === "sunk") {
        ar.flash("#000", 0.25);
        const d = strokes - course.hole.par;
        ar.banner(pickedUp ? "PICKED UP" : resultName(strokes, course.hole.par).toUpperCase(), strokes === 1 ? `1 stroke · par ${course.hole.par}` : `${strokes} strokes · par ${course.hole.par}`, { color: d < 0 ? "#ffd84a" : "#80ff9a" });
        if (stateTime > 1.2) ar.text(holeIx + 1 < nHoles ? "Face open floor, then press FIRE for the next hole" : "Press FIRE for your scorecard", v.cx, v.cy + v.h * 0.22, { size: 14, align: "center" });
      } else if (state === "done") {
        ar.flash("#000", 0.55);
        const total = card.reduce((a, b) => a + b, 0);
        const par = HOLES.slice(0, nHoles).reduce((s, h) => s + h.par, 0);
        ar.banner("ROUND OVER", `${total} strokes · ${overPar(total - par)}`, { color: "#80ff9a" });
        // the scorecard
        const cw = Math.min(34, (v.w - 60) / (nHoles + 1));
        const x0 = v.cx - (cw * (nHoles + 1)) / 2;
        const y0 = v.cy + v.h * 0.14;
        ar.text("Hole", x0, y0, { size: 11, color: "#a0c8a8" });
        ar.text("Par", x0, y0 + 18, { size: 11, color: "#a0c8a8" });
        ar.text("You", x0, y0 + 36, { size: 11, color: "#a0c8a8" });
        for (let i = 0; i < nHoles; i++) {
          const x = x0 + cw * (i + 1.5);
          const d = card[i] - HOLES[i].par;
          ar.text(String(i + 1), x, y0, { size: 11, align: "center", color: "#a0c8a8" });
          ar.text(String(HOLES[i].par), x, y0 + 18, { size: 12, align: "center" });
          ar.text(String(card[i]), x, y0 + 36, { size: 13, align: "center", color: d < 0 ? "#ffd84a" : d === 0 ? "#80ff9a" : "#ffffff" });
        }
        if (rankMsg) ar.text(rankMsg, v.cx, y0 + 64, { size: 16, align: "center", color: "#80ff9a" });
        if (stateTime > 2) ar.text("Press FIRE to play again", v.cx, y0 + 88, { size: 14, align: "center" });
      }
    }

    ar.onFrame((now, dt) => {
      update(Math.min(dt, 0.1));
      draw();
    });
    return {
      actionLabel: "⛳ Putt",
      snapshot: () => ({
        state, hole: holeIx + 1, strokes, card: card.slice(),
        ball: { x: +ball.x.toFixed(3), y: +ball.y.toFixed(3), moving: ball.moving },
        cup: course && course.cup.map((q) => +q.toFixed(3)),
      }),
      // (debug, e.g. for an introduction: putt from where the ball is, toward a point)
      debug: {
        course: () => course,
        ball: () => ball,
        puttToward: (x, y, power) => {
          const d = Math.hypot(x - ball.x, y - ball.y) || 1;
          const v = (MIN_PUTT + (MAX_PUTT - MIN_PUTT) * power * power) * Math.sqrt(S);
          lie = { x: ball.x, y: ball.y };
          ball.vx = ((x - ball.x) / d) * v;
          ball.vy = ((y - ball.y) / d) * v;
          ball.moving = true;
          strokes++;
        },
      },
    };
  };
  Lynx.games.golf.HOLES = HOLES;
  Lynx.games.golf.PAR_TOTAL = PAR_TOTAL;
})(window.Lynx);
