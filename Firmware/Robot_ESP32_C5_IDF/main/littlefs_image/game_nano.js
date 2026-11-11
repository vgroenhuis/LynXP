// Inside the Chip -- a parkour through a chip at the nanometre scale, on the
// hero, drive and camera of Knight on Blocks (game_knightblocks.js, as an
// extension). A technician in a cleanroom suit, shrunk to some 15 nm (1 cm
// on the floor is about 5 nm), runs, jumps and climbs through what's inside
// a modern chip, laid out on the floor in front of the robot:
//   1 The Copper Grid -- the interconnect: copper lines on two layers, vias
//     between them, the dark void of the (taken away) insulating glass below
//   2 Down the Stack -- from a thick top layer down to the thin ones, over
//     signal pulses running along the wires
//   3 The Switch -- a FinFET: silicon fins, gates too tall to climb, spacers,
//     source and drain, contacts. Stepping on a gate's contact switches the
//     transistor on: for a few seconds its channel opens, through the gate
//   4 Gate All Around -- stacked nanosheets (the newest transistors): climb
//     them like a ladder, through two switched gates
// Electrons to collect, nano facts at the glowing info points (what it all
// is, how small, how it's made -- EUV light), hearts: a fall into the void
// or a hit by a signal pulse costs one.
//
// Real cubes found by the camera are part of it too: at this scale a speck
// of dust is a boulder -- they're drawn as dust (climb them!), and the first
// one met tells why chips are made in cleanrooms.
//
// The world: boxes in the level's frame (u forward from where the robot
// stood at the start, v to the right, h up; meters), solid for the hero as
// long blocks (game_knightblocks.js: hu / hv), drawn in short pieces, depth
// sorted with the hero (ar.queue, world3d extents) -- near the camera
// textured (painted here, 128 px = 4 cm: polished copper, tungsten, silicon
// with its atom lattice, the gate's metal, nitride, faceted epitaxial
// silicon, the oxide's glass, the porous void), further away flat colour;
// the setting "textures" off: flat colour everywhere.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  Lynx.games.nano = (ar, cfg, app) => Lynx.games.knightblocks(ar, cfg, app, (api) => Lynx.nanoVoyage(api));

  const CM = 0.01;
  const FALL_S = 0.8;
  const INV_S = 1.4;
  const STORE = "nanoDone";

  // -- the looks: top, the two sides (lit along u, darker along v), the edges ------------------------------
  const STYLES = {
    copper: { tex: "nn_copper", top: "#c87a4a", side: "#9c5832", dark: "#713d20", line: "rgba(40,18,6,0.85)", shine: "rgba(255,226,190,0.55)", name: "copper" },
    copperTop: { tex: "nn_copper", top: "#b8703f", side: "#8e4f2b", dark: "#66361b", line: "rgba(40,18,6,0.85)", shine: "rgba(255,220,180,0.5)" },
    via: { tex: "nn_tungsten", top: "#bfc6ce", side: "#8f97a1", dark: "#676e78", line: "rgba(20,24,30,0.85)", shine: "rgba(255,255,255,0.6)" },
    pad: { tex: "nn_pad", top: "#d9dee4", side: "#a8b0b9", dark: "#7c848e", line: "rgba(30,34,40,0.8)" },
    fin: { tex: "nn_silicon", top: "#9d92b6", side: "#776b91", dark: "#564b70", line: "rgba(20,14,34,0.8)" },
    sheet: { tex: "nn_silicon", top: "#a69bc0", side: "#7d7198", dark: "#5c5076", line: "rgba(20,14,34,0.8)" },
    gate: { tex: "nn_gate", top: "#5f74c0", side: "#4659a3", dark: "#34437e", line: "rgba(10,14,40,0.85)" },
    spacer: { tex: "nn_nitride", top: "rgba(232,237,241,0.8)", side: "rgba(205,213,221,0.62)", dark: "rgba(170,181,192,0.62)", line: "rgba(40,50,60,0.5)" }, // (see-through a little: the gate behind)
    epiN: { tex: "nn_epiN", top: "#74c890", side: "#539f6c", dark: "#3c7a51", line: "rgba(10,40,20,0.8)" },
    epiP: { tex: "nn_epiP", top: "#e08cb4", side: "#b5668b", dark: "#8a4a69", line: "rgba(50,10,30,0.8)" },
    contact: { tex: "nn_tungsten", top: "#c4c9ce", side: "#9399a1", dark: "#6b7179", line: "rgba(20,24,30,0.85)" },
  };

  // -- the textures: painted here (128 px = 4 cm), materials as they are in a chip ----------------------------------
  const streaks = (g, rnd, wrap, n, light, dark, lenMin, lenMax, wMax = 1.2) => {
    for (let k = 0; k < n; k++) {
      const x = rnd() * 128;
      const y = rnd() * 128;
      const l = lenMin + rnd() * (lenMax - lenMin);
      const a = 0.04 + rnd() * 0.1;
      g.strokeStyle = rnd() < 0.55 ? light.replace("A", a.toFixed(3)) : dark.replace("A", a.toFixed(3));
      g.lineWidth = 0.5 + rnd() * wMax;
      wrap(x, y, l, (px, py) => {
        g.beginPath();
        g.moveTo(px, py);
        g.lineTo(px + l, py + (rnd() - 0.5) * 1.5);
        g.stroke();
      });
    }
  };
  const blobs = (g, rnd, wrap, n, rMin, rMax, light, dark) => {
    for (let k = 0; k < n; k++) {
      const x = rnd() * 128;
      const y = rnd() * 128;
      const r = rMin + rnd() * (rMax - rMin);
      g.fillStyle = (rnd() < 0.5 ? light : dark).replace("A", (0.04 + rnd() * 0.08).toFixed(3));
      wrap(x, y, r, (px, py) => {
        g.beginPath();
        g.arc(px, py, r, 0, 2 * Math.PI);
        g.fill();
      });
    }
  };
  const faceted = (base) => (g, rnd, wrap, size, noise) => {
    g.fillStyle = base;
    g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const x = j * 32;
        const y = i * 32;
        for (const tri of [[[x, y], [x + 32, y], [x, y + 32]], [[x + 32, y], [x + 32, y + 32], [x, y + 32]]]) {
          const l = rnd();
          g.fillStyle = l < 0.5 ? `rgba(255,255,255,${(0.04 + l * 0.18).toFixed(3)})` : `rgba(0,0,0,${(0.04 + (l - 0.5) * 0.25).toFixed(3)})`;
          g.beginPath();
          tri.forEach(([a, b], n) => (n ? g.lineTo(a, b) : g.moveTo(a, b)));
          g.closePath();
          g.fill();
          g.strokeStyle = "rgba(255,255,255,0.18)";
          g.lineWidth = 0.8;
          g.stroke();
        }
      }
    }
    noise(7);
  };
  const TEXTURES = {
    nn_copper: Lynx.paintedTexture(301, (g, rnd, wrap, size, noise) => {
      // polished copper: warm and bright, fine grains, faint polishing marks (not wood: no dark streaks)
      const gr = g.createLinearGradient(0, 0, 128, 128);
      gr.addColorStop(0, "#c9784a");
      gr.addColorStop(0.5, "#d98d5c");
      gr.addColorStop(1, "#c9784a");
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
      blobs(g, rnd, wrap, 60, 3, 9, "rgba(255,205,160,A)", "rgba(150,70,35,A)"); // (the grains)
      streaks(g, rnd, wrap, 140, "rgba(255,236,210,A)", "rgba(255,236,210,A)", 4, 22, 0.6); // (polished)
      for (let k = 0; k < 5; k++) {
        const y = rnd() * 128;
        g.strokeStyle = "rgba(255,240,220,0.22)";
        g.lineWidth = 0.6;
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(128, y + (rnd() - 0.5) * 20);
        g.stroke();
      }
      noise(6);
    }),
    nn_tungsten: Lynx.paintedTexture(303, (g, rnd, wrap, size, noise) => {
      g.fillStyle = "#9da3aa";
      g.fillRect(0, 0, 128, 128);
      blobs(g, rnd, wrap, 600, 0.8, 3, "rgba(255,255,255,A)", "rgba(0,0,0,A)");
      noise(12);
    }),
    nn_gate: Lynx.paintedTexture(305, (g, rnd, wrap, size, noise) => {
      g.fillStyle = "#5266aa";
      g.fillRect(0, 0, 128, 128);
      blobs(g, rnd, wrap, 40, 6, 18, "rgba(200,215,255,A)", "rgba(10,20,60,A)");
      streaks(g, rnd, wrap, 200, "rgba(210,225,255,A)", "rgba(10,20,60,A)", 6, 40);
      noise(7);
    }),
    nn_silicon: Lynx.paintedTexture(307, (g, rnd, wrap, size, noise) => {
      g.fillStyle = "#948bab";
      g.fillRect(0, 0, 128, 128);
      noise(7);
      // the crystal: rows of atoms and the bonds between them
      g.strokeStyle = "rgba(220,212,240,0.22)";
      g.lineWidth = 0.8;
      for (let r = 0; r < 16; r++) {
        for (let c = 0; c < 16; c++) {
          const x = c * 8 + (r % 2) * 4;
          const y = r * 8 + 4;
          g.beginPath();
          g.moveTo(x, y);
          g.lineTo(x + 4, y + 8);
          g.moveTo(x, y);
          g.lineTo(x - 4, y + 8);
          g.stroke();
        }
      }
      for (let r = 0; r < 16; r++) {
        for (let c = 0; c < 16; c++) {
          const x = c * 8 + (r % 2) * 4;
          const y = r * 8 + 4;
          wrap(x, y, 3, (px, py) => {
            g.fillStyle = "rgba(40,30,70,0.35)";
            g.beginPath();
            g.arc(px + 0.7, py + 0.7, 1.7, 0, 2 * Math.PI);
            g.fill();
            g.fillStyle = "rgba(235,230,250,0.62)";
            g.beginPath();
            g.arc(px, py, 1.5, 0, 2 * Math.PI);
            g.fill();
          });
        }
      }
    }),
    nn_epiN: Lynx.paintedTexture(309, faceted("#5aa874")),
    nn_epiP: Lynx.paintedTexture(311, faceted("#cf7fa6")),
    nn_nitride: Lynx.paintedTexture(313, (g, rnd, wrap, size, noise) => {
      g.fillStyle = "#e2e7ec";
      g.fillRect(0, 0, 128, 128);
      blobs(g, rnd, wrap, 160, 1, 4, "rgba(255,255,255,A)", "rgba(120,130,150,A)");
      noise(4);
    }),
    nn_pad: Lynx.paintedTexture(315, (g, rnd, wrap, size, noise) => {
      g.fillStyle = "#c6ccd3";
      g.fillRect(0, 0, 128, 128);
      streaks(g, rnd, wrap, 240, "rgba(255,255,255,A)", "rgba(40,50,60,A)", 10, 70);
      // probe marks
      for (let k = 0; k < 3; k++) {
        const x = 20 + rnd() * 88;
        const y = 20 + rnd() * 88;
        g.strokeStyle = "rgba(60,64,70,0.35)";
        g.lineWidth = 2;
        g.beginPath();
        g.ellipse(x, y, 5 + rnd() * 4, 2 + rnd() * 2, rnd() * 3, 0, 2 * Math.PI);
        g.stroke();
      }
      noise(6);
    }),
    nn_oxide: Lynx.paintedTexture(317, (g, rnd, wrap, size, noise) => {
      g.fillStyle = "#7b9bb5";
      g.fillRect(0, 0, 128, 128);
      blobs(g, rnd, wrap, 40, 10, 34, "rgba(220,240,255,A)", "rgba(20,40,70,A)");
      blobs(g, rnd, wrap, 120, 0.6, 1.4, "rgba(255,255,255,A)", "rgba(255,255,255,A)");
      noise(4);
    }),
    nn_void: Lynx.paintedTexture(319, (g, rnd, wrap, size, noise) => {
      g.fillStyle = "#0b1020";
      g.fillRect(0, 0, 128, 128);
      // the porous glass's pores
      for (let k = 0; k < 280; k++) {
        const x = rnd() * 128;
        const y = rnd() * 128;
        const r = 0.8 + rnd() * 2.4;
        wrap(x, y, r + 1, (px, py) => {
          g.fillStyle = "rgba(0,0,0,0.55)";
          g.beginPath();
          g.arc(px, py, r, 0, 2 * Math.PI);
          g.fill();
          g.strokeStyle = "rgba(90,110,170,0.2)";
          g.lineWidth = 0.6;
          g.stroke();
        });
      }
      noise(4);
    }),
  };
  if (Lynx.registerTexture) Object.keys(TEXTURES).forEach((k) => Lynx.registerTexture(k, TEXTURES[k]));
  const TEX_PX_CM = 32; // texture pixels per cm (128 px = 4 cm)
  const TEX_NEAR = 0.65; // m: nearer than this, textured (further: flat colour)

  // -- the levels -----------------------------------------------------------------------------------------
  // Built by code (in cm): boxes {u0, u1, v0, v1, h0, h1, style}, solid
  // unless deco; electrons [u, v, h]; facts {u, v, title, text}; labels {u,
  // v, h, text}; pulses (along a line's top): {line (its id), from, to, period,
  // phase}; switches: {button: {u, v, h}, gate: its tunnels' barriers, onS};
  // goal {u, v, h}; floor: "void" (a fall) or "oxide" (ground, within the
  // rect `oxide` -- the void beyond: no walking round the gates).
  function lv1() {
    const B = [];
    const add = (u0, u1, v0, v1, h0, h1, style, extra) => B.push({ u0, u1, v0, v1, h0, h1, style, ...extra });
    // the landing: an aluminium pad, the start
    add(12, 22, -6, 6, 0, 2.2, "pad");
    // metal 2: lines along, 2 cm wide (h 1 .. 2.2)
    add(22, 30, -1, 1, 1, 2.2, "copper", { id: "A1" });
    add(33, 50, -1, 1, 1, 2.2, "copper", { id: "A2" });
    add(30, 70, -5.5, -3.5, 1, 2.2, "copper", { id: "B" });
    add(48, 86, 2.5, 4.5, 1, 2.2, "copper", { id: "C" });
    // metal 3: lines across, on vias (h 3.6 .. 4.8): hurdles to vault
    add(35, 37, -10, 10, 3.6, 4.8, "copperTop", { id: "X1" });
    add(59, 61, -9, 8, 3.6, 4.8, "copperTop", { id: "X2" });
    for (const [u, v] of [[36, 0], [36, -4.5], [60, -4.5], [60, 3.5]]) add(u - 0.7, u + 0.7, v - 0.7, v + 0.7, 2.2, 3.6, "via");
    // the goal's landing and the via going down
    add(86, 94, 0, 8, 1, 2.2, "pad");
    // the lower layers, far below in the void (not walkable: drawn only)
    for (let u = 20; u < 96; u += 3) B.push({ u0: u, u1: u + 1.1, v0: -16, v1: 16, h0: 0, h1: 0.35, style: "copper", deco: true });
    const E = [];
    for (let u = 24; u <= 29; u += 2.5) E.push([u, 0, 3.4]);
    for (let u = 38; u <= 49; u += 3) E.push([u, 0, 3.4]);
    for (let u = 40; u <= 68; u += 4) E.push([u, -4.5, 3.4]);
    for (let u = 50; u <= 84; u += 3.5) E.push([u, 3.5, 3.4]);
    E.push([36, 0, 6], [60, 3.5, 6]);
    return {
      id: "grid", name: "The Copper Grid", floor: "void",
      intro: "The wiring of a chip: copper lines on two layers, and nothing but void between them",
      hint: "Run along the copper lines; vault the lines crossing above (jump at them), jump the gaps -- don't fall into the void",
      start: [17, 0], goal: { u: 90, v: 4, h: 2.2 }, boxes: B, electrons: E,
      facts: [
        { u: 17, v: 0, title: "You're 15 nanometres tall", text: "That's about a hundred silicon atoms. A hair is 5000 times thicker than you are now." },
        { u: 31.5, v: 0, title: "The void", text: "Between the wires there's normally an insulating glass full of tiny pores (\"low-k\"). We took it away so you can see -- and walk." },
        { u: 36, v: -2, title: "Vias", text: "Vias join one metal layer to the next. A modern chip has 15 or more layers, and kilometres of wire in all." },
        { u: 52, v: 3.5, title: "Copper wires", text: "These copper lines are 20 to 40 nm wide. The copper is poured into trenches, then polished flat, layer after layer." },
        { u: 75, v: 3.5, title: "Printed with light", text: "Each layer's pattern is printed with EUV light of 13.5 nm, made by hitting tiny tin droplets with a laser 50,000 times a second." },
      ],
      labels: [{ u: 26, v: 0, h: 2.6, text: "metal 2" }, { u: 36, v: 7, h: 5.2, text: "metal 3" }, { u: 36, v: -4.5, h: 3, text: "via" }],
      pulses: [],
      switches: [],
    };
  }
  function lv2() {
    const B = [];
    const add = (u0, u1, v0, v1, h0, h1, style, extra) => B.push({ u0, u1, v0, v1, h0, h1, style, ...extra });
    // the top: a thick, wide line, high up (on a tall via)
    add(12, 40, -2, 2, 8.4, 10.5, "copperTop", { id: "M6" });
    add(14, 17, -1.5, 1.5, 0, 8.4, "via");
    // down to metal 5 (across), metal 4 (along), metal 3 (across), metal 2 (along)
    add(43, 46, -13, 3, 6.4, 8, "copper", { id: "M5" });
    add(46, 72, -12, -9, 4.6, 6, "copper", { id: "M4" });
    add(75, 78, -13, 9, 3, 4.2, "copperTop", { id: "M3" });
    add(78, 98, 5, 8, 1.4, 2.6, "copper", { id: "M2" });
    // vias under each line's ends (down to the next)
    for (const [u, v, h0, h1] of [[44.5, -10.5, 6, 6.4], [76.5, -10.5, 4.2, 4.6], [76.5, 6.5, 2.6, 3], [96, 6.5, 0, 1.4]]) add(u - 0.8, u + 0.8, v - 0.8, v + 0.8, h0, h1, "via");
    add(44, 45, 1.5, 2.5, 0, 6.4, "via");
    // the contact at the bottom: the goal
    add(98, 104, 3.5, 9.5, 0, 2.6, "pad");
    for (let u = 20; u < 104; u += 3) B.push({ u0: u, u1: u + 1.1, v0: -16, v1: 16, h0: 0, h1: 0.35, style: "copper", deco: true });
    const E = [];
    for (let u = 20; u <= 38; u += 3) E.push([u, 0, 11.8]);
    for (let v = -2; v >= -10; v -= 3) E.push([44.5, v, 9.3]);
    for (let u = 50; u <= 70; u += 4) E.push([u, -10.5, 7.3]);
    for (let v = -8; v <= 5; v += 3.5) E.push([76.5, v, 5.5]);
    for (let u = 81; u <= 95; u += 3.5) E.push([u, 6.5, 3.9]);
    return {
      id: "stack", name: "Down the Stack", floor: "void",
      intro: "From a thick top wire down through the layers, over the signals racing along them",
      hint: "Drop from one layer to the next; signal pulses race along the lower wires: jump over them",
      start: [16, 0], goal: { u: 101, v: 6.5, h: 2.6 }, boxes: B, electrons: E,
      facts: [
        { u: 20, v: 0, title: "The top layers", text: "The top metal layers are thick and wide: they carry power and the long-distance signals across the chip." },
        { u: 50, v: -10.5, title: "Signals", text: "A signal is a change in voltage, racing along the wire at a good fraction of the speed of light. Mind the pulses!" },
        { u: 76.5, v: -4, title: "Thinner and thinner", text: "Going down, the wires get thinner and closer together, down to a few tens of nanometres apart." },
        { u: 88, v: 6.5, title: "RC delay", text: "Thin wires resist: today, sending a signal along the wires can take longer than switching the transistors themselves." },
      ],
      labels: [{ u: 25, v: 0, h: 11, text: "metal 6" }, { u: 60, v: -10.5, h: 6.6, text: "metal 4" }, { u: 88, v: 6.5, h: 3.1, text: "metal 2" }],
      pulses: [
        { line: "M4", axis: "u", from: 47, to: 71, period: 2.6, phase: 0 },
        { line: "M3", axis: "v", from: -12, to: 8, period: 3, phase: 1.2 },
        { line: "M2", axis: "u", from: 79, to: 97, period: 2.2, phase: 0.5 },
      ],
      switches: [],
    };
  }
  // a gate across the fins (at u, thick d) with a tunnel over each fin
  // (its channel: barred while the transistor is off)
  function gateAcross(add, u, d, vMin, vMax, fins, finW, finTop, top, tunnelTop, id) {
    const half = d / 2;
    const spaced = 0.6;
    let v = vMin;
    const edges = fins.map((fv) => [fv - finW / 2 - 0.2, fv + finW / 2 + 0.2]);
    for (const [a, b] of edges) {
      add(u - half, u + half, v, a, 0, top, "gate", { id: `${id}w${a}` });
      add(u - half - spaced, u - half, v, a, 0, top - 0.3, "spacer");
      add(u + half, u + half + spaced, v, a, 0, top - 0.3, "spacer");
      // over the fin: the gate bridges it, a tunnel under (the channel)
      add(u - half, u + half, a, b, tunnelTop, top, "gate", { id: `${id}b${a}` });
      add(u - half, u + half, a, b, finTop, tunnelTop, "barrier", { id: `${id}x${a}`, barrier: id, deco: false });
      v = b;
    }
    add(u - half, u + half, v, vMax, 0, top, "gate", { id: `${id}w${vMax}` });
    add(u - half - spaced, u - half, v, vMax, 0, top - 0.3, "spacer");
    add(u + half, u + half + spaced, v, vMax, 0, top - 0.3, "spacer");
  }
  function lv3() {
    const B = [];
    const add = (u0, u1, v0, v1, h0, h1, style, extra) => B.push({ u0, u1, v0, v1, h0, h1, style, ...extra });
    const fins = [-6, 0, 6];
    const finW = 1.4;
    const finTop = 2.6;
    for (const fv of fins) add(18, 94, fv - finW / 2, fv + finW / 2, 0, finTop, "fin", { id: `fin${fv}` });
    gateAcross(add, 40, 2.6, -12, 12, fins, finW, finTop, 8.6, 6.2, "g1");
    gateAcross(add, 68, 2.6, -12, 12, fins, finW, finTop, 8.6, 6.2, "g2");
    // source / drain: raised epitaxial silicon on the fins, between the gates
    for (const fv of fins) {
      add(50, 58, fv - 1.6, fv + 1.6, finTop, finTop + 1.1, "epiN");
      add(78, 86, fv - 1.6, fv + 1.6, finTop, finTop + 1.1, "epiN");
      add(24, 32, fv - 1.6, fv + 1.6, finTop, finTop + 1.1, "epiN");
    }
    // contacts: tungsten pillars up from the source and drain
    add(52.5, 55.5, -7.5, -4.5, finTop + 1.1, 10, "contact");
    add(80.5, 83.5, 4.5, 7.5, finTop + 1.1, 10, "contact");
    const E = [];
    for (let u = 20; u <= 36; u += 4) E.push([u, 0, 5.3]);
    for (let u = 44; u <= 64; u += 4) E.push([u, -6, 5.3], [u, 6, 5.3]);
    for (let u = 72; u <= 90; u += 4) E.push([u, 0, 5.3]);
    return {
      id: "finfet", name: "The Switch", floor: "oxide", oxide: { u0: 8, u1: 100, v0: -12, v1: 12 },
      intro: "A transistor: silicon fins, and gates too tall to climb. Switch it on to open its channel",
      hint: "Step on a gate's contact (the glowing pad): the transistor switches on for a while -- run along a fin, through the channel under the gate",
      start: [14, 0], goal: { u: 90, v: 0, h: finTop }, boxes: B, electrons: E,
      facts: [
        { u: 14, v: 0, title: "A transistor", text: "You're at a FinFET, the switch every chip is built of. A big processor has tens of billions of them." },
        { u: 22, v: 0, title: "The fins", text: "The channel runs through these silicon fins, only 5 to 7 nm wide -- a few dozen atoms." },
        { u: 34, v: -9, title: "The gate", text: "The gate wraps the fin on three sides. A voltage on it pulls electrons into the fin: the switch is on." },
        { u: 54, v: 0, title: "Source and drain", text: "Silicon grown on the fins, doped with phosphorus: electrons come in at the source and leave at the drain." },
        { u: 62, v: -9, title: "On and off", text: "Switching takes a few trillionths of a second -- billions of times every second, in every transistor." },
        { u: 86, v: 0, title: "Spacers and high-k", text: "The white spacers keep the gate apart; under the gate, an insulator only a couple of nm thick, of hafnium oxide." },
      ],
      labels: [{ u: 22, v: 6, h: 3.3, text: "fin" }, { u: 40, v: 11, h: 9.4, text: "gate" }, { u: 54, v: 6, h: 4.4, text: "source" }, { u: 82, v: -6, h: 4.4, text: "drain" }, { u: 54, v: -6, h: 10.6, text: "contact" }],
      pulses: [],
      switches: [
        { button: { u: 33, v: -9, h: 0 }, gate: "g1", onS: 9 },
        { button: { u: 61, v: -9, h: 0 }, gate: "g2", onS: 9 },
      ],
    };
  }
  function lv4() {
    const B = [];
    const add = (u0, u1, v0, v1, h0, h1, style, extra) => B.push({ u0, u1, v0, v1, h0, h1, style, ...extra });
    const sheetW = 3.4;
    const th = 0.7;
    const sh = (k) => 1.4 + k * 2.6; // a sheet's underside
    // the stack: three sheets, each shorter at the start -- a staircase up
    // (each run of sheets meets the gates' cores: no gap to fall into)
    const runs = [[20, 47.9], [50.5, 63.9], [66.5, 90]];
    runs.forEach(([a, b], n) => {
      for (let k = 0; k < 3; k++) {
        const s = n === 0 ? a + k * 7 : a;
        add(s, b, -sheetW / 2, sheetW / 2, sh(k), sh(k) + th, "sheet", { id: `s${n}${k}` });
      }
    });
    // the gates all around: walls with a tunnel over the top sheet
    const top = sh(2) + th; // 7.3
    // (14 cm: out of reach from the top sheet, even with a jump)
    gateAcross(add, 49.2, 2.6, -12, 12, [0], sheetW, top, 14, top + 3.4, "g1");
    gateAcross(add, 65.2, 2.6, -12, 12, [0], sheetW, top, 14, top + 3.4, "g2");
    // the gates' cores, wrapped round the sheets (the tunnel's floor on top)
    for (const u of [49.2, 65.2]) add(u - 1.3, u + 1.3, -sheetW / 2 - 0.2, sheetW / 2 + 0.2, 0, top, "gate");
    // inner supports at the stack's ends (source / drain)
    add(88, 92, -2.5, 2.5, 0, top, "epiN");
    // between the gates: the contact pillars, a way back up from the floor
    add(53, 56, -6.5, -4, 0, 2.6, "contact");
    add(56.5, 59.5, -6.5, -4, 0, 5, "contact");
    add(60, 62.6, -4.8, -2.2, 0, 7.3, "contact");
    const E = [];
    for (let u = 22; u <= 46; u += 4) E.push([u, 0, sh(u < 27 ? 0 : u < 34 ? 1 : 2) + th + 1.3]);
    for (const [u, v, h] of [[54.5, -5.2, 3.9], [58, -5.2, 6.3], [57, 0, 8.6], [58, -9, 1.3]]) E.push([u, v, h]);
    for (let u = 70; u <= 86; u += 4) E.push([u, 0, top + 1.3]);
    return {
      id: "gaa", name: "Gate All Around", floor: "oxide", oxide: { u0: 8, u1: 96, v0: -12, v1: 12 },
      intro: "The newest transistors: stacked silicon sheets, the gate all around them. Climb the stack",
      hint: "Climb the sheets like stairs; switch each gate on at its pad and run through on the top sheet. Between the gates the pad is on the floor -- the pillars lead back up",
      start: [15, 0], goal: { u: 86, v: 0, h: top }, boxes: B, electrons: E,
      facts: [
        { u: 16, v: 0, title: "Gate all around", text: "Instead of a fin, a stack of thin silicon sheets, with the gate wrapped all the way round each one: a better switch, less leakage." },
        { u: 30, v: 0, title: "Nanosheets", text: "Each sheet is about 5 nm thick. Chips of the \"2 nm\" generation are built like this." },
        { u: 46, v: -4, title: "What \"2 nm\" means", text: "Nothing on the chip is 2 nm long: it's a generation's name. Gates sit about 45 nm apart, wires about 20." },
        { u: 58, v: -9, title: "Made in layers", text: "A chip takes some three months to make: hundreds of steps of printing, etching, filling and polishing." },
        { u: 76, v: 0, title: "Billions at once", text: "All of this is made at once, for billions of transistors side by side, on a silicon wafer 30 cm across." },
      ],
      labels: [{ u: 24, v: 3, h: 2.6, text: "nanosheet" }, { u: 49.2, v: 9, h: 14.8, text: "gate" }],
      pulses: [],
      switches: [
        { button: { u: 45.5, v: 0, h: top }, gate: "g1", onS: 7 },
        { button: { u: 58, v: -9, h: 0 }, gate: "g2", onS: 12 },
      ],
    };
  }
  const LEVELS = [lv1(), lv2(), lv3(), lv4()];

  // -- the cleanroom suit: a new character on the knight's skeleton ------------------------------------------
  const SUIT = {
    outline: "rgba(20,26,34,0.9)", suit: "#eef2f6", shade: "#cfd7e0", hood: "#e9eef3", zip: "#aab4c0", skin: "#e0a67e", mask: "#ffffff",
    goggle: "#2f5f8f", glint: "#c8f0ff", glove: "#4a82d6", boot: "#dde2ea", sole: "#7f8b99", pack: "#9aa8b8", light: "#7cf7ff",
  };

  Lynx.nanoVoyage = (api) => {
    const { ar, w, hero } = api;
    const { clamp } = api.util;
    const T = (s) => (Lynx.tr ? Lynx.tr(s) : s);
    const maxHearts = clamp(Math.round(+api.cfg.hearts) || 3, 1, 9);
    const store = {
      get() {
        try {
          return JSON.parse(localStorage.getItem(STORE) || "[]");
        } catch (e) {
          return [];
        }
      },
      set(v) {
        try {
          localStorage.setItem(STORE, JSON.stringify(v));
        } catch (e) {
          // (not remembered)
        }
      },
    };
    const G = {
      phase: "menu", sel: 0, idx: -1, lv: null, t: 0, time: 0, levelTime: 0,
      hearts: maxHearts, falls: 0, hurts: 0, flash: null, hint: false, done: new Set(store.get()),
      O: null, safe: null, fallT: 0, inv: 0,
      got: new Set(), seen: new Set(), fact: null, dustSeen: false,
      on: {}, // gate -> seconds left switched on
      boxes: [], pieces: [], solidsStatic: [],
    };
    const say = (text, color) => api.say(T(text), color);
    const sfx = (n) => api.sfx(n);

    // -- the level's frame -----------------------------------------------------------------------------------------
    function toFR(u, v) {
      const c = Math.cos(G.O.th);
      const s = Math.sin(G.O.th);
      return [G.O.f + u * c - v * s, G.O.r + u * s + v * c];
    }
    function toUV(f, r) {
      const c = Math.cos(G.O.th);
      const s = Math.sin(G.O.th);
      const df = f - G.O.f;
      const dr = r - G.O.r;
      return [df * c + dr * s, -df * s + dr * c];
    }
    const P = (u, v, h) => [...toFR(u * CM, v * CM), h * CM]; // cm in the level -> [f, r, h] (m) for world3d

    // the level's boxes: solids for the hero (barriers only while their gate is off), pieces for drawing
    function build(lv) {
      G.boxes = lv.boxes.map((b, n) => ({ ...b, id: b.id || `b${n}`, style: b.style }));
      G.solidsStatic = [];
      G.barriers = [];
      G.pieces = [];
      G.boxes.forEach((b) => {
        const [cf, cr] = toFR(((b.u0 + b.u1) / 2) * CM, ((b.v0 + b.v1) / 2) * CM);
        const hu = ((b.u1 - b.u0) / 2) * CM;
        const hv = ((b.v1 - b.v0) / 2) * CM;
        const s = { id: `n${b.id}`, cf, cr, yaw: G.O.th, hu, hv, half: Math.min(hu, hv), h0: b.h0 * CM, h1: b.h1 * CM, box: b };
        if (b.barrier) G.barriers.push(s);
        else if (!b.deco) G.solidsStatic.push(s);
        if (b.barrier) return; // (drawn as a field, not a box)
        // pieces: at most 4 cm long, so the depth order with the hero holds and the lens doesn't bend long faces
        const alongU = b.u1 - b.u0 >= b.v1 - b.v0;
        const len = alongU ? b.u1 - b.u0 : b.v1 - b.v0;
        const n = Math.max(1, Math.ceil(len / 4));
        for (let k = 0; k < n; k++) {
          const a = (k / n) * len;
          const c = ((k + 1) / n) * len;
          const pc = alongU ? { u0: b.u0 + a, u1: b.u0 + c, v0: b.v0, v1: b.v1 } : { u0: b.u0, u1: b.u1, v0: b.v0 + a, v1: b.v0 + c };
          G.pieces.push({ ...pc, h0: b.h0, h1: b.h1, style: b.style, deco: !!b.deco, box: b, first: k === 0, last: k === n - 1, alongU });
        }
      });
      G.lineOf = {};
      G.boxes.forEach((b) => (G.lineOf[b.id] = b));
    }
    function solids() {
      if (G.phase === "menu" || !G.O) return [];
      return G.solidsStatic.concat(G.barriers.filter((s) => !(G.on[s.box.barrier] > 0)));
    }

    // -- the hero: where she stands, falls, hurts -------------------------------------------------------------------
    const heroUV = () => toUV(hero.f, hero.r).map((x) => x / CM); // cm
    function onFloor() {
      return hero.mode === "move" && hero.onGround && hero.standOn === null && hero.z < 0.003;
    }
    const onOxide = (u, v) => {
      const o = G.lv.oxide;
      return G.lv.floor === "oxide" && !!o && u >= o.u0 && u <= o.u1 && v >= o.v0 && v <= o.v1;
    };
    function startFall() {
      G.fallT = 0.001;
      hero.vf *= 0.3;
      hero.vr *= 0.3;
      sfx("die");
    }
    function respawn() {
      const s = G.safe || G.start;
      api.placeHero(s.f, s.r, hero.yaw);
      G.inv = Math.max(G.inv, 0.8);
    }
    function hurt(why) {
      if (G.inv > 0 || G.phase !== "play") return;
      G.hearts = Math.max(0, G.hearts - 1);
      G.hurts++;
      G.inv = INV_S;
      G.flash = { color: "rgba(120,220,255,0.3)", t: 0 };
      sfx("pain");
      if (G.hearts <= 0) return lose(why);
      respawn();
      say(why, "#9fe8ff");
    }
    function lose(why) {
      G.phase = "lost";
      G.t = 0;
      G.lostWhy = why;
      sfx("lose");
    }
    function updateHero(dt) {
      G.inv = Math.max(0, G.inv - dt);
      if (G.fallT > 0) {
        G.fallT += dt;
        hero.z -= dt * (0.05 + G.fallT * 0.25);
        if (G.fallT >= FALL_S) {
          G.fallT = 0;
          G.falls++;
          G.hearts = Math.max(0, G.hearts - 1);
          respawn();
          if (G.hearts <= 0) return lose("Lost in the void");
          say("Into the void! Back onto the metal", "#9fe8ff");
        }
        return;
      }
      const [hu, hv] = heroUV();
      // the void under the wires (and round the oxide): no floor
      if (onFloor() && !onOxide(hu, hv)) return startFall();
      // safe ground: on a level's box (or the oxide floor)
      if (hero.mode === "move" && hero.onGround && (typeof hero.standOn === "string" ? hero.standOn.startsWith("n") : onOxide(hu, hv) && hero.z < 0.003)) {
        G.safe = { f: hero.f, r: hero.r };
      }
      // electrons
      G.lv.electrons.forEach((e, k) => {
        if (G.got.has(k)) return;
        if (Math.hypot(e[0] - hu, e[1] - hv) < 1.6 && Math.abs(e[2] - (hero.z / CM + 1.5)) < 2.4) {
          G.got.add(k);
          sfx("coin");
        }
      });
      // facts
      G.lv.facts.forEach((fc, k) => {
        if (G.seen.has(k) || Math.hypot(fc.u - hu, fc.v - hv) > 3.2) return;
        G.seen.add(k);
        G.fact = { title: fc.title, text: fc.text, t: 0 };
        sfx("power");
      });
      // dust: a real cube near
      if (!G.dustSeen) {
        const near = api.realSolids.some((b) => !b.inferred && Math.hypot(b.cf - hero.f, b.cr - hero.r) < 0.07);
        if (near) {
          G.dustSeen = true;
          G.fact = { title: "A speck of dust!", text: "At this scale a dust particle is a boulder -- and one is enough to ruin a chip. That's why chips are made in cleanrooms, by people in suits like yours.", t: 0 };
          sfx("power");
        }
      }
      // signal pulses: on that line's top, near the pulse
      for (const p of G.lv.pulses) {
        if (hero.standOn !== `n${p.line}` || hero.mode !== "move" || !hero.onGround) continue;
        const x = pulseAt(p);
        if (Math.abs((p.axis === "u" ? hu : hv) - x) < 1.3) hurt("Zapped by a signal pulse! Jump over them");
      }
      // switches
      for (const s of G.lv.switches) {
        const b = s.button;
        if (Math.hypot(b.u - hu, b.v - hv) < 1.8 && Math.abs(hero.z / CM - b.h) < 0.8 && hero.onGround) {
          if (!(G.on[s.gate] > 0)) {
            sfx("power");
            say("The gate's voltage is on: the channel conducts!", "#9fe8ff");
          }
          G.on[s.gate] = s.onS;
        }
      }
      // the goal
      const gl = G.lv.goal;
      if (Math.hypot(gl.u - hu, gl.v - hv) < 2.2 && Math.abs(hero.z / CM - gl.h) < 1.2 && hero.onGround) win();
    }
    const pulseAt = (p) => p.from + (((G.levelTime / p.period + p.phase) % 1) * (p.to - p.from));

    // -- flow --------------------------------------------------------------------------------------------------------
    function loadLevel(k) {
      const lv = LEVELS[k];
      G.idx = k;
      G.lv = lv;
      G.phase = "play";
      G.t = 0;
      G.levelTime = 0;
      G.hearts = maxHearts;
      G.falls = G.hurts = 0;
      G.fallT = 0;
      G.inv = 0;
      G.hint = false;
      G.got = new Set();
      G.seen = new Set();
      G.fact = null;
      G.on = {};
      const ch = api.chassis();
      G.O = { f: ch.f, r: ch.r, th: ch.th };
      build(lv);
      const [sf, sr] = toFR(lv.start[0] * CM, lv.start[1] * CM);
      G.start = { f: sf, r: sr };
      G.safe = null;
      if (api.refreshSolids) api.refreshSolids();
      api.placeHero(sf, sr, G.O.th);
      api.recenter();
      say(`Level ${k + 1}: ${lv.name}`, "#9fe8ff");
      sfx("go");
    }
    function win() {
      if (G.phase !== "play") return;
      G.phase = "won";
      G.t = 0;
      G.done.add(G.lv.id);
      store.set([...G.done]);
      sfx("levelup");
    }
    function retry() {
      G.phase = "play";
      G.hearts = maxHearts;
      G.fallT = 0;
      G.inv = 0;
      G.safe = null;
      G.on = {};
      api.placeHero(G.start.f, G.start.r, G.O.th);
      api.recenter();
      sfx("go");
    }
    function nextLevel() {
      if (G.idx + 1 < LEVELS.length) {
        G.sel = G.idx + 1;
        loadLevel(G.sel);
      } else {
        G.phase = "menu";
        G.O = null;
        say("Every level done: you've seen the inside of a chip!", "#9fe8ff");
      }
    }
    function toMenu() {
      G.phase = "menu";
      G.O = null;
    }
    function choose(dir) {
      G.sel = (G.sel + dir + LEVELS.length) % LEVELS.length;
      sfx("click");
    }
    function startSelected(state) {
      if (state === "title") api.startPlay();
      loadLevel(G.sel);
    }
    function confirm(state) {
      if (G.phase === "menu") startSelected(state);
      else if (G.phase === "won" && G.t > 0.6) nextLevel();
      else if (G.phase === "lost" && G.t > 0.6) retry();
    }

    // -- drawing ----------------------------------------------------------------------------------------------------
    const g = () => ar.ctx;
    function polyFill(pts, fill, stroke, width = 1) {
      const s = w.polyScreen(pts, 1);
      if (!s) return null;
      const c = g();
      c.beginPath();
      s.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
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
      return s;
    }
    // The floor: the void (dark, far below) or the oxide (pale glass) -- in 5 cm tiles
    function drawFloor() {
      if (G.phase === "menu" || !G.O) return;
      const lv = G.lv;
      const grid = "rgba(220,240,255,0.35)";
      Lynx.asScene(g(), () => {
        for (let u = 8; u < 108; u += 4) {
          for (let v = -24; v < 24; v += 4) {
            const ox = onOxide(u + 2, v + 2);
            const q = [P(u, v, 0), P(u + 4, v, 0), P(u + 4, v + 4, 0), P(u, v + 4, 0)];
            const mid = P(u + 2, v + 2, 0);
            if (texOn && w.camZ(mid[0], mid[1], 0) < TEX_NEAR) {
              // (near: the material -- the oxide's glass, see-through; the void's porous dark)
              const c = g();
              const a0 = c.globalAlpha;
              c.globalAlpha = a0 * (ox ? 0.55 : 0.92);
              const done = texRect(q, 4, 4, Lynx.texture(ox ? "nn_oxide" : "nn_void"));
              c.globalAlpha = a0;
              if (done) continue;
            }
            const s = polyFill(q, ox ? "rgba(120,160,200,0.42)" : "rgba(8,12,24,0.88)", null);
            if (s && ox) {
              // the oxide's grain: a dot at each corner
              const c = g();
              c.fillStyle = grid;
              c.fillRect(s[0].x - 1, s[0].y - 1, 2, 2);
            }
          }
        }
      });
      // the deco: lower layers far below, drawn flat (no depth: the bottom of everything)
      G.pieces.forEach((p) => {
        if (!p.deco) return;
        const q = [P(p.u0, p.v0, p.h1), P(p.u1, p.v0, p.h1), P(p.u1, p.v1, p.h1), P(p.u0, p.v1, p.h1)];
        const mid = P((p.u0 + p.u1) / 2, (p.v0 + p.v1) / 2, p.h1);
        const c = g();
        const a0 = c.globalAlpha;
        c.globalAlpha = a0 * 0.5;
        const done = texOn && w.camZ(mid[0], mid[1], mid[2]) < TEX_NEAR && texRect(q, p.u1 - p.u0, p.v1 - p.v0, Lynx.texture("nn_copper"));
        c.globalAlpha = a0;
        polyFill(q, done ? "rgba(0,0,10,0.45)" : "rgba(130,80,50,0.35)", null); // (far below: in the dark)
      });
      // the switches' pads on the floor, and the wires to their gates
      G.lv.switches.forEach((s) => {
        if (s.button.h > 0) return;
        drawPad(s);
      });
    }
    function drawPad(s) {
      const b = s.button;
      const on = G.on[s.gate] > 0;
      const pts = [];
      for (let k = 0; k < 20; k++) {
        const a = (k / 20) * Math.PI * 2;
        pts.push(P(b.u + Math.cos(a) * 1.6, b.v + Math.sin(a) * 1.6, b.h + 0.05));
      }
      const pulse = 0.5 + 0.5 * Math.sin(G.time * 5);
      polyFill(pts, on ? "rgba(120,255,200,0.75)" : `rgba(255,210,90,${(0.45 + 0.35 * pulse).toFixed(2)})`, on ? "rgba(200,255,230,0.95)" : "rgba(255,240,180,0.95)", 2);
      // the time left: a ring shrinking
      if (on) {
        const u = G.on[s.gate] / s.onS;
        const ring = [];
        for (let k = 0; k <= 24 * u; k++) {
          const a = (k / 24) * Math.PI * 2;
          ring.push(P(b.u + Math.cos(a) * 2.2, b.v + Math.sin(a) * 2.2, b.h + 0.06));
        }
        if (ring.length > 1) w.line3(ring, "rgba(160,255,220,0.95)", 3, 0.01);
      }
      const p = w.project(...P(b.u, b.v, b.h + 1.5));
      if (p) ar.queue(p.depth, () => ar.text(on ? `ON ${Math.ceil(G.on[s.gate])} s` : "GATE", p.x, p.y, { size: Math.max(10, Math.min(16, 0.01 * p.ppm)), align: "center", color: on ? "#a8ffd8" : "#ffe08a" }));
    }

    // A flat rectangle (4 points [f, r, h]: a0, b0, b1, a1 -- lenA cm from a
    // to b, lenB from 0 to 1) textured, in pieces of at most 4 cm (one
    // texture's width each). False: some of it isn't in front of the lens.
    const texOn = api.cfg.textures !== false && !!ar.texturedQuadScreen && !!Lynx.texture;
    function texRect(q, lenA, lenB, img) {
      const nA = Math.max(1, Math.ceil(lenA / 4 - 1e-6));
      const nB = Math.max(1, Math.ceil(lenB / 4 - 1e-6));
      const at = (x, y) => {
        // (bilinear over the corners: a flat rectangle)
        const lo = q[0].map((v, i) => v + (q[1][i] - v) * x);
        const hi = q[3].map((v, i) => v + (q[2][i] - v) * x);
        return lo.map((v, i) => v + (hi[i] - v) * y);
      };
      const grid = [];
      for (let j = 0; j <= nB; j++) {
        const row = [];
        for (let i = 0; i <= nA; i++) row.push(w.project(...at(i / nA, j / nB)));
        grid.push(row);
      }
      if (grid.some((row) => row.some((pt) => !pt))) return false;
      const ua = (lenA / nA) * TEX_PX_CM;
      const ub = (lenB / nB) * TEX_PX_CM;
      const uv = [{ u: 0, v: ub }, { u: ua, v: ub }, { u: ua, v: 0 }, { u: 0, v: 0 }];
      for (let j = 0; j < nB; j++) for (let i = 0; i < nA; i++) ar.texturedQuadScreen([grid[j][i], grid[j][i + 1], grid[j + 1][i + 1], grid[j + 1][i]], img, uv);
      return true;
    }
    // a face's sheen: lit along its top edge, shadowed toward the bottom (a polished solid, not paper)
    function sheen(quad) {
      const top = w.project(...quad[3].map((v, i) => (v + quad[2][i]) / 2));
      const bot = w.project(...quad[0].map((v, i) => (v + quad[1][i]) / 2));
      const s = w.polyScreen(quad, 1);
      if (!top || !bot || !s) return;
      const c = g();
      const gr = c.createLinearGradient(top.x, top.y, bot.x, bot.y);
      gr.addColorStop(0, "rgba(255,245,230,0.22)");
      gr.addColorStop(0.18, "rgba(255,245,230,0.04)");
      gr.addColorStop(1, "rgba(0,0,0,0.25)");
      c.fillStyle = gr;
      c.beginPath();
      s.forEach((p, i) => (i ? c.lineTo(p.x, p.y) : c.moveTo(p.x, p.y)));
      c.closePath();
      c.fill();
    }
    // a straight edge (both ends in front of the lens)
    function line(a, b, color) {
      const pa = w.project(...a);
      const pb = w.project(...b);
      if (!pa || !pb) return;
      const c = g();
      c.strokeStyle = color;
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(pa.x, pa.y);
      c.lineTo(pb.x, pb.y);
      c.stroke();
    }
    // a box piece: the faces toward the camera, the top -- queued with its extent
    function queuePiece(p, cam) {
      const st = STYLES[p.style] || STYLES.via;
      const corners = [[p.u0, p.v0], [p.u1, p.v0], [p.u1, p.v1], [p.u0, p.v1]];
      const fr = corners.map(([u, v]) => toFR(u * CM, v * CM));
      const mid = toFR(((p.u0 + p.u1) / 2) * CM, ((p.v0 + p.v1) / 2) * CM);
      const z = w.camZ(mid[0], mid[1], ((p.h0 + p.h1) / 2) * CM);
      if (z < w.near && fr.every(([f, r]) => w.camZ(f, r, p.h1 * CM) < w.near && w.camZ(f, r, p.h0 * CM) < w.near)) return;
      const [cu, cv] = toUV(cam.f, cam.r).map((x) => x / CM);
      const ch = cam.h / CM;
      const tex = texOn && st.tex && z < TEX_NEAR ? Lynx.texture(st.tex) : null;
      ar.queue(z, () => {
        const c0 = g();
        const alpha0 = c0.globalAlpha;
        if (p.style === "spacer") c0.globalAlpha = alpha0 * 0.8; // (see-through a little: the gate behind)
        // (faces: 0 -v, 1 +u, 2 +v, 3 -u -- corner k to k+1)
        const normals = [[0, -1], [1, 0], [0, 1], [-1, 0]];
        for (let k = 0; k < 4; k++) {
          const [nu, nv] = normals[k];
          if (nu && !(nu > 0 ? p.last || !p.alongU : p.first || !p.alongU)) continue; // (inside a long box: no end face)
          if (nv && !(nv > 0 ? p.last || p.alongU : p.first || p.alongU)) continue;
          const a = corners[k];
          const b = corners[(k + 1) % 4];
          const mu = (a[0] + b[0]) / 2;
          const mv = (a[1] + b[1]) / 2;
          if ((cu - mu) * nu + (cv - mv) * nv <= 0) continue;
          const quad = [P(a[0], a[1], p.h0), P(b[0], b[1], p.h0), P(b[0], b[1], p.h1), P(a[0], a[1], p.h1)];
          // textured (near): the material, then the face's shade over it; else flat
          if (!(tex && texRect(quad, Math.hypot(b[0] - a[0], b[1] - a[1]), p.h1 - p.h0, tex))) polyFill(quad, nu ? st.side : st.dark, null);
          else {
            polyFill(quad, nu ? "rgba(0,0,0,0.12)" : "rgba(0,0,0,0.32)", null);
            sheen(quad);
          }
          // its outline: top and bottom, and the upright edges only where the box ends (no seams between pieces)
          const endFace = p.alongU ? !!nu : !!nv;
          line(P(a[0], a[1], p.h0), P(b[0], b[1], p.h0), st.line);
          line(P(a[0], a[1], p.h1), P(b[0], b[1], p.h1), st.line);
          const startEnd = endFace || (p.alongU ? a[0] === p.box.u0 || a[0] === p.box.u1 : a[1] === p.box.v0 || a[1] === p.box.v1);
          const stopEnd = endFace || (p.alongU ? b[0] === p.box.u0 || b[0] === p.box.u1 : b[1] === p.box.v0 || b[1] === p.box.v1);
          if (startEnd) line(P(a[0], a[1], p.h0), P(a[0], a[1], p.h1), st.line);
          if (stopEnd) line(P(b[0], b[1], p.h0), P(b[0], b[1], p.h1), st.line);
        }
        if (ch > p.h1) {
          const topQ = corners.map(([u, v]) => P(u, v, p.h1));
          if (!(tex && texRect(topQ, p.u1 - p.u0, p.v1 - p.v0, tex))) polyFill(topQ, st.top, null);
          else if (p.style === "copperTop") polyFill(topQ, "rgba(0,0,0,0.08)", null);
          // the edges where the faces end (not between the pieces of one box)
          const c = g();
          c.strokeStyle = st.line;
          c.lineWidth = 1;
          const edge = (a, b) => {
            const pa = w.project(...P(a[0], a[1], p.h1));
            const pb = w.project(...P(b[0], b[1], p.h1));
            if (!pa || !pb) return;
            c.beginPath();
            c.moveTo(pa.x, pa.y);
            c.lineTo(pb.x, pb.y);
            c.stroke();
          };
          if (p.alongU) {
            edge(corners[0], corners[1]);
            edge(corners[2], corners[3]);
            if (p.last) edge(corners[1], corners[2]);
            if (p.first) edge(corners[3], corners[0]);
          } else {
            edge(corners[1], corners[2]);
            edge(corners[3], corners[0]);
            if (p.first) edge(corners[0], corners[1]);
            if (p.last) edge(corners[2], corners[3]);
          }
          // the metal's shine: a bright streak along the top
          if (st.shine) {
            const sv = p.alongU ? p.v0 + (p.v1 - p.v0) * 0.3 : null;
            const su = p.alongU ? null : p.u0 + (p.u1 - p.u0) * 0.3;
            const s = p.alongU ? [P(p.u0, sv, p.h1 + 0.02), P(p.u1, sv, p.h1 + 0.02)] : [P(su, p.v0, p.h1 + 0.02), P(su, p.v1, p.h1 + 0.02)];
            w.line3(s, st.shine, 1.5, 0.01);
          }
        } else if (ch < p.h0 && p.h0 > 0.05) polyFill(corners.map(([u, v]) => P(u, v, p.h0)), st.dark, st.line);
        c0.globalAlpha = alpha0;
      }, extentOf(p));
    }

    // the barriers (a gate's channel, off) and the open channel (on: electrons streaming through)
    // a box's extent for the depth order (its turned corners)
    function extentOf(b) {
      const fr = [[b.u0, b.v0], [b.u1, b.v0], [b.u1, b.v1], [b.u0, b.v1]].map(([u, v]) => toFR(u * CM, v * CM));
      return w.extent(Math.min(...fr.map((q) => q[0])), Math.max(...fr.map((q) => q[0])), Math.min(...fr.map((q) => q[1])), Math.max(...fr.map((q) => q[1])), b.h0 * CM, b.h1 * CM, fr);
    }
    function queueChannels() {
      G.barriers.forEach((s) => {
        const b = s.box;
        const on = G.on[b.barrier] > 0;
        const mid = toFR(((b.u0 + b.u1) / 2) * CM, ((b.v0 + b.v1) / 2) * CM);
        const z = w.camZ(mid[0], mid[1], ((b.h0 + b.h1) / 2) * CM);
        if (z < w.near) return;
        ar.queue(z - 0.001, () => {
          const c = g();
          if (!on) {
            // a red field across the channel: closed
            const fl = 0.35 + 0.15 * Math.sin(G.time * 9 + b.v0);
            for (const u of [b.u0, b.u1]) polyFill([P(u, b.v0, b.h0), P(u, b.v1, b.h0), P(u, b.v1, b.h1), P(u, b.v0, b.h1)], `rgba(255,70,60,${fl.toFixed(2)})`, "rgba(255,150,130,0.9)", 1.5);
          } else {
            // the channel open: electrons streaming along the fin through it
            for (let k = 0; k < 6; k++) {
              const x = b.u0 - 3 + (((G.time * 0.9 + k / 6) % 1) * (b.u1 - b.u0 + 6));
              const p = w.project(...P(x, (b.v0 + b.v1) / 2, b.h0 + 0.5));
              if (!p) continue;
              const r = Math.max(2, 0.005 * p.ppm);
              ar.glow(p.x, p.y, r * 2.2, [[0, "rgba(255,255,255,0.95)"], [0.4, "rgba(120,230,255,0.8)"], [1, "rgba(120,230,255,0)"]]);
            }
            c.globalAlpha = 1;
          }
        }, extentOf(b));
      });
    }
    function queueGlow(u, v, h, rM, inner, outer, extra) {
      const p = w.project(...P(u, v, h));
      if (!p) return;
      ar.queue(p.depth, () => {
        const r = Math.max(2.5, rM * p.ppm);
        ar.glow(p.x, p.y, r * 2.4, [[0, inner], [0.4, outer], [1, outer.replace(/[\d.]+\)$/, "0)")]]);
        if (extra) extra(p, r);
      });
    }
    function drawStanding() {
      if (G.phase === "menu" || !G.O) return;
      const cam = w.camLocal();
      G.pieces.forEach((p) => !p.deco && queuePiece(p, cam));
      queueChannels();
      // raised pads (switches up on a sheet)
      G.lv.switches.forEach((s) => s.button.h > 0 && drawPad(s));
      // electrons
      G.lv.electrons.forEach((e, k) => {
        if (G.got.has(k)) return;
        const bob = Math.sin(G.time * 3 + k) * 0.25;
        queueGlow(e[0], e[1], e[2] + bob, 0.0035, "rgba(255,255,255,0.95)", "rgba(110,200,255,0.85)", (p, r) => ar.text("e⁻", p.x, p.y + r * 0.35, { size: Math.max(8, r * 1.1), align: "center", color: "#08223a", outline: false }));
      });
      // info points not yet read
      G.lv.facts.forEach((fc, k) => {
        if (G.seen.has(k)) return;
        const h = topAt(fc.u, fc.v) + 2.5 + Math.sin(G.time * 2 + k) * 0.3;
        queueGlow(fc.u, fc.v, h, 0.004, "rgba(255,255,230,0.95)", "rgba(255,210,90,0.8)", (p, r) => ar.text("i", p.x, p.y + r * 0.4, { size: Math.max(9, r * 1.3), align: "center", color: "#5a3a00", outline: false }));
      });
      // signal pulses: bright bars racing along their wires
      G.lv.pulses.forEach((pl) => {
        const L = G.lineOf[pl.line];
        const x = pulseAt(pl);
        const h = L.h1 + 0.15;
        const pts = pl.axis === "u" ? [P(x - 1.2, (L.v0 + L.v1) / 2, h), P(x + 1.2, (L.v0 + L.v1) / 2, h)] : [P((L.u0 + L.u1) / 2, x - 1.2, h), P((L.u0 + L.u1) / 2, x + 1.2, h)];
        const mid = pl.axis === "u" ? P(x, (L.v0 + L.v1) / 2, h) : P((L.u0 + L.u1) / 2, x, h);
        const p = w.project(...mid);
        if (!p) return;
        ar.queue(p.depth - 0.002, () => {
          w.line3(pts, "rgba(140,250,255,0.95)", Math.max(3, 0.012 * p.ppm), 0.01);
          ar.glow(p.x, p.y, Math.max(6, 0.02 * p.ppm), [[0, "rgba(255,255,255,0.9)"], [0.4, "rgba(120,240,255,0.6)"], [1, "rgba(120,240,255,0)"]]);
        });
      });
      // the goal: a glowing ring, the way on
      const gl = G.lv.goal;
      const ring = [];
      for (let k = 0; k <= 20; k++) {
        const a = (k / 20) * Math.PI * 2;
        ring.push(P(gl.u + Math.cos(a) * 2, gl.v + Math.sin(a) * 2, gl.h + 0.1));
      }
      const gp = w.project(...P(gl.u, gl.v, gl.h + 3));
      if (gp) {
        ar.queue(gp.depth, () => {
          w.line3(ring, `rgba(160,255,200,${(0.6 + 0.4 * Math.sin(G.time * 5)).toFixed(2)})`, 3, 0.01);
          ar.glow(gp.x, gp.y, Math.max(8, 0.03 * gp.ppm), [[0, "rgba(220,255,230,0.8)"], [0.5, "rgba(120,255,180,0.35)"], [1, "rgba(120,255,180,0)"]]);
          ar.text("EXIT", gp.x, gp.y, { size: Math.max(10, Math.min(18, 0.012 * gp.ppm)), align: "center", color: "#c8ffd8" });
        });
      }
      // labels: what's what
      G.lv.labels.forEach((lb) => {
        const p = w.project(...P(lb.u, lb.v, lb.h));
        if (p) ar.queue(p.depth - 0.003, () => ar.text(T(lb.text), p.x, p.y, { size: Math.max(9, Math.min(15, 0.009 * p.ppm)), align: "center", color: "rgba(230,240,255,0.85)" }));
      });
      // real cubes: dust boulders
      api.realSolids.forEach((b) => {
        if (b.inferred) return;
        const p = w.project(b.cf, b.cr, (b.h0 + b.h1) / 2);
        if (!p) return;
        ar.queue(p.depth, () => drawDust(b, p));
      });
    }
    // the top of whatever stands at a point (cm), for the info points
    function topAt(u, v) {
      let h = 0;
      G.boxes.forEach((b) => {
        if (b.deco || b.barrier) return;
        if (u >= b.u0 && u <= b.u1 && v >= b.v0 && v <= b.v1) h = Math.max(h, b.h1);
      });
      return h;
    }
    // a speck of dust: a lumpy grey boulder where the cube stands
    function drawDust(b, p) {
      const c = g();
      const top = w.project(b.cf, b.cr, b.h1);
      const bot = w.project(b.cf, b.cr, b.h0);
      if (!top || !bot) return;
      const R = Math.max(6, (bot.y - top.y) * 0.62, b.half * 1.25 * p.ppm);
      const cx = p.x;
      const cy = (top.y + bot.y) / 2;
      const seed = (b.tag || 0) * 7.3 + 1;
      c.save();
      for (let n = 0; n < 7; n++) {
        const a = seed + n * 2.1;
        const rr = R * (0.55 + 0.18 * Math.sin(a * 3));
        const x = cx + Math.cos(a) * R * 0.45;
        const y = cy + Math.sin(a) * R * 0.35;
        const gr = c.createRadialGradient(x - rr * 0.3, y - rr * 0.35, rr * 0.1, x, y, rr);
        gr.addColorStop(0, "#a9a39a");
        gr.addColorStop(0.7, "#6e6860");
        gr.addColorStop(1, "#45413c");
        c.fillStyle = gr;
        c.beginPath();
        c.arc(x, y, rr, 0, 2 * Math.PI);
        c.fill();
      }
      // fuzz
      c.strokeStyle = "rgba(200,195,185,0.5)";
      c.lineWidth = 1;
      for (let n = 0; n < 18; n++) {
        const a = n * 0.35 + seed;
        c.beginPath();
        c.moveTo(cx + Math.cos(a) * R * 0.85, cy + Math.sin(a) * R * 0.7);
        c.lineTo(cx + Math.cos(a) * R * 1.05, cy + Math.sin(a) * R * 0.88);
        c.stroke();
      }
      c.restore();
    }

    // -- the suit: white coverall, hood, goggles, blue gloves, a glowing pack ----------------------------------------
    const V = {
      add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
      mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
    };
    function suitPrims(J, Pp) {
      const L = SUIT;
      const out = [];
      const seg = (a, b, rad, color) => out.push({ k: "seg", a: Pp(a), b: Pp(b), rad, color });
      const ball = (c, rad, color) => out.push({ k: "ball", c: Pp(c), rad, color });
      const fwd = [Math.cos(J.twist), Math.sin(J.twist), 0];
      const right = [-Math.sin(J.twist), Math.cos(J.twist), 0];
      const back = V.mul(fwd, -1);
      const lerp3 = (a, b, t) => V.add(a, V.mul(V.add(b, V.mul(a, -1)), t));
      for (const s2 of [-1, 1]) {
        seg(J.hip[s2], J.knee[s2], 0.0025, L.suit);
        seg(J.knee[s2], lerp3(J.knee[s2], J.ankle[s2], 0.55), 0.0023, L.suit);
        seg(lerp3(J.knee[s2], J.ankle[s2], 0.55), J.ankle[s2], 0.0022, L.boot);
        seg(J.ankle[s2], J.toe[s2], 0.002, L.sole);
      }
      seg(V.add(J.pelvis, V.mul(J.up, -0.002)), J.chest, 0.0049, L.suit);
      seg(V.add(J.pelvis, V.mul(fwd, 0.0046)), V.add(J.chest, V.mul(fwd, 0.0046)), 0.0004, L.zip); // the zip
      const packC = V.add(lerp3(J.pelvis, J.chest, 0.65), V.mul(back, 0.0048));
      seg(V.add(packC, [0, 0, 0.0026]), V.add(packC, [0, 0, -0.0026]), 0.0032, L.pack);
      ball(V.add(packC, V.add(V.mul(back, 0.0028), [0, 0, 0.0012])), 0.0012, L.light);
      seg(J.sh[-1], J.sh[1], 0.0022, L.suit);
      for (const s2 of [-1, 1]) {
        seg(J.sh[s2], J.elbow[s2], 0.0018, L.suit);
        seg(J.elbow[s2], J.hand[s2], 0.0016, L.shade);
        ball(J.hand[s2], 0.0017, L.glove);
      }
      // the hood, the face in its opening, a mask over the mouth, goggles
      ball(V.add(J.head, V.mul(back, 0.0008)), 0.006, L.hood);
      ball(V.add(J.head, V.mul(fwd, 0.0024)), 0.0038, L.skin);
      ball(V.add(J.head, V.add(V.mul(fwd, 0.0036), [0, 0, -0.0018])), 0.0026, L.mask);
      seg(V.add(V.add(J.head, V.mul(fwd, 0.0046)), V.add(V.mul(right, -0.0026), [0, 0, 0.0008])), V.add(V.add(J.head, V.mul(fwd, 0.0046)), V.add(V.mul(right, 0.0026), [0, 0, 0.0008])), 0.0013, L.goggle);
      ball(V.add(V.add(J.head, V.mul(fwd, 0.0058)), V.add(V.mul(right, 0.0012), [0, 0, 0.0012])), 0.0005, L.glint);
      return out;
    }
    function drawSuit(J) {
      const K = api.K;
      const prims = suitPrims(J, K.placer(hero.f, hero.r, hero.z, hero.yaw, api.S));
      prims.forEach((p) => p.rad && (p.rad *= api.S));
      const alpha = G.fallT > 0 ? clamp(1 - G.fallT / FALL_S, 0, 1) : G.inv > 0.3 && G.inv < INV_S - 0.2 ? (Math.sin(G.time * 36) > 0 ? 0.45 : 1) : 1;
      K.drawPrims(w, prims, ar, SUIT.outline, alpha);
      return true;
    }

    // -- the HUD, the fact card, the menu -------------------------------------------------------------------------
    function wrapText(text, width, size) {
      const c = g();
      c.save();
      c.font = `bold ${size}px system-ui, sans-serif`;
      const words = T(text).split(" ");
      const out = [];
      let line = "";
      for (const wd of words) {
        const t = line ? `${line} ${wd}` : wd;
        if (c.measureText(t).width > width && line) {
          out.push(line);
          line = wd;
        } else line = t;
      }
      if (line) out.push(line);
      c.restore();
      return out;
    }
    function drawHud() {
      const v = ar.view;
      const small = Lynx.smallScreen();
      const lv = G.lv;
      let y = v.y + (small ? 16 : 20);
      ar.text(`${G.idx + 1}. ${T(lv.name)}`, v.cx, y, { size: small ? 13 : 16, align: "center", color: "#9fe8ff" });
      y += small ? 16 : 20;
      ar.text("♥".repeat(G.hearts) + "♡".repeat(Math.max(0, maxHearts - G.hearts)), v.cx, y, { size: small ? 14 : 18, align: "center", color: "#ff5a5a" });
      ar.text(`e⁻ ${G.got.size}/${lv.electrons.length} · facts ${G.seen.size}/${lv.facts.length}`, v.x + v.w - 14, v.y + (small ? 52 : 60), { size: small ? 12 : 14, align: "right", color: "#bfe6ff" });
      if (G.hint && lv.hint) {
        let hy = v.y + v.h - (small ? 70 : 60);
        wrapText(lv.hint, Math.min(560, v.w - 40), small ? 12 : 14).reverse().forEach((l) => {
          ar.text(l, v.cx, hy, { size: small ? 12 : 14, align: "center", color: "#c8f0ff" });
          hy -= 18;
        });
      }
      // the nano fact: a card at the bottom for a while
      if (G.fact && G.phase === "play") {
        const f = G.fact;
        const wd = Math.min(600, v.w - 30);
        const lines = wrapText(f.text, wd - 30, small ? 12 : 14);
        const hg = 30 + lines.length * (small ? 16 : 19) + 10;
        const x0 = v.cx - wd / 2;
        const y0 = v.y + v.h - hg - (small ? 40 : 46);
        const c = g();
        c.save();
        c.globalAlpha = clamp(Math.min(f.t * 4, (9 - f.t) * 2), 0, 1);
        c.fillStyle = "rgba(6,14,26,0.86)";
        c.strokeStyle = "rgba(255,210,90,0.9)";
        c.lineWidth = 1.5;
        c.beginPath();
        if (c.roundRect) c.roundRect(x0, y0, wd, hg, 8);
        else c.rect(x0, y0, wd, hg);
        c.fill();
        c.stroke();
        ar.text(`ⓘ ${T(f.title)}`, x0 + 14, y0 + 20, { size: small ? 13 : 15, color: "#ffd870" });
        lines.forEach((l, i) => ar.text(l, x0 + 14, y0 + 40 + i * (small ? 16 : 19), { size: small ? 12 : 14, color: "#e8f2ff" }));
        c.restore();
      }
      if (G.flash) ar.flash(G.flash.color, clamp(1 - G.flash.t / 0.4, 0, 1));
      if (G.phase === "won") {
        ar.flash("rgba(4,16,30,0.55)", 1);
        ar.banner(T("SIGNAL DELIVERED!"), T(G.idx + 1 < LEVELS.length ? "Fire / A: the next level" : "Fire / A: back to the menu"), { color: "#9fe8ff" });
        ar.text(`e⁻ ${G.got.size}/${lv.electrons.length} · ${T("facts")} ${G.seen.size}/${lv.facts.length} · ${T("falls")}: ${G.falls} · ${T("time")}: ${Math.round(G.levelTime)} s`, v.cx, v.cy + 60, { size: 14, align: "center", color: "#e0f4ff" });
      } else if (G.phase === "lost") {
        ar.flash("rgba(0,10,30,0.5)", 1);
        ar.banner(T("NO HEARTS LEFT"), T("Fire / A: try again"), { color: "#ff7060" });
        if (G.lostWhy) ar.text(G.lostWhy, v.cx, v.cy + 60, { size: 14, align: "center", color: "#ffd0c8" });
      }
    }
    let menuRows = [];
    function drawMenu() {
      const v = ar.view;
      const small = Lynx.smallScreen();
      ar.flash("rgba(4,8,18,0.82)", 1);
      const titleSize = Math.max(22, Math.min(54, v.w / 11, v.h / 8));
      let y = v.y + titleSize + 8;
      ar.text(T("INSIDE THE CHIP"), v.cx, y, { size: titleSize, align: "center", color: "#9fe8ff", font: "Impact, 'Arial Black', sans-serif", weight: "normal" });
      y += small ? 18 : 24;
      ar.text("Shrunk to 15 nanometres: run, jump and climb through the wires and transistors of a chip", v.cx, y, { size: small ? 11 : 13, align: "center", color: "#d0e6f8" });
      const rw = Math.min(460, v.w - 40);
      const top = y + (small ? 16 : 24);
      const rowH = small ? 20 : 26;
      const rowSize = small ? 12 : 15;
      menuRows = [];
      LEVELS.forEach((l, i) => {
        const ry = top + i * rowH + rowSize;
        const sel = i === G.sel;
        menuRows.push({ i, x0: v.cx - rw / 2, x1: v.cx + rw / 2, y0: ry - rowSize * 1.1, y1: ry - rowSize * 1.1 + rowH });
        if (sel) {
          g().fillStyle = "rgba(120,200,255,0.2)";
          g().fillRect(v.cx - rw / 2, ry - rowSize * 1.1, rw, rowH - 2);
        }
        ar.text(`${i + 1}. ${T(l.name)}`, v.cx - rw / 2 + 14, ry, { size: rowSize, color: sel ? "#e8f8ff" : "#a8c4d8" });
        if (G.done.has(l.id)) ar.text("✔", v.cx + rw / 2 - 14, ry, { size: rowSize, align: "right", color: "#80ff9c" });
      });
      let by = top + LEVELS.length * rowH + (small ? 16 : 24);
      wrapText(LEVELS[G.sel].intro, rw, small ? 11 : 13).forEach((t) => {
        ar.text(t, v.cx, by, { size: small ? 11 : 13, align: "center", color: "#e0f0ff" });
        by += small ? 14 : 18;
      });
      ar.text(
        small ? "Tap a level · tap it again: start" : `The level appears in front of the robot · click a level, again to start · LB / RB, Tab, 1-${LEVELS.length}: choose · Fire / A: start`,
        v.cx, v.y + v.h - 22, { size: small ? 11 : 12, align: "center", color: "#ffe9a8" },
      );
    }
    function rowAt(e) {
      if (G.phase !== "menu" || !menuRows.length) return null;
      const pt = e.touches ? e.touches[0] : e;
      if (!pt) return null;
      const r = g().canvas.getBoundingClientRect();
      const x = pt.clientX - r.left;
      const y = pt.clientY - r.top;
      return menuRows.find((m) => x >= m.x0 && x <= m.x1 && y >= m.y0 && y <= m.y1) || null;
    }
    const onRowDown = (e) => {
      const m = rowAt(e);
      if (!m) return;
      e.stopPropagation();
      if (e.type !== "pointerdown") return;
      e.preventDefault();
      if (m.i === G.sel) startSelected(api.state);
      else {
        G.sel = m.i;
        sfx("click");
      }
    };
    ["pointerdown", "mousedown", "touchstart"].forEach((t) => window.addEventListener(t, onRowDown, { capture: true, passive: false }));
    ar.onDestroy(() => ["pointerdown", "mousedown", "touchstart"].forEach((t) => window.removeEventListener(t, onRowDown, { capture: true })));
    function onKey(e) {
      const t = e.target;
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA"))) return;
      if (e.code === "KeyH" && G.phase === "play") G.hint = !G.hint;
      else if (e.code === "KeyL" && api.state === "playing") toMenu();
    }
    window.addEventListener("keydown", onKey);
    ar.onDestroy(() => window.removeEventListener("keydown", onKey));
    const touch = Lynx.touchButtons();
    const touchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    const menuBtns = [touch.add("▲ Previous level", () => G.phase === "menu" && choose(-1)), touch.add("▼ Next level", () => G.phase === "menu" && choose(1))];
    const hintBtn = touch.add("\u{1F4A1} Hint", () => G.phase === "play" && (G.hint = !G.hint));
    function showButtons() {
      menuBtns.forEach((b) => (b.style.display = G.phase === "menu" && touchDevice ? "" : "none"));
      hintBtn.style.display = G.phase === "play" ? "" : "none";
    }

    return {
      actionLabel: "▶ OK",
      frozen: () => G.phase !== "play" || G.fallT > 0,
      solids,
      drawFloor,
      draw: drawStanding,
      update(dt) {
        G.time += dt;
        showButtons();
        if (G.flash) {
          G.flash.t += dt;
          if (G.flash.t > 0.4) G.flash = null;
        }
        if (G.fact && (G.fact.t += dt) > 9) G.fact = null;
        if (G.phase === "menu" || !G.O) return;
        G.t += dt;
        if (G.phase !== "play") return;
        G.levelTime += dt;
        Object.keys(G.on).forEach((k) => (G.on[k] = Math.max(0, G.on[k] - dt)));
        updateHero(dt);
        if (hero.z < -0.05 && G.fallT <= 0) respawn();
      },
      hud() {
        if (G.phase === "menu") return drawMenu();
        drawHud();
      },
      title() {
        showButtons();
        drawMenu();
        return true;
      },
      helpLine: () => (G.phase === "menu" ? "" : "Move: stick / WASD · Jump: Space / A (at a ledge: catch it, climb) · Robot: right stick / arrows · Hint: H · Levels: L · Center: V"),
      onFire(state) {
        confirm(state);
        return true;
      },
      onJump(state) {
        if (G.phase === "play") return false;
        confirm(state);
        return true;
      },
      unarmed: true,
      hideBlock: () => !!G.O && G.phase !== "menu", // (the real cubes: drawn as dust)
      drawHero: drawSuit,
      hideHero: () => G.phase === "menu",
      onWeapon(wpn) {
        if (G.phase !== "menu") return false;
        if (wpn === "next") choose(1);
        else if (wpn === "prev") choose(-1);
        else if (typeof wpn === "number" && wpn >= 1 && wpn <= LEVELS.length) {
          G.sel = wpn - 1;
          sfx("click");
        }
        return true;
      },
      heroAlpha: () => (G.fallT > 0 ? clamp(1 - G.fallT / FALL_S, 0, 1) : 1),
      snapshot: () => ({
        phase: G.phase, level: G.lv && G.lv.id, hearts: G.hearts, falls: G.falls, hurts: G.hurts,
        electrons: G.lv ? `${G.got.size}/${G.lv.electrons.length}` : null, facts: G.lv ? `${G.seen.size}/${G.lv.facts.length}` : null,
        on: { ...G.on }, hero: G.O ? heroUV().map((x) => +x.toFixed(1)).concat(+(hero.z / CM).toFixed(2)) : null, standOn: hero.standOn, mode: hero.mode,
      }),
      debug: { G, LEVELS, loadLevel, toFR, toUV, win, retry, solids, P },
    };
  };
})(window.Lynx);
