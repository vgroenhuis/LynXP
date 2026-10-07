// Web Worker: checkerboard corners (camcal_checker.js) off the page's main
// thread, for the camera calibration (app_camcal.js).
//
// Messages in:  {type: "frame", id, width, height, gray (Float32Array buffer, transferred), opts}
// Messages out: {type: "corners", id, result: {points: [{i, j, u, v}], candidates} | null, ms}

self.window = self;
importScripts("camcal_checker.js");

onmessage = (ev) => {
  const m = ev.data;
  if (m.type !== "frame") return;
  const t0 = performance.now();
  let result = null;
  try {
    result = self.Lynx.camcalChecker.find(new Float32Array(m.gray), m.width, m.height, m.opts || {});
  } catch (e) {
    result = null;
  }
  postMessage({ type: "corners", id: m.id, result, ms: performance.now() - t0 });
};
