#include "ws_broadcast.hpp"
#include "debug_pan.hpp"
#include "web_server.hpp"
#include "control_modes.hpp"
#include "odometry.hpp"
#include "settings.hpp"
#include "motors.hpp"
#include "diagnostics.hpp"
#include "breadcrumb.hpp"
#include "watchdog.hpp"
#include "ina260.hpp"

#include "esp_http_server.h"
#include "cJSON.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_task_wdt.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <cmath>
#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <algorithm>
#include <sys/select.h>
#include <sys/socket.h>
#include <cerrno>

namespace {

void servo_history_record(unsigned long nowMs); // see ws_broadcast_servo_actual()

const char *TAG = "ws";

unsigned long millis_now() { return (unsigned long) (esp_timer_get_time() / 1000); }

// -- inbound message dispatch (was handle_ws_message() in web_server.cpp) --

// Safety watchdog: if the client driving a continuous real-time mode
// (touchpad/control-frame joystick) goes silent for this long, the poll
// task zeroes the drive input so the robot stops itself rather than
// executing a stale command indefinitely. Deliberately NOT applied to
// goto/lab1/lab2/manual-velocity/deadzone-calibration -- those aren't
// continuous per-tick commands.
constexpr unsigned long DRIVE_COMMAND_WATCHDOG_MS = 1000;
unsigned long lastDriveCommandMs = 0;

// Same watchdog rationale, applied to the rotate trackpad: without it, a
// connection dropped mid-drag (before the client's release handler can send
// value=0) would leave controlFrameRotateInput stuck nonzero forever --
// unlike the old Rotate Left/Right buttons, a stuck nonzero input here can
// now also keep re-triggering applyServoTrackingConstraints()'s base-assist
// indefinitely, physically spinning the chassis. Set on every
// "control_frame_rotate" message (including the value=0 release itself).
unsigned long lastControlFrameRotateMsgMs = 0;

// Same rate-control pattern as controlFrameRotateInput above, but for the
// tilt axis of the camera control joystick -- a signed deflection fraction
// in [-1,1], integrated into currentTiltAngleDeg server-side (see
// ws_poll_task below) rather than client-side. This is deliberate: with
// multiple browsers potentially open at once, any of which can send a tilt
// rate command, the ESP32 has to be the single authoritative owner of "the
// current tilt angle" -- a browser-local running total would silently
// diverge across tabs/devices. Local only to this file (unlike
// controlFrameRotateInput) since nothing outside ws_broadcast.cpp needs it.
float tiltRateInput = 0.0f;
unsigned long lastTiltRateMsgMs = 0;

// Idle-power management for both servos: once SERVO_IDLE_TIMEOUT_MS have
// passed since a servo's commanded angle last actually changed, the poll
// loop drops its PWM pulse entirely (duty 0, not just "hold the last
// angle") rather than leaving it energized doing nothing. The gear train
// holds position mechanically with no signal on this hardware (confirmed),
// so this is pure current savings with no risk of drift -- the next real
// command (a direct WS message, or -- for pan -- the next auto-follow
// correction) immediately restores the real pulse. Updated on every actual
// angle change, not just "a servo_angle message arrived" or "follow mode
// is on": a stationary robot with servoFollowControlFrame enabled but
// nothing actually rotating should still let the pan servo idle, since its
// commanded angle isn't changing either.
constexpr unsigned long SERVO_IDLE_TIMEOUT_MS = 2000;
unsigned long lastPanActiveMs = 0;
unsigned long lastTiltActiveMs = 0;
// Both start "idle" (no pulse) rather than "active" -- true to the real
// hardware state at boot (motors_init() leaves both servo channels at duty
// 0) until ws_broadcast_start() writes each servo's first real pulse
// immediately on task startup, right below.
bool panServoIdle = true;
bool tiltServoIdle = true;

// This rover's power supply comfortably handles both servos activating
// simultaneously at boot (unlike the S3 robot this was ported from, which
// staggered pan/tilt activation by a couple seconds to split the combined
// current spike in two) -- no startup delay needed here. Every real
// (non-zero-duty) pulse write still funnels through these two rather than
// calling servo_set_pulse_us()/tilt_servo_set_pulse_us() directly, so
// there's exactly one place that does so regardless of which code path
// wants to move a servo (a direct WS command, the auto-follow correction,
// the idle-cutoff wake-up, or the initial boot write in ws_broadcast_start()).
void writePanServoPulse() {
    servo_set_pulse_us(computeServoPulseUs(currentServoAngleDeg));
}
void writeTiltServoPulse() {
    tilt_servo_set_pulse_us(computeTiltServoPulseUs(currentTiltAngleDeg));
}

// Opt-in CPU/memory diagnostics broadcast, mirroring gotoDiagnosticsEnabled's
// pattern -- only sampled/sent while at least one client has the panel open.
bool sysDiagnosticsEnabled = false;
constexpr unsigned long SYS_DIAGNOSTICS_INTERVAL_MS = 1000;

// Round-trip time diagnostics: a pong reply awaiting send from the poll task
// rather than sent directly from the WS receive handler -- matches the Pico
// build's documented ~2s latency finding for replying from within the
// receive-event callback vs. the main loop. Also happens to be the
// mechanism that keeps every WS send on ONE task (see ws_poll_task's header
// comment) -- the receive handler runs on the httpd task and must never
// write to the socket itself.
bool pendingPongFlag = false;
int pendingPongFd = -1;
int pendingPongSeq = 0;

void handle_ws_message(int fd, const char *body) {
    cJSON *root = cJSON_Parse(body);
    if (root == nullptr) {
        return;
    }
    cJSON *typeItem = cJSON_GetObjectItemCaseSensitive(root, "type");
    if (!cJSON_IsString(typeItem)) {
        cJSON_Delete(root);
        return;
    }
    const char *type = typeItem->valuestring;
    breadcrumb_mark_ws_message(type);

    auto getNum = [&](const char *key, double defaultVal = 0.0) -> double {
        cJSON *item = cJSON_GetObjectItemCaseSensitive(root, key);
        return cJSON_IsNumber(item) ? item->valuedouble : defaultVal;
    };
    auto getBool = [&](const char *key, bool defaultVal = false) -> bool {
        cJSON *item = cJSON_GetObjectItemCaseSensitive(root, key);
        return cJSON_IsBool(item) ? cJSON_IsTrue(item) : defaultVal;
    };
    auto getStr = [&](const char *key) -> const char * {
        cJSON *item = cJSON_GetObjectItemCaseSensitive(root, key);
        return cJSON_IsString(item) ? item->valuestring : nullptr;
    };

    if (std::strcmp(type, "mode") == 0) {
        cJSON *modeItem = cJSON_GetObjectItemCaseSensitive(root, "mode");
        if (cJSON_IsNumber(modeItem)) {
            switchModeIfNeeded((int) modeItem->valuedouble);
        }
    } else if (std::strcmp(type, "joystick") == 0) {
        switchModeIfNeeded(TOUCHPAD_CONTROL);
        double j1 = getNum("j1"), j2 = getNum("j2");
        V1[0] = (float) (j2 + j1);
        V1[1] = (float) (j2 - j1);
        lastDriveCommandMs = millis_now();
    } else if (std::strcmp(type, "control_joystick") == 0) {
        switchModeIfNeeded(CONTROL_FRAME_CONTROL);
        lastDriveCommandMs = millis_now();
        double j1 = getNum("j1"), j2 = getNum("j2");
        controlJoyX = (float) j2;
        controlJoyY = (float) -j1;
    } else if (std::strcmp(type, "goto") == 0) {
        switchModeIfNeeded(GOTO_POSITION_CONTROL);
        goalX_m = (float) getNum("x");
        goalY_m = (float) getNum("y");
        cJSON *headingItem = cJSON_GetObjectItemCaseSensitive(root, "heading");
        goalHasHeading = cJSON_IsNumber(headingItem);
        goalHeadingRad = goalHasHeading ? (float) headingItem->valuedouble : 0.0f;
        goalMaintainSpeed = getBool("maintainSpeed");
    } else if (std::strcmp(type, "control_frame_rotate") == 0) {
        // Purely adjusts the reference arrow, doesn't drive the motors --
        // no mode switch here, unlike the drive commands above. `value` is
        // the RAW signed deflection fraction in [-1,1] from the X axis of
        // the camera control joystick (app.js's setupCameraJoystick()),
        // resent continuously while dragged (~25Hz, matching the other
        // joysticks) and zeroed by the client itself on release. The curve
        // (settings.cameraJoystickCurve) and rate scaling
        // (settings.panMaxSpeedDegPerSec) are both applied server-side, in
        // the poll loop below -- not here, and not client-side -- so
        // there's a single authoritative interpretation regardless of which
        // browser sent it. lastControlFrameRotateMsgMs also backs a
        // watchdog in the poll loop, in case a dropped connection mid-drag
        // never sends that release.
        controlFrameRotateInput = std::clamp((float) getNum("value"), -1.0f, 1.0f);
        lastControlFrameRotateMsgMs = millis_now();
    } else if (std::strcmp(type, "aim") == 0) {
        // Absolute camera aim from the first-person page (see
        // aimTargetOmegaRadPerSec's doc comment): heading = the control
        // frame's direction (rad, odometry frame), tilt = the tilt angle (deg).
        // Replaces any rate input rather than adding to it.
        unsigned long nowMs = millis_now();
        float heading = wrapToPi((float) getNum("heading"));
        float dt = (nowMs - lastAimMsgMs) / 1000.0f;
        float omega = (lastAimMsgMs != 0 && dt > 0.005f && dt < 0.5f) ? wrapToPi(heading - controlFrameThetaRad) / dt : 0.0f;
        aimTargetOmegaRadPerSec = 0.5f * aimTargetOmegaRadPerSec + 0.5f * omega; // the page's send timing jitters
        lastAimMsgMs = nowMs;
        controlFrameThetaRad = heading;
        controlFrameRotateInput = 0.0f;
        lastControlFrameRotateMsgMs = nowMs;
        tiltRateInput = 0.0f;
        lastTiltRateMsgMs = nowMs;
        float tilt = std::clamp((float) getNum("tilt"), settings.tiltMinAngleDeg, settings.tiltMaxAngleDeg);
        if (tilt != currentTiltAngleDeg) {
            currentTiltAngleDeg = tilt;
            lastTiltActiveMs = nowMs;
            tiltServoIdle = false;
            writeTiltServoPulse();
        }
    } else if (std::strcmp(type, "calibrate_deadzone") == 0) {
        switchModeIfNeeded(DEADZONE_CALIBRATION);
        startDeadzoneCalibrationFlag = true;
    } else if (std::strcmp(type, "calibrate_encoder_count") == 0) {
        switchModeIfNeeded(ENCODER_CALIBRATION);
        encoderCalibrationWheel = ((int) getNum("wheel") == 1) ? 1 : 0;
        startEncoderCalibrationFlag = true;
    } else if (std::strcmp(type, "goto_diag_enable") == 0) {
        gotoDiagnosticsEnabled = getBool("enabled");
    } else if (std::strcmp(type, "sys_diag_enable") == 0) {
        sysDiagnosticsEnabled = getBool("enabled");
    } else if (std::strcmp(type, "servo_angle") == 0) {
        // Independent of the drive-mode state machine (like
        // control_frame_rotate above). If servoFollowControlFrame is on,
        // the poll task overwrites this within one of its own update ticks.
        // Clamped to the calibrated range (not a fixed +/-90) so the test
        // panel can reach a wider-than-180-deg servo's full travel -- the
        // auto-follow path below has its own, architecturally fixed +/-90
        // clamp, independent of this one.
        currentServoAngleDeg = std::clamp((float) getNum("angleDeg"), settings.servoMinAngleDeg, settings.servoMaxAngleDeg);
        lastPanActiveMs = millis_now();
        panServoIdle = false;
        writePanServoPulse(); // no-op until PAN_SERVO_STARTUP_DELAY_MS has elapsed -- see its doc comment
    } else if (std::strcmp(type, "tilt_servo_angle") == 0) {
        // Direct/absolute angle set -- used by the tilt test panel's own
        // slider for calibration, not by the camera control joystick (see
        // tilt_rate below for that). No auto-follow ever overwrites this;
        // tilt's range is itself a calibration value (Settings::tiltMinAngleDeg).
        currentTiltAngleDeg = std::clamp((float) getNum("angleDeg"), settings.tiltMinAngleDeg, settings.tiltMaxAngleDeg);
        lastTiltActiveMs = millis_now();
        tiltServoIdle = false;
        writeTiltServoPulse(); // no-op until TILT_SERVO_STARTUP_DELAY_MS has elapsed -- see its doc comment
    } else if (std::strcmp(type, "tilt_rate") == 0) {
        // Y axis of the camera control joystick -- see
        // controlFrameRotateInput's doc comment above and tiltRateInput's
        // own doc comment for why this is integrated server-side (into
        // currentTiltAngleDeg, in the poll loop below) rather than
        // client-side: multiple browsers can each send this, and the ESP32
        // has to be the one shared source of truth for the current angle.
        tiltRateInput = std::clamp((float) getNum("value"), -1.0f, 1.0f);
        lastTiltRateMsgMs = millis_now();
    } else if (std::strcmp(type, "manual_velocity_setpoint") == 0) {
        switchModeIfNeeded(MANUAL_VELOCITY_CONTROL);
        manualVelSetpointRevPerSec[0] = std::clamp((float) getNum("left"), -settings.maxWheelSpeedRevPerSec, settings.maxWheelSpeedRevPerSec);
        manualVelSetpointRevPerSec[1] = std::clamp((float) getNum("right"), -settings.maxWheelSpeedRevPerSec, settings.maxWheelSpeedRevPerSec);
    } else if (std::strcmp(type, "lab1") == 0) {
        const char *cmd = getStr("cmd");
        if (cmd != nullptr && (std::strcmp(cmd, "forward") == 0 || std::strcmp(cmd, "backward") == 0)) {
            switchModeIfNeeded(LAB1_FWD_REV);
            lab1Forward = std::strcmp(cmd, "forward") == 0;
            lab1StartTimeMs = millis_now();
        }
    } else if (std::strcmp(type, "lab2_setpoint") == 0) {
        switchModeIfNeeded(LAB2_PID_1M);
        float delta = (float) getNum("delta");
        lab2SetpointM[0] += delta;
        lab2SetpointM[1] += delta;
    } else if (std::strcmp(type, "lab2_turn") == 0) {
        const char *dir = getStr("dir");
        if (dir != nullptr) {
            switchModeIfNeeded(LAB2_PID_1M);
            applyLab2Turn(std::strcmp(dir, "left") == 0);
        }
    } else if (std::strcmp(type, "ping") == 0) {
        pendingPongFd = fd;
        pendingPongSeq = (int) getNum("seq");
        pendingPongFlag = true;
    }

    cJSON_Delete(root);
}

constexpr size_t WS_RX_MAX = 256; // drive messages are well under 150 bytes

esp_err_t ws_handler(httpd_req_t *req) {
    if (req->method == HTTP_GET) {
        // Handshake -- the framework completes the HTTP->WS upgrade itself,
        // nothing to send from here.
        return ESP_OK;
    }

    httpd_ws_frame_t frame = {};
    frame.type = HTTPD_WS_TYPE_TEXT;
    if (httpd_ws_recv_frame(req, &frame, 0) != ESP_OK) { // first pass: fills frame.len only
        return ESP_OK; // don't kill the connection over a malformed frame
    }
    if (frame.len == 0) {
        return ESP_OK;
    }
    if (frame.len > WS_RX_MAX) {
        // Its payload is still in the socket: returning without reading it
        // would have the next "frame" parsed from the middle of this one.
        // Read and drop a moderately oversized message; close the
        // connection on an absurd one (the client reconnects).
        constexpr size_t WS_DRAIN_MAX = 4096;
        ESP_LOGW(TAG, "dropping oversized WS message (%u bytes)", (unsigned) frame.len);
        if (frame.len > WS_DRAIN_MAX) return ESP_FAIL;
        uint8_t *junk = (uint8_t *) malloc(frame.len);
        if (junk == nullptr) return ESP_FAIL;
        frame.payload = junk;
        esp_err_t err = httpd_ws_recv_frame(req, &frame, frame.len);
        free(junk);
        return err == ESP_OK ? ESP_OK : ESP_FAIL;
    }

    uint8_t buf[WS_RX_MAX + 1];
    frame.payload = buf;
    if (httpd_ws_recv_frame(req, &frame, WS_RX_MAX) != ESP_OK) {
        return ESP_OK;
    }
    buf[frame.len] = 0;

    handle_ws_message(httpd_req_to_sockfd(req), (const char *) buf);
    return ESP_OK;
}

// -- outbound broadcast --------------------------------------------------

constexpr size_t MAX_WS_FDS = 16; // >= httpd_config_t.max_open_sockets (12)

// -- non-blocking WebSocket sends ------------------------------------------
// Everything outbound on the WebSockets (telemetry broadcasts, pongs) goes
// through ws_send_text() below, only ever from ws_poll_task, so framing can't
// interleave. The httpd receive handler never sends.
//
// This task is watched by the task watchdog (3 s), so it must never block on
// a socket. esp_http_server's httpd_ws_send_frame_async() does two BLOCKING
// send()s bounded only by send_wait_timeout, and lwIP checks that timeout
// with ~1 s granularity -- one stalled client (e.g. a phone reloading the
// page, a burst of new connections exhausting lwIP's buffers) could hold this
// task for 3-6 s and trigger a watchdog reboot. That was the "hang in
// pose_broadcast". A select() "writable" probe didn't help: it only
// guarantees a minimal amount of send-buffer space.
//
// So frames are built here and written with MSG_DONTWAIT. Whatever doesn't
// fit waits in that client's backlog, retried every tick; new frames for a
// client with a backlog are dropped (telemetry is superseded 10x a second
// anyway), and a client whose backlog hasn't drained for 2 s is closed --
// the pages reconnect by themselves.
constexpr size_t WS_FRAME_MAX = 1024; // largest frame we build: 4-byte header + <= 800-byte payload
constexpr int64_t WS_BACKLOG_TIMEOUT_US = 2000000;

struct WsBacklog {
    int fd = -1;
    size_t len = 0; // bytes waiting in buf
    size_t off = 0; // of which already sent
    int64_t sinceUs = 0;
    uint8_t buf[WS_FRAME_MAX];
};
WsBacklog wsBacklogs[MAX_WS_FDS];
portMUX_TYPE wsBacklogMux = portMUX_INITIALIZER_UNLOCKED; // guards slot ownership against the close callback

WsBacklog *backlog_for(int fd) {
    WsBacklog *found = nullptr;
    taskENTER_CRITICAL(&wsBacklogMux);
    for (auto &b : wsBacklogs) {
        if (b.fd == fd) {
            found = &b;
            break;
        }
    }
    if (!found) {
        for (auto &b : wsBacklogs) {
            if (b.fd < 0) {
                b.fd = fd;
                b.len = b.off = 0;
                found = &b;
                break;
            }
        }
    }
    taskEXIT_CRITICAL(&wsBacklogMux);
    return found;
}

// >= 0: bytes written (possibly fewer than len); -1: socket error.
int send_nonblocking(int fd, const uint8_t *data, size_t len) {
    int n = send(fd, data, len, MSG_DONTWAIT);
    if (n < 0) return (errno == EAGAIN || errno == EWOULDBLOCK) ? 0 : -1;
    return n;
}

// Returns true if nothing is left waiting for this client.
bool flush_backlog(httpd_handle_t server, WsBacklog &b) {
    if (b.off >= b.len) return true;
    int n = send_nonblocking(b.fd, b.buf + b.off, b.len - b.off);
    if (n > 0) {
        b.off += (size_t) n;
        b.sinceUs = esp_timer_get_time(); // progress
    }
    if (b.off >= b.len) {
        b.len = b.off = 0;
        return true;
    }
    if (n < 0 || esp_timer_get_time() - b.sinceUs > WS_BACKLOG_TIMEOUT_US) {
        ESP_LOGW(TAG, "ws fd %d stalled -- closing it", b.fd);
        b.len = b.off = 0;
        httpd_sess_trigger_close(server, b.fd);
    }
    return false;
}

void ws_send_text(httpd_handle_t server, int fd, const char *text, size_t len) {
    if (len + 4 > WS_FRAME_MAX) return;
    WsBacklog *b = backlog_for(fd);
    if (b == nullptr) return;
    if (!flush_backlog(server, *b)) return; // still busy with an earlier frame: drop this one
    // Server-to-client frame: FIN + text opcode, unmasked, 7- or 16-bit length.
    size_t h = 0;
    b->buf[h++] = 0x81;
    if (len < 126) {
        b->buf[h++] = (uint8_t) len;
    } else {
        b->buf[h++] = 126;
        b->buf[h++] = (uint8_t) (len >> 8);
        b->buf[h++] = (uint8_t) len;
    }
    std::memcpy(b->buf + h, text, len);
    b->len = h + len;
    b->off = 0;
    b->sinceUs = esp_timer_get_time();
    flush_backlog(server, *b);
}

// Retry every client's pending bytes (called once per poll tick).
void flush_all_backlogs(httpd_handle_t server) {
    for (auto &b : wsBacklogs) {
        if (b.fd >= 0 && b.len > b.off) {
            if (httpd_ws_get_fd_info(server, b.fd) != HTTPD_WS_CLIENT_WEBSOCKET) {
                b.len = b.off = 0; // gone
                continue;
            }
            flush_backlog(server, b);
        }
    }
}

// Sends `json` to every currently-connected WS client, never blocking.
void broadcast_ws(httpd_handle_t server, const char *json, size_t len) {
    if (server == nullptr) {
        return;
    }
    int fds[MAX_WS_FDS];
    size_t fdCount = MAX_WS_FDS;
    if (httpd_get_client_list(server, &fdCount, fds) != ESP_OK) {
        return;
    }
    for (size_t i = 0; i < fdCount; i++) {
        if (httpd_ws_get_fd_info(server, fds[i]) == HTTPD_WS_CLIENT_WEBSOCKET) {
            ws_send_text(server, fds[i], json, len);
        }
    }
}

int count_ws_clients(httpd_handle_t server) {
    if (server == nullptr) {
        return 0;
    }
    int fds[MAX_WS_FDS];
    size_t fdCount = MAX_WS_FDS;
    if (httpd_get_client_list(server, &fdCount, fds) != ESP_OK) {
        return 0;
    }
    int count = 0;
    for (size_t i = 0; i < fdCount; i++) {
        if (httpd_ws_get_fd_info(server, fds[i]) == HTTPD_WS_CLIENT_WEBSOCKET) {
            count++;
        }
    }
    return count;
}

// -- poll task: control-frame rotation, servo follow, drive watchdog,
//    pending pong, pose/sysstats broadcast -- was web_server_poll(),
//    called from the Pico build's core0 main loop. Runs at 50Hz: fast
//    enough for the 20Hz servo-follow update and the up-to-30Hz telemetry
//    rate, without being needlessly tight for a task that's mostly idle
//    between those.

constexpr unsigned long POLL_INTERVAL_MS = 20;

TaskHandle_t g_pollTaskHandle = nullptr;

void ws_poll_task(void *arg) {
    (void) arg;
    breadcrumb_mark_core0(CORE0_CP_BOOT);
    httpd_handle_t server = web_server_get_handle();

    // Drive both servos to their home position (angle 0, from
    // web_server_recenter_servo()) immediately -- no startup delay needed
    // on this rover's power supply. panServoIdle/tiltServoIdle flip to
    // false here so the idle-cutoff check in the loop below doesn't
    // immediately undo this before SERVO_IDLE_TIMEOUT_MS has meaningfully
    // elapsed; lastPanActiveMs/lastTiltActiveMs are still 0 at this point,
    // which the loop's own first-tick initialization (right below) already
    // handles correctly.
    writePanServoPulse();
    panServoIdle = false;
    writeTiltServoPulse();
    tiltServoIdle = false;

    unsigned long lastControlFrameUpdateMs = 0;
    unsigned long lastTiltRateUpdateMs = 0;
    unsigned long lastServoFollowUpdateMs = 0;
    unsigned long lastPoseSendMs = 0;
    unsigned long lastSysStatsSendMs = 0;

    while (true) {
        vTaskDelay(pdMS_TO_TICKS(POLL_INTERVAL_MS));
        diagnostics_core0_loop_start();
        unsigned long nowMs = millis_now();

        // The one checkpoint that also records connection counts -- see
        // breadcrumb_mark_core0_with_conns()'s doc comment on why this is
        // the single most useful place to capture them for a hang
        // investigation, and why it's not done on every mark.
        int totalConns = 0;
        {
            int fds[MAX_WS_FDS];
            size_t fdCount = MAX_WS_FDS;
            if (server != nullptr && httpd_get_client_list(server, &fdCount, fds) == ESP_OK) {
                totalConns = (int) fdCount;
            }
        }
        breadcrumb_mark_core0_with_conns(CORE0_CP_POLL_LOOP_START, totalConns, count_ws_clients(server));

        if (lastControlFrameUpdateMs == 0) {
            lastControlFrameUpdateMs = nowMs;
        }
        if (lastTiltRateUpdateMs == 0) {
            lastTiltRateUpdateMs = nowMs;
        }
        // Same reasoning: without this, both default to 0 and the very
        // first tick (already well past SERVO_IDLE_TIMEOUT_MS of "boot
        // time") would immediately idle-cut the servos web_server_recenter_servo()
        // just drove them to.
        if (lastPanActiveMs == 0) {
            lastPanActiveMs = nowMs;
        }
        if (lastTiltActiveMs == 0) {
            lastTiltActiveMs = nowMs;
        }
        breadcrumb_mark_core0(CORE0_CP_CONTROL_FRAME);
        if (controlFrameRotateInput != 0.0f && nowMs - lastControlFrameRotateMsgMs > DRIVE_COMMAND_WATCHDOG_MS) {
            controlFrameRotateInput = 0.0f; // dropped connection mid-drag -- see its doc comment above
        }
        if (std::fabs(controlFrameRotateInput) > CONTROL_FRAME_ROTATE_DEADZONE) {
            float dt_s = (nowMs - lastControlFrameUpdateMs) / 1000.0f;
            float rateDegPerSec = applyJoystickCurve(controlFrameRotateInput) * settings.panMaxSpeedDegPerSec;
            controlFrameThetaRad = wrapToPi(controlFrameThetaRad + rateDegPerSec * ((float) M_PI / 180.0f) * dt_s);
        }
        lastControlFrameUpdateMs = nowMs;

        // Tilt: same rate-control pattern as the rotate axis just above,
        // but integrates directly into currentTiltAngleDeg (there's no
        // separate "reference" vs. "actual" split like pan's control-frame
        // vs. chassis heading -- tilt has no auto-follow, so its commanded
        // angle IS the angle). Only counts as "active" (refreshes
        // lastTiltActiveMs, wakes it from idle) when the clamped result
        // actually changes -- e.g. already pinned at tiltMaxAngleDeg and
        // still holding the stick up shouldn't keep re-writing the same
        // pulse or resetting the idle timer.
        if (tiltRateInput != 0.0f && nowMs - lastTiltRateMsgMs > DRIVE_COMMAND_WATCHDOG_MS) {
            tiltRateInput = 0.0f; // dropped connection mid-drag -- same reasoning as controlFrameRotateInput's watchdog
        }
        if (std::fabs(tiltRateInput) > CONTROL_FRAME_ROTATE_DEADZONE) {
            float dt_s = (nowMs - lastTiltRateUpdateMs) / 1000.0f;
            float rateDegPerSec = applyJoystickCurve(tiltRateInput) * settings.tiltMaxSpeedDegPerSec;
            float newTiltAngle = std::clamp(currentTiltAngleDeg + rateDegPerSec * dt_s, settings.tiltMinAngleDeg, settings.tiltMaxAngleDeg);
            if (newTiltAngle != currentTiltAngleDeg) {
                currentTiltAngleDeg = newTiltAngle;
                lastTiltActiveMs = nowMs;
                tiltServoIdle = false;
                writeTiltServoPulse();
            }
        }
        lastTiltRateUpdateMs = nowMs;

        // Pan-servo camera platform: counter-rotate to keep facing the
        // control frame's reference direction even while the chassis turns
        // to strafe/reverse. Clamped to the servo's +/-90 deg range.
        breadcrumb_mark_core0(CORE0_CP_SERVO_FOLLOW);
        //
        // Measured (debug_pan.cpp experiments: camera heading tracked from
        // the video while the robot turns in place): the servo lags its
        // command by roughly 60 ms, so aiming at the CURRENT chassis heading
        // left the camera trailing by rate x lag -- ~12 deg at 130 deg/s and
        // ~24 deg at 240 deg/s with the old 60 ms update spacing. Updating
        // every tick (20 ms, the servo's own PWM frame) and aiming where the
        // chassis will be g_panLeadMs from now (rate x lead) brings that
        // down to ~2-5 deg. Both are runtime knobs, see debug_pan.hpp.
        if (settings.servoFollowControlFrame && !g_panFollowSuspended &&
            (nowMs - lastServoFollowUpdateMs >= (unsigned long) g_panFollowIntervalMs)) {
            lastServoFollowUpdateMs = nowMs;
            float predictedThetaRad = poseThetaRad;
            if (g_panLeadMs > 0.0f) {
                float wheelCircumference_m = (float) M_PI * settings.wheelDiameterMm / 1000.0f;
                float omegaRadPerSec = (wheelVelRevPerSec[1] - wheelVelRevPerSec[0]) * wheelCircumference_m /
                                       (settings.wheelbaseMm / 1000.0f);
                // Ignore encoder blips at standstill (below ~6 deg/s the lead
                // would add < 0.5 deg anyway), so a still robot doesn't keep
                // nudging (and re-energizing) the servo.
                if (std::fabs(omegaRadPerSec) > 0.1f) {
                    predictedThetaRad += omegaRadPerSec * g_panLeadMs / 1000.0f;
                }
            }
            float headingDiffRad = wrapToPi(controlFrameThetaRad - predictedThetaRad);
            float newAngle = std::clamp(headingDiffRad * 180.0f / (float) M_PI, -90.0f, 90.0f);
            // Only counts as "active" (and only re-writes the pulse) if the
            // needed angle actually moved -- a stationary robot/control
            // frame recomputes the exact same angle every tick, and that
            // alone shouldn't keep the servo energized. See
            // SERVO_IDLE_TIMEOUT_MS's doc comment above.
            if (newAngle != currentServoAngleDeg) {
                currentServoAngleDeg = newAngle;
                lastPanActiveMs = nowMs;
                panServoIdle = false;
                writePanServoPulse();
            }
        }

        // Idle-power cutoff -- see SERVO_IDLE_TIMEOUT_MS's doc comment.
        // Falls under the same CORE0_CP_SERVO_FOLLOW checkpoint above; not
        // worth its own breadcrumb entry for two non-blocking comparisons.
        if (!panServoIdle && nowMs - lastPanActiveMs > SERVO_IDLE_TIMEOUT_MS) {
            servo_set_pulse_us(0);
            panServoIdle = true;
        }
        if (!tiltServoIdle && nowMs - lastTiltActiveMs > SERVO_IDLE_TIMEOUT_MS) {
            tilt_servo_set_pulse_us(0);
            tiltServoIdle = true;
        }

        breadcrumb_mark_core0(CORE0_CP_DRIVE_WATCHDOG);
        if ((settings.mode == TOUCHPAD_CONTROL || settings.mode == CONTROL_FRAME_CONTROL) &&
            nowMs - lastDriveCommandMs > DRIVE_COMMAND_WATCHDOG_MS) {
            V1[0] = V1[1] = 0;
            controlJoyX = 0;
            controlJoyY = 0;
        }

        breadcrumb_mark_core0(CORE0_CP_PONG);
        if (pendingPongFlag) {
            pendingPongFlag = false;
            char buf[64];
            int n = snprintf(buf, sizeof(buf), "{\"type\":\"pong\",\"seq\":%d}", pendingPongSeq);
            if (server != nullptr && httpd_ws_get_fd_info(server, pendingPongFd) == HTTPD_WS_CLIENT_WEBSOCKET) {
                ws_send_text(server, pendingPongFd, buf, (size_t) n);
            }
        }

        servo_history_record(nowMs);
        if (server != nullptr) flush_all_backlogs(server);
        int wsCount = count_ws_clients(server);

        breadcrumb_mark_core0(CORE0_CP_POSE_BROADCAST);
        unsigned long poseTelemetryIntervalMs = (unsigned long) (1000.0f / settings.telemetryHz);
        if (wsCount > 0 && (nowMs - lastPoseSendMs >= poseTelemetryIntervalMs)) {
            lastPoseSendMs = nowMs;
            // Robot-center linear speed (magnitude), from the same 1kHz
            // encoder-derivative wheel velocities the position controller
            // uses -- not gated behind gotoDiagnosticsEnabled, since the
            // speedometer needs it unconditionally.
            float wheelCircumferenceCm = (float) M_PI * settings.wheelDiameterMm / 10.0f;
            float speedCmPerSec = std::fabs((wheelVelRevPerSec[0] + wheelVelRevPerSec[1]) / 2.0f) * wheelCircumferenceCm;
            // Same "always send it" reasoning as speedCmPerSec above -- it's
            // three floats, cheap enough not to need its own opt-in gate
            // like gotoDiagnosticsEnabled/sysDiagnosticsEnabled do for their
            // much larger payloads. Left at 0 (with inaAvailable:false) if
            // the sensor was never found -- the Main page's Power panel
            // reads that flag rather than treating 0V/0mA as a real reading.
            float inaVoltageV = 0.0f, inaCurrentMa = 0.0f, inaPowerMw = 0.0f;
            bool inaOk = ina260_read(&inaVoltageV, &inaCurrentMa, &inaPowerMw);
            float panActDeg, tiltActDeg;
            ws_broadcast_servo_actual(&panActDeg, &tiltActDeg);
            char json[800];
            int len = snprintf(json, sizeof(json),
                "{\"type\":\"pose\",\"t\":%lu,\"x\":%.4f,\"y\":%.4f,\"theta\":%.4f,\"controlTheta\":%.4f,"
                "\"calibrating\":%s,\"calibratingPwm\":%d,"
                "\"encoderCalibrating\":%s,\"encoderCalibrationWheel\":%d,\"encoderCalibrationRevs\":%.3f,"
                "\"speedCmPerSec\":%.2f,\"servoAngleDeg\":%.2f,\"tiltAngleDeg\":%.2f,"
                "\"panActDeg\":%.2f,\"tiltActDeg\":%.2f,"
                "\"inaAvailable\":%s,\"inaVoltageV\":%.3f,\"inaCurrentMa\":%.1f,\"inaPowerMw\":%.1f",
                nowMs, poseX_m, poseY_m, poseThetaRad, controlFrameThetaRad,
                deadzoneCalibrationActive ? "true" : "false", deadzoneCalibrationPwm,
                encoderCalibrationActive ? "true" : "false", encoderCalibrationWheel, encoderCalibrationRevsDone,
                speedCmPerSec, currentServoAngleDeg, currentTiltAngleDeg,
                panActDeg, tiltActDeg,
                inaOk ? "true" : "false", inaVoltageV, inaCurrentMa, inaPowerMw);
            if (gotoDiagnosticsEnabled && len > 0 && (size_t) len < sizeof(json)) {
                len += snprintf(json + len, sizeof(json) - len,
                    ",\"wheelPosRev\":[%.5f,%.5f],\"wheelVelRevPerSec\":[%.5f,%.5f],"
                    "\"gotoWheelVelSetpointRevPerSec\":[%.5f,%.5f],\"gotoWheelPosSetpointRev\":[%.5f,%.5f],"
                    "\"gotoTargetHeadingRad\":%.4f,\"goalX\":%.4f,\"goalY\":%.4f,"
                    "\"motorPowerPwm\":[%d,%d],\"gotoFfPwm\":[%.2f,%.2f],\"gotoPPwm\":[%.2f,%.2f],\"gotoIPwm\":[%.2f,%.2f]",
                    wheelPosRev[0], wheelPosRev[1], wheelVelRevPerSec[0], wheelVelRevPerSec[1],
                    gotoWheelVelSetpointRevPerSec[0], gotoWheelVelSetpointRevPerSec[1],
                    gotoWheelPosSetpointRev[0], gotoWheelPosSetpointRev[1],
                    gotoTargetHeadingRad, goalX_m, goalY_m,
                    motorPowerPwm[0], motorPowerPwm[1],
                    gotoFfPwm[0], gotoFfPwm[1], gotoPPwm[0], gotoPPwm[1], gotoIPwm[0], gotoIPwm[1]);
            }
            if (len > 0 && (size_t) len < sizeof(json)) {
                len += snprintf(json + len, sizeof(json) - len, ",\"clients\":%d}", wsCount);
            }
            if (len > 0 && (size_t) len < sizeof(json)) {
                broadcast_ws(server, json, (size_t) len);
            }
        }

        breadcrumb_mark_core0(CORE0_CP_SYSSTATS_BROADCAST);
        if (sysDiagnosticsEnabled && wsCount > 0 && (nowMs - lastSysStatsSendMs >= SYS_DIAGNOSTICS_INTERVAL_MS)) {
            lastSysStatsSendMs = nowMs;
            DiagnosticsSnapshot snap;
            diagnostics_get_snapshot(&snap);
            char json[680];
            int len = snprintf(json, sizeof(json),
                "{\"type\":\"sysstats\","
                "\"core0Hz\":%.1f,\"core0TickAvgUs\":%u,\"core0TickMaxUs\":%u,"
                "\"core1Hz\":%.1f,\"core1TickAvgUs\":%u,\"core1TickMaxUs\":%u,"
                "\"heapArenaBytes\":%u,\"heapUsedBytes\":%u,\"heapFreeBytes\":%u,\"heapCeilingBytes\":%u,"
                "\"core0StackUsedBytes\":%u,\"core0StackTotalBytes\":%u,"
                "\"core1StackUsedBytes\":%u,\"core1StackTotalBytes\":%u,"
                "\"totalRamBytes\":%u,"
                "\"psramTotalBytes\":%u,\"psramFreeBytes\":%u,\"psramMinFreeBytes\":%u}",
                (double) snap.core0HzMeasured, (unsigned) snap.core0TickAvgUs, (unsigned) snap.core0TickMaxUs,
                (double) snap.core1HzMeasured, (unsigned) snap.core1TickAvgUs, (unsigned) snap.core1TickMaxUs,
                (unsigned) snap.heapArenaBytes, (unsigned) snap.heapUsedBytes, (unsigned) snap.heapFreeBytes,
                (unsigned) snap.heapCeilingBytes,
                (unsigned) snap.core0StackUsedBytes, (unsigned) snap.core0StackTotalBytes,
                (unsigned) snap.core1StackUsedBytes, (unsigned) snap.core1StackTotalBytes,
                (unsigned) snap.totalRamBytes,
                (unsigned) snap.psramTotalBytes, (unsigned) snap.psramFreeBytes, (unsigned) snap.psramMinFreeBytes);
            if (len > 0 && (size_t) len < sizeof(json)) {
                broadcast_ws(server, json, (size_t) len);
            }
        }

        breadcrumb_mark_core0(CORE0_CP_LOOP_END);
        diagnostics_core0_loop_end();

        // Subscribed by watchdog_system_init() (called from app_main() once
        // both this task and the control task exist). A hang anywhere above
        // -- including a stuck httpd_ws_send_frame_async() that somehow
        // evaded the writability probe -- now trips a 3s task-watchdog
        // reboot instead of silently freezing telemetry. Guarded the same
        // way as control_task.cpp's reset call -- see its comment.
        if (watchdog_is_ready()) {
            esp_task_wdt_reset();
        }
    }
}

// Where the servos physically are, as opposed to where they've been told to
// go: they take ~70 ms to follow a command (measured -- that's also the pan
// follow's lead, debug_pan.hpp), and since the pan command itself leads the
// chassis by that much, "chassis heading + commanded pan" ran ahead of the
// real camera heading by turn rate x 70 ms (up to ~20 deg in a fast turn).
// The camera page's overlays use this estimate instead: the commanded angles
// of g_panLeadMs ago, from a short history recorded every poll tick.
constexpr int SERVO_HISTORY = 32; // 32 x 20 ms = 640 ms
struct ServoSample {
    unsigned long ms;
    float pan;
    float tilt;
};
ServoSample servoHistory[SERVO_HISTORY];
int servoHistoryHead = 0; // next slot to write
int servoHistoryCount = 0;
portMUX_TYPE servoHistoryMux = portMUX_INITIALIZER_UNLOCKED;

void servo_history_record(unsigned long nowMs) {
    taskENTER_CRITICAL(&servoHistoryMux);
    servoHistory[servoHistoryHead] = {nowMs, currentServoAngleDeg, currentTiltAngleDeg};
    servoHistoryHead = (servoHistoryHead + 1) % SERVO_HISTORY;
    if (servoHistoryCount < SERVO_HISTORY) servoHistoryCount++;
    taskEXIT_CRITICAL(&servoHistoryMux);
}

} // namespace

void ws_broadcast_servo_actual(float *panDeg, float *tiltDeg) {
    *panDeg = currentServoAngleDeg;
    *tiltDeg = currentTiltAngleDeg;
    unsigned long target = millis_now() - (unsigned long) g_panLeadMs;
    taskENTER_CRITICAL(&servoHistoryMux);
    // newest to oldest: the first sample at or before `target` is the command
    // that was in force then
    for (int i = 1; i <= servoHistoryCount; i++) {
        const ServoSample &s = servoHistory[(servoHistoryHead - i + SERVO_HISTORY) % SERVO_HISTORY];
        *panDeg = s.pan;
        *tiltDeg = s.tilt;
        if ((long) (target - s.ms) >= 0) break;
    }
    taskEXIT_CRITICAL(&servoHistoryMux);
}

void ws_broadcast_set_pan_angle(float deg) {
    currentServoAngleDeg = std::clamp(deg, settings.servoMinAngleDeg, settings.servoMaxAngleDeg);
    lastPanActiveMs = millis_now();
    panServoIdle = false;
    writePanServoPulse();
}

void ws_broadcast_set_tilt_angle(float deg) {
    currentTiltAngleDeg = std::clamp(deg, settings.tiltMinAngleDeg, settings.tiltMaxAngleDeg);
    lastTiltActiveMs = millis_now();
    tiltServoIdle = false;
    writeTiltServoPulse();
}

void ws_broadcast_forget_fd(int fd) {
    // httpd's close callback (another task) -- make sure a reused socket
    // number never inherits a closed client's half-sent frame.
    taskENTER_CRITICAL(&wsBacklogMux);
    for (auto &b : wsBacklogs) {
        if (b.fd == fd) {
            b.len = b.off = 0;
            b.fd = -1;
        }
    }
    taskEXIT_CRITICAL(&wsBacklogMux);
}

void ws_broadcast_hold_drive_command() {
    lastDriveCommandMs = millis_now();
}

TaskHandle_t ws_broadcast_get_poll_task_handle() {
    return g_pollTaskHandle;
}

void ws_broadcast_start() {
    httpd_handle_t server = web_server_get_handle();
    if (server == nullptr) {
        ESP_LOGE(TAG, "web_server_get_handle() returned null -- call web_server_init() first");
        return;
    }

    httpd_uri_t wsUri = {};
    wsUri.uri = "/ws";
    wsUri.method = HTTP_GET;
    wsUri.handler = ws_handler;
    wsUri.user_ctx = nullptr;
    wsUri.is_websocket = true;
    httpd_register_uri_handler(server, &wsUri);

    xTaskCreate(ws_poll_task, "ws_poll", 4096, nullptr, 4, &g_pollTaskHandle);
    ESP_LOGI(TAG, "/ws registered, poll task running at %lu ms interval", (unsigned long) POLL_INTERVAL_MS);
}
