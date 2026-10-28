#pragma once

#include "driver/gpio.h"

// Single source of truth for this wheeled robot's wiring on the Waveshare
// ESP32-C5-WIFI6-KIT-N16R8-M (DevKitC-1-compatible pinout). Pin map is the
// bench-verified one from Test_ESP32_C5_Robot_Peripherals (motors/encoders/
// servos all confirmed correct on real hardware -- see that project's own
// board_pins.hpp for the full strapping-pin/PSRAM-pin research this is
// based on); MOTOR_TRANSMISSION_RATIO/ENCODER_COUNTS_PER_REVOLUTION are
// carried over from Robot_ESP32_S3_IDF's board_pins.hpp as a PLACEHOLDER --
// this robot's actual gearbox/encoder spec hasn't been confirmed, so
// odometry/PID distance and velocity units will be correctly *computed* but
// wrongly *scaled* until these are corrected, the same way MOTOR_INVERT
// started as a guess and got fixed empirically during bring-up.
//
// ESP32-C5 strapping pins, per the official ESP-IDF GPIO guide: GPIO2,
// GPIO7, GPIO25, GPIO27, GPIO28 -- see Test_ESP32_C5_Robot_Peripherals's
// board_pins.hpp for the full reasoning on why each one used below is safe.
// Also reserved: GPIO16-22 (SPI flash/PSRAM) and GPIO13/14 (USB-JTAG).
// GPIO15 is additionally unavailable on this specific N16R8 module (wired to
// its octal PSRAM, confirmed via board silkscreen).

// ---------------------------------------------------------------------------
// Motor driver: TB6612FNG dual H-bridge
// ---------------------------------------------------------------------------
// STBY is hardwired to +3.3V (always enabled). PWM rides on the dedicated
// PWM pin only (PWMA/PWMB); AIN1/AIN2, BIN1/BIN2 are plain static direction
// outputs. AO1/AO2 -> RIGHT motor, BO1/BO2 -> LEFT motor.

constexpr int WHEEL_LEFT = 0;
constexpr int WHEEL_RIGHT = 1;

constexpr gpio_num_t MOTOR_ENABLE_PIN[2] = {
    GPIO_NUM_0, // left  = PWMB
    GPIO_NUM_9, // right = PWMA
};

constexpr gpio_num_t MOTOR_DIR_PIN[2][2] = {
    {GPIO_NUM_6, GPIO_NUM_1}, // left  = BIN1, BIN2
    {GPIO_NUM_7, GPIO_NUM_8}, // right = AIN1, AIN2
};

// Confirmed empirically at the Test_ESP32_C5_Robot_Peripherals bench test:
// the right wheel needed inverting (mirrored motor mounting).
constexpr bool MOTOR_INVERT[2] = {false, true};

constexpr int MOTOR_PWM_FREQ_HZ = 20000;

// ---------------------------------------------------------------------------
// Quadrature encoders -- decoded in hardware by the PCNT peripheral
// ---------------------------------------------------------------------------
constexpr gpio_num_t ENCODER_PIN[2][2] = {
    {GPIO_NUM_26, GPIO_NUM_25}, // left  A/B
    {GPIO_NUM_24, GPIO_NUM_23}, // right A/B
};

// Confirmed empirically: both raw counts already track true physical
// rotation correctly once MOTOR_INVERT above is applied -- no sign flip
// needed on either wheel.
constexpr int ENCODER_SIGN[2] = {+1, +1};

// PLACEHOLDER -- copied from Robot_ESP32_S3_IDF's board_pins.hpp, NOT
// verified for this robot's actual motors/gearbox/encoders. Odometry and
// PID distance/velocity units are wrong (but the code runs fine) until this
// is measured and corrected on this hardware.
constexpr int MOTOR_TRANSMISSION_RATIO = 30;
constexpr int ENCODER_COUNTS_PER_REVOLUTION = 48; // on the motor axis, not the wheel axis

// ---------------------------------------------------------------------------
// Pan/tilt servos
// ---------------------------------------------------------------------------
// Pan was originally on GPIO28 (one of the ESP32-C5's boot-mode strapping
// pins) and visibly, randomly rotated CW or CCW at every boot -- confirmed
// on real hardware to be happening before app_main() even runs (a
// motors_force_safe_state() fix covering the ~500ms app_main-to-motors_init()
// gap did not help, and neither did an external pull-up on the signal line),
// consistent with noise during the ROM/2nd-stage-bootloader's own strap
// sampling window, which no application-level fix can reach. Moved to
// GPIO5 -- not a strapping pin, so there's no boot-time sampling window for
// noise to be misread as a rotation command. The camera link's output on
// GPIO28 (CAM_SPI_CS_PIN below, formerly the UART TX) took its place, since
// a line floating/glitching briefly before boot has no visible or functional
// consequence there (see its own comment).
// Requires physically swapping which header pin the pan servo and the CAM
// UART TX wire are each connected to, not just this software change.
constexpr gpio_num_t SERVO_PIN = GPIO_NUM_5;        // pan
constexpr gpio_num_t TILT_SERVO_PIN = GPIO_NUM_10;  // tilt
constexpr int SERVO_PWM_FREQ_HZ = 50;

// ---------------------------------------------------------------------------
// QR-display pushbutton
// ---------------------------------------------------------------------------
// Pulled-up GPIO input, wired to GND -- shared with the onboard RGB LED
// (WS2812), the status light: button.cpp turns the pin into the LED's data
// output only for the moment a new colour is sent (status_led.cpp), as in
// the bring-up test project.
constexpr gpio_num_t QR_BUTTON_PIN = GPIO_NUM_27;

// ---------------------------------------------------------------------------
// S3-CAM link: SPI, this board is the master (cam_link.cpp, cam_link_proto.h)
// ---------------------------------------------------------------------------
// Replaces the old UART link (GPIO4 RX / GPIO28 TX), so that camera frames can
// later be streamed through this board's own (5 GHz capable) Wi-Fi. Four
// signals plus power, on the XIAO ESP32-S3 Sense's header (cam side:
// ESP32_S3_CAM_IDF/main/main.c, STATUS_SPI_* pins):
//
//   this board              cam (XIAO ESP32-S3 Sense)
//   GPIO14  SCLK   ------>  D9  = GPIO8   SCLK   (new wire, on the USB D+ pin)
//   GPIO13  MOSI   ------>  D10 = GPIO9   MOSI   (new wire, on the USB D- pin)
//   GPIO4   MISO   <------  D0  = GPIO1   MISO   (the old UART wire, same direction)
//   GPIO28  CS     ------>  D1  = GPIO2   CS     (the old UART wire, same direction)
//   5 V and GND as before (the cam's 5 V pin)
//
// GPIO4 and GPIO28 are the pins the UART used. GPIO13/14 are the native USB
// pins: that port now only powers the board; the console (logs, bench
// console) and flashing go through the dev kit's UART/CH343 port. GPIO28 is a
// boot-mode strapping pin: it is only ever an output here, and the cam's
// pull-up on CS keeps it high at reset.
// 1.0.7: SCLK and MOSI moved from GPIO11/12 (the UART0 pins) to GPIO14/13,
// the native USB pins (the USB-Serial-JTAG is off, sdkconfig.defaults): the
// dev kit's CH343 USB-serial chip drives GPIO12 (U0RXD) whenever the board has
// 5 V, so MOSI there fought it and no frame got through (1.0.6 test: with MOSI
// left off, 292 of 293 frames from the camera were valid). The console is
// back on UART0 / the CH343 port. Mode 3 (clock idles high) and CS driven by
// hand with setup time, see cam_link.cpp.
constexpr gpio_num_t CAM_SPI_SCLK_PIN = GPIO_NUM_14;
constexpr gpio_num_t CAM_SPI_MOSI_PIN = GPIO_NUM_13;
constexpr gpio_num_t CAM_SPI_MISO_PIN = GPIO_NUM_4;
constexpr gpio_num_t CAM_SPI_CS_PIN = GPIO_NUM_28;

// ---------------------------------------------------------------------------
// INA260 high-side current/voltage sensor -- attaches as a second device on
// the OLED's existing I2C bus (see oled.cpp), not its own bus.
// ---------------------------------------------------------------------------
constexpr uint8_t INA260_I2C_ADDR = 0x40;

// ---------------------------------------------------------------------------
// Control loop
// ---------------------------------------------------------------------------
constexpr uint32_t TIMER_INTERVAL_US = 1000; // 1 kHz, board-agnostic
