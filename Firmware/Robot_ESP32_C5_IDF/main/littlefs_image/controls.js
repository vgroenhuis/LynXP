// Driving from the first-person view: one shared WebSocket to the robot
// (used by the touch joysticks in cam.js AND the keyboard below -- a second
// socket per page was once implicated in a firmware hang, see cam.js's
// subscribeToPose() comment), plus FPS-style keyboard controls:
//
//   W / S        drive forward / back          A / D   strafe left / right
//   Left/Right   turn the camera (and robot)   Up/Down tilt the camera
//   Q / E        same as Left / Right          Shift   half speed
//   Space        fire / action                 1-3     pick weapon
//   Tab          next weapon
//
// and a gamepad (Gamepad API, "standard" layout -- e.g. a GameSir G8 phone
// controller): left stick drives/strafes, right stick turns/tilts the
// camera (D-pad too), RT / X / Start fire, A jumps (B too) in games with
// jumping and fires otherwise (also on title/game-over screens, to start),
// LB / RB previous / next weapon, LT held = half speed. Both inputs add up,
// so either can be used any time.
//
// Drive/look commands use exactly the same messages as the joysticks
// ("control_joystick", "control_frame_rotate", "tilt_rate"), resent every
// HEARTBEAT_MS while held and zeroed on release or when the tab loses focus.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  // -- shared control socket -------------------------------------------------
  let ws = null;
  let lastMessageAtMs = 0;
  let connectStartedAtMs = 0;
  let reconnectTimer = null;
  let started = false;
  const messageListeners = new Map(); // telemetry type -> callbacks (e.g. "pose")

  function connect() {
    ws = new WebSocket(`ws://${location.host}/ws`);
    connectStartedAtMs = Date.now();
    ws.onopen = () => (lastMessageAtMs = Date.now());
    ws.onmessage = (ev) => {
      lastMessageAtMs = Date.now();
      if (!messageListeners.size || typeof ev.data !== "string") return;
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      (messageListeners.get(msg.type) || []).forEach((cb) => cb(msg));
    };
    ws.onclose = () => {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 250);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch (e) {
        // onclose handles the retry
      }
    };
  }

  // The robot broadcasts telemetry several times a second to every client,
  // so a silent-but-"open" socket is a dead one (same watchdog as app.js).
  function forceReconnect() {
    clearTimeout(reconnectTimer);
    if (ws) {
      const dead = ws;
      ws = null;
      dead.onopen = dead.onclose = dead.onerror = dead.onmessage = null;
      try {
        dead.close();
      } catch (e) {
        // discarding it either way
      }
    }
    connect();
  }

  function ensureStarted() {
    if (started) return;
    started = true;
    connect();
    setInterval(() => {
      if (!ws) return;
      const now = Date.now();
      if (ws.readyState === WebSocket.CONNECTING && now - connectStartedAtMs > 3000) forceReconnect();
      else if (ws.readyState === WebSocket.OPEN && now - lastMessageAtMs > 1000) forceReconnect();
    }, 300);
  }

  // The camera turn / tilt rates last sent (raw [-1,1], when), whoever sent
  // them (keyboard, gamepad, touch joysticks): the camera page's smooth-aim
  // view integrates these the same way the robot does.
  const aimInput = { rot: 0, tilt: 0, rotAt: 0, tiltAt: 0 };

  Lynx.control = {
    send(obj) {
      ensureStarted();
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(obj));
      const v = Math.max(-1, Math.min(1, Number(obj.value) || 0));
      if (obj.type === "control_frame_rotate") Object.assign(aimInput, { rot: v, rotAt: performance.now() });
      else if (obj.type === "tilt_rate") Object.assign(aimInput, { tilt: v, tiltAt: performance.now() });
    },
    aimInput,
    start: ensureStarted,
    // Robot telemetry arriving on this same socket, e.g. onMessage("pose", cb).
    onMessage(type, cb) {
      if (!messageListeners.has(type)) messageListeners.set(type, []);
      messageListeners.get(type).push(cb);
      ensureStarted();
    },
  };

  // -- keyboard ---------------------------------------------------------------
  const DRIVE_SPEED = 0.8;
  const TURN_SPEED = 0.7;
  const TILT_SPEED = 0.8;
  const HEARTBEAT_MS = 150;

  const held = new Set();
  let heartbeat = null;
  let lastSent = { j1: 0, j2: 0, rot: 0, tilt: 0 };
  const listeners = { fire: [], weapon: [], jump: [] };

  Lynx.onAction = (name, cb) => listeners[name].push(cb);
  Lynx.clearActions = () => Object.values(listeners).forEach((l) => (l.length = 0));
  Lynx.fireAction = () => listeners.fire.forEach((cb) => cb());
  // Virtual jump (J key, gamepad A/B, or a game's touch button) -- only games
  // that support it listen. A listener returns whether jumping applies right
  // now (e.g. playing, not on a title screen); jumpAction() returns whether
  // any did, so gamepad A can fall back to fire when it doesn't.
  Lynx.jumpAction = () => listeners.jump.map((cb) => !!cb()).some(Boolean);
  // True while Space / the on-screen action button is held -- for
  // automatic weapons. Presses still go through fireAction() too.
  Lynx.input = { fireHeld: false };

  function axis(neg, pos) {
    return (held.has(pos) ? 1 : 0) - (held.has(neg) ? 1 : 0);
  }

  const clamp1 = (v) => Math.max(-1, Math.min(1, v));
  // Analog stick values are rounded so tiny jitter doesn't turn into a
  // stream of "changed" commands.
  const quantize = (v) => Math.round(v * 20) / 20;

  function computeAndSend(force) {
    const slow = held.has("ShiftLeft") || held.has("ShiftRight") || pad.slow ? 0.5 : 1;
    const cmd = {
      j1: quantize(clamp1(axis("KeyA", "KeyD") * DRIVE_SPEED + pad.j1) * slow),
      j2: quantize(clamp1(axis("KeyS", "KeyW") * DRIVE_SPEED + pad.j2) * slow),
      // Rotate is positive to the LEFT, matching the right touch joystick's mapping.
      rot: quantize(clamp1((axis("ArrowRight", "ArrowLeft") + axis("KeyE", "KeyQ")) * TURN_SPEED + pad.rot) * slow),
      tilt: quantize(clamp1(axis("ArrowDown", "ArrowUp") * TILT_SPEED + pad.tilt) * slow),
    };
    const driveChanged = cmd.j1 !== lastSent.j1 || cmd.j2 !== lastSent.j2;
    const lookChanged = cmd.rot !== lastSent.rot || cmd.tilt !== lastSent.tilt;
    const driving = cmd.j1 !== 0 || cmd.j2 !== 0;
    const looking = cmd.rot !== 0 || cmd.tilt !== 0;
    if (driveChanged || (force && driving)) Lynx.control.send({ type: "control_joystick", j1: cmd.j1, j2: cmd.j2 });
    if (lookChanged || (force && looking)) {
      Lynx.control.send({ type: "control_frame_rotate", value: cmd.rot });
      Lynx.control.send({ type: "tilt_rate", value: cmd.tilt });
    }
    lastSent = cmd;
    if ((driving || looking) && heartbeat === null) {
      heartbeat = setInterval(() => computeAndSend(true), HEARTBEAT_MS);
    } else if (!driving && !looking && heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  }

  const MOVEMENT_KEYS = new Set([
    "KeyW", "KeyA", "KeyS", "KeyD", "KeyQ", "KeyE", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight",
  ]);

  function isTyping(e) {
    const t = e.target;
    return t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable);
  }

  Lynx.enableKeyboardControls = () => {
    window.addEventListener("keydown", (e) => {
      if (isTyping(e) || e.ctrlKey || e.metaKey || e.altKey) return;
      Lynx.sfx.unlock();
      if (e.code === "Space") {
        e.preventDefault();
        Lynx.input.fireHeld = true;
        if (!e.repeat) Lynx.fireAction();
        return;
      }
      if (/^Digit[1-9]$/.test(e.code)) {
        listeners.weapon.forEach((cb) => cb(Number(e.code.slice(5))));
        return;
      }
      if (e.code === "KeyJ") {
        if (!e.repeat) Lynx.jumpAction();
        return;
      }
      if (e.code === "Tab") {
        e.preventDefault();
        listeners.weapon.forEach((cb) => cb("next"));
        return;
      }
      if (!MOVEMENT_KEYS.has(e.code)) return;
      e.preventDefault(); // arrows would otherwise scroll
      if (!held.has(e.code)) {
        held.add(e.code);
        computeAndSend(false);
      }
    });
    window.addEventListener("keyup", (e) => {
      if (e.code === "Space") Lynx.input.fireHeld = false;
      if (held.delete(e.code)) computeAndSend(false);
    });
    // Letting go of everything if focus leaves mid-press -- otherwise the
    // keyup never arrives and the robot keeps driving on the last heartbeat.
    const releaseAll = () => {
      Lynx.input.fireHeld = false;
      if (held.size === 0) return;
      held.clear();
      computeAndSend(false);
    };
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", () => document.hidden && releaseAll());
    Lynx.control.start();
    enableGamepad();
  };

  // -- gamepad ------------------------------------------------------------------
  const PAD_POLL_MS = 50;
  const DEADZONE = 0.15;
  // Standard-layout button indices (https://w3c.github.io/gamepad/#remapping).
  const BTN = { A: 0, B: 1, X: 2, LB: 4, RB: 5, LT: 6, RT: 7, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
  const FIRE_BUTTONS = [BTN.RT, BTN.X, BTN.START];

  const pad = { j1: 0, j2: 0, rot: 0, tilt: 0, slow: false };
  let padIndex = null;
  let padPoll = null;
  let prevPressed = [];
  let padFireHeld = false;
  let aFires = false; // this A press went to fire (no jumping right now), so holding it auto-fires

  // What the page can tell about gamepad support, for the status line on the
  // camera page: "unsupported" (no Gamepad API at all), "waiting" (API there,
  // no pad seen yet -- browsers only reveal one after a button press),
  // "connected". insecure = page isn't a secure context; some browsers hide
  // gamepads from plain-http pages, and the robot can only serve http.
  Lynx.gamepad = {
    state: typeof navigator.getGamepads === "function" ? "waiting" : "unsupported",
    id: "",
    insecure: !window.isSecureContext,
    onChange: null,
  };
  const notify = () => Lynx.gamepad.onChange && Lynx.gamepad.onChange(Lynx.gamepad);

  function deadzone(v) {
    const a = Math.abs(v);
    return a < DEADZONE ? 0 : (Math.sign(v) * (a - DEADZONE)) / (1 - DEADZONE);
  }

  function readPad() {
    let pads = [];
    try {
      pads = navigator.getGamepads() || [];
    } catch (e) {
      return null; // e.g. blocked by permissions policy
    }
    if (padIndex !== null && pads[padIndex] && pads[padIndex].connected) return pads[padIndex];
    const found = Array.from(pads).find((g) => g && g.connected);
    return found || null;
  }

  function releasePad() {
    Object.assign(pad, { j1: 0, j2: 0, rot: 0, tilt: 0, slow: false });
    if (padFireHeld) Lynx.input.fireHeld = false;
    padFireHeld = false;
    prevPressed = [];
    computeAndSend(false);
  }

  function pollPad() {
    const g = document.hidden ? null : readPad();
    if (!g) {
      if (padIndex !== null) {
        padIndex = null;
        Lynx.gamepad.state = "waiting";
        Lynx.gamepad.id = "";
        releasePad();
        notify();
      }
      return;
    }
    if (padIndex !== g.index) {
      padIndex = g.index;
      Lynx.gamepad.state = "connected";
      Lynx.gamepad.id = g.id;
      notify();
    }

    const pressed = g.buttons.map((b) => b.pressed || b.value > 0.5);
    const down = (i) => !!pressed[i];
    const justDown = (i) => down(i) && !prevPressed[i];
    if (pressed.some((p, i) => p && !prevPressed[i])) Lynx.sfx.unlock();

    const ax = (i) => deadzone(g.axes[i] || 0);
    const dpad = (neg, pos) => (down(pos) ? 1 : 0) - (down(neg) ? 1 : 0);
    pad.j1 = ax(0) * DRIVE_SPEED;
    pad.j2 = -ax(1) * DRIVE_SPEED;
    pad.rot = clamp1(-ax(2) + dpad(BTN.RIGHT, BTN.LEFT)) * TURN_SPEED;
    pad.tilt = clamp1(-ax(3) + dpad(BTN.DOWN, BTN.UP)) * TILT_SPEED;
    pad.slow = down(BTN.LT);
    computeAndSend(false);

    // A: jump where jumping applies, otherwise the classic fire / action
    if (justDown(BTN.A)) {
      aFires = !Lynx.jumpAction();
      if (aFires) Lynx.fireAction();
    }
    if (!down(BTN.A)) aFires = false;
    const fireDown = FIRE_BUTTONS.some(down) || aFires;
    if (FIRE_BUTTONS.some(justDown)) Lynx.fireAction();
    if (fireDown !== padFireHeld) {
      padFireHeld = fireDown;
      Lynx.input.fireHeld = fireDown;
    }
    if (justDown(BTN.RB)) listeners.weapon.forEach((cb) => cb("next"));
    if (justDown(BTN.LB)) listeners.weapon.forEach((cb) => cb("prev"));
    if (justDown(BTN.B)) Lynx.jumpAction(); // the old jump button, still works
    prevPressed = pressed;
  }

  function enableGamepad() {
    if (Lynx.gamepad.state === "unsupported" || padPoll !== null) return;
    // Cheap enough to just poll; gamepadconnected only fires after the
    // first button press anyway, and not at all in some browsers.
    padPoll = setInterval(pollPad, PAD_POLL_MS);
    window.addEventListener("gamepadconnected", pollPad);
    window.addEventListener("gamepaddisconnected", pollPad);
    notify();
  }
})(window.Lynx);
