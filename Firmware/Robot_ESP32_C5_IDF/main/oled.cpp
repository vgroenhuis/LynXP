#include "oled.hpp"
#include "wifi_connect.hpp"
#include "button.hpp"
#include "qr_display.hpp"
#include "ina260.hpp"

extern "C" {
#include "ssd1306.h"
}

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <cstdio>
#include <cstring>

// nopnop2002/esp-idf-ssd1306 component. Pins/panel size/I2C port are set in
// sdkconfig.defaults (CONFIG_SDA_GPIO etc.), not here -- that's how this
// component's Kconfig-driven config works. Ported from
// Test_ESP32_C5_IDF_for_S3_CAM/main/oled.c's status screen. The S3 CAM's own
// identity used to be shown here too (relayed over UART -- see
// uart_link.cpp), but that only ever existed so its IP could be read off
// and copied into the Main page/QR code by hand -- moot now that the C5
// picks it up automatically the moment the cam starts reporting, with no
// manual step anywhere.

namespace {

SSD1306_t s_dev;
bool s_showingQr = false;
bool s_ina260Ok = false;

// Also the button-response latency: the task only notices a press/release on
// its next iteration, so this period is the worst-case delay before the
// screen reacts. 500ms made the QR button feel sluggish; 30ms (matching
// button.cpp's own poll rate) keeps the redraw cheap -- a handful of small
// I2C text writes -- while making the button feel instant.
constexpr TickType_t RENDER_PERIOD = pdMS_TO_TICKS(30);

// 8x8 font means 16 columns on a 128px-wide panel -- a full colon-separated
// MAC ("AA:BB:CC:DD:EE:FF", 17 chars) doesn't fit. Strip the colons (12
// chars) rather than truncate the address.
void format_compact_mac(const char *mac, char *out, size_t out_len) {
    size_t j = 0;
    for (size_t i = 0; mac[i] != '\0' && j + 1 < out_len; i++) {
        if (mac[i] != ':') out[j++] = mac[i];
    }
    out[j] = '\0';
}

// Always writes all 16 columns (space-padded), unlike a plain
// ssd1306_display_text(..., strlen(text), ...) call -- otherwise a shorter
// replacement (e.g. "10.0.0.5" after "connecting...") leaves the previous,
// longer text's trailing glyph columns stuck on screen.
void render_row_padded(int page, const char *text) {
    char padded[17];
    std::snprintf(padded, sizeof(padded), "%-16s", text);
    ssd1306_display_text(&s_dev, page, padded, 16, false);
}

void render_status() {
    // The QR view fills every page with bitmap data; text draws only touch
    // the exact glyph columns it writes, so without a full clear here,
    // leftover QR pixels stay visible around and below the status text.
    if (s_showingQr) {
        ssd1306_clear_screen(&s_dev, false);
        s_showingQr = false;
    }

    ssd1306_display_text(&s_dev, 0, "LynXP", 5, false);

    // MAC while disconnected -- helps registering this device's MAC on a
    // network that requires it (e.g. MAC allowlisting) before it ever gets
    // an IP -- then IP once connected.
    if (wifi_is_connected()) {
        render_row_padded(1, wifi_connect_get_ip());
    } else {
        char compactMac[13];
        format_compact_mac(wifi_connect_get_mac(), compactMac, sizeof(compactMac));
        char macRow[17];
        std::snprintf(macRow, sizeof(macRow), "MAC %s", compactMac);
        render_row_padded(1, macRow);
    }

    if (s_ina260Ok) {
        float busVoltageV, currentMa, powerMw;
        if (ina260_read(&busVoltageV, &currentMa, &powerMw)) {
            char line[17];
            std::snprintf(line, sizeof(line), "%.2fV %.0fmA", busVoltageV, currentMa);
            render_row_padded(2, line);
        } else {
            render_row_padded(2, "INA260 read err");
        }
    } else {
        render_row_padded(2, "no INA260");
    }
}

void oled_task_body(void *arg) {
    (void) arg;
    while (true) {
        bool connected = wifi_is_connected();
        // Only offer the QR code once there's a real IP to link to --
        // "http://0.0.0.0/" would be useless.
        if (button_is_pressed() && connected) {
            // Regenerating and re-blitting the QR bitmap is far more
            // expensive than a status redraw (full QR encode + a 1KB I2C
            // transfer) -- worth doing once on the press edge rather than
            // every 30ms for as long as the button stays held, especially
            // since the bitmap wouldn't change between those redraws anyway.
            if (!s_showingQr) {
                qr_display_render(&s_dev, wifi_connect_get_ip());
                s_showingQr = true;
            }
        } else {
            render_status();
        }
        vTaskDelay(RENDER_PERIOD);
    }
}

} // namespace

void oled_status_start() {
    i2c_master_init(&s_dev, CONFIG_SDA_GPIO, CONFIG_SCL_GPIO, CONFIG_RESET_GPIO);
    ssd1306_init(&s_dev, 128, 64);
    ssd1306_clear_screen(&s_dev, false);
    // Attaches as a second device on the bus i2c_master_init() just created
    // -- see ina260.hpp's own doc comment on why this is the one place that
    // calls ina260_init(); everything else just calls ina260_is_available()/
    // ina260_read().
    s_ina260Ok = ina260_init(s_dev._i2c_bus_handle);
    button_start();
    xTaskCreate(oled_task_body, "oled", 3072, nullptr, 1, nullptr);
}
