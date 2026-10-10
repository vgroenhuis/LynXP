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

namespace {

const char *TAG = "servo_table";
constexpr const char *NVS_NAMESPACE = "robot";
constexpr const char *KEY_PAN = "panTable";
constexpr const char *KEY_TILT = "tiltTable";
constexpr const char *KEY_BACKLASH = "backlash";
constexpr float TURN_DEADBAND_DEG = 0.05f; // smaller steps don't count as turning (noise, re-sends)

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
    float b[2] = {};
    size_t len = sizeof(b);
    if (nvs_get_blob(h, KEY_BACKLASH, b, &len) == ESP_OK && len == sizeof(b) && std::isfinite(b[0]) && std::isfinite(b[1])) {
        g_panBacklashDeg = b[0];
        g_tiltBacklashDeg = b[1];
    }
    nvs_close(h);
    ESP_LOGI(TAG, "backlash: pan %.2f, tilt %.2f deg", g_panBacklashDeg, g_tiltBacklashDeg);
    ESP_LOGI(TAG, "pan table %s, tilt table %s", g_panTable.valid ? "in use" : "none", g_tiltTable.valid ? "in use" : "none");
}

bool servo_tables_save() {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return false;
    bool ok = nvs_set_blob(h, KEY_PAN, &g_panTable, sizeof(g_panTable)) == ESP_OK &&
              nvs_set_blob(h, KEY_TILT, &g_tiltTable, sizeof(g_tiltTable)) == ESP_OK;
    float b[2] = {g_panBacklashDeg, g_tiltBacklashDeg};
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

float servo_backlash_adjust(BacklashState *s, float angleDeg, float backlashDeg) {
    if (!s->started) {
        s->started = true;
        s->last = angleDeg;
        s->dir = 0;
    } else if (angleDeg > s->last + TURN_DEADBAND_DEG) {
        s->dir = 1;
        s->last = angleDeg;
    } else if (angleDeg < s->last - TURN_DEADBAND_DEG) {
        s->dir = -1;
        s->last = angleDeg;
    }
    return angleDeg - s->dir * backlashDeg / 2.0f;
}
