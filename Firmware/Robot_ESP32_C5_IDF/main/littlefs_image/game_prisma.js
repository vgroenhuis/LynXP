// Prisma -- a Sokoban-style laser puzzle on the floor. A board of tiles is
// laid out where the robot stands (facing up the level map); drive onto a
// neighbouring tile to step there, or into a block to push it. Guide the
// beams onto their receivers (exact colours), then drive onto the exit.
// Rules: prisma_core.js; levels: prisma_levels.js (all solver-checked).

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const core = Lynx.prismaCore;
  // Kept well below the camera (~10 cm) so the board stays visible past the
  // nearest pieces; the minimap gives the overview.
  const WALL_H = 0.045;
  const BLOCK_H = 0.06;
  const BEAM_H = 0.03;
  const ENTER_FRACTION = 0.32; // robot must be this close (in tiles) to a tile's center to count as on it
  const PROGRESS_KEY = "prismaProgress";

  const loadProgress = () => {
    try {
      return JSON.parse(localStorage.getItem(PROGRESS_KEY)) || {};
    } catch (e) {
      return {};
    }
  };
  const saveProgress = (p) => {
    try {
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(p));
    } catch (e) {
      // no storage -- progress just isn't remembered
    }
  };

  Lynx.games.prisma = (ar, cfg) => {
    const levels = Lynx.prismaLevels;
    const CELL = cfg.cellM || 0.25;
    let progress = loadProgress();
    // startLevel 0: continue at the first level without stars yet
    const firstUnsolved = Math.max(0, levels.findIndex((_, i) => !progress[String(i + 1)]));
    let levelIndex = cfg.startLevel ? Math.min(Math.max(cfg.startLevel - 1, 0), levels.length - 1) : firstUnsolved;
    let state = "title"; // title | playing | clear | done
    let stateTime = 0;
    let g = null; // parsed level
    let s = null; // current state
    let history = [];
    let moves = 0;
    let anchor = null; // {x, y, th, sx, sy}: board placement
    let blocked = null; // {x, y, t, msg}
    let traced = null;
    let lastMoveAt = -10;
    let lastStars = 0;

    // -- board <-> world -------------------------------------------------------------
    // map "up" (-y) = the robot's forward direction at the start of the level
    function toWorld(cx, cy) {
      const f = (anchor.sy - cy) * CELL;
      const r = (cx - anchor.sx) * CELL;
      return {
        x: anchor.x + f * Math.cos(anchor.th) + r * Math.sin(anchor.th),
        y: anchor.y + f * Math.sin(anchor.th) - r * Math.cos(anchor.th),
      };
    }
    function toBoard(wx, wy) {
      const dx = wx - anchor.x;
      const dy = wy - anchor.y;
      const f = dx * Math.cos(anchor.th) + dy * Math.sin(anchor.th);
      const r = dx * Math.sin(anchor.th) - dy * Math.cos(anchor.th);
      return { x: anchor.sx + r / CELL, y: anchor.sy - f / CELL };
    }

    function startLevel(i) {
      levelIndex = i;
      const lv = levels[i];
      g = core.parse(lv);
      s = g.initial;
      history = [];
      moves = 0;
      blocked = null;
      anchor = { x: ar.pose.x, y: ar.pose.y, th: ar.pose.theta, sx: g.start[0], sy: g.start[1] };
      traced = core.trace(g, s);
      state = "playing";
      stateTime = 0;
      Lynx.sfx.play("levelup");
    }

    function undo() {
      if (!history.length) return;
      s = history.pop();
      moves = Math.max(0, moves - 1);
      traced = core.trace(g, s);
      Lynx.sfx.play("click");
    }

    function restart() {
      if (state === "playing" || state === "clear") startLevel(levelIndex);
    }

    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title") startLevel(levelIndex);
      else if (state === "clear" && stateTime > 1) {
        if (levelIndex + 1 < levels.length) startLevel(levelIndex + 1);
        else {
          state = "done";
          stateTime = 0;
        }
      } else if (state === "playing") undo();
    });
    Lynx.onAction("weapon", (which) => {
      // LB / RB: undo / restart
      if (state !== "playing") return;
      if (which === "prev") undo();
      else if (which === "next") restart();
    });
    Lynx.touchButtons().add("⟲ Restart", restart);

    // -- moving: follow the robot tile by tile ------------------------------------------
    function update(dt) {
      stateTime += dt;
      if (blocked) blocked.t += dt;
      if (state !== "playing") return;
      const b = toBoard(ar.pose.x, ar.pose.y);
      const cx = Math.round(b.x);
      const cy = Math.round(b.y);
      const centered = Math.abs(b.x - cx) < ENTER_FRACTION && Math.abs(b.y - cy) < ENTER_FRACTION;
      if (cx === s.px && cy === s.py) {
        blocked = null;
        return;
      }
      if (!centered) return;
      const dx = cx - s.px;
      const dy = cy - s.py;
      if (Math.abs(dx) + Math.abs(dy) !== 1) {
        if (!blocked || blocked.x !== cx || blocked.y !== cy) blocked = { x: cx, y: cy, t: 0, msg: "One tile at a time -- go back to the marked tile" };
        return;
      }
      const n = core.move(g, s, dx, dy);
      if (!n) {
        if (!blocked || blocked.x !== cx || blocked.y !== cy) {
          blocked = { x: cx, y: cy, t: 0, msg: "Blocked -- back up" };
          Lynx.sfx.play("fail");
        }
        return;
      }
      const pushed = JSON.stringify(n.blocks) !== JSON.stringify(s.blocks);
      history.push(s);
      s = n;
      moves++;
      blocked = null;
      lastMoveAt = stateTime;
      const before = traced;
      traced = core.trace(g, s);
      Lynx.sfx.play(pushed ? "knock" : "click");
      const newlyLit = traced.hitColor.some((c, i) => c === g.receivers[i].color && before.hitColor[i] !== c);
      if (newlyLit) Lynx.sfx.play("pickup");
      if (core.solved(g, s)) {
        state = "clear";
        stateTime = 0;
        const par = levels[levelIndex].par || moves;
        const stars = moves <= par ? 3 : moves <= Math.ceil(par * 1.5) ? 2 : 1;
        lastStars = stars;
        const key = String(levelIndex + 1);
        progress[key] = Math.max(progress[key] || 0, stars);
        saveProgress(progress);
        Lynx.sfx.play("found");
        const total = Object.values(progress).reduce((a, v) => a + v, 0);
        Lynx.submitScore("prisma", total);
      }
    }

    // -- drawing ---------------------------------------------------------------------------
    const ctx = () => ar.ctx;

    // Projected polygon of world points (x, y, h); null if any is behind the camera.
    function proj(points) {
      const out = [];
      for (const [x, y, h] of points) {
        const p = ar.project(x, y, h);
        if (!p) return null;
        out.push(p);
      }
      return out;
    }

    function poly(pts, fill, stroke, width = 1) {
      const c = ctx();
      c.beginPath();
      pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.closePath();
      if (fill) {
        c.fillStyle = fill;
        c.fill();
      }
      if (stroke) {
        c.strokeStyle = stroke;
        c.lineWidth = width;
        c.stroke();
      }
    }

    // floor corners of tile (cx, cy), optionally shrunk
    function tileCorners(cx, cy, inset = 0) {
      const a = 0.5 - inset;
      return [[cx - a, cy - a], [cx + a, cy - a], [cx + a, cy + a], [cx - a, cy + a]].map(([x, y]) => toWorld(x, y));
    }

    // Board frame for exact draw ordering (ar.queue's box): f = column, r =
    // row (tiles), h = height (m); cam set at the start of each frame.
    const frame = { cam: { f: 0, r: 0, h: 0 } };
    const cellBox = (cx, cy, half, h0, h1) => ({ frame, f0: cx - half, f1: cx + half, r0: cy - half, r1: cy + half, h0, h1 });

    // A box standing on a tile: sides facing the camera, then the top.
    function box(cx, cy, h, top, side, inset = 0.04) {
      const base = tileCorners(cx, cy, inset);
      const c = toWorld(cx, cy);
      const p = ar.project(c.x, c.y, h / 2);
      if (!p) return;
      ar.queue(p.depth, () => {
        const cam = ar.cameraWorld();
        for (let i = 0; i < 4; i++) {
          const a = base[i];
          const b = base[(i + 1) % 4];
          // outward normal of this side, in the floor plane
          const mx = (a.x + b.x) / 2 - c.x;
          const my = (a.y + b.y) / 2 - c.y;
          if (mx * (cam.x - (a.x + b.x) / 2) + my * (cam.y - (a.y + b.y) / 2) <= 0) continue;
          const q = proj([[a.x, a.y, 0], [b.x, b.y, 0], [b.x, b.y, h], [a.x, a.y, h]]);
          if (q) poly(q, side, "rgba(0,0,0,0.35)");
        }
        if (cam.h > h) {
          const q = proj(base.map((w) => [w.x, w.y, h]));
          if (q) poly(q, top, "rgba(0,0,0,0.35)");
        }
      }, cellBox(cx, cy, 0.5 - inset, 0, h));
    }

    // An upright panel along a tile's diagonal ('/' or '\').
    function panel(cx, cy, o, h, fill, edge) {
      const [a, b] = o === "/" ? [toWorld(cx - 0.42, cy + 0.42), toWorld(cx + 0.42, cy - 0.42)] : [toWorld(cx - 0.42, cy - 0.42), toWorld(cx + 0.42, cy + 0.42)];
      const c = toWorld(cx, cy);
      const p = ar.project(c.x, c.y, h / 2);
      if (!p) return;
      ar.queue(p.depth, () => {
        const q = proj([[a.x, a.y, 0.01], [b.x, b.y, 0.01], [b.x, b.y, h], [a.x, a.y, h]]);
        if (q) poly(q, fill, edge, 2);
      }, cellBox(cx, cy, 0.42, 0.01, h));
    }

    function floorTile(cx, cy, fill, stroke, inset = 0.06, width = 1.5) {
      const q = proj(tileCorners(cx, cy, inset).map((w) => [w.x, w.y, 0]));
      if (q) poly(q, fill, stroke, width);
    }

    function drawBoard() {
      const cw = ar.cameraWorld();
      const cb = toBoard(cw.x, cw.y);
      frame.cam = { f: cb.x, r: cb.y, h: cw.h };
      // tile grid on the floor
      for (let y = 0; y < g.H; y++) {
        for (let x = 0; x < g.W; x++) {
          if (g.cell[y][x] === "#" && (x === 0 || y === 0 || x === g.W - 1 || y === g.H - 1)) continue;
          floorTile(x, y, null, "rgba(255,255,255,0.18)", 0.02, 1);
        }
      }
      const lit = traced.lit;
      const gatesOpen = core.platePressed(g, s);
      for (let y = 0; y < g.H; y++) {
        for (let x = 0; x < g.W; x++) {
          const ch = g.cell[y][x];
          if (ch === "#") box(x, y, WALL_H, "#8a8478", "#5e5a52", 0);
          else if (ch === "~") box(x, y, WALL_H, "rgba(160,230,255,0.25)", "rgba(120,200,255,0.2)", 0.02);
          else if (ch === "L") box(x, y, WALL_H, "#303038", "#202028");
          else if (ch === "R") {
            const i = g.receivers.findIndex((r) => r.x === x && r.y === y);
            const want = g.receivers[i].color;
            const ok = traced.hitColor[i] === want;
            box(x, y, WALL_H, ok ? core.COLOR_CSS[want] : "#403c48", "#2a2830");
            const c = toWorld(x, y);
            const p = ar.project(c.x, c.y, WALL_H + 0.02);
            if (p) {
              ar.queue(p.depth - 0.001, () => {
                ar.glow(p.x, p.y, Math.max(8, 0.12 * p.ppm), [[0, core.COLOR_CSS[want]], [1, "rgba(0,0,0,0)"]], ok ? 1 : 0.35);
              }, cellBox(x, y, 0, WALL_H + 0.02, WALL_H + 0.02));
            }
          } else if (ch === "m" || ch === "M") panel(x, y, ch === "m" ? "/" : "\\", BLOCK_H, "rgba(200,220,255,0.75)", "#e0f0ff");
          else if (ch === "z" || ch === "Z") panel(x, y, ch === "z" ? "/" : "\\", BLOCK_H, "rgba(200,255,255,0.35)", "#80ffff");
          else if (ch === "f") {
            const f = g.filters.get(x + "," + y);
            box(x, y, BLOCK_H, "rgba(0,0,0,0)", (core.COLOR_CSS[core.COLORS[f.color]] || "#fff") + "66", 0.2);
          } else if (ch === "D") {
            if (gatesOpen) floorTile(x, y, "rgba(80,255,120,0.12)", "rgba(80,255,120,0.6)");
            else box(x, y, WALL_H, "#b03030", "#802020", 0.08);
          } else if (ch === "_") {
            const pressed = gatesOpen && ((s.px === x && s.py === y) || core.blockAt(s, x, y));
            floorTile(x, y, pressed ? "rgba(255,210,60,0.5)" : "rgba(255,210,60,0.15)", "#ffd23c", 0.15, 2);
          } else if (ch === "o") {
            const c = toWorld(x, y);
            ar.floorCircle(c.x, c.y, CELL * 0.3, "rgba(190,120,255,0.2)", "#c080ff");
          } else if (ch === "X") {
            const pulse = lit ? 0.35 + 0.25 * Math.sin(stateTime * 5) : 0.08;
            floorTile(x, y, `rgba(80,255,120,${pulse})`, lit ? "#50ff78" : "rgba(80,255,120,0.4)", 0.08, 2);
          }
        }
      }
      // movable blocks
      s.blocks.forEach((b) => {
        if (b.kind === "crate") box(b.x, b.y, BLOCK_H, "#c88a3c", "#8a5a24", 0.08);
        else {
          const c = toWorld(b.x, b.y);
          ar.floorCircle(c.x, c.y, CELL * 0.18, "rgba(60,60,70,0.7)");
          panel(b.x, b.y, b.o, BLOCK_H, "rgba(210,225,255,0.8)", "#40e0ff");
        }
      });
      // you (the tile you're on), and where you tried to go
      floorTile(s.px, s.py, "rgba(40,200,255,0.18)", "#28c8ff", 0.1, 2.5);
      if (blocked) floorTile(blocked.x, blocked.y, "rgba(255,60,60,0.25)", "#ff4040", 0.1, 2.5);
      ar.flush();
      drawBeams();
    }

    function drawBeams() {
      const c = ctx();
      traced.segments.forEach((seg) => {
        const css = core.COLOR_CSS[seg.color];
        // several pieces, so the line bends with the lens like the floor does
        const n = Math.max(2, Math.ceil(Math.hypot(seg.x1 - seg.x0, seg.y1 - seg.y0) * 3));
        const pts = [];
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const w = toWorld(seg.x0 + (seg.x1 - seg.x0) * t, seg.y0 + (seg.y1 - seg.y0) * t);
          const p = ar.project(w.x, w.y, BEAM_H);
          if (p) pts.push(p);
        }
        if (pts.length < 2) return;
        c.save();
        c.lineCap = "round";
        c.lineJoin = "round";
        [[9, 0.25], [4, 0.6], [1.5, 1]].forEach(([width, alpha], k) => {
          c.globalAlpha = alpha;
          c.strokeStyle = k === 2 ? "#ffffff" : css;
          c.lineWidth = width;
          c.beginPath();
          pts.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
          c.stroke();
        });
        c.restore();
      });
    }

    // Top-down overview in the corner (map up = the robot's forward at the
    // start of the level), with the robot's heading.
    function drawMinimap() {
      const v = ar.view;
      const c = ctx();
      const t = Math.max(8, Math.min(20, Math.floor((v.h * 0.42) / g.H), Math.floor((v.w * 0.3) / g.W)));
      const ox = v.x + v.w - g.W * t - 12;
      const oy = v.y + 60;
      const mid = (x, y) => [ox + (x + 0.5) * t, oy + (y + 0.5) * t];
      const gatesOpen = core.platePressed(g, s);
      c.save();
      c.globalAlpha = 0.85;
      c.fillStyle = "rgba(10,12,20,0.75)";
      c.fillRect(ox - 4, oy - 4, g.W * t + 8, g.H * t + 8);
      for (let y = 0; y < g.H; y++) {
        for (let x = 0; x < g.W; x++) {
          const ch = g.cell[y][x];
          const [mx, my] = mid(x, y);
          const fill = { "#": "#77726a", L: "#303038", R: "#403c48", "~": "rgba(160,230,255,0.35)" }[ch];
          if (fill) {
            c.fillStyle = fill;
            c.fillRect(ox + x * t, oy + y * t, t, t);
          }
          if (ch === "R") {
            const i = g.receivers.findIndex((r) => r.x === x && r.y === y);
            const want = g.receivers[i].color;
            c.fillStyle = core.COLOR_CSS[want];
            c.globalAlpha = traced.hitColor[i] === want ? 1 : 0.35;
            c.beginPath();
            c.arc(mx, my, t * 0.32, 0, 2 * Math.PI);
            c.fill();
            c.globalAlpha = 0.85;
          } else if (ch === "L") {
            const e = g.emitters.find((m) => m.x === x && m.y === y);
            c.fillStyle = core.COLOR_CSS[e.color];
            c.fillRect(mx - t * 0.15 + e.d[0] * t * 0.3, my - t * 0.15 + e.d[1] * t * 0.3, t * 0.3, t * 0.3);
          } else if (ch === "D" && !gatesOpen) {
            c.fillStyle = "#b03030";
            c.fillRect(ox + x * t + 2, oy + y * t + 2, t - 4, t - 4);
          } else if (ch === "D" || ch === "_" || ch === "X" || ch === "o") {
            c.strokeStyle = { D: "#50ff78", _: "#ffd23c", X: "#50ff78", o: "#c080ff" }[ch];
            c.lineWidth = 1.5;
            if (ch === "o") {
              c.beginPath();
              c.arc(mx, my, t * 0.3, 0, 2 * Math.PI);
              c.stroke();
            } else c.strokeRect(ox + x * t + 2.5, oy + y * t + 2.5, t - 5, t - 5);
          } else if (ch === "f") {
            const f = g.filters.get(x + "," + y);
            c.strokeStyle = core.COLOR_CSS[core.COLORS[f.color]] || "#fff";
            c.lineWidth = 2;
            c.strokeRect(ox + x * t + 3, oy + y * t + 3, t - 6, t - 6);
          }
          const fixed = { m: "/", M: "\\", z: "/", Z: "\\" }[ch];
          if (fixed) mirrorLine(mx, my, fixed, ch === "z" || ch === "Z" ? "#80ffff" : "#e0f0ff", 1.5);
        }
      }
      function mirrorLine(mx, my, o, color, width) {
        const a = t * 0.4;
        c.strokeStyle = color;
        c.lineWidth = width;
        c.beginPath();
        if (o === "/") {
          c.moveTo(mx - a, my + a);
          c.lineTo(mx + a, my - a);
        } else {
          c.moveTo(mx - a, my - a);
          c.lineTo(mx + a, my + a);
        }
        c.stroke();
      }
      s.blocks.forEach((b) => {
        const [mx, my] = mid(b.x, b.y);
        if (b.kind === "crate") {
          c.fillStyle = "#c88a3c";
          c.fillRect(mx - t * 0.38, my - t * 0.38, t * 0.76, t * 0.76);
        } else mirrorLine(mx, my, b.o, "#40e0ff", 3);
      });
      c.globalAlpha = 1;
      traced.segments.forEach((seg) => {
        c.strokeStyle = core.COLOR_CSS[seg.color];
        c.lineWidth = 2;
        c.beginPath();
        c.moveTo(...mid(seg.x0, seg.y0));
        c.lineTo(...mid(seg.x1, seg.y1));
        c.stroke();
      });
      // the robot: its tile, and where it's really heading
      const b0 = toBoard(ar.pose.x, ar.pose.y);
      const b1 = toBoard(ar.pose.x + 0.1 * Math.cos(ar.pose.theta), ar.pose.y + 0.1 * Math.sin(ar.pose.theta));
      const hd = Math.atan2(b1.y - b0.y, b1.x - b0.x);
      const [px, py] = mid(Math.max(-0.5, Math.min(g.W - 0.5, b0.x)), Math.max(-0.5, Math.min(g.H - 0.5, b0.y)));
      c.strokeStyle = "#28c8ff";
      c.lineWidth = 2;
      c.strokeRect(ox + s.px * t + 1, oy + s.py * t + 1, t - 2, t - 2);
      c.fillStyle = "#28c8ff";
      c.beginPath();
      c.moveTo(px + Math.cos(hd) * t * 0.45, py + Math.sin(hd) * t * 0.45);
      c.lineTo(px + Math.cos(hd + 2.5) * t * 0.3, py + Math.sin(hd + 2.5) * t * 0.3);
      c.lineTo(px + Math.cos(hd - 2.5) * t * 0.3, py + Math.sin(hd - 2.5) * t * 0.3);
      c.closePath();
      c.fill();
      c.restore();
    }

    function draw() {
      const v = ar.view;
      if (state === "playing" || state === "clear") {
        drawBoard();
        if (cfg.minimap !== false) drawMinimap();
      }
      const lv = levels[levelIndex];
      if (state === "playing" || state === "clear") {
        ar.text(`PRISMA ${levelIndex + 1}/${levels.length}  ${lv.name}`, v.x + 14, v.y + 66, { size: 16, color: "#80e0ff" });
        ar.text(`moves ${moves}${lv.par ? `  (best ${lv.par})` : ""}`, v.x + 14, v.y + 88, { size: 14 });
        const lit = traced.hitColor.filter((c, i) => c === g.receivers[i].color).length;
        ar.text(`receivers ${lit}/${g.receivers.length}`, v.x + 14, v.y + 108, { size: 14, color: traced.lit ? "#50ff78" : "#fff" });
        if (cfg.hints !== false && stateTime < 8 && lv.hint) ar.text(lv.hint, v.cx, v.y + v.h - 20, { size: 15, align: "center", color: "#ffe080" });
        if (blocked && state === "playing") ar.text(blocked.msg, v.cx, v.y + v.h * 0.3, { size: 18, align: "center", color: "#ff6060" });
        if (traced.lit && state === "playing" && g.cell[s.py][s.px] !== "X") ar.text("All lit -- drive to the exit!", v.cx, v.y + v.h * 0.22, { size: 18, align: "center", color: "#50ff78" });
      }
      if (state === "title") {
        ar.flash("#000", 0.45);
        ar.banner("PRISMA", `Press FIRE to start level ${levelIndex + 1}`, { color: "#80e0ff" });
        ar.text("Drive onto a tile to step · drive into a block to push it · FIRE = undo · ⟲ = restart", v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
        ar.text("The board is laid out in front of the robot -- give it about 2 x 2 m.", v.cx, v.cy + v.h * 0.26, { size: 13, align: "center" });
      } else if (state === "clear") {
        const stars = lastStars;
        ar.banner("SOLVED!", `${moves} moves  ${"★".repeat(stars)}${"☆".repeat(3 - stars)}`, { color: "#50ff78" });
        if (stateTime > 1) ar.text(levelIndex + 1 < levels.length ? "Press FIRE for the next level" : "Press FIRE", v.cx, v.cy + v.h * 0.22, { size: 14, align: "center" });
      } else if (state === "done") {
        const total = Object.values(progress).reduce((a, x) => a + x, 0);
        ar.flash("#000", 0.4);
        ar.banner("ALL LEVELS SOLVED", `${total} of ${levels.length * 3} stars`, { color: "#ffd84a" });
      }
    }

    ar.onFrame((now, dt) => {
      update(dt);
      draw();
    });

    return {
      actionLabel: "↶ Undo",
      snapshot: () => ({ state, level: levelIndex + 1, moves, player: s && [s.px, s.py], lit: traced && traced.lit, blocks: s && s.blocks }),
    };
  };
})(window.Lynx);
