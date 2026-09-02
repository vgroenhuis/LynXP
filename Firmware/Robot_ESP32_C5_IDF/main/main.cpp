#include "board_pins.hpp"
#include "motors.hpp"
#include "encoders.hpp"
#include "control_task.hpp"
#include "serial_console.hpp"
#include "settings.hpp"
#include "log_task.hpp"
#include "oled.hpp"
#include "watchdog.hpp"
#include "breadcrumb.hpp"
#include "diagnostics.hpp"
#include "littlefs_init.hpp"
#include "wifi_connect.hpp"
#include "web_server.hpp"
#include "ws_broadcast.hpp"
#include "uart_link.hpp"
#include "ping_diag.hpp"
#include "ota.hpp"

#include "esp_log.h"
#include "nvs_flash.h"

// Full feature parity with Robot_ESP32_S3_IDF: local control, WiFi/web
// server/WebSocket, the S3-CAM UART link, and now OTA -- the last piece
// deferred by the staged port plan at
// C:\Users\vince\.claude\plans\shiny-squishing-bengio.md.

extern "C" void app_main(void) {
    // Must be the very first thing app_main() does, before any other init:
    // the TB6612's AIN1-2/BIN1-2/PWMA/PWMB pins and both servo signal lines
    // float on reset (the ROM bootloader runs for a while before app_main
    // is even reached), and a floating driver/servo input is an undefined
    // output. This does not cover that ROM window itself -- only external
    // pulldowns on the pins do -- but it closes the window from here on,
    // including every future reboot.
    motors_force_safe_state();

    // Must run before control_task_start() below: the control task starts
    // writing ITS OWN fresh breadcrumbs (via breadcrumb_mark_core1()) the
    // instant it launches, well before this point would otherwise run.
    // Harmless to call this early: it only reads RTC memory, no dependency
    // on anything initialized after it.
    breadcrumb_capture_boot_snapshot();

    ESP_LOGI("main", "LynXP ESP32-C5 -- full feature parity (wifi + http + control modes + diagnostics + CAM link + OTA)");

    // Standard ESP-IDF idiom: nvs_flash_init() can report that the
    // partition's data is stale (format changed between IDF versions) or
    // that it ran out of free pages; either way, erasing and retrying once
    // is the documented recovery, not a real error path.
    esp_err_t nvsErr = nvs_flash_init();
    if (nvsErr == ESP_ERR_NVS_NO_FREE_PAGES || nvsErr == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        nvsErr = nvs_flash_init();
    }
    ESP_ERROR_CHECK(nvsErr);

    // Try to load a previous session's settings, and only fall back to (and
    // persist) defaults if none exist yet or the version doesn't match.
    if (!loadSettings()) {
        applyDefaultSettings();
        saveSettings();
    }

    littlefs_init();
    motors_init();
    encoders_init();
    web_server_recenter_servo(); // see its own doc comment -- must run after settings are loaded, before HTTP bring-up
    log_task_start(); // before control_task_start(): controlModesTick() may submit log lines from tick 1
    control_task_start();
    serial_console_start();

    wifi_connect_start();
    uart_link_start(); // listens for the S3 CAM's periodic status line -- see board_pins.hpp's CAM_UART_* pins
    ping_diag_start(); // ICMP-pings the cam once uart_link knows its IP, for a live WiFi-quality signal
    oled_status_start(); // after wifi_connect_start(): the MAC must already be known for the first frame
    web_server_init();
    ws_broadcast_start();
    ota_register_routes();

    // Both tasks now exist -- subscribe them to the task watchdog and start
    // measuring their tick timing/stack usage.
    watchdog_system_init(control_task_get_handle(), ws_broadcast_get_poll_task_handle());
    diagnostics_register_tasks(ws_broadcast_get_poll_task_handle(), WS_POLL_TASK_STACK_BYTES,
                                control_task_get_handle(), CONTROL_TASK_STACK_BYTES);

    if (watchdog_last_reboot_was_hang()) {
        const BreadcrumbSnapshot &bc = breadcrumb_get_boot_snapshot();
        ESP_LOGW("main", "*** Last reboot was a hang recovery: %s ***", watchdog_last_reboot_reason_string());
        ESP_LOGW("main", "*** core0 was at: %s | core1 was at: %s (tick %lu) | last WS message: '%s' ***",
                 breadcrumb_core0_checkpoint_name(bc.core0Checkpoint),
                 breadcrumb_core1_checkpoint_name(bc.core1Checkpoint),
                 (unsigned long) bc.core1TickCountAtLastMark, bc.lastWsMessageType);
    }

    // Last: only mark this boot "known good" (cancelling the OTA rollback
    // countdown) once everything above has actually started successfully.
    ota_start_validation();
}
