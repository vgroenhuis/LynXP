#include "status_led.hpp"

#include <cmath>
#include <cstring>

#include "esp_system.h"
#include "uart_link.hpp"
#include "watchdog.hpp"
#include "wifi_connect.hpp"
#include "ws_broadcast.hpp"

namespace {

// Kept dim: an indicator on the board, not room lighting.
constexpr uint8_t LEVEL = 40;
constexpr uint32_t CRASH_SHOW_MS = 30000; // how long after boot a crash restart is shown
constexpr uint32_t CAMERA_GRACE_MS = 20000; // the camera's own boot, before its silence counts as an error

volatile bool s_updating = false;

StatusLedColor scaled(uint8_t r, uint8_t g, uint8_t b, float k = 1.0f) {
    return { (uint8_t) (r * k), (uint8_t) (g * k), (uint8_t) (b * k) };
}

// on/off at hz (50% duty)
bool blink(uint32_t nowMs, float hz) {
    return std::fmod(nowMs * hz / 1000.0f, 1.0f) < 0.5f;
}

bool crashed_last_time() {
    if (watchdog_last_reboot_was_hang()) return true;
    switch (esp_reset_reason()) {
        case ESP_RST_PANIC:
        case ESP_RST_INT_WDT:
        case ESP_RST_TASK_WDT:
        case ESP_RST_WDT:
        case ESP_RST_BROWNOUT:
            return true;
        default:
            return false;
    }
}

} // namespace

void status_led_set_updating(bool updating) {
    s_updating = updating;
}

StatusLedColor status_led_color(uint32_t nowMs) {
    constexpr StatusLedColor OFF = { 0, 0, 0 };
    if (s_updating) {
        return blink(nowMs, 5.0f) ? scaled(0, LEVEL, LEVEL) : OFF;
    }
    if (nowMs < CRASH_SHOW_MS && crashed_last_time()) {
        return blink(nowMs, 2.0f) ? scaled(LEVEL, 0, 0) : OFF;
    }
    if (nowMs > CAMERA_GRACE_MS && uart_link_peer_is_stale()) {
        return scaled(LEVEL, 0, 0);
    }

    // (the cheap flags -- wifi_get_status() asks the driver, too much ~30x a second)
    const bool connected = wifi_is_connected();
    // The camera has joined once it reports an address (it's told which
    // network by the robot, uart_link.cpp, so it only follows once the robot's on).
    const bool cameraOnline = !uart_link_peer_is_stale() && std::strcmp(uart_link_get_peer_ip(), "0.0.0.0") != 0;
    if (!connected && wifi_ap_is_active()) {
        // breathing: no network to join, the setup hotspot's waiting
        float k = 0.15f + 0.85f * (0.5f - 0.5f * std::cos(nowMs * 2.0f * (float) M_PI / 3000.0f));
        k = std::round(k * 10.0f) / 10.0f; // (in steps: the LED is only written when it changes)
        return scaled(LEVEL, 0, LEVEL, k);
    }
    if (!connected || (!cameraOnline && !uart_link_peer_is_stale())) {
        return blink(nowMs, 2.0f) ? scaled(LEVEL, LEVEL * 45 / 100, 0) : OFF; // orange
    }
    const bool inUse = ws_broadcast_client_count() > 0 || (!uart_link_peer_is_stale() && uart_link_get_diagnostics().clients > 0);
    return inUse ? scaled(0, LEVEL, 0) : scaled(0, 0, LEVEL);
}
