#include "littlefs_init.hpp"

#include "esp_littlefs.h"
#include "esp_log.h"

void littlefs_init() {
    esp_vfs_littlefs_conf_t conf = {};
    conf.base_path = "/littlefs";
    conf.partition_label = "storage";
    conf.format_if_mount_failed = true;
    conf.dont_mount = false;

    esp_err_t err = esp_vfs_littlefs_register(&conf);
    if (err != ESP_OK) {
        ESP_LOGE("littlefs", "mount failed: %s", esp_err_to_name(err));
        return;
    }
    size_t total = 0, used = 0;
    esp_littlefs_info(conf.partition_label, &total, &used);
    ESP_LOGI("littlefs", "mounted: %u/%u bytes used", (unsigned) used, (unsigned) total);
}
