#include "breadcrumb.hpp"
#include "control_task.hpp"

#include "esp_attr.h"

#include <cstring>

namespace {

// RTC slow memory is undefined after a genuine power-on (and possibly after
// a brownout, if the RTC domain itself drops), so every read of g_rtc must
// be gated on this magic word rather than trusted directly.
constexpr uint32_t BREADCRUMB_MAGIC = 0xB0BB1E5A;

struct RtcBreadcrumbData {
    uint32_t magic;
    int core0Checkpoint;
    int core1Checkpoint;
    char lastWsMessageType[16];
    uint32_t core1TickCountAtLastMark;
    int core0TotalConns;
    int core0WsConns;
};

RTC_NOINIT_ATTR RtcBreadcrumbData g_rtc;

BreadcrumbSnapshot g_bootSnapshot;

// The magic word only proves the STRUCT has been touched since the RTC
// domain last truly lost power -- it says nothing about any individual
// field that hasn't been written yet this session. Confirmed on this
// board's very first-ever boot: breadcrumb_mark_core1(CORE1_CP_BOOT) sets
// magic immediately (control_task.cpp's first call), but lastWsMessageType
// is only ever written by breadcrumb_mark_ws_message() -- which hadn't run
// yet (no WS message had arrived), so it still held genuinely undefined RTC
// memory noise (a raw 0x1F control byte, in this case) even though the
// struct as a whole now read as "magic-valid." That leaked straight into
// /params' JSON via lastHangWsMessage and broke JSON.parse() in the
// browser. Fix: zero the WHOLE struct the first time any mark function
// notices the magic word isn't set yet, before setting it and writing the
// field that call actually cares about -- so every field neither mark
// function writes together starts from a safe, empty value.
void ensure_rtc_initialized() {
    if (g_rtc.magic != BREADCRUMB_MAGIC) {
        std::memset(&g_rtc, 0, sizeof(g_rtc));
        g_rtc.magic = BREADCRUMB_MAGIC;
    }
}

} // namespace

void breadcrumb_mark_core0(Core0Checkpoint cp) {
    ensure_rtc_initialized();
    g_rtc.core0Checkpoint = cp;
}

void breadcrumb_mark_core0_with_conns(Core0Checkpoint cp, int totalConns, int wsConns) {
    ensure_rtc_initialized();
    g_rtc.core0Checkpoint = cp;
    g_rtc.core0TotalConns = totalConns;
    g_rtc.core0WsConns = wsConns;
}

void breadcrumb_mark_core1(Core1Checkpoint cp) {
    ensure_rtc_initialized();
    g_rtc.core1Checkpoint = cp;
    g_rtc.core1TickCountAtLastMark = g_controlTickCount;
}

void breadcrumb_mark_ws_message(const char *type) {
    ensure_rtc_initialized();
    std::strncpy(g_rtc.lastWsMessageType, type, sizeof(g_rtc.lastWsMessageType) - 1);
    g_rtc.lastWsMessageType[sizeof(g_rtc.lastWsMessageType) - 1] = '\0';
}

void breadcrumb_capture_boot_snapshot() {
    if (g_rtc.magic == BREADCRUMB_MAGIC) {
        g_bootSnapshot.core0Checkpoint = g_rtc.core0Checkpoint;
        g_bootSnapshot.core1Checkpoint = g_rtc.core1Checkpoint;
        std::strncpy(g_bootSnapshot.lastWsMessageType, g_rtc.lastWsMessageType,
                     sizeof(g_bootSnapshot.lastWsMessageType) - 1);
        g_bootSnapshot.lastWsMessageType[sizeof(g_bootSnapshot.lastWsMessageType) - 1] = '\0';
        g_bootSnapshot.core1TickCountAtLastMark = g_rtc.core1TickCountAtLastMark;
        g_bootSnapshot.core0TotalConns = g_rtc.core0TotalConns;
        g_bootSnapshot.core0WsConns = g_rtc.core0WsConns;
    } else {
        std::memset(&g_bootSnapshot, 0, sizeof(g_bootSnapshot));
    }
}

const BreadcrumbSnapshot &breadcrumb_get_boot_snapshot() {
    return g_bootSnapshot;
}

const char *breadcrumb_core0_checkpoint_name(int cp) {
    switch (cp) {
        case CORE0_CP_BOOT: return "boot";
        case CORE0_CP_POLL_LOOP_START: return "poll_loop_start";
        case CORE0_CP_CONTROL_FRAME: return "control_frame";
        case CORE0_CP_SERVO_FOLLOW: return "servo_follow";
        case CORE0_CP_DRIVE_WATCHDOG: return "drive_watchdog";
        case CORE0_CP_PONG: return "pong";
        case CORE0_CP_POSE_BROADCAST: return "pose_broadcast";
        case CORE0_CP_SYSSTATS_BROADCAST: return "sysstats_broadcast";
        case CORE0_CP_LOOP_END: return "loop_end";
        default: return "unknown";
    }
}

const char *breadcrumb_core1_checkpoint_name(int cp) {
    switch (cp) {
        case CORE1_CP_BOOT: return "boot";
        case CORE1_CP_TICK_START: return "tick_start";
        case CORE1_CP_ENCODER_DERIVATIVES: return "encoder_derivatives";
        case CORE1_CP_WHEEL_TELEMETRY: return "wheel_telemetry";
        case CORE1_CP_MODE_TOUCHPAD: return "mode_touchpad";
        case CORE1_CP_MODE_LAB1: return "mode_lab1";
        case CORE1_CP_MODE_LAB2: return "mode_lab2";
        case CORE1_CP_MODE_CONTROL_FRAME: return "mode_control_frame";
        case CORE1_CP_MODE_GOTO: return "mode_goto";
        case CORE1_CP_MODE_DEADZONE_CAL: return "mode_deadzone_cal";
        case CORE1_CP_MODE_MANUAL_VEL: return "mode_manual_vel";
        case CORE1_CP_MODE_ENCODER_CAL: return "mode_encoder_cal";
        case CORE1_CP_MODE_OTHER: return "mode_other";
        case CORE1_CP_LOGGING: return "logging";
        case CORE1_CP_ODOMETRY: return "odometry";
        case CORE1_CP_RESET_HANDLING: return "reset_handling";
        case CORE1_CP_RUN_MOTOR: return "run_motor";
        case CORE1_CP_TICK_END: return "tick_end";
        default: return "unknown";
    }
}
