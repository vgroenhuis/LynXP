#pragma once

// Stores the object-detection model (a YOLOv8n ONNX file, ~6 MB -- far too
// big for the 1 MB LittleFS partition) in its own raw "model" flash
// partition and serves it to the browser, which runs it (detect.js). Served
// from the robot itself rather than a third-party host so it keeps working
// as long as the robot does; browsers cache it for good after the first
// load (the URL carries the model's checksum, so a new model busts the cache).
//
//   GET  /models/info            {"installed","name","bytes","version","capacity"}
//   GET  /models/model.onnx?v=.. the model bytes
//   POST /models/upload?name=..  raw body = the .onnx file (OTA credentials apply)
//
// Partition layout: sector 0 holds a small header (magic, size, FNV-1a
// checksum, file name), the file starts at offset 4096. The header is only
// written after the whole file has been, so an interrupted upload reads as
// "not installed" rather than a truncated model.

// Registers the routes above. Call after web_server_init().
void model_store_register_routes();
