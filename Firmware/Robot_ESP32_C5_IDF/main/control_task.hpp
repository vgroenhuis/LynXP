#pragma once

#include <cstdint>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// The 1 kHz control loop. Ported from Robot_ESP32_S3_IDF/main/control_task.hpp,
// which pinned this task to the S3's second CPU core specifically to isolate
// its float-heavy tick (controlModesTick() and everything it calls --
// odometry's wrapToPi(), the PID/goto controllers -- is dense sinf/cosf/
// atan2f math) from WiFi/HTTP work on the other core. The ESP32-C5 is
// single-core (boots as "Unicore app"), so that isolation is no longer
// physically possible: this task now time-shares the one core with
// everything else the firmware runs. It stays the highest-priority task in
// the app (see CONTROL_TASK_PRIORITY below) so it still preempts other work
// for its brief per-tick execution, which is what actually protects its
// timing -- the core split was a nice-to-have on top of that, not the only
// thing keeping the loop on schedule.
//
// The gptimer-ISR-notifies-a-task shape itself is kept regardless: a gptimer
// fires a 1 kHz alarm whose ISR does nothing but notify this task, and the
// task -- not the ISR -- runs controlModesTick(). This is still the right
// design even without the S3's specific Xtensa FPU-in-ISR concern, because
// it keeps the ISR body trivially short (good practice generally) and
// because ulTaskNotifyTake(pdTRUE, ...) collapses any backlog (e.g. from an
// NVS commit stalling the flash cache) into a single wakeup instead of
// running catch-up iterations with a stale dt -- which is why
// TIMER_INTERVAL_US stays a fixed compile-time 1000 rather than needing a
// measured dt.

// Creates the control task and starts the gptimer that drives it. Call once
// from app_main(), after motors_init() and encoders_init().
void control_task_start();

// For watchdog_system_init()/diagnostics_register_tasks() to subscribe/
// measure this task. Valid only after control_task_start() returns.
TaskHandle_t control_task_get_handle();

// The stack size (bytes) control_task_start() actually created the task
// with -- diagnostics_register_tasks() needs this alongside the handle.
constexpr uint32_t CONTROL_TASK_STACK_BYTES = 8192;

// Ticks actually executed since boot. Written only by the control task;
// read from any task (diagnostics, the watchdog liveness check).
extern volatile uint32_t g_controlTickCount;

// gptimer alarms that fired but were coalesced into a single
// ulTaskNotifyTake() wakeup (i.e. ticks the control task did not get to run
// individually) -- see the file comment. Surfaced in the diagnostics panel as
// a sign the loop is falling behind, e.g. during a long flash operation.
extern volatile uint32_t g_controlMissedTicks;

// -1000..1000, wheel 0 = left, 1 = right. Written by controlModesTick()'s
// mode dispatch (control_modes.cpp, called from this file's control task),
// read by the tick loop's motors_run() calls.
extern volatile int motorPower[2];

// Snapshot taken by the control task once per tick from encoders_read(), so
// the rest of the firmware sees a coherent, non-racing pair of counts instead
// of reading PCNT mid-update.
extern volatile long encoderCount_steps[2];

// Low-pass-filtered differentiator output (calcEncoderDerivatives() in
// control_modes.cpp), used for wheel velocity telemetry and the Lab2 PID's
// derivative term.
extern volatile float encoderCountDerivative_steps[2];
