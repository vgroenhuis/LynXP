// Block Quest's people and monsters as 3D models for the renderer in blockquest_gl.js:
// the knight in steel plate and a crimson tabard, and the undead -- skeletons built
// bone by bone, hoplites in bronze, hooded archers, the Brute and the Warden in
// black iron. Every model hangs on the joints that Pocket Knight's skeleton
// (K.bodyJoints) computes, so they walk, swing and fall as the flat sprites did.
//
//   const M = Lynx.bqFigures(R);   M.knight(F, J, st); M.enemy(F, J, e, o)
// F: a figure from R.figure(); J: the joints; st: {time, speed}; e: the enemy.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  Lynx.bqFigures = (R) => {
    const { add, sub, mul, dot, cross, norm, len, frameZ } = R.v;
    const lerp3 = (a, b, t) => add(mul(a, 1 - t), mul(b, t));
    const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
    const WALK_V = 0.06;

    function torso(J) {
      const z = norm(J.up);
      const fwd = [Math.cos(J.twist), Math.sin(J.twist), 0];
      const x = norm(sub(fwd, mul(z, dot(fwd, z))));
      return { x, y: cross(z, x), z };
    }
    const mk = (T) => (c, a, b, d) => add(c, add(mul(T.x, a), add(mul(T.y, b), mul(T.z, d))));

    // A cloth hanging from the edge a-b along `down`
    function hang(F, a, b, down, o, col, mat, cop = {}) {
      const nu = o.nu || 5;
      const nv = o.nv || 6;
      const mid = mul(add(a, b), 0.5);
      const half = mul(sub(b, a), 0.5);
      const pts = [];
      for (let j = 0; j < nv; j++) {
        const v = j / (nv - 1);
        for (let i = 0; i < nu; i++) {
          const u = (i / (nu - 1)) * 2 - 1;
          let p = add(mid, mul(half, u * (1 + (o.flare || 0) * v)));
          p = add(p, mul(down, v));
          p = add(p, mul(o.out || [0, 0, 0], v * v));
          const wave = Math.sin((o.t || 0) * (o.hz || 5) + v * 3.2 + u * 1.7) * (o.amp || 0) * v;
          p = add(p, mul(o.sway || [0, 0, 0], wave));
          pts.push(p);
        }
      }
      F.cloth(pts, nu, nv, [len(sub(b, a)), len(down)], col, mat, cop);
    }

    // a blade (flat box) from p along d
    function blade(F, hand, d, length, o) {
      const gripBack = o.gripBack || 0.003;
      const gp = add(hand, mul(d, o.guardAt || 0.0034));
      const fr = frameZ(d, [0, 0, 1]);
      F.seg(add(hand, mul(d, -gripBack)), add(hand, mul(d, 0.0022)), o.gripR || 0.0011, o.gripR || 0.0011, o.gripCol || "#3a2616", "leather");
      F.ball(add(hand, mul(d, -gripBack - 0.0004)), o.pomR || 0.0017, o.hiltCol || "#c9a24a", o.hiltMat || "gold");
      F.box(gp, o.guardH || 0.0010, o.guardW || 0.0058, 0.0007, o.hiltCol || "#c9a24a", o.hiltMat || "gold", { frame: fr });
      const bc = add(gp, mul(d, 0.0007 + length / 2));
      F.box(bc, o.thick || 0.00032, o.width || 0.0016, length / 2, o.bladeCol || "#cfd6de", o.bladeMat || "steel", { frame: fr, rust: o.rust || 0 });
      if (o.fuller !== false) F.box(add(bc, mul(fr.x, (o.thick || 0.00032) * 0.9)), 0.00012, (o.width || 0.0016) * 0.3, length * 0.42, o.fullerCol || "#8c949c", o.bladeMat || "steel", { frame: fr, rust: o.rust || 0 });
      if (o.tip !== false) F.seg(add(gp, mul(d, 0.0007 + length)), add(gp, mul(d, 0.0007 + length + (o.width || 0.0016) * 1.5)), (o.width || 0.0016) * 0.8, 0.00012, o.bladeCol || "#cfd6de", o.bladeMat || "steel", { rust: o.rust || 0, hint: fr.y });
      return gp;
    }

    // -- the knight ---------------------------------------------------------------------------------------------
    function knight(F, J, st) {
      const T = torso(J);
      const at = mk(T);
      const STEEL = "#aeb6c0";
      const STEEL2 = "#8d96a1";
      const RED = "#9a161e";
      const t = st.time;
      const amp = clamp(st.speed / WALK_V, 0, 3);
      // legs
      for (const s of [-1, 1]) {
        F.cap(J.hip[s], J.knee[s], 0.0037, 0.0031, STEEL2, "steel", { noA: true });
        F.ell(add(J.knee[s], [0.0012, 0, 0.0002]), 0.0026, 0.0036, 0.0030, STEEL, "steel", { frame: T });
        F.seg(J.knee[s], J.ankle[s], 0.0031, 0.0023, STEEL, "steel");
        F.seg(add(J.knee[s], [0.0018, 0, -0.0012]), add(J.ankle[s], [0.0017, 0, 0.001]), 0.0008, 0.0006, STEEL2, "steel", { hint: [0, 1, 0] });
        F.ball(J.ankle[s], 0.0025, STEEL2, "steel");
        const fd = sub(J.toe[s], J.ankle[s]);
        const fl = len(fd);
        F.ell(add(J.ankle[s], add(mul(fd, 0.55), [0, 0, -0.0006])), 0.0017, 0.0023, fl * 0.62 + 0.0012, STEEL2, "steel", { frame: frameZ(fd, [0, 0, 1]) });
      }
      // hips and torso
      F.box(at(J.pelvis, 0.0004, 0, 0.0018), 0.0058, 0.0079, 0.0030, STEEL2, "steel", { frame: T });
      F.box(at(J.pelvis, 0.0003, 0, 0.0048), 0.0062, 0.0083, 0.0013, "#4a3020", "leather", { frame: T });
      F.box(at(J.pelvis, 0.0068, 0, 0.0048), 0.0007, 0.0016, 0.0013, "#c9a24a", "gold", { frame: T });
      F.ell(at(J.pelvis, 0.0003, 0, 0.0092), 0.0059, 0.0080, 0.0058, STEEL2, "steel", { frame: T });
      F.ell(at(J.chest, 0.0006, 0, 0.0004), 0.0066, 0.0094, 0.0098, STEEL, "steel", { frame: T });
      F.ell(at(J.chest, 0.0058, 0, 0.0008), 0.0014, 0.0010, 0.0084, "#c9a24a", "gold", { frame: T });
      F.seg(at(J.neck, 0, 0, -0.0034), at(J.neck, 0, 0, 0.0012), 0.0047, 0.0040, STEEL2, "steel");
      // arms
      for (const s of [-1, 1]) {
        const sh = J.sh[s];
        F.ell(add(sh, mul(T.z, 0.0014)), 0.0042, 0.0058, 0.0030, STEEL, "steel", { frame: T });
        F.ell(add(sh, add(mul(T.z, 0.0034), mul(T.y, s * 0.0008))), 0.0014, 0.0014, 0.0007, "#c9a24a", "gold", { frame: T });
        F.cap(sh, J.elbow[s], 0.0027, 0.0024, STEEL2, "steel", { noA: true });
        F.ball(J.elbow[s], 0.0031, STEEL, "steel");
        F.seg(J.elbow[s], J.hand[s], 0.0026, 0.0020, STEEL2, "steel");
        F.ball(J.hand[s], 0.0023, "#3a2a1c", "leather");
      }
      // head: a bascinet with a visor, a gold band and a plume
      const hd = J.head;
      F.ell(at(hd, 0, 0, 0.0004), 0.0056, 0.0050, 0.0060, STEEL, "steel", { frame: T });
      F.ell(at(hd, 0, 0, 0.0016), 0.0058, 0.0052, 0.0006, "#c9a24a", "gold", { frame: T });
      F.box(at(hd, 0.0050, 0, -0.0004), 0.0008, 0.0033, 0.0005, "#000000", "void", { frame: T });
      for (let k = -1; k <= 1; k++) F.ball(at(hd, 0.0052, k * 0.0016, -0.0030), 0.00028, "#000000", "void");
      F.seg(at(hd, 0.0052, 0, 0.0030), at(hd, 0.0050, 0, -0.0035), 0.00055, 0.00055, STEEL2, "steel");
      {
        const n = 10;
        const pts = [];
        const trail = 0.002 + 0.004 * clamp(amp, 0, 1.4);
        for (let j = 0; j < n; j++) {
          const q = j / (n - 1);
          let x;
          let z;
          if (q < 0.55) {
            const ph = (1.25 - (q / 0.55) * 1.2);
            x = 0.0056 * Math.cos(ph);
            z = 0.0062 * Math.sin(ph) + 0.0002;
          } else {
            const u = (q - 0.55) / 0.45;
            x = -0.0056 * 0.95 - 0.005 * u - trail * u * u;
            z = 0.0004 - 0.0062 * u * u + Math.sin(t * 6 + u * 3) * 0.0006 * u;
          }
          const wd = 0.0013 * (1 - 0.35 * q);
          for (const sd of [-1, 0, 1]) pts.push(at(hd, x, sd * wd, z + 0.0008 * (1 - sd * sd)));
        }
        F.cloth(pts, 3, n, [0.003, 0.014], RED, "cloth", { extra: 0 });
      }
      // tabard: a cross on white, front and back; the cape behind
      const flap = Math.sin(t * 5.5) * 0.0008 * clamp(amp, 0.2, 2);
      {
        const lift = clamp(amp, 0, 1.3);
        hang(F, at(J.pelvis, 0.0064, -0.0050, 0.0044), at(J.pelvis, 0.0064, 0.0050, 0.0044), mul(T.z, -0.0155), { nu: 5, nv: 7, flare: 0.22, out: mul(T.x, 0.0006 + 0.0016 * lift), t, hz: 6, amp: flap, sway: T.x }, "#e6e0d0", "cloth", { extra: 1 });
        hang(F, at(J.pelvis, -0.0062, -0.0050, 0.0044), at(J.pelvis, -0.0062, 0.0050, 0.0044), mul(T.z, -0.0150), { nu: 5, nv: 6, flare: 0.22, out: mul(T.x, -0.0008 - 0.002 * lift), t: t + 1.7, hz: 6, amp: flap, sway: T.x }, "#d8d2c0", "cloth", { extra: 0 });
        const trail = 0.0035 + 0.0125 * clamp(amp, 0, 1.5);
        hang(F, at(J.chest, -0.0070, -0.0090, 0.0072), at(J.chest, -0.0070, 0.0090, 0.0072), mul(T.z, -0.0300), { nu: 7, nv: 9, flare: 0.45, out: add(mul(T.x, -trail), mul(T.z, 0.004 * clamp(amp, 0, 1.2))), t, hz: 5, amp: 0.0012 + 0.0015 * clamp(amp, 0, 1.5), sway: T.y }, "#8c1018", "cloth", { extra: 0 });
      }
      // sword
      if (J.swordDir) {
        const d = norm(J.swordDir);
        blade(F, J.hand[1], d, 0.0178, { width: 0.0017 });
      }
      // shield: raised in front of the chest, or on the left arm
      const KS = [0.0090, 0.0132, 0.0032];
      if (J.shield) {
        const c = J.shield;
        F.shield("kite", add(c, [0.001, 0, -0.0012]), mul(T.x, 1), T.z, KS, "#1f3d7a", "enamel", { extra: 1, rimCol: "#c9a24a" });
      } else {
        const c = add(lerp3(J.elbow[-1], J.hand[-1], 0.5), add(mul(T.y, -0.0042), add(mul(T.x, 0.0014), mul(T.z, -0.0030))));
        F.shield("kite", c, add(mul(T.y, -1), mul(T.x, 0.32)), T.z, KS, "#1f3d7a", "enamel", { extra: 1, rimCol: "#c9a24a" });
      }
    }

    // -- the dead ------------------------------------------------------------------------------------------------------
    function skeletonBody(F, J, T, at, look, angry, o = {}) {
      const bone = o.bone || look.bone;
      const BONE2 = "#cfc3a2";
      // spine
      const sp0 = at(J.pelvis, -0.0030, 0, 0.0008);
      const sp1 = at(J.neck, -0.0038, 0, -0.0014);
      const nV = 8;
      for (let i = 0; i < nV; i++) {
        const q = i / (nV - 1);
        const p = at(lerp3(sp0, sp1, q), -0.0008 * Math.sin(Math.PI * q), 0, 0);
        F.ell(p, 0.0013, 0.0014, 0.0010, bone, "bone", { frame: T });
        F.ell(add(p, mul(T.x, -0.0013)), 0.0010, 0.00035, 0.0008, bone, "bone", { frame: T });
      }
      // ribs: six a side, arcs from the spine round to the sternum
      if (!o.noRibs) {
        for (let i = 0; i < 6; i++) {
          const q = i / 5;
          const base = lerp3(J.pelvis, J.neck, 0.4 + 0.5 * q);
          const kx = 0.80 + 0.2 * Math.sin(Math.PI * (0.15 + 0.7 * q));
          const rx = 0.0054 * kx;
          const ry = 0.0074 * kx;
          for (const s of [-1, 1]) {
            let prev = null;
            const nJ = 8;
            for (let j = 0; j <= nJ; j++) {
              const ph = Math.PI - 0.25 - (j / nJ) * (Math.PI - 0.25 - 0.5);
              const p = at(base, 0.0004 + rx * Math.cos(ph), s * ry * Math.sin(ph), -0.0014 * (1 - ph / Math.PI) * 1.4);
              if (prev) F.seg(prev, p, 0.00058, 0.00058, bone, "bone");
              prev = p;
            }
            F.seg(prev, at(base, 0.0004 + rx, s * 0.0007, -0.0022), 0.00045, 0.00036, BONE2, "bone");
          }
        }
        F.box(at(lerp3(J.pelvis, J.neck, 0.68), 0.0058, 0, 0), 0.00055, 0.0010, 0.0046, BONE2, "bone", { frame: T });
      }
      // shoulder girdle and pelvis
      for (const s of [-1, 1]) {
        F.seg(at(J.neck, 0.0006, s * 0.0008, -0.0014), J.sh[s], 0.00075, 0.00075, bone, "bone");
        F.ell(at(J.sh[s], -0.0024, s * -0.0006, -0.0030), 0.0004, 0.0019, 0.0027, bone, "bone", { frame: T });
        F.ell(at(J.pelvis, -0.0004, s * 0.0034, 0.0020), 0.0020, 0.0010, 0.0028, bone, "bone", { frame: T });
      }
      F.ell(at(J.pelvis, -0.0020, 0, 0.0008), 0.0013, 0.0017, 0.0024, bone, "bone", { frame: T });
      F.ell(at(J.pelvis, 0.0020, 0, -0.0010), 0.0010, 0.0024, 0.0008, bone, "bone", { frame: T });
      // limbs
      for (const s of [-1, 1]) {
        F.cap(J.hip[s], J.knee[s], 0.0015, 0.0012, bone, "bone", { noB: true });
        F.ball(add(J.hip[s], mul(T.y, s * 0.0007)), 0.0019, bone, "bone");
        F.ball(add(J.knee[s], [0, 0.0009, 0]), 0.0016, bone, "bone");
        F.ball(add(J.knee[s], [0, -0.0009, 0]), 0.0016, bone, "bone");
        F.ell(add(J.knee[s], [0.0016, 0, 0.0001]), 0.0007, 0.0011, 0.0012, BONE2, "bone", { frame: T });
        F.seg(J.knee[s], J.ankle[s], 0.0013, 0.0010, bone, "bone");
        F.seg(add(J.knee[s], [0, s * 0.0012, -0.0006]), add(J.ankle[s], [0, s * 0.0011, 0.0004]), 0.0006, 0.0005, bone, "bone");
        F.ball(J.ankle[s], 0.0014, bone, "bone");
        F.ell(add(J.ankle[s], [-0.0008, 0, -0.0013]), 0.0016, 0.0012, 0.0010, bone, "bone", { frame: T });
        for (let k = -1; k <= 1; k++) {
          const a = add(J.ankle[s], [0.0012, k * 0.0008, -0.0012]);
          const b = add(J.toe[s], [0, k * 0.0008, 0]);
          F.seg(a, b, 0.00055, 0.0004, bone, "bone");
        }
        // arms
        F.ball(J.sh[s], 0.0017, bone, "bone");
        F.cap(J.sh[s], J.elbow[s], 0.0012, 0.0010, bone, "bone", { noA: true });
        F.ball(J.elbow[s], 0.0014, bone, "bone");
        const fd = sub(J.hand[s], J.elbow[s]);
        const side = norm(cross(fd, [0, 0, 1]));
        F.seg(J.elbow[s], J.hand[s], 0.0009, 0.0007, bone, "bone");
        F.seg(add(J.elbow[s], mul(side, 0.0008)), add(J.hand[s], mul(side, 0.0007)), 0.0007, 0.0006, bone, "bone");
        F.ell(J.hand[s], 0.0016, 0.0013, 0.0009, bone, "bone", { frame: frameZ(fd, [0, 0, 1]) });
        const fdn = norm(fd);
        for (let k = -1; k <= 1; k++) {
          const a = add(J.hand[s], mul(side, k * 0.0008));
          F.seg(a, add(a, add(mul(fdn, 0.0036), mul(side, k * 0.0004))), 0.00042, 0.0003, bone, "bone");
        }
      }
      // skull
      const hd = J.head;
      F.ell(at(hd, 0, 0, 0.0008), 0.0050, 0.0043, 0.0050, bone, "bone", { frame: T });
      F.ell(at(hd, 0.0026, 0, -0.0020), 0.0030, 0.0030, 0.0022, bone, "bone", { frame: T });
      F.ell(at(hd, 0.0020, 0, -0.0049), 0.0030, 0.0026, 0.0011, bone, "bone", { frame: T });
      for (const s of [-1, 1]) {
        F.ell(at(hd, 0.0037, s * 0.0020, 0.0003), 0.0014, 0.0014, 0.0016, "#000000", "void", { frame: T });
        F.ell(at(hd, 0.0035, s * 0.0030, -0.0014), 0.0012, 0.0010, 0.0010, bone, "bone", { frame: T });
        if (angry) F.ball(at(hd, 0.0043, s * 0.0020, 0.0003), 0.00062, look.eye, "glow");
      }
      F.ell(at(hd, 0.0049, 0, -0.0014), 0.0006, 0.0007, 0.0011, "#000000", "void", { frame: T });
      for (let i = 0; i < 6; i++) {
        F.box(at(hd, 0.0051, (i - 2.5) * 0.0011, -0.0035), 0.0004, 0.0005, 0.0007, "#e7dfc6", "bone", { frame: T });
        F.box(at(hd, 0.0046, (i - 2.5) * 0.0010, -0.0043), 0.0004, 0.0005, 0.0006, "#e0d8bc", "bone", { frame: T });
      }
      F.seg(at(hd, -0.0006, 0, -0.0050), at(J.neck, -0.0036, 0, -0.0016), 0.0008, 0.0009, bone, "bone");
    }

    function enemy(F, J, e, o) {
      const T = torso(J);
      const at = mk(T);
      const kind = e.kind;
      const look = o.look;
      const t = o.time;
      const angry = e.state !== "idle" && e.state !== "dead";
      const armored = (kind === "brute" || kind === "warden") && e.armor;
      const heavy = kind === "brute" || kind === "warden";
      const boneCol = kind === "hoplite" ? "#d9d0b4" : kind === "archer" ? "#c9c0a2" : heavy ? "#d6ccb0" : "#e1d8bd";
      // bone first
      skeletonBody(F, J, T, at, look, angry, { bone: boneCol, noRibs: armored });
      const IRON = heavy ? (kind === "warden" ? "#2f323b" : "#3a3d45") : "#7a736a";
      const TRIM = kind === "warden" ? "#c9a24a" : "#9a7a34";
      if (kind === "skeleton") {
        // a ragged loincloth and a rusted blade; every other one in an iron cap
        hang(F, at(J.pelvis, 0.0040, -0.0036, 0.0030), at(J.pelvis, 0.0040, 0.0036, 0.0030), mul(T.z, -0.0120), { nu: 4, nv: 5, flare: 0.3, out: mul(T.x, 0.0014), t, hz: 4, amp: 0.0006, sway: T.x }, "#4f4030", "cloth", { extra: 3 });
        hang(F, at(J.pelvis, -0.0034, -0.0034, 0.0030), at(J.pelvis, -0.0034, 0.0034, 0.0030), mul(T.z, -0.0100), { nu: 4, nv: 5, flare: 0.3, out: mul(T.x, -0.0012), t: t + 2, hz: 4, amp: 0.0006, sway: T.x }, "#46382a", "cloth", { extra: 3 });
        if (e.id % 2 === 0) {
          F.ell(at(J.head, 0.0002, 0, 0.0030), 0.0054, 0.0046, 0.0030, "#8a8278", "steel", { frame: T, rust: 0.7 });
          F.box(at(J.head, 0.0050, 0, 0.0000), 0.0004, 0.0004, 0.0030, "#8a8278", "steel", { frame: T, rust: 0.7 });
        }
        if (J.swordDir) blade(F, J.hand[1], norm(J.swordDir), 0.0155, { width: 0.0015, rust: 0.8, bladeCol: "#a09a90", hiltCol: "#5a4a34", hiltMat: "steel", pomR: 0.0012, fuller: false });
      } else if (kind === "hoplite") {
        const BR = "#b38a3e";
        // corinthian helm: a bronze dome, cheek guards, slits that glow, a horsehair crest
        const hd = J.head;
        F.ell(at(hd, 0.0004, 0, 0.0002), 0.0060, 0.0054, 0.0066, BR, "bronze", { frame: T, rust: 0.22 });
        F.ell(at(hd, 0.0046, 0, -0.0030), 0.0018, 0.0044, 0.0030, BR, "bronze", { frame: T, rust: 0.22 });
        F.box(at(hd, 0.0060, 0, -0.0006), 0.0006, 0.0034, 0.00055, "#000000", "void", { frame: T });
        for (const s of [-1, 1]) F.ball(at(hd, 0.0063, s * 0.0016, -0.0006), 0.00045, look.eye, "glow");
        F.box(at(hd, 0.0062, 0, -0.0030), 0.0005, 0.0006, 0.0034, BR, "bronze", { frame: T });
        {
          const n = 9;
          const pts = [];
          for (let j = 0; j < n; j++) {
            const ph = 1.3 - (j / (n - 1)) * 2.5;
            const r = 0.0068 + 0.0012 * Math.sin((j / (n - 1)) * Math.PI);
            const x = r * Math.cos(ph) - 0.0006;
            const z = r * Math.sin(ph) + 0.0012 + (ph < 0.2 ? Math.sin(t * 5 + j) * 0.0004 : 0);
            for (const sd of [-1, 0, 1]) pts.push(at(hd, x, sd * 0.0011, z - 0.0005 * sd * sd * 0));
          }
          F.cloth(pts, 3, n, [0.003, 0.016], "#7e1c1c", "cloth", { extra: 0 });
        }
        // muscle cuirass, greaves, a leather kilt, a round shield, a short blade
        F.ell(at(J.chest, 0.0004, 0, 0.0004), 0.0064, 0.0090, 0.0094, BR, "bronze", { frame: T, rust: 0.2 });
        F.ell(at(J.pelvis, 0.0003, 0, 0.0075), 0.0058, 0.0078, 0.0060, BR, "bronze", { frame: T, rust: 0.2 });
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          F.box(at(J.pelvis, 0.0060 * Math.cos(a), 0.0082 * Math.sin(a), -0.0006), 0.0011, 0.0016, 0.0042, "#5a3a22", "leather", { frame: { x: [Math.cos(a), Math.sin(a), 0], y: [-Math.sin(a), Math.cos(a), 0], z: [0, 0, 1] } });
        }
        for (const s of [-1, 1]) {
          F.seg(J.knee[s], J.ankle[s], 0.0023, 0.0018, BR, "bronze", { rust: 0.2 });
          F.ell(add(J.sh[s], mul(T.z, 0.0008)), 0.0030, 0.0042, 0.0022, BR, "bronze", { frame: T, rust: 0.2 });
        }
        const c = [0.0150, -0.0040, J.chest[2] + 0.0006];
        F.shield("round", c, [1, 0, 0], [0, 0, 1], [0.0108, 0.0108, 0.0034], e.guard === false ? "#8a6a30" : "#b38a3e", "enamel", { extra: 2, rimCol: "#8a6a2a", rimMat: "bronze" });
        if (J.swordDir) blade(F, J.hand[1], norm(J.swordDir), 0.0155, { width: 0.0019, bladeCol: "#c8aa5e", bladeMat: "bronze", hiltCol: "#6a4a28", hiltMat: "leather", guardW: 0.0034, fuller: false });
      } else if (kind === "archer") {
        const OL = "#4a4a30";
        const hd = J.head;
        // hood and cloak
        F.ell(at(hd, -0.0016, 0, 0.0006), 0.0062, 0.0058, 0.0066, OL, "cloth", { frame: T });
        F.seg(at(hd, -0.0030, 0, 0.0046), at(hd, -0.0095, 0, -0.0004), 0.0026, 0.0003, OL, "cloth");
        hang(F, at(J.chest, -0.0058, -0.0086, 0.0066), at(J.chest, -0.0058, 0.0086, 0.0066), mul(T.z, -0.0300), { nu: 6, nv: 8, flare: 0.35, out: mul(T.x, -0.0030), t, hz: 3, amp: 0.001, sway: T.y }, "#4d4a34", "cloth", { extra: 3 });
        // quiver and arrows
        const qa = at(J.chest, -0.0092, 0.0030, -0.0070);
        const qb = at(J.chest, -0.0074, 0.0030, 0.0070);
        F.seg(qa, qb, 0.0020, 0.0022, "#5a3a22", "leather");
        for (let k = 0; k < 4; k++) {
          const off = [-0.0006 + k * 0.0004, 0.0030 + (k % 2 ? 0.0006 : -0.0006), 0];
          const top = add(qb, add(mul(T.z, 0.0042 + k * 0.0004), at([0, 0, 0], off[0], off[1], 0)));
          F.seg(add(qb, add(mul(T.z, -0.001), at([0, 0, 0], off[0], off[1], 0))), top, 0.00028, 0.00028, "#a8864e", "wood");
          F.ell(top, 0.00045, 0.00045, 0.0008, "#d8d0c0", "cloth");
        }
        // the bow (the left hand holds it), and the string drawn back to the right
        const hand = J.hand[-1];
        const bowC = add(hand, [0.0006, 0, 0]);
        const pts = [];
        for (let k = 0; k <= 8; k++) {
          const q = (k / 8) * 2 - 1;
          pts.push(add(bowC, [0.0036 * (1 - q * q) - 0.0014, 0, 0.0172 * q]));
        }
        for (let k = 0; k < 8; k++) F.seg(pts[k], pts[k + 1], 0.00085 * (1 - 0.4 * Math.abs((k - 3.5) / 4)), 0.00085 * (1 - 0.4 * Math.abs((k + 0.5 - 3.5) / 4)), "#7a5430", "wood");
        const draw = e.state === "windup" ? clamp(e.t / o.windup, 0, 1) : 0;
        const nock = add(bowC, [-0.0006 - 0.012 * draw, 0.0006, 0]);
        F.seg(pts[0], nock, 0.00022, 0.00022, "#e6dfce", "cloth");
        F.seg(nock, pts[8], 0.00022, 0.00022, "#e6dfce", "cloth");
        if (e.state === "windup") {
          const tipP = add(nock, [0.0235, 0, 0]);
          F.seg(nock, tipP, 0.00036, 0.00036, "#a8864e", "wood");
          F.seg(tipP, add(tipP, [0.0026, 0, 0]), 0.00075, 0.0001, "#b9bfc6", "steel");
          F.ell(add(nock, [0.0014, 0, 0]), 0.0012, 0.00035, 0.0007, "#d8d0c0", "cloth");
        }
      } else if (heavy) {
        const warden = kind === "warden";
        const hd = J.head;
        const rust = warden ? 0.12 : 0.3;
        if (armored) {
          F.ell(at(J.chest, 0.0008, 0, 0.0004), 0.0072, 0.0100, 0.0106, IRON, "steel", { frame: T, rust });
          F.ell(at(J.pelvis, 0.0004, 0, 0.0092), 0.0066, 0.0088, 0.0064, IRON, "steel", { frame: T, rust });
          F.box(at(J.chest, 0.0072, 0, 0.0020), 0.0004, 0.0012, 0.0070, TRIM, warden ? "gold" : "bronze", { frame: T });
          F.box(at(J.chest, 0.0070, 0, 0.0020), 0.0004, 0.0050, 0.0010, TRIM, warden ? "gold" : "bronze", { frame: T });
          // runes smouldering on the plate
          for (const s of [-1, 1]) F.box(at(J.chest, 0.0071, s * 0.0036, -0.0022), 0.0003, 0.0004, 0.0030, look.eye, "glow", { frame: T });
          F.box(at(J.chest, 0.0071, 0, -0.0060), 0.0003, 0.0030, 0.0004, look.eye, "glow", { frame: T });
        } else {
          // the armour cracked open: the ribs show a coal in the dark
          F.ball(at(J.chest, 0.0006, 0, 0.0004), 0.0026, "#ff5a18", "flame");
          for (const s of [-1, 1]) F.ell(at(J.chest, -0.0026, s * 0.0070, 0.0010), 0.0011, 0.0030, 0.0070, IRON, "steel", { frame: T, rust: 0.6 });
          F.ell(at(J.pelvis, 0.0004, 0, 0.0092), 0.0062, 0.0082, 0.0044, IRON, "steel", { frame: T, rust: 0.6 });
        }
        for (const s of [-1, 1]) {
          const sh = J.sh[s];
          F.ell(add(sh, mul(T.z, 0.0020)), 0.0050, 0.0068, 0.0034, IRON, "steel", { frame: T, rust });
          F.seg(add(sh, add(mul(T.z, 0.0030), mul(T.y, s * 0.0030))), add(sh, add(mul(T.z, 0.0100), mul(T.y, s * 0.0046))), 0.0013, 0.0001, boneCol, "bone");
          F.cap(sh, J.elbow[s], 0.0029, 0.0026, IRON, "steel", { noA: true, rust });
          F.seg(J.elbow[s], J.hand[s], 0.0028, 0.0023, IRON, "steel", { rust });
          F.ball(J.hand[s], 0.0027, "#23242a", "steel");
          F.cap(J.hip[s], J.knee[s], 0.0036, 0.0031, IRON, "steel", { noA: true, rust });
          F.seg(J.knee[s], J.ankle[s], 0.0030, 0.0024, IRON, "steel", { rust });
          F.ell(add(J.knee[s], [0.0012, 0, 0]), 0.0024, 0.0034, 0.0030, IRON, "steel", { frame: T, rust });
          const fd = sub(J.toe[s], J.ankle[s]);
          F.ell(add(J.ankle[s], add(mul(fd, 0.55), [0, 0, -0.0006])), 0.0018, 0.0025, len(fd) * 0.62 + 0.0012, IRON, "steel", { frame: frameZ(fd, [0, 0, 1]), rust });
        }
        // helm with horns and burning slits
        F.ell(at(hd, 0, 0, 0.0004), 0.0062, 0.0056, 0.0064, IRON, "steel", { frame: T, rust });
        F.box(at(hd, 0.0057, 0, 0.0002), 0.0007, 0.0034, 0.00055, "#000000", "void", { frame: T });
        for (const s of [-1, 1]) {
          F.ball(at(hd, 0.0060, s * 0.0018, 0.0002), 0.00055, look.eye, "glow");
          const base = at(hd, 0.0004, s * 0.0046, 0.0024);
          const mid = at(hd, 0.0004, s * 0.0092, 0.0050);
          const tip = at(hd, 0.0030, s * 0.0102, warden ? 0.0140 : 0.0108);
          F.seg(base, mid, warden ? 0.0021 : 0.0017, warden ? 0.0015 : 0.0012, "#d8cfb2", "bone");
          F.seg(mid, tip, warden ? 0.0015 : 0.0012, 0.00008, "#d8cfb2", "bone");
        }
        if (warden) {
          for (let k = 0; k < 5; k++) {
            const a = -0.9 + k * 0.45;
            F.seg(at(hd, -0.0004 + 0.0040 * Math.cos(a), 0.0044 * Math.sin(a), 0.0048), at(hd, -0.0004 + 0.0046 * Math.cos(a), 0.0052 * Math.sin(a), 0.0090 + (k === 2 ? 0.0024 : 0)), 0.0007, 0.0001, TRIM, "gold");
          }
          // a ragged black cloak
          hang(F, at(J.chest, -0.0078, -0.0100, 0.0084), at(J.chest, -0.0078, 0.0100, 0.0084), mul(T.z, -0.0360), { nu: 7, nv: 9, flare: 0.5, out: mul(T.x, -0.0040), t, hz: 2.4, amp: 0.0016, sway: T.y }, "#1b1820", "cloth", { extra: 3 });
          // the round shield with a skull boss
          const c = [0.0170, -0.0040, J.chest[2] + 0.0006];
          F.shield("round", c, [1, 0, 0], [0, 0, 1], [0.0128, 0.0128, 0.0040], "#2a2c34", "enamel", { extra: 3, rimCol: TRIM, rimMat: "gold", rimR: 0.0007 });
        }
        if (J.swordDir) {
          const d = norm(J.swordDir);
          const gp = blade(F, J.hand[1], d, warden ? 0.030 : 0.0235, { width: warden ? 0.0030 : 0.0025, thick: 0.0005, bladeCol: "#6b717b", fullerCol: look.eye, hiltCol: TRIM, hiltMat: warden ? "gold" : "bronze", guardW: 0.0075, rust: 0.25, gripBack: 0.0036 });
          void gp;
        }
        // the brute's wide belt and skull buckle
        if (!warden) F.box(at(J.pelvis, 0.0070, 0, 0.0050), 0.0007, 0.0022, 0.0020, boneCol, "bone", { frame: T });
      }
    }

    // -- things: the bomb, the powder keg, an arrow ----------------------------------------------------------------
    // (figures at their own size: one body unit is the bomb's radius, the keg's radius, a meter)
    function bomb(F, st) {
      const iron = "#2b2d32";
      F.ball([0, 0, 1], 1, iron, "steel", { rust: 0.22 });
      for (const k of [-0.42, 0.34]) F.ell([0, 0, 1 + k], 1.03 * Math.sqrt(1 - k * k), 1.03 * Math.sqrt(1 - k * k), 0.07, "#4a4d54", "steel");
      F.seg([0, 0, 1.78], [0, 0, 2.02], 0.42, 0.34, "#3a2c1c", "leather");
      F.seg([0, 0, 2.0], [0.2, 0, 2.38], 0.1, 0.09, "#6a5a40", "cloth");
      F.seg([0.2, 0, 2.38], [0.34, 0, 2.62], 0.09, 0.08, "#6a5a40", "cloth");
      F.ball([0.36, 0, 2.66], st.fuse ? 0.26 : 0.13, st.fuse ? "#ffc060" : "#ff6a20", "glow");
      if (!st.fuse && st.led) F.ball([0.98, 0, 1.16], 0.18, "#ff2a20", "glow");
      F.box([0.97, 0, 1.16], 0.13, 0.2, 0.13, "#1a1a1d", "steel");
    }
    function keg(F, k) {
      const R0 = 1;
      const rs = [0.82, 0.98, 1.0, 0.98, 0.82];
      const H = k.height / k.rad;
      for (let i = 0; i < 4; i++) {
        F.seg([0, 0, (i / 4) * H], [0, 0, ((i + 1) / 4) * H], rs[i] * R0, rs[i + 1] * R0, k.burnt > 0.4 ? "#3a2a20" : "#8a5a30", "wood");
      }
      F.ell([0, 0, H], 0.8 * R0, 0.8 * R0, 0.05, "#6a4426", "wood");
      for (const q of [0.12, 0.34, 0.66, 0.88]) {
        const i = Math.min(3, Math.floor(q * 4));
        const rr = rs[i] + (rs[i + 1] - rs[i]) * (q * 4 - i) + 0.03;
        F.seg([0, 0, q * H - 0.05], [0, 0, q * H + 0.05], rr * R0, rr * R0, "#3b3d44", "steel", { rust: 0.3 });
      }
      if (k.state === "fuse") {
        F.seg([0, 0, H], [0.1, 0, H + 0.4], 0.05, 0.05, "#d8c8a0", "cloth");
        F.ball([0.1, 0, H + 0.45], 0.13, "#ffd070", "glow");
      }
    }
    function arrow(F, d, stuck) {
      const L = 0.016;
      const tip = [0, 0, 0];
      const tail = mul(d, -L);
      const fr = frameZ(d, [0, 0, 1]);
      F.seg(tail, tip, 0.0004, 0.0004, "#a8864e", "wood");
      F.seg(add(tip, mul(d, -0.0032)), add(tip, mul(d, 0.0004)), 0.0009, 0.00008, "#b8bec6", "steel");
      for (const a of [0, 2.1, 4.2]) {
        const off = add(mul(fr.x, Math.cos(a) * 0.0006), mul(fr.y, Math.sin(a) * 0.0006));
        F.ell(add(add(tail, mul(d, 0.0016)), off), 0.00028, 0.00028, 0.0014, "#e4dccb", "cloth", { frame: frameZ(d, off) });
      }
      void stuck;
    }

    return { knight, enemy, bomb, keg, arrow, torso, hang };
  };
})(window.Lynx);
