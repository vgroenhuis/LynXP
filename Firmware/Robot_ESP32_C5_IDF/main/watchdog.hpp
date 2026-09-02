#pragma once

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// Replaces Robot_Pico2W_SDK/src/watchdog.cpp's hand-rolled hardware
// watchdog (fed by core0 only while core1's tick counter kept advancing --
// a liveness proof for both cores) with ESP-IDF's native task watchdog:
// esp_task_wdt is already auto-initialized by CONFIG_ESP_TASK_WDT_INIT=y in
// sdkconfig.defaults (3s timeout, panic-and-reboot on expiry). Subscribing
// BOTH the control task and the ws_poll task directly gives the same "a
// hang on either one reboots the chip" property for free, without needing
// separate liveness-proof plumbing -- each subscribed task just needs to
// call esp_task_wdt_reset() from within its own loop (control_task.cpp and
// ws_broadcast.cpp already do).

// Subscribes both tasks to the already-running task watchdog. Call once
// from app_main(), after both tasks have been created. pollTask may be
// nullptr (e.g. before ws_broadcast.cpp exists) -- only ctrlTask is
// required.
void watchdog_system_init(TaskHandle_t ctrlTask, TaskHandle_t pollTask);

// Wi-Fi/HTTP bring-up between task creation and watchdog_system_init() takes
// over a second, during which control_task.cpp/ws_broadcast.cpp were
// already calling esp_task_wdt_reset() every tick -- each call failed with
// a logged error ("task not found") since neither task was subscribed yet,
// flooding the boot log. Both loops check this before calling reset(), so
// the calls are simply skipped (not logged, not an error) until
// watchdog_system_init() actually runs.
bool watchdog_is_ready();

// True only for a genuine watchdog-timeout or panic hang recovery --
// distinguished from a USB/JTAG reflash, power-on, or reset-button press.
// Drives the UI's big warning banner.
bool watchdog_last_reboot_was_hang();

// Human-readable reason for the most recent boot, for the CPU/memory stats
// panel -- shown regardless of whether it was a hang, so the operator can
// always see why the robot last restarted.
const char *watchdog_last_reboot_reason_string();
