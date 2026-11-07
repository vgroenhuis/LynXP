#include "servo_table.hpp"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "esp_log.h"
#include "nvs.h"

ServoTable g_panTable = {};
ServoTable g_tiltTable = {};
float g_panBacklashDeg = 0.0f;
float g_tiltBacklashDeg = 0.0f;
float g_panKickDeg = 0.0f;
float g_tiltKickDeg = 0.0f;

namespace {

const char *TAG = "servo_table";
constexpr const char *NVS_NAMESPACE = "robot";
constexpr const char *KEY_PAN = "panTable";
constexpr const char *KEY_TILT = "tiltTable";
constexpr const char *KEY_BACKLASH = "backlash";
constexpr float TURN_DEADBAND_DEG = 0.05f; // smaller steps don't count as turning (noise, re-sends)
constexpr unsigned long KICK_MS = 20;       // one PWM frame (the poll task ends it: servo_kick_ended())
constexpr unsigned long KICK_REST_MS = 100; // a command that stood still this long gets a kick when it moves

// The old table (every 15 degrees) spread over every 5, by straight lines between its points.
void expand_old(const float *old, ServoTable *t) {
    for (int i = 0; i < SERVO_TABLE_N; i++) {
        float x = i * SERVO_TABLE_STEP_DEG / 15.0f;
        int j = std::min((int) x, SERVO_TABLE_N_OLD - 2);
        float f = x - j;
        t->pulseUs[i] = old[j] + f * (old[j + 1] - old[j]);
    }
}

struct OldServoTable {
    bool valid;
    float pulseUs[SERVO_TABLE_N_OLD];
};

void load_one(nvs_handle_t h, const char *key, ServoTable *t) {
    ServoTable loaded = {};
    size_t len = sizeof(loaded);
    if (nvs_get_blob(h, key, &loaded, &len) == ESP_OK && len == sizeof(loaded)) {
        *t = loaded;
        return;
    }
    OldServoTable old = {};
    len = sizeof(old);
    if (nvs_get_blob(h, key, &old, &len) == ESP_OK && len == sizeof(old) && old.valid) {
        expand_old(old.pulseUs, t);
        t->valid = true;
    }
}

} // namespace

void servo_tables_load() {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) != ESP_OK) return;
    load_one(h, KEY_PAN, &g_panTable);
    load_one(h, KEY_TILT, &g_tiltTable);
    // pan / tilt backlash, then (since 1.5.19) pan / tilt kick
    float b[4] = {};
    size_t len = sizeof(b);
    if (nvs_get_blob(h, KEY_BACKLASH, b, &len) == ESP_OK && (len == 2 * sizeof(float) || len == sizeof(b)) &&
        std::isfinite(b[0]) && std::isfinite(b[1]) && std::isfinite(b[2]) && std::isfinite(b[3])) {
        g_panBacklashDeg = b[0];
        g_tiltBacklashDeg = b[1];
        if (len == sizeof(b)) {
            g_panKickDeg = b[2];
            g_tiltKickDeg = b[3];
        }
    }
    nvs_close(h);
    ESP_LOGI(TAG, "backlash: pan %.2f, tilt %.2f deg; kick: pan %.2f, tilt %.2f deg", g_panBacklashDeg, g_tiltBacklashDeg,
             g_panKickDeg, g_tiltKickDeg);
    ESP_LOGI(TAG, "pan table %s, tilt table %s", g_panTable.valid ? "in use" : "none", g_tiltTable.valid ? "in use" : "none");
}

bool servo_tables_save() {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return false;
    bool ok = nvs_set_blob(h, KEY_PAN, &g_panTable, sizeof(g_panTable)) == ESP_OK &&
              nvs_set_blob(h, KEY_TILT, &g_tiltTable, sizeof(g_tiltTable)) == ESP_OK;
    float b[4] = {g_panBacklashDeg, g_tiltBacklashDeg, g_panKickDeg, g_tiltKickDeg};
    ok = ok && nvs_set_blob(h, KEY_BACKLASH, b, sizeof(b)) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    return ok;
}

bool servo_table_parse(const char *csv, ServoTable *out) {
    if (std::strcmp(csv, "none") == 0) {
        *out = {};
        return true;
    }
    ServoTable t = {};
    float v[SERVO_TABLE_N];
    int n = 0;
    const char *p = csv;
    while (n < SERVO_TABLE_N) {
        char *end = nullptr;
        float x = std::strtof(p, &end);
        if (end == p || !std::isfinite(x) || x < 300.0f || x > 2800.0f) return false;
        v[n++] = x;
        p = end;
        if (*p != ',') break;
        p++;
    }
    if (*p != '\0') return false;
    if (n == SERVO_TABLE_N) {
        for (int i = 0; i < n; i++) t.pulseUs[i] = v[i];
    } else if (n == SERVO_TABLE_N_OLD) {
        expand_old(v, &t);
    } else {
        return false;
    }
    // one way throughout (a servo turns one way as the pulse grows)
    float dir = t.pulseUs[SERVO_TABLE_N - 1] - t.pulseUs[0];
    for (int i = 1; i < SERVO_TABLE_N; i++) {
        if ((t.pulseUs[i] - t.pulseUs[i - 1]) * dir <= 0.0f) return false;
    }
    t.valid = true;
    *out = t;
    return true;
}

float servo_table_pulse(const ServoTable &t, float angleDeg) {
    float x = (std::clamp(angleDeg, -90.0f, 90.0f) + 90.0f) / SERVO_TABLE_STEP_DEG;
    int i = std::clamp((int) std::floor(x), 0, SERVO_TABLE_N - 2);
    float f = x - i;
    return t.pulseUs[i] + f * (t.pulseUs[i + 1] - t.pulseUs[i]);
}

void servo_table_json(const ServoTable &t, char *out, size_t outLen) {
    if (!t.valid) {
        std::snprintf(out, outLen, "null");
        return;
    }
    size_t n = std::snprintf(out, outLen, "[");
    for (int i = 0; i < SERVO_TABLE_N && n < outLen; i++) {
        n += std::snprintf(out + n, outLen - n, "%s%.1f", i ? "," : "", t.pulseUs[i]);
    }
    if (n < outLen) std::snprintf(out + n, outLen - n, "]");
}

float servo_backlash_adjust(BacklashState *s, float angleDeg, float backlashDeg, float kickDeg, unsigned long nowMs) {
    if (!s->started) {
        *s = {};
        s->started = true;
        s->last = s->cmd = s->out = angleDeg;
        s->movedMs = nowMs;
        return angleDeg;
    }
    float prevCmd = s->cmd;
    if (backlashDeg >= 0.0f) {
        // the play band (servo_table.hpp): the command trails the target by
        // half its width, and holds still while the target turns back inside it
        float half = backlashDeg / 2.0f;
        if (angleDeg > s->cmd + half) {
            s->cmd = angleDeg - half;
        } else if (angleDeg < s->cmd - half) {
            s->cmd = angleDeg + half;
        }
        if (s->cmd != prevCmd) s->out = angleDeg; // (moving: the overshoot makes up the trail)
    } else {
        if (angleDeg > s->last + TURN_DEADBAND_DEG) {
            s->dir = 1;
        } else if (angleDeg < s->last - TURN_DEADBAND_DEG) {
            s->dir = -1;
        }
        s->cmd = angleDeg - s->dir * backlashDeg / 2.0f;
        s->out = angleDeg;
    }
    if (std::fabs(angleDeg - s->last) > TURN_DEADBAND_DEG || backlashDeg >= 0.0f) s->last = angleDeg;
    float moved = s->cmd - prevCmd;
    if (moved != 0.0f) {
        int dir = moved > 0.0f ? 1 : -1;
        // a start after standing still, or a turn the other way: a kick
        if (kickDeg > 0.0f && (nowMs - s->movedMs > KICK_REST_MS || dir != s->cmdDir)) {
            s->kickUntilMs = nowMs + KICK_MS;
            s->kickDir = dir;
        }
        s->cmdDir = dir;
        s->movedMs = nowMs;
    }
    if (s->kickDir != 0 && (long) (s->kickUntilMs - nowMs) > 0) return s->cmd + s->kickDir * kickDeg;
    return s->cmd;
}

bool servo_kick_ended(BacklashState *s, unsigned long nowMs) {
    if (s->kickDir == 0 || (long) (s->kickUntilMs - nowMs) > 0) return false;
    s->kickDir = 0;
    return true;
}
