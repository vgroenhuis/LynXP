#include "oled.hpp"
#include "wifi_connect.hpp"
#include "button.hpp"
#include "qr_display.hpp"
#include "ina260.hpp"
#include "uart_link.hpp"

extern "C" {
#include "ssd1306.h"
#include "u8g2.h"
}

#include "driver/i2c_master.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <cstdio>
#include <cstring>

// Status screen on the 128x64 SSD1306. Laid out around what someone standing
// next to the robot actually needs to read: the robot's IP address, as big as
// it will fit, with the supporting details (network name, battery, camera)
// in smaller proportional fonts around it:
//
//   LynXP                    9.01 V  450 mA     <- header
//   ------------------------------------------
//   Mojca_Vincent_Reelaan3_5GHz                 <- network (scrolls if too long)
//   192.168.0.17                                <- robot IP, largest font that fits
//   ------------------------------------------
//   CAM 192.168.0.99                            <- camera (scrolls if too long)
//
// Offline it shows the MAC instead of the IP (handy for MAC allow-lists);
// with the setup hotspot up, the hotspot's name and the setup address.
//
// Drawing: u8g2 renders into an off-screen 1 KB page buffer (proportional
// and large fonts, clipping); the pixels then go out through the
// nopnop2002/ssd1306 component's I2C handle, which also owns the bus the
// INA260 shares. Only the 128-byte pages that changed since the last frame
// are sent, so a static screen costs no I2C traffic at all.

namespace {

SSD1306_t s_dev;
u8g2_t s_u8g2;
volatile bool s_paused = false; // diagnostics: no I2C traffic from this task at all
bool s_showingQr = false;
bool s_ina260Ok = false;
uint8_t s_sent[8][128];     // what the panel currently shows, per page
bool s_sentValid[8] = {};

// Also the button-response latency (the loop only notices a press on its next
// iteration). Rendering itself is cheap; I2C only happens for changed pages.
constexpr TickType_t RENDER_PERIOD = pdMS_TO_TICKS(40);
constexpr int64_t INA_PERIOD_US = 250 * 1000;

constexpr int W = 128;

// Largest first; the first one the text fits in wins.
const uint8_t *const DIGIT_FONTS[] = {
    u8g2_font_logisoso24_tn, u8g2_font_logisoso22_tn, u8g2_font_logisoso20_tn,
    u8g2_font_logisoso18_tn, u8g2_font_logisoso16_tn, u8g2_font_fub14_tn, u8g2_font_fub11_tn,
};
const uint8_t *const TEXT_FONTS[] = {
    u8g2_font_fub17_tr, u8g2_font_fub14_tr, u8g2_font_helvB14_tr, u8g2_font_helvB12_tr,
    u8g2_font_helvB10_tr, u8g2_font_helvB08_tr,
};

int64_t now_ms() { return esp_timer_get_time() / 1000; }

const uint8_t *pick_font(const uint8_t *const *fonts, size_t n, const char *text, int maxWidth) {
    for (size_t i = 0; i < n; i++) {
        u8g2_SetFont(&s_u8g2, fonts[i]);
        if (u8g2_GetStrWidth(&s_u8g2, text) <= maxWidth) return fonts[i];
    }
    return fonts[n - 1];
}

// Text in a horizontal band: centered if it fits, otherwise a marquee --
// hold the start 1.5 s, glide to the end, hold 1.5 s, jump back. Each band
// keeps its own scroll clock, restarted whenever its text changes.
struct Marquee {
    char text[64] = "";
    int64_t startMs = 0;
};

void draw_band(Marquee &m, const uint8_t *font, const char *text, int baseline, bool center = true) {
    if (std::strncmp(m.text, text, sizeof(m.text) - 1) != 0) {
        std::snprintf(m.text, sizeof(m.text), "%s", text);
        m.startMs = now_ms();
    }
    u8g2_SetFont(&s_u8g2, font);
    int tw = u8g2_GetStrWidth(&s_u8g2, text);
    if (tw <= W) {
        u8g2_DrawStr(&s_u8g2, center ? (W - tw) / 2 : 0, baseline, text);
        return;
    }
    constexpr int HOLD_MS = 1500;
    constexpr int PX_PER_S = 30;
    int overflow = tw - W;
    int scrollMs = overflow * 1000 / PX_PER_S;
    int cycle = HOLD_MS + scrollMs + HOLD_MS;
    int t = (int) ((now_ms() - m.startMs) % cycle);
    int offset = t < HOLD_MS ? 0 : t < HOLD_MS + scrollMs ? (t - HOLD_MS) * PX_PER_S / 1000 : overflow;
    int ascent = u8g2_GetAscent(&s_u8g2);
    int descent = u8g2_GetDescent(&s_u8g2); // negative
    u8g2_SetClipWindow(&s_u8g2, 0, baseline - ascent, W, baseline - descent + 1);
    u8g2_DrawStr(&s_u8g2, -offset, baseline, text);
    u8g2_SetMaxClipWindow(&s_u8g2);
}

// Big centered line in the largest font that fits the width.
void draw_big(const uint8_t *const *fonts, size_t n, const char *text, int baseline) {
    const uint8_t *font = pick_font(fonts, n, text, W);
    u8g2_SetFont(&s_u8g2, font);
    u8g2_DrawStr(&s_u8g2, (W - u8g2_GetStrWidth(&s_u8g2, text)) / 2, baseline, text);
}

Marquee s_networkBand;
Marquee s_bottomBand;
char s_powerText[24] = "";
int64_t s_lastInaUs = 0;

void update_power_text() {
    int64_t now = esp_timer_get_time();
    if (s_powerText[0] && now - s_lastInaUs < INA_PERIOD_US) return;
    s_lastInaUs = now;
    float v, ma, mw;
    if (!s_ina260Ok) {
        std::snprintf(s_powerText, sizeof(s_powerText), "no INA260");
    } else if (ina260_read(&v, &ma, &mw)) {
        if (ma >= 1000) std::snprintf(s_powerText, sizeof(s_powerText), "%.2f V  %.2f A", v, ma / 1000);
        else std::snprintf(s_powerText, sizeof(s_powerText), "%.2f V  %.0f mA", v, ma);
    } else {
        std::snprintf(s_powerText, sizeof(s_powerText), "INA260 err");
    }
}

void compose() {
    u8g2_ClearBuffer(&s_u8g2);

    // Header: name left, power right.
    u8g2_SetFont(&s_u8g2, u8g2_font_helvB08_tr);
    u8g2_DrawStr(&s_u8g2, 0, 8, "LynXP");
    update_power_text();
    u8g2_SetFont(&s_u8g2, u8g2_font_helvR08_tr);
    u8g2_DrawStr(&s_u8g2, W - u8g2_GetStrWidth(&s_u8g2, s_powerText), 8, s_powerText);
    u8g2_DrawHLine(&s_u8g2, 0, 10, W);

    WifiStatus st;
    wifi_get_status(&st);
    char line[64];

    if (st.connected) {
        draw_band(s_networkBand, u8g2_font_helvR08_tr, st.ssid, 20);
        draw_big(DIGIT_FONTS, sizeof(DIGIT_FONTS) / sizeof(DIGIT_FONTS[0]), st.ip, 46);
    } else if (st.apActive) {
        draw_band(s_networkBand, u8g2_font_helvR08_tr, "Setup hotspot -- no password:", 20);
        draw_big(TEXT_FONTS, sizeof(TEXT_FONTS) / sizeof(TEXT_FONTS[0]), wifi_ap_get_ssid(), 42);
    } else {
        if (st.connecting) std::snprintf(line, sizeof(line), "Connecting to %s...", st.connectingSsid);
        else std::snprintf(line, sizeof(line), "No WiFi -- looking for a saved network");
        draw_band(s_networkBand, u8g2_font_helvR08_tr, line, 20);
        // The MAC, for networks that need it registered before letting a device on.
        draw_big(TEXT_FONTS, sizeof(TEXT_FONTS) / sizeof(TEXT_FONTS[0]), wifi_connect_get_mac(), 40);
    }

    u8g2_DrawHLine(&s_u8g2, 0, 50, W);
    if (st.apActive && !st.connected) {
        draw_band(s_bottomBand, u8g2_font_helvB10_tr, "then open 192.168.4.1", 63);
    } else if (uart_link_peer_is_stale()) {
        draw_band(s_bottomBand, u8g2_font_helvR10_tr, "CAM  no link", 63);
    } else if (std::strcmp(uart_link_get_peer_ip(), "0.0.0.0") == 0) {
        std::snprintf(line, sizeof(line), "CAM  no WiFi -- MAC %s", uart_link_get_peer_mac());
        draw_band(s_bottomBand, u8g2_font_helvR10_tr, line, 63);
    } else {
        std::snprintf(line, sizeof(line), "CAM  %s", uart_link_get_peer_ip());
        draw_band(s_bottomBand, u8g2_font_helvB10_tr, line, 63);
    }
}

// u8g2's full buffer for this controller is already in SSD1306 page order
// (8 pages x 128 columns, one byte = 8 vertical pixels), so each page goes
// out as-is -- but only if it differs from what the panel already shows.
void flush() {
    const uint8_t *buf = u8g2_GetBufferPtr(&s_u8g2);
    for (int page = 0; page < 8; page++) {
        const uint8_t *p = buf + page * W;
        if (s_sentValid[page] && std::memcmp(p, s_sent[page], W) == 0) continue;
        ssd1306_display_image(&s_dev, page, 0, p, W);
        std::memcpy(s_sent[page], p, W);
        s_sentValid[page] = true;
    }
}

// The panel has no reset line wired, so it relies on its own power-on reset.
// On a cold start from the power bank the supply can still be ramping when
// the first init commands go out, leaving the display dark until the next
// warm reset. Re-sending the configuration once, a second in -- long after
// the supply has settled -- catches it once it's actually awake.
constexpr int64_t REINIT_AT_MS[] = {1000};

// Same configuration as nopnop2002/ssd1306's i2c_init() (128x64, not
// flipped), minus its leading "display off" -- so on a panel that's already
// running, resending it changes nothing visible (no flash), while a panel
// that missed the first init gets fully set up and switched on.
void wake_panel() {
    static const uint8_t CMDS[] = {
        0x00,             // control byte: command stream
        0xA8, 0x3F,       // multiplex ratio: 64 rows
        0xD3, 0x00,       // display offset 0
        0x40,             // start line 0
        0xA1,             // segment remap
        0xC8,             // COM scan direction
        0xD5, 0x80,       // clock divide
        0xDA, 0x12,       // COM pins
        0x81, 0xFF,       // contrast
        0xA4,             // display follows RAM
        0xDB, 0x40,       // VCOMH deselect
        0x20, 0x02,       // page addressing mode
        0x00, 0x10,       // column start
        0x8D, 0x14,       // charge pump on
        0x2E,             // scrolling off
        0xA6,             // normal (not inverted)
        0xAF,             // display on
    };
    i2c_master_transmit(s_dev._i2c_dev_handle, CMDS, sizeof(CMDS), 100);
}

void oled_task_body(void *arg) {
    (void) arg;
    const int64_t startMs = now_ms();
    size_t reinitsDone = 0;
    while (true) {
        if (reinitsDone < sizeof(REINIT_AT_MS) / sizeof(REINIT_AT_MS[0]) && now_ms() - startMs >= REINIT_AT_MS[reinitsDone]) {
            wake_panel();
            std::memset(s_sentValid, 0, sizeof(s_sentValid)); // resend every page
            reinitsDone++;
        }
        if (s_paused) {
            vTaskDelay(RENDER_PERIOD);
            continue;
        }
        bool connected = wifi_is_connected();
        bool apActive = wifi_ap_is_active();
        // Connected: a QR linking to the web UI. Offline with the setup
        // hotspot up: a QR that joins the hotspot (the captive portal then
        // opens the setup page). Neither: nothing useful to encode.
        if (button_is_pressed() && (connected || apActive)) {
            // Regenerating and re-blitting the QR bitmap is far more
            // expensive than a status redraw -- done once on the press edge,
            // not every frame while the button stays held.
            if (!s_showingQr) {
                if (connected) qr_display_render(&s_dev, wifi_connect_get_ip());
                else qr_display_render_wifi_join(&s_dev, wifi_ap_get_ssid());
                s_showingQr = true;
                std::memset(s_sentValid, 0, sizeof(s_sentValid)); // the panel no longer shows the status screen
            }
        } else {
            s_showingQr = false;
            compose();
            flush();
        }
        vTaskDelay(RENDER_PERIOD);
    }
}

} // namespace

void oled_set_paused(bool paused) {
    s_paused = paused;
    if (!paused) std::memset(s_sentValid, 0, sizeof(s_sentValid)); // full redraw on resume
}

void oled_status_start() {
    i2c_master_init(&s_dev, CONFIG_SDA_GPIO, CONFIG_SCL_GPIO, CONFIG_RESET_GPIO);
    ssd1306_init(&s_dev, 128, 64);
    ssd1306_clear_screen(&s_dev, false);
    // Off-screen only: the dummy callbacks mean u8g2 never touches a bus.
    u8g2_Setup_ssd1306_i2c_128x64_noname_f(&s_u8g2, U8G2_R0, u8x8_dummy_cb, u8x8_dummy_cb);
    // Attaches as a second device on the bus i2c_master_init() just created
    // -- see ina260.hpp's own doc comment on why this is the one place that
    // calls ina260_init(); everything else just calls ina260_is_available()/
    // ina260_read().
    s_ina260Ok = ina260_init(s_dev._i2c_bus_handle);
    button_start();
    xTaskCreate(oled_task_body, "oled", 4096, nullptr, 1, nullptr);
}
