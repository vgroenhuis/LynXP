// Checks every Prisma level: solvable? shortest solution? Uses the game's own
// rules (main/littlefs_image/prisma_core.js).
//
// usage: node tools/prisma_solve.js [levelNumber]
const path = require("path");
const core = require(path.join(__dirname, "../main/littlefs_image/prisma_core.js"));
global.window = globalThis;
require(path.join(__dirname, "../main/littlefs_image/prisma_levels.js"));
const levels = globalThis.Lynx.prismaLevels;

const only = process.argv[2] ? Number(process.argv[2]) : null;
const arrows = { "0,-1": "U", "1,0": "R", "0,1": "D", "-1,0": "L" };
let ok = true;
levels.forEach((lv, i) => {
  if (only && i + 1 !== only) return;
  const t0 = Date.now();
  const r = core.solve(lv);
  const ms = Date.now() - t0;
  if (!r.moves) {
    ok = false;
    console.log(`${String(i + 1).padStart(2)} ${lv.name.padEnd(22)} UNSOLVABLE${r.gaveUp ? " (gave up)" : ""}  states ${r.explored}`);
    return;
  }
  // pushes = moves that moved a block
  const g = core.parse(lv);
  let s = g.initial;
  let pushes = 0;
  for (const [dx, dy] of r.moves) {
    const n = core.move(g, s, dx, dy);
    if (JSON.stringify(n.blocks) !== JSON.stringify(s.blocks)) pushes++;
    s = n;
  }
  const flag = lv.par !== undefined && lv.par !== r.moves.length ? `  (par in file: ${lv.par}!)` : "";
  console.log(`${String(i + 1).padStart(2)} ${lv.name.padEnd(22)} ${String(r.moves.length).padStart(3)} moves, ${String(pushes).padStart(2)} pushes, ${String(r.explored).padStart(8)} states, ${ms} ms${flag}`);
  if (only) console.log("   " + r.moves.map(([dx, dy]) => arrows[`${dx},${dy}`]).join(""));
});
process.exit(ok ? 0 : 1);
