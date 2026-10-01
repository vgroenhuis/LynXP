// Web Worker: AprilTag detection (tag36h11) for tagblocks.js, off the page's
// main thread. The detector is the AprilTag C library compiled to
// WebAssembly by arenaxr/apriltag-js-standalone (BSD-3-Clause), loaded from
// jsDelivr at a pinned commit (an immutable URL: cached for good, ~190 KB),
// like the detection model and onnxruntime-web -- nothing extra in LittleFS.
//
// Messages in:  {type: "options", decimate, sigma, refine}
//               {type: "frame", id, width, height, rgba (ArrayBuffer, transferred)}
// Messages out: {type: "ready"} | {type: "error", message}
//               {type: "detections", id, detections: [{id, corners: [{x, y} x4], center}], ms}
// Corners wrap counter-clockwise around the tag in the image, starting at the
// tag's (-1, +1) corner (the C library's p[0..3]).

const BASE = "https://cdn.jsdelivr.net/gh/arenaxr/apriltag-js-standalone@f0fe55676265a1251ad36f18bac9939206a59e19/html/";

let mod = null;
let api = null;
const opts = { decimate: 1.0, sigma: 0.0, refine: 1 }; // full resolution: small tags (22.5 mm) get sharper corners

function applyOptions() {
  // decimate, sigma, nthreads, refine_edges, max_detections (0 = all), return_pose, return_solutions
  api.setOptions(opts.decimate, opts.sigma, 1, opts.refine, 0, 0, 0);
}

try {
  importScripts(BASE + "apriltag_wasm.js");
  AprilTagWasm({ locateFile: (path) => BASE + path })
    .then((Module) => {
      mod = Module;
      api = {
        init: Module.cwrap("atagjs_init", "number", []),
        setOptions: Module.cwrap("atagjs_set_detector_options", "number", ["number", "number", "number", "number", "number", "number", "number"]),
        setBuffer: Module.cwrap("atagjs_set_img_buffer", "number", ["number", "number", "number"]),
        detect: Module.cwrap("atagjs_detect", "number", []),
      };
      api.init();
      applyOptions();
      postMessage({ type: "ready" });
    })
    .catch((e) => postMessage({ type: "error", message: `AprilTag detector didn't load: ${e && e.message ? e.message : e}` }));
} catch (e) {
  postMessage({ type: "error", message: `AprilTag detector didn't load (offline?): ${e && e.message ? e.message : e}` });
}

onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "options") {
    Object.assign(opts, m.options || {});
    if (api) applyOptions();
    return;
  }
  if (m.type !== "frame" || !api) return;
  const t0 = performance.now();
  const { width, height } = m;
  const rgba = new Uint8Array(m.rgba);
  const buf = api.setBuffer(width, height, width);
  const heap = mod.HEAPU8;
  // grayscale, straight into the detector's buffer
  for (let i = 0, j = 0, n = width * height; j < n; i += 4, j++) {
    heap[buf + j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
  const ptr = api.detect();
  const len = mod.getValue(ptr, "i32");
  let detections = [];
  if (len > 0) {
    const strPtr = mod.getValue(ptr + 4, "i32");
    const text = new TextDecoder().decode(mod.HEAPU8.subarray(strPtr, strPtr + len));
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) detections = parsed;
    } catch (e) {
      // (an error string) -- no detections this frame
    }
  }
  postMessage({ type: "detections", id: m.id, detections, ms: performance.now() - t0 });
};
