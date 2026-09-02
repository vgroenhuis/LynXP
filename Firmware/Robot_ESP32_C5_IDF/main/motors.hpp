#pragma once

#include <cstdint>

// TB6612FNG dual-motor driver + pan/tilt servos, all via LEDC PWM. See
// board_pins.hpp for the pin map and WHEEL_LEFT/WHEEL_RIGHT indices.

// Forces every motor AND servo GPIO to a known-low output. Call as the very
// first thing in app_main(), before anything else: the TB6612's
// direction/PWM inputs and both servo signal lines all float on reset, and
// the ROM bootloader runs for a while before app_main is even reached --
// this closes the window from here on (including every future reboot),
// though it can't cover the ROM window itself (only external pulldowns on
// the pins do that). Also closes the ~500ms gap between here and
// motors_init() actually configuring LEDC on the servo pins -- without this,
// SERVO_PIN sat completely undriven that whole time, visibly twitching the
// pan servo once LEDC finally claimed it. motors_init() re-does the same
// GPIO config as part of its own setup, so calling this first is about
// closing the gap before motors_init() runs, not a substitute for it.
void motors_force_safe_state();

void motors_init();

// power in [-1000, 1000]; sign is direction, magnitude/1000 is duty cycle.
void motors_run(int power, int wheel);
void motors_coast_all();

void servo_set_pulse_us(uint16_t pulse_us);
void tilt_servo_set_pulse_us(uint16_t pulse_us);

// Last commanded duty, for serial_console.cpp's diagnostic printing.
uint32_t servo_last_duty();
uint32_t tilt_servo_last_duty();
