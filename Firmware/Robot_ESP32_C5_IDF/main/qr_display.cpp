#include "qr_display.hpp"

extern "C" {
#include "qrcode.h"
}

#include <cstdio>
#include <cstring>

// Builds a QR code for http://<ip>/ via the espressif/qrcode component and
// blits it as a full-screen 1bpp bitmap via ssd1306_bitmaps(). That call
// expects a row-major, MSB-first packed bitmap with width a multiple of 8 --
// 128 wide, one byte per 8 columns. Ported from
// Test_ESP32_C5_IDF_for_S3_CAM/main/qr_display.c.

namespace {

constexpr int QR_MAX_VERSION = 10; // way more than a "http://<ip>/" URL ever needs
// Spec recommends 4. This screen is only 64px tall, so the scale factor
// below (an integer floor of 64/totalModules) is extremely sensitive to
// this -- trimmed to 1 (rather than spec's recommended margin) to keep the
// per-module scale as large as possible on a small, high-contrast,
// close-range OLED, where it still scans fine.
constexpr int QR_QUIET_MODULES = 1;

constexpr int CANVAS_W = 128;
constexpr int CANVAS_H = 64;
constexpr int CANVAS_ROW_BYTES = CANVAS_W / 8;

uint8_t s_canvas[CANVAS_ROW_BYTES * CANVAS_H];
SSD1306_t *s_renderDev; // esp_qrcode_generate's callback only passes the qrcode handle

void render_callback(esp_qrcode_handle_t qrcode) {
    int qrSize = esp_qrcode_get_size(qrcode);
    int totalModules = qrSize + QR_QUIET_MODULES * 2;
    int scale = CANVAS_H / totalModules;
    if (scale < 1) scale = 1;
    int pxSize = totalModules * scale;
    int offX = (CANVAS_W - pxSize) / 2;
    int offY = (CANVAS_H - pxSize) / 2;

    std::memset(s_canvas, 0, sizeof(s_canvas));
    for (int my = 0; my < qrSize; my++) {
        for (int mx = 0; mx < qrSize; mx++) {
            if (!esp_qrcode_get_module(qrcode, mx, my)) continue;
            for (int dy = 0; dy < scale; dy++) {
                int y = offY + (my + QR_QUIET_MODULES) * scale + dy;
                if (y < 0 || y >= CANVAS_H) continue;
                for (int dx = 0; dx < scale; dx++) {
                    int x = offX + (mx + QR_QUIET_MODULES) * scale + dx;
                    if (x < 0 || x >= CANVAS_W) continue;
                    s_canvas[y * CANVAS_ROW_BYTES + x / 8] |= (0x80 >> (x % 8));
                }
            }
        }
    }

    ssd1306_bitmaps(s_renderDev, 0, 0, s_canvas, CANVAS_W, CANVAS_H, false);
}

} // namespace

void qr_display_render(SSD1306_t *dev, const char *ip) {
    char url[64];
    std::snprintf(url, sizeof(url), "http://%s/", ip);

    s_renderDev = dev;
    esp_qrcode_config_t cfg = ESP_QRCODE_CONFIG_DEFAULT();
    cfg.display_func = render_callback;
    cfg.max_qrcode_version = QR_MAX_VERSION;
    cfg.qrcode_ecc_level = ESP_QRCODE_ECC_LOW;
    esp_qrcode_generate(&cfg, url);
}
