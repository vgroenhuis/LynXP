// See cpu_trace.h. Identical copy in both firmwares.
#include "cpu_trace.h"

#include <stdlib.h>
#include <string.h>

#include "esp_attr.h"
#include "esp_cpu.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#define EVENTS_MAX 65536 // 512 KB of PSRAM, kept once allocated; a busy second has ~10-20k switches
#define TASKS_MAX 48
#define HEADER_BYTES 32
#define TASK_BYTES 24
#define EVENT_BYTES 8

typedef struct {
    uint32_t t;      // us since the start
    uint32_t handle; // TCB address | core
} event_t;

static event_t *s_ev = NULL;
static volatile bool s_on = false;
static volatile uint32_t s_n = 0;   // events claimed (may pass EVENTS_MAX: the rest are lost)
static int64_t s_start = 0;
static uint32_t s_durUs = 0;
static bool s_have = false;         // a finished recording is there
static char s_chip[8];

// Every context switch, with the scheduler's lock held: claim a slot, write
// it. Two cores (S3) can get here at once, hence the atomic slot counter.
void IRAM_ATTR cpu_trace_switched_in(void *tcb) {
    if (!s_on) return;
    uint32_t t = (uint32_t) (esp_timer_get_time() - s_start);
    if (t > s_durUs) {
        s_on = false;
        return;
    }
    uint32_t i = __atomic_fetch_add(&s_n, 1, __ATOMIC_RELAXED);
    if (i < EVENTS_MAX) {
        s_ev[i].t = t;
        s_ev[i].handle = (uint32_t) (uintptr_t) tcb | (uint32_t) esp_cpu_get_core_id();
    }
}

bool cpu_trace_start(uint32_t ms, const char *chip) {
    if (cpu_trace_running() || ms == 0 || ms > CPU_TRACE_MAX_MS) return false;
    if (s_ev == NULL) {
        s_ev = (event_t *) heap_caps_malloc(EVENTS_MAX * sizeof(event_t), MALLOC_CAP_SPIRAM);
        if (s_ev == NULL) return false;
    }
    memset(s_chip, 0, sizeof(s_chip));
    memcpy(s_chip, chip, strnlen(chip, sizeof(s_chip)));
    s_have = false;
    s_durUs = ms * 1000;
    s_n = 0;
    s_start = esp_timer_get_time();
    for (int core = 0; core < portNUM_PROCESSORS; core++) {
        s_ev[s_n].t = 0;
        s_ev[s_n].handle = (uint32_t) (uintptr_t) xTaskGetCurrentTaskHandleForCore(core) | (uint32_t) core;
        s_n++;
    }
    __atomic_thread_fence(__ATOMIC_SEQ_CST);
    s_on = true;
    return true;
}

bool cpu_trace_running(void) {
    if (s_on && esp_timer_get_time() - s_start > (int64_t) s_durUs + 1000) s_on = false; // (no switch since the end)
    if (!s_on && s_n > 0 && !s_have) s_have = true;
    return s_on;
}

static void put32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t) v;
    p[1] = (uint8_t) (v >> 8);
    p[2] = (uint8_t) (v >> 16);
    p[3] = (uint8_t) (v >> 24);
}

size_t cpu_trace_blob(uint8_t **out) {
    *out = NULL;
    if (cpu_trace_running() || !s_have) return 0;
    uint32_t n = s_n < EVENTS_MAX ? s_n : EVENTS_MAX;
    uint32_t lost = s_n - n;

    // The tasks seen, and their names from the scheduler's list now (a task
    // that ended since -- a stream viewer -- has no name any more).
    uint32_t handles[TASKS_MAX];
    int tasks = 0;
    for (uint32_t i = 0; i < n; i++) {
        uint32_t h = s_ev[i].handle & ~3u;
        int k = 0;
        while (k < tasks && handles[k] != h) k++;
        if (k == tasks && tasks < TASKS_MAX) handles[tasks++] = h;
    }
    UBaseType_t count = uxTaskGetNumberOfTasks() + 4;
    TaskStatus_t *status = (TaskStatus_t *) heap_caps_malloc(count * sizeof(TaskStatus_t), MALLOC_CAP_SPIRAM);
    if (status == NULL) return 0;
    count = uxTaskGetSystemState(status, count, NULL);

    size_t len = HEADER_BYTES + (size_t) tasks * TASK_BYTES + (size_t) n * EVENT_BYTES;
    uint8_t *b = (uint8_t *) heap_caps_calloc(1, len, MALLOC_CAP_SPIRAM);
    if (b == NULL) {
        free(status);
        return 0;
    }
    memcpy(b, "CPUT", 4);
    b[4] = 1;
    b[5] = portNUM_PROCESSORS;
    b[6] = (uint8_t) tasks;
    b[7] = (uint8_t) (tasks >> 8);
    put32(b + 8, (uint32_t) len);
    put32(b + 12, s_durUs);
    put32(b + 16, n);
    put32(b + 20, lost);
    memcpy(b + 24, s_chip, sizeof(s_chip));
    uint8_t *p = b + HEADER_BYTES;
    for (int k = 0; k < tasks; k++, p += TASK_BYTES) {
        put32(p, handles[k]);
        p[5] = 1;
        for (UBaseType_t s = 0; s < count; s++) {
            if ((uint32_t) (uintptr_t) status[s].xHandle == handles[k]) {
                p[4] = (uint8_t) status[s].uxCurrentPriority;
                p[5] = 0;
                memcpy(p + 8, status[s].pcTaskName, strnlen(status[s].pcTaskName, 16));
                break;
            }
        }
    }
    for (uint32_t i = 0; i < n; i++, p += EVENT_BYTES) {
        put32(p, s_ev[i].t);
        put32(p + 4, s_ev[i].handle);
    }
    free(status);
    *out = b;
    return len;
}
