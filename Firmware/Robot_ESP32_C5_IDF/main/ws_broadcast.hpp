#pragma once

#include <cstdint>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

// The WebSocket half of Robot_Pico2W_SDK/src/web_server.cpp -- /ws message
// dispatch (handle_ws_message()) and the poll-loop telemetry broadcast
// (web_server_poll()), split out from web_server.cpp/.hpp (the HTTP GET/POST
// routes) because esp_http_server's WS model looks different enough from
// Mongoose's that keeping them apart is clearer. Message types, JSON field
// names, and behaviour (deferred pong, drive-command watchdog, stale-client
// handling) are all kept equivalent to the Pico build -- see the migration
// plan for exactly how each piece maps.

// Registers the /ws route on web_server_get_handle()'s server and starts the
// broadcast/poll task (the ESP32 equivalent of the Pico's core0 main-loop
// call to web_server_poll(): control-frame rotation integration, servo
// follow, drive-command watchdog, pose/sysstats broadcast, dead-client
// handling). Call once from app_main(), after web_server_init().
void ws_broadcast_start();

// For watchdog_system_init()/diagnostics_register_tasks() to subscribe/
// measure this task. Valid only after ws_broadcast_start() returns.
TaskHandle_t ws_broadcast_get_poll_task_handle();

// The stack size (bytes) ws_broadcast_start() actually created the poll
// task with -- diagnostics_register_tasks() needs this alongside the handle.
constexpr uint32_t WS_POLL_TASK_STACK_BYTES = 4096;
