// Block Quest's fighters and weapons (see game_blockquest.js): enemies that
// wind up before they strike (so a shield can meet the blow), arrows that
// fly and stick in real blocks, bombs set by hand and set off from a
// distance, powder kegs, blasts that the real blocks give cover from.
//
//   const A = Lynx.bqActors(cx);   cx: {api, fx, hero, G, hurtHero, say, sfx, addScore, ...}
//   A.enemies, A.arrows, A.bombs, A.kegs: lists; A.spawn(kind, f, r, opts); A.update(dt); A.draw()
//   A.damage(e, n, o), A.blast(f, r, z, radius, dmg, o), A.placeBomb(), A.detonate()
//   A.rayBlocked([f, r, z], [f, r, z]) -> a solid in the way, or null
//
// Everything is in the floor frame (f forward, r right, z up, meters) at the
// knight's scale: a stride, a swing and a fuse take as long as a person's,
// distances are the knight's 3 cm.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  Lynx.bqActors = (cx) => {
    const { api, fx, hero, G } = cx;
    const { ar, w, K, C, S } = api;
    const { clamp, lerp, ease, wrap } = api.util;
    const BODY = C.BODY_H;
    const STEP = C.STEP_UP;

    const SK = K.SKELETON_LOOK;
    const LOOKS = {
      skeleton: SK,
      hoplite: { ...SK, bone: "#d6cfb6", eye: "#ff8a30", blade: "#b8b090" },
      archer: { ...SK, bone: "#c4bc9e", eye: "#ffb040" },
      brute: K.BRUTE_LOOK,
      warden: { ...K.BRUTE_LOOK, armor: "#2c2f38", trim: "#a07a28", eye: "#ff3a10", horn: "#cfc6a8", bone: "#bdb394" },
    };
    // Pocket Knight's numbers (7 cm knight), here scaled to the knight's size: lengths x S, times as they are
    const DEFS = {
      skeleton: { hp: 3, speed: 0.07 * S, windup: 0.6, strike: 0.14, recover: 0.8, reach: 0.034 * S, scale: 1, sight: 0.7, score: 100, dmg: 1 },
      hoplite: { hp: 4, speed: 0.06 * S, windup: 0.8, strike: 0.14, recover: 0.95, reach: 0.034 * S, scale: 1.05, sight: 0.7, score: 150, dmg: 1, guard: true },
      archer: { hp: 2, speed: 0.04 * S, windup: 1.0, strike: 0.2, recover: 2.2, reach: 0.034 * S, scale: 1, sight: 0.9, score: 150, dmg: 1, ranged: true },
      brute: { hp: 7, speed: 0.05 * S, windup: 0.95, strike: 0.2, recover: 1.0, reach: 0.046 * S, scale: 1.3, sight: 0.8, score: 400, dmg: 2, armored: true },
      warden: { hp: 16, speed: 0.045 * S, windup: 1.2, strike: 0.25, recover: 1.3, reach: 0.06 * S, scale: 2.5, sight: 1.5, score: 3000, dmg: 2, armored: true, boss: true },
    };
    const A = { enemies: [], arrows: [], bombs: [], kegs: [], blasts: [], rings: [], defs: DEFS };
    let uid = 1;

    // -- line of sight / cover through the blocks (real and virtual) -----------------------------
    function rayBlocked(a, b, o = {}) {
      for (const s of api.solids) {
        if (o.skip && o.skip(s)) continue;
        const [ua, va] = api.toB(s, a[0], a[1]);
        const [ub, vb] = api.toB(s, b[0], b[1]);
        const lo = [-s.half, -s.half, s.h0];
        const hi = [s.half, s.half, s.h1];
        const P = [ua, va, a[2]];
        const Q = [ub, vb, b[2]];
        let t0 = 0;
        let t1 = 1;
        let miss = false;
        for (let i = 0; i < 3 && !miss; i++) {
          const d = Q[i] - P[i];
          if (Math.abs(d) < 1e-9) {
            if (P[i] < lo[i] || P[i] > hi[i]) miss = true;
            continue;
          }
          let ta = (lo[i] - P[i]) / d;
          let tb = (hi[i] - P[i]) / d;
          if (ta > tb) [ta, tb] = [tb, ta];
          t0 = Math.max(t0, ta);
          t1 = Math.min(t1, tb);
          if (t0 > t1) miss = true;
        }
        if (!miss) return s;
      }
      return null;
    }
    A.rayBlocked = rayBlocked;

    // can a walker stand at (f, r) at height z? (not inside a block it would have to climb)
    function blockedAt(f, r, z, rad, self) {
      for (const b of api.solids) {
        if (b === self || b.h1 <= z + STEP || b.h0 >= z + BODY * 0.9) continue;
        const [u, v] = api.toB(b, f, r);
        if (Math.abs(u) < b.half + rad && Math.abs(v) < b.half + rad) return true;
      }
      return false;
    }
    function pushOut(e) {
      for (const b of api.solids) {
        if (b.h1 <= e.z + STEP || b.h0 >= e.z + BODY * 0.9) continue;
        const [u, v] = api.toB(b, e.f, e.r);
        const m = b.half + e.rad;
        if (Math.abs(u) >= m || Math.abs(v) >= m) continue;
        const pen = [[m - u, 1, 0], [m + u, -1, 0], [m - v, 0, 1], [m + v, 0, -1]].sort((x, y) => x[0] - y[0]);
        const [d, nu, nv] = pen[0];
        [e.f, e.r] = api.fromB(b, u + nu * d, v + nv * d);
        e.bumped = 0.3;
      }
    }
    const groundOf = (f, r, z) => api.groundAt(f, r, z + STEP * 2, STEP).h;

    // -- enemies -------------------------------------------------------------------------------------------
    // opts: {dormant (waits for L.wake / being seen), perch (a block's tag: stands on it), yaw, hpK, drop, tag (a name), home}
    function spawn(kind, f, r, o = {}) {
      const def = DEFS[kind];
      const D = G.diff;
      const e = {
        id: uid++, kind, def, f, r, z: o.z || 0, yaw: o.yaw === undefined ? Math.PI : o.yaw, hp: Math.max(1, Math.round(def.hp * D.hp * (o.hpK || 1))),
        maxHp: 0, state: "idle", t: 0, deadT: 0, flash: 0, rad: 0.0085 * S * def.scale, speed: 0, phase: Math.random() * 6, vf: 0, vr: 0,
        dormant: !!o.dormant, perch: o.perch === undefined ? null : o.perch, drop: o.drop || null, name: o.name || null, cool: 0.5, side: Math.random() < 0.5 ? 1 : -1,
        sideT: 0, losT: 0, sees: false, sight: o.sight || def.sight, reloadK: o.reloadK || 1, lastKnown: null, armor: !!def.armored, guard: !!def.guard, staggerT: 0, hitDone: false, aimYaw: 0, bumped: 0, lostT: 0, shot: false,
        phaseN: 0,
      };
      e.maxHp = e.hp;
      if (e.perch !== null) followPerch(e);
      else e.z = groundOf(f, r, e.z);
      A.enemies.push(e);
      return e;
    }
    A.spawn = spawn;
    function followPerch(e) {
      const b = api.realSolids.find((s) => s.tag === e.perch);
      if (!b) {
        e.perch = null; // its block's gone: down it comes
        return;
      }
      e.f = b.cf;
      e.r = b.cr;
      e.z = b.h1;
    }
    const alive = (e) => e.state !== "dead";
    A.alive = () => A.enemies.filter(alive);
    A.wake = (e) => {
      if (e.dormant) {
        e.dormant = false;
        cx.sfx("growl");
      }
    };
    A.wakeAll = () => A.enemies.forEach(A.wake);

    function faceToward(e, f, r, rate, dt) {
      const want = Math.atan2(r - e.r, f - e.f);
      e.yaw = wrap(e.yaw + clamp(wrap(want - e.yaw), -rate * dt, rate * dt));
    }
    // walk toward a point, round what's in the way
    function walkToward(e, tf, tr, speed, dt) {
      const ang = Math.atan2(tr - e.r, tf - e.f);
      const step = Math.max(speed * dt * 4, e.rad * 1.5);
      let best = null;
      const order = e.sideT > 0 ? [0, 0.6 * e.side, -0.6 * e.side, 1.2 * e.side, -1.2 * e.side, 1.9 * e.side] : [0, 0.5, -0.5, 1.0, -1.0, 1.7, -1.7];
      for (const off of order) {
        const a = ang + off;
        if (!blockedAt(e.f + Math.cos(a) * step, e.r + Math.sin(a) * step, e.z, e.rad, null)) {
          best = a;
          if (off !== 0) {
            e.sideT = 0.7;
            e.side = Math.sign(off) || e.side;
          }
          break;
        }
      }
      if (best === null) return 0;
      e.yaw = wrap(e.yaw + clamp(wrap(best - e.yaw), -9 * dt, 9 * dt));
      const dist = Math.hypot(tf - e.f, tr - e.r);
      const v = Math.min(speed, dist / Math.max(dt, 1e-3));
      e.f += Math.cos(e.yaw) * v * dt;
      e.r += Math.sin(e.yaw) * v * dt;
      return v;
    }

    function updateEnemy(e, dt) {
      const d = e.def;
      const D = G.diff;
      e.t += dt;
      e.flash = Math.max(0, e.flash - dt);
      e.sideT = Math.max(0, e.sideT - dt);
      e.cool = Math.max(0, e.cool - dt);
      e.bumped = Math.max(0, e.bumped - dt);
      if (e.state === "dead") {
        e.deadT += dt;
        return;
      }
      if (e.perch !== null) followPerch(e);
      // knocked about
      if (Math.abs(e.vf) + Math.abs(e.vr) > 1e-5) {
        e.f += e.vf * dt;
        e.r += e.vr * dt;
        const k = Math.exp(-7 * dt);
        e.vf *= k;
        e.vr *= k;
      }
      const dx = hero.f - e.f;
      const dr = hero.r - e.r;
      const dist = Math.hypot(dx, dr);
      const dz = Math.abs(hero.z - e.z);
      e.losT -= dt;
      if (e.losT <= 0) {
        e.losT = 0.15;
        e.sees = G.heroAlive && dist < e.sight && !rayBlocked([e.f, e.r, e.z + BODY * 0.8 * d.scale], [hero.f, hero.r, hero.z + BODY * 0.6]);
      }
      if (e.sees) {
        e.lastKnown = [hero.f, hero.r];
        e.lostT = 0;
      } else e.lostT += dt;
      e.speed = 0;
      if (d.boss && !e.armor && e.state !== "dead") {
        e.armorT = (e.armorT || 0) + dt;
        if (e.armorT > 9) {
          e.armor = true;
          e.armorT = 0;
          cx.say("The Warden's bones knit new armor -- another blast!", "#ffd080");
        }
      }
      switch (e.state) {
        case "idle":
          if (!e.dormant && e.sees) {
            e.state = "chase";
            e.t = 0;
            cx.sfx("growl");
          }
          break;
        case "chase": {
          if (!G.heroAlive) {
            e.state = "idle";
            break;
          }
          if (d.ranged) {
            if (e.sees && e.cool <= 0) {
              e.state = "windup";
              e.t = 0;
              e.shot = false;
            } else if (e.sees) faceToward(e, hero.f, hero.r, 6, dt);
            else if (e.perch === null && e.lastKnown && e.lostT < 5) e.speed = walkToward(e, e.lastKnown[0], e.lastKnown[1], d.speed * D.speed, dt);
            break;
          }
          const tgt = e.sees ? [hero.f, hero.r] : e.lastKnown;
          if (!tgt) {
            e.state = "idle";
            break;
          }
          if (d.boss && e.sees && e.cool <= 0 && dist < 0.2) {
            // a sweep when you're in reach, else a slam that sends a shockwave along the floor
            e.slam = dist > d.reach * 0.95;
            e.state = "windup";
            e.t = 0;
            e.hitDone = false;
            break;
          }
          if (!d.boss && e.sees && dist <= d.reach * 0.92 && dz < BODY * 0.7 && e.cool <= 0) {
            e.state = "windup";
            e.t = 0;
            e.hitDone = false;
            break;
          }
          e.speed = walkToward(e, tgt[0], tgt[1], d.speed * D.speed, dt);
          if (!e.sees && e.lostT > 4 && Math.hypot(tgt[0] - e.f, tgt[1] - e.r) < 0.01) e.state = "idle";
          break;
        }
        case "windup": {
          const T = d.windup * D.windup;
          if (e.t < T * 0.65 || d.ranged) faceToward(e, hero.f, hero.r, d.ranged ? 6 : 7, dt);
          if (e.t >= T) {
            e.state = "strike";
            e.t = 0;
            e.hitDone = false;
            if (d.ranged) fireArrow(e);
          }
          break;
        }
        case "strike": {
          if (!d.ranged && !e.hitDone && e.t >= d.strike * 0.45) {
            e.hitDone = true;
            const near = Math.hypot(hero.f - e.f, hero.r - e.r) <= d.reach + 0.002 && Math.abs(hero.z - e.z) < BODY * 0.9;
            const ang = Math.abs(wrap(Math.atan2(hero.r - e.r, hero.f - e.f) - e.yaw));
            if (d.boss && e.slam) {
              slamRing(e);
            } else if (d.boss ? (Math.hypot(hero.f - e.f, hero.r - e.r) <= d.reach + 0.004 && ang < 1.4 && G.heroAlive) : near && ang < 1.15 && G.heroAlive) {
              const res = cx.hurtHero(d.dmg * (G.diff.dmg || 1), e.f, e.r, { kind: "melee", parryable: true, attacker: e });
              if (res.parried) stagger(e, 1.7);
            }
          }
          if (e.t >= d.strike) {
            e.state = "recover";
            e.t = 0;
          }
          break;
        }
        case "recover":
          if (e.t >= d.recover * (d.ranged ? e.reloadK : D.windup)) {
            e.state = "chase";
            e.t = 0;
            e.cool = d.ranged ? 0.2 : 0.35;
          }
          break;
        case "stagger":
          if (e.t >= e.staggerT) {
            e.state = "chase";
            e.t = 0;
            e.cool = 0.2;
          }
          break;
        default:
          break;
      }
      // crowding: not on top of each other
      A.enemies.forEach((o) => {
        if (o === e || o.state === "dead") return;
        const sf = e.f - o.f;
        const sr = e.r - o.r;
        const sd = Math.hypot(sf, sr);
        const m = (e.rad + o.rad) * 1.1;
        if (sd < m && sd > 1e-6 && e.perch === null) {
          const push = (m - sd) * 0.5;
          e.f += (sf / sd) * push;
          e.r += (sr / sd) * push;
        }
      });
      if (e.perch === null) {
        pushOut(e);
        e.z = groundOf(e.f, e.r, e.z);
      }
      e.phase += dt * 2 * Math.PI * (e.speed / (0.056 * S));
    }
    function stagger(e, t) {
      if (e.state === "dead") return;
      e.state = "stagger";
      e.t = 0;
      e.staggerT = t;
      e.guard = false;
      cx.sfx("knock");
      fx.parts.emit("spark", e.f, e.r, e.z + BODY * 0.6, 6, 0.004, { speed: 0.06 });
    }
    A.stagger = stagger;

    // hurt an enemy: n hits; o: {from: [f, r], blast, kind}. Returns whether it counted.
    function damage(e, n, o = {}) {
      if (e.state === "dead") return false;
      const def = e.def;
      const fromAng = o.from ? Math.atan2(o.from[1] - e.r, o.from[0] - e.f) : null;
      const front = fromAng === null ? false : Math.abs(wrap(fromAng - e.yaw)) < 1.2;
      // armor: only a blast opens it
      if (e.armor && !o.blast) {
        cx.sfx("knock");
        fx.parts.emit("spark", e.f, e.r, e.z + BODY * def.scale * 0.6, 8, 0.004, { speed: 0.07 });
        e.flash = 0.08;
        if (!e.armorNote) {
          e.armorNote = true;
          cx.say("Its armor turns the blade -- a blast would crack it", "#ffd080");
        }
        return false;
      }
      if (e.armor && o.blast) {
        e.armor = false;
        e.armorT = 0;
        cx.say(def.boss ? "The Warden's armor cracks!" : "The armor cracks open!", "#ffe080");
        stagger(e, def.boss ? 3.2 : 2.4);
      }
      // A raised shield turns away what comes from the front -- not while it
      // swings (its shield arm comes down: the parry-then-strike rhythm works
      // on it too), and the second blow on it knocks the shield aside.
      const guardFront = fromAng === null ? false : Math.abs(wrap(fromAng - e.yaw)) < 0.9;
      const swinging = e.state === "strike" || e.state === "recover";
      if (e.guard && guardFront && !o.blast && e.state !== "stagger" && !swinging) {
        cx.sfx("knock");
        fx.parts.emit("spark", e.f + Math.cos(e.yaw) * 0.006, e.r + Math.sin(e.yaw) * 0.006, e.z + BODY * 0.6, 8, 0.003, { speed: 0.07 });
        e.flash = 0.06;
        e.guardHits = (e.guardHits || 0) + 1;
        if (e.guardHits >= 2 && !e.def.boss) {
          e.guardHits = 0;
          stagger(e, 1.3);
          setTimeout(() => (e.guard = !!e.def.guard), 2500);
          cx.say("The shield is knocked aside -- strike now!", "#ffe080");
          return false;
        }
        if (!e.guardNote) {
          e.guardNote = true;
          cx.say("Its shield holds -- strike right after it swings, from the side, or hit the shield twice (a shield bash, Fire with yours raised, works too)", "#ffd080");
        }
        return false;
      }
      e.hp -= n;
      e.flash = 0.16;
      cx.sfx(e.hp > 0 ? "pain" : "die");
      fx.parts.emit("spark", e.f, e.r, e.z + BODY * def.scale * 0.6, 5, 0.004, { speed: 0.05 });
      if (o.from) {
        const a = Math.atan2(e.r - o.from[1], e.f - o.from[0]);
        const k = (o.blast ? 0.16 : 0.06) * (def.boss ? 0.2 : 1) / def.scale;
        e.vf += Math.cos(a) * k;
        e.vr += Math.sin(a) * k;
      }
      if (e.hp <= 0) {
        e.state = "dead";
        e.deadT = 0;
        e.t = 0;
        cx.addScore(def.score);
        G.stats.kills++;
        if (e.drop) cx.dropPickup(e.drop, e.f, e.r, e.z);
        for (let i = 0; i < 9; i++) fx.parts.emit("debris", e.f, e.r, e.z + BODY * 0.5, 1, 0.006, { speed: 0.05, up: 0.06 });
        fx.parts.emit("dust", e.f, e.r, e.z + 0.004, 4, 0.006, { speed: 0.01, up: 0.01 });
        if (cx.onKill) cx.onKill(e);
      } else if (!def.boss) {
        if (e.state !== "windup" || e.t < 0.2) {
          e.state = "stagger";
          e.t = 0;
          e.staggerT = o.blast ? 1.4 : 0.28;
        }
      }
      return true;
    }
    A.damage = damage;

    // -- arrows ---------------------------------------------------------------------------------------------------
    function fireArrow(e) {
      const sp = 0.115 * G.diff.speed;
      const from = [e.f + Math.cos(e.yaw) * 0.008, e.r + Math.sin(e.yaw) * 0.008, e.z + BODY * 0.72];
      const to = [hero.f, hero.r, hero.z + BODY * 0.5];
      const d = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) || 1;
      A.arrows.push({ f: from[0], r: from[1], z: from[2], vf: ((to[0] - from[0]) / d) * sp, vr: ((to[1] - from[1]) / d) * sp, vz: ((to[2] - from[2]) / d) * sp, t: 0, stuck: false, owner: e });
      cx.sfx("swing");
    }
    function updateArrows(dt) {
      for (let i = A.arrows.length - 1; i >= 0; i--) {
        const a = A.arrows[i];
        a.t += dt;
        if (a.stuck) {
          if (a.t - a.stuckAt > 2.5) A.arrows.splice(i, 1);
          continue;
        }
        const n0 = [a.f, a.r, a.z];
        a.f += a.vf * dt;
        a.r += a.vr * dt;
        a.z += a.vz * dt;
        const hitBlock = rayBlocked(n0, [a.f, a.r, a.z]);
        if (hitBlock || a.z < 0 || a.t > 8) {
          a.stuck = true;
          a.stuckAt = a.t;
          a.vf = a.vr = a.vz = 0;
          if (hitBlock) cx.sfx("knock");
          continue;
        }
        if (G.heroAlive && Math.hypot(hero.f - a.f, hero.r - a.r) < 0.0075 && a.z > hero.z - 0.002 && a.z < hero.z + BODY) {
          const res = cx.hurtHero(1 * (G.diff.dmg || 1), a.f - a.vf, a.r - a.vr, { kind: "arrow", parryable: true });
          A.arrows.splice(i, 1);
          if (res.blocked) fx.parts.emit("spark", a.f, a.r, a.z, 4, 0.003, { speed: 0.05 });
        }
      }
    }

    // -- bombs and kegs -----------------------------------------------------------------------------------------
    const BOMB_R = 0.8; // blast radius in the knight's heights... see blastRadius
    const blastRadius = () => BODY * 1.45;
    A.blastRadius = blastRadius;
    A.placeBomb = () => {
      if (G.bombs <= 0) {
        cx.say("No bombs left", "#ff9070");
        return false;
      }
      if (A.bombs.filter((b) => !b.fuse).length >= 3) {
        cx.say("Three bombs are set already -- detonate (E / LB)", "#ffd080");
        return false;
      }
      const f = hero.f + Math.cos(hero.yaw) * 0.009;
      const r = hero.r + Math.sin(hero.yaw) * 0.009;
      const z = groundOf(f, r, hero.z);
      A.bombs.push({ f, r, z: Math.min(z, hero.z + STEP), t: 0, fuse: 0, blink: Math.random() });
      G.bombs--;
      G.stats.bombs++;
      cx.sfx("click");
      return true;
    };
    A.detonate = () => {
      const armed = A.bombs.filter((b) => !b.fuse);
      if (!armed.length) {
        cx.say("No bomb to set off", "#ffd080");
        return false;
      }
      armed.forEach((b, i) => (b.fuse = 0.08 + i * 0.16));
      cx.sfx("zap");
      return true;
    };
    function explodeBomb(b) {
      A.blast(b.f, b.r, b.z, blastRadius(), 4, { source: "bomb" });
    }
    // a blast: damages whatever is in reach and not covered by a block between
    A.blast = (f, r, z, radius, dmg, o = {}) => {
      A.blasts.push({ f, r, z, rad: radius * 1.25, t: 0 });
      cx.sfx("explode");
      fx.parts.emit("spark", f, r, z + 0.004, 16, 0.004, { speed: 0.14, up: 0.1 });
      fx.parts.emit("debris", f, r, z + 0.003, 10, 0.004, { speed: 0.08, up: 0.1 });
      fx.parts.emit("smoke", f, r, z + 0.006, 7, 0.006, { speed: 0.02, up: 0.03 });
      cx.shake(0.5);
      const cover = (tf, tr, tz) => !!rayBlocked([f, r, z + 0.004], [tf, tr, tz], { skip: (s) => s.noCover });
      A.enemies.forEach((e) => {
        if (e.state === "dead") return;
        const d = Math.hypot(e.f - f, e.r - r);
        if (d > radius + e.rad) return;
        if (cover(e.f, e.r, e.z + BODY * 0.4 * e.def.scale)) return;
        damage(e, dmg * (1 - 0.45 * clamp(d / radius, 0, 1)), { blast: true, from: [f, r] });
      });
      if (G.heroAlive && !o.sparesHero) {
        const d = Math.hypot(hero.f - f, hero.r - r);
        if (d < radius * 1.05 && Math.abs(hero.z - z) < BODY * 2 && !cover(hero.f, hero.r, hero.z + BODY * 0.4)) {
          cx.hurtHero(2, f, r, { kind: "blast", energy: 0.6 });
        }
      }
      A.kegs.forEach((k) => {
        if (k.state === "idle" && Math.hypot(k.f - f, k.r - r) < radius + k.rad && !cover(k.f, k.r, k.z + 0.01)) light(k, 0.25);
      });
      if (cx.onBlast) cx.onBlast(f, r, z, radius, o);
    };
    // powder kegs: stand on a block (tag) or a spot; a blow or a blast sets them off
    A.addKeg = (o) => {
      const k = { f: o.f || 0, r: o.r || 0, z: 0, tag: o.tag === undefined ? null : o.tag, rad: 0.009 * S * 1.6, height: o.height || 0.026, state: "idle", fuse: 0, id: uid++, burnt: 0 };
      A.kegs.push(k);
      follow(k);
      return k;
    };
    function follow(k) {
      if (k.tag === null) return;
      const b = api.realSolids.find((s) => s.tag === k.tag);
      if (b) {
        k.f = b.cf;
        k.r = b.cr;
        k.z = b.h1;
        k.yaw = b.yaw;
        k.missing = false;
      } else k.missing = true;
    }
    function light(k, delay = 0.35) {
      if (k.state !== "idle") return;
      k.state = "fuse";
      k.fuse = delay;
      cx.sfx("click");
    }
    A.lightKeg = light;
    A.kegPower = 5;
    function kegBoom(k) {
      k.state = "gone";
      k.burnt = 1;
      A.blast(k.f, k.r, k.z, blastRadius() * 2.1, A.kegPower, { source: "keg" });
      if (cx.onKeg) cx.onKeg(k);
    }

    // a boss's slam: a shockwave along the floor (jump it, or stand on a block)
    function slamRing(e) {
      A.rings.push({ f: e.f + Math.cos(e.yaw) * e.def.reach * 0.6, r: e.r + Math.sin(e.yaw) * e.def.reach * 0.6, rad: 0.004, t: 0, hit: false, max: 0.2, speed: 0.1 });
      cx.sfx("crate");
      cx.shake(0.7);
      fx.parts.emit("dust", e.f + Math.cos(e.yaw) * 0.04, e.r + Math.sin(e.yaw) * 0.04, 0.002, 10, 0.02, { speed: 0.03, up: 0.02 });
    }
    A.slamRing = slamRing;
    function updateRings(dt) {
      for (let i = A.rings.length - 1; i >= 0; i--) {
        const g = A.rings[i];
        g.t += dt;
        g.rad += g.speed * dt;
        if (g.rad > g.max) {
          A.rings.splice(i, 1);
          continue;
        }
        if (!g.hit && G.heroAlive) {
          const d = Math.hypot(hero.f - g.f, hero.r - g.r);
          if (Math.abs(d - g.rad) < 0.006 && hero.z < 0.006 + (api.groundAt(hero.f, hero.r, hero.z + STEP, STEP).h) && hero.onGround) {
            g.hit = true;
            cx.hurtHero(1, g.f, g.r, { kind: "shock", unblockable: false, energy: 0.35 });
          }
        }
      }
    }

    // -- update ------------------------------------------------------------------------------------------------------
    A.update = (dt) => {
      A.enemies.forEach((e) => updateEnemy(e, dt));
      updateArrows(dt);
      updateRings(dt);
      for (let i = A.bombs.length - 1; i >= 0; i--) {
        const b = A.bombs[i];
        b.t += dt;
        if (b.fuse) {
          b.fuse -= dt;
          if (b.fuse <= 0) {
            explodeBomb(b);
            A.bombs.splice(i, 1);
          }
        }
      }
      A.kegs.forEach((k) => {
        follow(k);
        if (k.state === "fuse") {
          k.fuse -= dt;
          if (Math.random() < dt * 40) fx.parts.emit("spark", k.f, k.r, k.z + k.height, 1, 0.003, { speed: 0.04 });
          if (k.fuse <= 0) kegBoom(k);
        }
      });
      for (let i = A.blasts.length - 1; i >= 0; i--) {
        A.blasts[i].t += dt;
        if (A.blasts[i].t > 1.1) A.blasts.splice(i, 1);
      }
      // dead enemies lie a while
      for (let i = A.enemies.length - 1; i >= 0; i--) if (A.enemies[i].state === "dead" && A.enemies[i].deadT > 3.2) A.enemies.splice(i, 1);
    };

    // the knight's sword (and shield bash) against the fighters and kegs
    A.swordHit = (att, hitWindow, power) => {
      const reach = 0.032 * S;
      const out = [];
      A.enemies.forEach((e) => {
        if (e.state === "dead" || att.hits.has(e)) return;
        const d = Math.hypot(e.f - hero.f, e.r - hero.r);
        if (d > reach + e.rad * 1.2 + (e.def.boss ? 0.02 : 0)) return;
        if (Math.abs(e.z - hero.z) > BODY * (e.def.boss ? 1.4 : 0.9)) return;
        if (Math.abs(wrap(Math.atan2(e.r - hero.r, e.f - hero.f) - hero.yaw)) > 1.25) return;
        att.hits.add(e);
        out.push(damage(e, power, { from: [hero.f, hero.r], kind: "sword" }));
      });
      A.kegs.forEach((k) => {
        if (k.state !== "idle" || att.hits.has(k)) return;
        const d = Math.hypot(k.f - hero.f, k.r - hero.r);
        if (d > reach + k.rad && !(d < reach + 0.03 && Math.abs(wrap(Math.atan2(k.r - hero.r, k.f - hero.f) - hero.yaw)) < 0.6)) return;
        if (Math.abs(k.z - hero.z) > BODY) return;
        att.hits.add(k);
        light(k, 0.55);
        cx.say("The keg's fuse is lit -- run!", "#ff9060");
      });
      return out;
    };
    A.bash = () => {
      const reach = 0.026 * S + 0.006;
      A.enemies.forEach((e) => {
        if (e.state === "dead") return;
        const d = Math.hypot(e.f - hero.f, e.r - hero.r);
        if (d > reach + e.rad || Math.abs(wrap(Math.atan2(e.r - hero.r, e.f - hero.f) - hero.yaw)) > 1.0) return;
        if (e.def.boss) return;
        stagger(e, e.guard || e.def.guard ? 1.6 : 0.9);
        e.guard = false;
        const a = Math.atan2(e.r - hero.r, e.f - hero.f);
        e.vf += Math.cos(a) * 0.08;
        e.vr += Math.sin(a) * 0.08;
        cx.sfx("crate");
        setTimeout(() => {
          e.guard = !!e.def.guard;
        }, 2500);
      });
    };

    // -- drawing -----------------------------------------------------------------------------------------------------
    const CLANG = [[0, "rgba(255,255,255,0.95)"], [0.4, "rgba(255,120,80,0.6)"], [1, "rgba(255,60,0,0)"]];
    // The body's joints for an enemy's state (Pocket Knight's skeleton, at its own size)
    function enemyJoints(e, time, photo) {
      const d = e.def;
      const D = G.diff;
      const T = d.windup * D.windup;
      const windT = e.state === "windup" && !d.ranged ? clamp(e.t / T, 0, 1) : 0;
      const anim = {
        time: time + e.id * 10, speed: e.speed / S, phase: e.phase, air: null, land: 0, hang: false, climb: null,
        attack: e.state === "strike" && !d.ranged ? { n: 3, u: lerp(0.35, 0.62, clamp(e.t / d.strike, 0, 1)) } : e.state === "recover" && !d.ranged ? { n: 3, u: lerp(0.62, 1, clamp(e.t / d.recover, 0, 1)) } : null,
        hurt: e.state === "stagger" ? clamp(1 - e.t / Math.max(0.2, Math.min(e.staggerT, 0.5)), 0, 1) : 0, dead: photo && e.state === "dead" ? clamp(e.deadT / 0.7, 0, 1) : 0, brace: windT, armed: true,
      };
      const J = K.bodyJoints(anim);
      if (d.ranged) {
        // arms up: drawing a bow
        const draw = e.state === "windup" ? clamp(e.t / T, 0, 1) : 0;
        J.hand[1] = [0.02 - 0.012 * draw, 0.004, J.chest[2] + 0.002];
        J.hand[-1] = [0.026, -0.004, J.chest[2] + 0.002];
        J.elbow[1] = [0.006, 0.014, J.chest[2] - 0.004];
        J.elbow[-1] = [0.014, -0.012, J.chest[2] - 0.002];
        J.swordDir = null;
      }
      if (photo && d.guard) {
        // a hoplite keeps his shield up in front
        const c = [0.0150, -0.0040, J.chest[2] + 0.0006];
        J.hand[-1] = [c[0] - 0.002, c[1] - 0.004, c[2] - 0.002];
        J.elbow[-1] = [(J.sh[-1][0] + c[0]) / 2 - 0.002, (J.sh[-1][1] + c[1]) / 2 - 0.006, (J.sh[-1][2] + c[2]) / 2 - 0.005];
      }
      return { J, windT, T };
    }
    function enemyPrims(e, time) {
      const d = e.def;
      const sc = d.scale;
      const { J, windT, T } = enemyJoints(e, time, false);
      let P = K.placer(e.f, e.r, e.z, e.yaw, S * sc);
      if (e.state === "dead") {
        const k = ease(e.deadT / 0.6);
        const base = P;
        P = (v) => base([v[0] * (1 + k * 0.6), v[1] * (1 + k * 0.6), v[2] * (1 - 0.9 * k)]);
      }
      const look = LOOKS[e.kind];
      const prims = K.skeletonPrims(J, P, look, { angry: e.state !== "idle" && e.state !== "dead" });
      prims.forEach((p) => p.rad && (p.rad *= S * sc));
      if (e.kind === "hoplite" || e.kind === "warden") {
        const c = [0.014, -0.004, J.chest[2] + 0.002];
        const sh = (dy, dz) => P([c[0], c[1] + dy * (e.kind === "warden" ? 1.2 : 1), c[2] + dz * (e.kind === "warden" ? 1.2 : 1)]);
        const rim = [];
        for (let k = 0; k < 12; k++) rim.push(sh(0.011 * Math.cos((k / 12) * 2 * Math.PI), 0.012 * Math.sin((k / 12) * 2 * Math.PI)));
        prims.push({ k: "poly", pts: rim, color: e.guard === false ? "#7a5a28" : "#a8782e", lines: [[sh(-0.011, 0), sh(0.011, 0)], [sh(0, -0.012), sh(0, 0.012)]], lineColor: "rgba(60,36,10,0.7)" });
        prims.push({ k: "ball", c: sh(0, 0), rad: 0.0026 * S * sc * 0.4, color: "#d8b050" });
      }
      if (d.ranged) {
        const bow = [];
        for (let k = 0; k <= 6; k++) {
          const t = (k / 6) * 2 - 1;
          bow.push(P([0.026 + 0.004 * (1 - t * t) * 0, -0.004 + 0.017 * t * 0, J.chest[2] + 0.002 + 0.016 * t]));
        }
        for (let k = 0; k < 6; k++) prims.push({ k: "seg", a: bow[k], b: bow[k + 1], rad: 0.0007 * S * sc, color: "#6a4a28" });
        const draw = e.state === "windup" ? clamp(e.t / T, 0, 1) : 0;
        const nock = P([0.02 - 0.012 * draw, 0.004, J.chest[2] + 0.002]);
        prims.push({ k: "seg", a: bow[0], b: nock, rad: 0.00025 * S * sc, color: "#d8d0c0" });
        prims.push({ k: "seg", a: nock, b: bow[6], rad: 0.00025 * S * sc, color: "#d8d0c0" });
        if (e.state === "windup") prims.push({ k: "seg", a: nock, b: P([0.034, 0.004, J.chest[2] + 0.002]), rad: 0.0004 * S * sc, color: "#b8b0a0" });
      }
      return { prims, J, P, windT, look };
    }
    const windT0 = (e) => (e.state === "windup" && !e.def.ranged ? clamp(e.t / (e.def.windup * G.diff.windup), 0, 1) : 0);
    function drawEnemy(e, time) {
      const sc = e.def.scale;
      if (e.state === "dead" && e.deadT > 2.4) return;
      const m = w.project(e.f, e.r, e.z + BODY * 0.5 * sc);
      if (!m) return;
      ar.queue(m.depth, () => {
        if (e.state !== "dead") fx.shadow(e.f, e.r, e.z, 0.007 * S * sc * 1.5, 0.35);
        const fade = e.state === "dead" ? clamp(1 - (e.deadT - 1.6) / 0.8, 0, 1) : 1;
        const blink = e.flash > 0 ? 0.7 : windT0(e) > 0.6 ? (Math.sin(time * 40) > 0 ? 0.3 : 0) : 0;
        const c = w.camLocal();
        const near = clamp((Math.hypot(c.f - e.f, c.r - e.r) - 0.04) / 0.04, 0.35, 1);
        const ph = cx.photo && cx.photo();
        let J;
        let P;
        let windT;
        let look;
        if (ph) {
          // a lit 3D model on the GPU (blockquest_gl.js, blockquest_figures.js)
          const jj = enemyJoints(e, time, true);
          J = jj.J;
          windT = jj.windT;
          look = LOOKS[e.kind];
          P = K.placer(e.f, e.r, e.z, e.yaw, S * sc);
          const F = ph.R.figure({ f: e.f, r: e.r, z: e.z, yaw: e.yaw, scale: S * sc, height: 0.07 });
          if (F) {
            ph.M.enemy(F, J, e, { look, time, windup: jj.T });
            F.draw({ alpha: fade * near, flash: e.flash > 0 ? 0.6 : blink * 0.8, shadow: e.state === "dead" ? 0.5 : 1 });
          }
        } else {
          const pr = enemyPrims(e, time);
          ({ J, P, windT, look } = pr);
          K.drawPrims(w, pr.prims, ar, "rgba(20,16,12,0.7)", fade * near, blink);
        }
        if (windT > 0 && J.swordDir) {
          const tip = [J.hand[1][0] + J.swordDir[0] * 0.016, J.hand[1][1] + J.swordDir[1] * 0.016, J.hand[1][2] + J.swordDir[2] * 0.016];
          const s = w.project(...P(tip));
          if (s) ar.glow(s.x, s.y, Math.max(4, 0.006 * s.ppm * sc) * (0.5 + windT), CLANG);
        }
        if (!ph && e.armor && e.state !== "dead") {
          // armor plates catching the light
          const s = w.project(e.f, e.r, e.z + BODY * 0.55 * sc);
          if (s) ar.glow(s.x, s.y, 0.012 * s.ppm * sc, [[0, "rgba(255,255,255,0.1)"], [1, "rgba(255,255,255,0)"]]);
        }
        void look;
        // eyes in the dark
        if (e.state !== "idle" && e.state !== "dead") {
          const hs = w.project(...P([J.head[0] + 0.004, J.head[1], J.head[2] + 0.001]));
          if (hs) ar.glow(hs.x, hs.y, 0.004 * hs.ppm * sc, [[0, "rgba(255,80,40,0.8)"], [1, "rgba(255,40,0,0)"]]);
        }
      }, w.extent(e.f - 0.012 * S * sc * 1.6, e.f + 0.012 * S * sc * 1.6, e.r - 0.012 * S * sc * 1.6, e.r + 0.012 * S * sc * 1.6, e.z, e.z + BODY * sc));
    }
    function drawArrow(a) {
      const m = w.project(a.f, a.r, a.z);
      if (!m) return;
      ar.queue(m.depth, () => {
        const sp = Math.hypot(a.vf, a.vr, a.vz) || 1;
        let dir = [a.vf / sp, a.vr / sp, a.vz / sp];
        if (a.stuck) dir = a.dirKeep || (a.dirKeep = dir);
        if (!a.stuck) a.dirKeep = dir;
        const ph = cx.photo && cx.photo();
        if (ph) {
          const F = ph.R.figure({ f: a.f, r: a.r, z: a.z, yaw: 0, scale: 1, height: 0.002 });
          if (F) {
            ph.M.arrow(F, dir, a.stuck);
            F.draw({ shadow: 0 });
            return;
          }
        }
        const L = 0.016;
        const tip = [a.f, a.r, a.z];
        const tail = [a.f - dir[0] * L, a.r - dir[1] * L, a.z - dir[2] * L];
        const p0 = w.project(...tail);
        const p1 = w.project(...tip);
        if (!p0 || !p1) return;
        const g = ar.ctx;
        g.save();
        g.lineCap = "round";
        g.strokeStyle = "rgba(20,12,6,0.8)";
        g.lineWidth = Math.max(2, 0.0016 * p1.ppm + 1);
        g.beginPath();
        g.moveTo(p0.x, p0.y);
        g.lineTo(p1.x, p1.y);
        g.stroke();
        g.strokeStyle = "#a07a48";
        g.lineWidth = Math.max(1, 0.0016 * p1.ppm);
        g.stroke();
        g.fillStyle = "#c0c4c8";
        g.beginPath();
        g.arc(p1.x, p1.y, Math.max(1.2, 0.0019 * p1.ppm), 0, 2 * Math.PI);
        g.fill();
        g.strokeStyle = "#e8e0d0";
        g.lineWidth = 1;
        for (const s of [-1, 1]) {
          g.beginPath();
          g.moveTo(p0.x, p0.y);
          g.lineTo(p0.x - (p1.x - p0.x) * 0.2 + s * 3, p0.y - (p1.y - p0.y) * 0.2 - 2);
          g.stroke();
        }
        g.restore();
      });
    }
    function drawBomb(b, time) {
      const rad = 0.0055 * S / 0.43 * 0.55;
      const m = w.project(b.f, b.r, b.z + rad);
      if (!m) return;
      ar.queue(m.depth, () => {
        const g = ar.ctx;
        fx.shadow(b.f, b.r, b.z, rad * 1.1, 0.35);
        // blast reach: a faint ring while armed
        if (!b.fuse) fx.ring(b.f, b.r, b.z + 0.0006, blastRadius(), `rgba(255,70,50,${0.18 + 0.1 * Math.sin(time * 4 + b.blink * 6)})`, 1.2);
        const R = rad * m.ppm;
        const ph = cx.photo && cx.photo();
        if (ph) {
          const F = ph.R.figure({ f: b.f, r: b.r, z: b.z, yaw: 0, scale: rad, height: 2 });
          if (F) {
            ph.M.bomb(F, { fuse: b.fuse, led: Math.sin(time * 5 + b.blink * 6) > 0 });
            F.draw({ shadow: 0.6 });
          }
        } else {
          const grad = g.createRadialGradient(m.x - R * 0.35, m.y - R * 0.4, R * 0.1, m.x, m.y, R);
          grad.addColorStop(0, "#6a6c72");
          grad.addColorStop(0.35, "#2a2b30");
          grad.addColorStop(1, "#0a0a0c");
          g.fillStyle = grad;
          g.beginPath();
          g.arc(m.x, m.y, R, 0, 2 * Math.PI);
          g.fill();
        }
        // the cap and fuse
        const cap = w.project(b.f, b.r, b.z + rad * 2.0);
        if (cap) {
          if (!ph) {
            g.strokeStyle = "#3a2a1a";
            g.lineWidth = Math.max(1.5, R * 0.18);
            g.beginPath();
            g.moveTo(m.x, m.y - R * 0.9);
            g.quadraticCurveTo(cap.x + R * 0.4, cap.y - R * 0.2, cap.x + R * 0.2, cap.y - R * 0.7);
            g.stroke();
          }
          const spark = b.fuse ? 1 : 0.5 + 0.5 * Math.sin(time * 14 + b.blink * 9);
          g.save();
          g.globalCompositeOperation = "lighter";
          ar.glow(cap.x + R * 0.2, cap.y - R * 0.7, R * (b.fuse ? 1.6 : 0.8), [[0, `rgba(255,220,120,${0.9 * spark})`], [1, "rgba(255,80,0,0)"]]);
          g.restore();
        }
        // the remote's red light
        if (!b.fuse) {
          g.save();
          g.globalCompositeOperation = "lighter";
          ar.glow(m.x, m.y - R * 0.2, R * 0.45, [[0, `rgba(255,50,40,${0.5 + 0.5 * Math.sin(time * 5 + b.blink * 6)})`], [1, "rgba(255,0,0,0)"]]);
          g.restore();
        }
      }, w.extent(b.f - rad, b.f + rad, b.r - rad, b.r + rad, b.z, b.z + rad * 2));
    }
    function drawKeg(k, time) {
      if (k.state === "gone" && k.burnt >= 1) {
        // a scorched ring and a few staves
        const m = w.project(k.f, k.r, k.z);
        if (!m) return;
        ar.queue(m.depth + 0.001, () => {
          fx.disc(k.f, k.r, k.z + 0.0008, k.rad * 0.9, "rgba(10,8,6,0.45)");
          fx.barrel(k.f, k.r, k.z, k.rad * 0.6, k.height * 0.28, { burnt: 0.9 });
        });
        return;
      }
      if (k.missing) return;
      const m = w.project(k.f, k.r, k.z + k.height * 0.5);
      if (!m) return;
      ar.queue(m.depth, () => {
        const sh = k.state === "fuse" ? Math.sin(time * 50) * 0.0006 : 0;
        const ph = cx.photo && cx.photo();
        if (ph) {
          const F = ph.R.figure({ f: k.f + sh, r: k.r, z: k.z, yaw: k.id, scale: k.rad, height: k.height / k.rad });
          if (F) {
            ph.M.keg(F, k);
            F.draw({ shadow: 0.7 });
          }
        } else {
          fx.barrel(k.f + sh, k.r, k.z, k.rad, k.height, { color: [140, 92, 50], spin: k.id });
          // "powder" in red paint
          const s = w.project(k.f + Math.cos(k.id) * k.rad, k.r + Math.sin(k.id) * k.rad, k.z + k.height * 0.5);
          if (s) ar.text("\u2620", s.x, s.y + 3, { size: Math.max(8, 0.011 * s.ppm), align: "center", color: "rgba(200,40,30,0.8)", outline: false });
        }
        if (k.state === "fuse") fx.flame(k.f, k.r, k.z + k.height, 0.012, time, { light: false });
      }, w.extent(k.f - k.rad, k.f + k.rad, k.r - k.rad, k.r + k.rad, k.z, k.z + k.height));
    }
    function drawBlasts() {
      A.blasts.forEach((b) => {
        const m = w.project(b.f, b.r, b.z + 0.01);
        if (!m) return;
        ar.queue(m.depth - 0.01, () => fx.explosion(b.f, b.r, b.z, b.rad, clamp(b.t / 1.1, 0, 1)));
      });
      A.rings.forEach((g) => {
        const m = w.project(g.f, g.r, 0.002);
        if (!m) return;
        ar.queue(m.depth, () => {
          const a = 1 - g.rad / g.max;
          fx.ring(g.f, g.r, 0.0015, g.rad, `rgba(230,210,170,${(0.85 * a).toFixed(3)})`, 3);
          fx.ring(g.f, g.r, 0.0015, g.rad * 0.92, `rgba(120,100,80,${(0.5 * a).toFixed(3)})`, 1.5);
        });
      });
    }
    A.draw = (time) => {
      A.enemies.forEach((e) => drawEnemy(e, time));
      A.arrows.forEach(drawArrow);
      A.bombs.forEach((b) => drawBomb(b, time));
      A.kegs.forEach((k) => drawKeg(k, time));
      drawBlasts();
    };
    A.reset = () => {
      A.enemies.length = A.arrows.length = A.bombs.length = A.kegs.length = A.blasts.length = A.rings.length = 0;
    };
    void BOMB_R;
    void lerp;
    return A;
  };
})(window.Lynx);
