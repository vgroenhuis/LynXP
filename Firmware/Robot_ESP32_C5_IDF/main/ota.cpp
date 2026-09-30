#include "ota.hpp"
#include "web_server.hpp"
#include "wifi_connect.hpp"
#include "control_task.hpp"
#include "control_modes.hpp"
#include "motors.hpp"
#include "littlefs_init.hpp"
#include "settings.hpp"

#include "esp_http_server.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_littlefs.h"
#include "esp_log.h"
#include "esp_task_wdt.h"
#include "esp_phy_init.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "miniz.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace {

const char *TAG = "ota";

constexpr size_t RECV_CHUNK = 1024;

// Minimal, dependency-free base64 decoder (no mbedtls link needed just for
// this) -- only ever fed the "user:pass" payload of an Authorization: Basic
// header below, so it doesn't need to handle arbitrary/malformed input
// gracefully beyond not overrunning `out`.
int base64_decode(const char *in, size_t inLen, uint8_t *out, size_t outCap) {
    auto digitValue = [](char c) -> int {
        if (c >= 'A' && c <= 'Z') return c - 'A';
        if (c >= 'a' && c <= 'z') return c - 'a' + 26;
        if (c >= '0' && c <= '9') return c - '0' + 52;
        if (c == '+') return 62;
        if (c == '/') return 63;
        return -1;
    };
    size_t outLen = 0;
    int bits = 0, accum = 0;
    for (size_t i = 0; i < inLen && in[i] != '='; i++) {
        int v = digitValue(in[i]);
        if (v < 0) continue;
        accum = (accum << 6) | v;
        bits += 6;
        if (bits >= 8) {
            bits -= 8;
            if (outLen >= outCap) return -1;
            out[outLen++] = (uint8_t) ((accum >> bits) & 0xFF);
        }
    }
    return (int) outLen;
}

// Guards /update and /update-fs. settings.otaPassword empty means auth is
// disabled -- the pre-existing open behavior, kept as the default so a
// firmware update never locks the user out with credentials they didn't
// knowingly set (see settings.cpp's applyDefaultSettings()).
bool ota_check_basic_auth(httpd_req_t *req) {
    if (settings.otaPassword[0] == '\0') {
        return true;
    }

    char authHdr[128];
    if (httpd_req_get_hdr_value_str(req, "Authorization", authHdr, sizeof(authHdr)) != ESP_OK) {
        return false;
    }
    constexpr char PREFIX[] = "Basic ";
    if (std::strncmp(authHdr, PREFIX, sizeof(PREFIX) - 1) != 0) {
        return false;
    }

    const char *b64 = authHdr + sizeof(PREFIX) - 1;
    uint8_t decoded[96];
    int decodedLen = base64_decode(b64, std::strlen(b64), decoded, sizeof(decoded) - 1);
    if (decodedLen <= 0) {
        return false;
    }
    decoded[decodedLen] = '\0';

    char expected[sizeof(settings.otaUsername) + 1 + sizeof(settings.otaPassword)];
    int expectedLen = snprintf(expected, sizeof(expected), "%s:%s", settings.otaUsername, settings.otaPassword);
    // Constant-time: the time taken doesn't reveal how many leading
    // characters of a guess were right.
    uint8_t diff = (uint8_t) (decodedLen != expectedLen);
    for (int i = 0; i < expectedLen; i++) {
        diff |= (uint8_t) (decoded[i < decodedLen ? i : 0] ^ (uint8_t) expected[i]);
    }
    return diff == 0;
}

void send_unauthorized(httpd_req_t *req) {
    httpd_resp_set_status(req, "401 Unauthorized");
    httpd_resp_set_hdr(req, "WWW-Authenticate", "Basic realm=\"OTA Update\"");
    httpd_resp_set_type(req, "text/plain");
    httpd_resp_sendstr(req, "Unauthorized");
}

// Zero pulse means no signal on the control wire at all, not just "centered"
// -- a standard analog hobby servo with no pulse train stops actively
// correcting its position and draws close to nothing, same idea as
// motors_coast_all() above but for the servos. Cuts their contribution to
// the current draw during the erase/write loop below, on top of the motors
// already coasting -- suspected (unconfirmed) to matter for a marginal
// power supply. Both a no-op if the servos are physically disconnected.
void disable_servos() {
    servo_set_pulse_us(0);
    tilt_servo_set_pulse_us(0);
}

// Only needed on the failure paths below (the success path reboots, and
// web_server_recenter_servo() re-drives both servos from scratch on the
// next boot) -- restores whatever angle each servo was actually at before
// disable_servos() silenced it.
void restore_servos() {
    servo_set_pulse_us(computeServoPulseUs(currentServoAngleDeg));
    tilt_servo_set_pulse_us(computeTiltServoPulseUs(currentTiltAngleDeg));
}

esp_err_t handle_update_post(httpd_req_t *req) {
    if (!ota_check_basic_auth(req)) {
        ESP_LOGW(TAG, "/update rejected: bad or missing credentials");
        send_unauthorized(req);
        return ESP_OK;
    }

    // Stop the robot before touching flash -- esp_ota_write()'s internal
    // erase disables the flash cache on both cores for the duration, and
    // nothing should keep commanding motors through that.
    stopAllMotion();
    motors_coast_all();
    disable_servos();

    const esp_partition_t *updatePartition = esp_ota_get_next_update_partition(nullptr);
    if (updatePartition == nullptr) {
        httpd_resp_send_500(req);
        return ESP_OK;
    }

    // Same reasoning as handle_update_fs_post(): esp_ota_write()'s internal
    // erase/program disables the flash cache for its duration, during which
    // NO code executing from flash can run at all -- on the C5's single
    // core, that's not "competing for CPU time with another core," it's
    // everything stalling outright. Once cache re-enables and the scheduler
    // resumes, control_task.cpp needs to feed its task-watchdog subscription
    // within 3s; enough small stalls back to back can eat into that margin
    // -- confirmed empirically for the larger filesystem OTA below. Applied
    // here too since the mechanism is identical, just less likely to be hit
    // given a firmware image is normally smaller.
    TaskHandle_t ctrlTask = control_task_get_handle();
    esp_task_wdt_delete(ctrlTask);
    vTaskSuspend(ctrlTask);

    esp_ota_handle_t otaHandle = 0;
    esp_err_t err = esp_ota_begin(updatePartition, OTA_SIZE_UNKNOWN, &otaHandle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_begin failed: %s", esp_err_to_name(err));
        vTaskResume(ctrlTask);
        esp_task_wdt_add(ctrlTask);
        restore_servos();
        httpd_resp_send_500(req);
        return ESP_OK;
    }

    char buf[RECV_CHUNK];
    int remaining = (int) req->content_len;
    while (remaining > 0) {
        int recvLen = web_server_recv(req, buf, (size_t) std::min((int) sizeof(buf), remaining));
        if (recvLen <= 0) {
            esp_ota_abort(otaHandle);
            vTaskResume(ctrlTask);
            esp_task_wdt_add(ctrlTask);
            restore_servos();
            httpd_resp_send_500(req);
            return ESP_OK;
        }
        err = esp_ota_write(otaHandle, buf, recvLen);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "esp_ota_write failed: %s", esp_err_to_name(err));
            esp_ota_abort(otaHandle);
            vTaskResume(ctrlTask);
            esp_task_wdt_add(ctrlTask);
            restore_servos();
            httpd_resp_send_500(req);
            return ESP_OK;
        }
        remaining -= recvLen;
    }

    err = esp_ota_end(otaHandle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_end failed: %s", esp_err_to_name(err));
        vTaskResume(ctrlTask);
        esp_task_wdt_add(ctrlTask);
        restore_servos();
        httpd_resp_sendstr(req, "OTA image validation failed");
        return ESP_OK;
    }

    err = esp_ota_set_boot_partition(updatePartition);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "esp_ota_set_boot_partition failed: %s", esp_err_to_name(err));
        vTaskResume(ctrlTask);
        esp_task_wdt_add(ctrlTask);
        restore_servos();
        httpd_resp_send_500(req);
        return ESP_OK;
    }

    httpd_resp_sendstr(req, "OK, rebooting into new firmware...");
    ESP_LOGI(TAG, "OTA update complete, rebooting");
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
    return ESP_OK;
}

// -- compressed web image ------------------------------------------------------
// POST /update-fs?format=zlib: the same LittleFS image, zlib-compressed. The
// image is the whole ~12 MB partition but mostly empty (0xFF) blocks, so it
// compresses to a few hundred KB: the upload takes seconds instead of ~45 s.
// Writing then only touches the 4 KB sectors that actually differ from what's
// on flash (each one is read and compared first), so most of the partition is
// never erased at all. The end result is exactly the image, byte for byte --
// unlike just skipping empty blocks, which could leave an old LittleFS
// metadata block where the new image has an erased one.
//
// Decompressed twice: pass 1 only checks (a LittleFS image, fits the
// partition, zlib checksum OK) with nothing touched; pass 2 writes.

constexpr size_t FS_SECTOR = 4096;
constexpr size_t ZLIB_MAX_UPLOAD = 4 * 1024 * 1024; // a compressed web image is ~0.3 MB

// Takes the idle task off the task watchdog while alive. Checking and
// rewriting ~12 MB keeps this (httpd) task busy for seconds, and even with a
// 1-tick pause every 20 ms the idle task hardly got to run (measured: 3 runs in
// 2.3 s -- other ready tasks take the tick), so the idle check fired and
// rebooted the robot mid-update. The job is bounded and the robot reboots
// right after it; the watchdog keeps watching its subscribed tasks meanwhile.
struct IdleWatchdogPause {
    static esp_task_wdt_config_t config(uint32_t idleMask) {
        esp_task_wdt_config_t c = {};
        c.timeout_ms = CONFIG_ESP_TASK_WDT_TIMEOUT_S * 1000;
        c.idle_core_mask = idleMask;
        c.trigger_panic = true;
        return c;
    }
    IdleWatchdogPause() {
        esp_task_wdt_config_t c = config(0);
        esp_task_wdt_reconfigure(&c);
    }
    ~IdleWatchdogPause() {
        esp_task_wdt_config_t c = config(1); // CONFIG_ESP_TASK_WDT_CHECK_IDLE_TASK_CPU0
        esp_task_wdt_reconfigure(&c);
    }
};

bool is_blank(const uint8_t *p, size_t n) {
    for (size_t i = 0; i < n; i++) {
        if (p[i] != 0xFF) return false;
    }
    return true;
}

struct ImageSink {
    const esp_partition_t *part = nullptr;
    bool write = false;      // pass 2
    size_t total = 0;        // decompressed bytes so far
    uint8_t *sector = nullptr;
    size_t fill = 0;
    uint8_t *onFlash = nullptr;
    bool magic = false;      // "littlefs" at offset 8 of block 0 or 1
    size_t changed = 0;
    esp_err_t err = ESP_OK;
    int64_t lastBreathUs = 0;
    int64_t maxGapUs = 0;    // diagnostics: longest stretch without a yield
    int64_t maxFlashUs = 0;  // diagnostics: longest read+erase+write of one sector

    // Decompressing, comparing and rewriting ~12 MB is solid work for this
    // (httpd) task -- unlike an upload, which keeps waiting on the network.
    // Give the idle task a tick every 20 ms of it, or the task watchdog's
    // idle check fires (it did, with a yield only every 64 sectors: an erase
    // takes tens of ms, and a changed image moves hundreds of sectors).
    void breathe() {
        int64_t now = esp_timer_get_time();
        if (lastBreathUs != 0) maxGapUs = std::max(maxGapUs, now - lastBreathUs);
        if (lastBreathUs != 0 && now - lastBreathUs < 20000) return;
        vTaskDelay(1);
        lastBreathUs = esp_timer_get_time();
    }

    void flushSector() {
        size_t index = total / FS_SECTOR - 1; // total already counts this sector
        if (!write) {
            if (index <= 1 && std::memcmp(sector + 8, "littlefs", 8) == 0) magic = true;
            return;
        }
        if (index % 512 == 0) {
            ESP_LOGI(TAG, "zlib write: sector %u, %u rewritten so far (longest without a pause %lld ms, longest sector %lld ms)",
                     (unsigned) index, (unsigned) changed, (long long) (maxGapUs / 1000), (long long) (maxFlashUs / 1000));
        }
        size_t at = index * FS_SECTOR;
        int64_t t0 = esp_timer_get_time();
        err = esp_partition_read(part, at, onFlash, FS_SECTOR);
        if (err != ESP_OK || std::memcmp(onFlash, sector, FS_SECTOR) == 0) return;
        if (!is_blank(onFlash, FS_SECTOR)) err = esp_partition_erase_range(part, at, FS_SECTOR);
        if (err == ESP_OK && !is_blank(sector, FS_SECTOR)) err = esp_partition_write(part, at, sector, FS_SECTOR);
        maxFlashUs = std::max(maxFlashUs, esp_timer_get_time() - t0);
        changed++;
    }

    bool put(const uint8_t *p, size_t n) {
        while (n > 0 && err == ESP_OK) {
            size_t take = std::min(n, FS_SECTOR - fill);
            if (total + take > part->size) {
                err = ESP_ERR_INVALID_SIZE; // bigger than the partition
                break;
            }
            std::memcpy(sector + fill, p, take);
            fill += take;
            total += take;
            p += take;
            n -= take;
            if (fill == FS_SECTOR) {
                flushSector();
                fill = 0;
                breathe();
            }
        }
        return err == ESP_OK;
    }

    // After the stream: a partial last sector is padded with 0xFF, and the
    // rest of the partition (an image shorter than it) ends up erased too.
    void finish() {
        if (err == ESP_OK && fill > 0) {
            std::memset(sector + fill, 0xFF, FS_SECTOR - fill);
            total += FS_SECTOR - fill;
            flushSector();
            fill = 0;
        }
        if (!write) return;
        for (size_t at = total; err == ESP_OK && at + FS_SECTOR <= part->size; at += FS_SECTOR) {
            err = esp_partition_read(part, at, onFlash, FS_SECTOR);
            if (err == ESP_OK && !is_blank(onFlash, FS_SECTOR)) {
                err = esp_partition_erase_range(part, at, FS_SECTOR);
                changed++;
            }
            breathe();
        }
    }
};

// Runs one decompression pass of the whole zlib stream into sink.
bool inflate_image(const uint8_t *in, size_t inLen, tinfl_decompressor *d, uint8_t *dict, ImageSink &sink) {
    tinfl_init(d);
    size_t inOfs = 0;
    size_t dictOfs = 0;
    for (;;) {
        size_t inBytes = inLen - inOfs;
        size_t outBytes = TINFL_LZ_DICT_SIZE - dictOfs;
        tinfl_status st = tinfl_decompress(d, in + inOfs, &inBytes, dict, dict + dictOfs, &outBytes,
                                           TINFL_FLAG_PARSE_ZLIB_HEADER);
        inOfs += inBytes;
        if (outBytes > 0 && !sink.put(dict + dictOfs, outBytes)) return false;
        dictOfs = (dictOfs + outBytes) & (TINFL_LZ_DICT_SIZE - 1);
        if (st == TINFL_STATUS_DONE) break;
        if (st != TINFL_STATUS_HAS_MORE_OUTPUT) return false; // corrupt, or cut short
    }
    sink.finish();
    return sink.err == ESP_OK;
}

esp_err_t handle_update_fs_zlib(httpd_req_t *req, const esp_partition_t *fsPartition) {
    auto reject = [&](const char *status, const char *msg) {
        httpd_resp_set_status(req, status);
        httpd_resp_sendstr(req, msg);
        return ESP_OK;
    };
    if (req->content_len <= 0 || (size_t) req->content_len > ZLIB_MAX_UPLOAD) {
        return reject("400 Bad Request", "Compressed image missing or too large -- nothing was changed");
    }
    size_t inLen = (size_t) req->content_len;
    auto *in = (uint8_t *) heap_caps_malloc(inLen, MALLOC_CAP_8BIT);
    auto *d = (tinfl_decompressor *) heap_caps_malloc(sizeof(tinfl_decompressor), MALLOC_CAP_8BIT);
    auto *dict = (uint8_t *) heap_caps_malloc(TINFL_LZ_DICT_SIZE, MALLOC_CAP_8BIT);
    // The two buffers flash reads/writes go through: internal RAM. Flash
    // operations disable the cache -- and PSRAM with it -- so a PSRAM buffer
    // would have to go through a small bounce buffer, piece by piece.
    auto *sector = (uint8_t *) heap_caps_malloc(FS_SECTOR, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    auto *onFlash = (uint8_t *) heap_caps_malloc(FS_SECTOR, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    auto freeAll = [&]() {
        heap_caps_free(in);
        heap_caps_free(d);
        heap_caps_free(dict);
        heap_caps_free(sector);
        heap_caps_free(onFlash);
    };
    if (!in || !d || !dict || !sector || !onFlash) {
        freeAll();
        return reject("500 Internal Server Error", "Not enough memory for a compressed image -- send it uncompressed");
    }
    for (size_t got = 0; got < inLen;) {
        int n = web_server_recv(req, (char *) in + got, inLen - got);
        if (n <= 0) {
            freeAll();
            return reject("400 Bad Request", "Upload cut short -- nothing was changed");
        }
        got += (size_t) n;
    }

    IdleWatchdogPause idlePause; // until this handler returns (or the robot reboots)

    // Pass 1: check it, change nothing.
    ImageSink check;
    check.part = fsPartition;
    check.sector = sector;
    bool checked = inflate_image(in, inLen, d, dict, check);
    ESP_LOGI(TAG, "zlib: %u compressed bytes -> %u, %s", (unsigned) inLen, (unsigned) check.total, checked && check.magic ? "valid" : "INVALID");
    if (!checked || !check.magic) {
        freeAll();
        bool tooBig = check.err == ESP_ERR_INVALID_SIZE;
        ESP_LOGW(TAG, "/update-fs (zlib) rejected: %s", tooBig ? "too big" : "not a valid compressed LittleFS image");
        return reject("400 Bad Request", tooBig ? "Image bigger than the storage partition -- nothing was changed"
                                                : "Not a valid zlib-compressed LittleFS image -- nothing was changed");
    }

    // Pass 2: write. Same pausing as the uncompressed path below (see its
    // comment on the control task and the watchdog).
    stopAllMotion();
    motors_coast_all();
    disable_servos();
    TaskHandle_t ctrlTask = control_task_get_handle();
    esp_task_wdt_delete(ctrlTask);
    vTaskSuspend(ctrlTask);
    esp_vfs_littlefs_unregister("storage");

    int64_t t0 = esp_timer_get_time();
    ImageSink sink;
    sink.part = fsPartition;
    sink.write = true;
    sink.sector = sector;
    sink.onFlash = onFlash;
    bool ok = inflate_image(in, inLen, d, dict, sink);
    freeAll();
    if (!ok) {
        ESP_LOGE(TAG, "compressed filesystem OTA failed: %s", esp_err_to_name(sink.err));
        vTaskResume(ctrlTask);
        esp_task_wdt_add(ctrlTask);
        restore_servos();
        httpd_resp_send_500(req);
        littlefs_init();
        return ESP_OK;
    }
    char msg[120];
    std::snprintf(msg, sizeof(msg), "OK, %u of %u sectors rewritten in %lld ms -- rebooting to remount filesystem...",
                  (unsigned) sink.changed, (unsigned) (fsPartition->size / FS_SECTOR), (long long) ((esp_timer_get_time() - t0) / 1000));
    ESP_LOGI(TAG, "%s", msg);
    httpd_resp_sendstr(req, msg);
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
    return ESP_OK;
}

esp_err_t handle_update_fs_post(httpd_req_t *req) {
    if (!ota_check_basic_auth(req)) {
        ESP_LOGW(TAG, "/update-fs rejected: bad or missing credentials");
        send_unauthorized(req);
        return ESP_OK;
    }

    const esp_partition_t *fsPartition = esp_partition_find_first(
        ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, "storage");
    if (fsPartition == nullptr) {
        httpd_resp_send_500(req);
        return ESP_OK;
    }
    char query[48];
    char format[12];
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK &&
        httpd_query_key_value(query, "format", format, sizeof(format)) == ESP_OK && std::strcmp(format, "zlib") == 0) {
        return handle_update_fs_zlib(req, fsPartition);
    }
    if ((size_t) req->content_len > fsPartition->size) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "Image too large for storage partition");
        return ESP_OK;
    }

    // Receive the start of the image and check it IS a LittleFS image before
    // erasing anything: a wrong file (the app .bin, say) is rejected with the
    // current filesystem -- and so this web UI -- still intact. The superblock
    // carries the magic "littlefs" at offset 8 of block 0 or of block 1 (the
    // two blocks of the superblock pair; either may hold the newer copy).
    constexpr size_t FS_BLOCK_SIZE = 4096;
    constexpr size_t MAGIC_OFFSET = 8;
    static char head[FS_BLOCK_SIZE + 16];
    size_t headLen = std::min(sizeof(head), (size_t) req->content_len);
    size_t got = 0;
    while (got < headLen) {
        int n = web_server_recv(req, head + got, headLen - got);
        if (n <= 0) {
            httpd_resp_send_500(req);
            return ESP_OK;
        }
        got += (size_t) n;
    }
    auto hasMagic = [&](size_t at) {
        return headLen >= at + MAGIC_OFFSET + 8 && std::memcmp(head + at + MAGIC_OFFSET, "littlefs", 8) == 0;
    };
    if (!hasMagic(0) && !hasMagic(FS_BLOCK_SIZE)) {
        ESP_LOGW(TAG, "/update-fs rejected: not a LittleFS image");
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "Not a LittleFS image -- nothing was changed");
        return ESP_OK;
    }

    stopAllMotion();
    motors_coast_all();
    disable_servos();

    // Each esp_partition_erase_range() call disables the flash cache for
    // its duration -- on this single-core chip, that means NOTHING running
    // from flash executes at all while it's in progress, not just "the
    // other core stalls." Interleaving many small erases into the upload
    // loop (below) bounds any SINGLE stall to one sector, but a long upload
    // still means many such stalls back to back -- cumulatively enough,
    // empirically (on the S3 this was ported from), to leave the control
    // task's own task-watchdog subscription unfed for longer than its 3s
    // timeout once it's finally rescheduled. That's a false-positive hang
    // detection, not a real deadlock -- confirmed on that hardware: a ~2MB
    // filesystem OTA tripped the task watchdog and rebooted mid-upload
    // before this fix; the same risk applies here, if anything more acutely
    // with no second core to fall back on. Suspending the control task for
    // the duration removes it from contention entirely (motors are already
    // coasting from the calls above, so nothing is lost by pausing its
    // loop), and unsubscribing it from the watchdog means its own enforced
    // absence can't trip a timeout that exists to catch a task NOT doing
    // this on purpose.
    TaskHandle_t ctrlTask = control_task_get_handle();
    esp_task_wdt_delete(ctrlTask);
    vTaskSuspend(ctrlTask);

    esp_vfs_littlefs_unregister("storage");

    // Erase just enough NEW sectors to cover each chunk, right before
    // writing it -- not the whole ~1.9MB partition up front. Whole-
    // partition erase of a partition this size would be a single multi-
    // second flash-cache-disabled stall; interleaving it into the upload
    // spreads that into small increments (one 4KB sector each) and keeps
    // the connection busy enough that recv_wait_timeout can't fire either.
    constexpr size_t ERASE_SECTOR_SIZE = 4096;
    char buf[RECV_CHUNK];
    int remaining = (int) req->content_len;
    size_t writeOffset = 0;
    size_t erasedUpTo = 0;
    esp_err_t err = ESP_OK;
    bool headWritten = false;

    while (remaining > 0) {
        const char *data = buf;
        int recvLen;
        if (!headWritten) {
            // The already-received, already-checked start of the image first.
            headWritten = true;
            data = head;
            recvLen = (int) headLen;
        } else {
            recvLen = web_server_recv(req, buf, (size_t) std::min((int) sizeof(buf), remaining));
        }
        if (recvLen <= 0) {
            err = ESP_FAIL;
            break;
        }

        size_t writeEnd = writeOffset + (size_t) recvLen;
        while (erasedUpTo < writeEnd) {
            err = esp_partition_erase_range(fsPartition, erasedUpTo, ERASE_SECTOR_SIZE);
            if (err != ESP_OK) {
                break;
            }
            erasedUpTo += ERASE_SECTOR_SIZE;
        }
        if (err != ESP_OK) {
            break;
        }

        err = esp_partition_write(fsPartition, writeOffset, data, recvLen);
        if (err != ESP_OK) {
            break;
        }
        writeOffset += (size_t) recvLen;
        remaining -= recvLen;
    }

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "filesystem OTA failed: %s", esp_err_to_name(err));
        // Only path that doesn't reboot -- put the control task back exactly
        // as it was (resume, then re-subscribe; order matters, since
        // esp_task_wdt_add() on a still-suspended task would just start its
        // timeout countdown while it can't possibly run).
        vTaskResume(ctrlTask);
        esp_task_wdt_add(ctrlTask);
        restore_servos();
        httpd_resp_send_500(req);
        littlefs_init(); // remount whatever's there so the device isn't left filesystem-less
        return ESP_OK;
    }

    httpd_resp_sendstr(req, "OK, rebooting to remount filesystem...");
    ESP_LOGI(TAG, "LittleFS image update complete, rebooting");
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
    return ESP_OK;
}

// POST /debug/phycal: erase the radio's cached RF calibration and reboot,
// forcing a full calibration. A last-resort remedy (per ESP-IDF's own docs
// for esp_phy_erase_cal_data_in_nvs) when some channels seem deaf.
esp_err_t handle_phycal_post(httpd_req_t *req) {
    if (!ota_check_basic_auth(req)) {
        send_unauthorized(req);
        return ESP_OK;
    }
    esp_err_t err = esp_phy_erase_cal_data_in_nvs();
    if (err != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, esp_err_to_name(err));
        return ESP_OK;
    }
    httpd_resp_sendstr(req, "RF calibration erased, rebooting for a full calibration...");
    ESP_LOGW(TAG, "RF calibration data erased -- rebooting");
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
    return ESP_OK;
}

void ota_validate_task(void *arg) {
    (void) arg;
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(500));
        if (wifi_is_connected() && web_server_get_handle() != nullptr && g_controlTickCount >= 1000) {
            esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
            if (err == ESP_OK) {
                ESP_LOGI(TAG, "app marked valid, rollback cancelled");
            } else {
                ESP_LOGW(TAG, "esp_ota_mark_app_valid_cancel_rollback failed: %s", esp_err_to_name(err));
            }
            break;
        }
    }
    vTaskDelete(nullptr);
}

} // namespace

void ota_register_routes() {
    httpd_handle_t server = web_server_get_handle();
    if (server == nullptr) {
        ESP_LOGE(TAG, "web_server_get_handle() returned null -- call web_server_init() first");
        return;
    }

    httpd_uri_t updateUri = {.uri = "/update", .method = HTTP_POST, .handler = handle_update_post, .user_ctx = nullptr,
                             .is_websocket = false, .handle_ws_control_frames = false, .supported_subprotocol = nullptr};
    httpd_uri_t updateFsUri = {.uri = "/update-fs", .method = HTTP_POST, .handler = handle_update_fs_post, .user_ctx = nullptr,
                               .is_websocket = false, .handle_ws_control_frames = false, .supported_subprotocol = nullptr};
    httpd_register_uri_handler(server, &updateUri);
    httpd_register_uri_handler(server, &updateFsUri);
    httpd_uri_t phycalUri = updateUri;
    phycalUri.uri = "/debug/phycal";
    phycalUri.handler = handle_phycal_post;
    httpd_register_uri_handler(server, &phycalUri);
    ESP_LOGI(TAG, "/update and /update-fs registered");
}

void ota_start_validation() {
    xTaskCreate(ota_validate_task, "ota_validate", 3072, nullptr, 2, nullptr);
}

bool ota_request_authorized(httpd_req_t *req) {
    if (ota_check_basic_auth(req)) return true;
    send_unauthorized(req);
    return false;
}

void ota_pause_robot() {
    stopAllMotion();
    motors_coast_all();
    disable_servos();
    TaskHandle_t ctrlTask = control_task_get_handle();
    esp_task_wdt_delete(ctrlTask);
    vTaskSuspend(ctrlTask);
}

void ota_resume_robot() {
    TaskHandle_t ctrlTask = control_task_get_handle();
    vTaskResume(ctrlTask);
    esp_task_wdt_add(ctrlTask); // after resuming -- see handle_update_fs_post()'s failure path
    restore_servos();
}
