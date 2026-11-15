// Code Breaker -- Mastermind on your floor. A ring of coloured pads lies
// around where you start, and a hidden code of coloured pegs is locked
// away in the vault. Each guess is a row of pegs: drive onto a coloured pad
// to put that colour in the next empty slot of the row, then drive back onto
// the white CHECK pad in the middle (where you started) to test it. The
// vault answers with black pegs (right colour, right slot) and white pegs
// (right colour, wrong slot), never saying which is which. Crack the code
// in as few guesses as you can; FIRE takes back the last peg of the row.
// No time limit and nothing to shoot: pure logic, and the robot's own
// steering is the keyboard.

window.Lynx = window.Lynx || {};
Lynx.games = Lynx.games || {};

(function (Lynx) {
  const PAD_R = 0.2;
  const DWELL_S = 0.45; // time on a pad to register it
  const SPREAD_STEP_DEG = 40; // angle between neighbouring colour pads (the ring fans out in front)
  const ROW_H = 26; // px per guess row on screen
  const REVEAL_S = 1.4; // pause after a check, to see the pegs
  const SOLVED_S = 2.4; // pause after a solved code, before the next one
  const COLORS = [
    { name: "RED", letter: "R", color: "#ff4060" },
    { name: "ORANGE", letter: "O", color: "#ff9030" },
    { name: "YELLOW", letter: "Y", color: "#ffd040" },
    { name: "GREEN", letter: "G", color: "#40d070" },
    { name: "BLUE", letter: "B", color: "#4090ff" },
    { name: "PURPLE", letter: "P", color: "#b060ff" },
  ];
  // one tone per colour, so the pad can be heard as well as seen
  const TONE_FREQ = [262, 294, 330, 392, 440, 523];

  const clamp01 = (t) => Math.min(1, Math.max(0, t));

  // Black and white pegs for a guess against the code (standard Mastermind rules).
  function score(guess, code) {
    let black = 0;
    const left = Array(COLORS.length).fill(0);
    const right = Array(COLORS.length).fill(0);
    for (let i = 0; i < code.length; i++) {
      if (guess[i] === code[i]) black++;
      else {
        left[code[i]]++;
        right[guess[i]]++;
      }
    }
    let white = 0;
    for (let c = 0; c < COLORS.length; c++) white += Math.min(left[c], right[c]);
    return { black, white };
  }

  Lynx.games.codebreak = (ar, cfg) => {
    const nColors = Math.max(3, Math.min(COLORS.length, Math.round(cfg.colors || 6)));
    const duplicates = cfg.duplicates !== false;
    // without repeats a code can't be longer than the number of colours
    const nSlots = Math.min(duplicates ? 99 : nColors, Math.max(3, Math.min(5, Math.round(cfg.slots || 4))));
    const maxGuesses = Math.max(4, Math.min(16, Math.round(cfg.guesses || 10)));
    const D = cfg.padDistM || 1.0;

    let state = "title"; // title | guess | reveal | solved | over
    let stateTime = 0;
    let center = { x: 0, y: 0 };
    let pads = []; // colour pads, one per colour in play
    let check = { x: 0, y: 0, glow: 0 }; // the white CHECK pad (the start spot; set in layout())
    let code = [];
    let row = []; // colours placed in the current guess
    let history = []; // { guess: [...], black, white }
    let solvedCount = 0;
    let score_ = 0;
    let toast = null;
    let best = null;
    let rankMsg = "";
    let hold = null; // what the robot is standing on: { kind: "pad" | "check", i }
    let holdTime = 0;
    let fired = false; // this stay on the pad has already done its job
    let needLeave = true; // (the start spot is under the robot: leave it first)
    Lynx.bestScore("codebreak").then((b) => (best = b));

    function layout() {
      center = { x: ar.pose.x, y: ar.pose.y };
      const th = ar.pose.theta;
      const n = nColors;
      pads = [];
      for (let i = 0; i < n; i++) {
        // fan out in front of the robot, centred on its heading
        const a = th + ((i - (n - 1) / 2) * SPREAD_STEP_DEG * Math.PI) / 180;
        pads.push({ ...COLORS[i], idx: i, x: center.x + D * Math.cos(a), y: center.y + D * Math.sin(a), glow: 0, tone: TONE_FREQ[i] });
      }
      check = { x: center.x, y: center.y, glow: 0 };
    }

    function randomCode() {
      const c = [];
      while (c.length < nSlots) {
        const k = Math.floor(Math.random() * nColors);
        if (duplicates || !c.includes(k)) c.push(k);
      }
      return c;
    }

    function newCode() {
      code = randomCode();
      row = [];
      history = [];
      state = "guess";
      stateTime = 0;
      hold = null;
      needLeave = true;
      toast = { text: solvedCount ? `Code ${solvedCount + 1}: crack it!` : "Crack the vault's code", color: "#ffffff", t: 2.2 };
    }

    function start() {
      layout();
      solvedCount = 0;
      score_ = 0;
      rankMsg = "";
      newCode();
      Lynx.sfx.play("go");
    }

    function finish() {
      state = "over";
      stateTime = 0;
      rankMsg = "";
      Lynx.sfx.play("fail");
      Lynx.submitScore("codebreak", score_).then((rank) => {
        rankMsg = rank ? `#${rank} on the robot's scoreboard!` : "";
        if (rank === 1) best = score_;
      });
    }

    Lynx.onAction("fire", () => {
      Lynx.sfx.unlock();
      if (state === "title" || (state === "over" && stateTime > 1.5)) start();
      else if (state === "guess" && row.length) {
        // take back the last peg
        row.pop();
        Lynx.sfx.play("click");
      }
    });

    function place(i) {
      if (row.length >= nSlots) {
        toast = { text: "Row full: check it, or FIRE to take a peg back", color: "#ffd84a", t: 1.8 };
        return;
      }
      row.push(i);
      pads[i].glow = 1;
      Lynx.sfx.play("tick");
      if (row.length === nSlots) toast = { text: "Full row: drive onto CHECK in the middle", color: "#a0c0ff", t: 2 };
    }

    function check_() {
      if (row.length < nSlots) {
        toast = { text: `Place ${nSlots - row.length} more peg${nSlots - row.length > 1 ? "s" : ""} first`, color: "#ffd84a", t: 1.6 };
        Lynx.sfx.play("fail");
        return;
      }
      const res = score(row, code);
      history.push({ guess: row.slice(), black: res.black, white: res.white });
      check.glow = 1;
      // the vault answers: a tone per black peg, a softer one per white
      for (let k = 0; k < res.black; k++) setTimeout(() => Lynx.sfx.play("found"), k * 90);
      for (let k = 0; k < res.white; k++) setTimeout(() => Lynx.sfx.play("tock"), 300 + k * 90);
      row = [];
      state = "reveal";
      stateTime = 0;
      hold = null;
      needLeave = true; // (CHECK is under the robot: leave it before the next one counts)

      if (res.black === nSlots) {
        const left = maxGuesses - history.length;
        const pts = 100 + 25 * left + 10 * nSlots * nColors;
        score_ += pts;
        solvedCount++;
        toast = { text: `Cracked in ${history.length}!  +${pts}`, color: "#ffd84a", t: SOLVED_S };
        Lynx.sfx.play("levelup");
        state = "solved";
      } else if (history.length >= maxGuesses) {
        toast = { text: "Out of guesses", color: "#ff8080", t: 2 };
        finish();
      } else {
        toast = null;
      }
    }

    function update(dt) {
      stateTime += dt;
      pads.forEach((p) => (p.glow = Math.max(0, p.glow - dt * 2.5)));
      check.glow = Math.max(0, check.glow - dt * 2.5);
      if (toast) {
        toast.t -= dt;
        if (toast.t <= 0) toast = null;
      }

      if (state === "reveal" && stateTime > REVEAL_S) state = "guess";
      if (state === "solved" && stateTime > SOLVED_S) newCode();
      if (state !== "guess") return;

      // what is the robot standing on?
      const px = ar.pose.x;
      const py = ar.pose.y;
      let on = null;
      for (let i = 0; i < pads.length; i++) {
        if (Math.hypot(pads[i].x - px, pads[i].y - py) < PAD_R) {
          on = { kind: "pad", i };
          break;
        }
      }
      if (!on && Math.hypot(check.x - px, check.y - py) < PAD_R) on = { kind: "check", i: 0 };

      if (!on) {
        needLeave = false;
        hold = null;
        holdTime = 0;
        fired = false;
        return;
      }
      if (needLeave) return;
      if (!hold || hold.kind !== on.kind || hold.i !== on.i) {
        hold = on;
        holdTime = 0;
        fired = false;
      }
      if (fired) return;
      holdTime += dt;
      if (holdTime < DWELL_S) return;
      fired = true;
      if (on.kind === "pad") place(on.i);
      else check_();
    }

    function draw() {
      const v = ar.view;
      const ctx = ar.ctx;
      if (state !== "title") {
        pads.forEach((p, i) => {
          const g = Math.max(p.glow, 0);
          const isHold = hold && hold.kind === "pad" && hold.i === i;
          ar.floorCircle(p.x, p.y, PAD_R, hexA(p.color, 0.2 + 0.6 * g), hexA(p.color, 0.9));
          if (g > 0.05) {
            const pr = ar.project(p.x, p.y, 0.05);
            if (pr) ar.glow(pr.x, pr.y, PAD_R * pr.ppm * (1.5 + g), [[0, hexA(p.color, 0.8 * g)], [1, "rgba(255,255,255,0)"]], 1);
          }
          if (isHold && state === "guess" && !needLeave) {
            ar.floorCircle(p.x, p.y, PAD_R * clamp01(holdTime / DWELL_S), hexA(p.color, 0.85));
          }
        });
        // the CHECK pad: white, brighter when the row is full
        const full = row.length >= nSlots;
        const cHold = hold && hold.kind === "check" && !needLeave;
        ar.floorCircle(check.x, check.y, PAD_R, hexA("#ffffff", (full ? 0.5 : 0.15) + 0.5 * check.glow), hexA("#ffffff", full ? 1 : 0.5));
        if (cHold) ar.floorCircle(check.x, check.y, PAD_R * clamp01(holdTime / DWELL_S), "rgba(255,255,255,0.7)");
      }
      ar.flush();

      // pad labels, drawn over the floor where the camera can see them
      if (state !== "title") {
        pads.forEach((p) => {
          const pr = ar.project(p.x, p.y, 0.02);
          if (pr && ar.onScreen(pr, 30)) ar.text(p.letter, pr.x, pr.y + 5, { size: 18, align: "center", color: "#ffffff" });
        });
        const pc = ar.project(check.x, check.y, 0.02);
        if (pc && ar.onScreen(pc, 30)) ar.text("CHECK", pc.x, pc.y + 5, { size: 13, align: "center", color: "#101010", outline: false });
      }

      // the guesses so far, newest at the bottom, and the row being built
      if (state !== "title") drawBoard(ctx, v);

      const hudY = v.y + v.h - 16;
      ar.text(`SCORE ${score_}`, v.x + 16, hudY, { size: 20, color: "#a0c0ff" });
      if (state !== "title") ar.text(`GUESS ${Math.min(history.length + 1, maxGuesses)}/${maxGuesses}   CODE ${solvedCount + 1}`, v.cx + 40, hudY, { size: 16, align: "center" });
      if (toast) ar.text(toast.text, v.cx, v.y + v.h * 0.35, { size: 22, align: "center", color: toast.color, alpha: clamp01(toast.t * 2) });

      if (state === "title") {
        ar.flash("#000", 0.45);
        ar.banner("CODE BREAKER", "Press FIRE to lock the code in the vault", { color: "#a0c0ff" });
        ar.text(`Drive onto the coloured pads to fill a row of ${nSlots} pegs, then onto CHECK in the middle.`, v.cx, v.cy + v.h * 0.2, { size: 13, align: "center" });
        ar.text("Black peg: right colour, right place · white peg: right colour, wrong place", v.cx, v.cy + v.h * 0.25, { size: 13, align: "center" });
        if (best !== null) ar.text(`Best on this robot: ${best}`, v.cx, v.cy + v.h * 0.32, { size: 14, align: "center", color: "#a0c0ff" });
      } else if (state === "over") {
        ar.flash("#000", 0.4);
        const answer = code.map((c) => COLORS[c].letter).join(" ");
        ar.banner("OUT OF GUESSES", `The code was ${answer} · score ${score_} · ${solvedCount} cracked`);
        if (rankMsg) ar.text(rankMsg, v.cx, v.cy + v.h * 0.18, { size: 16, align: "center", color: "#a0c0ff" });
        if (stateTime > 1.5) ar.text("Press FIRE to play again", v.cx, v.cy + v.h * 0.25, { size: 14, align: "center" });
      }
    }

    // The history of guesses as rows of pegs with their black/white answers,
    // plus the row in progress (empty slots drawn as rings).
    function drawBoard(ctx, v) {
      const rowsFit = Math.max(3, Math.floor((v.h * 0.5) / ROW_H));
      const x0 = v.x + 18;
      const top = v.y + 40;
      const pegR = 8;
      const pegGap = 22;
      const answerX = x0 + nSlots * pegGap + 22;
      const lines = history.map((h) => ({ slots: h.guess, black: h.black, white: h.white }));
      if (state === "guess" || state === "reveal" || state === "solved") {
        const slots = row.slice();
        lines.push({ slots, pending: true });
      }
      const shown = lines.slice(-rowsFit);
      shown.forEach((line, r) => {
        const y = top + r * ROW_H;
        for (let s = 0; s < nSlots; s++) {
          const cx = x0 + s * pegGap;
          const idx = line.slots[s];
          if (idx !== undefined) {
            ctx.beginPath();
            ctx.arc(cx, y, pegR, 0, 2 * Math.PI);
            ctx.fillStyle = COLORS[idx] ? COLORS[idx].color : "#888";
            ctx.fill();
          } else {
            ctx.beginPath();
            ctx.arc(cx, y, pegR - 1, 0, 2 * Math.PI);
            ctx.strokeStyle = line.pending ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.2)";
            ctx.lineWidth = 2;
            ctx.stroke();
          }
        }
        if (!line.pending) {
          // the answer: black pegs first, then white
          const total = line.black + line.white;
          for (let j = 0; j < total; j++) {
            const cx = answerX + (j % 4) * 13;
            const cy = y + (j < 4 ? -5 : 6);
            ctx.beginPath();
            ctx.arc(cx, cy, 4.5, 0, 2 * Math.PI);
            ctx.fillStyle = j < line.black ? "#111" : "#f4f4f4";
            ctx.fill();
            ctx.strokeStyle = "rgba(255,255,255,0.8)";
            ctx.lineWidth = 1;
            ctx.stroke();
          }
        }
      });
    }

    function hexA(hex, a) {
      if (hex[0] !== "#") return hex;
      const n = parseInt(hex.slice(1), 16);
      return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
    }

    ar.onFrame((now, dt) => {
      update(dt);
      draw();
    });
    return {
      actionLabel: "▶ Start",
      debug: {
        pads: () => pads,
        check: () => check,
        code: () => code.slice(),
        row: () => row.slice(),
        history: () => history.map((h) => ({ ...h, guess: h.guess.slice() })),
        state: () => state,
        score: () => score_,
      },
    };
  };
})(window.Lynx);
