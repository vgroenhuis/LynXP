#pragma once

#include "esp_http_server.h"

// ESP-IDF replacement for Robot_Pico2W_SDK/src/web_server.cpp's Mongoose
// layer. Routes, JSON field names, and static-file cache policy are all
// kept byte-identical to the Pico build so app.js/cam.js (copied over
// unmodified) work without any client-side changes. See the mg_* ->
// esp_http_server/cJSON mapping table in the migration plan.
//
// The WebSocket route (/ws) and the poll-loop-driven telemetry broadcast
// live in ws_broadcast.hpp/.cpp instead (milestone D) -- everything else
// (static files, /params, /set, /pose, /pose_reset, /wifi, /waypoints)
// is here.

// Starts the HTTP server and registers every route. Call once from
// app_main(), after settings are loaded and wifi_connect_start() has run
// (Wi-Fi doesn't need to be UP yet -- httpd binds regardless).
void web_server_init();

// Returns the running server handle, or nullptr if not started yet.
// ws_broadcast.cpp needs this to register the /ws handler on the same
// server instance and to enumerate connected clients for telemetry.
httpd_handle_t web_server_get_handle();

// Resets currentServoAngleDeg/currentTiltAngleDeg to 0 (facing
// forward/level). Call once after loadSettings()/applyDefaultSettings(),
// before Wi-Fi/HTTP bring-up, so that state is correct from tick 1 -- same
// reasoning as the Pico version, which drove the hardware immediately here
// too. This port deliberately does NOT: the actual pulse writes are
// deferred and staggered a couple seconds apart by ws_broadcast.cpp's
// PAN_SERVO_STARTUP_DELAY_MS/TILT_SERVO_STARTUP_DELAY_MS gates, so driving
// both servos toward home at once (if either was left away from it before
// a reboot) doesn't draw one combined current spike.
void web_server_recenter_servo();

// Last commanded pan-servo angle, within [settings.servoMinAngleDeg,
// settings.servoMaxAngleDeg], whether from a direct servo_angle WS message
// or the control-frame auto-follow logic in ws_broadcast.cpp (which has its
// own, architecturally fixed +/-90 clamp, independent of the calibrated
// range). Shared with that file (and with handle_pose()'s servoAngleDeg
// field here) so everything agrees on where the camera is actually pointed.
extern float currentServoAngleDeg;

// Last commanded tilt-servo angle, within [settings.tiltMinAngleDeg,
// settings.tiltMaxAngleDeg] -- set only from a direct tilt_servo_angle WS
// message (no auto-follow behavior for tilt).
extern float currentTiltAngleDeg;

// Pan-servo angle -> pulse width (us), piecewise linear through the 3-point
// calibration (min pulse at settings.servoMinAngleDeg, center pulse at 0,
// max pulse at settings.servoMaxAngleDeg). Angle 0 is fixed, not a
// calibration value -- servoFollowControlFrame and the whole control-frame
// tracking system assume it means "facing the same direction as the
// chassis." Shared with ws_broadcast.cpp's servo_angle WS handler and
// control-frame auto-follow logic, so both always agree on exactly the
// same mapping.
uint16_t computeServoPulseUs(float angleDeg);

// Same idea for the tilt servo (min pulse at settings.tiltMinAngleDeg,
// center pulse at 0, max pulse at settings.tiltMaxAngleDeg) -- some tilt
// servos have a 270 or 360 deg range instead of the usual 180.
uint16_t computeTiltServoPulseUs(float angleDeg);
