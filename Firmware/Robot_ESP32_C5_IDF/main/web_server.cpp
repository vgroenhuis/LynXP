#include "web_server.hpp"
#include "settings.hpp"
#include "waypoints.hpp"
#include "control_modes.hpp"
#include "odometry.hpp"
#include "wifi_connect.hpp"
#include "uart_link.hpp"
#include "ping_diag.hpp"
#include "motors.hpp"
#include "watchdog.hpp"
#include "breadcrumb.hpp"

#include "cJSON.h"
#include "esp_log.h"

#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <algorithm>

// ESP-IDF replacement for Robot_Pico2W_SDK/src/web_server.cpp's HTTP half
// (everything except /ws and the poll-loop telemetry broadcast, which live
// in ws_broadcast.cpp). Routes, JSON field names, and static-file cache
// policy are all kept byte-identical to the Pico build. See the mg_* ->
// esp_http_server/cJSON mapping table in the migration plan for the full
// rationale behind each substitution below.

float currentServoAngleDeg = 0.0f;

namespace {

const char *TAG = "web_server";

httpd_handle_t g_server = nullptr;

// -- static file table + serving --------------------------------------

struct StaticFile {
    const char *uri;
    const char *littlefsPath;
    const char *contentType;
    // Browser cache lifetime in seconds, or 0 for "always refetch". Applied
    // to app.js/style.css/cam.js (which only ever change on a filesystem
    // OTA) but NOT the HTML entry points -- see Robot_Pico2W_SDK's own
    // comment on this table: every Camera<->Main navigation opens a burst
    // of ~6 connections, and this collapses repeat navigations within a
    // session down to just the HTML request. Kept short (60s, not the 1hr
    // originally ported from the Pico build) so a filesystem OTA's new
    // app.js/style.css/cam.js is picked up well within the same sitting --
    // an hour-long stale cache after an update was confusing enough in
    // practice (edited settings silently not persisting because the loaded
    // JS predated them) to outweigh the extra refetch it saves.
    unsigned cacheMaxAgeSec;
};

constexpr StaticFile STATIC_FILES[] = {
    {"/", "/littlefs/index.html", "text/html", 0},
    {"/index.html", "/littlefs/index.html", "text/html", 0},
    {"/app.js", "/littlefs/app.js", "application/javascript", 60},
    {"/style.css", "/littlefs/style.css", "text/css", 60},
    {"/cam", "/littlefs/cam.html", "text/html", 0},
    {"/cam.html", "/littlefs/cam.html", "text/html", 0},
    {"/cam.js", "/littlefs/cam.js", "application/javascript", 60},
};

// Streams the file in 1 KB chunks rather than the Pico version's
// malloc(whole file)+single send -- app.js alone is over 100 KB, which was
// a real heap spike on every fetch there. No mg_http_reply()-bypass
// bookkeeping needed here either (the Pico version had to manually clear
// c->is_resp after a raw send, or pipelined keep-alive requests would
// hang) -- esp_http_server has no equivalent footgun.
esp_err_t serve_static_file(httpd_req_t *req, const StaticFile &f) {
    FILE *file = fopen(f.littlefsPath, "r");
    if (file == nullptr) {
        ESP_LOGW(TAG, "static file missing: %s", f.littlefsPath);
        httpd_resp_send_404(req);
        return ESP_OK;
    }

    httpd_resp_set_type(req, f.contentType);
    // Declared at function scope, not inside the if-block below: httpd_resp_set_hdr()
    // only stores the POINTER, and requires it stay valid until the response is
    // actually sent (the first httpd_resp_send_chunk() call, further down this
    // function) -- not until this statement finishes. A block-scoped buffer here
    // was reused by buf[] below once its own scope ended, so the header ended up
    // pointing at leftover file content instead of the cache directive.
    char cacheHdr[48];
    if (f.cacheMaxAgeSec > 0) {
        snprintf(cacheHdr, sizeof(cacheHdr), "public, max-age=%u", f.cacheMaxAgeSec);
        httpd_resp_set_hdr(req, "Cache-Control", cacheHdr);
    }

    char buf[1024];
    size_t readBytes;
    esp_err_t err = ESP_OK;
    while ((readBytes = fread(buf, 1, sizeof(buf), file)) > 0) {
        if (httpd_resp_send_chunk(req, buf, (ssize_t) readBytes) != ESP_OK) {
            err = ESP_FAIL;
            break;
        }
    }
    fclose(file);
    if (err == ESP_OK) {
        httpd_resp_send_chunk(req, nullptr, 0); // terminates the chunked response
    }
    return err;
}

// Registered as the HTTPD_404_NOT_FOUND handler rather than a `/*` wildcard
// httpd_uri_t: httpd_uri_match_wildcard only matches a trailing `*`, and a
// catch-all registered alongside the exact routes below creates an
// ordering hazard that could shadow them. Falling through to "not found"
// for everything else is exactly the Pico version's `else { 404 }` branch
// in its own dispatch chain.
esp_err_t static_fallback_handler(httpd_req_t *req, httpd_err_code_t error) {
    (void) error;
    char uriPath[64];
    std::strncpy(uriPath, req->uri, sizeof(uriPath) - 1);
    uriPath[sizeof(uriPath) - 1] = '\0';
    if (char *q = std::strchr(uriPath, '?')) {
        *q = '\0';
    }

    for (const auto &f : STATIC_FILES) {
        if (std::strcmp(uriPath, f.uri) == 0) {
            return serve_static_file(req, f);
        }
    }
    httpd_resp_send_404(req);
    return ESP_OK;
}

// -- query-string + POST-body helpers -----------------------------------

// httpd_query_key_value() does not URL-decode, unlike Mongoose's
// mg_http_get_var() -- app.js's /set calls go through encodeURIComponent(),
// so this is needed for any value containing reserved characters (spaces,
// '&', etc. -- SSIDs and the like).
void url_decode(char *s) {
    char *out = s;
    while (*s) {
        if (*s == '%' && s[1] && s[2]) {
            char hex[3] = {s[1], s[2], '\0'};
            *out++ = (char) std::strtol(hex, nullptr, 16);
            s += 3;
        } else if (*s == '+') {
            *out++ = ' ';
            s++;
        } else {
            *out++ = *s++;
        }
    }
    *out = '\0';
}

bool get_query_str(httpd_req_t *req, const char *name, char *buf, size_t bufLen) {
    size_t qlen = httpd_req_get_url_query_len(req);
    if (qlen == 0) {
        return false;
    }
    // qlen doesn't include the NUL terminator httpd_req_get_url_query_str()
    // requires room for.
    char *query = (char *) malloc(qlen + 1);
    if (query == nullptr) {
        return false;
    }
    bool found = false;
    if (httpd_req_get_url_query_str(req, query, qlen + 1) == ESP_OK) {
        if (httpd_query_key_value(query, name, buf, bufLen) == ESP_OK) {
            url_decode(buf);
            found = true;
        }
    }
    free(query);
    return found;
}

bool get_query_float(httpd_req_t *req, const char *name, float *out) {
    char buf[32];
    if (!get_query_str(req, name, buf, sizeof(buf))) return false;
    *out = std::strtof(buf, nullptr);
    return true;
}

bool get_query_int(httpd_req_t *req, const char *name, int *out) {
    char buf[32];
    if (!get_query_str(req, name, buf, sizeof(buf))) return false;
    *out = (int) std::strtol(buf, nullptr, 10);
    return true;
}

// Reads the full POST body into buf (NUL-terminated), up to bufSize-1
// bytes. Returns the byte count, or -1 if the body is missing, oversized
// for the caller's buffer, or a receive error/timeout occurred.
int read_post_body(httpd_req_t *req, char *buf, size_t bufSize) {
    if (req->content_len <= 0 || (size_t) req->content_len >= bufSize) {
        return -1;
    }
    int remaining = (int) req->content_len;
    int offset = 0;
    while (remaining > 0) {
        int received = httpd_req_recv(req, buf + offset, remaining);
        if (received == HTTPD_SOCK_ERR_TIMEOUT) {
            continue;
        }
        if (received <= 0) {
            return -1;
        }
        offset += received;
        remaining -= received;
    }
    buf[offset] = '\0';
    return offset;
}

// -- pan / tilt servos -----------------------------------------------------

} // namespace

float currentTiltAngleDeg = 0.0f;

// Piecewise linear through the 3-point calibration (min pulse at
// servoMinAngleDeg, center pulse at 0, max pulse at servoMaxAngleDeg).
// Angle 0 is fixed, not a calibration value -- see the doc comment on
// Settings::servoMinAngleDeg. Guards against a degenerate span (e.g.
// servoMinAngleDeg == 0 from a bad calibration entry) rather than dividing
// by zero.
uint16_t computeServoPulseUs(float angleDeg) {
    angleDeg = std::clamp(angleDeg, settings.servoMinAngleDeg, settings.servoMaxAngleDeg);
    float pulseUs;
    if (angleDeg <= 0.0f) {
        float span = -settings.servoMinAngleDeg;
        float fraction = (span != 0.0f) ? (angleDeg - settings.servoMinAngleDeg) / span : 0.0f;
        pulseUs = settings.servoMinPulseUs + fraction * (settings.servoCenterPulseUs - settings.servoMinPulseUs);
    } else {
        float span = settings.servoMaxAngleDeg;
        float fraction = (span != 0.0f) ? angleDeg / span : 0.0f;
        pulseUs = settings.servoCenterPulseUs + fraction * (settings.servoMaxPulseUs - settings.servoCenterPulseUs);
    }
    return (uint16_t) std::clamp(pulseUs, 0.0f, 19999.0f);
}

// Same idea for the tilt servo (min pulse at tiltMinAngleDeg, center pulse
// at 0, max pulse at tiltMaxAngleDeg).
uint16_t computeTiltServoPulseUs(float angleDeg) {
    angleDeg = std::clamp(angleDeg, settings.tiltMinAngleDeg, settings.tiltMaxAngleDeg);
    float pulseUs;
    if (angleDeg <= 0.0f) {
        float span = -settings.tiltMinAngleDeg;
        float fraction = (span != 0.0f) ? (angleDeg - settings.tiltMinAngleDeg) / span : 0.0f;
        pulseUs = settings.tiltMinPulseUs + fraction * (settings.tiltCenterPulseUs - settings.tiltMinPulseUs);
    } else {
        float span = settings.tiltMaxAngleDeg;
        float fraction = (span != 0.0f) ? angleDeg / span : 0.0f;
        pulseUs = settings.tiltCenterPulseUs + fraction * (settings.tiltMaxPulseUs - settings.tiltCenterPulseUs);
    }
    return (uint16_t) std::clamp(pulseUs, 0.0f, 19999.0f);
}

void web_server_recenter_servo() {
    // Deliberately does NOT write either servo's pulse -- only resets the
    // software state to 0. The actual pulses are written later, staggered
    // a couple seconds apart, by ws_broadcast.cpp's PAN_SERVO_STARTUP_DELAY_MS/
    // TILT_SERVO_STARTUP_DELAY_MS gates: driving both servos toward home at
    // once (if either was left away from it before a reboot) draws a
    // brief combined current spike this hardware's power budget can't
    // reliably absorb, so activating them a beat apart spreads it into two
    // smaller ones instead. This function still has to run early (before
    // Wi-Fi/HTTP bring-up, per its own established doc comment) so that
    // state is correct from tick 1, even though the hardware write itself
    // is deferred well past that point.
    currentServoAngleDeg = 0.0f;
    currentTiltAngleDeg = 0.0f;
}

namespace {

// -- /set, /params, /pose, /wifi, /pose_reset, /waypoints ---------------

esp_err_t handle_set(httpd_req_t *req) {
    char buf[80]; // wide enough for every string field handled below
    float fval;
    int ival;
    // Coalesced into a single saveSettings() at the end, unlike the Pico
    // version's saveSettings()-per-matched-field: a multi-parameter /set
    // (app.js sends one field per request today, but nothing guarantees
    // that stays true) would otherwise do several NVS commits back to back.
    bool dirty = false;

    if (get_query_int(req, "logging", &ival)) { settings.loggingEnabled = ival > 0; dirty = true; }
    if (get_query_float(req, "logRate", &fval)) { settings.dataLogRate = std::clamp(fval, 0.0f, 1000.0f); dirty = true; }
    if (get_query_str(req, "logType", buf, sizeof(buf))) {
        if (std::strcmp(buf, "left_wheel") == 0) settings.logType = LEFT_WHEEL;
        else if (std::strcmp(buf, "both_wheels") == 0) settings.logType = BOTH_WHEELS;
        dirty = true;
    }
    if (get_query_str(req, "logUnit", buf, sizeof(buf))) {
        if (std::strcmp(buf, "steps") == 0) settings.logUnit = ENCODER_STEPS;
        else if (std::strcmp(buf, "rad") == 0) settings.logUnit = WHEEL_RAD;
        else if (std::strcmp(buf, "deg") == 0) settings.logUnit = WHEEL_DEG;
        else if (std::strcmp(buf, "rev") == 0) settings.logUnit = WHEEL_REV;
        else if (std::strcmp(buf, "dist") == 0) settings.logUnit = DISTANCE;
        dirty = true;
    }
    if (get_query_int(req, "debug", &ival)) { settings.debugWeb = ival > 0; dirty = true; }
    if (get_query_str(req, "reset_pose", buf, sizeof(buf))) {
        // Position only -- current heading is deliberately preserved.
        resetPoseX_m = 0.0f;
        resetPoseY_m = 0.0f;
        resetPoseTheta_rad = poseThetaRad;
        resetPoseFlag = true;
        goalX_m = 0.0f;
        goalY_m = 0.0f;
        stopAllMotion();
    }
    if (get_query_str(req, "reset_orientation", buf, sizeof(buf))) {
        // Orientation only -- current position is deliberately preserved.
        resetPoseX_m = poseX_m;
        resetPoseY_m = poseY_m;
        resetPoseTheta_rad = 0.0f;
        resetPoseFlag = true;
        controlFrameThetaRad = 0.0f;
        stopAllMotion();
    }
    if (get_query_float(req, "kp", &fval)) { settings.kp = fval; dirty = true; }
    if (get_query_float(req, "ki", &fval)) { settings.ki = fval; dirty = true; }
    if (get_query_float(req, "kd", &fval)) { settings.kd = fval; dirty = true; }
    if (get_query_float(req, "diffCutoff", &fval)) { settings.differentiatorCutoffHz = fval; dirty = true; }
    if (get_query_str(req, "syncMotors", buf, sizeof(buf))) { settings.syncMotors = std::strcmp(buf, "1") == 0; dirty = true; }
    if (get_query_int(req, "motorPower", &ival)) { settings.maxMotorPower = ival; dirty = true; }
    if (get_query_float(req, "wheelbaseMm", &fval)) { settings.wheelbaseMm = fval; dirty = true; }
    if (get_query_float(req, "wheelDiameterMm", &fval)) { settings.wheelDiameterMm = fval; dirty = true; }
    if (get_query_float(req, "cameraHeightMm", &fval)) { settings.cameraHeightMm = fval; dirty = true; }
    if (get_query_float(req, "cameraTiltDeg", &fval)) { settings.cameraTiltDeg = fval; dirty = true; }
    if (get_query_float(req, "cameraVerticalFovDeg", &fval)) { settings.cameraVerticalFovDeg = std::clamp(fval, 1.0f, 179.0f); dirty = true; }
    if (get_query_float(req, "servoMinPulseUs", &fval)) { settings.servoMinPulseUs = std::clamp(fval, 0.0f, 19999.0f); dirty = true; }
    if (get_query_float(req, "servoMaxPulseUs", &fval)) { settings.servoMaxPulseUs = std::clamp(fval, 0.0f, 19999.0f); dirty = true; }
    if (get_query_float(req, "servoCenterPulseUs", &fval)) { settings.servoCenterPulseUs = std::clamp(fval, 0.0f, 19999.0f); dirty = true; }
    // Angle range is a calibration value -- clamped to a generous sanity
    // bound, not +/-90, so a 270/360 deg servo's real range can be entered.
    if (get_query_float(req, "servoMinAngleDeg", &fval)) { settings.servoMinAngleDeg = std::clamp(fval, -360.0f, 0.0f); dirty = true; }
    if (get_query_float(req, "servoMaxAngleDeg", &fval)) { settings.servoMaxAngleDeg = std::clamp(fval, 0.0f, 360.0f); dirty = true; }
    if (get_query_float(req, "tiltMinPulseUs", &fval)) { settings.tiltMinPulseUs = std::clamp(fval, 0.0f, 19999.0f); dirty = true; }
    if (get_query_float(req, "tiltMaxPulseUs", &fval)) { settings.tiltMaxPulseUs = std::clamp(fval, 0.0f, 19999.0f); dirty = true; }
    if (get_query_float(req, "tiltCenterPulseUs", &fval)) { settings.tiltCenterPulseUs = std::clamp(fval, 0.0f, 19999.0f); dirty = true; }
    if (get_query_float(req, "tiltMinAngleDeg", &fval)) { settings.tiltMinAngleDeg = std::clamp(fval, -360.0f, 0.0f); dirty = true; }
    if (get_query_float(req, "tiltMaxAngleDeg", &fval)) { settings.tiltMaxAngleDeg = std::clamp(fval, 0.0f, 360.0f); dirty = true; }
    if (get_query_float(req, "telemetryHz", &fval)) { settings.telemetryHz = std::clamp(fval, 1.0f, 30.0f); dirty = true; }
    if (get_query_float(req, "motorDeadzonePwm", &fval)) { settings.motorDeadzonePwm = std::clamp(fval, 0.0f, (float) settings.maxMotorPower); dirty = true; }
    if (get_query_float(req, "gotoSpeedGain", &fval)) { settings.gotoSpeedGain = std::clamp(fval, 0.01f, 1000.0f); dirty = true; }
    if (get_query_float(req, "maxWheelSpeedRevPerSec", &fval)) { settings.maxWheelSpeedRevPerSec = std::clamp(fval, 0.01f, 1000.0f); dirty = true; }
    if (get_query_float(req, "maxAccelRevPerSec2", &fval)) { settings.maxAccelRevPerSec2 = std::clamp(fval, 0.01f, 1000.0f); dirty = true; }
    if (get_query_float(req, "maxDecelRevPerSec2", &fval)) { settings.maxDecelRevPerSec2 = std::clamp(fval, 0.01f, 1000.0f); dirty = true; }
    if (get_query_float(req, "gotoVelKp", &fval)) { settings.gotoVelKp = fval; dirty = true; }
    if (get_query_float(req, "gotoVelKi", &fval)) { settings.gotoVelKi = fval; dirty = true; }
    if (get_query_float(req, "feedForwardPwmPerRevPerSec", &fval)) { settings.feedForwardPwmPerRevPerSec = std::clamp(fval, 0.0f, 1000.0f); dirty = true; }
    if (get_query_str(req, "gotoAllowReverse", buf, sizeof(buf))) { settings.gotoAllowReverse = std::strcmp(buf, "1") == 0; dirty = true; }
    if (get_query_str(req, "gotoPreserveHeading", buf, sizeof(buf))) { settings.gotoPreserveHeading = std::strcmp(buf, "1") == 0; dirty = true; }
    if (get_query_str(req, "controlFrameAllowReverse", buf, sizeof(buf))) { settings.controlFrameAllowReverse = std::strcmp(buf, "1") == 0; dirty = true; }
    if (get_query_str(req, "servoFollowControlFrame", buf, sizeof(buf))) { settings.servoFollowControlFrame = std::strcmp(buf, "1") == 0; dirty = true; }
    if (get_query_float(req, "servoMaxRotationRateDegPerSec", &fval)) { settings.servoMaxRotationRateDegPerSec = std::clamp(fval, 1.0f, 1000.0f); dirty = true; }
    if (get_query_float(req, "servoAssistMarginDeg", &fval)) { settings.servoAssistMarginDeg = std::clamp(fval, 0.0f, 90.0f); dirty = true; }
    if (get_query_float(req, "panMaxSpeedDegPerSec", &fval)) { settings.panMaxSpeedDegPerSec = std::clamp(fval, 1.0f, 1000.0f); dirty = true; }
    if (get_query_float(req, "tiltMaxSpeedDegPerSec", &fval)) { settings.tiltMaxSpeedDegPerSec = std::clamp(fval, 1.0f, 1000.0f); dirty = true; }
    if (get_query_str(req, "cameraJoystickCurve", buf, sizeof(buf))) {
        if (std::strcmp(buf, "linear") == 0) settings.cameraJoystickCurve = CAMERA_JOYSTICK_CURVE_LINEAR;
        else if (std::strcmp(buf, "quadratic") == 0) settings.cameraJoystickCurve = CAMERA_JOYSTICK_CURVE_QUADRATIC;
        dirty = true;
    }
    if (get_query_str(req, "controlFrameRotationStrategy", buf, sizeof(buf))) {
        if (std::strcmp(buf, "closest_face") == 0) settings.controlFrameRotationStrategy = CONTROL_FRAME_ROTATION_CLOSEST_FACE;
        else if (std::strcmp(buf, "fixed_hemisphere") == 0) settings.controlFrameRotationStrategy = CONTROL_FRAME_ROTATION_FIXED_HEMISPHERE;
        dirty = true;
    }
    if (get_query_str(req, "otaUsername", buf, sizeof(buf))) {
        std::strncpy(settings.otaUsername, buf, sizeof(settings.otaUsername) - 1);
        settings.otaUsername[sizeof(settings.otaUsername) - 1] = '\0';
        dirty = true;
    }
    if (get_query_str(req, "otaPassword", buf, sizeof(buf))) {
        std::strncpy(settings.otaPassword, buf, sizeof(settings.otaPassword) - 1);
        settings.otaPassword[sizeof(settings.otaPassword) - 1] = '\0';
        dirty = true;
    }
    if (get_query_float(req, "fireballSpeedMps", &fval)) { settings.fireballSpeedMps = std::clamp(fval, 0.01f, 10.0f); dirty = true; }
    if (get_query_float(req, "monsterSpeedMps", &fval)) { settings.monsterSpeedMps = std::clamp(fval, 0.01f, 10.0f); dirty = true; }
    if (get_query_int(req, "monsterCount", &ival)) { settings.monsterCount = std::clamp(ival, 0, 10); dirty = true; }
    if (get_query_float(req, "monsterStandoffDistanceM", &fval)) { settings.monsterStandoffDistanceM = std::clamp(fval, 0.0f, 5.0f); dirty = true; }
    if (dirty) {
        saveSettings();
    }

    httpd_resp_set_type(req, "text/plain");
    httpd_resp_sendstr(req, "OK");
    return ESP_OK;
}

esp_err_t handle_params(httpd_req_t *req) {
    const BreadcrumbSnapshot &bc = breadcrumb_get_boot_snapshot();
    char json[1850];
    snprintf(json, sizeof(json),
        "{\"loggingEnabled\":%s,\"debugWeb\":%s,\"dataLogRate\":%.1f,\"mode\":%d,"
        "\"logType\":%d,\"logUnit\":%d,\"kp\":%.4f,\"ki\":%.4f,\"kd\":%.4f,"
        "\"differentiatorCutoffHz\":%.2f,\"motorPower\":%d,"
        "\"wheelbaseMm\":%.1f,\"wheelDiameterMm\":%.1f,\"telemetryHz\":%.1f,"
        "\"motorDeadzonePwm\":%d,\"gotoSpeedGain\":%.3f,\"maxWheelSpeedRevPerSec\":%.3f,"
        "\"maxAccelRevPerSec2\":%.3f,\"maxDecelRevPerSec2\":%.3f,\"gotoVelKp\":%.3f,"
        "\"gotoVelKi\":%.3f,\"feedForwardPwmPerRevPerSec\":%.3f,\"gotoAllowReverse\":%s,"
        "\"gotoPreserveHeading\":%s,\"controlFrameAllowReverse\":%s,\"servoFollowControlFrame\":%s,"
        "\"controlFrameRotationStrategy\":%d,"
        "\"servoMinPulseUs\":%.1f,\"servoMaxPulseUs\":%.1f,\"servoCenterPulseUs\":%.1f,"
        "\"servoMinAngleDeg\":%.1f,\"servoMaxAngleDeg\":%.1f,"
        "\"servoMaxRotationRateDegPerSec\":%.1f,\"servoAssistMarginDeg\":%.1f,"
        "\"panMaxSpeedDegPerSec\":%.1f,\"tiltMaxSpeedDegPerSec\":%.1f,\"cameraJoystickCurve\":%d,"
        "\"tiltMinPulseUs\":%.1f,\"tiltMaxPulseUs\":%.1f,\"tiltCenterPulseUs\":%.1f,"
        "\"tiltMinAngleDeg\":%.1f,\"tiltMaxAngleDeg\":%.1f,"
        "\"cameraHeightMm\":%.1f,\"cameraTiltDeg\":%.1f,\"cameraVerticalFovDeg\":%.1f,"
        "\"lastRebootWasWatchdog\":%s,\"lastRebootReason\":\"%s\","
        "\"lastHangCore0Checkpoint\":\"%s\",\"lastHangCore1Checkpoint\":\"%s\","
        "\"lastHangWsMessage\":\"%s\",\"lastHangCore1Ticks\":%lu,"
        "\"lastHangConnCount\":%d,\"lastHangWsConnCount\":%d,"
        "\"altSsid\":\"%s\",\"altPassword\":\"%s\","
        "\"otaUsername\":\"%s\",\"otaPassword\":\"%s\","
        "\"fireballSpeedMps\":%.3f,\"monsterSpeedMps\":%.3f,\"monsterCount\":%d,\"monsterStandoffDistanceM\":%.3f}",
        settings.loggingEnabled ? "true" : "false", settings.debugWeb ? "true" : "false",
        settings.dataLogRate, settings.mode, settings.logType, settings.logUnit,
        settings.kp, settings.ki, settings.kd, settings.differentiatorCutoffHz,
        settings.maxMotorPower, settings.wheelbaseMm, settings.wheelDiameterMm,
        settings.telemetryHz, (int) settings.motorDeadzonePwm, settings.gotoSpeedGain,
        settings.maxWheelSpeedRevPerSec, settings.maxAccelRevPerSec2, settings.maxDecelRevPerSec2,
        settings.gotoVelKp, settings.gotoVelKi, settings.feedForwardPwmPerRevPerSec,
        settings.gotoAllowReverse ? "true" : "false",
        settings.gotoPreserveHeading ? "true" : "false",
        settings.controlFrameAllowReverse ? "true" : "false",
        settings.servoFollowControlFrame ? "true" : "false",
        settings.controlFrameRotationStrategy,
        settings.servoMinPulseUs, settings.servoMaxPulseUs, settings.servoCenterPulseUs,
        settings.servoMinAngleDeg, settings.servoMaxAngleDeg,
        settings.servoMaxRotationRateDegPerSec, settings.servoAssistMarginDeg,
        settings.panMaxSpeedDegPerSec, settings.tiltMaxSpeedDegPerSec, settings.cameraJoystickCurve,
        settings.tiltMinPulseUs, settings.tiltMaxPulseUs, settings.tiltCenterPulseUs,
        settings.tiltMinAngleDeg, settings.tiltMaxAngleDeg,
        settings.cameraHeightMm, settings.cameraTiltDeg, settings.cameraVerticalFovDeg,
        watchdog_last_reboot_was_hang() ? "true" : "false",
        watchdog_last_reboot_reason_string(),
        breadcrumb_core0_checkpoint_name(bc.core0Checkpoint),
        breadcrumb_core1_checkpoint_name(bc.core1Checkpoint),
        bc.lastWsMessageType, (unsigned long) bc.core1TickCountAtLastMark,
        bc.core0TotalConns, bc.core0WsConns,
        settings.altSsid, settings.altPassword,
        settings.otaUsername, settings.otaPassword,
        settings.fireballSpeedMps, settings.monsterSpeedMps, settings.monsterCount, settings.monsterStandoffDistanceM);

    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json);
    return ESP_OK;
}

// GET /camdiag: the S3 CAM's self-reported diagnostics (relayed over UART,
// see uart_link.cpp) plus this board's own live ICMP-ping stats to it (see
// ping_diag.cpp). Kept separate from /params (a big, load-once settings
// blob) since app.js polls this one every second or so while the "S3 CAM"
// panel is open -- rebuilding/parsing all of /params that often would be
// wasted work for data nobody's reading in that response.
esp_err_t handle_cam_diag(httpd_req_t *req) {
    const CamDiagnostics &camDiag = uart_link_get_diagnostics();
    bool camStale = uart_link_peer_is_stale();
    PingStats ping = ping_diag_get_stats();
    char json[400];
    snprintf(json, sizeof(json),
        "{\"mac\":\"%s\",\"ip\":\"%s\",\"stale\":%s,\"rssiDbm\":%d,"
        "\"uptimeS\":%lu,\"freeHeapBytes\":%lu,\"minFreeHeapBytes\":%lu,"
        "\"camFailCount\":%lu,\"rebootCount\":%lu,\"clients\":%d,\"resetReason\":\"%s\","
        "\"pingActive\":%s,\"pingSent\":%lu,\"pingReceived\":%lu,"
        "\"pingLastRttMs\":%lu,\"pingAvgRttMs\":%lu}",
        camDiag.mac, camDiag.ip, camStale ? "true" : "false", camDiag.rssiDbm,
        (unsigned long) camDiag.uptimeS, (unsigned long) camDiag.freeHeapBytes,
        (unsigned long) camDiag.minFreeHeapBytes, (unsigned long) camDiag.camFailCount,
        (unsigned long) camDiag.rebootCount, camDiag.clients, camDiag.resetReason,
        ping.active ? "true" : "false", (unsigned long) ping.sent, (unsigned long) ping.received,
        (unsigned long) ping.lastRttMs, (unsigned long) ping.avgRttMs);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json);
    return ESP_OK;
}

esp_err_t handle_pose(httpd_req_t *req) {
    float m[9];
    getPoseMatrix(m);
    char json[300];
    snprintf(json, sizeof(json),
        "{\"x\":%.4f,\"y\":%.4f,\"theta\":%.4f,\"servoAngleDeg\":%.2f,\"tiltAngleDeg\":%.2f,"
        "\"matrix\":[%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f,%.4f]}",
        poseX_m, poseY_m, poseThetaRad, currentServoAngleDeg, currentTiltAngleDeg,
        m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);

    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json);
    return ESP_OK;
}

esp_err_t handle_wifi_post(httpd_req_t *req) {
    char body[300];
    if (read_post_body(req, body, sizeof(body)) < 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Bad request body");
        return ESP_OK;
    }

    cJSON *root = cJSON_Parse(body);
    cJSON *ssidItem = root ? cJSON_GetObjectItemCaseSensitive(root, "ssid") : nullptr;
    cJSON *passItem = root ? cJSON_GetObjectItemCaseSensitive(root, "password") : nullptr;
    if (!cJSON_IsString(ssidItem) || !cJSON_IsString(passItem)) {
        cJSON_Delete(root);
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing ssid/password");
        return ESP_OK;
    }

    std::strncpy(settings.altSsid, ssidItem->valuestring, sizeof(settings.altSsid) - 1);
    settings.altSsid[sizeof(settings.altSsid) - 1] = '\0';
    std::strncpy(settings.altPassword, passItem->valuestring, sizeof(settings.altPassword) - 1);
    settings.altPassword[sizeof(settings.altPassword) - 1] = '\0';
    cJSON_Delete(root);
    saveSettings();

    ESP_LOGI(TAG, "Received WiFi settings: SSID=%s", settings.altSsid);
    httpd_resp_set_type(req, "text/plain");
    httpd_resp_sendstr(req, "OK, attempting to connect");

    // Points at the now-persisted settings.altSsid/altPassword, matching the
    // Pico version's comment: reconnect must reference stable storage, not
    // this handler's own stack-local body buffer.
    wifi_reconnect_with(settings.altSsid, settings.altPassword);
    return ESP_OK;
}

esp_err_t handle_pose_reset_post(httpd_req_t *req) {
    char body[200];
    if (read_post_body(req, body, sizeof(body)) < 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Bad request body");
        return ESP_OK;
    }

    cJSON *root = cJSON_Parse(body);
    double x = 0, y = 0, theta = 0;
    if (root) {
        cJSON *xi = cJSON_GetObjectItemCaseSensitive(root, "x");
        cJSON *yi = cJSON_GetObjectItemCaseSensitive(root, "y");
        cJSON *ti = cJSON_GetObjectItemCaseSensitive(root, "theta");
        if (cJSON_IsNumber(xi)) x = xi->valuedouble;
        if (cJSON_IsNumber(yi)) y = yi->valuedouble;
        if (cJSON_IsNumber(ti)) theta = ti->valuedouble;
        cJSON_Delete(root);
    }

    resetPoseX_m = (float) x;
    resetPoseY_m = (float) y;
    resetPoseTheta_rad = (float) theta;
    resetPoseFlag = true;

    httpd_resp_set_type(req, "text/plain");
    httpd_resp_sendstr(req, "OK");
    return ESP_OK;
}

// GET/POST /waypoints: robot-side storage for the waypoint list, shared
// across every connected device instead of each browser's own localStorage.
// The JSON body is opaque to the firmware; app.js/cam.js own the
// array-of-{name,x,y,heading} schema.
esp_err_t handle_waypoints_get(httpd_req_t *req) {
    static char json[WAYPOINTS_JSON_MAX_LEN];
    loadWaypointsJson(json, sizeof(json));
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json);
    return ESP_OK;
}

esp_err_t handle_waypoints_post(httpd_req_t *req) {
    static char body[WAYPOINTS_JSON_MAX_LEN];
    int len = read_post_body(req, body, sizeof(body));
    if (len < 0 || !saveWaypointsJson(body, (size_t) len)) {
        httpd_resp_send_err(req, HTTPD_413_CONTENT_TOO_LARGE, "Waypoints payload too large or failed to save");
        return ESP_OK;
    }
    httpd_resp_set_type(req, "text/plain");
    httpd_resp_sendstr(req, "OK");
    return ESP_OK;
}

// -- registration ---------------------------------------------------------

esp_err_t handle_set_wrapper(httpd_req_t *req) { return handle_set(req); }
esp_err_t handle_params_wrapper(httpd_req_t *req) { return handle_params(req); }
esp_err_t handle_cam_diag_wrapper(httpd_req_t *req) { return handle_cam_diag(req); }
esp_err_t handle_pose_wrapper(httpd_req_t *req) { return handle_pose(req); }
esp_err_t handle_wifi_post_wrapper(httpd_req_t *req) { return handle_wifi_post(req); }
esp_err_t handle_pose_reset_post_wrapper(httpd_req_t *req) { return handle_pose_reset_post(req); }
esp_err_t handle_waypoints_get_wrapper(httpd_req_t *req) { return handle_waypoints_get(req); }
esp_err_t handle_waypoints_post_wrapper(httpd_req_t *req) { return handle_waypoints_post(req); }

} // namespace

void web_server_init() {
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.server_port = 80;
    config.stack_size = 8192;
    config.max_open_sockets = 12; // the UI opens ~6 conns per page navigation
    config.max_uri_handlers = 20; // ~7 here + /ws once ws_broadcast.cpp registers it
    config.lru_purge_enable = true; // reconnect-storm resilience
    config.send_wait_timeout = 2; // bound the worst case if a peer stalls
    config.recv_wait_timeout = 5; // OTA upload chunks need it, once milestone G exists
    // C5 is single-core, so this just pins to the only core that exists --
    // no isolation from control_task.cpp anymore (see control_task.hpp's
    // doc comment). Kept explicit rather than left at NO_AFFINITY for
    // clarity, not because it changes anything.
    config.core_id = 0;
    config.keep_alive_enable = true;
    config.keep_alive_idle = 5;
    config.keep_alive_interval = 5;
    config.keep_alive_count = 3;

    if (httpd_start(&g_server, &config) != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed");
        return;
    }

    httpd_uri_t setUri = {.uri = "/set", .method = HTTP_GET, .handler = handle_set_wrapper, .user_ctx = nullptr,
                          .is_websocket = false, .handle_ws_control_frames = false, .supported_subprotocol = nullptr};
    httpd_uri_t paramsUri = {.uri = "/params", .method = HTTP_GET, .handler = handle_params_wrapper, .user_ctx = nullptr,
                             .is_websocket = false, .handle_ws_control_frames = false, .supported_subprotocol = nullptr};
    httpd_uri_t camDiagUri = {.uri = "/camdiag", .method = HTTP_GET, .handler = handle_cam_diag_wrapper, .user_ctx = nullptr,
                              .is_websocket = false, .handle_ws_control_frames = false, .supported_subprotocol = nullptr};
    httpd_uri_t poseUri = {.uri = "/pose", .method = HTTP_GET, .handler = handle_pose_wrapper, .user_ctx = nullptr,
                           .is_websocket = false, .handle_ws_control_frames = false, .supported_subprotocol = nullptr};
    httpd_uri_t wifiUri = {.uri = "/wifi", .method = HTTP_POST, .handler = handle_wifi_post_wrapper, .user_ctx = nullptr,
                           .is_websocket = false, .handle_ws_control_frames = false, .supported_subprotocol = nullptr};
    httpd_uri_t poseResetUri = {.uri = "/pose_reset", .method = HTTP_POST, .handler = handle_pose_reset_post_wrapper, .user_ctx = nullptr,
                                .is_websocket = false, .handle_ws_control_frames = false, .supported_subprotocol = nullptr};
    httpd_uri_t waypointsGetUri = {.uri = "/waypoints", .method = HTTP_GET, .handler = handle_waypoints_get_wrapper, .user_ctx = nullptr,
                                   .is_websocket = false, .handle_ws_control_frames = false, .supported_subprotocol = nullptr};
    httpd_uri_t waypointsPostUri = {.uri = "/waypoints", .method = HTTP_POST, .handler = handle_waypoints_post_wrapper, .user_ctx = nullptr,
                                    .is_websocket = false, .handle_ws_control_frames = false, .supported_subprotocol = nullptr};

    httpd_register_uri_handler(g_server, &setUri);
    httpd_register_uri_handler(g_server, &paramsUri);
    httpd_register_uri_handler(g_server, &camDiagUri);
    httpd_register_uri_handler(g_server, &poseUri);
    httpd_register_uri_handler(g_server, &wifiUri);
    httpd_register_uri_handler(g_server, &poseResetUri);
    httpd_register_uri_handler(g_server, &waypointsGetUri);
    httpd_register_uri_handler(g_server, &waypointsPostUri);
    httpd_register_err_handler(g_server, HTTPD_404_NOT_FOUND, static_fallback_handler);

    ESP_LOGI(TAG, "httpd started on port %d", config.server_port);
}

httpd_handle_t web_server_get_handle() {
    return g_server;
}
