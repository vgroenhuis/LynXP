#pragma once

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
