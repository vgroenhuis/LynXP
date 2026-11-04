#include "closer_update.hpp"

#include "closer_report.hpp"
#include "ota.hpp"
#include "web_server.hpp"
#include "status_led.hpp"
#include "cam_link.hpp"
#include "settings.hpp"

#include <algorithm>
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
constexpr const char *NVS_CAM_FAILED = "upd_cam_bad"; // a camera version it didn't come back with
constexpr size_t CAM_MAX = 3 * 1024 * 1024;          // the camera's app slots
constexpr int CAM_BACK_S = 120;                      // for the camera to restart into its new app
constexpr size_t FS_MAX = 4 * 1024 * 1024;           // (a compressed web image is ~0.3 MB)
constexpr int CONFIRM_S = 300;
constexpr size_t CHUNK = 4096;

volatile bool busy = false;
struct Offer;
Offer *pending = nullptr;  // an update to run, from the report task (closer_update_run_pending)
bool fromServer = false;   // this boot: an unconfirmed app from the server
bool reported = false;     // the server answered a report since this boot
int tries = 0;
int64_t retryAtUs = 0;
char failedVersion[32];
char offered[32];          // what the server offers ("" = nothing new)
char camVersion[32];       // what the camera runs ("" = not known: no link, not on Wi-Fi)
char camOffered[32];       // the camera version the server offers
char camFailed[32];
int64_t answeredUs = 0;    // when the server last answered a report
char state[160];          // (the heartbeat sends at most 119 characters of it: the server's limit)

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
// On failure *why says what went wrong (for the page and the console).
template <typename Sink>
bool download(const char *path, int size, const char *wantSha, char *buf, Sink sink, const char **why) {
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
    if (psa_crypto_init() != PSA_SUCCESS || psa_hash_setup(&sha, PSA_ALG_SHA_256) != PSA_SUCCESS) {
        *why = "no SHA-256";
        return false;
    }
    static char detail[48];
    *why = "no connection";
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
            // No answer (connection dropped before the headers): just another
            // try. Only an answer that doesn't fit ends it.
            if (len < 0 || status <= 0) {
                ESP_LOGW(TAG, "%s: no answer (have %d of %d bytes)", path, got, size);
            } else if (got == 0 ? (status != 200 || len != size) : (status != 206 || len != size - got)) {
                ESP_LOGE(TAG, "%s: refused (HTTP %d, length %lld, have %d of %d)", path, status, (long long) len, got, size);
                snprintf(detail, sizeof(detail), "HTTP %d, length %lld", status, (long long) len);
                *why = detail;
                broken = true;
            }
            int n;
            while (!broken && len >= 0 && status > 0 && (n = esp_http_client_read(c, buf, CHUNK)) > 0) {
                if (got + n > size || psa_hash_update(&sha, (uint8_t *) buf, n) != PSA_SUCCESS || !sink(buf, n)) {
                    *why = "write error";
                    broken = true;
                } else {
                    got += n;
                }
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
    if (!ok && !broken && got < size) {
        snprintf(detail, sizeof(detail), "broke off at %d of %d bytes", got, size);
        *why = detail;
    }
    if (!ok) return false;
    char dh[65];
    hex(digest, 32, dh);
    if (strcasecmp(dh, wantSha) != 0) {
        ESP_LOGE(TAG, "%s: SHA-256 mismatch", path);
        *why = "SHA-256 mismatch";
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
    bool app;           // the robot's own app (+ web files) to install
    bool cam;           // the camera's app to pass on
    char camVersion[32];
    char camPath[96];
    char camSha[65];
    int camSize;
};

bool copy_str(cJSON *obj, const char *key, char *out, size_t len);

// The camera's firmware version, from its own web server (GET /status,
// "fwVersion") over Wi-Fi; false if it can't be reached.
bool read_cam_version(char *out, size_t len) {
    const char *ip = cam_link_get_peer_ip();
    if (ip[0] == '\0' || std::strcmp(ip, "0.0.0.0") == 0 || cam_link_peer_is_stale()) return false;
    char url[48];
    snprintf(url, sizeof(url), "http://%s/status", ip);
    esp_http_client_config_t cfg = {};
    cfg.url = url;
    cfg.timeout_ms = 3000;
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    if (c == nullptr) return false;
    char body[512];
    int n = 0;
    if (esp_http_client_open(c, 0) == ESP_OK && esp_http_client_fetch_headers(c) >= 0 && esp_http_client_get_status_code(c) == 200) {
        for (int r; n < (int) sizeof(body) - 1 && (r = esp_http_client_read(c, body + n, sizeof(body) - 1 - n)) > 0;) n += r;
    }
    esp_http_client_cleanup(c);
    body[n] = '\0';
    cJSON *j = n > 0 ? cJSON_Parse(body) : nullptr;
    bool ok = j != nullptr && copy_str(j, "fwVersion", out, len);
    cJSON_Delete(j);
    return ok;
}

void base64(const char *in, char *out, size_t outLen) {
    static const char T[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    size_t n = std::strlen(in), o = 0;
    for (size_t i = 0; i < n && o + 4 < outLen; i += 3) {
        uint32_t v = (uint8_t) in[i] << 16 | (i + 1 < n ? (uint8_t) in[i + 1] << 8 : 0) | (i + 2 < n ? (uint8_t) in[i + 2] : 0);
        out[o++] = T[v >> 18 & 63];
        out[o++] = T[v >> 12 & 63];
        out[o++] = i + 1 < n ? T[v >> 6 & 63] : '=';
        out[o++] = i + 2 < n ? T[v & 63] : '=';
    }
    out[o] = '\0';
}

// Downloads the camera's app, checks it, and uploads it to the camera's own
// POST /update -- with the robot's OTA user and password, which the robot
// hands the camera over the SPI link. Then waits until the camera is back
// with the new version. NULL if it is, else why not; *permanent: the camera
// came back with its old version (rejected or rolled back: don't try again).
const char *update_camera(const Offer *o, char *buf, bool *permanent) {
    static char why[64];
    *permanent = false;
    uint8_t *img = (uint8_t *) heap_caps_malloc((size_t) o->camSize, MALLOC_CAP_SPIRAM);
    if (img == nullptr) return "camera: no memory";
    set_state("downloading camera %s", o->camVersion);
    size_t at = 0;
    const char *w = "";
    bool ok = download(o->camPath, o->camSize, o->camSha, buf, [&](const char *d, int n) {
        std::memcpy(img + at, d, (size_t) n);
        at += (size_t) n;
        return true;
    }, &w);
    if (!ok) {
        heap_caps_free(img);
        snprintf(why, sizeof(why), "camera: %s", w);
        return why;
    }

    set_state("installing camera %s", o->camVersion);
    char url[48];
    snprintf(url, sizeof(url), "http://%s/update", cam_link_get_peer_ip());
    esp_http_client_config_t cfg = {};
    cfg.url = url;
    cfg.method = HTTP_METHOD_POST;
    cfg.timeout_ms = 20000;
    esp_http_client_handle_t c = esp_http_client_init(&cfg);
    int status = -1;
    if (c != nullptr) {
        if (settings.otaPassword[0]) {
            char creds[sizeof(settings.otaUsername) + sizeof(settings.otaPassword) + 2];
            snprintf(creds, sizeof(creds), "%s:%s", settings.otaUsername, settings.otaPassword);
            char auth[112] = "Basic ";
            base64(creds, auth + 6, sizeof(auth) - 6);
            esp_http_client_set_header(c, "Authorization", auth);
        }
        esp_http_client_set_header(c, "Content-Type", "application/octet-stream");
        if (esp_http_client_open(c, o->camSize) == ESP_OK) {
            int sent = 0;
            while (sent < o->camSize) {
                int n = esp_http_client_write(c, (const char *) img + sent, std::min(o->camSize - sent, 4096));
                if (n <= 0) break;
                sent += n;
            }
            if (sent == o->camSize && esp_http_client_fetch_headers(c) >= 0) status = esp_http_client_get_status_code(c);
        }
        esp_http_client_cleanup(c);
    }
    heap_caps_free(img);
    if (status != 200) {
        snprintf(why, sizeof(why), status < 0 ? "camera: upload broke off" : "camera: upload refused (HTTP %d)", status);
        return why;
    }

    // It restarts into the new app; the old one answers until it does.
    set_state("camera %s installed, waiting for it to restart", o->camVersion);
    vTaskDelay(pdMS_TO_TICKS(8000));
    char now[32] = "";
    for (int s = 8; s < CAM_BACK_S; s += 3) {
        if (read_cam_version(now, sizeof(now))) {
            if (std::strcmp(now, o->camVersion) == 0) {
                snprintf(camVersion, sizeof(camVersion), "%s", now);
                return nullptr;
            }
            if (s >= 30) break; // (back, but with the old version)
        }
        vTaskDelay(pdMS_TO_TICKS(3000));
    }
    if (now[0]) {
        *permanent = true;
        snprintf(why, sizeof(why), "camera came back with %s", now);
    } else {
        snprintf(why, sizeof(why), "camera not back after %d s", CAM_BACK_S);
    }
    return why;
}

// Web files (if offered and not already written), then the app: both are
// downloaded and checked before the robot stops; then the web files are
// written, the app is made the boot app, and the robot restarts.
//
// The camera first, if it needs another version: a new robot app may count
// on it. The robot keeps running meanwhile (nothing on its own flash).
//
// Runs in the report task (no task of its own: an 8 KB stack didn't always
// fit in the internal RAM that's left, and then nothing happened at all).
void run_update(Offer *o) {
    // (Internal RAM if there is, else PSRAM: esp_flash_write copies a PSRAM
    // buffer through its own internal one.)
    char *buf = (char *) heap_caps_malloc(CHUNK, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    if (buf == nullptr) buf = (char *) heap_caps_malloc(CHUNK, MALLOC_CAP_SPIRAM);
    const char *why = "no memory";
    char whyBuf[64];
    const char *what = o->cam && !o->app ? o->camVersion : o->version; // (for the messages)
    bool ok = buf != nullptr;
    if (ok && o->cam) {
        bool permanent = false;
        const char *w = update_camera(o, buf, &permanent);
        if (w == nullptr) {
            set_state("camera updated to %s", o->camVersion);
        } else {
            ok = false;
            snprintf(whyBuf, sizeof(whyBuf), "%s", w);
            why = whyBuf;
            if (permanent) {
                snprintf(camFailed, sizeof(camFailed), "%s", o->camVersion);
                nvs_put_str(NVS_CAM_FAILED, camFailed);
            }
        }
    }
    if (ok && !o->app) {
        heap_caps_free(buf);
        tries = 0;
        delete o;
        busy = false;
        return;
    }
    if (ok) set_state(o->fs ? "downloading %s (web files)" : "downloading %s", o->version);
    uint8_t *fs = ok && o->fs ? (uint8_t *) heap_caps_malloc((size_t) o->fsSize, MALLOC_CAP_SPIRAM) : nullptr;
    const esp_partition_t *slot = esp_ota_get_next_update_partition(nullptr);
    esp_ota_handle_t ota = 0;
    if (ok && (slot == nullptr || (o->fs && fs == nullptr))) {
        ok = false;
        why = slot == nullptr ? "no OTA slot" : "no memory";
    }
    bool otaBegun = false, paused = false;

    if (ok && o->fs) {
        size_t at = 0;
        const char *w = "";
        ok = download(o->fsPath, o->fsSize, o->fsSha, buf, [&](const char *d, int n) {
            std::memcpy(fs + at, d, (size_t) n);
            at += (size_t) n;
            return true;
        }, &w);
        snprintf(whyBuf, sizeof(whyBuf), "web files: %s", w);
        why = whyBuf;
    }
    // The app goes straight into the other slot (it isn't the boot app until
    // esp_ota_set_boot_partition): its erase stalls the flash cache, so the
    // robot is paused from here on, as for POST /update.
    if (ok) {
        ota_pause_robot();
        status_led_set_updating(true);
        paused = true;
        // Sequential: each sector is erased just before it's written. With the
        // size given, esp_ota_begin erased all ~1.5 MB at once, and that stall
        // tripped the task watchdog (1.4.0 -> 1.4.4: "hang", restart).
        esp_err_t err = esp_ota_begin(slot, OTA_WITH_SEQUENTIAL_WRITES, &ota);
        ok = err == ESP_OK;
        otaBegun = ok;
        snprintf(whyBuf, sizeof(whyBuf), "esp_ota_begin: %s", esp_err_to_name(err));
        why = whyBuf;
    }
    if (ok) {
        set_state("downloading %s (app)", o->version);
        const char *w = "";
        ok = download(o->path, o->size, o->sha, buf, [&](const char *d, int n) { return esp_ota_write(ota, d, (size_t) n) == ESP_OK; }, &w);
        snprintf(whyBuf, sizeof(whyBuf), "app: %s", w);
        why = whyBuf;
    }
    if (ok) {
        otaBegun = false;
        esp_err_t err = esp_ota_end(ota); // (checks the image)
        ok = err == ESP_OK;
        snprintf(whyBuf, sizeof(whyBuf), "esp_ota_end: %s", esp_err_to_name(err));
        why = whyBuf;
    }
    if (ok && o->fs) {
        size_t changed = 0;
        set_state("writing the web files of %s", o->version);
        esp_err_t err = ota_write_fs_image_zlib(fs, (size_t) o->fsSize, &changed);
        ok = err == ESP_OK;
        if (ok) nvs_put_str(NVS_FS_SHA, o->fsSha);
        snprintf(whyBuf, sizeof(whyBuf), "writing web files: %s", esp_err_to_name(err));
        why = whyBuf;
    }
    if (ok) {
        nvs_handle_t h;
        if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) == ESP_OK) {
            nvs_set_u8(h, NVS_FROM_SERVER, 1);
            nvs_commit(h);
            nvs_close(h);
        }
        ok = esp_ota_set_boot_partition(slot) == ESP_OK;
        why = "esp_ota_set_boot_partition failed";
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
    snprintf(state, sizeof(state), "update to %s%s failed (%s), again in %d min", o->cam && !o->app ? "camera " : "", what, why, waitMin);
    ESP_LOGE(TAG, "%s", state);
    delete o;
    busy = false;
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
    nvs_get_string(NVS_CAM_FAILED, camFailed, sizeof(camFailed));
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
    answeredUs = esp_timer_get_time();
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
    cJSON *cam = usable ? cJSON_GetObjectItem(u, "cam") : nullptr;
    o->cam = cJSON_IsObject(cam) && copy_str(cam, "version", o->camVersion, sizeof(o->camVersion)) &&
             copy_str(cam, "path", o->camPath, sizeof(o->camPath)) && copy_str(cam, "sha256", o->camSha, sizeof(o->camSha)) &&
             cJSON_IsNumber(cJSON_GetObjectItem(cam, "size"));
    if (o->cam) o->camSize = cJSON_GetObjectItem(cam, "size")->valueint;
    cJSON_Delete(reply);
    snprintf(offered, sizeof(offered), "%s", usable ? o->version : "");
    snprintf(camOffered, sizeof(camOffered), "%s", o->cam ? o->camVersion : "");
    o->app = usable && o->size > 0 && std::strcmp(o->version, esp_app_get_description()->version) != 0 &&
             std::strcmp(o->version, failedVersion) != 0;
    // The camera: only if it can be asked which version it runs (on the link
    // and on Wi-Fi), and that's another one.
    if (o->cam) {
        if (!read_cam_version(camVersion, sizeof(camVersion))) camVersion[0] = '\0';
        o->cam = camVersion[0] && std::strcmp(camVersion, o->camVersion) != 0 && std::strcmp(o->camVersion, camFailed) != 0 &&
                 o->camSize > 0 && (size_t) o->camSize <= CAM_MAX;
    }
    if (!usable || (!o->app && !o->cam)) {
        delete o;
        return;
    }
    if (retryAtUs && esp_timer_get_time() < retryAtUs) {
        delete o;
        return;
    }
    busy = true;
    pending = o;
}

void closer_update_run_pending() {
    Offer *o = pending;
    pending = nullptr;
    if (o != nullptr) run_update(o);
}

bool closer_update_may_validate() { return !fromServer || reported; }

const char *closer_update_state() { return state; }

void closer_update_retry_now() { retryAtUs = 0; }

bool closer_update_busy() { return busy; }

namespace {

// {"version", "offered" ("" = nothing new), "cam_version" ("" = not known),
// "cam_offered", "busy", "checked_s" (seconds
// since the server last answered, -1 = not yet), "state"}
esp_err_t send_status(httpd_req_t *req) {
    cJSON *j = cJSON_CreateObject();
    cJSON_AddStringToObject(j, "version", esp_app_get_description()->version);
    bool news = offered[0] && std::strcmp(offered, esp_app_get_description()->version) != 0;
    cJSON_AddStringToObject(j, "offered", news ? offered : "");
    cJSON_AddStringToObject(j, "cam_version", camVersion);
    bool camNews = camOffered[0] && std::strcmp(camOffered, camVersion) != 0 && std::strcmp(camOffered, camFailed) != 0;
    cJSON_AddStringToObject(j, "cam_offered", camNews ? camOffered : "");
    cJSON_AddBoolToObject(j, "busy", busy);
    cJSON_AddNumberToObject(j, "checked_s", answeredUs ? (double) ((esp_timer_get_time() - answeredUs) / 1000000) : -1);
    cJSON_AddStringToObject(j, "state", state);
    char *out = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_sendstr(req, out ? out : "{}");
    cJSON_free(out);
    return ESP_OK;
}

// "Check for updates": a report right away (its reply offers a release, if
// there is one), without the wait after a failed try. No password: it only
// ever installs what the lab demos server offers, checked against its SHA-256.
esp_err_t handle_check(httpd_req_t *req) {
    closer_update_retry_now();
    closer_report_now();
    return send_status(req);
}

} // namespace

void closer_update_register_routes() {
    httpd_handle_t server = web_server_get_handle();
    if (server == nullptr) return;
    httpd_uri_t status = {.uri = "/api/update", .method = HTTP_GET, .handler = send_status, .user_ctx = nullptr,
                          .is_websocket = false, .handle_ws_control_frames = false, .supported_subprotocol = nullptr};
    httpd_uri_t check = status;
    check.uri = "/api/update/check";
    check.method = HTTP_POST;
    check.handler = handle_check;
    httpd_register_uri_handler(server, &status);
    httpd_register_uri_handler(server, &check);
}
