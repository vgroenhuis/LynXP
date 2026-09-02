// Cam page: displays this robot's own ESP32-S3-Sense camera stream
// fullscreen. The cam's MJPEG multipart stream (see ESP32_S3_CAM_IDF/main/
// main.c) runs on its own httpd server on port 81, path /stream -- a single
// img.src assignment is enough, the browser decodes each successive
// multipart frame on its own with no polling loop needed.
//
// The cam's current IP is read from THIS robot's own /camdiag (same-origin,
// no CORS) rather than the "S3 CAM" panel's manually-entered address
// directly: /camdiag relays the cam's self-reported IP live over the
// UART link (see uart_link.cpp) and is already the authoritative source the
// Main page's diagnostics block polls, so it's correct even if the cam's
// address changes (DHCP) without anyone updating the Main page field.

window.addEventListener("DOMContentLoaded", () => {
  // Fullscreen API requires a user gesture, so this can only be offered as
  // a button, not requested automatically on load. requestFullscreen()
  // targets the whole <html> element (not just .cam-fullscreen) so the
  // browser's own chrome (address bar, tabs) gets hidden too, not just the
  // page content growing to fill the existing viewport (which the CSS
  // layout already does on its own).
  const fullscreenBtn = document.getElementById("camFullscreenBtn");
  fullscreenBtn.addEventListener("click", () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      // Some browsers (notably older iOS Safari) don't support
      // requestFullscreen() on arbitrary elements at all - fail silently,
      // the page is already laid out to fill the viewport via CSS either way.
      document.documentElement.requestFullscreen().then(() => {
        // Most browsers only allow screen.orientation.lock() while in
        // fullscreen (a bare page can't hijack device rotation). iOS Safari
        // doesn't implement the Orientation Lock API at all -- the
        // .cam-rotate-prompt CSS media query is the fallback for that case,
        // shown whenever the device is actually held in portrait regardless
        // of whether this lock call succeeded.
        if (screen.orientation && screen.orientation.lock) {
          screen.orientation.lock("landscape").catch(() => {});
        }
      }).catch(() => {});
    }
  });
  document.addEventListener("fullscreenchange", () => {
    fullscreenBtn.textContent = document.fullscreenElement ? "Exit fullscreen" : "Fullscreen";
  });

  // Overlays panel: same three toggles as the Main page's "Camera page
  // settings" panel (camShowMapOverlay/camShowFloorGrid/
  // camShowWaypointsOverlay), reading/writing the exact same localStorage
  // keys so either page's control reflects the other's latest choice on its
  // next load.
  //
  // Each overlay's init function (initMapOverlay/initFloorGrid/
  // initWaypointOverlay) subscribes to the shared /pose poller with no way
  // to unsubscribe, so it must run at most once per overlay ever -- not
  // once per toggle flip. ensureInitialized() below is the guard: the FIRST
  // time an overlay is switched on (whether that's at page load, because it
  // was already on, or later by hand) it actually runs init; every toggle
  // after that just flips the canvas's visibility. This also means an
  // overlay that starts off (the common case) never subscribes to /pose at
  // all until actually enabled, matching this page's existing "don't poll
  // for something nobody turned on" approach elsewhere (see subscribeToPose
  // and startWaypointsPolling's own comments).
  function wireOverlayToggle(toggleId, storageKey, canvasId, ensureInitialized) {
    const toggle = document.getElementById(toggleId);
    const canvas = document.getElementById(canvasId);
    const initiallyOn = localStorage.getItem(storageKey) === "true";
    toggle.checked = initiallyOn;
    canvas.style.display = initiallyOn ? "block" : "none";
    if (initiallyOn) ensureInitialized();
    toggle.addEventListener("change", () => {
      localStorage.setItem(storageKey, toggle.checked);
      canvas.style.display = toggle.checked ? "block" : "none";
      if (toggle.checked) ensureInitialized();
    });
  }

  const img = document.getElementById("camStream");
  const status = document.getElementById("cam-status");
  const settingsLink = document.getElementById("camSettingsLink");

  // Same-origin poll of THIS robot's /camdiag doubles as this page's
  // connectivity heartbeat for the cam: a raw <img> only notices a stream
  // going away if the underlying connection gets a clean close, which a
  // hard power-cycle of the cam never sends (same class of problem as the
  // Main page's own stream-reconnect handling elsewhere in this codebase).
  // /camdiag's "stale" flag, driven by the UART link's own last-seen timer,
  // is a much more reliable "is the cam actually still there" signal --
  // polling it here catches that case and reconnects the <img> once the cam
  // is heard from again, instead of leaving a permanently frozen last frame
  // on screen.
  const CAM_HEARTBEAT_INTERVAL_MS = 2000;
  // Matches the cam's own native stream page (ESP32_S3_CAM_IDF/main/
  // index.html): onerror fires on every brief multipart frame-boundary hiccup
  // as well as a genuine drop, so the warning is delayed this long and
  // cancelled if a frame loads in the meantime -- avoids flashing a message
  // for a blip while still warning promptly for a real outage.
  const STREAM_OFFLINE_WARNING_DELAY_MS = 1500;
  let currentCamIp = null;
  let camEverConnected = false;
  let wasReachable = false;
  let offlineWarningTimer = null;

  img.onload = () => {
    clearTimeout(offlineWarningTimer);
    status.textContent = "";
  };
  img.onerror = () => {
    clearTimeout(offlineWarningTimer);
    offlineWarningTimer = setTimeout(() => {
      status.textContent = currentCamIp ? `Unable to load stream from ${currentCamIp}:81 (cam offline or unreachable).` : "Camera not detected.";
    }, STREAM_OFFLINE_WARNING_DELAY_MS);
  };

  function connectStream(camIp) {
    currentCamIp = camIp;
    // Cache-bust only on a reconnect (not the very first connect) so a
    // stale cached frame from a previous session can't linger.
    const cacheBust = camEverConnected ? `?t=${Date.now()}` : "";
    camEverConnected = true;
    img.src = `http://${camIp}:81/stream${cacheBust}`;
    settingsLink.href = `http://${camIp}/settings`;
    settingsLink.style.display = "";
  }

  function pollCamHeartbeat() {
    fetch("/camdiag")
      .then((r) => r.json())
      .then((d) => {
        const reachable = !d.stale && d.ip && d.ip !== "0.0.0.0";
        if (reachable && (!wasReachable || d.ip !== currentCamIp)) {
          connectStream(d.ip);
        } else if (!reachable) {
          status.textContent = "Camera unreachable, waiting...";
        }
        wasReachable = reachable;
      })
      .catch(() => {}); // transient fetch failure -- next tick retries
  }
  pollCamHeartbeat();
  setInterval(pollCamHeartbeat, CAM_HEARTBEAT_INTERVAL_MS);

  // Map overlay needs no robot calibration (it's driven entirely by pose).
  let mapOverlayInitialized = false;
  wireOverlayToggle("camToggleMapOverlay", "camShowMapOverlay", "camMapOverlay", () => {
    if (mapOverlayInitialized) return;
    mapOverlayInitialized = true;
    initMapOverlay();
  });

  // Floor grid + waypoints overlay both need the same pinhole-camera
  // calibration (height/tilt/FOV), which lives as a robot setting, not
  // localStorage -- it's a property of the physical camera mount, not a
  // per-browser display preference. Fetched once regardless of whether
  // either overlay starts on (a single one-off request, unlike the
  // recurring /pose or /waypoints polling those overlays themselves start)
  // so switching one on later doesn't need to wait on a fresh fetch.
  const calibPromise = fetch("/params")
    .then((r) => r.json())
    .then((data) => {
      // Game settings (see the Main page's "Game settings" panel) -- piggy-
      // backed onto this same fetch rather than a second round-trip, same
      // reasoning as the floor-grid calibration below.
      if (typeof data.fireballSpeedMps === "number") fireballSpeedMps = data.fireballSpeedMps;
      if (typeof data.monsterSpeedMps === "number") monsterSpeedMps = data.monsterSpeedMps;
      if (typeof data.monsterCount === "number") monsterCount = data.monsterCount;
      if (typeof data.monsterStandoffDistanceM === "number") monsterStandoffDistanceM = data.monsterStandoffDistanceM;
      fireballLifetimeMs = ((FIREBALL_MAX_RANGE_M - FIREBALL_START_DISTANCE_M) / fireballSpeedMps) * 1000;

      return {
        heightM: data.cameraHeightMm / 1000,
        tiltRad: (data.cameraTiltDeg * Math.PI) / 180,
        vfovRad: (data.cameraVerticalFovDeg * Math.PI) / 180,
      };
    })
    .catch(() => {
      document.getElementById("cam-status").textContent = "Unable to load camera settings from the robot.";
      return null;
    });

  let floorGridInitialized = false;
  wireOverlayToggle("camToggleFloorGrid", "camShowFloorGrid", "camFloorGrid", () => {
    if (floorGridInitialized) return;
    floorGridInitialized = true;
    calibPromise.then((calib) => {
      if (calib) initFloorGrid(calib);
    });
  });

  let waypointOverlayInitialized = false;
  wireOverlayToggle("camToggleWaypoints", "camShowWaypointsOverlay", "camWaypointOverlay", () => {
    if (waypointOverlayInitialized) return;
    waypointOverlayInitialized = true;
    calibPromise.then((calib) => {
      if (calib) initWaypointOverlay(calib);
    });
  });

  // Touch drive/look controls -- only on devices that actually have a
  // touchscreen (phone, tablet). Desktop/mouse users get the page exactly
  // as before, unchanged.
  if ("ontouchstart" in window || navigator.maxTouchPoints > 0) {
    setupCamTouchControls();
  }

  document.getElementById("camFireballBtn").addEventListener("click", () => {
    calibPromise.then((calib) => {
      if (calib) spawnFireball(calib);
    });
  });

  // Monsters are ambient -- they wander the scene whether or not anyone's
  // ever fired a fireball -- so this starts as soon as calibration is in,
  // not lazily on first button press like the toggleable overlays above.
  calibPromise.then((calib) => {
    if (calib) ensureFireballOverlayInitialized(calib);
  });
});

// --- Fireball + monsters: a purely cosmetic AR mini-game layered onto the
// camera view (no hardware/gameplay meaning to the robot itself). Both
// fireballs and monsters are real points in WORLD space, not locked to the
// camera's current view -- each is reprojected fresh every frame from the
// LIVE pose, exactly like the waypoint overlay's own markers (see
// initWaypointOverlay()'s comment for the shared derivation:
// worldToRelative() + a tilt-aware pinhole project()). The one thing that's
// fixed at the moment a fireball is fired (not re-read afterward) is its
// LAUNCH DIRECTION -- the camera's pan+tilt aim at that instant -- since a
// real projectile doesn't change course just because the shooter moves or
// looks elsewhere after it's already away.
// fireballSpeedMps/monsterSpeedMps/monsterCount/monsterStandoffDistanceM are
// configurable from the Main page's "Game settings" panel (persisted
// robot-side, like every other setting) rather than hardcoded -- loaded
// from /params below, with these as fallback defaults if that fetch fails.
// The rest stay internal tuning constants, not exposed as settings.
let fireballSpeedMps = 0.5;
const FIREBALL_RADIUS_M = 0.08;
const FIREBALL_START_DISTANCE_M = 0.2; // launched a short distance out, not exactly at the camera (a projection singularity)
const FIREBALL_MAX_RANGE_M = 5; // straight-line distance travelled (from launch, not FIREBALL_START_DISTANCE_M) before it fades out
let fireballLifetimeMs = ((FIREBALL_MAX_RANGE_M - FIREBALL_START_DISTANCE_M) / fireballSpeedMps) * 1000; // recomputed once fireballSpeedMps loads from /params
const FIREBALL_FADE_FRACTION = 0.8; // fraction of its lifetime before it starts fading out

// Monsters wander the world, biased toward the robot's current position,
// and respawn a short distance away whenever a fireball connects.
let monsterCount = 2;
let monsterSpeedMps = 0.1;
const MONSTER_RADIUS_M = 0.15;
const MONSTER_SPAWN_MIN_DISTANCE_M = 2;
const MONSTER_SPAWN_MAX_DISTANCE_M = 3;
const MONSTER_CHASE_WEIGHT = 0.75; // 0 = pure random wander, 1 = beeline straight for the target
const MONSTER_WANDER_TURN_RATE_RAD_PER_S = 1.2; // how fast its own random heading can drift
let monsterStandoffDistanceM = 0.2; // where it settles once caught up -- directly in front of the camera, not on top of it
const MONSTER_ARRIVE_TOLERANCE_M = 0.03; // once within this band of the standoff point, it holds position instead of jittering around it forever
const MONSTER_UPDATE_MAX_DT_S = 0.25; // caps one physics step so a backgrounded tab's huge first dt can't teleport it
const MONSTER_HIT_RADIUS_M = FIREBALL_RADIUS_M + MONSTER_RADIUS_M; // world-distance below which a fireball connects
const MONSTER_DEATH_LINGER_MS = 5000; // how long a dead monster stays visible (motionless, eyes X'd) before it's removed and a fresh one spawns

const FIREBALL_COLOR_STOPS = [
  [0, "rgba(255, 255, 220, 1)"],
  [0.35, "rgba(255, 180, 40, 0.95)"],
  [0.7, "rgba(255, 80, 20, 0.7)"],
  [1, "rgba(255, 40, 0, 0)"],
];
const MONSTER_COLOR_STOPS = [
  [0, "rgba(210, 255, 140, 1)"],
  [0.4, "rgba(110, 200, 40, 0.95)"],
  [0.75, "rgba(50, 110, 20, 0.85)"],
  [1, "rgba(30, 70, 10, 0)"],
];
const CROSSHAIR_SIZE_PX = 14;
const CROSSHAIR_GAP_PX = 4;

let fireballOverlayInitialized = false;
let fireballLastPose = { x: 0, y: 0, theta: 0, servoAngleDeg: 0, tiltAngleDeg: 0 };
let activeFireballs = [];
let monsters = []; // {x, y, wanderAngleRad, state: "alive"|"dead", diedAtMs}
let monsterUpdateLastMs = null;

function randomPositionAround(px, py, minDistM, maxDistM) {
  const angle = Math.random() * 2 * Math.PI;
  const dist = minDistM + Math.random() * (maxDistM - minDistM);
  return { x: px + dist * Math.cos(angle), y: py + dist * Math.sin(angle) };
}

// calib: same {heightM, tiltRad, vfovRad} shape as initFloorGrid/
// initWaypointOverlay's own calib -- see their shared comment for what
// each field means and where it comes from.
function ensureFireballOverlayInitialized(calib) {
  if (fireballOverlayInitialized) return;
  fireballOverlayInitialized = true;

  const canvas = document.getElementById("camFireballOverlay");
  const img = document.getElementById("camStream");
  canvas.style.display = "block"; // stays block permanently once first used; clearRect makes "nothing active" visually empty
  const ctx = canvas.getContext("2d");

  // Effective tilt is recomputed fresh in draw() below from the CURRENT
  // live pose (for reprojecting existing fireballs/monsters), not from
  // whatever it was at any particular fireball's launch time.
  let effectiveTiltRad = calib.tiltRad;

  // Identical to initWaypointOverlay()'s own worldToRelative()/project() --
  // duplicated rather than shared, matching how the floor grid and
  // waypoint overlay each already keep their own independent copies.
  function worldToRelative(wx, wy, pose) {
    const dx = wx - pose.x;
    const dy = wy - pose.y;
    return {
      right: dx * Math.sin(pose.theta) - dy * Math.cos(pose.theta),
      forward: dx * Math.cos(pose.theta) + dy * Math.sin(pose.theta),
    };
  }

  function project(x, y, h) {
    const verticalOffsetM = calib.heightM - h;
    const zc = y * Math.cos(effectiveTiltRad) + verticalOffsetM * Math.sin(effectiveTiltRad);
    const yc = verticalOffsetM * Math.cos(effectiveTiltRad) - y * Math.sin(effectiveTiltRad);
    const imgW = img.naturalWidth;
    const imgH = img.naturalHeight;
    const f = imgH / 2 / Math.tan(calib.vfovRad / 2);
    return { u: imgW / 2 + (f * x) / zc, v: imgH / 2 + (f * yc) / zc, zc };
  }

  // Current world position of a fireball, straight-line along its fixed
  // launch direction -- shared by rendering and collision checks so both
  // always agree on where it actually is.
  function fireballWorldPos(fb, nowMs) {
    const traveledM = FIREBALL_START_DISTANCE_M + (fireballSpeedMps * (nowMs - fb.spawnedAtMs)) / 1000;
    const horizontalM = traveledM * Math.cos(fb.launchTiltRad);
    return {
      x: fb.launchX + horizontalM * Math.cos(fb.launchThetaRad),
      y: fb.launchY + horizontalM * Math.sin(fb.launchThetaRad),
      h: calib.heightM - traveledM * Math.sin(fb.launchTiltRad),
    };
  }

  function ensureMonstersSpawned(px, py) {
    while (monsters.length < monsterCount) {
      const pos = randomPositionAround(px, py, MONSTER_SPAWN_MIN_DISTANCE_M, MONSTER_SPAWN_MAX_DISTANCE_M);
      monsters.push({ x: pos.x, y: pos.y, wanderAngleRad: Math.random() * 2 * Math.PI, state: "alive", diedAtMs: 0 });
    }
  }

  // Each monster's heading blends a straight line toward its target point
  // with its own slowly-drifting random wander direction -- blended as unit
  // vectors (not by averaging the two angles directly, which has a
  // wraparound bug whenever they're on opposite sides of +-180deg). A dead
  // monster is skipped entirely here (stays exactly where it died) until
  // MONSTER_DEATH_LINGER_MS removes it, at which point the count top-up
  // below spawns its replacement.
  //
  // The target isn't the robot's own position -- it's a point
  // monsterStandoffDistanceM directly in front of the CAMERA'S current
  // aim (chassis heading + pan), so a monster that catches up ends up
  // somewhere the player can actually see it rather than closing to zero
  // distance (where it'd sit behind/beside the chassis, or exactly on top
  // of it, out of view). Once within MONSTER_ARRIVE_TOLERANCE_M of that
  // point it just holds position -- still tracking a slowly-moving/panning
  // target, but not endlessly jittering around it once caught up.
  function updateMonsters(pose, nowMs) {
    monsters = monsters.filter((m) => m.state !== "dead" || nowMs - m.diedAtMs < MONSTER_DEATH_LINGER_MS);
    ensureMonstersSpawned(pose.x, pose.y);
    if (monsterUpdateLastMs === null) {
      monsterUpdateLastMs = nowMs;
      return;
    }
    const dtS = Math.min((nowMs - monsterUpdateLastMs) / 1000, MONSTER_UPDATE_MAX_DT_S);
    monsterUpdateLastMs = nowMs;

    const cameraThetaRad = pose.theta + (pose.servoAngleDeg * Math.PI) / 180;
    const targetX = pose.x + monsterStandoffDistanceM * Math.cos(cameraThetaRad);
    const targetY = pose.y + monsterStandoffDistanceM * Math.sin(cameraThetaRad);

    monsters.forEach((m) => {
      if (m.state === "dead") return;
      const dxToTarget = targetX - m.x;
      const dyToTarget = targetY - m.y;
      const distToTarget = Math.hypot(dxToTarget, dyToTarget);
      if (distToTarget <= MONSTER_ARRIVE_TOLERANCE_M) return; // close enough -- hold position

      m.wanderAngleRad += (Math.random() - 0.5) * MONSTER_WANDER_TURN_RATE_RAD_PER_S * dtS;
      const chaseAngleRad = Math.atan2(dyToTarget, dxToTarget);
      const vx = MONSTER_CHASE_WEIGHT * Math.cos(chaseAngleRad) + (1 - MONSTER_CHASE_WEIGHT) * Math.cos(m.wanderAngleRad);
      const vy = MONSTER_CHASE_WEIGHT * Math.sin(chaseAngleRad) + (1 - MONSTER_CHASE_WEIGHT) * Math.sin(m.wanderAngleRad);
      const vLen = Math.hypot(vx, vy) || 1;
      // Capped at distToTarget so a fast-approaching monster can't overshoot
      // past the standoff point in one physics step.
      const stepM = Math.min(monsterSpeedMps * dtS, distToTarget);
      m.x += (vx / vLen) * stepM;
      m.y += (vy / vLen) * stepM;
    });
  }

  // Fireball/monster collisions, purely in world space -- independent of
  // whether either is currently on-screen, same as a real projectile would
  // hit something regardless of what the camera happens to be pointed at.
  // A hit consumes the fireball (no pass-through) and marks the monster
  // dead in place -- it stays exactly where it was hit (see updateMonsters)
  // rather than immediately relocating; respawning a fresh one 2-3m away
  // happens later, once MONSTER_DEATH_LINGER_MS has passed.
  function resolveHits(nowMs) {
    const hitFireballIds = new Set();
    monsters.forEach((m) => {
      if (m.state === "dead") return;
      for (const fb of activeFireballs) {
        if (hitFireballIds.has(fb)) continue;
        const p = fireballWorldPos(fb, nowMs);
        if (Math.hypot(p.x - m.x, p.y - m.y) <= MONSTER_HIT_RADIUS_M) {
          hitFireballIds.add(fb);
          m.state = "dead";
          m.diedAtMs = nowMs;
          break;
        }
      }
    });
    if (hitFireballIds.size > 0) {
      activeFireballs = activeFireballs.filter((fb) => !hitFireballIds.has(fb));
    }
  }

  function drawGlow(cx, cy, radiusPx, opacity, colorStops) {
    ctx.save();
    ctx.globalAlpha = opacity;
    const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radiusPx);
    colorStops.forEach(([offset, color]) => gradient.addColorStop(offset, color));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(cx, cy, radiusPx, 0, 2 * Math.PI);
    ctx.fill();
    ctx.restore();
  }

  // Two simple dark eyes for character -- fixed screen-relative offset
  // rather than tracking the monster's own heading, which is plenty
  // convincing at this scale and avoids needing a facing-angle projection
  // of its own. Dead ones get an X'd-out look instead of dots.
  function drawEyes(cx, cy, radiusPx, dead) {
    const eyeOffsetPx = radiusPx * 0.35;
    const eyeY = cy - radiusPx * 0.15;
    [-1, 1].forEach((side) => {
      const ex = cx + side * eyeOffsetPx;
      if (dead) {
        const s = Math.max(radiusPx * 0.14, 1);
        ctx.strokeStyle = "rgba(20, 20, 20, 0.9)";
        ctx.lineWidth = Math.max(radiusPx * 0.07, 1);
        ctx.beginPath();
        ctx.moveTo(ex - s, eyeY - s);
        ctx.lineTo(ex + s, eyeY + s);
        ctx.moveTo(ex + s, eyeY - s);
        ctx.lineTo(ex - s, eyeY + s);
        ctx.stroke();
      } else {
        const r = Math.max(radiusPx * 0.12, 0.01);
        ctx.fillStyle = "rgba(20, 20, 20, 0.9)";
        ctx.beginPath();
        ctx.arc(ex, eyeY, r, 0, 2 * Math.PI);
        ctx.fill();
      }
    });
  }

  // Fixed at the displayed image's own center -- a HUD element, not a
  // world object, so it's always drawn last (on top of everything) rather
  // than taking part in the depth-sorted list below. Also happens to be
  // exactly where a newly-fired fireball starts out (see the module header
  // comment on why a point on the optical axis always projects to image
  // center), which is what makes it useful for aiming in the first place.
  function drawCrosshair(cx, cy) {
    ctx.save();
    ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx - CROSSHAIR_SIZE_PX, cy);
    ctx.lineTo(cx - CROSSHAIR_GAP_PX, cy);
    ctx.moveTo(cx + CROSSHAIR_GAP_PX, cy);
    ctx.lineTo(cx + CROSSHAIR_SIZE_PX, cy);
    ctx.moveTo(cx, cy - CROSSHAIR_SIZE_PX);
    ctx.lineTo(cx, cy - CROSSHAIR_GAP_PX);
    ctx.moveTo(cx, cy + CROSSHAIR_GAP_PX);
    ctx.lineTo(cx, cy + CROSSHAIR_SIZE_PX);
    ctx.stroke();
    ctx.restore();
  }

  function draw(pose) {
    fireballLastPose = pose;
    const now = performance.now();
    activeFireballs = activeFireballs.filter((fb) => now - fb.spawnedAtMs < fireballLifetimeMs);

    updateMonsters(pose, now);
    resolveHits(now);

    const containerW = canvas.clientWidth;
    const containerH = canvas.clientHeight;
    canvas.width = containerW;
    canvas.height = containerH;
    ctx.clearRect(0, 0, containerW, containerH);

    const imgW = img.naturalWidth;
    const imgH = img.naturalHeight;
    if (!imgW || !imgH) return;

    const scale = Math.min(containerW / imgW, containerH / imgH);
    const offsetX = (containerW - imgW * scale) / 2;
    const offsetY = (containerH - imgH * scale) / 2;
    const f = imgH / 2 / Math.tan(calib.vfovRad / 2);

    // Current camera aim -- for REPROJECTING against wherever the camera is
    // looking right now, not for a fireball's own trajectory (that's fixed
    // at launch, captured in fb.launch*).
    const cameraTheta = pose.theta + (pose.servoAngleDeg * Math.PI) / 180;
    effectiveTiltRad = calib.tiltRad - (pose.tiltAngleDeg * Math.PI) / 180;
    const camPose = { x: pose.x, y: pose.y, theta: cameraTheta };

    // Collected as {zc, render} entries and depth-sorted (painter's
    // algorithm: farthest first, nearest last) rather than always drawing
    // every fireball before every monster, so a closer entity of either
    // kind correctly occludes a farther one of the other kind.
    const drawables = [];

    activeFireballs.forEach((fb) => {
      const ageMs = now - fb.spawnedAtMs;
      const worldPos = fireballWorldPos(fb, now);
      const rel = worldToRelative(worldPos.x, worldPos.y, camPose);
      const p = project(rel.right, rel.forward, worldPos.h);
      if (p.zc <= 0.01) return; // behind the camera right now -- just skip drawing it this frame

      const cx = offsetX + p.u * scale;
      const cy = offsetY + p.v * scale;
      // Apparent size driven by p.zc (the TRUE current depth from the live
      // camera position to the fireball's current world position), so it
      // correctly grows/shrinks if the robot itself drives closer to or
      // further from it, not just from its own flight.
      const radiusPx = Math.max(((f * FIREBALL_RADIUS_M) / Math.max(p.zc, 0.05)) * scale, 0.01);

      const fadeStartMs = fireballLifetimeMs * FIREBALL_FADE_FRACTION;
      const opacity = ageMs > fadeStartMs ? Math.max(0, 1 - (ageMs - fadeStartMs) / (fireballLifetimeMs - fadeStartMs)) : 1;

      drawables.push({ zc: p.zc, render: () => drawGlow(cx, cy, radiusPx, opacity, FIREBALL_COLOR_STOPS) });
    });

    monsters.forEach((m) => {
      // Grounded creature: the glowing body's center sits one radius above
      // the floor (not exactly at floor level, which would draw it half
      // "underground"); its feet are separately projected at true floor
      // level (h=0) as a fixed, unanimated contact shadow -- gives a much
      // stronger "how far away is it" cue than the floating body alone,
      // moving with the same perspective as the floor grid itself.
      const rel = worldToRelative(m.x, m.y, camPose);
      const bodyP = project(rel.right, rel.forward, MONSTER_RADIUS_M);
      if (bodyP.zc <= 0.01) return; // behind the camera right now
      const feetP = project(rel.right, rel.forward, 0);

      const bodyCx = offsetX + bodyP.u * scale;
      const bodyCy = offsetY + bodyP.v * scale;
      const feetCx = offsetX + feetP.u * scale;
      const feetCy = offsetY + feetP.v * scale;
      const bodyRadiusPx = Math.max(((f * MONSTER_RADIUS_M) / Math.max(bodyP.zc, 0.05)) * scale, 0.01);
      const feetRadiusXPx = bodyRadiusPx * 0.9;
      const feetRadiusYPx = bodyRadiusPx * 0.35; // flattened, ground-hugging ellipse
      const dead = m.state === "dead";

      drawables.push({
        zc: bodyP.zc,
        render: () => {
          // Feet first, so the glowing body visually sits on top of them.
          ctx.save();
          ctx.fillStyle = "rgba(20, 40, 10, 0.85)";
          ctx.beginPath();
          ctx.ellipse(feetCx, feetCy, feetRadiusXPx, feetRadiusYPx, 0, 0, 2 * Math.PI);
          ctx.fill();
          ctx.restore();

          drawGlow(bodyCx, bodyCy, bodyRadiusPx, 1, MONSTER_COLOR_STOPS);
          drawEyes(bodyCx, bodyCy, bodyRadiusPx, dead);
        },
      });
    });

    drawables.sort((a, b) => b.zc - a.zc);
    drawables.forEach((d) => d.render());

    drawCrosshair(offsetX + (imgW * scale) / 2, offsetY + (imgH * scale) / 2);
  }

  subscribeToPose(draw);
}

function spawnFireball(calib) {
  ensureFireballOverlayInitialized(calib);
  const pose = fireballLastPose;
  activeFireballs.push({
    spawnedAtMs: performance.now(),
    launchX: pose.x,
    launchY: pose.y,
    // Camera's aim (pan + tilt) at the moment of firing, in world terms --
    // see the header comment on why this is captured once here rather
    // than read live in draw().
    launchThetaRad: pose.theta + (pose.servoAngleDeg * Math.PI) / 180,
    launchTiltRad: calib.tiltRad - (pose.tiltAngleDeg * Math.PI) / 180,
  });
}

// --- Shared pose telemetry: the mini-map, floor grid, and waypoints
// overlay all need live pose updates, so they share one poller (via
// subscribe callbacks) rather than each opening its own connection.
//
// Polls GET /pose over plain HTTP rather than keeping a WebSocket open.
// This page previously opened its own persistent /ws connection (on top of
// whatever the Main page already has open), and the robot started
// intermittently hanging - hard watchdog-timeout hangs, confirmed via the
// crash-breadcrumb log to be stuck inside Mongoose's own mg_mgr_poll(),
// not in any of our own message-handling code - specifically when a
// second simultaneous WS connection was in the picture (Camera page open
// alongside the Main page). Rather than debug further into vendored
// networking code talking directly to the CYW43 driver, the simpler and
// more robust fix is to just not hold a second long-lived connection open
// at all: each poll is a short request/response over the same HTTP path
// already used for /params etc., not a persistent socket.
const POSE_POLL_INTERVAL_MS = 150; // ~6-7Hz - smooth enough for overlay tracking, not chasing WS-grade rates

const poseSubscribers = [];
let posePollStarted = false;

function wrapToPi(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// Linear interpolation, with theta taking the short way around the
// wraparound rather than spinning the long way whenever a sample happens
// to straddle +-PI.
function lerpPose(a, b, t) {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    theta: a.theta + wrapToPi(b.theta - a.theta) * t,
    servoAngleDeg: a.servoAngleDeg + (b.servoAngleDeg - a.servoAngleDeg) * t,
    tiltAngleDeg: a.tiltAngleDeg + (b.tiltAngleDeg - a.tiltAngleDeg) * t,
  };
}

function subscribeToPose(callback) {
  poseSubscribers.push(callback);
  if (posePollStarted) return;
  posePollStarted = true;

  // The network side stays at its normal ~6-7Hz cadence -- deliberately
  // NOT polled faster to smooth motion, since a second connection here was
  // previously implicated in a hard-to-reproduce firmware hang (see the
  // comment above), and even short-lived polling at a much higher rate
  // would be a meaningfully different traffic pattern than what's already
  // been running reliably. Instead, prevPose/nextPose bracket the last two
  // samples actually received, and a requestAnimationFrame loop below
  // interpolates between them every frame (~60fps) -- this is what was
  // making waypoint markers (and the floor grid) visibly jump/judder
  // during fast rotation: they were being redrawn only once per poll
  // response, snapping straight to each new pose instead of easing toward
  // it. The tradeoff is up to one poll interval (~150ms) of added visual
  // lag, standard for this kind of network-entity smoothing and not
  // noticeable for a HUD overlay like this.
  let prevPose = null;
  let nextPose = null;
  let nextPoseReceivedAtMs = 0;

  function poll() {
    fetch("/pose")
      .then((r) => r.json())
      .then((data) => {
        const pose = { x: data.x, y: data.y, theta: data.theta, servoAngleDeg: data.servoAngleDeg || 0, tiltAngleDeg: data.tiltAngleDeg || 0 };
        prevPose = nextPose || pose;
        nextPose = pose;
        nextPoseReceivedAtMs = performance.now();
      })
      .catch(() => {}) // keep polling through a transient failure (e.g. brief Wi-Fi hiccup)
      .finally(() => setTimeout(poll, POSE_POLL_INTERVAL_MS));
  }
  poll();

  function animate() {
    if (nextPose) {
      const t = Math.min((performance.now() - nextPoseReceivedAtMs) / POSE_POLL_INTERVAL_MS, 1);
      const pose = prevPose ? lerpPose(prevPose, nextPose, t) : nextPose;
      poseSubscribers.forEach((cb) => cb(pose));
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
}

// A deliberately simplified, non-interactive "you are here" glance - not
// the Main page's full pan/zoom/click-to-navigate map (drawMap() in
// app.js), which is a much bigger piece of state/logic this page has no
// other use for. Fixed real-world scale, always centered on the robot,
// control-frame orientation - "up" on the map is whatever direction the
// camera is currently facing (chassis heading + pan servo angle, the same
// "effective camera heading" used by the floor grid/waypoint overlay
// below), so the map rotates live as the robot turns or the servo pans,
// matching what's actually in the camera view rather than a fixed
// north-up layout.
const CAM_MAP_METERS_VISIBLE = 3;
const CAM_MAP_MAX_TRAIL_POINTS = 200;

function initMapOverlay() {
  const canvas = document.getElementById("camMapOverlay");
  // wireOverlayToggle() only ever calls this once actually enabling the
  // overlay (initially on, or the moment it's first switched on) -- display
  // itself is owned entirely by wireOverlayToggle from then on.
  canvas.style.display = "block";
  const ctx = canvas.getContext("2d");
  const trail = [];

  // The round map's visual radius, independent of the canvas element's own
  // (larger) pixel dimensions -- see cam.html/style.css: the canvas is
  // sized bigger than this circle specifically so an out-of-range
  // waypoint's arrow has room to poke past the circle's edge and still be
  // drawn. A canvas can only ever render within its own pixel buffer
  // bounds regardless of CSS, so previously (when the circle was CSS
  // border-radius-clipped to the canvas's exact size) those arrows were
  // being silently discarded, not just visually clipped.
  const MAP_RADIUS_PX = 65;
  const ARROW_OVERLAP_PX = 3; // how far past MAP_RADIUS_PX an out-of-range arrow's anchor sits
  const mapCx = canvas.width / 2;
  const mapCy = canvas.height / 2;

  function worldToCanvas(x, y, pose) {
    const scale = (MAP_RADIUS_PX * 2) / CAM_MAP_METERS_VISIBLE;
    const cameraTheta = pose.theta + (pose.servoAngleDeg * Math.PI) / 180;
    const dx = x - pose.x;
    const dy = y - pose.y;
    const right = dx * Math.sin(cameraTheta) - dy * Math.cos(cameraTheta);
    const forward = dx * Math.cos(cameraTheta) + dy * Math.sin(cameraTheta);
    return {
      px: mapCx + right * scale,
      py: mapCy - forward * scale,
    };
  }

  function drawRoundBackground() {
    ctx.beginPath();
    ctx.arc(mapCx, mapCy, MAP_RADIUS_PX, 0, 2 * Math.PI);
    ctx.fillStyle = "rgba(0, 0, 0, 0.45)";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "#888";
    ctx.stroke();
  }

  // Small dots for each waypoint (Home included), same color convention as
  // the camera-view cylinder markers -- drawn under the trail/robot marker
  // so those stay legible on top. loadWaypointsForOverlay() is defined
  // further down this file but hoisted, and by the time this actually
  // runs (async, off a pose update) the whole script has long finished
  // loading, so the ordering in the file doesn't matter here.
  //
  // A waypoint beyond the map's visible radius instead gets a small arrow
  // clamped to the perimeter, pointing further in its direction -- the
  // same "offscreen objective" idea as the camera view's edge arrows, just
  // clamped to a circle (this map is round) rather than a rectangle, which
  // is simpler: just clamp the polar radius, no edge hit-testing needed.
  // Always drawn outside draw()'s circular clip region (see below), so the
  // arrow's overlap with the circle's edge is actually visible.
  function drawWaypoints(pose) {
    loadWaypointsForOverlay().forEach((wp) => {
      const { px, py } = worldToCanvas(wp.x, wp.y, pose);
      const color = wp.isHome ? "#2c9aff" : "#ffcc00";
      const dx = px - mapCx;
      const dy = py - mapCy;
      const dist = Math.hypot(dx, dy);

      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
      ctx.lineWidth = 1;

      if (dist <= MAP_RADIUS_PX) {
        ctx.beginPath();
        ctx.arc(px, py, 3, 0, 2 * Math.PI);
        ctx.fill();
        ctx.stroke();
        return;
      }

      const angle = Math.atan2(dy, dx);
      const anchorR = MAP_RADIUS_PX + ARROW_OVERLAP_PX;
      ctx.save();
      ctx.translate(mapCx + anchorR * Math.cos(angle), mapCy + anchorR * Math.sin(angle));
      ctx.rotate(angle);
      ctx.beginPath();
      ctx.moveTo(5, 0);
      ctx.lineTo(-3, -3.5);
      ctx.lineTo(-3, 3.5);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    });
  }

  function draw(pose) {
    if (canvas.style.display === "none") return; // toggled off -- skip the work, not just the visibility
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawRoundBackground();

    // Trail and the robot's own marker are clipped to the round map's
    // visual boundary, same as the old CSS border-radius clip -- only the
    // out-of-range waypoint arrows (drawn below, outside this clip) are
    // meant to intentionally poke past the edge.
    ctx.save();
    ctx.beginPath();
    ctx.arc(mapCx, mapCy, MAP_RADIUS_PX, 0, 2 * Math.PI);
    ctx.clip();

    if (trail.length > 1) {
      ctx.strokeStyle = "rgba(44, 154, 255, 0.85)";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      trail.forEach((p, i) => {
        const { px, py } = worldToCanvas(p.x, p.y, pose);
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.stroke();
    }

    const center = worldToCanvas(pose.x, pose.y, pose);
    const HEADING_LEN_M = 0.3;
    const tip = worldToCanvas(pose.x + HEADING_LEN_M * Math.cos(pose.theta), pose.y + HEADING_LEN_M * Math.sin(pose.theta), pose);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(center.px, center.py);
    ctx.lineTo(tip.px, tip.py);
    ctx.stroke();

    ctx.fillStyle = "#2c9aff";
    ctx.beginPath();
    ctx.arc(center.px, center.py, 4, 0, 2 * Math.PI);
    ctx.fill();

    ctx.restore();

    drawWaypoints(pose);
  }

  subscribeToPose((pose) => {
    trail.push({ x: pose.x, y: pose.y });
    if (trail.length > CAM_MAP_MAX_TRAIL_POINTS) trail.shift();
    draw(pose);
  });
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return { r: 40, g: 255, b: 120 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

// Floor grid overlay: projects a grid of real-world floor coordinates onto
// the camera image using a standard pinhole-camera model, given the
// camera's height above the floor, downward tilt, and vertical field of
// view (settings.cameraHeightMm/cameraTiltDeg/cameraVerticalFovDeg,
// calibrated on the Main page). The grid itself is fixed to the WORLD
// frame - the same minor(0.1m)/medium(0.5m)/major(1.0m) tiers as the Main
// page's live map (drawGridTier() in app.js) - so as the robot moves and
// turns, the grid translates/rotates under it exactly like a real grid
// painted on the floor would, rather than a fixed pattern rigidly
// attached to the camera. That means it has to be redrawn on every live
// pose update (subscribeToPose), not just once on load/resize.
//
// Accounts for the pan servo's current angle (broadcast as servoAngleDeg
// in pose telemetry) on top of the chassis heading, so the grid still
// tracks the real floor correctly while the servo is panned - e.g. by
// "Keep camera facing forward" reacting to a control-frame rotation. See
// draw()'s cameraTheta computation below. Likewise accounts for the tilt
// servo's current angle (tiltAngleDeg) on top of calib.tiltRad -- the
// latter is only the camera's fixed MOUNTING tilt (calibrated once, from
// robot settings), not the live tilt as the user actively tilts the camera
// up/down, so using calib.tiltRad alone left the grid correctly aligned
// only at the tilt servo's home position and increasingly wrong the
// further it moved away from it.
//
// Camera-relative coordinate setup: camera at the origin, X = right,
// Y = forward (horizontal), Z = down. A floor point at lateral offset x,
// forward distance y is at camera-relative world position (x, y, heightM).
// Tilting the camera down by tiltRad is a rotation about the X axis,
// giving camera-space coordinates:
//   xc = x
//   yc = heightM*cos(tiltRad) - y*sin(tiltRad)
//   zc = y*cos(tiltRad) + heightM*sin(tiltRad)   (depth along the optical axis)
// Then standard pinhole projection with focal length f (in pixels, derived
// from the vertical FOV and the image's native height) maps camera space
// to image pixel coordinates:
//   u = imgWidth/2 + f*xc/zc
//   v = imgHeight/2 + f*yc/zc
// Since a pinhole camera maps straight lines to straight lines, each grid
// line only needs its (possibly clipped) two endpoints projected, not
// sampled point-by-point.
function initFloorGrid(calib) {
  const canvas = document.getElementById("camFloorGrid");
  const img = document.getElementById("camStream");
  // wireOverlayToggle() only ever calls this once actually enabling the
  // overlay (initially on, or the moment it's first switched on) -- display
  // itself is owned entirely by wireOverlayToggle from then on.
  canvas.style.display = "block";
  const ctx = canvas.getContext("2d");

  // Visible window, in camera/robot-relative meters (x = right, y =
  // forward) - world grid lines get clipped to this box before projecting.
  // The near edge is a small positive distance, not exactly 0: forward=0 is
  // the point directly beside the camera (zero depth along the optical
  // axis), a genuine projection singularity (zc=0) whenever tilt is 0 -
  // clipping a line's endpoint to exactly that boundary made project()
  // reject the whole line, which is what was making some lines near the
  // center of the frame vanish.
  const VIEW_MIN_DISTANCE_M = 0.05;
  const VIEW_MAX_DISTANCE_M = 2.0;
  const VIEW_HALF_WIDTH_M = 0.6;

  // Color/opacity/minor-tier-visibility are display preferences (set on
  // the Main page, "Camera page settings"), read once here like the other
  // opt-in overlay settings - not robot calibration, so localStorage
  // rather than a firmware setting. Every floor is a different color, so
  // there's no single "right" default that reads well everywhere.
  const gridRgb = hexToRgb(localStorage.getItem("camGridColor") || "#28ff78");
  const gridOpacityPct = parseFloat(localStorage.getItem("camGridOpacity"));
  const majorOpacity = Number.isFinite(gridOpacityPct) ? gridOpacityPct / 100 : 0.9;
  const rgba = (opacity) => `rgba(${gridRgb.r}, ${gridRgb.g}, ${gridRgb.b}, ${opacity})`;

  const TIERS = [];
  if (localStorage.getItem("camShowMinorGrid") !== "false") {
    // Minor/medium opacity stay proportional to whatever major opacity the
    // user picked, preserving the same minor < medium < major hierarchy at
    // any overall brightness rather than a fixed absolute value.
    TIERS.push({ interval: 0.1, strokeStyle: rgba(majorOpacity * (0.35 / 0.9)), lineWidth: 1 });
  }
  TIERS.push({ interval: 0.5, strokeStyle: rgba(majorOpacity * (0.6 / 0.9)), lineWidth: 1 });
  TIERS.push({ interval: 1.0, strokeStyle: rgba(majorOpacity), lineWidth: 2 });

  let lastPose = { x: 0, y: 0, theta: 0, servoAngleDeg: 0, tiltAngleDeg: 0 };
  // Set from lastPose.tiltAngleDeg at the top of every draw() -- project()
  // reads this instead of calib.tiltRad directly so the live tilt servo
  // angle is folded in on top of the fixed mounting calibration.
  let effectiveTiltRad = calib.tiltRad;

  // World (dx, dy relative to the robot) -> camera-relative (right, forward).
  // Same rotation convention as driveTowardWorldDirection()'s forward/left
  // in control_modes.cpp, with right = -left.
  function worldToRelative(wx, wy, pose) {
    const dx = wx - pose.x;
    const dy = wy - pose.y;
    return {
      right: dx * Math.sin(pose.theta) - dy * Math.cos(pose.theta),
      forward: dx * Math.cos(pose.theta) + dy * Math.sin(pose.theta),
    };
  }

  // Inverse of worldToRelative - used once per redraw to find which world
  // grid lines can possibly fall within the visible camera-relative box.
  function relativeToWorld(right, forward, pose) {
    return {
      x: pose.x + forward * Math.cos(pose.theta) + right * Math.sin(pose.theta),
      y: pose.y + forward * Math.sin(pose.theta) - right * Math.cos(pose.theta),
    };
  }

  // Liang-Barsky: clips segment (x0,y0)-(x1,y1) to the axis-aligned box
  // [xMin,xMax]x[yMin,yMax], returning the clipped segment or null if none
  // of it is visible. Needed because a world-frame grid line (axis-aligned
  // in world space) is generally a TILTED line in camera-relative space
  // once the robot has any heading other than a multiple of 90 deg.
  function clipToBox(x0, y0, x1, y1, xMin, xMax, yMin, yMax) {
    let t0 = 0,
      t1 = 1;
    const dx = x1 - x0,
      dy = y1 - y0;
    const edges = [
      [-dx, x0 - xMin],
      [dx, xMax - x0],
      [-dy, y0 - yMin],
      [dy, yMax - y0],
    ];
    for (const [p, q] of edges) {
      if (p === 0) {
        if (q < 0) return null;
        continue;
      }
      const r = q / p;
      if (p < 0) {
        if (r > t1) return null;
        if (r > t0) t0 = r;
      } else {
        if (r < t0) return null;
        if (r < t1) t1 = r;
      }
    }
    return { x0: x0 + t0 * dx, y0: y0 + t0 * dy, x1: x0 + t1 * dx, y1: y0 + t1 * dy };
  }

  function project(x, y) {
    const zc = y * Math.cos(effectiveTiltRad) + calib.heightM * Math.sin(effectiveTiltRad);
    if (zc <= 0.01) return null; // behind the camera, or grazing along the optical axis
    const yc = calib.heightM * Math.cos(effectiveTiltRad) - y * Math.sin(effectiveTiltRad);
    const imgW = img.naturalWidth;
    const imgH = img.naturalHeight;
    const f = imgH / 2 / Math.tan(calib.vfovRad / 2);
    return {
      u: imgW / 2 + (f * x) / zc,
      v: imgH / 2 + (f * yc) / zc,
    };
  }

  function draw() {
    // The projection's "theta" is the CAMERA's effective world heading, not
    // the chassis's: chassis heading plus whatever the pan servo is
    // currently commanded to (same sign convention the firmware's
    // control-frame auto-follow logic uses - see currentServoAngleDeg in
    // web_server.cpp). Without this, panning the servo (e.g. via "Keep
    // camera facing forward" while rotating the control frame) rotates the
    // camera's actual view without the grid knowing, so it visibly drifts
    // off the real floor instead of staying put. Camera position is still
    // taken as the chassis's own position - the servo only pans, it
    // doesn't relocate the camera. Same idea for tilt: effectiveTiltRad
    // (read by project()) is the fixed mounting calibration PLUS the tilt
    // servo's current live angle, not calib.tiltRad alone.
    if (canvas.style.display === "none") return; // toggled off -- skip the work, not just the visibility
    const robotPose = lastPose;
    const cameraTheta = robotPose.theta + (robotPose.servoAngleDeg * Math.PI) / 180;
    // Subtracted, not added: confirmed on real hardware that pushing the
    // camera joystick "up" (positive tiltAngleDeg) physically rotates the
    // camera upward, i.e. REDUCES its downward pitch from calib.tiltRad.
    effectiveTiltRad = calib.tiltRad - (robotPose.tiltAngleDeg * Math.PI) / 180;
    const pose = { x: robotPose.x, y: robotPose.y, theta: cameraTheta };
    const containerW = canvas.clientWidth;
    const containerH = canvas.clientHeight;
    canvas.width = containerW;
    canvas.height = containerH;
    ctx.clearRect(0, 0, containerW, containerH);

    const imgW = img.naturalWidth;
    const imgH = img.naturalHeight;
    if (!imgW || !imgH) return; // no frame has loaded yet

    // object-fit: contain letterboxing - the actual displayed image occupies
    // a scaled, centered sub-rect of the canvas's full area, not the whole
    // thing, whenever the stream's aspect ratio doesn't match the viewport's.
    const scale = Math.min(containerW / imgW, containerH / imgH);
    const offsetX = (containerW - imgW * scale) / 2;
    const offsetY = (containerH - imgH * scale) / 2;
    const toCanvas = (u, v) => ({ x: offsetX + u * scale, y: offsetY + v * scale });

    const drawRelativeLine = (right0, forward0, right1, forward1) => {
      const clipped = clipToBox(right0, forward0, right1, forward1, -VIEW_HALF_WIDTH_M, VIEW_HALF_WIDTH_M, VIEW_MIN_DISTANCE_M, VIEW_MAX_DISTANCE_M);
      if (!clipped) return;
      const p1 = project(clipped.x0, clipped.y0);
      const p2 = project(clipped.x1, clipped.y1);
      if (!p1 || !p2) return;
      const c1 = toCanvas(p1.u, p1.v);
      const c2 = toCanvas(p2.u, p2.v);
      ctx.beginPath();
      ctx.moveTo(c1.x, c1.y);
      ctx.lineTo(c2.x, c2.y);
      ctx.stroke();
    };

    // World-frame bounding box that contains the visible camera-relative
    // box, from its 4 corners - determines which world grid line indices
    // are worth considering per tier.
    const corners = [
      relativeToWorld(-VIEW_HALF_WIDTH_M, VIEW_MIN_DISTANCE_M, pose),
      relativeToWorld(VIEW_HALF_WIDTH_M, VIEW_MIN_DISTANCE_M, pose),
      relativeToWorld(-VIEW_HALF_WIDTH_M, VIEW_MAX_DISTANCE_M, pose),
      relativeToWorld(VIEW_HALF_WIDTH_M, VIEW_MAX_DISTANCE_M, pose),
    ];
    const worldXMin = Math.min(...corners.map((c) => c.x));
    const worldXMax = Math.max(...corners.map((c) => c.x));
    const worldYMin = Math.min(...corners.map((c) => c.y));
    const worldYMax = Math.max(...corners.map((c) => c.y));

    // Layered minor -> medium -> major, each drawn on top of the last, same
    // idea as the Main map's drawGridTier().
    TIERS.forEach(({ interval, strokeStyle, lineWidth }) => {
      ctx.strokeStyle = strokeStyle;
      ctx.lineWidth = lineWidth;

      const startX = Math.floor(worldXMin / interval) * interval;
      for (let wx = startX; wx <= worldXMax; wx += interval) {
        const a = worldToRelative(wx, worldYMin, pose);
        const b = worldToRelative(wx, worldYMax, pose);
        drawRelativeLine(a.right, a.forward, b.right, b.forward);
      }
      const startY = Math.floor(worldYMin / interval) * interval;
      for (let wy = startY; wy <= worldYMax; wy += interval) {
        const a = worldToRelative(worldXMin, wy, pose);
        const b = worldToRelative(worldXMax, wy, pose);
        drawRelativeLine(a.right, a.forward, b.right, b.forward);
      }
    });
  }

  img.addEventListener("load", draw, { once: true }); // ensures naturalWidth/Height are known
  window.addEventListener("resize", draw);
  subscribeToPose((pose) => {
    lastPose = pose;
    draw();
  });
  draw();
}

// Waypoints now live in robot storage (GET/POST /waypoints, see
// waypoints.hpp/.cpp) instead of localStorage - shared across every
// connected device rather than per-browser, which is what used to make a
// Camera page on a different device than the one waypoints were created on
// only ever show Home. Home itself is still a fixed, always-present point
// never sent to the robot - same convention as app.js's HOME_WAYPOINT,
// duplicated here rather than imported since there's no module system
// between the two pages' scripts.
//
// loadWaypointsForOverlay() is called every draw() frame (up to ~60fps, see
// the pose-interpolation rAF loop above), so it stays a plain synchronous
// read of a background-refreshed cache rather than firing a fetch per
// call - the actual network poll below runs on its own low-frequency
// timer, deliberately not tied to the render rate.
const CAM_HOME_WAYPOINT = Object.freeze({ name: "Home", x: 0, y: 0, isHome: true });
const CAM_WAYPOINTS_POLL_INTERVAL_MS = 5000;
const CAM_WAYPOINTS_POLL_STARTUP_DELAY_MS = 500;

let cachedOverlayWaypoints = [CAM_HOME_WAYPOINT];
let waypointsPollStarted = false;

function startWaypointsPolling() {
  if (waypointsPollStarted) return;
  waypointsPollStarted = true;
  function poll() {
    fetch("/waypoints")
      .then((r) => r.json())
      .then((data) => {
        cachedOverlayWaypoints = [CAM_HOME_WAYPOINT, ...(Array.isArray(data) ? data : [])];
      })
      .catch(() => {}) // keep polling through a transient failure (e.g. brief Wi-Fi hiccup)
      .finally(() => setTimeout(poll, CAM_WAYPOINTS_POLL_INTERVAL_MS));
  }
  // The first call is deliberately delayed rather than firing immediately:
  // this can get triggered synchronously during page setup
  // (initWaypointOverlay's initial draw()), which would otherwise add yet
  // another brand-new connection into the exact same instant as the page's
  // other startup fetches (/params, /shot.jpg, the first /pose poll) - see
  // subscribeToPose()'s comment above on why concentrated connection
  // bursts specifically at page load have been implicated in this robot's
  // intermittent watchdog hangs.
  setTimeout(poll, CAM_WAYPOINTS_POLL_STARTUP_DELAY_MS);
}

function loadWaypointsForOverlay() {
  startWaypointsPolling();
  return cachedOverlayWaypoints;
}

// Waypoint marker overlay: renders each named waypoint as a game-style HUD
// marker over the live camera view, using the same pinhole-camera
// projection as the floor grid (camera-relative coordinates, effective
// heading = chassis heading + pan servo angle - see initFloorGrid()'s own
// comment for the full derivation and why the servo angle matters).
//
// A visible waypoint gets a pin at its projected ground position plus a
// name/distance label, the same idea as a quest marker in an open-world
// game. A waypoint that's off to the side of the frame, or behind the
// camera entirely, gets a small arrow clamped to the nearest screen edge
// and pointing further that way instead - the familiar "offscreen
// objective" indicator from open-world/racing games - rather than just
// vanishing the moment it leaves the frame.
//
// Unlike the floor grid, projection isn't range-limited to a small nearby
// window: a waypoint many meters away is still a perfectly valid pinhole
// projection (it just converges toward the horizon/vanishing point, same
// as any real distant landmark would), so it's shown at its true position
// rather than clipped away.
function initWaypointOverlay(calib) {
  const canvas = document.getElementById("camWaypointOverlay");
  const img = document.getElementById("camStream");
  // wireOverlayToggle() only ever calls this once actually enabling the
  // overlay (initially on, or the moment it's first switched on) -- display
  // itself is owned entirely by wireOverlayToggle from then on.
  canvas.style.display = "block";
  const ctx = canvas.getContext("2d");

  const EDGE_MARGIN_PX = 26; // kept clear along the canvas edge for the arrow + label

  // Each waypoint (when clearly in view) renders as a standing cylinder
  // marker on the floor rather than a flat pin -- roughly the footprint
  // and reach of a real object you'd navigate the robot to. Purely a
  // display convention; doesn't need to match anything physical.
  const CYLINDER_RADIUS_M = 0.10; // 10 cm radius (20 cm diameter)
  const CYLINDER_HEIGHT_M = 0.2; // 20 cm
  const CYLINDER_SEGMENTS = 16; // ring polygon resolution -- smooth enough at this display scale
  const GLOW_BLUR_PX = 32; // canvas shadow blur radius used for the marker's glow halo
  const GLOW_HALO_BLUR_PX = 55; // extra-wide, faint pass drawn first for a stronger, layered glow

  let lastPose = { x: 0, y: 0, theta: 0, servoAngleDeg: 0, tiltAngleDeg: 0 };
  // Set from lastPose.tiltAngleDeg at the top of every draw() -- project()
  // reads this instead of calib.tiltRad directly so the live tilt servo
  // angle (on top of the fixed mounting calibration) is accounted for, same
  // as initFloorGrid()'s own project()/draw() -- see its comment for why.
  let effectiveTiltRad = calib.tiltRad;

  function worldToRelative(wx, wy, pose) {
    const dx = wx - pose.x;
    const dy = wy - pose.y;
    return {
      right: dx * Math.sin(pose.theta) - dy * Math.cos(pose.theta),
      forward: dx * Math.cos(pose.theta) + dy * Math.sin(pose.theta),
    };
  }

  // General pinhole projection for a point at height h above the floor
  // (h=0 is the floor itself, matching the floor grid's projection) --
  // same derivation as initFloorGrid()'s project(), generalized by
  // replacing the fixed camera-to-floor vertical offset (calib.heightM)
  // with camera-to-point (calib.heightM - h), which collapses back to the
  // floor-grid formula exactly when h=0.
  function project(x, y, h) {
    const verticalOffsetM = calib.heightM - h;
    const zc = y * Math.cos(effectiveTiltRad) + verticalOffsetM * Math.sin(effectiveTiltRad);
    const yc = verticalOffsetM * Math.cos(effectiveTiltRad) - y * Math.sin(effectiveTiltRad);
    const imgW = img.naturalWidth;
    const imgH = img.naturalHeight;
    const f = imgH / 2 / Math.tan(calib.vfovRad / 2);
    return { u: imgW / 2 + (f * x) / zc, v: imgH / 2 + (f * yc) / zc, zc };
  }

  // The two vertical edges of a cylinder that are actually visible as its
  // silhouette from a given viewpoint are exactly the two lines tangent to
  // its base circle from the viewpoint's horizontal position -- and since
  // (cx, cy) here are already camera-relative, that viewpoint is the origin,
  // making this a plain 2D circle-tangent-from-external-point problem
  // regardless of the camera's height or tilt.
  function computeTangentPoints(cx, cy, r) {
    const d = Math.hypot(cx, cy);
    if (d <= r) return null; // camera is over/inside the base -- no clean silhouette
    const thetaToCenter = Math.atan2(cy, cx);
    const halfAngle = Math.asin(r / d);
    const tangentLen = Math.sqrt(d * d - r * r);
    return [thetaToCenter + halfAngle, thetaToCenter - halfAngle].map((psi) => ({
      right: tangentLen * Math.cos(psi),
      forward: tangentLen * Math.sin(psi),
    }));
  }

  function computeRing(cx, cy, h) {
    const pts = [];
    for (let i = 0; i < CYLINDER_SEGMENTS; i++) {
      const ang = (i / CYLINDER_SEGMENTS) * Math.PI * 2;
      pts.push(project(cx + CYLINDER_RADIUS_M * Math.cos(ang), cy + CYLINDER_RADIUS_M * Math.sin(ang), h));
    }
    return pts;
  }

  const ringFullyInFront = (pts) => pts.every((p) => p.zc > 0.01);

  function projectToCanvas(x, y, h, toCanvas) {
    const p = project(x, y, h);
    return toCanvas(p.u, p.v);
  }

  function drawLabel(x, y, baseline, wp, distM) {
    const text = `${wp.name} (${distM.toFixed(1)}m)`;
    ctx.font = "bold 12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = baseline;
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.75)";
    ctx.strokeText(text, x, y);
    ctx.fillStyle = "#fff";
    ctx.fillText(text, x, y);
  }

  function drawPin(c, wp, distM) {
    const color = wp.isHome ? "#2c9aff" : "#ffcc00";
    const r = 7;
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = GLOW_BLUR_PX;
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(c.x, c.y - r);
    ctx.lineTo(c.x + r, c.y);
    ctx.lineTo(c.x, c.y + r);
    ctx.lineTo(c.x - r, c.y);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    drawLabel(c.x, c.y - r - 4, "bottom", wp, distM);
  }

  function ringPath(pts, toCanvas) {
    ctx.beginPath();
    pts.forEach((p, i) => {
      const s = toCanvas(p.u, p.v);
      if (i === 0) ctx.moveTo(s.x, s.y);
      else ctx.lineTo(s.x, s.y);
    });
    ctx.closePath();
  }

  // Standing-cylinder marker: a 30cm-diameter, 100cm-tall post rendered on
  // the floor at the waypoint's position, used whenever its base is
  // cleanly in view (see ringFullyInFront()'s callers below). Falls back
  // to the flat pin marker when the robot is too close for a well-defined
  // projection (e.g. sitting right on top of the waypoint after arriving),
  // since the tangent-line/ring math degenerates as the camera nears or
  // enters the base circle.
  function drawCylinder(c, rel, wp, distM, toCanvas) {
    const basePts = computeRing(rel.right, rel.forward, 0);
    const topPts = computeRing(rel.right, rel.forward, CYLINDER_HEIGHT_M);
    if (!ringFullyInFront(basePts) || !ringFullyInFront(topPts)) {
      drawPin(c, wp, distM);
      return;
    }

    const color = wp.isHome ? "#2c9aff" : "#ffcc00";
    const tangents = computeTangentPoints(rel.right, rel.forward, CYLINDER_RADIUS_M);

    // Extra-wide, faint halo pass first (just the top cap, since it's the
    // largest/most central shape) -- layering a bigger, fainter blur under
    // the normal-strength glow reads as noticeably more "lit up" than
    // pushing a single shadowBlur value higher.
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = GLOW_HALO_BLUR_PX;
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.5;
    ringPath(topPts, toCanvas);
    ctx.fill();
    ctx.restore();

    // Scoped to just the shape drawing (not the label below) -- shadowBlur
    // applied to text would blur it into illegibility rather than glow it.
    ctx.save();
    ctx.shadowColor = color;
    ctx.shadowBlur = GLOW_BLUR_PX;
    ctx.fillStyle = color;

    // Side wall: the quad between the two silhouette edges, gives the
    // cylinder a solid-looking body instead of just two floating caps.
    if (tangents) {
      const [t1, t2] = tangents;
      const t1b = projectToCanvas(t1.right, t1.forward, 0, toCanvas);
      const t1t = projectToCanvas(t1.right, t1.forward, CYLINDER_HEIGHT_M, toCanvas);
      const t2b = projectToCanvas(t2.right, t2.forward, 0, toCanvas);
      const t2t = projectToCanvas(t2.right, t2.forward, CYLINDER_HEIGHT_M, toCanvas);
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.moveTo(t1b.x, t1b.y);
      ctx.lineTo(t1t.x, t1t.y);
      ctx.lineTo(t2t.x, t2t.y);
      ctx.lineTo(t2b.x, t2b.y);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // Top cap: solid fill, gives the marker a clear "top" to read at a glance.
    ringPath(topPts, toCanvas);
    ctx.globalAlpha = 0.75;
    ctx.fill();
    ctx.globalAlpha = 1;

    // Base outline only, in the marker's own color -- it's right on the
    // floor and would otherwise just darken the ground under it.
    ringPath(basePts, toCanvas);
    ctx.globalAlpha = 0.4;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = 1;

    ctx.restore();

    const topCenter = projectToCanvas(rel.right, rel.forward, CYLINDER_HEIGHT_M, toCanvas);
    drawLabel(topCenter.x, topCenter.y - 6, "bottom", wp, distM);
  }

  function drawEdgeArrow(x, y, angle, wp, distM, w, h) {
    const color = wp.isHome ? "#2c9aff" : "#ffcc00";
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = color;
    ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(10, 0);
    ctx.lineTo(-6, -7);
    ctx.lineTo(-6, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    // Label stays upright and inset from the edge, rather than rotating
    // with the arrow (which would make it hard to read near the corners).
    const labelX = Math.min(Math.max(x, EDGE_MARGIN_PX + 30), w - EDGE_MARGIN_PX - 30);
    const labelY = Math.min(Math.max(y + 14, 12), h - 4);
    drawLabel(labelX, labelY, "top", wp, distM);
  }

  function draw() {
    // Same "effective camera heading"/"effective tilt" correction as the
    // floor grid - see its own draw()'s comment for why (pan/tilt servo can
    // point the camera somewhere other than straight ahead of the chassis
    // at its calibrated resting tilt).
    if (canvas.style.display === "none") return; // toggled off -- skip the work, not just the visibility
    const robotPose = lastPose;
    const cameraTheta = robotPose.theta + (robotPose.servoAngleDeg * Math.PI) / 180;
    // Subtracted, not added: confirmed on real hardware that pushing the
    // camera joystick "up" (positive tiltAngleDeg) physically rotates the
    // camera upward, i.e. REDUCES its downward pitch from calib.tiltRad.
    effectiveTiltRad = calib.tiltRad - (robotPose.tiltAngleDeg * Math.PI) / 180;
    const pose = { x: robotPose.x, y: robotPose.y, theta: cameraTheta };

    const containerW = canvas.clientWidth;
    const containerH = canvas.clientHeight;
    canvas.width = containerW;
    canvas.height = containerH;
    ctx.clearRect(0, 0, containerW, containerH);

    const imgW = img.naturalWidth;
    const imgH = img.naturalHeight;
    if (!imgW || !imgH) return;

    const scale = Math.min(containerW / imgW, containerH / imgH);
    const offsetX = (containerW - imgW * scale) / 2;
    const offsetY = (containerH - imgH * scale) / 2;
    const toCanvas = (u, v) => ({ x: offsetX + u * scale, y: offsetY + v * scale });

    const cx = containerW / 2;
    const cy = containerH / 2;

    loadWaypointsForOverlay().forEach((wp) => {
      const rel = worldToRelative(wp.x, wp.y, pose);
      const distM = Math.hypot(rel.right, rel.forward);
      const p = project(rel.right, rel.forward, 0);
      const inFront = p.zc > 0.01;
      const c = inFront ? toCanvas(p.u, p.v) : null;

      if (c && c.x >= 0 && c.x <= containerW && c.y >= 0 && c.y <= containerH) {
        drawCylinder(c, rel, wp, distM, toCanvas);
        return;
      }

      // Off-screen: clamp a ray from the screen center toward the
      // waypoint's screen-space direction (in front of the camera, just
      // outside the frame) or its world-relative right/left side (behind
      // the camera, where u/v aren't meaningful) to the canvas edge.
      const dirX = c ? c.x - cx : rel.right;
      const dirY = c ? c.y - cy : -1; // slight upward bias so a directly-behind waypoint doesn't sit exactly on the vertical center
      if (dirX === 0 && dirY === 0) return;
      const halfW = containerW / 2 - EDGE_MARGIN_PX;
      const halfH = containerH / 2 - EDGE_MARGIN_PX;
      const s = Math.min(dirX !== 0 ? Math.abs(halfW / dirX) : Infinity, dirY !== 0 ? Math.abs(halfH / dirY) : Infinity);
      drawEdgeArrow(cx + dirX * s, cy + dirY * s, Math.atan2(dirY, dirX), wp, distM, containerW, containerH);
    });
  }

  img.addEventListener("load", draw, { once: true });
  window.addEventListener("resize", draw);
  subscribeToPose((pose) => {
    lastPose = pose;
    draw();
  });
  draw();
}

// --- Touch drive/look controls (touchscreen devices only) -----------------
//
// Two floating joysticks over the camera view, following the standard
// mobile FPS control convention (PUBG Mobile, COD Mobile, etc.): the left
// half of the screen drives/strafes (mirrors the Main page's control-frame
// joystick -- an omnidirectional analog stick, not tank-style
// forward+turn), the right half pans/tilts the camera (mirrors the Main
// page's camera control joystick -- a rate control on both axes that
// springs back to center on release). Both are "floating": invisible until
// the user actually touches down, then centered on that exact point,
// rather than a small fixed target the thumb has to hunt for -- and both
// track their own touch by identifier, so driving and looking work
// simultaneously with two thumbs.
//
// This needs its own live WebSocket connection to send these commands,
// unlike the rest of this page (deliberately HTTP-polling-only for pose --
// see subscribeToPose()'s comment above for why a second persistent WS
// connection was previously implicated in a hard-to-reproduce firmware
// hang). That hang's root cause (Mongoose + the Pico W's CYW43 WiFi
// driver) doesn't exist in this ESP32-S3 port -- esp_http_server has
// already run fine with several simultaneous WS clients in normal use
// (Main page and Camera page open at once) -- so a second connection here
// is safe on this hardware/firmware, unlike on the original Pico build.
function setupCamTouchControls() {
  const container = document.querySelector(".cam-fullscreen");
  container.classList.add("cam-touch-controls-active");

  const leftBase = document.getElementById("camLeftJoystickBase");
  const leftKnob = document.getElementById("camLeftJoystickKnob");
  const rightBase = document.getElementById("camRightJoystickBase");
  const rightKnob = document.getElementById("camRightJoystickKnob");

  const MAX_DISTANCE = 70; // matches the floating base's 140px diameter / 2, see style.css
  const SEND_INTERVAL_MS = 40; // ~25 Hz, matches the Main page's joysticks
  const HEARTBEAT_INTERVAL_MS = 200; // resends the current command while held still -- see the Main page's setupJoystick() for why

  // -- WS connection: minimal reconnecting socket, send-only in practice.
  // It still receives the normal "pose"/etc. broadcasts every connected
  // client gets, which doubles as a free liveness signal (content unused --
  // this page already has pose via HTTP polling) for the same staleness
  // watchdog approach app.js uses for the Main page's connection.
  let ws = null;
  let wsLastMessageAtMs = 0;
  let wsConnectStartedAtMs = 0;
  let wsReconnectTimer = null;

  function connectWs() {
    ws = new WebSocket(`ws://${location.host}/ws`);
    wsConnectStartedAtMs = Date.now();
    ws.onopen = () => {
      wsLastMessageAtMs = Date.now();
    };
    ws.onmessage = () => {
      wsLastMessageAtMs = Date.now();
    };
    ws.onclose = () => {
      clearTimeout(wsReconnectTimer);
      wsReconnectTimer = setTimeout(connectWs, 250);
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch (e) {
        // ignore -- onclose above handles the retry regardless
      }
    };
  }

  function forceReconnect() {
    clearTimeout(wsReconnectTimer);
    if (ws) {
      const dead = ws;
      ws = null;
      dead.onopen = dead.onclose = dead.onerror = dead.onmessage = null;
      try {
        dead.close();
      } catch (e) {
        // ignore -- discarding this socket regardless
      }
    }
    connectWs();
  }

  connectWs();
  setInterval(() => {
    if (!ws) return;
    const now = Date.now();
    if (ws.readyState === WebSocket.CONNECTING && now - wsConnectStartedAtMs > 3000) {
      forceReconnect();
    } else if (ws.readyState === WebSocket.OPEN && now - wsLastMessageAtMs > 1000) {
      forceReconnect();
    }
  }, 300);

  function sendWs(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  function localXY(touch, rect) {
    return { x: touch.clientX - rect.left, y: touch.clientY - rect.top };
  }

  // -- left: drive/strafe, mirrors the Main page's control-frame joystick
  // (setupJoystick() over "control_joystick") exactly -- same j1/j2
  // mapping, same throttle/heartbeat pattern, reset to (0,0) on release.
  let leftTouchId = null;
  let leftAnchor = { x: 0, y: 0 };
  let leftLastSendMs = 0;
  let leftJ1 = 0;
  let leftJ2 = 0;
  let leftHeartbeatTimer = null;

  function sendLeft(j1, j2) {
    leftJ1 = j1;
    leftJ2 = j2;
    const now = Date.now();
    if (now - leftLastSendMs >= SEND_INTERVAL_MS || (j1 === 0 && j2 === 0)) {
      leftLastSendMs = now;
      sendWs({ type: "control_joystick", j1, j2 });
    }
  }

  function startLeftHeartbeat() {
    stopLeftHeartbeat();
    leftHeartbeatTimer = setInterval(() => {
      sendWs({ type: "control_joystick", j1: leftJ1, j2: leftJ2 });
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopLeftHeartbeat() {
    if (leftHeartbeatTimer !== null) {
      clearInterval(leftHeartbeatTimer);
      leftHeartbeatTimer = null;
    }
  }

  function updateLeft(x, y) {
    const dx = Math.max(-MAX_DISTANCE, Math.min(MAX_DISTANCE, x - leftAnchor.x));
    const dy = Math.max(-MAX_DISTANCE, Math.min(MAX_DISTANCE, y - leftAnchor.y));
    leftKnob.style.left = `${MAX_DISTANCE + dx}px`;
    leftKnob.style.top = `${MAX_DISTANCE + dy}px`;
    sendLeft(dx / MAX_DISTANCE, -dy / MAX_DISTANCE);
  }

  function releaseLeft() {
    leftTouchId = null;
    leftBase.style.display = "none";
    stopLeftHeartbeat();
    sendLeft(0, 0);
  }

  // -- right: camera pan/tilt, mirrors the Main page's camera control
  // joystick (setupCameraJoystick() over "control_frame_rotate"/
  // "tilt_rate") exactly -- both axes are rate controls, curve and speed
  // scaling applied server-side, both reset to 0 on release (the camera
  // stops moving but doesn't snap back, same as letting go of a game
  // controller's look stick).
  let rightTouchId = null;
  let rightAnchor = { x: 0, y: 0 };
  let rightLastSendMs = 0;
  let rightRotateValue = 0;
  let rightTiltValue = 0;
  let rightHeartbeatTimer = null;

  function sendRight(rotateValue, tiltValue) {
    rightRotateValue = rotateValue;
    rightTiltValue = tiltValue;
    const now = Date.now();
    if (now - rightLastSendMs >= SEND_INTERVAL_MS || (rotateValue === 0 && tiltValue === 0)) {
      rightLastSendMs = now;
      sendWs({ type: "control_frame_rotate", value: rotateValue });
      sendWs({ type: "tilt_rate", value: tiltValue });
    }
  }

  function startRightHeartbeat() {
    stopRightHeartbeat();
    rightHeartbeatTimer = setInterval(() => {
      sendWs({ type: "control_frame_rotate", value: rightRotateValue });
      sendWs({ type: "tilt_rate", value: rightTiltValue });
    }, HEARTBEAT_INTERVAL_MS);
  }

  function stopRightHeartbeat() {
    if (rightHeartbeatTimer !== null) {
      clearInterval(rightHeartbeatTimer);
      rightHeartbeatTimer = null;
    }
  }

  function updateRight(x, y) {
    const dx = Math.max(-MAX_DISTANCE, Math.min(MAX_DISTANCE, x - rightAnchor.x));
    const dy = Math.max(-MAX_DISTANCE, Math.min(MAX_DISTANCE, y - rightAnchor.y));
    rightKnob.style.left = `${MAX_DISTANCE + dx}px`;
    rightKnob.style.top = `${MAX_DISTANCE + dy}px`;
    sendRight(-dx / MAX_DISTANCE, -dy / MAX_DISTANCE);
  }

  function releaseRight() {
    rightTouchId = null;
    rightBase.style.display = "none";
    stopRightHeartbeat();
    sendRight(0, 0);
  }

  // -- shared multi-touch dispatch: each new touch claims whichever zone
  // (left/right half of the container) it landed in, as long as that zone
  // isn't already claimed by another active touch -- so both thumbs work
  // independently and a third touch (or a second touch in an
  // already-claimed zone) is simply ignored.
  container.addEventListener("touchstart", (e) => {
    // Let the menu panels (toggle + whatever buttons are inside them, now
    // or added later) and standalone overlay buttons (e.g. Fireball) handle
    // their own taps untouched -- don't claim a touch that landed on one.
    if (e.target.closest(".cam-menu-panel, .cam-overlay-btn")) return;
    // Matches the .cam-rotate-prompt media query exactly: while it's
    // showing (portrait, touch device), the joysticks stay disabled rather
    // than popping up half-usable underneath the prompt.
    if (window.matchMedia("(orientation: portrait) and (hover: none) and (pointer: coarse)").matches) return;
    e.preventDefault();

    const rect = container.getBoundingClientRect();
    for (const touch of e.changedTouches) {
      const p = localXY(touch, rect);
      const isLeftHalf = p.x < rect.width / 2;
      if (isLeftHalf && leftTouchId === null) {
        leftTouchId = touch.identifier;
        leftAnchor = p;
        leftBase.style.left = `${p.x}px`;
        leftBase.style.top = `${p.y}px`;
        leftBase.style.display = "block";
        updateLeft(p.x, p.y);
        startLeftHeartbeat();
      } else if (!isLeftHalf && rightTouchId === null) {
        rightTouchId = touch.identifier;
        rightAnchor = p;
        rightBase.style.left = `${p.x}px`;
        rightBase.style.top = `${p.y}px`;
        rightBase.style.display = "block";
        updateRight(p.x, p.y);
        startRightHeartbeat();
      }
    }
  }, { passive: false });

  container.addEventListener("touchmove", (e) => {
    e.preventDefault();
    const rect = container.getBoundingClientRect();
    for (const touch of e.changedTouches) {
      if (touch.identifier === leftTouchId) {
        const p = localXY(touch, rect);
        updateLeft(p.x, p.y);
      } else if (touch.identifier === rightTouchId) {
        const p = localXY(touch, rect);
        updateRight(p.x, p.y);
      }
    }
  }, { passive: false });

  function handleTouchEnd(e) {
    for (const touch of e.changedTouches) {
      if (touch.identifier === leftTouchId) {
        releaseLeft();
      } else if (touch.identifier === rightTouchId) {
        releaseRight();
      }
    }
  }
  container.addEventListener("touchend", handleTouchEnd);
  container.addEventListener("touchcancel", handleTouchEnd);
}
