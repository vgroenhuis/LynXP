// Shared AR engine for the first-person-view games (game_*.js) and apps.
//
// World frame = the robot's odometry frame (meters, x/y on the floor, h up).
// Every frame the live pose (cam.js's subscribeToPose(), interpolated to the
// display rate) gives the camera's position and aim: chassis heading + pan
// servo, tilt = mounting tilt minus the tilt servo. Points are projected with
// a tilt-aware pinhole (calibrated height/tilt from the Main page, focal
// length from the lens calibration's image center), then mapped onto the
// letterboxed <img> ("object-fit: contain"). Deliberately WITHOUT the lens's
// barrel distortion, unlike cam.js's floor grid and coordinate frame (which
// must line up with the video): straight edges stay straight, and a wall
// passing right by the lens still projects sensibly -- the distortion model
// folds points far off-axis back toward the center, which made faces close
// to the player vanish.
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
  const SLOPE_FOLLOW_M = 0.015; // a drop in the ground up to this much per frame isn't a fall
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

  // -- procedural stone textures -----------------------------------------------
  // Generated once per kind (deterministic, from a seed): stone blocks in
  // courses with recessed mortar, a little relief on each block, mottling,
  // hairline cracks and grain. Tiles seamlessly in both directions. Walls:
  // 256 x 128 px = 0.6 x 0.3 m (one storey); floors: 128 x 128 px = 0.3 m.
  const TEXTURE_KINDS = {
    sandstone: { w: 256, h: 128, rows: 4, base: [200, 166, 112], vary: 16, mortar: [112, 88, 56], seed: 7, grime: 0.22 },
    crypt: { w: 256, h: 128, rows: 4, base: [124, 112, 92], vary: 12, mortar: [62, 54, 42], seed: 11, grime: 0.3, moss: true },
    flagstone: { w: 128, h: 128, grid: 2, base: [184, 152, 104], vary: 14, mortar: [92, 72, 46], seed: 3 },
    darkflag: { w: 128, h: 128, grid: 2, base: [96, 80, 58], vary: 10, mortar: [40, 32, 22], seed: 5 },
    // more wall stones, so each floor / wing / section of a level has its own color
    moonstone: { w: 256, h: 128, rows: 4, base: [112, 120, 164], vary: 12, mortar: [48, 52, 84], seed: 13, grime: 0.2 },
    redstone: { w: 256, h: 128, rows: 4, base: [178, 100, 72], vary: 14, mortar: [88, 44, 30], seed: 17, grime: 0.22 },
    seastone: { w: 256, h: 128, rows: 4, base: [86, 130, 126], vary: 12, mortar: [34, 60, 58], seed: 19, grime: 0.3, moss: true },
  };
  const textureCache = new Map();
  function seededRandom(seed) {
    let s = seed | 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeTexture(k) {
    const { w, h } = k;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    const rand = seededRandom(k.seed);
    const rgb = (a) => `rgb(${a.map((v) => Math.max(0, Math.min(255, Math.round(v)))).join(",")})`;
    // draws at (x, y) and wherever it wraps around the edges
    const wrapped = (x, y, bw, bh, fn) => {
      [0, -w, w].forEach((dx) => [0, -h, h].forEach((dy) => {
        if (x + dx < w && x + dx + bw > 0 && y + dy < h && y + dy + bh > 0) fn(x + dx, y + dy);
      }));
    };
    g.fillStyle = rgb(k.mortar);
    g.fillRect(0, 0, w, h);
    const blocks = [];
    if (k.rows) {
      const rh = h / k.rows;
      for (let row = 0; row < k.rows; row++) {
        const start = rand() * w;
        let x = start;
        while (x < start + w - 1) {
          let bw = 46 + rand() * 60;
          if (start + w - (x + bw) < 36) bw = start + w - x;
          blocks.push({ x, y: row * rh, w: bw, h: rh });
          x += bw;
        }
      }
    } else {
      const s = w / k.grid;
      for (let i = 0; i < k.grid; i++) for (let j = 0; j < k.grid; j++) blocks.push({ x: i * s, y: j * s, w: s, h: s });
    }
    blocks.forEach((b) => {
      const t = (rand() - 0.5) * 2 * k.vary;
      const col = k.base.map((v) => v + t + (rand() - 0.5) * 8);
      wrapped(b.x, b.y, b.w, b.h, (x, y) => {
        g.fillStyle = rgb(col);
        g.fillRect(x + 1.5, y + 1.5, b.w - 3, b.h - 3);
        g.fillStyle = "rgba(255,244,220,0.16)"; // lit top edge
        g.fillRect(x + 1.5, y + 1.5, b.w - 3, 2);
        g.fillStyle = "rgba(0,0,0,0.2)"; // shadowed bottom and side
        g.fillRect(x + 1.5, y + b.h - 4, b.w - 3, 2.5);
        g.fillStyle = "rgba(0,0,0,0.1)";
        g.fillRect(x + b.w - 4, y + 1.5, 2.5, b.h - 3);
      });
    });
    // mottling: soft light and dark patches
    for (let n = 0; n < 45; n++) {
      const x = rand() * w;
      const y = rand() * h;
      const r = 6 + rand() * 22;
      const dark = rand() < 0.6;
      const tint = k.moss && rand() < 0.3 ? "60,80,40" : dark ? "40,25,10" : "255,240,210";
      wrapped(x - r, y - r, 2 * r, 2 * r, (px, py) => {
        const grad = g.createRadialGradient(px + r, py + r, 0, px + r, py + r, r);
        grad.addColorStop(0, `rgba(${tint},${dark ? 0.13 : 0.08})`);
        grad.addColorStop(1, `rgba(${tint},0)`);
        g.fillStyle = grad;
        g.fillRect(px, py, 2 * r, 2 * r);
      });
    }
    // hairline cracks
    g.strokeStyle = "rgba(30,18,6,0.35)";
    g.lineWidth = 1;
    for (let n = 0; n < 7; n++) {
      let x = rand() * w;
      let y = rand() * h;
      let a = rand() * Math.PI * 2;
      g.beginPath();
      g.moveTo(x, y);
      for (let s = 0; s < 6; s++) {
        a += (rand() - 0.5) * 1.2;
        x += Math.cos(a) * 4;
        y += Math.sin(a) * 4;
        g.lineTo(x, y);
      }
      g.stroke();
    }
    // grain, and grime collecting toward the floor
    const img = g.getImageData(0, 0, w, h);
    const d = img.data;
    for (let y = 0; y < h; y++) {
      const grime = k.grime ? 1 - k.grime * Math.max(0, (y / h - 0.7) / 0.3) : 1;
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const n = (rand() - 0.5) * 26;
        d[i] = (d[i] + n) * grime;
        d[i + 1] = (d[i + 1] + n) * grime;
        d[i + 2] = (d[i + 2] + n * 0.8) * grime;
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  // Detail overlays: transparent textures of just seams, relief, mottling,
  // cracks (and marble veins), drawn over a surface's own flat color -- so a
  // red door, a marble platform or a see-through floor gets stone detail and
  // keeps its color. 128 x 128 px = 0.3 m, slabs of 0.15 m, tiling.
  const DETAIL_KINDS = {
    slab: { seed: 21, seam: 0.5, cracks: 6 },
    marble: { seed: 23, seam: 0.32, cracks: 2, veins: 7 },
  };
  function makeDetail(k) {
    const w = 128;
    const h = 128;
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d");
    const rand = seededRandom(k.seed);
    const wrapped = (x, y, bw, bh, fn) => {
      [0, -w, w].forEach((dx) => [0, -h, h].forEach((dy) => {
        if (x + dx < w && x + dx + bw > 0 && y + dy < h && y + dy + bh > 0) fn(x + dx, y + dy);
      }));
    };
    const s = w / 2;
    for (let i = 0; i < 2; i++) {
      for (let j = 0; j < 2; j++) {
        const x = i * s;
        const y = j * s;
        // a slab: slightly lighter or darker than its neighbours, lit edge, shadowed edge
        g.fillStyle = rand() < 0.5 ? `rgba(255,245,225,${(0.03 + rand() * 0.05).toFixed(3)})` : `rgba(30,20,8,${(0.03 + rand() * 0.06).toFixed(3)})`;
        g.fillRect(x + 1.5, y + 1.5, s - 3, s - 3);
        g.fillStyle = "rgba(255,248,230,0.22)";
        g.fillRect(x + 1.5, y + 1.5, s - 3, 2);
        g.fillStyle = "rgba(0,0,0,0.22)";
        g.fillRect(x + 1.5, y + s - 4, s - 3, 2.5);
        g.fillRect(x + s - 4, y + 1.5, 2.5, s - 3);
      }
    }
    // the joints between slabs
    g.fillStyle = `rgba(20,12,4,${k.seam})`;
    for (let n = 0; n <= 2; n++) {
      g.fillRect(n * s - 1.5, 0, 3, h);
      g.fillRect(0, n * s - 1.5, w, 3);
    }
    for (let n = 0; n < 30; n++) {
      const x = rand() * w;
      const y = rand() * h;
      const r = 5 + rand() * 18;
      const dark = rand() < 0.6;
      const tint = dark ? "40,25,10" : "255,240,210";
      wrapped(x - r, y - r, 2 * r, 2 * r, (px, py) => {
        const grad = g.createRadialGradient(px + r, py + r, 0, px + r, py + r, r);
        grad.addColorStop(0, `rgba(${tint},${dark ? 0.12 : 0.09})`);
        grad.addColorStop(1, `rgba(${tint},0)`);
        g.fillStyle = grad;
        g.fillRect(px, py, 2 * r, 2 * r);
      });
    }
    const squiggle = (n, step, turn, style, width) => {
      g.strokeStyle = style;
      g.lineWidth = width;
      g.lineCap = "round";
      let x = rand() * w;
      let y = rand() * h;
      let a = rand() * Math.PI * 2;
      for (let q = 0; q < n; q++) {
        const x0 = x;
        const y0 = y;
        a += (rand() - 0.5) * turn;
        x += Math.cos(a) * step;
        y += Math.sin(a) * step;
        wrapped(Math.min(x0, x) - 2, Math.min(y0, y) - 2, Math.abs(x - x0) + 4, Math.abs(y - y0) + 4, (px, py) => {
          const ox = px - (Math.min(x0, x) - 2);
          const oy = py - (Math.min(y0, y) - 2);
          g.beginPath();
          g.moveTo(x0 + ox, y0 + oy);
          g.lineTo(x + ox, y + oy);
          g.stroke();
        });
        x = ((x % w) + w) % w;
        y = ((y % h) + h) % h;
      }
    };
    for (let n = 0; n < (k.veins || 0); n++) squiggle(14, 6, 0.9, `rgba(70,70,80,${(0.12 + rand() * 0.14).toFixed(3)})`, 1 + rand());
    for (let n = 0; n < k.cracks; n++) squiggle(6, 4, 1.2, "rgba(30,18,6,0.4)", 1);
    // grain: alpha-only speckle
    const img = g.getImageData(0, 0, w, h);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      const n = rand();
      if (n < 0.12) {
        const a = d[i + 3] / 255;
        const add = 0.1 * (1 - a);
        d[i] = (d[i] * a) / (a + add);
        d[i + 1] = (d[i + 1] * a) / (a + add);
        d[i + 2] = (d[i + 2] * a) / (a + add);
        d[i + 3] = Math.round((a + add) * 255);
      }
    }
    g.putImageData(img, 0, 0);
    return c;
  }
  Lynx.texture = (name) => {
    const kind = TEXTURE_KINDS[name] || DETAIL_KINDS[name];
    if (!kind) return null;
    if (!textureCache.has(name)) textureCache.set(name, TEXTURE_KINDS[name] ? makeTexture(kind) : makeDetail(kind));
    return textureCache.get(name);
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
      const lens = Lynx.lens.params(imgW, imgH);
      ar.view = {
        cw, ch, imgW, imgH, scale, offX: x, offY: y, x, y, w, h,
        f: lens.f, // near the image center; see Lynx.lens
        cx: x + lens.cx * scale, // the optical center (the image center unless calibrated)
        cy: y + lens.cy * scale,
      };
    }

    // Camera-frame point (x right, y down, z forward; z > 0) -> screen.
    function pinhole(x, y, z) {
      const v = ar.view;
      return { x: v.cx + ((v.f * x) / z) * v.scale, y: v.cy + ((v.f * y) / z) * v.scale };
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
      const p = pinhole(rel.right, yc, zc);
      return { x: p.x, y: p.y, depth: zc, ppm: (v.f * v.scale) / zc };
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
    // A low ceiling over the player: the highest ar.z may go (Infinity: none).
    // Games under a ceiling set it every frame. A jump under it stays as long
    // as in the open -- only the view stops at the ceiling while the arc goes
    // on unseen -- so a pit you can jump in the open you can jump under a
    // ceiling too, however high the camera sits.
    let arcZ = 0; // the jump arc's height (ar.z is it, capped by the ceiling)
    let shownZ = 0; // ar.z as set here last: a game that sets ar.z itself restarts the arc from there
    ar.ceiling = Infinity;
    ar.setCeiling = (z) => {
      ar.ceiling = z;
      if (ar.z > z) {
        ar.z = Math.max(ar.ground, z);
        shownZ = ar.z;
      }
    };

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

    // Part of a texture on a small world quad: corners [x, y, h] (in order
    // around it) get texture pixels uv [{u, v}] (same order). Drawn as two
    // affinely mapped triangles -- fine for quads small on screen relative to
    // their depth, so callers cut big surfaces into pieces. Returns false
    // (drawing nothing) if a corner is too close or behind the lens.
    function texTriangle(img, s0, s1, s2, t0, t1, t2) {
      const du1 = t1.u - t0.u;
      const dv1 = t1.v - t0.v;
      const du2 = t2.u - t0.u;
      const dv2 = t2.v - t0.v;
      const det = du1 * dv2 - du2 * dv1;
      if (Math.abs(det) < 1e-9) return;
      const dx1 = s1.x - s0.x;
      const dy1 = s1.y - s0.y;
      const dx2 = s2.x - s0.x;
      const dy2 = s2.y - s0.y;
      const a = (dx1 * dv2 - dx2 * dv1) / det;
      const b = (dy1 * dv2 - dy2 * dv1) / det;
      const c = (dx2 * du1 - dx1 * du2) / det;
      const d = (dy2 * du1 - dy1 * du2) / det;
      // clip slightly larger than the triangle, so neighbours leave no hairline seams
      const cx = (s0.x + s1.x + s2.x) / 3;
      const cy = (s0.y + s1.y + s2.y) / 3;
      const grow = (p) => {
        const dx = p.x - cx;
        const dy = p.y - cy;
        const len = Math.hypot(dx, dy) || 1;
        return [p.x + (dx / len) * 0.7, p.y + (dy / len) * 0.7];
      };
      ctx.save();
      ctx.beginPath();
      [s0, s1, s2].map(grow).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      ctx.clip();
      ctx.transform(a, b, c, d, s0.x - a * t0.u - c * t0.v, s0.y - b * t0.u - d * t0.v);
      ctx.drawImage(img, 0, 0);
      ctx.restore();
    }
    ar.texturedQuad = (pts, img, uv) => {
      const s = pts.map((p) => ar.project(p[0], p[1], p[2]));
      if (s.some((p) => !p)) return false;
      texTriangle(img, s[0], s[1], s[2], uv[0], uv[1], uv[2]);
      texTriangle(img, s[0], s[2], s[3], uv[0], uv[2], uv[3]);
      return true;
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

    // Arrow at the edge of the screen pointing toward an off-screen (or
    // behind-the-camera) world point. No-op if it's visible. The whole
    // canvas counts, not just the letterboxed video: the virtual scene is
    // drawn over the bars beside the picture too.
    //
    // Direction = the point's direction in the camera's image plane (x
    // right, y down), which is exactly the way it lies on screen when it's
    // in front of the camera: at eye level to the left the arrow points
    // left, not diagonally up-left. Behind the camera the sideways part is
    // stretched by the depth behind (sign kept), so something behind you
    // says "turn left/right" rather than "over the top" -- continuous with
    // the in-front case right beside the camera.
    ar.edgeArrow = (wx, wy, h, color, label) => {
      const EDGE_MARGIN_PX = 28;
      const v = ar.view;
      const p = ar.project(wx, wy, h);
      if (p && p.x >= 10 && p.x <= v.cw - 10 && p.y >= 10 && p.y <= v.ch - 10) return;
      const rel = ar.toCamera(wx, wy);
      const vertical = calib.heightM + ar.z - h;
      const zc = rel.forward * Math.cos(ar.tilt) + vertical * Math.sin(ar.tilt);
      let dirX = rel.right;
      let dirY = vertical * Math.cos(ar.tilt) - rel.forward * Math.sin(ar.tilt);
      if (zc < 0) dirX = (dirX < 0 ? -1 : 1) * Math.hypot(dirX, zc);
      const len = Math.hypot(dirX, dirY);
      if (len < 1e-9) return;
      dirX /= len;
      dirY /= len;
      // From the picture's center out to the canvas edge, minus a margin.
      const rx = Math.max(1, Math.min(v.cx, v.cw - v.cx) - EDGE_MARGIN_PX);
      const ry = Math.max(1, Math.min(v.cy, v.ch - v.cy) - EDGE_MARGIN_PX);
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

    // Screen rectangle a box covers ({x0, y0, x1, y1}), null if it's all
    // behind the lens, undefined if its frame can't place it in the world
    // (frame.toWorld(f, r) -> {x, y}). Edges are clipped at the lens, so a
    // box reaching past the camera still gets its true visible extent.
    function screenBounds(b) {
      const toWorld = b.frame.toWorld;
      if (!toWorld) return undefined;
      const cs = [];
      for (const f of [b.f0, b.f1]) {
        for (const r of [b.r0, b.r1]) {
          const w = toWorld(f, r);
          const rel = ar.toCamera(w.x, w.y);
          for (const h of [b.h0, b.h1]) {
            const vertical = calib.heightM + ar.z - h;
            cs.push({
              x: rel.right,
              y: vertical * Math.cos(ar.tilt) - rel.forward * Math.sin(ar.tilt),
              z: rel.forward * Math.cos(ar.tilt) + vertical * Math.sin(ar.tilt),
            });
          }
        }
      }
      const pts = [];
      for (let i = 0; i < 8; i++) {
        if (cs[i].z >= NEAR_M) pts.push(cs[i]);
        for (const bit of [1, 2, 4]) {
          const j = i ^ bit;
          if (j < i) continue;
          const a = cs[i];
          const c = cs[j];
          if (a.z >= NEAR_M !== c.z >= NEAR_M) {
            const t = (NEAR_M - a.z) / (c.z - a.z);
            pts.push({ x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t, z: NEAR_M });
          }
        }
      }
      let out = null;
      pts.forEach((c) => {
        const { x, y } = pinhole(c.x, c.y, c.z);
        out = out ? { x0: Math.min(out.x0, x), y0: Math.min(out.y0, y), x1: Math.max(out.x1, x), y1: Math.max(out.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
      });
      return out;
    }
    const overlap = (a, b) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

    ar.flush = () => {
      const items = queueItems;
      queueItems = [];
      items.sort((a, b) => b.depth - a.depth); // painter's order: farthest first
      if (items.filter((it) => it.box).length > 1) {
        // Only boxes that overlap on screen need an order between them --
        // ordering ones that don't can chain into a cycle (a covers b may
        // cover c may cover a, each true on its own) that then gets broken
        // the wrong way.
        const bounds = items.map((it) => (it.box ? screenBounds(it.box) : undefined));
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
            if (bounds[i] !== undefined && bounds[j] !== undefined && (!bounds[i] || !bounds[j] || !overlap(bounds[i], bounds[j]))) continue;
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
      ar.tilt = Lynx.cameraDown(calib, pose);
      updateView();
      const now = performance.now();
      const dt = lastFrameMs === null ? 0 : Math.max(0, Math.min((now - lastFrameMs) / 1000, 0.1));
      lastFrameMs = now;
      // jump / fall physics
      // Walked off an edge: fall. A small drop (walking down a slope, like
      // the sanctum's stairs) is just followed.
      if (ar.z !== shownZ) arcZ = ar.z; // a game moved the view
      if (!ar.airborne && arcZ > ar.ground + SLOPE_FOLLOW_M) {
        ar.airborne = true;
        ar.vz = 0;
      }
      if (ar.airborne) {
        // exact for constant gravity, so the jump height doesn't depend on the frame rate
        arcZ += ar.vz * dt - 0.5 * GRAVITY * dt * dt;
        ar.vz -= GRAVITY * dt;
        if (ar.vz <= 0 && arcZ <= ar.ground) {
          arcZ = ar.ground;
          ar.vz = 0;
          ar.airborne = false;
          ar.landedAt = now; // games can react to a landing
        }
      } else {
        arcZ = ar.ground;
      }
      ar.z = Math.min(arcZ, Math.max(ar.ground, ar.ceiling));
      shownZ = ar.z;
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
        // Fire on pointerdown: while another finger holds the drive stick,
        // phones often don't synthesize a click for a second touch. The click
        // that follows a pointerdown is swallowed; a click with no preceding
        // pointerdown (keyboard activation) still works.
        let handledByPointer = false;
        const fire = (e) => {
          e.stopPropagation();
          Lynx.sfx.unlock();
          onClick();
        };
        b.addEventListener("pointerdown", (e) => {
          if (e.pointerType === "mouse" && e.button !== 0) return;
          handledByPointer = true;
          fire(e);
        });
        b.addEventListener("click", (e) => {
          if (handledByPointer) {
            handledByPointer = false;
            e.stopPropagation();
            return;
          }
          fire(e);
        });
        bar.appendChild(b);
        return b;
      },
      // A button held down (e.g. a shield): onDown when pressed, onUp when let go.
      addHold(label, onDown, onUp) {
        const b = document.createElement("button");
        b.className = "cam-overlay-btn";
        b.textContent = label;
        let downNow = false;
        const up = (e) => {
          if (!downNow) return;
          downNow = false;
          if (e) e.stopPropagation();
          onUp();
        };
        b.addEventListener("pointerdown", (e) => {
          if (e.pointerType === "mouse" && e.button !== 0) return;
          e.stopPropagation();
          e.preventDefault();
          Lynx.sfx.unlock();
          try {
            b.setPointerCapture(e.pointerId); // (still ours if the finger slides off)
          } catch (err) {
            // fine without
          }
          downNow = true;
          onDown();
        });
        ["pointerup", "pointercancel", "lostpointercapture"].forEach((ev) => b.addEventListener(ev, up));
        b.addEventListener("click", (e) => e.stopPropagation());
        bar.appendChild(b);
        return b;
      },
    };
  };
})(window.Lynx);
