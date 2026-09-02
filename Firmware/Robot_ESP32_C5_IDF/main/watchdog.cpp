#include "watchdog.hpp"

#include "esp_task_wdt.h"
#include "esp_system.h"

namespace {
volatile bool g_ready = false;
}

void watchdog_system_init(TaskHandle_t ctrlTask, TaskHandle_t pollTask) {
    esp_task_wdt_add(ctrlTask);
    // pollTask is null in builds where ws_broadcast.cpp doesn't exist yet
    // (this port's Stage 1) -- esp_task_wdt_add(NULL) would subscribe
    // whichever task calls this function (app_main's task) instead of
    // skipping, and that task never calls esp_task_wdt_reset() again after
    // boot, so it must be guarded rather than passed straight through.
    if (pollTask != nullptr) {
        esp_task_wdt_add(pollTask);
    }
    g_ready = true;
}

bool watchdog_is_ready() {
    return g_ready;
}

bool watchdog_last_reboot_was_hang() {
    esp_reset_reason_t r = esp_reset_reason();
    return r == ESP_RST_TASK_WDT || r == ESP_RST_INT_WDT || r == ESP_RST_WDT ||
           r == ESP_RST_PANIC || r == ESP_RST_CPU_LOCKUP;
}

const char *watchdog_last_reboot_reason_string() {
    switch (esp_reset_reason()) {
        case ESP_RST_POWERON: return "power-on reset";
        case ESP_RST_EXT: return "external reset (EN pin)";
        case ESP_RST_SW: return "software reset (esp_restart, e.g. after OTA)";
        case ESP_RST_PANIC: return "crash/panic";
        case ESP_RST_INT_WDT: return "interrupt watchdog timeout (hang recovery)";
        case ESP_RST_TASK_WDT: return "task watchdog timeout (hang recovery)";
        case ESP_RST_WDT: return "other watchdog timeout (hang recovery)";
        case ESP_RST_DEEPSLEEP: return "wake from deep sleep";
        case ESP_RST_BROWNOUT: return "brownout (voltage dip on the power rail)";
        case ESP_RST_SDIO: return "reset over SDIO";
        case ESP_RST_USB: return "USB reset (reflash)";
        case ESP_RST_JTAG: return "JTAG reset (debugger)";
        case ESP_RST_EFUSE: return "efuse error";
        case ESP_RST_PWR_GLITCH: return "power glitch detected";
        case ESP_RST_CPU_LOCKUP: return "CPU lockup (double exception, hang recovery)";
        default: return "unknown";
    }
}
