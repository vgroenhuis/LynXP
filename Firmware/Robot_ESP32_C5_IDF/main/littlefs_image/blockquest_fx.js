// Block Quest's drawing kit (game_blockquest.js): realistic-looking surfaces
// and effects painted over the video -- procedural lava and water that
// flow, textured stone and timber skins for the real blocks, a barrel, fire,
// explosions, embers and smoke. Everything is drawn through a Lynx.world3d
// (floor frame: f forward, r right, h up, meters), in the same depth-sorted
// queue as the knight and the blocks.
//
//   const fx = Lynx.bqFx(ar, w);
//   fx.patch(name, rect, h, {time, tile, flow, alpha, quality})  a textured flat area, flowing
//   fx.skin(b, styleName)           a real block's faces, textured and lit (call where its silhouette was cut out)
//   fx.glowSides(b, rgb, a, frac)   light cast on a block's lower sides (lava, fire)
//   fx.barrel(f, r, z, rad, height, o), fx.flame(f, r, z, size, time), fx.explosion(f, r, z, rad, t)
//   fx.ring(f, r, z, rad, color, width), fx.disc(f, r, z, rad, fill), fx.shadow(f, r, z, rad, a)
//   fx.parts.emit(kind, f, r, h, n) / update(dt) / draw()
//   fx.tex(name) -> canvas: lava, lavaHot, water, wood, planks, scorch, plus ar.js's stones

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };
  function rng(seed) {
    let s = seed | 0;
    return () => {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // tileable value noise (period p cells), octaves summed
  function noiseField(size, period, octaves, seed) {
    const r = rng(seed);
    const grids = [];
    for (let o = 0; o < octaves; o++) {
      const n = period << o;
      const g = new Float32Array(n * n);
      for (let i = 0; i < g.length; i++) g[i] = r();
      grids.push({ n, g });
    }
    const out = new Float32Array(size * size);
    let amp = 1;
    let tot = 0;
    grids.forEach(({ n, g }) => {
      for (let y = 0; y < size; y++) {
        const fy = (y / size) * n;
        const y0 = Math.floor(fy);
        const ty = smooth(0, 1, fy - y0);
        for (let x = 0; x < size; x++) {
          const fx = (x / size) * n;
          const x0 = Math.floor(fx);
          const tx = smooth(0, 1, fx - x0);
          const a = g[(y0 % n) * n + (x0 % n)];
          const b = g[(y0 % n) * n + ((x0 + 1) % n)];
          const c = g[((y0 + 1) % n) * n + (x0 % n)];
          const d = g[((y0 + 1) % n) * n + ((x0 + 1) % n)];
          out[y * size + x] += amp * lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
        }
      }
      tot += amp;
      amp *= 0.5;
    });
    for (let i = 0; i < out.length; i++) out[i] /= tot;
    return out;
  }
  // worley (cellular) distances F1 and F2 on a tileable grid
  function worley(size, cells, seed) {
    const r = rng(seed);
    const pts = [];
    for (let j = 0; j < cells; j++) for (let i = 0; i < cells; i++) pts.push([(i + 0.15 + 0.7 * r()) / cells, (j + 0.15 + 0.7 * r()) / cells]);
    const f1 = new Float32Array(size * size);
    const f2 = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const px = x / size;
        const py = y / size;
        const ci = Math.floor(px * cells);
        const cj = Math.floor(py * cells);
        let d1 = 9;
        let d2 = 9;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = (ci + di + cells) % cells;
            const jj = (cj + dj + cells) % cells;
            const p = pts[jj * cells + ii];
            const ox = ci + di < 0 ? -1 : ci + di >= cells ? 1 : 0;
            const oy = cj + dj < 0 ? -1 : cj + dj >= cells ? 1 : 0;
            const d = Math.hypot(px - (p[0] + ox), py - (p[1] + oy));
            if (d < d1) {
              d2 = d1;
              d1 = d;
            } else if (d < d2) d2 = d;
          }
        }
        f1[y * size + x] = d1;
        f2[y * size + x] = d2;
      }
    }
    return { f1, f2 };
  }
  const canvasOf = (w, h) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    return c;
  };
  const ramp = (stops, t) => {
    t = clamp(t, 0, 1);
    for (let i = 1; i < stops.length; i++) {
      if (t <= stops[i][0]) {
        const [t0, c0] = stops[i - 1];
        const [t1, c1] = stops[i];
        const k = (t - t0) / (t1 - t0 || 1);
        return [lerp(c0[0], c1[0], k), lerp(c0[1], c1[1], k), lerp(c0[2], c1[2], k)];
      }
    }
    return stops[stops.length - 1][1];
  };

  // -- procedural textures ------------------------------------------------------------------
  const MAKERS = {
    // molten rock: a dark crust of plates, glowing white-orange where they part
    lava() {
      const N = 256;
      const { f1, f2 } = worley(N, 9, 5);
      const n1 = noiseField(N, 4, 4, 9);
      const n2 = noiseField(N, 8, 3, 21);
      const c = canvasOf(N, N);
      const g = c.getContext("2d");
      const img = g.createImageData(N, N);
      const HOT = [[0, [70, 8, 0]], [0.3, [190, 40, 2]], [0.65, [255, 118, 18]], [1, [255, 220, 120]]];
      for (let i = 0; i < N * N; i++) {
        const edge = f2[i] - f1[i];
        const crack = 1 - smooth(0.0, 0.026 + 0.03 * n2[i], edge);
        const halo = 1 - smooth(0.0, 0.17, edge);
        const heat = clamp(crack * (0.75 + 0.5 * n1[i]) + 0.3 * halo * halo * (0.4 + n2[i]) + 0.03 * n1[i], 0, 1);
        const plate = smooth(0.35, 0.8, n1[i]) * 0.5 + 0.5 * n2[i];
        const crust = [20 + 34 * plate, 11 + 18 * plate, 8 + 12 * plate];
        const hot = ramp(HOT, heat);
        const k = smooth(0.14, 0.6, heat);
        img.data[i * 4] = lerp(crust[0], hot[0], k);
        img.data[i * 4 + 1] = lerp(crust[1], hot[1], k);
        img.data[i * 4 + 2] = lerp(crust[2], hot[2], k);
        img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      return c;
    },
    // just the glowing cracks, to pulse on top of the lava
    lavaHot() {
      const N = 256;
      const { f1, f2 } = worley(N, 9, 5);
      const n1 = noiseField(N, 4, 4, 9);
      const c = canvasOf(N, N);
      const g = c.getContext("2d");
      const img = g.createImageData(N, N);
      for (let i = 0; i < N * N; i++) {
        const crack = 1 - smooth(0.0, 0.05, f2[i] - f1[i]);
        const a = crack * (0.35 + 0.65 * n1[i]);
        img.data[i * 4] = 255;
        img.data[i * 4 + 1] = 150 + 90 * a;
        img.data[i * 4 + 2] = 40 + 100 * a;
        img.data[i * 4 + 3] = Math.round(255 * a);
      }
      g.putImageData(img, 0, 0);
      return c;
    },
    // deep water: dark teal, wave ridges, caustic lines
    water() {
      const N = 256;
      const a = noiseField(N, 4, 4, 31);
      const b = noiseField(N, 6, 3, 37);
      const c = canvasOf(N, N);
      const g = c.getContext("2d");
      const img = g.createImageData(N, N);
      for (let y = 0; y < N; y++) {
        for (let x = 0; x < N; x++) {
          const i = y * N + x;
          const wv = 0.5 + 0.5 * Math.sin(((x / N) * 6 + a[i] * 4) * Math.PI * 2) * Math.cos(((y / N) * 4 + b[i] * 3) * Math.PI * 2);
          const caustic = 1 - smooth(0, 0.07, Math.abs(a[i] - b[i]));
          const base = [10 + 18 * a[i], 52 + 46 * a[i], 74 + 50 * b[i]];
          const k = 0.35 * wv + 0.9 * caustic * 0.55;
          img.data[i * 4] = clamp(base[0] + 150 * k * 0.6, 0, 255);
          img.data[i * 4 + 1] = clamp(base[1] + 170 * k * 0.8, 0, 255);
          img.data[i * 4 + 2] = clamp(base[2] + 160 * k, 0, 255);
          img.data[i * 4 + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
      return c;
    },
    // timber: planks with grain, seams and nails
    wood() {
      const N = 128;
      const r = rng(77);
      const grain = noiseField(N, 4, 3, 41);
      const c = canvasOf(N, N);
      const g = c.getContext("2d");
      const img = g.createImageData(N, N);
      const planks = 4;
      const hue = Array.from({ length: planks }, () => 0.8 + 0.4 * r());
      for (let y = 0; y < N; y++) {
        const pl = Math.floor((y / N) * planks);
        for (let x = 0; x < N; x++) {
          const i = y * N + x;
          const gx = grain[((y * 7) % N) * N + ((x * 1) % N)];
          const streak = 0.5 + 0.5 * Math.sin(x * 0.11 + gx * 14 + pl * 3);
          const k = hue[pl] * (0.78 + 0.26 * streak) * (0.9 + 0.2 * grain[i]);
          img.data[i * 4] = clamp(138 * k, 0, 255);
          img.data[i * 4 + 1] = clamp(92 * k, 0, 255);
          img.data[i * 4 + 2] = clamp(52 * k, 0, 255);
          img.data[i * 4 + 3] = 255;
        }
      }
      g.putImageData(img, 0, 0);
      g.fillStyle = "rgba(25,14,6,0.8)";
      for (let p = 0; p < planks; p++) g.fillRect(0, (p * N) / planks, N, 2);
      g.fillStyle = "rgba(40,36,34,0.9)";
      for (let p = 0; p < planks; p++) [10, N - 10].forEach((x) => {
        g.beginPath();
        g.arc(x, (p * N) / planks + N / planks / 2, 2.2, 0, 2 * Math.PI);
        g.fill();
      });
      return c;
    },
    // scorched ground: dark soot with a faint red heat
    scorch() {
      const N = 128;
      const n = noiseField(N, 4, 4, 51);
      const c = canvasOf(N, N);
      const g = c.getContext("2d");
      const img = g.createImageData(N, N);
      for (let i = 0; i < N * N; i++) {
        const v = 20 + 30 * n[i];
        img.data[i * 4] = v + 14 * smooth(0.6, 0.9, n[i]);
        img.data[i * 4 + 1] = v * 0.8;
        img.data[i * 4 + 2] = v * 0.7;
        img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      return c;
    },
    // old bone-white marble slabs for altars and tablets
    ivory() {
      const N = 128;
      const n = noiseField(N, 4, 4, 61);
      const c = canvasOf(N, N);
      const g = c.getContext("2d");
      const img = g.createImageData(N, N);
      for (let i = 0; i < N * N; i++) {
        const v = 196 + 40 * n[i];
        img.data[i * 4] = v;
        img.data[i * 4 + 1] = v - 6;
        img.data[i * 4 + 2] = v - 22;
        img.data[i * 4 + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      return c;
    },
  };

  Lynx.bqFx = (ar, w) => {
    const g = ar.ctx;
    const cache = new Map();
    const patterns = new Map();
    const tex = (name) => {
      if (!cache.has(name)) cache.set(name, MAKERS[name] ? MAKERS[name]() : Lynx.texture && Lynx.texture(name));
      return cache.get(name);
    };
    const pattern = (img) => {
      if (!patterns.has(img)) patterns.set(img, g.createPattern(img, "repeat"));
      return patterns.get(img);
    };

    // -- textured triangles (the texture repeats, so it can slide) --------------------------------
    function tri(img, s0, s1, s2, t0, t1, t2) {
      const v = ar.view;
      const x0 = Math.min(s0.x, s1.x, s2.x);
      const x1 = Math.max(s0.x, s1.x, s2.x);
      const y0 = Math.min(s0.y, s1.y, s2.y);
      const y1 = Math.max(s0.y, s1.y, s2.y);
      if (x1 < v.x || x0 > v.x + v.w || y1 < v.y || y0 > v.y + v.h) return;
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
      const cx = (s0.x + s1.x + s2.x) / 3;
      const cy = (s0.y + s1.y + s2.y) / 3;
      const grow = (p) => {
        const dx = p.x - cx;
        const dy = p.y - cy;
        const len = Math.hypot(dx, dy) || 1;
        return [p.x + (dx / len) * 0.8, p.y + (dy / len) * 0.8];
      };
      g.save();
      g.beginPath();
      [s0, s1, s2].map(grow).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.clip();
      g.transform(a, b, c, d, s0.x - a * t0.u - c * t0.v, s0.y - b * t0.u - d * t0.v);
      g.fillStyle = pattern(img);
      const um = Math.min(t0.u, t1.u, t2.u) - 1;
      const vm = Math.min(t0.v, t1.v, t2.v) - 1;
      g.fillRect(um, vm, Math.max(t0.u, t1.u, t2.u) - um + 2, Math.max(t0.v, t1.v, t2.v) - vm + 2);
      g.restore();
    }
    // a quad given by four floor-frame points [f, r, h], with texture coordinates in pixels
    function quad(img, pts, uv) {
      const s = pts.map((p) => w.project(p[0], p[1], p[2]));
      if (s.some((p) => !p)) return false;
      tri(img, s[0], s[1], s[2], uv[0], uv[1], uv[2]);
      tri(img, s[0], s[2], s[3], uv[0], uv[2], uv[3]);
      return true;
    }

    // -- a flat textured area, flowing --------------------------------------------------------------
    // rect: {f0, f1, r0, r1}; tile: meters per texture repeat; flow: [df, dr] m/s;
    // finer pieces near the camera (the affine texture mapping needs small ones)
    function patch(name, rect, h, o = {}) {
      const img = tex(name);
      if (!img) return;
      const time = o.time || 0;
      const tile = o.tile || 0.16;
      const flow = o.flow || [0, 0];
      const ppm = img.width / tile;
      // o.world: the rect is in world coordinates (x0 = f0, x1 = f1, y0 = r0, y1 = r1), e.g. the level's own frame
      const cw = ar.cameraWorld();
      const cam = o.world ? { f: cw.x, r: cw.y, h: cw.h } : w.camLocal();
      const toFR = o.world ? (x, y) => { const l = w.toLocal(x, y); return [l.f, l.r]; } : (f, r) => [f, r];
      const q = o.quality || 1;
      const old = g.globalAlpha;
      g.globalAlpha = old * (o.alpha === undefined ? 1 : o.alpha);
      if (o.blend) g.globalCompositeOperation = o.blend;
      const uvOf = (f, r) => ({ u: (r - flow[1] * time) * ppm, v: (f - flow[0] * time) * ppm });
      const walk = (f0, f1, r0, r1, depth) => {
        const df = Math.max(0, f0 - cam.f, cam.f - f1);
        const dr = Math.max(0, r0 - cam.r, cam.r - r1);
        const d = Math.hypot(df, dr, Math.max(0, cam.h - h));
        const want = (d < 0.14 ? 0.03 : d < 0.3 ? 0.06 : d < 0.6 ? 0.12 : 0.25) * q;
        if (Math.max(f1 - f0, r1 - r0) > want * 1.01 && depth < 7) {
          const fm = (f0 + f1) / 2;
          const rm = (r0 + r1) / 2;
          walk(f0, fm, r0, rm, depth + 1);
          walk(f0, fm, rm, r1, depth + 1);
          walk(fm, f1, r0, rm, depth + 1);
          walk(fm, f1, rm, r1, depth + 1);
          return;
        }
        const P = [[f1, r0], [f1, r1], [f0, r1], [f0, r0]];
        quad(img, P.map(([f, r]) => [...toFR(f, r), h]), P.map(([f, r]) => uvOf(f, r)));
      };
      // (cut a little at the camera's near plane: pieces entirely behind it draw nothing anyway)
      walk(rect.f0, rect.f1, rect.r0, rect.r1, 0);
      g.globalCompositeOperation = "source-over";
      g.globalAlpha = old;
    }

    // -- skins for the real blocks --------------------------------------------------------------------
    // the light: from above, a little from the left front (floor frame)
    const LIGHT = (() => {
      const v = [0.35, -0.45, 0.82];
      const n = Math.hypot(...v);
      return v.map((x) => x / n);
    })();
    const STYLES = {
      stone: { side: "sandstone", top: "flagstone", tile: 0.1, tint: "rgba(30,22,12,0.0)" },
      dark: { side: "crypt", top: "darkflag", tile: 0.1, tint: "rgba(0,0,0,0.12)" },
      basalt: { side: "darkflag", top: "darkflag", tile: 0.09, tint: "rgba(20,0,0,0.25)" },
      crate: { side: "wood", top: "wood", tile: 0.05, tint: "rgba(0,0,0,0)" },
      red: { side: "redstone", top: "flagstone", tile: 0.1, tint: "rgba(0,0,0,0.05)" },
      moon: { side: "moonstone", top: "flagstone", tile: 0.1, tint: "rgba(0,0,10,0.05)" },
      sea: { side: "seastone", top: "seastone", tile: 0.1, tint: "rgba(0,0,0,0.05)" },
      ivory: { side: "ivory", top: "ivory", tile: 0.1, tint: "rgba(0,0,0,0)" },
    };
    // the corners of a block's footprint, floor frame
    function corners(b) {
      const c = Math.cos(b.yaw);
      const s = Math.sin(b.yaw);
      return [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [b.cf + u * b.half * c - v * b.half * s, b.cr + u * b.half * s + v * b.half * c]);
    }
    const facing = (cam, cs, i, cf, cr) => {
      const p = cs[i];
      const q = cs[(i + 1) % 4];
      const mf = (p[0] + q[0]) / 2;
      const mr = (p[1] + q[1]) / 2;
      return (cam.f - mf) * (mf - cf) + (cam.r - mr) * (mr - cr) > 0;
    };
    // paint a block: textured, lit faces. b: solids entry plus fromB (set by the game)
    function skin(b, styleName, o = {}) {
      const st = STYLES[styleName] || STYLES.stone;
      const cs = corners(b);
      const cam = w.camLocal();
      const n = 3;
      const sideImg = tex(st.side);
      const topImg = tex(st.top);
      const ppm = sideImg.width / st.tile;
      const grow = o.grow || 0.0006; // a hair bigger than the real block: the video's edge doesn't peek out
      const cf = b.cf;
      const cr = b.cr;
      const big = cs.map(([f, r]) => [f + Math.sign(f - cf) * grow, r + Math.sign(r - cr) * grow]);
      for (let i = 0; i < 4; i++) {
        if (!facing(cam, big, i, cf, cr)) continue;
        const A = big[i];
        const B = big[(i + 1) % 4];
        const h0 = b.h0 - 0.0004;
        const h1 = b.h1 + 0.0004;
        const len = Math.hypot(B[0] - A[0], B[1] - A[1]);
        // texture coordinates run along the face and up it; the block's own origin keeps each block's stones the same
        const seed = ((b.tag || 0) * 37 + i * 11) % 7;
        const poly = [[A[0], A[1], h0], [B[0], B[1], h0], [B[0], B[1], h1], [A[0], A[1], h1]].map(([f, r, h]) => w.project(f, r, h));
        if (poly.some((p) => !p)) continue;
        for (let a = 0; a < n; a++) {
          for (let c = 0; c < n; c++) {
            const s0 = a / n;
            const s1 = (a + 1) / n;
            const t0 = c / n;
            const t1 = (c + 1) / n;
            const at = (s, t) => [A[0] + (B[0] - A[0]) * s, A[1] + (B[1] - A[1]) * s, h0 + (h1 - h0) * t];
            const uv = (s, t) => ({ u: (seed * 0.31 + s * len) * ppm, v: (seed * 0.17 + (1 - t) * (h1 - h0)) * ppm });
            quad(sideImg, [at(s0, t0), at(s1, t0), at(s1, t1), at(s0, t1)], [uv(s0, t0), uv(s1, t0), uv(s1, t1), uv(s0, t1)]);
          }
        }
        // lighting by the face's direction, and the darker foot
        const nrm = [(B[1] - A[1]) / len, -(B[0] - A[0]) / len];
        const out = Math.sign(nrm[0] * (A[0] - cf) + nrm[1] * (A[1] - cr));
        const lam = clamp(out * (nrm[0] * LIGHT[0] + nrm[1] * LIGHT[1]) * 1.1 + 0.55, 0.2, 1);
        g.save();
        g.beginPath();
        poly.forEach((p, k) => (k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        g.clip();
        g.fillStyle = `rgba(6,4,2,${(0.5 * (1 - lam)).toFixed(3)})`;
        g.fillRect(v0(poly, "x"), v0(poly, "y"), v1(poly, "x") - v0(poly, "x"), v1(poly, "y") - v0(poly, "y"));
        const lo = { x: (poly[0].x + poly[1].x) / 2, y: (poly[0].y + poly[1].y) / 2 };
        const hi = { x: (poly[2].x + poly[3].x) / 2, y: (poly[2].y + poly[3].y) / 2 };
        const grad = g.createLinearGradient(lo.x, lo.y, hi.x, hi.y);
        grad.addColorStop(0, "rgba(0,0,0,0.35)");
        grad.addColorStop(0.35, "rgba(0,0,0,0)");
        g.fillStyle = grad;
        g.fillRect(v0(poly, "x"), v0(poly, "y"), v1(poly, "x") - v0(poly, "x"), v1(poly, "y") - v0(poly, "y"));
        if (st.tint !== "rgba(0,0,0,0)") {
          g.fillStyle = st.tint;
          g.fillRect(v0(poly, "x"), v0(poly, "y"), v1(poly, "x") - v0(poly, "x"), v1(poly, "y") - v0(poly, "y"));
        }
        g.restore();
        g.strokeStyle = "rgba(8,6,4,0.55)";
        g.lineWidth = 1;
        g.beginPath();
        poly.forEach((p, k) => (k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        g.stroke();
      }
      if (cam.h > b.h1) {
        const T = big.map(([f, r]) => [f, r, b.h1 + 0.0004]);
        const k2 = 2;
        for (let a = 0; a < k2; a++) {
          for (let c = 0; c < k2; c++) {
            const mix = (s, t) => {
              const f = lerp(lerp(T[0][0], T[1][0], s), lerp(T[3][0], T[2][0], s), t);
              const r = lerp(lerp(T[0][1], T[1][1], s), lerp(T[3][1], T[2][1], s), t);
              return [f, r, T[0][2]];
            };
            const s0 = a / k2;
            const s1 = (a + 1) / k2;
            const t0 = c / k2;
            const t1 = (c + 1) / k2;
            const uv = (s, t) => ({ u: (s * b.half * 2 + (b.tag || 0) * 0.13) * ppm, v: (t * b.half * 2) * ppm });
            quad(topImg, [mix(s0, t0), mix(s1, t0), mix(s1, t1), mix(s0, t1)], [uv(s0, t0), uv(s1, t0), uv(s1, t1), uv(s0, t1)]);
          }
        }
        const poly = T.map(([f, r, h]) => w.project(f, r, h));
        if (poly.every(Boolean)) {
          g.save();
          g.fillStyle = "rgba(255,248,230,0.10)";
          g.beginPath();
          poly.forEach((p, k) => (k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
          g.closePath();
          g.fill();
          g.strokeStyle = "rgba(8,6,4,0.55)";
          g.stroke();
          g.restore();
        }
      }
    }
    const v0 = (poly, k) => Math.min(...poly.map((p) => p[k])) - 1;
    const v1 = (poly, k) => Math.max(...poly.map((p) => p[k])) + 1;

    // light thrown on the lower part of a block's sides (lava, fire): rgb [r,g,b], strongest alpha a, frac of its height
    function glowSides(b, rgb, a, frac = 0.7, o = {}) {
      const cs = corners(b);
      const cam = w.camLocal();
      for (let i = 0; i < 4; i++) {
        if (!facing(cam, cs, i, b.cf, b.cr)) continue;
        const A = cs[i];
        const B = cs[(i + 1) % 4];
        const hb = b.h0;
        const ht = b.h0 + (b.h1 - b.h0) * frac;
        const P = [[A[0], A[1], hb], [B[0], B[1], hb], [B[0], B[1], ht], [A[0], A[1], ht]].map(([f, r, h]) => w.project(f, r, h));
        if (P.some((p) => !p)) continue;
        const lo = { x: (P[0].x + P[1].x) / 2, y: (P[0].y + P[1].y) / 2 };
        const hi = { x: (P[2].x + P[3].x) / 2, y: (P[2].y + P[3].y) / 2 };
        const flick = o.flicker ? 0.85 + 0.15 * Math.sin(o.flicker * 9 + i * 2) : 1;
        const grad = g.createLinearGradient(lo.x, lo.y, hi.x, hi.y);
        grad.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${(a * flick).toFixed(3)})`);
        grad.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
        g.save();
        g.globalCompositeOperation = o.blend || "lighter";
        g.beginPath();
        P.forEach((p, k) => (k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
        g.closePath();
        g.fillStyle = grad;
        g.fill();
        g.restore();
      }
    }

    // -- small shapes -------------------------------------------------------------------------------------
    function disc(f, r, z, rad, fill, stroke, lineW = 1) {
      const pts = [];
      for (let k = 0; k < 24; k++) pts.push([f + rad * Math.cos((k / 24) * 2 * Math.PI), r + rad * Math.sin((k / 24) * 2 * Math.PI), z]);
      const p = w.polyScreen(pts, 1);
      if (p) w.fillPoly(p, fill, stroke, lineW);
    }
    const ring = (f, r, z, rad, color, width = 2) => disc(f, r, z, rad, null, color, width);
    function shadow(f, r, z, rad, a = 0.35) {
      disc(f, r, z + 0.0006, rad, `rgba(0,0,0,${a.toFixed(3)})`);
    }
    // a glow at a floor-frame point (additive)
    function glow(f, r, h, rad, stops, alpha = 1, blend = "lighter") {
      const m = w.project(f, r, h);
      if (!m) return;
      g.save();
      g.globalCompositeOperation = blend;
      ar.glow(m.x, m.y, rad * m.ppm, stops, alpha);
      g.restore();
    }
    // fire: stacked flickering glows rising from a point
    function flame(f, r, z, size, time, o = {}) {
      const base = w.project(f, r, z);
      if (!base) return;
      const a = o.alpha === undefined ? 1 : o.alpha;
      const seed = o.seed || 0;
      g.save();
      g.globalCompositeOperation = "lighter";
      for (let k = 0; k < 5; k++) {
        const t = k / 4;
        const sway = Math.sin(time * 11 + seed + k * 1.7) * 0.22 * size * t;
        const flick = 0.8 + 0.2 * Math.sin(time * 23 + seed * 3 + k * 2.3);
        const m = w.project(f + sway * Math.cos(seed), r + sway * Math.sin(seed), z + size * (0.15 + 1.05 * t));
        if (!m) continue;
        const rad = size * (0.62 - 0.4 * t) * flick * m.ppm;
        ar.glow(m.x, m.y, rad, [[0, `rgba(255,${240 - 60 * t | 0},${190 - 150 * t | 0},${0.85 * a})`], [0.45, `rgba(255,${120 - 40 * t | 0},20,${0.5 * a})`], [1, "rgba(200,40,0,0)"]]);
      }
      g.restore();
      if (o.light !== false) glow(f, r, z + size * 0.3, size * 2.4, [[0, `rgba(255,150,50,${0.22 * a})`], [1, "rgba(255,80,0,0)"]]);
    }
    // a barrel: bulging staves, iron hoops, a lid
    function barrel(f, r, z, rad, height, o = {}) {
      const rings = [[0, 0.8], [0.14, 0.93], [0.5, 1], [0.86, 0.93], [1, 0.8]];
      const N = 14;
      const cam = w.camLocal();
      const spin = o.spin || 0;
      const burnt = o.burnt || 0;
      const pt = (k, ri) => {
        const a = (k / N) * 2 * Math.PI + spin;
        return [f + rad * rings[ri][1] * Math.cos(a), r + rad * rings[ri][1] * Math.sin(a), z + height * rings[ri][0]];
      };
      const facets = [];
      for (let k = 0; k < N; k++) {
        const am = ((k + 0.5) / N) * 2 * Math.PI + spin;
        const nf = Math.cos(am);
        const nr = Math.sin(am);
        if ((cam.f - f) * nf + (cam.r - r) * nr <= 0) continue;
        facets.push({ k, lam: clamp(nf * LIGHT[0] + nr * LIGHT[1] + 0.62, 0.25, 1), d: (cam.f - f) * nf + (cam.r - r) * nr });
      }
      const wood = o.color || [150, 98, 52];
      facets.forEach(({ k, lam }) => {
        for (let ri = 0; ri < 4; ri++) {
          const P = [pt(k, ri), pt(k + 1, ri), pt(k + 1, ri + 1), pt(k, ri + 1)];
          const s = P.map(([a, b, c]) => w.project(a, b, c));
          if (s.some((p) => !p)) continue;
          const stave = 0.86 + 0.14 * ((k * 7) % 3) / 2;
          const shade = lam * stave * (1 - 0.7 * burnt);
          g.fillStyle = `rgb(${wood[0] * shade | 0},${wood[1] * shade | 0},${wood[2] * shade | 0})`;
          g.beginPath();
          s.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
          g.closePath();
          g.fill();
          g.strokeStyle = "rgba(20,10,4,0.55)";
          g.lineWidth = 0.8;
          g.stroke();
        }
      });
      // iron hoops
      [0.14, 0.5, 0.86].forEach((t, i) => {
        const ri = i === 0 ? 1 : i === 1 ? 2 : 3;
        const line = [];
        for (let k = 0; k <= N; k++) {
          const am = ((k + 0.5) / N) * 2 * Math.PI + spin;
          if ((cam.f - f) * Math.cos(am) + (cam.r - r) * Math.sin(am) <= 0) {
            line.push(null);
            continue;
          }
          const a = (k / N) * 2 * Math.PI + spin;
          line.push([f + rad * rings[ri][1] * 1.01 * Math.cos(a), r + rad * rings[ri][1] * 1.01 * Math.sin(a), z + height * t]);
        }
        g.strokeStyle = o.hoop || "rgba(54,56,62,0.95)";
        g.lineWidth = Math.max(1.5, 0.006 * (w.project(f, r, z + height * t) || { ppm: 300 }).ppm * (rad / 0.02));
        g.beginPath();
        let pen = false;
        line.forEach((p) => {
          if (!p) {
            pen = false;
            return;
          }
          const s = w.project(p[0], p[1], p[2]);
          if (!s) return;
          if (pen) g.lineTo(s.x, s.y);
          else g.moveTo(s.x, s.y);
          pen = true;
        });
        g.stroke();
      });
      // the lid, seen from above
      if (cam.h > z + height) {
        const lid = [];
        for (let k = 0; k < N; k++) lid.push(pt(k, 4));
        const p = w.polyScreen(lid, 1);
        if (p) {
          w.fillPoly(p, `rgb(${wood[0] * 0.8 | 0},${wood[1] * 0.8 | 0},${wood[2] * 0.8 | 0})`, "rgba(20,10,4,0.8)", 1);
          const bung = w.project(f + rad * 0.3, r, z + height);
          if (bung) {
            g.fillStyle = "rgba(30,16,8,0.9)";
            g.beginPath();
            g.arc(bung.x, bung.y, Math.max(1.5, 0.12 * rad * bung.ppm), 0, 2 * Math.PI);
            g.fill();
          }
        }
      }
    }

    // explosion: t 0..1 (a flash, a fireball swelling, then smoke), rad: its reach (m)
    function explosion(f, r, z, rad, t) {
      const m = w.project(f, r, z + rad * 0.25);
      if (!m) return;
      const R = rad * m.ppm * 0.62;
      g.save();
      g.globalCompositeOperation = "lighter";
      const flash = Math.max(0, 1 - t * 6);
      if (flash > 0) ar.glow(m.x, m.y, R * (0.8 + t * 3), [[0, `rgba(255,255,240,${0.9 * flash})`], [0.45, `rgba(255,200,110,${0.4 * flash})`], [1, "rgba(255,120,0,0)"]]);
      const swell = smooth(0, 0.3, t);
      const fade = 1 - smooth(0.3, 0.85, t);
      for (let k = 0; k < 7; k++) {
        const a = k * 0.9 + 0.6;
        const d = rad * 0.4 * swell * (k % 2 ? 0.7 : 1);
        const q = w.project(f + d * Math.cos(a), r + d * Math.sin(a), z + rad * (0.14 + 0.38 * swell) + 0.06 * rad * Math.sin(k * 2));
        if (!q) continue;
        ar.glow(q.x, q.y, R * (0.28 + 0.26 * swell), [[0, `rgba(255,${210 - 90 * swell | 0},${120 - 80 * swell | 0},${0.55 * fade})`], [0.5, `rgba(255,${110 - 40 * swell | 0},20,${0.4 * fade})`], [1, "rgba(120,20,0,0)"]]);
      }
      g.restore();
      // smoke afterwards, darker and rising
      const sm = smooth(0.2, 0.6, t) * (1 - smooth(0.75, 1, t));
      if (sm > 0) {
        for (let k = 0; k < 5; k++) {
          const a = k * 1.3;
          const q = w.project(f + rad * 0.25 * Math.cos(a), r + rad * 0.25 * Math.sin(a), z + rad * (0.25 + 0.9 * t));
          if (!q) continue;
          ar.glow(q.x, q.y, R * (0.35 + 0.35 * t), [[0, `rgba(50,46,42,${0.55 * sm})`], [1, "rgba(40,38,36,0)"]]);
        }
      }
      // the blast wave on the floor
      if (t < 0.45) {
        const k = t / 0.45;
        ring(f, r, z + 0.0008, rad * (0.25 + 0.75 * k), `rgba(255,235,190,${(0.7 * (1 - k)).toFixed(3)})`, 2.5);
        disc(f, r, z + 0.0005, rad * 0.5 * (1 - k * 0.5), `rgba(255,170,60,${(0.28 * (1 - k)).toFixed(3)})`);
      }
    }
    // -- particles -------------------------------------------------------------------------------------
    const parts = [];
    const KINDS = {
      ember: { life: [1.0, 2.2], size: [0.0014, 0.003], g: -0.01, drag: 0.4 },
      smoke: { life: [1.2, 2.2], size: [0.006, 0.012], g: -0.012, drag: 1.2 },
      spark: { life: [0.25, 0.6], size: [0.0012, 0.0022], g: 0.2, drag: 0.1 },
      debris: { life: [0.7, 1.4], size: [0.0007, 0.0018], g: 0.45, drag: 0.1 },
      dust: { life: [0.6, 1.1], size: [0.004, 0.009], g: -0.004, drag: 2 },
      splash: { life: [0.4, 0.8], size: [0.0014, 0.0028], g: 0.4, drag: 0.2 },
    };
    const rnd = (a, b) => a + Math.random() * (b - a);
    function emit(kind, f, r, h, n = 1, spread = 0.01, o = {}) {
      const K = KINDS[kind];
      for (let i = 0; i < n; i++) {
        const sp = o.speed === undefined ? 0.03 : o.speed;
        parts.push({
          kind, f: f + rnd(-spread, spread), r: r + rnd(-spread, spread), h,
          vf: rnd(-sp, sp), vr: rnd(-sp, sp), vh: o.up === undefined ? rnd(0.01, 0.05) : o.up * rnd(0.5, 1.2),
          life: rnd(...K.life), t: 0, size: rnd(...K.size) * (o.scale || 1), k: Math.random(),
        });
      }
      if (parts.length > 400) parts.splice(0, parts.length - 400);
    }
    function update(dt) {
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        const K = KINDS[p.kind];
        p.t += dt;
        if (p.t >= p.life) {
          parts.splice(i, 1);
          continue;
        }
        const d = Math.exp(-K.drag * dt);
        p.vf *= d;
        p.vr *= d;
        p.vh = p.vh * d - K.g * dt;
        p.f += p.vf * dt;
        p.r += p.vr * dt;
        p.h += p.vh * dt;
        if (p.h < 0 && (p.kind === "debris" || p.kind === "spark")) {
          p.h = 0;
          p.vh *= -0.3;
        }
      }
    }
    function drawParts() {
      parts.forEach((p) => {
        const m = w.project(p.f, p.r, p.h);
        if (!m) return;
        const u = p.t / p.life;
        ar.queue(m.depth, () => {
          g.save();
          const rad = Math.max(0.8, p.size * m.ppm);
          if (p.kind === "ember") {
            g.globalCompositeOperation = "lighter";
            const a = (1 - u) * (0.6 + 0.4 * Math.sin(p.t * 20 + p.k * 9));
            ar.glow(m.x, m.y, rad * 3.2, [[0, `rgba(255,${200 - 120 * u | 0},60,${a})`], [1, "rgba(255,60,0,0)"]]);
          } else if (p.kind === "spark") {
            g.globalCompositeOperation = "lighter";
            g.strokeStyle = `rgba(255,${220 - 80 * u | 0},120,${1 - u})`;
            g.lineWidth = Math.max(1, rad * 0.8);
            g.beginPath();
            g.moveTo(m.x, m.y);
            g.lineTo(m.x - p.vf * 14 * m.ppm * 0.02, m.y + p.vh * 14 * m.ppm * 0.02);
            g.stroke();
          } else if (p.kind === "smoke" || p.kind === "dust") {
            const grow = 1 + 2.2 * u;
            const c = p.kind === "smoke" ? "58,54,50" : "150,138,120";
            ar.glow(m.x, m.y, rad * grow * 2, [[0, `rgba(${c},${(p.kind === "smoke" ? 0.4 : 0.3) * (1 - u)})`], [1, `rgba(${c},0)`]]);
          } else if (p.kind === "splash") {
            g.fillStyle = `rgba(210,240,255,${0.8 * (1 - u)})`;
            g.beginPath();
            g.arc(m.x, m.y, rad, 0, 2 * Math.PI);
            g.fill();
          } else {
            g.fillStyle = `rgba(40,32,26,${1 - u * 0.5})`;
            g.beginPath();
            g.arc(m.x, m.y, rad, 0, 2 * Math.PI);
            g.fill();
          }
          g.restore();
        });
      });
    }

    return {
      tex, patch, quad, skin, glowSides, disc, ring, shadow, glow, flame, barrel, explosion, STYLES, corners,
      parts: { emit, update, draw: drawParts, list: parts },
    };
  };
})(window.Lynx);
