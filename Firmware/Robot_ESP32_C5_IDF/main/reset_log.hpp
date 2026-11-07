#pragma once

// Reset history: why the previous runs ended, in more detail than
// esp_reset_reason() gives -- for the hangs that end in a hardware-level
// watchdog ("other watchdog timeout"), where neither the task watchdog's
// record (watchdog.cpp) nor a panic message survives.
//
// What's kept across a reset, in RTC memory:
//   - the last task switches (the "flight recorder": every context switch,
//     via cpu_trace.c's hook), so the task that had the CPU when everything
//     stopped is known, with the time of that switch;
//   - once a second: the uptime and the internal RAM free / lowest free, and
//     a handle -> name table of the tasks (names can't be looked up safely
//     inside the context switch);
//   - the last network step (reset_log_net: Wi-Fi events, the HTTPS reports);
//   - a panic's reason, program counter and return address (the panic
//     handler is wrapped, see CMakeLists.txt: --wrap=esp_panic_handler).
// At the next start that's turned into one entry -- with the chip's own
// reset cause (RTC watchdog, super watchdog, ...), the breadcrumbs and the
// task watchdog's record -- and the last RESET_LOG_ENTRIES entries are kept
// in NVS: GET /resets lists them, newest first.

#define RESET_LOG_ENTRIES 8

// As early as possible in app_main(): after breadcrumb_capture_boot_snapshot()
// and watchdog_capture_boot(), before any task is started. Reads what the
// previous run left and starts recording for this one.
void reset_log_capture();

// After nvs_flash_init(): adds this start to the history in NVS.
void reset_log_store();

// Once a second (the health task): uptime, RAM, the task name table.
void reset_log_live();

// The network step now (a short constant string): kept with its time, so a
// hang shows what the network side was doing last.
void reset_log_net(const char *step);

// One line about how the previous run ended -- "" after a plain power-on,
// reset button, update or reflash.
const char *reset_log_summary();

// GET /resets (after web_server_init()).
void reset_log_register_routes();
