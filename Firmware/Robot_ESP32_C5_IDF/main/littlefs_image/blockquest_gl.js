// Block Quest's character renderer: real 3D figures, lit and shaded on the GPU.
//
// The game draws on a 2D canvas, back to front (ar.queue). A figure is drawn
// inside its queue slot: its parts (ellipsoids, tapered cylinders, rounded
// boxes, shields, cloth) go to a WebGL2 canvas of the same size with a camera
// that matches the game's, and the finished picture is copied onto the 2D
// canvas, so the blocks, effects and the other figures still sort around it.
//
// Looks come from the shader: physically based lighting (a key light, sky and
// floor bounce, up to four point lights for torches, lava, fuses and blasts),
// procedural materials with bump (bone, steel and rust, bronze, cloth, leather,
// wood, enamel, glow), and a shadow cast on the floor.
//
//   const R = Lynx.bqGL(ar, w, cfg);   R.ok: false when WebGL2 is missing (the game keeps its flat sprites)
//   R.setEnv({sky, ground, lights: [{f, r, h, col, rad}]})   once a frame (floor-frame lights)
//   const F = R.figure({f, r, z, yaw, scale, height});       // null when out of sight
//   F.ell(c, rx, ry, rz, col, mat, o) F.seg(a, b, r0, r1, col, mat, o) F.cap(...)
//   F.box(c, hx, hy, hz, col, mat, o) F.shield(kind, c, nrm, up, size, col, mat, o) F.cloth(pts, nu, nv, size, col, mat, o)
//   F.draw({alpha, flash, shadow})                            // onto ar.ctx
// Parts are in the body frame (x forward, y right, z up, meters at the pocket
// knight's size); o: {rust, frame: {x, y, z}, seed, taper, two}.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const MAT = { bone: 0, steel: 1, cloth: 2, leather: 3, wood: 4, glow: 5, void: 6, gold: 7, bronze: 8, enamel: 10, flame: 11 };

  const VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in vec3 a_nrm;
layout(location=2) in vec2 a_uv;
layout(location=3) in vec4 a_loc; // xyz: texture-space position, w: slope weight (1 on a cylinder's side)
layout(location=4) in vec3 a_c;
layout(location=5) in vec3 a_x;
layout(location=6) in vec3 a_y;
layout(location=7) in vec3 a_z;
layout(location=8) in vec4 a_col;
layout(location=9) in vec4 a_prm; // seed, taper, slope, extra
uniform vec4 u_proj;   // fpx, cx, cy, cylinder flag
uniform vec2 u_size;
uniform vec2 u_zr;
uniform float u_inv;   // 1 / body scale
uniform float u_shadow;
uniform vec3 u_org, u_up, u_key;
out vec3 v_p; out vec3 v_n; flat out vec4 v_col; flat out vec4 v_prm; out vec3 v_loc; out vec2 v_uv; out float v_hgt;
void main() {
  vec3 p = a_pos;
  float lx = dot(a_x, a_x), ly = dot(a_y, a_y), lz = dot(a_z, a_z);
  vec3 nn = a_x * (a_nrm.x / lx) + a_y * (a_nrm.y / ly) + a_z * (a_nrm.z / lz);
  nn = normalize(nn);
  if (u_proj.w > 0.5) {
    p.xy *= mix(1.0, a_prm.y, (p.z + 1.0) * 0.5);
    if (a_loc.w > 0.5) nn = normalize(nn + a_prm.z * normalize(a_z));
  }
  vec3 pc = a_c + a_x * p.x + a_y * p.y + a_z * p.z;
  v_hgt = dot(pc - u_org, u_up);
  if (u_shadow > 0.5) {
    pc = pc - u_key * (v_hgt / dot(u_key, u_up)) + u_up * (0.0006 / u_inv * 0.5);
  }
  v_p = pc; v_n = nn; v_col = a_col; v_prm = a_prm; v_uv = a_uv;
  v_loc = a_loc.xyz * vec3(length(a_x), length(a_y), length(a_z)) * u_inv + a_prm.x * 7.31;
  float cxp = (u_proj.x * pc.x + (u_proj.y - u_size.x * 0.5) * pc.z) / (u_size.x * 0.5);
  float cyp = -(u_proj.x * pc.y + (u_proj.z - u_size.y * 0.5) * pc.z) / (u_size.y * 0.5);
  float n = u_zr.x, f = u_zr.y;
  float czp = (pc.z * (f + n) - 2.0 * f * n) / (f - n);
  gl_Position = vec4(cxp, cyp, czp, pc.z);
}`;

  const FS = `#version 300 es
precision highp float;
in vec3 v_p; in vec3 v_n; flat in vec4 v_col; flat in vec4 v_prm; in vec3 v_loc; in vec2 v_uv; in float v_hgt;
uniform float u_q;
uniform vec3 u_key, u_keyCol, u_sky, u_gnd, u_up, u_fill;
uniform vec4 u_pl[4];
uniform vec3 u_plc[4];
uniform float u_flash, u_time, u_two, u_shadow, u_sa, u_bump, u_aoH;
out vec4 o;
const float PI = 3.14159265;
float h31(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float vn(vec3 p) {
  vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h31(i), h31(i + vec3(1,0,0)), f.x), mix(h31(i + vec3(0,1,0)), h31(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(h31(i + vec3(0,0,1)), h31(i + vec3(1,0,1)), f.x), mix(h31(i + vec3(0,1,1)), h31(i + vec3(1,1,1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5, s = 0.0; int oct = u_q > 0.5 ? 3 : 2; for (int i = 0; i < 3; i++) { if (i >= oct) break; s += a * vn(p); p = p * 2.03 + 17.1; a *= 0.5; } return s * (u_q > 0.5 ? 1.14 : 1.33); }
vec3 lin(vec3 c) { return pow(c, vec3(2.2)); }
vec3 bumpN(vec3 n, vec3 p, float h, float k) {
  vec3 dpx = dFdx(p), dpy = dFdy(p);
  float dhx = dFdx(h), dhy = dFdy(h);
  vec3 r1 = cross(dpy, n), r2 = cross(n, dpx);
  float det = dot(dpx, r1);
  vec3 grad = sign(det) * (dhx * r1 + dhy * r2);
  return normalize(abs(det) * n - k * grad);
}
float ggx(float nh, float a) { float a2 = a * a; float d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
vec3 env(vec3 r) {
  float up = dot(r, u_up);
  vec3 c = mix(u_gnd * 0.55, u_sky * 1.45, smoothstep(-0.12, 0.38, up));
  float s = max(dot(r, u_key), 0.0);
  c += u_keyCol * (pow(s, 50.0) * 1.6 + pow(s, 7.0) * 0.18);
  c += u_sky * 0.35 * smoothstep(0.55, 1.0, up);
  return c;
}
void main() {
  if (u_shadow > 0.5) { o = vec4(0.0, 0.0, 0.0, u_sa); return; }
  vec3 N = normalize(v_n);
  vec3 V = normalize(-v_p);
  if (u_two > 0.5 && dot(N, V) < 0.0) N = -N;
  int mt = int(v_col.a + 0.5);
  vec3 alb = lin(v_col.rgb);
  vec3 L = v_loc;
  float extra = v_prm.w;
  float rough = 0.6, metal = 0.0, sss = 0.0, hgt = 0.5, bumpK = 1.0, cavity = 1.0;
  vec3 emi = vec3(0.0);
  if (mt == 0) { // bone
    float n1 = fbm(L * 380.0), n2 = vn(L * 1500.0 + 3.0);
    float stain = smoothstep(0.35, 0.8, fbm(L * 150.0 + 9.0));
    alb *= mix(vec3(1.0), vec3(0.62, 0.48, 0.30), stain * 0.65);
    alb *= 0.66 + 0.5 * n1;
    float cr = smoothstep(0.0, 0.025, abs(vn(L * 950.0 + 5.0) - 0.5));
    alb *= mix(0.4, 1.0, cr);
    hgt = n2 * 0.55 + n1 * 0.45 - (1.0 - cr) * 0.4; rough = 0.52; sss = 0.35; bumpK = 1.1;
    cavity = mix(0.55, 1.0, smoothstep(0.2, 0.7, n1));
  } else if (mt == 1 || mt == 8) { // steel / bronze with rust or verdigris
    float st = 0.6 * vn(L * vec3(1300.0, 1300.0, 80.0)) + 0.4 * vn(L * vec3(3200.0, 3200.0, 160.0));
    float rn = extra > 0.001 ? fbm(L * 240.0 + 2.0) : 0.0;
    float rm = extra > 0.001 ? smoothstep(1.0 - extra * 1.15, 1.0 - extra * 1.15 + 0.16, rn + 0.12 * vn(L * 900.0)) : 0.0;
    vec3 rc = mt == 1 ? mix(vec3(0.28, 0.11, 0.04), vec3(0.58, 0.28, 0.09), fbm(L * 800.0)) : mix(vec3(0.12, 0.34, 0.26), vec3(0.28, 0.5, 0.4), fbm(L * 800.0));
    alb = mix(alb * (0.78 + 0.32 * st), lin(rc), rm);
    metal = 1.0 - rm * 0.95; rough = mix(0.22 + 0.3 * st, 0.88, rm);
    hgt = st * 0.5 + vn(L * 520.0) * 0.5 + rm * 0.4; bumpK = 0.8 + rm;
    float dent = vn(L * 90.0 + 4.0);
    if (u_q > 0.5) N = bumpN(N, v_p, dent, u_bump * 6.0);
  } else if (mt == 2) { // cloth
    float wv = sin(L.x * 2400.0) * sin(L.y * 2400.0);
    float wf = clamp(1.0 - fwidth(L.x * 2400.0) * 0.5, 0.0, 1.0);
    float fib = fbm(L * 600.0);
    alb *= 0.82 + 0.18 * fib + 0.07 * wv * wf;
    float fold = fbm(L * 70.0 + 1.0);
    alb *= 0.8 + 0.3 * fold;
    if (extra > 0.5 && extra < 1.5) { // tabard: a cross on white
      vec2 q = v_uv - 0.5;
      float vert = step(abs(q.x), 0.085) * step(-0.38, q.y) * step(q.y, 0.34);
      float hor = step(abs(q.y + 0.07), 0.07) * step(abs(q.x), 0.27);
      float cr = max(vert, hor);
      alb = mix(alb, lin(vec3(0.62, 0.05, 0.06)) * (0.8 + 0.3 * fib), cr);
    } else if (extra > 1.5 && extra < 2.5) { // hem stripes
      float s = step(0.5, fract(v_uv.x * 6.0));
      alb = mix(alb, alb * vec3(0.35, 0.25, 0.2), s * smoothstep(0.7, 0.8, v_uv.y));
    } else if (extra > 2.5) { // tatters: ragged lower edge fades out
      float edge = v_uv.y + (fbm(vec3(v_uv.x * 14.0, 1.0, 3.0)) - 0.5) * 0.35;
      if (edge > 0.93) discard;
    }
    rough = 0.92; hgt = 0.5 + 0.4 * wv * wf + 0.4 * fold; bumpK = 0.6; sss = 0.15;
  } else if (mt == 3) { // leather
    float g = vn(L * 1100.0) * (0.6 + 0.4 * vn(L * 2300.0));
    alb *= 0.72 + 0.5 * g * fbm(L * 200.0) * 2.0;
    rough = 0.62; hgt = g; bumpK = 1.0;
  } else if (mt == 4) { // wood, grain along the part's length
    float gr = fbm(L * vec3(1600.0, 1600.0, 90.0));
    float ring = sin((L.x + L.y) * 700.0 + gr * 9.0) * 0.5 + 0.5;
    alb *= 0.62 + 0.45 * ring + 0.2 * gr;
    rough = 0.55; hgt = ring * 0.4 + gr * 0.3; bumpK = 0.7;
  } else if (mt == 5) { // glow
    float fl = 0.78 + 0.22 * sin(u_time * 9.0 + v_prm.x * 13.0) + 0.1 * vn(vec3(u_time * 3.0, v_prm.x, 1.0));
    emi = alb * (1.7 * fl + 0.4);
    alb *= 0.2;
  } else if (mt == 6) { // a dark hollow
    alb = vec3(0.004, 0.003, 0.003); rough = 0.9;
  } else if (mt == 7) { // gold
    float st = 0.6 * vn(L * vec3(1500.0, 1500.0, 100.0)) + 0.4 * vn(L * 2900.0);
    alb *= 0.85 + 0.25 * st;
    metal = 1.0; rough = 0.26 + 0.12 * st; hgt = st;
    if (u_q > 0.5) N = bumpN(N, v_p, fbm(L * 100.0), u_bump * 4.0);
  } else if (mt == 10) { // enamelled shield: paint over steel, an emblem in uv
    vec2 q = v_uv * 2.0 - 1.0;
    float st = vn(L * vec3(1400.0, 1400.0, 1400.0));
    vec3 base = alb;
    float emb = 0.0;
    vec3 ec = lin(vec3(0.88, 0.72, 0.28));
    if (extra < 1.5) { // a cross
      emb = max(step(abs(q.x), 0.12) * step(abs(q.y + 0.05), 0.82), step(abs(q.y - 0.18), 0.11) * step(abs(q.x), 0.58));
    } else if (extra < 2.5) { // rings (bronze aspis)
      float r = length(q);
      emb = step(0.82, r) * step(r, 0.9) + step(0.52, r) * step(r, 0.57) + step(r, 0.12);
      ec = base * 0.45;
    } else { // a skull-ish boss
      float r = length(q - vec2(0.0, 0.05));
      emb = step(r, 0.34) + step(abs(q.x), 0.05) * step(q.y, -0.34) * step(-0.8, q.y) * 0.0;
      ec = lin(vec3(0.82, 0.78, 0.62));
    }
    alb = mix(base * (0.8 + 0.3 * st), ec * (0.85 + 0.25 * st), emb);
    float wear = smoothstep(0.62, 0.8, fbm(L * 300.0 + 8.0));
    alb = mix(alb, lin(vec3(0.5, 0.5, 0.52)), wear * 0.4);
    metal = max(wear, emb * 0.8) * 0.9; rough = mix(0.34, 0.5, 1.0 - wear); hgt = st * 0.4 + emb * 0.5;
    if (u_q > 0.5) N = bumpN(N, v_p, fbm(L * 110.0), u_bump * 5.0);
  } else if (mt == 11) { // flame / hot metal: pure glow, hot core
    float fl = 0.7 + 0.3 * vn(vec3(u_time * 4.0, v_prm.x, L.z * 300.0));
    emi = alb * 2.6 * fl; alb *= 0.0;
  }
  // fine bump on everything but the plain-lit
  if (u_q > 0.5 && mt != 5 && mt != 6 && mt != 11) N = bumpN(N, v_p, hgt, u_bump * bumpK);

  float ndl = dot(N, u_key);
  float wrap = sss;
  float dif = max((ndl + wrap) / (1.0 + wrap), 0.0);
  float ndv = max(dot(N, V), 0.0);
  float up = dot(N, u_up);
  // a pocket-sized occlusion: darker toward the floor and under things
  float ao = mix(0.5, 1.0, smoothstep(0.0, u_aoH, v_hgt)) * mix(0.82, 1.0, up * 0.5 + 0.5);
  vec3 hemi = mix(u_gnd, u_sky, up * 0.5 + 0.5);
  vec3 pl = vec3(0.0), pls = vec3(0.0);
  vec3 H0 = normalize(u_key + V);
  for (int i = 0; i < 4; i++) {
    vec4 q = u_pl[i];
    if (q.w <= 0.0) continue;
    vec3 d = q.xyz - v_p;
    float dist = length(d);
    vec3 ld = d / max(dist, 1e-4);
    float at = clamp(1.0 - (dist * dist) / (q.w * q.w), 0.0, 1.0); at *= at;
    float nl = max((dot(N, ld) + wrap) / (1.0 + wrap), 0.0);
    pl += u_plc[i] * nl * at;
    vec3 Hh = normalize(ld + V);
    pls += u_plc[i] * at * ggx(max(dot(N, Hh), 0.0), max(rough * rough, 0.05)) * 0.2 * max(dot(N, ld), 0.0);
  }
  vec3 f0 = mix(vec3(0.04), alb, metal);
  float vh = max(dot(V, H0), 0.0);
  vec3 F = f0 + (1.0 - f0) * pow(1.0 - vh, 5.0);
  float a = max(rough * rough, 0.05);
  vec3 spec = F * ggx(max(dot(N, H0), 0.0), a) * 0.25 * max(ndl, 0.0) * u_keyCol;
  vec3 R = reflect(-V, N);
  vec3 fe = f0 + (max(vec3(1.0 - rough), f0) - f0) * pow(1.0 - ndv, 5.0);
  vec3 refl = env(R) * ao * fe * (1.0 - rough * 0.6);
  vec3 diff = alb * (1.0 - metal) * (u_keyCol * dif + hemi * ao * cavity + u_fill * ndv * 0.6 + pl);
  vec3 rim = u_sky * pow(1.0 - ndv, 3.0) * 0.38 * (1.0 - metal * 0.4) * cavity;
  vec3 col = diff + spec + pls + refl + rim * mix(vec3(1.0), alb * 2.0 + 0.2, 0.3) + emi;
  col = mix(col, vec3(1.0, 0.92, 0.8) * 1.6, u_flash);
  col = vec3(1.0) - exp(-col * 1.25);
  col = pow(col, vec3(1.0 / 2.2));
  o = vec4(col, 1.0);
}`;

  // -- meshes --------------------------------------------------------------------------------------------
  // vertex: pos3 nrm3 uv2 loc4 (12 floats)
  function sphereMesh(nLat = 14, nLon = 22) {
    const v = [];
    const idx = [];
    for (let i = 0; i <= nLat; i++) {
      const t = (i / nLat) * Math.PI;
      for (let j = 0; j <= nLon; j++) {
        const a = (j / nLon) * 2 * Math.PI;
        const x = Math.sin(t) * Math.cos(a);
        const y = Math.sin(t) * Math.sin(a);
        const z = Math.cos(t);
        v.push(x, y, z, x, y, z, j / nLon, i / nLat, x, y, z, 0);
      }
    }
    for (let i = 0; i < nLat; i++) {
      for (let j = 0; j < nLon; j++) {
        const a = i * (nLon + 1) + j;
        const b = a + nLon + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    return { v: new Float32Array(v), idx: new Uint16Array(idx) };
  }
  function cylMesh(n = 20) {
    const v = [];
    const idx = [];
    for (let j = 0; j <= n; j++) {
      const a = (j / n) * 2 * Math.PI;
      const c = Math.cos(a);
      const s = Math.sin(a);
      v.push(c, s, -1, c, s, 0, j / n, 0, c, s, -1, 1);
      v.push(c, s, 1, c, s, 0, j / n, 1, c, s, 1, 1);
    }
    for (let j = 0; j < n; j++) {
      const a = j * 2;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    for (const sz of [-1, 1]) {
      const base = v.length / 12;
      v.push(0, 0, sz, 0, 0, sz, 0.5, 0.5, 0, 0, sz, 0);
      for (let j = 0; j <= n; j++) {
        const a = (j / n) * 2 * Math.PI;
        v.push(Math.cos(a), Math.sin(a), sz, 0, 0, sz, 0.5 + 0.5 * Math.cos(a), 0.5 + 0.5 * Math.sin(a), Math.cos(a), Math.sin(a), sz, 0);
      }
      for (let j = 0; j < n; j++) idx.push(base, base + 1 + j, base + 2 + j);
    }
    return { v: new Float32Array(v), idx: new Uint16Array(idx) };
  }
  function boxMesh(n = 5, rr = 0.24) {
    const v = [];
    const idx = [];
    const faces = [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]];
    faces.forEach(([ax, sg]) => {
      const a1 = (ax + 1) % 3;
      const a2 = (ax + 2) % 3;
      const base = v.length / 12;
      for (let i = 0; i <= n; i++) {
        for (let j = 0; j <= n; j++) {
          const p = [0, 0, 0];
          p[ax] = sg;
          p[a1] = (i / n) * 2 - 1;
          p[a2] = (j / n) * 2 - 1;
          const c = p.map((q) => Math.max(-(1 - rr), Math.min(1 - rr, q)));
          const d = p.map((q, k) => q - c[k]);
          const l = Math.hypot(...d) || 1;
          const nrm = d.map((q) => q / l);
          const pos = c.map((q, k) => q + nrm[k] * rr);
          v.push(...pos, ...nrm, i / n, j / n, ...p, 0);
        }
      }
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
          const a = base + i * (n + 1) + j;
          const b = a + n + 1;
          if (sg > 0) idx.push(a, b, a + 1, a + 1, b, b + 1);
          else idx.push(a, a + 1, b, a + 1, b + 1, b);
        }
      }
    });
    return { v: new Float32Array(v), idx: new Uint16Array(idx) };
  }
  // A domed plate over an outline in (y, z), unit size; x out of the face (0..1)
  function plateMesh(contour, rings = 5) {
    const v = [];
    const idx = [];
    const n = contour.length;
    const grid = [];
    for (let k = 0; k <= rings; k++) {
      const s = 1 - k / rings;
      const row = [];
      for (let i = 0; i < n; i++) {
        const [y, z] = contour[i];
        const yy = y * s;
        const zz = z * s;
        row.push([1 - s * s * 0.0 - s * s, yy, zz, (y * 0.5 + 0.5), (z * 0.5 + 0.5)]);
      }
      grid.push(row);
    }
    // x = a dome: 1 at the centre, 0 at the rim
    grid.forEach((row, k) => row.forEach((p) => (p[0] = 1 - (1 - k / rings) * (1 - k / rings))));
    const vn2 = grid.map((row) => row.map(() => [0, 0, 0]));
    const P = (k, i) => grid[k][(i + n) % n];
    for (let k = 0; k < rings; k++) {
      for (let i = 0; i < n; i++) {
        const a = P(k, i);
        const b = P(k, i + 1);
        const c = P(k + 1, i);
        const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
        const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
        const nrm = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        [[k, i], [k, (i + 1) % n], [k + 1, i], [k + 1, (i + 1) % n]].forEach(([kk, ii]) => {
          vn2[kk][ii][0] += nrm[0];
          vn2[kk][ii][1] += nrm[1];
          vn2[kk][ii][2] += nrm[2];
        });
      }
    }
    for (let k = 0; k <= rings; k++) {
      for (let i = 0; i < n; i++) {
        const p = grid[k][i];
        let nrm = vn2[k][i];
        if (k === rings) nrm = [1, 0, 0];
        const l = Math.hypot(...nrm) || 1;
        const sg = nrm[0] < 0 ? -1 : 1;
        v.push(p[0], p[1], p[2], (sg * nrm[0]) / l, (sg * nrm[1]) / l, (sg * nrm[2]) / l, p[3], p[4], p[0] * 0.7, p[1], p[2], 0);
      }
    }
    for (let k = 0; k < rings; k++) {
      for (let i = 0; i < n; i++) {
        const a = k * n + i;
        const b = k * n + ((i + 1) % n);
        const c = (k + 1) * n + i;
        const d = (k + 1) * n + ((i + 1) % n);
        idx.push(a, c, b, b, c, d);
      }
    }
    return { v: new Float32Array(v), idx: new Uint16Array(idx) };
  }
  const KITE = (() => {
    const half = [[0, 1.0], [0.45, 0.99], [0.8, 0.94], [0.97, 0.84], [1.0, 0.55], [0.96, 0.2], [0.82, -0.2], [0.58, -0.58], [0.3, -0.87]];
    const pts = half.slice();
    pts.push([0, -1.0]);
    for (let i = half.length - 1; i >= 1; i--) pts.push([-half[i][0], half[i][1]]);
    return pts;
  })();
  const ROUND = Array.from({ length: 28 }, (_, i) => [Math.cos((i / 28) * 2 * Math.PI), Math.sin((i / 28) * 2 * Math.PI)]);

  // -- small vector helpers (body frame) --------------------------------------------------------------------
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const len = (a) => Math.hypot(a[0], a[1], a[2]);
  const norm = (a) => {
    const l = len(a) || 1;
    return [a[0] / l, a[1] / l, a[2] / l];
  };
  const frameZ = (z, hint = [0, 0, 1]) => {
    z = norm(z);
    let h = hint;
    if (Math.abs(dot(h, z)) > 0.95) h = [1, 0, 0];
    const x = norm(sub(h, mul(z, dot(h, z))));
    return { x, y: cross(z, x), z };
  };

  const hexCache = {};
  function rgb(c) {
    if (Array.isArray(c)) return c;
    let v = hexCache[c];
    if (!v) {
      const n = parseInt(c.slice(1), 16);
      v = hexCache[c] = [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    }
    return v;
  }

  Lynx.bqGL = (ar, w, cfg = {}) => {
    const R = { ok: false, MAT, v: { add, sub, mul, dot, cross, len, norm, frameZ }, rgb };
    let cv;
    let gl;
    try {
      cv = document.createElement("canvas");
      cv.width = 64;
      cv.height = 64;
      gl = cv.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: cfg.photoreal !== "fast", depth: true, stencil: true, preserveDrawingBuffer: false });
    } catch {
      gl = null;
    }
    if (!gl) return R;

    const prog = gl.createProgram();
    const shader = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    };
    try {
      gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
      gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    } catch (e) {
      R.error = String(e.message || e);
      if (typeof console !== "undefined") console.warn("bqGL shader:", R.error);
      return R;
    }
    gl.useProgram(prog);
    const U = {};
    ["u_proj", "u_size", "u_zr", "u_inv", "u_shadow", "u_org", "u_up", "u_key", "u_keyCol", "u_sky", "u_gnd", "u_fill", "u_flash", "u_time", "u_q", "u_two", "u_sa", "u_bump", "u_aoH"].forEach((n) => (U[n] = gl.getUniformLocation(prog, n)));
    U.pl = gl.getUniformLocation(prog, "u_pl");
    U.plc = gl.getUniformLocation(prog, "u_plc");

    // shapes: vertex arrays with an instance buffer each
    const STRIDE = 20 * 4;
    const shapes = {};
    const makeShape = (mesh) => {
      const vao = gl.createVertexArray();
      gl.bindVertexArray(vao);
      const vb = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vb);
      gl.bufferData(gl.ARRAY_BUFFER, mesh.v, gl.STATIC_DRAW);
      const ib = gl.createBuffer();
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.idx, gl.STATIC_DRAW);
      const vs = 12 * 4;
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, vs, 0);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, vs, 12);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 2, gl.FLOAT, false, vs, 24);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 4, gl.FLOAT, false, vs, 32);
      const inst = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, inst);
      const offs = [[4, 3, 0], [5, 3, 12], [6, 3, 24], [7, 3, 36], [8, 4, 48], [9, 4, 64]];
      offs.forEach(([loc, n, off]) => {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, n, gl.FLOAT, false, STRIDE, off);
        gl.vertexAttribDivisor(loc, 1);
      });
      return { vao, inst, count: mesh.idx.length, data: [] };
    };
    shapes.sphere = makeShape(sphereMesh());
    shapes.cyl = makeShape(cylMesh());
    shapes.box = makeShape(boxMesh());
    shapes.kite = makeShape(plateMesh(KITE, 5));
    shapes.round = makeShape(plateMesh(ROUND, 5));
    gl.bindVertexArray(null);
    // cloth: a dynamic triangle list, one instance by constant attributes
    const clothVao = gl.createVertexArray();
    gl.bindVertexArray(clothVao);
    const clothVb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, clothVb);
    [[0, 3, 0], [1, 3, 12], [2, 2, 24], [3, 4, 32]].forEach(([loc, n, off]) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, n, gl.FLOAT, false, 48, off);
    });
    gl.bindVertexArray(null);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);
    gl.depthFunc(gl.LEQUAL);
    cv.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      R.ok = false;
    });
    R.ok = true;

    // -- frame environment -----------------------------------------------------------------------------------
    let env = { sky: [0.62, 0.68, 0.8], ground: [0.28, 0.25, 0.22], lights: [], key: [1.0, 0.93, 0.8] };
    R.setEnv = (e) => (env = { ...env, ...e });
    const quality = cfg.quality === "low" || cfg.photoreal === "fast" ? 0 : 1;
    let time = 0;
    R.setTime = (t) => (time = t);

    function fit() {
      const c = ar.ctx.canvas;
      if (cv.width !== c.width || cv.height !== c.height) {
        cv.width = c.width;
        cv.height = c.height;
      }
    }

    // world / camera helpers for the current frame
    const KEY_W = norm([-0.34, 0.26, 0.9]); // toward the light, world x, y, up
    function dirCam(F, d) {
      return [d[0] * F.right[0] + d[1] * F.right[1] + d[2] * F.right[2], d[0] * F.down[0] + d[1] * F.down[1] + d[2] * F.down[2], d[0] * F.fwd[0] + d[1] * F.fwd[1] + d[2] * F.fwd[2]];
    }

    // -- one figure -------------------------------------------------------------------------------------------
    R.figure = (o) => {
      if (!R.ok) return null;
      const F = ar.frame;
      const th = w.anchor().th;
      const cth = Math.cos(th);
      const sth = Math.sin(th);
      const K = o.scale;
      const cy = Math.cos(o.yaw);
      const sy = Math.sin(o.yaw);
      const floorToCam = (df, dr, dh) => dirCam(F, [df * cth + dr * sth, df * sth - dr * cth, dh]);
      const ex = floorToCam(cy * K, sy * K, 0);
      const ey = floorToCam(-sy * K, cy * K, 0);
      const ez = floorToCam(0, 0, K);
      const wp = w.toWorld(o.f, o.r);
      const O = ar.camPoint(wp.x, wp.y, o.z);
      const H = o.height || 0.07;
      const body = (v) => [ex[0] * v[0] + ey[0] * v[1] + ez[0] * v[2], ex[1] * v[0] + ey[1] * v[1] + ez[1] * v[2], ex[2] * v[0] + ey[2] * v[1] + ez[2] * v[2]];
      const pt = (v) => add(O, body(v));
      const pc = pt([0, 0, H * 0.5]);
      if (pc[2] < 0.03) return null;
      const m = w.project(o.f, o.r, o.z + K * H * 0.5);
      if (!m) return null;
      const fpx = m.ppm * pc[2];
      const proj = [fpx, m.x - (fpx * pc[0]) / pc[2], m.y - (fpx * pc[1]) / pc[2]];
      const up = dirCam(F, [0, 0, 1]);
      const keyC = dirCam(F, KEY_W);
      const items = { sphere: [], cyl: [], box: [], kite: [], round: [] };
      const cloths = [];
      const col4 = (c, mat) => {
        const k = rgb(c);
        return [k[0], k[1], k[2], MAT[mat] === undefined ? mat : MAT[mat]];
      };
      let seedN = 0;
      const push = (shape, c, X, Y, Z, col, mat, op) => {
        const k = col4(col, mat);
        const a = items[shape];
        a.push(c[0], c[1], c[2], X[0], X[1], X[2], Y[0], Y[1], Y[2], Z[0], Z[1], Z[2], k[0], k[1], k[2], k[3], (op && op.seed !== undefined ? op.seed : ++seedN * 0.37) % 40, op && op.taper !== undefined ? op.taper : 1, op && op.slope ? op.slope : 0, op && op.rust ? op.rust : 0);
      };
      const axes = (fr, rx, ry, rz) => [body(mul(fr.x, rx)), body(mul(fr.y, ry)), body(mul(fr.z, rz))];
      const IDF = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
      const Fg = {
        body, pt,
        // an ellipsoid (radii along the frame's axes; the body axes by default)
        ell(c, rx, ry, rz, col, mat, op = {}) {
          const [X, Y, Z] = axes(op.frame || IDF, rx, ry, rz);
          push("sphere", pt(c), X, Y, Z, col, mat, op);
        },
        ball(c, r, col, mat, op) {
          Fg.ell(c, r, r, r, col, mat, op);
        },
        // a rounded box, half sizes along the frame's axes
        box(c, hx, hy, hz, col, mat, op = {}) {
          const [X, Y, Z] = axes(op.frame || IDF, hx, hy, hz);
          push("box", pt(c), X, Y, Z, col, mat, op);
        },
        // a tapered cylinder from a (radius r0) to b (radius r1)
        seg(a, b, r0, r1, col, mat, op = {}) {
          const d = sub(b, a);
          const l = len(d);
          if (l < 1e-6) return;
          const fr = frameZ(d, op.hint || [0, 0, 1]);
          const [X, Y, Z] = axes(fr, r0, r0, l / 2);
          push("cyl", pt(mul(add(a, b), 0.5)), X, Y, Z, col, mat, { ...op, taper: r1 / r0, slope: (r0 - r1) / l });
        },
        // a limb: a segment with a ball at each end
        cap(a, b, r0, r1, col, mat, op = {}) {
          Fg.seg(a, b, r0, r1, col, mat, op);
          if (!op.noA) Fg.ball(a, r0, col, mat, op);
          if (!op.noB) Fg.ball(b, r1, col, mat, op);
        },
        // a domed shield: kind "kite" | "round"; c its centre, nrm its face (out), up; size [half width, half height, bulge]
        shield(kind, c, nrm, upv, size, col, mat, op = {}) {
          const x = norm(nrm);
          const z = norm(sub(upv, mul(x, dot(upv, x))));
          const y = cross(z, x);
          push(kind, pt(c), body(mul(x, size[2])), body(mul(y, size[0])), body(mul(z, size[1])), col, mat, op);
          // a rim all round
          if (op.rim !== false) {
            const ctr = kind === "kite" ? KITE : ROUND;
            for (let i = 0; i < ctr.length; i++) {
              const a = ctr[i];
              const b = ctr[(i + 1) % ctr.length];
              const pa = add(c, add(mul(y, a[0] * size[0]), mul(z, a[1] * size[1])));
              const pb = add(c, add(mul(y, b[0] * size[0]), mul(z, b[1] * size[1])));
              Fg.seg(pa, pb, op.rimR || 0.0006, op.rimR || 0.0006, op.rimCol || "#b8923c", op.rimMat || "gold", { ...op, taper: 1, slope: 0 });
              Fg.ball(pa, (op.rimR || 0.0006) * 1.02, op.rimCol || "#b8923c", op.rimMat || "gold");
            }
          }
        },
        // a hanging cloth: pts[nu*nv] body points (u across, v down), size [width, height] for the weave
        cloth(pts, nu, nv, size, col, mat, op = {}) {
          const nrmA = new Array(nu * nv);
          const P = (i, j) => pts[Math.max(0, Math.min(nv - 1, j)) * nu + Math.max(0, Math.min(nu - 1, i))];
          for (let j = 0; j < nv; j++) {
            for (let i = 0; i < nu; i++) {
              const du = sub(P(i + 1, j), P(i - 1, j));
              const dv = sub(P(i, j + 1), P(i, j - 1));
              nrmA[j * nu + i] = norm(cross(du, dv));
            }
          }
          const vtx = [];
          const V = (i, j) => {
            const p = pts[j * nu + i];
            const n = nrmA[j * nu + i];
            vtx.push(p[0], p[1], p[2], n[0], n[1], n[2], i / (nu - 1), j / (nv - 1), (i / (nu - 1)) * size[0], (j / (nv - 1)) * size[1], 0, 0);
          };
          for (let j = 0; j < nv - 1; j++) {
            for (let i = 0; i < nu - 1; i++) {
              V(i, j); V(i, j + 1); V(i + 1, j);
              V(i + 1, j); V(i, j + 1); V(i + 1, j + 1);
            }
          }
          const k = col4(col, mat);
          cloths.push({ vtx: new Float32Array(vtx), col: k, extra: op.extra || 0, seed: op.seed || ++seedN * 0.37, pts });
        },
        // the shadow and the figure, onto the 2D canvas
        draw(dop = {}) {
          fit();
          const W = cv.width;
          const Hh = cv.height;
          // screen box of everything, and of its shadow
          let x0 = Infinity;
          let y0 = Infinity;
          let x1 = -Infinity;
          let y1 = -Infinity;
          const scr = (p, r) => {
            const z = Math.max(p[2], 0.02);
            const sx = proj[1] + (fpx * p[0]) / z;
            const sy2 = proj[2] + (fpx * p[1]) / z;
            const rr = (fpx * r) / z + 2;
            x0 = Math.min(x0, sx - rr);
            x1 = Math.max(x1, sx + rr);
            y0 = Math.min(y0, sy2 - rr);
            y1 = Math.max(y1, sy2 + rr);
          };
          const shadowOf = (p) => {
            const h = dot(sub(p, O), up);
            const k = h / dot(keyC, up);
            return [p[0] - keyC[0] * k, p[1] - keyC[1] * k, p[2] - keyC[2] * k];
          };
          Object.keys(items).forEach((nm) => {
            const a = items[nm];
            for (let i = 0; i < a.length; i += 20) {
              const c = [a[i], a[i + 1], a[i + 2]];
              const r = Math.max(Math.hypot(a[i + 3], a[i + 4], a[i + 5]), Math.hypot(a[i + 6], a[i + 7], a[i + 8]), Math.hypot(a[i + 9], a[i + 10], a[i + 11])) * 1.2;
              scr(c, r);
              scr(shadowOf(c), r);
            }
          });
          cloths.forEach((cl) => cl.pts.forEach((p) => {
            const c = pt(p);
            scr(c, 0.002 * K);
            scr(shadowOf(c), 0.002 * K);
          }));
          x0 = Math.max(0, Math.floor(x0));
          y0 = Math.max(0, Math.floor(y0));
          x1 = Math.min(W, Math.ceil(x1));
          y1 = Math.min(Hh, Math.ceil(y1));
          if (x1 - x0 < 2 || y1 - y0 < 2) return;
          gl.viewport(0, 0, W, Hh);
          gl.enable(gl.SCISSOR_TEST);
          gl.scissor(x0, Hh - y1, x1 - x0, y1 - y0);
          gl.clearColor(0, 0, 0, 0);
          gl.clearDepth(1);
          gl.clearStencil(0);
          gl.depthMask(true);
          gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
          gl.useProgram(prog);
          gl.uniform4f(U.u_proj, proj[0], proj[1], proj[2], 0);
          gl.uniform2f(U.u_size, W, Hh);
          gl.uniform2f(U.u_zr, 0.02, 3);
          gl.uniform1f(U.u_inv, 1 / K);
          gl.uniform3fv(U.u_org, O);
          gl.uniform3fv(U.u_up, up);
          gl.uniform3fv(U.u_key, keyC);
          const kc = env.key;
          gl.uniform3f(U.u_keyCol, kc[0] * 2.1, kc[1] * 2.1, kc[2] * 2.1);
          gl.uniform3f(U.u_sky, env.sky[0] * 0.9, env.sky[1] * 0.9, env.sky[2] * 0.9);
          gl.uniform3f(U.u_gnd, env.ground[0], env.ground[1], env.ground[2]);
          gl.uniform3f(U.u_fill, 0.42, 0.42, 0.44);
          gl.uniform1f(U.u_flash, dop.flash || 0);
          gl.uniform1f(U.u_time, time);
          gl.uniform1f(U.u_q, quality);
          gl.uniform1f(U.u_bump, 0.0003 * K);
          gl.uniform1f(U.u_aoH, 0.012 * K);
          // the four strongest lights
          const pl = new Float32Array(16);
          const plc = new Float32Array(12);
          const L = (env.lights || [])
            .map((l) => {
              const wl = w.toWorld(l.f, l.r);
              const pcm = ar.camPoint(wl.x, wl.y, l.h);
              const d = Math.hypot(pcm[0] - pc[0], pcm[1] - pc[1], pcm[2] - pc[2]);
              return { pcm, l, score: (l.k || 1) / (1 + (d / l.rad) ** 2) };
            })
            .sort((a, b) => b.score - a.score)
            .slice(0, 4);
          L.forEach((q, i) => {
            pl.set([q.pcm[0], q.pcm[1], q.pcm[2], q.l.rad], i * 4);
            plc.set([q.l.col[0] * (q.l.k || 1), q.l.col[1] * (q.l.k || 1), q.l.col[2] * (q.l.k || 1)], i * 3);
          });
          gl.uniform4fv(U.pl, pl);
          gl.uniform3fv(U.plc, plc);
          const drawAll = (shadow) => {
            gl.uniform1f(U.u_shadow, shadow ? 1 : 0);
            Object.keys(items).forEach((nm) => {
              const a = items[nm];
              if (!a.length) return;
              const sh = shapes[nm];
              gl.uniform4f(U.u_proj, proj[0], proj[1], proj[2], nm === "cyl" ? 1 : 0);
              gl.uniform1f(U.u_two, nm === "kite" || nm === "round" ? 1 : 0);
              gl.bindVertexArray(sh.vao);
              gl.bindBuffer(gl.ARRAY_BUFFER, sh.inst);
              gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(a), gl.DYNAMIC_DRAW);
              gl.drawElementsInstanced(gl.TRIANGLES, sh.count, gl.UNSIGNED_SHORT, 0, a.length / 20);
            });
            // cloth: one instance, the body's own axes
            if (cloths.length) {
              gl.uniform4f(U.u_proj, proj[0], proj[1], proj[2], 0);
              gl.uniform1f(U.u_two, 1);
              gl.bindVertexArray(clothVao);
              gl.bindBuffer(gl.ARRAY_BUFFER, clothVb);
              cloths.forEach((cl) => {
                gl.bufferData(gl.ARRAY_BUFFER, cl.vtx, gl.DYNAMIC_DRAW);
                const set = (loc, v) => gl.vertexAttrib4f(loc, v[0], v[1], v[2], 0);
                set(4, O); set(5, ex); set(6, ey); set(7, ez);
                gl.vertexAttrib4f(8, cl.col[0], cl.col[1], cl.col[2], cl.col[3]);
                gl.vertexAttrib4f(9, cl.seed, 1, 0, cl.extra);
                gl.drawArrays(gl.TRIANGLES, 0, cl.vtx.length / 12);
              });
            }
          };
          if (dop.shadow !== 0) {
            gl.enable(gl.STENCIL_TEST);
            gl.stencilFunc(gl.NOTEQUAL, 1, 1);
            gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
            gl.depthMask(false);
            gl.disable(gl.DEPTH_TEST);
            gl.uniform1f(U.u_sa, 0.42 * (dop.shadow === undefined ? 1 : dop.shadow));
            drawAll(true);
            gl.disable(gl.STENCIL_TEST);
          }
          gl.depthMask(true);
          gl.enable(gl.DEPTH_TEST);
          drawAll(false);
          gl.bindVertexArray(null);
          gl.disable(gl.SCISSOR_TEST);
          const g = ar.ctx;
          g.save();
          g.globalAlpha = Math.max(0, Math.min(1, dop.alpha === undefined ? 1 : dop.alpha));
          g.drawImage(cv, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
          g.restore();
        },
      };
      return Fg;
    };
    return R;
  };
})(window.Lynx);
