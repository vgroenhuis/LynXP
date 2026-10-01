// Web Worker: AprilTag detection for tagblocks.js, off the page's main
// thread. The AprilTag C library compiled to WebAssembly (the
// arenaxr/apriltag-js-standalone wrapper, BSD-3-Clause), one build per tag
// family, loaded from jsDelivr at pinned commits (immutable URLs, cached for
// good -- nothing in LittleFS):
//   tag16h5  -- vgroenhuis/AprilTagDetector (AprilTag 3, its output extended
//               with each detection's bit errors and decision margin)
//   tag36h11 -- arenaxr/apriltag-js-standalone
// tag16h5 has only 30 codes, 5 bits apart, so stray quads decode as tags
// now and then: like AprilTagDetector, only exact codes with a decision
// margin of 25+ count (tagblocks.js then wants two sightings per block).
//
// Messages in:  {type: "family", family} (first; loads the detector)
//               {type: "frame", id, width, height, rgba (ArrayBuffer, transferred)}
// Messages out: {type: "ready"} | {type: "error", message}
//               {type: "detections", id, detections: [{id, corners: [{x, y} x4], margin}], ms}
// Corners wrap round the tag in order (the C library's p[0..3]).

const BUILDS = {
  tag16h5: { base: "https://cdn.jsdelivr.net/gh/vgroenhuis/AprilTagDetector@f0fca90e6e3a1b45152f68e35307a91f9c820e53/", ids: 30, minMargin: 25 },
  tag36h11: { base: "https://cdn.jsdelivr.net/gh/arenaxr/apriltag-js-standalone@f0fe55676265a1251ad36f18bac9939206a59e19/html/", ids: 587, minMargin: 0 },
};
const MIN_SIDE_PX = 10;

let detect = null; // (rgba, width, height) -> detections

function load(family) {
  const build = BUILDS[family] || BUILDS.tag16h5;
  importScripts(build.base + "apriltag_wasm.js");
  self.AprilTagWasm({ locateFile: (path) => build.base + path })
    .then((Module) => {
      const init = Module.cwrap("atagjs_init", "number", []);
      const setOptions = Module.cwrap("atagjs_set_detector_options", "number", ["number", "number", "number", "number", "number", "number", "number"]);
      const setBuffer = Module.cwrap("atagjs_set_img_buffer", "number", ["number", "number", "number"]);
      const run = Module.cwrap("atagjs_detect", "number", []);
      init();
      // decimate 1 (small tags), sigma 0, 1 thread, refine edges, all detections, no pose (tagblocks.js does it, with the lens)
      setOptions(1.0, 0.0, 1, 1, 0, 0, 0);
      detect = (rgba, width, height) => {
        const buf = setBuffer(width, height, width);
        const heap = Module.HEAPU8;
        for (let i = 0, j = 0, n = width * height; j < n; i += 4, j++) heap[buf + j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
        const ptr = run();
        const len = Module.getValue(ptr, "i32");
        if (len <= 0) return [];
        const strPtr = Module.getValue(ptr + 4, "i32");
        let parsed;
        try {
          parsed = JSON.parse(new TextDecoder().decode(Module.HEAPU8.subarray(strPtr, strPtr + len)));
        } catch (e) {
          return [];
        }
        if (!Array.isArray(parsed)) return [];
        return parsed.filter((d) => {
          if (!(d.id >= 0 && d.id < build.ids)) return false;
          if (typeof d.hamming === "number" && d.hamming > 0) return false;
          if (typeof d.margin === "number" && d.margin < build.minMargin) return false;
          const c = d.corners;
          const sides = c.map((p, i) => Math.hypot(p.x - c[(i + 1) % 4].x, p.y - c[(i + 1) % 4].y));
          return Math.min(...sides) >= MIN_SIDE_PX && Math.min(...sides) / Math.max(...sides) >= 0.3;
        }).map((d) => ({ id: d.id, corners: d.corners, margin: d.margin }));
      };
      postMessage({ type: "ready" });
    })
    .catch((e) => postMessage({ type: "error", message: `Tag detector didn't load: ${e && e.message ? e.message : e}` }));
}

onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "family") {
    if (detect) return;
    try {
      load(m.family);
    } catch (e) {
      postMessage({ type: "error", message: `Tag detector didn't load (offline?): ${e && e.message ? e.message : e}` });
    }
    return;
  }
  if (m.type !== "frame" || !detect) return;
  const t0 = performance.now();
  let detections = [];
  try {
    detections = detect(new Uint8ClampedArray(m.rgba), m.width, m.height);
  } catch (e) {
    detections = [];
  }
  postMessage({ type: "detections", id: m.id, detections, ms: performance.now() - t0 });
};
