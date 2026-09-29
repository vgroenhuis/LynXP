// Shared AR engine for the first-person-view games (game_*.js) and apps.
//
// World frame = the robot's odometry frame (meters, x/y on the floor, h up).
// Every frame the live pose (cam.js's subscribeToPose(), interpolated to the
// display rate) gives the camera's position and aim: chassis heading + pan
// servo, tilt = mounting tilt minus the tilt servo. Points are projected with
// the same tilt-aware pinhole model as the floor grid/waypoint overlays
// (calibrated height/tilt/vertical FOV from the Main page), then mapped onto
// the letterboxed <img> ("object-fit: contain").
//
// Games draw world things through queue()/flush() (painter's algorithm:
// farthest first) and HUD things straight onto ctx in screen space.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const NEAR_M = 0.04; // closer than this in front of the lens isn't drawn (projection blows up)
  // Virtual jumping: the camera's virtual height rises along a jump arc while
  // its floor position stays the robot's real one. Robot scale: the camera
  // sits ~10 cm up, obstacles are 10-30 cm.
  const JUMP_HEIGHT_M = 0.28;
  const JUMP_TIME_S = 0.75; // up and down again
  const GRAVITY = (8 * JUMP_HEIGHT_M) / (JUMP_TIME_S * JUMP_TIME_S);
  const JUMP_SPEED = (4 * JUMP_HEIGHT_M) / JUMP_TIME_S;
  const FALLBACK_IMG_W = 640; // until the stream's first frame arrives
  const FALLBACK_IMG_H = 480;

  // -- pixel sprites ----------------------------------------------------------
  // rows: array of equal-length strings; palette: char -> CSS color ("." or
  // " " = transparent). Rendered once to a tiny canvas, then scaled up with
  // smoothing off for that chunky retro look.
  const spriteCache = new Map();
  Lynx.sprite = (rows, palette) => {
    const key = rows.join("|") + JSON.stringify(palette);
    if (spriteCache.has(key)) return spriteCache.get(key);
    const h = rows.length;
    const w = rows[0].length;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const col = palette[rows[y][x]];
        if (!col) continue;
        g.fillStyle = col;
        g.fillRect(x, y, 1, 1);
      }
    }
    spriteCache.set(key, c);
    return c;
  };

  Lynx.createAr = (calib) => {
    const container = document.querySelector(".cam-fullscreen");
    const img = document.getElementById("camStream");
    const canvas = document.createElement("canvas");
    canvas.className = "cam-floor-grid game-canvas";
    container.insertBefore(canvas, document.getElementById("camMenuPanel"));
    const ctx = canvas.getContext("2d");

    const ar = {
      canvas,
      ctx,
      calib,
      pose: { x: 0, y: 0, theta: 0, servoAngleDeg: 0, tiltAngleDeg: 0 },
      camTheta: 0,
      tilt: calib.tiltRad,
      view: null, // {cw, ch, imgW, imgH, scale, offX, offY, f, x, y, w, h, cx, cy}
      hasVideo: false,
      // Virtual elevation of the camera above its real height (m): the ground
      // under the player (a platform a game put there, see setGround) plus
      // the current jump. Everything virtual is drawn from that height.
      z: 0,
      ground: 0,
      vz: 0,
      airborne: false,
    };
    const frameCallbacks = [];
    let queueItems = [];
    let lastFrameMs = null;

    function updateView() {
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      ar.hasVideo = img.naturalWidth > 0;
      const imgW = img.naturalWidth || FALLBACK_IMG_W;
      const imgH = img.naturalHeight || FALLBACK_IMG_H;
      const scale = Math.min(cw / imgW, ch / imgH);
      const w = imgW * scale;
      const h = imgH * scale;
      const x = (cw - w) / 2;
      const y = (ch - h) / 2;
      ar.view = {
        cw, ch, imgW, imgH, scale, offX: x, offY: y, x, y, w, h,
        f: Lynx.lens.params(imgW, imgH).f, // near the image center; see Lynx.lens
        cx: x + w / 2,
        cy: y + h / 2,
      };
    }

    // World point -> camera frame: right, forward (on the floor plane).
    ar.toCamera = (wx, wy) => {
      const dx = wx - ar.pose.x;
      const dy = wy - ar.pose.y;
      const t = ar.camTheta;
      return { right: dx * Math.sin(t) - dy * Math.cos(t), forward: dx * Math.cos(t) + dy * Math.sin(t) };
    };

    // World point (x, y on the floor, h meters up) -> screen. Null if behind
    // the camera. ppm = screen pixels per meter at that depth (for sizing).
    ar.project = (wx, wy, h) => {
      const rel = ar.toCamera(wx, wy);
      const v = ar.view;
      const vertical = calib.heightM + ar.z - h;
      const zc = rel.forward * Math.cos(ar.tilt) + vertical * Math.sin(ar.tilt);
      if (zc < NEAR_M) return null;
      const yc = vertical * Math.cos(ar.tilt) - rel.forward * Math.sin(ar.tilt);
      // Through the calibrated lens model (Lynx.lens, lynx_common.js).
      const p = Lynx.lens.project(rel.right, yc, zc, v.imgW, v.imgH);
      if (!p) return null;
      return { x: v.offX + p.u * v.scale, y: v.offY + p.v * v.scale, depth: zc, ppm: (p.scale * v.scale) / zc };
    };

    // Is a projected point inside the visible video area (with margin px)?
    ar.onScreen = (p, margin = 0) =>
      p && p.x >= ar.view.x - margin && p.x <= ar.view.x + ar.view.w + margin &&
      p.y >= ar.view.y - margin && p.y <= ar.view.y + ar.view.h + margin;

    // Camera position in the world (for 3D distances, e.g. projectile hits).
    ar.cameraWorld = () => ({ x: ar.pose.x, y: ar.pose.y, h: calib.heightM + ar.z });

    // Jump (only from the ground). Returns whether a jump started.
    ar.jump = () => {
      if (ar.airborne) return false;
      ar.vz = JUMP_SPEED;
      ar.airborne = true;
      Lynx.sfx.play("jump");
      return true;
    };
    // What the player stands on right now (m above the floor): games with
    // platforms set it every frame from where the robot is. Walking off an
    // edge makes you fall; you can only get higher by jumping. Negative =
    // the bottom of a pit (you drop into it).
    ar.setGround = (h) => {
      ar.ground = h;
    };
    // Height of the player's feet above the floor (0 = on the floor).
    ar.feet = () => ar.z;

    // Unit vector of where the camera is looking, in world coordinates.
    ar.aimVector = () => ({
      x: Math.cos(ar.camTheta) * Math.cos(ar.tilt),
      y: Math.sin(ar.camTheta) * Math.cos(ar.tilt),
      h: -Math.sin(ar.tilt),
    });

    // box (optional): the item's axis-aligned extent {frame, f0, f1, r0, r1,
    // h0, h1} in a game's own floor frame, frame.cam = the camera's {f, r, h}
    // in it this frame. Boxed items of the same frame are drawn in an exact
    // order (see flush()) instead of just by their center's depth, which
    // gets neighbouring blocks of different sizes wrong.
    ar.queue = (depth, draw, box) => queueItems.push({ depth, draw, box });

    // -- world drawing helpers ------------------------------------------------

    // Billboard sprite standing on the floor at (wx, wy), bottom at baseH,
    // heightM tall. Returns its screen rect (for hit tests), or null.
    ar.spriteRect = (spr, wx, wy, baseH, heightM) => {
      const bottom = ar.project(wx, wy, baseH);
      const top = ar.project(wx, wy, baseH + heightM);
      if (!bottom || !top) return null;
      const hPx = Math.max(bottom.y - top.y, 1);
      const wPx = (hPx * spr.width) / spr.height;
      return { x: bottom.x - wPx / 2, y: top.y, w: wPx, h: hPx, depth: bottom.depth, cx: bottom.x, bottomY: bottom.y };
    };

    ar.drawSprite = (spr, rect, opts = {}) => {
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;
      if (opts.flip) {
        ctx.translate(rect.x + rect.w, rect.y);
        ctx.scale(-1, 1);
        ctx.drawImage(spr, 0, 0, rect.w, rect.h);
      } else {
        ctx.drawImage(spr, rect.x, rect.y, rect.w, rect.h);
      }
      if (opts.tint) {
        ctx.globalCompositeOperation = "source-atop";
        ctx.fillStyle = opts.tint;
        ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
      }
      ctx.restore();
    };

    // A circle lying on the floor, drawn in true perspective (so it
    // flattens into an ellipse with distance, like the floor grid).
    ar.floorCircle = (wx, wy, radiusM, fill, stroke, h = 0) => {
      const pts = [];
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * 2 * Math.PI;
        const p = ar.project(wx + radiusM * Math.cos(a), wy + radiusM * Math.sin(a), h);
        if (!p) return;
        pts.push(p);
      }
      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      if (fill) {
        ctx.fillStyle = fill;
        ctx.fill();
      }
      if (stroke) {
        ctx.strokeStyle = stroke;
        ctx.stroke();
      }
    };

    ar.glow = (x, y, r, stops, alpha = 1) => {
      if (r <= 0.5) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      stops.forEach(([o, c]) => g.addColorStop(o, c));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      ctx.fill();
      ctx.restore();
    };

    // -- HUD helpers -----------------------------------------------------------

    ar.text = (str, x, y, opts = {}) => {
      const size = opts.size || 16;
      ctx.save();
      ctx.font = `${opts.weight || "bold"} ${size}px ${opts.font || "system-ui, sans-serif"}`;
      ctx.textAlign = opts.align || "left";
      ctx.textBaseline = opts.baseline || "alphabetic";
      if (opts.alpha !== undefined) ctx.globalAlpha = opts.alpha;
      if (opts.outline !== false) {
        ctx.lineWidth = Math.max(2, size / 7);
        ctx.strokeStyle = opts.outline || "rgba(0,0,0,0.85)";
        ctx.lineJoin = "round";
        ctx.strokeText(str, x, y);
      }
      ctx.fillStyle = opts.color || "#fff";
      ctx.fillText(str, x, y);
      ctx.restore();
    };

    // Big centered title + subtitle over the video (wave banners, game over...).
    ar.banner = (title, sub, opts = {}) => {
      const v = ar.view;
      const size = Math.max(22, Math.min(v.w / 12, 64));
      ar.text(title, v.cx, v.cy - size * 0.4, { size, align: "center", color: opts.color || "#ff3b30", font: "Impact, 'Arial Black', sans-serif", weight: "normal", alpha: opts.alpha });
      if (sub) ar.text(sub, v.cx, v.cy + size * 0.55, { size: size * 0.38, align: "center", alpha: opts.alpha });
    };

    ar.flash = (color, alpha) => {
      if (alpha <= 0.01) return;
      ctx.save();
      ctx.globalAlpha = Math.min(alpha, 1);
      ctx.fillStyle = color;
      ctx.fillRect(ar.view.x, ar.view.y, ar.view.w, ar.view.h);
      ctx.restore();
    };

    ar.crosshair = (color = "rgba(255,255,255,0.85)", size = 12, gap = 4) => {
      const { cx, cy } = ar.view;
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      [[-1, 0], [1, 0], [0, -1], [0, 1]].forEach(([dx, dy]) => {
        ctx.moveTo(cx + dx * gap, cy + dy * gap);
        ctx.lineTo(cx + dx * size, cy + dy * size);
      });
      ctx.stroke();
      ctx.restore();
    };

    // Arrow at the edge of the video pointing toward an off-screen (or
    // behind-the-camera) world point. No-op if it's visible.
    ar.edgeArrow = (wx, wy, h, color, label) => {
      const p = ar.project(wx, wy, h);
      if (ar.onScreen(p, -10)) return;
      const rel = ar.toCamera(wx, wy);
      const v = ar.view;
      const angle = Math.atan2(rel.right, rel.forward); // 0 = straight ahead, + = to the right
      const rx = v.w / 2 - 28;
      const ry = v.h / 2 - 28;
      // Straight ahead but above/below the frame (tilted away): point up/down instead.
      let dirX = Math.sin(angle);
      let dirY = -Math.cos(angle);
      if (p && Math.abs(angle) < 0.6) {
        dirX = (p.x - v.cx) / v.w;
        dirY = (p.y - v.cy) / v.h;
        const len = Math.hypot(dirX, dirY) || 1;
        dirX /= len;
        dirY /= len;
      }
      const t = 1 / Math.max(Math.abs(dirX) / rx, Math.abs(dirY) / ry);
      const x = v.cx + dirX * t;
      const y = v.cy + dirY * t;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(Math.atan2(dirY, dirX));
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(-8, -10);
      ctx.lineTo(-3, 0);
      ctx.lineTo(-8, 10);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      ctx.restore();
      if (label) ar.text(label, x - dirX * 22, y - dirY * 22 + 5, { size: 12, align: "center", color });
    };

    // Round radar at the top-center of the video, camera heading up.
    // blips: [{x, y, color, r}] in world meters.
    ar.radar = (blips, rangeM) => {
      const v = ar.view;
      const R = Math.max(36, Math.min(60, v.h * 0.11));
      const cx = v.cx;
      const cy = v.y + R + 10;
      ctx.save();
      ctx.fillStyle = "rgba(0, 20, 0, 0.55)";
      ctx.strokeStyle = "rgba(90, 255, 120, 0.7)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, 2 * Math.PI);
      ctx.fill();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, R / 2, 0, 2 * Math.PI);
      ctx.strokeStyle = "rgba(90, 255, 120, 0.25)";
      ctx.stroke();
      // Field-of-view wedge.
      const halfFov = Lynx.lens.angleAt(v.imgW / 2, v.imgW, v.imgH);
      ctx.fillStyle = "rgba(90, 255, 120, 0.12)";
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, -Math.PI / 2 - halfFov, -Math.PI / 2 + halfFov);
      ctx.closePath();
      ctx.fill();
      blips.forEach((b) => {
        const rel = ar.toCamera(b.x, b.y);
        let bx = rel.right / rangeM;
        let by = -rel.forward / rangeM;
        const d = Math.hypot(bx, by);
        if (d > 1) {
          bx /= d;
          by /= d;
        }
        ctx.fillStyle = b.color;
        ctx.beginPath();
        ctx.arc(cx + bx * (R - 3), cy + by * (R - 3), b.r || 3, 0, 2 * Math.PI);
        ctx.fill();
      });
      ctx.fillStyle = "#fff";
      ctx.beginPath();
      ctx.moveTo(cx, cy - 5);
      ctx.lineTo(cx - 4, cy + 4);
      ctx.lineTo(cx + 4, cy + 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    };

    // -- frame loop -----------------------------------------------------------

    ar.onFrame = (cb) => frameCallbacks.push(cb);

    // Must box a be drawn before box b (+1), after it (-1), or can't they
    // overlap on screen (0)? Two separate boxes always have a gap between
    // them along one of the axes; the one on the camera's side of that gap
    // may cover the other, never the other way round. With the camera IN the
    // gap, no line of sight passes through both (along that axis it moves
    // toward one of them only), so neither covers the other -- saying
    // otherwise invents constraints that can form cycles (the camera
    // standing between walls in a maze), which then get broken wrongly.
    const AXES = [["f0", "f1", "f"], ["r0", "r1", "r"], ["h0", "h1", "h"]];
    function boxOrder(a, b) {
      const cam = a.frame.cam;
      for (const [lo, hi, c] of AXES) {
        if (a[hi] <= b[lo] + 1e-6) return cam[c] > b[lo] ? 1 : cam[c] < a[hi] ? -1 : 0;
        if (b[hi] <= a[lo] + 1e-6) return cam[c] < b[hi] ? 1 : cam[c] > a[lo] ? -1 : 0;
      }
      return 0; // they intersect: nothing exact to say
    }

    ar.flush = () => {
      const items = queueItems;
      queueItems = [];
      items.sort((a, b) => b.depth - a.depth); // painter's order: farthest first
      if (items.filter((it) => it.box).length > 1) {
        // Topological sort: boxes wait for the boxes they may cover; among
        // the ones free to go, the farthest goes first (unboxed items just
        // keep their depth order).
        const n = items.length;
        const after = items.map(() => []);
        const waits = new Array(n).fill(0);
        for (let i = 0; i < n; i++) {
          const a = items[i].box;
          if (!a) continue;
          for (let j = i + 1; j < n; j++) {
            const b = items[j].box;
            if (!b || b.frame !== a.frame) continue;
            const o = boxOrder(a, b);
            if (o > 0) {
              after[i].push(j);
              waits[j]++;
            } else if (o < 0) {
              after[j].push(i);
              waits[i]++;
            }
          }
        }
        const done = new Array(n).fill(false);
        for (let k = 0; k < n; k++) {
          let pick = -1;
          for (let i = 0; i < n; i++) {
            if (!done[i] && waits[i] === 0) {
              pick = i;
              break;
            }
          }
          if (pick < 0) pick = done.indexOf(false); // a cycle (rare): break it by depth
          done[pick] = true;
          after[pick].forEach((j) => waits[j]--);
          items[pick].draw();
        }
        return;
      }
      items.forEach((it) => it.draw());
    };

    const unsubscribe = subscribeToPose((pose) => {
      ar.pose = pose;
      ar.camTheta = pose.theta + (pose.servoAngleDeg * Math.PI) / 180;
      ar.tilt = calib.tiltRad - (pose.tiltAngleDeg * Math.PI) / 180;
      updateView();
      const now = performance.now();
      const dt = lastFrameMs === null ? 0 : Math.max(0, Math.min((now - lastFrameMs) / 1000, 0.1));
      lastFrameMs = now;
      // jump / fall physics
      if (!ar.airborne && ar.z > ar.ground + 1e-4) {
        ar.airborne = true; // walked off an edge
        ar.vz = 0;
      }
      if (ar.airborne) {
        // exact for constant gravity, so the jump height doesn't depend on the frame rate
        ar.z += ar.vz * dt - 0.5 * GRAVITY * dt * dt;
        ar.vz -= GRAVITY * dt;
        if (ar.vz <= 0 && ar.z <= ar.ground) {
          ar.z = ar.ground;
          ar.vz = 0;
          ar.airborne = false;
          ar.landedAt = now; // games can react to a landing
        }
      } else {
        ar.z = ar.ground;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      frameCallbacks.forEach((cb) => cb(now, dt));
    });

    // Tear-down for switching games in-page (see cam.js setupModeSelect):
    // stops the frame loop, runs the game's own cleanups, removes its canvas
    // and on-screen buttons.
    const cleanups = [];
    ar.onDestroy = (cb) => cleanups.push(cb);
    ar.destroy = () => {
      unsubscribe();
      frameCallbacks.length = 0;
      cleanups.splice(0).forEach((cb) => cb());
      canvas.remove();
      const bar = document.querySelector(".game-touch-ui");
      if (bar) bar.remove();
    };

    return ar;
  };

  // -- helpers shared by games ------------------------------------------------

  Lynx.randomAround = (x, y, minR, maxR) => {
    const a = Math.random() * 2 * Math.PI;
    const r = minR + Math.random() * (maxR - minR);
    return { x: x + r * Math.cos(a), y: y + r * Math.sin(a) };
  };

  // Touch-friendly on-screen buttons for games (bottom-right, above the
  // action button). Returns the container; games add buttons with add().
  Lynx.touchButtons = () => {
    let bar = document.querySelector(".game-touch-ui");
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "game-touch-ui";
      document.querySelector(".cam-fullscreen").appendChild(bar);
    }
    return {
      el: bar,
      add(label, onClick) {
        const b = document.createElement("button");
        b.className = "cam-overlay-btn";
        b.textContent = label;
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          Lynx.sfx.unlock();
          onClick();
        });
        bar.appendChild(b);
        return b;
      },
    };
  };
})(window.Lynx);
