#include "watchdog.hpp"

#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_task_wdt.h"
#include "esp_system.h"
#include "esp_timer.h"

namespace {
volatile bool g_ready = false;

const char *TAG = "health";

// Why the health watchdog restarted the chip, kept across the (software)
// reset in RTC memory. Fields are written BEFORE the magic word, and the
// magic is cleared once read, so a stale or half-written record never
// counts (see the RTC_NOINIT field-init note in breadcrumb.cpp).
enum HealthReason : uint32_t { HEALTH_NONE = 0, HEALTH_LOW_MEMORY = 1, HEALTH_STARVED = 2 };
constexpr uint32_t HEALTH_MAGIC = 0x4EA17B07;
struct RtcHealth {
    uint32_t reason;
    uint32_t detail; // low memory: internal RAM free (bytes); starved: seconds since the OLED task ran
    uint32_t magic;
};
RTC_NOINIT_ATTR RtcHealth g_rtcHealth;
HealthReason g_bootHealthReason = HEALTH_NONE; // what the previous boot recorded (read once at start)
uint32_t g_bootHealthDetail = 0;

constexpr uint32_t LOW_MEMORY_BYTES = 4096;
constexpr int LOW_MEMORY_SECONDS = 10;
constexpr int64_t OLED_STALL_US = 20LL * 1000 * 1000;

volatile int64_t g_oledBeatUs = 0;
TaskHandle_t g_ctrlTask = nullptr;

void restart_for(HealthReason reason, uint32_t detail) {
    g_rtcHealth.reason = reason;
    g_rtcHealth.detail = detail;
    g_rtcHealth.magic = HEALTH_MAGIC;
    esp_restart();
}

void health_task(void *) {
    int lowSeconds = 0;
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(1000));
        // An OTA upload suspends the control task and legitimately starves
        // everything else for a while.
        if (g_ctrlTask != nullptr && eTaskGetState(g_ctrlTask) == eSuspended) {
            lowSeconds = 0;
            g_oledBeatUs = esp_timer_get_time();
            continue;
        }
        size_t freeInternal = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
        lowSeconds = freeInternal < LOW_MEMORY_BYTES ? lowSeconds + 1 : 0;
        if (lowSeconds >= LOW_MEMORY_SECONDS) {
            ESP_LOGE(TAG, "internal RAM nearly empty (%u bytes free) for %d s -- restarting", (unsigned) freeInternal, lowSeconds);
            restart_for(HEALTH_LOW_MEMORY, (uint32_t) freeInternal);
        }
        int64_t beat = g_oledBeatUs;
        int64_t sinceUs = esp_timer_get_time() - beat;
        if (beat != 0 && sinceUs > OLED_STALL_US) {
            ESP_LOGE(TAG, "OLED task hasn't run for %lld s -- the system is starved, restarting", (long long) (sinceUs / 1000000));
            restart_for(HEALTH_STARVED, (uint32_t) (sinceUs / 1000000));
        }
    }
}

} // namespace

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

void watchdog_health_start(TaskHandle_t ctrlTask) {
    if (g_rtcHealth.magic == HEALTH_MAGIC && esp_reset_reason() == ESP_RST_SW) {
        g_bootHealthReason = (HealthReason) g_rtcHealth.reason;
        g_bootHealthDetail = g_rtcHealth.detail;
    }
    g_rtcHealth.magic = 0;
    g_ctrlTask = ctrlTask;
    // Above the web server and WiFi tasks, so it still runs when they're the
    // ones hogging the CPU; below the 1 kHz control task.
    xTaskCreate(health_task, "health", 3072, nullptr, 15, nullptr);
}

void watchdog_oled_heartbeat() {
    g_oledBeatUs = esp_timer_get_time();
}

bool watchdog_last_reboot_was_hang() {
    if (g_bootHealthReason != HEALTH_NONE) return true;
    esp_reset_reason_t r = esp_reset_reason();
    return r == ESP_RST_TASK_WDT || r == ESP_RST_INT_WDT || r == ESP_RST_WDT ||
           r == ESP_RST_PANIC || r == ESP_RST_CPU_LOCKUP;
}

const char *watchdog_last_reboot_reason_string() {
    if (g_bootHealthReason == HEALTH_LOW_MEMORY) return "health watchdog: internal RAM ran out (hang recovery)";
    if (g_bootHealthReason == HEALTH_STARVED) return "health watchdog: tasks starved, OLED/QR stopped (hang recovery)";
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
