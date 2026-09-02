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
    snprintf(expected, sizeof(expected), "%s:%s", settings.otaUsername, settings.otaPassword);
    return std::strcmp((const char *) decoded, expected) == 0;
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
        int recvLen = httpd_req_recv(req, buf, std::min((int) sizeof(buf), remaining));
        if (recvLen == HTTPD_SOCK_ERR_TIMEOUT) {
            continue;
        }
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
        httpd_resp_send_500(req);
        return ESP_OK;
    }

    httpd_resp_sendstr(req, "OK, rebooting into new firmware...");
    ESP_LOGI(TAG, "OTA update complete, rebooting");
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
    if ((size_t) req->content_len > fsPartition->size) {
        httpd_resp_set_status(req, "400 Bad Request");
        httpd_resp_sendstr(req, "Image too large for storage partition");
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

    while (remaining > 0) {
        int recvLen = httpd_req_recv(req, buf, std::min((int) sizeof(buf), remaining));
        if (recvLen == HTTPD_SOCK_ERR_TIMEOUT) {
            continue;
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

        err = esp_partition_write(fsPartition, writeOffset, buf, recvLen);
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
    ESP_LOGI(TAG, "/update and /update-fs registered");
}

void ota_start_validation() {
    xTaskCreate(ota_validate_task, "ota_validate", 3072, nullptr, 2, nullptr);
}
