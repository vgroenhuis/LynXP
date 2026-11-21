// The game table page (gametable.html): one big table comparing every game's
// mechanics -- launch and last update, person view, how the robot and the
// camera are controlled, what the cube tags do, the type of game, levels,
// weapons, graphics and more.
//
// Where the values come from:
//  - the catalog (lynx_common.js): name, icon, kind, launch date, settings,
//    difficulty options, scoreboards, whether it needs the internet -- these
//    follow the catalog by themselves;
//  - games_table_dates.js (tools/games_table_dates.py, from the git history
//    and the files): last update, lines of code, which games have an
//    introduction;
//  - FACTS below: what the code does -- written by hand, English and Dutch
//    side by side ([en, nl]). A new game needs a row here (without one, its
//    row shows what the catalog knows and "?" for the rest).

(function () {
  const nl = (Lynx.lang || "en") === "nl";
  const tr = (s) => (Lynx.tr ? Lynx.tr(s) : s);
  const pick = (v) => (Array.isArray(v) ? (nl ? v[1] : v[0]) : v);

  // -- the vocabulary: values several games share --------------------------------------------------------------------
  const FIRST = ["First person", "Eerste persoon"];
  const THIRD = ["Third person", "Derde persoon"];
  const CAMVIEW = ["Camera view", "Camerabeeld"];
  const STICK_CAM = ["Player: left stick, camera frame (moves toward where the camera looks)", "Speler: linkerstick, camerabeeld (beweegt naar waar de camera kijkt)"];
  const STICK_CAM_WALLS = ["Player: left stick, camera frame; the game's walls stop the robot", "Speler: linkerstick, camerabeeld; de muren van het spel stoppen de robot"];
  const FOLLOW = ["Automatic: the robot follows the character at ~15 cm", "Automatisch: de robot volgt het personage op ~15 cm"];
  const ROBOT_FRAME = ["Player: right stick, robot frame (up/down drive, left/right turn); auto drive optional (it follows the character); keeps clear of known blocks", "Speler: rechterstick, robotframe (omhoog/omlaag rijden, links/rechts draaien); automatisch rijden mogelijk (volgt het personage); blijft uit de buurt van bekende blokken"];
  const CAM_STICK = ["Manual: right stick / arrows / mouse drag pan and tilt; the robot turns with the pan", "Handmatig: rechterstick / pijltjes / muis slepen draaien en kantelen; de robot draait mee"];
  const CAM_AIM = ["Manual: the crosshair is the camera's optical axis (turn to aim)", "Handmatig: het dradenkruis is de optische as van de camera (draai om te richten)"];
  const CAM_TRACK = ["Automatic: tracks the character, turning only outside a dead zone (keeps pictures still for the tag detector); look controls move the robot instead", "Automatisch: volgt het personage en draait alleen buiten een dode zone (houdt beelden stil voor de tagherkenning)"];
  const NONE = ["None", "Geen"];
  const COVER = ["Optional cover: cubes on the floor are solid -- monsters walk round them, shots stop at them, the robot stops short of them", "Optioneel dekking: kubussen op de vloer zijn massief -- monsters lopen eromheen, schoten stoppen ertegen, de robot stopt ervoor"];
  const ANY_TAG = ["Any", "Alle"];
  const DASH = ["-", "-"];
  const JUMP_VIRTUAL = ["Virtual jump (setting): the view rises, the robot stays on the floor", "Virtueel springen (instelling): het beeld stijgt, de robot blijft op de vloer"];
  const JUMP_CHAR = ["The character jumps, catches ledges and climbs", "Het personage springt, grijpt randen en klimt"];
  const NO = ["No", "Nee"];
  const ENG_2D = ["2D canvas AR overlay (ar.js): the lens-calibrated camera model projects floor shapes and sprites", "2D-canvas AR-overlay (ar.js): het gekalibreerde cameramodel projecteert vloervormen en sprites"];
  const ENG_3D = ["2D canvas + world3d: depth-sorted 3D boxes, textured floors, lens-aware", "2D-canvas + world3d: op diepte gesorteerde 3D-blokken, getextureerde vloeren, lensbewust"];
  const ENG_KNIGHT = ["2D canvas + world3d, with the knight engine (articulated skeleton, IK limbs)", "2D-canvas + world3d, met de ridder-engine (skelet met IK-ledematen)"];
  const ENG_GL = ["WebGL2 (lit, depth-buffered 3D models) + 2D canvas; 2D fallback", "WebGL2 (belichte 3D-modellen met dieptebuffer) + 2D-canvas; 2D-terugval"];

  // -- the facts, per game id ---------------------------------------------------------------------------------------------------
  // genre, players, view, role (of the robot), drive (robot frame control), camera,
  // jump, fire (what the FIRE button does), tagRole, tagIds, levelsN (number, for
  // sorting; null: endless) + levels, winlose, scoring, space (floor), fight,
  // weapons, enemies, engine, style, detail (1-5) + detailNote, net
  const FACTS = {
    none: {
      genre: ["Free driving, no game", "Vrij rijden, geen spel"], players: "1", view: CAMVIEW,
      role: ["Just a camera car: overlays add the floor grid, axes, map, waypoints and cube detection", "Gewoon een camerawagen: overlays tonen het vloerraster, assen, kaart, routepunten en kubusherkenning"],
      drive: [
        "Player: two modes -- camera frame (left stick moves toward where the camera looks) or robot frame (like a car, right stick sets the camera angle)",
        "Speler: twee standen -- camerabeeld (linkerstick beweegt naar waar de camera kijkt) of robotframe (als een auto, rechterstick bepaalt de camerahoek)",
      ],
      camera: CAM_STICK, jump: NO, fire: DASH,
      tagRole: ["Optional detection overlay: outlines and tags of the cubes found; a frame cube can set the world frame", "Optionele detectie-overlay: contouren en tags van gevonden kubussen; een framekubus kan het wereldframe bepalen"],
      tagIds: ["Any", "Alle"], levelsN: 0, levels: DASH, winlose: DASH, scoring: DASH, space: ["Any", "Willekeurig"], fight: NO, weapons: DASH, enemies: DASH,
      engine: ["Overlays on the video (map, floor grid, axes, waypoints)", "Overlays op het beeld (kaart, vloerraster, assen, routepunten)"],
      style: ["Thin lines and markers", "Dunne lijnen en markeringen"], detail: 1, net: ["Tag detector (for the cube overlay)", "Tagherkenning (voor de kubus-overlay)"],
    },
    demons: {
      genre: ["Shooter (FPS)", "Schietspel (FPS)"], players: "1", view: FIRST,
      role: ["Your body: dodge fireballs by driving, pick up health and ammo by driving over it", "Je lichaam: ontwijk vuurballen door te rijden, pak gezondheid en munitie door eroverheen te rijden"],
      drive: STICK_CAM, camera: CAM_AIM, jump: JUMP_VIRTUAL, fire: ["Fire the weapon (hold: auto)", "Het wapen afvuren (ingedrukt: automatisch)"],
      tagRole: COVER, tagIds: ANY_TAG, levelsN: null, levels: ["Endless waves; new weapons on the floor in later waves; cover walls from wave 3", "Eindeloze golven; nieuwe wapens op de vloer in latere golven; dekkingsmuren vanaf golf 3"],
      winlose: ["Health and armor; game over at 0", "Gezondheid en pantser; game over bij 0"], scoring: ["Points per kill", "Punten per kill"],
      space: ["Demons spawn in a ring of 2.5 m; pickups within 0.5 m of the start", "Demonen verschijnen in een ring van 2,5 m; pickups binnen 0,5 m van de start"],
      fight: ["Yes: shooting and melee", "Ja: schieten en dichtbij"],
      weapons: ["Fist, chainsaw, pistol, shotgun, super shotgun, chaingun, rocket launcher, plasma rifle, BFG 9000", "Vuist, kettingzaag, pistool, jachtgeweer, dubbelloops, chaingun, raketwerper, plasmageweer, BFG 9000"],
      enemies: ["Imps, pinkies, cacodemons (fireballs aimed where you were)", "Imps, pinkies, cacodemons (vuurballen gericht op waar je was)"],
      engine: ENG_2D, style: ["Pixel-art sprites as billboards (Doom look), status-bar face", "Pixelart-sprites als billboards (Doom-look), gezichtje in de statusbalk"], detail: 3,
      detailNote: ["Sprites, glows, shadows; projectiles and blasts", "Sprites, gloed, schaduwen; projectielen en explosies"], net: ["Tag detector, for the cubes (optional)", "Tagherkenning, voor de kubussen (optioneel)"],
    },
    david: {
      genre: ["Shooter, crate-breaker", "Shooter, kratten openschieten"], players: "1", view: FIRST,
      role: ["Your body: aim by turning, dodge monsters, drive over coins", "Je lichaam: richt door te draaien, ontwijk monsters, rijd over munten"],
      drive: STICK_CAM, camera: CAM_AIM, jump: JUMP_VIRTUAL, fire: ["Fire the weapon", "Het wapen afvuren"],
      tagRole: COVER, tagIds: ANY_TAG, levelsN: null, levels: ["Endless levels: open every crate and beat every monster", "Eindeloze levels: open elke kist en versla elk monster"],
      winlose: ["Hearts; a golden crate in each level holds a new weapon", "Harten; een gouden kist in elk level bevat een nieuw wapen"], scoring: ["Points (coins, monsters)", "Punten (munten, monsters)"],
      space: ["Radius 2 m", "Straal 2 m"], fight: ["Yes: shooting and melee", "Ja: schieten en dichtbij"],
      weapons: ["Water pistol, wooden sword, bow (arrows fall), laser pistol, bombs, double pistol, lightning gun, rainbow cannon; wooden shield", "Waterpistool, houten zwaard, boog (pijlen vallen), laserpistool, bommen, dubbel pistool, bliksemkanon, regenboogkanon; houten schild"],
      enemies: ["Monsters that crawl toward you", "Monsters die op je afkruipen"],
      engine: ENG_2D, style: ["Pixel-art sprites as billboards, crates and effects", "Pixelart-sprites als billboards, kratten en effecten"], detail: 3, detailNote: ["Sprites, glows, projectiles", "Sprites, gloed, projectielen"], net: ["Tag detector, for the cubes (optional)", "Tagherkenning, voor de kubussen (optioneel)"],
    },
    poop: {
      genre: ["Shooter with walls", "Shooter met muren"], players: "1", view: FIRST,
      role: ["Your body: find a clear line of fire, walls block you too", "Je lichaam: zoek een vrij schootsveld, muren blokkeren ook jou"],
      drive: STICK_CAM_WALLS, camera: CAM_AIM, jump: JUMP_VIRTUAL, fire: ["Fire the weapon", "Het wapen afvuren"],
      tagRole: COVER, tagIds: ANY_TAG, levelsN: 10, levels: ["10 levels, each with long stone walls; a giant poop in levels 5 and 10", "10 levels, elk met lange stenen muren; een gigantische drol in level 5 en 10"],
      winlose: ["Hearts", "Harten"], scoring: ["Points; golden poops are worth a lot", "Punten; gouden drollen zijn veel waard"], space: ["Radius 2 m", "Straal 2 m"],
      fight: ["Yes: shooting and melee", "Ja: schieten en dichtbij"],
      weapons: ["Water gun, bow (arrows fall), toilet brush (melee), bombs; toilet-lid shield", "Waterpistool, boog (pijlen vallen), toiletborstel (dichtbij), bommen; toiletdeksel als schild"],
      enemies: ["Poops (walk around the walls), golden poops, giant poop", "Drollen (lopen om de muren heen), gouden drollen, gigantische drol"],
      engine: ENG_2D, style: ["Pixel-art sprites as billboards; walls as rows of stone sprites", "Pixelart-sprites als billboards; muren als rijen steensprites"], detail: 3, detailNote: ["Sprites, shadows, projectiles", "Sprites, schaduwen, projectielen"], net: ["Tag detector, for the cubes (optional)", "Tagherkenning, voor de kubussen (optioneel)"],
    },
    coins: {
      genre: ["Arcade chase (Pac-Man)", "Arcade-achtervolging (Pac-Man)"], players: "1", view: FIRST,
      role: ["Pac-Man: you drive over the coins", "Pac-Man: jij rijdt over de munten"],
      drive: STICK_CAM, camera: CAM_STICK, jump: JUMP_VIRTUAL, fire: ["Start", "Start"],
      tagRole: NONE, tagIds: DASH, levelsN: null, levels: ["Endless levels: more ghosts (up to 6), faster", "Eindeloze levels: meer spoken (tot 6), sneller"],
      winlose: ["Lives", "Levens"], scoring: ["Points (coins, ghosts)", "Punten (munten, spoken)"], space: ["Radius 1.5 m", "Straal 1,5 m"], fight: NO, weapons: DASH,
      enemies: ["Ghosts with their own personalities; a power coin turns them blue", "Spoken met elk een eigen karakter; een powermunt maakt ze blauw"],
      engine: ENG_2D, style: ["Flat vector shapes, arcade", "Platte vectorvormen, arcade"], detail: 2, detailNote: ["Flat coins and ghosts on the floor", "Platte munten en spoken op de vloer"], net: DASH,
    },
    sonar: {
      genre: ["Treasure hunt by ear", "Schattenjacht op het gehoor"], players: "1", view: FIRST,
      role: ["A metal detector: pings and a hot/cold meter; dig where you stand", "Een metaaldetector: pings en een warm/koud-meter; graaf waar je staat"],
      drive: STICK_CAM, camera: CAM_STICK, jump: NO, fire: ["Dig", "Graven"],
      tagRole: NONE, tagIds: DASH, levelsN: null, levels: ["Rounds with more gems", "Rondes met meer edelstenen"], winlose: ["A limited number of digs and a clock", "Een beperkt aantal keer graven en een klok"],
      scoring: ["Points (gems found, time left)", "Punten (gevonden stenen, resterende tijd)"], space: ["Radius 1.5 m", "Straal 1,5 m"], fight: NO, weapons: DASH, enemies: ["The clock", "De klok"],
      engine: ENG_2D, style: ["Minimal: rings on the floor, a meter; the sound does the work", "Minimaal: ringen op de vloer, een meter; het geluid doet het werk"], detail: 1, detailNote: ["Almost nothing to see on purpose", "Bijna niets te zien, met opzet"], net: DASH,
    },
    echo: {
      genre: ["Memory (Simon)", "Geheugenspel (Simon)"], players: "1", view: FIRST,
      role: ["You drive onto the pads in order", "Je rijdt in volgorde op de vlakken"],
      drive: STICK_CAM, camera: CAM_STICK, jump: NO, fire: ["Start / play the sequence again", "Start / de reeks opnieuw afspelen"],
      tagRole: NONE, tagIds: DASH, levelsN: null, levels: ["Endless rounds, one more step each", "Eindeloze rondes, elke keer een stap meer"], winlose: ["The wrong pad ends it; no time limit", "Het verkeerde vlak beëindigt het; geen tijdslimiet"],
      scoring: ["Rounds completed", "Voltooide rondes"], space: ["Pads 0.8 m from the start", "Vlakken op 0,8 m van de start"], fight: NO, weapons: DASH, enemies: DASH,
      engine: ENG_2D, style: ["Four glowing coloured pads, a note each", "Vier gloeiende gekleurde vlakken, elk met een noot"], detail: 1, detailNote: ["Four pads and glows", "Vier vlakken en gloed"], net: DASH,
    },
    codebreak: {
      genre: ["Logic puzzle (Mastermind)", "Logicapuzzel (Mastermind)"], players: "1", view: FIRST,
      role: ["The keyboard: you drive onto the coloured pads, then back onto CHECK", "Het toetsenbord: je rijdt op de gekleurde vlakken, dan terug op CHECK"],
      drive: STICK_CAM, camera: CAM_STICK, jump: NO, fire: ["Start / take back the last peg", "Start / de laatste pin terugnemen"],
      tagRole: NONE, tagIds: DASH, levelsN: null, levels: ["Endless: code after code (colours, pegs and guesses are settings)", "Eindeloos: code na code (kleuren, pinnen en pogingen zijn instellingen)"],
      winlose: ["A limited number of guesses per code; no time limit", "Een beperkt aantal pogingen per code; geen tijdslimiet"],
      scoring: ["Points per code cracked (fewer guesses: more)", "Punten per gekraakte code (minder pogingen: meer)"], space: ["Pads in a fan about 1 m from the start", "Vlakken in een waaier op ongeveer 1 m van de start"], fight: NO, weapons: DASH, enemies: ["The hidden code", "De verborgen code"],
      engine: ENG_2D, style: ["Glowing coloured pads on the floor; a peg board with black and white answer pegs", "Gloeiende gekleurde vlakken op de vloer; een pinnenbord met zwarte en witte antwoordpinnen"], detail: 2, detailNote: ["Flat pads and glows, a tone per colour", "Platte vlakken en gloed, een toon per kleur"], net: DASH,
    },
    crossing: {
      genre: ["Arcade (Frogger)", "Arcade (Frogger)"], players: "1", view: FIRST,
      role: ["The frog: cross the roads between the sidewalks", "De kikker: steek de wegen over tussen de stoepen"],
      drive: STICK_CAM, camera: CAM_STICK, jump: NO, fire: ["Honk: freezes the traffic for a moment", "Toeteren: bevriest het verkeer even"],
      tagRole: NONE, tagIds: DASH, levelsN: null, levels: ["Endless: the course flips each time you cross, faster and denser", "Eindeloos: het parcours draait om elke keer dat je oversteekt, sneller en drukker"],
      winlose: ["Lives", "Levens"], scoring: ["Crossings + points", "Oversteken + punten"], space: ["1.6 m wide and 2.5 m long", "1,6 m breed en 2,5 m lang"], fight: NO, weapons: DASH,
      enemies: ["Traffic: cars, vans, trucks, motorcycles (own speeds, queueing)", "Verkeer: auto's, bestelbussen, vrachtwagens, motoren (eigen snelheid, filevorming)"],
      engine: ENG_GL, style: ["Real 3D models lit on the GPU: asphalt, markings, paint, glass, rubber, chrome", "Echte 3D-modellen, op de GPU belicht: asfalt, markeringen, lak, glas, rubber, chroom"], detail: 5, detailNote: ["Textured, lit, depth-buffered", "Getextureerd, belicht, met dieptebuffer"], net: DASH,
    },
    shepherd: {
      genre: ["Herding / positioning", "Hoeden / positioneren"], players: "1", view: FIRST,
      role: ["The sheepdog: the flock runs from the robot", "De herdershond: de kudde vlucht voor de robot"],
      drive: STICK_CAM, camera: CAM_STICK, jump: NO, fire: ["Bark: a short, wide scare", "Blaffen: een korte, brede schrik"],
      tagRole: NONE, tagIds: DASH, levelsN: null, levels: ["Endless levels: more sheep and foxes", "Eindeloze levels: meer schapen en vossen"], winlose: ["The flock must be in the pen before time runs out", "De kudde moet voor het einde van de tijd in de kooi zijn"],
      scoring: ["Points (sheep home, time left)", "Punten (schapen thuis, resterende tijd)"], space: ["Radius 1 m", "Straal 1 m"], fight: NO, weapons: DASH,
      enemies: ["Foxes that catch strays (drive at them)", "Vossen die dwalers vangen (rijd erop af)"],
      engine: ENG_2D, style: ["Pixel-art sheep and fox sprites, flat grass and pen", "Pixelart-schapen en vossen, plat gras en kooi"], detail: 2, detailNote: ["Sprites on flat fields", "Sprites op vlakke velden"], net: DASH,
    },
    lightwall: {
      genre: ["Arcade, light-cycles (Tron)", "Arcade, lichtmotoren (Tron)"], players: "1", view: THIRD,
      role: ["You steer a light-cycle that never stops; the robot is its camera", "Jij stuurt een lichtmotor die nooit stopt; de robot is de camera"],
      drive: FOLLOW, camera: ["Automatic: points at the cycle (absolute aim)", "Automatisch: wijst naar de motor (absolute richting)"], jump: NO, fire: ["Light pulse: wipes the rival walls close by", "Lichtpuls: wist de muren van tegenstanders vlakbij"],
      tagRole: NONE, tagIds: DASH, levelsN: null, levels: ["No levels: endless; a rival joins every half minute", "Geen levels: eindeloos; elke halve minuut komt er een tegenstander bij"], winlose: ["Lives; touching a wall of light derezzes", "Levens; een lichtmuur aanraken is de dood"],
      scoring: ["Survival time + rivals derezzed", "Overlevingstijd + uitgeschakelde tegenstanders"], space: ["Radius 1.5 m", "Straal 1,5 m"], fight: ["Indirect: trap rivals in your light wall", "Indirect: vang tegenstanders in je lichtmuur"],
      weapons: ["Your own wall of light; a pulse (FIRE)", "Je eigen lichtmuur; een puls (FIRE)"], enemies: ["Rival cycles that look ahead and cut you off", "Tegenstanders die vooruitkijken en je afsnijden"],
      engine: ENG_2D, style: ["Neon: glowing extruded light walls and cycles", "Neon: gloeiende lichtmuren en motoren"], detail: 3, detailNote: ["Glow, lean animation, trails", "Gloed, overhelling, sporen"], net: DASH,
    },
    inkblot: {
      genre: ["Clean-up / containment", "Opruimen / indammen"], players: "1", view: FIRST,
      role: ["The scrubber: driving over ink wipes it, sit on a well to cap it", "De schrobber: over inkt rijden veegt hem weg, op een bron zitten dicht hem"],
      drive: STICK_CAM, camera: CAM_STICK, jump: NO, fire: ["Soap bubble: wipes a wide patch", "Zeepbel: veegt een groot stuk weg"],
      tagRole: NONE, tagIds: DASH, levelsN: null, levels: ["Endless levels: more wells, faster ink", "Eindeloze levels: meer bronnen, snellere inkt"], winlose: ["Over when the ink swamps nearly half the arena", "Voorbij als de inkt bijna de helft van de arena bedekt"],
      scoring: ["Points (ink scrubbed, wells capped)", "Punten (inkt geschrobd, bronnen gedicht)"], space: ["Radius 1.5 m", "Straal 1,5 m"], fight: NO, weapons: DASH, enemies: ["Spreading ink", "Zich verspreidende inkt"],
      engine: ENG_2D, style: ["Glossy smooth blobs (curves and gradients)", "Glanzende gladde vlekken (bochten en kleurverlopen)"], detail: 3, detailNote: ["Smooth organic shapes", "Gladde organische vormen"], net: DASH,
    },
    prisma: {
      genre: ["Puzzle (Sokoban + lasers)", "Puzzel (Sokoban + lasers)"], players: "1", view: FIRST,
      role: ["The pusher: you step tile by tile and push mirrors and crates", "De duwer: je stapt tegel voor tegel en duwt spiegels en kratten"],
      drive: STICK_CAM, camera: CAM_STICK, jump: NO, fire: ["Undo", "Ongedaan maken"],
      tagRole: NONE, tagIds: DASH, levelsN: 17, levels: ["17 levels, from gentle to fiendish (solver-checked)", "17 levels, van mild tot duivels (met een solver gecontroleerd)"], winlose: ["No way to lose; par = shortest solution", "Niet te verliezen; par = kortste oplossing"],
      scoring: ["1-3 stars (fewest moves)", "1-3 sterren (minste zetten)"], space: ["Up to 8 x 7 tiles of 25 cm (2 x 1.75 m)", "Tot 8 x 7 tegels van 25 cm (2 x 1,75 m)"], fight: NO, weapons: DASH, enemies: DASH,
      engine: ENG_2D, style: ["Flat tiles and glowing coloured beams; your robot casts a shadow", "Platte tegels en gloeiende gekleurde stralen; je robot werpt een schaduw"], detail: 2, detailNote: ["Clean flat graphics", "Strakke platte beelden"], net: DASH,
    },
    temple: {
      genre: ["Adventure (Tomb Raider-like)", "Avontuur (à la Tomb Raider)"], players: "1", view: FIRST,
      role: ["The explorer: its walls really stop the robot; virtual jumping over pits and lava", "De ontdekkingsreiziger: de muren stoppen de robot echt; virtueel springen over kuilen en lava"],
      drive: STICK_CAM_WALLS, camera: CAM_AIM, jump: ["Virtual jump (core mechanic)", "Virtueel springen (kernmechaniek)"], fire: ["Fire the pistol", "Het pistool afvuren"],
      tagRole: NONE, tagIds: DASH, levelsN: 8, levels: ["8 levels: upper temple, sunken sanctum, lower temple, clockwork labyrinth, sky citadel, drowned cistern, hall of mirrors, watchers' vault", "8 levels: bovenste tempel, verzonken heiligdom, onderste tempel, uurwerklabyrint, hemelburcht, verdronken regenput, spiegelzaal, kluis van de waakogen"],
      winlose: ["Hearts; timed gates; puzzles (glyph floors, keys, lifts, push blocks, mirrors)", "Harten; poorten met tijdslimiet; puzzels (glyfvloeren, sleutels, liften, schuifblokken, spiegels)"], scoring: ["Points (treasure, kills)", "Punten (schat, kills)"], space: ["About 2 x 3 m", "Ongeveer 2 x 3 m"],
      fight: ["Yes: shooting; stealth in the last level", "Ja: schieten; sluipen in het laatste level"],
      weapons: ["Pistol (hits crystals, shoots switches and mirrors); Sun Shield (level 7: the robot is a mirror)", "Pistool (raakt kristallen, schiet op schakelaars en spiegels); Zonneschild (level 7: de robot is een spiegel)"],
      enemies: ["Bats, spirits, scarabs, mummies, guardians (bosses), dart traps, stone watchers", "Vleermuizen, geesten, scarabeeën, mummies, bewakers (eindbazen), pijlvallen, stenen waakogen"],
      engine: ["2D canvas with the Temple's own 3D: depth-sorted textured stone blocks, sprites", "2D-canvas met de eigen 3D van de tempel: op diepte gesorteerde getextureerde steenblokken, sprites"], style: ["Procedural stone textures, sprites, torch glows", "Procedurele steentexturen, sprites, fakkelgloed"], detail: 4, detailNote: ["Textures near the camera (setting)", "Texturen dicht bij de camera (instelling)"], net: DASH,
    },
    knight: {
      genre: ["Platformer + sword fighting", "Platformspel met zwaardgevechten"], players: "1", view: THIRD,
      role: ["A 7 cm knight on the floor; the robot is its camera operator", "Een ridder van 7 cm op de vloer; de robot is zijn cameraman"],
      drive: FOLLOW, camera: ["Automatic: tracks the knight; camera button: the robot circles behind; look controls orbit", "Automatisch: volgt de ridder; camera-knop: de robot gaat erachter; kijkbesturing draait eromheen"], jump: JUMP_CHAR, fire: ["Sword: three-hit combo; plunging strike in the air", "Zwaard: combo van drie slagen; neerwaartse slag in de lucht"],
      tagRole: NONE, tagIds: DASH, levelsN: 2, levels: ["2 levels: the ruined keep, the clockwork bridge", "2 levels: de verwoeste burcht, de uurwerkbrug"], winlose: ["Hearts; chasms and spikes", "Harten; kloven en spijkers"],
      scoring: ["Points (coins, enemies)", "Punten (munten, vijanden)"], space: ["About 1.3 x 2.5 m", "Ongeveer 1,3 x 2,5 m"], fight: ["Yes: melee", "Ja: dichtbij"],
      weapons: ["Sword (three-hit combo, plunge strike)", "Zwaard (combo van drie, neerwaartse slag)"], enemies: ["Skeletons and a brute (they wind up before they strike)", "Skeletten en een bruut (ze halen eerst uit)"],
      engine: ENG_KNIGHT, style: ["Cartoon 3D knight with outlines on textured sandstone blocks", "Cartoon-3D-ridder met contouren op getextureerde zandsteenblokken"], detail: 3, detailNote: ["Animated skeleton figure, textures (setting)", "Geanimeerd skeletfiguur, texturen (instelling)"], net: DASH,
    },
    knightblocks: {
      genre: ["Sandbox / parkour on real blocks", "Zandbak / parkour op echte blokken"], players: "1", view: THIRD,
      role: ["Camera operator: finds the blocks and keeps clear of them", "Cameraman: vindt de blokken en blijft er vanaf"],
      drive: ROBOT_FRAME, camera: CAM_TRACK, jump: JUMP_CHAR, fire: ["Start", "Start"],
      tagRole: ["The cubes are solid blocks: the knight walks around, jumps onto, catches the edge of and climbs them; a nearer block hides the knight", "De kubussen zijn massieve blokken: de ridder loopt eromheen, springt erop, grijpt de rand en klimt; een dichterbij blok verbergt de ridder"],
      tagIds: ["Any tag ID (one cube size per ID); frame cube 24-29", "Elke tag-ID (één kubusmaat per ID); framekubus 24-29"], levelsN: 0, levels: ["No levels: a free sandbox", "Geen levels: een vrije zandbak"], winlose: ["No goal, no way to lose", "Geen doel, niet te verliezen"], scoring: NONE,
      space: ["Wherever the blocks are", "Waar de blokken staan"], fight: NO, weapons: DASH, enemies: DASH,
      engine: ENG_KNIGHT, style: ["Cartoon 3D knight without armour (tunic, bare head); block outlines and silhouette cut-outs over the video", "Cartoon-3D-ridder zonder harnas (tuniek, blootshoofds); blokcontouren en uitgesneden silhouetten over het beeld"], detail: 3, detailNote: ["Blocks sit in the real video", "Blokken staan in het echte beeld"], net: ["Tag detector", "Tagherkenning"],
    },
    laraonblocks: {
      genre: ["Climbing challenge on real blocks", "Klimuitdaging op echte blokken"], players: "1", view: THIRD,
      role: ["Camera operator, and builder: stacks the cubes higher", "Cameraman, en bouwer: stapelt de kubussen hoger"],
      drive: ROBOT_FRAME, camera: CAM_TRACK, jump: JUMP_CHAR, fire: ["Start", "Start"],
      tagRole: ["The cubes are blocks to climb: stack them (or put them on a box or a book) to reach the ever higher coins", "De kubussen zijn blokken om op te klimmen: stapel ze (of zet ze op een doos of een boek) om de steeds hogere munten te halen"],
      tagIds: ["Any tag ID (one cube size per ID); frame cube 24-29", "Elke tag-ID (één kubusmaat per ID); framekubus 24-29"], levelsN: 0, levels: ["No levels: coin after coin, each higher", "Geen levels: munt na munt, elk hoger"],
      winlose: ["No way to lose: as high as you can stack", "Niet te verliezen: zo hoog als je kunt stapelen"], scoring: ["Coins taken", "Gepakte munten"],
      space: ["Coins within about 20 cm of Lara", "Munten binnen zo'n 20 cm van Lara"], fight: NO, weapons: DASH, enemies: DASH,
      engine: ENG_KNIGHT, style: ["Cartoon 3D explorer (braid, tank top); a spinning gold coin with its shadow and height", "Cartoon-3D-avonturierster (vlecht, topje); een draaiende gouden munt met schaduw en hoogte"], detail: 3, detailNote: ["Blocks sit in the real video", "Blokken staan in het echte beeld"], net: ["Tag detector", "Tagherkenning"],
    },
    blockquest: {
      genre: ["Adventure with puzzles and fights", "Avontuur met puzzels en gevechten"], players: ["1 (2 in the ferry level: a second person slides a cube)", "1 (2 in het veerlevel: een tweede persoon schuift een kubus)"], view: THIRD,
      role: ["Camera operator, as in Knight on Blocks", "Cameraman, zoals in Ridder op Blokken"],
      drive: ROBOT_FRAME, camera: CAM_TRACK, jump: JUMP_CHAR, fire: ["Sword (shield held up + Fire: bash)", "Zwaard (schild omhoog + Fire: stoot)"],
      tagRole: ["Level props that you place by hand: steps and platforms, bridges over lava, mirrors for a sunbeam, weights for plates, bombs and kegs, pillars to remember; a placement guide shows where each goes", "Voorwerpen in het level die je met de hand plaatst: treden en platforms, bruggen over lava, spiegels voor een zonnestraal, gewichten voor platen, bommen en tonnen, pilaren om te onthouden; een plaatsingsgids toont waar elk heen moet"],
      tagIds: ["0-5 (40 mm) + the frame cube (origin)", "0-5 (40 mm) + de framekubus (oorsprong)"], levelsN: 12, levels: ["12 levels: climb, lava floor, courtyard, powder cellar, sunbeam vault, ferry, boss, weighing hall, ashen isles, echo chamber, clockwork crypt, sky stair", "12 levels: klim, lavavloer, binnenplaats, buskruitkelder, zonnestraalkluis, veer, eindbaas, weegzaal, asrijke eilanden, echokamer, uurwerkkrocht, hemeltrap"],
      winlose: ["Hearts; hazards (lava, geysers, falling fire); a crypt against the clock", "Harten; gevaren (lava, geisers, vallend vuur); een krocht tegen de klok"], scoring: NONE, space: ["Set by the level's placement guide", "Bepaald door de plaatsingsgids van het level"],
      fight: ["Yes: melee, shield, bombs", "Ja: dichtbij, schild, bommen"], weapons: ["Sword (three-hit combo), shield (block, parry), shield bash, hand-set bombs set off from a distance, powder keg", "Zwaard (combo van drie), schild (blokkeren, pareren), schildstoot, met de hand geplaatste bommen die op afstand afgaan, buskruitton"],
      enemies: ["Skeletons, hoplites, archers, the bone-and-iron boss", "Skeletten, hoplieten, boogschutters, de eindbaas van bot en ijzer"],
      engine: ENG_GL, style: ["Lit 3D figures and skins on the real blocks (stone, timber, basalt), lava floors, fire, explosions", "Belichte 3D-figuren en huiden op de echte blokken (steen, hout, basalt), lavavloeren, vuur, explosies"], detail: 5, detailNote: ["Photoreal option, quality setting", "Fotorealistische optie, kwaliteitsinstelling"], net: ["Tag detector", "Tagherkenning"],
    },
    runes: {
      genre: ["Puzzle-adventure (no fighting)", "Puzzelavontuur (zonder vechten)"], players: "1", view: THIRD,
      role: ["Camera operator for the explorer", "Cameraman voor de ontdekkingsreiziger"],
      drive: ROBOT_FRAME, camera: CAM_TRACK, jump: JUMP_CHAR, fire: ["OK / board or leave the ship", "OK / het schip op of af"],
      tagRole: ["Rune stones you set down by hand: 0 Bridge (a bridge over water, along the cube's X axis), 1 Weight (plate), 2 Rain (puts out fire), 3 Lantern (lights ghost bridges), 4 Key (slides into the keyhole: opens the portal), 5 Earth (sinks spikes); the directional Bridge turns with the cube; the River's helm steers a ship", "Runenstenen die je met de hand neerzet: 0 Brug (een brug over water, langs de X-as van het blokje), 1 Gewicht (plaat), 2 Regen (dooft vuur), 3 Lantaarn (verlicht spookbruggen), 4 Sleutel (glijdt in het sleutelgat: opent het portaal), 5 Aarde (laat spijkers zakken); de richtinggevoelige Brug draait met de kubus; het roer in de Rivier stuurt een schip"],
      tagIds: ["0-5; no frame cube", "0-5; geen framekubus"], levelsN: 10, levels: ["10 levels: 1 stone, 3 stones, then all six; steps to climb; a river with a ship", "10 levels: 1 steen, 3 stenen, daarna alle zes; treden om te beklimmen; een rivier met een schip"],
      winlose: ["Hearts; water, ravines, fire, spikes; no enemies", "Harten; water, ravijnen, vuur, spijkers; geen vijanden"], scoring: ["Levels done (ticks)", "Voltooide levels (vinkjes)"], space: ["About 0.5 x 0.9 m", "Ongeveer 0,5 x 0,9 m"], fight: NO, weapons: DASH, enemies: ["None (hazards only)", "Geen (alleen gevaren)"],
      engine: ENG_KNIGHT, style: ["Flat-colour cartoon: animated water, palm island, stones with runes; an explorer heroine", "Cartoon in effen kleuren: bewegend water, palmeiland, stenen met runen; een ontdekkingsreizigster"], detail: 3, detailNote: ["Cheap on an old phone; floor opacity slider", "Zuinig op een oude telefoon; schuifregelaar voor vloerdekking"], net: ["Tag detector", "Tagherkenning"],
    },
    gems: {
      genre: ["Tower defence", "Tower defense"], players: "1", view: FIRST,
      role: ["Eyes over the board; aiming FIRE builds walls", "Ogen boven het bord; richten en FIRE bouwt muren"],
      drive: STICK_CAM, camera: CAM_STICK, jump: NO, fire: ["Build a wall on the tile in the middle of the view", "Een muur bouwen op de tegel midden in beeld"],
      tagRole: ["Every cube is a tower with a floating gem; stack two to merge the gems (a grade higher); an emptied cube gets a new gem on the home field", "Elke kubus is een toren met een zwevende edelsteen; stapel er twee om de stenen samen te voegen (een rang hoger); een lege kubus krijgt een nieuwe steen op het thuisveld"],
      tagIds: ["Every tag", "Elke tag"], levelsN: 6, levels: ["6 levels (8-15 waves each): road, two roads, open field, spiral, crossroads, last stand", "6 levels (8-15 golven elk): weg, twee wegen, open veld, spiraal, kruispunt, laatste stand"],
      winlose: ["The crystal has 20 hit points; monsters that reach it crack it", "Het kristal heeft 20 levenspunten; monsters die het bereiken beschadigen het"], scoring: ["Points", "Punten"], space: ["1 x 1 m arena of 5 cm tiles", "Arena van 1 x 1 m met tegels van 5 cm"],
      fight: ["Yes: towers shoot", "Ja: torens schieten"], weapons: ["Gems: amethyst bolts, ruby cannon, emerald laser, topaz blade, sapphire frost, diamond storm (grades by merging)", "Edelstenen: amethistpijlen, robijnkanon, smaragdlaser, topaaszwaard, saffierijs, diamantstorm (rangen door samenvoegen)"],
      enemies: ["Crawlers, runners, bosses walking from the gates to the crystal", "Kruipers, rennende monsters, eindbazen die van de poorten naar het kristal lopen"],
      engine: ENG_3D, style: ["Textured grass, brick walls, granite; faceted glowing gems that change shape with grade", "Getextureerd gras, bakstenen muren, graniet; gefacetteerde gloeiende edelstenen die van vorm veranderen met de rang"], detail: 4, detailNote: ["Textures, gem shapes, lightning, blasts", "Texturen, edelsteenvormen, bliksem, explosies"], net: ["Tag detector", "Tagherkenning"],
    },
    nano: {
      genre: ["Educational parkour", "Educatieve parkour"], players: "1", view: THIRD,
      role: ["Camera operator for a technician shrunk to 15 nm", "Cameraman voor een technicus gekrompen tot 15 nm"],
      drive: ROBOT_FRAME, camera: CAM_TRACK, jump: JUMP_CHAR, fire: ["OK", "OK"],
      tagRole: ["Real cubes are specks of dust: boulders at this scale you can climb (with a cleanroom fact)", "Echte kubussen zijn stofjes: rotsblokken op deze schaal waar je op kunt klimmen (met een cleanroom-feitje)"],
      tagIds: ["Any", "Alle"], levelsN: 4, levels: ["4 levels: copper grid, down the stack, FinFET, gate-all-around", "4 levels: koperen raster, de stapel af, FinFET, gate-all-around"],
      winlose: ["Hearts; the void under the wires, signal pulses", "Harten; de leegte onder de draden, signaalpulsen"], scoring: ["Electrons collected + nano facts read", "Verzamelde elektronen + gelezen nanofeitjes"], space: ["About 1.1 x 0.45 m", "Ongeveer 1,1 x 0,45 m"], fight: NO, weapons: DASH, enemies: ["Signal pulses (hazard)", "Signaalpulsen (gevaar)"],
      engine: ENG_KNIGHT, style: ["Procedural material textures (copper, silicon lattice, tungsten, oxide) near the camera; cartoon cleanroom technician", "Procedurele materiaaltexturen (koper, siliciumrooster, wolfraam, oxide) dicht bij de camera; cartoon-technicus in cleanroompak"], detail: 4, detailNote: ["Textures setting; metallic sheen", "Textuurinstelling; metaalglans"], net: ["Tag detector (for the dust)", "Tagherkenning (voor het stof)"],
    },
    chips: {
      genre: ["Logic puzzle (educational)", "Logicapuzzel (educatief)"], players: "1", view: FIRST,
      role: ["Eyes over the die; a datasheet card on FIRE", "Ogen boven de chip; een datasheetkaart op FIRE"],
      drive: STICK_CAM, camera: CAM_STICK, jump: NO, fire: ["Show the level's datasheet card", "De datasheetkaart van het level tonen"],
      tagRole: ["Each cube is a logic chip (7400 series): 0 NOT, 1 AND, 2 OR, 3 XOR, 4 NAND, 5 NOR; set in a cell it becomes that gate; stacked on top it inverts", "Elke kubus is een logicachip (7400-serie): 0 NOT, 1 AND, 2 OR, 3 XOR, 4 NAND, 5 NOR; in een cel wordt het die poort; erbovenop keert het om"],
      tagIds: ["0-5", "0-5"], levelsN: 8, levels: ["8 levels: inverter, AND, XOR, half adder, NAND only, majority, multiplexer, latch", "8 levels: inverter, AND, XOR, halve opteller, alleen NAND, meerderheid, multiplexer, latch"],
      winlose: ["No way to lose: the logic analyzer shows output against WANT", "Niet te verliezen: de logische analyzer toont de uitgang naast WANT"], scoring: ["1-3 stars (fewest transistors)", "1-3 sterren (minste transistors)"], space: ["About 0.6 x 0.5 m", "Ongeveer 0,6 x 0,5 m"], fight: NO, weapons: DASH, enemies: DASH,
      engine: ENG_3D, style: ["Die-photo textures (standard cells), gold pads, bond wires, black DIP packages, glowing electrons", "Chipfototexturen (standaardcellen), gouden pads, bonddraadjes, zwarte DIP-behuizingen, gloeiende elektronen"], detail: 3, detailNote: ["Textures setting; logic analyzer overlay", "Textuurinstelling; logische analyzer als overlay"], net: ["Tag detector", "Tagherkenning"],
    },
    wisps: {
      genre: ["Puzzle (guiding)", "Puzzel (leiden)"], players: "1", view: FIRST,
      role: ["Eyes and a bell (FIRE); the robot weighs down plates", "Ogen en een bel (FIRE); de robot drukt platen omlaag"],
      drive: STICK_CAM, camera: CAM_STICK, jump: NO, fire: ["Ring the bell: wakes wisps near the robot", "De bel luiden: maakt spookjes vlakbij wakker"],
      tagRole: ["Lanterns that wisps fly to (move them on); two stacked: a tall lantern; in a stream: a stepping stone; on a plate: a weight", "Lantaarns waar lichtjes naartoe vliegen (verplaats ze); twee gestapeld: een hoge lantaarn; in een beek: een stapsteen; op een plaat: een gewicht"],
      tagIds: ["Every tag", "Elke tag"], levelsN: 6, levels: ["6 levels, each bringing a new idea", "6 levels, elk met een nieuw idee"], winlose: ["No enemies, no way to lose", "Geen vijanden, niet te verliezen"], scoring: ["1-3 stars (all home, every bloom, in time)", "1-3 sterren (allemaal thuis, elke bloem, op tijd)"], space: ["1 x 1 m meadow of 5 cm tiles", "Weide van 1 x 1 m met tegels van 5 cm"], fight: NO, weapons: DASH, enemies: ["None (sleepy moss, gates)", "Geen (slaperig mos, poorten)"],
      engine: ENG_3D, style: ["Night meadow: textured ground, hedges, glowing wisps with trails", "Weide bij nacht: getextureerde grond, heggen, gloeiende lichtjes met sporen"], detail: 3, detailNote: ["Textures, light pools", "Texturen, lichtplassen"], net: ["Tag detector", "Tagherkenning"],
    },
    race: {
      genre: ["Racing (time trial)", "Racen (tijdrit)"], players: "1", view: FIRST,
      role: ["The race car: drive through the gates in order", "De racewagen: rijd in volgorde door de poorten"],
      drive: STICK_CAM, camera: CAM_STICK, jump: NO, fire: ["Start / restart", "Start / opnieuw"],
      tagRole: NONE, tagIds: DASH, levelsN: 4, levels: ["4 courses: oval, figure eight, slalom, star; laps", "4 parcoursen: ovaal, achtvorm, slalom, ster; rondes"], winlose: ["No way to lose; beat your best lap", "Niet te verliezen; verbeter je beste ronde"],
      scoring: ["Best lap + total time, with a ghost of your best", "Beste ronde + totaaltijd, met een spook van je beste"], space: ["Course 1.5 m", "Parcours 1,5 m"], fight: NO, weapons: DASH, enemies: ["The clock and your own ghost", "De klok en je eigen spook"],
      engine: ENG_2D, style: ["Flat gates and a translucent ghost replay", "Platte poorten en een doorschijnende spookreplay"], detail: 2, detailNote: ["Simple gate markers", "Eenvoudige poortmarkeringen"], net: DASH,
    },
    scavenger: {
      genre: ["Hunting game (object recognition)", "Zoekspel (objectherkenning)"], players: "1", view: FIRST,
      role: ["Find the named object and point the camera at it", "Vind het genoemde voorwerp en richt de camera erop"],
      drive: STICK_CAM, camera: CAM_STICK, jump: NO, fire: ["Start / skip", "Start / overslaan"],
      tagRole: NONE, tagIds: DASH, levelsN: null, levels: ["Rounds of a set number of objects", "Rondes met een instelbaar aantal voorwerpen"], winlose: ["Seconds per object", "Seconden per voorwerp"], scoring: ["Points (objects found, speed)", "Punten (gevonden voorwerpen, snelheid)"], space: ["Any room", "Elke kamer"], fight: NO, weapons: DASH, enemies: ["The clock", "De klok"],
      engine: ["Live YOLOv8 object detection in the browser + overlay", "Live YOLOv8-objectherkenning in de browser + overlay"], style: ["Detection boxes and labels on the video", "Herkenningskaders en labels op het beeld"], detail: 1, net: ["Detection model (YOLOv8)", "Herkenningsmodel (YOLOv8)"],
    },
    monster_hunt: {
      genre: ["Shooting toy (no score)", "Schietspeeltje (geen score)"], players: "1", view: FIRST,
      role: ["Your body: aim by turning the camera", "Je lichaam: richt door de camera te draaien"],
      drive: STICK_CAM, camera: CAM_AIM, jump: NO, fire: ["Fireball", "Vuurbal"],
      tagRole: NONE, tagIds: DASH, levelsN: 0, levels: ["No levels: relaxed, no score", "Geen levels: ontspannen, geen score"], winlose: ["No way to lose", "Niet te verliezen"], scoring: NONE, space: ["Any room", "Elke kamer"],
      fight: ["Yes: shooting", "Ja: schieten"], weapons: ["Fireballs (fly in world space)", "Vuurballen (vliegen in de wereldruimte)"], enemies: ["Green monsters roaming round the robot", "Groene monsters die rond de robot zwerven"],
      engine: ENG_2D, style: ["Simple billboard monsters and fireballs, reprojected from the live pose", "Eenvoudige billboard-monsters en vuurballen, herberekend uit de actuele positie"], detail: 1, detailNote: ["The original first game", "Het oorspronkelijke eerste spel"], net: DASH,
    },
    focus: {
      genre: ["Tool (camera focus)", "Hulpmiddel (camerascherpte)"], players: "1", view: CAMVIEW, role: ["Shows the picture's sharpness live", "Toont de scherpte van het beeld live"],
      drive: STICK_CAM, camera: CAM_STICK, jump: NO, fire: ["Reset the best value", "De beste waarde resetten"], tagRole: NONE, tagIds: DASH, levelsN: 0, levels: DASH, winlose: DASH, scoring: DASH, space: ["Any", "Willekeurig"], fight: NO, weapons: DASH, enemies: DASH,
      engine: ["2D canvas: sharpness number, graph, magnified centre", "2D-canvas: scherptegetal, grafiek, vergroot midden"], style: ["Numbers and graph", "Getallen en grafiek"], detail: 1, net: DASH,
    },
    camcal: {
      genre: ["Tool (lens calibration)", "Hulpmiddel (lenskalibratie)"], players: "1", view: CAMVIEW, role: ["Photographs a calibration target from all around", "Fotografeert een kalibratiedoel van alle kanten"],
      drive: ["Automatic: the robot drives a tour around the target", "Automatisch: de robot rijdt een rondje om het doel"], camera: ["Automatic: servo and board checks, then the tour", "Automatisch: servo- en bordcontroles, daarna het rondje"], jump: NO, fire: DASH,
      tagRole: ["A checkerboard or AprilGrid target is detected for the calibration (not cubes)", "Een dambord of AprilGrid wordt herkend voor de kalibratie (geen kubussen)"], tagIds: ["Grid tags", "Grid-tags"], levelsN: 0, levels: DASH, winlose: DASH, scoring: DASH, space: ["A wall near the floor", "Een muur vlak bij de vloer"], fight: NO, weapons: DASH, enemies: DASH,
      engine: ["2D canvas: board/tag detection, solver results", "2D-canvas: bord-/tagherkenning, solverresultaten"], style: ["Detections on the video and numbers", "Herkenningen op het beeld en getallen"], detail: 2, net: ["Tag detector", "Tagherkenning"],
    },
    detect: {
      genre: ["Tool (object detection)", "Hulpmiddel (objectherkenning)"], players: "1", view: CAMVIEW, role: ["Names the objects in view; can turn the camera to follow one", "Benoemt de voorwerpen in beeld; kan de camera een voorwerp laten volgen"],
      drive: STICK_CAM, camera: ["Manual, or automatic follow of an object (setting)", "Handmatig, of automatisch een voorwerp volgen (instelling)"], jump: NO, fire: ["Follow on/off", "Volgen aan/uit"], tagRole: NONE, tagIds: DASH, levelsN: 0, levels: DASH, winlose: DASH, scoring: DASH, space: ["Any", "Willekeurig"], fight: NO, weapons: DASH, enemies: DASH,
      engine: ["Live YOLOv8 object detection in the browser + overlay", "Live YOLOv8-objectherkenning in de browser + overlay"], style: ["Detection boxes and labels on the video", "Herkenningskaders en labels op het beeld"], detail: 2, net: ["Detection model (YOLOv8)", "Herkenningsmodel (YOLOv8)"],
    },
  };

  // -- the columns -------------------------------------------------------------------------------------------------------------------
  // g: group (the toggles above the table); sort: "text" | "num" | "date"; get(row) -> {text, num?, html?}
  const GROUPS = [
    { id: "overview", en: "Overview", nl: "Overzicht" },
    { id: "control", en: "View and control", nl: "Beeld en besturing" },
    { id: "cubes", en: "Cube tags", nl: "Kubustags" },
    { id: "play", en: "Gameplay", nl: "Spelverloop" },
    { id: "combat", en: "Combat", nl: "Gevecht" },
    { id: "graphics", en: "Graphics", nl: "Beeld en uiterlijk" },
    { id: "extras", en: "Settings and extras", nl: "Instellingen en extra's" },
  ];
  const KIND = { game: ["Game", "Spel"], app: ["App", "App"], none: ["Free driving", "Vrij rijden"] };
  // The "?" next to a column name: what the column means (en, nl)
  const HELP = {
    updated: () => [
      `From the git history of the game's own files (the shared engine is not counted for the games that ride on it). Refresh it with tools/games_table_dates.py; last run: ${dateText((window.Lynx.GAME_TABLE_DATES || {}).generated)}.`,
      `Uit de git-geschiedenis van de eigen bestanden van het spel (de gedeelde engine telt niet mee voor de spellen die erop draaien). Vernieuwen met tools/games_table_dates.py; laatst uitgevoerd: ${dateText((window.Lynx.GAME_TABLE_DATES || {}).generated)}.`,
    ],
    loc: [
      "Lines of code in the game's own files (not the shared engine under the games that ride on it).",
      "Regels code in de eigen bestanden van het spel (niet de gedeelde engine onder de spellen die erop draaien).",
    ],
    view: [
      "First person: you look through the robot's camera and the game is drawn over the real floor. Third person: you steer a small character that walks on the floor in front of the robot, which films it.",
      "Eerste persoon: je kijkt door de camera van de robot en het spel wordt over de echte vloer getekend. Derde persoon: je bestuurt een klein personage dat op de vloer voor de robot loopt, die het filmt.",
    ],
    drive: [
      "How the robot's body is driven. Camera frame: the left stick moves the robot toward where the camera looks. Robot frame: like a car (up and down drive, left and right turn). Automatic: the game drives the robot, e.g. after the character.",
      "Hoe het lichaam van de robot wordt bestuurd. Camerabeeld: de linkerstick beweegt de robot naar waar de camera kijkt. Robotframe: als een auto (omhoog en omlaag rijden, links en rechts draaien). Automatisch: het spel rijdt de robot, bijv. achter het personage aan.",
    ],
    camera: [
      "How the camera (pan and tilt) is pointed: by the player, or automatically by the game.",
      "Hoe de camera (draaien en kantelen) wordt gericht: door de speler, of automatisch door het spel.",
    ],
    jump: [
      "Virtual jumping lifts the view while the robot stays on the floor; a character jumps in its own world.",
      "Virtueel springen tilt het beeld op terwijl de robot op de vloer blijft; een personage springt in zijn eigen wereld.",
    ],
    tagRole: [
      "What the AprilTag cubes you set on the floor do in the game.",
      "Wat de AprilTag-kubussen die je op de vloer zet in het spel doen.",
    ],
    levels: [
      "The number of levels, or how the game goes on. Sorting puts endless games last.",
      "Het aantal levels, of hoe het spel doorgaat. Bij sorteren komen eindeloze spellen laatst.",
    ],
    space: [
      "How much clear floor the game needs, from where the robot stands at the start.",
      "Hoeveel vrije vloer het spel nodig heeft, vanaf waar de robot bij de start staat.",
    ],
    weapons: [
      "Weapons and tools in the fighting games (also what a cube can shoot or do).",
      "Wapens en gereedschap in de vechtspellen (ook wat een kubus kan schieten of doen).",
    ],
    engine: [
      "How the picture is made: a 2D canvas drawn over the video with the calibrated camera model, with world3d (depth-sorted 3D boxes), or WebGL2.",
      "Hoe het beeld wordt gemaakt: een 2D-canvas over het beeld met het gekalibreerde cameramodel, met world3d (op diepte gesorteerde 3D-blokken), of WebGL2.",
    ],
    detail: [
      "A rough rating from 1 (a few shapes) to 5 (lit 3D models); hover a rating for a note.",
      "Een ruwe beoordeling van 1 (een paar vormen) tot 5 (belichte 3D-modellen); houd de muis boven een cijfer voor een toelichting.",
    ],
    textures: [
      "Whether the game's settings have a switch for textures (off: flat colours, lighter for an old phone).",
      "Of de instellingen van het spel een schakelaar voor texturen hebben (uit: effen kleuren, lichter voor een oude telefoon).",
    ],
    intro: [
      "Whether the game has a spoken introduction that plays when it starts.",
      "Of het spel een gesproken introductie heeft die bij de start wordt afgespeeld.",
    ],
  };
  const dateText = (iso) => {
    if (!iso) return "-";
    const d = new Date(`${iso}T12:00:00`);
    return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(nl ? "nl-NL" : "en-GB", { day: "numeric", month: "short", year: "numeric" });
  };
  const fact = (key) => (e, f) => {
    const v = f && f[key];
    return v === undefined ? { text: "?" } : { text: pick(v) };
  };
  const dots = (n) => "●".repeat(n) + "○".repeat(5 - n);
  const COLS = [
    { k: "name", g: "overview", en: "Game", nl: "Spel", sort: "text", get: (e) => ({ text: `${e.icon || ""} ${tr(e.name)}`.trim(), key: tr(e.name) }), first: true },
    { k: "kind", g: "overview", en: "Kind", nl: "Soort", sort: "text", get: (e) => ({ text: pick(KIND[e.kind] || KIND.game) }) },
    { k: "released", g: "overview", en: "Launched", nl: "Verschenen", sort: "date", get: (e) => ({ text: dateText(e.released), num: e.released || "" }) },
    { k: "updated", g: "overview", en: "Last update", nl: "Laatste update", sort: "date", get: (e, f, d) => ({ text: dateText(d && d.updated), num: (d && d.updated) || "" }) },
    { k: "genre", g: "overview", en: "Type of game", nl: "Soort spel", sort: "text", get: fact("genre") },
    { k: "players", g: "overview", en: "Players", nl: "Spelers", sort: "text", get: fact("players") },
    { k: "loc", g: "overview", en: "Code (lines)", nl: "Code (regels)", sort: "num", get: (e, f, d) => ({ text: d ? d.loc.toLocaleString(nl ? "nl-NL" : "en-GB") : "?", num: d ? d.loc : -1 }), cls: "num" },
    { k: "view", g: "control", en: "Person view", nl: "Perspectief", sort: "text", get: fact("view"), chip: true },
    { k: "role", g: "control", en: "Role of the robot", nl: "Rol van de robot", sort: "text", get: fact("role") },
    { k: "drive", g: "control", en: "Robot frame control", nl: "Besturing van de robot", sort: "text", get: fact("drive"), wide: true },
    { k: "camera", g: "control", en: "Camera control", nl: "Camerabesturing", sort: "text", get: fact("camera"), wide: true },
    { k: "jump", g: "control", en: "Jumping", nl: "Springen", sort: "text", get: fact("jump") },
    { k: "fire", g: "control", en: "FIRE button", nl: "FIRE-knop", sort: "text", get: fact("fire") },
    { k: "tagRole", g: "cubes", en: "Role of the cube tags", nl: "Rol van de kubustags", sort: "text", get: fact("tagRole"), wide: true },
    { k: "tagIds", g: "cubes", en: "Tags used", nl: "Gebruikte tags", sort: "text", get: fact("tagIds") },
    { k: "levels", g: "play", en: "Levels", nl: "Levels", sort: "num", get: (e, f) => ({ text: f ? pick(f.levels) : "?", num: f && f.levelsN !== undefined ? (f.levelsN === null ? 999 : f.levelsN) : -1 }), wide: true },
    { k: "winlose", g: "play", en: "Win / lose", nl: "Winnen / verliezen", sort: "text", get: fact("winlose") },
    { k: "scoring", g: "play", en: "Scoring", nl: "Score", sort: "text", get: fact("scoring") },
    { k: "difficulty", g: "play", en: "Difficulty setting", nl: "Moeilijkheidsinstelling", sort: "text", get: (e) => {
      const s = (e.settings || []).find((x) => x.key === "difficulty");
      const name = (o) => tr((Array.isArray(o) ? o[1] : o).replace(/\s*\(.*\)/, ""));
      return { text: s ? (s.options || []).map(name).join(" / ") || tr("Yes") : tr("No") };
    } },
    { k: "space", g: "play", en: "Floor space", nl: "Vloerruimte", sort: "text", get: fact("space") },
    { k: "fight", g: "combat", en: "Fighting", nl: "Vechten", sort: "text", get: fact("fight") },
    { k: "weapons", g: "combat", en: "Weapons", nl: "Wapens", sort: "text", get: fact("weapons"), wide: true },
    { k: "enemies", g: "combat", en: "Enemies / opposition", nl: "Vijanden / tegenstand", sort: "text", get: fact("enemies") },
    { k: "engine", g: "graphics", en: "Graphics engine", nl: "Grafische engine", sort: "text", get: fact("engine"), wide: true },
    { k: "style", g: "graphics", en: "Graphics style", nl: "Grafische stijl", sort: "text", get: fact("style"), wide: true },
    { k: "detail", g: "graphics", en: "Level of detail", nl: "Detailniveau", sort: "num", get: (e, f) => ({ text: f ? dots(f.detail) : "?", num: f ? f.detail : -1, note: f && f.detailNote ? pick(f.detailNote) : "" }), cls: "dots" },
    { k: "textures", g: "graphics", en: "Textures setting", nl: "Textuurinstelling", sort: "text", get: (e) => ({ text: (e.settings || []).some((s) => s.key === "textures") ? tr("Yes") : tr("No") }) },
    { k: "settings", g: "extras", en: "Settings", nl: "Instellingen", sort: "num", get: (e) => ({ text: String((e.settings || []).length), num: (e.settings || []).length }), cls: "num" },
    { k: "boards", g: "extras", en: "Scoreboards", nl: "Scoreborden", sort: "num", get: (e) => ({ text: String((e.boards || []).length), num: (e.boards || []).length }), cls: "num" },
    { k: "intro", g: "extras", en: "Introduction", nl: "Introductie", sort: "text", get: (e, f, d, intros) => ({ text: intros.has(e.id) ? tr("Yes") : tr("No") }) },
    { k: "net", g: "extras", en: "Needs internet once", nl: "Internet nodig (eenmalig)", sort: "text", get: fact("net") },
  ];

  // -- the table -----------------------------------------------------------------------------------------------------------------------------
  const $ = (id) => document.getElementById(id);
  const dates = (window.Lynx && Lynx.GAME_TABLE_DATES) || { games: {}, intros: [] };
  const intros = new Set(dates.intros || []);
  const PREF = "gameTablePrefs2";
  let prefs = { hidden: [], apps: true, sort: "released", dir: "desc" };
  try {
    prefs = Object.assign(prefs, JSON.parse(localStorage.getItem(PREF) || "{}"));
  } catch (e) {
    // (not remembered)
  }
  const savePrefs = () => {
    try {
      localStorage.setItem(PREF, JSON.stringify(prefs));
    } catch (e) {
      // (not remembered)
    }
  };
  let query = "";

  const rows = () =>
    Lynx.CATALOG.map((e) => {
      const f = FACTS[e.id];
      const d = dates.games[e.id];
      const cells = {};
      COLS.forEach((c) => (cells[c.k] = c.get(e, f, d, intros)));
      // ("Needs internet": the catalog's own words, when the facts have none)
      if (cells.net.text === "?" && /internet once/i.test(e.blurb || "")) cells.net = { text: pick(["Tag detector", "Tagherkenning"]) };
      return { e, f, cells };
    });
  const shown = (r) => (prefs.apps ? true : r.e.kind === "game") && (!query || Object.values(r.cells).some((c) => c.text.toLowerCase().includes(query)));
  const cmp = (col, dir) => (a, b) => {
    const x = a.cells[col.k];
    const y = b.cells[col.k];
    let r;
    if (col.sort === "num" || col.sort === "date") r = col.sort === "date" ? String(x.num).localeCompare(String(y.num)) : x.num - y.num;
    else r = (x.key || x.text).localeCompare(y.key || y.text, nl ? "nl" : "en", { sensitivity: "base", numeric: true });
    return (r || a.cells.name.key.localeCompare(b.cells.name.key)) * dir;
  };

  // (the game's name stays whatever groups are hidden)
  const visibleCols = () => COLS.filter((c) => c.first || !prefs.hidden.includes(c.g));

  // The "?" next to a column's name: a tooltip (hover, keyboard focus, or a tap), not a title attribute
  // -- a title is slow, and never shows on a touch screen
  let tip = null;
  function hideTip() {
    if (tip) tip.remove();
    tip = null;
  }
  function showTip(anchor, text) {
    hideTip();
    tip = document.createElement("div");
    tip.className = "gt-tip";
    tip.textContent = text;
    document.body.appendChild(tip);
    const r = anchor.getBoundingClientRect();
    const w = tip.offsetWidth;
    tip.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, r.left))}px`;
    tip.style.top = `${r.bottom + 6}px`;
  }
  document.addEventListener("keydown", (e) => e.key === "Escape" && hideTip());
  document.addEventListener("click", hideTip);
  const helpText = (c) => {
    const h = HELP[c.k];
    return h ? pick(typeof h === "function" ? h() : h) : "";
  };

  function render() {
    const cols = visibleCols();
    const table = $("matrix");
    table.replaceChildren();
    const head = table.createTHead().insertRow();
    cols.forEach((c) => {
      const th = document.createElement("th");
      th.scope = "col";
      th.className = `${c.first ? "first " : ""}g-${c.g} ${c.cls || ""}`;
      const on = prefs.sort === c.k;
      th.textContent = (nl ? c.nl : tr(c.en)) + (on ? (prefs.dir === "asc" ? " ▲" : " ▼") : "");
      const help = helpText(c);
      if (help) {
        const q = document.createElement("span");
        q.className = "gt-help";
        q.textContent = "?";
        q.tabIndex = 0;
        q.setAttribute("role", "button");
        q.setAttribute("aria-label", help);
        q.addEventListener("mouseenter", () => showTip(q, help));
        q.addEventListener("mouseleave", hideTip);
        q.addEventListener("focus", () => showTip(q, help));
        q.addEventListener("blur", hideTip);
        q.addEventListener("click", (e) => {
          e.stopPropagation(); // (not a sort)
          showTip(q, help);
        });
        th.appendChild(q);
      }
      th.setAttribute("aria-sort", on ? (prefs.dir === "asc" ? "ascending" : "descending") : "none");
      th.addEventListener("click", () => {
        prefs.dir = prefs.sort === c.k && prefs.dir === "asc" ? "desc" : "asc";
        prefs.sort = c.k;
        savePrefs();
        render();
      });
      head.appendChild(th);
    });
    const col = COLS.find((c) => c.k === prefs.sort) || COLS[2];
    const list = rows().filter(shown).sort(cmp(col, prefs.dir === "asc" ? 1 : -1));
    const body = table.createTBody();
    list.forEach((r) => {
      const tr0 = body.insertRow();
      tr0.dataset.kind = r.e.kind;
      cols.forEach((c) => {
        const td = tr0.insertCell();
        const v = r.cells[c.k];
        td.className = `${c.first ? "first " : ""}g-${c.g} ${c.cls || ""} ${c.wide ? "wide" : ""}`;
        td.textContent = v.text;
        if (c.chip) td.dataset.chip = r.f && Array.isArray(r.f.view) ? r.f.view[0].split(" ")[0].toLowerCase() : "";
        if (v.note) td.title = v.note;
        if (c.k === "name" && r.e.kind !== "game") td.classList.add("is-app");
      });
    });
    $("count").textContent = `${list.length} / ${Lynx.CATALOG.length}`;
    if (!list.length) {
      const td = body.insertRow().insertCell();
      td.colSpan = cols.length;
      td.className = "empty";
      td.textContent = tr("No game matches.");
    }
  }

  function toCsv() {
    const cols = visibleCols();
    const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
    const list = rows().filter(shown).sort(cmp(COLS.find((c) => c.k === prefs.sort) || COLS[2], prefs.dir === "asc" ? 1 : -1));
    return [cols.map((c) => q(nl ? c.nl : c.en)).join(","), ...list.map((r) => cols.map((c) => q(r.cells[c.k].text)).join(","))].join("\n");
  }

  function setup() {
    const groups = $("groups");
    GROUPS.forEach((g) => {
      const label = document.createElement("label");
      label.className = "gt-chip";
      const input = Object.assign(document.createElement("input"), { type: "checkbox", checked: !prefs.hidden.includes(g.id) });
      input.addEventListener("change", () => {
        prefs.hidden = prefs.hidden.filter((x) => x !== g.id).concat(input.checked ? [] : [g.id]);
        savePrefs();
        render();
      });
      label.append(input, document.createTextNode(` ${nl ? g.nl : tr(g.en)}`));
      groups.appendChild(label);
    });
    $("showApps").checked = prefs.apps;
    $("scroller").addEventListener("scroll", hideTip);
    $("showApps").addEventListener("change", () => {
      prefs.apps = $("showApps").checked;
      savePrefs();
      render();
    });
    $("filter").addEventListener("input", () => {
      query = $("filter").value.trim().toLowerCase();
      render();
    });
    $("csvBtn").addEventListener("click", () => {
      const url = URL.createObjectURL(new Blob(["﻿" + toCsv()], { type: "text/csv;charset=utf-8" }));
      const a = Object.assign(document.createElement("a"), { href: url, download: "lynxp-game-table.csv" });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    render();
  }
  // (the games table only needs the catalog: the page's own script runs after lynx_common.js)
  setup();
  Lynx.gameTable = { FACTS, COLS, rows };
})();
