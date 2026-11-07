// English / Dutch for the robot's pages (Dutch children play with LynXP).
// Load it first, in <head>: <script src="i18n.js"></script>.
//
// The pages and games are written in English; Dutch comes from one table,
// nl.js (Lynx.NL: {"English text": "Nederlandse tekst"}), applied where text
// reaches the screen -- so the games themselves don't change:
//   - Lynx.tr(text): the Dutch for a piece of text (unchanged in English, or
//     when the table has nothing for it). ar.text() runs everything drawn
//     over the video through it, Block Quest's wrapText() too (before it
//     breaks lines);
//   - the pages' own text (the HTML and what scripts put in it, also later)
//     is translated in place, text node by text node -- or, for a paragraph
//     with links / <code> / <em> in it, as a whole (a key with the HTML).
// Table keys may hold {} for any text (`${...}` in the source): "Level {}
// cleared" -> "Level {} gehaald"; {0} {1} in the Dutch reorder them. What a
// {} stands for is translated too, if the table has it (a game's name).
// Numbers match whatever is there ("starting in {} s" covers 1.3 and 0.4).
//
// The language: the EN / NL button on every page (remembered in this
// browser), else the browser's own language. Elements with translate="no"
// (and <code>, <pre>, inputs) are left alone.

window.Lynx = window.Lynx || {};

(function (Lynx) {
  const KEY = "lynxLang";
  let lang = null;
  try {
    lang = localStorage.getItem(KEY);
  } catch (e) {
    // (not remembered: the browser's language)
  }
  if (lang !== "en" && lang !== "nl") lang = /^nl\b/i.test(navigator.language || "") ? "nl" : "en";
  Lynx.lang = lang;
  // The Dutch table only when it's needed (~30 KB from the robot): loaded
  // right here, while the page is still being read -- so before its scripts
  // run and before DOMContentLoaded.
  if (lang === "nl" && !Lynx.NL && document.readyState === "loading") document.write('<script src="nl.js"><\/script>');
  Lynx.setLang = (l) => {
    try {
      localStorage.setItem(KEY, l);
    } catch (e) {
      // (only for this page then)
    }
    location.reload();
  };

  // -- the table -------------------------------------------------------------------
  let exact = null; // Map: English -> Dutch
  let upper = null; // Map: ENGLISH -> Dutch (for text in capitals: titles, banners)
  let pats = null; // [{re, nl}] for keys with {}
  let html = null; // Map: normalized innerHTML -> Dutch HTML
  const esc = (s) => s.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");
  function compile() {
    exact = new Map();
    upper = new Map();
    pats = [];
    html = new Map();
    Object.entries(Lynx.NL || {}).forEach(([k, v]) => {
      if (/<[a-z]/i.test(k)) html.set(k.replace(/\s+/g, " ").trim(), v);
      else if (k.includes("{}")) {
        const parts = k.split("{}");
        pats.push({ re: new RegExp("^" + parts.map(esc).join("([\\s\\S]+?)") + "$"), nl: v, lit: k.length - 2 * (parts.length - 1) });
      } else {
        exact.set(k, v);
        if (!upper.has(k.toUpperCase())) upper.set(k.toUpperCase(), v);
      }
    });
    pats.sort((a, b) => b.lit - a.lit); // (the most specific first)
  }

  const cache = new Map(); // text -> Dutch, or null (none)
  const bySkeleton = new Map(); // the text with its numbers blanked -> the pattern that fit it (index, -1: none)
  const CACHE_MAX = 4000;
  let depth = 0;

  function fill(nl, caps) {
    let i = 0;
    return nl.replace(/\{(\d*)\}/g, (_, d) => {
      const c = caps[d === "" ? i++ : +d];
      return c === undefined ? "" : tr(c);
    });
  }
  function lookPattern(core) {
    const sk = core.replace(/\d+(?:[.,]\d+)*/g, "#");
    const known = bySkeleton.get(sk);
    if (known !== undefined) {
      if (known < 0) return null;
      const m = pats[known].re.exec(core);
      if (m) return fill(pats[known].nl, m.slice(1));
    }
    for (let i = 0; i < pats.length; i++) {
      const m = pats[i].re.exec(core);
      if (m) {
        bySkeleton.set(sk, i);
        return fill(pats[i].nl, m.slice(1));
      }
    }
    bySkeleton.set(sk, -1);
    return null;
  }
  function look(core) {
    const e = exact.get(core);
    if (e !== undefined) return e;
    // (a sentence ending in a full stop, or not)
    if (/[.!:]$/.test(core)) {
      const e2 = exact.get(core.slice(0, -1));
      if (e2 !== undefined) return e2 + core.slice(-1);
    }
    // (a name in capitals, "THE SUNBEAM VAULT": the Dutch in capitals too)
    if (/[A-Z]/.test(core) && core === core.toUpperCase()) {
      const u = upper.get(core);
      if (u !== undefined) return u.toUpperCase();
    }
    if (depth > 3) return null;
    // (an icon or symbol in front, "🐑 Shepherd" in the game menu: the rest)
    const ic = /^([^A-Za-z0-9]+\s+)([A-Za-z][\s\S]*)$/.exec(core);
    if (ic) {
      const t = look(ic[2]);
      if (t !== null) return ic[1] + t;
    }
    return lookPattern(core);
  }
  function tr(s) {
    if (lang !== "nl" || typeof s !== "string" || !s || !/[A-Za-z]/.test(s)) return s;
    if (!exact) {
      if (!Lynx.NL) return s;
      compile();
    }
    let r = cache.get(s);
    if (r === undefined) {
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
      depth++;
      let core = null;
      try {
        core = look(m[2].replace(/ /g, " ").replace(/[ \t]*\n[ \t]*/g, " ")); // (&nbsp; and the HTML's line breaks: plain spaces)
      } finally {
        depth--;
      }
      r = core === null ? null : m[1] + core + m[3];
      if (cache.size > CACHE_MAX) {
        cache.clear();
        bySkeleton.clear();
      }
      cache.set(s, r);
    }
    return r === null ? s : r;
  }
  Lynx.tr = tr;

  // -- the pages -------------------------------------------------------------------
  if (lang === "nl") document.documentElement.lang = "nl";
  const SKIP = "script, style, code, pre, textarea, kbd, [translate='no']";
  const INLINE = /^(A|B|BR|CODE|EM|I|KBD|SMALL|SPAN|STRONG|SUB|SUP)$/;
  const ATTRS = ["placeholder", "title", "aria-label", "alt"];

  function mixed(el) {
    let text = false;
    let tags = false;
    for (const c of el.childNodes) {
      if (c.nodeType === 3 && c.nodeValue.trim()) text = true;
      else if (c.nodeType === 1) {
        if (!INLINE.test(c.tagName)) return false;
        tags = true;
      }
    }
    return text && tags;
  }
  function trElement(el) {
    if (el.closest(SKIP)) return;
    ATTRS.forEach((a) => {
      const v = el.getAttribute(a);
      if (v) {
        const t = tr(v);
        if (t !== v) el.setAttribute(a, t);
      }
    });
    if (el.tagName === "INPUT" && /^(button|submit|reset)$/i.test(el.type) && el.value) {
      const t = tr(el.value);
      if (t !== el.value) el.value = t;
    }
    if (html && html.size && mixed(el)) {
      const t = html.get(el.innerHTML.replace(/\s+/g, " ").trim());
      if (t !== undefined) {
        el.innerHTML = t;
        return;
      }
    }
    for (const c of Array.from(el.childNodes)) trNode(c);
  }
  function trNode(n) {
    if (n.nodeType === 3) {
      const p = n.parentElement;
      if (!p || p.closest(SKIP)) return;
      const t = tr(n.nodeValue);
      if (t !== n.nodeValue) n.nodeValue = t;
    } else if (n.nodeType === 1) trElement(n);
  }
  Lynx.trElement = (el) => lang === "nl" && trNode(el);

  // The EN / NL button: in the page's top bar, or the first-person view's menu.
  function addButton() {
    if (document.getElementById("langBtn")) return;
    const b = document.createElement("button");
    b.id = "langBtn";
    b.type = "button";
    b.setAttribute("translate", "no");
    b.textContent = lang === "nl" ? "EN" : "NL";
    b.title = lang === "nl" ? "Switch to English" : "Nederlands";
    b.addEventListener("click", () => Lynx.setLang(lang === "nl" ? "en" : "nl"));
    const nav = document.querySelector(".top-nav");
    const menu = document.querySelector("#camMenuPanel .cam-menu-panel-body");
    if (nav) {
      b.className = "nav-link lang-btn";
      nav.appendChild(b);
    } else if (menu) {
      b.className = "cam-overlay-btn lang-btn";
      b.textContent = lang === "nl" ? "English" : "Nederlands";
      menu.insertBefore(b, menu.querySelector("#gamepadStatus"));
    } else {
      b.className = "lang-btn lang-btn-float";
      document.body.appendChild(b);
    }
  }

  function start() {
    addButton();
    if (lang !== "nl") return;
    document.title = tr(document.title);
    trNode(document.body);
    new MutationObserver((list) => {
      list.forEach((m) => {
        if (m.type === "characterData") trNode(m.target);
        else if (m.type === "attributes") trElement(m.target);
        else m.addedNodes.forEach(trNode);
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(window.Lynx);
