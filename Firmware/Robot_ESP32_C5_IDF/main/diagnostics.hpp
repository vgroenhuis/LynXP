#pragma once

#include <cstdint>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// CPU/heap/stack telemetry for the sysstats WS broadcast (ws_broadcast.cpp)
// and /params. Field names match Robot_Pico2W_SDK/src/diagnostics.hpp
// exactly. "core0"/"core1" here are historical names for two TASKS, not
// physical cores: this originally ran on the dual-core ESP32-S3, where
// control_task.cpp really was pinned to a second core; on the single-core
// ESP32-C5 this now targets, both tracks share the one core. "core1" tracks
// control_task.cpp's 1kHz loop, "core0" tracks ws_poll_task specifically
// (not literally "everything on core 0"). Kept as-is rather than renamed,
// since these are read by name from /params and the web UI.
//
// Unlike the Pico version, stack usage here is a TRUE historical high-water
// mark (uxTaskGetStackHighWaterMark), not a snapshot of current depth --
// strictly more useful, and heapCeilingBytes is esp_get_minimum_free_heap_size()
// (the all-time low point), also strictly more informative than a fixed
// linker-symbol ceiling.

struct DiagnosticsSnapshot {
    float core0HzMeasured;
    uint32_t core0TickAvgUs;
    uint32_t core0TickMaxUs;
    float core1HzMeasured;
    uint32_t core1TickAvgUs;
    uint32_t core1TickMaxUs;

    uint32_t heapArenaBytes;
    uint32_t heapUsedBytes;
    uint32_t heapFreeBytes;
    uint32_t heapCeilingBytes;

    uint32_t core0StackUsedBytes;
    uint32_t core0StackTotalBytes;
    uint32_t core1StackUsedBytes;
    uint32_t core1StackTotalBytes;

    uint32_t totalRamBytes;
};

// Registers the task handles + declared stack sizes (in bytes, matching
// what was passed to xTaskCreate) whose high-water mark should be reported
// as "core0"/"core1" above. Call once after both tasks are created.
void diagnostics_register_tasks(TaskHandle_t core0Task, uint32_t core0StackBytes,
                                 TaskHandle_t core1Task, uint32_t core1StackBytes);

// Call once per control-loop tick, bracketing the work (control_task.cpp).
void diagnostics_core1_tick_start();
void diagnostics_core1_tick_end();

// Call once per ws_poll_task iteration, bracketing the work (ws_broadcast.cpp).
void diagnostics_core0_loop_start();
void diagnostics_core0_loop_end();

// Reads live heap/stack usage plus each track's most recently completed
//1-second measurement window (Hz, avg/max tick time).
void diagnostics_get_snapshot(DiagnosticsSnapshot *out);
