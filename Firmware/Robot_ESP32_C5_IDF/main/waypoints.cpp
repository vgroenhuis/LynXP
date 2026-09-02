#include "waypoints.hpp"

#include "nvs.h"
#include "esp_log.h"

#include <cstdio>

// Ported from Robot_Pico2W_SDK/src/waypoints.cpp. Same NVS namespace as
// settings.cpp ("robot"), separate key ("waypoints") so a settings load/save
// never touches this blob and vice versa.

namespace {

constexpr const char *NVS_NAMESPACE = "robot";
constexpr const char *NVS_KEY = "waypoints";

const char *TAG = "waypoints";

} // namespace

void loadWaypointsJson(char *buf, size_t bufSize) {
    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READONLY, &handle);
    if (err != ESP_OK) {
        // No file yet -- same as a browser's first-ever localStorage read.
        snprintf(buf, bufSize, "[]");
        return;
    }

    size_t len = bufSize - 1;
    err = nvs_get_blob(handle, NVS_KEY, buf, &len);
    nvs_close(handle);

    if (err != ESP_OK) {
        snprintf(buf, bufSize, "[]");
        return;
    }
    buf[len] = '\0';
}

bool saveWaypointsJson(const char *json, size_t len) {
    if (len >= WAYPOINTS_JSON_MAX_LEN) {
        ESP_LOGW(TAG, "rejected save, %u bytes exceeds cap of %u", (unsigned) len,
                 (unsigned) WAYPOINTS_JSON_MAX_LEN);
        return false;
    }

    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open (RW) failed: %s", esp_err_to_name(err));
        return false;
    }

    err = nvs_set_blob(handle, NVS_KEY, json, len);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "waypoints save failed: %s", esp_err_to_name(err));
        return false;
    }
    ESP_LOGI(TAG, "Waypoints saved (%u bytes).", (unsigned) len);
    return true;
}
