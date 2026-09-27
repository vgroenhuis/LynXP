// Time Trial -- a course of gates is laid out on the floor starting where
// the robot stands, facing where the camera looks. Drive through the gates
// in order; a lap ends back through the checkered start gate. Your best lap
// on each course is replayed as a translucent ghost to race against (kept
// in this browser), and the best total time goes on the robot's scoreboard.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const POST_HEIGHT_M = 0.22;
  const BANNER_M = 0.05;

  // Course shapes in local coordinates (u = forward from the start, v = to
  // the left), as a closed loop of gate positions starting at the start
  // line. Scaled by the course-size setting.
  function coursePoints(kind) {
    const pts = [];
    if (kind === "eight") {
      // Starts on the right-hand loop, not on the crossing in the middle.
      for (let i = 0; i < 12; i++) {
        const t = (i / 12) * 2 * Math.PI + Math.PI / 2;
        pts.push({ u: 1.1 * Math.sin(t), v: -0.55 * Math.sin(2 * t) });
      }
    } else if (kind === "slalom") {
      const n = 12;
      for (let i = 0; i < n; i++) {
        const t = (i / n) * 2 * Math.PI;
        const weave = i % 2 === 0 ? 0 : (i % 4 === 1 ? 0.18 : -0.18);
        const r = 1 + weave;
        pts.push({ u: 1.2 * Math.sin(t) * r, v: 0.4 * (1 - Math.cos(t)) * r });
      }
    } else if (kind === "star") {
      for (let i = 0; i < 10; i++) {
        const a = (i / 10) * 2 * Math.PI;
        const r = i % 2 === 0 ? 1 : 0.45;
        pts.push({ u: r * Math.sin(a), v: 1 - r * Math.cos(a) });
      }
    } else {
      for (let i = 0; i < 8; i++) {
        const t = (i / 8) * 2 * Math.PI;
        pts.push({ u: 0.9 * Math.sin(t), v: 0.6 * (1 - Math.cos(t)) });
      }
    }
    // Normalize: start gate at the origin, first leg pointing straight ahead
    // (+u), so every course begins right where the robot is, facing where
    // the camera looks.
    const n = pts.length;
    const heading = Math.atan2(pts[1].v - pts[n - 1].v, pts[1].u - pts[n - 1].u);
    const c = Math.cos(-heading);
    const s = Math.sin(-heading);
    const o = pts[0];
    return pts.map((p) => ({ u: (p.u - o.u) * c - (p.v - o.v) * s, v: (p.u - o.u) * s + (p.v - o.v) * c }));
  }

  // Does the move a->b cross the gate line c-d? Half-open: a move that ends
  // exactly on the line counts, one that starts on it doesn't -- so stopping
  // right on the line and then driving on can't slip through uncounted.
  function segmentsCross(a, b, c, d) {
    const cross = (p, q, r) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
    const d1 = cross(c, d, a);
    const d2 = cross(c, d, b);
    const d3 = cross(a, b, c);
    const d4 = cross(a, b, d);
    return ((d1 < 0 && d2 >= 0) || (d1 > 0 && d2 <= 0)) && d3 * d4 <= 0;
  }

  const fmt = (ms) => Lynx.formatScore({ format: "time" }, ms);

  Lynx.games.race = (ar, cfg) => {
    const boardKey = `race_${cfg.course}`;
    const ghostKey = `lynxRaceGhost_${cfg.course}_${cfg.sizeM}`;
    let state = "title"; // title | countdown | racing | done
    let stateTime = 0;
    let gates = [];
    let origin = null; // {x, y, theta}
    let nextGate = 1;
    let lap = 1;
    let raceStartMs = 0;
    let lapStartMs = 0;
    let lapTimes = [];
    let bestLapMs = null;
    let lastDelta = null;
    let prevPos = null;
    let lapPath = [];
    let ghost = null; // {lapMs, path: [[t, u, v]...]}
    let best = null;
    let rankMsg = "";
    let lastBeep = -1;

    try {
      ghost = JSON.parse(localStorage.getItem(ghostKey) || "null");
    } catch (e) {
      ghost = null;
    }
    if (ghost) bestLapMs = ghost.lapMs;
    Lynx.bestScore(boardKey).then((b) => (best = b));

    // local (u forward, v left) <-> world, relative to the start pose
    const toWorld = (u, v) => ({
      x: origin.x + u * Math.cos(origin.theta) - v * Math.sin(origin.theta),
      y: origin.y + u * Math.sin(origin.theta) + v * Math.cos(origin.theta),
    });
    const toLocal = (x, y) => {
      const dx = x - origin.x;
      const dy = y - origin.y;
      return { u: dx * Math.cos(origin.theta) + dy * Math.sin(origin.theta), v: -dx * Math.sin(origin.theta) + dy * Math.cos(origin.theta) };
    };

    function layOut() {
      origin = { x: ar.pose.x, y: ar.pose.y, theta: ar.camTheta };
      const pts = coursePoints(cfg.course).map((p) => ({ u: p.u * cfg.sizeM, v: p.v * cfg.sizeM }));
      gates = pts.map((p, i) => {
        const prev = pts[(i - 1 + pts.length) % pts.length];
        const next = pts[(i + 1) % pts.length];
        const tu = next.u - prev.u;
        const tv = next.v - prev.v;
        const len = Math.hypot(tu, tv) || 1;
        // Posts either side of the path, perpendicular to its direction.
        const nu = -tv / len;
        const nv = tu / len;
        const half = cfg.gateWidthM / 2;
        return { i, center: toWorld(p.u, p.v), a: toWorld(p.u + nu * half, p.v + nv * half), b: toWorld(p.u - nu * half, p.v - nv * half) };
      });
    }

    function start() {
      layOut();
      state = "countdown";
      stateTime = 0;
      lastBeep = -1;
      nextGate = 1;
      lap = 1;
      lapTimes = [];
      lastDelta = null;
      prevPos = { x: ar.pose.x, y: ar.pose.y };
    }

    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title" || state === "done" || state === "racing") start();
    });

    function update(now, dt) {
      stateTime += dt;
      const pos = { x: ar.pose.x, y: ar.pose.y };
      if (state === "countdown") {
        const n = 3 - Math.floor(stateTime);
        if (n !== lastBeep && n > 0) {
          lastBeep = n;
          Lynx.sfx.play("beep");
        }
        if (stateTime >= 3) {
          state = "racing";
          stateTime = 0;
          raceStartMs = now;
          lapStartMs = now;
          lapPath = [];
          Lynx.sfx.play("go");
        }
        prevPos = pos;
        return;
      }
      if (state !== "racing") return;

      const l = toLocal(pos.x, pos.y);
      const t = now - lapStartMs;
      if (!lapPath.length || t - lapPath[lapPath.length - 1][0] > 100) lapPath.push([Math.round(t), +l.u.toFixed(3), +l.v.toFixed(3)]);

      const g = gates[nextGate];
      if (prevPos && segmentsCross(prevPos, pos, g.a, g.b)) {
        Lynx.sfx.play("gate");
        if (nextGate === 0) {
          const lapMs = now - lapStartMs;
          lapTimes.push(lapMs);
          lastDelta = bestLapMs !== null ? lapMs - bestLapMs : null;
          if (bestLapMs === null || lapMs < bestLapMs) {
            bestLapMs = lapMs;
            ghost = { lapMs, path: lapPath };
            try {
              localStorage.setItem(ghostKey, JSON.stringify(ghost));
            } catch (e) {
              // storage full/blocked -- no ghost next time, that's all
            }
          }
          lapPath = [];
          lapStartMs = now;
          if (lap >= cfg.laps) {
            const total = now - raceStartMs;
            state = "done";
            stateTime = 0;
            rankMsg = "";
            Lynx.sfx.play("found");
            Lynx.submitScore(boardKey, total).then((rank) => {
              rankMsg = rank ? `#${rank} on the robot's scoreboard!` : "";
              if (rank === 1) best = total;
            });
          } else {
            lap++;
          }
        }
        nextGate = (nextGate + 1) % gates.length;
      }
      prevPos = pos;
    }

    function drawGate(g, idx) {
      const ctx = ar.ctx;
      const isNext = state === "racing" && idx === nextGate;
      const isAfter = state === "racing" && idx === (nextGate + 1) % gates.length;
      const isStart = idx === 0;
      const color = isNext ? "#30ff60" : isAfter ? "#ffd040" : isStart ? "#ffffff" : "rgba(200,200,200,0.6)";
      const aBot = ar.project(g.a.x, g.a.y, 0);
      const aTop = ar.project(g.a.x, g.a.y, POST_HEIGHT_M);
      const bBot = ar.project(g.b.x, g.b.y, 0);
      const bTop = ar.project(g.b.x, g.b.y, POST_HEIGHT_M);
      const bLow = ar.project(g.b.x, g.b.y, POST_HEIGHT_M - BANNER_M);
      const aLow = ar.project(g.a.x, g.a.y, POST_HEIGHT_M - BANNER_M);
      if (!aBot || !aTop || !bBot || !bTop || !aLow || !bLow) return;
      ar.queue((aBot.depth + bBot.depth) / 2, () => {
        ctx.save();
        ctx.lineCap = "round";
        [[aBot, aTop], [bBot, bTop]].forEach(([p0, p1]) => {
          ctx.strokeStyle = "rgba(0,0,0,0.5)";
          ctx.lineWidth = Math.max(3, 0.02 * p0.ppm) + 2;
          ctx.beginPath();
          ctx.moveTo(p0.x, p0.y);
          ctx.lineTo(p1.x, p1.y);
          ctx.stroke();
          ctx.strokeStyle = color;
          ctx.lineWidth = Math.max(2, 0.02 * p0.ppm);
          ctx.stroke();
        });
        // Banner across the top; checkered for start/finish.
        ctx.beginPath();
        ctx.moveTo(aTop.x, aTop.y);
        ctx.lineTo(bTop.x, bTop.y);
        ctx.lineTo(bLow.x, bLow.y);
        ctx.lineTo(aLow.x, aLow.y);
        ctx.closePath();
        ctx.globalAlpha = isNext ? 0.85 : 0.5;
        ctx.fillStyle = isStart ? "#ffffff" : color;
        ctx.fill();
        if (isStart) {
          ctx.globalAlpha = 0.9;
          ctx.fillStyle = "#111";
          const n = 8;
          for (let i = 0; i < n; i++) {
            for (let row = 0; row < 2; row++) {
              if ((i + row) % 2) continue;
              const f0 = i / n;
              const f1 = (i + 1) / n;
              const lerp = (p, q, f) => ({ x: p.x + (q.x - p.x) * f, y: p.y + (q.y - p.y) * f });
              const top0 = lerp(aTop, bTop, f0);
              const top1 = lerp(aTop, bTop, f1);
              const low0 = lerp(aLow, bLow, f0);
              const low1 = lerp(aLow, bLow, f1);
              const r0 = row === 0 ? [top0, top1] : [lerp(top0, low0, 0.5), lerp(top1, low1, 0.5)];
              const r1 = row === 0 ? [lerp(top0, low0, 0.5), lerp(top1, low1, 0.5)] : [low0, low1];
              ctx.beginPath();
              ctx.moveTo(r0[0].x, r0[0].y);
              ctx.lineTo(r0[1].x, r0[1].y);
              ctx.lineTo(r1[1].x, r1[1].y);
              ctx.lineTo(r1[0].x, r1[0].y);
              ctx.closePath();
              ctx.fill();
            }
          }
        }
        ctx.restore();
        if (isNext) {
          const mid = ar.project(g.center.x, g.center.y, POST_HEIGHT_M + 0.04);
          if (mid) ar.text(idx === 0 ? "FINISH" : String(idx), mid.x, mid.y, { size: 14, align: "center", color: "#30ff60" });
        }
      });
    }

    function drawGhost(now) {
      if (!cfg.ghost || !ghost || state !== "racing" || !ghost.path.length) return;
      const t = now - lapStartMs;
      const path = ghost.path;
      let i = 0;
      while (i < path.length - 1 && path[i + 1][0] < t) i++;
      if (t > ghost.lapMs) return;
      const a = path[i];
      const b = path[Math.min(i + 1, path.length - 1)];
      const f = b[0] > a[0] ? Math.min(1, (t - a[0]) / (b[0] - a[0])) : 0;
      const w = toWorld(a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
      const pr = ar.project(w.x, w.y, 0.05);
      if (!pr) return;
      ar.queue(pr.depth, () => {
        ar.floorCircle(w.x, w.y, 0.09, "rgba(120,180,255,0.35)", "rgba(160,210,255,0.8)");
        ar.glow(pr.x, pr.y, 0.06 * pr.ppm, [[0, "rgba(200,230,255,0.9)"], [1, "rgba(120,180,255,0)"]]);
        ar.text("ghost", pr.x, pr.y - 0.08 * pr.ppm, { size: 11, align: "center", color: "#b0d8ff", alpha: 0.8 });
      });
    }

    function draw(now) {
      const v = ar.view;
      if (gates.length) {
        gates.forEach(drawGate);
        drawGhost(now);
        ar.flush();
        if (state === "racing") {
          const g = gates[nextGate];
          ar.edgeArrow(g.center.x, g.center.y, POST_HEIGHT_M / 2, "#30ff60", nextGate === 0 ? "finish" : `gate ${nextGate}`);
        }
        if (cfg.radar) {
          const blips = gates.map((g, i) => ({ x: g.center.x, y: g.center.y, color: i === nextGate && state === "racing" ? "#30ff60" : "rgba(255,255,255,0.6)", r: i === nextGate ? 4 : 2.5 }));
          ar.radar(blips, cfg.sizeM * 2.2);
        }
      }

      const hudY = v.y + v.h - 16;
      if (state === "racing") {
        ar.text(fmt(now - raceStartMs), v.x + 16, hudY, { size: 26, color: "#fff", font: "ui-monospace, Consolas, monospace" });
        ar.text(`LAP ${lap}/${cfg.laps}   lap ${fmt(now - lapStartMs)}${bestLapMs !== null ? `   best ${fmt(bestLapMs)}` : ""}`, v.cx, hudY, { size: 15, align: "center" });
        if (lastDelta !== null && now - lapStartMs < 3000) {
          ar.text(`${lastDelta <= 0 ? "-" : "+"}${fmt(Math.abs(lastDelta))}`, v.cx, v.y + v.h * 0.3, { size: 30, align: "center", color: lastDelta <= 0 ? "#30ff60" : "#ff5040" });
        }
      }
      if (state === "title") {
        ar.flash("#000", 0.45);
        ar.banner("TIME TRIAL", "Point the camera where the course should go, then press FIRE", { color: "#30ff60" });
        ar.text(`${cfg.course} course · ${cfg.laps} laps · ${cfg.sizeM} m`, v.cx, v.cy + v.h * 0.2, { size: 14, align: "center" });
        if (best !== null) ar.text(`Record on this robot: ${fmt(best)}`, v.cx, v.cy + v.h * 0.27, { size: 14, align: "center", color: "#ffd040" });
      } else if (state === "countdown") {
        const n = 3 - Math.floor(stateTime);
        ar.banner(n > 0 ? String(n) : "GO!", "drive through the gates in order", { color: n > 0 ? "#ffd040" : "#30ff60" });
      } else if (state === "done") {
        const total = lapTimes.reduce((a, b) => a + b, 0);
        ar.banner("FINISHED", `${fmt(total)} · best lap ${fmt(Math.min(...lapTimes))}`, { color: "#30ff60" });
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.18, { size: 16, align: "center", color: "#ffd040" });
        ar.text("Press FIRE to race again (the course re-anchors to where you are)", v.cx, v.cy + v.h * 0.25, { size: 13, align: "center" });
      }
    }

    ar.onFrame((now, dt) => {
      update(now, dt);
      draw(now);
    });
    return {
      actionLabel: "\u{1F3C1} Start / restart",
      snapshot: () => ({ state, lap, nextGate, lapTimes, origin, gates: gates.map((g) => ({ a: g.a, b: g.b })) }),
    };
  };
})(window.Lynx);
