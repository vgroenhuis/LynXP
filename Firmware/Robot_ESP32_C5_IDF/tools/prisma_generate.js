// Searches random Prisma layouts for hard ones: builds candidates from a
// set of pieces, solves each with the game's own rules, and prints the ones
// with the longest shortest-solutions (JSON, ready to paste into
// prisma_levels.js after a look-over).
//
// usage: node tools/prisma_generate.js <preset> [tries] [seed]
//   presets: mirrors, gate, rotator, colors, all
const path = require("path");
const core = require(path.join(__dirname, "../main/littlefs_image/prisma_core.js"));

const preset = process.argv[2] || "mirrors";
const tries = Number(process.argv[3] || 3000);
let seed = Number(process.argv[4] || 1);
const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const pick = (a) => a[Math.floor(rnd() * a.length)];

const PRESETS = {
  mirrors: { W: 7, H: 7, mirrors: [3, 4], crates: [0, 1], walls: [2, 5], emitters: 1, receivers: 1, colors: ["r"], extras: [] },
  split: { W: 7, H: 7, mirrors: [2, 3], crates: [0, 1], walls: [1, 3], emitters: 1, receivers: 2, colors: ["c"], extras: ["splitter"] },
  gate: { W: 7, H: 7, mirrors: [2, 3], crates: [1, 2], walls: [2, 4], emitters: 1, receivers: 1, colors: ["b"], extras: ["gate"] },
  rotator: { W: 7, H: 7, mirrors: [2, 3], crates: [0, 1], walls: [2, 4], emitters: 1, receivers: 1, colors: ["g"], extras: ["rotator"] },
  colors: { W: 7, H: 7, mirrors: [3, 4], crates: [0, 1], walls: [1, 3], emitters: 2, receivers: 1, colors: ["r", "b"], mix: true, extras: [] },
  all: { W: 8, H: 7, mirrors: [3, 4], crates: [1, 1], walls: [2, 4], emitters: 2, receivers: 2, colors: ["r", "b"], extras: ["gate", "rotator"] },
};
const P = PRESETS[preset];
const irand = ([a, b]) => a + Math.floor(rnd() * (b - a + 1));

function candidate() {
  const { W, H } = P;
  const g = Array.from({ length: H }, (_, y) => Array.from({ length: W }, (_, x) => (x === 0 || y === 0 || x === W - 1 || y === H - 1 ? "#" : ".")));
  const free = () => {
    for (let k = 0; k < 200; k++) {
      const x = 1 + Math.floor(rnd() * (W - 2));
      const y = 1 + Math.floor(rnd() * (H - 2));
      if (g[y][x] === ".") return [x, y];
    }
    return null;
  };
  const border = () => {
    // a wall cell on the border (not a corner), and the inward direction
    for (let k = 0; k < 100; k++) {
      const side = pick(["N", "S", "W", "E"]);
      let x, y, dir;
      if (side === "N") [x, y, dir] = [1 + Math.floor(rnd() * (W - 2)), 0, "S"];
      if (side === "S") [x, y, dir] = [1 + Math.floor(rnd() * (W - 2)), H - 1, "N"];
      if (side === "W") [x, y, dir] = [0, 1 + Math.floor(rnd() * (H - 2)), "E"];
      if (side === "E") [x, y, dir] = [W - 1, 1 + Math.floor(rnd() * (H - 2)), "W"];
      if (g[y][x] === "#") return [x, y, dir];
    }
    return null;
  };
  const level = { name: "", map: null, emitters: [], receivers: [] };
  // start at the bottom middle, facing up
  const sx = Math.floor(W / 2);
  const sy = H - 2;
  g[sy][sx] = "S";
  for (let i = 0; i < irand(P.walls); i++) {
    const c = free();
    if (c) g[c[1]][c[0]] = "#";
  }
  for (let i = 0; i < P.emitters; i++) {
    const b = border();
    if (!b) return null;
    g[b[1]][b[0]] = "L";
    level.emitters.push({ at: [b[0], b[1]], dir: b[2], color: P.colors[i % P.colors.length] });
  }
  for (let i = 0; i < P.receivers; i++) {
    const b = border();
    if (!b) return null;
    g[b[1]][b[0]] = "R";
    // one receiver per emitter, in its colour (a splitter feeds several)
    const color = P.mix ? "m" : P.colors[Math.min(i, P.colors.length - 1)];
    level.receivers.push({ at: [b[0], b[1]], color });
  }
  if (P.extras.includes("gate")) {
    const p = free();
    const d = free();
    if (!p || !d) return null;
    g[p[1]][p[0]] = "_";
    g[d[1]][d[0]] = "D";
  }
  if (P.extras.includes("splitter")) {
    const z = free();
    if (!z) return null;
    g[z[1]][z[0]] = pick(["z", "Z"]);
  }
  if (P.extras.includes("rotator")) {
    const o = free();
    if (!o) return null;
    g[o[1]][o[0]] = "o";
  }
  for (let i = 0; i < irand(P.mirrors); i++) {
    const c = free();
    if (c) g[c[1]][c[0]] = pick(["/", "\\"]);
  }
  for (let i = 0; i < irand(P.crates); i++) {
    const c = free();
    if (c) g[c[1]][c[0]] = "k";
  }
  const x = free();
  if (!x) return null;
  g[x[1]][x[0]] = "X";
  level.map = g.map((r) => r.join(""));
  return level;
}

const found = [];
for (let t = 0; t < tries; t++) {
  const lv = candidate();
  if (!lv) continue;
  const gd = core.parse(lv);
  if (core.trace(gd, gd.initial).lit) continue; // already solved at the start
  const r = core.solve(lv, 150000);
  if (!r.moves) continue;
  let s = gd.initial;
  let pushes = 0;
  for (const [dx, dy] of r.moves) {
    const n = core.move(gd, s, dx, dy);
    if (JSON.stringify(n.blocks) !== JSON.stringify(s.blocks)) pushes++;
    s = n;
  }
  // every block that exists should matter a bit: require several pushes
  found.push({ lv, moves: r.moves.length, pushes, states: r.explored, score: r.moves.length + 4 * pushes });
}
found.sort((a, b) => b.score - a.score);
const seenMaps = new Set();
found.filter((f) => !seenMaps.has(f.lv.map.join("")) && seenMaps.add(f.lv.map.join(""))).slice(0, 4).forEach((f) => {
  console.log(`// ${preset}: ${f.moves} moves, ${f.pushes} pushes, ${f.states} states`);
  console.log(JSON.stringify(f.lv));
});
