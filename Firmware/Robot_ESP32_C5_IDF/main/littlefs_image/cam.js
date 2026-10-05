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
    // Going fullscreen is for the view, so fold the Menu and Overlays
    // panels away (each is still one tap to reopen).
    if (document.fullscreenElement) {
      document.querySelectorAll(".cam-menu-panel").forEach((panel) => (panel.open = false));
    }
  });

  document.getElementById("camReloadBtn").addEventListener("click", () => location.reload());

  // Moves the world origin (home) to where the robot is now, with +X along
  // the camera's current viewing direction (/set?reset_home -- nothing
  // physically turns), and stops the robot. Tap
  // twice to confirm (a confirm() dialog can knock the page out of
  // fullscreen), since waypoints and game layouts are relative to home.
  const setHomeBtn = document.getElementById("camSetHomeBtn");
  const SET_HOME_LABEL = setHomeBtn.textContent;
  let setHomeArmedTimer = null;
  setHomeBtn.addEventListener("click", () => {
    if (!setHomeArmedTimer) {
      setHomeBtn.textContent = "Tap again to confirm";
      setHomeBtn.classList.add("cam-btn-armed");
      setHomeArmedTimer = setTimeout(disarmSetHome, 3000);
      return;
    }
    disarmSetHome();
    fetch("/set?reset_home=1")
      .then((r) => {
        if (!r.ok) throw new Error(r.status);
        setHomeBtn.textContent = "Home set ✓";
        setTimeout(() => (setHomeBtn.textContent = SET_HOME_LABEL), 1500);
      })
      .catch(() => (document.getElementById("cam-status").textContent = "Couldn't set home -- is the robot reachable?"));
  });
  function disarmSetHome() {
    clearTimeout(setHomeArmedTimer);
    setHomeArmedTimer = null;
    setHomeBtn.textContent = SET_HOME_LABEL;
    setHomeBtn.classList.remove("cam-btn-armed");
  }

  // Overlays panel: same toggles as the Main page's "Camera page
  // settings" panel (camShowMapOverlay/camShowFloorGrid/camShowWorldAxes/
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
  function wireOverlayToggle(toggleId, storageKey, canvasId, ensureInitialized, defaultOn = false) {
    const toggle = document.getElementById(toggleId);
    const canvas = document.getElementById(canvasId);
    const stored = localStorage.getItem(storageKey);
    const initiallyOn = stored === null ? defaultOn : stored === "true";
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

  // Deadline + no overlap: requests that hang across a robot reboot would
  // otherwise pile up one per tick until they hold all 6 of the browser's
  // connections to the robot, after which nothing on this page (not even
  // navigating away) could reach it any more -- see fetchWithTimeout().
  let camHeartbeatInFlight = false;
  function pollCamHeartbeat() {
    if (camHeartbeatInFlight) return;
    camHeartbeatInFlight = true;
    fetchWithTimeout("/camdiag", 3000)
      .then((d) => {
        const reachable = !d.stale && d.ip && d.ip !== "0.0.0.0";
        if (reachable && (!wasReachable || d.ip !== currentCamIp)) {
          connectStream(d.ip);
        } else if (!reachable) {
          status.textContent = "Camera unreachable, waiting...";
        }
        wasReachable = reachable;
      })
      .catch(() => {}) // transient fetch failure -- next tick retries
      .finally(() => (camHeartbeatInFlight = false));
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
  // Retried until it succeeds (e.g. page opened while the robot is still
  // rebooting), so the overlays start by themselves once it's back.
  const CALIB_RETRY_MS = 2000;
  // The per-resolution lens calibration (/appdata/camcal, see Lynx.lens) is
  // optional: without it the overlays use a pinhole with cameraVerticalFovDeg.
  const loadCalib = () =>
    fetchWithTimeout("/params", 5000)
      .then((data) =>
        fetchWithTimeout("/appdata/camcal", 5000)
          .catch(() => null)
          .then((camcal) => {
            Lynx.lens.setCalibration(camcal, data.cameraVerticalFovDeg);
            return {
              heightM: data.cameraHeightMm / 1000,
              tiltRad: (data.cameraTiltDeg * Math.PI) / 180,
              vfovRad: (data.cameraVerticalFovDeg * Math.PI) / 180, // fallback only -- projection goes through Lynx.lens
              // how the robot turns camera input into angles (see stepAim())
              aim: typeof data.panMaxSpeedDegPerSec !== "number" ? null : {
                panRateDeg: data.panMaxSpeedDegPerSec,
                tiltRateDeg: data.tiltMaxSpeedDegPerSec,
                tiltMinDeg: data.tiltMinAngleDeg,
                tiltMaxDeg: data.tiltMaxAngleDeg,
                quadratic: data.cameraJoystickCurve === 1,
                servoFollows: data.servoFollowControlFrame !== false,
              },
            };
          })
      )
      .catch(() => {
        document.getElementById("cam-status").textContent = "Unable to load camera settings from the robot -- retrying...";
        return new Promise((resolve) => setTimeout(resolve, CALIB_RETRY_MS)).then(loadCalib);
      });
  const calibPromise = loadCalib().then((calib) => {
    const status = document.getElementById("cam-status");
    if (status.textContent.startsWith("Unable to load camera settings")) status.textContent = "";
    return calib;
  });

  let floorGridInitialized = false;
  wireOverlayToggle("camToggleFloorGrid", "camShowFloorGrid", "camFloorGrid", () => {
    if (floorGridInitialized) return;
    floorGridInitialized = true;
    calibPromise.then((calib) => {
      if (calib) initFloorGrid(calib);
    });
  });

  // World coordinate frame (X red, Y green, 1 m ticks) -- on by default.
  let worldAxesInitialized = false;
  wireOverlayToggle("camToggleWorldAxes", "camShowWorldAxes", "camAxesOverlay", () => {
    if (worldAxesInitialized) return;
    worldAxesInitialized = true;
    calibPromise.then((calib) => {
      if (calib) initFloorGrid(calib, { canvasId: "camAxesOverlay", grid: false, axes: true });
    });
  }, true);

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

  // Detection needs to read pixels back from the stream, which a
  // cross-origin <img> only allows in crossorigin mode (the camera sends the
  // matching CORS header). Off by default so an older camera firmware
  // without that header still shows a picture.
  Lynx.cam = {
    // fn(nowMs) -> {yaw (rad, odometry frame), tiltDeg} or null: where the
    // camera should point, each frame (null = back to the player's input).
    // Only with absolute aim (Lynx.control.absoluteAim()); without it a game
    // has to send "aim" itself.
    setAimOverride(fn) {
      aimOverride = fn;
    },
    // A game's own entries in the panels (it removes them when it ends, e.g.
    // el.remove() in ar.onDestroy): a button in the Menu panel, and an
    // on/off switch in the Overlays panel.
    addMenuButton(text, onClick) {
      const b = document.createElement("button");
      b.className = "cam-overlay-btn";
      b.textContent = text;
      b.addEventListener("click", () => {
        b.blur();
        onClick();
      });
      document.querySelector("#camMenuPanel .cam-menu-panel-body").insertBefore(b, document.getElementById("gamepadStatus"));
      return b;
    },
    addOverlayToggle(text, checked, onChange) {
      const label = document.createElement("label");
      label.className = "cam-toggle-switch";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!checked;
      input.addEventListener("change", () => {
        input.blur();
        onChange(input.checked);
      });
      const slider = document.createElement("span");
      slider.className = "cam-toggle-slider";
      label.append(input, slider, document.createTextNode(` ${text}`));
      document.querySelector("#camOverlaysPanel .cam-menu-panel-body").insertBefore(label, document.getElementById("camSetHomeBtn"));
      return label;
    },
    enableCors() {
      if (img.crossOrigin === "anonymous") return;
      img.crossOrigin = "anonymous";
      if (currentCamIp) connectStream(currentCamIp);
    },
  };

  // -- Games & apps (see games.html / lynx_common.js) ---------------------------
  Lynx.enableKeyboardControls();

  // Gamepad status line in the Menu panel, plus a brief toast when a pad
  // (dis)connects -- the panel is usually collapsed while playing.
  const gamepadStatus = document.getElementById("gamepadStatus");
  let lastPadState = Lynx.gamepad.state;
  const renderGamepad = (gp) => {
    const name = gp.id.split(" (")[0] || "Gamepad";
    if (gp.state === "unsupported") gamepadStatus.textContent = "\u{1F3AE} This browser doesn't support gamepads";
    else if (gp.state === "connected") gamepadStatus.textContent = `\u{1F3AE} ${name} connected`;
    else if (gp.insecure) gamepadStatus.textContent = "\u{1F3AE} Gamepad: press a button on it. Nothing? See Games & apps settings.";
    else gamepadStatus.textContent = "\u{1F3AE} Gamepad: press a button on it";
    if (gp.state !== lastPadState && gp.state !== "unsupported") {
      showToast(gp.state === "connected" ? `\u{1F3AE} ${name} connected` : "\u{1F3AE} Gamepad disconnected");
    }
    lastPadState = gp.state;
  };
  Lynx.gamepad.onChange = renderGamepad;
  renderGamepad(Lynx.gamepad);

  let toastTimer = null;
  function showToast(text) {
    let toast = document.querySelector(".cam-toast");
    if (!toast) {
      toast = document.createElement("div");
      toast.className = "cam-toast";
      document.querySelector(".cam-fullscreen").appendChild(toast);
    }
    toast.textContent = text;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 2500);
  }

  // The action button: press = one fire/action, hold = automatic fire.
  const actionBtn = document.getElementById("camFireballBtn");
  const releaseAction = () => (Lynx.input.fireHeld = false);
  actionBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    Lynx.sfx.unlock();
    Lynx.input.fireHeld = true;
    Lynx.fireAction();
  });
  ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => actionBtn.addEventListener(ev, releaseAction));

  // Mouse users: clicking the picture fires too (while a game is running).
  document.querySelector(".cam-fullscreen").addEventListener("mousedown", (e) => {
    if (gameMode === "none") return;
    if (e.button !== 0 || e.target.closest(".cam-menu-panel, .cam-overlay-btn, .game-touch-ui")) return;
    Lynx.sfx.unlock();
    Lynx.input.fireHeld = true;
    Lynx.fireAction();
  });
  window.addEventListener("mouseup", releaseAction);

  let currentAr = null; // the running game_*.js game's AR engine, for teardown

  function stopActive() {
    Lynx.clearActions();
    Lynx.input.fireHeld = false;
    if (currentAr) currentAr.destroy();
    currentAr = null;
    Lynx.activeGame = null;
    if (gameMode === "monster_hunt") {
      activeFireballs = [];
      monsters = [];
      monsterUpdateLastMs = null;
    }
    gameMode = "none";
    actionBtn.style.display = "none";
  }

  // Starts app.active. Also used to switch games in-page (no reload), which
  // keeps the browser in fullscreen -- a reloaded page can't re-enter it
  // without another tap.
  function startActive(calib, app) {
    stopActive();
    // the robot drive mode and the cube detection are Free-drive things (games drive and aim themselves)
    Lynx.control.setRobotModeAllowed(app.active === "none");
    Lynx.freeDriveTags.setActive(app.active === "none");
    if (!calib || app.active === "none") return;

    // Declutter: a game wants the view, not the menus (still one tap away).
    document.querySelectorAll(".cam-menu-panel").forEach((panel) => (panel.open = false));

    if (app.active === "monster_hunt") {
      const m = app.monster_hunt;
      fireballSpeedMps = m.fireballSpeedMps;
      monsterSpeedMps = m.monsterSpeedMps;
      monsterCount = m.monsterCount;
      monsterLegDistanceM = m.monsterLegDistanceM;
      fireballLifetimeMs = ((FIREBALL_MAX_RANGE_M - FIREBALL_START_DISTANCE_M) / fireballSpeedMps) * 1000;
      gameMode = "monster_hunt";
      actionBtn.textContent = "\u{1F525} Fireball";
      actionBtn.style.display = "block";
      Lynx.onAction("fire", () => spawnFireball(calib));
      // Monsters are ambient -- they wander whether or not anyone's fired
      // yet -- so this starts right away, not on the first button press.
      ensureFireballOverlayInitialized(calib);
      return;
    }

    const startGame = Lynx.games[app.active];
    if (!startGame) return;
    gameMode = app.active;
    currentAr = Lynx.createAr(calib);
    const game = startGame(currentAr, app[app.active], app) || {};
    Lynx.activeGame = game; // e.g. Lynx.activeGame.snapshot() from the console
    if (game.actionLabel) {
      actionBtn.textContent = game.actionLabel;
      actionBtn.style.display = "block";
    }
  }

  Promise.all([calibPromise, Lynx.loadAppSettings()]).then(([calib, app]) => {
    aimParams = calib.aim && calib.aim.servoFollows ? calib.aim : null;
    if (calib.aim) Lynx.control.setRobotCamRates(calib.aim.panRateDeg, calib.aim.tiltRateDeg);
    // The overlays and games point where the page aims (see withAim()),
    // unless "Smooth aim" is off -- then the servos' measured angles.
    aimView = app.general.smoothAim !== false;
    // Absolute aim runs in the pose loop, so keep that going even with no
    // overlay or game listening (with the socket up it adds no requests).
    if (aimParams) subscribeToPose(() => {});
    Lynx.sfx.volume = app.general.volume;
    setupModeSelect(calib, app);
    setupDriveModeButton();
    Lynx.freeDriveTags.setup(calib, app);
    startActive(calib, app);
  });

  // Gamepad stick readout (Menu panel): the raw axes as the browser reports
  // them -- before any dead zone -- plus each axis's largest value since it
  // was opened and the sticks' radius, to see where the controller itself
  // stops (an outer dead zone: full scale before the stick's physical edge).
  (function setupStickReadout() {
    const btn = document.getElementById("camStickReadoutBtn");
    const box = document.createElement("div");
    box.style.cssText = "position:absolute;left:12px;bottom:12px;z-index:30;padding:8px 10px;border-radius:8px;background:rgba(0,0,0,0.7);color:#e8f4ff;font:13px/1.45 ui-monospace,Consolas,monospace;white-space:pre;pointer-events:none;display:none";
    document.querySelector(".cam-fullscreen").appendChild(box);
    let timer = null;
    let peak = [0, 0, 0, 0];
    const f = (v) => (v >= 0 ? " " : "") + v.toFixed(3);
    const render = () => {
      const a = Lynx.gamepad.rawAxes || [];
      if (!a.length) {
        box.textContent = "No gamepad yet -- press a button on it";
        return;
      }
      for (let i = 0; i < 4; i++) peak[i] = Math.max(peak[i], Math.abs(a[i] || 0));
      const r = (i) => Math.hypot(a[i] || 0, a[i + 1] || 0);
      box.textContent =
        `           x       y      radius\n` +
        `left   ${f(a[0] || 0)}  ${f(a[1] || 0)}   ${r(0).toFixed(3)}\n` +
        `right  ${f(a[2] || 0)}  ${f(a[3] || 0)}   ${r(2).toFixed(3)}\n` +
        `peak L ${peak[0].toFixed(3)}   ${peak[1].toFixed(3)}\n` +
        `peak R ${peak[2].toFixed(3)}   ${peak[3].toFixed(3)}`;
    };
    btn.addEventListener("click", () => {
      btn.blur();
      if (timer) {
        clearInterval(timer);
        timer = null;
        box.style.display = "none";
        return;
      }
      peak = [0, 0, 0, 0];
      box.style.display = "block";
      render();
      timer = setInterval(render, 50);
    });
  })();

  // Free drive's drive mode switch (also M / gamepad Back): the default
  // (camera frame) or the robot mode (chassis frame, see controls.js).
  function setupDriveModeButton() {
    const btn = document.getElementById("camDriveModeBtn");
    let shown = Lynx.control.driveMode();
    const render = (mode) => {
      const allowed = Lynx.control.robotModeAllowed();
      btn.style.display = allowed ? "" : "none";
      btn.textContent = mode === "robot" ? "\u{1F697} Drive: robot frame" : "\u{1F3A5} Drive: camera frame";
      if (mode !== shown && allowed) {
        showToast(mode === "robot" ? "\u{1F697} Robot frame: left stick drives and turns, right stick points the camera" : "\u{1F3A5} Camera frame: the default drive mode");
      }
      shown = mode;
    };
    btn.addEventListener("click", () => {
      Lynx.control.toggleDriveMode();
      btn.blur();
    });
    Lynx.control.onDriveModeChange(render);
    render(shown);
  }

  // Quick switch between games/apps from the Menu panel: saved robot-side
  // like everything on the Games & apps page, and swapped in place.
  function setupModeSelect(calib, app) {
    const select = document.getElementById("camModeSelect");
    Lynx.CATALOG.forEach((e) => {
      const opt = document.createElement("option");
      opt.value = e.id;
      opt.textContent = `${e.icon} ${e.name}`;
      select.appendChild(opt);
    });
    select.value = app.active;
    select.addEventListener("change", () => {
      app.active = select.value;
      startActive(calib, app);
      select.blur(); // so Space/arrow keys go to the game, not the dropdown
      Lynx.saveAppSettings(app)
        .catch(() => (document.getElementById("cam-status").textContent = "Couldn't save the game choice -- is the robot reachable?"));
    });
  }
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
// fireballSpeedMps/monsterSpeedMps/monsterCount/monsterLegDistanceM are
// configurable on the Games & apps page (stored robot-side in the
// /appdata/settings document) -- set in DOMContentLoaded above, with these
// as fallback defaults. The rest stay internal tuning constants.
let gameMode = "none"; // "none", "monster_hunt" (below), or the id of a running game_*.js / detect.js game
let aimView = true; // the general "Smooth aim" setting (see withAim())
let aimParams = null; // calib.aim once loaded, if the pan servo follows the control frame (absolute aim, see stepAim())
let aimOverride = null; // a game pointing the camera itself (Lynx.cam.setAimOverride)
let fireballSpeedMps = 0.5;
const FIREBALL_RADIUS_M = 0.08;
const FIREBALL_START_DISTANCE_M = 0.2; // launched a short distance out, not exactly at the camera (a projection singularity)
const FIREBALL_MAX_RANGE_M = 5; // straight-line distance travelled (from launch, not FIREBALL_START_DISTANCE_M) before it fades out
let fireballLifetimeMs = ((FIREBALL_MAX_RANGE_M - FIREBALL_START_DISTANCE_M) / fireballSpeedMps) * 1000; // recomputed once fireballSpeedMps loads from /params
const FIREBALL_FADE_FRACTION = 0.8; // fraction of its lifetime before it starts fading out

// Monsters roam in straight-line "legs": each pick a heading (mostly
// random, lightly biased toward the robot's current position), walk it for
// monsterLegDistanceM, then pick a fresh heading -- rather than continuously
// re-aiming at the player, which just parks them in front of the camera.
// Respawns a short distance away whenever a fireball connects.
let monsterCount = 2;
let monsterSpeedMps = 0.1;
const MONSTER_RADIUS_M = 0.15;
const MONSTER_SPAWN_MIN_DISTANCE_M = 2;
const MONSTER_SPAWN_MAX_DISTANCE_M = 3;
const MONSTER_DIRECTION_BIAS = 0.3; // 0 = pure random heading, 1 = always exactly toward the player; kept low for "slightly favouring"
let monsterLegDistanceM = 1.0; // distance walked on one chosen heading before a new one is picked
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
let monsters = []; // {x, y, headingRad, legDistanceRemainingM, state: "alive"|"dead", diedAtMs}
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
    // Through the calibrated lens model (Lynx.lens). s = local pixels per
    // unit of x/z there, for sizing things at that depth.
    const p = Lynx.lens.project(x, yc, zc, img.naturalWidth, img.naturalHeight);
    return p ? { u: p.u, v: p.v, zc, s: p.scale } : { u: NaN, v: NaN, zc, s: 0 };
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
      // legDistanceRemainingM starts at 0 so the very first update tick
      // immediately picks a real (player-biased) heading instead of walking
      // this throwaway spawn-time angle for a full leg.
      monsters.push({ x: pos.x, y: pos.y, headingRad: 0, legDistanceRemainingM: 0, state: "alive", diedAtMs: 0 });
    }
  }

  // Each monster walks in a straight line ("leg") for monsterLegDistanceM,
  // then picks a fresh heading and starts a new leg -- rather than
  // continuously re-aiming at the player, which just parks it in front of
  // the camera indefinitely. The new heading blends a straight line toward
  // the robot's current position with a uniformly random direction (as unit
  // vectors, not by averaging angles directly, which has a wraparound bug
  // whenever they're on opposite sides of +-180deg), weighted by
  // MONSTER_DIRECTION_BIAS so it only *slightly* favours the player. A dead
  // monster is skipped entirely here (stays exactly where it died) until
  // MONSTER_DEATH_LINGER_MS removes it, at which point the count top-up
  // below spawns its replacement.
  function updateMonsters(pose, nowMs) {
    monsters = monsters.filter((m) => m.state !== "dead" || nowMs - m.diedAtMs < MONSTER_DEATH_LINGER_MS);
    ensureMonstersSpawned(pose.x, pose.y);
    if (monsterUpdateLastMs === null) {
      monsterUpdateLastMs = nowMs;
      return;
    }
    const dtS = Math.min((nowMs - monsterUpdateLastMs) / 1000, MONSTER_UPDATE_MAX_DT_S);
    monsterUpdateLastMs = nowMs;

    monsters.forEach((m) => {
      if (m.state === "dead") return;

      if (m.legDistanceRemainingM <= 0) {
        const towardPlayerRad = Math.atan2(pose.y - m.y, pose.x - m.x);
        const randomRad = Math.random() * 2 * Math.PI;
        const vx = MONSTER_DIRECTION_BIAS * Math.cos(towardPlayerRad) + (1 - MONSTER_DIRECTION_BIAS) * Math.cos(randomRad);
        const vy = MONSTER_DIRECTION_BIAS * Math.sin(towardPlayerRad) + (1 - MONSTER_DIRECTION_BIAS) * Math.sin(randomRad);
        m.headingRad = Math.atan2(vy, vx);
        m.legDistanceRemainingM = monsterLegDistanceM;
      }

      const stepM = Math.min(monsterSpeedMps * dtS, m.legDistanceRemainingM);
      m.x += stepM * Math.cos(m.headingRad);
      m.y += stepM * Math.sin(m.headingRad);
      m.legDistanceRemainingM -= stepM;
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
    if (gameMode !== "monster_hunt") {
      // Switched to another game in-page: stay subscribed but idle.
      if (canvas.width) canvas.width = 0;
      return;
    }
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
      const radiusPx = Math.max(((p.s * FIREBALL_RADIUS_M) / Math.max(p.zc, 0.05)) * scale, 0.01);

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
      const bodyRadiusPx = Math.max(((bodyP.s * MONSTER_RADIUS_M) / Math.max(bodyP.zc, 0.05)) * scale, 0.01);
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
// fetch() with a deadline. A request in flight while the robot reboots
// (e.g. a firmware/filesystem OTA) can hang forever -- no reply and no reset
// ever arrives, and fetch() has no timeout of its own -- which silently
// stalled every poll loop that only schedules its next round once the
// previous request settles. Aborting it makes such a loop just carry on.
function fetchWithTimeout(url, timeoutMs, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).then(
    (r) => r.json().finally(() => clearTimeout(timer)),
    (e) => {
      clearTimeout(timer);
      throw e;
    }
  );
}

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

// Where the servos physically point: the robot's estimate (panActDeg/
// tiltActDeg: commands of one servo lag ago), not the command itself. The
// pan command deliberately leads the chassis to cover the servo's lag, so
// using it made the overlays swing while the real camera held still.
// Older firmware only sends the commands.
function servoAngles(m) {
  return {
    servoAngleDeg: m.panActDeg ?? m.servoAngleDeg ?? 0,
    tiltAngleDeg: m.tiltActDeg ?? m.tiltAngleDeg ?? 0,
  };
}

// Returns an unsubscribe function (used when a game is switched in-page).
function subscribeToPose(callback) {
  poseSubscribers.push(callback);
  const unsubscribe = () => {
    const i = poseSubscribers.indexOf(callback);
    if (i >= 0) poseSubscribers.splice(i, 1);
  };
  if (posePollStarted) return unsubscribe;
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

  // Preferred source: the robot's own pose broadcast on the WebSocket this
  // page already holds open for driving (controls.js) -- ~10 Hz, each sample
  // stamped with the robot's clock ("t", ms). The overlays are then drawn
  // for "robot time now minus the video's delay", so they show the same
  // moment as the picture instead of trailing it (polling + smoothing above
  // put them ~150-250 ms behind, which during a turn is a visible slide).
  // Robot time now is estimated from the fastest-arriving samples.
  const wsSamples = []; // {t, pose}, robot-clock ms, oldest first
  const clockOffsets = []; // recent (arrival - t), their min ~ clock offset + min one-way delay
  let wsLastArrival = -Infinity;
  const overlayDelayMs = () => {
    const v = parseFloat(localStorage.getItem("camOverlayDelayMs"));
    // Measured 2026-09-27: video frames reach a PC ~45-55 ms after the robot
    // clock (in-place turns, video vs odometry); minus the one-way delay the
    // clock estimate below already includes, plus decoding. Tunable on the
    // Main page ("Camera page settings").
    return Number.isFinite(v) ? v : 45;
  };
  Lynx.control.onMessage("pose", (m) => {
    if (typeof m.t !== "number") return; // older firmware
    const now = performance.now();
    wsLastArrival = now;
    if (wsSamples.length && m.t <= wsSamples[wsSamples.length - 1].t) {
      wsSamples.length = 0; // robot rebooted: its clock restarted
      clockOffsets.length = 0;
    }
    clockOffsets.push(now - m.t);
    if (clockOffsets.length > 100) clockOffsets.shift();
    const pose = { x: m.x, y: m.y, theta: m.theta, ...servoAngles(m) };
    wsSamples.push({ t: m.t, pose });
    if (wsSamples.length > 30) wsSamples.shift();
    if (typeof m.controlTheta === "number") correctAim(m, Math.min(...clockOffsets));
  });
  const wsFresh = () => performance.now() - wsLastArrival < 600 && wsSamples.length >= 2;

  // Absolute aim: the page, not the robot, turns the camera input into where
  // the camera points. The turn/tilt rates (keyboard, gamepad, touch
  // joysticks) are integrated here -- rate x panMaxSpeedDegPerSec through
  // the joystick curve, as the robot used to -- and the resulting heading
  // (the control frame's direction, controlTheta) and tilt go to the robot
  // as an "aim" message; the servos then chase them. So a short tap turns
  // the camera exactly as far as it turns the view, however the network
  // bunches the messages up (with rates, the robot turned for as long as it
  // saw the key down). While this page isn't steering, it follows the
  // robot's own targets (another browser, re-homing), and big jumps snap.
  //
  // Smooth aim (games, a setting): the game's view uses these same angles
  // instead of the servos' measured ones -- steady, no servo wobble.
  // Position still comes from odometry.
  const AIM_TAU_S = 0.8; // how quickly a difference from the robot fades while not steering
  const AIM_SNAP_RAD = 0.5; // bigger jumps (re-homing, a reboot) are taken at once
  const AIM_LINK_MS = 40; // roughly how long a target takes to show up in the robot's broadcast
  const AIM_SEND_MS = 33; // ~30 Hz while the aim moves
  const AIM_HOLD_MS = 300; // keep steering this long after the input stops (the last target gets out)
  const aim = { yaw: null, tiltDeg: 0, lastMs: null, hist: [], errYaw: 0, errTilt: 0, activeAt: -1e9, sentAt: -1e9, sent: null };
  const aimCurve = (v, a) => {
    const x = Math.abs(v) > 0.03 ? v : 0; // CONTROL_FRAME_ROTATE_DEADZONE
    return a.quadratic ? Math.sign(x) * x * x : x;
  };
  const aimSteering = (now) => now - aim.activeAt < AIM_HOLD_MS;
  // Absolute aim is on while this loop keeps it up to date (it stops with
  // the tab hidden) -- otherwise the rates go to the robot as before.
  Lynx.control.absoluteAim = () => aimParams !== null && aim.yaw !== null && aim.lastMs !== null && performance.now() - aim.lastMs < 250;

  function stepAim(now, a) {
    const input = Lynx.control.aimInput;
    const dt = aim.lastMs === null ? 0 : Math.max(0, Math.min((now - aim.lastMs) / 1000, 0.1));
    aim.lastMs = now;
    // a held key/stick is resent every ~150 ms; one not heard for 1 s is released
    const rot = now - input.rotAt < 1000 ? input.rot : 0;
    const tilt = now - input.tiltAt < 1000 ? input.tilt : 0;
    if (aimCurve(rot, a) !== 0 || aimCurve(tilt, a) !== 0) aim.activeAt = now;
    aim.yaw += ((aimCurve(rot, a) * a.panRateDeg * Math.PI) / 180) * dt;
    aim.tiltDeg = Math.max(a.tiltMinDeg, Math.min(a.tiltMaxDeg, aim.tiltDeg + aimCurve(tilt, a) * a.tiltRateDeg * dt));
    // The robot drive mode: the camera sits at an angle to the chassis that
    // the robot itself holds ("camera_relative", nothing to send from here).
    const robotPan = Lynx.control.robotCamPanRad();
    if (robotPan !== null && wsSamples.length) {
      aim.yaw += wrapToPi(wsSamples[wsSamples.length - 1].pose.theta + robotPan - aim.yaw);
      aim.tiltDeg = Math.max(a.tiltMinDeg, Math.min(a.tiltMaxDeg, Lynx.control.robotCamTiltDeg()));
      aim.errYaw = aim.errTilt = 0;
    }
    // A game pointing the camera itself (Lynx.cam.setAimOverride): it says
    // where, the rates above only feed its own controls.
    const o = aimOverride && aimOverride(now);
    if (o) {
      aim.yaw += wrapToPi(o.yaw - aim.yaw); // the history stays continuous
      aim.tiltDeg = Math.max(a.tiltMinDeg, Math.min(a.tiltMaxDeg, o.tiltDeg));
      aim.activeAt = now;
    }
    if (aimSteering(now)) {
      aim.errYaw = aim.errTilt = 0; // this page is the one steering
      sendAim(now);
    }
    const k = 1 - Math.exp(-dt / AIM_TAU_S);
    const dy = aim.errYaw * k;
    const dTilt = aim.errTilt * k;
    aim.yaw += dy;
    aim.tiltDeg += dTilt;
    aim.errYaw -= dy;
    aim.errTilt -= dTilt;
    // keep the history consistent with the correction just applied
    aim.hist.forEach((h) => {
      h.yaw += dy;
      h.tiltDeg += dTilt;
    });
    aim.hist.push({ ms: now, yaw: aim.yaw, tiltDeg: aim.tiltDeg });
    while (aim.hist.length > 1 && aim.hist[0].ms < now - 2000) aim.hist.shift();
  }

  // The current target to the robot, at most ~30 Hz and only if it moved.
  function sendAim(now) {
    if (now - aim.sentAt < AIM_SEND_MS) return;
    const s = aim.sent;
    if (s && Math.abs(wrapToPi(aim.yaw - s.yaw)) < 0.001 && Math.abs(aim.tiltDeg - s.tiltDeg) < 0.05) return;
    Lynx.control.send({ type: "aim", heading: +wrapToPi(aim.yaw).toFixed(4), tilt: +aim.tiltDeg.toFixed(2) });
    aim.sentAt = now;
    aim.sent = { yaw: aim.yaw, tiltDeg: aim.tiltDeg };
  }

  function correctAim(m, clockOffset) {
    if (aim.yaw === null) {
      aim.yaw = m.controlTheta;
      aim.tiltDeg = m.tiltAngleDeg;
      aim.errYaw = aim.errTilt = 0;
      return;
    }
    // where the view was when the robot computed these targets
    const at = m.t + clockOffset - AIM_LINK_MS;
    let h = aim.hist[0];
    for (const e of aim.hist) if (e.ms <= at) h = e;
    if (!h) return;
    const errYaw = wrapToPi(m.controlTheta - h.yaw);
    const errTilt = m.tiltAngleDeg - h.tiltDeg;
    if (Math.abs(errYaw) > AIM_SNAP_RAD) {
      aim.yaw += errYaw;
      aim.hist.forEach((e) => (e.yaw += errYaw));
      aim.errYaw = 0;
    } else if (!aimSteering(performance.now())) {
      aim.errYaw = errYaw;
      aim.errTilt = errTilt;
    }
  }

  // The aim as it was at local time ms (history interpolated; newer than the
  // history = now).
  function aimAt(ms) {
    const h = aim.hist;
    if (!h.length || ms >= h[h.length - 1].ms) return { yaw: aim.yaw, tiltDeg: aim.tiltDeg };
    if (ms <= h[0].ms) return h[0];
    let i = h.length - 1;
    while (i > 0 && h[i - 1].ms > ms) i--;
    const a = h[i - 1];
    const b = h[i];
    const t = (ms - a.ms) / (b.ms - a.ms || 1);
    return { yaw: a.yaw + (b.yaw - a.yaw) * t, tiltDeg: a.tiltDeg + (b.tiltDeg - a.tiltDeg) * t };
  }

  // Roughly how long the camera takes to point where the page aimed it: the
  // "aim" message's trip plus the servo's own lag (debug_pan measurements,
  // ~60-70 ms). The overlay delay setting adds the video's lag on top.
  const AIM_SERVO_LAG_MS = 80;

  // Every frame: keep the aim up to date (and steering the robot), and --
  // with "Smooth aim" on -- hand the overlays and games that aim instead of
  // the servos' measured angles: as it was one servo lag + overlay delay
  // ago, so it moves with the video. Smooth every frame, where the measured
  // angles only arrive 10x a second (a grid drawn from those jumped when a
  // turn started and stopped). As a camera heading: chassis heading =
  // camera heading, pan 0. Position still comes from odometry.
  function withAim(pose) {
    if (!aimParams || aim.yaw === null) return pose;
    const now = performance.now();
    stepAim(now, aimParams);
    if (!aimView) return pose;
    const seen = aimAveraged(now, AIM_SERVO_LAG_MS + overlayDelayMs());
    return { ...pose, theta: wrapToPi(seen.yaw), servoAngleDeg: 0, tiltAngleDeg: seen.tiltDeg };
  }

  // The aim averaged over the last 2 x lagMs, instead of the aim exactly
  // lagMs ago. In a steady turn that's the same delay (so the view still
  // lines up with the video), but a turn no longer sits still for the
  // whole lag first: the view starts turning at once, slowly, ramps up to
  // full speed over 2 x lagMs, and eases out the same way when the turn
  // stops. On the way it runs ahead of the video by at most lag/4 x speed
  // (~4 deg at 90 deg/s and 180 ms) -- a game feels far less laggy.
  function aimAveraged(now, lagMs) {
    const n = 8; // trapezoid rule over the window
    let yaw = 0;
    let tiltDeg = 0;
    for (let k = 0; k <= n; k++) {
      const w = k === 0 || k === n ? 0.5 : 1;
      const a = aimAt(now - (2 * lagMs * k) / n);
      yaw += w * a.yaw; // continuous (never wrapped), so plain averaging is fine
      tiltDeg += w * a.tiltDeg;
    }
    return { yaw: yaw / n, tiltDeg: tiltDeg / n };
  }

  function wsPoseAt() {
    const target = performance.now() - Math.min(...clockOffsets) - overlayDelayMs();
    const n = wsSamples.length;
    let i = n - 1;
    while (i > 0 && wsSamples[i - 1].t > target) i--;
    const a = wsSamples[Math.max(i - 1, 0)];
    const b = wsSamples[Math.max(i, 1)];
    // Interpolate between the samples around the target time, or carry the
    // last motion forward (at most 200 ms) if the next sample isn't in yet.
    const span = b.t - a.t;
    let t = span > 0 ? (target - a.t) / span : 1;
    t = Math.max(0, Math.min(t, 1 + 200 / Math.max(span, 1)));
    return lerpPose(a.pose, b.pose, t);
  }

  function poll() {
    if (wsFresh()) {
      setTimeout(poll, POSE_POLL_INTERVAL_MS); // not needed while the socket delivers poses
      return;
    }
    fetchWithTimeout("/pose", 2500)
      .then((data) => {
        const pose = { x: data.x, y: data.y, theta: data.theta, ...servoAngles(data) };
        prevPose = nextPose || pose;
        nextPose = pose;
        nextPoseReceivedAtMs = performance.now();
      })
      .catch(() => {}) // keep polling through a transient failure (e.g. brief Wi-Fi hiccup)
      .finally(() => setTimeout(poll, POSE_POLL_INTERVAL_MS));
  }
  poll();

  function animate() {
    if (wsFresh()) {
      const pose = withAim(wsPoseAt());
      poseSubscribers.slice().forEach((cb) => cb(pose));
    } else if (nextPose) {
      const t = Math.min((performance.now() - nextPoseReceivedAtMs) / POSE_POLL_INTERVAL_MS, 1);
      const pose = prevPose ? lerpPose(prevPose, nextPose, t) : nextPose;
      poseSubscribers.slice().forEach((cb) => cb(pose));
    }
    requestAnimationFrame(animate);
  }
  requestAnimationFrame(animate);
  return unsubscribe;
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
      const color = WAYPOINT_COLOR;
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

// Waypoint markers (camera-view beacons, pins, edge arrows, mini-map):
// GTA-style magenta, which stands out against almost any real floor.
const WAYPOINT_COLOR = "#e83fb8";

// Neutral gray reads on most floors without shouting over the picture;
// changeable on the Main page ("Camera page settings").
const CAM_GRID_DEFAULT_COLOR = "#c0c0c0";

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
// Also draws the world coordinate frame (see drawAxes() in draw()): a second
// instance with { canvasId: "camAxesOverlay", grid: false, axes: true } so
// the two overlays toggle independently but share one projection/clipping
// pipeline.
function initFloorGrid(calib, { canvasId = "camFloorGrid", grid = true, axes = false } = {}) {
  const canvas = document.getElementById(canvasId);
  const img = document.getElementById("camStream");
  // wireOverlayToggle() only ever calls this once actually enabling the
  // overlay (initially on, or the moment it's first switched on) -- display
  // itself is owned entirely by wireOverlayToggle from then on.
  canvas.style.display = "block";
  const ctx = canvas.getContext("2d");

  // Grid lines are clipped to a camera-relative box (x = right, y = forward)
  // before projecting. The near edge is a small positive distance, not
  // exactly 0: forward=0 is the point directly beside the camera (zero depth
  // along the optical axis), a genuine projection singularity (zc=0) whenever
  // tilt is 0 -- clipping a line's endpoint to exactly that boundary made
  // project() reject the whole line. The box's width follows the camera's
  // actual horizontal field of view (see draw()), so the grid covers the
  // whole picture instead of a fixed strip that showed up as a trapezoid;
  // its depth is per tier (TIERS.maxDistM), with lines fading out toward it.
  const VIEW_MIN_DISTANCE_M = 0.05;

  // Color/opacity/minor-tier-visibility are display preferences (set on
  // the Main page, "Camera page settings"), read once here like the other
  // opt-in overlay settings - not robot calibration, so localStorage
  // rather than a firmware setting. Every floor is a different color, so
  // there's no single "right" default that reads well everywhere.
  const gridRgb = hexToRgb(localStorage.getItem("camGridColor") || CAM_GRID_DEFAULT_COLOR);
  const gridOpacityPct = parseFloat(localStorage.getItem("camGridOpacity"));
  const majorOpacity = Number.isFinite(gridOpacityPct) ? gridOpacityPct / 100 : 0.9;
  const rgbaOf = (c, opacity) => `rgba(${c.r}, ${c.g}, ${c.b}, ${opacity})`;

  // World axes: X red, Y green, tick marks + labels every whole meter.
  const X_AXIS_RGB = hexToRgb("#ff3b30");
  const Y_AXIS_RGB = hexToRgb("#34d158");
  const AXIS_OPACITY = 0.95;
  const AXIS_TICK_HALF_M = 0.06; // whole-meter tick marks are 12 cm across, on the floor
  const AXIS_HALF_TICK_HALF_M = 0.035; // half-meter ones 7 cm
  const AXIS_LABEL_MIN_GAP_PX = 28; // labels closer than this (near the horizon) are skipped

  // Each tier reaches only as far as its lines stay at least this many
  // pixels apart on screen (see draw()): fine lines near the robot, coarse
  // ones further out, instead of all of them piling up at the horizon.
  const MIN_LINE_SPACING_PX = 5;
  const MAX_GRID_DISTANCE_M = 8;
  const TIERS = [];
  if (localStorage.getItem("camShowMinorGrid") !== "false") {
    // Minor/medium opacity stay proportional to whatever major opacity the
    // user picked, preserving the same minor < medium < major hierarchy at
    // any overall brightness rather than a fixed absolute value.
    TIERS.push({ interval: 0.1, opacity: majorOpacity * (0.35 / 0.9), lineWidth: 1 });
  }
  TIERS.push({ interval: 0.5, opacity: majorOpacity * (0.6 / 0.9), lineWidth: 1 });
  TIERS.push({ interval: 1.0, opacity: majorOpacity, lineWidth: 2 });

  // 1 up close, easing to 0 over the last 40% of a tier's reach.
  const fadeAt = (forwardM, maxDistM) => {
    const t = Math.min(1, Math.max(0, (forwardM - 0.6 * maxDistM) / (0.4 * maxDistM)));
    return 1 - t * t * (3 - 2 * t);
  };

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
    return { x0: x0 + t0 * dx, y0: y0 + t0 * dy, x1: x0 + t1 * dx, y1: y0 + t1 * dy, t0, t1 };
  }

  // Through the calibrated lens model (Lynx.lens, lynx_common.js), so the
  // grid bends with the camera's barrel distortion.
  function project(x, y) {
    const zc = y * Math.cos(effectiveTiltRad) + calib.heightM * Math.sin(effectiveTiltRad);
    if (zc <= 0.01) return null; // behind the camera, or grazing along the optical axis
    const yc = calib.heightM * Math.cos(effectiveTiltRad) - y * Math.sin(effectiveTiltRad);
    const p = Lynx.lens.project(x, yc, zc, img.naturalWidth, img.naturalHeight);
    return p && { u: p.u, v: p.v, zc };
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

    // The grid covers the whole page viewport, carrying on past the
    // picture's own edges into the letterbox bars (so it lines up with
    // waypoint beacons drawn there). Its extent in image-pixel coordinates:
    const uMin = -offsetX / scale - 4;
    const uMax = (containerW - offsetX) / scale + 4;
    const vMin = -offsetY / scale - 4;
    const vMax = (containerH - offsetY) / scale + 4;
    // Clipping uses the straight chord between a line's projected ends, which
    // the lens bends away from -- so clip with some slack.
    const slackU = 0.15 * imgW;
    const slackV = 0.15 * imgH;

    // Half the horizontal field of view of that viewport, in the same
    // pinhole model. A floor point `forward` meters ahead is at most
    // (forward + height) deep along the optical axis at any downward tilt,
    // so that times tan(half-FOV) bounds how far sideways it can still be in
    // view -- with a little margin so lines run cleanly off the edges.
    const fImg = Lynx.lens.params(imgW, imgH).f; // pixels per radian near the center
    const edgeAngle = Lynx.lens.angleAt(Math.max(uMax - imgW / 2, imgW / 2 - uMin), imgW, imgH);
    const tanHalfHfov = Math.tan(Math.min(edgeAngle, 1.45));
    const halfWidthAt = (forwardM) => (forwardM + calib.heightM) * tanHalfHfov * 1.15 + 0.1;
    // With the camera tilted up past level, the nearest floor is behind the
    // lens (project() rejects it) -- start the box where depth turns positive
    // so lines get shortened there instead of dropped whole.
    const cosT = Math.cos(effectiveTiltRad);
    const nearM = cosT > 0
      ? Math.max(VIEW_MIN_DISTANCE_M, (0.02 - calib.heightM * Math.sin(effectiveTiltRad)) / cosT)
      : Infinity;

    // Layered minor -> medium -> major, each drawn on top of the last, same
    // idea as the Main map's drawGridTier().
    // A floor line d meters ahead sits about f*height/d pixels below the
    // horizon, so neighbouring lines `interval` apart are f*height*interval/d^2
    // pixels apart -- solve for the d where that drops to MIN_LINE_SPACING_PX.
    const fPx = fImg * scale;
    const reachFor = (interval) =>
      Math.min(MAX_GRID_DISTANCE_M, Math.sqrt((fPx * calib.heightM * interval) / MIN_LINE_SPACING_PX));

    // Returns a function drawing one camera-relative floor segment, clipped
    // to [nearM, maxDistM] ahead / +-halfWidthM sideways and to the
    // viewport, fading out toward maxDistM.
    // Pieces of a projected floor line are split in half (on the floor) until
    // each is short on screen, nearly straight, and nearly evenly faded; the
    // lens bends straight floor lines, most of all close to the camera and
    // far off to the side. (An earlier version clipped the straight chord
    // between the projected END points to the viewport -- with the lens'
    // curvature that chord can miss the picture while the line itself
    // crosses it, so lines near the robot vanished, especially tilted up.)
    const MAX_PIECE_PX = 90;
    const MAX_BEND_PX = 1;
    const MAX_FADE_STEP = 0.08;
    const MAX_SPLITS = 12;

    const makeLineDrawer = (maxDistM, halfWidthM, rgb, opacity) => (right0, forward0, right1, forward1) => {
      const c = clipToBox(right0, forward0, right1, forward1, -halfWidthM, halfWidthM, nearM, maxDistM);
      if (!c) return;
      const a = { right: c.x0, forward: c.y0, p: project(c.x0, c.y0) };
      const b = { right: c.x1, forward: c.y1, p: project(c.x1, c.y1) };
      if (!a.p || !b.p) return; // the box keeps the ends in front of the lens
      a.fade = fadeAt(a.forward, maxDistM);
      b.fade = fadeAt(b.forward, maxDistM);

      const strokePiece = (p, q) => {
        const alpha = opacity * fadeAt((p.forward + q.forward) / 2, maxDistM);
        if (alpha <= 0.005) return;
        // off one side of the picture entirely: nothing to draw (and huge
        // off-screen strokes are what GPU rasterizers tend to drop)
        if ((p.p.u < uMin - slackU && q.p.u < uMin - slackU) || (p.p.u > uMax + slackU && q.p.u > uMax + slackU)) return;
        if ((p.p.v < vMin - slackV && q.p.v < vMin - slackV) || (p.p.v > vMax + slackV && q.p.v > vMax + slackV)) return;
        const s = toCanvas(p.p.u, p.p.v);
        const e = toCanvas(q.p.u, q.p.v);
        ctx.strokeStyle = rgbaOf(rgb, alpha);
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(e.x, e.y);
        ctx.stroke();
      };

      const piece = (p, q, depth) => {
        const m = { right: (p.right + q.right) / 2, forward: (p.forward + q.forward) / 2 };
        m.p = project(m.right, m.forward);
        if (!m.p || depth >= MAX_SPLITS) return strokePiece(p, q);
        m.fade = fadeAt(m.forward, maxDistM);
        const du = (q.p.u - p.p.u) * scale;
        const dv = (q.p.v - p.p.v) * scale;
        const lenPx = Math.hypot(du, dv);
        // how far the true midpoint lies off the straight chord, on screen
        const bendPx = lenPx > 1e-6 ? Math.abs(((m.p.u - p.p.u) * scale) * dv - ((m.p.v - p.p.v) * scale) * du) / lenPx : 0;
        // ends and middle all beyond the same edge of the picture: this piece
        // stays out of view, so it isn't worth refining
        const beyond = (f) => [p, m, q].every((x) => f(x.p));
        if (beyond((x) => x.u < uMin - slackU) || beyond((x) => x.u > uMax + slackU) ||
            beyond((x) => x.v < vMin - slackV) || beyond((x) => x.v > vMax + slackV)) return;
        const needsSplit = bendPx > MAX_BEND_PX || Math.abs(p.fade - q.fade) > MAX_FADE_STEP || lenPx > MAX_PIECE_PX;
        if (!needsSplit) return strokePiece(p, q);
        piece(p, m, depth + 1);
        piece(m, q, depth + 1);
      };
      piece(a, b, 0);
    };

    if (grid) TIERS.forEach(({ interval, opacity, lineWidth }) => {
      const maxDistM = reachFor(interval);
      if (nearM >= maxDistM) return;
      const halfWidthM = halfWidthAt(maxDistM);
      ctx.lineWidth = lineWidth;
      const drawRelativeLine = makeLineDrawer(maxDistM, halfWidthM, gridRgb, opacity);

      // World-frame bounding box of this tier's camera-relative box, from
      // its 4 corners -- decides which world grid lines are worth trying.
      const corners = [
        relativeToWorld(-halfWidthM, nearM, pose),
        relativeToWorld(halfWidthM, nearM, pose),
        relativeToWorld(-halfWidthM, maxDistM, pose),
        relativeToWorld(halfWidthM, maxDistM, pose),
      ];
      const worldXMin = Math.min(...corners.map((c) => c.x));
      const worldXMax = Math.max(...corners.map((c) => c.x));
      const worldYMin = Math.min(...corners.map((c) => c.y));
      const worldYMax = Math.max(...corners.map((c) => c.y));

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

    if (axes && nearM < MAX_GRID_DISTANCE_M) {
      const maxDistM = MAX_GRID_DISTANCE_M;
      const halfWidthM = halfWidthAt(maxDistM);
      const spanM = maxDistM + halfWidthM; // farther than this from the robot can't be in view
      const worldSeg = (draw, x0, y0, x1, y1) => {
        const a = worldToRelative(x0, y0, pose);
        const b = worldToRelative(x1, y1, pose);
        draw(a.right, a.forward, b.right, b.forward);
      };
      const labels = [];
      // along: 0 = X axis (y = 0), 1 = Y axis (x = 0).
      [[0, X_AXIS_RGB], [1, Y_AXIS_RGB]].forEach(([along, rgb]) => {
        const at = (k, off) => (along === 0 ? [k, off] : [off, k]); // world point k meters along the axis, off to the side
        const center = along === 0 ? pose.x : pose.y;
        const lineDraw = makeLineDrawer(maxDistM, halfWidthM, rgb, AXIS_OPACITY);
        ctx.lineWidth = 3;
        worldSeg(lineDraw, ...at(center - spanM, 0), ...at(center + spanM, 0));
        // Every half meter: whole meters get the bigger tick and label
        // priority; the 0.5 m ones only get labels where there's room.
        for (let i = Math.ceil(2 * (center - spanM)); i <= Math.floor(2 * (center + spanM)); i++) {
          if (i === 0) continue;
          const k = i / 2;
          const half = i % 2 !== 0;
          ctx.lineWidth = half ? 1.5 : 2;
          const tickM = half ? AXIS_HALF_TICK_HALF_M : AXIS_TICK_HALF_M;
          worldSeg(lineDraw, ...at(k, -tickM), ...at(k, tickM));
          const [wx, wy] = at(k, 0);
          const rel = worldToRelative(wx, wy, pose);
          if (rel.forward < nearM || rel.forward > maxDistM) continue;
          const p = project(rel.right, rel.forward);
          if (!p) continue;
          const c = toCanvas(p.u, p.v);
          if (c.x < 0 || c.x > containerW || c.y < 0 || c.y > containerH) continue;
          // Placement priority: the +1 m mark (which also carries the axis
          // name), then other whole meters, then half meters.
          const priority = k === 1 ? 0 : half ? 2 : 1;
          const name = k === 1 ? (along === 0 ? "X" : "Y") : null;
          labels.push({ x: c.x, y: c.y, text: `${k}`, alpha: fadeAt(rel.forward, maxDistM), forward: rel.forward, priority, name });
        }
      });
      // By priority, nearest first within each, skipping any that would
      // crowd an already-placed one.
      labels.sort((a, b) => a.priority - b.priority || a.forward - b.forward);
      const placed = [];
      ctx.font = "bold 12px sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "bottom";
      ctx.lineWidth = 3;
      labels.forEach((l) => {
        if (l.alpha < 0.05) return;
        if (placed.some((q) => Math.hypot(q.x - l.x, q.y - l.y) < AXIS_LABEL_MIN_GAP_PX)) return;
        placed.push(l);
        ctx.strokeStyle = `rgba(0, 0, 0, ${0.7 * l.alpha})`;
        ctx.strokeText(l.text, l.x + 4, l.y - 3);
        // White text (dark outline) reads on any floor; the axis lines
        // themselves carry the red/green.
        ctx.fillStyle = `rgba(255, 255, 255, ${l.alpha})`;
        ctx.fillText(l.text, l.x + 4, l.y - 3);
        if (l.name) {
          // Axis name in big letters above the +1 m label.
          ctx.font = "bold 20px sans-serif";
          ctx.strokeText(l.name, l.x + 4, l.y - 17);
          ctx.fillText(l.name, l.x + 4, l.y - 17);
          ctx.font = "bold 12px sans-serif";
        }
      });
    }
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
    fetchWithTimeout("/waypoints", 5000)
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

  // Each waypoint in view renders as a beacon: the silhouette of a standing
  // cylinder on the floor (see drawBeacon()) rather than a flat pin --
  // roughly the footprint of a real object you'd navigate the robot to.
  // Purely a display convention; doesn't need to match anything physical.
  const CYLINDER_RADIUS_M = 0.10; // 10 cm radius (20 cm diameter)
  const CYLINDER_HEIGHT_M = 0.2; // 20 cm
  const GLOW_BLUR_PX = 32; // canvas shadow blur radius for the close-up pin marker's glow

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
    // Through the calibrated lens model (Lynx.lens). s = local pixels per
    // unit of x/z there, for sizing things at that depth.
    const p = Lynx.lens.project(x, yc, zc, img.naturalWidth, img.naturalHeight);
    return p ? { u: p.u, v: p.v, zc, s: p.scale } : { u: NaN, v: NaN, zc, s: 0 };
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
    const color = WAYPOINT_COLOR;
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

  // Beacon marker: the silhouette of a standing cylinder on the floor at
  // the waypoint -- the quad between its two outline edges (the lines
  // tangent to its base circle as seen from the camera), which is a plain
  // rectangle whenever the camera is level. Filled with a vertical fade:
  // 75% opaque at the floor, fully transparent at the top, like a beam of
  // light. Returns the silhouette's canvas corners (for the on-screen test),
  // or null when there's no clean silhouette -- camera over/inside the base,
  // or part of it behind the lens.
  function beaconQuad(rel, toCanvas) {
    const tangents = computeTangentPoints(rel.right, rel.forward, CYLINDER_RADIUS_M);
    if (!tangents) return null;
    const corners = [];
    for (const [t, h] of [[tangents[0], 0], [tangents[0], CYLINDER_HEIGHT_M], [tangents[1], CYLINDER_HEIGHT_M], [tangents[1], 0]]) {
      const p = project(t.right, t.forward, h);
      if (p.zc <= 0.01) return null;
      corners.push(toCanvas(p.u, p.v));
    }
    return corners; // bottom-1, top-1, top-2, bottom-2
  }

  function drawBeacon(quad, wp, distM, view) {
    const { r, g, b } = hexToRgb(WAYPOINT_COLOR);
    const [b1, t1, t2, b2] = quad;
    const bottom = { x: (b1.x + b2.x) / 2, y: (b1.y + b2.y) / 2 };
    const top = { x: (t1.x + t2.x) / 2, y: (t1.y + t2.y) / 2 };
    const grad = ctx.createLinearGradient(bottom.x, bottom.y, top.x, top.y);
    grad.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.75)`);
    grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(b1.x, b1.y);
    ctx.lineTo(t1.x, t1.y);
    ctx.lineTo(t2.x, t2.y);
    ctx.lineTo(b2.x, b2.y);
    ctx.closePath();
    ctx.fill();

    // Label above the beacon, kept on screen while the beacon is only
    // partly in view.
    const labelX = Math.min(Math.max(top.x, view.x + 60), view.x + view.w - 60);
    const labelY = Math.min(Math.max(top.y - 4, view.y + 16), view.y + view.h - 4);
    drawLabel(labelX, labelY, "bottom", wp, distM);
  }

  function drawEdgeArrow(x, y, angle, wp, distM, w, h) {
    const color = WAYPOINT_COLOR;
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
    // Below the arrow, or above it when the arrow's in the lower half
    // (e.g. along the bottom edge) so the label isn't pushed off screen.
    if (y > h / 2) drawLabel(labelX, Math.max(y - 12, 16), "bottom", wp, distM);
    else drawLabel(labelX, Math.min(y + 14, h - 18), "top", wp, distM);
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

    // The whole page viewport, not just the letterboxed picture inside it:
    // the projection carries on past the camera's own edges, so a beacon
    // already shows over the bars beside the picture as it comes into view.
    const view = { x: 0, y: 0, w: containerW, h: containerH };

    loadWaypointsForOverlay().forEach((wp) => {
      const rel = worldToRelative(wp.x, wp.y, pose);
      const distM = Math.hypot(rel.right, rel.forward);
      const p = project(rel.right, rel.forward, 0);
      const inFront = p.zc > 0.01;
      const c = inFront ? toCanvas(p.u, p.v) : null;

      // Drawn as soon as any part of the beacon overlaps the viewport, not
      // only once its center does -- it's wide enough that the center test
      // left a clearly visible beacon missing near the edges.
      const quad = beaconQuad(rel, toCanvas);
      if (quad) {
        const xs = quad.map((q) => q.x);
        const ys = quad.map((q) => q.y);
        if (Math.max(...xs) >= view.x && Math.min(...xs) <= view.x + view.w &&
            Math.max(...ys) >= view.y && Math.min(...ys) <= view.y + view.h) {
          drawBeacon(quad, wp, distM, view);
          return;
        }
      } else if (c && c.x >= 0 && c.x <= containerW && c.y >= 0 && c.y <= containerH) {
        drawPin(c, wp, distM); // right on top of it: no clean silhouette
        return;
      }

      // Off-screen: clamp a ray from the screen center toward the
      // waypoint's screen-space direction (in front of the camera, just
      // outside the frame) or, behind the camera where u/v aren't
      // meaningful, its top-down radar direction (right = right, ahead =
      // up) -- so a waypoint behind the player sits along the BOTTOM edge,
      // sliding up the side edges as it comes round beside them.
      const dirX = c ? c.x - cx : rel.right;
      const dirY = c ? c.y - cy : -rel.forward;
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

  // Shared with the keyboard controls -- one socket per page (controls.js).
  function sendWs(obj) {
    Lynx.control.send(obj);
  }
  Lynx.control.start();

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
    if (e.target.closest(".cam-menu-panel, .cam-overlay-btn, .game-touch-ui")) return;
    Lynx.sfx.unlock();
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
