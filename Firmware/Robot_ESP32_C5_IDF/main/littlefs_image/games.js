// Games & apps page: choose what the first-person view runs, edit each
// game's settings (generated from Lynx.CATALOG's schema), see the
// scoreboards, and manage the object-detection model. Everything saved goes
// to the robot (/appdata/settings, /appdata/scores).

(function () {
  let app = null;
  let editing = null; // catalog id whose settings are shown
  let saveTimer = null;

  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, children = []) => {
    const e = Object.assign(document.createElement(tag), props);
    children.forEach((c) => c && e.appendChild(typeof c === "string" ? document.createTextNode(c) : c));
    return e;
  };

  function save() {
    clearTimeout(saveTimer);
    $("savedNote").textContent = "saving...";
    saveTimer = setTimeout(() => {
      Lynx.saveAppSettings(app)
        .then(() => ($("savedNote").textContent = "saved ✓"))
        .catch(() => ($("savedNote").textContent = "couldn't save -- is the robot reachable?"));
    }, 350);
  }

  // -- catalog cards -------------------------------------------------------------
  function renderCatalog() {
    const grid = $("catalog");
    grid.replaceChildren();
    Lynx.CATALOG.forEach((entry) => {
      const active = app.active === entry.id;
      const card = el("div", { className: "games-card" + (active ? " games-card-active" : "") + (editing === entry.id ? " games-card-editing" : "") });
      card.appendChild(el("div", { className: "games-card-icon", textContent: entry.icon }));
      const body = el("div", { className: "games-card-body" });
      body.appendChild(el("div", { className: "games-card-title" }, [
        entry.name,
        entry.kind !== "none" ? el("span", { className: "games-tag", textContent: entry.kind === "app" ? "app" : "game" }) : null,
        entry.needsModel ? el("span", { className: "games-tag games-tag-ai", textContent: "YOLOv8" }) : null,
      ]));
      body.appendChild(el("div", { className: "games-card-blurb", textContent: entry.blurb }));
      const actions = el("div", { className: "games-card-actions" });
      const selectBtn = el("button", { type: "button", className: "games-btn" + (active ? " games-btn-on" : ""), textContent: active ? "✓ Active" : "Use this" });
      selectBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        app.active = entry.id;
        editing = entry.id;
        save();
        renderAll();
      });
      actions.appendChild(selectBtn);
      body.appendChild(actions);
      card.appendChild(body);
      card.addEventListener("click", () => {
        editing = entry.id;
        renderAll();
      });
      grid.appendChild(card);
    });
    $("playBtn").textContent = app.active === "none" ? "▶ Open first-person view" : `▶ Play ${Lynx.findEntry(app.active).name}`;
  }

  // -- settings form ---------------------------------------------------------------
  function fieldFor(spec, values, onChange) {
    const row = el("label", { className: "games-field" });
    row.appendChild(el("span", { className: "games-field-label", textContent: spec.label + (spec.unit ? ` (${spec.unit})` : "") }));
    if (spec.type === "number") {
      const input = el("input", { type: "number", min: spec.min, max: spec.max, step: spec.step, value: values[spec.key] });
      input.addEventListener("change", () => {
        let v = parseFloat(input.value);
        if (Number.isNaN(v)) v = spec.def;
        v = Math.min(spec.max, Math.max(spec.min, v));
        input.value = v;
        values[spec.key] = v;
        onChange();
      });
      row.appendChild(input);
    } else if (spec.type === "select") {
      const sel = el("select");
      spec.options.forEach(([value, label]) => sel.appendChild(el("option", { value, textContent: label })));
      sel.value = values[spec.key];
      sel.addEventListener("change", () => {
        values[spec.key] = sel.value;
        onChange();
      });
      row.appendChild(sel);
    } else if (spec.type === "checkbox") {
      const cb = el("input", { type: "checkbox", checked: !!values[spec.key] });
      cb.addEventListener("change", () => {
        values[spec.key] = cb.checked;
        onChange();
      });
      row.classList.add("games-field-check");
      row.insertBefore(cb, row.firstChild);
    } else if (spec.type === "classes") {
      // Toggle chips for a set of COCO classes, stored comma-separated.
      row.classList.add("games-field-wide");
      const chosen = new Set(String(values[spec.key] || "").split(",").map((s) => s.trim()).filter(Boolean));
      const chips = el("div", { className: "games-chips" });
      (spec.options || Lynx.COCO_CLASSES).forEach((cls) => {
        const chip = el("button", { type: "button", className: "games-chip" + (chosen.has(cls) ? " games-chip-on" : ""), textContent: `${Lynx.emojiFor(cls)} ${cls}` });
        chip.addEventListener("click", (e) => {
          e.preventDefault();
          if (chosen.has(cls)) chosen.delete(cls);
          else chosen.add(cls);
          chip.classList.toggle("games-chip-on");
          values[spec.key] = Array.from(chosen).join(",");
          onChange();
        });
        chips.appendChild(chip);
      });
      row.appendChild(chips);
      if (spec.hint) row.appendChild(el("span", { className: "games-dim games-small", textContent: spec.hint }));
    }
    return row;
  }

  function renderSettings() {
    const entry = Lynx.findEntry(editing);
    $("settingsTitle").textContent = `${entry.icon} ${entry.name}`;
    $("settingsBlurb").textContent = entry.blurb;
    const form = $("settingsForm");
    form.replaceChildren();
    if (!entry.settings.length) form.appendChild(el("p", { className: "games-dim", textContent: "No settings." }));
    entry.settings.forEach((spec) => form.appendChild(fieldFor(spec, app[entry.id], save)));
    if (entry.settings.length) {
      const reset = el("button", { type: "button", className: "games-btn games-btn-quiet", textContent: "Reset to defaults" });
      reset.addEventListener("click", () => {
        entry.settings.forEach((s) => (app[entry.id][s.key] = s.def));
        save();
        renderSettings();
      });
      form.appendChild(reset);
    }
  }

  function renderGeneral() {
    const form = $("generalForm");
    form.replaceChildren();
    Lynx.GENERAL_SETTINGS.forEach((spec) => form.appendChild(fieldFor(spec, app.general, save)));
  }

  // -- scoreboards ---------------------------------------------------------------
  function renderBoards() {
    Lynx.loadScores().then((all) => {
      const wrap = $("boards");
      wrap.replaceChildren();
      Lynx.CATALOG.forEach((entry) => (entry.boards || []).forEach((board) => {
        const list = Array.isArray(all[board.key]) ? all[board.key] : [];
        const box = el("div", { className: "games-board" });
        const head = el("div", { className: "games-board-head" }, [el("strong", { textContent: `${entry.icon} ${board.title}` })]);
        if (list.length) {
          const clear = el("button", { type: "button", className: "games-btn games-btn-quiet", textContent: "Clear" });
          clear.addEventListener("click", () => {
            if (!confirm(`Clear the ${board.title} scoreboard?`)) return;
            delete all[board.key];
            fetch("/appdata/scores", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(all) }).then(renderBoards);
          });
          head.appendChild(clear);
        }
        box.appendChild(head);
        if (!list.length) {
          box.appendChild(el("div", { className: "games-dim games-small", textContent: "No scores yet." }));
        } else {
          const table = el("table", { className: "games-score-table" });
          list.forEach((row, i) =>
            table.appendChild(el("tr", {}, [
              el("td", { textContent: `${i + 1}.` }),
              el("td", { textContent: row.n }),
              el("td", { className: "games-score", textContent: Lynx.formatScore(board, row.s) }),
              el("td", { className: "games-dim", textContent: row.d || "" }),
            ])));
          box.appendChild(table);
        }
        wrap.appendChild(box);
      }));
    });
  }

  // -- detection model -----------------------------------------------------------
  // The model comes from a URL (jsDelivr by default, see detect.js); a custom
  // one is kept per browser in localStorage "detectModelUrl".
  function renderModelStatus() {
    let custom = "";
    try {
      custom = localStorage.getItem("detectModelUrl") || "";
    } catch (e) {
      // no storage: the standard model
    }
    if (document.activeElement !== $("modelUrl")) $("modelUrl").value = custom;
    $("modelStatus").textContent = custom ? "Using a custom model on this browser." : `Standard model: ${Lynx.detectModelUrl()}`;
    $("modelStatus").className = "games-model-status " + (custom ? "games-warn" : "games-ok");
  }

  function benchmark() {
    const btn = $("benchBtn");
    btn.disabled = true;
    const msg = $("modelMsg");
    Lynx.loadDetector((s) => (msg.textContent = s))
      .then(async (session) => {
        const size = Number(app.detect.inputSize) || 320;
        const c = document.createElement("canvas");
        c.width = 640;
        c.height = 480;
        const g = c.getContext("2d");
        g.fillStyle = "#789";
        g.fillRect(0, 0, 640, 480);
        msg.textContent = "Running...";
        await Lynx.detectOnce(session, c, 640, 480, size, 0.5, null); // warm-up
        const t0 = performance.now();
        const runs = 3;
        for (let i = 0; i < runs; i++) await Lynx.detectOnce(session, c, 640, 480, size, 0.5, null);
        const ms = (performance.now() - t0) / runs;
        msg.textContent = `${Math.round(ms)} ms per frame at ${size} px on this device → about ${(1000 / ms).toFixed(1)} detections per second.`;
      })
      .catch((e) => (msg.textContent = e.message || String(e)))
      .finally(() => (btn.disabled = false));
  }

  function renderAll() {
    renderCatalog();
    renderSettings();
  }

  // -- init --------------------------------------------------------------------------
  $("playerName").value = Lynx.playerName();
  $("playerName").addEventListener("change", (e) => Lynx.setPlayerName(e.target.value));
  $("modelUrl").addEventListener("change", (e) => {
    const url = e.target.value.trim();
    try {
      if (url) localStorage.setItem("detectModelUrl", url);
      else localStorage.removeItem("detectModelUrl");
    } catch (err) {
      // no storage: nothing to remember
    }
    $("modelMsg").textContent = url ? "Custom model set -- press Speed test to try it." : "Back to the standard model.";
    renderModelStatus();
  });
  $("benchBtn").addEventListener("click", benchmark);

  Lynx.loadAppSettings().then((settings) => {
    app = settings;
    editing = app.active === "none" ? "demons" : app.active;
    renderAll();
    renderGeneral();
    renderBoards();
    renderModelStatus();
  });
})();

// The exact origin to allow in Chrome's insecure-origin flag (see the Gamepad notes).
document.querySelectorAll(".robot-origin").forEach((el) => (el.textContent = location.origin));
