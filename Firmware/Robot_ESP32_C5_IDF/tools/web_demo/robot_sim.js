// LynXP web demo: a stand-in for the robot, so the robot's own web pages run
// in a browser without one (GitHub Pages, tools/web_demo/build.py). Loaded
// first on every page. It answers what the robot's web server would:
//   - fetch(): /params (the firmware's defaults), /set, /pose, /pose_reset,
//     /camdiag, /waypoints, /appdata/* (settings, scores, tags, camcal...:
//     kept in this browser's localStorage), the rest: 503 "not in the demo"
//   - the WebSocket (/ws): a simulated robot -- it drives from the drive
//     commands (joystick, control_joystick), turns its camera from the aim
//     commands (aim, control_frame_rotate, tilt_rate, camera_relative) and
//     broadcasts its pose ten times a second, answers pings
//   - the camera stream (http://<cam>:81/stream): a plain grey frame -- the
//     first-person view draws a tiled floor instead (cam.js, in demo mode),
//     through the same projection as its overlays, so driving and turning
//     look right
// There are no real cubes: the tag detector finds nothing.

(function () {
  "use strict";
  const DEMO = (window.LYNX_DEMO = { robot: null });

  // -- the robot's settings: the firmware's defaults (settings.cpp), /set changes them ---------
  const PARAMS = {
    loggingEnabled: false, debugWeb: false, dataLogRate: 10, mode: 0, logType: 0, logUnit: 0, kp: 1, ki: 0, kd: 0,
    differentiatorCutoffHz: 10, motorPower: 1000, wheelbaseMm: 170, wheelDiameterMm: 65, telemetryHz: 10,
    motorDeadzonePwm: 300, gotoSpeedGain: 10, maxWheelSpeedRevPerSec: 1.8, maxAccelRevPerSec2: 5, maxDecelRevPerSec2: 5,
    gotoVelKp: 1500, gotoVelKi: 1000, feedForwardPwmPerRevPerSec: 0.53, gotoAllowReverse: true, gotoPreserveHeading: false,
    controlFrameAllowReverse: true, servoFollowControlFrame: true, controlFrameRotationStrategy: 1,
    servoMinPulseUs: 530, servoMaxPulseUs: 2410, servoCenterPulseUs: 1465, servoMinAngleDeg: -90, servoMaxAngleDeg: 90,
    servoMaxRotationRateDegPerSec: 270, servoAssistMarginDeg: 45, panMaxSpeedDegPerSec: 180, tiltMaxSpeedDegPerSec: 120,
    cameraJoystickCurve: 1, tiltMinPulseUs: 2250, tiltMaxPulseUs: 550, tiltCenterPulseUs: 1370, tiltMinAngleDeg: -90,
    tiltMaxAngleDeg: 90, cameraHeightMm: 100, cameraTiltDeg: 0, cameraVerticalFovDeg: 65,
    lastRebootWasWatchdog: false, lastRebootReason: "demo", lastHangCore0Checkpoint: "", lastHangCore1Checkpoint: "",
    lastHangWsMessage: "", lastHangCore1Ticks: 0, lastHangConnCount: 0, lastHangWsConnCount: 0, lastResetDetail: "",
    otaUsername: "admin", otaPasswordSet: false, panTableUs: [], tiltTableUs: [], panBacklashDeg: 0, tiltBacklashDeg: 0, panKickDeg: 0, tiltKickDeg: 0,
  };
  const store = {
    get(k) {
      try {
        return localStorage.getItem("lynxDemo:" + k);
      } catch (e) {
        return null;
      }
    },
    set(k, v) {
      try {
        localStorage.setItem("lynxDemo:" + k, v);
      } catch (e) {
        // (not kept)
      }
    },
  };
  try {
    Object.assign(PARAMS, JSON.parse(store.get("params") || "{}"));
  } catch (e) {
    // (the defaults)
  }

  // -- the simulated robot ---------------------------------------------------------------------
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const R = (DEMO.robot = {
    x: 0, y: 0, theta: 0, ct: 0, tilt: 0, pan: 0, v: 0, w: 0,
    drive: null, driveAt: -1e9, // {kind, j1, j2}
    rot: 0, rotAt: -1e9, tiltRate: 0, tiltAt: -1e9, rel: null, relAt: -1e9,
  });
  const vmax = () => PARAMS.maxWheelSpeedRevPerSec * Math.PI * (PARAMS.wheelDiameterMm / 1000);
  const curve = (v) => (Math.abs(v) < 0.03 ? 0 : PARAMS.cameraJoystickCurve === 1 ? Math.sign(v) * v * v : v);
  let lastStep = performance.now();
  function step() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastStep) / 1000);
    lastStep = now;
    // the camera's direction (the control frame) and tilt, from rate input
    if (now - R.rotAt < 500 && R.rot) R.ct = wrap(R.ct + (curve(R.rot) * PARAMS.panMaxSpeedDegPerSec * Math.PI) / 180 * dt);
    if (now - R.tiltAt < 500 && R.tiltRate) R.tilt = clamp(R.tilt + curve(R.tiltRate) * PARAMS.tiltMaxSpeedDegPerSec * dt, -60, 60);
    // driving: wheel speed targets as the firmware sets them (control_modes.cpp), as fractions of the top speed
    let tl = 0;
    let tr = 0;
    const d = now - R.driveAt < 600 ? R.drive : null;
    if (d && d.kind === "joystick") {
      tl = d.j2 + d.j1; // (ws_broadcast.cpp: V1[0] = j2 + j1, V1[1] = j2 - j1)
      tr = d.j2 - d.j1;
    } else if (d && d.kind === "control") {
      // controlFrameJoystickControl + driveTowardWorldDirection: the camera frame's joystick turned
      // into the world, then into the chassis's forward / left; which face drives: FIXED_HEMISPHERE
      // (ahead of the camera: forward) or the closer face
      const jx = d.j2;
      const jy = -d.j1;
      const wx = jx * Math.cos(R.ct) - jy * Math.sin(R.ct);
      const wy = jx * Math.sin(R.ct) + jy * Math.cos(R.ct);
      const fwd = wx * Math.cos(R.theta) + wy * Math.sin(R.theta);
      const left = -wx * Math.sin(R.theta) + wy * Math.cos(R.theta);
      const ahead = PARAMS.controlFrameRotationStrategy === 1 ? wx * Math.cos(R.ct) + wy * Math.sin(R.ct) >= 0 : fwd >= 0;
      if (ahead) {
        tl = fwd - left;
        tr = fwd + left;
      } else if (!PARAMS.controlFrameAllowReverse) {
        const turn = (left >= 0 ? 1 : -1) * Math.max(Math.abs(left), 0.3);
        tl = -turn;
        tr = turn;
      } else {
        tl = fwd + left;
        tr = fwd - left;
      }
    }
    // to wheel speeds (m/s); the chassis turning no faster than the pan servo can follow (applyServoTrackingConstraints)
    const top = vmax();
    let vl = clamp(tl, -1, 1) * top;
    let vr = clamp(tr, -1, 1) * top;
    const wb = PARAMS.wheelbaseMm / 1000;
    if (PARAMS.servoFollowControlFrame && d && d.kind === "control") {
      const avg = (vl + vr) / 2;
      const maxW = (PARAMS.servoMaxRotationRateDegPerSec * Math.PI) / 180;
      const w0 = clamp((vr - vl) / wb, -maxW, maxW);
      vl = avg - (w0 * wb) / 2;
      vr = avg + (w0 * wb) / 2;
    }
    // the wheels reach those speeds at most so quickly (maxAccelRevPerSec2 / maxDecelRevPerSec2)
    const circ = Math.PI * (PARAMS.wheelDiameterMm / 1000);
    const acc = (cur, want) => {
      const lim = (Math.abs(want) > Math.abs(cur) ? PARAMS.maxAccelRevPerSec2 : PARAMS.maxDecelRevPerSec2) * circ * dt;
      return cur + clamp(want - cur, -lim, lim);
    };
    R.vl = acc(R.vl || 0, vl);
    R.vr = acc(R.vr || 0, vr);
    R.v = (R.vl + R.vr) / 2;
    R.w = (R.vr - R.vl) / wb;
    R.theta = wrap(R.theta + R.w * dt);
    R.x += R.v * Math.cos(R.theta) * dt;
    R.y += R.v * Math.sin(R.theta) * dt;
    // the pan servo: the camera keeps to the control frame (within its range), or a robot-relative target
    if (now - R.relAt < 3000 && R.rel) {
      R.pan = R.rel.pan;
      if (typeof R.rel.tilt === "number") R.tilt = R.rel.tilt;
      R.ct = wrap(R.theta + (R.pan * Math.PI) / 180);
    } else R.pan = clamp((wrap(R.ct - R.theta) * 180) / Math.PI, -90, 90);
  }
  setInterval(step, 20);

  function poseMsg() {
    return {
      type: "pose", t: Math.round(performance.now()), x: +R.x.toFixed(4), y: +R.y.toFixed(4), theta: +R.theta.toFixed(4), controlTheta: +R.ct.toFixed(4),
      calibrating: false, calibratingPwm: 0, encoderCalibrating: false, encoderCalibrationWheel: 0, encoderCalibrationRevs: 0,
      speedCmPerSec: +(Math.abs(R.v) * 100).toFixed(2), servoAngleDeg: +R.pan.toFixed(2), tiltAngleDeg: +R.tilt.toFixed(2),
      panActDeg: +R.pan.toFixed(2), tiltActDeg: +R.tilt.toFixed(2), inaAvailable: false, clients: 1,
    };
  }
  function command(msg) {
    if (DEMO.log) DEMO.log.push(msg);
    const now = performance.now();
    const n = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
    switch (msg.type) {
      case "joystick":
        R.drive = { kind: "joystick", j1: n(msg.j1), j2: n(msg.j2) };
        R.driveAt = now;
        break;
      case "control_joystick":
        R.drive = { kind: "control", j1: n(msg.j1), j2: n(msg.j2) };
        R.driveAt = now;
        break;
      case "aim":
        R.ct = wrap(n(msg.heading));
        R.tilt = clamp(n(msg.tilt), -60, 60);
        R.rot = 0;
        R.tiltRate = 0;
        R.rel = null;
        break;
      case "control_frame_rotate":
        R.rot = clamp(n(msg.value), -1, 1);
        R.rotAt = now;
        R.rel = null;
        break;
      case "tilt_rate":
        R.tiltRate = clamp(n(msg.value), -1, 1);
        R.tiltAt = now;
        break;
      case "camera_relative":
        R.rel = { pan: clamp(n(msg.pan), -90, 90), tilt: typeof msg.tilt === "number" ? clamp(msg.tilt, -60, 60) : undefined };
        R.relAt = now;
        break;
      case "servo_angle":
        R.ct = wrap(R.theta + (n(msg.angleDeg) * Math.PI) / 180);
        break;
      case "tilt_servo_angle":
        R.tilt = clamp(n(msg.angleDeg), -60, 60);
        break;
      default:
        break;
    }
  }

  // -- the WebSocket --------------------------------------------------------------------------
  const RealWS = window.WebSocket;
  class DemoSocket {
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this._l = { open: [], message: [], close: [], error: [] };
      setTimeout(() => {
        if (this.readyState !== 0) return;
        this.readyState = 1;
        this._emit("open", {});
        this._timer = setInterval(() => this._emit("message", { data: JSON.stringify(poseMsg()) }), 100);
      }, 30);
    }
    _emit(type, ev) {
      const h = this["on" + type];
      if (h) h.call(this, ev);
      this._l[type].forEach((f) => f.call(this, ev));
    }
    addEventListener(type, f) {
      if (this._l[type]) this._l[type].push(f);
    }
    removeEventListener(type, f) {
      if (this._l[type]) this._l[type] = this._l[type].filter((g) => g !== f);
    }
    send(data) {
      let msg;
      try {
        msg = JSON.parse(data);
      } catch (e) {
        return;
      }
      if (msg.type === "ping") setTimeout(() => this._emit("message", { data: JSON.stringify({ type: "pong", seq: msg.seq }) }), 5);
      else command(msg);
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      clearInterval(this._timer);
      setTimeout(() => this._emit("close", { code: 1000 }), 0);
    }
  }
  DemoSocket.CONNECTING = 0;
  DemoSocket.OPEN = 1;
  DemoSocket.CLOSING = 2;
  DemoSocket.CLOSED = 3;
  window.WebSocket = function (url, protocols) {
    if (/\/ws(\?|$)/.test(String(url))) return new DemoSocket(url);
    return new RealWS(url, protocols);
  };
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3, prototype: RealWS.prototype });

  // -- fetch ------------------------------------------------------------------------------------
  const realFetch = window.fetch.bind(window);
  const json = (obj, status = 200) => Promise.resolve(new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } }));
  const text = (s, status = 200) => Promise.resolve(new Response(s, { status, headers: { "Content-Type": "text/plain" } }));
  const ROBOT_PATHS = /^\/(params|set|pose|pose_reset|camdiag|waypoints|appdata\/[\w-]+|api\/update(\/check)?|update(-fs)?|status|resets|wifi[\w/-]*|sysstats|ping)$/;
  window.fetch = function (input, init = {}) {
    const raw = typeof input === "string" ? input : input && input.url;
    let u;
    try {
      u = new URL(raw, location.href);
    } catch (e) {
      return realFetch(input, init);
    }
    // the robot's own paths: absolute on the robot (here they'd point at the site's root)
    const path = raw.startsWith("/") ? u.pathname : u.origin === location.origin && !/\.\w+$/.test(u.pathname) ? "/" + u.pathname.split("/").pop() : null;
    if (!path || !ROBOT_PATHS.test(path)) return realFetch(input, init);
    const method = (init.method || "GET").toUpperCase();
    const q = u.searchParams;
    if (path === "/params") return json(PARAMS);
    if (path === "/set") {
      if (q.get("set_pose") === "1") {
        R.x = +q.get("x") || 0;
        R.y = +q.get("y") || 0;
        R.theta = +q.get("theta") || 0;
      } else if (q.get("reset_home") === "1") {
        R.x = R.y = 0;
      } else {
        q.forEach((v, k) => {
          if (k in PARAMS && typeof PARAMS[k] !== "string") PARAMS[k] = typeof PARAMS[k] === "boolean" ? v === "1" || v === "true" : +v;
        });
        store.set("params", JSON.stringify(PARAMS));
      }
      return text("OK");
    }
    if (path === "/pose") return json(poseMsg());
    if (path === "/pose_reset") {
      R.x = R.y = R.theta = R.ct = 0;
      return text("OK");
    }
    if (path === "/camdiag") return json({ ip: "demo-camera", stale: false, demo: true });
    if (path === "/waypoints" || path.startsWith("/appdata/")) {
      const key = path.slice(1);
      if (method === "POST" || method === "PUT") {
        const body = init.body;
        return Promise.resolve(typeof body === "string" ? body : body && body.text ? body.text() : "").then((s) => {
          store.set(key, s || "");
          return text("OK");
        });
      }
      const v = store.get(key);
      if (v !== null && v !== "") return text(v);
      return path === "/waypoints" ? json([]) : text("not found", 404);
    }
    if (path === "/status") return json({ demo: true });
    return text("Not available in the demo (no robot)", 503);
  };

  // -- the camera stream: there's no camera -- a plain 640 x 480 frame (the
  // page sizes its overlays by the picture), and the first-person view draws a
  // tiled floor in its place (cam.js, initFloorGrid's "tiles": window.LYNX_DEMO)
  let blank = null;
  function frame() {
    if (!blank) {
      const c = document.createElement("canvas");
      c.width = 640;
      c.height = 480;
      const g = c.getContext("2d");
      g.fillStyle = "rgb(150,152,158)";
      g.fillRect(0, 0, 640, 480);
      blank = c.toDataURL("image/png");
    }
    return blank;
  }
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get() {
      return srcDesc.get.call(this);
    },
    set(v) {
      srcDesc.set.call(this, /:81\/stream/.test(String(v)) ? frame() : v);
    },
  });

  // -- a note on every page: this is the demo ---------------------------------------------------
  document.addEventListener("DOMContentLoaded", () => {
    const nl = (() => {
      try {
        return (localStorage.getItem("lynxLang") || navigator.language || "").toLowerCase().startsWith("nl");
      } catch (e) {
        return false;
      }
    })();
    const b = document.createElement("div");
    b.id = "lynxDemoNote";
    b.textContent = nl
      ? "Demo zonder robot: de robot en zijn camera zijn nagebootst (een tegelvloer, geen echte kubussen). Instellingen en scores blijven in deze browser."
      : "Demo without a robot: the robot and its camera are simulated (a tiled floor, no real cubes). Settings and scores stay in this browser.";
    b.style.cssText =
      "position:fixed;left:50%;bottom:4px;transform:translateX(-50%);z-index:99999;background:rgba(30,30,40,0.85);color:#ffe9a8;" +
      "font:12px system-ui,sans-serif;padding:3px 10px;border-radius:6px;pointer-events:none;max-width:94vw;text-align:center";
    document.body.appendChild(b);
    setTimeout(() => (b.style.opacity = "0.55"), 8000);
  });
})();
