#include "uart_link.hpp"
#include "board_pins.hpp"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/uart.h"
#include "esp_log.h"

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

// Parses "STAT key=value key=value ...\n" (line already NUL-terminated, no
// trailing \r\n). Loose key=value tokenizing rather than a fixed sscanf --
// unknown keys are silently ignored (forward-compatible if the cam side
// gains fields this firmware doesn't know about yet) and a key the cam
// doesn't currently send just leaves that field at its last known value
// (backward-compatible with an older cam build). The leading "STAT" token
// has no '=' in it, so it's skipped by the same loop with no special-casing
// needed.
void handle_line(char *line) {
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
    char line[192]; // matches the cam's own status_uart_send() buffer size
    size_t lineLen = 0;
    uint8_t byte;

    while (true) {
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

    xTaskCreate(uart_link_rx_task, "uart_link_rx", 3072, nullptr, tskIDLE_PRIORITY + 1, nullptr);
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

bool uart_link_peer_is_stale() {
    if (s_lastSeenTick == 0) return true;
    return (xTaskGetTickCount() - s_lastSeenTick) > PEER_STALE_TICKS;
}
