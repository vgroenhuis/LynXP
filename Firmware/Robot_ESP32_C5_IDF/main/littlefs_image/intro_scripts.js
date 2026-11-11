// The games' introductions (played by intro.js; the step format is described there).
// Text: [English, Dutch] -- kept here, next to the film it belongs to, rather
// than in nl.js. Coordinates: f m ahead, r m to the right of where the robot
// stood when the intro began, h m up; angles in degrees, positive = left.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const I = (Lynx.intros = Lynx.intros || {});
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
  const snap = (ctx) => (ctx.game && ctx.game.snapshot ? ctx.game.snapshot() : {}) || {};

  // -- helpers for the scripts -------------------------------------------------------
  // First person: turn toward the nearest of some world points ({x, y}), and
  // creep closer (or back off) to keep `keep` m away
  function hunt(pick, keep = 0.8, speed = 0.5) {
    return (t, ctx) => {
      const p = ctx.pose;
      const list = (pick(ctx) || []).filter((e) => e && isFinite(e.x));
      if (!list.length) return { rot: 35 };
      let best = list[0];
      let bd = Infinity;
      list.forEach((e) => {
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        if (d < bd) [best, bd] = [e, d];
      });
      const err = wrap(Math.atan2(best.y - p.y, best.x - p.x) - p.theta);
      const rot = Math.max(-80, Math.min(80, (err * 180) / Math.PI * 2.5));
      const j2 = Math.abs(err) < 0.6 ? Math.max(-speed, Math.min(speed, (bd - keep) * 2)) : 0;
      return { rot, j2 };
    };
  }
  // Third person (Pocket Knight, Knight on Blocks): the hero in the world, for the chase camera
  function hero(ctx) {
    const d = ctx.game && ctx.game.debug;
    if (!d || !d.hero || !d.world) return null;
    const h = d.hero();
    const w = d.world();
    const p = w.toWorld(h.f, h.r);
    return { x: p.x, y: p.y, h: h.z, yaw: w.anchor().th - h.yaw };
  }
  // the third-person hero's stick, turned to head for a point of the intro's frame
  function steer(f, r, speed = 0.8) {
    return (t, ctx) => {
      const g = hero(ctx);
      if (!g) return [0, speed];
      const w = ctx.toWorld(f, r);
      const want = Math.atan2(w.y - g.y, w.x - g.x);
      // the stick is the camera's: up = the way the view looks
      const view = ctx.ar.camTheta;
      const a = wrap(want - view);
      const dist = Math.hypot(w.x - g.x, w.y - g.y);
      const s = dist < 0.02 ? 0 : speed;
      return [-Math.sin(a) * s, Math.cos(a) * s];
    };
  }
  const every = (t0, t1, dt, what) => {
    const out = [];
    for (let t = t0; t <= t1 + 1e-6; t += dt) out.push([t, what]);
    return out;
  };

  // -- first-person shooters -----------------------------------------------------------
  I.demons = {
    steps: [
      {
        say: ["Doom, in your own room. Demons come at you from every side, and the robot is you.", "Doom, in je eigen kamer. Demonen komen van alle kanten op je af, en de robot ben jij."],
        cam: { orbit: [0, 0, 0.1], radius: 2.6, height: 1.6, from: -30, to: 30 },
      },
      {
        say: ["Drive with the left stick or W A S D, look round with the right stick or the arrow keys.", "Rijd met de linkerstick of W A S D, kijk rond met de rechterstick of de pijltjestoetsen."],
        cam: { behind: 0.55, height: 0.4, ahead: 0.7 },
        drive: (t) => ({ j2: 0.6, rot: t < 2.5 ? 30 : -30 }),
      },
      {
        say: ["Imps, pinkies and cacodemons close in. Aim at them and fire: Z, Space, or the trigger.", "Imps, pinkies en cacodemonen komen dichterbij. Richt op ze en vuur: Z, spatie of de trekker."],
        cam: "player",
        drive: hunt((ctx) => snap(ctx).enemies, 1.0),
        fireHeld: [1.0, 99],
      },
      {
        say: ["Switch weapons with 1 to 7, Tab, or the shoulder buttons. New weapons lie on the floor in later waves.", "Wissel van wapen met 1 tot 7, Tab of de schouderknoppen. In latere golven liggen er nieuwe wapens op de vloer."],
        cam: "player",
        drive: hunt((ctx) => snap(ctx).enemies, 1.0),
        at: [[0.8, "weapon", "next"], [3.5, "weapon", "next"]],
        fireHeld: [0.5, 99],
      },
      {
        say: ["Fireballs are real too: dodge them by driving out of the way. Drive over health and ammo to pick them up.", "Vuurballen zijn ook echt: ontwijk ze door opzij te rijden. Rijd over gezondheid en munitie om ze op te pakken."],
        cam: { behind: 0.7, height: 0.55, ahead: 0.5, side: 0.25 },
        drive: (t) => ({ j1: t < 2 ? 0.8 : -0.8, j2: 0.2, rot: 10 }),
      },
      {
        say: ["The radar shows where they come from. Press Fire to start. Rip and tear!", "De radar laat zien waar ze vandaan komen. Druk op Vuur om te beginnen. Rip and tear!"],
        cam: { orbit: [0, 0, 0.1], radius: 2.2, height: 1.8, from: 40, to: 80 },
      },
    ],
  };

  I.david = {
    steps: [
      {
        say: ["David: monsters, crates and a lot of weapons, on your floor.", "David: monsters, kratten en een hoop wapens, op jouw vloer."],
        cam: { orbit: [0, 0, 0.05], radius: 2.4, height: 1.5, from: -30, to: 20 },
      },
      {
        say: ["Drive with the left stick or W A S D, and look round with the right stick or the arrows.", "Rijd met de linkerstick of W A S D, en kijk rond met de rechterstick of de pijltjes."],
        cam: { behind: 0.55, height: 0.4, ahead: 0.7 },
        drive: (t) => ({ j2: 0.5, rot: t < 2 ? 35 : -25 }),
      },
      {
        say: ["Shoot the crates open. The golden crate always holds a new weapon.", "Schiet de kratten open. In de gouden krat zit altijd een nieuw wapen."],
        cam: "player",
        drive: hunt((ctx) => (snap(ctx).crates || []).filter((c) => !c.open), 0.7),
        fireHeld: [1.2, 99],
      },
      {
        say: ["Monsters come for you. Fire with Z, Space or the trigger; hold X or B to raise your shield.", "Monsters komen op je af. Vuur met Z, spatie of de trekker; houd X of B ingedrukt voor je schild."],
        cam: "player",
        drive: hunt((ctx) => snap(ctx).monsters, 0.9),
        fireHeld: [0.5, 3.5],
        shield: [3.6, 6],
      },
      {
        say: ["Water pistol, sword, bow, laser, bombs, lightning: pick your weapon with 1 to 8 or Tab.", "Waterpistool, zwaard, boog, laser, bommen, bliksem: kies je wapen met 1 tot 8 of Tab."],
        cam: { behind: 0.6, height: 0.45, ahead: 0.6, side: -0.2 },
        drive: hunt((ctx) => (snap(ctx).monsters || []).concat((snap(ctx).crates || []).filter((c) => !c.open)), 0.8),
        fireHeld: [0.5, 99],
      },
      {
        say: ["Beat the monsters to clear the level. Press Fire to start!", "Versla de monsters om het level te halen. Druk op Vuur om te beginnen!"],
        cam: { orbit: [0, 0, 0.05], radius: 2.2, height: 1.7, from: 30, to: 70 },
      },
    ],
  };

  I.poop = {
    steps: [
      {
        say: ["Poop Shooter! Poops crawl toward you, and long stone walls stand in the way.", "Poepschieter! Poepjes kruipen naar je toe, en er staan lange stenen muren in de weg."],
        cam: { orbit: [0, 0, 0.05], radius: 2.4, height: 1.5, from: -40, to: 10 },
      },
      {
        say: ["The walls stop the poops, your shots, and the robot too: drive round them for a clear shot.", "De muren houden de poepjes tegen, je schoten, en de robot ook: rij eromheen voor een vrij schot."],
        cam: { orbit: "player", radius: 1.1, height: 1.0, from: -30, to: 30 },
        drive: (t) => ({ j2: 0.3, rot: t < 2.5 ? -30 : 30 }),
      },
      {
        say: ["Fire with Z, Space or the trigger. The water gun first; arrows from the bow fall, so aim a bit high.", "Vuur met Z, spatie of de trekker. Eerst het waterpistool; pijlen van de boog vallen, dus mik wat hoger."],
        cam: "player",
        drive: hunt((ctx) => snap(ctx).poops, 0.9, 0), // (turn and shoot: walls all round)
        fireHeld: [0.8, 99],
        at: [[4, "weapon", 2]],
      },
      {
        say: ["The toilet brush is for up close, and bombs roll on until you fire again. Hold X or B for the toilet-lid shield.", "De wc-borstel is voor dichtbij, en bommen rollen door tot je opnieuw vuurt. Houd X of B ingedrukt voor het wc-deksel-schild."],
        cam: "player",
        drive: hunt((ctx) => snap(ctx).poops, 0.9, 0), // (turn and shoot: walls all round)
        at: [[0.2, "weapon", 1]],
        fireHeld: [0.5, 3.5],
        shield: [4, 6],
      },
      {
        say: ["Golden poops are worth a lot, and a giant one waits in levels 5 and 10. Press Fire to start!", "Gouden poepjes zijn veel waard, en in level 5 en 10 wacht een reuzenpoep. Druk op Vuur om te beginnen!"],
        cam: { orbit: [0, 0, 0.05], radius: 2.2, height: 1.7, from: 20, to: 60 },
      },
    ],
  };

  // -- floor games ----------------------------------------------------------------------
  I.coins = {
    steps: [
      {
        say: ["Pac-Man, on your own floor. Coins lie all around the robot.", "Pac-Man, op je eigen vloer. Overal rond de robot liggen munten."],
        cam: { orbit: [0, 0, 0], radius: 2.3, height: 1.4, from: -40, to: 20 },
      },
      {
        say: ["Drive over every coin to pick it up: left stick, or W A S D.", "Rijd over elke munt om hem te pakken: linkerstick, of W A S D."],
        cam: { behind: 0.5, height: 0.35, ahead: 0.6 },
        drive: { j2: 0.8, rot: 25 },
      },
      {
        say: ["Ghosts hunt you down, each in its own way. Touch one and you lose a life.", "Spoken jagen op je, elk op zijn eigen manier. Raak je er een, dan ben je een leven kwijt."],
        cam: { orbit: "player", radius: 1.3, height: 0.8, from: 20, to: 80 },
        drive: { j2: 0.6, rot: -30 },
      },
      {
        say: ["The big power coins turn the ghosts blue for a few seconds. Then you hunt them!", "De grote powermunten maken de spoken een paar seconden blauw. Dan jaag jij op hen!"],
        cam: "player",
        drive: { j2: 0.7, rot: 15 },
      },
      {
        say: ["The radar shows where everything is. Clear all coins and the next level has more ghosts.", "De radar laat zien waar alles is. Alle munten op? Dan komen er in het volgende level meer spoken."],
        cam: { behind: 0.6, height: 0.5, ahead: 0.4 },
        drive: { j2: 0.6, rot: -20 },
      },
      {
        say: ["Press Fire to start. Good luck!", "Druk op Vuur om te beginnen. Succes!"],
        cam: { orbit: [0, 0, 0], radius: 2, height: 1.6, from: 70, to: 110 },
        d: 3.5,
      },
    ],
  };

  I.sonar = {
    steps: [
      {
        say: ["Sonar: a treasure hunt with nothing to see. Gems lie buried somewhere on your floor.", "Sonar: een schattenjacht waarbij je niets ziet. Ergens in je vloer liggen edelstenen begraven."],
        cam: { orbit: [0, 0, 0], radius: 2.2, height: 1.5, from: -30, to: 20 },
      },
      {
        say: ["Listen to the pings: the closer you get to a gem, the faster and higher they sound.", "Luister naar de pings: hoe dichter je bij een edelsteen komt, hoe sneller en hoger ze klinken."],
        cam: "player",
        drive: (t) => ({ j2: 0.6, rot: Math.sin(t * 0.8) * 40 }),
      },
      {
        say: ["The hot and cold meter helps too. Drive with the left stick or W A S D.", "De warm-koud-meter helpt ook. Rijd met de linkerstick of W A S D."],
        cam: { behind: 0.5, height: 0.45, ahead: 0.5 },
        drive: (t) => ({ j2: 0.5, rot: -25 }),
      },
      {
        say: ["Hot? Press Fire to dig where you stand. But digs and time are limited, and every miss costs a dig.", "Warm? Druk op Vuur om te graven waar je staat. Maar je kunt maar een paar keer graven, de tijd loopt, en elke misser kost een schep."],
        cam: "player",
        drive: { j2: 0 },
      },
      {
        say: ["Find every gem before the time runs out. Press Fire to start!", "Vind alle edelstenen voor de tijd op is. Druk op Vuur om te beginnen!"],
        cam: { orbit: [0, 0, 0], radius: 2, height: 1.7, from: 30, to: 70 },
      },
    ],
  };

  I.echo = {
    steps: [
      {
        say: ["Echo: Simon on your floor. Four coloured pads lie round the robot, each with its own note.", "Echo: Simon zegt, op je vloer. Rond de robot liggen vier gekleurde vlakken, elk met een eigen toon."],
        cam: { orbit: [0, 0, 0], radius: 1.9, height: 1.3, from: -30, to: 30 },
      },
      {
        say: ["Watch and listen: the pads light up in a sequence.", "Kijk en luister: de vlakken lichten op in een volgorde."],
        cam: { orbit: [0, 0, 0], radius: 1.6, height: 1.4, from: 30, to: 70 },
      },
      {
        say: ["Then repeat it: drive onto the pads in the same order, and wait a moment on each.", "Doe het dan na: rij in dezelfde volgorde naar de vlakken, en blijf op elk even staan."],
        cam: { behind: 0.6, height: 0.55, ahead: 0.4 },
        drive: { to: (ctx) => {
          const d = ctx.game.debug;
          if (!d) return null;
          const seq = d.seq();
          const pads = d.pads();
          return seq.length ? pads[seq[Math.min(d.step(), seq.length - 1)]] : null;
        }, speed: 0.8 },
      },
      {
        say: ["Every round adds a step, and the playback gets faster. A wrong pad, or too slow, and it's over.", "Elke ronde komt er een stap bij, en het voordoen gaat sneller. Verkeerd vlak, of te traag, en het is voorbij."],
        cam: { orbit: "player", radius: 1.2, height: 0.9, from: 0, to: 60 },
        drive: { to: (ctx) => {
          const d = ctx.game.debug;
          if (!d) return null;
          const seq = d.seq();
          return seq.length ? d.pads()[seq[Math.min(d.step(), seq.length - 1)]] : null;
        }, speed: 0.8 },
      },
      {
        say: ["Press Fire to start!", "Druk op Vuur om te beginnen!"],
        cam: { orbit: [0, 0, 0], radius: 1.8, height: 1.5, from: 60, to: 100 },
        d: 3,
      },
    ],
  };

  // Crossing: wait on a safe strip till the road lanes up to the next strip stay clear for
  // the time spent in each (every car's motion foreseen), then drive across in one go;
  // waited too long: honk (the traffic freezes for a moment; the next look ahead counts on it)
  const CROSS_MPS = 0.3;
  // a road lane's room for the robot (m; < 0: a hit) while it drives through the lane's
  // reach, from u now (the game's own test: a car within 0.3 lanes + the robot's radius
  // along, within half its length + the robot's radius sideways); its cars shifted by off
  function laneRoom(ln, j, c, LW, fr, off = 0, lead = 0) {
    const zone = LW * 0.3 + 0.09 + 0.01;
    const tin = lead + Math.max(0, (j * LW - zone - c.u) / CROSS_MPS - 0.1);
    const tout = lead + (j * LW + zone - c.u) / CROSS_MPS + 0.1;
    let room = 1e9;
    for (let tt = tin; tt <= tout; tt += 0.05) {
      for (const car of ln.cars) {
        const moved = ln.dir * (car.v === undefined ? ln.speed : car.v) * Math.max(0, tt - fr) + off; // (each at its own speed now)
        let ds = Math.abs(c.s - (car.s + moved)) % ln.P;
        ds = Math.min(ds, ln.P - ds);
        room = Math.min(room, ds - car.len / 2 - 0.09);
      }
    }
    return room;
  }
  function crossDrive(t, ctx) {
    const d = ctx.game.debug;
    if (!d || d.state() !== "playing") return { mps: CROSS_MPS };
    const p = ctx.pose;
    const lanes = d.lanes();
    const LW = d.LW;
    const c = d.toCourse(p.x, p.y);
    const a = d.toCourse(p.x + Math.cos(p.theta), p.y + Math.sin(p.theta));
    const err = Math.atan2(a.s - c.s, a.u - c.u); // (the robot's heading, in the course)
    const rot = Math.max(-90, Math.min(90, (-err * 180) / Math.PI * 3));
    const S = (ctx.cross = ctx.cross || { go: false, to: 0, waited: 0, lastT: t });
    if (S.lanes !== lanes) {
      // a new course (the game built it just now: its traffic can be staged unseen),
      // to be crossed once the robot has turned round to it
      S.lanes = lanes;
      S.go = false;
      stageTraffic(ctx, Math.abs(err) / (Math.PI / 2) + 0.4);
    }
    if (Math.abs(err) > 0.05) return { rot, mps: CROSS_MPS }; // (straight along the course first)
    const dt = Math.max(0, Math.min(0.1, t - S.lastT));
    S.lastT = t;
    const k = Math.round(c.u / LW);
    if (S.go && c.u < S.to * LW) return { j2: 1, rot, mps: CROSS_MPS };
    S.go = false;
    if (k >= lanes.length - 1) return { rot, mps: CROSS_MPS };
    // the run of road lanes ahead, up to the next safe strip
    let to = k + 1;
    while (to < lanes.length - 1 && lanes[to].type === "road") to++;
    const fr = d.freeze();
    let clear = true;
    for (let j = k + 1; j < to && clear; j++) clear = laneRoom(lanes[j], j, c, LW, fr) > 0.03;
    S.waited += dt;
    if (!clear && S.waited > 4 && !S.honked) {
      Lynx.fireAction();
      S.honked = true;
    }
    if (clear) {
      S.go = true;
      S.to = to;
      S.waited = 0;
      S.honked = false;
    }
    return { j2: clear ? 1 : 0, rot, mps: CROSS_MPS };
  }
  // the demo's traffic: each road lane's cars shifted (all together, spacing kept) so a gap
  // passes the robot's line just while it drives through that lane, crossing in one go
  function stageTraffic(ctx, lead = 0) {
    const d = ctx.game.debug;
    if (!d || d.state() !== "playing") return;
    const p = ctx.pose;
    const c = d.toCourse(p.x, p.y);
    const fr = d.freeze();
    d.lanes().forEach((ln, j) => {
      if (ln.type !== "road" || j * d.LW < c.u) return;
      let best = 0;
      let bestRoom = -1e9;
      for (let off = 0; off < ln.P; off += 0.02) {
        const room = laneRoom(ln, j, c, d.LW, fr, off, lead);
        if (room > bestRoom) {
          bestRoom = room;
          best = off;
        }
      }
      ln.cars.forEach((car) => {
        car.s += best;
        while (car.s > ln.P / 2) car.s -= ln.P;
      });
    });
  }
  I.crossing = {
    grid: [-0.6, 3.4, -1.2, 1.2],
    steps: [
      {
        say: ["Crossing: lanes of traffic run across the floor ahead of the robot.", "Oversteken: voor de robot rijdt verkeer in rijstroken dwars over de vloer."],
        cam: { orbit: [1.4, 0, 0], radius: 2.6, height: 2.0, from: -40, to: 10 },
      },
      {
        say: ["Drive across to the far side without being run over. The sidewalks are safe: wait there for a gap.", "Rij naar de overkant zonder overreden te worden. Op de stoepen ben je veilig: wacht daar op een gat."],
        cam: { behind: 0.6, height: 0.5, ahead: 0.8 },
        drive: crossDrive,
        d: 9,
      },
      {
        say: ["Every car, truck and motorcycle drives at its own speed and keeps its distance. The yellow lines split the two directions.", "Elke auto, vrachtwagen en motor rijdt zijn eigen snelheid en houdt afstand. De gele lijnen scheiden de twee rijrichtingen."],
        cam: "player",
        drive: crossDrive,
        d: 7,
      },
      {
        say: ["Stuck? Fire honks: the traffic stops for a moment. It takes a while to recharge.", "Vast? Vuur toetert: het verkeer staat even stil. Daarna moet de toeter een tijdje opladen."],
        cam: { orbit: "player", radius: 0.9, height: 0.8, from: -30, to: 30 },
        drive: crossDrive,
      },
      {
        say: ["Over the other side, the course flips: cross back, through faster traffic. Press Fire to start!", "Aan de overkant draait het parcours om: steek terug over, door sneller verkeer. Druk op Vuur om te beginnen!"],
        cam: { orbit: [1.4, 0, 0], radius: 2.6, height: 2.2, from: 20, to: 70 },
        drive: crossDrive,
      },
    ],
  };

  // the light-cycle, for the chase camera
  const cycle = (ctx) => (ctx.game.debug && ctx.game.debug.cycle ? ctx.game.debug.cycle() : null);
  // its stick: head for a point of the intro's frame (camera-relative, as the game reads it)
  function ride(f, r) {
    return (t, ctx) => {
      const c = cycle(ctx);
      if (!c) return [0, 0];
      const w = ctx.toWorld(f, r);
      const a = wrap(Math.atan2(w.y - c.y, w.x - c.x) - ctx.ar.camTheta);
      return [-Math.sin(a), Math.cos(a)];
    };
  }
  I.lightwall = {
    thirdPerson: true,
    start: (ctx) => {
      Lynx.fireAction();
      if (ctx.game.debug && ctx.game.debug.god) ctx.game.debug.god(true);
    },
    steps: [
      {
        say: ["Lightwall: Tron on your floor. You ride a light-cycle, and the robot follows it with its camera.", "Lichtmuur: Tron op je vloer. Jij rijdt op een lichtmotor, en de robot volgt hem met zijn camera."],
        cam: { chase: cycle, dist: 0.45, height: 0.25, side: 20 },
        stick: ride(0.9, 0.3),
      },
      {
        say: ["It never stops: the stick says which way to ride, and it lays a wall of light behind it.", "Hij stopt nooit: de stick zegt welke kant je op rijdt, en hij laat een muur van licht achter zich."],
        cam: { chase: cycle, dist: 0.4, height: 0.2, side: -30 },
        stick: ride(0.6, -0.6),
      },
      {
        say: ["The rivals do too. Whatever touches a wall, or the arena's edge, is derezzed.", "De tegenstanders ook. Wat een muur raakt, of de rand van de arena, is af."],
        cam: { orbit: [0.4, 0, 0], radius: 2.3, height: 1.6, from: -30, to: 10 },
        stick: ride(0.2, 0.4),
      },
      {
        say: ["Your own wall is harmless to you but deadly to them: cut them off. Trapped? Fire sends a pulse that wipes their walls nearby.", "Je eigen muur doet jou niets, maar hen wel: snijd ze af. Ingesloten? Vuur stuurt een golf die hun muren in de buurt wist."],
        cam: { chase: cycle, dist: 0.5, height: 0.3, side: 35 },
        stick: ride(0.9, -0.3),
        at: [[2.5, "fire"]],
      },
      {
        say: ["Derezzed rivals come back along the edge, and more join in as time goes on. Press Fire to start!", "Uitgeschakelde tegenstanders komen terug langs de rand, en er komen er steeds meer bij. Druk op Vuur om te beginnen!"],
        cam: { orbit: [0.4, 0, 0], radius: 2.2, height: 1.9, from: 30, to: 70 },
        stick: ride(0.4, 0.5),
      },
    ],
  };

  // Gem Bastion: the arena (S = 1 m, 20 x 20 tiles) lies from 0.2 m ahead of
  // the robot; tile (row from the far end, column from the left) -> the intro's frame
  const GB = { near: 0.2, S: 1, N: 20 };
  const gbF = (i) => GB.near + (GB.N - 1 - i + 0.5) * (GB.S / GB.N);
  const gbR = (j) => -GB.S / 2 + (j + 0.5) * (GB.S / GB.N);
  const gbAt = (i, j, h = 0.04) => [gbF(i), gbR(j), h];
  // pretend cubes on tiles: [[tag, row, col, level]...]
  const gbCubes = (ctx, list) => {
    const d = ctx.game.debug;
    if (!d || !d.setCubes) return;
    d.setCubes(list.map(([tag, i, j, level]) => ({ tag, ...d.tileWorld(i, j), level: level || 0 })));
  };
  const GB_L1 = [[0, 12, 8], [1, 7, 12], [2, 7, 6], [3, 3, 9]];
  I.gems = {
    grid: [0.1, 1.3, -0.65, 0.65],
    start: (ctx) => {
      const d = ctx.game.debug;
      if (!d || !d.startLevel) return;
      d.startLevel(0);
      d.closeCard();
      gbCubes(ctx, GB_L1);
    },
    steps: [
      {
        say: ["Gem Bastion: tower defense on your floor, with your own tagged cubes.", "Edelsteenbastion: torenverdediging op je vloer, met je eigen getagde kubussen."],
        cam: { orbit: [0.7, 0, 0], radius: 1.3, height: 1.0, from: -35, to: 5 },
      },
      {
        say: ["Monsters come in at the gates and follow the road to your crystal. Each one that gets there cracks it.", "Monsters komen binnen bij de poorten en volgen de weg naar je kristal. Elk monster dat er komt, laat het barsten."],
        cam: { orbit: gbAt(10, 10, 0), radius: 0.75, height: 0.45, from: 20, to: 60 },
        run: (ctx) => ctx.game.debug.sendWave(),
      },
      {
        say: ["Every cube is a tower: a gem floats over it and shoots the monsters that come near.", "Elke kubus is een toren: er zweeft een edelsteen boven die de monsters in de buurt beschiet."],
        cam: { orbit: gbAt(7, 6, 0.04), radius: 0.32, height: 0.2, from: -20, to: 30 },
        run: (ctx) => ["crawler", "crawler", "runner"].forEach((t, k) => ctx.game.debug.monster(t, 5, 5 + k, true, 40)),
      },
      {
        say: ["Stack two cubes and their gems merge into one: a grade higher, a new shape, more power.", "Stapel twee kubussen en hun stenen smelten samen tot één: een graad hoger, een nieuwe vorm, meer kracht."],
        cam: { orbit: gbAt(12, 8, 0.05), radius: 0.3, height: 0.2, from: 40, to: 90 },
        at: [[1.4, (ctx) => gbCubes(ctx, [[0, 12, 8], [1, 12, 8, 1], [2, 7, 6], [3, 3, 9]])]],
      },
      {
        say: ["The emptied cube goes on the golden home field, and gets a new gem.", "De lege kubus gaat op het gouden thuisveld, en krijgt een nieuwe steen."],
        cam: { orbit: gbAt(17, 13, 0.02), radius: 0.38, height: 0.25, from: -30, to: 10 },
        at: [[1.0, (ctx) => gbCubes(ctx, [[0, 12, 8], [1, 17, 13], [2, 7, 6], [3, 3, 9]])]],
      },
      {
        say: ["Every level brings a new kind of gem: cannons, lasers, swords, frost and storms, each fighting its own way.", "Elk level brengt een nieuwe soort steen: kanonnen, lasers, zwaarden, vorst en storm, elk met een eigen manier van vechten."],
        cam: { orbit: gbAt(12, 9, 0.02), radius: 0.6, height: 0.38, from: -60, to: -10 },
        run: (ctx) => {
          const d = ctx.game.debug;
          d.startLevel(5);
          d.closeCard();
          gbCubes(ctx, [[0, 11, 5], [1, 14, 14], [2, 9, 12], [3, 15, 8], [4, 12, 10], [5, 12, 7]]);
          [["crawler", 13, 6], ["crawler", 13, 9], ["brute", 13, 11], ["runner", 14, 8], ["crawler", 10, 11], ["swarm", 11, 9], ["swarm", 11, 10], ["crawler", 15, 9]].forEach(([t, i, j]) => d.monster(t, i, j, true, 90));
        },
      },
      {
        say: ["On the open fields you build walls, to make their way to the crystal longer. Press Fire to start!", "Op de open velden bouw je muren, om hun weg naar het kristal langer te maken. Druk op Vuur om te beginnen!"],
        cam: { orbit: [0.7, 0, 0], radius: 1.2, height: 0.95, from: 10, to: 50 },
        run: (ctx) => {
          const d = ctx.game.debug;
          for (let j = 2; j <= 8; j++) d.wall(6, j);
          for (let j = 11; j <= 17; j++) d.wall(6, j);
          for (let i = 7; i <= 10; i++) d.wall(i, 8);
          d.sendWave();
        },
        at: [[0.6, (ctx) => ctx.game.debug.wall(8, 11)], [1.2, (ctx) => ctx.game.debug.wall(8, 12)], [1.8, (ctx) => ctx.game.debug.wall(8, 13)]],
      },
    ],
  };

  // Wisp Hollow: the same meadow frame as Gem Bastion's arena (gbAt); pretend cubes on tiles
  const whCubes = (ctx, list) => ctx.game.debug.setCubes(list.map(([tag, i, j, level]) => ({ tag, i, j, level })));
  I.wisps = {
    grid: [0.1, 1.3, -0.65, 0.65],
    start: (ctx) => {
      const d = ctx.game.debug;
      if (!d || !d.startLevel) return;
      d.startLevel(0);
      d.closeCard();
      d.setRobot(19, 10);
    },
    steps: [
      {
        say: ["Wisp Hollow: a quiet puzzle at night. No enemies, no way to lose.", "Dwaallichtjesdal: een rustige puzzel in de nacht. Geen vijanden, je kunt niet verliezen."],
        cam: { orbit: [0.7, 0, 0], radius: 1.3, height: 1.0, from: -35, to: 0 },
      },
      {
        say: ["Wisps drift out of a spring. Your cubes are lanterns: a wisp flies to the nearest one it can see.", "Uit een bron komen dwaallichtjes. Je kubussen zijn lantaarns: een lichtje vliegt naar de dichtstbijzijnde die het kan zien."],
        cam: { orbit: gbAt(4, 4, 0.02), radius: 0.42, height: 0.28, from: 10, to: 60 },
        run: (ctx) => whCubes(ctx, [[0, 5, 5]]),
      },
      {
        say: ["Lay a trail to the shrine. A lantern they have visited can be picked up and set down further on.", "Leg een spoor naar het heiligdom. Een lantaarn waar ze geweest zijn, kun je oppakken en verderop neerzetten."],
        cam: { orbit: gbAt(10, 10, 0), radius: 0.8, height: 0.55, from: -30, to: 20 },
        run: (ctx) => whCubes(ctx, [[0, 5, 5], [1, 9, 10]]),
        at: [[3.2, (ctx) => whCubes(ctx, [[0, 12, 13], [1, 9, 10]])]],
      },
      {
        say: ["Night-blooms open where a wisp passes. They earn you stars.", "Nachtbloemen gaan open waar een lichtje langskomt. Daarmee verdien je sterren."],
        cam: { orbit: gbAt(12, 14, 0.01), radius: 0.3, height: 0.18, from: 30, to: 80 },
      },
      {
        say: ["Hedges hide a lantern's light. Stack two cubes for a tall lantern, seen over the hedges.", "Heggen verbergen het licht van een lantaarn. Stapel twee kubussen voor een hoge lantaarn, zichtbaar over de heggen."],
        cam: { orbit: gbAt(8, 8, 0.02), radius: 0.75, height: 0.6, from: -50, to: 0 },
        run: (ctx) => {
          const d = ctx.game.debug;
          d.startLevel(2);
          d.closeCard();
          whCubes(ctx, [[0, 12, 9], [1, 12, 9, 1], [2, 14, 5]]);
        },
      },
      {
        say: ["A cube in the stream is a stepping stone. A weight on a plate opens its gate: a cube, or the robot itself.", "Een kubus in de beek is een stapsteen. Een gewicht op een plaat opent de poort: een kubus, of de robot zelf."],
        cam: { orbit: gbAt(9, 8, 0), radius: 0.85, height: 0.6, from: 20, to: 60 },
        run: (ctx) => {
          const d = ctx.game.debug;
          d.startLevel(5);
          d.closeCard();
          d.setRobot(8, 14);
          whCubes(ctx, [[0, 4, 4], [1, 8, 4], [2, 10, 4], [3, 13, 5], [4, 13, 5, 1]]);
        },
      },
      {
        say: ["Wisps fall asleep in the soft moss. Fire rings the robot's bell and wakes them. Press Fire to start!", "In het zachte mos vallen lichtjes in slaap. Vuur luidt de bel van de robot en maakt ze wakker. Druk op Vuur om te beginnen!"],
        cam: { orbit: gbAt(7, 4, 0.02), radius: 0.45, height: 0.3, from: -20, to: 30 },
        d: 8,
        at: [[2.5, (ctx) => ctx.game.debug.setRobot(7, 4)], [3.2, "fire"]],
      },
    ],
  };

  I.inkblot = {
    steps: [
      {
        say: ["Inkblot, a clean-up game. Ink seeps up through the floor from leaky wells.", "Inktvlek, een schoonmaakspel. Uit lekkende putten sijpelt inkt omhoog door de vloer."],
        cam: { orbit: [0, 0, 0], radius: 2.2, height: 1.6, from: -30, to: 20 },
      },
      {
        say: ["The blots slowly spread out. Drive over the ink to scrub it away.", "De vlekken breiden zich langzaam uit. Rij over de inkt om hem weg te schrobben."],
        cam: { behind: 0.55, height: 0.5, ahead: 0.5 },
        drive: (t) => ({ j2: 0.7, rot: Math.sin(t) * 50 }),
      },
      {
        say: ["Sit on a pink well for a moment to cap it for good.", "Blijf even op een roze put staan om hem voorgoed dicht te maken."],
        cam: { orbit: "player", radius: 1.1, height: 0.9, from: 0, to: 50 },
        drive: { j2: 0.5, rot: -30 },
      },
      {
        say: ["Fire throws a soap bubble that wipes a wide patch, but it's slow to recharge.", "Vuur gooit een zeepbel die een groot stuk schoonveegt, maar die laadt langzaam op."],
        cam: "player",
        at: [[1.0, "fire"]],
        drive: { j2: 0.3 },
      },
      {
        say: ["If the ink covers nearly half the arena, it's over. Press Fire to start!", "Bedekt de inkt bijna de halve arena, dan is het voorbij. Druk op Vuur om te beginnen!"],
        cam: { orbit: [0, 0, 0], radius: 2, height: 1.8, from: 30, to: 70 },
      },
    ],
  };

  // the sheepdog's spot: just behind the flock (inside the sheep's 0.4 m flee radius), on the
  // far side from where they should go: first a point outside the pen's gap (it faces the
  // middle, so pushing straight at the pen runs them into its wall), then into the pen
  function herd(ctx) {
    const d = ctx.game.debug;
    if (!d) return null;
    const free = d.sheep().filter((s) => !s.penned && !s.caught);
    if (!free.length) return null;
    const pen = d.pen();
    const ca = Math.cos(pen.a);
    const sa = Math.sin(pen.a);
    const gap = { x: pen.x - ca * 0.43, y: pen.y - sa * 0.43 }; // (0.28 to the gap, 0.15 beyond it)
    // one sheep at a time (a spread flock's middle is nowhere): the one nearest the gap
    const c = free.reduce((a, s) => (Math.hypot(s.x - gap.x, s.y - gap.y) < Math.hypot(a.x - gap.x, a.y - gap.y) ? s : a));
    // at the gap's mouth yet? (in line with the opening, and as far along as the mouth)
    const along = (c.x - pen.x) * ca + (c.y - pen.y) * sa;
    const lat = -(c.x - pen.x) * sa + (c.y - pen.y) * ca;
    const goal = Math.abs(lat) < 0.15 && along > -0.5 ? pen : gap;
    const dx = c.x - goal.x;
    const dy = c.y - goal.y;
    const n = Math.hypot(dx, dy) || 1;
    return { x: c.x + (dx / n) * 0.18, y: c.y + (dy / n) * 0.18 };
  }
  // the demo's flock: gathered between the robot and the pen's gap (the gap faces the middle,
  // where the robot starts), so the herding fits in the time a step takes
  function gatherFlock(ctx) {
    const d = ctx.game.debug;
    if (!d) return;
    const pen = d.pen();
    const ca = Math.cos(pen.a);
    const sa = Math.sin(pen.a);
    const p = ctx.pose;
    const ur = (p.x - pen.x) * ca + (p.y - pen.y) * sa; // the robot, along the pen's axis
    d.sheep()
      .filter((s) => !s.penned && !s.caught)
      .forEach((s, k) => {
        const u = Math.min(-0.42, ur + 0.28 + 0.07 * Math.floor(k / 3));
        const v = ((k % 3) - 1) * 0.07;
        s.x = pen.x + u * ca - v * sa;
        s.y = pen.y + u * sa + v * ca;
        s.vx = 0;
        s.vy = 0;
      });
  }
  I.shepherd = {
    steps: [
      {
        say: ["Shepherd: the robot is the sheepdog. A flock grazes on your floor.", "Herder: de robot is de herdershond. Op je vloer graast een kudde schapen."],
        cam: { orbit: [0, 0, 0], radius: 1.9, height: 1.3, from: -30, to: 20 },
      },
      {
        say: ["The sheep run away from the robot. Circle round behind them and steer them through the gap into the pen.", "De schapen rennen weg van de robot. Rij om ze heen en drijf ze door de opening de kooi in."],
        cam: { orbit: "player", radius: 1.1, height: 0.9, from: -40, to: 20 },
        run: gatherFlock,
        drive: { to: herd, speed: 0.9, mps: 0.3 },
      },
      {
        say: ["Foxes sneak in from the edge to catch strays. Drive at them to scare them off.", "Vossen sluipen vanaf de rand naar binnen om losgeraakte schapen te pakken. Rij op ze af om ze weg te jagen."],
        cam: { behind: 0.55, height: 0.45, ahead: 0.5 },
        drive: { to: herd, speed: 0.9, mps: 0.3 },
      },
      {
        say: ["Fire barks: a short, wide scare.", "Vuur blaft: even een brede schrik."],
        cam: "player",
        at: [[0.8, "fire"]],
      },
      {
        say: ["Get the whole flock home before the time runs out. Press Fire to start!", "Krijg de hele kudde thuis voor de tijd op is. Druk op Vuur om te beginnen!"],
        cam: { orbit: [0, 0, 0], radius: 1.8, height: 1.6, from: 20, to: 60 },
      },
    ],
  };

  I.prisma = {
    grid: [-1, 3, -2, 2],
    steps: [
      {
        say: ["Prisma: a laser puzzle laid out on your floor, Sokoban style.", "Prisma: een laserpuzzel op je vloer, in Sokoban-stijl."],
        cam: { orbit: [0.5, 0, 0], radius: 1.8, height: 1.5, from: -30, to: 20 },
      },
      {
        say: ["Drive tile by tile. Push mirrors and crates by driving into them.", "Rij tegel voor tegel. Duw spiegels en kratten door ertegenaan te rijden."],
        cam: { behind: 0.6, height: 0.6, ahead: 0.5 },
        drive: (t) => ({ j2: t < 1.5 ? 0.8 : 0, rot: t > 2 && t < 3.2 ? 75 : 0 }),
      },
      {
        say: ["Steer every laser beam onto its receiver. Stand on a plate to open its gate, and watch out: your robot casts a shadow too.", "Stuur elke laserstraal naar zijn ontvanger. Ga op een plaat staan om een hek te openen, en let op: je robot werpt ook een schaduw."],
        cam: { orbit: [0.5, 0, 0], radius: 1.3, height: 1.2, from: 20, to: 80 },
      },
      {
        say: ["Stuck? Undo a move with the button. Seventeen levels; the fewest moves earns three stars. Press Fire to start!", "Vast? Maak een zet ongedaan met de knop. Zeventien levels; met de minste zetten krijg je drie sterren. Druk op Vuur om te beginnen!"],
        cam: { orbit: [0.5, 0, 0], radius: 1.6, height: 1.8, from: 80, to: 120 },
      },
    ],
  };

  // the race: a point 20 cm beyond the next gate (its middle would stop the car on the line)
  function pastGate(ctx) {
    const s = snap(ctx);
    const g = s.gates && s.gates[s.nextGate];
    if (!g) return null;
    const mx = (g.a.x + g.b.x) / 2;
    const my = (g.a.y + g.b.y) / 2;
    let nx = -(g.b.y - g.a.y);
    let ny = g.b.x - g.a.x;
    const n = Math.hypot(nx, ny) || 1;
    nx /= n;
    ny /= n;
    const p = ctx.pose;
    if ((mx - p.x) * nx + (my - p.y) * ny < 0) {
      nx = -nx;
      ny = -ny;
    }
    return { x: mx + nx * 0.2, y: my + ny * 0.2 };
  }
  I.race = {
    grid: [-1, 3, -2, 2],
    steps: [
      {
        say: ["Time Trial: a course of gates, laid out from where the robot stands.", "Tijdrit: een parcours van poortjes, uitgezet vanaf waar de robot staat."],
        cam: { orbit: [0.7, 0.4, 0], radius: 2.0, height: 1.6, from: -40, to: 10 },
      },
      {
        say: ["Drive through the gates in order, with the left stick or W A S D. The next gate lights up.", "Rij in de goede volgorde door de poortjes, met de linkerstick of W A S D. Het volgende poortje licht op."],
        cam: { behind: 0.6, height: 0.45, ahead: 0.7 },
        drive: { to: pastGate, speed: 1 },
      },
      {
        say: ["Race the clock, and a ghost replay of your own best lap.", "Race tegen de klok, en tegen een spookrit van je eigen beste ronde."],
        cam: "player",
        drive: { to: pastGate, speed: 1 },
      },
      {
        say: ["Point the camera where the course should go, then press Fire to start!", "Richt de camera waar het parcours moet komen, en druk dan op Vuur om te beginnen!"],
        cam: { orbit: [0.7, 0.4, 0], radius: 1.9, height: 1.8, from: 20, to: 60 },
      },
    ],
  };

  // -- the temple (first person, with virtual jumping) ------------------------------------
  I.temple = {
    grid: [-1, 3.5, -1.5, 1.5],
    start: (ctx) => {
      if (ctx.game.debug && ctx.game.debug.god) ctx.game.debug.god(true);
      Lynx.fireAction();
    },
    steps: [
      {
        say: ["Temple of LynXP: a Tomb Raider-style adventure in a temple on your floor.", "Tempel van LynXP: een avontuur in Tomb Raider-stijl, in een tempel op je vloer."],
        cam: { orbit: [1.2, 0, 0.05], radius: 2.2, height: 1.7, from: -35, to: 15 },
      },
      {
        say: ["Drive with the left stick or W A S D. The walls really stop the robot.", "Rijd met de linkerstick of W A S D. De muren houden de robot echt tegen."],
        cam: { behind: 0.5, height: 0.45, ahead: 0.6 },
        drive: (t) => ({ rot: t < 1.2 ? 25 : t < 3.6 ? -25 : t < 4.8 ? 25 : 0 }), // (a look round, back where it started)
        d: 4.8,
      },
      {
        // the spike pit: 0.23-0.39 m ahead; a running jump from 0.19 m clears it
        say: ["Spike pits and lava: jump over them with Space or gamepad A.", "Spijkerkuilen en lava: spring eroverheen met spatie of gamepad A."],
        cam: "player",
        drive: (t) => ({ j2: t < 1.6 ? 1 : 0, mps: 0.3 }),
        at: [[0.63, "jump"]],
        d: 4,
      },
      {
        say: ["Climb the stone blocks for treasure, and solve the glyph floor to raise the portcullis.", "Klim op de stenen blokken voor schatten, en los de tegelvloer met tekens op om het valhek te openen."],
        cam: { orbit: [1.3, 0, 0.1], radius: 1.4, height: 1.2, from: 10, to: 70 },
      },
      {
        say: ["Then the guardian: shoot its crystals with Fire, jump its shockwaves, and dodge its fireballs.", "Dan de bewaker: schiet zijn kristallen kapot met Vuur, spring over zijn schokgolven en ontwijk zijn vuurballen."],
        cam: { orbit: [2.3, 0, 0.2], radius: 1.1, height: 0.8, from: -20, to: 20 },
      },
      {
        say: ["Eight levels, deeper and deeper: mazes, lifts, sky platforms, mirrors and more. Press Fire to start!", "Acht levels, steeds dieper: doolhoven, liften, zwevende platforms, spiegels en meer. Druk op Vuur om te beginnen!"],
        cam: { orbit: [1.2, 0, 0.05], radius: 2.4, height: 2.2, from: 40, to: 80 },
      },
    ],
  };

  // -- third person -----------------------------------------------------------------------
  I.knight = {
    thirdPerson: true,
    grid: [-0.5, 3, -1, 1],
    start: (ctx) => {
      if (ctx.game.debug && ctx.game.debug.god) ctx.game.debug.god(true);
      Lynx.fireAction();
    },
    steps: [
      {
        say: ["Pocket Knight: you play a 7 centimetre knight, at 1 to 25 scale, on your floor.", "Zakridder: je speelt een ridder van 7 centimeter, op schaal 1 op 25, op je vloer."],
        cam: { orbit: [1.15, 0, 0.03], radius: 1.5, height: 1.0, from: -50, to: 0 },
      },
      {
        say: ["You don't drive the robot: it follows the knight with its camera by itself.", "Je bestuurt de robot niet: die volgt de ridder zelf met zijn camera."],
        cam: { chase: hero, dist: 0.3, height: 0.16, side: 30 },
        d: 4,
      },
      {
        say: ["Run with the left stick or W A S D, and jump with A or Space. Small steps you just walk up.", "Ren met de linkerstick of W A S D, en spring met A of spatie. Kleine treden loop je gewoon op."],
        cam: { chase: hero, dist: 0.32, height: 0.16, side: 25 },
        stick: steer(0.6, 0, 1),
        at: [[1.6, "jump"], [2.6, "jump"]],
      },
      {
        say: ["Too high? Jump at a ledge to catch it, then push on to climb up.", "Te hoog? Spring tegen een richel om hem te pakken, en duw door om omhoog te klimmen."],
        cam: { chase: hero, dist: 0.3, height: 0.2, side: -35 },
        stick: steer(0.62, 0, 1),
        at: [[0.3, "jump"], [1.6, "jump"], [2.8, "jump"]],
      },
      {
        say: ["Fire swings the sword: a three-hit combo. Skeletons wind up before they strike: hit them first, or step away.", "Vuur zwaait met het zwaard: een combo van drie slagen. Skeletten halen eerst uit voor ze slaan: raak ze eerst, of stap opzij."],
        cam: { orbit: [1.25, 0, 0.03], radius: 0.5, height: 0.3, from: -30, to: 20 },
        at: every(0.5, 6, 0.6, "fire"),
      },
      {
        say: ["Push crates onto plates, ride moving platforms over chasms, strike levers to open gates.", "Duw kratten op platen, rijd mee op bewegende platforms over afgronden, sla tegen hendels om hekken te openen."],
        cam: { orbit: [1.5, 0.2, 0.05], radius: 0.8, height: 0.6, from: 20, to: 80 },
      },
      {
        say: ["The camera button, C or Y, brings the robot round behind the knight. Press Fire to start!", "De cameraknop, C of Y, laat de robot achter de ridder gaan staan. Druk op Vuur om te beginnen!"],
        cam: { orbit: [1.15, 0, 0.03], radius: 1.6, height: 1.3, from: 80, to: 120 },
      },
    ],
  };

  // Knight on Blocks: pretend cubes stand in front of the robot (the real ones may not be out yet)
  const KB_CUBES = [
    { tag: 0, f: 0.42, r: 0.0 },
    { tag: 1, f: 0.42, r: 0.06 },
    { tag: 2, f: 0.42, r: 0.06, h0: 0.04 },
    { tag: 3, f: 0.5, r: -0.08 },
  ];
  I.knightblocks = {
    thirdPerson: true,
    grid: [-0.5, 1.5, -0.8, 0.8],
    start: (ctx) => {
      ctx.fakeCubes(KB_CUBES);
      const d = ctx.game.debug;
      if (d && d.startPlay) d.startPlay();
    },
    steps: [
      {
        say: ["Knight on Blocks: the Pocket Knight, on real blocks.", "Ridder op Blokken: de Zakridder, op echte blokken."],
        cam: { orbit: [0.4, 0, 0.02], radius: 0.6, height: 0.4, from: -40, to: 10 },
      },
      {
        say: ["Cubes with AprilTags on their faces: the robot finds them with its camera. Print the tags from the tags page.", "Blokjes met AprilTags op hun zijkanten: de robot vindt ze met zijn camera. Print de tags via de tagpagina."],
        cam: { orbit: [0.45, 0, 0.03], radius: 0.35, height: 0.25, from: 10, to: 60 },
      },
      {
        say: ["The knight walks round them, jumps and climbs onto them, and catches the edge of a stack.", "De ridder loopt eromheen, springt en klimt erop, en grijpt de rand van een stapel."],
        cam: { chase: hero, dist: 0.18, height: 0.1, side: 30 },
        stick: steer(0.42, 0.0, 1),
        at: [[1.2, "jump"], [2.2, "jump"], [3.4, "jump"]],
      },
      {
        say: ["Run with the left stick or W A S D, jump with A or Space.", "Ren met de linkerstick of W A S D, spring met A of spatie."],
        cam: { chase: hero, dist: 0.18, height: 0.12, side: -30 },
        stick: steer(0.42, 0.06, 1),
        at: [[0.4, "jump"], [1.4, "jump"], [2.4, "jump"]],
      },
      {
        say: ["The robot follows the knight without bumping into any block it has seen. Press Fire to start!", "De robot volgt de ridder zonder tegen een blok te botsen dat hij gezien heeft. Druk op Vuur om te beginnen!"],
        cam: { orbit: [0.45, 0, 0.02], radius: 0.7, height: 0.5, from: 60, to: 110 },
      },
    ],
  };

  // Rune Stones, level 3 ("Six Stones", every stone once): the stones where
  // they solve it, beside the explorer's way (column 3).
  // Its cells: row i (0 = far end, 17 rows), column j (9): f = 0.12 + (16.5 - i) * 0.05, r = (j - 4) * 0.05
  const RS = (tag, i, j) => ({ tag, f: 0.12 + (16.5 - i) * 0.05, r: (j - 4) * 0.05 });
  const RUNES_1 = [RS(0, 13.5, 2.3), RS(1, 11, 8)];
  const RUNES_2 = RUNES_1.concat([RS(2, 8.5, 2), RS(3, 5.5, 2), RS(5, 2.5, 2)]);
  const RUNES_3 = RUNES_2.concat([RS(4, 0, 2)]);
  I.runes = {
    thirdPerson: true,
    grid: [-0.4, 1.2, -0.6, 0.6],
    start: (ctx) => {
      ctx.fakeCubes([]);
      Lynx.weaponAction(3); // (the level menu: level 3, every stone once)
      Lynx.fireAction(); // (Fire starts it)
    },
    steps: [
      {
        say: ["Rune Stones: a puzzle game with no fighting. A level appears on the floor in front of the robot.", "Runenstenen: een puzzelspel zonder vechten. Op de vloer voor de robot verschijnt een level."],
        cam: { orbit: [0.55, -0.05, 0], radius: 0.9, height: 0.7, from: -40, to: 10 },
      },
      {
        say: ["Water, ravines, fire, spikes, ghostly bridges and gates stand between the explorer and the portal.", "Water, ravijnen, vuur, spijkers, spookbruggen en hekken staan tussen de ontdekkingsreiziger en het portaal."],
        cam: { fly: [[0.05, -0.05, 0.18], [0.5, -0.05, 0]], to: [[0.5, 0.25, 0.25], [0.9, -0.05, 0]] },
      },
      {
        say: ["You make the way, with six rune stones: the tagged cubes 0 to 5, set down by hand. The Island makes an island in the water; the Weight holds a plate down to open its gate.", "Jij maakt de weg vrij, met zes runenstenen: de blokjes met tag 0 tot 5, die je met de hand neerzet. Het Eiland maakt een eiland in het water; het Gewicht houdt een plaat omlaag zodat het hek opengaat."],
        cam: { orbit: [0.3, 0, 0], radius: 0.45, height: 0.35, from: -10, to: 30 },
        run: (ctx) => ctx.fakeCubes(RUNES_1),
      },
      {
        say: ["Rain puts out the fire, the Lantern lights the ghost bridges, Earth sinks the spikes.", "Regen dooft het vuur, de Lantaarn laat de spookbruggen oplichten, Aarde laat de spijkers zakken."],
        cam: { orbit: [0.67, -0.05, 0], radius: 0.5, height: 0.42, from: 30, to: 60 },
        run: (ctx) => ctx.fakeCubes(RUNES_2),
      },
      {
        say: ["And the Key, in its socket, opens the portal.", "En de Sleutel, in zijn sleutelgat, opent het portaal."],
        cam: { orbit: [0.92, -0.08, 0], radius: 0.3, height: 0.25, from: 60, to: 90 },
        run: (ctx) => ctx.fakeCubes(RUNES_3),
        d: 3.5,
      },
      {
        say: ["Now the explorer can go: walk with the stick or W A S D, jump with A or Space.", "Nu kan de ontdekkingsreiziger op pad: lopen met de stick of W A S D, springen met A of spatie."],
        cam: { chase: hero, dist: 0.16, height: 0.09, side: 20 },
        stick: steer(0.95, -0.05, 0.9),
        d: 12,
      },
      {
        say: ["The first level starts with just the Island, the second with three stones. Some levels need a stone twice, some have raised ground to climb, and on the river cube 4 steers a ship. Press Fire to start!", "Het eerste level begint met alleen het Eiland, het tweede met drie stenen. Sommige levels hebben een steen twee keer nodig, sommige hebben verhoogde grond om te beklimmen, en op de rivier stuurt blokje 4 een schip. Druk op Vuur om te beginnen!"],
        cam: { orbit: [0.55, -0.05, 0], radius: 0.95, height: 0.8, from: 60, to: 100 },
        stick: steer(0.95, -0.05, 0.9),
      },
    ],
  };

  I.blockquest = {
    thirdPerson: true,
    grid: [-0.4, 1.4, -0.7, 0.7],
    start: null, // (its level menu stays: the levels need the cubes placed first)
    steps: [
      {
        say: ["Block Quest: Knight on Blocks with real levels, built round your tagged cubes.", "Blokkentocht: Ridder op Blokken met echte levels, gebouwd rond je blokjes met tags."],
        cam: { orbit: [0.4, 0, 0], radius: 0.8, height: 0.6, from: -30, to: 10 },
      },
      {
        say: ["Each level starts with a placement guide: a checklist and ghost footprints show where every cube goes.", "Elk level begint met een plaatsingsgids: een lijstje en spookafdrukken laten zien waar elk blokje moet staan."],
        cam: { orbit: [0.4, 0, 0], radius: 0.6, height: 0.5, from: 10, to: 40 },
        run: (ctx) => {
          // (level 1's guide; the intro's end starts the game afresh, at its menu)
          const d = ctx.game.ext && ctx.game.ext.debug;
          if (!d || !d.startSelected) return;
          d.G.sel = 0;
          d.startSelected("title");
        },
      },
      {
        say: ["The frame cube is the starting point. When every cube is in place, the level begins.", "Het startblok is het beginpunt. Staan alle blokjes goed, dan begint het level."],
        cam: { orbit: [0.4, 0, 0], radius: 0.5, height: 0.45, from: 40, to: 70 },
      },
      {
        say: ["Climb, cross lava, fight skeletons with sword and shield, set off bombs, bend sunbeams with mirror cubes.", "Klim, steek lava over, vecht tegen skeletten met zwaard en schild, laat bommen ontploffen, buig zonnestralen met spiegelblokjes."],
        cam: { orbit: [0.4, 0, 0], radius: 0.7, height: 0.6, from: 70, to: 110 },
      },
      {
        say: ["Run with the stick, jump with A, sword on Fire. Pick a level and press Fire to start!", "Rennen met de stick, springen met A, zwaard op Vuur. Kies een level en druk op Vuur om te beginnen!"],
        cam: { orbit: [0.4, 0, 0], radius: 0.9, height: 0.8, from: 110, to: 140 },
        run: (ctx) => {
          const d = ctx.game.ext && ctx.game.ext.debug;
          if (d && d.G) d.G.phase = "menu";
        },
      },
    ],
  };

  // -- games about the real room: subtitles over the live view ------------------------------
  I.scavenger = {
    live: true,
    start: null,
    steps: [
      {
        say: ["Scavenger Hunt: the robot names a real object: a cup, a chair, a book.", "Speurtocht: de robot noemt een echt voorwerp: een beker, een stoel, een boek."],
      },
      {
        say: ["Race to find one, and point the camera at it. It's recognised live, on this phone or computer.", "Zoek er snel een en richt de camera erop. Hij wordt meteen herkend, op deze telefoon of computer."],
      },
      {
        say: ["Drive with the left stick or W A S D, look round with the right stick or the arrows. Be quick: the clock is ticking!", "Rijd met de linkerstick of W A S D, kijk rond met de rechterstick of de pijltjes. Wees snel: de klok tikt!"],
      },
    ],
  };

  I.monster_hunt = {
    live: true,
    start: null,
    steps: [
      {
        say: ["Monster Hunt, the original: green monsters roam around the robot.", "Monsterjacht, het origineel: groene monsters zwerven rond de robot."],
      },
      {
        say: ["Turn the camera toward one and fling fireballs at it: the Fire button, Z or Space.", "Draai de camera naar een monster en gooi er vuurballen naar: de Vuur-knop, Z of spatie."],
      },
      {
        say: ["No score, no rush: just relax and hunt. Have fun!", "Geen score, geen haast: gewoon rustig jagen. Veel plezier!"],
      },
    ],
  };
})(window.Lynx);
