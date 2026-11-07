#include "closer_report.hpp"

#include "wifi_connect.hpp"
#include "ws_broadcast.hpp"
#include "ina260.hpp"
#include "cam_link.hpp"
#include "ping_diag.hpp"
#include "closer_update.hpp"
#include "cam_stream.hpp"
#include "diagnostics.hpp"
#include "cpu_trace.h"
#include "watchdog.hpp"
#include "breadcrumb.hpp"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_memory_utils.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_random.h"
#include "miniz.h"
#include "nvs.h"

static const char *TAG = "closer";

namespace {

constexpr const char *REPORT_URL = "https://closer.ram.eemcs.utwente.nl/labdemos/api/heartbeat";
constexpr const char *TRACE_URL = "https://closer.ram.eemcs.utwente.nl/labdemos/api/trace";
constexpr uint32_t TRACE_MS = 1000;
constexpr int64_t TRACE_MIN_GAP_US = 10 * 1000000; // between two recordings, whoever asks
constexpr size_t CAM_BLOB_MAX = 1024 * 1024;
constexpr int INTERVAL_S = 60;
// After a failed report (no network route yet, server restarting): try again
// sooner than a full interval, so the page notices a fresh boot quickly.
constexpr int RETRY_S = 15;
constexpr const char *NVS_NAMESPACE = "closer";
constexpr const char *NVS_KEY = "key";

char deviceKey[96];     // "<demo id>.<secret>"
char demoId[48];
char lastResult[64];
TaskHandle_t reportTask = nullptr;
volatile bool reportNow = false; // closer_report_now()
volatile bool traceWanted = false;
const char *volatile traceState = "idle"; // "recording", "uploading", then how the last one went
int64_t lastTraceUs = -TRACE_MIN_GAP_US;
bool bootSent = false;  // "boot" (with the reset reason) goes once per power-up, then "beat"

// Why the chip last started -- same names as the other lab demos report, so
// the page's "Restarts (24 h)" and reset column read alike for all of them.
const char *reset_reason() {
    switch (esp_reset_reason()) {
        case ESP_RST_POWERON: return "power_on";
        case ESP_RST_EXT: return "reset_pin";
        case ESP_RST_SW: return "software";
        case ESP_RST_PANIC: return "crash";
        case ESP_RST_INT_WDT: return "interrupt_watchdog";
        case ESP_RST_TASK_WDT: return "task_watchdog";
        case ESP_RST_WDT: return "watchdog";
        case ESP_RST_DEEPSLEEP: return "deep_sleep";
        case ESP_RST_BROWNOUT: return "brownout";
        case ESP_RST_USB: return "usb";
        case ESP_RST_JTAG: return "jtag";
        case ESP_RST_PWR_GLITCH: return "power_glitch";
        case ESP_RST_CPU_LOCKUP: return "cpu_lockup";
        default: return "unknown";
    }
}

void load_key() {
    deviceKey[0] = '\0';
    demoId[0] = '\0';
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        size_t n = sizeof(deviceKey);
        if (nvs_get_str(h, NVS_KEY, deviceKey, &n) != ESP_OK) deviceKey[0] = '\0';
        nvs_close(h);
    }
    const char *dot = std::strchr(deviceKey, '.');
    if (dot) {
        size_t n = (size_t) (dot - deviceKey);
        if (n >= sizeof(demoId)) n = sizeof(demoId) - 1;
        std::memcpy(demoId, deviceKey, n);
        demoId[n] = '\0';
    }
}

char *build_report(const char *event) {
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "event", event);
    if (std::strcmp(event, "boot") == 0) cJSON_AddStringToObject(j, "reset", reset_reason());

    WifiStatus ws;
    wifi_get_status(&ws);
    cJSON_AddStringToObject(j, "ip", ws.ip);
    cJSON_AddStringToObject(j, "hostname", "lynxp");
    cJSON_AddStringToObject(j, "fw", esp_app_get_description()->version);
    cJSON_AddNumberToObject(j, "uptime_s", (double) (esp_timer_get_time() / 1000000));
    if (ws.connected) {
        char b[18];
        snprintf(b, sizeof(b), "%02x:%02x:%02x:%02x:%02x:%02x",
                 ws.bssid[0], ws.bssid[1], ws.bssid[2], ws.bssid[3], ws.bssid[4], ws.bssid[5]);
        cJSON_AddNumberToObject(j, "rssi", ws.rssi);
        cJSON_AddStringToObject(j, "ssid", ws.ssid);
        cJSON_AddStringToObject(j, "bssid", b);
        cJSON_AddNumberToObject(j, "channel", ws.channel);
    }
    // Internal RAM only: PSRAM's 8 MB would hide the number that matters.
    cJSON_AddNumberToObject(j, "heap_free", heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    cJSON_AddNumberToObject(j, "interval", INTERVAL_S);
    cJSON_AddNumberToObject(j, "clients", ws_broadcast_client_count());

    // The page labels a stat with its key ('_' -> ' '), so the keys carry
    // their units. Not "battery_v": that is a Li-ion cell voltage on the page
    // (charge estimate); this is the USB-PD bus behind the powerbank.
    cJSON *stats = cJSON_AddObjectToObject(j, "stats");
    float v, ma, mw;
    if (ina260_is_available() && ina260_read(&v, &ma, &mw)) {
        cJSON_AddNumberToObject(stats, "supply [V]", v);
        cJSON_AddNumberToObject(stats, "current [mA]", ma);
        cJSON_AddNumberToObject(stats, "power [W]", mw / 1000.0f);
    }
    if (ws.apActive) cJSON_AddNumberToObject(stats, "hotspot clients", ws.apClients);

    // The link to the camera board (ESP32-S3): its status line over SPI
    // every second or so (cam_link.cpp), and pings to it over Wi-Fi.
    // "cam_rssi" (the camera's Wi-Fi signal) is the key the page's diagram
    // shows the camera as active by -- so only while the link is up.
    const CamDiagnostics &cam = cam_link_get_diagnostics();
    uint32_t camAgeS = cam_link_peer_age_s();
    if (camAgeS != UINT32_MAX) cJSON_AddNumberToObject(stats, "cam link age [s]", camAgeS);
    if (!cam_link_peer_is_stale() && cam.rssiDbm != 0) cJSON_AddNumberToObject(stats, "cam_rssi", cam.rssiDbm);
    PingStats ping = ping_diag_get_stats();
    if (ping.active && ping.received > 0) cJSON_AddNumberToObject(stats, "cam ping [ms]", ping.avgRttMs);
    if (camAgeS == UINT32_MAX) {
        cJSON_AddStringToObject(j, "message", "Camera link: no status from the ESP32-S3 since the robot started");
    } else if (cam_link_peer_is_stale()) {
        char msg[96];
        snprintf(msg, sizeof(msg), "Camera link down: no status from the ESP32-S3 for %lu s", (unsigned long) camAgeS);
        cJSON_AddStringToObject(j, "message", msg);
    } else if (closer_update_state()[0]) {
        char msg[120]; // (the server takes messages up to 120 characters)
        snprintf(msg, sizeof(msg), "%s", closer_update_state());
        cJSON_AddStringToObject(j, "message", msg);
    }

    // After a hang restart, the boot report says where the two tracked tasks
    // were (breadcrumb.hpp) -- the lab demos server keeps it in its log, so a
    // hang far from any serial console still leaves a trace.
    if (std::strcmp(event, "boot") == 0 && watchdog_last_reboot_was_hang()) {
        const BreadcrumbSnapshot &bc = breadcrumb_get_boot_snapshot();
        char msg[120]; // (the server takes messages up to 120 characters)
        const char *wdt = watchdog_twdt_culprits();
        if (wdt[0]) {
            // (the task watchdog's own record first: who didn't check in)
            snprintf(msg, sizeof(msg), "task wdt:%.70s; control at %s, ws at %s", wdt,
                     breadcrumb_core1_checkpoint_name(bc.core1Checkpoint), breadcrumb_core0_checkpoint_name(bc.core0Checkpoint));
        } else {
            snprintf(msg, sizeof(msg), "hang: control at %s (tick %lu), ws at %s, last WS '%s'",
                     breadcrumb_core1_checkpoint_name(bc.core1Checkpoint), (unsigned long) bc.core1TickCountAtLastMark,
                     breadcrumb_core0_checkpoint_name(bc.core0Checkpoint), bc.lastWsMessageType);
        }
        cJSON_DeleteItemFromObject(j, "message");
        cJSON_AddStringToObject(j, "message", msg);
    }

    char *out = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    return out;
}

// The server's reply to a heartbeat (small JSON): "update" offers a release
// (closer_update.hpp); "trace": true asks for a recording (the page's button,
// when the server can't reach this robot).
struct Reply {
    char text[1024];
    int len;
};

esp_err_t on_http_event(esp_http_client_event_t *e) {
    Reply *r = (Reply *) e->user_data;
    if (e->event_id == HTTP_EVENT_ON_DATA && r != nullptr) {
        int n = e->data_len;
        if (n > (int) sizeof(r->text) - 1 - r->len) n = (int) sizeof(r->text) - 1 - r->len;
        if (n > 0) {
            std::memcpy(r->text + r->len, e->data, (size_t) n);
            r->len += n;
            r->text[r->len] = '\0';
        }
    }
    return ESP_OK;
}

// True if the server took the report.
bool send_report() {
    const char *event = bootSent ? "beat" : "boot";
    char *body = build_report(event);
    if (!body) return false;
    esp_http_client_config_t cfg = {};
    cfg.url = REPORT_URL;
    cfg.method = HTTP_METHOD_POST;
    cfg.crt_bundle_attach = esp_crt_bundle_attach;
    cfg.timeout_ms = 10000;
    Reply reply = {};
    cfg.event_handler = on_http_event;
    cfg.user_data = &reply;
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    bool ok = false;
    if (c) {
        char auth[sizeof(deviceKey) + 8];
        snprintf(auth, sizeof(auth), "Bearer %s", deviceKey);
        esp_http_client_set_header(c, "Authorization", auth);
        esp_http_client_set_header(c, "Content-Type", "application/json");
        esp_http_client_set_post_field(c, body, (int) std::strlen(body));
        esp_err_t err = esp_http_client_perform(c);
        int status = esp_http_client_get_status_code(c);
        if (err != ESP_OK) {
            snprintf(lastResult, sizeof(lastResult), "%s: %s", event, esp_err_to_name(err));
        } else {
            snprintf(lastResult, sizeof(lastResult), "%s: HTTP %d", event, status);
            ok = (status == 200);
            if (ok && std::strstr(reply.text, "\"trace\":true")) closer_report_request_trace();
        }
        if (status == 401) ESP_LOGW(TAG, "the server doesn't know this device key (closer key <key>)");
        esp_http_client_cleanup(c);
    }
    cJSON_free(body);
    ESP_LOGI(TAG, "report %s", lastResult);
    if (ok) bootSent = true;
    if (ok) closer_update_on_reply(reply.text); // (after the connection is closed: an update opens its own)
    return ok;
}

// The camera's recording (GET /cputrace on its own web server, over Wi-Fi):
// length, and the blob in PSRAM in *out (free() it); 0 if none.
size_t fetch_cam_blob(uint8_t **out) {
    *out = nullptr;
    const char *ip = cam_link_get_peer_ip();
    if (ip[0] == '\0' || std::strcmp(ip, "0.0.0.0") == 0) return 0;
    char url[48];
    snprintf(url, sizeof(url), "http://%s/cputrace", ip);
    esp_http_client_config_t cfg = {};
    cfg.url = url;
    cfg.timeout_ms = 5000;
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (c == nullptr) return 0;
    size_t got = 0;
    if (esp_http_client_open(c, 0) == ESP_OK) {
        int64_t len = esp_http_client_fetch_headers(c);
        if (esp_http_client_get_status_code(c) == 200 && len > 0 && len <= (int64_t) CAM_BLOB_MAX) {
            uint8_t *buf = (uint8_t *) heap_caps_malloc((size_t) len, MALLOC_CAP_SPIRAM);
            while (buf != nullptr && got < (size_t) len) {
                int n = esp_http_client_read(c, (char *) buf + got, (int) ((size_t) len - got));
                if (n <= 0) break;
                got += (size_t) n;
            }
            if (buf != nullptr && got == (size_t) len) {
                *out = buf;
            } else {
                free(buf);
                got = 0;
            }
        }
    }
    esp_http_client_cleanup(c);
    return got;
}

// What holds the internal RAM, for the trace's "ram": the heap's totals, each
// task's stack (size: its heap block; where; the least it ever had left), and
// the other allocated blocks -- the big ones one by one, the rest summed.
// (heap_caps_walk holds the heap lock: the callback only copies, into PSRAM.)
struct RamBlock {
    uintptr_t ptr;
    uint32_t size;
};
struct RamWalk {
    RamBlock *big;
    int nBig, maxBig;
    uint32_t smallCount, smallBytes, freeBytes, freeCount;
};
bool ram_walk_cb(walker_heap_into_t, walker_block_info_t b, void *u) {
    auto *w = (RamWalk *) u;
    if (!b.used) {
        w->freeBytes += b.size;
        w->freeCount++;
    } else if (b.size >= 512 && w->nBig < w->maxBig) {
        w->big[w->nBig++] = {(uintptr_t) b.ptr, (uint32_t) b.size};
    } else {
        w->smallCount++;
        w->smallBytes += b.size;
    }
    return true;
}
void add_ram(cJSON *j) {
    cJSON *ram = cJSON_AddObjectToObject(j, "ram");
    multi_heap_info_t info;
    heap_caps_get_info(&info, MALLOC_CAP_INTERNAL);
    cJSON_AddNumberToObject(ram, "heap_total", heap_caps_get_total_size(MALLOC_CAP_INTERNAL));
    cJSON_AddNumberToObject(ram, "allocated", info.total_allocated_bytes);
    cJSON_AddNumberToObject(ram, "free", info.total_free_bytes);
    cJSON_AddNumberToObject(ram, "largest_free", info.largest_free_block);
    cJSON_AddNumberToObject(ram, "min_free", info.minimum_free_bytes);
    cJSON_AddNumberToObject(ram, "blocks", info.allocated_blocks);
    cJSON_AddNumberToObject(ram, "dma_free", heap_caps_get_free_size(MALLOC_CAP_DMA));
    RamWalk w = {};
    w.maxBig = 300;
    w.big = (RamBlock *) heap_caps_malloc(sizeof(RamBlock) * w.maxBig, MALLOC_CAP_SPIRAM);
    UBaseType_t nTasks = uxTaskGetNumberOfTasks() + 4;
    auto *ts = (TaskStatus_t *) heap_caps_malloc(sizeof(TaskStatus_t) * nTasks, MALLOC_CAP_SPIRAM);
    if (w.big == nullptr || ts == nullptr) {
        heap_caps_free(w.big);
        heap_caps_free(ts);
        return;
    }
    nTasks = uxTaskGetSystemState(ts, nTasks, nullptr);
    heap_caps_walk(MALLOC_CAP_INTERNAL, ram_walk_cb, &w);
    // (as text, not hundreds of cJSON items: those would take internal RAM)
    constexpr size_t TXT = 6000;
    char *txt = (char *) heap_caps_malloc(TXT, MALLOC_CAP_SPIRAM);
    if (txt == nullptr) {
        heap_caps_free(w.big);
        heap_caps_free(ts);
        return;
    }
    size_t at = 0;
    txt[0] = '\0';
    // "name prio stack-bytes unused-min-words I|P; ..."
    for (UBaseType_t i = 0; i < nTasks; i++) {
        uintptr_t base = (uintptr_t) ts[i].pxStackBase;
        uint32_t size = 0;
        for (int k = 0; k < w.nBig; k++) {
            if (base >= w.big[k].ptr && base < w.big[k].ptr + (w.big[k].size & 0x7FFFFFFFu)) {
                size = w.big[k].size & 0x7FFFFFFFu;
                w.big[k].size |= 0x80000000u; // (counted as a stack)
                break;
            }
        }
        if (at < TXT - 64) at += snprintf(txt + at, TXT - at, "%s%s %u %lu %u %c", i ? "; " : "", ts[i].pcTaskName,
                                          (unsigned) ts[i].uxCurrentPriority, (unsigned long) size,
                                          (unsigned) ts[i].usStackHighWaterMark, esp_ptr_internal(ts[i].pxStackBase) ? 'I' : 'P');
    }
    cJSON_AddStringToObject(ram, "tasks", txt);
    std::sort(w.big, w.big + w.nBig, [](const RamBlock &x, const RamBlock &y) { return (x.size & 0x7FFFFFFFu) > (y.size & 0x7FFFFFFFu); });
    uint32_t stacks = 0;
    at = 0;
    txt[0] = '\0';
    for (int k = 0; k < w.nBig; k++) {
        if (w.big[k].size & 0x80000000u) stacks += w.big[k].size & 0x7FFFFFFFu;
        else if (at < TXT - 16) at += snprintf(txt + at, TXT - at, "%s%lu", at ? " " : "", (unsigned long) w.big[k].size);
    }
    cJSON_AddStringToObject(ram, "other_blocks", txt); // (sizes, the biggest first; the stacks left out)
    heap_caps_free(txt);
    cJSON_AddNumberToObject(ram, "stacks", stacks);
    cJSON_AddNumberToObject(ram, "small_blocks", w.smallCount);
    cJSON_AddNumberToObject(ram, "small_bytes", w.smallBytes);
    cJSON_AddNumberToObject(ram, "walk_free", w.freeBytes);
    cJSON_AddNumberToObject(ram, "free_pieces", w.freeCount);
    cJSON_AddBoolToObject(ram, "truncated", w.nBig == w.maxBig);
    heap_caps_free(w.big);
    heap_caps_free(ts);
}

// What was going on during the recording, for the page: Wi-Fi, the camera
// link, video, the control loop.
char *build_trace_meta(bool camAsked) {
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "fw", esp_app_get_description()->version);
    cJSON_AddNumberToObject(j, "uptime_s", (double) (esp_timer_get_time() / 1000000));
    cJSON_AddBoolToObject(j, "cam_asked", camAsked);
    WifiStatus ws;
    wifi_get_status(&ws);
    cJSON *wifi = cJSON_AddObjectToObject(j, "wifi");
    cJSON_AddNumberToObject(wifi, "rssi", ws.rssi);
    cJSON_AddNumberToObject(wifi, "channel", ws.channel);
    cJSON_AddBoolToObject(wifi, "band5", ws.connectedOn5Ghz);
    cJSON_AddNumberToObject(j, "ws_clients", ws_broadcast_client_count());
    char buf[800];
    if (cam_link_raw_json(buf, sizeof(buf)) > 0) cJSON_AddItemToObject(j, "link", cJSON_Parse(buf));
    if (cam_link_video_json(buf, sizeof(buf)) > 0) cJSON_AddItemToObject(j, "video", cJSON_Parse(buf));
    if (cam_stream_json(buf, sizeof(buf)) > 0) cJSON_AddItemToObject(j, "stream", cJSON_Parse(buf));
    const CamDiagnostics &cd = cam_link_get_diagnostics();
    cJSON *cam = cJSON_AddObjectToObject(j, "camera");
    cJSON_AddStringToObject(cam, "ip", cd.ip);
    cJSON_AddNumberToObject(cam, "rssi", cd.rssiDbm);
    cJSON_AddNumberToObject(cam, "viewers", cd.clients);
    cJSON_AddBoolToObject(cam, "stale", cam_link_peer_is_stale());
    DiagnosticsSnapshot d;
    diagnostics_get_snapshot(&d);
    cJSON *ctl = cJSON_AddObjectToObject(j, "control");
    cJSON_AddNumberToObject(ctl, "hz", d.core1HzMeasured);
    cJSON_AddNumberToObject(ctl, "avg_us", d.core1TickAvgUs);
    cJSON_AddNumberToObject(ctl, "max_us", d.core1TickMaxUs);
    cJSON_AddNumberToObject(j, "heap_free", heap_caps_get_free_size(MALLOC_CAP_INTERNAL));
    cJSON_AddNumberToObject(j, "psram_free", heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
    add_ram(j);
    char *out = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    return out;
}

void put32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t) v;
    p[1] = (uint8_t) (v >> 8);
    p[2] = (uint8_t) (v >> 16);
    p[3] = (uint8_t) (v >> 24);
}

// zlib-compresses the upload (the ROM's miniz deflate), into PSRAM: 0 (and
// nothing in *out) if that didn't work -- then it goes uncompressed. In
// steps of 16 KB with a tick's pause after each: a few hundred KB at once
// would keep everything below this task off the CPU for most of a second.
size_t compress_trace(const uint8_t *in, size_t len, uint8_t **out) {
    *out = nullptr;
    auto *d = (tdefl_compressor *) heap_caps_malloc(sizeof(tdefl_compressor), MALLOC_CAP_SPIRAM);
    size_t cap = len + len / 8 + 1024;
    auto *buf = (uint8_t *) heap_caps_malloc(cap, MALLOC_CAP_SPIRAM);
    size_t done = 0, made = 0;
    tdefl_status st = TDEFL_STATUS_BAD_PARAM;
    if (d != nullptr && buf != nullptr && tdefl_init(d, nullptr, nullptr, TDEFL_WRITE_ZLIB_HEADER | 32) == TDEFL_STATUS_OKAY) {
        do {
            size_t inSize = std::min<size_t>(len - done, 16384);
            size_t outSize = cap - made;
            bool last = done + inSize == len;
            st = tdefl_compress(d, in + done, &inSize, buf + made, &outSize, last ? TDEFL_FINISH : TDEFL_NO_FLUSH);
            done += inSize;
            made += outSize;
            vTaskDelay(1);
        } while (st == TDEFL_STATUS_OKAY && made < cap);
    }
    free(d);
    if (st != TDEFL_STATUS_DONE) {
        free(buf);
        return 0;
    }
    *out = buf;
    return made;
}

// POSTs the upload in pieces of 16 KB (TRACE_URL/<id>?upload=&offset=&total=
// [&z=1]); the server answers with how much it has ("have"), and after a
// connection breaks off the next piece starts there -- at home the
// connection to the server breaks off every few seconds, and a single POST
// of a few hundred KB never got through. 200 when all of it is in (the last
// piece's answer), -1 without a connection, else the refusing HTTP status.
int upload_trace(const uint8_t *data, size_t len, bool zlibbed) {
    constexpr size_t PIECE = 16384;
    char id[12];
    snprintf(id, sizeof(id), "%08lx", (unsigned long) esp_random());
    char auth[sizeof(deviceKey) + 8];
    snprintf(auth, sizeof(auth), "Bearer %s", deviceKey);
    char url[192];
    snprintf(url, sizeof(url), "%s/%s", TRACE_URL, demoId);
    esp_http_client_config_t cfg = {};
    cfg.url = url;
    cfg.method = HTTP_METHOD_POST;
    cfg.crt_bundle_attach = esp_crt_bundle_attach;
    cfg.timeout_ms = 15000;
    cfg.event_handler = on_http_event;
    Reply reply = {};
    cfg.user_data = &reply;
    esp_http_client_handle_t c = nullptr;
    size_t have = 0;
    int status = -1, stuck = 0;
    for (int attempt = 0; attempt < 80 && stuck < 5; attempt++) {
        if (c == nullptr) {
            c = esp_http_client_init(&cfg);
            if (c == nullptr) break;
            esp_http_client_set_header(c, "Authorization", auth);
            esp_http_client_set_header(c, "Content-Type", "application/octet-stream");
        }
        size_t n = std::min(PIECE, len - have);
        snprintf(url, sizeof(url), "%s/%s?upload=%s&offset=%u&total=%u%s", TRACE_URL, demoId, id, (unsigned) have,
                 (unsigned) len, zlibbed ? "&z=1" : "");
        esp_http_client_set_url(c, url);
        esp_http_client_set_post_field(c, (const char *) data + have, (int) n);
        reply.len = 0;
        reply.text[0] = '\0';
        esp_err_t err = esp_http_client_perform(c); // (the same connection while it lasts)
        status = err == ESP_OK ? esp_http_client_get_status_code(c) : -1;
        const char *h = std::strstr(reply.text, "\"have\":");
        size_t before = have;
        if ((status == 200 || status == 409) && h != nullptr) have = (size_t) std::strtoul(h + 7, nullptr, 10);
        if (status == 200 && have >= len) break;            // all in, and taken
        if (status != 200 && status != 409 && status > 0) break; // refused (bad key, bad data ...)
        if (status < 0) {                                   // broke off: a new connection
            esp_http_client_cleanup(c);
            c = nullptr;
            vTaskDelay(pdMS_TO_TICKS(500));
        }
        stuck = have > before ? 0 : stuck + 1;
    }
    if (c != nullptr) esp_http_client_cleanup(c);
    return status == 200 && have >= len ? 200 : status == 409 ? -1 : status;
}

// One second on both chips (cpu_trace.h), then one upload (compressed, in pieces): "LXTR", u32
// length of the JSON that follows (build_trace_meta), the JSON, the robot's
// blob, the camera's blob (if it sent one). Nothing goes out while recording.
void run_trace() {
    lastTraceUs = esp_timer_get_time();
    traceState = "recording";
    bool camAsked = cam_link_request_cam_trace((int) TRACE_MS);
    if (!cpu_trace_start(TRACE_MS, "ESP32-C5")) {
        traceState = "failed: no memory";
        return;
    }
    vTaskDelay(pdMS_TO_TICKS(TRACE_MS + 100));
    char *meta = build_trace_meta(camAsked); // (right after: what was going on)
    uint8_t *mine = nullptr, *cam = nullptr;
    size_t mineLen = cpu_trace_blob(&mine), camLen = 0;
    traceState = "uploading";
    for (int i = 0; camAsked && camLen == 0 && i < 4; i++) { // (the camera started a little later)
        vTaskDelay(pdMS_TO_TICKS(300));
        camLen = fetch_cam_blob(&cam);
    }
    size_t metaLen = meta ? std::strlen(meta) : 0;
    size_t len = 8 + metaLen + mineLen + camLen;
    uint8_t *body = (uint8_t *) heap_caps_malloc(len, MALLOC_CAP_SPIRAM);
    if (body != nullptr && mineLen > 0) {
        std::memcpy(body, "LXTR", 4);
        put32(body + 4, (uint32_t) metaLen);
        std::memcpy(body + 8, meta, metaLen);
        std::memcpy(body + 8 + metaLen, mine, mineLen);
        if (camLen) std::memcpy(body + 8 + metaLen + mineLen, cam, camLen);
        uint8_t *packed = nullptr;
        size_t packedLen = compress_trace(body, len, &packed);
        const uint8_t *send = packed ? packed : body;
        size_t sendLen = packed ? packedLen : len;
        int status = upload_trace(send, sendLen, packed != nullptr);
        traceState = status == 200 ? (camLen ? "sent" : "sent (robot only)") : status < 0 ? "failed: no connection" : "failed: refused";
        ESP_LOGI(TAG, "trace: %u + %u bytes, sent as %u, HTTP %d", (unsigned) mineLen, (unsigned) camLen, (unsigned) sendLen, status);
        free(packed);
    } else {
        traceState = "failed: no memory";
    }
    free(body);
    free(mine);
    free(cam);
    cJSON_free(meta);
}

void report_task(void *) {
    int64_t nextReport = 0;
    for (;;) {
        if (traceWanted && deviceKey[0] && wifi_is_connected()) {
            traceWanted = false;
            run_trace();
        }
        if (reportNow || esp_timer_get_time() >= nextReport) {
            reportNow = false;
            int waitS = INTERVAL_S;
            if (deviceKey[0] && wifi_is_connected()) {
                if (!send_report()) waitS = RETRY_S;
                closer_update_run_pending(); // (an update the reply offered: the next report waits for it)
            } else if (deviceKey[0]) {
                waitS = 5; // waiting for Wi-Fi: report as soon as it's up
            }
            nextReport = esp_timer_get_time() + (int64_t) waitS * 1000000;
        }
        // Until the next report, closer_report_now() or a recording is asked for.
        int64_t waitMs = (nextReport - esp_timer_get_time()) / 1000;
        ulTaskNotifyTake(pdTRUE, pdMS_TO_TICKS(waitMs > 0 ? waitMs : 1));
    }
}

} // namespace

void closer_report_start() {
    load_key();
    closer_update_init();
    if (!demoId[0]) ESP_LOGI(TAG, "no lab demos key stored -- not reporting (closer key <key>)");
    // 8 KB: the TLS handshake (mbedTLS + certificate bundle) is stack-hungry.
    // Priority 1, below everything that matters.
    xTaskCreate(report_task, "closer_report", 8192, nullptr, 1, &reportTask);
}

bool closer_report_set_key(const char *key) {
    if (std::strlen(key) >= sizeof(deviceKey)) return false;
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t err = key[0] ? nvs_set_str(h, NVS_KEY, key) : nvs_erase_key(h, NVS_KEY);
    if (err == ESP_ERR_NVS_NOT_FOUND) err = ESP_OK;
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) return false;
    load_key();
    bootSent = false; // a new identity starts with a boot report
    return true;
}

const char *closer_report_demo_id() { return demoId; }
const char *closer_report_device_key() { return deviceKey; }

void closer_report_now() {
    reportNow = true;
    if (reportTask != nullptr) xTaskNotifyGive(reportTask);
}

bool closer_report_request_trace() {
    if (!deviceKey[0] || reportTask == nullptr || traceWanted || cpu_trace_running()) return false;
    if (esp_timer_get_time() - lastTraceUs < TRACE_MIN_GAP_US) return false;
    traceWanted = true;
    traceState = "asked";
    xTaskNotifyGive(reportTask);
    return true;
}

const char *closer_report_trace_state() { return traceState; }
const char *closer_report_last_result() { return lastResult; }
