#include "app_data.hpp"

#include "nvs.h"
#include "esp_log.h"

#include <cstdio>
#include <cstring>

namespace {

const char *TAG = "app_data";
constexpr const char *NVS_NAMESPACE = "appdata";
// camcal: per-resolution camera calibration (field of view etc.), written by
// the calibration tooling and read by the camera page's overlays.
constexpr const char *VALID_NAMES[] = {"settings", "scores", "camcal"};

} // namespace

bool app_data_is_valid_name(const char *name) {
    for (const char *valid : VALID_NAMES) {
        if (std::strcmp(name, valid) == 0) return true;
    }
    return false;
}

void app_data_load(const char *name, char *buf, size_t bufSize) {
    nvs_handle_t h;
    size_t len = bufSize - 1;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) != ESP_OK) {
        std::snprintf(buf, bufSize, "{}");
        return;
    }
    esp_err_t err = nvs_get_blob(h, name, buf, &len);
    nvs_close(h);
    if (err != ESP_OK) {
        std::snprintf(buf, bufSize, "{}");
        return;
    }
    buf[len] = '\0';
}

bool app_data_save(const char *name, const char *json, size_t len) {
    if (!app_data_is_valid_name(name) || len >= APP_DATA_JSON_MAX_LEN) return false;
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t err = nvs_set_blob(h, name, json, len);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "saving %s failed: %s", name, esp_err_to_name(err));
        return false;
    }
    return true;
}
