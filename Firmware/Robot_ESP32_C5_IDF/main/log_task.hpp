#pragma once

#include <cstddef>

// Non-blocking logging for control_modes.cpp's CSV data-logging feature
// (settings.loggingEnabled). On the Pico, printf() from inside the 1 kHz
// timer ISR was already a bit dicey but tolerated; on ESP32-S3 printf() to
// USB-Serial-JTAG genuinely BLOCKS when nothing is draining the endpoint
// (no serial monitor attached), which would stall controlModesTick() --
// now running in a real task, not an ISR, but still the control loop --
// for however long the write sits waiting. The control task only ever
// formats a line (snprintf, no I/O) and hands it off here; the actual
// printf happens on a separate, low-priority task, and a full queue just
// silently drops the newest sample rather than blocking anyone.

constexpr size_t LOG_LINE_MAX_LEN = 128;

// Creates the queue and starts the log-printing task. Call once from
// app_main().
void log_task_start();

// Enqueues a pre-formatted, NUL-terminated line (max LOG_LINE_MAX_LEN-1
// bytes) for the log task to print. Never blocks the caller; silently drops
// the line if the queue is full.
void log_task_submit(const char *line);
