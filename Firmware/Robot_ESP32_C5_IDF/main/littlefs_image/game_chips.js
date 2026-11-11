// Chip Foundry -- logic puzzles on a silicon die, with real cubes. The floor
// in front of the robot becomes a chip seen under the microscope: a die
// with bond pads, gold bond wires out to the package's leads, power rails,
// metal traces on two layers (with vias where they turn) and empty cells
// in the standard-cell rows. Signals run along the traces as glowing
// electrons -- bright for a 1, dim for a 0.
//
// The tagged cubes are chips (each drawn as a little DIP package with its
// 7400-series part number), and set down in an empty cell they become its
// logic gate:
//   0 NOT (74HC04)  1 AND (74HC08)  2 OR (74HC32)
//   3 XOR (74HC86)  4 NAND (74HC00) 5 NOR (74HC02)
// A cube stacked on top of a cell inverts its output (an extra inverter:
// AND + a cube on top = NAND), whatever its tag. A cell with one input
// feeds it to both of the gate's (NAND of A and A is NOT A); a NOT in a
// two-input cell uses the first (upper) input.
//
// The test vectors run through the input pads, one step at a time, and the
// logic analyzer at the bottom of the screen shows each signal: the outputs
// as they are, and as they should be (WANT). When every step matches, the
// circuit is verified and taped out. Stars: one for a working chip, two for
// a lean one, three for the fewest transistors possible (as a real chip's
// area: NOT 2, NAND / NOR 4, AND / OR 6, XOR 8, a stacked inverter 2).
// Each level's best is worked out here, by trying every way to fill it.
//
// The levels: an inverter, AND, XOR, a half adder, AND with the AND and OR
// chips sold out (NAND is universal), a majority vote (a full adder's
// carry), a multiplexer and a latch -- memory out of feedback.
//
// Drawing: the 2D canvas through world3d.js (lens-aware, depth sorted with
// ar.queue): flat colour and lines, no textures.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  // the cells' chips, by tag
  const GATES = [
    { tag: 0, name: "NOT", part: "74HC04", tr: 2, color: [120, 220, 255] },
    { tag: 1, name: "AND", part: "74HC08", tr: 6, color: [255, 200, 90] },
    { tag: 2, name: "OR", part: "74HC32", tr: 6, color: [140, 240, 140] },
    { tag: 3, name: "XOR", part: "74HC86", tr: 8, color: [255, 130, 220] },
    { tag: 4, name: "NAND", part: "74HC00", tr: 4, color: [255, 150, 90] },
    { tag: 5, name: "NOR", part: "74HC02", tr: 4, color: [170, 160, 255] },
  ];
  const INV_TR = 2; // a stacked cube: an inverter
  // A gate's output from its inputs (0, 1 or null: unknown -- a 0 into an
  // AND decides it all the same, as in a real chip)
  function gateOut(tag, a, b) {
    switch (tag) {
      case 0:
        return a === null ? null : 1 - a;
      case 1:
        return a === 0 || b === 0 ? 0 : a === null || b === null ? null : 1;
      case 2:
        return a === 1 || b === 1 ? 1 : a === null || b === null ? null : 0;
      case 3:
        return a === null || b === null ? null : a ^ b;
      case 4:
        return a === 0 || b === 0 ? 1 : a === null || b === null ? null : 0;
      case 5:
        return a === 1 || b === 1 ? 0 : a === null || b === null ? null : 1;
      default:
        return null;
    }
  }

  // The levels. Board: cols x rows tiles (rows from the robot outward; the
  // signals run left to right). Inputs: pads on the left edge, at a row;
  // outputs: pads on the right edge, fed by a cell. Cells: at [col, row],
  // fed by pads or other cells (`detour`: the row a wire going back left
  // runs along). want: the output's function of the inputs -- or, for a
  // sequential level, `seq` (the inputs, step by step) and `wantSeq`.
  // allowed: the tags in stock (default all).
  const LEVELS = [
    {
      id: "inv", name: "The Inverter", blurb: "One cell: the output is the opposite of the input", card: "inv",
      cols: 10, rows: 6,
      inputs: [{ n: "A", row: 3 }],
      cells: [{ id: "c1", at: [5, 3], in: ["A"] }],
      outputs: [{ n: "Y", row: 3, from: "c1", want: (v) => 1 - v.A }],
    },
    {
      id: "and", name: "Both or Nothing", blurb: "A 1 out only when both inputs are 1", card: "and",
      cols: 10, rows: 6,
      inputs: [{ n: "A", row: 4 }, { n: "B", row: 2 }],
      cells: [{ id: "c1", at: [5, 3], in: ["A", "B"] }],
      outputs: [{ n: "Y", row: 3, from: "c1", want: (v) => v.A & v.B }],
    },
    {
      id: "xor", name: "Spot the Difference", blurb: "A 1 out when the inputs differ", card: "xor",
      cols: 10, rows: 6,
      inputs: [{ n: "A", row: 4 }, { n: "B", row: 2 }],
      cells: [{ id: "c1", at: [5, 3], in: ["A", "B"] }],
      outputs: [{ n: "Y", row: 3, from: "c1", want: (v) => v.A ^ v.B }],
    },
    {
      id: "half", name: "Half Adder", blurb: "1 + 1 = 10: a SUM and a CARRY, two cells", card: "half",
      cols: 11, rows: 7,
      inputs: [{ n: "A", row: 5 }, { n: "B", row: 1 }],
      cells: [{ id: "c1", at: [6, 5], in: ["A", "B"] }, { id: "c2", at: [6, 1], in: ["A", "B"] }],
      outputs: [{ n: "SUM", row: 5, from: "c1", want: (v) => v.A ^ v.B }, { n: "CARRY", row: 1, from: "c2", want: (v) => v.A & v.B }],
    },
    {
      id: "nand", name: "Sold Out", blurb: "AND again -- without the AND and OR chips", card: "nand", allowed: [0, 3, 4, 5],
      cols: 11, rows: 6,
      inputs: [{ n: "A", row: 4 }, { n: "B", row: 2 }],
      cells: [{ id: "c1", at: [4, 3], in: ["A", "B"] }, { id: "c2", at: [7, 3], in: ["c1"] }],
      outputs: [{ n: "Y", row: 3, from: "c2", want: (v) => v.A & v.B }],
    },
    {
      id: "maj", name: "Majority Vote", blurb: "Three inputs: out comes what most of them say", card: "maj",
      cols: 12, rows: 8,
      inputs: [{ n: "A", row: 6 }, { n: "B", row: 4 }, { n: "C", row: 1 }],
      cells: [
        { id: "c1", at: [4, 6], in: ["A", "B"] },
        { id: "c2", at: [4, 3], in: ["A", "B"] },
        { id: "c3", at: [7, 2], in: ["c2", "C"] },
        { id: "c4", at: [9, 4], in: ["c1", "c3"] },
      ],
      outputs: [{ n: "Y", row: 4, from: "c4", want: (v) => (v.A + v.B + v.C >= 2 ? 1 : 0) }],
    },
    {
      id: "mux", name: "The Multiplexer", blurb: "S chooses: S = 0 lets A through, S = 1 lets B through", card: "mux",
      cols: 12, rows: 8,
      inputs: [{ n: "A", row: 6 }, { n: "S", row: 4 }, { n: "B", row: 1 }],
      cells: [
        { id: "c1", at: [3, 4], in: ["S"] },
        { id: "c2", at: [6, 5], in: ["A", "c1"] },
        { id: "c3", at: [6, 2], in: ["S", "B"] },
        { id: "c4", at: [9, 4], in: ["c2", "c3"] },
      ],
      outputs: [{ n: "Y", row: 4, from: "c4", want: (v) => (v.S ? v.B : v.A) }],
    },
    {
      id: "latch", name: "Memory", blurb: "Two cells feeding each other remember a bit", card: "latch",
      cols: 11, rows: 7,
      inputs: [{ n: "R", row: 5 }, { n: "S", row: 1 }],
      cells: [
        { id: "c1", at: [6, 5], in: ["R", "c2"], detour: [null, 3.5] },
        { id: "c2", at: [6, 1], in: ["c1", "S"], detour: [2.5, null] },
      ],
      outputs: [{ n: "Q", row: 5, from: "c1" }],
      // set, hold, hold, reset, hold, hold, set, hold
      seq: [{ S: 1, R: 0 }, { S: 0, R: 0 }, { S: 0, R: 0 }, { S: 0, R: 1 }, { S: 0, R: 0 }, { S: 0, R: 0 }, { S: 1, R: 0 }, { S: 0, R: 0 }],
      wantSeq: { Q: [1, 1, 1, 0, 0, 0, 1, 1] },
    },
  ];

  // The level's cards: what the chip world has to do with it
  const CARDS = {
    inv: { title: "Inside a chip", lines: [
      "A chip is billions of transistors -- tiny switches etched into silicon -- wired by metal traces.",
      "Two of them make the simplest gate, the inverter: a 1 in gives a 0 out, a 0 gives a 1.",
      "Each cube is a chip: 0 NOT, 1 AND, 2 OR, 3 XOR, 4 NAND, 5 NOR. Set one in the empty cell.",
      "The logic analyzer up top shows the output (Y) against what it should be (WANT).",
      "A cube stacked on a cell inverts its output. Fewer transistors: more stars."] },
    and: { title: "AND", lines: [
      "AND gives a 1 only when both inputs are 1.",
      "In CMOS, the natural gate is NAND (4 transistors): an AND is a NAND plus an inverter, 6.",
      "Any of your chips can go in a cell -- the analyzer tells you which one does the job."] },
    xor: { title: "XOR: are they different?", lines: [
      "XOR gives a 1 when its inputs differ: a chip compares bits with it,",
      "and it's the heart of every adder. (With a cube on top: XNOR, are they the same?)"] },
    half: { title: "Adding in binary", lines: [
      "0 + 0 = 0, 0 + 1 = 1, 1 + 1 = 10: a SUM bit and a CARRY bit.",
      "That's a half adder: two cells side by side, one for each.",
      "Every processor adds with chains of circuits like this one."] },
    nand: { title: "Sold out: NAND is universal", lines: [
      "The AND and OR chips are sold out!",
      "But NAND is universal: every logic function can be built from NANDs alone.",
      "Make an AND out of what's left: the second cell has one input."] },
    maj: { title: "Majority vote", lines: [
      "Three inputs, and the output says what most of them say.",
      "It's also the CARRY of a full adder: A + B + C carries a 1 when two or more are 1.",
      "Four cells, and each chip only once -- a cube stacked on a cell turns it into its opposite."] },
    mux: { title: "The multiplexer", lines: [
      "A select line S chooses which input goes through: S = 0 passes A, S = 1 passes B.",
      "Chips steer data like this billions of times a second: buses, memories, processors."] },
    latch: { title: "Memory out of feedback", lines: [
      "Two cells feeding each other can hold a bit: S (set) makes Q 1, R (reset) makes it 0,",
      "and with both at 0 it remembers. The static RAM in a processor's cache works like this --",
      "six transistors a bit. Hint: a NOR latch, and one NOR can be an OR with a cube on top."] },
  };

  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const rgb = (c, a = 1) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${a})`;
  const VERIFY_S = 2.2; // a working circuit, unchanged this long: taped out

  // -- the logic: a level's circuit, its test vectors, its best -------------------------------------------------
  // the steps: each a {name: bit} of the inputs
  function vectors(L) {
    if (L.seq) return L.seq;
    const n = L.inputs.length;
    const out = [];
    for (let k = 0; k < 1 << n; k++) {
      const v = {};
      L.inputs.forEach((p, i) => (v[p.n] = (k >> (n - 1 - i)) & 1));
      out.push(v);
    }
    return out;
  }
  // the cells' outputs for inputs v, from the cells' last values (sequential:
  // the memory); asg: cell id -> {tag, inv} or null. Settles, or gives up
  // (an oscillation: unknown)
  function settle(L, asg, v, last) {
    const val = { ...v };
    L.cells.forEach((c) => (val[c.id] = last ? last[c.id] : null));
    for (let it = 0; it < 16; it++) {
      let changed = false;
      for (const c of L.cells) {
        const a = asg[c.id];
        let o = null;
        if (a) {
          const x = val[c.in[0]];
          const y = c.in.length > 1 ? val[c.in[1]] : x;
          o = gateOut(a.tag, x === undefined ? null : x, y === undefined ? null : y);
          if (o !== null && a.inv) o = 1 - o;
        }
        if (o !== val[c.id]) {
          val[c.id] = o;
          changed = true;
        }
      }
      if (!changed) return val;
    }
    L.cells.forEach((c) => (val[c.id] = null));
    return val;
  }
  // every step's values (the sequence from power-up: nothing known)
  function run(L, asg) {
    const steps = [];
    let last = null;
    for (const v of vectors(L)) {
      last = settle(L, asg, v, L.seq ? last : null);
      steps.push(last);
    }
    return steps;
  }
  const want = (L, o, k, v) => (L.seq ? L.wantSeq[o.n][k] : o.want(v));
  function works(L, asg) {
    const vs = vectors(L);
    const steps = run(L, asg);
    return steps.every((s, k) => L.outputs.every((o) => s[o.from] === want(L, o, k, vs[k])));
  }
  const transistors = (asg) => Object.values(asg).reduce((n, a) => n + (a ? GATES[a.tag].tr + (a.inv ? INV_TR : 0) : 0), 0);
  // The fewest transistors that work (each tag once; a stacked cube is one more cube of the six)
  function bestOf(L) {
    const allowed = L.allowed || [0, 1, 2, 3, 4, 5];
    let best = Infinity;
    const asg = {};
    const go = (k, used, cubes) => {
      if (cubes > 6) return;
      if (k === L.cells.length) {
        if (works(L, asg)) best = Math.min(best, transistors(asg));
        return;
      }
      for (const t of allowed) {
        if (used & (1 << t)) continue;
        for (const inv of [false, true]) {
          asg[L.cells[k].id] = { tag: t, inv };
          go(k + 1, used | (1 << t), cubes + 1 + (inv ? 1 : 0));
        }
      }
      delete asg[L.cells[k].id];
    };
    go(0, 0, 0);
    return best;
  }

  Lynx.games.chips = (ar, cfg, app) => {
    const T = clamp((+cfg.cellCm || 5) / 100, 0.035, 0.1); // m: a tile
    const STEP_S = clamp(+cfg.stepS || 1, 0.4, 3);
    const w = Lynx.world3d(ar, { textures: false });
    const layer = Lynx.cubeLayer(ar, app, {});
    const frameTags = new Set(Lynx.FRAME_CUBE_TAGS || []);
    const tr = Lynx.tr || ((t) => t);
    const sfx = (n) => Lynx.sfx.play(n);

    let state = "title"; // title | playing | won
    let stateTime = 0;
    let time = 0;
    let L = null;
    let levelIdx = 0;
    let vecs = [];
    let steps = []; // this circuit's values, per step
    let step = 0; // the test vector shown
    let stepT = 0;
    let asg = {}; // cell id -> {tag, inv, b (its cube), top (the stacked cube)} or null
    let spare = []; // cubes not in a cell: {b, why}
    let sig = "";
    let ok = false;
    let verifyT = 0;
    let card = null;
    let toast = null;
    let best = null; // this level's fewest transistors
    let result = null; // {tr, stars, score}
    let rankMsg = "";
    let topScore = null;
    let fakeBlocks = null; // (tests: pretend cubes)
    const bestCache = {};
    Lynx.bestScore("chips").then((b) => (topScore = b));
    const say = (text, color = "#c8f4ff", t = 2.4) => (toast = { text, color, t });

    // -- the board's frame: tile [col, row] (col left to right, row from the robot out) <-> local f, r ---------------
    const fOf = (row) => 0.03 + (row + 0.5) * T;
    const rOf = (col) => (col - (L.cols - 1) / 2) * T;
    const P = (x, y, h = 0.0006) => [fOf(y), rOf(x), h]; // a point in tile units -> local [f, r, h]
    const cellOf = (id) => L.cells.find((c) => c.id === id);
    const inPad = (n) => L.inputs.find((p) => p.n === n);
    // a cell's pins (tile units)
    const pinIn = (c, k) => (c.in.length === 1 ? [c.at[0] - 0.5, c.at[1]] : [c.at[0] - 0.5, c.at[1] + (k ? -0.22 : 0.22)]);
    const pinOut = (c) => [c.at[0] + 0.5, c.at[1]];
    const srcPin = (n) => (inPad(n) ? [0.45, inPad(n).row] : pinOut(cellOf(n)));
    // The wires: Manhattan, along metal 1 (across) and metal 2 (along), with a via at each turn
    let wires = []; // {from (a signal), pts: [[x, y]...]}
    // (a wire mustn't run under a cell other than its own two)
    const hitsH = (x0, x1, y, skip) => L.cells.some((c) => !skip.includes(c) && Math.abs(c.at[1] - y) < 0.56 && Math.min(x0, x1) < c.at[0] + 0.56 && Math.max(x0, x1) > c.at[0] - 0.56);
    const hitsV = (x, y0, y1, skip) => L.cells.some((c) => !skip.includes(c) && Math.abs(c.at[0] - x) < 0.56 && Math.min(y0, y1) < c.at[1] + 0.56 && Math.max(y0, y1) > c.at[1] - 0.56);
    function route() {
      wires = [];
      let k = 0;
      L.cells.forEach((c) => {
        c.in.forEach((src, i) => {
          const a = srcPin(src);
          const b = pinIn(c, i);
          const skip = [c, cellOf(src)];
          const det = c.detour && c.detour[i];
          let pts;
          if (det !== null && det !== undefined) {
            // back to the left: out, round along the detour row, in (each wire its own lanes)
            const xo = a[0] + 0.3 + 0.18 * (k % 3);
            const xi = b[0] - 0.35 - 0.15 * (k % 3);
            pts = [a, [xo, a[1]], [xo, det], [xi, det], [xi, b[1]], b];
          } else if (Math.abs(a[1] - b[1]) < 1e-6 && !hitsH(a[0], b[0], a[1], skip)) pts = [a, b];
          else {
            // turn late (near the cell), else early (near the source), where it runs clear
            const tries = [0, 1, 2].map((j) => b[0] - 0.3 - 0.16 * ((k + j) % 3)).concat([0, 1, 2].map((j) => a[0] + 0.3 + 0.16 * ((k + j) % 3)));
            let mx = tries.find((x) => x > a[0] + 0.05 && x < b[0] - 0.05 && !hitsH(a[0], x, a[1], skip) && !hitsV(x, a[1], b[1], skip) && !hitsH(x, b[0], b[1], skip));
            if (mx === undefined) mx = (a[0] + b[0]) / 2;
            pts = [a, [mx, a[1]], [mx, b[1]], b];
          }
          wires.push({ from: src, pts });
          k++;
        });
      });
      L.outputs.forEach((o) => {
        const a = pinOut(cellOf(o.from));
        const b = [L.cols - 1.45, o.row];
        const pts = Math.abs(a[1] - b[1]) < 1e-6 ? [a, b] : [a, [(a[0] + b[0]) / 2, a[1]], [(a[0] + b[0]) / 2, b[1]], b];
        wires.push({ from: o.from, pts });
      });
    }

    // -- flow -------------------------------------------------------------------------------------------------------
    function startLevel(n) {
      levelIdx = n;
      L = LEVELS[n];
      const th = ar.pose.theta;
      w.setAnchor({ x: ar.pose.x + Math.cos(th) * 0.17, y: ar.pose.y + Math.sin(th) * 0.17, th });
      vecs = vectors(L);
      if (bestCache[L.id] === undefined) bestCache[L.id] = bestOf(L);
      best = bestCache[L.id];
      route();
      asg = {};
      spare = [];
      sig = "";
      ok = false;
      verifyT = 0;
      step = 0;
      stepT = 0;
      result = null;
      rankMsg = "";
      card = { id: L.card, t: 0 };
      readCubes();
      state = "playing";
      stateTime = 0;
      sfx("go");
    }
    function tapeOut() {
      const n = transistors(asg);
      const stars = 1 + (n <= best + 4 ? 1 : 0) + (n <= best ? 1 : 0);
      const score = stars * 100 + Math.max(0, 40 - n) * 3 + 40 * levelIdx;
      result = { tr: n, stars, score };
      state = "won";
      stateTime = 0;
      sfx("levelup");
      try {
        const done = JSON.parse(localStorage.getItem("chipsDone") || "{}");
        done[L.id] = Math.max(done[L.id] || 0, stars);
        localStorage.setItem("chipsDone", JSON.stringify(done));
      } catch (e) {
        // (not remembered)
      }
      Lynx.submitScore("chips", score).then((rank) => {
        rankMsg = rank ? `#${rank} on the robot's scoreboard!` : "";
        if (rank === 1) topScore = score;
      });
      if (levelIdx + 1 < LEVELS.length) menu.select(levelIdx + 1);
    }
    const doneStars = () => {
      try {
        return JSON.parse(localStorage.getItem("chipsDone") || "{}");
      } catch (e) {
        return {};
      }
    };
    const menu = Lynx.levelMenu(ar, {
      key: "chips",
      levels: LEVELS.map((l) => {
        const s = doneStars()[l.id] || 0;
        return { name: `${tr(l.name)}${s ? "  " + "★".repeat(s) : ""}`, note: `${l.cells.length} ${l.cells.length === 1 ? "cell" : "cells"}`, blurb: tr(l.blurb) };
      }),
      active: () => state === "title",
      onStart: (i) => startLevel(i),
      color: "#8ff0ff",
    });

    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title") return startLevel(menu.sel);
      if (state === "won") {
        if (stateTime > 1.2) state = "title";
        return;
      }
      if (state !== "playing") return;
      card = card ? null : { id: L.card, t: 0.3 }; // (Fire: the level's card again -- the datasheet)
    });

    // -- the cubes: which chip in which cell --------------------------------------------------------------------------
    function readCubes() {
      const real = (fakeBlocks || layer.blocks() || []).filter((b) => !frameTags.has(b.tag) && !b.inferred && b.tag >= 0 && b.tag <= 5);
      const allowed = L.allowed || [0, 1, 2, 3, 4, 5];
      const next = {};
      spare = [];
      const at = (b) => {
        const l = w.toLocal(b.x, b.y);
        return L.cells.find((c) => Math.abs(l.f - fOf(c.at[1])) <= T * 0.62 && Math.abs(l.r - rOf(c.at[0])) <= T * 0.62);
      };
      const bottoms = real.filter((b) => !(b.level >= 1));
      const tops = real.filter((b) => b.level >= 1);
      bottoms.forEach((b) => {
        const c = at(b);
        if (!c) return spare.push({ b, why: "" });
        if (next[c.id]) return spare.push({ b, why: "" });
        if (!allowed.includes(b.tag)) {
          next[c.id] = null;
          return spare.push({ b, why: "sold out", cell: c });
        }
        next[c.id] = { tag: b.tag, inv: false, b, tops: [] };
      });
      tops.forEach((b) => {
        const c = at(b);
        const a = c && next[c.id];
        if (!a) return spare.push({ b, why: "" });
        a.tops.push(b);
        a.inv = a.tops.length % 2 === 1; // (two on top: inverted twice)
      });
      const s = L.cells.map((c) => (next[c.id] ? `${next[c.id].tag}${next[c.id].inv ? "i" : ""}` : "-")).join(",");
      asg = next;
      if (s !== sig) {
        // a chip set in (or taken out): what it is
        const before = sig.split(",");
        sig = s;
        verifyT = 0;
        L.cells.forEach((c, i) => {
          const a = next[c.id];
          const was = before[i];
          if (a && was !== `${a.tag}${a.inv ? "i" : ""}`) {
            const g = GATES[a.tag];
            say(`${a.inv ? "Inverted " : ""}${g.name} · ${g.part} · ${g.tr + (a.inv ? INV_TR : 0)} transistors`, rgb(g.color));
            sfx("click");
          }
        });
        steps = run(L, asg);
        ok = L.cells.every((c) => asg[c.id]) && works(L, asg);
      }
      if (spare.some((x) => x.why === "sold out") && !toast) say("That chip is sold out in this level", "#ff9a8a", 1.5);
    }

    // -- the loop ---------------------------------------------------------------------------------------------------
    function update(dt) {
      time += dt;
      stateTime += dt;
      if (toast && (toast.t -= dt) <= 0) toast = null;
      if (card) card.t += dt;
      if (state !== "playing" && state !== "won") return;
      if (state === "playing") readCubes();
      stepT += dt;
      const per = ok && state === "playing" ? Math.min(STEP_S, VERIFY_S / vecs.length) : STEP_S; // (verifying: through them all quickly)
      if (stepT >= per) {
        stepT = 0;
        step = (step + 1) % vecs.length;
      }
      if (state === "playing" && !card) {
        if (ok) {
          if (verifyT === 0) step = 0;
          verifyT += dt;
          if (verifyT >= VERIFY_S) tapeOut();
        } else verifyT = 0;
      }
    }

    // -- drawing ------------------------------------------------------------------------------------------------------
    const LOOK = {
      die: "rgba(30,44,52,0.9)",
      rowA: "rgba(60,90,100,0.35)",
      seal: "rgba(200,170,90,0.85)",
      pad: "rgba(220,180,80,0.95)",
      padEdge: "rgba(120,90,30,0.95)",
      bond: "rgba(240,205,110,0.95)",
      lead: "rgba(190,196,204,0.95)",
      m1: [150, 175, 195], // metal 1 (across): aluminium
      m2: [205, 130, 80], // metal 2 (along): copper
      one: [120, 250, 255],
      zero: [40, 70, 120],
      unknown: [255, 90, 90],
      vdd: "rgba(230,80,70,0.8)",
      gnd: "rgba(80,130,230,0.8)",
    };
    const val = (n) => {
      const s = steps[step];
      if (inPad(n)) return vecs[step][n];
      return s ? s[n] : null;
    };
    const valColor = (v, a = 1) => rgb(v === 1 ? LOOK.one : v === 0 ? LOOK.zero : LOOK.unknown, a);
    // pixels for a width in m at a local point
    const px = (f, r, m, min = 1) => {
      const p = w.project(f, r, 0);
      return p ? Math.max(min, m * p.ppm) : min;
    };
    // a deterministic scatter (the die's dummy metal fill)
    function seeded(seed) {
      let t = seed;
      return () => {
        t = (t + 0x6d2b79f5) | 0;
        let x = Math.imul(t ^ (t >>> 15), 1 | t);
        x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
        return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
      };
    }

    function drawDie() {
      const g = ar.ctx;
      const x0 = -0.5;
      const x1 = L.cols - 0.5;
      const y0 = -0.5;
      const y1 = L.rows - 0.5;
      const q = { f0: fOf(y0), f1: fOf(y1), r0: rOf(x0), r1: rOf(x1) };
      // the die and its standard-cell rows
      w.floor(q, 0.0002, LOOK.die, null); // (w.floor: at the scene's opacity)
      {
        for (let y = 0; y < L.rows; y++) {
          w.floor({ f0: fOf(y - 0.5) + T * 0.06, f1: fOf(y - 0.5) + T * 0.16, r0: q.r0 + T * 0.3, r1: q.r1 - T * 0.3 }, 0.0003, y % 2 ? LOOK.vdd.replace("0.8", "0.25") : LOOK.gnd.replace("0.8", "0.25"), null);
        }
        // dummy metal fill: little rectangles where nothing runs
        const rnd = seeded(7 + levelIdx);
        for (let k = 0; k < L.cols * L.rows * 0.7; k++) {
          const x = 1.2 + rnd() * (L.cols - 3.4);
          const y = rnd() * (L.rows - 1);
          if (L.cells.some((c) => Math.abs(c.at[0] - x) < 1.1 && Math.abs(c.at[1] - y) < 0.9)) continue;
          const lw = 0.08 + rnd() * 0.12;
          w.floor({ f0: fOf(y) - T * 0.04, f1: fOf(y) + T * 0.04, r0: rOf(x) - T * lw, r1: rOf(x) + T * lw }, 0.0004, "rgba(120,140,150,0.18)", null);
        }
      }
      // the seal ring, and the die's name etched in a corner
      const ring = (m) => [[fOf(y0) + m, rOf(x0) + m, 0.0005], [fOf(y1) - m, rOf(x0) + m, 0.0005], [fOf(y1) - m, rOf(x1) - m, 0.0005], [fOf(y0) + m, rOf(x1) - m, 0.0005], [fOf(y0) + m, rOf(x0) + m, 0.0005]];
      w.line3(ring(T * 0.08), LOOK.seal, 2, T);
      w.line3(ring(T * 0.16), "rgba(200,170,90,0.4)", 1, T);
      const tag = w.project(fOf(y1 - 0.3), rOf(x1 - 1.6), 0.001);
      if (tag) ar.text(`LYNX-${levelIdx + 1} · ${L.id.toUpperCase()}`, tag.x, tag.y, { size: Math.max(8, Math.min(14, 0.012 * tag.ppm)), align: "center", color: "rgba(200,220,230,0.55)", outline: false });
      // the package's leads beyond the die, bond wires up to the pads
      const lead = (row, side) => {
        const xr = side < 0 ? x0 - 0.9 : x1 + 0.9;
        w.floor({ f0: fOf(row) - T * 0.18, f1: fOf(row) + T * 0.18, r0: rOf(xr) - T * 0.45, r1: rOf(xr) + T * 0.45 }, 0.0004, LOOK.lead, "rgba(80,80,90,0.9)", { object: true });
        const xp = side < 0 ? 0 : L.cols - 1;
        const pts = [];
        for (let k = 0; k <= 10; k++) {
          const u = k / 10;
          pts.push([fOf(row), rOf(xr + (xp - xr) * u), 0.0006 + Math.sin(u * Math.PI) * T * 0.35]);
        }
        w.line3(pts, LOOK.bond, Math.max(1.2, px(fOf(row), rOf(xp), 0.0012)), 0.01);
      };
      L.inputs.forEach((p) => lead(p.row, -1));
      L.outputs.forEach((o) => lead(o.row, 1));
      // the power rails: VDD along the far edge, GND along the near one
      w.line3([[fOf(y1 - 0.15), rOf(x0 + 0.3), 0.0005], [fOf(y1 - 0.15), rOf(x1 - 0.3), 0.0005]], LOOK.vdd, Math.max(2, px(fOf(y1), 0, 0.004)), T);
      w.line3([[fOf(y0 + 0.15), rOf(x0 + 0.3), 0.0005], [fOf(y0 + 0.15), rOf(x1 - 0.3), 0.0005]], LOOK.gnd, Math.max(2, px(fOf(y0), 0, 0.004)), T);
      const vl = w.project(fOf(y1 - 0.15), rOf(x0 + 0.6), 0.001);
      if (vl) ar.text("VDD", vl.x, vl.y - 3, { size: 10, color: "#ff9c90" });
      const gl = w.project(fOf(y0 + 0.15), rOf(x0 + 0.6), 0.001);
      if (gl) ar.text("GND", gl.x, gl.y - 3, { size: 10, color: "#9cbcff" });
    }

    function drawWires() {
      const g = ar.ctx;
      wires.forEach((wr) => {
        const v = val(wr.from);
        // the metal: across on metal 1, along on metal 2
        for (let k = 0; k + 1 < wr.pts.length; k++) {
          const a = wr.pts[k];
          const b = wr.pts[k + 1];
          const across = Math.abs(a[1] - b[1]) < 1e-6;
          const mid = P((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
          const wd = px(mid[0], mid[1], 0.0032, 1.5);
          w.line3([P(...a), P(...b)], rgb(across ? LOOK.m1 : LOOK.m2, 0.9), wd, 0.02);
          w.line3([P(...a, 0.0008), P(...b, 0.0008)], valColor(v, v === 1 ? 0.85 : 0.6), Math.max(1, wd * 0.45), 0.02);
        }
        // the vias, where it turns
        for (let k = 1; k + 1 < wr.pts.length; k++) {
          const [x, y] = wr.pts[k];
          w.floor({ f0: fOf(y) - T * 0.07, f1: fOf(y) + T * 0.07, r0: rOf(x) - T * 0.07, r1: rOf(x) + T * 0.07 }, 0.001, "rgba(30,30,34,0.9)", "rgba(220,220,230,0.8)", { object: true });
        }
        // electrons, running along (a 1: bright and quick; an unknown: none)
        if (v === null) return;
        let len = 0;
        const segs = [];
        for (let k = 0; k + 1 < wr.pts.length; k++) {
          const a = wr.pts[k];
          const b = wr.pts[k + 1];
          const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
          segs.push({ a, b, l, at: len });
          len += l;
        }
        const gap = 0.45;
        const off = (time * (v === 1 ? 1.6 : 0.35)) % gap;
        for (let s = off; s < len; s += gap) {
          const sg = segs.find((q) => s >= q.at && s <= q.at + q.l + 1e-9) || segs[segs.length - 1];
          const u = sg.l ? (s - sg.at) / sg.l : 0;
          const x = sg.a[0] + (sg.b[0] - sg.a[0]) * u;
          const y = sg.a[1] + (sg.b[1] - sg.a[1]) * u;
          const p = w.project(fOf(y), rOf(x), 0.0012);
          if (!p) continue;
          const r = Math.max(1.5, 0.0026 * p.ppm);
          if (v === 1) ar.glow(p.x, p.y, r * 2.4, [[0, "rgba(255,255,255,0.95)"], [0.35, rgb(LOOK.one, 0.8)], [1, rgb(LOOK.one, 0)]]);
          else {
            g.fillStyle = rgb([90, 130, 200], 0.7);
            g.beginPath();
            g.arc(p.x, p.y, r * 0.6, 0, 2 * Math.PI);
            g.fill();
          }
        }
      });
    }

    function drawPads() {
      const pad = (x, row, name, v, wantV) => {
        const q = { f0: fOf(row) - T * 0.32, f1: fOf(row) + T * 0.32, r0: rOf(x) - T * 0.32, r1: rOf(x) + T * 0.32 };
        w.floor(q, 0.0009, LOOK.pad, LOOK.padEdge, { width: 2, object: true });
        const p = w.project(fOf(row), rOf(x), 0.002);
        if (!p) return;
        ar.queue(p.depth, () => {
          const r = Math.max(5, 0.009 * p.ppm);
          ar.glow(p.x, p.y - r * 2.2, r * 1.6, [[0, v === 1 ? "rgba(255,255,255,0.95)" : "rgba(60,80,110,0.9)"], [0.5, valColor(v, 0.8)], [1, valColor(v, 0)]]);
          ar.text(`${name} ${v === null ? "?" : v}`, p.x, p.y - r * 3.6, { size: Math.max(11, Math.min(18, r * 1.4)), align: "center", color: v === 1 ? "#c8fbff" : "#9fb4d0" });
          if (wantV !== undefined) ar.text(`want ${wantV}`, p.x, p.y + r * 2.2, { size: Math.max(9, Math.min(13, r)), align: "center", color: wantV === v ? "#a8ffb0" : "#ffd27a" });
        });
      };
      L.inputs.forEach((p) => pad(0, p.row, p.n, vecs[step][p.n]));
      L.outputs.forEach((o, i) => pad(L.cols - 1, o.row, o.n, val(o.from), want(L, o, step, vecs[step])));
    }

    // an empty cell: its outline, its pins, a "?"
    function drawCells() {
      L.cells.forEach((c) => {
        const [x, y] = c.at;
        const a = asg[c.id];
        const q = { f0: fOf(y) - T * 0.46, f1: fOf(y) + T * 0.46, r0: rOf(x) - T * 0.46, r1: rOf(x) + T * 0.46 };
        w.floor(q, 0.0009, a ? "rgba(20,24,28,0.6)" : "rgba(90,200,230,0.08)", null, { object: true });
        // dashed outline while empty
        const corners = [[q.f0, q.r0], [q.f1, q.r0], [q.f1, q.r1], [q.f0, q.r1]];
        for (let k = 0; k < 4; k++) {
          const s = corners[k];
          const e = corners[(k + 1) % 4];
          const n = 6;
          for (let d = 0; d < n; d += 2) {
            const u0 = d / n;
            const u1 = (d + 1) / n;
            w.line3([[s[0] + (e[0] - s[0]) * u0, s[1] + (e[1] - s[1]) * u0, 0.001], [s[0] + (e[0] - s[0]) * u1, s[1] + (e[1] - s[1]) * u1, 0.001]], a ? "rgba(140,220,255,0.35)" : "rgba(140,230,255,0.9)", 1.5, 0.02);
          }
        }
        if (!a) {
          const p = w.project(fOf(y), rOf(x), 0.002);
          if (p) {
            const pulse = 0.6 + 0.4 * Math.sin(time * 4 + x);
            ar.queue(p.depth, () => ar.text("?", p.x, p.y + 6, { size: Math.max(12, Math.min(30, 0.02 * p.ppm)), align: "center", color: `rgba(150,235,255,${pulse.toFixed(2)})` }));
          }
        }
      });
    }

    // A cube drawn as a chip: a black DIP package where the cube stands
    // (turned with it), silver legs down both sides, its part number and
    // gate on top -- and a light over it for its output.
    function queueChip(b, opts) {
      const l = w.toLocal(b.x, b.y);
      const yawL = w.anchor().th - (b.yaw || 0); // (the cube's turn in the board's frame)
      const hw = (b.half || 0.02) * 1.06;
      const h0 = b.h0 || 0;
      const h1 = (b.h1 || h0 + 2 * hw) + 0.001;
      const c = Math.cos(yawL);
      const s = Math.sin(yawL);
      const at = (u, v, h) => [l.f + u * c - v * s, l.r + u * s + v * c, h];
      const corners = [[-hw, -hw], [hw, -hw], [hw, hw], [-hw, hw]];
      const mid = w.project(l.f, l.r, (h0 + h1) / 2);
      if (!mid) return;
      ar.queue(mid.depth, () => {
        const g = ar.ctx;
        const cam = w.camLocal();
        const proj = (pts) => {
          const out = [];
          for (const p of pts) {
            const q = w.project(...p);
            if (!q) return null;
            out.push(q);
          }
          return out;
        };
        const fill = (pts, col, line) => {
          const s2 = proj(pts);
          if (!s2) return null;
          g.beginPath();
          s2.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
          g.closePath();
          g.fillStyle = col;
          g.fill();
          if (line) {
            g.strokeStyle = line;
            g.lineWidth = 1;
            g.stroke();
          }
          return s2;
        };
        // the sides that face the camera, with legs on two of them
        for (let k = 0; k < 4; k++) {
          const [u0, v0] = corners[k];
          const [u1, v1] = corners[(k + 1) % 4];
          const mf = at((u0 + u1) / 2, (v0 + v1) / 2, 0);
          const [cf, cr] = [l.f, l.r];
          if ((cam.f - mf[0]) * (mf[0] - cf) + (cam.r - mf[1]) * (mf[1] - cr) <= 0) continue;
          fill([at(u0, v0, h0), at(u1, v1, h0), at(u1, v1, h1), at(u0, v0, h1)], k % 2 ? "rgba(26,26,30,0.98)" : "rgba(40,40,46,0.98)", "rgba(0,0,0,0.9)");
          if (k % 2 === 0) {
            // the legs: four bent silver pins
            for (let n = 0; n < 4; n++) {
              const t = (n + 0.5) / 4;
              const u = u0 + (u1 - u0) * t;
              const v = v0 + (v1 - v0) * t;
              const out = 1.25;
              const pts = proj([at(u, v, h0 + (h1 - h0) * 0.35), at(u * (Math.abs(u) > Math.abs(v) ? out : 1), v * (Math.abs(v) >= Math.abs(u) ? out : 1), h0 + (h1 - h0) * 0.3), at(u * (Math.abs(u) > Math.abs(v) ? out : 1), v * (Math.abs(v) >= Math.abs(u) ? out : 1), h0)]);
              if (!pts) continue;
              g.strokeStyle = "rgba(205,210,220,0.95)";
              g.lineWidth = Math.max(1.2, 0.0016 * mid.ppm);
              g.beginPath();
              pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
              g.stroke();
            }
          }
        }
        // the top: the part number, the gate's name, the pin-1 dot
        if (cam.h > h1) {
          const top = fill(corners.map(([u, v]) => at(u, v, h1)), "rgba(34,34,40,0.98)", rgb(opts.color, 0.7));
          if (!top) return;
          const cx = top.reduce((a, p) => a + p.x, 0) / 4;
          const cy = top.reduce((a, p) => a + p.y, 0) / 4;
          const span = Math.max(...top.map((p) => p.x)) - Math.min(...top.map((p) => p.x));
          const dot = proj([at(-hw * 0.65, -hw * 0.65, h1)]);
          if (dot) {
            g.fillStyle = "rgba(200,200,210,0.7)";
            g.beginPath();
            g.arc(dot[0].x, dot[0].y, Math.max(1.5, span * 0.04), 0, 2 * Math.PI);
            g.fill();
          }
          const big = clamp(span * 0.26, 9, 30);
          ar.text(opts.label, cx, cy + big * 0.25, { size: big, align: "center", color: rgb(opts.color), outline: "rgba(0,0,0,0.9)" });
          if (opts.part) ar.text(opts.part, cx, cy + big * 0.25 + big * 0.75, { size: Math.max(7, big * 0.45), align: "center", color: "rgba(210,215,225,0.85)", outline: false });
        }
        // the output light over it
        if (opts.out !== undefined) {
          const p = w.project(l.f, l.r, h1 + 0.012);
          if (p) {
            const r = Math.max(3, 0.005 * p.ppm);
            ar.glow(p.x, p.y, r * 2.2, [[0, opts.out === 1 ? "rgba(255,255,255,0.95)" : "rgba(80,90,110,0.9)"], [0.4, valColor(opts.out, 0.85)], [1, valColor(opts.out, 0)]]);
          }
        }
      }, w.extent(l.f - hw, l.f + hw, l.r - hw, l.r + hw, h0, h1));
    }
    function drawChips() {
      L.cells.forEach((c) => {
        const a = asg[c.id];
        if (!a) return;
        const gt = GATES[a.tag];
        queueChip(a.b, { label: gt.name, part: gt.part, color: gt.color, out: a.tops.length ? undefined : val(c.id) });
        a.tops.forEach((b, i) => queueChip(b, { label: i % 2 ? "INV·INV" : "INV", part: "74HC04", color: [230, 230, 240], out: i === a.tops.length - 1 ? val(c.id) : undefined }));
      });
      spare.forEach((x) => {
        const gt = GATES[x.b.tag];
        queueChip(x.b, { label: gt.name, part: x.why === "sold out" ? "SOLD OUT" : gt.part, color: x.why === "sold out" ? [255, 110, 100] : gt.color.map((v) => v * 0.7) });
      });
    }

    // The logic analyzer: every signal over the test vectors, the outputs against WANT
    let scopeBottom = 0;
    function drawScope(v) {
      const g = ar.ctx;
      const small = Lynx.smallScreen();
      const names = L.inputs.map((p) => p.n);
      const rowsN = names.length + L.outputs.length;
      const lh = small ? 15 : 19;
      const wd = Math.min(small ? 420 : 560, v.w - 30);
      const hg = 26 + rowsN * lh + 8;
      const x0 = v.cx - wd / 2;
      const y0 = v.y + (small ? 58 : 64); // (up top: the die is down where the camera looks)
      scopeBottom = y0 + hg;
      const lab = small ? 46 : 64;
      const sw = (wd - lab - 12) / vecs.length;
      g.save();
      g.fillStyle = "rgba(4,10,16,0.82)";
      g.strokeStyle = "rgba(120,220,255,0.6)";
      g.lineWidth = 1.5;
      g.beginPath();
      if (g.roundRect) g.roundRect(x0, y0, wd, hg, 8);
      else g.rect(x0, y0, wd, hg);
      g.fill();
      g.stroke();
      ar.text("LOGIC ANALYZER", x0 + 10, y0 + 16, { size: 11, color: "#8ff0ff", outline: false });
      const verdict = ok ? "✔ every step matches" : L.cells.some((c) => !asg[c.id]) ? "cells empty" : "✘ not yet";
      ar.text(verdict, x0 + wd - 10, y0 + 16, { size: 11, align: "right", color: ok ? "#9cffb0" : "#ffb08a", outline: false });
      const sx = (k) => x0 + lab + k * sw;
      // the cursor: this step
      g.fillStyle = "rgba(140,230,255,0.13)";
      g.fillRect(sx(step), y0 + 22, sw, rowsN * lh + 2);
      const wave = (bits, y, col, dash) => {
        g.strokeStyle = col;
        g.lineWidth = 2;
        g.setLineDash(dash ? [4, 3] : []);
        g.beginPath();
        let prev = null;
        bits.forEach((b, k) => {
          const yy = b === 1 ? y - lh * 0.62 : y - lh * 0.12;
          if (b === null) {
            prev = null;
            return;
          }
          if (prev === null) g.moveTo(sx(k), yy);
          else g.lineTo(sx(k), yy);
          g.lineTo(sx(k + 1), yy);
          prev = b;
        });
        g.stroke();
        g.setLineDash([]);
      };
      let y = y0 + 22 + lh;
      names.forEach((n) => {
        ar.text(n, x0 + 10, y - 4, { size: 12, color: "#c8dcff", outline: false });
        wave(vecs.map((vv) => vv[n]), y, "rgba(170,200,255,0.9)", false);
        y += lh;
      });
      L.outputs.forEach((o) => {
        const got = steps.map((s) => (s ? s[o.from] : null));
        const wnt = vecs.map((vv, k) => want(L, o, k, vv));
        got.forEach((b, k) => {
          if (b !== wnt[k]) {
            g.fillStyle = "rgba(255,80,60,0.22)";
            g.fillRect(sx(k), y - lh + 2, sw, lh - 2);
          }
          if (b === null) ar.text("?", sx(k) + sw / 2, y - 4, { size: 11, align: "center", color: "#ff8a8a", outline: false });
        });
        ar.text(o.n, x0 + 10, y - 4, { size: 12, color: "#8ff0ff", outline: false });
        wave(wnt, y, "rgba(255,210,110,0.85)", true);
        wave(got, y, "rgba(120,250,255,0.95)", false);
        y += lh;
      });
      if (!small) ar.text("solid: the output · dashed: WANT", x0 + wd - 10, y0 + hg - 4, { size: 10, align: "right", color: "#7d93a8", outline: false });
      // verifying: a bar filling up
      if (ok && state === "playing" && !card) {
        const u = clamp(verifyT / VERIFY_S, 0, 1);
        g.fillStyle = "rgba(120,255,160,0.85)";
        g.fillRect(x0, y0 + hg + 2, wd * u, 4);
        ar.text("Verifying the test vectors...", v.cx, y0 + hg + 22, { size: 13, align: "center", color: "#a8ffc0" });
      }
      g.restore();
    }

    function drawCard(v) {
      const g = ar.ctx;
      const C = CARDS[card.id];
      const small = Lynx.smallScreen();
      const wdt = Math.min(720, v.w - 30);
      const size = small ? 11 : 14;
      const lines = C.lines.map((t) => tr(t));
      const hgt = 62 + lines.length * (size + 8) + 34;
      const x0 = v.cx - wdt / 2;
      const y0 = Math.max(v.y + 40, scopeBottom + 12); // (under the logic analyzer)
      g.save();
      g.globalAlpha = Math.min(1, card.t * 4);
      g.fillStyle = "rgba(6,14,22,0.92)";
      g.strokeStyle = "rgba(120,230,255,0.9)";
      g.lineWidth = 2;
      g.beginPath();
      if (g.roundRect) g.roundRect(x0, y0, wdt, hgt, 10);
      else g.rect(x0, y0, wdt, hgt);
      g.fill();
      g.stroke();
      ar.text(tr(C.title), v.cx, y0 + 34, { size: small ? 17 : 22, align: "center", color: "#8ff0ff" });
      lines.forEach((t, i) => ar.text(t, v.cx, y0 + 64 + i * (size + 8), { size, align: "center" }));
      ar.text("FIRE / click: to the die (FIRE again: this card)", v.cx, y0 + hgt - 14, { size: 12, align: "center", color: "#ffe9a8" });
      g.restore();
    }

    function draw() {
      const v = ar.view;
      if (state === "playing" || state === "won") {
        w.beginFrame();
        drawDie();
        drawWires();
        drawCells();
        drawPads();
        drawChips();
      }
      ar.flush();
      if (state === "title") {
        const small = Lynx.smallScreen();
        ar.flash("#02070c", 0.7);
        ar.text("CHIP FOUNDRY", v.cx, v.y + (small ? 40 : 62), { size: small ? 28 : 44, align: "center", color: "#8ff0ff", font: "Impact, 'Arial Black', sans-serif", weight: "normal" });
        if (!small) ar.text("Logic on a silicon die: your cubes are the chips -- 0 NOT, 1 AND, 2 OR, 3 XOR, 4 NAND, 5 NOR", v.cx, v.y + 90, { size: 13, align: "center" });
        ar.text("The die is laid out on the floor right in front of the robot · a cube stacked on a cell inverts it", v.cx, v.y + (small ? 60 : 110), { size: small ? 11 : 13, align: "center" });
        menu.draw(v.y + (small ? 76 : 128), v.y + v.h - 90);
        if (topScore !== null) ar.text(`Best on this robot: ${topScore}`, v.cx, v.y + v.h - 36, { size: 14, align: "center", color: "#8ff0ff" });
        return;
      }
      // the HUD
      const small = Lynx.smallScreen();
      const filled = L.cells.filter((c) => asg[c.id]).length;
      ar.text(`${tr(L.name)}`, v.x + 14, v.y + 26, { size: 17, color: "#8ff0ff" });
      ar.text(`Cells ${filled}/${L.cells.length} · ${transistors(asg)} transistors (best ${best})`, v.x + 14, v.y + 48, { size: 14, color: "#d8e8f0" });
      if (!small && v.w >= 1000) {
        const allowed = L.allowed || [0, 1, 2, 3, 4, 5];
        GATES.forEach((gt, i) => {
          const out = !allowed.includes(gt.tag);
          ar.text(`${gt.tag} ${gt.name} · ${gt.tr}T${out ? " · sold out" : ""}`, v.x + v.w - 14, v.y + 24 + i * 17, { size: 13, align: "right", color: out ? "rgba(255,120,110,0.8)" : rgb(gt.color) });
        });
        ar.text("on top: inverts (+2T)", v.x + v.w - 14, v.y + 24 + 6 * 17, { size: 12, align: "right", color: "#c8c8d8" });
      }
      drawScope(v);
      if (toast && !card) ar.text(toast.text, v.cx, scopeBottom + 50, { size: 18, align: "center", color: toast.color, alpha: clamp(toast.t * 2, 0, 1) });
      if (layer.drawStatus) layer.drawStatus();
      if (card && state === "playing") drawCard(v);
      if (state === "won") {
        ar.flash("#02070c", 0.45);
        ar.banner("TAPED OUT!", `${tr(L.name)} · ${"★".repeat(result.stars)}${"☆".repeat(3 - result.stars)} · ${result.tr} transistors · score ${result.score}`, { color: "#8ff0ff" });
        const why = result.stars === 3 ? "As small as this chip can be" : `The fewest that work: ${best} transistors`;
        ar.text(why, v.cx, v.cy + v.h * 0.12, { size: 14, align: "center" });
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.17, { size: 15, align: "center", color: "#8ff0ff" });
        if (stateTime > 1.2) ar.text("Press FIRE for the level menu", v.cx, v.cy + v.h * 0.22, { size: 14, align: "center" });
      }
    }

    ar.onFrame((now, dt) => {
      update(Math.min(dt, 0.1));
      draw();
    });
    return {
      actionLabel: "📄 Datasheet",
      snapshot: () => ({
        state, level: L && L.id, step, ok, verify: +verifyT.toFixed(2), best,
        cells: L ? L.cells.map((c) => (asg[c.id] ? `${c.id}:${GATES[asg[c.id].tag].name}${asg[c.id].inv ? "+inv" : ""}` : `${c.id}:-`)) : [],
        transistors: transistors(asg), result, spare: spare.length,
      }),
      debug: {
        LEVELS, GATES, bestOf, works, run, startLevel: (n) => startLevel(n), closeCard: () => (card = null),
        // pretend cubes: [{tag, cell: "c1", on: 0 (stacked: 1, 2)}] or [{tag, col, row}] (null: the real ones)
        setCubes(list) {
          fakeBlocks = list
            ? list.map((c, n) => {
                const cell = c.cell ? cellOf(c.cell) : null;
                const [x, y] = cell ? cell.at : [c.col, c.row];
                const p = w.toWorld(fOf(y), rOf(x));
                const lv = c.on || 0;
                return { id: `fake${n}`, tag: c.tag, x: p.x, y: p.y, yaw: w.anchor().th + (c.yaw || 0), level: lv, h0: lv * 0.04, h1: lv * 0.04 + 0.04, half: 0.02, inferred: false, n: 9 };
              })
            : null;
        },
      },
    };
  };
})(window.Lynx);
