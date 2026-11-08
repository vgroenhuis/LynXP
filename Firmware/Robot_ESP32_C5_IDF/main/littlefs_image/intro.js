// Game introductions: a short film that plays when a game starts, made with
// the game itself. The game runs as usual -- its first level, its enemies,
// its own drawing -- but a virtual camera flies round it (ar.virtual, see
// ar.js), the robot stays where it is (Lynx.control.hold: nothing is sent),
// and a script plays the player: it drives (first person: a virtual robot,
// drawn as a little model when the camera isn't its own), moves the hero
// (third person: the stick, Lynx.control.setScriptedDrive), fires, jumps.
// Subtitles in the page's language, optionally read out by the browser's
// own voice (speechSynthesis). Skip: the button, Esc / Enter / Space, any
// gamepad button. When it ends (or is skipped) the game starts afresh, so
// nothing of the demo carries over -- and scores aren't saved meanwhile.
// The scripts are in intro_scripts.js (Lynx.intros[id]).
//
// A script: {steps: [step, ...], start: "fire" (default: start play as Fire
// on the title screen does) | null | fn(ctx), live: true (no virtual camera:
// subtitles over the real view, for games about the real room)}. A step:
//   say: [english, dutch]       the subtitle (and voice); the step lasts
//                               at least d s and until the voice is done
//   d: seconds                  (default: from the text's length)
//   cam: the camera during the step, in the level's frame (f m forward and
//        r m to the right of where the robot stood when the intro started,
//        h m up; a = degrees, positive = to the left):
//     {orbit: [f, r, h], radius, height, from: a, to: a}   round a point
//     {fly: [[eye], [look]], to: [[eye], [look]]}         from one view to another
//     {eye: [f, r, h], look: [f, r, h]}                    still
//     "player"                                             the player's own camera
//     {behind: dist, height, ahead}                        over the player's shoulder (first person)
//     {chase: fn(ctx) -> {x, y, h, yaw} (world), dist, height, side}   follow a hero
//     cut: true                                            (no glide from the last view)
//   drive: {j1, j2, rot} | {to: [f, r], speed} | fn(t, ctx)   the player robot (first person)
//   stick: [j1, j2] | fn(t, ctx) -> [j1, j2]                  the hero's stick (third person)
//   at: [[t, "fire" | "jump" | "camera" | ["weapon", n] | fn(ctx)], ...]
//   fireHeld: [t0, t1], shield: [t0, t1]                       held between those times
//   run: fn(ctx)                                               at the step's start
// ctx: {game, ar, O, toWorld(f, r), fromWorld(x, y), pose (the player's),
//       fakeCubes([{tag, f, r, yaw, size}]), t (in the step)}.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const DRIVE_MPS = 0.22; // the virtual robot's speed at full stick
  const BLEND_S = 0.9; // a new camera glides in from the last one this long
  const FADE_S = 0.45;
  const L = (s) => (Array.isArray(s) ? (Lynx.lang === "nl" && s[1] ? s[1] : s[0]) : s || "");
  const UI = {
    skip: ["Skip ⏭", "Overslaan ⏭"],
    intros: ["Play intros", "Intro's afspelen"],
    voiceOn: ["🔊 Voice", "🔊 Stem"],
    voiceOff: ["🔇 Voice", "🔇 Stem"],
    hint: ["Esc / Enter / any gamepad button: skip", "Esc / Enter / een knop op de gamepad: overslaan"],
    intro: ["Introduction", "Introductie"],
  };
  const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
  const lerp = (a, b, t) => a + (b - a) * t;
  const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const norm = (v) => {
    const n = Math.hypot(v[0], v[1], v[2]) || 1;
    return [v[0] / n, v[1] / n, v[2] / n];
  };
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  let cur = null; // the intro playing

  // How long a subtitle needs (s): reading (or hearing) it at about 2.6 words a second
  const textTime = (s) => Math.max(3.2, s.split(/\s+/).length / 2.6 + 1.2);

  function speak(text, on, volume) {
    const S = window.speechSynthesis;
    if (!S) return null;
    S.cancel();
    if (!on || !text) return null;
    const u = new SpeechSynthesisUtterance(text.replace(/[⏭▶⤒🔥✓✔]/gu, ""));
    const lang = Lynx.lang === "nl" ? "nl" : "en";
    u.lang = lang === "nl" ? "nl-NL" : "en-GB";
    const voices = S.getVoices() || [];
    const pick = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(u.lang.toLowerCase())) || voices.find((v) => v.lang && v.lang.toLowerCase().startsWith(lang));
    if (pick) u.voice = pick;
    u.rate = 1.02;
    u.volume = Math.max(0, Math.min(1, volume === undefined ? 1 : volume * 1.4));
    const st = { done: false };
    u.onend = u.onerror = () => (st.done = true);
    S.speak(u);
    return st;
  }

  function buildLayer(entry, opts) {
    const host = document.querySelector(".cam-fullscreen") || document.body;
    const el = document.createElement("div");
    el.className = "intro-layer";
    el.innerHTML = `
      <div class="intro-title"><div class="intro-icon"></div><div class="intro-name"></div><div class="intro-kicker"></div></div>
      <div class="intro-sub"><span></span></div>
      <div class="intro-bar"><div></div></div>
      <div class="intro-ctrl">
        <label class="intro-check"><input type="checkbox"> <span></span></label>
        <button class="intro-btn intro-voice"></button>
        <button class="intro-btn intro-skip"></button>
      </div>
      <div class="intro-hint"></div>
      <div class="intro-fade"></div>`;
    el.setAttribute("translate", "no"); // (the subtitles are in the page's language already)
    el.querySelector(".intro-icon").textContent = entry ? entry.icon : "";
    el.querySelector(".intro-name").textContent = entry ? (Lynx.tr ? Lynx.tr(entry.name) : entry.name) : "";
    el.querySelector(".intro-kicker").textContent = L(UI.intro);
    el.querySelector(".intro-check span").textContent = L(UI.intros);
    el.querySelector(".intro-skip").textContent = L(UI.skip);
    el.querySelector(".intro-hint").textContent = L(UI.hint);
    const box = el.querySelector(".intro-check input");
    box.checked = opts.app ? opts.app.general.intros !== false : true;
    box.addEventListener("change", () => {
      if (!opts.app) return;
      opts.app.general.intros = box.checked;
      Lynx.saveAppSettings(opts.app).catch(() => {});
    });
    const voiceBtn = el.querySelector(".intro-voice");
    const showVoice = () => (voiceBtn.textContent = L(cur && cur.voice ? UI.voiceOn : UI.voiceOff));
    voiceBtn.addEventListener("click", () => {
      if (!cur) return;
      cur.voice = !cur.voice;
      showVoice();
      if (opts.app) {
        opts.app.general.introVoice = cur.voice;
        Lynx.saveAppSettings(opts.app).catch(() => {});
      }
      if (!cur.voice && window.speechSynthesis) window.speechSynthesis.cancel();
    });
    el.querySelector(".intro-skip").addEventListener("click", () => finish(true));
    // (the layer takes the taps: nothing reaches the game under it)
    ["pointerdown", "mousedown", "touchstart", "click", "wheel"].forEach((t) =>
      el.addEventListener(t, (e) => {
        if (!e.target.closest(".intro-ctrl")) e.preventDefault();
        e.stopPropagation();
      }, { passive: false }),
    );
    host.appendChild(el);
    return { el, showVoice, sub: el.querySelector(".intro-sub span"), bar: el.querySelector(".intro-bar div"), fade: el.querySelector(".intro-fade") };
  }

  // -- the virtual camera ------------------------------------------------------------
  function frameFrom(eye, look, ar) {
    const fwd = norm([look[0] - eye[0], look[1] - eye[1], look[2] - eye[2]]);
    let right = cross(fwd, [0, 0, 1]);
    if (Math.hypot(...right) < 1e-3) right = [Math.sin(cur.O.th), -Math.cos(cur.O.th), 0]; // (straight down)
    right = norm(right);
    const down = cross(fwd, right);
    return { C: [eye[0], eye[1], eye[2] - ar.z], fwd, right, down, panDeg: 0, tiltDeg: 0, fixRad: 0, fixRoll: 0, fixPan: 0 };
  }
  // the player's own camera as eye / look (for gliding to and from it)
  function playerView(ar) {
    const F = Lynx.cameraFrame(ar.calib, cur.pose);
    const e = [F.C[0], F.C[1], F.C[2]];
    return { eye: e, look: [e[0] + F.fwd[0], e[1] + F.fwd[1], e[2] + F.fwd[2]], player: true };
  }

  function camFor(spec, t, d, ar) {
    const I = cur;
    const P = (p) => {
      const w = I.toWorld(p[0], p[1]);
      return [w.x, w.y, p[2]];
    };
    if (!spec || spec === "player") return playerView(ar);
    if (spec.orbit) {
      const a = ((lerp(spec.from || 0, spec.to === undefined ? spec.from || 0 : spec.to, ease(t / d)) * Math.PI) / 180);
      // round a point, or round the player ("player": as it drives)
      const c = spec.orbit === "player" ? I.fromWorld(I.pose.x, I.pose.y) : null;
      const [cf, cr, ch] = c ? [c.f, c.r, spec.lookH || 0.03] : spec.orbit;
      const R = spec.radius || 1;
      return { eye: P([cf - R * Math.cos(a), cr - R * Math.sin(a), spec.height || 0.6]), look: P([cf, cr, ch]), smooth: c ? 0.3 : 0 };
    }
    if (spec.fly) {
      const k = ease(t / d);
      const to = spec.to || spec.fly;
      return { eye: lerp3(P(spec.fly[0]), P(to[0]), k), look: lerp3(P(spec.fly[1]), P(to[1]), k) };
    }
    if (spec.eye) return { eye: P(spec.eye), look: P(spec.look) };
    if (spec.behind !== undefined) {
      // over the player's shoulder: behind and above the robot, looking past it
      const p = I.pose;
      const c = Math.cos(p.theta);
      const s = Math.sin(p.theta);
      const b = spec.behind;
      const ahead = spec.ahead === undefined ? 0.5 : spec.ahead;
      const side = spec.side || 0;
      return {
        eye: [p.x - c * b + s * side, p.y - s * b - c * side, spec.height || 0.35],
        look: [p.x + c * ahead, p.y + s * ahead, spec.lookH === undefined ? 0.02 : spec.lookH],
        smooth: 0.25,
      };
    }
    if (spec.chase) {
      const g = spec.chase(I.ctx);
      if (!g) return null;
      const dist = spec.dist || 0.25;
      const yaw = g.yaw + ((spec.side || 0) * Math.PI) / 180;
      return {
        eye: [g.x - Math.cos(yaw) * dist, g.y - Math.sin(yaw) * dist, (g.h || 0) + (spec.height || 0.14)],
        look: [g.x + Math.cos(g.yaw) * (spec.ahead || 0.03), g.y + Math.sin(g.yaw) * (spec.ahead || 0.03), (g.h || 0) + (spec.lookH === undefined ? 0.02 : spec.lookH)],
        smooth: spec.smooth === undefined ? 0.5 : spec.smooth,
      };
    }
    return playerView(ar);
  }

  function applyVirtual(ar, now, dt) {
    const I = cur;
    if (!I) return;
    tick(now);
    // the player, as the game sees it
    ar.pose = { ...I.pose };
    ar.camTheta = I.pose.theta;
    ar.tilt = Lynx.cameraDown(ar.calib, I.pose);
    const base = Lynx.cameraFrame(ar.calib, I.pose);
    // the view
    const step = I.steps[I.i];
    let v = camFor(step && step.cam, I.t, I.d, ar) || I.last || playerView(ar);
    if (v.smooth && I.last) {
      // (a moving target: followed softly, not jerked along)
      const k = 1 - Math.exp(-dt / v.smooth);
      v = { eye: lerp3(I.last.eye, v.eye, k), look: lerp3(I.last.look, v.look, k) };
    }
    const blend = step && step.cam && step.cam.cut ? 0 : BLEND_S;
    if (I.from && I.t < blend) {
      const k = ease(I.t / blend);
      v = { eye: lerp3(I.from.eye, v.eye, k), look: lerp3(I.from.look, v.look, k), player: false };
    }
    I.last = v;
    if (v.player) {
      ar.frame = base;
      I.eyeAtPlayer = true;
    } else {
      ar.frame = frameFrom(v.eye, v.look, ar);
      ar.eye = { x: v.eye[0], y: v.eye[1] };
      ar.camTheta = Math.atan2(ar.frame.fwd[1], ar.frame.fwd[0]);
      ar.tilt = Math.asin(Math.max(-1, Math.min(1, -ar.frame.fwd[2])));
      const pf = Lynx.cameraFrame(ar.calib, I.pose).C;
      I.eyeAtPlayer = Math.hypot(v.eye[0] - pf[0], v.eye[1] - pf[1], v.eye[2] - pf[2]) < 0.06;
    }
    // the hero's stick (third person) is the view's stick: worked out now that ar.camTheta is the view's
    if (step && step.stick && !I.ending) {
      const s = typeof step.stick === "function" ? safe(() => step.stick(I.t, I.ctx)) : step.stick;
      Lynx.control.setScriptedDrive(s ? { j1: s[0], j2: s[1] } : null);
    }
  }

  // A floor of faint lines (the room isn't shown: it wouldn't match the view)
  function backdrop(ar) {
    const g = ar.ctx;
    const W = ar.canvas.width;
    const H = ar.canvas.height;
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, "#0b1020");
    sky.addColorStop(1, "#1d2638");
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    const I = cur;
    if (!I) return;
    const step = 0.25;
    const seg = (a, b, alpha) => {
      const p = ar.project(a.x, a.y, 0);
      const q = ar.project(b.x, b.y, 0);
      if (!p || !q) return;
      g.strokeStyle = `rgba(120,160,220,${alpha})`;
      g.beginPath();
      g.moveTo(p.x, p.y);
      g.lineTo(q.x, q.y);
      g.stroke();
    };
    g.lineWidth = 1;
    const [f0, f1, r0, r1] = I.script.grid || [-1.5, 3.5, -2.5, 2.5];
    for (let f = f0; f <= f1 + 1e-6; f += step) {
      for (let r = r0; r < r1 - 1e-6; r += step) seg(I.toWorld(f, r), I.toWorld(f, r + step), 0.16);
    }
    for (let r = r0; r <= r1 + 1e-6; r += step) {
      for (let f = f0; f < f1 - 1e-6; f += step) seg(I.toWorld(f, r), I.toWorld(f + step, r), 0.16);
    }
  }

  // The player's robot, when the camera isn't its own: a little model of it
  function overlay(ar) {
    const I = cur;
    if (!I || I.script.thirdPerson || I.eyeAtPlayer) return;
    const g = ar.ctx;
    const p = I.pose;
    const c = Math.cos(p.theta);
    const s = Math.sin(p.theta);
    const W = (f, r, h) => ar.project(p.x + f * c + r * s, p.y + f * s - r * c, h);
    const box = (f0, f1, r0, r1, h0, h1, top, side, front) => {
      const cam = ar.cameraWorld();
      const lf = (cam.x - p.x) * c + (cam.y - p.y) * s;
      const lr = (cam.x - p.x) * s - (cam.y - p.y) * c;
      const faces = [];
      if (lf > f1) faces.push([[f1, r0], [f1, r1], front]);
      if (lf < f0) faces.push([[f0, r1], [f0, r0], side]);
      if (lr > r1) faces.push([[f1, r1], [f0, r1], side]);
      if (lr < r0) faces.push([[f0, r0], [f1, r0], side]);
      const poly = (pts, fill) => {
        const q = pts.map(([f, r, h]) => W(f, r, h));
        if (q.some((x) => !x)) return;
        g.beginPath();
        q.forEach((x, i) => (i ? g.lineTo(x.x, x.y) : g.moveTo(x.x, x.y)));
        g.closePath();
        g.fillStyle = fill;
        g.fill();
        g.strokeStyle = "rgba(20,24,30,0.9)";
        g.lineWidth = 1;
        g.stroke();
      };
      faces.forEach(([a, b, fill]) => poly([[a[0], a[1], h0], [b[0], b[1], h0], [b[0], b[1], h1], [a[0], a[1], h1]], fill));
      if (cam.h > h1) poly([[f0, r0, h1], [f1, r0, h1], [f1, r1, h1], [f0, r1, h1]], top);
    };
    // the view: a pale wedge on the floor ahead
    const a = W(0.05, 0, 0.002);
    const b = W(0.5, 0.22, 0.002);
    const e = W(0.5, -0.22, 0.002);
    if (a && b && e) {
      g.beginPath();
      g.moveTo(a.x, a.y);
      g.lineTo(b.x, b.y);
      g.lineTo(e.x, e.y);
      g.closePath();
      g.fillStyle = "rgba(255,230,140,0.16)";
      g.fill();
    }
    // the chassis, the wheels, the camera on its mast
    box(-0.16, 0.05, -0.08, 0.08, 0.015, 0.075, "#e9edf2", "#b9c2cc", "#cfd6de");
    box(-0.03, 0.03, 0.08, 0.095, 0, 0.06, "#2a2e34", "#202328", "#2a2e34");
    box(-0.03, 0.03, -0.095, -0.08, 0, 0.06, "#2a2e34", "#202328", "#2a2e34");
    box(-0.015, 0.0, -0.01, 0.01, 0.075, 0.1, "#9aa3ad", "#7d868f", "#9aa3ad");
    box(-0.005, 0.03, -0.025, 0.025, 0.1, 0.125, "#ff8a2a", "#d86a12", "#33373d");
  }

  // -- the timeline ----------------------------------------------------------------------
  function enterStep(i, now) {
    const I = cur;
    I.from = I.last ? { eye: I.last.eye, look: I.last.look } : null;
    I.i = i;
    I.t0 = now;
    I.t = 0;
    const st = I.steps[i];
    const text = L(st.say);
    I.d = st.d || textTime(text);
    I.layer.sub.textContent = text;
    I.layer.sub.parentNode.style.visibility = text ? "visible" : "hidden";
    I.speech = speak(text, I.voice, I.volume);
    I.fired = new Set();
    I.lastPress = 0;
    Lynx.input.fireHeld = false;
    if (I.shieldOn) {
      Lynx.shieldAction("intro", false);
      I.shieldOn = false;
    }
    Lynx.control.setScriptedDrive(null);
    if (st.run) safe(() => st.run(I.ctx));
  }
  function safe(fn) {
    try {
      return fn();
    } catch (e) {
      console.warn("intro:", e);
      return undefined;
    }
  }
  function doAction(a) {
    const what = Array.isArray(a) ? a[0] : a;
    if (typeof what === "function") return safe(() => what(cur.ctx));
    if (what === "fire") Lynx.fireAction();
    else if (what === "jump") Lynx.jumpAction();
    else if (what === "camera") Lynx.cameraAction();
    else if (what === "weapon") Lynx.weaponAction(a[1]);
  }

  function tick(now) {
    const I = cur;
    if (!I || I.lastTick === now) return;
    const dt = I.lastTick ? Math.min(0.1, (now - I.lastTick) / 1000) : 0;
    I.lastTick = now;
    if (I.ending) return;
    I.t = (now - I.t0) / 1000;
    const st = I.steps[I.i];
    I.ctx.t = I.t;
    // the actions due
    (st.at || []).forEach((a, k) => {
      if (I.fired.has(k) || I.t < a[0]) return;
      I.fired.add(k);
      doAction(a.slice(1).length === 1 ? a[1] : a.slice(1));
    });
    if (st.fireHeld) {
      // held: for automatic weapons; and pressed again and again, for the others
      const on = I.t >= st.fireHeld[0] && I.t < st.fireHeld[1];
      Lynx.input.fireHeld = on;
      if (on && (!I.lastPress || I.t - I.lastPress >= 0.45 || I.t < I.lastPress)) {
        I.lastPress = I.t;
        Lynx.fireAction();
      }
    }
    if (st.shield) {
      const on = I.t >= st.shield[0] && I.t < st.shield[1];
      if (on !== !!I.shieldOn) {
        Lynx.shieldAction("intro", on);
        I.shieldOn = on;
      }
    }
    // (the hero's stick, third person: set in applyVirtual, once ar.camTheta is the view's)
    // the player's robot (first person)
    if (st.drive) driveStep(st.drive, dt);
    // progress, and on to the next step
    const total = I.steps.reduce((n, s, k) => n + (k < I.i ? s._d || 0 : 0), 0);
    st._d = I.d;
    I.layer.bar.style.width = `${Math.min(100, ((total + Math.min(I.t, I.d)) / I.estTotal) * 100).toFixed(1)}%`;
    const title = I.layer.el.querySelector(".intro-title");
    if (I.i === 0) title.style.opacity = I.t < 3.2 ? 1 : Math.max(0, 1 - (I.t - 3.2) / 0.6);
    else title.style.opacity = 0;
    const voiceDone = !I.speech || I.speech.done || I.t > I.d + 6;
    if (I.t >= I.d && voiceDone) {
      if (I.i + 1 < I.steps.length) enterStep(I.i + 1, now);
      else finish(false);
    }
  }

  function driveStep(drive, dt) {
    const I = cur;
    const p = I.pose;
    let j1 = 0;
    let j2 = 0;
    let rot = 0;
    let mps = drive.mps || DRIVE_MPS; // (a step can drive faster: a running jump)
    if (typeof drive === "function") {
      const r = safe(() => drive(I.t, I.ctx)) || {};
      ({ j1 = 0, j2 = 0, rot = 0 } = r);
      if (r.mps) mps = r.mps;
    } else if (drive.to) {
      // toward a point: [f, r] of the intro's frame, or fn(ctx) -> {x, y} in the world (or null: wait)
      const w = typeof drive.to === "function" ? safe(() => drive.to(I.ctx)) : I.toWorld(drive.to[0], drive.to[1]);
      if (w && isFinite(w.x)) {
        const want = Math.atan2(w.y - p.y, w.x - p.x);
        const err = wrap(want - p.theta);
        const dist = Math.hypot(w.x - p.x, w.y - p.y);
        rot = Math.max(-90, Math.min(90, (err * 180) / Math.PI * 3));
        j2 = dist > 0.03 ? (drive.speed || 0.8) * Math.max(0, Math.cos(err)) * Math.min(1, dist / 0.1 + 0.3) : 0;
      }
    } else ({ j1 = 0, j2 = 0, rot = 0 } = drive);
    // (the game's walls, as for the real stick)
    const f = Lynx.control.filterDrive(j1, j2);
    if (f) ({ j1, j2 } = f);
    const c = Math.cos(p.theta);
    const s = Math.sin(p.theta);
    p.x += (j2 * c + j1 * s) * mps * dt;
    p.y += (j2 * s - j1 * c) * mps * dt;
    p.theta = wrap(p.theta + ((rot * Math.PI) / 180) * dt);
  }

  function onKey(e) {
    if (!cur) return;
    const t = e.target;
    if (t && t.closest && t.closest(".intro-ctrl") && (e.code === "Space" || e.code === "Enter")) return; // (the focused button / box)
    e.stopImmediatePropagation();
    e.preventDefault();
    if (e.type === "keydown" && !e.repeat && (e.code === "Escape" || e.code === "Enter" || e.code === "NumpadEnter" || e.code === "Space")) finish(true);
  }

  function finish(skipped) {
    const I = cur;
    if (!I || I.ending) return;
    I.ending = true;
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    I.layer.fade.style.opacity = 1;
    setTimeout(() => cleanup(skipped), FADE_S * 1000);
  }

  function cleanup(skipped) {
    const I = cur;
    if (!I) return;
    cur = null;
    Lynx.intro.active = false;
    document.body.classList.remove("intro-playing");
    cancelAnimationFrame(I.raf);
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("keyup", onKey, true);
    if (I.ar) I.ar.virtual = null;
    if (I.restoreCubes) safe(I.restoreCubes);
    if (I.shieldOn) Lynx.shieldAction("intro", false);
    Lynx.input.fireHeld = false;
    Lynx.control.setScriptedDrive(null);
    Lynx.control.hold(false);
    if (I.img) I.img.style.visibility = I.imgVis;
    // the game starts afresh under the black, then the black goes
    safe(() => I.onDone && I.onDone(skipped));
    const el = I.layer.el;
    el.classList.add("intro-gone");
    setTimeout(() => el.remove(), 600);
  }

  Lynx.intro = {
    active: false,
    has: (id) => !!(Lynx.intros && Lynx.intros[id]),
    // opts: {id, ar (null: no AR, a live intro), game, app, onDone(skipped)}
    play(opts) {
      if (cur) cleanup(true);
      const script = Lynx.intros && Lynx.intros[opts.id];
      if (!script) return false;
      const ar = script.live ? null : opts.ar;
      const real = opts.ar ? opts.ar.pose : { x: 0, y: 0, theta: 0 };
      const th = opts.ar ? opts.ar.camTheta : 0;
      const O = { x: real.x, y: real.y, th };
      const I = {
        id: opts.id, script, ar, game: opts.game || {}, onDone: opts.onDone,
        steps: script.steps, i: 0, t: 0, t0: 0, d: 1, O,
        voice: opts.app ? opts.app.general.introVoice !== false : true,
        volume: opts.app ? opts.app.general.volume : 0.6,
        pose: { x: real.x, y: real.y, theta: th, servoAngleDeg: 0, tiltAngleDeg: real.tiltAngleDeg || 0 },
        last: null, from: null, lastTick: 0, ending: false,
      };
      I.estTotal = script.steps.reduce((n, s) => n + (s.d || textTime(L(s.say))), 0);
      I.toWorld = (f, r) => ({ x: O.x + f * Math.cos(O.th) + r * Math.sin(O.th), y: O.y + f * Math.sin(O.th) - r * Math.cos(O.th) });
      I.fromWorld = (x, y) => {
        const dx = x - O.x;
        const dy = y - O.y;
        return { f: dx * Math.cos(O.th) + dy * Math.sin(O.th), r: dx * Math.sin(O.th) - dy * Math.cos(O.th) };
      };
      I.ctx = {
        game: I.game, ar: opts.ar, O, toWorld: I.toWorld, fromWorld: I.fromWorld, pose: I.pose, t: 0,
        // pretend cubes (Knight on Blocks games): [{tag, f, r, yaw (deg), size (m)}] in the intro's frame
        fakeCubes(list) {
          const tb = I.game.debug && I.game.debug.tags && I.game.debug.tags();
          if (!tb) return;
          if (!I.restoreCubes) {
            const own = Object.prototype.hasOwnProperty.call(tb, "blocks");
            const was = tb.blocks;
            I.restoreCubes = () => (own ? (tb.blocks = was) : delete tb.blocks);
          }
          const made = list.map((c, k) => {
            const w = I.toWorld(c.f, c.r);
            const half = (c.size || 0.04) / 2;
            return { id: `intro${k}_${c.tag}`, tag: c.tag, x: w.x, y: w.y, yaw: O.th - ((c.yaw || 0) * Math.PI) / 180, half, h0: c.h0 || 0, h1: (c.h0 || 0) + 2 * half, n: 9, level: 0 };
          });
          tb.blocks = () => made;
        },
      };
      cur = I;
      Lynx.intro.active = true;
      document.body.classList.add("intro-playing");
      I.layer = buildLayer(Lynx.findEntry ? Lynx.findEntry(opts.id) : null, opts);
      I.layer.showVoice();
      Lynx.control.hold(true, () => finish(true));
      window.addEventListener("keydown", onKey, true);
      window.addEventListener("keyup", onKey, true);
      if (ar) {
        I.img = document.getElementById("camStream");
        if (I.img) {
          I.imgVis = I.img.style.visibility;
          I.img.style.visibility = "hidden";
        }
        ar.virtual = { apply: applyVirtual, backdrop, overlay };
      }
      // start play, as Fire on the title screen
      const start = script.start === undefined ? "fire" : script.start;
      if (start === "fire") Lynx.fireAction();
      else if (typeof start === "function") safe(() => start(I.ctx));
      enterStep(0, performance.now());
      // (the clock also runs without a frame from the robot: a live intro, a slow socket)
      const loop = (now) => {
        if (cur !== I) return;
        tick(now);
        I.raf = requestAnimationFrame(loop);
      };
      I.raf = requestAnimationFrame(loop);
      return true;
    },
    skip: () => finish(true),
    // gone at once, without starting the game afresh (another game was picked)
    abort() {
      if (!cur) return;
      cur.onDone = null;
      cleanup(true);
    },
    // (the console: on to step n)
    goto(n) {
      if (cur && n >= 0 && n < cur.steps.length) enterStep(n, performance.now());
    },
    // (the console: what plays now)
    state: () => (cur ? { id: cur.id, step: cur.i, of: cur.steps.length, t: +cur.t.toFixed(2), pose: { ...cur.pose } } : null),
  };
})(window.Lynx);
