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

namespace {

const char *TAG = "servo_table";
constexpr const char *NVS_NAMESPACE = "robot";
constexpr const char *KEY_PAN = "panTable";
constexpr const char *KEY_TILT = "tiltTable";

void load_one(nvs_handle_t h, const char *key, ServoTable *t) {
    ServoTable loaded = {};
    size_t len = sizeof(loaded);
    if (nvs_get_blob(h, key, &loaded, &len) == ESP_OK && len == sizeof(loaded)) *t = loaded;
}

} // namespace

void servo_tables_load() {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) != ESP_OK) return;
    load_one(h, KEY_PAN, &g_panTable);
    load_one(h, KEY_TILT, &g_tiltTable);
    nvs_close(h);
    ESP_LOGI(TAG, "pan table %s, tilt table %s", g_panTable.valid ? "in use" : "none", g_tiltTable.valid ? "in use" : "none");
}

bool servo_tables_save() {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return false;
    bool ok = nvs_set_blob(h, KEY_PAN, &g_panTable, sizeof(g_panTable)) == ESP_OK &&
              nvs_set_blob(h, KEY_TILT, &g_tiltTable, sizeof(g_tiltTable)) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    return ok;
}

bool servo_table_parse(const char *csv, ServoTable *out) {
    if (std::strcmp(csv, "none") == 0) {
        *out = {};
        return true;
    }
    ServoTable t = {};
    const char *p = csv;
    for (int i = 0; i < SERVO_TABLE_N; i++) {
        char *end = nullptr;
        float v = std::strtof(p, &end);
        if (end == p || !std::isfinite(v) || v < 300.0f || v > 2800.0f) return false;
        t.pulseUs[i] = v;
        p = end;
        if (i < SERVO_TABLE_N - 1) {
            if (*p != ',') return false;
            p++;
        }
    }
    if (*p != '\0') return false;
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
