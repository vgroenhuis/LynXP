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
// noise to be misread as a rotation command. CAM_UART_TX_PIN below moved to
// GPIO28 in exchange, since a UART TX line floating/glitching briefly before
// boot has no visible or functional consequence (see its own comment).
// Requires physically swapping which header pin the pan servo and the CAM
// UART TX wire are each connected to, not just this software change.
constexpr gpio_num_t SERVO_PIN = GPIO_NUM_5;        // pan
constexpr gpio_num_t TILT_SERVO_PIN = GPIO_NUM_10;  // tilt
constexpr int SERVO_PWM_FREQ_HZ = 50;

// ---------------------------------------------------------------------------
// QR-display pushbutton
// ---------------------------------------------------------------------------
// Plain pulled-up GPIO input, wired to GND -- unlike the bring-up test
// project, this pin is NOT shared with the onboard RGB LED here: the S3
// firmware being ported never drove that LED either (NEOPIXEL_PIN was
// defined but unused there too), so there's nothing to time-multiplex
// against. The LED stays available for a future feature.
constexpr gpio_num_t QR_BUTTON_PIN = GPIO_NUM_27;

// ---------------------------------------------------------------------------
// S3-CAM status UART link
// ---------------------------------------------------------------------------
// UART1 to an ESP32-S3-Sense camera module's D0/D1 header pins. On the cam
// side (ESP32_S3_CAM_IDF/main/main.c), D0=GPIO1=TX, D1=GPIO2=RX -- confirmed
// directly from that firmware's STATUS_UART_TX_GPIO/RX_GPIO. This board's
// wiring: cam D0 (TX) -> here GPIO4 (this board's RX); cam D1 (RX) -> here
// GPIO28 (this board's TX) -- moved from GPIO5 to trade places with the pan
// servo (see SERVO_PIN above). GPIO28 is a boot-mode strapping pin, but
// that's a non-issue here: this pin only ever needs to be an ESP32 OUTPUT
// (the cam firmware doesn't act on anything received on its own D1/RX per
// its own source), so even if it floats or glitches before uart_link_start()
// configures it, at worst a stray byte or two arrives at the camera before
// real communication begins, with no functional or visible consequence --
// nothing like a servo physically reacting to the same kind of noise.
constexpr gpio_num_t CAM_UART_RX_PIN = GPIO_NUM_4;
constexpr gpio_num_t CAM_UART_TX_PIN = GPIO_NUM_28;

// ---------------------------------------------------------------------------
// INA260 high-side current/voltage sensor -- attaches as a second device on
// the OLED's existing I2C bus (see oled.cpp), not its own bus.
// ---------------------------------------------------------------------------
constexpr uint8_t INA260_I2C_ADDR = 0x40;

// ---------------------------------------------------------------------------
// Control loop
// ---------------------------------------------------------------------------
constexpr uint32_t TIMER_INTERVAL_US = 1000; // 1 kHz, board-agnostic
