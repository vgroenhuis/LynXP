#pragma once

#include <cstdint>

// The board's onboard RGB LED (WS2812 on QR_BUTTON_PIN -- shared with the
// QR pushbutton, see button.cpp, which owns the pin and writes the colour
// this picks). What it shows, most important first:
//
//   cyan, flashing fast    firmware / filesystem update being written
//   red, flashing          the last restart was a crash, hang or brownout
//                          (for the first 30 s after booting)
//   red                    the camera (S3) has stopped reporting over the
//                          serial link (dead, unpowered, cable loose)
//   purple, breathing      no known network in reach: the setup hotspot is on
//   orange, flashing       connecting to WiFi -- this board or the camera
//   green                  connected, someone's using it (a web page open on
//                          the robot, or the camera stream being watched)
//   blue                   connected, nobody using it
//
// (The LED can't change while the button is held: the button shorts its
// data line.)

struct StatusLedColor {
    uint8_t r, g, b;
};

// The colour to show at nowMs (blinking and breathing included).
StatusLedColor status_led_color(uint32_t nowMs);

// A firmware / filesystem update is being received (ota.cpp).
void status_led_set_updating(bool updating);
