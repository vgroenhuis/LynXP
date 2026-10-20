// Block Quest's levels (game_blockquest.js). Each is laid out round the FRAME
// CUBE, in cube sizes (U = the size of the cubes in use, 5 cm for the 40 mm
// tags at 75%): x away from the robot, y to the left, the frame cube's
// center the origin.
//
//   {id, name, tags (what the level is about), blurb, story,
//    cubes: [{tag, at: [x, y], stack (0 floor, 1 on a cube...), onTag, label,
//             tol, optional, free (a radius: anywhere within it)}],
//    spawn: {at: [x, y], yaw (deg)}, bombs: n carried at the start,
//    skins: {tag: style}, frameSkin, floor: "lava" | "flags" | "water", area: [x0, y0, x1, y1],
//    init(L), update(L, dt), draw(L), objective(L) -> text | {text, at: [x, y], h},
//    onKill(L, e), onBlast(L, f, r, z, rad), solids(L)}
//
// L (see game_blockquest.js): enemy(), pickup(), geyser(), barricade(), wall(),
// gate(), keg(), brazier(), flag(), cube(tag), heroOn(), win()...

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  const LEVELS = [];

  // ================================================================================================
  // 1. The Dawn Stair -- a first climb, no enemies
  // ================================================================================================
  LEVELS.push({
    id: "dawn",
    name: "The Dawn Stair",
    tags: "puzzle · climbing",
    blurb: "A first climb, no enemies: stack two blocks into a tower, add a step, fetch the Sunstone and light the beacon on the frame cube.",
    story: "The Sunstone lies on the top of a ruined tower. Climb it, take the stone, and carry it back to the beacon (the frame cube) to bring the dawn.",
    intro: "Climb the tower, take the Sunstone, light the beacon",
    cubes: [
      { tag: 0, at: [3.2, -1.2], stack: 0, label: "Tower" },
      { tag: 1, at: [3.2, -1.2], stack: 1, onTag: 0, label: "Tower top" },
      { tag: 2, at: [3.2, 0.0], stack: 0, label: "Step" },
    ],
    spawn: { at: [1.5, 0], yaw: 0 },
    skins: { 0: "stone", 1: "stone", 2: "stone" },
    frameSkin: "ivory",
    floor: "flags",
    area: [-2.5, -5, 8, 5],
    init(L) {
      L.brazier([1.2, 2.6]);
      L.brazier([1.2, -3.0]);
      L.brazier([5.8, 1.8]);
      L.pickup("coin", [2.2, 0.8]);
      L.pickup("coin", [2.2, -0.6]);
      L.pickup("coin", [3.2, 0.0], { tag: 2, lift: 0.004 });
      L.pickup("heart", [5.0, -2.4]);
      L.pickup("gem", null, { tag: 1, lift: 0.007, color: "255,206,90", size: 1.3, name: "sunstone", onTake: (L2) => {
        L2.flag("stone", true);
        L2.say("The Sunstone! Back to the beacon -- climb the frame cube", "#ffe080");
      } });
    },
    update(L) {
      if (L.flag("stone") && L.heroOn() === "frame") {
        L.flag("lit", true);
        L.win("The beacon is lit -- dawn breaks");
      }
    },
    draw(L) {
      const f = L.frame();
      if (f && L.flag("lit")) L.fx.flame(f.f, f.r, f.top, 0.05, L.clock());
      else if (f && L.flag("stone")) {
        const m = L.w.project(f.f, f.r, f.top + 0.01);
        if (m) L.api.ar.glow(m.x, m.y, 0.02 * m.ppm, [[0, "rgba(255,230,140,0.45)"], [1, "rgba(255,200,60,0)"]]);
      }
    },
    objective(L) {
      if (!L.flag("stone")) {
        const t = L.cube(1);
        const on = L.heroOn();
        const text = on === 2 ? "Jump at the tower's edge and hold toward it: the knight hangs, then climbs" : on === 0 || on === 1 ? "" : "Climb the step, then the tower: jump at a ledge and hold toward it";
        return { text, at: t ? [t.x, t.y] : [3.2, -1.2], h: 0.12 };
      }
      return { text: "Carry the Sunstone to the beacon: climb onto the frame cube", at: [0, 0], h: 0.05 };
    },
  });

  // ================================================================================================
  // 2. The Cinder Causeway -- the floor is lava
  // ================================================================================================
  LEVELS.push({
    id: "cinder",
    name: "The Cinder Causeway",
    tags: "lava · platforms · move a block",
    blurb: "The floor is lava. Hop from stone to stone to the Ember Crown, between the geysers' eruptions -- and the last gap is too wide: move a block that the knight is not standing on.",
    story: "The temple floor has melted. The only way to the Ember Crown is over the stones. One gap is too wide for any jump: carry the spare stone to it -- with your hands, or the robot -- but never one the knight stands on.",
    intro: "The floor is lava! Stone to stone to the Ember Crown",
    cubes: [
      { tag: 0, at: [1.65, 0.2], label: "Stone 0" },
      { tag: 1, at: [3.3, -0.45], label: "Stone 1" },
      { tag: 2, at: [4.95, 0.2], label: "Stone 2" },
      { tag: 3, at: [8.5, 0.2], stack: 0, label: "Pedestal" },
      { tag: 4, at: [8.5, 0.2], stack: 1, onTag: 3, label: "Pedestal top" },
      { tag: 5, at: [-0.4, -3.4], free: 1.4, label: "Spare stone", optional: false },
    ],
    spawn: { at: [0, 0], yaw: 0 },
    skins: { 0: "basalt", 1: "basalt", 2: "basalt", 3: "basalt", 4: "basalt", 5: "basalt" },
    frameSkin: "stone",
    floor: "lava",
    area: [-2.2, -5.5, 11.5, 5.5],
    init(L) {
      L.lava([-2.2, -5.5, 11.5, 5.5]);
      L.geyser([0.85, 0.1], { phase: 0.0 });
      L.geyser([2.5, -0.15], { phase: 1.5 });
      L.geyser([4.1, -0.15], { phase: 3.0 });
      L.geyser([5.83, 0.2], { phase: 0.8 });
      L.geyser([7.6, 0.2], { phase: 2.2 });
      L.pickup("coin", null, { tag: 0, lift: 0.004 });
      L.pickup("coin", null, { tag: 1, lift: 0.004 });
      L.pickup("heart", null, { tag: 2, lift: 0.006 });
      L.pickup("crown", null, { tag: 4, lift: 0.008, size: 1.4, name: "crown", onTake: (L2) => L2.win("The Ember Crown is yours") });
      L.brazier([3.0, 3.5]);
      L.brazier([7.0, -3.5]);
    },
    update(L, dt) {
      if (Math.random() < dt * 18) {
        const h = L.heroU();
        L.fx.parts.emit("ember", L.f(h[0] + L.rnd(-3, 3), h[1] + L.rnd(-3, 3)).f, L.f(h[0] + L.rnd(-3, 3), h[1] + L.rnd(-3, 3)).r, 0.002, 1, 0.01, { up: 0.05 });
      }
    },
    objective(L) {
      const s5 = L.cube(5);
      const bridged = s5 && dist([s5.x, s5.y], [6.7, 0.2]) < 1.15 && s5.stack === 0;
      const hu = L.heroU();
      if (!bridged && hu[0] > 3.5) return { text: "The last gap is too wide: put the spare stone (5) in it -- not a stone the knight stands on", at: [6.7, 0.2], h: 0.05 };
      if (!bridged) return { text: "Hop from stone to stone -- jump between the geysers' eruptions", at: [4.95, 0.2], h: 0.06 };
      return { text: "Cross to the pedestal and take the Ember Crown", at: [8.5, 0.2], h: 0.12 };
    },
  });

  // ================================================================================================
  // 3. The Sentinels' Court -- sword and shield
  // ================================================================================================
  LEVELS.push({
    id: "court",
    name: "The Sentinels' Court",
    tags: "melee · shield · archers",
    blurb: "Three waves of skeletons: parry their blows with your shield, then strike; hit a hoplite's shield twice or strike right after it swings; hide behind the pillars from the archer on the tower -- then climb to the relic on the altar. The cubes stay where they are.",
    story: "The court is guarded by the dead. Their blows are slow, and tell you when they come: raise your shield just as one lands to parry it, then strike. Hoplites hide behind their own shields -- but lower them to swing, and two blows knock a shield aside. The cubes are the court's pillars and tower: leave them where they are, they're your cover.",
    intro: "Three waves -- shield up! The cubes stay put: they're your cover",
    cubes: [
      { tag: 0, at: [3.2, -2.3], label: "Pillar" },
      { tag: 1, at: [3.2, 2.3], label: "Pillar" },
      { tag: 2, at: [5.8, -1.3], label: "Pillar" },
      { tag: 3, at: [5.8, 1.3], label: "Pillar" },
      { tag: 4, at: [9.2, 0], stack: 0, label: "Tower base" },
      { tag: 5, at: [9.2, 0], stack: 1, onTag: 4, label: "Tower top" },
    ],
    spawn: { at: [1.5, 0], yaw: 0 },
    skins: { 0: "stone", 1: "stone", 2: "stone", 3: "stone", 4: "dark", 5: "dark" },
    frameSkin: "ivory",
    floor: "flags",
    floorTex: "darkflag",
    area: [-1.6, -5.5, 10.8, 5.5],
    init(L) {
      L.brazier([1.2, 3.8]);
      L.brazier([1.2, -3.8]);
      L.brazier([10.2, 3.8]);
      L.brazier([10.2, -3.8]);
      L.flag("wave", 0);
      L.flag("wait", 3);
      L.flag("relic", L.pickup("crown", null, { tag: "frame", lift: 0.008, size: 1.4, hidden: true, onTake: (L2) => L2.win("The relic is yours -- the court is silent") }));
    },
    update(L, dt) {
      const wave = L.flag("wave");
      const alive = L.A.alive().length;
      if (wave < 3 || alive) {
        if (alive === 0) {
          L.flag("wait", L.flag("wait") - dt);
          if (L.flag("wait") <= 0) nextWave(L);
        }
      } else if (!L.flag("clear")) {
        L.flag("clear", true);
        L.flag("relic").hidden = false;
        L.say("The court is clear -- take the relic from the altar", "#ffe080");
        L.sfx("power");
      }
    },
    objective(L) {
      const wave = L.flag("wave");
      const alive = L.A.alive().length;
      if (L.flag("clear")) return { text: "Climb the altar (the frame cube) and take the relic", at: [0, 0], h: 0.07 };
      if (wave === 0) return { text: "They come -- hold the shield up (X / B) and wait for the first blow", at: [6, 0], h: 0.02 };
      if (alive) return { text: `Wave ${wave}/3 -- ${alive} left. Shield up, strike when they reel` };
      return { text: "Catch your breath..." };
    },
  });
  function nextWave(L) {
    const wave = L.flag("wave") + 1;
    L.flag("wave", wave);
    L.flag("wait", 4);
    if (wave === 1) {
      L.enemy("skeleton", [9.6, -3.2], { yawDeg: 180 });
      L.enemy("skeleton", [9.6, 3.2], { yawDeg: 180 });
      L.say("Wave 1 -- raise your shield just as a blow lands: PARRY, then strike", "#ffe080");
    } else if (wave === 2) {
      L.enemy("hoplite", [9.6, -2.6], { yawDeg: 180 });
      L.enemy("skeleton", [9.6, 2.8], { yawDeg: 180 });
      L.enemy("archer", [0, 0], { perch: 5, yawDeg: 180 });
      L.say("Wave 2 -- the archer shoots: use the pillars, block, or jump. The hoplite's shield holds: bash it (Fire, shield up) or go round", "#ffe080");
      L.pickup("heart", [2.0, 0]);
    } else if (wave === 3) {
      L.enemy("hoplite", [9.6, 2.6], { yawDeg: 180 });
      L.enemy("hoplite", [9.6, -2.6], { yawDeg: 180 });
      L.enemy("skeleton", [9.6, 0], { yawDeg: 180 });
      L.say("Wave 3 -- the last of them", "#ffe080");
      L.pickup("heart", [2.0, 1.0]);
    }
  }

  // ================================================================================================
  // 4. The Powder Cellar -- bombs
  // ================================================================================================
  LEVELS.push({
    id: "cellar",
    name: "The Powder Cellar",
    tags: "bombs · armor · powder kegs",
    blurb: "A rubble wall seals the vault; behind it waits an armored brute. Set bombs by hand, take cover behind the pillars, and detonate from afar -- or carry a powder keg (a real cube!) next to the wall.",
    story: "The vault's door is a heap of rubble that only powder can move, and the brute behind it is armored: the sword rings off its plates until a blast cracks them. Bombs go where you set them and wait; the kegs (cubes 4 and 5) go where you put them -- by hand.",
    intro: "Blow the rubble wall -- B sets a bomb, E sets them off",
    bombs: 3,
    cubes: [
      { tag: 0, at: [3.0, -1.4], label: "Pillar" },
      { tag: 1, at: [3.0, 1.4], label: "Pillar" },
      { tag: 2, at: [4.6, -2.7], label: "Pillar" },
      { tag: 3, at: [4.6, 2.7], label: "Pillar" },
      { tag: 4, at: [1.2, -3.6], label: "Powder keg" },
      { tag: 5, at: [1.2, 3.6], label: "Powder keg" },
    ],
    spawn: { at: [1.5, 0], yaw: 0 },
    skins: { 0: "stone", 1: "stone", 2: "stone", 3: "stone", 4: "crate", 5: "crate" },
    frameSkin: "dark",
    floor: "flags",
    floorTex: "crypt",
    area: [-1.6, -5.5, 12.2, 5.5],
    init(L) {
      // the dividing wall and the rubble in its doorway
      L.wall({ at: [6.2, -3.9], len: 4.0, angle: 90, height: 1.5 });
      L.wall({ at: [6.2, 3.9], len: 4.0, angle: 90, height: 1.5 });
      L.barricade({ at: [6.2, 0], len: 3.9, angle: 90, height: 1.3 });
      L.keg({ tag: 4 });
      L.keg({ tag: 5 });
      L.brazier([1.0, 2.0]);
      L.brazier([1.0, -2.0]);
      L.brazier([11.3, 4.0]);
      L.pickup("bomb", [1.0, 0.2]);
      L.pickup("bomb", [2.2, -3.8]);
      L.pickup("heart", [2.6, 3.6]);
      const brute = L.enemy("brute", [9.0, 0], { dormant: true, yawDeg: 180 });
      L.flag("brute", brute);
      L.enemy("skeleton", [8.4, -2.2], { dormant: true, yawDeg: 180 });
      L.enemy("skeleton", [8.4, 2.2], { dormant: true, yawDeg: 180 });
      L.pickup("crown", [11.0, 0], { size: 1.4, name: "treasure", onTake: (L2) => L2.win("The vault's treasure is yours") });
    },
    onBlast(L) {
      // the noise wakes the vault
      L.A.wakeAll();
    },
    objective(L) {
      const bar = L.E.barricades[0];
      if (bar && !bar.dead) return { text: L.G.bombs + L.A.bombs.length ? "Set bombs at the rubble (B), step back behind a pillar, detonate (E). Or move a powder keg beside it by hand" : "Out of bombs: find more, or carry a powder keg (cube 4 / 5) to the wall and strike it", at: [6.2, 0], h: 0.04 };
      const brute = L.flag("brute");
      if (brute && brute.state !== "dead") return { text: brute.armor ? "The brute's armor turns the sword: set a bomb where it will pass, detonate when it is near" : "Its armor is cracked -- strike now!" };
      return { text: "Take the treasure from the vault", at: [11, 0], h: 0.04 };
    },
  });


  // ================================================================================================
  // 5. The Sunbeam Vault -- the real cubes are the mirrors
  // ================================================================================================
  // The beam: from the sun-orb it runs along the floor until it meets a cube. A cube's four faces are
  // mirrors (cubes 0-2) -- turn one a quarter... or an eighth, 45 degrees, and the beam turns a right
  // angle -- the prism (cube 3) splits what hits it in two, anything else (the frame cube, the
  // obsidian block) swallows it. Both crystals lit: the vault opens.
  const BEAM_SRC = { p: [2.5, -5.6], d: [0, 1] };
  const OBSIDIAN = { c: [2.5, 0], half: 1.1 };
  const CRYSTALS = [[1.0, 3.0], [8.6, 3.0]];
  const SOLUTION = [{ tag: 0, at: [2.2, -3.6], yaw: 45 }, { tag: 1, at: [6.5, -4.2], yaw: 45 }, { tag: 3, at: [6.0, 3.0], yaw: 0 }];
  function squareEdges(c, half, yawRad) {
    const co = Math.cos(yawRad);
    const si = Math.sin(yawRad);
    const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => [c[0] + (a * co - b * si) * half, c[1] + (a * si + b * co) * half]);
    return pts.map((p, i) => ({ a: p, b: pts[(i + 1) % 4] }));
  }
  function traceBeams(L) {
    const sq = [];
    [0, 1, 2].forEach((tag) => {
      const c = L.cube(tag);
      if (c) sq.push({ edges: squareEdges([c.x, c.y], c.size / 2 / L.U, c.yawW), kind: "mirror", c: [c.x, c.y] });
    });
    const pr = L.cube(3);
    if (pr) sq.push({ edges: squareEdges([pr.x, pr.y], pr.size / 2 / L.U, pr.yawW), kind: "prism", c: [pr.x, pr.y] });
    const fr = L.frame();
    if (fr) sq.push({ edges: squareEdges([fr.x, fr.y], 0.4, 0), kind: "absorb", c: [fr.x, fr.y] });
    sq.push({ edges: squareEdges(OBSIDIAN.c, OBSIDIAN.half, 0), kind: "absorb", c: OBSIDIAN.c });
    const segs = [];
    const rays = [{ p: BEAM_SRC.p.slice(), d: BEAM_SRC.d.slice(), n: 0, skip: null }];
    let guard = 0;
    while (rays.length && guard++ < 24) {
      const ray = rays.pop();
      let { p, d } = ray;
      let skip = ray.skip;
      for (let bounce = 0; bounce < 7; bounce++) {
        let best = null;
        sq.forEach((s) => {
          if (s === skip) return;
          s.edges.forEach(({ a, b }) => {
            const ex = b[0] - a[0];
            const ey = b[1] - a[1];
            const den = d[0] * ey - d[1] * ex;
            if (Math.abs(den) < 1e-9) return;
            const t = ((a[0] - p[0]) * ey - (a[1] - p[1]) * ex) / den;
            const u = ((a[0] - p[0]) * d[1] - (a[1] - p[1]) * d[0]) / den;
            if (t < 1e-4 || u < 0 || u > 1) return;
            if (!best || t < best.t) {
              const len = Math.hypot(ex, ey);
              let n = [ey / len, -ex / len];
              if ((a[0] - s.c[0]) * n[0] + (a[1] - s.c[1]) * n[1] < 0) n = [-n[0], -n[1]];
              best = { t, n, s };
            }
          });
        });
        const T = best ? best.t : 30;
        const q = [p[0] + d[0] * T, p[1] + d[1] * T];
        segs.push({ a: p, b: q, hit: best ? best.s.kind : null });
        if (!best) break;
        if (best.s.kind === "mirror") {
          const dn = d[0] * best.n[0] + d[1] * best.n[1];
          d = [d[0] - 2 * dn * best.n[0], d[1] - 2 * dn * best.n[1]];
          p = q;
          skip = best.s;
        } else if (best.s.kind === "prism") {
          rays.push({ p: best.s.c.slice(), d: [-d[1], d[0]], skip: best.s }, { p: best.s.c.slice(), d: [d[1], -d[0]], skip: best.s });
          break;
        } else break;
      }
    }
    return segs;
  }
  const segDist = (p, a, b) => {
    const ex = b[0] - a[0];
    const ey = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * ex + (p[1] - a[1]) * ey) / (ex * ex + ey * ey || 1)));
    return Math.hypot(p[0] - a[0] - t * ex, p[1] - a[1] - t * ey);
  };
  LEVELS.push({
    id: "beam",
    name: "The Sunbeam Vault",
    tags: "puzzle · mirrors · no enemies",
    blurb: "No enemies: a sunbeam, three mirror cubes, a prism cube. Turn the real cubes (45 degrees!) so the beam reaches both crystals and the vault opens.",
    story: "A sun-orb throws a beam across the floor. The cubes are mirrors: set one at 45 degrees and the beam turns a right angle. The prism (cube 3) splits a beam in two. The frame cube and the obsidian block swallow light. Light both crystals -- then the vault door lifts.",
    intro: "Aim the beam: turn the mirror cubes 45 degrees. H: a hint",
    cubes: [
      { tag: 0, at: [-0.6, -3.2], free: 1.6, label: "Mirror" },
      { tag: 1, at: [0.8, -3.3], free: 1.6, label: "Mirror" },
      { tag: 2, at: [-0.4, -4.6], free: 1.6, label: "Mirror", optional: true },
      { tag: 3, at: [-1.6, 2.4], free: 1.6, label: "Prism" },
    ],
    spawn: { at: [1.0, 0.0], yaw: 0 },
    skins: { 0: "ivory", 1: "ivory", 2: "ivory", 3: "sea" },
    frameSkin: "dark",
    floor: "flags",
    floorTex: "darkflag",
    area: [-2.6, -6, 11.6, 6],
    init(L) {
      L.wall({ at: [2.5, 0], len: 2.2, angle: 90, thick: 2.2, height: 1.2, style: "basalt" }); // the obsidian block
      L.wall({ at: [9.6, -4.4], len: 3.0, angle: 90, height: 1.4 });
      L.wall({ at: [10.9, -0.1], len: 2.6, angle: 0, height: 1.4 });
      L.flag("gate", L.gate({ at: [9.6, -1.5], len: 2.8, angle: 90, height: 1.4 }));
      L.pickup("crown", [11.0, -1.8], { size: 1.4, name: "treasure", onTake: (L2) => L2.win("The vault is open -- the treasure is yours") });
      L.pickup("coin", [1.2, 1.8]);
      L.pickup("coin", [1.2, -1.8]);
      L.pickup("heart", [5.0, 4.6]);
      L.brazier([8.2, 5.0]);
      L.brazier([-1.2, -5.0]);
      L.flag("lit", [0, 0]);
      L.flag("segs", []);
    },
    update(L, dt) {
      const segs = traceBeams(L);
      L.flag("segs", segs);
      const lit = L.flag("lit");
      CRYSTALS.forEach((c, i) => {
        const on = segs.some((s) => segDist(c, s.a, s.b) < 0.4);
        lit[i] = on ? Math.min(1.5, lit[i] + dt) : Math.max(0, lit[i] - dt * 1.5);
      });
      const gate = L.flag("gate");
      const both = lit[0] > 0.8 && lit[1] > 0.8;
      if (both && !gate.open) {
        gate.open = true;
        L.say("Both crystals blaze -- the vault door lifts!", "#ffe080");
        L.sfx("gate");
      }
    },
    draw(L) {
      const { w, fx } = L;
      const U = L.U;
      const g = L.api.ar.ctx;
      const t = L.clock();
      const pt = (x, y, h) => {
        const l = L.f(x, y);
        return [l.f, l.r, h];
      };
      const lit = L.flag("lit") || [0, 0];
      // the sun-orb
      const src = w.project(...pt(BEAM_SRC.p[0], BEAM_SRC.p[1], 0.012));
      if (src) {
        L.api.ar.queue(src.depth, () => {
          fx.shadow(...pt(BEAM_SRC.p[0], BEAM_SRC.p[1], 0).slice(0, 2), 0, 0.01, 0.3);
          g.save();
          g.globalCompositeOperation = "lighter";
          L.api.ar.glow(src.x, src.y, 0.03 * src.ppm, [[0, "rgba(255,250,210,0.95)"], [0.35, "rgba(255,200,90,0.6)"], [1, "rgba(255,140,30,0)"]]);
          g.restore();
        });
      }
      // the crystals
      CRYSTALS.forEach((c, i) => {
        const m = w.project(...pt(c[0], c[1], 0.02));
        if (!m) return;
        L.api.ar.queue(m.depth, () => {
          const k = Math.min(1, lit[i]);
          const R = 0.012 * m.ppm;
          fx.shadow(...pt(c[0], c[1], 0).slice(0, 2), 0, 0.009, 0.3);
          g.save();
          g.beginPath();
          g.moveTo(m.x, m.y - R * 1.5);
          g.lineTo(m.x + R * 0.8, m.y - R * 0.2);
          g.lineTo(m.x + R * 0.5, m.y + R * 0.9);
          g.lineTo(m.x - R * 0.5, m.y + R * 0.9);
          g.lineTo(m.x - R * 0.8, m.y - R * 0.2);
          g.closePath();
          const gr = g.createLinearGradient(m.x - R, m.y - R, m.x + R, m.y + R);
          gr.addColorStop(0, `rgb(${120 + 135 * k | 0},${150 + 100 * k | 0},${200 + 55 * k | 0})`);
          gr.addColorStop(1, `rgb(${30 + 80 * k | 0},${50 + 100 * k | 0},${100 + 90 * k | 0})`);
          g.fillStyle = gr;
          g.fill();
          g.strokeStyle = "rgba(255,255,255,0.7)";
          g.stroke();
          if (k > 0.05) {
            g.globalCompositeOperation = "lighter";
            L.api.ar.glow(m.x, m.y, R * (2.5 + k * 2), [[0, `rgba(255,240,170,${0.7 * k})`], [1, "rgba(255,200,60,0)"]]);
          }
          g.restore();
        });
      });
      // the beams
      (L.flag("segs") || []).forEach((s) => {
        const mid = w.project(...pt((s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2, 0.01));
        if (!mid) return;
        L.api.ar.queue(mid.depth + 0.05, () => {
          const P = [pt(s.a[0], s.a[1], 0.01), pt(s.b[0], s.b[1], 0.01)];
          g.save();
          g.globalCompositeOperation = "lighter";
          g.lineCap = "round";
          w.line3(P, `rgba(255,190,70,${0.22 + 0.05 * Math.sin(t * 9)})`, 9, 0.04);
          w.line3(P, "rgba(255,230,140,0.5)", 4, 0.04);
          w.line3(P, "rgba(255,255,235,0.95)", 1.6, 0.04);
          if (s.hit) {
            const e = w.project(...pt(s.b[0], s.b[1], 0.01));
            if (e) L.api.ar.glow(e.x, e.y, 0.012 * e.ppm, [[0, "rgba(255,255,230,0.9)"], [1, "rgba(255,180,60,0)"]]);
          }
          g.restore();
        });
      });
      // the hint: where the cubes go
      if (L.G.hint) {
        SOLUTION.forEach((sol) => {
          const half = U * 0.5;
          const co = Math.cos((sol.yaw * Math.PI) / 180);
          const si = Math.sin((sol.yaw * Math.PI) / 180);
          const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => {
            const x = sol.at[0] * U + (a * co - b * si) * half;
            const y = sol.at[1] * U + (a * si + b * co) * half;
            const l = L.api.w.toLocal(x, y);
            return [l.f, l.r, 0.002];
          });
          const poly = w.polyScreen(corners, 2);
          if (poly) w.fillPoly(poly, "rgba(120,220,255,0.22)", "rgba(120,220,255,0.9)", 2);
          const m = w.project(...pt(sol.at[0], sol.at[1], U + 0.004));
          if (m) L.api.ar.text(`${sol.tag}`, m.x, m.y, { size: 14, align: "center", color: "#a0e8ff" });
        });
      }
    },
    objective(L) {
      const lit = L.flag("lit") || [0, 0];
      const gate = L.flag("gate");
      if (gate && gate.open) return { text: "The vault is open -- take the treasure (jump nothing: the beams are harmless)", at: [11, -1.8], h: 0.04 };
      if (lit[0] > 0.2 || lit[1] > 0.2) return { text: `${lit[0] > 0.8 ? "One crystal burns" : ""}${lit[1] > 0.8 ? "One crystal burns" : "Almost"} -- light both: use the prism to split the beam` };
      return { text: "Get the beam past the obsidian block to the crystals: a mirror cube at 45 degrees turns it (H: hint)" };
    },
  });

  // ================================================================================================
  // 6. The Ember Ferry -- two players: the knight rides, a human slides the ferry cube
  // ================================================================================================
  const LANE = [[3.1, 0], [4.5, -0.6], [5.25, 0], [6.0, 0.6], [7.4, -0.5], [8.45, 0]];
  const ROCKS = [[4.5, 0.8], [6.0, -0.8], [7.4, 0.9]];
  const laneAt = (s) => {
    let left = s;
    for (let i = 0; i + 1 < LANE.length; i++) {
      const len = Math.hypot(LANE[i + 1][0] - LANE[i][0], LANE[i + 1][1] - LANE[i][1]);
      if (left <= len) {
        const k = left / len;
        return [LANE[i][0] + (LANE[i + 1][0] - LANE[i][0]) * k, LANE[i][1] + (LANE[i + 1][1] - LANE[i][1]) * k];
      }
      left -= len;
    }
    return LANE[LANE.length - 1].slice();
  };
  const LANE_LEN = LANE.slice(1).reduce((m, p, i) => m + Math.hypot(p[0] - LANE[i][0], p[1] - LANE[i][1]), 0);
  function ferryPos(L) {
    if (L.api.cfg.solo) return { x: L.flag("ferry")[0], y: L.flag("ferry")[1], virtual: true };
    const c = L.cube(5);
    return c ? { x: c.x, y: c.y, c, top: c.top } : null;
  }
  function drawBoat(L, f, r, top, yaw) {
    const { w, fx } = L;
    const g = L.api.ar.ctx;
    const t = L.clock();
    const half = L.U / 2;
    fx.skin({ cf: f, cr: r, yaw, half: half + 0.003, h0: -0.004, h1: top, tag: 5 }, "crate", { grow: 0.0008 });
    // the gunwale
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1], [-1, -1]].map(([a, b]) => [f + (a * c - b * s) * (half + 0.003), r + (a * s + b * c) * (half + 0.003), top + 0.001]);
    w.line3(corners, "rgba(60,36,16,0.95)", 3, 0.02);
    // a mast, a lantern and a pennant at the stern
    const base = [f + (-0.7 * c + 0.7 * s) * half, r + (-0.7 * s - 0.7 * c) * half, top];
    const tip = [base[0], base[1], top + 0.032];
    w.line3([base, tip], "rgba(70,44,20,0.95)", 2, 0.02);
    const m = w.project(...tip);
    if (m) {
      g.save();
      g.globalCompositeOperation = "lighter";
      L.api.ar.glow(m.x, m.y, 0.014 * m.ppm * (0.9 + 0.1 * Math.sin(t * 13)), [[0, "rgba(255,230,150,0.9)"], [0.4, "rgba(255,160,60,0.45)"], [1, "rgba(255,100,0,0)"]]);
      g.restore();
      g.fillStyle = "rgba(190,40,30,0.9)";
      g.beginPath();
      g.moveTo(m.x, m.y + 2);
      g.lineTo(m.x + 0.012 * m.ppm, m.y + 0.004 * m.ppm + Math.sin(t * 6) * 2);
      g.lineTo(m.x, m.y + 0.008 * m.ppm);
      g.fill();
    }
  }
  function drawRock(L, u, hit) {
    const l = L.f(u[0], u[1]);
    const m = L.w.project(l.f, l.r, 0.006);
    if (!m) return;
    const g = L.api.ar.ctx;
    L.api.ar.queue(m.depth, () => {
      const R = 0.014 * m.ppm;
      L.fx.shadow(l.f, l.r, 0, 0.011, 0.35);
      const gr = g.createRadialGradient(m.x - R * 0.35, m.y - R * 0.5, R * 0.1, m.x, m.y, R * 1.1);
      gr.addColorStop(0, "#9a948a");
      gr.addColorStop(0.55, "#5a554e");
      gr.addColorStop(1, "#1c1a18");
      g.fillStyle = gr;
      g.beginPath();
      g.moveTo(m.x - R, m.y + R * 0.5);
      g.quadraticCurveTo(m.x - R * 1.1, m.y - R * 0.6, m.x - R * 0.3, m.y - R * 0.9);
      g.quadraticCurveTo(m.x + R * 0.6, m.y - R * 1.1, m.x + R, m.y - R * 0.2);
      g.quadraticCurveTo(m.x + R * 1.1, m.y + R * 0.6, m.x + R * 0.4, m.y + R * 0.7);
      g.closePath();
      g.fill();
      g.strokeStyle = "rgba(10,8,6,0.8)";
      g.stroke();
      g.save();
      g.globalCompositeOperation = "lighter";
      const rim = g.createLinearGradient(m.x, m.y - R * 0.2, m.x, m.y + R * 0.7);
      rim.addColorStop(0, "rgba(255,90,20,0)");
      rim.addColorStop(1, `rgba(255,110,30,${hit ? 0.9 : 0.5})`);
      g.fillStyle = rim;
      g.fillRect(m.x - R, m.y - R * 0.2, R * 2, R * 0.9);
      g.restore();
    });
  }
  LEVELS.push({
    id: "ferry",
    name: "The Ember Ferry",
    tags: "co-op · two players · lava river",
    blurb: "A two-player level: the knight rides the ferry (cube 5) across the lava river while a second human slides that cube by hand round the rocks and between the geysers. (Solo setting: the ferry sails itself.)",
    story: "A river of lava between the docks, and a ferry that has no ferryman. Player 2 is the ferryman: slide cube 5 across by hand, round the grey rocks (a bump hurts the knight) and clear of the geysers, while the knight stands on it and shields itself from the archers on the far bank.",
    intro: "All aboard: Player 2 slides the ferry (cube 5)",
    cubes: [
      { tag: 4, at: [1.5, 0], label: "Near dock" },
      { tag: 5, at: [3.1, 0], label: "THE FERRY (Player 2 moves it)", soloSkip: true },
      { tag: 3, at: [9.7, 0], stack: 0, label: "Far dock" },
      { tag: 2, at: [9.7, 0], stack: 1, onTag: 3, label: "Dock top" },
      { tag: 0, at: [9.7, -3.3], label: "Archer's perch" },
      { tag: 1, at: [9.7, 3.3], label: "Archer's perch" },
    ],
    spawn: { at: [0, 0], yaw: 0 },
    skins: { 0: "basalt", 1: "basalt", 2: "stone", 3: "stone", 4: "stone", 5: null },
    frameSkin: "stone",
    floor: "lava",
    area: [2.3, -5.5, 9.0, 5.5],
    init(L) {
      L.lava([2.3, -5.5, 9.0, 5.5]);
      L.geyser([5.6, 0.3], { phase: 0.0 });
      L.geyser([6.9, 0.1], { phase: 2.3 });
      if (L.api.cfg.solo) L.E.geysers.forEach((g) => (g.harmless = true)); // (alone, the geysers only flare)
      L.flag("ferry", [LANE[0][0], LANE[0][1]]);
      L.flag("s", 0);
      L.flag("cool", 0);
      L.flag("hits", 0);
      // (they only see the ferry once it's most of the way over, and take their time)
      L.enemy("archer", [0, 0], { perch: 0, yawDeg: 180, sight: 0.34, reloadK: 1.5 });
      L.enemy("archer", [0, 0], { perch: 1, yawDeg: 180, sight: 0.34, reloadK: 1.5 });
      L.pickup("feather", null, { tag: 2, lift: 0.01, size: 1.5, name: "feather", onTake: (L2) => L2.win(L2.flag("hits") ? "The Phoenix Feather is yours" : "The Phoenix Feather -- and not a scratch on the ferry!") });
      L.pickup("heart", [1.5, 2.6]);
      L.brazier([1.2, 3.8]);
      L.brazier([1.2, -3.8]);
      L.brazier([10.8, 0]);
    },
    solids(L) {
      const p = L.flag("ferry");
      if (!L.api.cfg.solo || !p) return [];
      const l = L.f(p[0], p[1]);
      return [{ id: "ferry", cf: l.f, cr: l.r, yaw: L.api.w.anchor().th, half: L.U / 2, h0: 0, h1: L.U, virtual: true, tag: -2 }];
    },
    update(L, dt) {
      const solo = L.api.cfg.solo;
      const on = L.heroOn() === 5 || (solo && L.api.hero.standOn === "ferry");
      if (solo && on) {
        L.flag("s", Math.min(LANE_LEN, L.flag("s") + 0.3 * dt));
        const q = laneAt(L.flag("s"));
        L.flag("ferry", q);
      }
      // the rocks
      const fp = ferryPos(L);
      L.flag("cool", Math.max(0, L.flag("cool") - dt));
      if (fp) {
        ROCKS.forEach((rk) => {
          const dx = Math.max(0, Math.abs(fp.x - rk[0]) - 0.5);
          const dy = Math.max(0, Math.abs(fp.y - rk[1]) - 0.5);
          if (Math.hypot(dx, dy) < 0.35 && L.flag("cool") <= 0) {
            L.flag("cool", 2);
            L.flag("hits", L.flag("hits") + 1);
            L.sfx("crate");
            L.shake(0.7);
            L.say("The ferry grinds on a rock!", "#ff9070");
            if (on) L.hurt(1, L.api.hero.f, L.api.hero.r, { unblockable: true });
          }
        });
      }
    },
    drawFloor(L) {
      const U = L.U;
      const banks = [[-2.6, -5.5, 2.3, 5.5], [9.0, -5.5, 11.6, 5.5]];
      banks.forEach((b) => L.fx.patch("darkflag", { f0: b[0] * U, f1: b[2] * U, r0: b[1] * U, r1: b[3] * U }, 0, { world: true, tile: 0.14, alpha: 0.9 }));
    },
    draw(L) {
      const { w } = L;
      const t = L.clock();
      const g = L.api.ar.ctx;
      const lane = [];
      for (let s = 0; s <= LANE_LEN; s += 0.25) lane.push(laneAt(s));
      const pts = lane.map((p) => {
        const l = L.f(p[0], p[1]);
        return [l.f, l.r, 0.003];
      });
      const m = w.project(...pts[Math.floor(pts.length / 2)]);
      if (m) {
        L.api.ar.queue(m.depth + 0.3, () => {
          g.save();
          g.setLineDash([6, 10]);
          g.globalCompositeOperation = "lighter";
          w.line3(pts, "rgba(120,220,255,0.35)", 2, 0.03);
          g.restore();
        });
      }
      ROCKS.forEach((rk) => drawRock(L, rk, L.flag("cool") > 1.6));
      // the mooring mark
      const end = L.f(LANE[LANE.length - 1][0], LANE[LANE.length - 1][1]);
      L.fx.ring(end.f, end.r, 0.003, L.U * 0.55, `rgba(120,220,255,${0.4 + 0.2 * Math.sin(t * 3)})`, 2);
      if (L.api.cfg.solo && L.flag("ferry")) {
        const p = L.flag("ferry");
        const l = L.f(p[0], p[1]);
        const mm = w.project(l.f, l.r, L.U * 0.5);
        if (mm) L.api.ar.queue(mm.depth, () => drawBoat(L, l.f, l.r, L.U, L.api.w.anchor().th), w.extent(l.f - L.U / 2, l.f + L.U / 2, l.r - L.U / 2, l.r + L.U / 2, 0, L.U));
      }
    },
    blockOver(L, b) {
      if (b.tag === 5 && !L.api.cfg.solo) drawBoat(L, b.cf, b.cr, b.h1, b.yaw);
    },
    objective(L) {
      const on = L.heroOn() === 5 || (L.api.cfg.solo && L.api.hero.standOn === "ferry");
      const fp = ferryPos(L);
      if (!on) {
        if (L.cube(2) && L.heroOn() === 2) return { text: "Take the Phoenix Feather" };
        const far = L.heroU()[0] > 9;
        if (far) return { text: "Take the Phoenix Feather from the top of the far dock", at: [9.7, 0], h: 0.1 };
        return { text: L.api.cfg.solo ? "Board the ferry -- it sails when you stand on it" : "Hop aboard the ferry (cube 5). Player 2: slide it along the blue lane, round the rocks", at: fp ? [fp.x, fp.y] : [3.1, 0], h: 0.07 };
      }
      return { text: L.api.cfg.solo ? "Riding the ferry -- shield up against the archers!" : "Player 2: along the lane, clear of the rocks and the geysers! Knight: shield up!", at: [9.7, 0], h: 0.1 };
    },
  });

  // ================================================================================================
  // 7. The Bone Warden -- everything at once
  // ================================================================================================
  LEVELS.push({
    id: "warden",
    name: "The Bone Warden",
    tags: "boss · sword · shield · bombs · kegs",
    blurb: "The finale. A giant in bone and iron: its armor turns the sword until a blast cracks it. Jump its shockwaves, parry its sweep, drag the powder kegs (cubes 4, 5) by hand to where it walks, and take the crown on the altar.",
    story: "The Warden has stood here since the temple was built. Its slam sends a ring along the floor -- jump it, or stand on a block. Its sweep can be parried. Its armor is only cracked by a blast: bombs, or a powder keg you move into its path -- then strike hard before the bones knit again.",
    intro: "The Bone Warden wakes -- jump the shockwaves, crack its armor with a blast",
    bombs: 4,
    cubes: [
      { tag: 0, at: [3.4, -2.8], label: "Pillar" },
      { tag: 1, at: [3.4, 2.8], label: "Pillar" },
      { tag: 2, at: [5.8, -1.4], label: "Pillar" },
      { tag: 3, at: [5.8, 1.4], label: "Pillar" },
      { tag: 4, at: [1.4, -4.0], label: "Powder keg" },
      { tag: 5, at: [1.4, 4.0], label: "Powder keg" },
    ],
    spawn: { at: [1.2, 0], yaw: 0 },
    skins: { 0: "stone", 1: "stone", 2: "stone", 3: "stone", 4: "crate", 5: "crate" },
    frameSkin: "ivory",
    floor: "flags",
    floorTex: "darkflag",
    area: [-1.8, -6, 12, 6],
    init(L) {
      L.keg({ tag: 4 });
      L.keg({ tag: 5 });
      L.brazier([1.0, 2.4]);
      L.brazier([1.0, -2.4]);
      L.brazier([11.2, 4.4]);
      L.brazier([11.2, -4.4]);
      L.pickup("bomb", [2.0, 1.6]);
      L.pickup("bomb", [2.0, -1.6]);
      L.pickup("heart", [3.0, 0.0]);
      L.flag("boss", L.enemy("warden", [9.4, 0], { dormant: true, yawDeg: 180 }));
      L.flag("relic", L.pickup("crown", null, { tag: "frame", lift: 0.008, size: 1.5, hidden: true, onTake: (L2) => L2.win("The Warden is bones, and the crown is yours") }));
      L.flag("summon", 0);
    },
    onBlast(L) {
      L.A.wakeAll();
    },
    update(L) {
      const boss = L.flag("boss");
      if (boss.dormant && L.heroU()[0] > 2.6) L.A.wake(boss);
      if (boss.state !== "dead") {
        const f = boss.hp / boss.maxHp;
        const n = L.flag("summon");
        if ((n === 0 && f < 0.7) || (n === 1 && f < 0.35)) {
          L.flag("summon", n + 1);
          const b = L.units(boss.f, boss.r);
          L.enemy("skeleton", [b[0] - 1.0, b[1] - 1.6]);
          L.enemy("skeleton", [b[0] - 1.0, b[1] + 1.6]);
          L.say("The Warden calls its dead!", "#ff9070");
          L.sfx("growl");
          L.pickup("bomb", [4.5, 0]);
        }
      } else if (!L.flag("clear")) {
        L.flag("clear", true);
        L.flag("relic").hidden = false;
        L.A.enemies.forEach((e) => e.state !== "dead" && L.A.damage(e, 99, { from: [boss.f, boss.r], blast: true }));
        L.say("The Warden falls -- take the crown from the altar", "#ffe080");
        L.sfx("power");
      }
    },
    hud(L) {
      const boss = L.flag("boss");
      if (!boss || boss.dormant || boss.state === "dead") return;
      const v = L.api.ar.view;
      const g = L.api.ar.ctx;
      const wd = Math.min(360, v.w * 0.5);
      const x = v.cx - wd / 2;
      const y = v.y + 70;
      g.save();
      g.fillStyle = "rgba(0,0,0,0.6)";
      g.fillRect(x - 3, y - 3, wd + 6, 14);
      const k = Math.max(0, boss.hp / boss.maxHp);
      g.fillStyle = boss.armor ? "#8a8f9a" : "#c03a2a";
      g.fillRect(x, y, wd * k, 8);
      g.strokeStyle = boss.armor ? "rgba(220,225,240,0.9)" : "rgba(255,160,140,0.8)";
      g.strokeRect(x, y, wd, 8);
      g.restore();
      L.api.ar.text(boss.armor ? "THE BONE WARDEN -- armored" : "THE BONE WARDEN -- armor cracked!", v.cx, y + 28, { size: 13, align: "center", color: boss.armor ? "#d8dce8" : "#ffb090" });
    },
    objective(L) {
      const boss = L.flag("boss");
      if (L.flag("clear")) return { text: "Climb the altar and take the crown", at: [0, 0], h: 0.07 };
      if (boss.dormant) return { text: "The Warden sleeps -- bombs: B sets, E detonates. Kegs: carry them by hand where it will walk" };
      return { text: boss.armor ? "Its armor turns the sword: a blast cracks it (bomb, keg) -- jump the shockwaves!" : "Armor cracked -- strike!" };
    },
  });

  Lynx.blockQuestLevels = LEVELS;
})(window.Lynx);
