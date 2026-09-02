#include "control_task.hpp"
#include "board_pins.hpp"
#include "motors.hpp"
#include "encoders.hpp"
#include "control_modes.hpp"
#include "breadcrumb.hpp"
#include "diagnostics.hpp"

#include "driver/gptimer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_task_wdt.h"

#include "watchdog.hpp"

volatile uint32_t g_controlTickCount = 0;
volatile uint32_t g_controlMissedTicks = 0;
volatile int motorPower[2] = {0, 0};
volatile long encoderCount_steps[2] = {0, 0};
volatile float encoderCountDerivative_steps[2] = {0, 0};

namespace {

const char *TAG = "control_task";

constexpr UBaseType_t CONTROL_TASK_PRIORITY = 20; // highest in the app -- see control_task.hpp

TaskHandle_t g_controlTaskHandle = nullptr;

bool IRAM_ATTR gptimer_alarm_isr(gptimer_handle_t timer, const gptimer_alarm_event_data_t *edata, void *user_ctx) {
    (void) timer;
    (void) edata;
    BaseType_t higherPriorityTaskWoken = pdFALSE;
    // pdFALSE (don't clear the count itself between calls) isn't relevant
    // here -- the "collapse a backlog into one wakeup" behaviour comes from
    // ulTaskNotifyTake(pdTRUE, ...) on the receiving side, not from this call.
    vTaskNotifyGiveFromISR((TaskHandle_t) user_ctx, &higherPriorityTaskWoken);
    return higherPriorityTaskWoken == pdTRUE;
}

void control_task_body(void *arg) {
    (void) arg;
    breadcrumb_mark_core1(CORE1_CP_BOOT);

    gptimer_config_t timerConfig = {};
    timerConfig.clk_src = GPTIMER_CLK_SRC_DEFAULT;
    timerConfig.direction = GPTIMER_COUNT_UP;
    timerConfig.resolution_hz = 1'000'000; // 1 tick = 1 us
    gptimer_handle_t timer = nullptr;
    ESP_ERROR_CHECK(gptimer_new_timer(&timerConfig, &timer));

    gptimer_event_callbacks_t callbacks = {};
    callbacks.on_alarm = gptimer_alarm_isr;
    ESP_ERROR_CHECK(gptimer_register_event_callbacks(timer, &callbacks, xTaskGetCurrentTaskHandle()));

    gptimer_alarm_config_t alarmConfig = {};
    alarmConfig.alarm_count = TIMER_INTERVAL_US;
    alarmConfig.reload_count = 0;
    alarmConfig.flags.auto_reload_on_alarm = true;
    ESP_ERROR_CHECK(gptimer_set_alarm_action(timer, &alarmConfig));

    ESP_ERROR_CHECK(gptimer_enable(timer));
    ESP_ERROR_CHECK(gptimer_start(timer));

    ESP_LOGI(TAG, "control task running on core %d, %lu us period",
             xPortGetCoreID(), (unsigned long) TIMER_INTERVAL_US);

    uint32_t gptimerTicksExpected = 0;

    while (true) {
        // pdTRUE clears the notification count on take, so a stall (e.g. an
        // NVS commit disabling the flash cache) collapses any backlog of
        // missed alarms into a single wakeup here rather than running N
        // catch-up iterations with a stale dt. We still count how far behind
        // we fell, for the diagnostics panel.
        uint32_t pending = ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
        gptimerTicksExpected += pending;
        if (pending > 1) {
            g_controlMissedTicks = g_controlMissedTicks + (pending - 1);
        }

        diagnostics_core1_tick_start();

        long counts[2];
        encoders_read(counts);
        encoderCount_steps[0] = counts[0];
        encoderCount_steps[1] = counts[1];

        // Full mode dispatch (odometry, PID/goto controllers, calibration
        // modes) -- writes motorPower[] itself.
        controlModesTick();

        motors_run(motorPower[WHEEL_LEFT], WHEEL_LEFT);
        motors_run(motorPower[WHEEL_RIGHT], WHEEL_RIGHT);

        // g_controlTickCount++ triggers a deprecated-volatile-increment
        // warning under C++20 (gnu++2b); this is the equivalent read-modify-
        // write spelled out explicitly.
        g_controlTickCount = g_controlTickCount + 1;

        diagnostics_core1_tick_end();

        // This task is subscribed to the task watchdog by watchdog_system_init()
        // (called from app_main() once both it and ws_poll_task exist). A hang
        // anywhere in this loop -- including inside controlModesTick() itself --
        // now trips a 3s task-watchdog reboot instead of silently freezing.
        // Guarded on watchdog_is_ready(): Wi-Fi/HTTP bring-up between task
        // creation and watchdog_system_init() takes over a second, during
        // which calling esp_task_wdt_reset() before subscription just logged
        // a "task not found" error every tick.
        if (watchdog_is_ready()) {
            esp_task_wdt_reset();
        }
    }
}

} // namespace

void control_task_start() {
    BaseType_t ok = xTaskCreate(
        control_task_body, "ctrl", CONTROL_TASK_STACK_BYTES, nullptr,
        CONTROL_TASK_PRIORITY, &g_controlTaskHandle);
    if (ok != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreate failed");
    }
}

TaskHandle_t control_task_get_handle() {
    return g_controlTaskHandle;
}
