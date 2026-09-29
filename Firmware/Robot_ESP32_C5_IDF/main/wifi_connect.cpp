#include "wifi_connect.hpp"
#include "wifi_networks.hpp"
#include "captive_dns.hpp"

#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_mac.h"
#include "esp_random.h"
#include "esp_timer.h"
#include "mdns.h"
#include "nvs.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"

#include <algorithm>
#include <cctype>
#include <cstdio>
#include <cstring>

// Connection policy, all driven from one manager task (so scans, connect
// attempts and hotspot mode switches never race each other for the radio):
//
//   not connected -> scan, pick the best saved network in range (one with a
//     2.4 GHz access point first, so the S3 camera can follow; then strongest
//     signal), try it; repeat every few seconds. If there are no saved
//     networks at all, or none has been joinable for AP_START_DELAY_US, open
//     the setup hotspot (APSTA mode -- the robot keeps trying its saved
//     networks in the background while the hotspot is up).
//   connected -> idle until a disconnect or a request from the web UI. Once
//     it's been connected for a bit and no phone is left on the hotspot,
//     shut the hotspot off again.

namespace {

const char *TAG = "wifi";

constexpr char HOSTNAME[] = "lynxp";
constexpr char AP_SSID_PREFIX[] = "LynXP-";
// RFC 8910 captive-portal URI handed out via DHCP (option 114), so recent
// Android/iOS pop the setup page straight away instead of relying only on
// their HTTP connectivity probes being redirected. esp_netif keeps the
// pointer, hence static storage.
constexpr char CAPTIVE_PORTAL_URI[] = "http://192.168.4.1/wifi";

constexpr uint32_t CONNECT_TIMEOUT_MS = 15000;
constexpr int64_t AP_START_DELAY_US = 20LL * 1000 * 1000;
constexpr int64_t AP_STOP_DELAY_US = 10LL * 1000 * 1000;
constexpr uint32_t RETRY_INTERVAL_MS = 3000;
// A scan hops the radio across every 2.4 + 5 GHz channel (~8 s on the C5),
// during which the hotspot is effectively off the air -- a phone trying to
// join it, or already mid-setup on it, would keep failing. So once the
// hotspot is up, only rescan occasionally (an explicit Scan from the setup
// page, or a newly added network, still acts immediately).
constexpr uint32_t RETRY_INTERVAL_WITH_AP_MS = 30000;
constexpr size_t SCAN_MAX = 32;
constexpr uint16_t SCAN_RECORDS_MAX = 64;
constexpr size_t SCAN_APS_MAX = 48;
// Channels that may only be listened to, not probed (5 GHz radar/DFS
// channels): long enough to catch at least one beacon (typically every
// ~102 ms). Left at 0 these were effectively never scanned at all.
constexpr uint32_t SCAN_PASSIVE_MS = 150;
constexpr int64_t CAM_SCAN_MAX_AGE_US = 5LL * 60 * 1000 * 1000;

constexpr EventBits_t BIT_CONNECTED = BIT0;
constexpr EventBits_t BIT_DISCONNECTED = BIT1;
constexpr EventBits_t BIT_SCAN_REQUEST = BIT2;
constexpr EventBits_t BIT_RECHECK = BIT3;

EventGroupHandle_t s_events = nullptr;
SemaphoreHandle_t s_lock = nullptr;
esp_netif_t *s_apNetif = nullptr;
esp_netif_t *s_staNetif = nullptr;

struct Lock {
    Lock() { xSemaphoreTake(s_lock, portMAX_DELAY); }
    ~Lock() { xSemaphoreGive(s_lock); }
};

// -- state (guarded by s_lock unless noted) --
volatile bool g_connected = false;   // read lock-free by hot paths (OLED, OTA validation)
volatile bool g_apActive = false;
volatile bool g_prefer5 = false;      // see wifi_get_prefer_5ghz()
volatile bool g_reevaluate = false;   // the preference just changed: re-pick while connected
char g_mac[18] = "";
char g_ip[16] = "0.0.0.0";
char g_connectedSsid[33] = "";
char g_attemptSsid[33] = "";
bool g_connecting = false;
char g_preferredSsid[33] = "";       // one-shot, from wifi_request_connect()
char g_apSsid[33] = "";              // fixed after wifi_connect_start()
WifiScanEntry g_scan[SCAN_MAX];      // what the robot itself heard in its last scan
size_t g_scanCount = 0;
WifiScanEntry g_camScan[SCAN_MAX];   // what the camera (2.4 GHz only, its own antenna) last reported
size_t g_camScanCount = 0;
int64_t g_camScanAtUs = 0;
bool g_scanning = false;
uint32_t g_scanSeq = 0;
WifiApEntry g_aps[SCAN_APS_MAX];     // every access point of the last scan, strongest first
size_t g_apCount = 0;
// The pinned access point (see wifi_pin_ap()); g_pinSsid "" = none.
char g_pinSsid[33] = "";
uint8_t g_pinBssid[6] = {};
uint8_t g_pinChannel = 0;
bool g_repin = false;                 // just pinned: move onto it if connected elsewhere

bool pin_applies(const char *ssid) {
    Lock lock;
    return g_pinSsid[0] != '\0' && std::strcmp(g_pinSsid, ssid) == 0;
}

void save_pin() {
    nvs_handle_t h;
    if (nvs_open("wifinets", NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_str(h, "pinSsid", g_pinSsid);
    nvs_set_blob(h, "pinBssid", g_pinBssid, sizeof(g_pinBssid));
    nvs_set_u8(h, "pinCh", g_pinChannel);
    nvs_commit(h);
    nvs_close(h);
}

void copy_str(char *dst, size_t dstLen, const char *src) {
    size_t n = strnlen(src, dstLen - 1);
    std::memcpy(dst, src, n);
    dst[n] = '\0';
}

// The driver's wifi_config_t ssid[32]/password[64] are NOT NUL-terminated
// when full (a 32-char SSID or a 64-hex-digit PSK) -- so fill the whole
// field rather than reserving a byte for a terminator it doesn't use.
void copy_field(uint8_t *dst, size_t dstLen, const char *src) {
    std::memset(dst, 0, dstLen);
    std::memcpy(dst, src, std::min(std::strlen(src), dstLen));
}

// -- setup hotspot --------------------------------------------------------

// Radio policy at boot: ESP-IDF's world-safe regulatory default ("01",
// 2.4 GHz channels 1-11, adopting the connected router's country via
// 802.11d) -- set explicitly because the driver persists the country in
// flash, and earlier builds stored "NL" there. Plus the saved band preference.
void apply_radio_policy() {
    esp_wifi_set_country_code("01", true);
    nvs_handle_t h;
    uint8_t prefer5 = 0;
    if (nvs_open("wifinets", NVS_READWRITE, &h) == ESP_OK) {
        nvs_get_u8(h, "prefer5", &prefer5);
        nvs_erase_key(h, "country"); // left over from builds that had a country setting
        nvs_commit(h);
        size_t len = sizeof(g_pinSsid);
        size_t blobLen = sizeof(g_pinBssid);
        if (nvs_get_str(h, "pinSsid", g_pinSsid, &len) != ESP_OK || nvs_get_blob(h, "pinBssid", g_pinBssid, &blobLen) != ESP_OK ||
            blobLen != sizeof(g_pinBssid)) {
            g_pinSsid[0] = '\0';
        }
        nvs_get_u8(h, "pinCh", &g_pinChannel);
        nvs_close(h);
    }
    g_prefer5 = prefer5 != 0;
    if (g_pinSsid[0]) {
        ESP_LOGI(TAG, "Pinned access point for %s: %02x:%02x:%02x:%02x:%02x:%02x (channel %u)", g_pinSsid, g_pinBssid[0],
                 g_pinBssid[1], g_pinBssid[2], g_pinBssid[3], g_pinBssid[4], g_pinBssid[5], g_pinChannel);
    }
}

int ap_client_count() {
    if (!g_apActive) return 0;
    wifi_sta_list_t list = {};
    return esp_wifi_ap_get_sta_list(&list) == ESP_OK ? list.num : 0;
}

void start_ap() {
    if (g_apActive) return;
    wifi_config_t ap = {};
    copy_field(ap.ap.ssid, sizeof(ap.ap.ssid), g_apSsid);
    ap.ap.ssid_len = (uint8_t) std::strlen(g_apSsid);
    ap.ap.channel = 1; // 2.4 GHz, so any phone can see it (follows the station's channel once that connects)
    // Open, no password: it only exists while the robot can't reach any
    // saved network, and joining should be one tap. The flip side: anyone in
    // range can join it during that time and use the robot's pages too.
    ap.ap.authmode = WIFI_AUTH_OPEN;
    ap.ap.max_connection = 4;

    esp_err_t err = esp_wifi_set_mode(WIFI_MODE_APSTA);
    if (err == ESP_OK) err = esp_wifi_set_config(WIFI_IF_AP, &ap);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "starting setup hotspot failed: %s", esp_err_to_name(err));
        return;
    }

    esp_netif_dhcps_stop(s_apNetif);
    esp_netif_dhcps_option(s_apNetif, ESP_NETIF_OP_SET, ESP_NETIF_CAPTIVEPORTAL_URI,
                           (void *) CAPTIVE_PORTAL_URI, std::strlen(CAPTIVE_PORTAL_URI));
    esp_netif_dhcps_start(s_apNetif);

    esp_netif_ip_info_t ipInfo = {};
    esp_netif_get_ip_info(s_apNetif, &ipInfo);
    captive_dns_start(ipInfo.ip.addr);

    g_apActive = true;
    ESP_LOGW(TAG, "Setup hotspot \"%s\" active (open) -- join it and open http://192.168.4.1/wifi", g_apSsid);
}

void stop_ap() {
    if (!g_apActive) return;
    if (esp_wifi_set_mode(WIFI_MODE_STA) == ESP_OK) {
        g_apActive = false;
        ESP_LOGI(TAG, "Setup hotspot stopped");
    }
}

// -- scanning / choosing / connecting --------------------------------------

// Diagnostics from the serial console ("wifi scan [passive|long]"): the next
// scan uses the given mode and logs every raw record.
volatile int g_debugScanMode = -1; // -1 none, 0 normal, 1 passive, 2 long active
volatile int g_debugScanChannel = 0; // >0: scan only this channel
char g_debugInfo[96] = "";

void do_scan() {
    {
        Lock lock;
        g_scanning = true;
    }
    int debugMode = g_debugScanMode;
    g_debugScanMode = -1;
    int debugChannel = g_debugScanChannel;
    g_debugScanChannel = 0;
    wifi_scan_config_t cfg = {};
    cfg.channel = (uint8_t) debugChannel;
    if (debugMode >= 0) {
        wifi_country_t c = {};
        esp_wifi_get_country(&c);
        wifi_band_mode_t band = WIFI_BAND_MODE_AUTO;
        esp_wifi_get_band_mode(&band);
        ESP_LOGI(TAG, "country cc=%c%c schan=%u nchan=%u policy=%d band_mode=%d scan channel=%d", c.cc[0], c.cc[1],
                 c.schan, c.nchan, (int) c.policy, (int) band, debugChannel);
        std::snprintf(g_debugInfo, sizeof(g_debugInfo), "cc=%c%c schan=%u nchan=%u band_mode=%d", c.cc[0], c.cc[1],
                      c.schan, c.nchan, (int) band);
    }
    cfg.show_hidden = false;
    cfg.scan_type = debugMode == 1 ? WIFI_SCAN_TYPE_PASSIVE : WIFI_SCAN_TYPE_ACTIVE;
    cfg.scan_time.active.min = debugMode == 2 ? 200 : 60;
    cfg.scan_time.active.max = debugMode == 2 ? 400 : 120;
    cfg.scan_time.passive = debugMode == 1 ? 400 : SCAN_PASSIVE_MS;
    cfg.home_chan_dwell_time = WIFI_SCAN_HOME_CHANNEL_DWELL_DEFAULT_TIME;

    WifiScanEntry merged[SCAN_MAX];
    size_t mergedCount = 0;
    static WifiApEntry aps[SCAN_APS_MAX]; // only this task scans; static keeps ~1.2 KB off its stack
    size_t apCount = 0;

    // Mode 3: scan with the radio in 2.4 GHz-only band mode (drops a 5 GHz
    // connection; the manager reconnects afterwards).
    if (debugMode == 3) {
        esp_wifi_set_band_mode(WIFI_BAND_MODE_2G_ONLY);
        vTaskDelay(pdMS_TO_TICKS(500));
    }
    int64_t t0 = esp_timer_get_time();
    esp_err_t err = esp_wifi_scan_start(&cfg, true); // blocking; this task owns the radio
    if (debugMode == 3) {
        ESP_LOGI(TAG, "2.4 GHz-only scan: %s", esp_err_to_name(err));
        std::snprintf(g_debugInfo + std::strlen(g_debugInfo), sizeof(g_debugInfo) - std::strlen(g_debugInfo),
                      " | 2G-only scan: %s", esp_err_to_name(err));
    }
    if (err == ESP_OK) {
        uint16_t n = SCAN_RECORDS_MAX;
        uint16_t total = 0;
        esp_wifi_scan_get_ap_num(&total);
        auto *records = new (std::nothrow) wifi_ap_record_t[SCAN_RECORDS_MAX];
        if (records != nullptr && esp_wifi_scan_get_ap_records(&n, records) == ESP_OK) {
            if (debugMode >= 0) {
                ESP_LOGI(TAG, "scan (%s): %u APs in %lld ms", debugMode == 1 ? "passive 400ms" : debugMode == 2 ? "active 200-400ms" : "normal",
                         (unsigned) total, (long long) ((esp_timer_get_time() - t0) / 1000));
                for (uint16_t i = 0; i < n; i++) {
                    const uint8_t *b = records[i].bssid;
                    ESP_LOGI(TAG, "  ch %3u  %4d dBm  %02x:%02x:%02x:%02x:%02x:%02x  %s", records[i].primary, records[i].rssi,
                             b[0], b[1], b[2], b[3], b[4], b[5], records[i].ssid[0] ? (const char *) records[i].ssid : "<hidden>");
                }
            }
            // One entry per SSID: strongest BSS's signal, bands OR'd together
            // (a dual-band router shows up as two BSSes with the same name).
            for (uint16_t i = 0; i < n; i++) {
                const char *ssid = (const char *) records[i].ssid;
                if (ssid[0] == '\0') continue;
                bool is5 = records[i].primary > 14;
                WifiScanEntry *e = nullptr;
                for (size_t j = 0; j < mergedCount; j++) {
                    if (std::strcmp(merged[j].ssid, ssid) == 0) { e = &merged[j]; break; }
                }
                if (e == nullptr) {
                    if (mergedCount >= SCAN_MAX) continue;
                    e = &merged[mergedCount++];
                    std::memset(e, 0, sizeof(*e));
                    copy_str(e->ssid, sizeof(e->ssid), ssid);
                    e->rssi = records[i].rssi;
                    e->channel = records[i].primary;
                    e->robotHears = true;
                } else if (records[i].rssi > e->rssi) {
                    e->rssi = records[i].rssi;
                    e->channel = records[i].primary;
                }
                if (records[i].authmode != WIFI_AUTH_OPEN) e->secure = true;
                if (is5 && (!e->has5 || records[i].rssi > e->rssi5)) {
                    e->rssi5 = records[i].rssi;
                    e->channel5 = records[i].primary;
                    std::memcpy(e->bssid5, records[i].bssid, sizeof(e->bssid5));
                }
                if (is5) e->has5 = true; else e->has24 = true;
                if (apCount < SCAN_APS_MAX) {
                    WifiApEntry &a = aps[apCount++];
                    copy_str(a.ssid, sizeof(a.ssid), ssid);
                    std::memcpy(a.bssid, records[i].bssid, sizeof(a.bssid));
                    a.rssi = records[i].rssi;
                    a.channel = records[i].primary;
                }
            }
            std::sort(aps, aps + apCount, [](const WifiApEntry &a, const WifiApEntry &b) { return a.rssi > b.rssi; });
            std::sort(merged, merged + mergedCount,
                      [](const WifiScanEntry &a, const WifiScanEntry &b) { return a.rssi > b.rssi; });
        }
        delete[] records;
    } else {
        ESP_LOGW(TAG, "scan failed: %s", esp_err_to_name(err));
    }
    esp_wifi_clear_ap_list(); // frees the driver's copy even if we didn't read every record
    if (debugMode == 3) esp_wifi_set_band_mode(WIFI_BAND_MODE_AUTO);

    Lock lock;
    if (err == ESP_OK) {
        std::memcpy(g_scan, merged, mergedCount * sizeof(WifiScanEntry));
        g_scanCount = mergedCount;
        std::memcpy(g_aps, aps, apCount * sizeof(WifiApEntry));
        g_apCount = apCount;
        g_scanSeq++;
    }
    g_scanning = false;
}

// Best saved network in the latest scan. Default: 2.4 GHz-capable first (the
// camera can only follow the robot onto those), then strongest signal. With
// "prefer 5 GHz": 5 GHz-capable first, ranked by their 5 GHz signal, and the
// strongest 5 GHz access point is pinned (*pin5 set) so a dual-band SSID
// doesn't end up on its 2.4 GHz radio anyway.
bool pick_best(char *outSsid, size_t outLen, const WifiScanEntry **pin5) {
    Lock lock;
    *pin5 = nullptr;
    const WifiScanEntry *best = nullptr;
    auto preferred = [](const WifiScanEntry &e) { return g_prefer5 ? e.has5 : e.has24; };
    auto signal = [](const WifiScanEntry &e) { return g_prefer5 && e.has5 ? e.rssi5 : e.rssi; };
    for (size_t i = 0; i < g_scanCount; i++) {
        const WifiScanEntry &e = g_scan[i];
        if (!wifi_networks_find(e.ssid, nullptr)) continue;
        if (best == nullptr || (preferred(e) && !preferred(*best)) ||
            (preferred(e) == preferred(*best) && signal(e) > signal(*best))) {
            best = &e;
        }
    }
    if (best == nullptr) return false;
    copy_str(outSsid, outLen, best->ssid);
    if (g_prefer5 && best->has5 && best->has24) {
        static WifiScanEntry pinned; // copied out of g_scan: the next scan may overwrite it
        pinned = *best;
        *pin5 = &pinned;
    }
    return true;
}

// usePin: join the pinned access point if this is its network (see
// wifi_pin_ap()); the caller retries with false if that fails.
bool attempt(const char *ssid, const WifiScanEntry *pin5 = nullptr, bool usePin = true) {
    WifiCredential cred;
    if (!wifi_networks_find(ssid, &cred)) return false;

    {
        Lock lock;
        copy_str(g_attemptSsid, sizeof(g_attemptSsid), cred.ssid);
        g_connecting = true;
    }
    ESP_LOGI(TAG, "Connecting to WiFi: %s", cred.ssid);

    wifi_config_t cfg = {};
    copy_field(cfg.sta.ssid, sizeof(cfg.sta.ssid), cred.ssid);
    copy_field(cfg.sta.password, sizeof(cfg.sta.password), cred.password);
    cfg.sta.threshold.authmode = cred.password[0] == '\0' ? WIFI_AUTH_OPEN : WIFI_AUTH_WPA2_PSK;
    // Dual-band SSIDs: look at every channel and take the strongest BSS,
    // rather than whichever answers first.
    cfg.sta.scan_method = WIFI_ALL_CHANNEL_SCAN;
    cfg.sta.sort_method = WIFI_CONNECT_AP_BY_SIGNAL;
    if (usePin && pin_applies(cred.ssid)) {
        Lock lock;
        cfg.sta.bssid_set = true;
        std::memcpy(cfg.sta.bssid, g_pinBssid, sizeof(cfg.sta.bssid));
        cfg.sta.channel = g_pinChannel;
        ESP_LOGI(TAG, "  (the chosen access point %02x:%02x:%02x:%02x:%02x:%02x, channel %u)", g_pinBssid[0], g_pinBssid[1],
                 g_pinBssid[2], g_pinBssid[3], g_pinBssid[4], g_pinBssid[5], g_pinChannel);
    } else if (pin5 != nullptr) {
        cfg.sta.bssid_set = true;
        std::memcpy(cfg.sta.bssid, pin5->bssid5, sizeof(cfg.sta.bssid));
        cfg.sta.channel = pin5->channel5;
        ESP_LOGI(TAG, "  (pinned to its 5 GHz access point, channel %u)", pin5->channel5);
    }

    xEventGroupClearBits(s_events, BIT_CONNECTED | BIT_DISCONNECTED);
    esp_err_t err = esp_wifi_set_config(WIFI_IF_STA, &cfg);
    if (err == ESP_OK) err = esp_wifi_connect();
    EventBits_t bits = 0;
    if (err == ESP_OK) {
        bits = xEventGroupWaitBits(s_events, BIT_CONNECTED | BIT_DISCONNECTED, pdFALSE, pdFALSE,
                                   pdMS_TO_TICKS(CONNECT_TIMEOUT_MS));
    }

    {
        Lock lock;
        g_connecting = false;
    }
    if ((bits & BIT_CONNECTED) && g_connected) return true;

    ESP_LOGW(TAG, "Connecting to %s failed%s", cred.ssid, err != ESP_OK ? "" : (bits ? "" : " (timeout)"));
    esp_wifi_disconnect();
    return false;
}

void manager_task(void *) {
    int64_t disconnectedSinceUs = esp_timer_get_time();
    int64_t connectedSinceUs = 0;
    bool scanRequested = false;

    while (true) {
        int64_t now = esp_timer_get_time();

        if (!g_connected) {
            char target[33] = "";
            {
                Lock lock;
                copy_str(target, sizeof(target), g_preferredSsid);
                g_preferredSsid[0] = '\0';
            }
            bool haveTarget = target[0] != '\0' && wifi_networks_find(target, nullptr);
            const WifiScanEntry *pin5 = nullptr;
            if (!haveTarget && wifi_networks_count() > 0) {
                do_scan();
                haveTarget = pick_best(target, sizeof(target), &pin5);
            } else if (!haveTarget && (scanRequested || !g_apActive)) {
                // Nothing saved -- still keep the scan list fresh for the
                // setup page, but only when asked once the hotspot is up
                // (see RETRY_INTERVAL_WITH_AP_MS).
                do_scan();
            }
            scanRequested = false;

            // A pinned attempt (the chosen access point, or the 5 GHz one)
            // that fails falls back to letting the driver pick any access
            // point of that network.
            if (haveTarget && (attempt(target, pin5) || ((pin5 != nullptr || pin_applies(target)) && attempt(target, nullptr, false)))) {
                connectedSinceUs = esp_timer_get_time();
                continue;
            }

            now = esp_timer_get_time();
            if (!g_apActive && (wifi_networks_count() == 0 || now - disconnectedSinceUs > AP_START_DELAY_US)) {
                start_ap();
            }
            uint32_t waitMs = g_apActive ? RETRY_INTERVAL_WITH_AP_MS : RETRY_INTERVAL_MS;
            // A scan request or a list change just cuts the wait short --
            // the loop scans/attempts again either way.
            EventBits_t woke = xEventGroupWaitBits(s_events, BIT_SCAN_REQUEST | BIT_RECHECK, pdTRUE, pdFALSE,
                                                   pdMS_TO_TICKS(waitMs));
            scanRequested = (woke & BIT_SCAN_REQUEST) != 0;
            continue;
        }

        EventBits_t bits = xEventGroupWaitBits(s_events, BIT_DISCONNECTED | BIT_SCAN_REQUEST | BIT_RECHECK,
                                               pdTRUE, pdFALSE, pdMS_TO_TICKS(2000));
        if (bits & BIT_DISCONNECTED) {
            disconnectedSinceUs = esp_timer_get_time();
            continue;
        }
        if (bits & BIT_SCAN_REQUEST) do_scan();
        if (bits & BIT_RECHECK) {
            char current[33];
            bool switchNetwork;
            {
                Lock lock;
                copy_str(current, sizeof(current), g_connectedSsid);
                switchNetwork = g_preferredSsid[0] != '\0' && std::strcmp(g_preferredSsid, current) != 0;
                if (!switchNetwork) g_preferredSsid[0] = '\0';
            }
            bool forgotten = !wifi_networks_find(current, nullptr);
            // An access point of this very network was just chosen: move
            // onto it unless we're already there.
            bool repin = false;
            {
                Lock lock;
                if (g_repin && !switchNetwork && std::strcmp(g_pinSsid, current) == 0) {
                    wifi_ap_record_t info;
                    repin = esp_wifi_sta_get_ap_info(&info) != ESP_OK || std::memcmp(info.bssid, g_pinBssid, sizeof(g_pinBssid)) != 0;
                }
                g_repin = false;
            }
            // The band preference changed: move if the policy now picks a
            // different network, or a 5 GHz access point we're not on.
            bool rebalance = false;
            if (g_reevaluate && !switchNetwork && !forgotten) {
                g_reevaluate = false;
                do_scan();
                char best[33];
                const WifiScanEntry *pin5 = nullptr;
                wifi_ap_record_t info;
                bool on5 = esp_wifi_sta_get_ap_info(&info) == ESP_OK && info.primary > 14;
                rebalance = pick_best(best, sizeof(best), &pin5) && (std::strcmp(best, current) != 0 || (pin5 != nullptr && !on5));
            }
            if (switchNetwork || forgotten || rebalance || repin) {
                ESP_LOGI(TAG, "Leaving %s (%s)", current,
                         forgotten ? "forgotten" : rebalance ? "band preference" : repin ? "chosen access point" : "switching networks");
                if (repin) {
                    Lock lock;
                    copy_str(g_preferredSsid, sizeof(g_preferredSsid), current); // rejoin right away, no scan first
                }
                esp_wifi_disconnect(); // STA_DISCONNECTED clears g_connected; the loop then connects to the preferred/best one
                xEventGroupWaitBits(s_events, BIT_DISCONNECTED, pdTRUE, pdFALSE, pdMS_TO_TICKS(3000));
                g_connected = false;
                disconnectedSinceUs = esp_timer_get_time();
                continue;
            }
        }
        if (g_apActive && esp_timer_get_time() - connectedSinceUs > AP_STOP_DELAY_US && ap_client_count() == 0) {
            stop_ap();
        }
    }
}

void wifi_event_handler(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void) arg;
    if (base == WIFI_EVENT && id == WIFI_EVENT_STA_DISCONNECTED) {
        bool wasConnected = g_connected;
        g_connected = false;
        auto *event = (wifi_event_sta_disconnected_t *) data;
        // 2 AUTH_EXPIRE / 15 4WAY_HANDSHAKE_TIMEOUT / 204 HANDSHAKE_TIMEOUT
        // usually mean a wrong password; 201 NO_AP_FOUND means out of range.
        ESP_LOGW(TAG, "%s (reason=%d)", wasConnected ? "disconnected" : "connect attempt failed", event->reason);
        xEventGroupSetBits(s_events, BIT_DISCONNECTED);
    } else if (base == WIFI_EVENT && id == WIFI_EVENT_AP_STACONNECTED) {
        ESP_LOGI(TAG, "a device joined the setup hotspot");
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        auto *event = (ip_event_got_ip_t *) data;
        {
            Lock lock;
            std::snprintf(g_ip, sizeof(g_ip), IPSTR, IP2STR(&event->ip_info.ip));
            copy_str(g_connectedSsid, sizeof(g_connectedSsid), g_attemptSsid);
        }
        ESP_LOGI(TAG, "connected to %s, ip=%s", g_attemptSsid, g_ip);
        g_connected = true;
        xEventGroupSetBits(s_events, BIT_CONNECTED);
    }
}

} // namespace

void wifi_connect_start() {
    uint8_t mac[6];
    ESP_ERROR_CHECK(esp_read_mac(mac, ESP_MAC_WIFI_STA));
    std::snprintf(g_mac, sizeof(g_mac), "%02X:%02X:%02X:%02X:%02X:%02X",
                  mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    std::snprintf(g_apSsid, sizeof(g_apSsid), "%s%02X%02X", AP_SSID_PREFIX, mac[4], mac[5]);
    ESP_LOGI(TAG, "MAC address: %s", g_mac);

    s_lock = xSemaphoreCreateMutex();
    s_events = xEventGroupCreate();

    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    s_staNetif = esp_netif_create_default_wifi_sta();
    esp_netif_set_hostname(s_staNetif, HOSTNAME);
    s_apNetif = esp_netif_create_default_wifi_ap();

    wifi_init_config_t initCfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&initCfg));
    ESP_ERROR_CHECK(esp_event_handler_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, nullptr));
    ESP_ERROR_CHECK(esp_event_handler_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, nullptr));

    // After esp_wifi_init(): the one-time import reads the driver's own
    // persisted config (the network the previous firmware was using).
    wifi_networks_init();

    apply_radio_policy();

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());

    xTaskCreate(manager_task, "wifi_mgr", 4096, nullptr, tskIDLE_PRIORITY + 1, nullptr);

    ESP_ERROR_CHECK(mdns_init());
    ESP_ERROR_CHECK(mdns_hostname_set(HOSTNAME));
    mdns_instance_name_set("LynXP");
    ESP_LOGI(TAG, "mDNS hostname set: %s.local", HOSTNAME);
}

bool wifi_is_connected() { return g_connected; }
const char *wifi_connect_get_mac() { return g_mac; }
const char *wifi_connect_get_ip() { return g_ip; }
bool wifi_ap_is_active() { return g_apActive; }
const char *wifi_ap_get_ssid() { return g_apSsid; }

bool wifi_get_prefer_5ghz() { return g_prefer5; }

void wifi_set_prefer_5ghz(bool prefer) {
    if (prefer == g_prefer5) return;
    g_prefer5 = prefer;
    nvs_handle_t h;
    if (nvs_open("wifinets", NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_u8(h, "prefer5", prefer ? 1 : 0);
        nvs_commit(h);
        nvs_close(h);
    }
    ESP_LOGI(TAG, "Prefer 5 GHz: %s", prefer ? "on" : "off");
    g_reevaluate = true;
    xEventGroupSetBits(s_events, BIT_RECHECK);
}

void wifi_set_camera_scan(const WifiScanEntry *entries, size_t count) {
    Lock lock;
    g_camScanCount = std::min(count, SCAN_MAX);
    std::memcpy(g_camScan, entries, g_camScanCount * sizeof(WifiScanEntry));
    g_camScanAtUs = esp_timer_get_time();
    g_scanSeq++;
}

bool wifi_is_ap_address(uint32_t addrNetOrder) {
    if (s_apNetif == nullptr) return false;
    esp_netif_ip_info_t ipInfo = {};
    return esp_netif_get_ip_info(s_apNetif, &ipInfo) == ESP_OK && ipInfo.ip.addr == addrNetOrder;
}

void wifi_get_status(WifiStatus *out) {
    std::memset(out, 0, sizeof(*out));
    {
        Lock lock;
        out->connected = g_connected;
        if (out->connected) {
            copy_str(out->ssid, sizeof(out->ssid), g_connectedSsid);
            copy_str(out->ip, sizeof(out->ip), g_ip);
        } else {
            copy_str(out->ip, sizeof(out->ip), "0.0.0.0");
        }
        out->connecting = g_connecting;
        copy_str(out->connectingSsid, sizeof(out->connectingSsid), g_attemptSsid);
        out->scanning = g_scanning;
        out->scanSeq = g_scanSeq;
    }
    if (out->connected) {
        wifi_ap_record_t info;
        if (esp_wifi_sta_get_ap_info(&info) == ESP_OK) {
            out->rssi = info.rssi;
            out->channel = info.primary;
            std::memcpy(out->bssid, info.bssid, sizeof(out->bssid));
            out->connectedOn5Ghz = info.primary > 14;
        }
    }
    out->apActive = g_apActive;
    out->apClients = ap_client_count();
}

// The robot's own scan, annotated with (and extended by) what the camera
// last reported -- the camera has its own, often better-placed, antenna.
size_t wifi_get_scan_results(WifiScanEntry *out, size_t max) {
    Lock lock;
    size_t n = std::min(max, g_scanCount);
    std::memcpy(out, g_scan, n * sizeof(WifiScanEntry));
    bool camFresh = g_camScanCount > 0 && esp_timer_get_time() - g_camScanAtUs < CAM_SCAN_MAX_AGE_US;
    if (!camFresh) return n;
    for (size_t i = 0; i < g_camScanCount; i++) {
        const WifiScanEntry &c = g_camScan[i];
        size_t j = 0;
        while (j < n && std::strcmp(out[j].ssid, c.ssid) != 0) j++;
        if (j < n) {
            out[j].camRssi = c.camRssi;
            out[j].has24 = true;
            if (!out[j].channel) out[j].channel = c.channel;
        } else if (n < max) {
            out[n++] = c; // heard only by the camera
        }
    }
    std::sort(out, out + n, [](const WifiScanEntry &a, const WifiScanEntry &b) {
        int ra = a.robotHears ? a.rssi : a.camRssi;
        int rb = b.robotHears ? b.rssi : b.camRssi;
        return ra > rb;
    });
    return n;
}

bool wifi_ip_in_our_subnet(const char *ip) {
    if (!g_connected || ip == nullptr || s_staNetif == nullptr) return false;
    esp_netif_ip_info_t info = {};
    esp_ip4_addr_t addr = {};
    if (esp_netif_get_ip_info(s_staNetif, &info) != ESP_OK || esp_netif_str_to_ip4(ip, &addr) != ESP_OK) return false;
    if (addr.addr == 0 || info.netmask.addr == 0) return false;
    return (addr.addr & info.netmask.addr) == (info.ip.addr & info.netmask.addr);
}

bool wifi_ssid_has_24ghz(const char *ssid) {
    Lock lock;
    for (size_t i = 0; i < g_camScanCount; i++) {
        if (std::strcmp(g_camScan[i].ssid, ssid) == 0) return true; // the camera is 2.4 GHz only
    }
    for (size_t i = 0; i < g_scanCount; i++) {
        if (std::strcmp(g_scan[i].ssid, ssid) == 0) return g_scan[i].has24;
    }
    return false;
}

bool wifi_ssid_is_5ghz_only(const char *ssid) {
    Lock lock;
    for (size_t i = 0; i < g_camScanCount; i++) {
        if (std::strcmp(g_camScan[i].ssid, ssid) == 0) return false; // the 2.4 GHz-only camera hears it
    }
    for (size_t i = 0; i < g_scanCount; i++) {
        if (std::strcmp(g_scan[i].ssid, ssid) == 0) return g_scan[i].has5 && !g_scan[i].has24;
    }
    return false;
}

void wifi_request_scan() {
    xEventGroupSetBits(s_events, BIT_SCAN_REQUEST);
}

const char *wifi_debug_info() { return g_debugInfo; }

void wifi_request_debug_scan(int mode, int channel) {
    g_debugScanChannel = channel;
    g_debugScanMode = mode;
    xEventGroupSetBits(s_events, BIT_SCAN_REQUEST);
}

void wifi_request_connect(const char *ssid) {
    {
        Lock lock;
        copy_str(g_preferredSsid, sizeof(g_preferredSsid), ssid);
    }
    xEventGroupSetBits(s_events, BIT_RECHECK);
}

void wifi_networks_changed() {
    xEventGroupSetBits(s_events, BIT_RECHECK);
}

size_t wifi_get_scan_aps(WifiApEntry *out, size_t max) {
    Lock lock;
    size_t n = std::min(max, g_apCount);
    std::memcpy(out, g_aps, n * sizeof(WifiApEntry));
    return n;
}

bool wifi_pin_ap(const char *ssid, const uint8_t bssid[6], uint8_t channel) {
    if (!wifi_networks_find(ssid, nullptr)) return false;
    {
        Lock lock;
        copy_str(g_pinSsid, sizeof(g_pinSsid), ssid);
        std::memcpy(g_pinBssid, bssid, sizeof(g_pinBssid));
        g_pinChannel = channel;
        save_pin();
        g_repin = true;
        // On another network (or none): go there now; attempt() uses the pin.
        if (std::strcmp(g_connectedSsid, ssid) != 0 || !g_connected) copy_str(g_preferredSsid, sizeof(g_preferredSsid), ssid);
    }
    ESP_LOGI(TAG, "Chosen access point for %s: %02x:%02x:%02x:%02x:%02x:%02x (channel %u)", ssid, bssid[0], bssid[1], bssid[2],
             bssid[3], bssid[4], bssid[5], channel);
    xEventGroupSetBits(s_events, BIT_RECHECK);
    return true;
}

void wifi_unpin_ap() {
    Lock lock;
    if (g_pinSsid[0] == '\0') return;
    g_pinSsid[0] = '\0';
    std::memset(g_pinBssid, 0, sizeof(g_pinBssid));
    g_pinChannel = 0;
    save_pin();
    ESP_LOGI(TAG, "Access point choice cleared (automatic)");
}

bool wifi_get_pinned_ap(char *ssid, uint8_t bssid[6], uint8_t *channel) {
    Lock lock;
    if (g_pinSsid[0] == '\0') return false;
    copy_str(ssid, 33, g_pinSsid);
    std::memcpy(bssid, g_pinBssid, sizeof(g_pinBssid));
    *channel = g_pinChannel;
    return true;
}
