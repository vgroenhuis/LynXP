#include "reset_log.hpp"

#include <algorithm>
#include <cstdio>
#include <cstring>

#include "breadcrumb.hpp"
#include "watchdog.hpp"
#include "web_server.hpp"

#include "esp_app_desc.h"
#include "esp_attr.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_private/panic_internal.h"
#include "esp_rom_sys.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "riscv/rvruntime-frames.h"

namespace {

const char *TAG = "resetlog";

constexpr uint32_t FLIGHT_MAGIC = 0x5EB0F11E;
constexpr uint32_t PANIC_MAGIC = 0x9A41C0DE;
constexpr int RING = 24;  // task switches kept
constexpr int NAMES = 32; // tasks in the name table

// Times are esp_timer microseconds >> 10 ("ms", 1.024 ms): no 64-bit
// division inside the context switch.
inline uint32_t now_kus() {
    return (uint32_t) (esp_timer_get_time() >> 10);
}

struct RtcFlight {
    uint32_t magic;
    uint32_t idx; // next slot in the ring (always < RING)
    uint32_t tcb[RING];
    uint32_t tKus[RING];
    uint32_t nameTcb[NAMES];
    char name[NAMES][12];
    uint32_t upKus; // the last live tick
    uint32_t freeInternal, minFreeInternal, freePsram;
    char net[28];
    uint32_t netKus;
    char version[16]; // this run's firmware
};
struct RtcPanic {
    char reason[48];
    uint32_t pc, ra, exc, tKus;
    uint32_t magic; // written last
};
RTC_NOINIT_ATTR RtcFlight g_fl;
RTC_NOINIT_ATTR RtcPanic g_pn;
volatile bool g_flightOn = false;

// One start in the history (fixed size: stored as one NVS blob).
struct Entry {
    uint32_t seq;           // which start this was (counts up, kept in NVS)
    uint8_t reason;         // esp_reset_reason()
    uint8_t hw;             // the chip's own reset cause (soc_reset_reason_t)
    uint8_t flags;          // F_*: which parts below are filled in
    uint8_t pad;
    uint32_t upMs;          // the previous run: uptime at its last live tick
    uint32_t lastSwitchMs;  // the previous run: when its last task switch happened
    uint32_t netMs;         // the previous run: when its last network step began
    uint32_t freeInternal, minFreeInternal;
    uint32_t pc, ra, exc;   // panic
    char version[16];       // the previous run's firmware
    char tasks[72];         // its last task switches, oldest first ("httpd>IDLE>tiT")
    char net[28];
    char panic[48];
    char twdt[80];
    char crumbs[72];
};
enum : uint8_t { F_FLIGHT = 1, F_PANIC = 2, F_TWDT = 4, F_CRUMBS = 8 };
struct Ring {
    uint32_t count; // entries filled (<= RESET_LOG_ENTRIES)
    Entry e[RESET_LOG_ENTRIES]; // newest first
};

EXT_RAM_BSS_ATTR RtcFlight s_prevFl;
EXT_RAM_BSS_ATTR RtcPanic s_prevPn;
EXT_RAM_BSS_ATTR Entry s_entry;
EXT_RAM_BSS_ATTR Ring s_ring;
bool s_haveFl = false;
bool s_havePn = false;
bool s_captured = false;
char s_summary[160] = "";

void copy_str(char *dst, size_t n, const char *src) {
    size_t k = 0;
    for (; src && src[k] && k + 1 < n; k++) dst[k] = src[k];
    dst[k] = '\0';
}

const char *hw_name(int hw) {
    switch (hw) {
        case 0x01: return "power-on/brownout";
        case 0x03: return "software (core)";
        case 0x05: return "deep sleep";
        case 0x07: return "MWDT0 (task wdt timer) core reset";
        case 0x08: return "MWDT1 (interrupt wdt timer) core reset";
        case 0x09: return "RTC watchdog core reset";
        case 0x0B: return "MWDT0 CPU reset";
        case 0x0C: return "software (CPU)";
        case 0x0D: return "RTC watchdog CPU reset";
        case 0x0F: return "brownout";
        case 0x10: return "RTC watchdog system reset";
        case 0x11: return "MWDT1 CPU reset";
        case 0x12: return "super watchdog";
        case 0x14: return "eFuse CRC";
        case 0x15: return "USB UART";
        case 0x16: return "USB JTAG";
        case 0x18: return "JTAG";
        case 0x19: return "power glitch";
        case 0x1A: return "CPU lockup";
        default: return "?";
    }
}

const char *reason_name(int r) {
    switch (r) {
        case ESP_RST_POWERON: return "power-on";
        case ESP_RST_EXT: return "reset pin";
        case ESP_RST_SW: return "software";
        case ESP_RST_PANIC: return "panic";
        case ESP_RST_INT_WDT: return "interrupt watchdog";
        case ESP_RST_TASK_WDT: return "task watchdog";
        case ESP_RST_WDT: return "other watchdog";
        case ESP_RST_DEEPSLEEP: return "deep sleep";
        case ESP_RST_BROWNOUT: return "brownout";
        case ESP_RST_SDIO: return "SDIO";
        case ESP_RST_USB: return "USB";
        case ESP_RST_JTAG: return "JTAG";
        case ESP_RST_EFUSE: return "eFuse";
        case ESP_RST_PWR_GLITCH: return "power glitch";
        case ESP_RST_CPU_LOCKUP: return "CPU lockup";
        default: return "unknown";
    }
}

const char *task_name(const RtcFlight &fl, uint32_t tcb, char *buf, size_t n) {
    for (int k = 0; k < NAMES; k++) {
        if (fl.nameTcb[k] == tcb && tcb != 0) {
            snprintf(buf, n, "%.11s", fl.name[k]);
            return buf;
        }
    }
    snprintf(buf, n, "?%04lx", (unsigned long) (tcb & 0xFFFF));
    return buf;
}

// The ring, oldest first, repeats folded: "IDLE>httpd>IDLE>tiT" -- the
// newest end if it doesn't all fit.
void ring_text(const RtcFlight &fl, char *out, size_t n, uint32_t *lastKus) {
    char all[RING * 13 + 1];
    size_t len = 0;
    all[0] = '\0';
    uint32_t prev = 0;
    *lastKus = 0;
    for (int k = 0; k < RING; k++) {
        int i = (int) ((fl.idx + k) % RING);
        uint32_t tcb = fl.tcb[i];
        if (tcb == 0) continue;
        *lastKus = fl.tKus[i];
        if (tcb == prev) continue;
        prev = tcb;
        char nm[12];
        task_name(fl, tcb, nm, sizeof(nm));
        int w = snprintf(all + len, sizeof(all) - len, "%s%s", len ? ">" : "", nm);
        if (w < 0 || (size_t) w >= sizeof(all) - len) break;
        len += (size_t) w;
    }
    const char *from = all;
    while (std::strlen(from) >= n) {
        const char *gt = std::strchr(from + 1, '>');
        if (!gt) break;
        from = gt + 1;
    }
    snprintf(out, n, "%s", from);
}

bool abnormal(int reason) {
    return reason == ESP_RST_PANIC || reason == ESP_RST_INT_WDT || reason == ESP_RST_TASK_WDT || reason == ESP_RST_WDT ||
           reason == ESP_RST_BROWNOUT || reason == ESP_RST_PWR_GLITCH || reason == ESP_RST_CPU_LOCKUP ||
           watchdog_last_reboot_was_hang();
}

void build_entry() {
    Entry &e = s_entry;
    std::memset(&e, 0, sizeof(e));
    int reason = (int) esp_reset_reason();
    e.reason = (uint8_t) reason;
    e.hw = (uint8_t) esp_rom_get_reset_reason(0);
    if (s_haveFl) {
        e.flags |= F_FLIGHT;
        uint32_t lastKus = 0;
        ring_text(s_prevFl, e.tasks, sizeof(e.tasks), &lastKus);
        e.upMs = (uint32_t) (((uint64_t) s_prevFl.upKus * 1024) / 1000);
        e.lastSwitchMs = (uint32_t) (((uint64_t) lastKus * 1024) / 1000);
        e.netMs = (uint32_t) (((uint64_t) s_prevFl.netKus * 1024) / 1000);
        e.freeInternal = s_prevFl.freeInternal;
        e.minFreeInternal = s_prevFl.minFreeInternal;
        copy_str(e.net, sizeof(e.net), s_prevFl.net);
        copy_str(e.version, sizeof(e.version), s_prevFl.version);
    }
    if (s_havePn) {
        e.flags |= F_PANIC;
        copy_str(e.panic, sizeof(e.panic), s_prevPn.reason);
        e.pc = s_prevPn.pc;
        e.ra = s_prevPn.ra;
        e.exc = s_prevPn.exc;
    }
    const char *twdt = watchdog_twdt_culprits();
    if (twdt[0]) {
        e.flags |= F_TWDT;
        copy_str(e.twdt, sizeof(e.twdt), twdt);
    }
    if (reason != ESP_RST_POWERON) {
        const BreadcrumbSnapshot &bc = breadcrumb_get_boot_snapshot();
        e.flags |= F_CRUMBS;
        snprintf(e.crumbs, sizeof(e.crumbs), "ctrl %s (tick %lu), ws %s, msg '%s', conns %d/%d",
                 breadcrumb_core1_checkpoint_name(bc.core1Checkpoint), (unsigned long) bc.core1TickCountAtLastMark,
                 breadcrumb_core0_checkpoint_name(bc.core0Checkpoint), bc.lastWsMessageType, bc.core0TotalConns, bc.core0WsConns);
    }

    s_summary[0] = '\0';
    if (!abnormal(reason)) return;
    // The most telling part first (the lab demos server keeps 120 characters).
    size_t n = 0;
    auto add = [&](const char *fmt, auto... args) {
        if (n >= sizeof(s_summary) - 1) return;
        int w = snprintf(s_summary + n, sizeof(s_summary) - n, fmt, args...);
        if (w > 0) n = std::min(sizeof(s_summary) - 1, n + (size_t) w);
    };
    if (e.flags & F_PANIC) add("panic '%s' pc 0x%08lx ra 0x%08lx; ", e.panic, (unsigned long) e.pc, (unsigned long) e.ra);
    else add("%s; ", hw_name(e.hw));
    if (e.flags & F_FLIGHT) {
        const char *last = std::strrchr(e.tasks, '>');
        add("after %.1f s, task '%s'", e.upMs / 1000.0, last ? last + 1 : e.tasks);
        if (e.lastSwitchMs + 200 < e.upMs) add(" (stuck %.1f s)", (e.upMs - e.lastSwitchMs) / 1000.0);
        if (e.net[0]) add("; net '%s' at %.1f s", e.net, e.netMs / 1000.0);
        add("; RAM low %lu", (unsigned long) e.minFreeInternal);
    }
    if (e.flags & F_TWDT) add("; wdt:%s", e.twdt);
}

// The name table: which TCB is which task (refreshed once a second).
EXT_RAM_BSS_ATTR TaskStatus_t s_status[NAMES];

void refresh_names() {
    UBaseType_t n = uxTaskGetSystemState(s_status, NAMES, nullptr);
    if (n == 0) return; // (more tasks than NAMES: keep the last table)
    for (int k = 0; k < NAMES; k++) {
        if ((UBaseType_t) k < n) {
            g_fl.nameTcb[k] = (uint32_t) (uintptr_t) s_status[k].xHandle;
            snprintf(g_fl.name[k], sizeof(g_fl.name[k]), "%.11s", s_status[k].pcTaskName);
        } else {
            g_fl.nameTcb[k] = 0;
        }
    }
}

esp_err_t handle_resets(httpd_req_t *req) {
    static EXT_RAM_BSS_ATTR char json[RESET_LOG_ENTRIES * 700 + 300];
    size_t n = 0;
    auto add = [&](const char *fmt, auto... args) {
        if (n >= sizeof(json) - 1) return;
        int w = snprintf(json + n, sizeof(json) - n, fmt, args...);
        if (w > 0) n = std::min(sizeof(json) - 1, n + (size_t) w);
    };
    char sumEsc[2 * sizeof(s_summary)];
    json_escape(s_summary, sumEsc, sizeof(sumEsc));
    add("{\"summary\":\"%s\",\"entries\":[", sumEsc);
    for (uint32_t k = 0; k < s_ring.count && k < RESET_LOG_ENTRIES; k++) {
        const Entry &e = s_ring.e[k];
        char tasks[2 * sizeof(e.tasks)], net[2 * sizeof(e.net)], panic[2 * sizeof(e.panic)], twdt[2 * sizeof(e.twdt)],
            crumbs[2 * sizeof(e.crumbs)], ver[2 * sizeof(e.version)];
        json_escape(e.tasks, tasks, sizeof(tasks));
        json_escape(e.net, net, sizeof(net));
        json_escape(e.panic, panic, sizeof(panic));
        json_escape(e.twdt, twdt, sizeof(twdt));
        json_escape(e.crumbs, crumbs, sizeof(crumbs));
        json_escape(e.version, ver, sizeof(ver));
        add("%s{\"start\":%lu,\"reason\":\"%s\",\"chipReason\":\"%s (0x%02x)\"", k ? "," : "", (unsigned long) e.seq,
            reason_name(e.reason), hw_name(e.hw), e.hw);
        if (e.flags & F_FLIGHT) {
            add(",\"prevFirmware\":\"%s\",\"prevUptimeS\":%.1f,\"lastTaskSwitchS\":%.3f,\"lastTasks\":\"%s\","
                "\"netStep\":\"%s\",\"netStepS\":%.1f,\"internalFree\":%lu,\"internalLowest\":%lu",
                ver, e.upMs / 1000.0, e.lastSwitchMs / 1000.0, tasks, net, e.netMs / 1000.0, (unsigned long) e.freeInternal,
                (unsigned long) e.minFreeInternal);
        }
        if (e.flags & F_PANIC) add(",\"panic\":\"%s\",\"pc\":\"0x%08lx\",\"ra\":\"0x%08lx\",\"exception\":%lu", panic,
                                   (unsigned long) e.pc, (unsigned long) e.ra, (unsigned long) e.exc);
        if (e.flags & F_TWDT) add(",\"taskWatchdog\":\"%s\"", twdt);
        if (e.flags & F_CRUMBS) add(",\"breadcrumbs\":\"%s\"", crumbs);
        add("%s", "}");
    }
    add("%s", "]}");
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    return httpd_resp_send(req, json, (ssize_t) n);
}

} // namespace

// cpu_trace.c calls this at every context switch (scheduler lock held, maybe
// with the flash cache off: RAM only, no calls out).
extern "C" void IRAM_ATTR cpu_trace_flight(void *tcb) {
    if (!g_flightOn) return;
    uint32_t i = g_fl.idx;
    if (i >= RING) i = 0;
    g_fl.tcb[i] = (uint32_t) (uintptr_t) tcb;
    g_fl.tKus[i] = now_kus();
    g_fl.idx = i + 1 >= RING ? 0 : i + 1;
}

// The panic handler, wrapped (CMakeLists.txt: -Wl,--wrap=esp_panic_handler):
// its reason and where it happened, before the (slow) printing starts -- if
// the printing itself hangs and the RTC watchdog ends it, this is all that's
// left.
extern "C" void __real_esp_panic_handler(panic_info_t *info);
extern "C" void IRAM_ATTR __wrap_esp_panic_handler(panic_info_t *info) {
    g_pn.magic = 0;
    const char *r = (g_panic_abort && g_panic_abort_details) ? g_panic_abort_details : info->reason;
    size_t k = 0;
    if (r) {
        for (; r[k] && k < sizeof(g_pn.reason) - 1; k++) g_pn.reason[k] = r[k];
    }
    g_pn.reason[k] = '\0';
    g_pn.pc = (uint32_t) (uintptr_t) info->addr;
    g_pn.ra = info->frame ? (uint32_t) ((const RvExcFrame *) info->frame)->ra : 0;
    g_pn.exc = (uint32_t) info->exception;
    g_pn.tKus = now_kus();
    g_pn.magic = PANIC_MAGIC;
    __real_esp_panic_handler(info);
}

void reset_log_capture() {
    if (s_captured) return;
    s_captured = true;
    bool poweron = esp_reset_reason() == ESP_RST_POWERON; // (RTC memory is noise then)
    s_haveFl = !poweron && g_fl.magic == FLIGHT_MAGIC;
    s_havePn = !poweron && g_pn.magic == PANIC_MAGIC;
    if (s_haveFl) {
        std::memcpy(&s_prevFl, &g_fl, sizeof(s_prevFl));
        s_prevFl.net[sizeof(s_prevFl.net) - 1] = '\0';
        s_prevFl.version[sizeof(s_prevFl.version) - 1] = '\0';
        for (auto &nm : s_prevFl.name) nm[sizeof(nm) - 1] = '\0';
    }
    if (s_havePn) {
        std::memcpy(&s_prevPn, &g_pn, sizeof(s_prevPn));
        s_prevPn.reason[sizeof(s_prevPn.reason) - 1] = '\0';
    }
    // This run's record: empty, then on.
    g_pn.magic = 0;
    std::memset(&g_fl, 0, sizeof(g_fl));
    copy_str(g_fl.version, sizeof(g_fl.version), esp_app_get_description()->version);
    g_fl.magic = FLIGHT_MAGIC;
    __atomic_thread_fence(__ATOMIC_SEQ_CST);
    g_flightOn = true;
    build_entry();
    if (s_summary[0]) ESP_LOGW(TAG, "previous run: %s", s_summary);
}

void reset_log_store() {
    nvs_handle_t h;
    if (nvs_open("resetlog", NVS_READWRITE, &h) != ESP_OK) return;
    uint32_t seq = 0;
    nvs_get_u32(h, "seq", &seq);
    seq++;
    s_entry.seq = seq;
    size_t len = sizeof(s_ring);
    if (nvs_get_blob(h, "ring", &s_ring, &len) != ESP_OK || len != sizeof(s_ring) || s_ring.count > RESET_LOG_ENTRIES) {
        std::memset(&s_ring, 0, sizeof(s_ring));
    }
    std::memmove(&s_ring.e[1], &s_ring.e[0], sizeof(Entry) * (RESET_LOG_ENTRIES - 1));
    s_ring.e[0] = s_entry;
    if (s_ring.count < RESET_LOG_ENTRIES) s_ring.count++;
    nvs_set_u32(h, "seq", seq);
    nvs_set_blob(h, "ring", &s_ring, sizeof(s_ring));
    nvs_commit(h);
    nvs_close(h);
}

void reset_log_live() {
    if (!g_flightOn) return;
    refresh_names();
    g_fl.freeInternal = (uint32_t) heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    g_fl.minFreeInternal = (uint32_t) heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    g_fl.freePsram = (uint32_t) heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    g_fl.upKus = now_kus();
}

void reset_log_net(const char *step) {
    if (!g_flightOn) return;
    size_t k = 0;
    for (; step && step[k] && k < sizeof(g_fl.net) - 1; k++) g_fl.net[k] = step[k];
    g_fl.net[k] = '\0';
    g_fl.netKus = now_kus();
}

const char *reset_log_summary() {
    return s_summary;
}

void reset_log_register_routes() {
    httpd_handle_t server = web_server_get_handle();
    if (server == nullptr) return;
    httpd_uri_t uri = {.uri = "/resets", .method = HTTP_GET, .handler = handle_resets, .user_ctx = nullptr,
                       .is_websocket = false, .handle_ws_control_frames = false, .supported_subprotocol = nullptr};
    if (httpd_register_uri_handler(server, &uri) != ESP_OK) ESP_LOGE(TAG, "couldn't register /resets");
}
