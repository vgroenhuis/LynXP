// Pan-servo tracking experiments -- see debug_pan.hpp.
//
// GET /debug/now
//     esp_timer time in us (for syncing a PC-side camera recording).
// GET /debug/panexp?kind=rotate|servo[&rate=0.5][&ms=600][&follow=1][&deg=40]
//     Starts one scripted experiment (409 if one is running) and returns at
//     once. The robot only ever turns in place:
//       rotate: 300 ms still, turn left at `rate` (fraction of max wheel
//               speed) for `ms`, 800 ms still, turn right for `ms`, 800 ms
//               still -- ending where it started. follow=0 holds the pan
//               servo still (camera turns with the chassis).
//       servo:  chassis still; pan servo steps +deg, holds 800 ms, back to
//               where it was, holds 800 ms.
//       turnto: pan servo held; 500 ms still, turn in place at `rate` until
//               odometry says the chassis turned `deg` (either sign; up to
//               720), 1500 ms still. For calibration: a full 360 deg turn is
//               exact whatever the calibration, see tools/calibrate.py.
//       record: doesn't move anything -- just logs (for `secs`, default 60,
//               max 600) while someone drives; kind=stop ends it early. The
//               log is a ring buffer, so read it as it goes with ?from=.
//     log_ms=N logs every N ms instead of every 5 (for long runs).
// GET /debug/servo?pan=<deg>&tilt=<deg> | ?release=1
//     Holds the pan/tilt servos at the given angles (pan follow suspended)
//     until released, or for at most 2 minutes.
// GET /debug/panlog[?from=N]
//     CSV of the experiment's log (409 while a scripted one is still running,
//     unless ?from= is given): t_us, theta_rad, wheel vel L/R (rev/s), pan
//     command (deg), phase, tilt command (deg), x_m, y_m. First line is
//     "# control_rad=..,t0_us=..,next=N": ask for ?from=N next time to get
//     only newer samples (the ring keeps the latest MAX_SAMPLES).
//
// No PSRAM on this build, so the log is packed to 20 bytes/sample (~20 KB).
// GET /debug/pantune[?interval=20][&lead=70]
//     Reads/sets the servo-follow knobs (not persisted; reboot resets them).
//
// All of it is gated like /update (ota_request_authorized()).

#include "debug_pan.hpp"
#include "web_server.hpp"
#include "control_modes.hpp"
#include "odometry.hpp"
#include "settings.hpp"
#include "ota.hpp"
#include "ws_broadcast.hpp"

#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

// Defaults from the 2026-09-27 tracking experiments (camera heading measured
// from the video during in-place turns, see ws_broadcast.cpp's servo-follow
// comment): 20 ms updates + 70 ms lead cut the peak camera heading error at
// ~240 deg/s from 24 deg to ~5 deg.
volatile int g_panFollowIntervalMs = 20;
volatile float g_panLeadMs = 70.0f;
volatile bool g_panFollowSuspended = false;

namespace {

const char *TAG = "debug_pan";

constexpr int SAMPLE_PERIOD_US = 5000; // 200 Hz
constexpr int64_t SERVO_HOLD_MAX_US = 120LL * 1000 * 1000;
constexpr int MAX_SAMPLES = 1024; // ring buffer; ~5 s at 200 Hz, ~40 s at 25 ms

struct Sample {
    uint32_t tUs; // since the experiment started
    float theta;
    int16_t wvL; // rev/s x 1000
    int16_t wvR;
    int16_t servoCdeg; // pan command, deg x 100
    int16_t tiltCdeg; // tilt command, deg x 100
    int16_t xMm; // position, mm
    int16_t yMm;
    uint8_t phase;
};

Sample *samples = nullptr;
int64_t t0Us = 0;
float controlThetaAtStart = 0.0f;
volatile int sampleCount = 0;
volatile uint8_t currentPhase = 0;
volatile bool logging = false;
volatile bool running = false;
volatile bool stopRequested = false;
esp_timer_handle_t sampleTimer = nullptr;
int logEvery = 1; // log every Nth 5 ms tick
int tickCounter = 0;
volatile float turnedRad = 0.0f; // turnto: accumulated odometry turn
volatile bool servoHeld = false;
volatile int64_t servoHoldUntilUs = 0;

struct Params {
    char kind[8];
    float rate;
    int ms;
    bool follow;
    float deg;
} params;

void sample_cb(void *) {
    if (servoHeld && esp_timer_get_time() > servoHoldUntilUs) {
        servoHeld = false; // forgotten hold -- give the pan servo back to follow
        g_panFollowSuspended = false;
    }
    if (!logging || samples == nullptr) return;
    if (++tickCounter < logEvery) return;
    tickCounter = 0;
    int i = sampleCount; // total ever logged this experiment; the ring holds the latest MAX_SAMPLES
    samples[i % MAX_SAMPLES] = {(uint32_t) (esp_timer_get_time() - t0Us), poseThetaRad,
                                (int16_t) (wheelVelRevPerSec[0] * 1000.0f), (int16_t) (wheelVelRevPerSec[1] * 1000.0f),
                                (int16_t) (currentServoAngleDeg * 100.0f), (int16_t) (currentTiltAngleDeg * 100.0f),
                                (int16_t) std::clamp(poseX_m * 1000.0f, -32767.0f, 32767.0f),
                                (int16_t) std::clamp(poseY_m * 1000.0f, -32767.0f, 32767.0f), currentPhase};
    sampleCount = i + 1;
}

// Holds an in-place turn (TOUCHPAD_CONTROL, V1 = [-r, r]; positive r turns
// left) for `ms`, refreshing the drive watchdog like a held joystick would.
void turn_for(float r, int ms) {
    int64_t end = esp_timer_get_time() + (int64_t) ms * 1000;
    while (esp_timer_get_time() < end) {
        switchModeIfNeeded(TOUCHPAD_CONTROL);
        V1[0] = -r;
        V1[1] = r;
        ws_broadcast_hold_drive_command();
        vTaskDelay(pdMS_TO_TICKS(20));
    }
    V1[0] = V1[1] = 0.0f;
}

void hold_still(int ms) {
    int64_t end = esp_timer_get_time() + (int64_t) ms * 1000;
    while (esp_timer_get_time() < end) {
        V1[0] = V1[1] = 0.0f;
        ws_broadcast_hold_drive_command();
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

void experiment_task(void *) {
    sampleCount = 0;
    currentPhase = 0;
    t0Us = esp_timer_get_time();
    controlThetaAtStart = controlFrameThetaRad;
    logging = true;

    if (std::strcmp(params.kind, "rotate") == 0) {
        if (!params.follow) {
            g_panFollowSuspended = true; // servo stays where it is
        }
        hold_still(300);
        currentPhase = 1;
        turn_for(params.rate, params.ms);
        currentPhase = 2;
        hold_still(800);
        currentPhase = 3;
        turn_for(-params.rate, params.ms);
        currentPhase = 4;
        hold_still(800);
        g_panFollowSuspended = false;
    } else if (std::strcmp(params.kind, "record") == 0) {
        int64_t end = t0Us + (int64_t) params.ms * 1000;
        while (!stopRequested && esp_timer_get_time() < end) vTaskDelay(pdMS_TO_TICKS(50));
    } else if (std::strcmp(params.kind, "turnto") == 0) {
        g_panFollowSuspended = true;
        hold_still(500);
        currentPhase = 1;
        float target = std::fabs(params.deg) * (float) M_PI / 180.0f;
        float r = params.deg >= 0 ? params.rate : -params.rate;
        float last = poseThetaRad;
        turnedRad = 0.0f;
        int64_t giveUp = esp_timer_get_time() + 20LL * 1000 * 1000;
        while (std::fabs(turnedRad) < target && esp_timer_get_time() < giveUp) {
            switchModeIfNeeded(TOUCHPAD_CONTROL);
            V1[0] = -r;
            V1[1] = r;
            ws_broadcast_hold_drive_command();
            vTaskDelay(pdMS_TO_TICKS(5));
            float now = poseThetaRad;
            turnedRad += wrapToPi(now - last);
            last = now;
        }
        V1[0] = V1[1] = 0.0f;
        currentPhase = 2;
        int64_t settleEnd = esp_timer_get_time() + 1500 * 1000;
        while (esp_timer_get_time() < settleEnd) { // keep integrating the stop overshoot
            hold_still(5);
            float now = poseThetaRad;
            turnedRad += wrapToPi(now - last);
            last = now;
        }
        if (!servoHeld) g_panFollowSuspended = false;
    } else { // servo
        g_panFollowSuspended = true;
        float start = currentServoAngleDeg;
        hold_still(300);
        currentPhase = 1;
        ws_broadcast_set_pan_angle(start + params.deg);
        hold_still(800);
        currentPhase = 2;
        ws_broadcast_set_pan_angle(start);
        hold_still(800);
        g_panFollowSuspended = false;
    }

    logging = false;
    running = false;
    ESP_LOGI(TAG, "experiment '%s' done, %d samples", params.kind, (int) sampleCount);
    vTaskDelete(nullptr);
}

bool query_str(httpd_req_t *req, const char *key, char *out, size_t len) {
    char q[160];
    if (httpd_req_get_url_query_str(req, q, sizeof(q)) != ESP_OK) return false;
    return httpd_query_key_value(q, key, out, len) == ESP_OK;
}

float query_float(httpd_req_t *req, const char *key, float def) {
    char v[24];
    return query_str(req, key, v, sizeof(v)) ? std::strtof(v, nullptr) : def;
}

esp_err_t handle_now(httpd_req_t *req) {
    char buf[32];
    snprintf(buf, sizeof(buf), "%lld", (long long) esp_timer_get_time());
    httpd_resp_set_type(req, "text/plain");
    return httpd_resp_sendstr(req, buf);
}

esp_err_t handle_exp(httpd_req_t *req) {
    if (!ota_request_authorized(req)) return ESP_OK;
    char stopKind[8] = "";
    if (query_str(req, "kind", stopKind, sizeof(stopKind)) && std::strcmp(stopKind, "stop") == 0) {
        stopRequested = true; // record only; scripted experiments are short
        return httpd_resp_sendstr(req, running ? "stopping" : "nothing running");
    }
    if (running) {
        httpd_resp_set_status(req, "409 Conflict");
        return httpd_resp_sendstr(req, "experiment already running");
    }
    if (samples == nullptr) {
        samples = (Sample *) malloc(sizeof(Sample) * MAX_SAMPLES);
        if (samples == nullptr) {
            char msg[96];
            snprintf(msg, sizeof(msg), "no memory for the log (%u bytes; largest free block %u)",
                     (unsigned) (sizeof(Sample) * MAX_SAMPLES), (unsigned) heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, msg);
            return ESP_OK;
        }
    }
    char kind[8] = "rotate";
    query_str(req, "kind", kind, sizeof(kind));
    if (std::strcmp(kind, "rotate") != 0 && std::strcmp(kind, "servo") != 0 && std::strcmp(kind, "turnto") != 0 &&
        std::strcmp(kind, "record") != 0) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "kind must be rotate, servo, turnto, record or stop");
        return ESP_OK;
    }
    std::strcpy(params.kind, kind);
    // Deliberately bounded: these move the robot.
    params.rate = std::fmin(std::fmax(query_float(req, "rate", 0.5f), 0.05f), 1.0f);
    params.ms = (int) std::fmin(std::fmax(query_float(req, "ms", 600.0f), 50.0f), 2000.0f);
    params.follow = query_float(req, "follow", 1.0f) != 0.0f;
    float degLimit = std::strcmp(kind, "turnto") == 0 ? 720.0f : 80.0f;
    params.deg = std::fmin(std::fmax(query_float(req, "deg", 40.0f), -degLimit), degLimit);
    logEvery = (int) std::fmin(std::fmax(query_float(req, "log_ms", 5.0f) / 5.0f, 1.0f), 100.0f);
    if (std::strcmp(kind, "record") == 0) {
        params.ms = (int) std::fmin(std::fmax(query_float(req, "secs", 60.0f), 1.0f), 600.0f) * 1000;
    }
    stopRequested = false;
    tickCounter = 0;

    running = true;
    if (xTaskCreate(experiment_task, "pan_exp", 4096, nullptr, 5, nullptr) != pdPASS) {
        running = false;
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "task create failed");
        return ESP_OK;
    }
    char buf[64];
    snprintf(buf, sizeof(buf), "started %lld", (long long) esp_timer_get_time());
    httpd_resp_set_type(req, "text/plain");
    return httpd_resp_sendstr(req, buf);
}

esp_err_t handle_log(httpd_req_t *req) {
    httpd_resp_set_type(req, "text/csv");
    char q[16];
    bool incremental = query_str(req, "from", q, sizeof(q));
    if (running && !incremental) {
        httpd_resp_set_status(req, "409 Conflict");
        return httpd_resp_sendstr(req, "still running");
    }
    if (samples == nullptr) return httpd_resp_sendstr(req, "# nothing logged yet\n");
    int n = sampleCount;
    int from = incremental ? (int) query_float(req, "from", 0.0f) : 0;
    from = std::max(from, n - MAX_SAMPLES);
    char line[160];
    int len = snprintf(line, sizeof(line),
                       "# control_rad=%.5f,t0_us=%lld,next=%d\nt_us,theta_rad,wvL,wvR,servo_deg,phase,tilt_deg,x_m,y_m\n",
                       controlThetaAtStart, (long long) t0Us, n);
    httpd_resp_send_chunk(req, line, len);
    for (int i = std::max(from, 0); i < n; i++) {
        const Sample &s = samples[i % MAX_SAMPLES];
        len = snprintf(line, sizeof(line), "%lld,%.5f,%.3f,%.3f,%.2f,%d,%.2f,%.3f,%.3f\n", (long long) (t0Us + s.tUs),
                       s.theta, s.wvL / 1000.0f, s.wvR / 1000.0f, s.servoCdeg / 100.0f, s.phase, s.tiltCdeg / 100.0f,
                       s.xMm / 1000.0f, s.yMm / 1000.0f);
        if (httpd_resp_send_chunk(req, line, len) != ESP_OK) return ESP_FAIL;
    }
    return httpd_resp_send_chunk(req, nullptr, 0);
}

esp_err_t handle_servo(httpd_req_t *req) {
    if (!ota_request_authorized(req)) return ESP_OK;
    char v[8];
    if (query_str(req, "release", v, sizeof(v))) {
        servoHeld = false;
        g_panFollowSuspended = false;
    } else {
        servoHeld = true;
        servoHoldUntilUs = esp_timer_get_time() + SERVO_HOLD_MAX_US;
        g_panFollowSuspended = true;
        if (query_str(req, "pan", v, sizeof(v))) ws_broadcast_set_pan_angle(query_float(req, "pan", 0.0f));
        if (query_str(req, "tilt", v, sizeof(v))) ws_broadcast_set_tilt_angle(query_float(req, "tilt", 0.0f));
    }
    char buf[96];
    snprintf(buf, sizeof(buf), "{\"held\":%s,\"pan\":%.2f,\"tilt\":%.2f,\"turnedDeg\":%.3f}", servoHeld ? "true" : "false",
             currentServoAngleDeg, currentTiltAngleDeg, turnedRad * 180.0f / (float) M_PI);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, buf);
}

esp_err_t handle_tune(httpd_req_t *req) {
    if (!ota_request_authorized(req)) return ESP_OK;
    g_panFollowIntervalMs = (int) std::fmin(std::fmax(query_float(req, "interval", (float) g_panFollowIntervalMs), 5.0f), 200.0f);
    g_panLeadMs = std::fmin(std::fmax(query_float(req, "lead", g_panLeadMs), 0.0f), 300.0f);
    char buf[64];
    snprintf(buf, sizeof(buf), "{\"interval\":%d,\"lead\":%.1f}", (int) g_panFollowIntervalMs, (float) g_panLeadMs);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, buf);
}

} // namespace

void debug_pan_register_routes() {
    httpd_handle_t server = web_server_get_handle();
    if (server == nullptr) return;
    const struct {
        const char *uri;
        esp_err_t (*handler)(httpd_req_t *);
    } routes[] = {
        {"/debug/now", handle_now},
        {"/debug/panexp", handle_exp},
        {"/debug/panlog", handle_log},
        {"/debug/pantune", handle_tune},
        {"/debug/servo", handle_servo},
    };
    for (const auto &r : routes) {
        httpd_uri_t u = {.uri = r.uri, .method = HTTP_GET, .handler = r.handler, .user_ctx = nullptr,
                         .is_websocket = false, .handle_ws_control_frames = false, .supported_subprotocol = nullptr};
        httpd_register_uri_handler(server, &u);
    }

    const esp_timer_create_args_t args = {.callback = sample_cb, .arg = nullptr, .dispatch_method = ESP_TIMER_TASK,
                                          .name = "pan_log", .skip_unhandled_events = true};
    if (esp_timer_create(&args, &sampleTimer) == ESP_OK) {
        esp_timer_start_periodic(sampleTimer, SAMPLE_PERIOD_US);
    }
}
