#pragma once

extern "C" {
#include "ssd1306.h"
}

// Renders a full-screen QR code linking to http://<ip>/. The S3 CAM's own
// IP never needs to be passed along here -- the C5 already learns it live
// over the UART link (uart_link.cpp) the moment the cam starts reporting,
// independent of which device loads the page or how. Caller must only pass
// a real connected `ip` (not "0.0.0.0"). Ported from
// Test_ESP32_C5_IDF_for_S3_CAM/main/qr_display.c.
void qr_display_render(SSD1306_t *dev, const char *ip);

// Renders a full-screen "join this WiFi network" QR code for an open network
// (the standard WIFI:T:nopass;S:...;; payload phone cameras understand) --
// used for the setup hotspot, so joining it is one scan.
void qr_display_render_wifi_join(SSD1306_t *dev, const char *ssid);
