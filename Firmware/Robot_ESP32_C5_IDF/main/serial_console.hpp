#pragma once

// Milestone-B bench-test console: a stand-in for the WebSocket control
// channel, so the hardware layer (motors, encoders, servo) can be exercised
// on real hardware before Wi-Fi/HTTP exist at all. Ported in spirit from
// Robot_Pico2W_SDK's main.cpp handle_test_serial_command()/
// poll_serial_console(), but restructured as a blocking-read FreeRTOS task
// rather than a non-blocking poll -- the Pico version had to be non-blocking
// because it shared a single core0 superloop with Mongoose; here the console
// can simply own its own task and block on each line.
//
// Superseded once the full WebSocket API exists (milestone D), but left in
// place afterwards: it is a useful bench tool independent of Wi-Fi being up.

// Starts the console task. Call once from app_main(), after motors_init(),
// encoders_init() and control_task_start().
void serial_console_start();
