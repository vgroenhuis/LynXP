# Files served to browsers from a CDN

Big files the web UI needs but the robot doesn't store: browsers fetch them
straight from GitHub through jsDelivr, e.g.

    https://cdn.jsdelivr.net/gh/vgroenhuis/LynXP@model-yolov8n-lynxp-1/Firmware/Robot_ESP32_C5_IDF/cdn/yolov8n-lynxp.onnx

Always reference them by a **tag** (never a branch): the URL then never changes
content, so browsers and the CDN can cache it for good. A new version of a
file gets a new tag, and `detect.js` is pointed at it.

- `yolov8n-lynxp.onnx` -- the object-detection model (YOLOv8n, fp16 weights,
  6.8 MB) used by `main/littlefs_image/detect.js`. Built by
  `tools/export_yolo_model.py`. Tag `model-yolov8n-lynxp-1`.
