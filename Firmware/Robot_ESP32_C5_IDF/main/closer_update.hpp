#pragma once

// Updates from the CloSer lab demos server, the way the other lab demos get
// theirs: a heartbeat reply can offer a release ("update": version, sha256,
// size, path, and "fs" for the web files), published on the server with
// `python -m labdemos.cli publish lynxp-one build/LynXP.bin --fs build/storage.bin`.
// The robot downloads it over HTTPS with its own device key -- wherever it
// is, home network or iotroam, the server never has to reach it -- checks
// both SHA-256s, writes the web files (only the sectors that differ) and the
// app, and restarts into the new app.
//
// The camera (ESP32-S3) too, if the release has its app ("cam", published
// with --cam): the robot asks the camera which version it runs (GET /status
// on the camera), and if that's another one it downloads the camera's app,
// checks it and uploads it to the camera's POST /update (with the OTA
// password the robot gives the camera over the SPI link) -- before its own
// app, since a new robot app may count on the new camera. A camera that
// comes back with its old version (rejected, or rolled back) isn't sent that
// version again. A camera without Wi-Fi isn't updated.
//
// The robot stops while the update is written (cyan LED, OLED says so),
// also with its page open. A download that breaks off resumes where it
// was; a failed one is tried again after 5, 10, 20, 40, then every 60 min.
//
// Rollback: the new app must reach the server (one report) within 5 minutes,
// besides ota.cpp's own checks, or it goes back to the previous app and that
// version isn't tried again. (The web files stay new: they are written in
// place, there is no second copy.) Updates through /update are not affected.

// Call once from closer_report_start(), before the first report.
void closer_update_init();

// The heartbeat reply (JSON text): starts an update if it offers one. Also
// tells this module the server answered (for the rollback check above).
void closer_update_on_reply(const char *replyJson);

// Runs the update closer_update_on_reply() found, if any (minutes; the robot
// restarts at the end if it installed its own app). Called by the report
// task after each report, outside the report's own HTTP request.
void closer_update_run_pending();

// For ota.cpp's validation: false only after an update from the server,
// until the new app's first report got through.
bool closer_update_may_validate();

// What the update module is doing or last did, for the serial console and
// the heartbeat's "message" ("" = nothing to say).
const char *closer_update_state();

// Console `closer update`: forget the wait after a failed download (the next
// report may start it again at once).
void closer_update_retry_now();

// True while an update is being downloaded or written (the OLED says so).
bool closer_update_busy();

// GET /api/update (status) and POST /api/update/check (the page's "Check for
// updates": a report right away). Call once after web_server_init().
void closer_update_register_routes();
