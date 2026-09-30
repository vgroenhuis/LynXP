#include "model_store.hpp"
#include "web_server.hpp"
#include "ota.hpp"

#include "esp_http_server.h"
#include "esp_partition.h"
#include "esp_log.h"

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstring>

namespace {

const char *TAG = "model_store";

constexpr char MAGIC[8] = {'L', 'X', 'M', 'O', 'D', 'E', 'L', '1'};
constexpr size_t DATA_OFFSET = 4096;
constexpr size_t ERASE_BLOCK = 64 * 1024; // block erase: far fewer (if longer) cache-off stalls than 4 KB sectors

struct Header {
    char magic[8];
    uint32_t size;
    uint32_t fnv;
    char name[48];
};

const esp_partition_t *model_partition() {
    return esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "model");
}

bool read_header(const esp_partition_t *p, Header *h) {
    if (p == nullptr || esp_partition_read(p, 0, h, sizeof(*h)) != ESP_OK) return false;
    h->name[sizeof(h->name) - 1] = '\0';
    return std::memcmp(h->magic, MAGIC, sizeof(MAGIC)) == 0 && h->size > 0 &&
           h->size <= p->size - DATA_OFFSET;
}

uint32_t fnv1a(uint32_t hash, const uint8_t *data, size_t len) {
    for (size_t i = 0; i < len; i++) {
        hash ^= data[i];
        hash *= 16777619u;
    }
    return hash;
}

esp_err_t handle_info(httpd_req_t *req) {
    const esp_partition_t *p = model_partition();
    Header h;
    bool installed = read_header(p, &h);
    char nameEsc[2 * sizeof(h.name)];
    json_escape(installed ? h.name : "", nameEsc, sizeof(nameEsc));
    char json[260];
    std::snprintf(json, sizeof(json),
                  "{\"installed\":%s,\"name\":\"%s\",\"bytes\":%lu,\"version\":\"%08lx\",\"capacity\":%lu}",
                  installed ? "true" : "false", nameEsc, installed ? (unsigned long) h.size : 0UL,
                  installed ? (unsigned long) h.fnv : 0UL, p ? (unsigned long) (p->size - DATA_OFFSET) : 0UL);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_sendstr(req, json);
    return ESP_OK;
}

// Streams straight out of flash. Note httpd is single-task, so while this
// ~6 MB transfer runs (a few seconds), other requests wait -- acceptable for
// a one-time download the browser then caches.
esp_err_t handle_download(httpd_req_t *req) {
    const esp_partition_t *p = model_partition();
    Header h;
    if (!read_header(p, &h)) {
        httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "No model installed -- see the Games & apps page");
        return ESP_OK;
    }
    httpd_resp_set_type(req, "application/octet-stream");
    // Clients always request ?v=<checksum>, so the bytes behind one URL never change.
    httpd_resp_set_hdr(req, "Cache-Control", "public, max-age=31536000, immutable");

    static uint8_t buf[8192]; // httpd is a single task -- static keeps it off its stack
    size_t offset = 0;
    while (offset < h.size) {
        size_t n = std::min(sizeof(buf), (size_t) h.size - offset);
        if (esp_partition_read(p, DATA_OFFSET + offset, buf, n) != ESP_OK ||
            httpd_resp_send_chunk(req, (const char *) buf, (ssize_t) n) != ESP_OK) {
            ESP_LOGW(TAG, "model download aborted at %u bytes", (unsigned) offset);
            return ESP_FAIL;
        }
        offset += n;
    }
    httpd_resp_send_chunk(req, nullptr, 0);
    return ESP_OK;
}

esp_err_t handle_upload(httpd_req_t *req) {
    if (!ota_request_authorized(req)) return ESP_OK;
    const esp_partition_t *p = model_partition();
    if (p == nullptr) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR,
                            "No 'model' partition -- flash the firmware (with its partition table) over USB once");
        return ESP_OK;
    }
    size_t total = (size_t) req->content_len;
    if (total == 0 || total > p->size - DATA_OFFSET) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Model missing or too large for the model partition");
        return ESP_OK;
    }

    Header h = {};
    std::memcpy(h.magic, MAGIC, sizeof(MAGIC));
    h.size = (uint32_t) total;
    h.fnv = 2166136261u;
    char nameParam[48] = "model.onnx";
    size_t qlen = httpd_req_get_url_query_len(req);
    if (qlen > 0 && qlen < 128) {
        char query[128];
        if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK) {
            if (httpd_query_key_value(query, "name", nameParam, sizeof(nameParam)) == ESP_OK) {
                web_server_url_decode(nameParam);
            }
        }
    }
    std::snprintf(h.name, sizeof(h.name), "%s", nameParam);

    ESP_LOGI(TAG, "receiving model \"%s\" (%u bytes)", h.name, (unsigned) total);
    ota_pause_robot();

    // Invalidate the old header first: a partial upload must never look installed.
    esp_err_t err = esp_partition_erase_range(p, 0, DATA_OFFSET);
    size_t erasedUpTo = DATA_OFFSET;
    size_t written = 0;
    static char buf[4096];
    while (err == ESP_OK && written < total) {
        int n = web_server_recv(req, buf, std::min(sizeof(buf), total - written));
        if (n <= 0) {
            err = ESP_FAIL;
            break;
        }
        size_t end = DATA_OFFSET + written + (size_t) n;
        while (err == ESP_OK && erasedUpTo < end) {
            // First block is the partial one after the header sector.
            size_t len = std::min(ERASE_BLOCK - (erasedUpTo % ERASE_BLOCK), (size_t) p->size - erasedUpTo);
            err = esp_partition_erase_range(p, erasedUpTo, len);
            erasedUpTo += len;
        }
        if (err == ESP_OK) err = esp_partition_write(p, DATA_OFFSET + written, buf, (size_t) n);
        h.fnv = fnv1a(h.fnv, (const uint8_t *) buf, (size_t) n);
        written += (size_t) n;
    }
    if (err == ESP_OK) err = esp_partition_write(p, 0, &h, sizeof(h));
    ota_resume_robot();

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "model upload failed: %s", esp_err_to_name(err));
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Upload failed -- try again");
        return ESP_OK;
    }
    ESP_LOGI(TAG, "model installed: %u bytes, version %08lx", (unsigned) total, (unsigned long) h.fnv);
    httpd_resp_set_type(req, "text/plain");
    httpd_resp_sendstr(req, "OK, model installed");
    return ESP_OK;
}

} // namespace

void model_store_register_routes() {
    httpd_handle_t server = web_server_get_handle();
    if (server == nullptr) return;
    httpd_uri_t info = {.uri = "/models/info", .method = HTTP_GET, .handler = handle_info, .user_ctx = nullptr,
                        .is_websocket = false, .handle_ws_control_frames = false, .supported_subprotocol = nullptr};
    httpd_uri_t download = info;
    download.uri = "/models/model.onnx";
    download.handler = handle_download;
    httpd_uri_t upload = info;
    upload.uri = "/models/upload";
    upload.method = HTTP_POST;
    upload.handler = handle_upload;
    httpd_register_uri_handler(server, &info);
    httpd_register_uri_handler(server, &download);
    httpd_register_uri_handler(server, &upload);

    Header h;
    const esp_partition_t *p = model_partition();
    if (p == nullptr) {
        ESP_LOGW(TAG, "no 'model' partition in the partition table");
    } else if (read_header(p, &h)) {
        ESP_LOGI(TAG, "model \"%s\" installed (%u bytes)", h.name, (unsigned) h.size);
    } else {
        ESP_LOGI(TAG, "model partition empty (%u KB free)", (unsigned) (p->size / 1024));
    }
}
