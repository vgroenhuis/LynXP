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
//   - the camera stream (http://<cam>:81/stream): a rendered picture of a
//     floor of large tiles under a grey sky, from where the simulated
//     camera is -- so driving and turning look right
// There are no real cubes: the tag detector finds nothing in the picture.

(function () {
  "use strict";
  const DEMO = (window.LYNX_DEMO = { robot: null });

  // -- the robot's settings: the firmware's defaults (settings.cpp), /set changes them ---------
  const PARAMS = {
    loggingEnabled: false, debugWeb: false, dataLogRate: 10, mode: 0, logType: 0, logUnit: 0, kp: 1, ki: 0, kd: 0,
    differentiatorCutoffHz: 10, motorPower: 1000, wheelbaseMm: 170, wheelDiameterMm: 65, telemetryHz: 10,
    motorDeadzonePwm: 300, gotoSpeedGain: 10, maxWheelSpeedRevPerSec: 1.8, maxAccelRevPerSec2: 5, maxDecelRevPerSec2: 5,
    gotoVelKp: 1500, gotoVelKi: 1000, feedForwardPwmPerRevPerSec: 0.53, gotoAllowReverse: true, gotoPreserveHeading: false,
    controlFrameAllowReverse: true, servoFollowControlFrame: true, controlFrameRotationStrategy: 0,
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
  const vmax = () => PARAMS.maxWheelSpeedRevPerSec * Math.PI * (PARAMS.wheelDiameterMm / 1000) * 0.9;
  const curve = (v) => (Math.abs(v) < 0.03 ? 0 : PARAMS.cameraJoystickCurve === 1 ? Math.sign(v) * v * v : v);
  let lastStep = performance.now();
  function step() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - lastStep) / 1000);
    lastStep = now;
    // the camera's direction (the control frame) and tilt, from rate input
    if (now - R.rotAt < 500 && R.rot) R.ct = wrap(R.ct + (curve(R.rot) * PARAMS.panMaxSpeedDegPerSec * Math.PI) / 180 * dt);
    if (now - R.tiltAt < 500 && R.tiltRate) R.tilt = clamp(R.tilt + curve(R.tiltRate) * PARAMS.tiltMaxSpeedDegPerSec * dt, -60, 60);
    // driving
    let v = 0;
    let w = 0;
    const d = now - R.driveAt < 600 ? R.drive : null;
    if (d && d.kind === "joystick") {
      const l = clamp(d.j2 + d.j1, -1, 1);
      const r = clamp(d.j2 - d.j1, -1, 1);
      v = ((l + r) / 2) * vmax();
      w = ((r - l) * vmax()) / (PARAMS.wheelbaseMm / 1000);
    } else if (d && d.kind === "control") {
      // the control frame: forward = where the camera looks; the chassis turns to the way to go and drives
      const fx = d.j2;
      const fy = -d.j1;
      const mag = Math.min(1, Math.hypot(fx, fy));
      if (mag > 0.02) {
        const want = Math.atan2(Math.sin(R.ct) * fx + Math.cos(R.ct) * fy, Math.cos(R.ct) * fx - Math.sin(R.ct) * fy);
        let err = wrap(want - R.theta);
        let dir = 1;
        if (PARAMS.controlFrameAllowReverse && Math.abs(err) > Math.PI / 2 + 0.2) {
          err = wrap(err + Math.PI);
          dir = -1;
        }
        w = clamp(err * 6, -6, 6);
        v = dir * mag * vmax() * Math.max(0, Math.cos(err));
      }
    }
    // (a little inertia)
    const k = 1 - Math.exp(-dt / 0.12);
    R.v += (v - R.v) * k;
    R.w += (w - R.w) * k;
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

  // -- the camera stream: a rendered floor from where the simulated camera is ------------------------
  const W = 320;
  const H = 240;
  let canvas = null;
  let ctx = null;
  let img = null;
  function render() {
    if (!canvas) {
      canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      ctx = canvas.getContext("2d");
      img = ctx.createImageData(W, H);
    }
    const hgt = PARAMS.cameraHeightMm / 1000;
    const f = H / 2 / Math.tan((PARAMS.cameraVerticalFovDeg * Math.PI) / 360);
    const yaw = R.theta + (R.pan * Math.PI) / 180;
    const pitch = ((R.tilt - PARAMS.cameraTiltDeg) * Math.PI) / 180; // (cameraTiltDeg: down; the tilt servo: up -- Lynx.cameraFrame)
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const d = img.data;
    for (let py = 0; py < H; py++) {
      const yc = (H / 2 - py - 0.5) / f; // up
      for (let px = 0; px < W; px++) {
        const xc = (px + 0.5 - W / 2) / f; // right
        // the ray: forward 1, right xc, up yc -- tilted up by pitch, then turned by yaw (x forward, y left)
        const fw = cp - yc * sp;
        const up = sp + yc * cp;
        const dx = fw * cy + xc * sy;
        const dy = fw * sy - xc * cy;
        let r;
        let g;
        let b;
        const o = (py * W + px) * 4;
        if (up < -1e-4) {
          const t = hgt / -up;
          const wx = R.x + dx * t;
          const wy = R.y + dy * t;
          const tile = (Math.floor(wx / 0.3) + Math.floor(wy / 0.3)) & 1;
          const line = Math.abs(wx / 0.3 - Math.round(wx / 0.3)) < 0.012 || Math.abs(wy / 0.3 - Math.round(wy / 0.3)) < 0.012;
          const fog = Math.min(1, t / 6);
          [r, g, b] = line ? [96, 84, 70] : tile ? [176, 150, 116] : [158, 132, 100];
          r += (150 - r) * fog;
          g += (152 - g) * fog;
          b += (158 - b) * fog;
        } else {
          const s = Math.min(1, up * 2);
          r = 150 + 40 * s;
          g = 152 + 46 * s;
          b = 158 + 60 * s;
        }
        d[o] = r;
        d[o + 1] = g;
        d[o + 2] = b;
        d[o + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.8);
  }
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  const streams = new Set();
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    enumerable: srcDesc.enumerable,
    get() {
      return srcDesc.get.call(this);
    },
    set(v) {
      if (/:81\/stream/.test(String(v))) {
        streams.add(this);
        srcDesc.set.call(this, render());
        return;
      }
      streams.delete(this);
      srcDesc.set.call(this, v);
    },
  });
  setInterval(() => {
    if (!streams.size) return;
    const url = render();
    streams.forEach((el) => (el.isConnected ? srcDesc.set.call(el, url) : streams.delete(el)));
  }, 100);

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
