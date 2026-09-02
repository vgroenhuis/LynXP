#pragma once

// SSD1306 128x64 status display, I2C on GPIO2(SDA)/GPIO3(SCL) -- see
// sdkconfig.defaults for the Kconfig-driven pin config. Shows this robot's
// name, its MAC address until wifi_connect.cpp reports a connection (useful
// for registering the MAC on networks that require it) and its IP address
// from then on, and live voltage/current from the INA260 current sensor
// (attached as a second device on this same I2C bus -- see ina260.cpp).
// Holding the QR button once connected shows a QR code linking to the web UI.

// Initializes the I2C bus + SSD1306 panel + INA260, and starts a
// low-priority background task that keeps the screen in sync with
// wifi_connect.hpp's state. Call once from app_main(), after
// wifi_connect_start() so an IP can already be known for the first frame.
void oled_status_start();
