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

  function connect() {
    ws = new WebSocket(`ws://${location.host}/ws`);
    connectStartedAtMs = Date.now();
    ws.onopen = () => (lastMessageAtMs = Date.now());
    ws.onmessage = () => (lastMessageAtMs = Date.now());
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

  Lynx.control = {
    send(obj) {
      ensureStarted();
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
    },
    start: ensureStarted,
  };

  // -- keyboard ---------------------------------------------------------------
  const DRIVE_SPEED = 0.8;
  const TURN_SPEED = 0.7;
  const TILT_SPEED = 0.8;
  const HEARTBEAT_MS = 150;

  const held = new Set();
  let heartbeat = null;
  let lastSent = { j1: 0, j2: 0, rot: 0, tilt: 0 };
  const listeners = { fire: [], weapon: [] };

  Lynx.onAction = (name, cb) => listeners[name].push(cb);
  Lynx.clearActions = () => Object.values(listeners).forEach((l) => (l.length = 0));
  Lynx.fireAction = () => listeners.fire.forEach((cb) => cb());
  // True while Space / the on-screen action button is held -- for
  // automatic weapons. Presses still go through fireAction() too.
  Lynx.input = { fireHeld: false };

  function axis(neg, pos) {
    return (held.has(pos) ? 1 : 0) - (held.has(neg) ? 1 : 0);
  }

  function computeAndSend(force) {
    const slow = held.has("ShiftLeft") || held.has("ShiftRight") ? 0.5 : 1;
    const cmd = {
      j1: axis("KeyA", "KeyD") * DRIVE_SPEED * slow,
      j2: axis("KeyS", "KeyW") * DRIVE_SPEED * slow,
      // Rotate is positive to the LEFT, matching the right touch joystick's mapping.
      rot: (axis("ArrowRight", "ArrowLeft") + axis("KeyE", "KeyQ")) * TURN_SPEED * slow,
      tilt: axis("ArrowDown", "ArrowUp") * TILT_SPEED * slow,
    };
    cmd.rot = Math.max(-1, Math.min(1, cmd.rot));
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
  };
})(window.Lynx);
