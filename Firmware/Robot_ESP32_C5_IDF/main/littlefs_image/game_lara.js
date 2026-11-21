// Lara on Blocks -- coins climbing out of reach, on the hero, drive and camera of
// Knight on Blocks (game_knightblocks.js, as an extension). Lara, the
// explorer with the braid and the tank top, runs, jumps and climbs on the real
// tagged cubes; a gold coin turns up near her (at most some 20 cm away, at
// 3 cm hero height -- all distances scale with her height):
//   coin 1 lies on the floor,
//   coin 2 hangs in the air, within a jump's reach from the floor,
//   coin 3 on: higher and higher -- out of reach from the floor: stack cubes
//   (or put them on a box, a book, a chair...) to climb up to it.
// The score: the coins taken. Fire puts the coin somewhere else (as high).
// A shadow and a thin line below the coin show where it is above the floor,
// its height is written beside it; an arrow at the edge points to it when
// it's out of the picture.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  Lynx.games.laraonblocks = (ar, cfg, app) => Lynx.games.knightblocks(ar, cfg, app, (api) => Lynx.laraCoins(api));

  const BOARD = "laraonblocks";

  // Lara's look: a tank top, shorts, knee boots, a backpack, a long braid
  const LARA = {
    outline: "rgba(15,12,10,0.9)", skin: "#e0a67e", hair: "#3b2416", hairTie: "#1c120a", top: "#2a9a98", topDark: "#1d7472",
    shorts: "#8a6a44", belt: "#2e2016", strap: "#3a2a1c", boots: "#4a2c18", bootCuff: "#5e3a20", gloves: "#2a2420", pack: "#6b5236", eye: "#1a1410", lips: "#b8584e",
  };
  const V = {
    add: (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]],
    mul: (a, k) => [a[0] * k, a[1] * k, a[2] * k],
  };
  const lerp3 = (a, b, t) => V.add(a, V.mul(V.add(b, V.mul(a, -1)), t));

  // the prims (game_knight.js drawPrims) of Lara in pose J, placed by P (knight units: 3 cm tall)
  function laraPrims(J, P, time, phase, speed) {
    const L = LARA;
    const out = [];
    const seg = (a, b, rad, color, grp, bias) => out.push({ k: "seg", a: P(a), b: P(b), rad, color, grp, bias });
    const ball = (c, rad, color, grp, extra = {}) => out.push({ k: "ball", c: P(c), rad, color, grp, ...extra });
    const fwd = [Math.cos(J.twist), Math.sin(J.twist), 0];
    const right = [-Math.sin(J.twist), Math.cos(J.twist), 0];
    const back = V.mul(fwd, -1);
    const body = "body";
    const flow = Math.min(0.006, speed * 0.05);
    // legs: bare thighs and knees, knee-high boots, a strap round each thigh
    for (const s of [-1, 1]) {
      const grp = `leg${s}`;
      const mid = lerp3(J.hip[s], J.knee[s], 0.45);
      seg(J.hip[s], J.knee[s], 0.0021, L.skin, grp);
      seg(lerp3(J.knee[s], J.ankle[s], 0.12), J.ankle[s], 0.002, L.boots, grp);
      seg(lerp3(J.knee[s], J.ankle[s], 0.12), lerp3(J.knee[s], J.ankle[s], 0.22), 0.0022, L.bootCuff, grp);
      seg(J.ankle[s], J.toe[s], 0.0019, L.boots, grp);
      seg(V.add(mid, [0, 0, 0.0005]), V.add(mid, [0, 0, -0.0005]), 0.0024, L.strap, grp);
    }
    // the shorts: from the waist to the top of the thighs
    const waist = V.add(J.pelvis, V.mul(J.up, 0.003));
    const hem = V.add(J.pelvis, V.mul(J.up, -0.0045));
    out.push({
      k: "poly",
      pts: [P(V.add(waist, V.mul(right, -0.0052))), P(V.add(waist, V.mul(right, 0.0052))), P(V.add(hem, V.mul(right, 0.0066))), P(V.add(hem, V.mul(right, -0.0066)))],
      color: L.shorts,
      grp: body,
      lines: [[P(hem), P(waist)]],
      lineColor: "rgba(40,28,14,0.5)",
    });
    // the tank top (bare shoulders and arms), the belt and its pouches, the backpack
    seg(V.add(J.pelvis, V.mul(J.up, 0.003)), J.chest, 0.0043, L.top, body);
    seg(V.add(J.pelvis, V.mul(J.up, 0.0026)), V.add(J.pelvis, V.mul(J.up, 0.0042)), 0.0047, L.belt, body);
    for (const s of [-1, 1]) ball(V.add(V.add(J.pelvis, V.mul(right, s * 0.0048)), V.mul(J.up, 0.0034)), 0.0014, L.strap, body);
    const packC = V.add(lerp3(J.pelvis, J.chest, 0.7), V.mul(back, 0.0042));
    seg(V.add(packC, [0, 0, 0.0022]), V.add(packC, [0, 0, -0.0022]), 0.003, L.pack, body);
    seg(J.sh[-1], J.sh[1], 0.0018, L.skin, body);
    for (const s of [-1, 1]) seg(V.add(J.sh[s], V.mul(right, -s * 0.0012)), lerp3(J.pelvis, J.chest, 0.75), 0.0011, L.topDark, body, -0.0008); // (the top's straps)
    seg(V.add(J.chest, V.mul(V.add(J.neck, V.mul(J.chest, -1)), 0.35)), J.neck, 0.0018, L.skin, body);
    for (const s of [-1, 1]) {
      const grp = `arm${s}`;
      seg(J.sh[s], J.elbow[s], 0.0015, L.skin, grp);
      seg(J.elbow[s], J.hand[s], 0.0013, L.skin, grp);
      ball(J.hand[s], 0.0015, L.gloves, grp);
    }
    // the head: hair swept back, the face, a long braid down the back (swinging as she runs)
    ball(V.add(J.head, V.add(V.mul(fwd, -0.0016), [0, 0, 0.0011])), 0.0056, L.hair, body);
    ball(J.head, 0.0052, L.skin, body);
    ball(V.add(J.head, V.add(V.mul(fwd, 0.0012), [0, 0, 0.0038])), 0.0034, L.hair, body); // (the hairline)
    for (const s of [-1, 1]) ball(V.add(V.add(J.head, V.mul(fwd, 0.005)), V.add(V.mul(right, s * 0.0018), [0, 0, 0.0004])), 0.0007, L.eye, body, { flat: true, noOutline: true });
    ball(V.add(J.head, V.add(V.mul(fwd, 0.0051), [0, 0, -0.0021])), 0.0007, L.lips, body, { flat: true, noOutline: true });
    const nape = V.add(V.add(J.head, V.mul(back, 0.0048)), [0, 0, -0.0012]);
    const swing = Math.sin(time * 7 + phase) * 0.0014 * Math.min(1, speed * 20);
    let prev = nape;
    for (let k = 1; k <= 4; k++) {
      const t = k / 4;
      const p = V.add(V.add(nape, V.mul(back, (0.0016 + flow) * t)), V.add(V.mul(right, swing * t * t), [0, 0, -0.011 * t + flow * 0.4 * t]));
      seg(prev, p, 0.0017 - 0.0003 * t, L.hair, body);
      ball(p, 0.0017 - 0.0003 * t, L.hair, body); // (the braid's plaits)
      prev = p;
    }
    ball(prev, 0.0011, L.hairTie, body);
    return out;
  }
  Lynx.laraPrims = laraPrims;

  Lynx.laraCoins = (api) => {
    const { ar, w, hero, C } = api;
    const { clamp } = api.util;
    const T = (s) => (Lynx.tr ? Lynx.tr(s) : s);
    const H = C.BODY_H; // her height (m)
    const APEX = (C.JUMP_V * C.JUMP_V) / (2 * C.GRAVITY); // a jump's height (m)
    const COIN_R = 0.2 * H; // the coin's radius
    const NEAR = 0.2 * (H / 0.03); // farthest a coin turns up from her: 20 cm at 3 cm tall
    const G = { score: 0, coin: null, time: 0, best: null, rankMsg: "", pop: null, tries: 0 };
    Lynx.bestScore(BOARD).then((b) => (G.best = b)).catch(() => {});

    // the k-th coin's height (its centre above the floor)
    function coinHeight(k) {
      if (k <= 1) return COIN_R; // on the floor
      if (k === 2) return H + COIN_R + 0.35 * APEX; // above her head: a jump's reach
      // out of a jump's reach from the floor (her head at H + APEX), a bit higher each time
      return H + APEX + COIN_R + 0.25 * H + (k - 3) * 0.5 * H;
    }
    const fits = (f, r, h) =>
      // not in a cube (or so close above it that it's on it, for the coins in the air)
      !api.solids.some((b) => api.inFoot(b, f, r, COIN_R + 0.004) && h + COIN_R > b.h0 - 0.002 && h - COIN_R < b.h1 + (h > COIN_R * 1.5 ? 0.6 * H : 0.002));
    function clearOfRobot(f, r) {
      const ch = api.chassis();
      const rb = api.robotBody();
      const df = f - ch.f;
      const dr = r - ch.r;
      const a = df * Math.cos(ch.th) + dr * Math.sin(ch.th); // along the robot (forward)
      const b = -df * Math.sin(ch.th) + dr * Math.cos(ch.th);
      const m = 0.03;
      return !(a < rb.front + m && a > -rb.rear - m && Math.abs(b) < rb.half + m);
    }
    // a new coin: near her, away from the robot (towards where the camera looks), not in a cube
    function spawn(k = G.score + 1) {
      const h = coinHeight(k);
      const ch = api.chassis();
      const away = Math.atan2(hero.r - ch.r, hero.f - ch.f); // (from the robot through her: what the camera sees)
      let best = null;
      for (let n = 0; n < 80; n++) {
        const a = away + (Math.random() - 0.5) * (n < 50 ? 2.2 : 2 * Math.PI);
        const d = (0.3 + 0.7 * Math.random()) * NEAR;
        const f = hero.f + d * Math.cos(a);
        const r = hero.r + d * Math.sin(a);
        if (!fits(f, r, h) || !clearOfRobot(f, r)) continue;
        if (G.coin && Math.hypot(f - G.coin.f, r - G.coin.r) < 0.25 * NEAR) continue; // (moved: somewhere else)
        best = { f, r };
        break;
      }
      if (!best) best = { f: hero.f + Math.cos(away) * 0.5 * NEAR, r: hero.r + Math.sin(away) * 0.5 * NEAR };
      G.coin = { ...best, h, k, t: 0 };
    }
    function take() {
      G.score += 1;
      G.pop = { f: G.coin.f, r: G.coin.r, h: G.coin.h, t: 0 };
      api.sfx("coin");
      const next = G.score + 1;
      if (next === 2) api.say(T("Coin 2 is in the air: jump for it!"), "#ffd84a");
      else if (next === 3) api.say(T("Too high to jump: stack the cubes and climb up!"), "#ffd84a");
      else api.say(T("Coin {}! The next one is higher.").replace("{}", G.score), "#ffd84a");
      spawn(next);
    }
    function touching() {
      const c = G.coin;
      if (!c) return false;
      if (Math.hypot(c.f - hero.f, c.r - hero.r) > C.BODY_R + COIN_R) return false;
      return c.h + COIN_R > hero.z && c.h - COIN_R < hero.z + H;
    }
    let submitted = 0;
    function submit() {
      if (G.score <= submitted) return;
      submitted = G.score;
      Lynx.submitScore(BOARD, G.score).then((rank) => (G.rankMsg = rank ? T("#{} on the robot's scoreboard!").replace("{}", rank) : "")).catch(() => {});
    }
    ar.onDestroy(submit);

    // -- drawing ------------------------------------------------------------------------------
    function drawCoin() {
      const c = G.coin;
      if (!c || api.state !== "playing") return;
      const bob = c.k > 1 ? Math.sin(G.time * 2.2) * 0.04 * H : 0;
      const h = c.h + bob;
      const p = w.project(c.f, c.r, h);
      // the shadow on what's below it, and a thin line down to it: where it is, how high
      const g0 = api.groundAt(c.f, c.r, h - COIN_R).h;
      const ps = w.project(c.f, c.r, g0);
      if (ps) {
        ar.queue(ps.depth + 0.001, () => {
          const x = ar.ctx;
          x.save();
          x.fillStyle = "rgba(0,0,0,0.3)";
          x.beginPath();
          x.ellipse(ps.x, ps.y, Math.max(2, COIN_R * ps.ppm), Math.max(1, COIN_R * ps.ppm * 0.4), 0, 0, 2 * Math.PI);
          x.fill();
          x.restore();
        });
        if (h - g0 > COIN_R * 2) w.line3([[c.f, c.r, g0], [c.f, c.r, h - COIN_R]], "rgba(255,216,74,0.45)", 1, 0.005);
      }
      if (!p) return;
      ar.queue(p.depth, () => {
        const x = ar.ctx;
        const r = Math.max(3, COIN_R * p.ppm);
        const spin = Math.cos(G.time * 3);
        ar.glow(p.x, p.y, r * 2.6, [[0, "rgba(255,240,160,0.55)"], [0.5, "rgba(255,210,60,0.25)"], [1, "rgba(255,210,60,0)"]]);
        x.save();
        // the rim (its edge, seen as it turns), then the face
        const rw = Math.max(1, r * Math.abs(spin));
        x.fillStyle = "#a8741a";
        x.beginPath();
        x.ellipse(p.x + (spin >= 0 ? 1 : -1) * Math.min(r * 0.18, 2.5), p.y, rw, r, 0, 0, 2 * Math.PI);
        x.fill();
        const gr = x.createLinearGradient(p.x - rw, p.y - r, p.x + rw, p.y + r);
        gr.addColorStop(0, "#fff2a0");
        gr.addColorStop(0.5, "#ffc928");
        gr.addColorStop(1, "#d08f10");
        x.fillStyle = gr;
        x.strokeStyle = "rgba(90,55,0,0.9)";
        x.lineWidth = 1.2;
        x.beginPath();
        x.ellipse(p.x, p.y, rw, r, 0, 0, 2 * Math.PI);
        x.fill();
        x.stroke();
        if (Math.abs(spin) > 0.35) {
          x.strokeStyle = "rgba(150,95,0,0.8)";
          x.beginPath();
          x.ellipse(p.x, p.y, rw * 0.66, r * 0.66, 0, 0, 2 * Math.PI);
          x.stroke();
        }
        x.restore();
        // its height above the floor (real cm)
        if (c.k > 1) ar.text(`${Math.round((c.h / 0.01) * 10) / 10} cm`, p.x + r + 6, p.y + 4, { size: 12, align: "left", color: "#ffe9a8" });
      });
    }
    function drawPop() {
      const q = G.pop;
      if (!q) return;
      const p = w.project(q.f, q.r, q.h + q.t * 0.6 * H);
      if (p) ar.text("+1", p.x, p.y, { size: 18, align: "center", color: `rgba(255,220,80,${clamp(1 - q.t / 0.9, 0, 1)})` });
    }
    // the coin out of the picture: an arrow at the edge, towards it
    function drawPointer() {
      const c = G.coin;
      if (!c || api.state !== "playing") return;
      const v = ar.view;
      const p = w.project(c.f, c.r, c.h);
      const ph = w.project(hero.f, hero.r, hero.z + H / 2);
      const m = 30;
      if (p && p.x > v.x + m && p.x < v.x + v.w - m && p.y > v.y + m && p.y < v.y + v.h - m) return;
      let dx;
      let dy;
      if (p && ph) {
        dx = p.x - ph.x;
        dy = p.y - ph.y;
      } else {
        // behind the camera: its side, from where she is
        const cam = w.camLocal();
        const fwd = Math.atan2(hero.r - cam.r, hero.f - cam.f);
        const a = Math.atan2(c.r - cam.r, c.f - cam.f) - fwd;
        dx = Math.sin(a);
        dy = 1;
      }
      const L = Math.hypot(dx, dy) || 1;
      dx /= L;
      dy /= L;
      const cx = v.cx;
      const cy = v.cy;
      const t = Math.min(Math.abs((v.w / 2 - m) / (dx || 1e-6)), Math.abs((v.h / 2 - m) / (dy || 1e-6)));
      const x0 = cx + dx * t;
      const y0 = cy + dy * t;
      const x = ar.ctx;
      x.save();
      x.translate(x0, y0);
      x.rotate(Math.atan2(dy, dx));
      x.fillStyle = "rgba(255,210,60,0.95)";
      x.strokeStyle = "rgba(60,35,0,0.9)";
      x.lineWidth = 1.5;
      x.beginPath();
      x.moveTo(14, 0);
      x.lineTo(-8, -10);
      x.lineTo(-3, 0);
      x.lineTo(-8, 10);
      x.closePath();
      x.fill();
      x.stroke();
      x.restore();
    }
    function drawHud() {
      const v = ar.view;
      const small = Lynx.smallScreen();
      ar.text(`\u{1FA99} ${G.score}`, v.x + v.w - 14, v.y + (small ? 52 : 60), { size: small ? 18 : 22, align: "right", color: "#ffd84a" });
      const sub = [];
      if (G.best != null) sub.push(`${T("best")}: ${Math.max(G.best, G.score)}`);
      if (G.coin && G.coin.k > 1) sub.push(`${T("next coin")}: ${Math.round(G.coin.h / 0.001) / 10} cm`);
      if (sub.length) ar.text(sub.join(" · "), v.x + v.w - 14, v.y + (small ? 70 : 82), { size: small ? 11 : 13, align: "right", color: "#ffe9a8" });
      if (G.rankMsg) ar.text(G.rankMsg, v.x + v.w - 14, v.y + (small ? 86 : 100), { size: small ? 11 : 13, align: "right", color: "#9ad8ff" });
      drawPointer();
    }
    function drawLara(J, alpha) {
      const K = api.K;
      const prims = laraPrims(J, K.placer(hero.f, hero.r, hero.z, hero.yaw, api.S), G.time, hero.phase || 0, Math.hypot(hero.vf, hero.vr) / api.S);
      prims.forEach((p) => {
        if (p.rad) p.rad *= api.S;
        if (p.bias) p.bias *= api.S;
      });
      K.drawPrims(w, prims, ar, LARA.outline, alpha == null ? 1 : alpha);
      return true;
    }

    return {
      name: "LARA ON BLOCKS",
      actionLabel: "\u{1FA99} Move coin",
      unarmed: true,
      drawHero: drawLara,
      draw() {
        drawCoin();
        drawPop();
      },
      hud: drawHud,
      helpLine: (auto) =>
        auto
          ? "Run: stick / WASD · Jump: A / Space · Coin elsewhere: Fire · Behind: Y / C · Center: V · Rescan: R · Manual drive: M"
          : "Lara: left stick / WASD · Robot: right stick / arrows · Jump: A / Space · Coin elsewhere: Fire · Center: V / Y / C · Rescan: R · Auto drive: M",
      onFire(state) {
        if (state !== "playing") return false; // (the base game starts)
        if (G.coin) {
          spawn(G.coin.k);
          api.sfx("click");
        }
        return true;
      },
      update(dt) {
        G.time += dt;
        if (G.pop && (G.pop.t += dt) > 0.9) G.pop = null;
        if (api.state !== "playing") return;
        if (!G.coin) {
          spawn(1);
          api.say(T("A coin! Run to it and take it"), "#ffd84a");
        }
        if (touching()) take();
      },
      snapshot: () => ({ score: G.score, coin: G.coin && { k: G.coin.k, f: +G.coin.f.toFixed(3), r: +G.coin.r.toFixed(3), h: +G.coin.h.toFixed(3) } }),
      debug: { G, spawn, coinHeight, take, H, APEX },
    };
  };
})(window.Lynx);
