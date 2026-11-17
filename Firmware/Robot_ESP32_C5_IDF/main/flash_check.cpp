#include "flash_check.hpp"
#include "web_server.hpp"

#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>

#include "cJSON.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_image_format.h"
#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_rom_crc.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "psa/crypto.h"

namespace {

const char *TAG = "flashcheck";
constexpr size_t CHUNK = 4096;
constexpr size_t PSRAM_TEST_BYTES = 512 * 1024;
constexpr size_t NVS_PAGE = 4096;
constexpr size_t NVS_ENTRIES = 126;

SemaphoreHandle_t s_lock = nullptr;
FlashCheckResult s_result = {};
bool s_ever = false;
int64_t s_endUs = 0;

struct Lock {
    Lock() { xSemaphoreTake(s_lock, portMAX_DELAY); }
    ~Lock() { xSemaphoreGive(s_lock); }
};

uint32_t rd32(const uint8_t *p) { uint32_t v; std::memcpy(&v, p, 4); return v; }
uint16_t rd16(const uint8_t *p) { uint16_t v; std::memcpy(&v, p, 2); return v; }

// -- the program image ---------------------------------------------------------

struct Image {
    const esp_partition_t *part;
    uint32_t hashedLen; // bytes covered by the appended SHA-256
    uint8_t digest[32];
    const uint8_t *mapped;
    esp_partition_mmap_handle_t map;
};

bool image_open(Image *im) {
    im->part = esp_ota_get_running_partition();
    if (im->part == nullptr) return false;
    esp_partition_pos_t pos = {.offset = im->part->address, .size = im->part->size};
    esp_image_metadata_t meta = {};
    if (esp_image_verify(ESP_IMAGE_VERIFY_SILENT, &pos, &meta) != ESP_OK || !meta.image.hash_appended ||
        meta.image_len <= 32) {
        ESP_LOGE(TAG, "running image: no appended SHA-256 to check against");
        return false;
    }
    im->hashedLen = meta.image_len - 32;
    std::memcpy(im->digest, meta.image_digest, 32);
    const void *p = nullptr;
    if (esp_partition_mmap(im->part, 0, im->hashedLen, ESP_PARTITION_MMAP_DATA, &p, &im->map) != ESP_OK) return false;
    im->mapped = (const uint8_t *) p;
    return true;
}

void image_pass(const Image &im, uint8_t *buf, uint8_t *viaCache) {
    psa_hash_operation_t direct = PSA_HASH_OPERATION_INIT;
    psa_hash_operation_t cached = PSA_HASH_OPERATION_INIT;
    psa_hash_setup(&direct, PSA_ALG_SHA_256);
    psa_hash_setup(&cached, PSA_ALG_SHA_256);
    uint32_t mismatches = 0;
    uint32_t firstAddr = 0;
    for (uint32_t off = 0; off < im.hashedLen; off += CHUNK) {
        size_t n = std::min<size_t>(CHUNK, im.hashedLen - off);
        if (esp_partition_read(im.part, off, buf, n) != ESP_OK) std::memset(buf, 0, n);
        std::memcpy(viaCache, im.mapped + off, n); // through the cache, as the CPU fetches code
        psa_hash_update(&direct, buf, n);
        psa_hash_update(&cached, viaCache, n);
        if (std::memcmp(buf, viaCache, n) != 0) {
            mismatches++;
            if (firstAddr == 0) {
                size_t i = 0;
                while (i < n && buf[i] == viaCache[i]) i++;
                firstAddr = im.part->address + off + i;
            }
        }
        vTaskDelay(1); // a direct read stalls the CPU's flash cache: let the robot's own tasks in between
    }
    uint8_t d1[32], d2[32];
    size_t l1 = 0, l2 = 0;
    bool ok1 = psa_hash_finish(&direct, d1, sizeof(d1), &l1) == PSA_SUCCESS && std::memcmp(d1, im.digest, 32) == 0;
    bool ok2 = psa_hash_finish(&cached, d2, sizeof(d2), &l2) == PSA_SUCCESS && std::memcmp(d2, im.digest, 32) == 0;
    Lock lock;
    s_result.imageBytes = im.hashedLen;
    if (!ok1) s_result.directHashBad++;
    if (!ok2) s_result.cacheHashBad++;
    s_result.chunkMismatches += mismatches;
    if (firstAddr && !s_result.firstMismatchAddr) s_result.firstMismatchAddr = firstAddr;
    if (!ok1 || !ok2 || mismatches) {
        ESP_LOGE(TAG, "program read: direct %s, cache %s, %lu chunk(s) differ (first 0x%lx)", ok1 ? "ok" : "BAD",
                 ok2 ? "ok" : "BAD", (unsigned long) mismatches, (unsigned long) firstAddr);
    }
}

// -- NVS, raw ----------------------------------------------------------------------
// Layout (nvs_flash/src: nvs_page.hpp, nvs_types.hpp): 4 KB pages; a 32-byte
// header (state, seq, version, ..., crc32 over bytes 4-27), a 32-byte bitmap
// of 2 bits per entry (3 empty, 2 written, 0 erased, 1 illegal), then 126
// entries of 32 bytes: nsIndex, type, span, chunkIndex, crc32 (over bytes
// 0-3 and 8-31), key[16], data[8]. Strings and blobs keep their size and
// data crc32 in data[] and their bytes in the next span-1 entries.

void add_key(char *keys, size_t len, const uint8_t *key) {
    char k[17] = {};
    std::memcpy(k, key, 16);
    for (char &c : k) if (c != '\0' && (c < 0x20 || c > 0x7e)) c = '?';
    size_t used = std::strlen(keys);
    if (used + std::strlen(k) + 2 < len) std::snprintf(keys + used, len - used, "%s%s", used ? " " : "", k);
}

void nvs_pass(const esp_partition_t *nvs, uint8_t *a, uint8_t *b) {
    size_t size = nvs->size;
    bool readOk = esp_partition_read(nvs, 0, a, size) == ESP_OK;
    vTaskDelay(1);
    readOk = readOk && esp_partition_read(nvs, 0, b, size) == ESP_OK;
    bool differ = !readOk || std::memcmp(a, b, size) != 0;

    uint32_t entries = 0, badHeaders = 0, badData = 0, badPages = 0, erasedBad = 0;
    char keys[64] = "";
    for (size_t pg = 0; pg + NVS_PAGE <= size; pg += NVS_PAGE) {
        const uint8_t *p = a + pg;
        uint32_t state = rd32(p);
        if (state == 0xFFFFFFFF || state == 0) continue; // uninitialised / invalid page
        if (esp_rom_crc32_le(0xffffffff, p + 4, 24) != rd32(p + 28)) {
            badPages++;
            continue;
        }
        for (size_t i = 0; i < NVS_ENTRIES; i++) {
            uint32_t es = (rd32(p + 32 + (i / 16) * 4) >> ((i % 16) * 2)) & 3;
            if (es == 3 || es == 1) continue;
            const uint8_t *e = p + 64 + i * 32;
            uint32_t crc = esp_rom_crc32_le(0xffffffff, e, 4);
            crc = esp_rom_crc32_le(crc, e + 8, 24);
            bool headerOk = crc == rd32(e + 4);
            uint8_t type = e[1];
            uint8_t span = e[2];
            if (es == 0) { // erased: only its own header (a span's data entries are erased too)
                if (!headerOk && e[0] != 0xff) erasedBad++;
                continue;
            }
            entries++;
            if (!headerOk) {
                badHeaders++;
                add_key(keys, sizeof(keys), e + 8);
                continue;
            }
            if ((type == 0x21 || type == 0x41 || type == 0x42) && span >= 1 && i + span <= NVS_ENTRIES) {
                uint16_t dataSize = rd16(e + 24);
                if (dataSize <= (span - 1) * 32 &&
                    esp_rom_crc32_le(0xffffffff, e + 32, dataSize) != rd32(e + 28)) {
                    badData++;
                    add_key(keys, sizeof(keys), e + 8);
                }
                i += span - 1;
            } else if (span > 1) {
                i += span - 1;
            }
        }
    }
    std::memset(a, 0, size); // (Wi-Fi passwords and the device key were in there)
    std::memset(b, 0, size);
    Lock lock;
    if (differ) s_result.nvsReadDiffs++;
    s_result.nvsEntries = entries;
    s_result.nvsBadHeaders = badHeaders;
    s_result.nvsBadData = badData;
    s_result.nvsBadPages = badPages;
    s_result.nvsErasedBad = erasedBad;
    std::snprintf(s_result.nvsBadKeys, sizeof(s_result.nvsBadKeys), "%s", keys);
    if (differ || badHeaders || badData || badPages) {
        ESP_LOGE(TAG, "NVS: reads %s, %lu bad header(s), %lu bad data, %lu bad page(s) [%s]", differ ? "DIFFER" : "agree",
                 (unsigned long) badHeaders, (unsigned long) badData, (unsigned long) badPages, keys);
    }
}

// -- PSRAM -------------------------------------------------------------------------

void psram_pass(uint32_t *mem, size_t words, uint32_t seed) {
    uint32_t x = seed | 1;
    for (size_t i = 0; i < words; i++) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        mem[i] = x ^ (uint32_t) i;
        if ((i & 0x3fff) == 0) vTaskDelay(1);
    }
    x = seed | 1;
    uint32_t bad = 0, firstBad = 0;
    for (size_t i = 0; i < words; i++) {
        x ^= x << 13; x ^= x >> 17; x ^= x << 5;
        if (mem[i] != (x ^ (uint32_t) i)) {
            if (bad++ == 0) firstBad = (uint32_t) (uintptr_t) &mem[i];
        }
        if ((i & 0x3fff) == 0) vTaskDelay(1);
    }
    Lock lock;
    s_result.psramBadWords += bad;
    if (bad && !s_result.psramFirstBadAddr) s_result.psramFirstBadAddr = firstBad;
    if (bad) ESP_LOGE(TAG, "PSRAM: %lu bad word(s), first at 0x%lx", (unsigned long) bad, (unsigned long) firstBad);
}

void check_task(void *) {
    Image im = {};
    bool haveImage = psa_crypto_init() == PSA_SUCCESS && image_open(&im);
    const esp_partition_t *nvs = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_NVS, "nvs");
    auto *buf = (uint8_t *) heap_caps_malloc(CHUNK, MALLOC_CAP_SPIRAM);
    auto *viaCache = (uint8_t *) heap_caps_malloc(CHUNK, MALLOC_CAP_SPIRAM);
    uint8_t *nvsA = nvs ? (uint8_t *) heap_caps_malloc(nvs->size, MALLOC_CAP_SPIRAM) : nullptr;
    uint8_t *nvsB = nvs ? (uint8_t *) heap_caps_malloc(nvs->size, MALLOC_CAP_SPIRAM) : nullptr;
    auto *ps = (uint32_t *) heap_caps_malloc(PSRAM_TEST_BYTES, MALLOC_CAP_SPIRAM);
    {
        Lock lock;
        s_result.psramBytes = ps ? PSRAM_TEST_BYTES : 0;
    }
    ESP_LOGI(TAG, "started: image %s, nvs %s, psram %s", haveImage ? "yes" : "no", nvsA && nvsB ? "yes" : "no", ps ? "yes" : "no");

    uint32_t pass = 0;
    while (esp_timer_get_time() < s_endUs) {
        if (haveImage && buf && viaCache) image_pass(im, buf, viaCache);
        if (nvsA && nvsB) nvs_pass(nvs, nvsA, nvsB);
        if (ps) psram_pass(ps, PSRAM_TEST_BYTES / 4, 0x9e3779b9u * ++pass);
        Lock lock;
        s_result.passes++;
        int64_t left = (s_endUs - esp_timer_get_time()) / 1000000;
        s_result.secondsLeft = left > 0 ? (uint32_t) left : 0;
    }

    if (haveImage) esp_partition_munmap(im.map);
    heap_caps_free(buf);
    heap_caps_free(viaCache);
    heap_caps_free(nvsA);
    heap_caps_free(nvsB);
    heap_caps_free(ps);
    {
        Lock lock;
        s_result.running = false;
        s_result.secondsLeft = 0;
        ESP_LOGI(TAG, "done: %lu passes", (unsigned long) s_result.passes);
    }
    vTaskDelete(nullptr);
}

bool start(int minutes) {
    Lock lock;
    if (s_result.running) return false;
    s_result = {};
    s_result.running = true;
    s_ever = true;
    s_endUs = esp_timer_get_time() + (int64_t) minutes * 60 * 1000000;
    s_result.secondsLeft = (uint32_t) minutes * 60;
    if (xTaskCreate(check_task, "flashcheck", 4096, nullptr, tskIDLE_PRIORITY + 1, nullptr) != pdPASS) {
        s_result.running = false;
        return false;
    }
    return true;
}

esp_err_t handle_flashcheck(httpd_req_t *req) {
    char query[32] = "";
    char val[8] = "";
    const char *note = "";
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK &&
        httpd_query_key_value(query, "start", val, sizeof(val)) == ESP_OK) {
        int minutes = std::clamp(std::atoi(val), 1, 30);
        note = start(minutes) ? "started" : "already running";
    }
    FlashCheckResult r;
    bool any = flash_check_get(&r);
    cJSON *j = cJSON_CreateObject();
    if (note[0]) cJSON_AddStringToObject(j, "note", note);
    if (!any) {
        cJSON_AddStringToObject(j, "status", "not run yet -- start with /flashcheck?start=3 (minutes, 1-30)");
    } else {
        cJSON_AddStringToObject(j, "status", r.running ? "running" : "done");
        cJSON_AddNumberToObject(j, "passes", r.passes);
        cJSON_AddNumberToObject(j, "secondsLeft", r.secondsLeft);
        cJSON *img = cJSON_AddObjectToObject(j, "program");
        cJSON_AddNumberToObject(img, "bytes", r.imageBytes);
        cJSON_AddNumberToObject(img, "directHashBad", r.directHashBad);
        cJSON_AddNumberToObject(img, "cacheHashBad", r.cacheHashBad);
        cJSON_AddNumberToObject(img, "chunkMismatches", r.chunkMismatches);
        char a[12];
        std::snprintf(a, sizeof(a), "0x%lx", (unsigned long) r.firstMismatchAddr);
        cJSON_AddStringToObject(img, "firstMismatch", r.firstMismatchAddr ? a : "");
        cJSON *nv = cJSON_AddObjectToObject(j, "nvs");
        cJSON_AddNumberToObject(nv, "readDiffs", r.nvsReadDiffs);
        cJSON_AddNumberToObject(nv, "entries", r.nvsEntries);
        cJSON_AddNumberToObject(nv, "badHeaders", r.nvsBadHeaders);
        cJSON_AddNumberToObject(nv, "badData", r.nvsBadData);
        cJSON_AddNumberToObject(nv, "badPages", r.nvsBadPages);
        cJSON_AddNumberToObject(nv, "erasedBad", r.nvsErasedBad);
        cJSON_AddStringToObject(nv, "badKeys", r.nvsBadKeys);
        cJSON *ps = cJSON_AddObjectToObject(j, "psram");
        cJSON_AddNumberToObject(ps, "bytes", r.psramBytes);
        cJSON_AddNumberToObject(ps, "badWords", r.psramBadWords);
        std::snprintf(a, sizeof(a), "0x%lx", (unsigned long) r.psramFirstBadAddr);
        cJSON_AddStringToObject(ps, "firstBad", r.psramFirstBadAddr ? a : "");
    }
    char *out = cJSON_PrintUnformatted(j);
    cJSON_Delete(j);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_sendstr(req, out ? out : "{}");
    cJSON_free(out);
    return ESP_OK;
}

} // namespace

bool flash_check_get(FlashCheckResult *out) {
    if (s_lock == nullptr) return false;
    Lock lock;
    *out = s_result;
    return s_ever;
}

void flash_check_register_routes() {
    if (s_lock == nullptr) s_lock = xSemaphoreCreateMutex();
    httpd_handle_t server = web_server_get_handle();
    if (server == nullptr) return;
    httpd_uri_t uri = {.uri = "/flashcheck", .method = HTTP_GET, .handler = handle_flashcheck, .user_ctx = nullptr,
                       .is_websocket = false, .handle_ws_control_frames = false, .supported_subprotocol = nullptr};
    if (httpd_register_uri_handler(server, &uri) != ESP_OK) ESP_LOGE(TAG, "couldn't register /flashcheck");
}
