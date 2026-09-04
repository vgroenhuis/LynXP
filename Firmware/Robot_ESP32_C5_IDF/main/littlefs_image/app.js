let ws = null;
let wsReconnectTimer = null;
let wsLastMessageAtMs = 0;
let wsConnectStartedAtMs = 0;

const WS_RECONNECT_DELAY_MS = 250;
// If the socket reports "open" but hasn't delivered anything in this long,
// treat it as silently dead (common on flaky Wi-Fi) and force a reconnect
// instead of waiting for the browser's own TCP-level timeout to notice.
const WS_STALE_THRESHOLD_MS = 1000;
// If the handshake itself hasn't resolved (still CONNECTING) after this
// long, the socket is stuck rather than merely slow - force it closed so
// onclose can retry. Without this, a WS that never finishes connecting
// (e.g. a dropped SYN during a flaky Wi-Fi handoff) sits forever in
// CONNECTING: onopen/onclose/onerror never fire, and the staleness check
// below only looks at the OPEN state, so nothing would ever recover it -
// this reproduced as "the page goes unresponsive but a new tab works fine".
const WS_CONNECT_TIMEOUT_MS = 3000;

let geometry = { wheelbaseMm: 230, wheelDiameterMm: 71 };
let latestPose = { x: 0, y: 0, theta: 0 };
let controlFrameTheta = 0; // world-frame angle of the control-frame reference arrow
let goalMarker = null; // last click-to-navigate target, in world coords, optionally with a .heading (rad)
let waypoints = []; // user-added only, [{name,x,y,heading(rad)}] - Home is injected separately, never stored
let selectedWaypointIndex = null; // index into fullWaypointList() (Home is index 0)
let editingWaypoint = false;

// Patrol loop: when active, checkWaypointAutoAdvance() (called on every "pose"
// telemetry message) watches for arrival at fullWaypointList()[autoAdvanceTargetIndex]
// and issues a "goto" for the next one in the list, wrapping around forever.
// Cancelled by any non-waypoint drive command (see updateModeHighlight() and
// the plain map-click handler) so it can't silently hijack the robot back
// into goto mode after the operator switches to manual control.
let autoAdvanceActive = false;
let autoAdvanceTargetIndex = null;
const WAYPOINT_ARRIVAL_TOLERANCE_M = 0.05; // a bit looser than the firmware's own 0.03m so telemetry lag/noise can't miss it
const WAYPOINT_HEADING_ARRIVAL_TOLERANCE_RAD = (5 * Math.PI) / 180;
let deadzoneCalibrationWasActive = false;
let encoderCalibrationWasActive = false;
// The tilt servo's angle now lives authoritatively on the ESP32 (see
// ws_broadcast.cpp's tiltRateInput/currentTiltAngleDeg) since multiple
// browsers can each send tilt rate commands -- the tilt test panel's
// slider is kept in sync from every "pose" broadcast's tiltAngleDeg field
// rather than tracking its own local value. This flag suppresses that sync
// while the user is actively dragging the slider themselves, so the
// ~telemetryHz broadcast can't fight a manual drag.
let tiltSliderDragging = false;
// Kept in sync with their settings (loadParams() + the relevant change
// listeners) purely so the diagnostics graphs' reference grid lines stay
// accurate without needing a full params refetch every time they're drawn.
let maxWheelSpeedRevPerSec = 2.0;
let maxMotorPowerPwm = 1000;
const trail = [];
const MAX_TRAIL_POINTS = 2000;

// Abandons the current socket immediately and starts a fresh connection,
// rather than calling ws.close() and waiting for its onclose to fire.
// close() on a truly dead connection (not just an idle one) can itself sit
// for a long time - the browser still has to run its own closing handshake/
// TCP-level teardown against a peer that's never going to answer - which is
// exactly the "reconnects eventually, but way later than it should" gap
// this closes. The old socket's handlers are detached first so whatever it
// does later (fire close/error after all) can't interfere with the new one.
function forceReconnect() {
  clearTimeout(wsReconnectTimer);
  if (ws) {
    const dead = ws;
    ws = null;
    dead.onopen = dead.onclose = dead.onerror = dead.onmessage = null;
    try {
      dead.close();
    } catch (e) {
      // ignore - we're discarding this socket regardless
    }
  }
  connectWs();
}

function connectWs() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  wsConnectStartedAtMs = Date.now();

  ws.onopen = () => {
    document.getElementById("ws-status").textContent = "connected";
    wsLastMessageAtMs = Date.now();
    // The server's gotoDiagnosticsEnabled flag is per-connection, reset to
    // false on every fresh WS connect - resync it after a reconnect so a
    // WiFi drop doesn't silently desync the still-checked checkbox from a
    // server that's no longer sending the extra telemetry.
    if (document.getElementById("gotoDiagnosticsEnabled").checked) {
      sendWs({ type: "goto_diag_enable", enabled: true });
    }
    if (document.getElementById("sysDiagnosticsEnabled").checked) {
      sendWs({ type: "sys_diag_enable", enabled: true });
    }
  };
  ws.onclose = () => {
    document.getElementById("ws-status").textContent = "disconnected, retrying...";
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWs, WS_RECONNECT_DELAY_MS);
  };
  ws.onerror = () => {
    ws.close();
  };
  ws.onmessage = (e) => {
    wsLastMessageAtMs = Date.now();
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch (err) {
      return;
    }
    if (msg.type === "pose") {
      latestPose = { x: msg.x, y: msg.y, theta: msg.theta };
      checkWaypointAutoAdvance();
      if (typeof msg.controlTheta === "number") {
        controlFrameTheta = msg.controlTheta;
      }
      if (typeof msg.calibrating === "boolean") {
        if (msg.calibrating) {
          document.getElementById("deadzoneCalibrationStatus").textContent = `Calibrating... testing PWM ${msg.calibratingPwm}`;
        } else if (deadzoneCalibrationWasActive) {
          document.getElementById("deadzoneCalibrationStatus").textContent = "Done.";
          loadParams(); // refresh the displayed motorDeadzonePwm with the new value
        }
        deadzoneCalibrationWasActive = msg.calibrating;
      }
      if (typeof msg.encoderCalibrating === "boolean") {
        const wheelName = msg.encoderCalibrationWheel === 1 ? "right" : "left";
        if (msg.encoderCalibrating) {
          document.getElementById("encoderCalibrationStatus").textContent =
            `Spinning ${wheelName} wheel: ${msg.encoderCalibrationRevs.toFixed(2)} / 10.00 revolutions counted so far - watch the wheel and confirm it matches.`;
        } else if (encoderCalibrationWasActive) {
          document.getElementById("encoderCalibrationStatus").textContent =
            `Done. This always reads 10.00 here (it's counted using the same constants being checked) - what matters is whether the ${wheelName} wheel visibly completed exactly 10 real turns. If it looked short or long, MOTOR_TRANSMISSION_RATIO/ENCODER_COUNTS_PER_REVOLUTION (robot_core1.hpp) need adjusting proportionally.`;
        }
        encoderCalibrationWasActive = msg.encoderCalibrating;
      }
      trail.push({ x: msg.x, y: msg.y });
      if (trail.length > MAX_TRAIL_POINTS) {
        trail.shift();
      }
      if (document.getElementById("gotoDiagnosticsEnabled").checked && Array.isArray(msg.wheelPosRev)) {
        updateGotoGraphs(msg);
      }
      if (typeof msg.speedCmPerSec === "number") {
        latestSpeedCmPerSec = msg.speedCmPerSec;
        drawSpeedometer(latestSpeedCmPerSec);
      }
      if (typeof msg.inaAvailable === "boolean") {
        updateInaGraphs(msg);
      }
      if (typeof msg.clients === "number") {
        document.getElementById("ws-clients").textContent = `WebSocket clients: ${msg.clients}`;
      }
      if (typeof msg.tiltAngleDeg === "number" && !tiltSliderDragging) {
        document.getElementById("tiltAngleDeg").value = msg.tiltAngleDeg;
        document.getElementById("tiltAngleDegVal").value = msg.tiltAngleDeg;
        updateTiltPulseDisplay();
      }
      drawMap();
    } else if (msg.type === "pong") {
      handlePong(msg.seq);
    } else if (msg.type === "sysstats") {
      updateSysStats(msg);
    }
  };
}

setInterval(() => {
  if (!ws) return;
  const now = Date.now();
  if (ws.readyState === WebSocket.CONNECTING && now - wsConnectStartedAtMs > WS_CONNECT_TIMEOUT_MS) {
    forceReconnect();
  } else if (ws.readyState === WebSocket.OPEN && now - wsLastMessageAtMs > WS_STALE_THRESHOLD_MS) {
    forceReconnect();
  }
}, 300);

// Browsers throttle setInterval heavily in backgrounded tabs (sometimes to
// once a minute or less), so the watchdog above can't be relied on to run
// promptly while the tab isn't visible - check immediately on refocus too,
// in case the connection died while backgrounded and the throttled
// watchdog hasn't caught up yet.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible" || !ws) return;
  const now = Date.now();
  const stuckConnecting = ws.readyState === WebSocket.CONNECTING && now - wsConnectStartedAtMs > WS_CONNECT_TIMEOUT_MS;
  const staleOpen = ws.readyState === WebSocket.OPEN && now - wsLastMessageAtMs > WS_STALE_THRESHOLD_MS;
  if (stuckConnecting || staleOpen) {
    forceReconnect();
  }
});

function sendWs(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// --- Diagnostics: WebSocket round-trip time (opt-in, for investigating map lag) ---
// Sends its own small ping/pong traffic on top of everything else, so it's
// off by default - only enable while actively investigating. Tied to the
// live map update rate (telemetryHz) rather than a fixed interval, so it
// always matches whatever rate the pose telemetry itself is already
// running at (pings share the same per-client outbound queue as pose
// telemetry, so pinging much faster than that would just add unnecessary
// extra traffic without measuring anything new).

let rttPingIntervalMs = 1000; // overwritten by loadParams()/telemetryHz's change handler
const MAX_RTT_SAMPLES = 100;

let rttPingSeq = 0;
let rttPingTimer = null;
const rttPingSentAt = new Map();
const rttSamples = [];

function setRttPingIntervalFromHz(hz) {
  rttPingIntervalMs = 1000 / hz;
  if (rttPingTimer) {
    // Restart with the new period so a live change takes effect immediately.
    stopRttDiagnostics();
    startRttDiagnostics();
  }
}

function sendRttPing() {
  const seq = rttPingSeq++;
  rttPingSentAt.set(seq, performance.now());
  sendWs({ type: "ping", seq });
  // Drop any pings old enough that their pong is never coming (dropped
  // frame, disconnect) so this map can't grow without bound.
  for (const key of rttPingSentAt.keys()) {
    if (seq - key > 20) rttPingSentAt.delete(key);
  }
}

function handlePong(seq) {
  const sentAt = rttPingSentAt.get(seq);
  if (sentAt === undefined) return;
  rttPingSentAt.delete(seq);
  const rtt = performance.now() - sentAt;
  rttSamples.push(rtt);
  if (rttSamples.length > MAX_RTT_SAMPLES) rttSamples.shift();
  drawRttGraph();
  updateRttStats();
}

function startRttDiagnostics() {
  if (rttPingTimer) return;
  rttPingTimer = setInterval(sendRttPing, rttPingIntervalMs);
}

function stopRttDiagnostics() {
  clearInterval(rttPingTimer);
  rttPingTimer = null;
  rttPingSentAt.clear();
  rttSamples.length = 0;
  updateRttStats();
  drawRttGraph();
}

function updateRttStats() {
  const statsEl = document.getElementById("rtt-stats");
  if (rttSamples.length === 0) {
    statsEl.textContent = "";
    return;
  }
  const min = Math.min(...rttSamples);
  const max = Math.max(...rttSamples);
  const avg = rttSamples.reduce((a, b) => a + b, 0) / rttSamples.length;
  statsEl.textContent = `min ${min.toFixed(0)} ms / avg ${avg.toFixed(0)} ms / max ${max.toFixed(0)} ms (n=${rttSamples.length})`;
}

function drawRttGraph() {
  const canvas = document.getElementById("rttGraph");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (rttSamples.length < 2) return;

  const maxVal = Math.max(...rttSamples, 10); // avoid a degenerate all-zero scale
  const padding = 4;
  const w = canvas.width - padding * 2;
  const h = canvas.height - padding * 2;

  ctx.strokeStyle = "#2c9aff";
  ctx.lineWidth = 2;
  ctx.beginPath();
  rttSamples.forEach((v, i) => {
    const x = padding + (i / (MAX_RTT_SAMPLES - 1)) * w;
    const y = padding + h - (v / maxVal) * h;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

// --- Speedometer: semicircular needle gauge showing the robot's live
// linear speed magnitude, from the "speedCmPerSec" field on every "pose"
// telemetry message (computed firmware-side from the same encoder-derived
// wheel velocities the position controller uses). Max speed and the major
// (labeled) / minor (unlabeled) tick intervals are user-adjustable,
// persisted display preferences - not robot settings - defaulting to
// 50 cm/s max, a major tick every 5 cm/s, and a minor tick every 1 cm/s.

let latestSpeedCmPerSec = 0;

function getSpeedometerMax() {
  const val = parseFloat(document.getElementById("speedometerMaxCmPerSec").value);
  return val > 0 ? val : 50;
}

function getSpeedometerMajorTick() {
  const val = parseFloat(document.getElementById("speedometerMajorTickCmPerSec").value);
  return val > 0 ? val : 5;
}

function getSpeedometerMinorTick() {
  const val = parseFloat(document.getElementById("speedometerMinorTickCmPerSec").value);
  return val > 0 ? val : 1;
}

function drawSpeedometer(speedCmPerSec) {
  const canvas = document.getElementById("speedometerGauge");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const centerX = canvas.width / 2;
  const centerY = canvas.height - 35;
  const radius = Math.min(centerX, centerY) - 15;
  const maxSpeed = getSpeedometerMax();
  const majorTick = getSpeedometerMajorTick();
  const minorTick = getSpeedometerMinorTick();
  const fraction = Math.max(0, Math.min(1, speedCmPerSec / maxSpeed));

  // The gauge sweeps the top half-circle: angle PI (pointing left, 0 speed)
  // through 1.5*PI (pointing up, half scale) to 2*PI (pointing right, max).
  ctx.beginPath();
  ctx.lineWidth = 3;
  ctx.strokeStyle = "#aaa";
  ctx.arc(centerX, centerY, radius, Math.PI, 2 * Math.PI);
  ctx.stroke();

  const angleForValue = (v) => Math.PI + (v / maxSpeed) * Math.PI;
  const drawTick = (value, length, lineWidth) => {
    const angle = angleForValue(value);
    const x1 = centerX + (radius - length) * Math.cos(angle);
    const y1 = centerY + (radius - length) * Math.sin(angle);
    const x2 = centerX + radius * Math.cos(angle);
    const y2 = centerY + radius * Math.sin(angle);
    ctx.beginPath();
    ctx.strokeStyle = "#888";
    ctx.lineWidth = lineWidth;
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };
  // Whether `value` lands on a major-tick position (used to skip a
  // redundant minor tick drawn at the same spot as a major one).
  const isOnMajorTick = (value) => Math.abs(Math.round(value / majorTick) * majorTick - value) < 1e-6;

  // Interval-based (not a fixed division count), so the scale can be tuned
  // to whatever increments make sense for the configured max speed. Capped
  // at 1000 ticks per pass as a safety net against a runaway loop if an
  // interval field is set absurdly small relative to max speed.
  const MAX_TICKS = 1000;

  const minorCount = Math.min(Math.floor(maxSpeed / minorTick + 1e-9), MAX_TICKS);
  for (let i = 0; i <= minorCount; i++) {
    const value = i * minorTick;
    if (isOnMajorTick(value)) continue;
    drawTick(value, 5, 1);
  }

  const majorCount = Math.min(Math.floor(maxSpeed / majorTick + 1e-9), MAX_TICKS);
  ctx.font = "10px sans-serif";
  ctx.fillStyle = "#666";
  ctx.textAlign = "center";
  for (let i = 0; i <= majorCount; i++) {
    const value = i * majorTick;
    drawTick(value, 10, 2);
    const angle = angleForValue(value);
    const labelR = radius - 22;
    const lx = centerX + labelR * Math.cos(angle);
    const ly = centerY + labelR * Math.sin(angle);
    ctx.fillText(Math.round(value).toString(), lx, ly + 3);
  }

  const needleAngle = Math.PI + fraction * Math.PI;
  const needleLen = radius - 10;
  ctx.beginPath();
  ctx.strokeStyle = "#d9534f";
  ctx.lineWidth = 3;
  ctx.moveTo(centerX, centerY);
  ctx.lineTo(centerX + needleLen * Math.cos(needleAngle), centerY + needleLen * Math.sin(needleAngle));
  ctx.stroke();

  ctx.beginPath();
  ctx.fillStyle = "#444";
  ctx.arc(centerX, centerY, 5, 0, 2 * Math.PI);
  ctx.fill();

  ctx.font = "bold 16px sans-serif";
  ctx.fillStyle = "#333";
  ctx.textAlign = "center";
  ctx.fillText(`${speedCmPerSec.toFixed(1)} cm/s`, centerX, centerY + 22);
}

// --- Diagnostics: CPU/memory stats (opt-in, pushed server-side at a fixed
// 1Hz via a dedicated "sysstats" message - see sysDiagnosticsEnabled) ---

function formatBytes(b) {
  return (b / 1024).toFixed(1) + " KB";
}

function updateSysStats(msg) {
  const el = document.getElementById("sys-stats");
  // heapCeilingBytes is the real "how much room is left" number: the true
  // limit the heap could grow to. heapArenaBytes is just how much of that
  // has been claimed so far (grows on demand) - a high used/arena ratio is
  // normal and NOT a low-memory warning; used/ceiling is the one that
  // actually matters.
  const heapCeilingPct = msg.heapCeilingBytes > 0 ? ((msg.heapUsedBytes / msg.heapCeilingBytes) * 100).toFixed(0) : "0";
  const core0StackPct = ((msg.core0StackUsedBytes / msg.core0StackTotalBytes) * 100).toFixed(0);
  const core1StackPct = ((msg.core1StackUsedBytes / msg.core1StackTotalBytes) * 100).toFixed(0);
  const rows = [
    ["Core0 loop rate (network/HTTP)", `${msg.core0Hz.toFixed(0)} Hz`],
    ["Core0 tick time (avg / max)", `${msg.core0TickAvgUs} µs / ${msg.core0TickMaxUs} µs`],
    ["Core1 loop rate (1kHz control loop)", `${msg.core1Hz.toFixed(1)} Hz`],
    ["Core1 tick time (avg / max)", `${msg.core1TickAvgUs} µs / ${msg.core1TickMaxUs} µs`],
    ["Heap used / room to grow into", `${formatBytes(msg.heapUsedBytes)} / ${formatBytes(msg.heapCeilingBytes)} (${heapCeilingPct}%)`],
    ["Heap claimed so far (arena)", `${formatBytes(msg.heapArenaBytes)} claimed, ${formatBytes(msg.heapFreeBytes)} of that unused`],
    ["Core0 stack used / total", `${formatBytes(msg.core0StackUsedBytes)} / ${formatBytes(msg.core0StackTotalBytes)} (${core0StackPct}%)`],
    ["Core1 stack used / total", `${formatBytes(msg.core1StackUsedBytes)} / ${formatBytes(msg.core1StackTotalBytes)} (${core1StackPct}%)`],
    ["Total RAM", formatBytes(msg.totalRamBytes)],
  ];
  el.innerHTML =
    `<caption>Stack figures are the current depth when sampled, not a historical peak. The heap "arena" grows on demand as needed - it's not a fixed pool, so a high claimed/unused ratio there is normal.</caption>` +
    `<tbody>${rows.map(([label, value]) => `<tr><th scope="row">${label}</th><td>${value}</td></tr>`).join("")}</tbody>`;
}

// --- Diagnostics: position-controller graphs (opt-in, mirrors the RTT toggle
// above but pushed server-side via the pose broadcast rather than a
// separate ping) ---

const GOTO_GRAPH_WINDOW_SEC = 10; // rolling wall-clock window, not a fixed sample count,
// so the graphs stay correct across the full 1-30Hz telemetryHz range.

const DASH_SOLID = [];
const DASH_DASHED = [4, 3];
const DASH_DOTTED = [1, 3];

function makeSeries(color, dash) {
  return { buffer: [], color, dash: dash || [] };
}

function pushSample(series, t, v) {
  series.buffer.push({ t, v });
  const cutoff = t - GOTO_GRAPH_WINDOW_SEC * 1000;
  while (series.buffer.length && series.buffer[0].t < cutoff) series.buffer.shift();
}

// seriesList: [{buffer:[{t,v}], color, dash}]. X axis is always the fixed
// trailing [nowT-windowSec, nowT] window regardless of how many samples have
// arrived. `options`:
//   gridLines: optional [{value, label}] list of labeled horizontal reference
//     lines (e.g. the wheel speed limit).
//   extendRangeToGridLines: whether gridLines' values also expand the
//     auto-scaled Y range so they're always visible even if actual data
//     never gets close to them (default true - set false for a graph that
//     should stay tightly auto-scaled to its real data, like wheel velocity).
//   tieredGridFn(minV, maxV): optional, called with the FINAL (already-
//     padded) axis bounds, returns [{color, lineWidth, values:[...]}] for a
//     dense, unlabeled multi-tier reference grid (e.g. the map's 0.1/0.5/1m
//     tiers) that reflects whatever range the data naturally falls in,
//     rather than forcing the view wider.
function drawTimeSeriesGraph(canvasId, seriesList, windowSec, nowT, options) {
  options = options || {};
  const gridLines = options.gridLines;
  const extendRangeToGridLines = options.extendRangeToGridLines !== false;
  const tieredGridFn = options.tieredGridFn;

  const canvas = document.getElementById(canvasId);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  let minV = Infinity, maxV = -Infinity;
  for (const s of seriesList) {
    for (const p of s.buffer) {
      if (p.v < minV) minV = p.v;
      if (p.v > maxV) maxV = p.v;
    }
  }
  if (gridLines && extendRangeToGridLines) {
    for (const g of gridLines) {
      if (g.value < minV) minV = g.value;
      if (g.value > maxV) maxV = g.value;
    }
  }
  if (!isFinite(minV) || !isFinite(maxV)) return;
  if (maxV - minV < 1e-6) {
    minV -= 0.5;
    maxV += 0.5;
  }
  const pad = (maxV - minV) * 0.1;
  minV -= pad;
  maxV += pad;

  const padding = 4;
  const w = canvas.width - padding * 2;
  const h = canvas.height - padding * 2;
  const tMin = nowT - windowSec * 1000;
  const xOf = (t) => padding + ((t - tMin) / (windowSec * 1000)) * w;
  const yOf = (v) => padding + h - ((v - minV) / (maxV - minV)) * h;

  // Every graph gets SOME numeric Y-axis indication, not just the ones that
  // happen to pass their own gridLines (e.g. the configured max wheel
  // speed) -- a bare auto-scaled line chart with no labels leaves no way to
  // tell a 1-unit wobble from a 100-unit one. Skipped when tieredGridFn is
  // in play (that grid's own tick spacing already implies scale, and it's
  // too dense to label every line without clutter).
  const AUTO_GRID_TICK_COUNT = 4;
  const displayGridLines = gridLines
    ? gridLines
    : tieredGridFn
      ? null
      : (() => {
          const step = (maxV - minV) / AUTO_GRID_TICK_COUNT;
          const decimals = step < 1 ? 2 : step < 10 ? 1 : 0;
          return Array.from({ length: AUTO_GRID_TICK_COUNT + 1 }, (_, i) => {
            const v = minV + step * i;
            return { value: v, label: v.toFixed(decimals) };
          });
        })();

  if (tieredGridFn) {
    ctx.setLineDash([]);
    for (const tier of tieredGridFn(minV, maxV)) {
      ctx.strokeStyle = tier.color;
      ctx.lineWidth = tier.lineWidth || 1;
      for (const value of tier.values) {
        const y = yOf(value);
        ctx.beginPath();
        ctx.moveTo(padding, y);
        ctx.lineTo(padding + w, y);
        ctx.stroke();
      }
    }
  }

  if (displayGridLines) {
    ctx.strokeStyle = "#ddd";
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.font = "9px sans-serif";
    ctx.fillStyle = "#999";
    for (const g of displayGridLines) {
      const y = yOf(g.value);
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(padding + w, y);
      ctx.stroke();
      ctx.fillText(g.label, padding + 2, y - 2);
    }
  }

  for (const s of seriesList) {
    if (s.buffer.length < 2) continue;
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.setLineDash(s.dash);
    ctx.beginPath();
    s.buffer.forEach((p, i) => {
      const x = xOf(p.t);
      const y = yOf(p.v);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }
  ctx.setLineDash([]);
}

const GOTO_COLOR_LEFT = "#2c9aff";
const GOTO_COLOR_RIGHT = "#ff8a2c";

// Reference grid lines, computed at draw time (not baked into gotoGraphs at
// load time) so they always reflect the LIVE setting value, not whatever
// was in effect when the page first loaded.
function makeWheelVelGridLines() {
  const maxV = Math.ceil(maxWheelSpeedRevPerSec);
  const lines = [];
  for (let v = -maxV; v <= maxV; v++) {
    lines.push({ value: v, label: `${v}` });
  }
  return lines;
}
function makeHeadingGridLines() {
  return [-180, -90, 0, 90, 180].map((v) => ({ value: v, label: `${v}°` }));
}
function makePwmGridLines() {
  return [
    { value: 0, label: "0" },
    { value: maxMotorPowerPwm, label: "max" },
  ];
}

// Same three-tier idea as the live map's grid (drawGridTier in drawMap()):
// minor/medium/major intervals in increasing color darkness, each skipped
// if the current range would pack in too many lines to be useful. Lower
// maxLines than the map's own thresholds (60/60/200) since these graphs are
// only ~90px tall after padding vs. the map's 360px canvas - the map's
// thresholds would pack lines closer than a couple pixels apart here.
const WORLD_POS_GRID_TIERS = [
  { interval: 0.1, color: "#eee", lineWidth: 1, maxLines: 15 },
  { interval: 0.5, color: "#ccc", lineWidth: 1, maxLines: 15 },
  { interval: 1.0, color: "#999", lineWidth: 1.5, maxLines: 40 },
];

function makeWorldPosTieredGrid(minV, maxV) {
  const span = maxV - minV;
  const result = [];
  for (const tier of WORLD_POS_GRID_TIERS) {
    if (span / tier.interval > tier.maxLines) continue;
    const values = [];
    for (let v = Math.floor(minV / tier.interval) * tier.interval; v <= maxV; v += tier.interval) {
      values.push(v);
    }
    result.push({ color: tier.color, lineWidth: tier.lineWidth, values });
  }
  return result;
}

const gotoGraphs = {
  wheelPos: {
    canvasId: "gotoWheelPosGraph",
    series: [makeSeries(GOTO_COLOR_LEFT, DASH_SOLID), makeSeries(GOTO_COLOR_LEFT, DASH_DASHED), makeSeries(GOTO_COLOR_RIGHT, DASH_SOLID), makeSeries(GOTO_COLOR_RIGHT, DASH_DASHED)],
  },
  wheelVel: {
    canvasId: "gotoWheelVelGraph",
    series: [makeSeries(GOTO_COLOR_LEFT, DASH_SOLID), makeSeries(GOTO_COLOR_LEFT, DASH_DASHED), makeSeries(GOTO_COLOR_RIGHT, DASH_SOLID), makeSeries(GOTO_COLOR_RIGHT, DASH_DASHED)],
    gridLinesFn: makeWheelVelGridLines,
    extendRangeToGridLines: false, // keep this one tightly auto-scaled to actual data, not forced to the full speed range
  },
  worldX: {
    canvasId: "gotoWorldXGraph",
    series: [makeSeries(GOTO_COLOR_LEFT, DASH_SOLID), makeSeries(GOTO_COLOR_LEFT, DASH_DASHED)],
    tieredGridFn: makeWorldPosTieredGrid,
  },
  worldY: {
    canvasId: "gotoWorldYGraph",
    series: [makeSeries(GOTO_COLOR_LEFT, DASH_SOLID), makeSeries(GOTO_COLOR_LEFT, DASH_DASHED)],
    tieredGridFn: makeWorldPosTieredGrid,
  },
  heading: {
    canvasId: "gotoHeadingGraph",
    series: [makeSeries(GOTO_COLOR_LEFT, DASH_SOLID), makeSeries(GOTO_COLOR_LEFT, DASH_DASHED)],
    gridLinesFn: makeHeadingGridLines,
  },
  pwm: {
    canvasId: "gotoPwmGraph",
    series: [makeSeries(GOTO_COLOR_LEFT, DASH_SOLID), makeSeries(GOTO_COLOR_RIGHT, DASH_SOLID)],
    gridLinesFn: makePwmGridLines,
  },
  pwmComponents: {
    canvasId: "gotoPwmComponentsGraph",
    // ff/P/I per wheel: solid=ff, dashed=P, dotted=I, blue=left, orange=right
    series: [
      makeSeries(GOTO_COLOR_LEFT, DASH_SOLID),
      makeSeries(GOTO_COLOR_LEFT, DASH_DASHED),
      makeSeries(GOTO_COLOR_LEFT, DASH_DOTTED),
      makeSeries(GOTO_COLOR_RIGHT, DASH_SOLID),
      makeSeries(GOTO_COLOR_RIGHT, DASH_DASHED),
      makeSeries(GOTO_COLOR_RIGHT, DASH_DOTTED),
    ],
  },
};

function updateGotoGraphs(msg) {
  const t = performance.now();

  pushSample(gotoGraphs.wheelPos.series[0], t, msg.wheelPosRev[0]);
  pushSample(gotoGraphs.wheelPos.series[1], t, msg.gotoWheelPosSetpointRev[0]);
  pushSample(gotoGraphs.wheelPos.series[2], t, msg.wheelPosRev[1]);
  pushSample(gotoGraphs.wheelPos.series[3], t, msg.gotoWheelPosSetpointRev[1]);

  pushSample(gotoGraphs.wheelVel.series[0], t, msg.wheelVelRevPerSec[0]);
  pushSample(gotoGraphs.wheelVel.series[1], t, msg.gotoWheelVelSetpointRevPerSec[0]);
  pushSample(gotoGraphs.wheelVel.series[2], t, msg.wheelVelRevPerSec[1]);
  pushSample(gotoGraphs.wheelVel.series[3], t, msg.gotoWheelVelSetpointRevPerSec[1]);

  pushSample(gotoGraphs.worldX.series[0], t, msg.x);
  pushSample(gotoGraphs.worldX.series[1], t, msg.goalX);
  pushSample(gotoGraphs.worldY.series[0], t, msg.y);
  pushSample(gotoGraphs.worldY.series[1], t, msg.goalY);
  pushSample(gotoGraphs.heading.series[0], t, (msg.theta * 180) / Math.PI);
  pushSample(gotoGraphs.heading.series[1], t, (msg.gotoTargetHeadingRad * 180) / Math.PI);

  pushSample(gotoGraphs.pwm.series[0], t, msg.motorPowerPwm[0]);
  pushSample(gotoGraphs.pwm.series[1], t, msg.motorPowerPwm[1]);

  pushSample(gotoGraphs.pwmComponents.series[0], t, msg.gotoFfPwm[0]);
  pushSample(gotoGraphs.pwmComponents.series[1], t, msg.gotoPPwm[0]);
  pushSample(gotoGraphs.pwmComponents.series[2], t, msg.gotoIPwm[0]);
  pushSample(gotoGraphs.pwmComponents.series[3], t, msg.gotoFfPwm[1]);
  pushSample(gotoGraphs.pwmComponents.series[4], t, msg.gotoPPwm[1]);
  pushSample(gotoGraphs.pwmComponents.series[5], t, msg.gotoIPwm[1]);

  for (const key in gotoGraphs) {
    const g = gotoGraphs[key];
    drawTimeSeriesGraph(g.canvasId, g.series, GOTO_GRAPH_WINDOW_SEC, t, {
      gridLines: g.gridLinesFn ? g.gridLinesFn() : undefined,
      extendRangeToGridLines: g.extendRangeToGridLines,
      tieredGridFn: g.tieredGridFn,
    });
  }

  document.getElementById("gotoWheelPosStats").textContent =
    `Left: ${msg.wheelPosRev[0].toFixed(3)} rev / Right: ${msg.wheelPosRev[1].toFixed(3)} rev`;

  document.getElementById("gotoWheelVelStats").textContent =
    `Left: ${msg.wheelVelRevPerSec[0].toFixed(3)} rev/s / Right: ${msg.wheelVelRevPerSec[1].toFixed(3)} rev/s`;
}

function clearGotoGraphs() {
  for (const key in gotoGraphs) {
    const g = gotoGraphs[key];
    g.series.forEach((s) => (s.buffer.length = 0));
    const canvas = document.getElementById(g.canvasId);
    canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  }
  document.getElementById("gotoWheelPosStats").textContent = "";
  document.getElementById("gotoWheelVelStats").textContent = "";
}

// --- Power: live voltage/current from the INA260 current sensor, sent
// unconditionally on every "pose" message (see ws_broadcast.cpp) since it's
// only three small fields -- no opt-in gate needed like goto/sysstats'
// much larger payloads.
const inaVoltageSeries = makeSeries(GOTO_COLOR_LEFT, DASH_SOLID);
const inaCurrentSeries = makeSeries(GOTO_COLOR_RIGHT, DASH_SOLID);

function updateInaGraphs(msg) {
  document.getElementById("ina260-unavailable").style.display = msg.inaAvailable ? "none" : "";
  if (!msg.inaAvailable) {
    document.getElementById("ina260-stats").textContent = "";
    return;
  }

  const t = performance.now();
  pushSample(inaVoltageSeries, t, msg.inaVoltageV);
  pushSample(inaCurrentSeries, t, msg.inaCurrentMa);
  drawTimeSeriesGraph("inaVoltageGraph", [inaVoltageSeries], GOTO_GRAPH_WINDOW_SEC, t, {});
  drawTimeSeriesGraph("inaCurrentGraph", [inaCurrentSeries], GOTO_GRAPH_WINDOW_SEC, t, {});

  document.getElementById("ina260-stats").textContent =
    `${msg.inaVoltageV.toFixed(2)} V, ${msg.inaCurrentMa.toFixed(0)} mA, ${(msg.inaPowerMw / 1000).toFixed(2)} W`;
}

// The S3 CAM panel used to embed a live <img> preview here, pointed straight
// at the cam's MJPEG stream. Removed: tucked inside a collapsed panel, it
// kept decoding a live video stream in the background even when nobody was
// looking at it, for no benefit over just clicking through to the cam's own
// page (which itself links to its native /stream). This panel is now purely
// informational -- the cam's IP is never entered or stored anywhere, only
// relayed live from the cam over UART (see uart_link.cpp) and read back via
// /camdiag, same source the diagnostics fields below already use.

// A link that does nothing when clicked (still at href="#", nothing known
// yet) is confusing on its own -- greyed out and unclickable instead makes
// "the robot doesn't have a live cam IP right now" visible rather than a
// silent no-op.
function setAdminLink(id, address) {
  const el = document.getElementById(id);
  if (address) {
    el.href = `http://${address}/`;
    el.classList.remove("link-disabled");
  } else {
    el.href = "#";
    el.classList.add("link-disabled");
  }
}

// --- S3 CAM diagnostics: relayed from the cam over its UART link to this
// board (uart_link.cpp), plus this board's own live ICMP ping to it
// (ping_diag.cpp) -- see handle_cam_diag() in web_server.cpp. Polled only
// while the S3 CAM panel is open; nobody's looking at it otherwise, so
// there's no reason to keep hitting the robot every second in the
// background.

let s3camDiagTimer = null;

function formatUptime(totalSeconds) {
  const s = Math.floor(totalSeconds % 60);
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

// Reasons the cam wouldn't reboot on its own during normal operation --
// distinct from the routine POWERON/SW/USB/JTAG a reflash or RTS-toggle
// produces during development, which aren't worth flagging.
const CAM_RESET_REASON_WARN = new Set([
  "BROWNOUT", "PANIC", "TASK_WDT", "INT_WDT", "WDT", "CPU_LOCKUP", "EFUSE", "PWR_GLITCH",
]);

function setDiagField(id, text, warn) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.classList.toggle("diag-warn", !!warn);
}

function updateCamDiagDisplay(d) {
  const camReachable = !d.stale && d.ip && d.ip !== "0.0.0.0";
  setAdminLink("s3camAdminLink", camReachable ? d.ip : "");

  setDiagField("s3camResetReason", d.resetReason || "-", CAM_RESET_REASON_WARN.has(d.resetReason));
  setDiagField("s3camReboots", String(d.rebootCount), false);
  setDiagField("s3camRssi", d.rssiDbm ? `${d.rssiDbm} dBm` : "-", d.rssiDbm !== 0 && d.rssiDbm < -75);
  setDiagField("s3camFailCount", String(d.camFailCount), d.camFailCount > 0);
  setDiagField("s3camUptime", formatUptime(d.uptimeS), false);
  setDiagField("s3camHeap", `${Math.round(d.freeHeapBytes / 1024)} KB`, false);
  setDiagField("s3camClients", String(d.clients), false);

  if (d.pingActive) {
    setDiagField("s3camPing", `${d.pingAvgRttMs} / ${d.pingLastRttMs} ms`, d.pingAvgRttMs > 200);
    const lossPct = d.pingSent > 0 ? Math.round((1 - d.pingReceived / d.pingSent) * 100) : 0;
    setDiagField("s3camPingLoss", `${lossPct}%`, lossPct > 10);
  } else {
    setDiagField("s3camPing", "-", false);
    setDiagField("s3camPingLoss", "-", false);
  }

  document.getElementById("s3camDiagBlock").classList.toggle("diag-stale", !!d.stale);
}

function pollCamDiag() {
  fetch("/camdiag")
    .then((r) => r.json())
    .then(updateCamDiagDisplay)
    .catch(() => {}); // transient fetch failure -- next tick will retry
}

function startCamDiagPolling() {
  stopCamDiagPolling();
  pollCamDiag();
  s3camDiagTimer = setInterval(pollCamDiag, 1000);
}

function stopCamDiagPolling() {
  if (s3camDiagTimer !== null) {
    clearInterval(s3camDiagTimer);
    s3camDiagTimer = null;
  }
}

// --- Persistent UI state: collapsible panel open/closed + diagnostics
// checkboxes, remembered per-browser across page loads via localStorage.
// Purely cosmetic/client-side - never sent to the robot.

const PANEL_STATE_STORAGE_KEY = "panelOpenState";

// Restores each <details class="panel"> element's open/closed state from
// localStorage (falling back to its state as authored in index.html for any
// panel never toggled before), then wires it to keep saving future toggles.
function restorePanelStates() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(PANEL_STATE_STORAGE_KEY)) || {};
  } catch (e) {
    saved = {};
  }
  document.querySelectorAll("details.panel[id]").forEach((panel) => {
    if (Object.prototype.hasOwnProperty.call(saved, panel.id)) {
      panel.open = saved[panel.id];
    }
    panel.addEventListener("toggle", () => {
      saved[panel.id] = panel.open;
      localStorage.setItem(PANEL_STATE_STORAGE_KEY, JSON.stringify(saved));
    });
  });
}

// --- Panel layout: which .panel-column container each panel lives in and
// in what order, remembered per-browser via localStorage. Panels are
// dragged by a small grip handle injected into each panel's <summary>;
// drag mechanics mirror the joystick's mousedown/touchstart +
// mousemove/touchmove + mouseup/touchend pattern rather than native HTML5
// drag-and-drop, for consistency and touch support.
//
// The number of .panel-column containers is NOT fixed at 4 - it's derived
// from however many currently fit (computeColumnCount()) and panels are
// always laid out in a single row of that many columns (layoutColumns()),
// never left to CSS flex-wrap. flex-wrap is row-based: with a fixed 4
// columns, a viewport only wide enough for 2 per row would wrap into 2
// rows, and the 2nd row starts below the TALLER of row 1's two columns -
// leaving a visible gap under the shorter one. A single row of
// however-many-fit has no "next row" to leave a gap before.

const PANEL_LAYOUT_STORAGE_KEY = "panelLayout";
const PANEL_COLUMN_WIDTH = 320;
const MAX_PANEL_COLUMNS = 4;

// The authored order in index.html, captured once at script load (before
// any column wrapping happens, since panels are flat children of
// .container in the HTML) - both the no-saved-layout-yet default and the
// fallback for any panel id a saved order doesn't mention (e.g. one added
// in a later firmware update).
const DEFAULT_PANEL_ORDER = Array.from(document.querySelectorAll(".container > details.panel[id]")).map(
  (el) => el.id
);

let draggingPanel = null;

function dragEventPoint(e) {
  if (e.touches && e.touches.length > 0) {
    return { x: e.touches[0].clientX, y: e.touches[0].clientY };
  }
  return { x: e.clientX, y: e.clientY };
}

// Adds a drag handle to every panel's <summary>. Injected via JS (rather
// than hand-added to every <summary> in index.html) so any panel added
// later automatically gets one.
function injectDragHandles() {
  document.querySelectorAll("details.panel[id] > summary").forEach((summary) => {
    const handle = document.createElement("span");
    handle.className = "panel-drag-handle";
    handle.title = "Drag to move panel";
    // <details> toggles open/closed on the summary's "click" event -
    // without this, clicking the handle to start a drag would also toggle
    // the panel it's meant to be dragging.
    handle.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    handle.addEventListener("mousedown", (e) => startPanelDrag(e, summary.parentElement));
    handle.addEventListener("touchstart", (e) => startPanelDrag(e, summary.parentElement), {
      passive: false,
    });
    summary.appendChild(handle);
  });
}

function startPanelDrag(e, panel) {
  if (document.getElementById("lockPanelLayout").checked) return;
  e.preventDefault();
  draggingPanel = panel;
  panel.classList.add("panel-dragging");
  document.body.classList.add("panel-drag-active");

  window.addEventListener("mousemove", handlePanelDragMove);
  window.addEventListener("touchmove", handlePanelDragMove, { passive: false });
  window.addEventListener("mouseup", endPanelDrag);
  window.addEventListener("touchend", endPanelDrag);
}

function handlePanelDragMove(e) {
  if (!draggingPanel) return;
  e.preventDefault();
  movePanelToPoint(dragEventPoint(e));
}

// Hit-tests the pointer against the current .panel-column containers (nearest by
// horizontal center if the pointer is outside all of them - this is what
// keeps an emptied-out column reachable as a drop target) and against the
// target column's current panels' vertical midpoints, then moves the
// dragged panel's actual DOM node there if that differs from where it
// already is. Moving the real node (rather than a floating clone) means
// its open/closed state and any live content (map canvas, in-progress
// graphs) survive the move untouched.
function movePanelToPoint(point) {
  const columns = Array.from(document.querySelectorAll(".panel-column"));
  if (columns.length === 0) return;

  let targetColumn = columns[0];
  let bestDist = Infinity;
  columns.forEach((col) => {
    const rect = col.getBoundingClientRect();
    if (point.x >= rect.left && point.x <= rect.right) {
      targetColumn = col;
      bestDist = -Infinity;
      return;
    }
    const center = (rect.left + rect.right) / 2;
    const dist = Math.abs(point.x - center);
    if (dist < bestDist) {
      bestDist = dist;
      targetColumn = col;
    }
  });

  const siblings = Array.from(targetColumn.children).filter((el) => el !== draggingPanel);
  let insertBefore = null;
  for (const sib of siblings) {
    const rect = sib.getBoundingClientRect();
    const mid = rect.top + rect.height / 2;
    if (point.y < mid) {
      insertBefore = sib;
      break;
    }
  }

  if (insertBefore) {
    if (draggingPanel.nextSibling !== insertBefore) {
      targetColumn.insertBefore(draggingPanel, insertBefore);
    }
  } else if (targetColumn.lastElementChild !== draggingPanel) {
    targetColumn.appendChild(draggingPanel);
  }
}

function endPanelDrag() {
  if (!draggingPanel) return;
  draggingPanel.classList.remove("panel-dragging");
  document.body.classList.remove("panel-drag-active");
  draggingPanel = null;

  window.removeEventListener("mousemove", handlePanelDragMove);
  window.removeEventListener("touchmove", handlePanelDragMove);
  window.removeEventListener("mouseup", endPanelDrag);
  window.removeEventListener("touchend", endPanelDrag);

  savePanelLayout();
}

// Flattens the current on-screen column order (left-to-right, top-to-
// bottom within each column) into one array and persists it - the single
// source of truth for "the user's panel order," independent of however
// many columns it happened to be split across when saved.
function savePanelLayout() {
  const order = Array.from(document.querySelectorAll(".panel-column")).flatMap((col) =>
    Array.from(col.children)
      .filter((el) => el.matches("details.panel[id]"))
      .map((el) => el.id)
  );
  localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(order));
}

// Reads the saved flat panel order, transparently migrating the older
// per-column (array-of-arrays) format if that's what's stored. Ids from a
// stale save that no longer exist are dropped; current panel ids the save
// doesn't mention (e.g. a panel added in a later firmware update) are
// appended in their DEFAULT_PANEL_ORDER position, so nothing silently
// disappears.
function loadPanelOrder() {
  let saved;
  try {
    saved = JSON.parse(localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY));
  } catch (e) {
    saved = null;
  }

  let order;
  if (Array.isArray(saved) && saved.every((x) => typeof x === "string")) {
    order = saved;
  } else if (Array.isArray(saved) && saved.every((x) => Array.isArray(x))) {
    order = saved.flat();
  } else {
    order = [];
  }

  order = order.filter((id) => document.getElementById(id));
  DEFAULT_PANEL_ORDER.forEach((id) => {
    if (!order.includes(id)) order.push(id);
  });
  return order;
}

// How many PANEL_COLUMN_WIDTH-wide columns currently fit, reading the
// live (post-media-query) body padding and container gap via
// getComputedStyle rather than duplicating those breakpoint values here,
// so this stays correct if the CSS spacing is ever retuned. Capped at
// MAX_PANEL_COLUMNS (4) - the desktop layout this was originally sized
// for - rather than growing further on very wide monitors.
function computeColumnCount() {
  const bodyStyle = getComputedStyle(document.body);
  const bodyPadding = parseFloat(bodyStyle.paddingLeft) + parseFloat(bodyStyle.paddingRight);
  const containerStyle = getComputedStyle(document.querySelector(".container"));
  const gap = parseFloat(containerStyle.columnGap) || 0;
  const available = window.innerWidth - bodyPadding;
  const count = Math.floor((available + gap) / (PANEL_COLUMN_WIDTH + gap));
  return Math.max(1, Math.min(MAX_PANEL_COLUMNS, count));
}

// Rebuilds the .panel-column containers from scratch and distributes
// `order` into exactly `count` of them as contiguous chunks (as evenly
// sized as possible) - contiguous rather than round-robin so panels that
// are next to each other in `order` (typically related - see the grouping
// in index.html's authored order) stay together in the same column
// instead of getting interleaved across columns.
function layoutColumns(order, count) {
  const container = document.querySelector(".container");
  // Resolve every panel element BEFORE removing the old .panel-column
  // divs: removing a column also detaches its child panels from the
  // document, and document.getElementById() can't find a detached
  // element - looking them up afterwards would silently return null for
  // everything and leave the page empty.
  const panels = order.map((id) => document.getElementById(id)).filter((el) => el);

  container.querySelectorAll(".panel-column").forEach((col) => col.remove());

  const base = Math.floor(panels.length / count);
  const remainder = panels.length % count;
  let idx = 0;
  for (let c = 0; c < count; c++) {
    const column = document.createElement("div");
    column.className = "panel-column";
    const chunkSize = base + (c < remainder ? 1 : 0);
    for (let i = 0; i < chunkSize; i++, idx++) {
      column.appendChild(panels[idx]);
    }
    container.appendChild(column);
  }
}

let currentColumnCount = 0;

// Re-derives the column count from the current viewport and only touches
// the DOM if it actually changed - called on load and (debounced) on
// resize/rotation. Skipped while a drag is in progress: rebuilding the
// .panel-column containers out from under an active drag (e.g. a phone
// auto-rotating mid-drag) would orphan the dragged node's drag-tracking.
function relayoutPanels() {
  if (draggingPanel) return;
  const count = computeColumnCount();
  if (count === currentColumnCount) return;
  currentColumnCount = count;
  layoutColumns(loadPanelOrder(), count);
}

let relayoutResizeTimer = null;
window.addEventListener("resize", () => {
  clearTimeout(relayoutResizeTimer);
  relayoutResizeTimer = setTimeout(relayoutPanels, 150);
});

// Restores a checkbox's checked state from localStorage under its own id as
// key, then keeps it in sync on every change. Returns the restored value so
// the caller can trigger whatever side effect normally follows a change
// event (setting .checked programmatically does not fire "change").
function restorePersistentCheckbox(id) {
  const el = document.getElementById(id);
  const saved = localStorage.getItem(id);
  if (saved !== null) {
    el.checked = saved === "true";
  }
  el.addEventListener("change", () => {
    localStorage.setItem(id, el.checked);
  });
  return el.checked;
}

// Same as restorePersistentCheckbox but for a number input - falls back to
// defaultValue when nothing (or something unparseable) was saved yet.
function restorePersistentNumberInput(id, defaultValue) {
  const el = document.getElementById(id);
  const saved = localStorage.getItem(id);
  el.value = saved !== null && !Number.isNaN(parseFloat(saved)) ? saved : defaultValue;
  el.addEventListener("change", () => {
    localStorage.setItem(id, el.value);
  });
  return parseFloat(el.value);
}

// --- Waypoints: named (x,y,heading) locations, stored on the ROBOT (not
// localStorage) so every connected device sees the same list. This used to
// be per-browser localStorage, which is why a Camera page open on a
// different device than the one waypoints were created on only ever showed
// Home - localStorage never syncs across devices. GET/POST /waypoints (see
// waypoints.hpp/.cpp) persists the exact same JSON shape that used to be
// JSON.stringify'd locally; the robot treats it as an opaque blob, so this
// schema lives entirely here.

const WAYPOINTS_STORAGE_KEY = "waypoints"; // legacy localStorage key, read once for migration only - see loadWaypoints()
// Home is a fixed, always-present waypoint that is never sent to the robot
// - keeping it out of storage entirely (rather than storing it
// flagged/protected) means there's no code path that could ever accidentally
// load a corrupted/edited "Home" entry from a stale blob.
const HOME_WAYPOINT = Object.freeze({ name: "Home", x: 0, y: 0, heading: 0, isHome: true });

// One-time migration: if the robot has no waypoints yet but this browser's
// localStorage does (left over from before waypoints moved server-side),
// upload them once so this device's existing work isn't silently lost.
// Only ever fires for whichever device happens to load this page first
// after the firmware update - if different devices had drifted to
// different local waypoint sets already (the exact bug this migration is
// meant to leave behind), there's no way to merge those after the fact;
// this just makes sure SOME data survives rather than none.
async function loadWaypoints() {
  let serverWaypoints;
  try {
    const res = await fetch("/waypoints");
    const data = await res.json();
    serverWaypoints = Array.isArray(data) ? data : [];
  } catch (e) {
    console.warn("Failed to load waypoints from robot:", e);
    return [];
  }

  if (serverWaypoints.length === 0) {
    let legacyLocal;
    try {
      legacyLocal = JSON.parse(localStorage.getItem(WAYPOINTS_STORAGE_KEY));
    } catch (e) {
      legacyLocal = null;
    }
    if (Array.isArray(legacyLocal) && legacyLocal.length > 0) {
      console.log(`Migrating ${legacyLocal.length} waypoint(s) from localStorage to robot storage.`);
      serverWaypoints = legacyLocal;
      await saveWaypointsList(serverWaypoints);
      localStorage.removeItem(WAYPOINTS_STORAGE_KEY);
    }
  }
  return serverWaypoints;
}

// Persists an explicit list (used by loadWaypoints()'s migration, which
// runs before `waypoints` itself is assigned) as well as saveWaypoints()
// below (the normal post-mutation save, which always persists the current
// `waypoints`).
async function saveWaypointsList(list) {
  try {
    await fetch("/waypoints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(list),
    });
  } catch (e) {
    console.warn("Failed to save waypoints to robot:", e);
  }
}

function saveWaypoints() {
  // Fire-and-forget: callers already update the local `waypoints` array
  // and re-render the table immediately (optimistic UI), matching the old
  // synchronous localStorage.setItem()'s instant feel - this just persists
  // the same data to the robot in the background instead.
  saveWaypointsList(waypoints);
}

// Low-frequency background poll (not tied to any per-tick telemetry) so a
// waypoint added/edited/removed on a DIFFERENT device shows up here too,
// without needing a manual reload - this is the actual "consistent across
// devices" part, since a plain load-once fetch would only ever reflect
// whatever existed when this page was opened. Only touches the local
// `waypoints` array/table while the panel is actually open (no point
// refreshing what isn't visible) and NOT mid-edit (an in-progress edit's
// unsaved text would otherwise vanish out from under the user the moment a
// background refresh re-renders the table).
const WAYPOINTS_BACKGROUND_REFRESH_MS = 5000;

function startWaypointsBackgroundRefresh() {
  setInterval(() => {
    const panel = document.getElementById("panel-waypoints");
    if (!panel.open || editingWaypoint) return;
    fetch("/waypoints")
      .then((res) => res.json())
      .then((data) => {
        if (!Array.isArray(data)) return;
        waypoints = data;
        selectedWaypointIndex = null; // list contents may have shifted under the old index
        renderWaypointsTable();
      })
      .catch(() => {}); // keep polling through a transient failure (e.g. brief Wi-Fi hiccup)
  }, WAYPOINTS_BACKGROUND_REFRESH_MS);
}

function fullWaypointList() {
  return [HOME_WAYPOINT, ...waypoints];
}

function makeCell(text) {
  const td = document.createElement("td");
  td.textContent = text;
  return td;
}

function makeEditCell(type, id, value, step) {
  const td = document.createElement("td");
  const input = document.createElement("input");
  input.type = type;
  input.id = id;
  input.value = value;
  if (step) input.step = step;
  td.appendChild(input);
  return td;
}

function updateWaypointActionButtons() {
  const list = fullWaypointList();
  const selected = selectedWaypointIndex !== null ? list[selectedWaypointIndex] : null;
  const isHomeSelected = !!(selected && selected.isHome);
  document.getElementById("waypointEditBtn").disabled = !selected || isHomeSelected || editingWaypoint;
  document.getElementById("waypointRemoveBtn").disabled = !selected || isHomeSelected || editingWaypoint;
  document.getElementById("waypointGotoBtn").disabled = !selected || editingWaypoint;
  document.getElementById("waypointSetPoseBtn").disabled = !selected || editingWaypoint;
  document.getElementById("waypointEditActions").style.display = editingWaypoint ? "block" : "none";
}

// Builds rows via DOM methods rather than innerHTML string interpolation:
// waypoint names are arbitrary user text, persisted and re-rendered on every
// load, so unescaped innerHTML would be an HTML-injection hole the moment a
// name contains '<'/'>'/'&'.
function renderWaypointsTable() {
  const tbody = document.getElementById("waypoints-tbody");
  tbody.innerHTML = "";
  const list = fullWaypointList();
  list.forEach((wp, i) => {
    const tr = document.createElement("tr");
    if (wp.isHome) tr.classList.add("home-row");
    if (i === selectedWaypointIndex) tr.classList.add("selected");

    if (editingWaypoint && i === selectedWaypointIndex && !wp.isHome) {
      tr.appendChild(makeEditCell("text", "waypointEditName", wp.name));
      tr.appendChild(makeEditCell("number", "waypointEditX", wp.x, "0.01"));
      tr.appendChild(makeEditCell("number", "waypointEditY", wp.y, "0.01"));
      tr.appendChild(makeEditCell("number", "waypointEditHeadingDeg", ((wp.heading * 180) / Math.PI).toFixed(1), "1"));
    } else {
      tr.appendChild(makeCell(wp.name));
      tr.appendChild(makeCell(wp.x.toFixed(3)));
      tr.appendChild(makeCell(wp.y.toFixed(3)));
      tr.appendChild(makeCell(`${((wp.heading * 180) / Math.PI).toFixed(1)}°`));
    }
    tr.addEventListener("click", () => {
      if (editingWaypoint) return; // must Save/Cancel first
      selectedWaypointIndex = i;
      renderWaypointsTable();
    });
    tbody.appendChild(tr);
  });
  updateWaypointActionButtons();
  drawMap();
}

function wrapToPi(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function updateWaypointAutoAdvanceStatus() {
  const status = document.getElementById("waypointAutoAdvanceStatus");
  if (autoAdvanceActive && autoAdvanceTargetIndex !== null) {
    const wp = fullWaypointList()[autoAdvanceTargetIndex];
    status.textContent = wp ? `Patrolling - heading to: ${wp.name}` : "";
  } else {
    status.textContent = "";
  }
}

// Sends the robot to fullWaypointList()[index], mirroring waypointGotoBtn's
// own handler (goalMarker + WS "goto" + mode highlight). Tags the message
// with maintainSpeed whenever this is part of an active patrol loop, so the
// firmware skips its distance-proportional slowdown - there's no need to
// crawl in for a precise stop when the next waypoint is about to supersede
// this one anyway. A one-off Go To (autoAdvanceActive false) still ramps
// down normally for accurate stopping.
function commandGotoWaypoint(index) {
  const wp = fullWaypointList()[index];
  if (!wp) return;
  goalMarker = { x: wp.x, y: wp.y, heading: wp.heading };
  sendWs({ type: "goto", x: wp.x, y: wp.y, heading: wp.heading, maintainSpeed: autoAdvanceActive });
  updateModeHighlight("4");
}

// Called on every "pose" telemetry message while a patrol loop is active:
// checks whether the robot has reached the current target (position, plus
// heading if gotoPreserveHeading is on - otherwise a patrol loop would move
// on mid-rotation, defeating the point of preserving heading at a stop) and,
// if so, advances to the next waypoint in the list, wrapping back to the
// start. Requires at least 2 waypoints (Home + >=1 more) - with just Home
// alone, "next" would be Home itself, re-triggering every single pose tick.
function checkWaypointAutoAdvance() {
  if (!autoAdvanceActive || !document.getElementById("waypointAutoAdvance").checked) {
    return;
  }
  const list = fullWaypointList();
  if (list.length < 2 || autoAdvanceTargetIndex === null) {
    return;
  }
  const target = list[autoAdvanceTargetIndex % list.length];
  const dist = Math.hypot(latestPose.x - target.x, latestPose.y - target.y);
  if (dist >= WAYPOINT_ARRIVAL_TOLERANCE_M) {
    return;
  }
  if (document.getElementById("gotoPreserveHeading").checked) {
    const headingError = wrapToPi(target.heading - latestPose.theta);
    if (Math.abs(headingError) >= WAYPOINT_HEADING_ARRIVAL_TOLERANCE_RAD) {
      return;
    }
  }
  autoAdvanceTargetIndex = (autoAdvanceTargetIndex + 1) % list.length;
  selectedWaypointIndex = autoAdvanceTargetIndex;
  commandGotoWaypoint(autoAdvanceTargetIndex);
  updateWaypointAutoAdvanceStatus();
  renderWaypointsTable();
}

// --- Live map ---

const MAP_MARGIN_FRACTION = 0.12; // reserved padding on each side, as a fraction of canvas size
// Half-width of the box seeded around the robot's own position below - a
// floor of 1m in every direction from the robot's center, independent of
// wherever the trail/goal extend to.
const MAP_MIN_CLEARANCE_AROUND_ROBOT_M = 1.0;

// User-controlled zoom on top of the auto-fit view below (mouse wheel /
// touch pinch over the map canvas) - 1 = auto-fit exactly, >1 = zoomed in.
// Anchored on the auto-fit center rather than the cursor/pinch midpoint:
// since the view already re-centers on the robot/trail/goal bounding box
// every frame, a cursor-anchored zoom would fight that recentering the
// moment the robot moves. Persisted across reloads like the other map/UI
// state (panel open state, S3 CAM address).
const MAP_ZOOM_STORAGE_KEY = "mapZoomFactor";
const MAP_ZOOM_MIN = 0.2;
const MAP_ZOOM_MAX = 10;
let mapZoomFactor = parseFloat(localStorage.getItem(MAP_ZOOM_STORAGE_KEY)) || 1;

function setMapZoomFactor(z) {
  mapZoomFactor = Math.min(MAP_ZOOM_MAX, Math.max(MAP_ZOOM_MIN, z));
  localStorage.setItem(MAP_ZOOM_STORAGE_KEY, mapZoomFactor);
  drawMap();
}

// Fits the whole recorded route (trail + current position + goal) into the
// canvas: returns the world-space center and a uniform px/meter scale.
// Starting the bounds as a box around the robot (rather than a single
// point) guarantees it keeps at least MAP_MIN_CLEARANCE_AROUND_ROBOT_M of
// clearance on every side - trail/goal points can only widen these bounds
// further, never pull them in tighter than that floor.
function computeMapView(canvas) {
  let xMin = latestPose.x - MAP_MIN_CLEARANCE_AROUND_ROBOT_M;
  let xMax = latestPose.x + MAP_MIN_CLEARANCE_AROUND_ROBOT_M;
  let yMin = latestPose.y - MAP_MIN_CLEARANCE_AROUND_ROBOT_M;
  let yMax = latestPose.y + MAP_MIN_CLEARANCE_AROUND_ROBOT_M;
  for (const p of trail) {
    if (p.x < xMin) xMin = p.x;
    if (p.x > xMax) xMax = p.x;
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
  }
  if (goalMarker) {
    if (goalMarker.x < xMin) xMin = goalMarker.x;
    if (goalMarker.x > xMax) xMax = goalMarker.x;
    if (goalMarker.y < yMin) yMin = goalMarker.y;
    if (goalMarker.y > yMax) yMax = goalMarker.y;
  }
  for (const wp of fullWaypointList()) {
    if (wp.x < xMin) xMin = wp.x;
    if (wp.x > xMax) xMax = wp.x;
    if (wp.y < yMin) yMin = wp.y;
    if (wp.y > yMax) yMax = wp.y;
  }

  const spanX = xMax - xMin;
  const spanY = yMax - yMin;

  const usableW = canvas.width * (1 - 2 * MAP_MARGIN_FRACTION);
  const usableH = canvas.height * (1 - 2 * MAP_MARGIN_FRACTION);
  const scale = Math.min(usableW / spanX, usableH / spanY) * mapZoomFactor;

  let cx = (xMin + xMax) / 2;
  let cy = (yMin + yMax) / 2;

  // At mapZoomFactor 1 the robot is always within view (it's inside its own
  // clearance box above by construction), but zooming in shrinks the
  // visible window around this same centroid - if the trail/waypoints pull
  // the centroid away from the robot's live position, a high enough zoom
  // pushes the robot itself out of frame. Clamp the center so the robot
  // stays within the visible area rather than tracking the centroid
  // unconditionally - this leaves the default (zoomed-out) "fit everything"
  // view untouched, only kicking in once zoom would otherwise lose the robot.
  const halfVisibleW = usableW / 2 / scale;
  const halfVisibleH = usableH / 2 / scale;
  if (latestPose.x < cx - halfVisibleW) cx = latestPose.x + halfVisibleW;
  else if (latestPose.x > cx + halfVisibleW) cx = latestPose.x - halfVisibleW;
  if (latestPose.y < cy - halfVisibleH) cy = latestPose.y + halfVisibleH;
  else if (latestPose.y > cy + halfVisibleH) cy = latestPose.y - halfVisibleH;

  return { cx, cy, scale };
}

// Rotated 90 deg from plain math convention so the robot's initial heading
// (world +x, theta=0) points up the screen instead of right.
function worldToCanvas(x, y, view, canvas) {
  const dx = x - view.cx;
  const dy = y - view.cy;
  return {
    px: canvas.width / 2 - dy * view.scale,
    py: canvas.height / 2 - dx * view.scale,
  };
}

// Inverse of worldToCanvas, for turning a map click back into world coords.
function canvasToWorld(px, py, view, canvas) {
  const dy = (canvas.width / 2 - px) / view.scale;
  const dx = (canvas.height / 2 - py) / view.scale;
  return { x: view.cx + dx, y: view.cy + dy };
}

function robotToWorld(lx, ly, pose) {
  const c = Math.cos(pose.theta);
  const s = Math.sin(pose.theta);
  return {
    x: pose.x + lx * c - ly * s,
    y: pose.y + lx * s + ly * c,
  };
}

function drawMap() {
  const canvas = document.getElementById("map");
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const view = computeMapView(canvas);

  // Visible world-space extent, with a little slack beyond the canvas edges
  // so grid lines run flush to the border instead of stopping short.
  const halfWorldW = canvas.width / 2 / view.scale;
  const halfWorldH = canvas.height / 2 / view.scale;
  const xMin = view.cx - halfWorldW;
  const xMax = view.cx + halfWorldW;
  const yMin = view.cy - halfWorldH;
  const yMax = view.cy + halfWorldH;

  function drawGridTier(interval, strokeStyle, lineWidth, maxLines) {
    if ((xMax - xMin) / interval > maxLines || (yMax - yMin) / interval > maxLines) {
      return; // too dense to be useful at this zoom level
    }
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;
    const startX = Math.floor(xMin / interval) * interval;
    for (let g = startX; g <= xMax; g += interval) {
      const a = worldToCanvas(g, yMin, view, canvas);
      const b = worldToCanvas(g, yMax, view, canvas);
      ctx.beginPath();
      ctx.moveTo(a.px, a.py);
      ctx.lineTo(b.px, b.py);
      ctx.stroke();
    }
    const startY = Math.floor(yMin / interval) * interval;
    for (let g = startY; g <= yMax; g += interval) {
      const a = worldToCanvas(xMin, g, view, canvas);
      const b = worldToCanvas(xMax, g, view, canvas);
      ctx.beginPath();
      ctx.moveTo(a.px, a.py);
      ctx.lineTo(b.px, b.py);
      ctx.stroke();
    }
  }

  // Layered minor -> medium -> major, each drawn on top of the last so the
  // coarser, more important lines always stay visible.
  drawGridTier(0.1, "#eee", 1, 60);
  drawGridTier(0.5, "#ccc", 1, 60);
  drawGridTier(1.0, "#999", 1.5, 200);

  // Path trail
  if (trail.length > 1) {
    ctx.strokeStyle = "#2c9aff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    trail.forEach((p, i) => {
      const { px, py } = worldToCanvas(p.x, p.y, view, canvas);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();
  }

  // Robot body + wheels, sized from geometry
  const wheelbase_m = geometry.wheelbaseMm / 1000;
  const wheelDiameter_m = geometry.wheelDiameterMm / 1000;
  const wheelWidth_m = 0.02;

  function drawPoly(points, fillStyle) {
    ctx.beginPath();
    points.forEach((p, i) => {
      const world = robotToWorld(p.lx, p.ly, latestPose);
      const { px, py } = worldToCanvas(world.x, world.y, view, canvas);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.fillStyle = fillStyle;
    ctx.fill();
  }

  // Left and right wheels
  [wheelbase_m / 2, -wheelbase_m / 2].forEach((ly) => {
    drawPoly(
      [
        { lx: wheelDiameter_m / 2, ly: ly + wheelWidth_m / 2 },
        { lx: wheelDiameter_m / 2, ly: ly - wheelWidth_m / 2 },
        { lx: -wheelDiameter_m / 2, ly: ly - wheelWidth_m / 2 },
        { lx: -wheelDiameter_m / 2, ly: ly + wheelWidth_m / 2 },
      ],
      "#333"
    );
  });

  // Coordinate-frame arrows: both start exactly at the wheel-axle midpoint
  // (robot origin) and are a fixed 10 cm regardless of robot geometry.
  // Red = local +x (forward), green = local +y (towards the left wheel,
  // since wheels are drawn at ly = +-wheelbase_m/2 with the left one at +ly).
  const AXIS_ARROW_LENGTH_M = 0.10;

  function drawAxisArrow(axis, color) {
    const headLength_m = AXIS_ARROW_LENGTH_M * 0.4;
    const headWidth_m = AXIS_ARROW_LENGTH_M * 0.5;
    const shaftEnd_m = AXIS_ARROW_LENGTH_M - headLength_m;

    const tip = axis === "x" ? { lx: AXIS_ARROW_LENGTH_M, ly: 0 } : { lx: 0, ly: AXIS_ARROW_LENGTH_M };
    const shaftEnd = axis === "x" ? { lx: shaftEnd_m, ly: 0 } : { lx: 0, ly: shaftEnd_m };
    const headA =
      axis === "x" ? { lx: shaftEnd_m, ly: headWidth_m / 2 } : { lx: headWidth_m / 2, ly: shaftEnd_m };
    const headB =
      axis === "x" ? { lx: shaftEnd_m, ly: -headWidth_m / 2 } : { lx: -headWidth_m / 2, ly: shaftEnd_m };

    const originWorld = robotToWorld(0, 0, latestPose);
    const shaftEndWorld = robotToWorld(shaftEnd.lx, shaftEnd.ly, latestPose);
    const originPt = worldToCanvas(originWorld.x, originWorld.y, view, canvas);
    const shaftEndPt = worldToCanvas(shaftEndWorld.x, shaftEndWorld.y, view, canvas);

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(originPt.px, originPt.py);
    ctx.lineTo(shaftEndPt.px, shaftEndPt.py);
    ctx.stroke();

    drawPoly([tip, headA, headB], color);
  }

  drawAxisArrow("x", "red");
  drawAxisArrow("y", "green");

  // Control-frame reference arrow: origin translates with the robot (same
  // origin as the axis arrows above) but its direction is fixed in world
  // space - it does NOT rotate with the robot body, only via the dedicated
  // rotate-left/right buttons - so unlike drawAxisArrow/drawPoly, this one
  // goes straight to world coordinates instead of routing through
  // robotToWorld (which rotates by the robot's own heading).
  const CONTROL_FRAME_ARROW_LENGTH_M = 0.15;

  function drawControlFrameArrow() {
    const headLength_m = CONTROL_FRAME_ARROW_LENGTH_M * 0.15;
    const headWidth_m = CONTROL_FRAME_ARROW_LENGTH_M * 0.2;
    const shaftEnd_m = CONTROL_FRAME_ARROW_LENGTH_M - headLength_m;

    const dirX = Math.cos(controlFrameTheta);
    const dirY = Math.sin(controlFrameTheta);
    const perpX = -dirY;
    const perpY = dirX;

    const toCanvasPt = (dx, dy) => worldToCanvas(latestPose.x + dx, latestPose.y + dy, view, canvas);
    const originPt = toCanvasPt(0, 0);
    const shaftEndPt = toCanvasPt(dirX * shaftEnd_m, dirY * shaftEnd_m);
    const tipPt = toCanvasPt(dirX * CONTROL_FRAME_ARROW_LENGTH_M, dirY * CONTROL_FRAME_ARROW_LENGTH_M);
    const headAPt = toCanvasPt(dirX * shaftEnd_m + (perpX * headWidth_m) / 2, dirY * shaftEnd_m + (perpY * headWidth_m) / 2);
    const headBPt = toCanvasPt(dirX * shaftEnd_m - (perpX * headWidth_m) / 2, dirY * shaftEnd_m - (perpY * headWidth_m) / 2);

    ctx.strokeStyle = "purple";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(originPt.px, originPt.py);
    ctx.lineTo(shaftEndPt.px, shaftEndPt.py);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(tipPt.px, tipPt.py);
    ctx.lineTo(headAPt.px, headAPt.py);
    ctx.lineTo(headBPt.px, headBPt.py);
    ctx.closePath();
    ctx.fillStyle = "purple";
    ctx.fill();
  }

  drawControlFrameArrow();

  // Click-to-navigate goal marker: a small orange ring at the last commanded
  // target, so there's visual confirmation of where a map click sent the
  // robot. Stays put until the next click - not tied to arrival.
  if (goalMarker) {
    const goalPt = worldToCanvas(goalMarker.x, goalMarker.y, view, canvas);
    ctx.strokeStyle = "orange";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(goalPt.px, goalPt.py, 6, 0, 2 * Math.PI);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(goalPt.px - 10, goalPt.py);
    ctx.lineTo(goalPt.px + 10, goalPt.py);
    ctx.moveTo(goalPt.px, goalPt.py - 10);
    ctx.lineTo(goalPt.px, goalPt.py + 10);
    ctx.stroke();
    if (typeof goalMarker.heading === "number") {
      const tip = worldToCanvas(goalMarker.x + 0.12 * Math.cos(goalMarker.heading), goalMarker.y + 0.12 * Math.sin(goalMarker.heading), view, canvas);
      ctx.beginPath();
      ctx.moveTo(goalPt.px, goalPt.py);
      ctx.lineTo(tip.px, tip.py);
      ctx.stroke();
    }
  }

  // Waypoint markers: small dot per saved waypoint (Home in blue, user
  // waypoints in gray), highlighted ring for the current selection, plus a
  // short heading tick drawn in world coordinates - waypoint heading isn't
  // attached to the robot body, so it's a straight world-frame line, not
  // routed through robotToWorld() like the axis/control-frame arrows above.
  fullWaypointList().forEach((wp, i) => {
    const { px, py } = worldToCanvas(wp.x, wp.y, view, canvas);
    const isSelected = i === selectedWaypointIndex;
    const color = wp.isHome ? "#2c9aff" : "#666";
    ctx.beginPath();
    ctx.arc(px, py, isSelected ? 7 : 5, 0, 2 * Math.PI);
    ctx.fillStyle = color;
    ctx.fill();
    if (isSelected) {
      ctx.strokeStyle = "orange";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    const tip = worldToCanvas(wp.x + 0.08 * Math.cos(wp.heading), wp.y + 0.08 * Math.sin(wp.heading), view, canvas);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(tip.px, tip.py);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Name label, offset above-right of the marker. A white stroke behind
    // the fill keeps it legible over the grid lines/trail regardless of
    // marker color, without needing a background box.
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.strokeText(wp.name, px + 8, py - 6);
    ctx.fillStyle = color;
    ctx.fillText(wp.name, px + 8, py - 6);
  });
}

// --- Settings <-> /params and /set ---

function loadParams() {
  fetch("/params")
    .then((r) => r.json())
    .then((data) => {
      document.getElementById("kp").value = data.kp;
      document.getElementById("kpVal").value = data.kp;
      document.getElementById("ki").value = data.ki;
      document.getElementById("kiVal").value = data.ki;
      document.getElementById("kd").value = data.kd;
      document.getElementById("kdVal").value = data.kd;

      document.getElementById("diffCutoff").value = data.differentiatorCutoffHz;
      document.getElementById("logRate").value = data.dataLogRate;
      document.getElementById("telemetryHz").value = data.telemetryHz;
      setRttPingIntervalFromHz(data.telemetryHz);

      document.getElementById("loggingEnabled").checked = data.loggingEnabled;
      document.getElementById("debugWeb").checked = data.debugWeb;

      document.getElementById("logType").value = data.logType === 0 ? "left_wheel" : "both_wheels";
      const unitMap = ["steps", "rad", "deg", "rev", "dist"];
      document.getElementById("logUnit").value = unitMap[data.logUnit];

      updateModeHighlight(String(data.mode));

      document.getElementById("ledToggle").checked = data.ledOn;

      document.getElementById("motorPower").value = data.motorPower;
      document.getElementById("motorPowerVal").textContent = data.motorPower;
      maxMotorPowerPwm = data.motorPower;

      document.getElementById("motorDeadzonePwm").value = data.motorDeadzonePwm;
      document.getElementById("gotoSpeedGain").value = data.gotoSpeedGain;
      document.getElementById("maxWheelSpeedRevPerSec").value = data.maxWheelSpeedRevPerSec;
      maxWheelSpeedRevPerSec = data.maxWheelSpeedRevPerSec;
      // The server clamps manual setpoints to this same limit - reflect it
      // here too so typing an unreachable value shows as invalid rather
      // than silently getting clamped with no visual feedback.
      document.getElementById("manualVelLeft").min = -data.maxWheelSpeedRevPerSec;
      document.getElementById("manualVelLeft").max = data.maxWheelSpeedRevPerSec;
      document.getElementById("manualVelRight").min = -data.maxWheelSpeedRevPerSec;
      document.getElementById("manualVelRight").max = data.maxWheelSpeedRevPerSec;
      document.getElementById("maxAccelRevPerSec2").value = data.maxAccelRevPerSec2;
      document.getElementById("maxDecelRevPerSec2").value = data.maxDecelRevPerSec2;
      document.getElementById("gotoVelKp").value = data.gotoVelKp;
      document.getElementById("gotoVelKi").value = data.gotoVelKi;
      document.getElementById("feedForwardPwmPerRevPerSec").value = data.feedForwardPwmPerRevPerSec;
      document.getElementById("gotoAllowReverse").checked = data.gotoAllowReverse;
      document.getElementById("gotoPreserveHeading").checked = data.gotoPreserveHeading;
      document.getElementById("controlFrameAllowReverse").checked = data.controlFrameAllowReverse;
      document.getElementById("servoFollowControlFrame").checked = data.servoFollowControlFrame;
      document.getElementById("controlFrameRotationStrategy").value =
        data.controlFrameRotationStrategy === 1 ? "fixed_hemisphere" : "closest_face";
      document.getElementById("servoMaxRotationRateDegPerSec").value = data.servoMaxRotationRateDegPerSec;
      document.getElementById("servoAssistMarginDeg").value = data.servoAssistMarginDeg;
      document.getElementById("panMaxSpeedDegPerSec").value = data.panMaxSpeedDegPerSec;
      document.getElementById("tiltMaxSpeedDegPerSec").value = data.tiltMaxSpeedDegPerSec;
      document.getElementById("cameraJoystickCurve").value =
        data.cameraJoystickCurve === 1 ? "quadratic" : "linear";
      document.getElementById("otaUsername").value = data.otaUsername;
      document.getElementById("otaPassword").value = data.otaPassword;

      document.getElementById("reboot-notice").style.display = data.lastRebootWasWatchdog ? "block" : "none";
      let rebootText = `Last reboot: ${data.lastRebootReason}`;
      if (data.lastRebootWasWatchdog) {
        // Breadcrumbs: where each core's "current checkpoint" scratch
        // register pointed at boot, i.e. right before the hang - see
        // src/breadcrumb.cpp for the full checkpoint list and reasoning.
        rebootText += ` — core0 was at: ${data.lastHangCore0Checkpoint}; core1 was at: ${data.lastHangCore1Checkpoint} (tick ${data.lastHangCore1Ticks}); last WS message: '${data.lastHangWsMessage}'`;
      }
      document.getElementById("reboot-reason-display").textContent = rebootText;

      document.getElementById("wheelbaseMm").value = data.wheelbaseMm;
      document.getElementById("wheelDiameterMm").value = data.wheelDiameterMm;
      geometry.wheelbaseMm = data.wheelbaseMm;
      geometry.wheelDiameterMm = data.wheelDiameterMm;

      document.getElementById("servoMinPulseUs").value = data.servoMinPulseUs;
      document.getElementById("servoMaxPulseUs").value = data.servoMaxPulseUs;
      document.getElementById("servoCenterPulseUs").value = data.servoCenterPulseUs;
      document.getElementById("servoMinAngleDeg").value = data.servoMinAngleDeg;
      document.getElementById("servoMaxAngleDeg").value = data.servoMaxAngleDeg;
      updateServoRangeAndSlider();

      document.getElementById("tiltMinPulseUs").value = data.tiltMinPulseUs;
      document.getElementById("tiltMaxPulseUs").value = data.tiltMaxPulseUs;
      document.getElementById("tiltCenterPulseUs").value = data.tiltCenterPulseUs;
      document.getElementById("tiltMinAngleDeg").value = data.tiltMinAngleDeg;
      document.getElementById("tiltMaxAngleDeg").value = data.tiltMaxAngleDeg;
      updateTiltRangeAndSlider();

      document.getElementById("cameraHeightMm").value = data.cameraHeightMm;
      document.getElementById("cameraTiltDeg").value = data.cameraTiltDeg;
      document.getElementById("cameraVerticalFovDeg").value = data.cameraVerticalFovDeg;

      document.getElementById("gameMode").value = data.gameMode === 1 ? "monster_hunt" : "none";
      document.getElementById("fireballSpeedMps").value = data.fireballSpeedMps;
      document.getElementById("monsterSpeedMps").value = data.monsterSpeedMps;
      document.getElementById("monsterCount").value = data.monsterCount;
      document.getElementById("monsterLegDistanceM").value = data.monsterLegDistanceM;

      document.getElementById("ssid").value = data.altSsid || "";
      document.getElementById("password").value = data.altPassword || "";

      drawMap();
    })
    .catch(console.error);
}

function setParam(name, value) {
  fetch(`/set?${name}=${encodeURIComponent(value)}`).catch(console.error);
}

// Mirrors the firmware's servo_angle pulse-width math exactly (see
// computeServoPulseUs() in web_server.cpp) so the readout updates instantly
// and also reflects in-progress edits to the min/center/max angle/pulse
// fields before they're saved - the point is to let the user read off the
// right-now pulse width while hunting for the values that line up with the
// servo's true mechanical positions, then copy them down. Piecewise linear
// (min..center, then center..max) rather than a single min..max
// interpolation, since horn-mounting tolerances mean the true 0 deg
// position isn't reliably the midpoint pulse. Angle 0 is fixed (not a
// calibration value) since servoFollowControlFrame and the control-frame
// tracking system assume it -- only the min/max endpoints are adjustable,
// for servos with more (or less) than the usual 180 deg range.
function updateServoPulseDisplay() {
  const angleDeg = parseFloat(document.getElementById("servoAngleDeg").value);
  const minAngleDeg = parseFloat(document.getElementById("servoMinAngleDeg").value);
  const maxAngleDeg = parseFloat(document.getElementById("servoMaxAngleDeg").value);
  const minPulseUs = parseFloat(document.getElementById("servoMinPulseUs").value);
  const maxPulseUs = parseFloat(document.getElementById("servoMaxPulseUs").value);
  const centerPulseUs = parseFloat(document.getElementById("servoCenterPulseUs").value);
  let pulseUs;
  if (angleDeg <= 0) {
    const span = -minAngleDeg;
    const fraction = span !== 0 ? (angleDeg - minAngleDeg) / span : 0;
    pulseUs = minPulseUs + fraction * (centerPulseUs - minPulseUs);
  } else {
    const fraction = maxAngleDeg !== 0 ? angleDeg / maxAngleDeg : 0;
    pulseUs = centerPulseUs + fraction * (maxPulseUs - centerPulseUs);
  }
  document.getElementById("servoPulseUsDisplay").textContent = `Pulse width: ${Math.round(pulseUs)} us`;
}

// Same idea as updateServoPulseDisplay() above, but for the tilt servo --
// see computeTiltServoPulseUs() in web_server.cpp.
function updateTiltPulseDisplay() {
  const angleDeg = parseFloat(document.getElementById("tiltAngleDeg").value);
  const minAngleDeg = parseFloat(document.getElementById("tiltMinAngleDeg").value);
  const maxAngleDeg = parseFloat(document.getElementById("tiltMaxAngleDeg").value);
  const minPulseUs = parseFloat(document.getElementById("tiltMinPulseUs").value);
  const maxPulseUs = parseFloat(document.getElementById("tiltMaxPulseUs").value);
  const centerPulseUs = parseFloat(document.getElementById("tiltCenterPulseUs").value);
  let pulseUs;
  if (angleDeg <= 0) {
    const span = -minAngleDeg;
    const fraction = span !== 0 ? (angleDeg - minAngleDeg) / span : 0;
    pulseUs = minPulseUs + fraction * (centerPulseUs - minPulseUs);
  } else {
    const fraction = maxAngleDeg !== 0 ? angleDeg / maxAngleDeg : 0;
    pulseUs = centerPulseUs + fraction * (maxPulseUs - centerPulseUs);
  }
  document.getElementById("tiltPulseUsDisplay").textContent = `Pulse width: ${Math.round(pulseUs)} us`;
}

// The pan angle slider/number-input's own min/max attributes track the
// servoMinAngleDeg/servoMaxAngleDeg calibration fields -- called on load and
// whenever those fields change, so the slider's draggable range always
// matches the servo's real range. Re-clamps the current angle into the new
// range if it falls outside it.
function updateServoRangeAndSlider() {
  const minAngleDeg = parseFloat(document.getElementById("servoMinAngleDeg").value);
  const maxAngleDeg = parseFloat(document.getElementById("servoMaxAngleDeg").value);
  const slider = document.getElementById("servoAngleDeg");
  const val = document.getElementById("servoAngleDegVal");
  slider.min = minAngleDeg;
  slider.max = maxAngleDeg;
  val.min = minAngleDeg;
  val.max = maxAngleDeg;
  const clamped = Math.min(Math.max(parseFloat(slider.value), minAngleDeg), maxAngleDeg);
  if (clamped !== parseFloat(slider.value)) {
    slider.value = clamped;
    val.value = clamped;
  }
  updateServoPulseDisplay();
}

// Same idea as updateServoRangeAndSlider() above, but for the tilt servo.
function updateTiltRangeAndSlider() {
  const minAngleDeg = parseFloat(document.getElementById("tiltMinAngleDeg").value);
  const maxAngleDeg = parseFloat(document.getElementById("tiltMaxAngleDeg").value);
  const slider = document.getElementById("tiltAngleDeg");
  const val = document.getElementById("tiltAngleDegVal");
  slider.min = minAngleDeg;
  slider.max = maxAngleDeg;
  val.min = minAngleDeg;
  val.max = maxAngleDeg;
  const clamped = Math.min(Math.max(parseFloat(slider.value), minAngleDeg), maxAngleDeg);
  if (clamped !== parseFloat(slider.value)) {
    slider.value = clamped;
    val.value = clamped;
  }
  updateTiltPulseDisplay();
}

function updateModeHighlight(modeValue) {
  const joystick = document.getElementById("joystickContainer");
  const joystick2 = document.getElementById("joystickContainer2");
  const lab1Buttons = document.querySelector(".lab1-buttons");
  const lab2ButtonsGroup = document.querySelector(".lab2-buttons");
  const mapGroup = document.querySelector(".map-group");

  joystick.classList.remove("active");
  joystick2.classList.remove("active");
  lab1Buttons.classList.remove("active");
  lab2ButtonsGroup.classList.remove("active");
  mapGroup.classList.remove("active");

  if (modeValue === "0") joystick.classList.add("active");
  else if (modeValue === "1") lab1Buttons.classList.add("active");
  else if (modeValue === "2") lab2ButtonsGroup.classList.add("active");
  else if (modeValue === "3") joystick2.classList.add("active");
  else if (modeValue === "4") mapGroup.classList.add("active");

  // Any drive command outside goto mode means the operator has taken manual
  // control - cancel a running patrol loop so it can't silently resume
  // commanding "goto" once they switch back, e.g. by clicking the map again.
  if (modeValue !== "4" && autoAdvanceActive) {
    autoAdvanceActive = false;
    autoAdvanceTargetIndex = null;
    updateWaypointAutoAdvanceStatus();
  }
}

window.addEventListener("DOMContentLoaded", () => {
  connectWs();
  loadParams();
  drawMap();
  injectDragHandles();
  relayoutPanels();
  restorePanelStates();
  // Delayed rather than fired immediately alongside connectWs()/loadParams()
  // above: those, this, and the page's own asset loads all firing in the
  // same instant is exactly the kind of connection burst at page load
  // that's been implicated in this robot's intermittent watchdog hangs
  // (see subscribeToPose()'s comment in cam.js for the fuller history).
  setTimeout(() => {
    loadWaypoints().then((loaded) => {
      waypoints = loaded;
      renderWaypointsTable();
    });
  }, 500);
  startWaypointsBackgroundRefresh();

  restorePersistentNumberInput("speedometerMaxCmPerSec", 50);
  restorePersistentNumberInput("speedometerMajorTickCmPerSec", 5);
  restorePersistentNumberInput("speedometerMinorTickCmPerSec", 1);
  ["speedometerMaxCmPerSec", "speedometerMajorTickCmPerSec", "speedometerMinorTickCmPerSec"].forEach((id) => {
    document.getElementById(id).addEventListener("input", () => {
      drawSpeedometer(latestSpeedCmPerSec);
    });
  });
  drawSpeedometer(latestSpeedCmPerSec);

  document.getElementById("reboot-notice").addEventListener("click", () => {
    document.getElementById("reboot-notice").style.display = "none";
  });

  document.getElementById("resetPanelLayoutBtn").addEventListener("click", () => {
    localStorage.removeItem(PANEL_LAYOUT_STORAGE_KEY);
    location.reload();
  });

  const lockPanelLayoutEl = document.getElementById("lockPanelLayout");
  const updateLayoutLockedClass = () => {
    document.body.classList.toggle("layout-locked", lockPanelLayoutEl.checked);
  };
  restorePersistentCheckbox("lockPanelLayout");
  updateLayoutLockedClass();
  lockPanelLayoutEl.addEventListener("change", updateLayoutLockedClass);

  document.getElementById("map").addEventListener("click", (e) => {
    const canvas = document.getElementById("map");
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const py = (e.clientY - rect.top) * scaleY;
    const view = computeMapView(canvas);
    const world = canvasToWorld(px, py, view, canvas);
    autoAdvanceActive = false;
    autoAdvanceTargetIndex = null;
    updateWaypointAutoAdvanceStatus();
    goalMarker = { x: world.x, y: world.y };
    sendWs({ type: "goto", x: world.x, y: world.y });
    updateModeHighlight("4");
    drawMap();
  });

  // Zoom: mouse wheel (desktop) and two-finger pinch (touch). Both just
  // adjust mapZoomFactor - see its declaration above for why this doesn't
  // bother anchoring on the cursor/pinch midpoint.
  const WHEEL_ZOOM_STEP = 1.1;
  document.getElementById("map").addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      setMapZoomFactor(mapZoomFactor * (e.deltaY < 0 ? WHEEL_ZOOM_STEP : 1 / WHEEL_ZOOM_STEP));
    },
    { passive: false }
  );

  let pinchStartDist = null;
  let pinchStartZoom = 1;
  function touchDist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }
  const mapCanvas = document.getElementById("map");
  mapCanvas.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        pinchStartDist = touchDist(e.touches);
        pinchStartZoom = mapZoomFactor;
      }
    },
    { passive: false }
  );
  mapCanvas.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length === 2 && pinchStartDist) {
        e.preventDefault();
        setMapZoomFactor(pinchStartZoom * (touchDist(e.touches) / pinchStartDist));
      }
    },
    { passive: false }
  );
  mapCanvas.addEventListener("touchend", (e) => {
    if (e.touches.length < 2) pinchStartDist = null;
  });

  document.getElementById("rttDiagnosticsEnabled").addEventListener("change", (e) => {
    if (e.target.checked) {
      startRttDiagnostics();
    } else {
      stopRttDiagnostics();
    }
  });
  if (restorePersistentCheckbox("rttDiagnosticsEnabled")) {
    startRttDiagnostics();
  }

  const s3camPanel = document.getElementById("panel-s3cam");
  s3camPanel.addEventListener("toggle", () => {
    if (s3camPanel.open) {
      startCamDiagPolling();
    } else {
      stopCamDiagPolling();
    }
  });
  if (s3camPanel.open) {
    startCamDiagPolling(); // catches the state restorePanelStates() already applied, above
  }

  document.getElementById("forwardBtn").addEventListener("click", () => {
    sendWs({ type: "lab1", cmd: "forward" });
    updateModeHighlight("1");
  });
  document.getElementById("backwardBtn").addEventListener("click", () => {
    sendWs({ type: "lab1", cmd: "backward" });
    updateModeHighlight("1");
  });

  document.getElementById("lab2SetpointA").addEventListener("click", () => {
    sendWs({ type: "lab2_setpoint", delta: 0.5 });
    updateModeHighlight("2");
  });
  document.getElementById("lab2SetpointB").addEventListener("click", () => {
    sendWs({ type: "lab2_setpoint", delta: -0.5 });
    updateModeHighlight("2");
  });
  document.getElementById("lab2Left").addEventListener("click", () => {
    sendWs({ type: "lab2_turn", dir: "left" });
    updateModeHighlight("2");
  });
  document.getElementById("lab2Right").addEventListener("click", () => {
    sendWs({ type: "lab2_turn", dir: "right" });
    updateModeHighlight("2");
  });

  document.getElementById("resetPoseBtn").addEventListener("click", () => {
    setParam("reset_pose", 1);
    trail.length = 0;
    goalMarker = null; // its coordinates were relative to the old pose frame
  });
  document.getElementById("resetOrientationBtn").addEventListener("click", () => {
    // Position is preserved server-side, so the trail and goal marker are
    // still spatially valid - nothing to clear here, unlike the position reset.
    setParam("reset_orientation", 1);
  });
  document.getElementById("clearPathBtn").addEventListener("click", () => {
    trail.length = 0;
    drawMap();
  });

  document.getElementById("waypointAddFromPoseBtn").addEventListener("click", () => {
    const nameInput = document.getElementById("waypointNewName");
    const name = nameInput.value.trim();
    if (!name) return;
    waypoints.push({ name, x: latestPose.x, y: latestPose.y, heading: latestPose.theta });
    saveWaypoints();
    nameInput.value = "";
    renderWaypointsTable();
  });

  document.getElementById("waypointEditBtn").addEventListener("click", () => {
    editingWaypoint = true;
    renderWaypointsTable();
  });
  document.getElementById("waypointCancelBtn").addEventListener("click", () => {
    editingWaypoint = false;
    renderWaypointsTable();
  });
  document.getElementById("waypointSaveBtn").addEventListener("click", () => {
    const idx = selectedWaypointIndex - 1; // -1 for Home's slot at the front
    const name = document.getElementById("waypointEditName").value.trim();
    const x = parseFloat(document.getElementById("waypointEditX").value);
    const y = parseFloat(document.getElementById("waypointEditY").value);
    const headingDeg = parseFloat(document.getElementById("waypointEditHeadingDeg").value);
    if (!name || !isFinite(x) || !isFinite(y) || !isFinite(headingDeg)) return;
    waypoints[idx] = { name, x, y, heading: (headingDeg * Math.PI) / 180 };
    saveWaypoints();
    editingWaypoint = false;
    renderWaypointsTable();
  });

  document.getElementById("waypointRemoveBtn").addEventListener("click", () => {
    const idx = selectedWaypointIndex - 1;
    waypoints.splice(idx, 1);
    saveWaypoints();
    selectedWaypointIndex = null;
    renderWaypointsTable();
  });

  document.getElementById("waypointClearAllBtn").addEventListener("click", () => {
    if (!confirm("Remove all user-added waypoints? Home is unaffected.")) return;
    waypoints = [];
    saveWaypoints();
    selectedWaypointIndex = null;
    renderWaypointsTable();
  });

  document.getElementById("waypointGotoBtn").addEventListener("click", () => {
    autoAdvanceActive = document.getElementById("waypointAutoAdvance").checked;
    autoAdvanceTargetIndex = autoAdvanceActive ? selectedWaypointIndex : null;
    commandGotoWaypoint(selectedWaypointIndex);
    updateWaypointAutoAdvanceStatus();
    drawMap();
  });

  document.getElementById("waypointAutoAdvance").addEventListener("change", (e) => {
    if (!e.target.checked) {
      autoAdvanceActive = false;
      autoAdvanceTargetIndex = null;
      updateWaypointAutoAdvanceStatus();
    }
  });
  restorePersistentCheckbox("waypointAutoAdvance");

  document.getElementById("waypointSetPoseBtn").addEventListener("click", () => {
    const wp = fullWaypointList()[selectedWaypointIndex];
    fetch("/pose_reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ x: wp.x, y: wp.y, theta: wp.heading }),
    }).catch(console.error);
    // Old trail/goal points were relative to the pose that just got
    // overwritten - mirrors resetPoseBtn's own handler above.
    trail.length = 0;
    goalMarker = null;
  });

  document.getElementById("gotoPreserveHeading").addEventListener("change", (e) => {
    setParam("gotoPreserveHeading", e.target.checked ? 1 : 0);
  });

  document.getElementById("loggingEnabled").addEventListener("change", (e) => {
    setParam("logging", e.target.checked ? 1 : 0);
  });
  document.getElementById("debugWeb").addEventListener("change", (e) => {
    setParam("debug", e.target.checked ? 1 : 0);
  });
  document.getElementById("ledToggle").addEventListener("change", (e) => {
    setParam("led", e.target.checked ? 1 : 0);
  });
  document.getElementById("syncMotors").addEventListener("change", (e) => {
    setParam("syncMotors", e.target.checked ? 1 : 0);
  });
  document.getElementById("logType").addEventListener("change", (e) => {
    setParam("logType", e.target.value);
  });
  document.getElementById("logUnit").addEventListener("change", (e) => {
    setParam("logUnit", e.target.value);
  });
  document.getElementById("logRate").addEventListener("change", (e) => {
    setParam("logRate", e.target.value);
  });
  document.getElementById("telemetryHz").addEventListener("change", (e) => {
    setParam("telemetryHz", e.target.value);
    setRttPingIntervalFromHz(parseFloat(e.target.value));
  });
  document.getElementById("motorDeadzonePwm").addEventListener("change", (e) => {
    setParam("motorDeadzonePwm", e.target.value);
  });
  document.getElementById("gotoSpeedGain").addEventListener("change", (e) => {
    setParam("gotoSpeedGain", e.target.value);
  });
  document.getElementById("maxWheelSpeedRevPerSec").addEventListener("change", (e) => {
    maxWheelSpeedRevPerSec = parseFloat(e.target.value);
    setParam("maxWheelSpeedRevPerSec", e.target.value);
  });
  document.getElementById("maxAccelRevPerSec2").addEventListener("change", (e) => {
    setParam("maxAccelRevPerSec2", e.target.value);
  });
  document.getElementById("maxDecelRevPerSec2").addEventListener("change", (e) => {
    setParam("maxDecelRevPerSec2", e.target.value);
  });
  document.getElementById("gotoVelKp").addEventListener("change", (e) => {
    setParam("gotoVelKp", e.target.value);
  });
  document.getElementById("gotoVelKi").addEventListener("change", (e) => {
    setParam("gotoVelKi", e.target.value);
  });
  document.getElementById("gotoAllowReverse").addEventListener("change", (e) => {
    setParam("gotoAllowReverse", e.target.checked ? 1 : 0);
  });
  document.getElementById("controlFrameAllowReverse").addEventListener("change", (e) => {
    setParam("controlFrameAllowReverse", e.target.checked ? 1 : 0);
  });
  document.getElementById("servoFollowControlFrame").addEventListener("change", (e) => {
    setParam("servoFollowControlFrame", e.target.checked ? 1 : 0);
  });
  document.getElementById("controlFrameRotationStrategy").addEventListener("change", (e) => {
    setParam("controlFrameRotationStrategy", e.target.value);
  });
  ["servoMaxRotationRateDegPerSec", "servoAssistMarginDeg"].forEach((name) => {
    document.getElementById(name).addEventListener("change", (e) => setParam(name, e.target.value));
  });
  ["panMaxSpeedDegPerSec", "tiltMaxSpeedDegPerSec"].forEach((name) => {
    document.getElementById(name).addEventListener("change", (e) => setParam(name, e.target.value));
  });
  document.getElementById("cameraJoystickCurve").addEventListener("change", (e) => {
    setParam("cameraJoystickCurve", e.target.value);
  });
  ["otaUsername", "otaPassword"].forEach((name) => {
    document.getElementById(name).addEventListener("change", (e) => setParam(name, e.target.value));
  });
  document.getElementById("feedForwardPwmPerRevPerSec").addEventListener("change", (e) => {
    setParam("feedForwardPwmPerRevPerSec", e.target.value);
  });

  // Manual velocity setpoint: a step-response test tool for the velocity
  // controller, bypassing the goto controller's distance-to-goal computation
  // but still going through its same rate limiter + PI tracking.
  function sendManualVelSetpoint() {
    sendWs({
      type: "manual_velocity_setpoint",
      left: parseFloat(document.getElementById("manualVelLeft").value) || 0,
      right: parseFloat(document.getElementById("manualVelRight").value) || 0,
    });
  }
  document.getElementById("manualVelLeft").addEventListener("change", sendManualVelSetpoint);
  document.getElementById("manualVelRight").addEventListener("change", sendManualVelSetpoint);
  document.getElementById("manualVelStopBtn").addEventListener("click", () => {
    document.getElementById("manualVelLeft").value = 0;
    document.getElementById("manualVelRight").value = 0;
    sendManualVelSetpoint();
  });

  document.getElementById("gotoDiagnosticsEnabled").addEventListener("change", (e) => {
    sendWs({ type: "goto_diag_enable", enabled: e.target.checked });
    if (!e.target.checked) {
      clearGotoGraphs();
    }
  });
  // Just restores the checkbox itself - if it comes back checked, the
  // existing ws.onopen resync logic (see connectWs()) sends goto_diag_enable
  // once the socket is actually open, same as it does after a reconnect.
  restorePersistentCheckbox("gotoDiagnosticsEnabled");

  document.getElementById("sysDiagnosticsEnabled").addEventListener("change", (e) => {
    sendWs({ type: "sys_diag_enable", enabled: e.target.checked });
    if (!e.target.checked) {
      document.getElementById("sys-stats").innerHTML = "";
    }
  });
  // Same resync-on-reconnect pattern as gotoDiagnosticsEnabled above.
  restorePersistentCheckbox("sysDiagnosticsEnabled");
  restorePersistentCheckbox("camShowMapOverlay"); // read by cam.js on the Camera page, not used here
  restorePersistentCheckbox("camShowFloorGrid"); // read by cam.js on the Camera page, not used here
  restorePersistentCheckbox("camShowMinorGrid"); // read by cam.js on the Camera page, not used here
  restorePersistentCheckbox("camShowWaypointsOverlay"); // read by cam.js on the Camera page, not used here
  restorePersistentNumberInput("camGridOpacity", 90); // read by cam.js on the Camera page, not used here
  document.getElementById("camGridColor").value = localStorage.getItem("camGridColor") || "#28ff78";
  document.getElementById("camGridColor").addEventListener("change", (e) => {
    localStorage.setItem("camGridColor", e.target.value); // read by cam.js on the Camera page, not used here
  });
  document.getElementById("calibrateDeadzoneBtn").addEventListener("click", () => {
    document.getElementById("deadzoneCalibrationStatus").textContent = "Calibrating...";
    sendWs({ type: "calibrate_deadzone" });
  });
  document.getElementById("calibrateEncoderCountBtn").addEventListener("click", () => {
    const wheel = parseInt(document.getElementById("encoderCalibrationWheel").value, 10);
    document.getElementById("encoderCalibrationStatus").textContent = "Starting...";
    sendWs({ type: "calibrate_encoder_count", wheel });
  });
  document.getElementById("diffCutoff").addEventListener("change", (e) => {
    setParam("diffCutoff", e.target.value);
  });

  document.getElementById("wheelbaseMm").addEventListener("change", (e) => {
    geometry.wheelbaseMm = parseFloat(e.target.value);
    setParam("wheelbaseMm", e.target.value);
    drawMap();
  });
  document.getElementById("wheelDiameterMm").addEventListener("change", (e) => {
    geometry.wheelDiameterMm = parseFloat(e.target.value);
    setParam("wheelDiameterMm", e.target.value);
    drawMap();
  });

  ["cameraHeightMm", "cameraTiltDeg", "cameraVerticalFovDeg"].forEach((name) => {
    document.getElementById(name).addEventListener("change", (e) => setParam(name, e.target.value));
  });

  document.getElementById("gameMode").addEventListener("change", (e) => setParam("gameMode", e.target.value));

  ["fireballSpeedMps", "monsterSpeedMps", "monsterCount", "monsterLegDistanceM"].forEach((name) => {
    document.getElementById(name).addEventListener("change", (e) => setParam(name, e.target.value));
  });

  // Servo angle: a live command (like the joysticks), not a persisted
  // setting - sent over the WS, not through setParam()/flash. Throttled
  // (send immediately, then at most once per SERVO_SEND_INTERVAL_MS, with
  // one trailing send for the final position) the same way the joystick's
  // sendJoystick() is, rather than debounced: a debounce resets its timer
  // on every event, so continuous dragging - which fires "input" faster
  // than any short debounce delay - never has a quiet gap long enough to
  // fire at all, and nothing moves until the drag pauses. A throttle keeps
  // sending at a steady rate throughout the drag instead.
  {
    const angleSlider = document.getElementById("servoAngleDeg");
    const angleVal = document.getElementById("servoAngleDegVal");
    const minPulseEl = document.getElementById("servoMinPulseUs");
    const maxPulseEl = document.getElementById("servoMaxPulseUs");
    const centerPulseEl = document.getElementById("servoCenterPulseUs");

    const SERVO_SEND_INTERVAL_MS = 40; // ~25 Hz, matches the joystick
    let lastServoSendMs = 0;
    let pendingServoAngle = 0;
    let servoTrailingTimer = null;
    const sendServoAngle = (deg) => {
      pendingServoAngle = parseFloat(deg);
      const now = Date.now();
      const elapsed = now - lastServoSendMs;
      if (elapsed >= SERVO_SEND_INTERVAL_MS) {
        lastServoSendMs = now;
        sendWs({ type: "servo_angle", angleDeg: pendingServoAngle });
      } else if (servoTrailingTimer === null) {
        servoTrailingTimer = setTimeout(() => {
          servoTrailingTimer = null;
          lastServoSendMs = Date.now();
          sendWs({ type: "servo_angle", angleDeg: pendingServoAngle });
        }, SERVO_SEND_INTERVAL_MS - elapsed);
      }
    };
    angleSlider.addEventListener("input", () => {
      angleVal.value = angleSlider.value;
      sendServoAngle(angleSlider.value);
      updateServoPulseDisplay();
    });
    angleVal.addEventListener("change", () => {
      angleSlider.value = angleVal.value;
      sendServoAngle(angleVal.value);
      updateServoPulseDisplay();
    });
    document.getElementById("servoCenterBtn").addEventListener("click", () => {
      angleSlider.value = 0;
      angleVal.value = 0;
      sendServoAngle(0);
      updateServoPulseDisplay();
    });

    [
      ["servoMinPulseUs", minPulseEl],
      ["servoCenterPulseUs", centerPulseEl],
      ["servoMaxPulseUs", maxPulseEl],
    ].forEach(([paramName, el]) => {
      el.addEventListener("change", (e) => setParam(paramName, e.target.value));
      el.addEventListener("input", updateServoPulseDisplay);
    });

    [
      ["servoMinAngleDeg", document.getElementById("servoMinAngleDeg")],
      ["servoMaxAngleDeg", document.getElementById("servoMaxAngleDeg")],
    ].forEach(([paramName, el]) => {
      el.addEventListener("change", (e) => {
        setParam(paramName, e.target.value);
        updateServoRangeAndSlider();
      });
      el.addEventListener("input", updateServoPulseDisplay);
    });
  }

  // Tilt servo test panel: same throttled-send pattern as the pan servo
  // above, over its own "tilt_servo_angle" WS message type and its own
  // updateTiltRangeAndSlider()/tiltMinAngleDeg/tiltMaxAngleDeg fields.
  {
    const angleSlider = document.getElementById("tiltAngleDeg");
    const angleVal = document.getElementById("tiltAngleDegVal");

    const TILT_SEND_INTERVAL_MS = 40; // ~25 Hz, matches the pan servo
    let lastTiltSendMs = 0;
    let pendingTiltAngle = 0;
    let tiltTrailingTimer = null;
    const sendTiltAngle = (deg) => {
      pendingTiltAngle = parseFloat(deg);
      const now = Date.now();
      const elapsed = now - lastTiltSendMs;
      if (elapsed >= TILT_SEND_INTERVAL_MS) {
        lastTiltSendMs = now;
        sendWs({ type: "tilt_servo_angle", angleDeg: pendingTiltAngle });
      } else if (tiltTrailingTimer === null) {
        tiltTrailingTimer = setTimeout(() => {
          tiltTrailingTimer = null;
          lastTiltSendMs = Date.now();
          sendWs({ type: "tilt_servo_angle", angleDeg: pendingTiltAngle });
        }, TILT_SEND_INTERVAL_MS - elapsed);
      }
    };
    // tiltSliderDragging suppresses the pose-broadcast sync (see its own
    // doc comment near the top of this file) while the user is actively
    // working this specific control, so the ~telemetryHz server update
    // can't yank the slider out from under a manual drag.
    angleSlider.addEventListener("mousedown", () => { tiltSliderDragging = true; });
    angleSlider.addEventListener("touchstart", () => { tiltSliderDragging = true; }, { passive: true });
    window.addEventListener("mouseup", () => { tiltSliderDragging = false; });
    window.addEventListener("touchend", () => { tiltSliderDragging = false; });
    angleVal.addEventListener("focus", () => { tiltSliderDragging = true; });
    angleVal.addEventListener("blur", () => { tiltSliderDragging = false; });

    angleSlider.addEventListener("input", () => {
      angleVal.value = angleSlider.value;
      sendTiltAngle(angleSlider.value);
      updateTiltPulseDisplay();
    });
    angleVal.addEventListener("change", () => {
      angleSlider.value = angleVal.value;
      sendTiltAngle(angleVal.value);
      updateTiltPulseDisplay();
    });
    document.getElementById("tiltCenterBtn").addEventListener("click", () => {
      angleSlider.value = 0;
      angleVal.value = 0;
      sendTiltAngle(0);
      updateTiltPulseDisplay();
    });

    [
      ["tiltMinPulseUs", document.getElementById("tiltMinPulseUs")],
      ["tiltCenterPulseUs", document.getElementById("tiltCenterPulseUs")],
      ["tiltMaxPulseUs", document.getElementById("tiltMaxPulseUs")],
    ].forEach(([paramName, el]) => {
      el.addEventListener("change", (e) => setParam(paramName, e.target.value));
      el.addEventListener("input", updateTiltPulseDisplay);
    });

    [
      ["tiltMinAngleDeg", document.getElementById("tiltMinAngleDeg")],
      ["tiltMaxAngleDeg", document.getElementById("tiltMaxAngleDeg")],
    ].forEach(([paramName, el]) => {
      el.addEventListener("change", (e) => {
        setParam(paramName, e.target.value);
        updateTiltRangeAndSlider();
      });
      el.addEventListener("input", updateTiltPulseDisplay);
    });
  }

  let debounceTimeout;
  ["kp", "ki", "kd"].forEach((name) => {
    const slider = document.getElementById(name);
    const valEl = document.getElementById(name + "Val");
    slider.addEventListener("input", () => {
      clearTimeout(debounceTimeout);
      debounceTimeout = setTimeout(() => {
        valEl.value = slider.value;
        setParam(name, slider.value);
      }, 50);
    });
    valEl.addEventListener("change", () => {
      slider.value = valEl.value;
      setParam(name, valEl.value);
    });
  });

  const motorPowerSlider = document.getElementById("motorPower");
  const motorPowerVal = document.getElementById("motorPowerVal");
  motorPowerSlider.addEventListener("input", () => {
    clearTimeout(debounceTimeout);
    debounceTimeout = setTimeout(() => {
      motorPowerVal.textContent = motorPowerSlider.value;
      maxMotorPowerPwm = parseFloat(motorPowerSlider.value);
      setParam("motorPower", motorPowerSlider.value);
    }, 50);
  });

  document.getElementById("wifiConnectBtn").addEventListener("click", () => {
    const ssid = document.getElementById("ssid").value;
    const password = document.getElementById("password").value;
    document.getElementById("wifi-status").textContent = "Sending, reconnecting...";
    fetch("/wifi", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ssid, password }),
    })
      .then((r) => r.text())
      .then((data) => {
        document.getElementById("wifi-status").textContent = data;
      })
      .catch(() => {
        // The board reconnects to the new network right after responding,
        // which usually drops this very request before the browser reads
        // the reply - that's expected, not necessarily a failure.
        document.getElementById("wifi-status").textContent =
          "Request sent - the board is switching networks, it may become unreachable at this address.";
      });
  });

  // Firmware/filesystem OTA: raw POST body (not multipart), matching the
  // firmware's read_post_body()/esp_ota_write()/esp_partition_write() side.
  // Both endpoints reboot the board on success, so a network error on the
  // response itself is the expected/successful outcome, same as the
  // /wifi handler above.
  //
  // otaHeaders(): builds the Authorization: Basic header from the current
  // input fields (not the last-saved setting) so a credential just typed
  // but not yet blurred/saved still works for this upload. Harmless to send
  // even when the firmware has auth disabled (empty otaPassword) - it just
  // ignores the header in that case.
  function otaHeaders() {
    const user = document.getElementById("otaUsername").value;
    const pass = document.getElementById("otaPassword").value;
    return { Authorization: "Basic " + btoa(`${user}:${pass}`) };
  }
  document.getElementById("uploadFwBtn").addEventListener("click", () => {
    const file = document.getElementById("fwFile").files[0];
    const status = document.getElementById("otaStatus");
    if (!file) {
      status.textContent = "Choose a .bin file first.";
      return;
    }
    status.textContent = `Uploading ${file.name} (${file.size} bytes)...`;
    fetch("/update", { method: "POST", body: file, headers: otaHeaders() })
      .then((r) => r.text())
      .then((data) => {
        status.textContent = data;
      })
      .catch(() => {
        status.textContent = "Upload sent - the board is rebooting into the new firmware.";
      });
  });

  document.getElementById("uploadFsBtn").addEventListener("click", () => {
    const file = document.getElementById("fsFile").files[0];
    const status = document.getElementById("fsStatus");
    if (!file) {
      status.textContent = "Choose a storage.bin file first.";
      return;
    }
    status.textContent = `Uploading ${file.name} (${file.size} bytes)...`;
    fetch("/update-fs", { method: "POST", body: file, headers: otaHeaders() })
      .then((r) => r.text())
      .then((data) => {
        status.textContent = data;
      })
      .catch(() => {
        status.textContent = "Upload sent - the board is rebooting to remount the filesystem.";
      });
  });

  // Joystick widgets: direct motor-PWM control and control-frame control
  // share identical drag/geometry/throttling behavior, differing only in
  // which WS message type they send and which panel they highlight as active.
  setupJoystick("joystickContainer", "joystickKnob", "joystick", "0");
  setupJoystick("joystickContainer2", "joystickKnob2", "control_joystick", "3");

  // Camera control joystick: 2D, but its two axes are different KINDS of
  // control (see setupCameraJoystick()'s own doc comment) so it isn't just
  // another setupJoystick() call.
  setupCameraJoystick("cameraControlJoystick", "cameraControlKnob");
});

function setupJoystick(containerId, knobId, wsMessageType, modeHighlightValue) {
  const container = document.getElementById(containerId);
  const knob = document.getElementById(knobId);
  let active = false;
  const center = { x: 110, y: 110 };
  const maxDistance = 90;

  let lastSendMs = 0;
  const sendIntervalMs = 40; // ~25 Hz
  let currentJ1 = 0;
  let currentJ2 = 0;
  let heartbeatTimer = null;
  // The firmware stops driving if it hasn't seen a fresh joystick message in
  // 1s (DRIVE_COMMAND_WATCHDOG_MS, web_server.cpp) -- a safety net for a
  // dropped connection/closed tab. But sendJoystick() below only fires from
  // actual pointer-move events, so holding the knob deflected but perfectly
  // still (no mousemove events at all) meant no message went out for over a
  // second and the robot stopped on its own mid-command. This timer
  // resends the current vector regardless of movement, at a period well
  // under that 1s cutoff, for as long as the knob is actively held.
  const HEARTBEAT_INTERVAL_MS = 200;

  function sendJoystick(j1, j2) {
    currentJ1 = j1;
    currentJ2 = j2;
    const now = Date.now();
    if (now - lastSendMs >= sendIntervalMs || (j1 === 0 && j2 === 0)) {
      lastSendMs = now;
      sendWs({ type: wsMessageType, j1, j2 });
      updateModeHighlight(modeHighlightValue);
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      sendWs({ type: wsMessageType, j1: currentJ1, j2: currentJ2 });
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function updatePosition(x, y) {
    const dx = x - center.x;
    const dy = y - center.y;
    const dist = Math.min(Math.sqrt(dx * dx + dy * dy), maxDistance);
    const angle = Math.atan2(dy, dx);
    const knobX = center.x + dist * Math.cos(angle);
    const knobY = center.y + dist * Math.sin(angle);

    knob.style.left = `${knobX}px`;
    knob.style.top = `${knobY}px`;

    const j1 = (knobX - center.x) / maxDistance;
    const j2 = -(knobY - center.y) / maxDistance;
    sendJoystick(j1, j2);
  }

  function resetJoystick() {
    knob.style.left = "50%";
    knob.style.top = "50%";
    sendJoystick(0, 0);
  }

  function handleMove(e) {
    if (!active) return;
    let clientX, clientY;
    if (e.touches) {
      e.preventDefault(); // suppress scroll/long-press text selection while dragging
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    const rect = container.getBoundingClientRect();
    updatePosition(clientX - rect.left, clientY - rect.top);
  }

  container.addEventListener("mousedown", (e) => {
    active = true;
    container.classList.add("active");
    handleMove(e);
    startHeartbeat();
  });
  container.addEventListener("touchstart", (e) => {
    e.preventDefault(); // suppress the long-press context menu / callout
    active = true;
    container.classList.add("active");
    handleMove(e);
    startHeartbeat();
  }, { passive: false });
  container.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("mousemove", handleMove);
  window.addEventListener("touchmove", handleMove, { passive: false });
  window.addEventListener("mouseup", () => {
    if (active) {
      active = false;
      container.classList.remove("active");
      stopHeartbeat();
      resetJoystick();
    }
  });
  window.addEventListener("touchend", () => {
    if (active) {
      active = false;
      container.classList.remove("active");
      stopHeartbeat();
      resetJoystick();
    }
  });
}

// 2D sibling of setupJoystick() above, for the combined rotate+tilt camera
// control joystick. Both axes are RATE controls, like an FPS game's look
// stick: X sends a signed deflection fraction as "control_frame_rotate",
// Y sends one as "tilt_rate" (see ws_broadcast.cpp for both). The RAW
// fraction is sent as-is -- the response curve (linear/quadratic,
// settings.cameraJoystickCurve) and the rate scaling
// (panMaxSpeedDegPerSec/tiltMaxSpeedDegPerSec) are both applied
// server-side, not here. This matters with multiple browsers potentially
// open at once: the ESP32 is the single authoritative owner of the current
// pan/tilt angles, not any one browser's local state, so the client's only
// job is reporting "how far is the stick pushed," the same for every tab.
// On release, BOTH axes reset -- the knob snaps back to center and both
// rate messages go out with value 0 -- matching a real game controller's
// spring-loaded stick. The camera itself does NOT snap back; it simply
// stops moving, exactly as if you let go of a look stick.
function setupCameraJoystick(containerId, knobId) {
  const container = document.getElementById(containerId);
  const knob = document.getElementById(knobId);
  let active = false;
  const center = { x: 110, y: 110 };
  const maxDistance = 90;

  let lastSendMs = 0;
  const sendIntervalMs = 40; // ~25 Hz, matches the joysticks
  let currentRotateValue = 0;
  let currentTiltValue = 0;
  let heartbeatTimer = null;
  // Same rationale as setupJoystick()'s heartbeat: a held-yet-motionless
  // drag produces no pointer-move events at all, so this resends both
  // current values on a timer for as long as the knob is held -- both
  // firmware-side inputs go stale after a watchdog timeout otherwise (see
  // ws_broadcast.cpp's DRIVE_COMMAND_WATCHDOG_MS use for
  // lastControlFrameRotateMsgMs / lastTiltRateMsgMs).
  const HEARTBEAT_INTERVAL_MS = 200;

  function sendCameraControl(rotateValue, tiltValue) {
    currentRotateValue = rotateValue;
    currentTiltValue = tiltValue;
    const now = Date.now();
    if (now - lastSendMs >= sendIntervalMs || (rotateValue === 0 && tiltValue === 0)) {
      lastSendMs = now;
      sendWs({ type: "control_frame_rotate", value: rotateValue });
      sendWs({ type: "tilt_rate", value: tiltValue });
    }
  }

  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      sendWs({ type: "control_frame_rotate", value: currentRotateValue });
      sendWs({ type: "tilt_rate", value: currentTiltValue });
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopHeartbeat() {
    if (heartbeatTimer !== null) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function updatePosition(x, y) {
    const dx = Math.max(-maxDistance, Math.min(maxDistance, x - center.x));
    const dy = Math.max(-maxDistance, Math.min(maxDistance, y - center.y));
    knob.style.left = `${center.x + dx}px`;
    knob.style.top = `${center.y + dy}px`;

    // Negated, same reasoning as the old rotate trackpad: dragging LEFT
    // should match the old "Rotate Left" button's direction.
    const rotateValue = -dx / maxDistance;
    // Negated: screen Y grows downward, but "up" should be the positive
    // (toward tiltMaxAngleDeg) direction.
    const tiltValue = -dy / maxDistance;
    sendCameraControl(rotateValue, tiltValue);
  }

  function handleMove(e) {
    if (!active) return;
    let clientX, clientY;
    if (e.touches) {
      e.preventDefault(); // suppress scroll/long-press text selection while dragging
      clientX = e.touches[0].clientX;
      clientY = e.touches[0].clientY;
    } else {
      clientX = e.clientX;
      clientY = e.clientY;
    }
    const rect = container.getBoundingClientRect();
    updatePosition(clientX - rect.left, clientY - rect.top);
  }

  function release() {
    if (!active) return;
    active = false;
    container.classList.remove("active");
    stopHeartbeat();
    knob.style.left = "50%";
    knob.style.top = "50%";
    sendCameraControl(0, 0);
  }

  container.addEventListener("mousedown", (e) => {
    active = true;
    container.classList.add("active");
    handleMove(e);
    startHeartbeat();
  });
  container.addEventListener("touchstart", (e) => {
    e.preventDefault(); // suppress the long-press context menu / callout
    active = true;
    container.classList.add("active");
    handleMove(e);
    startHeartbeat();
  }, { passive: false });
  container.addEventListener("contextmenu", (e) => e.preventDefault());
  window.addEventListener("mousemove", handleMove);
  window.addEventListener("touchmove", handleMove, { passive: false });
  window.addEventListener("mouseup", release);
  window.addEventListener("touchend", release);
}
