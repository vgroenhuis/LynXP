#include "closer_report.hpp"

#include "wifi_connect.hpp"
#include "ws_broadcast.hpp"
#include "ina260.hpp"

#include <cstdio>
#include <cstring>

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"

static const char *TAG = "closer";

namespace {

constexpr const char *REPORT_URL = "https://closer.ram.eemcs.utwente.nl/labdemos/api/heartbeat";
constexpr int INTERVAL_S = 60;
// After a failed report (no network route yet, server restarting): try again
// sooner than a full interval, so the page notices a fresh boot quickly.
constexpr int RETRY_S = 15;
constexpr const char *NVS_NAMESPACE = "closer";
constexpr const char *NVS_KEY = "key";

char deviceKey[96];     // "<demo id>.<secret>"
char demoId[48];
char lastResult[64];
bool bootSent = false;  // "boot" (with the reset reason) goes once per power-up, then "beat"

// Why the chip last started -- same names as the other lab demos report, so
// the page's "Restarts (24 h)" and reset column read alike for all of them.
const char *reset_reason() {
    switch (esp_reset_reason()) {
        case ESP_RST_POWERON: return "power_on";
        case ESP_RST_EXT: return "reset_pin";
        case ESP_RST_SW: return "software";
        case ESP_RST_PANIC: return "crash";
        case ESP_RST_INT_WDT: return "interrupt_watchdog";
        case ESP_RST_TASK_WDT: return "task_watchdog";
        case ESP_RST_WDT: return "watchdog";
        case ESP_RST_DEEPSLEEP: return "deep_sleep";
        case ESP_RST_BROWNOUT: return "brownout";
        case ESP_RST_USB: return "usb";
        case ESP_RST_JTAG: return "jtag";
        case ESP_RST_PWR_GLITCH: return "power_glitch";
        case ESP_RST_CPU_LOCKUP: return "cpu_lockup";
        default: return "unknown";
    }
}

void load_key() {
    deviceKey[0] = '\0';
    demoId[0] = '\0';
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        size_t n = sizeof(deviceKey);
        if (nvs_get_str(h, NVS_KEY, deviceKey, &n) != ESP_OK) deviceKey[0] = '\0';
        nvs_close(h);
    }
    const char *dot = std::strchr(deviceKey, '.');
    if (dot) {
        size_t n = (size_t) (dot - deviceKey);
        if (n >= sizeof(demoId)) n = sizeof(demoId) - 1;
        std::memcpy(demoId, deviceKey, n);
        demoId[n] = '\0';
    }
}

char *build_report(const char *event) {
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "event", event);
    if (std::strcmp(event, "boot") == 0) cJSON_AddStringToObject(j, "reset", reset_reason());

    WifiStatus ws;
    wifi_get_status(&ws);
    cJSON_AddStringToObject(j, "ip", ws.ip);
    cJSON_AddStringToObject(j, "hostname", "lynxp");
    cJSON_AddStringToObject(j, "fw", esp_app_get_description()->version);
    cJSON_AddNumberToObject(j, "uptime_s", (double) (esp_timer_get_time() / 1000000));
    if (ws.connected) {
        char b[18];
        snprintf(b, sizeof(b), "%02x:%02x:%02x:%02x:%02x:%02x",
                 ws.bssid[0], ws.bssid[1], ws.bssid[2], ws.bssid[3], ws.bssid[4], ws.bssid[5]);
        cJSON_AddNumberToObject(j, "rssi", ws.rssi);
        cJSON_AddStringToObject(j, "ssid", ws.ssid);
        cJSON_AddStringToObject(j, "bssid", b);
        cJSON_AddNumberToObject(j, "channel", ws.channel);
    }
    // Internal RAM only: PSRAM's 8 MB would hide the number that matters.
    cJSON_AddNumberToObject(j, "heap_free", heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    cJSON_AddNumberToObject(j, "interval", INTERVAL_S);
    cJSON_AddNumberToObject(j, "clients", ws_broadcast_client_count());

    // Not "battery_v": that is a Li-ion cell voltage on the page (charge
    // estimate); this is the USB-PD bus behind the powerbank.
    cJSON *stats = cJSON_AddObjectToObject(j, "stats");
    float v, ma, mw;
    if (ina260_is_available() && ina260_read(&v, &ma, &mw)) {
        cJSON_AddNumberToObject(stats, "supply_v", v);
        cJSON_AddNumberToObject(stats, "current_ma", ma);
        cJSON_AddNumberToObject(stats, "power_w", mw / 1000.0f);
    }
    if (ws.apActive) cJSON_AddNumberToObject(stats, "hotspot_clients", ws.apClients);

    char *out = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    return out;
}

// True if the server took the report.
bool send_report() {
    const char *event = bootSent ? "beat" : "boot";
    char *body = build_report(event);
    if (!body) return false;
    esp_http_client_config_t cfg = {};
    cfg.url = REPORT_URL;
    cfg.method = HTTP_METHOD_POST;
    cfg.crt_bundle_attach = esp_crt_bundle_attach;
    cfg.timeout_ms = 10000;
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    bool ok = false;
    if (c) {
        char auth[sizeof(deviceKey) + 8];
        snprintf(auth, sizeof(auth), "Bearer %s", deviceKey);
        esp_http_client_set_header(c, "Authorization", auth);
        esp_http_client_set_header(c, "Content-Type", "application/json");
        esp_http_client_set_post_field(c, body, (int) std::strlen(body));
        esp_err_t err = esp_http_client_perform(c);
        int status = esp_http_client_get_status_code(c);
        if (err != ESP_OK) {
            snprintf(lastResult, sizeof(lastResult), "%s: %s", event, esp_err_to_name(err));
        } else {
            snprintf(lastResult, sizeof(lastResult), "%s: HTTP %d", event, status);
            ok = (status == 200);
        }
        if (status == 401) ESP_LOGW(TAG, "the server doesn't know this device key (closer key <key>)");
        esp_http_client_cleanup(c);
    }
    cJSON_free(body);
    ESP_LOGI(TAG, "report %s", lastResult);
    if (ok) bootSent = true;
    return ok;
}

void report_task(void *) {
    for (;;) {
        int waitS = INTERVAL_S;
        if (deviceKey[0] && wifi_is_connected()) {
            if (!send_report()) waitS = RETRY_S;
        } else if (deviceKey[0]) {
            waitS = 5; // waiting for Wi-Fi: report as soon as it's up
        }
        vTaskDelay(pdMS_TO_TICKS(waitS * 1000));
    }
}

} // namespace

void closer_report_start() {
    load_key();
    if (!demoId[0]) ESP_LOGI(TAG, "no lab demos key stored -- not reporting (closer key <key>)");
    // 8 KB: the TLS handshake (mbedTLS + certificate bundle) is stack-hungry.
    // Priority 1, below everything that matters.
    xTaskCreate(report_task, "closer_report", 8192, nullptr, 1, nullptr);
}

bool closer_report_set_key(const char *key) {
    if (std::strlen(key) >= sizeof(deviceKey)) return false;
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t err = key[0] ? nvs_set_str(h, NVS_KEY, key) : nvs_erase_key(h, NVS_KEY);
    if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) return false;
    load_key();
    bootSent = false; // a new identity starts with a boot report
    return true;
}

const char *closer_report_demo_id() { return demoId; }
const char *closer_report_last_result() { return lastResult; }
