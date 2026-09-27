#include "uart_link.hpp"
#include "board_pins.hpp"
#include "wifi_connect.hpp"
#include "wifi_networks.hpp"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/uart.h"
#include "esp_log.h"

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {

const char *TAG = "uart_link";

constexpr uart_port_t LINK_UART_PORT = UART_NUM_1;
constexpr int LINK_UART_BAUD = 115200;
constexpr TickType_t PEER_STALE_TICKS = pdMS_TO_TICKS(6000);

CamDiagnostics s_diag;
volatile TickType_t s_lastSeenTick = 0;

// Cam WiFi hand-off (see uart_link.hpp). Checked every few seconds; after a
// push, give the cam time to switch networks before pushing the same one again.
constexpr TickType_t CAM_WIFI_CHECK_PERIOD = pdMS_TO_TICKS(5000);
constexpr TickType_t CAM_WIFI_REPUSH_PERIOD = pdMS_TO_TICKS(30000);
TickType_t s_lastCamWifiCheck = 0;
TickType_t s_lastCamWifiPush = 0;
char s_lastPushedSsid[33] = "";

// SSIDs/passwords can contain spaces, '=' or anything else, so they travel
// hex-encoded to keep the space-separated key=value line format intact.
void hex_encode(const char *in, char *out, size_t outLen) {
    static const char HEX[] = "0123456789abcdef";
    size_t j = 0;
    for (size_t i = 0; in[i] != '\0' && j + 2 < outLen; i++) {
        uint8_t b = (uint8_t) in[i];
        out[j++] = HEX[b >> 4];
        out[j++] = HEX[b & 0xF];
    }
    out[j] = '\0';
}

// Stops at the first non-hex character, i.e. the space before the next key.
void hex_decode(const char *in, char *out, size_t outLen) {
    size_t j = 0;
    for (size_t i = 0; std::isxdigit((unsigned char) in[i]) && std::isxdigit((unsigned char) in[i + 1]) && j + 1 < outLen; i += 2) {
        char pair[3] = {in[i], in[i + 1], '\0'};
        out[j++] = (char) std::strtol(pair, nullptr, 16);
    }
    out[j] = '\0';
}

WifiScanEntry s_camScan[32]; // being collected from "AP" lines until "APEND"
size_t s_camScanCount = 0;
volatile bool s_camScanPending = false;
volatile TickType_t s_camScanRequestedAt = 0;
constexpr TickType_t CAM_SCAN_TIMEOUT = pdMS_TO_TICKS(10000); // a 2.4 GHz scan takes ~2 s; generous margin

void maybe_sync_cam_wifi() {
    if (uart_link_peer_is_stale() || !wifi_is_connected()) return;
    TickType_t now = xTaskGetTickCount();
    WifiStatus st;
    wifi_get_status(&st);
    if (st.ssid[0] == '\0' || std::strcmp(s_diag.ssid, st.ssid) == 0) return; // already on the same network
    // A different SSID isn't necessarily a different network: the camera on
    // a router's 2.4 GHz SSID while the robot uses the same router's 5 GHz
    // one is exactly how it should be. If the camera's address is on the
    // robot's subnet, leave it alone.
    if (std::strcmp(s_diag.ip, "0.0.0.0") != 0 && wifi_ip_in_our_subnet(s_diag.ip)) return;
    // Only hand over a network the (2.4 GHz-only) camera can actually join.
    // On a 5 GHz link that means a scan must have seen the SSID on 2.4 GHz
    // too -- an unknown is treated as "no", never pushed blindly.
    if (st.connectedOn5Ghz && !wifi_ssid_has_24ghz(st.ssid)) return;

    if (std::strcmp(s_lastPushedSsid, st.ssid) == 0 && now - s_lastCamWifiPush < CAM_WIFI_REPUSH_PERIOD) return;

    WifiCredential cred;
    if (!wifi_networks_find(st.ssid, &cred)) return;
    char ssidHex[sizeof(cred.ssid) * 2];
    char passHex[sizeof(cred.password) * 2];
    hex_encode(cred.ssid, ssidHex, sizeof(ssidHex));
    hex_encode(cred.password, passHex, sizeof(passHex));
    char line[256];
    int len = std::snprintf(line, sizeof(line), "WIFI ssid=%s pass=%s\n", ssidHex, passHex);
    uart_write_bytes(LINK_UART_PORT, line, len);

    std::memcpy(s_lastPushedSsid, st.ssid, sizeof(s_lastPushedSsid)); // same size, always NUL-terminated
    s_lastCamWifiPush = now;
    ESP_LOGI(TAG, "sent network \"%s\" to the cam (it reported \"%s\")", st.ssid, s_diag.ssid);
}

// Parses "STAT key=value key=value ...\n" (line already NUL-terminated, no
// trailing \r\n). Loose key=value tokenizing rather than a fixed sscanf --
// unknown keys are silently ignored (forward-compatible if the cam side
// gains fields this firmware doesn't know about yet) and a key the cam
// doesn't currently send just leaves that field at its last known value
// (backward-compatible with an older cam build). The leading "STAT" token
// has no '=' in it, so it's skipped by the same loop with no special-casing
// needed.
void handle_line(char *line) {
    // "NET ssid=<hex>": which network the cam is on -- its own line rather
    // than a STAT field, so an older robot build (192-byte line buffer, no
    // idea what NET is) doesn't lose whole STAT lines to a long SSID.
    if (std::strncmp(line, "NET ", 4) == 0) {
        const char *hex = std::strstr(line, "ssid=");
        hex_decode(hex ? hex + 5 : "", s_diag.ssid, sizeof(s_diag.ssid));
        return;
    }
    // Camera scan results, one "AP ssid=<hex> rssi=<dBm> ch=<n> sec=<0|1>"
    // per network, then "APEND" (see uart_link_request_cam_scan()).
    if (std::strncmp(line, "AP ", 3) == 0) {
        if (s_camScanCount >= sizeof(s_camScan) / sizeof(s_camScan[0])) return;
        WifiScanEntry &e = s_camScan[s_camScanCount];
        std::memset(&e, 0, sizeof(e));
        const char *s = std::strstr(line, "ssid=");
        const char *r = std::strstr(line, "rssi=");
        const char *c = std::strstr(line, "ch=");
        const char *sec = std::strstr(line, "sec=");
        hex_decode(s ? s + 5 : "", e.ssid, sizeof(e.ssid));
        if (e.ssid[0] == '\0') return;
        e.camRssi = (int8_t) (r ? std::atoi(r + 5) : -100);
        e.channel = (uint8_t) (c ? std::atoi(c + 3) : 0);
        e.secure = sec ? sec[4] == '1' : true;
        e.has24 = true;
        e.robotHears = false;
        s_camScanCount++;
        return;
    }
    if (std::strcmp(line, "APEND") == 0) {
        s_camScanPending = false;
        wifi_set_camera_scan(s_camScan, s_camScanCount);
        ESP_LOGI(TAG, "camera scan: %u network(s)", (unsigned) s_camScanCount);
        s_camScanCount = 0;
        return;
    }

    bool sawMac = false;
    char *savePtr = nullptr;
    for (char *tok = strtok_r(line, " ", &savePtr); tok != nullptr; tok = strtok_r(nullptr, " ", &savePtr)) {
        char *eq = std::strchr(tok, '=');
        if (eq == nullptr) continue;
        *eq = '\0';
        const char *key = tok;
        const char *value = eq + 1;

        if (std::strcmp(key, "mac") == 0) {
            std::strncpy(s_diag.mac, value, sizeof(s_diag.mac) - 1);
            s_diag.mac[sizeof(s_diag.mac) - 1] = '\0';
            sawMac = true;
        } else if (std::strcmp(key, "ip") == 0) {
            std::strncpy(s_diag.ip, value, sizeof(s_diag.ip) - 1);
            s_diag.ip[sizeof(s_diag.ip) - 1] = '\0';
        } else if (std::strcmp(key, "rssi") == 0) {
            s_diag.rssiDbm = std::atoi(value);
        } else if (std::strcmp(key, "uptime") == 0) {
            s_diag.uptimeS = (uint32_t) std::strtoul(value, nullptr, 10);
        } else if (std::strcmp(key, "heap") == 0) {
            s_diag.freeHeapBytes = (uint32_t) std::strtoul(value, nullptr, 10);
        } else if (std::strcmp(key, "minheap") == 0) {
            s_diag.minFreeHeapBytes = (uint32_t) std::strtoul(value, nullptr, 10);
        } else if (std::strcmp(key, "camfail") == 0) {
            s_diag.camFailCount = (uint32_t) std::strtoul(value, nullptr, 10);
        } else if (std::strcmp(key, "reboots") == 0) {
            s_diag.rebootCount = (uint32_t) std::strtoul(value, nullptr, 10);
        } else if (std::strcmp(key, "clients") == 0) {
            s_diag.clients = std::atoi(value);
        } else if (std::strcmp(key, "reset") == 0) {
            std::strncpy(s_diag.resetReason, value, sizeof(s_diag.resetReason) - 1);
            s_diag.resetReason[sizeof(s_diag.resetReason) - 1] = '\0';
        }
    }

    if (!sawMac) {
        ESP_LOGW(TAG, "STAT line missing mac=, ignoring");
        return;
    }
    s_lastSeenTick = xTaskGetTickCount();
}

void uart_link_rx_task(void *arg) {
    (void) arg;
    char line[256]; // >= the cam's own status_uart_send() buffer size
    size_t lineLen = 0;
    uint8_t byte;

    while (true) {
        if (xTaskGetTickCount() - s_lastCamWifiCheck >= CAM_WIFI_CHECK_PERIOD) {
            s_lastCamWifiCheck = xTaskGetTickCount();
            maybe_sync_cam_wifi();
        }

        int n = uart_read_bytes(LINK_UART_PORT, &byte, 1, pdMS_TO_TICKS(100));
        if (n <= 0) continue;

        if (byte == '\n') {
            line[lineLen] = '\0';
            if (lineLen > 0) handle_line(line);
            lineLen = 0;
        } else if (byte != '\r') {
            if (lineLen < sizeof(line) - 1) {
                line[lineLen++] = (char) byte;
            } else {
                lineLen = 0; // overlong line -- drop and resync on the next '\n'
            }
        }
    }
}

} // namespace

void uart_link_start() {
    uart_config_t cfg = {};
    cfg.baud_rate = LINK_UART_BAUD;
    cfg.data_bits = UART_DATA_8_BITS;
    cfg.parity = UART_PARITY_DISABLE;
    cfg.stop_bits = UART_STOP_BITS_1;
    cfg.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
    // UART_SCLK_XTAL, not UART_SCLK_DEFAULT: this IS the ESP32-C5 receiver
    // the S3 firmware's own comment on this line warned about -- a known
    // chip erratum on UART_SCLK_DEFAULT (PLL-derived) is dodged by clocking
    // off the crystal instead. The S3 CAM's own UART1 (the other end of
    // this link) stays on UART_SCLK_DEFAULT; the erratum is C5-specific.
    cfg.source_clk = UART_SCLK_XTAL;

    ESP_ERROR_CHECK(uart_driver_install(LINK_UART_PORT, 256, 256, 0, nullptr, 0));
    ESP_ERROR_CHECK(uart_param_config(LINK_UART_PORT, &cfg));
    ESP_ERROR_CHECK(uart_set_pin(LINK_UART_PORT, CAM_UART_TX_PIN, CAM_UART_RX_PIN,
                                  UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));

    xTaskCreate(uart_link_rx_task, "uart_link_rx", 4096, nullptr, tskIDLE_PRIORITY + 1, nullptr);
}

const CamDiagnostics &uart_link_get_diagnostics() {
    return s_diag;
}

const char *uart_link_get_peer_mac() {
    return s_diag.mac;
}

const char *uart_link_get_peer_ip() {
    return s_diag.ip;
}

const char *uart_link_get_peer_ssid() {
    return s_diag.ssid;
}

bool uart_link_request_cam_scan() {
    if (uart_link_peer_is_stale()) return false;
    s_camScanCount = 0; // drop any half-received earlier report
    s_camScanRequestedAt = xTaskGetTickCount();
    s_camScanPending = true;
    uart_write_bytes(LINK_UART_PORT, "SCAN\n", 5);
    return true;
}

CamScanState uart_link_cam_scan_state() {
    if (!s_camScanPending) return CamScanState::Idle;
    return xTaskGetTickCount() - s_camScanRequestedAt < CAM_SCAN_TIMEOUT ? CamScanState::Scanning : CamScanState::NoAnswer;
}

bool uart_link_peer_is_stale() {
    if (s_lastSeenTick == 0) return true;
    return (xTaskGetTickCount() - s_lastSeenTick) > PEER_STALE_TICKS;
}
