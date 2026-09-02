#include "log_task.hpp"

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include <cstdio>
#include <cstring>

namespace {

struct LogLine {
    char text[LOG_LINE_MAX_LEN];
};

constexpr UBaseType_t LOG_QUEUE_DEPTH = 32;

QueueHandle_t g_queue = nullptr;

void log_task_body(void *arg) {
    (void) arg;
    LogLine line;
    while (true) {
        if (xQueueReceive(g_queue, &line, portMAX_DELAY) == pdTRUE) {
            fputs(line.text, stdout);
        }
    }
}

} // namespace

void log_task_start() {
    g_queue = xQueueCreate(LOG_QUEUE_DEPTH, sizeof(LogLine));
    xTaskCreate(log_task_body, "logtask", 3072, nullptr, 2, nullptr);
}

void log_task_submit(const char *line) {
    if (g_queue == nullptr) {
        return;
    }
    LogLine entry;
    std::strncpy(entry.text, line, sizeof(entry.text) - 1);
    entry.text[sizeof(entry.text) - 1] = '\0';
    xQueueSend(g_queue, &entry, 0); // 0 timeout: never blocks, drops on backpressure
}
