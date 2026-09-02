#include "diagnostics.hpp"

#include "esp_timer.h"
#include "esp_heap_caps.h"
#include "esp_system.h"

namespace {

// Rolling 1-second measurement window: accumulates tick durations, then
// computes Hz/avg/max once the window closes and resets. bracketed by
// start()/end() around each tick/loop iteration.
struct TickWindow {
    int64_t tickStartUs = 0;
    int64_t windowStartUs = 0;
    uint32_t count = 0;
    uint64_t sumUs = 0;
    uint32_t maxUs = 0;

    float hzResult = 0.0f;
    uint32_t avgUsResult = 0;
    uint32_t maxUsResult = 0;

    void start() {
        tickStartUs = esp_timer_get_time();
        if (windowStartUs == 0) {
            windowStartUs = tickStartUs;
        }
    }

    void end() {
        int64_t now = esp_timer_get_time();
        uint32_t durationUs = (uint32_t) (now - tickStartUs);
        sumUs += durationUs;
        if (durationUs > maxUs) {
            maxUs = durationUs;
        }
        count++;

        int64_t elapsed = now - windowStartUs;
        if (elapsed >= 1000000) { // 1s window closed
            hzResult = count / (elapsed / 1000000.0f);
            avgUsResult = (uint32_t) (sumUs / count);
            maxUsResult = maxUs;
            count = 0;
            sumUs = 0;
            maxUs = 0;
            windowStartUs = now;
        }
    }
};

TickWindow g_core0Window; // ws_poll_task
TickWindow g_core1Window; // control task

TaskHandle_t g_core0Task = nullptr;
TaskHandle_t g_core1Task = nullptr;
uint32_t g_core0StackBytes = 0;
uint32_t g_core1StackBytes = 0;

} // namespace

void diagnostics_register_tasks(TaskHandle_t core0Task, uint32_t core0StackBytes,
                                 TaskHandle_t core1Task, uint32_t core1StackBytes) {
    g_core0Task = core0Task;
    g_core0StackBytes = core0StackBytes;
    g_core1Task = core1Task;
    g_core1StackBytes = core1StackBytes;
}

void diagnostics_core1_tick_start() { g_core1Window.start(); }
void diagnostics_core1_tick_end() { g_core1Window.end(); }
void diagnostics_core0_loop_start() { g_core0Window.start(); }
void diagnostics_core0_loop_end() { g_core0Window.end(); }

void diagnostics_get_snapshot(DiagnosticsSnapshot *out) {
    out->core0HzMeasured = g_core0Window.hzResult;
    out->core0TickAvgUs = g_core0Window.avgUsResult;
    out->core0TickMaxUs = g_core0Window.maxUsResult;
    out->core1HzMeasured = g_core1Window.hzResult;
    out->core1TickAvgUs = g_core1Window.avgUsResult;
    out->core1TickMaxUs = g_core1Window.maxUsResult;

    // MALLOC_CAP_INTERNAL|MALLOC_CAP_8BIT is the same general-purpose pool
    // malloc()/new draw from on this board (no PSRAM). Unlike the Pico's
    // mallinfo().arena (which only reflects how much the allocator has
    // claimed SO FAR and grows on demand), ESP-IDF's heap regions are all
    // registered at boot and never grow, so arena == the true ceiling here.
    multi_heap_info_t info;
    heap_caps_get_info(&info, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    out->heapUsedBytes = (uint32_t) info.total_allocated_bytes;
    out->heapFreeBytes = (uint32_t) info.total_free_bytes;
    out->heapArenaBytes = out->heapUsedBytes + out->heapFreeBytes;
    // All-time low-water mark -- a materially more useful number than the
    // Pico's fixed linker-symbol ceiling: it directly answers "how close
    // did we ever actually come to running out", not just "how big is the
    // pool".
    out->heapCeilingBytes = esp_get_minimum_free_heap_size();

    if (g_core0Task != nullptr) {
        // A TRUE historical high-water mark (tracked continuously by
        // FreeRTOS since the task started), unlike the Pico version's
        // sampled current-depth-at-measurement-time. StackType_t is uint8_t
        // on this port, so the return value is already in bytes -- no word
        // conversion needed.
        uint32_t freeBytes = (uint32_t) uxTaskGetStackHighWaterMark(g_core0Task);
        out->core0StackTotalBytes = g_core0StackBytes;
        out->core0StackUsedBytes = g_core0StackBytes > freeBytes ? g_core0StackBytes - freeBytes : 0;
    }
    if (g_core1Task != nullptr) {
        uint32_t freeBytes = (uint32_t) uxTaskGetStackHighWaterMark(g_core1Task);
        out->core1StackTotalBytes = g_core1StackBytes;
        out->core1StackUsedBytes = g_core1StackBytes > freeBytes ? g_core1StackBytes - freeBytes : 0;
    }

    // Not literally "all RAM" (excludes .data/.bss/IRAM/RTC), but the
    // number that actually matters here: total internal SRAM available to
    // the general-purpose allocator, same pool heapArenaBytes/heapFreeBytes
    // are measured against.
    out->totalRamBytes = (uint32_t) heap_caps_get_total_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}
