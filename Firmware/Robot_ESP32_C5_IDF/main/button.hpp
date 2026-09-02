#pragma once

// Debounced poll task for the QR_BUTTON_PIN pushbutton (board_pins.hpp),
// wired to GND. Ported from Test_ESP32_C5_IDF_for_S3_CAM/main/button.c.

// Configures the GPIO and starts the debounce task. Call once from
// app_main().
void button_start();

// Debounced current state -- true while held down.
bool button_is_pressed();
