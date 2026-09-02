#include "ping_diag.hpp"
#include "uart_link.hpp"
#include "wifi_connect.hpp"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "ping/ping_sock.h"
#include "esp_log.h"

#include <cstring>

namespace {

const char *TAG = "ping_diag";

constexpr TickType_t POLL_PERIOD = pdMS_TO_TICKS(1000);

esp_ping_handle_t s_pingHandle = nullptr;
char s_pingedIp[16] = "";

// Written from the internal lwip ping task's callbacks, read from the HTTP
// handler that serves /params -- plain volatiles rather than a mutex,
// matching this codebase's existing pattern for small cross-task stats
// (wifi_connect.cpp's g_connected, uart_link.cpp's s_lastSeenTick).
volatile bool s_active = false;
volatile uint32_t s_sent = 0;
volatile uint32_t s_received = 0;
volatile uint32_t s_lastRttMs = 0;
volatile uint32_t s_avgRttMs = 0;

void on_ping_success(esp_ping_handle_t hdl, void *args) {
    (void) args;
    uint32_t elapsedMs = 0;
    esp_ping_get_profile(hdl, ESP_PING_PROF_TIMEGAP, &elapsedMs, sizeof(elapsedMs));
    s_sent = s_sent + 1;
    s_received = s_received + 1;
    s_lastRttMs = elapsedMs;
    // 1/8-weighted EMA -- cheap, no history buffer, still tracks a trend
    // over the last several seconds of one-per-second probes.
    s_avgRttMs = (s_avgRttMs == 0) ? elapsedMs : (s_avgRttMs * 7 + elapsedMs) / 8;
}

void on_ping_timeout(esp_ping_handle_t hdl, void *args) {
    (void) hdl;
    (void) args;
    s_sent = s_sent + 1;
    s_lastRttMs = 0;
}

void stop_session() {
    if (s_pingHandle != nullptr) {
        esp_ping_stop(s_pingHandle);
        esp_ping_delete_session(s_pingHandle);
        s_pingHandle = nullptr;
    }
    s_active = false;
}

void start_session(const char *ip) {
    stop_session();

    ip_addr_t target = {};
    if (!ipaddr_aton(ip, &target)) {
        ESP_LOGW(TAG, "Bad cam IP for ping: %s", ip);
        return;
    }

    esp_ping_config_t cfg = ESP_PING_DEFAULT_CONFIG();
    cfg.target_addr = target;
    cfg.count = ESP_PING_COUNT_INFINITE;
    cfg.interval_ms = 1000;
    cfg.timeout_ms = 1000;

    esp_ping_callbacks_t cbs = {};
    cbs.on_ping_success = on_ping_success;
    cbs.on_ping_timeout = on_ping_timeout;

    if (esp_ping_new_session(&cfg, &cbs, &s_pingHandle) != ESP_OK) {
        ESP_LOGW(TAG, "esp_ping_new_session failed for %s", ip);
        s_pingHandle = nullptr;
        return;
    }
    esp_ping_start(s_pingHandle);

    std::strncpy(s_pingedIp, ip, sizeof(s_pingedIp) - 1);
    s_pingedIp[sizeof(s_pingedIp) - 1] = '\0';
    s_sent = 0;
    s_received = 0;
    s_lastRttMs = 0;
    s_avgRttMs = 0;
    s_active = true;
    ESP_LOGI(TAG, "Pinging cam at %s", ip);
}

void ping_diag_task(void *arg) {
    (void) arg;
    while (true) {
        bool camKnown = !uart_link_peer_is_stale();
        const char *camIp = uart_link_get_peer_ip();
        // wifi_is_connected() matters here: uart_link can hear the cam's
        // STAT line (it arrives independently over UART) before THIS
        // board's own WiFi association finishes -- starting a ping session
        // before the local netif has an IP made esp_ping's socket send fail
        // outright, which it counts as ordinary loss. That's a one-time
        // startup race, not a real signal, so it's worth avoiding rather
        // than just tolerating the noise.
        bool camHasIp = camKnown && wifi_is_connected() && std::strcmp(camIp, "0.0.0.0") != 0;

        if (camHasIp) {
            if (std::strcmp(camIp, s_pingedIp) != 0) {
                // Cam's IP just became known, or changed (reboot -> new
                // DHCP lease) -- (re)target the session.
                start_session(camIp);
            }
        } else if (s_pingHandle != nullptr) {
            // Lost the cam (stale, or rebooted with no IP yet) -- stop
            // rather than keep pinging a now-meaningless target and
            // reporting loss for the wrong reason.
            stop_session();
            s_pingedIp[0] = '\0';
        }

        vTaskDelay(POLL_PERIOD);
    }
}

} // namespace

void ping_diag_start() {
    xTaskCreate(ping_diag_task, "ping_diag", 3072, nullptr, tskIDLE_PRIORITY + 1, nullptr);
}

PingStats ping_diag_get_stats() {
    PingStats stats;
    stats.active = s_active;
    stats.sent = s_sent;
    stats.received = s_received;
    stats.lastRttMs = s_lastRttMs;
    stats.avgRttMs = s_avgRttMs;
    return stats;
}
