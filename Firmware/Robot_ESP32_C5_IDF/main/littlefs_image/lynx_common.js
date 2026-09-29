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
        "Level 2 goes deeper: dart traps, a memory floor and the obsidian guardian.",
      settings: [
        { key: "difficulty", label: "Difficulty", type: "select", def: "normal",
          options: [["easy", "Easy (narrow pits)"], ["normal", "Normal"], ["hard", "Hard (4x4 glyph floor)"]] },
        { key: "startLevel", label: "Start at level", type: "select", def: "1",
          options: [["1", "1 -- the upper temple"], ["2", "2 -- the lower temple"]] },
        { key: "hearts", label: "Hearts", type: "number", def: 5, min: 1, max: 9, step: 1 },
        { key: "aimAssist", label: "Aim assist", type: "checkbox", def: true },
        { key: "radar", label: "Radar", type: "checkbox", def: true },
      ],
      boards: [{ key: "temple", title: "Temple of LynXP", better: "higher", format: "points" }],
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
  // lens, calibrated per resolution by tools/calibrate.py into the robot's
  // /appdata/camcal document: a direction at angle theta off the optical axis
  // lands fPx * (theta + k1 theta^3) pixels from the image center (k1 = 0 is
  // an equidistant fisheye; a pinhole is roughly k1 = 1/3). Resolutions
  // without a calibration fall back to a pinhole with the robot's
  // cameraVerticalFovDeg setting.
  const lensModes = {}; // "640x480" -> {fPx, k1}
  let fallbackVfovRad = (65 * Math.PI) / 180;

  Lynx.lens = {
    setCalibration(camcal, vfovDeg) {
      if (camcal && camcal.version >= 2 && camcal.modes) Object.assign(lensModes, camcal.modes);
      if (Number.isFinite(vfovDeg)) fallbackVfovRad = (vfovDeg * Math.PI) / 180;
    },
    // {f, k1} for this frame size; k1 null = plain pinhole.
    params(imgW, imgH) {
      const m = lensModes[`${imgW}x${imgH}`];
      if (m && m.fPx > 0) return { f: m.fPx, k1: m.k1 };
      return { f: imgH / 2 / Math.tan(fallbackVfovRad / 2), k1: null };
    },
    calibrated(imgW, imgH) {
      return !!lensModes[`${imgW}x${imgH}`];
    },
    // Camera-frame point (x right, y down, z forward, any unit) -> image
    // pixel coordinates, or null when it's not in front of the camera.
    // scale = local pixels per unit of x/z (for sizing things at that depth).
    project(x, y, z, imgW, imgH) {
      if (!(z > 1e-6)) return null;
      const { f, k1 } = Lynx.lens.params(imgW, imgH);
      const xn = x / z;
      const yn = y / z;
      let s = 1;
      if (k1 !== null) {
        const r = Math.hypot(xn, yn);
        if (r > 1e-9) {
          const th = Math.atan(r);
          s = (th + k1 * th * th * th) / r;
        }
      }
      return { u: imgW / 2 + f * xn * s, v: imgH / 2 + f * yn * s, scale: f * s };
    },
    // Angle off the optical axis (rad) of a point `px` pixels from the image
    // center -- e.g. the half field of view at an image edge.
    angleAt(px, imgW, imgH) {
      const { f, k1 } = Lynx.lens.params(imgW, imgH);
      const rd = Math.abs(px) / f;
      if (k1 === null) return Math.atan(rd);
      let th = rd;
      for (let i = 0; i < 20; i++) th -= (th + k1 * th * th * th - rd) / (1 + 3 * k1 * th * th);
      return th;
    },
  };
})(window.Lynx);
