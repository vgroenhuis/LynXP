// Free drive's AprilTag cube detection (cam.js starts it with Free drive):
// switches in the Overlays panel turn the detection on (cubes.js: the same
// cube layer the games use, the block map remembered on the robot -- see the
// Tags page), show the blocks' outlines -- with the footprint where a cube
// stands on the floor filled in -- (cyan, the frame cube yellow; grey
// for ones inferred underneath a stack; thin magenta for remembered ones not
// seen where they were lately) and the tags found in the picture (green), and let
// the frame cube set the world frame (see cubes.js).
//
// Lynx.freeDriveTags.setup(calib, app) once, then .setActive(bool) as Free
// drive starts / stops.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const KEYS = { on: "freeDriveTags", blocks: "freeDriveShowBlocks", tags: "freeDriveShowTags", frame: "freeDriveAutoFrame", tracks: "freeDriveWheelTracks" };

  const remembered = (key, def) => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? def : v === "1";
    } catch (e) {
      return def;
    }
  };
  const remember = (key, on) => {
    try {
      localStorage.setItem(key, on ? "1" : "0");
    } catch (e) {
      // (not remembered)
    }
  };

  let calib = null;
  let app = null;
  let active = false; // Free drive is running
  const opt = { on: remembered(KEYS.on, false), blocks: remembered(KEYS.blocks, true), tags: remembered(KEYS.tags, true), frame: remembered(KEYS.frame, false), tracks: remembered(KEYS.tracks, false) };
  let run = null; // {ar, w, layer (null with the detection off)} while detecting or showing the wheel tracks
  let toggles = [];

  function setup(c, a) {
    calib = c;
    app = a;
  }

  function setActive(on) {
    active = on;
    toggles.forEach((el) => el.remove());
    toggles = [];
    if (on && Lynx.cam && Lynx.cam.addOverlayToggle) {
      const t = (text, key) => Lynx.cam.addOverlayToggle(text, opt[key], (v) => {
        opt[key] = v;
        remember(KEYS[key], v);
        refresh();
      });
      toggles = [t("Cube detection", "on"), t("Cube outlines", "blocks"), t("Cube tags", "tags"), t("World frame from cube", "frame"), t("Wheel tracks", "tracks")];
    }
    refresh();
  }

  function refresh() {
    const want = active && (opt.on || opt.tracks) && calib;
    // (the detection switched: started over with or without it)
    if (run && (!want || !!run.layer !== opt.on)) {
      run.ar.destroy(); // (the layer stops with it)
      run = null;
    }
    if (want && !run) startRun();
  }

  function startRun() {
    const ar = Lynx.createAr(calib);
    const w = Lynx.world3d(ar, { textures: false, lens: true }); // (outlines on the video: through the lens)
    w.setAnchor({ x: 0, y: 0, th: 0 });
    const layer = opt.on ? Lynx.cubeLayer(ar, app, { frame: () => opt.frame }) : null;
    run = { ar, w, layer };
    ar.onFrame(() => {
      w.beginFrame();
      // (no status line -- the Tags page lists the cubes; only a failure shows here)
      if (layer) layer.draw(w, { blocks: opt.blocks, tags: opt.tags });
      if (opt.tracks) Lynx.drawWheelTracks(ar, w, { blocks: () => (layer ? layer.blocks() : []) });
    });
  }

  // blocks(): the cubes seen now (tagblocks.js list(): x, y, yaw, half, h0, h1),
  // [] while cube detection is off -- e.g. for the world axes (cam.js)
  Lynx.freeDriveTags = { setup, setActive, debug: () => run, blocks: () => (run && run.layer ? run.layer.blocks() : []) };
})(window.Lynx);
