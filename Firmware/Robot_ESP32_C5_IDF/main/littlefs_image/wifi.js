// Saved Wi-Fi networks manager -- shared by the Main page's "Wi-Fi networks"
// panel and the standalone /wifi page (which is also the setup hotspot's
// captive-portal landing page). Talks to web_server.cpp's /wifi/* routes.
//
// Every SSID shown here comes from the air (anyone nearby can name their
// network "<img onerror=...>"), so all of it goes in via textContent, never
// innerHTML.

// Returns { start(), stop() } -- starts/stops polling /wifi/status.
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

function initWifiManager(root) {
  root.classList.add("wifi-mgr");
  root.innerHTML = `
    <div class="wifi-status" data-el="status">Loading...</div>
    <div class="wifi-status wifi-cam" data-el="cam"></div>
    <div class="wifi-success" data-el="success" hidden></div>
    <h4>Saved networks</h4>
    <ul class="wifi-list" data-el="saved"></ul>
    <h4 class="wifi-heading-row">Nearby networks
      <span class="wifi-actions">
        <button type="button" class="wifi-btn" data-el="scanBtn">Scan</button>
        <button type="button" class="wifi-btn" data-el="camScanBtn" title="Scan with the camera's own antenna (2.4 GHz only) -- it often hears networks the robot's board antenna misses">\u{1F4F7} Scan with camera</button>
      </span>
    </h4>
    <ul class="wifi-list" data-el="nearby"></ul>
    <h4>Add a network</h4>
    <form class="wifi-form" data-el="form" autocomplete="off">
      <input type="text" data-el="ssid" placeholder="Network name (SSID)" maxlength="32" autocapitalize="off" spellcheck="false">
      <input type="password" data-el="password" placeholder="Password (empty for an open network)" maxlength="64">
      <label class="wifi-show-pw"><input type="checkbox" data-el="showPw"> Show password</label>
      <button type="submit" class="wifi-btn wifi-btn-primary">Save</button>
    </form>
    <p class="wifi-msg" data-el="msg"></p>
    <label class="wifi-country"><input type="checkbox" data-el="prefer5"> Prefer 5 GHz
      <span class="wifi-dim">usually far less crowded (campuses, apartment blocks). The camera is 2.4 GHz only: it
        still works if the same router also has a 2.4 GHz network the camera knows.</span>
    </label>`;
  const el = {};
  root.querySelectorAll("[data-el]").forEach((e) => (el[e.dataset.el] = e));

  el.prefer5.addEventListener("change", () => {
    post("/wifi/prefs", { prefer5g: el.prefer5.checked }).then((r) => say(r.message, !r.ok)).catch(() => say("Couldn't reach LynXP.", true));
  });

  let timer = null;
  let running = false;
  let last = null;
  let pendingScanSeq = null; // set while waiting for a user-requested scan to finish
  let camScanWaiting = false; // a camera scan was requested from this page

  function li(...children) {
    const item = document.createElement("li");
    children.forEach((c) => c && item.appendChild(c));
    return item;
  }
  function span(text, cls) {
    const s = document.createElement("span");
    s.textContent = text;
    if (cls) s.className = cls;
    return s;
  }
  function button(text, onClick, cls) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "wifi-btn" + (cls ? " " + cls : "");
    b.textContent = text;
    b.addEventListener("click", onClick);
    return b;
  }
  function bars(rssi) {
    const n = rssi > -55 ? 4 : rssi > -67 ? 3 : rssi > -75 ? 2 : 1;
    return "▂▄▆█".slice(0, n).padEnd(4, "▁");
  }
  function say(text, isError) {
    el.msg.textContent = text || "";
    el.msg.classList.toggle("wifi-error", !!isError);
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body || {}),
    }).then((r) => {
      if (!r.ok) return r.text().then((t) => ({ ok: false, message: t || `HTTP ${r.status}` }));
      return r.json();
    });
  }

  function render(s) {
    last = s;
    if (typeof s.prefer5g === "boolean" && document.activeElement !== el.prefer5) el.prefer5.checked = s.prefer5g;
    const nearbyBySsid = new Map(s.nearby.map((n) => [n.ssid, n]));

    // -- status line --
    let status;
    if (s.connected) {
      status = `Connected to ${s.ssid} · ${s.ip} · ${s.rssi} dBm${s.on5GHz ? " (5 GHz)" : ""}`;
    } else if (s.connecting) {
      status = `Connecting to ${s.connectingSsid}...`;
    } else if (s.saved.length === 0) {
      status = "Not connected -- no saved networks yet. Add one below.";
    } else {
      status = "Not connected -- looking for a saved network in range.";
    }
    if (s.apActive) {
      status += ` Setup hotspot "${s.apSsid}" is on${s.viaAp ? " (you're connected through it)" : ""}.`;
    }
    el.status.textContent = status;

    // -- camera line: the S3 is 2.4 GHz only and follows the robot's network --
    let cam;
    const current = nearbyBySsid.get(s.ssid);
    if (!s.camLinked) {
      cam = "Camera: no link to the camera board.";
    } else if (s.connected && current && current.has5 && !current.has24 && !s.camSameLan) {
      cam = `Camera: can't follow -- "${s.ssid}" is 5 GHz only and the camera is 2.4 GHz only.`;
    } else if (s.camSsid) {
      const note = !s.connected || s.camSsid === s.ssid ? "" : s.camSameLan ? " (same router as the robot)" : " (moving it to this network...)";
      cam = `Camera: on ${s.camSsid} · ${s.camIp}${note}`;
    } else if (s.camIp && s.camIp !== "0.0.0.0") {
      // Older camera firmware: reports its IP but not which network it's on.
      cam = `Camera: on Wi-Fi · ${s.camIp}`;
    } else {
      cam = s.connected ? "Camera: joining this network..." : "Camera: not on Wi-Fi.";
    }
    el.cam.textContent = cam;
    el.cam.classList.toggle("wifi-error", cam.includes("can't follow"));

    // -- "it worked" banner for the setup-hotspot flow: the phone is still
    // on the hotspot and needs to hop back to the real network --
    if (s.viaAp && s.connected) {
      el.success.hidden = false;
      el.success.replaceChildren(
        span(`LynXP joined "${s.ssid}" at ${s.ip}. `),
        span(`Reconnect this phone to "${s.ssid}", then open `),
        Object.assign(document.createElement("a"), { href: `http://${s.ip}/`, textContent: `http://${s.ip}/` }),
        span(" (or http://lynxp.local/). The setup hotspot switches itself off once you've left it.")
      );
    } else {
      el.success.hidden = true;
    }

    // -- saved networks --
    const savedRows = s.saved.map((net) => {
      const seen = nearbyBySsid.get(net.ssid);
      const isCurrent = s.connected && net.ssid === s.ssid;
      const tags = [];
      if (isCurrent) tags.push(span("connected", "wifi-tag wifi-tag-ok"));
      else if (seen && seen.robotHears === false) tags.push(span("only the camera hears it", "wifi-tag wifi-tag-warn"));
      else if (seen) tags.push(span(`in range ${bars(seen.rssi)}`, "wifi-tag"));
      else tags.push(span("not in range", "wifi-tag wifi-tag-dim"));
      if (seen && seen.has5 && !seen.has24) tags.push(span("5 GHz only", "wifi-tag wifi-tag-warn"));
      if (net.open) tags.push(span("open", "wifi-tag wifi-tag-dim"));

      const name = span(net.ssid, "wifi-ssid");
      const actions = document.createElement("span");
      actions.className = "wifi-actions";
      if (!isCurrent) {
        actions.appendChild(
          button("Connect", () => {
            if (s.connected && !confirm(`Switch LynXP to "${net.ssid}"? This page may lose its connection.`)) return;
            post("/wifi/connect", { ssid: net.ssid }).then((r) => say(r.message, !r.ok)).catch(() => say("Request sent."));
          })
        );
      }
      actions.appendChild(
        button(
          "Forget",
          () => {
            const warn = isCurrent ? " LynXP is connected to it right now and will drop off this network." : "";
            if (!confirm(`Forget "${net.ssid}"?${warn}`)) return;
            post("/wifi/remove", { ssid: net.ssid })
              .then((r) => {
                say(r.message, !r.ok);
                refresh();
              })
              .catch(() => say("Request sent."));
          },
          "wifi-btn-danger"
        )
      );
      const main = document.createElement("span");
      main.className = "wifi-main";
      main.append(name, ...tags);
      return li(main, actions);
    });
    el.saved.replaceChildren(...(savedRows.length ? savedRows : [li(span("None yet.", "wifi-dim"))]));

    // -- nearby networks: click one to fill in the add form --
    const savedSet = new Set(s.saved.map((n) => n.ssid));
    const nearbyRows = s.nearby.map((net) => {
      const main = document.createElement("span");
      main.className = "wifi-main";
      const robotHears = net.robotHears !== false;
      main.append(span(net.ssid, "wifi-ssid"));
      if (robotHears) main.append(span(`${bars(net.rssi)} ${net.rssi} dBm`, "wifi-tag"));
      if (net.camRssi) {
        main.append(span(`\u{1F4F7} ${net.camRssi} dBm${robotHears ? "" : " -- robot can't hear it"}`, robotHears ? "wifi-tag wifi-tag-dim" : "wifi-tag wifi-tag-warn"));
      }
      if (net.secure) main.append(span("\u{1F512}", "wifi-tag"));
      const band = net.has24 && net.has5 ? "2.4+5 GHz" : net.has5 ? "5 GHz only" : "2.4 GHz";
      main.append(span(net.channel ? `${band} · ch ${net.channel}` : band, net.has5 && !net.has24 ? "wifi-tag wifi-tag-warn" : "wifi-tag wifi-tag-dim"));
      if (savedSet.has(net.ssid)) main.append(span("saved", "wifi-tag wifi-tag-ok"));
      const row = li(main);
      row.classList.add("wifi-pickable");
      row.title = "Use this network";
      row.addEventListener("click", () => {
        el.ssid.value = net.ssid;
        el.password.value = "";
        if (net.secure) el.password.focus();
        say(net.has5 && !net.has24 ? "Note: 5 GHz only -- LynXP can use it, but the camera (2.4 GHz only) can't." : "");
      });
      return row;
    });
    const scanNote = s.scanning ? "Scanning..." : "No networks found yet -- press Scan.";
    el.nearby.replaceChildren(...(nearbyRows.length ? nearbyRows : [li(span(scanNote, "wifi-dim"))]));

    if (pendingScanSeq !== null && s.scanSeq !== pendingScanSeq && !s.scanning) pendingScanSeq = null;
    const scanBusy = s.scanning || pendingScanSeq !== null;
    el.scanBtn.disabled = scanBusy;
    el.scanBtn.textContent = scanBusy ? "Scanning..." : "Scan";

    // Camera scan: its own antenna, 2.4 GHz only. Results merge into the
    // list above (marked with the camera icon, or "robot can't hear it").
    el.camScanBtn.disabled = !s.camLinked || s.camScan === "scanning";
    el.camScanBtn.textContent = s.camScan === "scanning" ? "\u{1F4F7} Scanning..." : "\u{1F4F7} Scan with camera";
    el.camScanBtn.title = s.camLinked ? el.camScanBtn.title : "The camera isn't linked to the robot";
    if (camScanWaiting && s.camScan !== "scanning") {
      camScanWaiting = false;
      if (s.camScan === "noanswer") say("The camera didn't answer -- it needs newer firmware (flash it over USB).", true);
      else say("Camera scan done -- camera-heard networks are marked \u{1F4F7}.");
    }
  }

  function refresh() {
    return fetchWithTimeout("/wifi/status", 5000, { cache: "no-store" })
      .then(render)
      .catch(() => {
        el.status.textContent = "Can't reach LynXP -- if it just switched networks, reconnect to that network.";
      });
  }

  function schedule() {
    clearTimeout(timer);
    if (!running) return;
    // Poll faster while a scan the user asked for is in flight.
    timer = setTimeout(() => refresh().finally(schedule), pendingScanSeq !== null || camScanWaiting ? 700 : 2500);
  }

  el.scanBtn.addEventListener("click", () => {
    pendingScanSeq = last ? last.scanSeq : 0;
    el.scanBtn.disabled = true;
    el.scanBtn.textContent = "Scanning...";
    post("/wifi/scan").catch(() => {});
    schedule();
  });

  el.camScanBtn.addEventListener("click", () => {
    el.camScanBtn.disabled = true;
    el.camScanBtn.textContent = "\u{1F4F7} Scanning...";
    post("/wifi/scan?source=camera")
      .then((r) => {
        if (!r.ok) return say(r.message, true);
        camScanWaiting = true;
        say("The camera is scanning (its picture may stall for a moment)...");
        schedule();
      })
      .catch(() => say("Couldn't reach LynXP.", true));
  });

  el.showPw.addEventListener("change", () => {
    el.password.type = el.showPw.checked ? "text" : "password";
  });

  el.form.addEventListener("submit", (e) => {
    e.preventDefault();
    const ssid = el.ssid.value.trim();
    const password = el.password.value;
    if (!ssid) return say("Enter the network name.", true);
    if (password.length > 0 && password.length < 8) return say("A WPA2 password is at least 8 characters.", true);
    say("Saving...");
    post("/wifi/add", { ssid, password })
      .then((r) => {
        say(r.message, !r.ok);
        if (r.ok) {
          el.password.value = "";
          refresh();
        }
      })
      .catch(() => say("Couldn't reach LynXP.", true));
  });

  return {
    start() {
      if (running) return;
      running = true;
      refresh().finally(schedule);
    },
    stop() {
      running = false;
      clearTimeout(timer);
    },
  };
}
