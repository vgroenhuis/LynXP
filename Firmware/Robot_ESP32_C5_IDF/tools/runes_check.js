// Rune Stones level checker (game_runes.js): for every level, can it be won
// with all its stones -- and with each one left out (it shouldn't: no stone
// may stand in for another)? Usage:
//   node tools/runes_check.js [game_runes.js] [level id]
// Env: ONE=1 one placement, never moved (a level that needs a stone moved on
// should fail it); ISL island radius in cells (2.0; 2.5 for a margin);
// JM extra jump reach in cells (0.08; 0.35 for a margin); MAXS stones in use
// at once (2, the Key on top).
// Model (cells of 5 cm): stones placed anywhere and moved freely while the
// explorer stands on ground that stays ground; walking 4-ways (up one 4 cm
// step, down any); running jumps over gaps up to her reach (6.6 cm on the
// flat, more when dropping); hazards, unlit bridges and gaps not stood on.
// It errs toward finding a way. (The River's ship isn't modelled.)
const fs = require("fs");
const src = fs.readFileSync(process.argv[2] || require("path").join(__dirname, "../main/littlefs_image/game_runes.js"), "utf8");
const a = src.indexOf("const LEVELS = [");
const b = src.indexOf("\n  ];\n", a);
const LEVELS = eval(src.slice(a + "const LEVELS = ".length, b + 4));
const REACH = 2.2, RISE = 0.04, CELLM = 0.05;
const ISL = +(process.env.ISL || 2.0); // island radius in cells (its potato's largest)
const JV = 0.0842, GR = 0.1971, RUN = 0.0771;
const rangeCells = (drop) => (RUN * ((JV + Math.sqrt(JV * JV + 2 * GR * Math.max(0, drop))) / GR)) / CELLM;
const islandFloats = (ch) => ch === "."; // only on open water

function check(lv, allowed) {
  const rows = lv.map.map((s) => s.padEnd(Math.max(...lv.map.map((x) => x.length)), "."));
  const H = rows.length, W = rows[0].length;
  const OUT = process.env.OUTSIDE || ":"; // what's round the map
  const PAD = 3;
  const tile = (i, j) => (i < 0 || j < 0 || i >= H || j >= W ? OUT : rows[i][j]);
  const base = (i, j) => { const ch = tile(i, j); if (i < 0 || j < 0 || i >= H || j >= W || ch === "." || ch === ":") return 0; const r = lv.rise && lv.rise[i] && lv.rise[i][j]; return (+(r || (lv.riseAll && ch !== "." && ch !== ":" ? lv.riseAll : 0)) || 0) * RISE; };
  const cells = [];
  for (let i = -PAD; i < H + PAD; i++) for (let j = -PAD; j < W + PAD; j++) cells.push([i, j]);
  const key = (i, j) => `${i},${j}`;
  const find = (c) => { const o = []; for (let i = 0; i < H; i++) for (let j = 0; j < W; j++) if (rows[i][j] === c) o.push([i, j]); return o; };
  const S = find("S")[0], E = find("E");
  const hasK = find("K").length > 0;
  const stones = (lv.stones || [0, 1, 2, 3, 4, 5]).filter((t) => allowed.includes(t) && t !== lv.helm);
  // each stone's possible effects (deduplicated)
  const fires = [...find("F")], spikes = [...find("^")], bridges = [...find("~")], plates = [...find("a"), ...find("b")];
  const posList = []; for (let i = -PAD; i < H + PAD; i += 0.5) for (let j = -PAD; j < W + PAD; j += 0.5) posList.push([i, j]);
  const near = (p, list) => list.filter(([i, j]) => Math.hypot(p[0] - i, p[1] - j) <= REACH).map(([i, j]) => key(i, j)).sort().join(";");
  const effects = {};
  const uniq = (arr) => [...new Map(arr.map((e) => [e.id, e])).values()];
  for (const t of stones) {
    const list = [{ id: "none" }];
    if (t === 0) for (const p of posList) { const ch = tile(Math.round(p[0]), Math.round(p[1])); if (!islandFloats(ch)) continue; const cov = cells.filter(([i, j]) => islandFloats(tile(i, j)) && Math.hypot(i - p[0], j - p[1]) <= ISL).map(([i, j]) => key(i, j)); list.push({ id: "I" + cov.sort().join(";"), island: new Set(cov), at: p }); }
    if (t === 1) plates.forEach(([i, j]) => list.push({ id: "W" + rows[i][j], plate: rows[i][j].toUpperCase(), at: [i, j] }));
    if (t === 2) for (const p of posList) { const n = near(p, fires); if (n) list.push({ id: "R" + n, doused: new Set(n.split(";")), at: p }); }
    if (t === 3) for (const p of posList) { const n = near(p, bridges); if (n) list.push({ id: "L" + n, lit: new Set(n.split(";")), at: p }); }
    if (t === 4 && hasK) list.push({ id: "K", key: true });
    if (t === 5) for (const p of posList) { const n = near(p, spikes); if (n) list.push({ id: "E" + n, sunk: new Set(n.split(";")), at: p }); }
    effects[t] = uniq(list);
  }
  // all configurations (product)
  // up to MAXS stones in use at once (the Key, which only opens the portal, on top)
  const MAXS = +(process.env.MAXS || 2);
  const movers = stones.filter((t) => t !== 4);
  let configs = [{}];
  const rec = (k, cur, n) => {
    if (k === movers.length) { configs.push(cur); return; }
    rec(k + 1, cur, n);
    if (n < MAXS) for (const e of effects[movers[k]]) if (e.id !== "none") rec(k + 1, { ...cur, [movers[k]]: e }, n + 1);
  };
  configs = []; rec(0, {}, 0);
  if (stones.includes(4)) configs.forEach((c) => (c[4] = effects[4][1] || effects[4][0]));
  function standH(i, j, P) { // height she stands at, or null
    const ch = tile(i, j);
    const h = base(i, j);
    const k = key(i, j);
    if (ch === "." || ch === ":") return P[0] && P[0].island && P[0].island.has(k) ? 0 : null;
    if (ch === "w" || ch === "h") return null;
    if (ch === "~") return P[3] && P[3].lit && P[3].lit.has(k) ? h : null;
    if (ch === "F") return P[2] && P[2].doused && P[2].doused.has(k) ? h : null;
    if (ch === "^") return P[5] && P[5].sunk && P[5].sunk.has(k) ? h : null;
    if (ch === "A" || ch === "B") return P[1] && P[1].plate === ch ? h : null;
    return h; // # S E K a b f v H
  }
  function topH(i, j, P) { // the highest solid there (for a jump's path)
    const ch = tile(i, j); const h = base(i, j);
    if ((ch === "A" || ch === "B") && !(P[1] && P[1].plate === ch)) return h + 0.07;
    return h;
  }
  const jumps = [];
  for (let di = -3; di <= 3; di++) for (let dj = -3; dj <= 3; dj++) {
    if (Math.abs(di) + Math.abs(dj) <= 1) continue;
    const d = Math.hypot(di, dj); const ex = 0.5 / Math.max(Math.abs(di), Math.abs(dj)) * d;
    jumps.push({ di, dj, gap: d - 2 * ex });
  }
  function flood(start, P) {
    const seen = new Map(); const q = [];
    for (const k of start) { const [i, j] = k.split(",").map(Number); const h = standH(i, j, P); if (h !== null) { seen.set(k, h); q.push([i, j, h]); } }
    while (q.length) {
      const [i, j, h] = q.pop();
      const go = (ni, nj, viaJump, gap) => {
        if (ni < -PAD || nj < -PAD || ni >= H + PAD || nj >= W + PAD) return;
        const k = key(ni, nj); if (seen.has(k)) return;
        const nh = standH(ni, nj, P); if (nh === null) return;
        if (nh > h + RISE + 1e-6) return;
        if (viaJump) {
          if (gap > rangeCells(h - nh) + +(process.env.JM || 0.08)) return;
          // over the cells between: nothing higher than she flies
          const n = 12;
          for (let s = 1; s < n; s++) { const ti = Math.round(i + (ni - i) * s / n), tj = Math.round(j + (nj - j) * s / n); if ((ti === i && tj === j) || (ti === ni && tj === nj)) continue; if (topH(ti, tj, P) > Math.max(h, nh) + 0.018) return; }
        }
        seen.set(k, nh); q.push([ni, nj, nh]);
      };
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) go(i + di, j + dj, false, 0);
      for (const J of jumps) go(i + J.di, j + J.dj, true, J.gap);
    }
    return seen;
  }
  if (process.env.ONE) { // one placement, never moved
    for (const P of configs) { const f = flood([key(...S)], P); if (E.some(([i, j]) => f.has(key(i, j))) && (!hasK || (P[4] && P[4].key))) return { win: true, P, configs: configs.length }; }
    return { win: false, configs: configs.length };
  }
  let R = new Set([key(...S)]);
  for (let it = 0; it < 50; it++) {
    const before = R.size;
    for (const P of configs) {
      const st = [...R].filter((k) => { const [i, j] = k.split(",").map(Number); return standH(i, j, P) !== null; });
      if (!st.length) continue;
      const f = flood(st, P);
      for (const k of f.keys()) R.add(k);
      if (E.some(([i, j]) => f.has(key(i, j))) && (!hasK || (P[4] && P[4].key))) return { win: true, P, configs: configs.length };
    }
    if (R.size === before) break;
  }
  return { win: false, reach: R.size, configs: configs.length };
}
const desc = (P) => Object.entries(P).filter(([, e]) => e.id !== "none").map(([t, e]) => `${t}:${e.at ? e.at.join("/") : e.id}`).join(" ");
const only = process.argv[3];
for (const lv of LEVELS) {
  if (only && lv.id !== only) continue;
  if (lv.helm !== undefined) continue; // (the River: its ship isn't modelled)
  const all = lv.stones || [0, 1, 2, 3, 4, 5];
  const r = check(lv, all);
  const out = [`${lv.id.padEnd(10)} all: ${r.win ? "WIN" : "no"} (${r.configs} cfgs)`];
  for (const t of all) {
    if (t === lv.helm) continue;
    const q = check(lv, all.filter((x) => x !== t));
    out.push(`  without ${t}: ${q.win ? "WIN  <-- bypass: " + desc(q.P) : "no"}`);
  }
  console.log(out.join("\n"));
}
