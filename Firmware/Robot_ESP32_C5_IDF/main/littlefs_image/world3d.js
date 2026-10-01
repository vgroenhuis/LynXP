// A small 3D world kit on top of ar.js, for games built from blocks in their
// own floor frame (the knight; written after the Temple's own copies of
// these helpers, which could move onto it).
//
// Frame: f forward and r to the right of an anchor ({x, y, th} in the
// robot's odometry frame), h up from the floor (m). Surfaces are clipped at
// the lens's near plane before projection, cut into small pieces where
// they're textured (ar.texturedQuad maps each piece affinely), and queued on
// ar.queue with their extents, so ar.flush can order them exactly.
//
// Lynx.world3d(ar) -> {
//   setAnchor(a), anchor(), toWorld(f, r), toLocal(x, y), w3(f, r, h),
//   camLocal() -> {f, r, h}, camZ(f, r, h), project(f, r, h),
//   polyScreen(points [[f, r, h]...], seg), fillPoly(pts, fill, stroke, width),
//   line3(points, color, width, stepM), extent(f0, f1, r0, r1, h0, h1),
//   box(q {f0, f1, r0, r1}, h0, h1, col, opts), texFloor(q, h, name, alpha),
//   texFace(a, b, h0, h1, img), floor(q, h, fill, stroke, opts), beginFrame(),
// }
// col: {top, side, dark, line, tex (a full stone texture, Lynx.texture) or
// detail (an overlay over the flat colors: "slab", "marble")}.
// box opts: {alpha} (see-through, e.g. between the camera and the player),
// faceDeco(a, b, h0, h1) / topDeco(h): extra drawing on each face drawn
// (e.g. a crate's planks), in the same queue item.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const NEAR = 0.042; // surfaces are clipped this far in front of the lens (ar.js projects from 0.04 m)
  const TEX_PPM = 256 / 0.6; // texture pixels per meter, as the Temple

  Lynx.world3d = (ar, opts = {}) => {
    const near = Math.max(opts.near || NEAR, 0.042);
    const texturesOn = opts.textures !== false && typeof Lynx.texture === "function" && !!ar.texturedQuad;
    let anchor = { x: 0, y: 0, th: 0 };
    const toWorld = (f, r) => ({
      x: anchor.x + f * Math.cos(anchor.th) + r * Math.sin(anchor.th),
      y: anchor.y + f * Math.sin(anchor.th) - r * Math.cos(anchor.th),
    });
    const toLocal = (x, y) => {
      const dx = x - anchor.x;
      const dy = y - anchor.y;
      return { f: dx * Math.cos(anchor.th) + dy * Math.sin(anchor.th), r: dx * Math.sin(anchor.th) - dy * Math.cos(anchor.th) };
    };
    const w3 = (f, r, h) => {
      const w = toWorld(f, r);
      return [w.x, w.y, h];
    };
    const frame = { cam: { f: 0, r: 0, h: 0 }, toWorld };
    const camLocal = () => {
      const c = ar.cameraWorld();
      const l = toLocal(c.x, c.y);
      return { f: l.f, r: l.r, h: c.h };
    };
    // distance in front of the lens (the projection's z) of a local point
    function camZ(f, r, h) {
      const w = toWorld(f, r);
      const rel = ar.toCamera(w.x, w.y);
      const vert = ar.cameraWorld().h - h;
      return rel.forward * Math.cos(ar.tilt) + vert * Math.sin(ar.tilt);
    }
    const project = (f, r, h) => {
      if (camZ(f, r, h) < near) return null;
      const w = toWorld(f, r);
      return ar.project(w.x, w.y, h);
    };

    // Local polygon -> screen polygon, clipped at the near plane (edges cut
    // into seg pieces first, so the clip follows them closely).
    function polyScreen(pts, seg = 3) {
      const dense = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % pts.length];
        for (let k = 0; k < seg; k++) {
          const t = k / seg;
          dense.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]);
        }
      }
      const z = dense.map((p) => camZ(p[0], p[1], p[2]));
      const clipped = [];
      for (let i = 0; i < dense.length; i++) {
        const j = (i - 1 + dense.length) % dense.length;
        const inCur = z[i] >= near;
        const inPrev = z[j] >= near;
        if (inCur !== inPrev) {
          const t = (near - z[j]) / (z[i] - z[j]);
          clipped.push(dense[j].map((v, k) => v + (dense[i][k] - v) * t));
        }
        if (inCur) clipped.push(dense[i]);
      }
      if (clipped.length < 3) return null;
      const out = [];
      clipped.forEach((p) => {
        const w = toWorld(p[0], p[1]);
        const s = ar.project(w.x, w.y, Math.max(p[2], -10));
        if (s) out.push(s);
      });
      return out.length >= 3 ? out : null;
    }

    function fillPoly(pts, fill, stroke, width = 1) {
      const c = ar.ctx;
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

    // A polyline through local points, broken where it passes behind the lens.
    function line3(points, color, width, stepM = 0.02) {
      const c = ar.ctx;
      c.strokeStyle = color;
      c.lineWidth = width;
      c.beginPath();
      let pen = false;
      for (let i = 0; i + 1 < points.length; i++) {
        const [f0, r0, h0] = points[i];
        const [f1, r1, h1] = points[i + 1];
        const n = Math.max(1, Math.ceil(Math.hypot(f1 - f0, r1 - r0, h1 - h0) / stepM));
        for (let k = i ? 1 : 0; k <= n; k++) {
          const t = k / n;
          const p = project(f0 + (f1 - f0) * t, r0 + (r1 - r0) * t, h0 + (h1 - h0) * t);
          if (!p) {
            pen = false;
            continue;
          }
          if (pen) c.lineTo(p.x, p.y);
          else c.moveTo(p.x, p.y);
          pen = true;
        }
      }
      c.stroke();
    }

    const extent = (f0, f1, r0, r1, h0, h1) => ({ frame, f0, f1, r0, r1, h0, h1 });

    // -- textures -------------------------------------------------------------------
    const mod = (a, n) => {
      const m = ((a % n) + n) % n;
      return n - m < 0.01 ? 0 : m;
    };
    const cuts = (lo, hi, step) => {
      const out = [lo];
      for (let s = (Math.floor(lo / step + 1e-6) + 1) * step; s < hi - 1e-6; s += step) out.push(s);
      out.push(hi);
      return out;
    };
    // all corners in front of the lens (ar.project: from 0.04 m)?
    const quadOk = (pts) => pts.every((p) => camZ(p[0], p[1], p[2]) >= 0.042);
    function texQuad(pts, img, uv) {
      if (!quadOk(pts)) return;
      ar.texturedQuad(pts.map((p) => w3(p[0], p[1], p[2])), img, uv);
    }
    // A vertical face from local point a to b ([f, r]), h0..h1.
    function texFace(a, b, h0, h1, img) {
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 1e-6) return;
      const m = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const d = camZ(m[0], m[1], (h0 + h1) / 2);
      const step = d < 0.3 ? 0.03 : d < 0.7 ? 0.06 : 0.15;
      const ss = cuts(0, len, step);
      const hs = cuts(h0, h1, step);
      const at = (s, h) => [a[0] + ((b[0] - a[0]) * s) / len, a[1] + ((b[1] - a[1]) * s) / len, h];
      const base = Math.abs(b[0] - a[0]) < 1e-9 ? a[1] * Math.sign(b[1] - a[1]) : a[0] * Math.sign(b[0] - a[0]); // world-fixed u
      for (let i = 0; i + 1 < ss.length; i++) {
        const u0 = mod((base + ss[i]) * TEX_PPM, img.width);
        const u1 = u0 + (ss[i + 1] - ss[i]) * TEX_PPM;
        for (let k = 0; k + 1 < hs.length; k++) {
          const v0 = mod(-hs[k + 1] * TEX_PPM, img.height);
          const v1 = v0 + (hs[k + 1] - hs[k]) * TEX_PPM;
          texQuad([at(ss[i], hs[k + 1]), at(ss[i + 1], hs[k + 1]), at(ss[i + 1], hs[k]), at(ss[i], hs[k])], img,
            [{ u: u0, v: v0 }, { u: u1, v: v0 }, { u: u1, v: v1 }, { u: u0, v: v1 }]);
        }
      }
    }
    // A horizontal rectangle at height h, textured where it's within reach.
    function texFloor(q, h, name, alpha = 1) {
      if (!texturesOn) return;
      const img = Lynx.texture(name);
      if (!img) return;
      const c = camLocal();
      const R = 1.6;
      const f0 = Math.max(q.f0, c.f - R);
      const f1 = Math.min(q.f1, c.f + R);
      const r0 = Math.max(q.r0, c.r - R);
      const r1 = Math.min(q.r1, c.r + R);
      if (f0 >= f1 || r0 >= r1) return;
      const g = ar.ctx;
      const old = g.globalAlpha;
      g.globalAlpha = old * alpha;
      const quad = (fa, fb, ra, rb) => {
        const u0 = mod(ra * TEX_PPM, img.width);
        const v0 = mod(-fb * TEX_PPM, img.height);
        texQuad([[fb, ra, h], [fb, rb, h], [fa, rb, h], [fa, ra, h]], img,
          [{ u: u0, v: v0 }, { u: u0 + (rb - ra) * TEX_PPM, v: v0 }, { u: u0 + (rb - ra) * TEX_PPM, v: v0 + (fb - fa) * TEX_PPM }, { u: u0, v: v0 + (fb - fa) * TEX_PPM }]);
      };
      // pieces: 0.3 m (one tile) far away, finer close to the camera
      const fs = cuts(f0, f1, 0.3);
      const rs = cuts(r0, r1, 0.3);
      for (let i = 0; i + 1 < fs.length; i++) {
        for (let j = 0; j + 1 < rs.length; j++) {
          const df = Math.max(0, fs[i] - c.f, c.f - fs[i + 1]);
          const dr = Math.max(0, rs[j] - c.r, c.r - rs[j + 1]);
          const d = Math.hypot(df, dr, c.h - h);
          const step = d < 0.25 ? 0.05 : d < 0.6 ? 0.1 : 0.3;
          if (step >= 0.3) {
            quad(fs[i], fs[i + 1], rs[j], rs[j + 1]);
            continue;
          }
          const sf = cuts(fs[i], fs[i + 1], step);
          const sr = cuts(rs[j], rs[j + 1], step);
          for (let a = 0; a + 1 < sf.length; a++) for (let b = 0; b + 1 < sr.length; b++) quad(sf[a], sf[a + 1], sr[b], sr[b + 1]);
        }
      }
      g.globalAlpha = old;
    }

    // Anything of a block in front of the lens? (its corners)
    function inFront(q, h0, h1) {
      for (const f of [q.f0, q.f1]) for (const r of [q.r0, q.r1]) if (camZ(f, r, h0) >= near || camZ(f, r, h1) >= near) return true;
      return false;
    }

    // A block from (f0..f1, r0..r1), h0..h1: the faces that face the camera,
    // its top (seen from above) or underside (from below). Queued.
    function box(q, h0, h1, col, o = {}) {
      if (!inFront(q, h0, h1)) return;
      const mf = (q.f0 + q.f1) / 2;
      const mr = (q.r0 + q.r1) / 2;
      ar.queue(camZ(mf, mr, (h0 + h1) / 2), () => {
        const c = camLocal();
        const g = ar.ctx;
        const old = g.globalAlpha;
        if (o.alpha !== undefined) g.globalAlpha = old * o.alpha;
        const img = texturesOn && col.tex ? Lynx.texture(col.tex) : null;
        const detail = texturesOn && !img && col.detail ? Lynx.texture(col.detail) : null;
        const faces = [];
        if (c.f < q.f0) faces.push([[q.f0, q.r0], [q.f0, q.r1], col.side]);
        if (c.f > q.f1) faces.push([[q.f1, q.r1], [q.f1, q.r0], col.side]);
        if (c.r < q.r0) faces.push([[q.f1, q.r0], [q.f0, q.r0], col.dark]);
        if (c.r > q.r1) faces.push([[q.f0, q.r1], [q.f1, q.r1], col.dark]);
        faces.forEach(([a, b, fill]) => {
          const p = polyScreen([[a[0], a[1], h0], [b[0], b[1], h0], [b[0], b[1], h1], [a[0], a[1], h1]]);
          if (!p) return;
          fillPoly(p, fill, null);
          if (img || detail) {
            texFace(a, b, h0, h1, img || detail);
            if (img) fillPoly(p, `rgba(20,12,4,${fill === col.dark ? 0.3 : 0.1})`, null);
          }
          fillPoly(p, null, col.line, 1);
          if (o.faceDeco) o.faceDeco(a, b, h0, h1);
        });
        const top = (h, fill) => {
          const p = polyScreen([[q.f0, q.r0, h], [q.f1, q.r0, h], [q.f1, q.r1, h], [q.f0, q.r1, h]]);
          if (!p) return;
          fillPoly(p, fill, null);
          if (img) texFloor(q, h, col.topTex || "flagstone");
          else if (detail) texFloor(q, h, col.detail);
          fillPoly(p, null, col.line, 1);
          if (o.topDeco) o.topDeco(h);
        };
        if (c.h > h1) top(h1, col.top);
        else if (c.h < h0 && h0 > 0.001) top(h0, col.under || col.dark);
        g.globalAlpha = old;
      }, extent(q.f0, q.f1, q.r0, q.r1, h0, h1));
    }

    // A flat area on the floor (or at height h), drawn straight away (under
    // everything queued), with an optional detail texture.
    function floor(q, h, fill, stroke, o = {}) {
      const p = polyScreen([[q.f0, q.r0, h], [q.f1, q.r0, h], [q.f1, q.r1, h], [q.f0, q.r1, h]]);
      if (!p) return;
      if (fill) fillPoly(p, fill, null);
      if (o.detail) texFloor(q, h, o.detail, o.alpha === undefined ? 0.5 : o.alpha);
      if (stroke) fillPoly(p, null, stroke, o.width || 1);
    }

    return {
      frame, setAnchor: (a) => (anchor = { ...a }), anchor: () => anchor,
      toWorld, toLocal, w3, camLocal, camZ, project, polyScreen, fillPoly, line3, extent, box, floor, texFloor, texFace,
      beginFrame: () => (frame.cam = camLocal()),
      near,
    };
  };
})(window.Lynx);
