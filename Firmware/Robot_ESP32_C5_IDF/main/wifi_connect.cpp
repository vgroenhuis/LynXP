#include "wifi_connect.hpp"
#include "settings.hpp"
#include "wifi_creds.h"

#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_mac.h"
#include "mdns.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"

#include <cstring>
#include <cstdio>

// ESP-IDF replacement for Robot_Pico2W_SDK/src/wifi_connect.cpp. Mongoose's
// own TCP/IP stack + CYW43 driver has no ESP32 equivalent -- this is
// standard esp_wifi/esp_event STA setup instead, keeping the same policy
// (prefer settings.altSsid, else scan the compiled-in fallback list from
// wifi_creds.h -- same multi-network scheme as ESP32_S3_CAM_IDF -- and join
// whichever configured network is actually in range; retry forever on
// disconnect) and adding mDNS, which the Pico build never had (it only set
// a DHCP hostname).

namespace {

const char *TAG = "wifi";

constexpr char HOSTNAME[] = "lynxp";

struct WifiNetwork { const char *ssid; const char *pass; };

// Tried in priority order; only the first one actually in range at scan
// time is attempted. Leave a slot's ssid "" (see wifi_creds.h) to skip it.
constexpr WifiNetwork FALLBACK_NETWORKS[] = {
    {WIFI_SSID_1, WIFI_PASS_1},
    {WIFI_SSID_2, WIFI_PASS_2},
};
constexpr size_t FALLBACK_NETWORK_COUNT = sizeof(FALLBACK_NETWORKS) / sizeof(FALLBACK_NETWORKS[0]);

constexpr EventBits_t WIFI_CONNECTED_BIT = BIT0;
constexpr EventBits_t WIFI_FAILED_BIT = BIT1;
constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000;

volatile bool g_connected = false;
// Once true (settings.altSsid was set at boot, or via wifi_reconnect_with()),
// the fallback scan task below idles forever -- an explicit user choice is
// never second-guessed by re-scanning the compiled-in list.
volatile bool g_alt_override_active = false;
char g_mac_str[18] = "";
char g_ip_str[16] = "0.0.0.0";
EventGroupHandle_t g_wifi_event_group = nullptr;

void apply_config(const char *ssid, const char *password) {
    wifi_config_t cfg = {};
    std::strncpy((char *) cfg.sta.ssid, ssid, sizeof(cfg.sta.ssid) - 1);
    std::strncpy((char *) cfg.sta.password, password, sizeof(cfg.sta.password) - 1);
    cfg.sta.threshold.authmode = WIFI_AUTH_WPA2_PSK;
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &cfg));
}

void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void) arg;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_START) {
        if (g_alt_override_active) {
            esp_wifi_connect();
        }
        // else: fallback_scan_task picks a network and connects itself.
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        g_connected = false;
        auto *event = (wifi_event_sta_disconnected_t *) data;
        ESP_LOGW(TAG, "disconnected (reason=%d)", event->reason);
        if (g_alt_override_active) {
            // Retries indefinitely against the same user-chosen network,
            // matching wifi_state_callback()'s handling of
            // MG_TCPIP_EV_WIFI_CONNECT_ERR on the Pico build -- a
            // temporarily out-of-range or misconfigured network doesn't
            // give up.
            esp_wifi_connect();
        } else if (g_wifi_event_group) {
            // Wake fallback_scan_task so it rescans instead of blindly
            // retrying a network that may no longer be the best choice.
            xEventGroupSetBits(g_wifi_event_group, WIFI_FAILED_BIT);
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        auto *event = (ip_event_got_ip_t *) data;
        std::snprintf(g_ip_str, sizeof(g_ip_str), IPSTR, IP2STR(&event->ip_info.ip));
        ESP_LOGI(TAG, "connected, ip=%s", g_ip_str);
        g_connected = true;
        if (g_wifi_event_group) xEventGroupSetBits(g_wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

// Scans (short dwell, one pass) to see which of the compiled-in fallback
// networks is actually in range, then attempts only the highest-priority
// one present -- same policy as ESP32_S3_CAM_IDF's connect_to_wifi(), just
// running as its own low-priority task instead of blocking app_main(),
// since the C5's control loop must stay usable even with no Wi-Fi at all.
void fallback_scan_task(void *) {
    wifi_scan_config_t scan_cfg = {};
    scan_cfg.show_hidden = false;
    scan_cfg.scan_type = WIFI_SCAN_TYPE_ACTIVE;
    scan_cfg.scan_time.active.min = 60;
    scan_cfg.scan_time.active.max = 120;

    while (true) {
        if (g_alt_override_active) {
            // A user override arrived after this task started -- stop
            // contending for the radio and let wifi_reconnect_with() own it.
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }

        ESP_LOGI(TAG, "Scanning for fallback WiFi networks...");
        esp_wifi_scan_start(&scan_cfg, true); // blocking, quick (short dwell above)

        uint16_t ap_count = 0;
        esp_wifi_scan_get_ap_num(&ap_count);
        if (ap_count > 20) ap_count = 20;
        wifi_ap_record_t ap_records[20];
        uint16_t ap_records_len = ap_count;
        esp_wifi_scan_get_ap_records(&ap_records_len, ap_records);

        int chosen = -1;
        for (int i = 0; i < (int) FALLBACK_NETWORK_COUNT && chosen == -1; i++) {
            if (FALLBACK_NETWORKS[i].ssid[0] == '\0') continue;
            for (int j = 0; j < ap_records_len; j++) {
                if (std::strcmp((const char *) ap_records[j].ssid, FALLBACK_NETWORKS[i].ssid) == 0) {
                    chosen = i;
                    break;
                }
            }
        }

        if (chosen == -1) {
            ESP_LOGI(TAG, "No configured fallback network in range - rescanning");
            vTaskDelay(pdMS_TO_TICKS(2000));
            continue;
        }

        ESP_LOGI(TAG, "Connecting to WiFi: %s", FALLBACK_NETWORKS[chosen].ssid);
        xEventGroupClearBits(g_wifi_event_group, WIFI_CONNECTED_BIT | WIFI_FAILED_BIT);
        apply_config(FALLBACK_NETWORKS[chosen].ssid, FALLBACK_NETWORKS[chosen].pass);
        esp_wifi_connect();

        EventBits_t bits = xEventGroupWaitBits(
            g_wifi_event_group, WIFI_CONNECTED_BIT | WIFI_FAILED_BIT,
            pdFALSE, pdFALSE, pdMS_TO_TICKS(WIFI_CONNECT_TIMEOUT_MS));

        if (bits & WIFI_CONNECTED_BIT) {
            // Stay parked here until a disconnect sets WIFI_FAILED_BIT again.
            xEventGroupWaitBits(g_wifi_event_group, WIFI_FAILED_BIT, pdFALSE, pdFALSE, portMAX_DELAY);
            continue;
        }

        ESP_LOGW(TAG, "Connect failed/timed out - rescanning");
        esp_wifi_disconnect();
    }
}

} // namespace

void wifi_connect_start() {
    // Read before esp_wifi_start(): the STA MAC lives in efuse and is fixed
    // regardless of connection state, so callers (the OLED task) can show it
    // immediately, well before any IP exists.
    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    std::snprintf(g_mac_str, sizeof(g_mac_str), "%02X:%02X:%02X:%02X:%02X:%02X",
                  mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    ESP_LOGI(TAG, "MAC address: %s", g_mac_str);

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    esp_netif_t *staNetif = esp_netif_create_default_wifi_sta();
    esp_netif_set_hostname(staNetif, HOSTNAME);

    g_wifi_event_group = xEventGroupCreate();

    wifi_init_config_t initCfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&initCfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, nullptr));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, nullptr));

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    if (settings.altSsid[0] != '\0') {
        g_alt_override_active = true;
        apply_config(settings.altSsid, settings.altPassword);
    }
    ESP_ERROR_CHECK(esp_wifi_start());
    // esp_wifi_start() triggers WIFI_EVENT_STA_START asynchronously -- this
    // function does NOT block waiting for an IP (unlike the
    // Test_ESP32_S3_Feather_ESP_IDF spike's xEventGroupWaitBits(portMAX_DELAY)),
    // so the console/motors/control loop stay usable even with no Wi-Fi at
    // all.

    if (!g_alt_override_active) {
        // Needs esp_wifi_start() to have already run (esp_wifi_scan_start()
        // requires the driver started) -- hence created only now, not
        // alongside the event handlers above.
        xTaskCreate(fallback_scan_task, "wifi_fallback", 3072, nullptr, tskIDLE_PRIORITY + 1, nullptr);
    }

    ESP_ERROR_CHECK(mdns_init());
    ESP_ERROR_CHECK(mdns_hostname_set(HOSTNAME));
    mdns_instance_name_set("LynXP");
    ESP_LOGI(TAG, "mDNS hostname set: %s.local", HOSTNAME);
}

void wifi_reconnect_with(const char *ssid, const char *password) {
    g_alt_override_active = true; // stop fallback_scan_task from contending for this choice
    apply_config(ssid, password);
    esp_wifi_disconnect();
    esp_wifi_connect();
}

bool wifi_is_connected() {
    return g_connected;
}

const char *wifi_connect_get_mac() {
    return g_mac_str;
}

const char *wifi_connect_get_ip() {
    return g_ip_str;
}
