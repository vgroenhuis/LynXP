// Shared by the Games & apps page (games.html) and the first-person view
// (cam.html): the catalog of games/apps with their settings schema, the
// robot-side settings + scoreboard documents (web_server.cpp /appdata/*),
// and a tiny synthesized sound kit (no audio files -- everything is
// generated with WebAudio, so nothing extra has to fit in LittleFS).

window.Lynx = window.Lynx || {};

(function (Lynx) {
  // -- catalog ---------------------------------------------------------------
  // Each entry's `settings` drives both the settings form on games.html and
  // the defaults the game itself falls back to. `boards` are its high-score
  // tables: `better` says which way is a better score, `format` how to show it.
  const COCO_HOME_CLASSES = [
    "person", "bottle", "cup", "chair", "couch", "potted plant", "bed", "dining table", "tv",
    "laptop", "mouse", "remote", "keyboard", "cell phone", "book", "clock", "vase", "scissors",
    "teddy bear", "backpack", "umbrella", "handbag", "sports ball", "banana", "apple", "orange",
    "bowl", "toothbrush", "wine glass", "fork", "knife", "spoon",
  ];

  Lynx.CATALOG = [
    {
      id: "none", // kept as-is: stored settings refer to it
      kind: "none",
      name: "Free drive",
      icon: "\u{1F697}",
      blurb: "Just drive around and look -- no game or app running. The Overlays menu adds the floor grid, world axes, map and waypoints.",
      settings: [],
    },
    {
      id: "demons",
      kind: "game",
      name: "Doom",
      icon: "\u{1F479}",
      blurb:
        "Doom-style shooter in your own room. Imps, pinkies and cacodemons close in from all sides; " +
        "shoot them with pistol, shotgun and chaingun, and physically drive over health and ammo to pick them up. " +
        "Dodge fireballs by actually driving out of the way.",
      settings: [
        { key: "difficulty", label: "Difficulty", type: "select", def: "hmp",
          options: [["itytd", "I'm too young to die"], ["hmp", "Hurt me plenty"], ["uv", "Ultra-Violence"], ["nm", "Nightmare!"]] },
        { key: "spawnRadiusM", label: "Spawn distance", type: "number", unit: "m", def: 2.5, min: 1, max: 6, step: 0.25 },
        { key: "enemySpeed", label: "Enemy speed", type: "number", unit: "×", def: 1, min: 0.25, max: 3, step: 0.25 },
        { key: "aimAssist", label: "Aim assist", type: "checkbox", def: true },
        { key: "jump", label: "Virtual jumping (Space / gamepad A)", type: "checkbox", def: false },
        { key: "radar", label: "Radar", type: "checkbox", def: true },
        { key: "arrows", label: "Off-screen arrows", type: "checkbox", def: true },
      ],
      boards: [{ key: "demons", title: "Doom", better: "higher", format: "points" }],
    },
    {
      id: "david",
      kind: "game",
      name: "David",
      icon: "\u{1F4E6}",
      blurb:
        "Shoot open the crates on the floor: the golden one always holds a new, better gun " +
        "(water pistol, laser pistol, double pistol, lightning gun, rainbow cannon). Use them to beat the monsters " +
        "and get through as many levels as you can!",
      settings: [
        // the option keys stay Dutch (stored settings use them); the game started out in Dutch
        { key: "difficulty", label: "Difficulty", type: "select", def: "normaal",
          options: [["makkelijk", "Easy"], ["normaal", "Normal"], ["moeilijk", "Hard"]] },
        { key: "hearts", label: "Hearts", type: "number", def: 5, min: 1, max: 9, step: 1 },
        { key: "areaM", label: "Play area (radius)", type: "number", unit: "m", def: 2, min: 1, max: 5, step: 0.25 },
        { key: "aimAssist", label: "Aim assist", type: "checkbox", def: true },
        { key: "jump", label: "Virtual jumping (Space / gamepad A)", type: "checkbox", def: false },
        { key: "radar", label: "Radar", type: "checkbox", def: true },
        { key: "arrows", label: "Arrows to crates and monsters", type: "checkbox", def: true },
      ],
      boards: [{ key: "david", title: "David", better: "higher", format: "points" }],
    },
    {
      id: "poop",
      kind: "game",
      name: "Poop Shooter",
      icon: "\u{1F4A9}",
      blurb:
        "Shoot the poops that crawl toward you. Ten levels, every one with long stone walls: the poops have to walk around them, " +
        "they stop your shots -- and they stop the robot too, so you have to drive around them to find a clear line of fire. " +
        "Two weapons: a water gun and a bow -- arrows fall with gravity, so aim a bit above the poop. " +
        "A giant poop waits in levels 5 and 10; golden poops are worth a lot.",
      settings: [
        { key: "startLevel", label: "Start at level", type: "number", def: 1, min: 1, max: 10, step: 1 },
        { key: "difficulty", label: "Difficulty", type: "select", def: "normal",
          options: [["easy", "Easy"], ["normal", "Normal"], ["hard", "Hard"]] },
        { key: "hearts", label: "Hearts", type: "number", def: 5, min: 1, max: 9, step: 1 },
        { key: "areaM", label: "Play area (radius)", type: "number", unit: "m", def: 2, min: 1, max: 5, step: 0.25 },
        { key: "aimAssist", label: "Aim assist", type: "checkbox", def: true },
        { key: "jump", label: "Virtual jumping (Space / gamepad A)", type: "checkbox", def: false },
        { key: "radar", label: "Radar", type: "checkbox", def: true },
        { key: "arrows", label: "Arrows to poops", type: "checkbox", def: true },
      ],
      boards: [{ key: "poop", title: "Poop Shooter", better: "higher", format: "points" }],
    },
    {
      id: "coins",
      kind: "game",
      name: "Pacman",
      icon: "\u{1FA99}",
      blurb:
        "Pac-Man on the floor. Drive over every coin while ghosts hunt you down. " +
        "Grab a power coin and the ghosts turn blue -- then you hunt them.",
      settings: [
        { key: "coinCount", label: "Coins per level", type: "number", def: 16, min: 4, max: 60, step: 1 },
        { key: "areaRadiusM", label: "Play area radius", type: "number", unit: "m", def: 1.5, min: 0.5, max: 5, step: 0.25 },
        { key: "ghostCount", label: "Ghosts", type: "number", def: 2, min: 0, max: 6, step: 1 },
        { key: "ghostSpeedMps", label: "Ghost speed", type: "number", unit: "m/s", def: 0.1, min: 0.02, max: 0.5, step: 0.02 },
        { key: "lives", label: "Lives", type: "number", def: 3, min: 1, max: 9, step: 1 },
        { key: "jump", label: "Virtual jumping (Space / gamepad A)", type: "checkbox", def: false },
        { key: "radar", label: "Radar", type: "checkbox", def: true },
      ],
      boards: [{ key: "coins", title: "Pacman", better: "higher", format: "points" }],
    },
    {
      id: "prisma",
      kind: "game",
      name: "Prisma",
      icon: "\u{1F52E}",
      blurb:
        "A laser puzzle laid out on your floor, Sokoban style. Drive tile by tile, push mirrors and crates, " +
        "stand on plates to open gates, and steer every beam onto its receiver -- your robot casts a shadow too. " +
        "17 levels, from gentle to fiendish; the fewest moves earns three stars.",
      settings: [
        { key: "startLevel", label: "Start at level (0 = continue)", type: "number", def: 0, min: 0, max: 17, step: 1 },
        { key: "cellM", label: "Tile size", type: "number", unit: "m", def: 0.25, min: 0.15, max: 0.5, step: 0.05 },
        { key: "hints", label: "Level hints", type: "checkbox", def: true },
        { key: "minimap", label: "Minimap", type: "checkbox", def: true },
      ],
      boards: [{ key: "prisma", title: "Prisma (stars)", better: "higher", format: "points" }],
    },
    {
      id: "temple",
      kind: "game",
      name: "Temple of LynXP",
      icon: "\u{1F3DB}\u{FE0F}",
      blurb:
        "A Tomb Raider-style adventure in a 2 x 3 m temple on your floor. Jump spike pits and lava (virtual jumping), " +
        "climb stone blocks for treasure, solve the glyph floor to raise the portcullis, " +
        "then defeat the guardian: shoot its crystals, jump its shockwaves, dodge its fireballs. " +
        "Level 2, the sunken sanctum, is a two-storey maze whose walls really stop the robot: stairs, keys, doors, " +
        "switches you shoot, a lift -- and lava. Level 3 goes deeper: dart traps, a memory floor and the obsidian guardian. " +
        "Level 4, the clockwork labyrinth: three wings over the same floor, joined by portals, and rotating doors " +
        "whose switches are always in another wing. Level 5, the sky citadel: floating platforms in four tiers -- " +
        "crumbling tiles, phase tiles, a bounce pad, a lift. Level 6, the drowned cistern: push stone blocks into " +
        "water for bridges and onto plates, flame vents, and a boulder. Both have a timed gate: press the button, " +
        "then race the ticking clock. Level 7, the hall of mirrors: bend sunbeams with mirrors you shoot, jump the " +
        "beams -- and with the Sun Shield, the robot itself is a mirror. Level 8, the watchers' vault: sneak past " +
        "stone eyes and patrols, creep over gravel, ring gongs to distract them.",
      settings: [
        { key: "difficulty", label: "Difficulty", type: "select", def: "normal",
          options: [["easy", "Easy (narrow pits)"], ["normal", "Normal"], ["hard", "Hard (4x4 glyph floor, 12-glyph memory floor)"]] },
        { key: "startLevel", label: "Start at level", type: "select", def: "1",
          options: [["1", "1 -- the upper temple"], ["2", "2 -- the sunken sanctum"], ["3", "3 -- the lower temple"], ["4", "4 -- the clockwork labyrinth"], ["5", "5 -- the sky citadel"], ["6", "6 -- the drowned cistern"], ["7", "7 -- the hall of mirrors"], ["8", "8 -- the watchers' vault"]] },
        { key: "hearts", label: "Hearts", type: "number", def: 5, min: 1, max: 9, step: 1 },
        { key: "aimAssist", label: "Aim assist", type: "checkbox", def: true },
        { key: "radar", label: "Radar", type: "checkbox", def: true },
        { key: "textures", label: "Textured stone (turn off if slow)", type: "checkbox", def: true },
      ],
      boards: [{ key: "temple", title: "Temple of LynXP", better: "higher", format: "points" }],
    },
    {
      id: "knight",
      kind: "game",
      name: "Pocket Knight",
      icon: "⚔️",
      blurb:
        "A third-person sword-and-parkour adventure at 1:25 scale: you play a 7 cm knight on the floor, and the robot " +
        "follows it with its camera by itself -- about 15 cm away, from wherever it is (camera button: round behind the " +
        "knight; the look controls orbit it). Run, jump, catch ledges and climb, push crates onto plates, ride moving " +
        "platforms over chasms, strike levers -- and fight skeletons with your sword: they wind up before they strike. " +
        "Needs a clear floor of about 1.3 x 2.5 m.",
      settings: [
        { key: "difficulty", label: "Difficulty", type: "select", def: "normal",
          options: [["easy", "Easy (slow enemies)"], ["normal", "Normal"], ["hard", "Hard (more, quicker enemies)"]] },
        { key: "startLevel", label: "Start at level", type: "select", def: "1",
          options: [["1", "1 -- the ruined keep"], ["2", "2 -- the clockwork bridge"]] },
        { key: "hearts", label: "Hearts", type: "number", def: 5, min: 1, max: 9, step: 1 },
        { key: "camDistCm", label: "Camera distance", type: "number", unit: "cm", def: 15, min: 10, max: 30, step: 1 },
        { key: "textures", label: "Textured stone (turn off if slow)", type: "checkbox", def: true },
      ],
      boards: [{ key: "knight", title: "Pocket Knight", better: "higher", format: "points" }],
    },
    {
      id: "knightblocks",
      kind: "game",
      name: "Knight on Blocks",
      icon: "\u{1F9F1}",
      blurb:
        "The Pocket Knight on real blocks: cubes of any size with AprilTags (tag16h5) on their faces, each tag ID on cubes of one size (measured to the cm). " +
        "The robot finds them with its camera; the knight walks around them, jumps and climbs onto them, catches the edge " +
        "of a stack -- and the robot follows it without bumping into any block it has seen. It looks around first " +
        "if that's set (turning in place); moved blocks are noticed when the camera is still, and Rescan (in the Menu) starts over. Needs internet once (the tag detector). " +
        "Printable tags: open /tags.html on the robot.",
      settings: [
        { key: "robotRadiusCm", label: "Robot half-width (keep-out)", type: "number", unit: "cm", def: 9.5, min: 4, max: 20, step: 0.5 },
        { key: "robotRearCm", label: "Robot length behind the drive wheels", type: "number", unit: "cm", def: 18, min: 4, max: 40, step: 0.5 },
        { key: "knightCm", label: "Knight's height", type: "number", unit: "cm", def: 3, min: 2, max: 7, step: 0.5 },
        { key: "camDistCm", label: "Camera distance (zoom in the game: + / -)", type: "number", unit: "cm", def: 15, min: 10, max: 40, step: 1 },
        { key: "scan", label: "Look around at the start (turning on the spot)", type: "checkbox", def: false },
        { key: "showBlocks", label: "Show detected blocks (cyan outlines; also a switch in Overlays)", type: "checkbox", def: true },
        { key: "showTags", label: "Show tag detections (green outlines; also a switch in Overlays)", type: "checkbox", def: true },
      ],
      boards: [],
    },
    {
      id: "race",
      kind: "game",
      name: "Time Trial",
      icon: "\u{1F3C1}",
      blurb:
        "Race through a course of gates laid out around you, against the clock -- and against a ghost " +
        "replay of your own best lap.",
      settings: [
        { key: "course", label: "Course", type: "select", def: "oval",
          options: [["oval", "Oval"], ["eight", "Figure eight"], ["slalom", "Slalom"], ["star", "Star"]] },
        { key: "sizeM", label: "Course size", type: "number", unit: "m", def: 1.5, min: 0.5, max: 6, step: 0.25 },
        { key: "laps", label: "Laps", type: "number", def: 3, min: 1, max: 10, step: 1 },
        { key: "gateWidthM", label: "Gate width", type: "number", unit: "m", def: 0.45, min: 0.2, max: 1.5, step: 0.05 },
        { key: "ghost", label: "Ghost of best lap", type: "checkbox", def: true },
        { key: "radar", label: "Radar", type: "checkbox", def: true },
      ],
      boards: [
        { key: "race_oval", title: "Time Trial -- Oval", better: "lower", format: "time" },
        { key: "race_eight", title: "Time Trial -- Figure eight", better: "lower", format: "time" },
        { key: "race_slalom", title: "Time Trial -- Slalom", better: "lower", format: "time" },
        { key: "race_star", title: "Time Trial -- Star", better: "lower", format: "time" },
      ],
    },
    {
      id: "scavenger",
      kind: "game",
      name: "Scavenger Hunt",
      icon: "\u{1F50E}",
      blurb:
        "The robot names a real object -- a cup, a chair, a book... -- and you race to find one and point " +
        "the camera at it. Recognised live with YOLOv8, so it needs the detection model installed (below).",
      needsModel: true,
      settings: [
        { key: "rounds", label: "Objects per game", type: "number", def: 5, min: 1, max: 20, step: 1 },
        { key: "secondsPerItem", label: "Time per object", type: "number", unit: "s", def: 60, min: 10, max: 300, step: 5 },
        { key: "confidence", label: "Required confidence", type: "number", def: 0.5, min: 0.2, max: 0.95, step: 0.05 },
        { key: "objects", label: "Objects to hunt for", type: "classes", def: "bottle,cup,chair,book,potted plant,cell phone,remote,laptop,teddy bear,bowl,keyboard,backpack",
          options: COCO_HOME_CLASSES },
      ],
      boards: [{ key: "scavenger", title: "Scavenger Hunt", better: "higher", format: "points" }],
    },
    {
      id: "monster_hunt",
      kind: "game",
      name: "Monster hunt",
      icon: "\u{1F7E2}",
      blurb: "The original: green monsters roam around the robot; fling fireballs at them. Relaxed, no score.",
      settings: [
        { key: "fireballSpeedMps", label: "Fireball speed", type: "number", unit: "m/s", def: 0.5, min: 0.05, max: 5, step: 0.05 },
        { key: "monsterSpeedMps", label: "Monster speed", type: "number", unit: "m/s", def: 0.1, min: 0.01, max: 2, step: 0.01 },
        { key: "monsterCount", label: "Monsters", type: "number", def: 2, min: 0, max: 10, step: 1 },
        { key: "monsterLegDistanceM", label: "Monster leg distance", type: "number", unit: "m", def: 1, min: 0.05, max: 10, step: 0.05 },
      ],
      boards: [],
    },
    {
      id: "focus",
      kind: "app",
      name: "Focus check",
      icon: "\u{1F50E}",
      blurb:
        "Shows how sharp the camera's picture is, live, for turning the lens to its best focus: a sharpness number " +
        "with the best so far and a graph, the sharpness of 3 x 3 regions (is it even over the picture?), and a " +
        "magnified center. Keep the camera still with a fixed, detailed target in view (the calibration board is ideal).",
      settings: [],
    },
    {
      id: "camcal",
      kind: "app",
      name: "Camera calibration",
      icon: "\u{1F4D0}",
      blurb:
        "Calibrates the camera's lens (focal length, optical center, distortion) from photos of a calibration target: " +
        "a checkerboard (the more accurate) or an AprilGrid (Kalibr layout). Put the target upright, e.g. on a wall near the floor, with the robot in front of it: " +
        "the robot drives a tour around it and photographs it so it lands all over the picture, then fits the lens. " +
        "Save stores it for the current camera resolution. Needs internet once (the tag detector).",
      settings: [
        { key: "calibrate", label: "Calibrate", type: "select", def: "intrinsics", options: [["intrinsics", "The lens (intrinsics)"], ["extrinsics", "Camera on the robot (extrinsics: checkerboard + the frame cube on the floor)"]] },
        { key: "target", label: "Calibration target", type: "select", def: "aprilgrid", options: [["aprilgrid", "AprilGrid (Kalibr)"], ["checkerboard", "Checkerboard"]] },
        { key: "checkerCols", label: "Checkerboard: inner corners across (targetCols)", type: "number", def: 13, min: 2, max: 40, step: 1 },
        { key: "checkerRows", label: "Checkerboard: inner corners down (targetRows)", type: "number", def: 14, min: 2, max: 40, step: 1 },
        { key: "checkerSquareMm", label: "Checkerboard: square size", type: "number", unit: "mm", def: 20, min: 2, max: 200, step: 0.1 },
        { key: "tagFamily", label: "AprilGrid: tag family", type: "select", def: "tag36h11", options: [["tag36h11", "tag36h11 (Kalibr's AprilGrid)"], ["tag16h5", "tag16h5"]] },
        { key: "tagCols", label: "AprilGrid: tags across (tagCols)", type: "number", def: 6, min: 2, max: 20, step: 1 },
        { key: "tagRows", label: "AprilGrid: tags down (tagRows)", type: "number", def: 6, min: 2, max: 20, step: 1 },
        { key: "tagSizeMm", label: "AprilGrid: tag size (black square, tagSize)", type: "number", unit: "mm", def: 34, min: 5, max: 300, step: 0.1 },
        { key: "tagSpacing", label: "AprilGrid: gap between tags, as a share of the tag size (tagSpacing)", type: "number", def: 0.3, min: 0, max: 2, step: 0.01 },
      ],
    },
    {
      id: "detect",
      kind: "app",
      name: "Object detection",
      icon: "\u{1F9E0}",
      blurb:
        "Live YOLOv8 object detection on the camera feed (80 everyday object types), running on this " +
        "phone/computer. Optionally turns the camera to follow an object.",
      needsModel: true,
      settings: [
        { key: "confidence", label: "Minimum confidence", type: "number", def: 0.4, min: 0.05, max: 0.95, step: 0.05 },
        { key: "inputSize", label: "Model resolution", type: "select", def: "320",
          options: [["256", "256 px (fastest)"], ["320", "320 px"], ["416", "416 px"], ["512", "512 px (most accurate)"]] },
        { key: "maxFps", label: "Max detections per second", type: "number", def: 8, min: 1, max: 30, step: 1 },
        { key: "classes", label: "Only show", type: "classes", def: "", options: null, hint: "empty = all 80 classes" },
        { key: "follow", label: "Follow with camera", type: "select", def: "",
          options: [["", "Off"], ["person", "person"], ["cat", "cat"], ["dog", "dog"], ["sports ball", "sports ball"],
            ["cup", "cup"], ["bottle", "bottle"], ["teddy bear", "teddy bear"]] },
      ],
      boards: [],
    },
  ];

  Lynx.GENERAL_SETTINGS = [
    { key: "volume", label: "Sound volume", type: "number", def: 0.6, min: 0, max: 1, step: 0.1 },
    // on: the camera page's overlays and games turn/tilt with your controls,
    // delayed to match the video (smooth, steady aim); off: they follow the
    // camera servos' measured angles, which arrive only 10x a second
    { key: "smoothAim", label: "Smooth aim (overlays and games turn with your controls)", type: "checkbox", def: true },
    // AprilTag cubes (Free drive's cube detection, Knight on Blocks; see tagblocks.js)
    { key: "tagFamily", label: "AprilTag family on the cubes", type: "select", def: "tag16h5", options: [["tag16h5", "tag16h5 (30 ids, big cells: far)"], ["tag36h11", "tag36h11 (587 ids)"]] },
    { key: "tagPercent", label: "Tag size (black square) as a share of a cube face", type: "number", unit: "%", def: 75, min: 30, max: 95, step: 1 },
    { key: "frameCubeMm", label: "World-frame cube size (tags 24-29)", type: "number", unit: "mm", def: 40, min: 10, max: 200, step: 1 },
  ];

  Lynx.findEntry = (id) => Lynx.CATALOG.find((e) => e.id === id) || Lynx.CATALOG[0];

  function defaultsFor(schema) {
    const out = {};
    schema.forEach((s) => (out[s.key] = s.def));
    return out;
  }

  // Merges whatever the robot has stored over the schema defaults, so a
  // setting added in a later update just shows up with its default.
  function withDefaults(stored) {
    const s = stored && typeof stored === "object" ? stored : {};
    const out = { active: typeof s.active === "string" ? s.active : "none", general: Object.assign(defaultsFor(Lynx.GENERAL_SETTINGS), s.general) };
    if (!Lynx.CATALOG.some((e) => e.id === out.active)) out.active = "none";
    Lynx.CATALOG.forEach((e) => (out[e.id] = Object.assign(defaultsFor(e.settings), s[e.id])));
    return out;
  }

  Lynx.loadAppSettings = () =>
    fetch("/appdata/settings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}))
      .then(withDefaults);

  Lynx.saveAppSettings = (settings) =>
    fetch("/appdata/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
      });

  // -- scores ------------------------------------------------------------------
  // {boardKey: [{n: name, s: score, d: "YYYY-MM-DD"}...]}, best first, top
  // SCORES_PER_BOARD kept. Kept small on purpose: the whole document lives in
  // a 4 KB NVS blob next to the settings.
  const SCORES_PER_BOARD = 5;

  Lynx.loadScores = () =>
    fetch("/appdata/scores", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : {}))
      .catch(() => ({}));

  Lynx.findBoard = (key) => {
    for (const e of Lynx.CATALOG) for (const b of e.boards || []) if (b.key === key) return b;
    return { key, title: key, better: "higher", format: "points" };
  };

  Lynx.formatScore = (board, s) => {
    if (board.format === "time") {
      const ms = Math.max(0, Math.round(s));
      const m = Math.floor(ms / 60000);
      const sec = ((ms % 60000) / 1000).toFixed(2).padStart(5, "0");
      return m > 0 ? `${m}:${sec}` : `${(ms / 1000).toFixed(2)} s`;
    }
    return String(Math.round(s));
  };

  // Resolves to the 1-based rank achieved, or 0 if it didn't make the board.
  Lynx.submitScore = (boardKey, score) =>
    Lynx.loadScores().then((all) => {
      const board = Lynx.findBoard(boardKey);
      const list = Array.isArray(all[boardKey]) ? all[boardKey] : [];
      const entry = { n: Lynx.playerName(), s: Math.round(score), d: new Date().toISOString().slice(0, 10) };
      list.push(entry);
      list.sort((a, b) => (board.better === "lower" ? a.s - b.s : b.s - a.s));
      all[boardKey] = list.slice(0, SCORES_PER_BOARD);
      const rank = all[boardKey].indexOf(entry) + 1;
      if (rank === 0) return 0;
      return fetch("/appdata/scores", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(all) })
        .then(() => rank)
        .catch(() => 0);
    });

  Lynx.bestScore = (boardKey) =>
    Lynx.loadScores().then((all) => (Array.isArray(all[boardKey]) && all[boardKey].length ? all[boardKey][0].s : null));

  // Per device, not per robot: whoever's holding this phone.
  Lynx.playerName = () => {
    try {
      return (localStorage.getItem("lynxPlayerName") || "Player").slice(0, 12);
    } catch (e) {
      return "Player";
    }
  };
  Lynx.setPlayerName = (name) => {
    try {
      localStorage.setItem("lynxPlayerName", String(name).trim().slice(0, 12) || "Player");
    } catch (e) {
      // private mode etc. -- just stays "Player"
    }
  };

  // -- sound ------------------------------------------------------------------
  // All effects synthesized on the fly. The AudioContext can only start from
  // a user gesture, so Lynx.sfx.unlock() is called from the first key press,
  // tap or fire.
  const sfx = { volume: 0.6 };
  let audio = null;
  let noiseBuffer = null;

  sfx.unlock = () => {
    try {
      if (!audio) {
        audio = new (window.AudioContext || window.webkitAudioContext)();
        noiseBuffer = audio.createBuffer(1, audio.sampleRate, audio.sampleRate);
        const d = noiseBuffer.getChannelData(0);
        for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      }
      if (audio.state === "suspended") audio.resume();
    } catch (e) {
      audio = null; // no WebAudio -- silently no sound
    }
  };

  function envGain(t0, attack, hold, release, peak) {
    const g = audio.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(peak * sfx.volume, 0.0002), t0 + attack);
    g.gain.setValueAtTime(Math.max(peak * sfx.volume, 0.0002), t0 + attack + hold);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + hold + release);
    g.connect(audio.destination);
    return g;
  }

  function noise(t0, dur, filterType, freq, q, peak, freqEnd) {
    const src = audio.createBufferSource();
    src.buffer = noiseBuffer;
    const f = audio.createBiquadFilter();
    f.type = filterType;
    f.frequency.setValueAtTime(freq, t0);
    if (freqEnd) f.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    f.Q.value = q;
    src.connect(f);
    f.connect(envGain(t0, 0.004, dur * 0.2, dur * 0.8, peak));
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.05);
  }

  function tone(t0, type, freq, freqEnd, dur, peak) {
    const o = audio.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (freqEnd) o.frequency.exponentialRampToValueAtTime(freqEnd, t0 + dur);
    o.connect(envGain(t0, 0.005, dur * 0.3, dur * 0.7, peak));
    o.start(t0);
    o.stop(t0 + dur + 0.05);
  }

  const EFFECTS = {
    pistol: (t) => { noise(t, 0.18, "lowpass", 3000, 0.7, 0.8, 400); tone(t, "square", 180, 60, 0.08, 0.25); },
    shotgun: (t) => { noise(t, 0.45, "lowpass", 2200, 0.5, 1.0, 150); tone(t, "sawtooth", 110, 40, 0.18, 0.4); },
    chaingun: (t) => { noise(t, 0.09, "bandpass", 1800, 1, 0.7); tone(t, "square", 220, 90, 0.05, 0.2); },
    click: (t) => tone(t, "square", 900, 700, 0.03, 0.2),
    fireball: (t) => noise(t, 0.6, "bandpass", 500, 2, 0.5, 1400),
    explode: (t) => { noise(t, 0.7, "lowpass", 1500, 0.8, 0.9, 80); tone(t, "sine", 90, 30, 0.4, 0.5); },
    hurt: (t) => { tone(t, "sawtooth", 160, 70, 0.3, 0.5); noise(t, 0.2, "lowpass", 800, 1, 0.4); },
    pain: (t) => tone(t, "sawtooth", 420, 180, 0.25, 0.35),
    die: (t) => { tone(t, "sawtooth", 300, 40, 0.9, 0.45); noise(t + 0.1, 0.6, "lowpass", 900, 1, 0.35, 100); },
    growl: (t) => { tone(t, "sawtooth", 70, 55, 0.6, 0.3); noise(t, 0.5, "bandpass", 300, 3, 0.25); },
    pickup: (t) => { tone(t, "square", 660, null, 0.07, 0.25); tone(t + 0.07, "square", 990, null, 0.1, 0.25); },
    coin: (t) => { tone(t, "square", 988, null, 0.06, 0.22); tone(t + 0.06, "square", 1319, null, 0.14, 0.22); },
    power: (t) => { for (let i = 0; i < 6; i++) tone(t + i * 0.06, "square", 400 + i * 120, null, 0.06, 0.2); },
    eat: (t) => tone(t, "square", 200, 1600, 0.25, 0.3),
    lose: (t) => { for (let i = 0; i < 5; i++) tone(t + i * 0.12, "triangle", 500 - i * 70, 300 - i * 50, 0.12, 0.35); },
    gate: (t) => { tone(t, "triangle", 880, null, 0.08, 0.3); tone(t + 0.08, "triangle", 1175, null, 0.12, 0.3); },
    beep: (t) => tone(t, "square", 660, null, 0.15, 0.3),
    go: (t) => tone(t, "square", 1320, null, 0.4, 0.35),
    found: (t) => { [523, 659, 784, 1047].forEach((f, i) => tone(t + i * 0.08, "triangle", f, null, 0.12, 0.35)); },
    fail: (t) => tone(t, "sawtooth", 220, 110, 0.4, 0.3),
    // David
    squirt: (t) => { noise(t, 0.14, "bandpass", 2500, 2, 0.5, 900); tone(t, "sine", 700, 350, 0.06, 0.15); },
    laser: (t) => tone(t, "square", 1600, 300, 0.14, 0.25),
    zap: (t) => { tone(t, "sawtooth", 1200, 200, 0.08, 0.2); noise(t, 0.06, "highpass", 3000, 1, 0.3); },
    rainbow: (t) => { [523, 659, 784, 1047, 1319].forEach((f, i) => tone(t + i * 0.03, "triangle", f, f * 1.5, 0.12, 0.2)); noise(t, 0.4, "lowpass", 1200, 0.8, 0.5, 100); },
    knock: (t) => { noise(t, 0.08, "lowpass", 700, 1, 0.7); tone(t, "sine", 180, 90, 0.06, 0.3); },
    crate: (t) => { noise(t, 0.35, "lowpass", 900, 0.8, 0.9, 120); tone(t, "square", 140, 60, 0.12, 0.3); },
    boing: (t) => tone(t, "sine", 180, 520, 0.18, 0.35),
    // a clock: tick and tock alternate (the Temple's timed gates)
    tick: (t) => { tone(t, "square", 2400, 1800, 0.025, 0.18); noise(t, 0.02, "highpass", 4000, 1, 0.2); },
    tock: (t) => { tone(t, "square", 1500, 1100, 0.03, 0.18); noise(t, 0.025, "highpass", 2500, 1, 0.2); },
    // the Temple's watchers' vault: a gong, gravel underfoot, an eye that's seen you, the alarm
    gong: (t) => { [196, 293, 415].forEach((f, i) => tone(t, "sine", f, f * 0.98, 1.6 - i * 0.3, 0.3 - i * 0.07)); noise(t, 0.12, "bandpass", 1200, 2, 0.4); },
    crunch: (t) => noise(t, 0.09, "bandpass", 2600, 1.5, 0.35, 900),
    suspect: (t) => tone(t, "triangle", 520, 780, 0.18, 0.25),
    alarm: (t) => { for (let i = 0; i < 4; i++) tone(t + i * 0.16, "square", i % 2 ? 660 : 880, null, 0.14, 0.28); },
    jump: (t) => tone(t, "square", 300, 900, 0.16, 0.2),
    levelup: (t) => { [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone(t + i * 0.1, "square", f, null, 0.1, 0.22)); },
    // Short, original chugging riff for a new wave.
    wave: (t) => {
      const notes = [82, 82, 165, 82, 82, 147, 82, 82, 131, 82, 123, 110];
      notes.forEach((f, i) => { tone(t + i * 0.11, "sawtooth", f, null, 0.1, 0.3); tone(t + i * 0.11, "square", f * 2, null, 0.08, 0.1); });
    },
  };

  sfx.play = (name) => {
    if (!audio || !EFFECTS[name] || sfx.volume <= 0) return;
    try {
      EFFECTS[name](audio.currentTime + 0.01);
    } catch (e) {
      // ignore -- a missed sound effect isn't worth breaking a game loop over
    }
  };

  Lynx.sfx = sfx;
  Lynx.COCO_HOME_CLASSES = COCO_HOME_CLASSES;

  // YOLOv8's 80 COCO classes, in model output order.
  Lynx.COCO_CLASSES = [
    "person", "bicycle", "car", "motorcycle", "airplane", "bus", "train", "truck", "boat", "traffic light",
    "fire hydrant", "stop sign", "parking meter", "bench", "bird", "cat", "dog", "horse", "sheep", "cow",
    "elephant", "bear", "zebra", "giraffe", "backpack", "umbrella", "handbag", "tie", "suitcase", "frisbee",
    "skis", "snowboard", "sports ball", "kite", "baseball bat", "baseball glove", "skateboard", "surfboard",
    "tennis racket", "bottle", "wine glass", "cup", "fork", "knife", "spoon", "bowl", "banana", "apple",
    "sandwich", "orange", "broccoli", "carrot", "hot dog", "pizza", "donut", "cake", "chair", "couch",
    "potted plant", "bed", "dining table", "toilet", "tv", "laptop", "mouse", "remote", "keyboard",
    "cell phone", "microwave", "oven", "toaster", "sink", "refrigerator", "book", "clock", "vase",
    "scissors", "teddy bear", "hair drier", "toothbrush",
  ];

  const EMOJI = {
    person: "\u{1F9CD}", bottle: "\u{1F37E}", cup: "☕", chair: "\u{1FA91}", couch: "\u{1F6CB}️",
    "potted plant": "\u{1FAB4}", bed: "\u{1F6CF}️", "dining table": "\u{1F37D}️", tv: "\u{1F4FA}",
    laptop: "\u{1F4BB}", mouse: "\u{1F5B1}️", remote: "\u{1F4F1}", keyboard: "⌨️",
    "cell phone": "\u{1F4F1}", book: "\u{1F4D6}", clock: "\u{1F570}️", vase: "\u{1F3FA}", scissors: "✂️",
    "teddy bear": "\u{1F9F8}", backpack: "\u{1F392}", umbrella: "☂️", handbag: "\u{1F45C}",
    "sports ball": "⚽", banana: "\u{1F34C}", apple: "\u{1F34E}", orange: "\u{1F34A}", bowl: "\u{1F963}",
    toothbrush: "\u{1FAA5}", "wine glass": "\u{1F377}", fork: "\u{1F374}", knife: "\u{1F52A}", spoon: "\u{1F944}",
    cat: "\u{1F408}", dog: "\u{1F415}",
  };
  Lynx.emojiFor = (cls) => EMOJI[cls] || "\u{1F4E6}";

  // -- camera lens model ---------------------------------------------------------
  // Shared by every camera-page overlay (floor grid, axes, waypoints,
  // fireballs, AR games). The camera has a wide, strongly barrel-distorted
  // lens, calibrated per resolution (tools/calibrate.py, or the Camera
  // calibration app with an AprilGrid: app_camcal.js) into the robot's
  // /appdata/camcal document: a direction at angle theta off the optical axis
  // lands fPx * (theta + k1 theta^3 + k2 theta^5) pixels from the optical
  // center (cx, cy; the image center unless calibrated) (k1 = 0 is an
  // equidistant fisheye; a pinhole is roughly k1 = 1/3). Resolutions without
  // a calibration fall back to a pinhole with the robot's
  // cameraVerticalFovDeg setting.
  const lensModes = {}; // "640x480" -> {fPx, k1, k2?, cx?, cy?}
  let fallbackVfovRad = (65 * Math.PI) / 180;

  Lynx.lens = {
    setCalibration(camcal, vfovDeg) {
      if (camcal && camcal.version >= 2 && camcal.modes) Object.assign(lensModes, camcal.modes);
      if (Number.isFinite(vfovDeg)) fallbackVfovRad = (vfovDeg * Math.PI) / 180;
    },
    // {f, k1, k2, cx, cy} for this frame size; k1 null = plain pinhole.
    params(imgW, imgH) {
      const m = lensModes[`${imgW}x${imgH}`];
      const c = { cx: imgW / 2, cy: imgH / 2, k2: 0 };
      if (m && m.fPx > 0) return { ...c, f: m.fPx, k1: m.k1, k2: m.k2 || 0, cx: Number.isFinite(m.cx) ? m.cx : c.cx, cy: Number.isFinite(m.cy) ? m.cy : c.cy };
      return { ...c, f: imgH / 2 / Math.tan(fallbackVfovRad / 2), k1: null };
    },
    calibrated(imgW, imgH) {
      return !!lensModes[`${imgW}x${imgH}`];
    },
    // Camera-frame point (x right, y down, z forward, any unit) -> image
    // pixel coordinates, or null when it's not in front of the camera.
    // scale = local pixels per unit of x/z (for sizing things at that depth).
    project(x, y, z, imgW, imgH) {
      if (!(z > 1e-6)) return null;
      const { f, k1, k2, cx, cy } = Lynx.lens.params(imgW, imgH);
      const xn = x / z;
      const yn = y / z;
      let s = 1;
      if (k1 !== null) {
        const r = Math.hypot(xn, yn);
        if (r > 1e-9) {
          const th = Math.atan(r);
          const th2 = th * th;
          s = (th * (1 + k1 * th2 + k2 * th2 * th2)) / r;
        }
      }
      return { u: cx + f * xn * s, v: cy + f * yn * s, scale: f * s };
    },
    // Image pixel -> the direction it sees, as pinhole coordinates at z = 1
    // ([x right, y down]).
    normalize(u, v, imgW, imgH) {
      const { cx, cy } = Lynx.lens.params(imgW, imgH);
      const dx = u - cx;
      const dy = v - cy;
      const rp = Math.hypot(dx, dy);
      if (rp < 1e-9) return [0, 0];
      const rn = Math.tan(Lynx.lens.angleAt(rp, imgW, imgH));
      return [(dx / rp) * rn, (dy / rp) * rn];
    },
    // Angle off the optical axis (rad) of a point `px` pixels from the optical
    // center -- e.g. the half field of view at an image edge.
    angleAt(px, imgW, imgH) {
      const { f, k1, k2 } = Lynx.lens.params(imgW, imgH);
      const rd = Math.abs(px) / f;
      if (k1 === null) return Math.atan(rd);
      let th = rd;
      for (let i = 0; i < 20; i++) {
        const th2 = th * th;
        th -= (th * (1 + k1 * th2 + k2 * th2 * th2) - rd) / (1 + 3 * k1 * th2 + 5 * k2 * th2 * th2);
      }
      return Math.min(th, 1.5);
    },
  };
})(window.Lynx);
