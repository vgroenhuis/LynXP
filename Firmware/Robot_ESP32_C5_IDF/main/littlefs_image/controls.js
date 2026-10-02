// Driving from the first-person view: one shared WebSocket to the robot
// (used by the touch joysticks in cam.js AND the keyboard below -- a second
// socket per page was once implicated in a firmware hang, see cam.js's
// subscribeToPose() comment), plus FPS-style keyboard controls:
//
//   W / S        drive forward / back          A / D   strafe left / right
//   Left/Right   turn the camera (and robot)   Up/Down tilt the camera
//   Q / E        same as Left / Right          Shift   half speed
//   Z / Ctrl     fire / action (hold = auto)   1-3     pick weapon
//   Space        jump in games with jumping,   Tab     next weapon
//                else fire / action (like gamepad A; J jumps too)
//   C            camera action (games that have one, e.g. the knight:
//                the robot goes round behind the character; gamepad Y)
//   M            Free drive: switch between the default and the robot drive
//                mode (gamepad Back / Select; see "robot drive mode" below)
// (Ctrl + W is the browser's "close tab", which a page can't block -- Z is
// the safer fire key while driving.)
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
  // Which rate is running on the robot (sent non-zero, no zero after it yet)
  // -- its release must get through even if absolute aim took over meanwhile.
  const rateRunning = { control_frame_rotate: false, tilt_rate: false };

  // A game can keep the robot out of its virtual walls: every drive command
  // (keyboard, gamepad, touch joystick) goes through its filter, which gets
  // the control-frame j1 (right) / j2 (forward) and returns what to send --
  // or null to send nothing at all (a game that drives the robot itself and
  // takes the input for its own character, see driveInput()).
  // refreshDrive() re-sends the last real input through the filter when the
  // filter's answer changed (the robot reached a wall between two resends),
  // but only while that input is still being resent -- never on its own.
  let driveFilter = null;
  let rawDrive = { j1: 0, j2: 0, at: -1e9 };
  let sentDrive = { j1: 0, j2: 0 };
  const round2 = (v) => Math.round(v * 100) / 100;
  function filterDriveOrNull(j1, j2) {
    if (!driveFilter) return { j1, j2 };
    const f = driveFilter(j1, j2);
    return f ? { j1: round2(Math.max(-1, Math.min(1, f.j1))), j2: round2(Math.max(-1, Math.min(1, f.j2))) } : null;
  }
  function sendDrive(obj) {
    const f = filterDriveOrNull(Number(obj.j1) || 0, Number(obj.j2) || 0);
    if (!f) return; // the game keeps this input for itself
    sentDrive = f;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ ...obj, j1: f.j1, j2: f.j2 }));
  }

  // -- robot drive mode (Free drive only) ------------------------------------
  // The default drive mode works in the camera's frame: the left stick moves
  // the robot toward where the camera looks (strafing), the right stick turns
  // and tilts the camera at a rate, and the camera keeps its heading while
  // the chassis turns under it. The robot mode works in the CHASSIS frame:
  // the left stick drives it like a car (up/down = forward/back, left/right =
  // turn on the spot) and the right stick points the camera relative to the
  // chassis -- absolutely: released, the camera looks straight ahead and
  // level; held, left/right set the pan (full = ROBOT_CAM_PAN_DEG to that side) and
  // up/down the tilt (full = ROBOT_CAM_TILT_DEG up / down) -- and it turns
  // with the robot. Sent as "joystick" (tank drive) and "camera_relative"
  // (pan to the chassis + tilt, resent every ROBOT_CAM_SEND_MS; the robot
  // falls back to the default behaviour within half a second of it stopping).
  // The camera doesn't jump to the stick's angle: it moves there at the
  // default mode's rates (panMaxSpeedDegPerSec / tiltMaxSpeedDegPerSec) --
  // both servos slamming across at full speed at once dipped the supply
  // enough to upset the flash (CPU lockup, then "SPI flash busy" boot loops
  // until a power cycle; it happened three times with only the servos moving).
  const ROBOT_TURN_GAIN = 0.4; // full left/right = 40% of the wheels' top speed, opposite ways (~100 deg/s)
  const ROBOT_CAM_DEADZONE = 0.08; // per axis, around the stick's centre
  const ROBOT_CAM_TILT_DEG = 60;
  // Full left/right pan. Not the servo's whole +-90: at full left it went past
  // 90 (calibration) and the robot froze twice there -- a stalled servo's
  // current dipping the supply is the suspect.
  const ROBOT_CAM_PAN_DEG = 80;
  // full deflection: keyboard / gamepad send the look axes scaled by TURN_SPEED / TILT_SPEED (below), touch up to 1
  const ROBOT_CAM_FULL_ROT = 0.7;
  const ROBOT_CAM_FULL_TILT = 0.8;
  const ROBOT_CAM_SEND_MS = 100; // keep-alive
  const ROBOT_CAM_TICK_MS = 40; // steps while the camera moves
  // deg/s: the robot's panMaxSpeedDegPerSec / tiltMaxSpeedDegPerSec (cam.js passes them in once loaded)
  const camRates = { pan: 300, tilt: 300 };
  const DRIVE_MODE_KEY = "camDriveMode";
  let robotModeOn = false;
  try {
    robotModeOn = localStorage.getItem(DRIVE_MODE_KEY) === "robot";
  } catch (e) {
    // (storage blocked: the default mode)
  }
  let robotModeAllowed = false; // only in Free drive (games steer the camera and drive themselves)
  const camStick = { rot: 0, tilt: 0, rotAt: -1e9, tiltAt: -1e9 };
  let camTimer = null;
  let lastCam = null; // what was last sent, and when
  let camCmd = null; // where the camera is being moved to now: {pan, tilt, at}
  // the servos' angles as the robot reports them (where the camera starts from)
  const servoNow = { pan: 0, tilt: 0 };
  const robotMode = () => robotModeOn && robotModeAllowed;
  const modeListeners = [];
  // From the right stick: the camera's pan to the chassis (deg, positive =
  // left) and tilt (deg, positive = up).
  function robotCam() {
    const now = performance.now();
    const rot = now - camStick.rotAt < 1000 ? camStick.rot : 0; // (held input is resent; 1 s silent = released)
    const tilt = now - camStick.tiltAt < 1000 ? camStick.tilt : 0;
    const axis = (v, full) => (Math.abs(v) < ROBOT_CAM_DEADZONE ? 0 : Math.max(-1, Math.min(1, v / full)));
    const tenth = (v) => Math.round(v * 10) / 10;
    return { pan: tenth(axis(rot, ROBOT_CAM_FULL_ROT) * ROBOT_CAM_PAN_DEG), tilt: tenth(axis(tilt, ROBOT_CAM_FULL_TILT) * ROBOT_CAM_TILT_DEG) };
  }
  // Each tick: the robot gets the stick's angles (sent when they change,
  // else every ROBOT_CAM_SEND_MS to keep the mode) and eases the servos
  // there itself, every 20 ms at the same rates as here -- camCmd follows
  // along for the view.
  function sendRobotCam() {
    const now = performance.now();
    const want = robotCam();
    if (!camCmd) camCmd = { pan: servoNow.pan, tilt: servoNow.tilt, at: now };
    const dt = Math.min(0.2, (now - camCmd.at) / 1000);
    camCmd.at = now;
    const toward = (v, w, rate) => v + Math.max(-rate * dt, Math.min(rate * dt, w - v));
    camCmd.pan = toward(camCmd.pan, want.pan, camRates.pan);
    camCmd.tilt = toward(camCmd.tilt, want.tilt, camRates.tilt);
    if (!ws || ws.readyState !== WebSocket.OPEN || document.hidden) return;
    const c = want;
    if (lastCam && c.pan === lastCam.pan && c.tilt === lastCam.tilt && now - lastCam.at < ROBOT_CAM_SEND_MS) return;
    lastCam = { ...c, at: now };
    ws.send(JSON.stringify({ type: "camera_relative", pan: c.pan, tilt: c.tilt }));
  }
  let wasRobotMode = false;
  function applyDriveMode() {
    const on = robotMode();
    modeListeners.forEach((cb) => cb(Lynx.control.driveMode()));
    if (on === wasRobotMode) return;
    wasRobotMode = on;
    if (on && camTimer === null) {
      lastCam = null;
      camCmd = null; // (from where the servos are)
      camTimer = setInterval(sendRobotCam, ROBOT_CAM_TICK_MS);
      sendRobotCam();
    } else if (!on && camTimer !== null) {
      clearInterval(camTimer);
      camTimer = null;
    }
    // stop whatever the other mode was doing
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: on ? "control_joystick" : "joystick", j1: 0, j2: 0 }));
      ws.send(JSON.stringify({ type: "control_frame_rotate", value: 0 }));
      ws.send(JSON.stringify({ type: "tilt_rate", value: 0 }));
    }
    Object.assign(camStick, { rot: 0, tilt: 0 });
    Object.assign(aimInput, { rot: 0, tilt: 0 });
  }

  messageListeners.set("pose", [
    (m) => {
      if (typeof m.servoAngleDeg === "number") servoNow.pan = m.servoAngleDeg;
      if (typeof m.tiltAngleDeg === "number") servoNow.tilt = m.tiltAngleDeg;
    },
  ]);

  Lynx.control = {
    send(obj) {
      ensureStarted();
      if (robotMode() && obj.type === "control_joystick") {
        const j1 = Number(obj.j1) || 0;
        const j2 = Number(obj.j2) || 0;
        rawDrive = { j1, j2, at: performance.now() };
        if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "joystick", j1: round2(j1 * ROBOT_TURN_GAIN), j2: round2(j2) }));
        return;
      }
      if (robotMode() && (obj.type === "control_frame_rotate" || obj.type === "tilt_rate")) {
        const v = Math.max(-1, Math.min(1, Number(obj.value) || 0));
        if (obj.type === "control_frame_rotate") Object.assign(camStick, { rot: v, rotAt: performance.now() });
        else Object.assign(camStick, { tilt: v, tiltAt: performance.now() });
        return; // (the tick moves the camera there)
      }
      if (obj.type === "control_joystick") {
        rawDrive = { j1: Number(obj.j1) || 0, j2: Number(obj.j2) || 0, at: performance.now() };
        sendDrive(obj);
        return;
      }
      const v = Math.max(-1, Math.min(1, Number(obj.value) || 0));
      const isAimRate = obj.type === "control_frame_rotate" || obj.type === "tilt_rate";
      if (obj.type === "control_frame_rotate") Object.assign(aimInput, { rot: v, rotAt: performance.now() });
      else if (obj.type === "tilt_rate") Object.assign(aimInput, { tilt: v, tiltAt: performance.now() });
      // Absolute aim (the camera page, see cam.js stepAim()): the rates stay
      // here and the page sends where to point instead.
      if (isAimRate && Lynx.control.absoluteAim() && !(v === 0 && rateRunning[obj.type])) return;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
        if (isAimRate) rateRunning[obj.type] = v !== 0;
      }
    },
    aimInput,
    absoluteAim: () => false, // cam.js replaces this once it can aim
    setDriveFilter(fn) {
      driveFilter = fn;
      Lynx.control.refreshDrive();
    },
    refreshDrive() {
      if (performance.now() - rawDrive.at > 1000) return; // the input stopped: the robot's own watchdog stops it
      const f = filterDriveOrNull(rawDrive.j1, rawDrive.j2);
      if (f && (f.j1 !== sentDrive.j1 || f.j2 !== sentDrive.j2)) sendDrive({ type: "control_joystick", j1: rawDrive.j1, j2: rawDrive.j2 });
    },
    // The drive input as given (keyboard, gamepad, touch joystick; before any
    // filter): j1 right, j2 forward. Zero once it hasn't been resent for a
    // second (held input is resent every ~150 ms, release sends zero).
    driveInput() {
      if (performance.now() - rawDrive.at > 1000) return { j1: 0, j2: 0 };
      return { j1: rawDrive.j1, j2: rawDrive.j2 };
    },
    start: ensureStarted,
    // The drive mode: "default" (camera frame) or "robot" (chassis frame, see
    // above). The robot mode is a preference that only applies where allowed.
    driveMode: () => (robotModeOn ? "robot" : "default"),
    robotModeActive: robotMode,
    robotModeAllowed: () => robotModeAllowed,
    setDriveMode(mode) {
      robotModeOn = mode === "robot";
      try {
        localStorage.setItem(DRIVE_MODE_KEY, robotModeOn ? "robot" : "default");
      } catch (e) {
        // (not remembered)
      }
      applyDriveMode();
    },
    toggleDriveMode() {
      if (!robotModeAllowed) return;
      Lynx.control.setDriveMode(robotModeOn ? "default" : "robot");
    },
    setRobotModeAllowed(allowed) {
      if (robotModeAllowed === allowed) return;
      robotModeAllowed = allowed;
      applyDriveMode();
    },
    onDriveModeChange: (cb) => modeListeners.push(cb),
    setRobotCamRates(panDegPerSec, tiltDegPerSec) {
      if (panDegPerSec > 0) camRates.pan = panDegPerSec;
      if (tiltDegPerSec > 0) camRates.tilt = tiltDegPerSec;
    },
    // In the robot mode: the camera's angle to the chassis (rad, positive = left); else null.
    robotCamPanRad: () => (robotMode() && camCmd ? (camCmd.pan * Math.PI) / 180 : null),
    robotCamTiltDeg: () => (robotMode() && camCmd ? camCmd.tilt : null),
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
  const listeners = { fire: [], weapon: [], jump: [], camera: [] };

  Lynx.onAction = (name, cb) => listeners[name].push(cb);
  Lynx.clearActions = () => Object.values(listeners).forEach((l) => (l.length = 0));
  Lynx.fireAction = () => listeners.fire.forEach((cb) => cb());
  // Virtual jump (Space / J, gamepad A/B, or a game's touch button) -- only games
  // that support it listen. A listener returns whether jumping applies right
  // now (e.g. playing, not on a title screen); jumpAction() returns whether
  // any did, so gamepad A can fall back to fire when it doesn't.
  Lynx.jumpAction = () => listeners.jump.map((cb) => !!cb()).some(Boolean);
  // Camera action (C, gamepad Y, or a game's touch button), for games that
  // steer the camera themselves.
  Lynx.cameraAction = () => listeners.camera.forEach((cb) => cb());
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
  // The look axes keep the stick's full resolution (Hall-effect sticks like
  // the GameSir G8's are precise; in the robot drive mode they set the camera
  // angle directly, where 5% steps were 4 deg jumps). Still rounded a little
  // so sensor noise at rest doesn't count as a change.
  const quantizeFine = (v) => Math.round(v * 1000) / 1000;

  function computeAndSend(force) {
    const slow = held.has("ShiftLeft") || held.has("ShiftRight") || pad.slow ? 0.5 : 1;
    const cmd = {
      j1: quantize(clamp1(axis("KeyA", "KeyD") * DRIVE_SPEED + pad.j1) * slow),
      j2: quantize(clamp1(axis("KeyS", "KeyW") * DRIVE_SPEED + pad.j2) * slow),
      // Rotate is positive to the LEFT, matching the right touch joystick's mapping.
      rot: quantizeFine(clamp1((axis("ArrowRight", "ArrowLeft") + axis("KeyE", "KeyQ")) * TURN_SPEED + pad.rot) * slow),
      tilt: quantizeFine(clamp1(axis("ArrowDown", "ArrowUp") * TILT_SPEED + pad.tilt) * slow),
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

  const FIRE_KEYS = new Set(["KeyZ", "ControlLeft", "ControlRight"]);
  const fireKeysDown = new Set(); // fire keys held (plus "Space" while it's firing rather than jumping)
  let spaceFires = false;
  const updateFireHeld = () => (Lynx.input.fireHeld = fireKeysDown.size > 0);

  Lynx.enableKeyboardControls = () => {
    window.addEventListener("keydown", (e) => {
      if (isTyping(e) || e.metaKey || e.altKey) return;
      if (FIRE_KEYS.has(e.code)) {
        e.preventDefault();
        Lynx.sfx.unlock();
        fireKeysDown.add(e.code);
        updateFireHeld();
        if (!e.repeat) Lynx.fireAction();
        return;
      }
      // Ctrl is a fire key, so driving has to work with it held -- but any
      // other Ctrl combination stays the browser's.
      if (e.ctrlKey && !MOVEMENT_KEYS.has(e.code)) return;
      Lynx.sfx.unlock();
      if (e.code === "Space") {
        // Jump where jumping applies; otherwise fire / action (title
        // screens, games without jumping) -- same as gamepad A.
        e.preventDefault();
        if (!e.repeat) {
          spaceFires = !Lynx.jumpAction();
          if (spaceFires) {
            fireKeysDown.add("Space");
            updateFireHeld();
            Lynx.fireAction();
          }
        }
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
      if (e.code === "KeyC") {
        if (!e.repeat) Lynx.cameraAction();
        return;
      }
      if (e.code === "KeyM") {
        if (!e.repeat) Lynx.control.toggleDriveMode();
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
      if (FIRE_KEYS.has(e.code) || e.code === "Space") {
        fireKeysDown.delete(e.code);
        if (e.code === "Space") spaceFires = false;
        updateFireHeld();
      }
      if (held.delete(e.code)) computeAndSend(false);
    });
    // Letting go of everything if focus leaves mid-press -- otherwise the
    // keyup never arrives and the robot keeps driving on the last heartbeat.
    const releaseAll = () => {
      fireKeysDown.clear();
      spaceFires = false;
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
  const BTN = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };
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
    if (justDown(BTN.Y)) Lynx.cameraAction();
    if (justDown(BTN.BACK)) Lynx.control.toggleDriveMode();
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
