#include "closer_update.hpp"

#include "closer_report.hpp"
#include "ota.hpp"
#include "ws_broadcast.hpp"
#include "status_led.hpp"

#include <cstdio>
#include <cstring>
#include <strings.h>

#include "cJSON.h"
#include "esp_app_desc.h"
#include "esp_crt_bundle.h"
#include "esp_heap_caps.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"
#include "psa/crypto.h"

static const char *TAG = "closer_update";

namespace {

constexpr const char *BASE_URL = "https://closer.ram.eemcs.utwente.nl/labdemos";
constexpr const char *NVS_NAMESPACE = "closer";      // shared with closer_report.cpp (the key)
constexpr const char *NVS_FROM_SERVER = "upd_srv";   // 1: the running app came from the server, not yet confirmed
constexpr const char *NVS_FAILED = "upd_failed";     // a version that was installed and rolled back
constexpr const char *NVS_FS_SHA = "upd_fs_sha";     // the web files last written from the server
constexpr size_t FS_MAX = 4 * 1024 * 1024;           // (a compressed web image is ~0.3 MB)
constexpr int CONFIRM_S = 300;
constexpr size_t CHUNK = 4096;

bool busy = false;
bool fromServer = false;   // this boot: an unconfirmed app from the server
bool reported = false;     // the server answered a report since this boot
int tries = 0;
int64_t retryAtUs = 0;
char failedVersion[32];
char state[96];

void set_state(const char *fmt, const char *a = "", int b = 0) {
    snprintf(state, sizeof(state), fmt, a, b);
    ESP_LOGI(TAG, "%s", state);
}

void nvs_put_str(const char *key, const char *value) {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return;
    if (value[0]) nvs_set_str(h, key, value);
    else nvs_erase_key(h, key);
    nvs_commit(h);
    nvs_close(h);
}

void nvs_get_string(const char *key, char *out, size_t len) {
    out[0] = '\0';
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) != ESP_OK) return;
    if (nvs_get_str(h, key, out, &len) != ESP_OK) out[0] = '\0';
    nvs_close(h);
}

void hex(const uint8_t *in, int n, char *out) {
    for (int i = 0; i < n; i++) sprintf(out + 2 * i, "%02x", in[i]);
}

// Downloads BASE_URL + path into sink(data, n) (false = stop), checking its
// length and SHA-256. A connection that breaks off is resumed where it was
// (HTTP Range), as long as each try gets somewhere: 5 tries in a row without
// progress, 60 in all.
template <typename Sink>
bool download(const char *path, int size, const char *wantSha, char *buf, Sink sink) {
    char url[192];
    snprintf(url, sizeof(url), "%s%s", BASE_URL, path);
    char auth[112];
    snprintf(auth, sizeof(auth), "Bearer %s", closer_report_device_key());
    esp_http_client_config_t cfg = {};
    cfg.url = url;
    cfg.crt_bundle_attach = esp_crt_bundle_attach;
    cfg.timeout_ms = 15000;
    cfg.buffer_size = 2048;
    psa_hash_operation_t sha = PSA_HASH_OPERATION_INIT;
    if (psa_crypto_init() != PSA_SUCCESS || psa_hash_setup(&sha, PSA_ALG_SHA_256) != PSA_SUCCESS) return false;
    int got = 0, stuck = 0;
    bool broken = false;
    for (int attempt = 0; attempt < 60 && stuck < 5 && !broken && got < size; attempt++) {
        if (attempt) vTaskDelay(pdMS_TO_TICKS(1000));
        int before = got;
        esp_http_client_handle_t c = esp_http_client_init(&cfg);
        if (c == nullptr) break;
        esp_http_client_set_header(c, "Authorization", auth);
        char range[32];
        if (got) {
            snprintf(range, sizeof(range), "bytes=%d-", got);
            esp_http_client_set_header(c, "Range", range);
        }
        if (esp_http_client_open(c, 0) == ESP_OK) {
            int64_t len = esp_http_client_fetch_headers(c);
            int status = esp_http_client_get_status_code(c);
            if (got == 0 ? (status != 200 || len != size) : (status != 206 || len != size - got)) {
                ESP_LOGE(TAG, "%s: refused (HTTP %d, length %lld, have %d of %d)", path, status, (long long) len, got, size);
                broken = true;
            }
            int n;
            while (!broken && (n = esp_http_client_read(c, buf, CHUNK)) > 0) {
                if (got + n > size || psa_hash_update(&sha, (uint8_t *) buf, n) != PSA_SUCCESS || !sink(buf, n)) broken = true;
                else got += n;
            }
        }
        esp_http_client_close(c);
        esp_http_client_cleanup(c);
        stuck = got > before ? 0 : stuck + 1;
        if (!broken && got < size) ESP_LOGW(TAG, "%s broke off at %d of %d bytes; resuming", path, got, size);
    }
    uint8_t digest[32];
    size_t dlen = 0;
    bool ok = !broken && got == size && psa_hash_finish(&sha, digest, sizeof(digest), &dlen) == PSA_SUCCESS && dlen == 32;
    psa_hash_abort(&sha);
    if (!ok) return false;
    char dh[65];
    hex(digest, 32, dh);
    if (strcasecmp(dh, wantSha) != 0) {
        ESP_LOGE(TAG, "%s: SHA-256 mismatch", path);
        return false;
    }
    return true;
}

struct Offer {
    char version[32];
    char path[96];
    char sha[65];
    int size;
    bool fs;            // web files to write too
    char fsPath[96];
    char fsSha[65];
    int fsSize;
};

// Web files (if offered and not already written), then the app: both are
// downloaded and checked before the robot stops; then the web files are
// written, the app is made the boot app, and the robot restarts.
void update_task(void *arg) {
    Offer *o = (Offer *) arg;
    set_state("downloading %s", o->version);
    char *buf = (char *) heap_caps_malloc(CHUNK, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    uint8_t *fs = o->fs ? (uint8_t *) heap_caps_malloc((size_t) o->fsSize, MALLOC_CAP_SPIRAM) : nullptr;
    const esp_partition_t *slot = esp_ota_get_next_update_partition(nullptr);
    esp_ota_handle_t ota = 0;
    bool ok = buf != nullptr && slot != nullptr && (!o->fs || fs != nullptr);
    bool otaBegun = false, paused = false;

    if (ok && o->fs) {
        size_t at = 0;
        ok = download(o->fsPath, o->fsSize, o->fsSha, buf, [&](const char *d, int n) {
            std::memcpy(fs + at, d, (size_t) n);
            at += (size_t) n;
            return true;
        });
        if (!ok) ESP_LOGE(TAG, "web files: download failed");
    }
    // The app goes straight into the other slot (it isn't the boot app until
    // esp_ota_set_boot_partition): its erase stalls the flash cache, so the
    // robot is paused from here on, as for POST /update.
    if (ok) {
        ota_pause_robot();
        status_led_set_updating(true);
        paused = true;
        ok = esp_ota_begin(slot, (size_t) o->size, &ota) == ESP_OK;
        otaBegun = ok;
    }
    if (ok) {
        ok = download(o->path, o->size, o->sha, buf, [&](const char *d, int n) { return esp_ota_write(ota, d, (size_t) n) == ESP_OK; });
        if (!ok) ESP_LOGE(TAG, "app: download failed");
    }
    if (ok) {
        otaBegun = false;
        ok = esp_ota_end(ota) == ESP_OK; // (checks the image)
    }
    if (ok && o->fs) {
        size_t changed = 0;
        set_state("writing the web files of %s", o->version);
        esp_err_t err = ota_write_fs_image_zlib(fs, (size_t) o->fsSize, &changed);
        ok = err == ESP_OK;
        if (ok) nvs_put_str(NVS_FS_SHA, o->fsSha);
        else ESP_LOGE(TAG, "web files: %s", esp_err_to_name(err));
    }
    if (ok) {
        nvs_handle_t h;
        if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) == ESP_OK) {
            nvs_set_u8(h, NVS_FROM_SERVER, 1);
            nvs_commit(h);
            nvs_close(h);
        }
        ok = esp_ota_set_boot_partition(slot) == ESP_OK;
    }
    if (ok) {
        ESP_LOGI(TAG, "update to %s installed, restarting", o->version);
        vTaskDelay(pdMS_TO_TICKS(500));
        esp_restart();
    }
    if (otaBegun) esp_ota_abort(ota);
    if (paused) {
        status_led_set_updating(false);
        ota_resume_robot();
    }
    heap_caps_free(buf);
    heap_caps_free(fs);
    // A download that broke off (Wi-Fi hiccup) is no reason to give up on the
    // version: again in 5, 10, 20, 40, then every 60 minutes.
    tries++;
    int waitMin = tries >= 5 ? 60 : 5 << (tries - 1);
    retryAtUs = esp_timer_get_time() + (int64_t) waitMin * 60 * 1000000;
    set_state("update to %s failed, again in %d min", o->version, waitMin);
    delete o;
    busy = false;
    vTaskDelete(nullptr);
}

bool copy_str(cJSON *obj, const char *key, char *out, size_t len) {
    cJSON *v = cJSON_GetObjectItem(obj, key);
    if (!cJSON_IsString(v) || std::strlen(v->valuestring) >= len) return false;
    std::strcpy(out, v->valuestring);
    return true;
}

void rollback_task(void *) {
    vTaskDelay(pdMS_TO_TICKS(CONFIRM_S * 1000));
    if (fromServer && !reported) {
        const char *v = esp_app_get_description()->version;
        ESP_LOGE(TAG, "%s could not reach the lab demos server in %d s: going back to the previous app", v, CONFIRM_S);
        nvs_put_str(NVS_FAILED, v);
        esp_ota_mark_app_invalid_rollback_and_reboot();
    }
    vTaskDelete(nullptr);
}

} // namespace

void closer_update_init() {
    nvs_get_string(NVS_FAILED, failedVersion, sizeof(failedVersion));
    uint8_t flag = 0;
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u8(h, NVS_FROM_SERVER, &flag);
        nvs_close(h);
    }
    esp_ota_img_states_t st;
    bool pending = esp_ota_get_state_partition(esp_ota_get_running_partition(), &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY;
    const char *running = esp_app_get_description()->version;
    if (flag && pending) {
        fromServer = true;
        set_state("new firmware %s: waiting for the server", running);
        xTaskCreate(rollback_task, "closer_rollback", 3072, nullptr, 1, nullptr);
    } else if (flag) {
        // (back on the old app after a reset before the new one was confirmed)
        nvs_put_str(NVS_FROM_SERVER, "");
    }
    if (failedVersion[0] && std::strcmp(failedVersion, running) != 0) set_state("update to %s failed, rolled back", failedVersion);
}

void closer_update_on_reply(const char *replyJson) {
    if (fromServer && !reported) {
        nvs_handle_t h;
        if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) == ESP_OK) {
            nvs_erase_key(h, NVS_FROM_SERVER);
            nvs_erase_key(h, NVS_FAILED); // an older failure is history now
            nvs_commit(h);
            nvs_close(h);
        }
        failedVersion[0] = '\0';
        fromServer = false;
        set_state("firmware %s confirmed", esp_app_get_description()->version);
    }
    reported = true;
    esp_ota_img_states_t st;
    if (busy || (esp_ota_get_state_partition(esp_ota_get_running_partition(), &st) == ESP_OK && st == ESP_OTA_IMG_PENDING_VERIFY)) {
        return; // (not before ota.cpp has confirmed the running app)
    }
    cJSON *reply = cJSON_Parse(replyJson);
    cJSON *u = reply ? cJSON_GetObjectItem(reply, "update") : nullptr;
    Offer *o = new Offer();
    bool usable = cJSON_IsObject(u) && copy_str(u, "version", o->version, sizeof(o->version)) &&
                  copy_str(u, "path", o->path, sizeof(o->path)) && copy_str(u, "sha256", o->sha, sizeof(o->sha)) &&
                  cJSON_IsNumber(cJSON_GetObjectItem(u, "size"));
    if (usable) o->size = cJSON_GetObjectItem(u, "size")->valueint;
    cJSON *fs = usable ? cJSON_GetObjectItem(u, "fs") : nullptr;
    if (cJSON_IsObject(fs)) {
        usable = copy_str(fs, "path", o->fsPath, sizeof(o->fsPath)) && copy_str(fs, "sha256", o->fsSha, sizeof(o->fsSha)) &&
                 cJSON_IsNumber(cJSON_GetObjectItem(fs, "size"));
        if (usable) o->fsSize = cJSON_GetObjectItem(fs, "size")->valueint;
        char written[65];
        nvs_get_string(NVS_FS_SHA, written, sizeof(written));
        o->fs = usable && strcasecmp(written, o->fsSha) != 0;
        if (o->fs && (o->fsSize <= 0 || (size_t) o->fsSize > FS_MAX)) usable = false;
    }
    cJSON_Delete(reply);
    if (!usable || o->size <= 0 || std::strcmp(o->version, esp_app_get_description()->version) == 0 ||
        std::strcmp(o->version, failedVersion) == 0) {
        delete o;
        return;
    }
    if (retryAtUs && esp_timer_get_time() < retryAtUs) {
        delete o;
        return;
    }
    if (ws_broadcast_client_count() > 0) {
        set_state("update to %s waits until nobody has the robot's page open", o->version);
        delete o;
        return;
    }
    busy = true;
    if (xTaskCreate(update_task, "closer_update", 8192, o, 2, nullptr) != pdPASS) {
        delete o;
        busy = false;
    }
}

bool closer_update_may_validate() { return !fromServer || reported; }

const char *closer_update_state() { return state; }

void closer_update_retry_now() { retryAtUs = 0; }
