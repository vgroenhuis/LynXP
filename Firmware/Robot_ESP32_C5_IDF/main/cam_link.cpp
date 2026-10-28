#include "cam_link.hpp"
#include "board_pins.hpp"
#include "wifi_connect.hpp"
#include "wifi_networks.hpp"
#include "settings.hpp"

#include "cam_link_proto.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_random.h"

#include <cctype>
#include <cstdio>
#include <cstdlib>
#include <cstring>

namespace {

const char *TAG = "cam_link";

// SPI master towards the camera (the S3 is the slave): see cam_link_proto.h
// for the framing and board_pins.hpp for the wires.
constexpr spi_host_device_t LINK_SPI_HOST = SPI2_HOST;
constexpr int LINK_SPI_CLOCK_HZ = 4 * 1000 * 1000; // a 128-byte frame takes ~0.26 ms; jumper wires don't like more
constexpr TickType_t POLL_FAST = pdMS_TO_TICKS(5);   // while either side has something to say
constexpr TickType_t POLL_IDLE = pdMS_TO_TICKS(25);
constexpr TickType_t PEER_STALE_TICKS = pdMS_TO_TICKS(6000);

cam_link_t s_link;
uint8_t s_ring[1024];
SemaphoreHandle_t s_linkMutex = nullptr;
spi_device_handle_t s_dev = nullptr;
uint8_t *s_txFrame = nullptr; // DMA-capable
uint8_t *s_rxFrame = nullptr;

// Queues text for the camera (non-blocking: a full queue drops the message --
// every message here is re-sent or re-requested later).
bool link_write(const char *data, size_t len) {
    if (s_linkMutex == nullptr) return false;
    xSemaphoreTake(s_linkMutex, portMAX_DELAY);
    size_t n = cam_link_enqueue(&s_link, (const uint8_t *) data, len);
    xSemaphoreGive(s_linkMutex);
    if (n < len) ESP_LOGW(TAG, "send queue full, dropped %u byte(s)", (unsigned) (len - n));
    return n == len;
}

CamDiagnostics s_diag;
volatile TickType_t s_lastSeenTick = 0;

// Cam WiFi hand-off (see cam_link.hpp). Checked every few seconds; after a
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
    if (cam_link_peer_is_stale() || !wifi_is_connected()) return;
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
    link_write(line, (size_t) len);

    std::memcpy(s_lastPushedSsid, st.ssid, sizeof(s_lastPushedSsid)); // same size, always NUL-terminated
    s_lastCamWifiPush = now;
    ESP_LOGI(TAG, "sent network \"%s\" to the cam (it reported \"%s\")", st.ssid, s_diag.ssid);
}

// The camera guards its own /update with the robot's OTA credentials: they
// travel as "OTA user=<hex> pass=<hex>" (the camera keeps them in NVS), sent
// right after a change and re-sent every 30 s so a camera that rebooted or
// was swapped picks them up too.
constexpr TickType_t CAM_OTA_REPUSH_PERIOD = pdMS_TO_TICKS(30000);
TickType_t s_lastCamOtaPush = 0;
volatile bool s_camOtaDirty = true;

void maybe_sync_cam_ota() {
    if (cam_link_peer_is_stale()) return;
    TickType_t now = xTaskGetTickCount();
    if (!s_camOtaDirty && now - s_lastCamOtaPush < CAM_OTA_REPUSH_PERIOD) return;
    s_camOtaDirty = false;
    s_lastCamOtaPush = now;
    char userHex[sizeof(settings.otaUsername) * 2];
    char passHex[sizeof(settings.otaPassword) * 2];
    hex_encode(settings.otaUsername, userHex, sizeof(userHex));
    hex_encode(settings.otaPassword, passHex, sizeof(passHex));
    char line[200];
    int len = std::snprintf(line, sizeof(line), "OTA user=%s pass=%s\n", userHex, passHex);
    link_write(line, (size_t) len);
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
    // per network, then "APEND" (see cam_link_request_cam_scan()).
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

// Bytes the camera sent, cut into lines at '\n' (the same text lines as before
// the link was SPI).
void feed_bytes(const uint8_t *data, size_t n) {
    static char line[256]; // >= the cam's own status_link_send() buffer size
    static size_t lineLen = 0;
    for (size_t i = 0; i < n; i++) {
        uint8_t byte = data[i];
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

// The SPI master: one full-duplex 128-byte frame with the camera every few ms.
void cam_link_task(void *arg) {
    (void) arg;
    uint8_t payload[CAM_LINK_PAYLOAD_MAX];
    TickType_t lastGood = 0;
    TickType_t lastWarn = xTaskGetTickCount();
    bool up = false;

    while (true) {
        if (xTaskGetTickCount() - s_lastCamWifiCheck >= CAM_WIFI_CHECK_PERIOD) {
            s_lastCamWifiCheck = xTaskGetTickCount();
            maybe_sync_cam_wifi();
            maybe_sync_cam_ota();
        }

        xSemaphoreTake(s_linkMutex, portMAX_DELAY);
        cam_link_build(&s_link, s_txFrame);
        bool busy = cam_link_busy(&s_link);
        xSemaphoreGive(s_linkMutex);

        spi_transaction_t t = {};
        t.length = CAM_LINK_FRAME_BYTES * 8;
        t.tx_buffer = s_txFrame;
        t.rx_buffer = s_rxFrame;
        int n = -1;
        if (spi_device_transmit(s_dev, &t) == ESP_OK) {
            xSemaphoreTake(s_linkMutex, portMAX_DELAY);
            n = cam_link_parse(&s_link, s_rxFrame, payload);
            xSemaphoreGive(s_linkMutex);
        }
        TickType_t now = xTaskGetTickCount();
        if (n >= 0) {
            lastGood = now;
            if (!up) {
                up = true;
                ESP_LOGI(TAG, "camera link up (SPI)");
            }
            if (n > 0) feed_bytes(payload, (size_t) n);
        } else {
            if (up && now - lastGood > pdMS_TO_TICKS(2000)) {
                up = false;
                ESP_LOGW(TAG, "camera link lost");
            }
            // Nothing valid back: no camera yet, or a wiring problem. Say so now and then.
            if (!up && now - lastWarn > pdMS_TO_TICKS(30000)) {
                lastWarn = now;
                ESP_LOGW(TAG, "no valid frame from the camera (%u bad so far): check the SPI wires (SCLK GPIO%d, MOSI GPIO%d, MISO GPIO%d, CS GPIO%d)",
                         (unsigned) s_link.framesBad, (int) CAM_SPI_SCLK_PIN, (int) CAM_SPI_MOSI_PIN, (int) CAM_SPI_MISO_PIN, (int) CAM_SPI_CS_PIN);
            }
        }
        vTaskDelay(busy || n > 0 ? POLL_FAST : POLL_IDLE);
    }
}

} // namespace

void cam_link_start() {
    uint8_t epoch = (uint8_t) (esp_random() & 0xFF);
    cam_link_init(&s_link, epoch ? epoch : 1, s_ring, sizeof(s_ring));
    s_linkMutex = xSemaphoreCreateMutex();
    s_txFrame = (uint8_t *) heap_caps_calloc(1, CAM_LINK_FRAME_BYTES, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    s_rxFrame = (uint8_t *) heap_caps_calloc(1, CAM_LINK_FRAME_BYTES, MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
    if (s_linkMutex == nullptr || s_txFrame == nullptr || s_rxFrame == nullptr) {
        ESP_LOGE(TAG, "out of memory, camera link not started");
        return;
    }

    spi_bus_config_t bus = {};
    bus.mosi_io_num = CAM_SPI_MOSI_PIN;
    bus.miso_io_num = CAM_SPI_MISO_PIN;
    bus.sclk_io_num = CAM_SPI_SCLK_PIN;
    bus.quadwp_io_num = -1;
    bus.quadhd_io_num = -1;
    bus.max_transfer_sz = CAM_LINK_FRAME_BYTES;
    ESP_ERROR_CHECK(spi_bus_initialize(LINK_SPI_HOST, &bus, SPI_DMA_CH_AUTO));

    spi_device_interface_config_t dev = {};
    dev.clock_speed_hz = LINK_SPI_CLOCK_HZ;
    dev.mode = 0;
    dev.spics_io_num = CAM_SPI_CS_PIN;
    dev.queue_size = 1;
    ESP_ERROR_CHECK(spi_bus_add_device(LINK_SPI_HOST, &dev, &s_dev));

    xTaskCreate(cam_link_task, "cam_link", 4096, nullptr, tskIDLE_PRIORITY + 2, nullptr);
}

const CamDiagnostics &cam_link_get_diagnostics() {
    return s_diag;
}

const char *cam_link_get_peer_mac() {
    return s_diag.mac;
}

const char *cam_link_get_peer_ip() {
    return s_diag.ip;
}

const char *cam_link_get_peer_ssid() {
    return s_diag.ssid;
}

bool cam_link_request_cam_scan() {
    if (cam_link_peer_is_stale()) return false;
    s_camScanCount = 0; // drop any half-received earlier report
    s_camScanRequestedAt = xTaskGetTickCount();
    s_camScanPending = true;
    link_write("SCAN\n", 5);
    return true;
}

CamScanState cam_link_cam_scan_state() {
    if (!s_camScanPending) return CamScanState::Idle;
    return xTaskGetTickCount() - s_camScanRequestedAt < CAM_SCAN_TIMEOUT ? CamScanState::Scanning : CamScanState::NoAnswer;
}

bool cam_link_peer_is_stale() {
    if (s_lastSeenTick == 0) return true;
    return (xTaskGetTickCount() - s_lastSeenTick) > PEER_STALE_TICKS;
}

void cam_link_credentials_changed() { s_camOtaDirty = true; }
