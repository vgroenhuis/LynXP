// The tagged cubes as cover in a shooter (Demons, Poop Shooter, David): put
// cubes with AprilTags on the floor and the game finds them with the camera
// (cubes.js) -- then they're solid, as the real things are: monsters walk
// round them, shots, arrows and bombs stop at them, a blast doesn't reach
// through, and the robot's drive commands stop short of them (no pushing a
// cube along). All in world coordinates (m), like the games.
//
// Lynx.cubeCover(ar, app, opts) -> cover; it stops with the ar.
//   opts: {clear: how far the robot's centre keeps from a cube's side (m),
//          lookahead: s, where a stop will take effect (the robot's speed)}
//   cover.update(dt): the cubes seen now (call once a frame)
//   cover.list: [{x, y, yaw, half, h0, h1, tag}] (the cubes in play)
//   cover.wallAt(x, y, h, m = 0): is the point in a cube (grown by m)?
//   cover.blocked(x0, y0, x1, y1, m = 0, minTop = 0): does the floor segment
//     run into one (at least minTop high)?
//   cover.slide(e, nx, ny, r): the creature e ({x, y}) walks to (nx, ny):
//     where it ends up, round a cube in the way (its radius r) -> [x, y]
//   cover.steer(x, y, mx, my, r): a heading (mx, my) turned along a cube's
//     side when it runs into one -> [mx, my]
//   cover.filterDrive(j1, j2, vel): the part of a drive command pointing into a
//     cube that's within `clear` of the robot taken out, or null (no cubes)
//   cover.draw(w): faint outlines of the cubes (w: a Lynx.world3d)

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const COL = "rgba(120,235,255,0.55)";

  Lynx.cubeCover = (ar, app, opts = {}) => {
    const clear = opts.clear || 0.2;
    const lookahead = opts.lookahead == null ? 0.3 : opts.lookahead;
    let layer = null;
    try {
      layer = Lynx.cubeLayer ? Lynx.cubeLayer(ar, app, {}) : null;
    } catch (e) {
      layer = null; // (no tag finder here: no cover)
    }
    const cover = { list: [], layer };

    // a point in the cube's own frame (u along its yaw, v across)
    const local = (b, x, y) => {
      const c = Math.cos(b.yaw || 0);
      const s = Math.sin(b.yaw || 0);
      const dx = x - b.x;
      const dy = y - b.y;
      return [dx * c + dy * s, -dx * s + dy * c];
    };
    const toWorld = (b, u, v) => {
      const c = Math.cos(b.yaw || 0);
      const s = Math.sin(b.yaw || 0);
      return [b.x + u * c - v * s, b.y + u * s + v * c];
    };
    // the nearest point of the cube's square to (x, y) and how far it is (negative: inside, how deep)
    function nearest(b, x, y) {
      const [u, v] = local(b, x, y);
      const h = b.half;
      const cu = Math.max(-h, Math.min(h, u));
      const cv = Math.max(-h, Math.min(h, v));
      if (cu !== u || cv !== v) {
        const [qx, qy] = toWorld(b, cu, cv);
        const d = Math.hypot(x - qx, y - qy);
        return { qx, qy, d, nx: (x - qx) / d, ny: (y - qy) / d };
      }
      // inside: out through the nearest side
      const du = h - Math.abs(u);
      const dv = h - Math.abs(v);
      const [ou, ov] = du < dv ? [Math.sign(u) || 1, 0] : [0, Math.sign(v) || 1];
      const [qx, qy] = toWorld(b, du < dv ? ou * h : u, du < dv ? v : ov * h);
      const c = Math.cos(b.yaw || 0);
      const s = Math.sin(b.yaw || 0);
      return { qx, qy, d: -Math.min(du, dv), nx: ou * c - ov * s, ny: ou * s + ov * c };
    }
    cover.nearest = nearest;

    cover.update = () => {
      const all = layer && layer.blocks ? layer.blocks() || [] : [];
      // (a stack is one cube's footprint: the lowest h0 to the highest h1)
      cover.list = all.filter((b) => b && b.half > 0).map((b) => ({ x: b.x, y: b.y, yaw: b.yaw || 0, half: b.half, h0: b.h0 || 0, h1: b.h1 || 2 * b.half, tag: b.tag }));
    };
    cover.wallAt = (x, y, h, m = 0) =>
      cover.list.some((b) => h <= b.h1 + m && h >= b.h0 - m && nearest(b, x, y).d < m);
    // Liang-Barsky in the cube's frame
    cover.blocked = (x0, y0, x1, y1, m = 0, minTop = 0) =>
      cover.list.some((b) => {
        if (b.h1 < minTop) return false;
        const [u0, v0] = local(b, x0, y0);
        const [u1, v1] = local(b, x1, y1);
        const h = b.half + m;
        let t0 = 0;
        let t1 = 1;
        const du = u1 - u0;
        const dv = v1 - v0;
        for (const [p, q] of [[-du, u0 + h], [du, h - u0], [-dv, v0 + h], [dv, h - v0]]) {
          if (Math.abs(p) < 1e-12) {
            if (q < 0) return false;
          } else {
            const t = q / p;
            if (p < 0) t0 = Math.max(t0, t);
            else t1 = Math.min(t1, t);
            if (t0 > t1) return false;
          }
        }
        return true;
      });
    cover.slide = (e, nx, ny, r) => {
      let x = nx;
      let y = ny;
      cover.list.forEach((b) => {
        const n = nearest(b, x, y);
        if (n.d < r) {
          x += n.nx * (r - n.d);
          y += n.ny * (r - n.d);
        }
      });
      return [x, y];
    };
    cover.steer = (x, y, mx, my, r, side = 1) => {
      let ax = mx;
      let ay = my;
      cover.list.forEach((b) => {
        const n = nearest(b, x, y);
        if (n.d > r + 0.12) return;
        const into = -(ax * n.nx + ay * n.ny);
        if (into <= 0) return;
        // along the side: the way the heading already leans (or `side`, head on)
        const tx = -n.ny;
        const ty = n.nx;
        const along = ax * tx + ay * ty;
        const sg = Math.abs(along) > 0.05 * Math.hypot(ax, ay) ? Math.sign(along) : side;
        const k = 1 - Math.max(0, n.d - r) / 0.12;
        ax += (n.nx * into + tx * sg * into * 1.2) * k;
        ay += (n.ny * into + ty * sg * into * 1.2) * k;
      });
      return [ax, ay];
    };
    cover.filterDrive = (j1, j2, vel = { x: 0, y: 0 }) => {
      if (!cover.list.length) return null;
      const t = ar.camTheta;
      let vx = j2 * Math.cos(t) + j1 * Math.sin(t);
      let vy = j2 * Math.sin(t) - j1 * Math.cos(t);
      const px = ar.pose.x + vel.x * lookahead;
      const py = ar.pose.y + vel.y * lookahead;
      const cs = [];
      cover.list.forEach((b) => {
        const n = nearest(b, px, py);
        if (n.d < clear) cs.push({ x: n.nx, y: n.ny });
      });
      if (!cs.length) return null;
      for (let pass = 0; pass < 3; pass++) {
        let changed = false;
        cs.forEach((c) => {
          const dot = vx * c.x + vy * c.y;
          if (dot < -1e-6) {
            vx -= dot * c.x;
            vy -= dot * c.y;
            changed = true;
          }
        });
        if (!changed) break;
      }
      if (cs.some((c) => vx * c.x + vy * c.y < -1e-3)) vx = vy = 0; // (wedged between two)
      return { j1: vx * Math.sin(t) - vy * Math.cos(t), j2: vx * Math.cos(t) + vy * Math.sin(t) };
    };
    cover.draw = (w) => {
      if (w && w.line3) {
        cover.list.forEach((b) => {
          const h = b.half;
          const ring = (z) =>
            [[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]].map(([u, v]) => {
              const l = w.toLocal(...toWorld(b, u, v));
              return [l.f, l.r, z];
            });
          w.line3(ring(b.h0 + 0.001), COL, 1.5, 0.01);
          w.line3(ring(b.h1), COL, 1.5, 0.01);
          const lo = ring(b.h0 + 0.001);
          const hi = ring(b.h1);
          for (let k = 0; k < 4; k++) w.line3([lo[k], hi[k]], COL, 1.5, 0.01);
        });
      }
    };
    return cover;
  };
})(window.Lynx);
