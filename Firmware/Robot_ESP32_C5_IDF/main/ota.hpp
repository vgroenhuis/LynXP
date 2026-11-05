#pragma once

#include "esp_http_server.h"

#include <cstddef>
#include <cstdint>

#include "esp_ota_ops.h"

// App firmware + filesystem OTA, lifted from the proven-on-hardware
// Test_ESP32_S3_Feather_ESP_IDF spike's update_post_handler/
// update_fs_post_handler, with three hardening changes on top:
//   1. Both handlers stop the robot before touching flash.
//   2. The filesystem OTA erases incrementally (sector-by-sector, just
//      ahead of each write) instead of the whole ~1.9MB partition up
//      front, so no single stall lasts more than one sector's worth.
//   3. Rollback validation -- see ota_start_validation().
//
// Same wire protocol as the spike: POST raw binary bodies, no multipart --
// `fetch(url, {method:'POST', body: file})` or `curl --data-binary` both
// work.

// Registers POST /update (app firmware, written via esp_ota_*) and
// POST /update-fs (littlefs image, written via raw esp_partition_* calls
// to the "storage" partition). Call once from app_main(), after
// web_server_init().
void ota_register_routes();

// Starts a background task that calls esp_ota_mark_app_valid_cancel_rollback()
// once Wi-Fi is connected, the HTTP server is listening, and the control
// task has ticked at least 1000 times -- i.e. once THIS boot has actually
// proven itself alive, not just that it linked and started running.
//
// With CONFIG_BOOTLOADER_APP_ROLLBACK_ENABLE=y (sdkconfig.defaults), a
// freshly-OTA'd image boots in PENDING_VERIFY state and the bootloader
// automatically reverts to the previous slot on the NEXT reboot unless
// something calls this first. The Test_ESP32_S3_Feather_ESP_IDF spike has
// no rollback at all -- a bad-but-valid image there bricks the board into a
// USB reflash. Call once from app_main(), after every other subsystem has
// been started.
void ota_start_validation();

// Shared with any other raw-flash upload handler:
// Checks the OTA Basic-auth credentials; if they don't match, sends the 401
// itself and returns false.
bool ota_request_authorized(httpd_req_t *req);
// Stops the motors, silences the servos and suspends the control task (off
// its watchdog) for the duration of a long flash erase/write -- see
// handle_update_fs_post()'s comment for why. ota_resume_robot() undoes it.
void ota_pause_robot();
void ota_resume_robot();

// Writes a zlib-compressed LittleFS image (what POST /update-fs?format=zlib
// takes) to the storage partition: checked whole first, then only the 4 KB
// sectors that differ are rewritten. The filesystem stays unmounted after
// success -- restart next. ESP_ERR_INVALID_ARG / ESP_ERR_INVALID_SIZE: not a
// valid image / too big, nothing changed. Call between ota_pause_robot() and
// a restart (or ota_resume_robot() on failure). For closer_update.cpp.
esp_err_t ota_write_fs_image_zlib(const uint8_t *in, size_t len, size_t *changed);

// Writes an app image (in RAM, already checked) into the other app slot and
// checks it (esp_ota_end); *slot is that slot, for esp_ota_set_boot_partition.
// In 4 KB steps with a tick's pause after each. Call between
// ota_pause_robot() and a restart (or ota_resume_robot()).
esp_err_t ota_write_app_image(const uint8_t *img, size_t len, const esp_partition_t **slot);
