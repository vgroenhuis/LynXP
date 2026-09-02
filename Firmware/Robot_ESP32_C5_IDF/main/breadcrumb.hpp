#pragma once

#include <cstdint>

// Crash-breadcrumb logging: persists minimal "where was execution" markers
// into RTC slow memory (RTC_NOINIT_ATTR), which survives a watchdog/panic
// reset -- the ESP32 equivalent of Robot_Pico2W_SDK/src/breadcrumb.cpp's
// watchdog-scratch-register approach. If the task watchdog recovers from a
// genuine hang, the NEXT boot can read out roughly where each task was
// stuck.
//
// Unlike the Pico version there's no register scarcity here (RTC slow
// memory is 8KB, not 4 spare 32-bit words), so this drops that version's
// bit-packed conn counts and 4-character-truncated WS message type in
// favour of plain fields.
//
// "core0"/"core1" in the names below are historical -- on the ESP32-S3 this
// port originally targeted, control_task.cpp really was pinned to a second
// physical core. The ESP32-C5 this now runs on is single-core, so both
// tracks share the same core; the names just distinguish two different
// TASKS now (control_task.cpp's 1kHz loop vs. ws_poll_task's network work),
// not two physical cores. Kept as-is rather than renamed throughout, since
// these are read by name from /params and the web UI. Core1Checkpoint's
// members map 1:1 to control_modes.cpp's real algorithm phases; Core0Checkpoint's
// match ws_poll_task's phases (see ws_broadcast.cpp).

enum Core0Checkpoint {
    CORE0_CP_BOOT = 0,
    CORE0_CP_POLL_LOOP_START,
    CORE0_CP_CONTROL_FRAME,
    CORE0_CP_SERVO_FOLLOW,
    CORE0_CP_DRIVE_WATCHDOG,
    CORE0_CP_PONG,
    CORE0_CP_POSE_BROADCAST,
    CORE0_CP_SYSSTATS_BROADCAST,
    CORE0_CP_LOOP_END,
};

enum Core1Checkpoint {
    CORE1_CP_BOOT = 0,
    CORE1_CP_TICK_START,
    CORE1_CP_ENCODER_DERIVATIVES,
    CORE1_CP_WHEEL_TELEMETRY,
    CORE1_CP_MODE_TOUCHPAD,
    CORE1_CP_MODE_LAB1,
    CORE1_CP_MODE_LAB2,
    CORE1_CP_MODE_CONTROL_FRAME,
    CORE1_CP_MODE_GOTO,
    CORE1_CP_MODE_DEADZONE_CAL,
    CORE1_CP_MODE_MANUAL_VEL,
    CORE1_CP_MODE_ENCODER_CAL,
    CORE1_CP_MODE_OTHER,
    CORE1_CP_LOGGING,
    CORE1_CP_ODOMETRY,
    CORE1_CP_RESET_HANDLING,
    CORE1_CP_RUN_MOTOR,
    CORE1_CP_TICK_END,
};

void breadcrumb_mark_core0(Core0Checkpoint cp);
void breadcrumb_mark_core1(Core1Checkpoint cp);

// Same as breadcrumb_mark_core0(), but also records the current WS
// connection counts. Reserved for the ONE checkpoint most useful for a hang
// investigation (CORE0_CP_POLL_LOOP_START) -- walking the client list on
// every mark would defeat the "practically free" property the rest of this
// file relies on.
void breadcrumb_mark_core0_with_conns(Core0Checkpoint cp, int totalConns, int wsConns);

// Records the WS message type currently being handled, so a hang triggered
// from inside a specific message handler is visible even though the core0
// checkpoint alone would just say "inside the poll loop" or similar.
void breadcrumb_mark_ws_message(const char *type);

struct BreadcrumbSnapshot {
    int core0Checkpoint;
    int core1Checkpoint;
    char lastWsMessageType[16];
    uint32_t core1TickCountAtLastMark;
    int core0TotalConns;
    int core0WsConns;
};

// Call once, early in app_main() -- before any breadcrumb_mark_*() call in
// this new session overwrites the RTC-memory fields. Caches what the
// PREVIOUS session last wrote, for the rest of this session's lifetime.
// Only meaningful when watchdog_last_reboot_was_hang() is true --
// otherwise these are stale leftovers from an earlier hang, or all-zero
// (magic word absent) on a genuine first power-on.
void breadcrumb_capture_boot_snapshot();
const BreadcrumbSnapshot &breadcrumb_get_boot_snapshot();

// Human-readable names, for /params and the UI.
const char *breadcrumb_core0_checkpoint_name(int cp);
const char *breadcrumb_core1_checkpoint_name(int cp);
