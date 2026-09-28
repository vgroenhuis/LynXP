// Prisma rules -- pure logic, no drawing. Shared by the game (game_prisma.js)
// and the level solver (tools/prisma_solve.js), so "solvable in N moves" is
// checked against exactly what the game does.
//
// The grid: columns x (left -> right), rows y (top -> bottom, as written in
// the level map). At the start the robot faces "up" the map (-y).
//
// Map characters:
//   #  wall                 .  floor              S  start (floor)
//   X  exit (floor)         ~  glass: light passes, you and blocks don't
//   /  \  mirror block (pushable; / turns a beam going right upward)
//   k  crate (pushable, blocks light)
//   m  M  fixed mirror (/ and \, not pushable)
//   z  Z  fixed beam splitter (/ and \: half goes straight, half turns)
//   o  rotator pad: stepping on it turns the mirror blocks next to it
//   _  pressure plate: every gate D is open while any plate is pressed
//   D  gate                 L  laser emitter      R  receiver
//   f  colour filter (only its colour gets through)
// Emitters, receivers and filters get their details (direction, colour)
// from lists in the level definition.

(function (root) {
  const COLORS = { r: 1, g: 2, b: 4, y: 3, m: 5, c: 6, w: 7 };
  const COLOR_CSS = { 1: "#ff3040", 2: "#30ff60", 4: "#4080ff", 3: "#ffe030", 5: "#ff40ff", 6: "#30ffff", 7: "#ffffff" };
  const DIRS = { N: [0, -1], E: [1, 0], S: [0, 1], W: [-1, 0] };
  const MOVE_DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];

  // '/': right -> up, up -> right, left -> down, down -> left
  const reflect = (o, dx, dy) => (o === "/" ? [-dy, -dx] : [dy, dx]);

  function parse(level) {
    const H = level.map.length;
    const W = Math.max(...level.map.map((r) => r.length));
    const cell = [];
    const blocks = [];
    let start = null;
    for (let y = 0; y < H; y++) {
      const row = [];
      for (let x = 0; x < W; x++) {
        let ch = level.map[y][x] || "#";
        if (ch === "S") {
          start = [x, y];
          ch = ".";
        }
        if (ch === "/" || ch === "\\") {
          blocks.push({ x, y, kind: "mirror", o: ch });
          ch = ".";
        } else if (ch === "k") {
          blocks.push({ x, y, kind: "crate", o: null });
          ch = ".";
        }
        row.push(ch);
      }
      cell.push(row);
    }
    const at = (list) => {
      const m = new Map();
      (list || []).forEach((e) => m.set(e.at[0] + "," + e.at[1], e));
      return m;
    };
    return {
      W, H, cell, start,
      emitters: (level.emitters || []).map((e) => ({ x: e.at[0], y: e.at[1], d: DIRS[e.dir], color: COLORS[e.color] })),
      receivers: (level.receivers || []).map((e) => ({ x: e.at[0], y: e.at[1], color: COLORS[e.color] })),
      filters: at(level.filters),
      initial: { px: start[0], py: start[1], blocks },
    };
  }

  const inside = (g, x, y) => x >= 0 && y >= 0 && x < g.W && y < g.H;
  const blockAt = (s, x, y) => s.blocks.find((b) => b.x === x && b.y === y);

  function platePressed(g, s) {
    for (let y = 0; y < g.H; y++) {
      for (let x = 0; x < g.W; x++) {
        if (g.cell[y][x] !== "_") continue;
        if ((s.px === x && s.py === y) || blockAt(s, x, y)) return true;
      }
    }
    return false;
  }

  // Can the player stand here / a block be pushed here?
  function passable(g, s, x, y, forBlock) {
    if (!inside(g, x, y)) return false;
    const ch = g.cell[y][x];
    if ("#~mMzZLRf".includes(ch)) return false;
    if (ch === "D" && !platePressed(g, s)) return false;
    if (forBlock && ch === "X") return false;
    return true;
  }

  // Trace every beam. Returns {segments: [{x0,y0,x1,y1,color}] (cell coords,
  // may end at a cell edge), hits: Map receiverIndex -> colour mask, lit: bool
  // (every receiver gets exactly its colour)}.
  function trace(g, s) {
    const segments = [];
    const hitColor = new Array(g.receivers.length).fill(0);
    const seen = new Set();
    const gatesOpen = platePressed(g, s);
    const stack = g.emitters.map((e) => ({ x: e.x, y: e.y, dx: e.d[0], dy: e.d[1], color: e.color }));
    while (stack.length) {
      let { x, y, dx, dy, color } = stack.pop();
      const sx = x;
      const sy = y;
      for (let steps = 0; steps < 200; steps++) {
        const nx = x + dx;
        const ny = y + dy;
        const key = `${nx},${ny},${dx},${dy},${color}`;
        if (!inside(g, nx, ny) || seen.has(key)) {
          segments.push({ x0: sx, y0: sy, x1: x + dx * 0.5, y1: y + dy * 0.5, color });
          break;
        }
        seen.add(key);
        x = nx;
        y = ny;
        const ch = g.cell[y][x];
        const b = blockAt(s, x, y);
        const stopHere = () => segments.push({ x0: sx, y0: sy, x1: x - dx * 0.5, y1: y - dy * 0.5, color });
        if (ch === "#" || ch === "L" || (ch === "D" && !gatesOpen) || (b && b.kind === "crate")) {
          stopHere();
          break;
        }
        if (s.px === x && s.py === y) {
          // the robot's own shadow
          stopHere();
          break;
        }
        if (ch === "R") {
          const i = g.receivers.findIndex((r) => r.x === x && r.y === y);
          if (i >= 0) hitColor[i] |= color;
          segments.push({ x0: sx, y0: sy, x1: x, y1: y, color });
          break;
        }
        if (ch === "f") {
          const f = g.filters.get(x + "," + y);
          const c = color & (f ? COLORS[f.color] : 0);
          segments.push({ x0: sx, y0: sy, x1: x, y1: y, color });
          if (!c) break;
          stack.push({ x, y, dx, dy, color: c });
          break;
        }
        let o = null;
        let split = false;
        if (b && b.kind === "mirror") o = b.o;
        else if (ch === "m") o = "/";
        else if (ch === "M") o = "\\";
        else if (ch === "z" || ch === "Z") {
          o = ch === "z" ? "/" : "\\";
          split = true;
        }
        if (o) {
          segments.push({ x0: sx, y0: sy, x1: x, y1: y, color });
          const [rx, ry] = reflect(o, dx, dy);
          stack.push({ x, y, dx: rx, dy: ry, color });
          if (split) stack.push({ x, y, dx, dy, color });
          break;
        }
      }
    }
    const lit = g.receivers.every((r, i) => hitColor[i] === r.color);
    return { segments, hitColor, lit };
  }

  // One move of the player in direction (dx, dy). Returns the new state, or
  // null if that move isn't possible.
  function move(g, s, dx, dy) {
    const tx = s.px + dx;
    const ty = s.py + dy;
    if (!inside(g, tx, ty)) return null;
    const b = blockAt(s, tx, ty);
    let blocks = s.blocks;
    if (b) {
      const bx = tx + dx;
      const by = ty + dy;
      if (!passable(g, s, bx, by, true) || blockAt(s, bx, by)) return null;
      blocks = s.blocks.map((o) => (o === b ? { ...o, x: bx, y: by } : o));
    } else if (!passable(g, s, tx, ty, false)) {
      return null;
    }
    let next = { px: tx, py: ty, blocks };
    // a gate can't close on you: if you'd stand in a gate that is now shut, the move fails
    if (g.cell[ty][tx] === "D" && !platePressed(g, next)) return null;
    if (g.cell[ty][tx] === "o") {
      next = {
        ...next,
        blocks: next.blocks.map((o) =>
          o.kind === "mirror" && Math.abs(o.x - tx) + Math.abs(o.y - ty) === 1 ? { ...o, o: o.o === "/" ? "\\" : "/" } : o),
      };
    }
    return next;
  }

  const solved = (g, s) => g.cell[s.py][s.px] === "X" && trace(g, s).lit;

  function stateKey(s) {
    const bs = s.blocks.map((b) => `${b.x},${b.y}${b.o || "k"}`).sort().join(";");
    return `${s.px},${s.py}|${bs}`;
  }

  // Breadth-first search for the shortest solution (list of [dx,dy]).
  function solve(level, maxStates = 3e6) {
    const g = parse(level);
    const startS = g.initial;
    const prev = new Map([[stateKey(startS), null]]);
    let frontier = [startS];
    let depth = 0;
    while (frontier.length) {
      const next = [];
      for (const s of frontier) {
        if (solved(g, s)) {
          const path = [];
          let k = stateKey(s);
          while (prev.get(k)) {
            const [pk, mv] = prev.get(k);
            path.push(mv);
            k = pk;
          }
          return { moves: path.reverse(), explored: prev.size, depth };
        }
        const sk = stateKey(s);
        for (const [dx, dy] of MOVE_DIRS) {
          const n = move(g, s, dx, dy);
          if (!n) continue;
          const nk = stateKey(n);
          if (prev.has(nk)) continue;
          prev.set(nk, [sk, [dx, dy]]);
          next.push(n);
        }
      }
      if (prev.size > maxStates) return { moves: null, explored: prev.size, depth, gaveUp: true };
      frontier = next;
      depth++;
    }
    return { moves: null, explored: prev.size, depth };
  }

  const core = { COLORS, COLOR_CSS, DIRS, MOVE_DIRS, parse, trace, move, solved, stateKey, solve, platePressed, blockAt };
  if (typeof module !== "undefined" && module.exports) module.exports = core;
  root.Lynx = root.Lynx || {};
  root.Lynx.prismaCore = core;
})(typeof window !== "undefined" ? window : globalThis);
