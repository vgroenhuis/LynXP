#include "cam_stream.hpp"
#include "cam_link.hpp"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "lwip/sockets.h"

#include <cstdio>
#include <cstring>

namespace {

const char *TAG = "cam_stream";
constexpr size_t FRAME_CAP = 160 * 1024; // as cam_link's VIDEO_FRAME_MAX
constexpr const char *BOUNDARY = "lynxpframe";

SemaphoreHandle_t s_lock = nullptr;
int s_viewers = 0;
bool s_startedVideo = false; // the stream asked for the video (and stops it again)
uint32_t s_framesSent = 0, s_viewersTotal = 0;
uint64_t s_bytesSent = 0;
int64_t s_windowStart = 0;
uint32_t s_windowFrames = 0;
float s_sendFps = 0;

bool send_all(int sock, const void *data, size_t len) {
    const uint8_t *p = (const uint8_t *) data;
    while (len > 0) {
        int n = send(sock, p, len, 0);
        if (n <= 0) return false;
        p += n;
        len -= (size_t) n;
    }
    return true;
}

void viewer_joined() {
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (s_viewers++ == 0 && !cam_link_video_running()) s_startedVideo = cam_link_set_video(CAM_STREAM_FPS);
    s_viewersTotal++;
    xSemaphoreGive(s_lock);
}

void viewer_left() {
    xSemaphoreTake(s_lock, portMAX_DELAY);
    if (--s_viewers == 0 && s_startedVideo) {
        cam_link_set_video(0);
        s_startedVideo = false;
    }
    xSemaphoreGive(s_lock);
}

void count_frame(size_t bytes) {
    xSemaphoreTake(s_lock, portMAX_DELAY);
    s_framesSent++;
    s_bytesSent += bytes;
    int64_t now = esp_timer_get_time();
    s_windowFrames++;
    if (now - s_windowStart >= 2000000) {
        s_sendFps = (float) s_windowFrames * 1e6f / (float) (now - s_windowStart);
        s_windowStart = now;
        s_windowFrames = 0;
    }
    xSemaphoreGive(s_lock);
}

// One viewer: the multipart header, then every new frame until the viewer goes.
void viewer_task(void *arg) {
    int sock = (int) (intptr_t) arg;
    uint8_t *frame = (uint8_t *) heap_caps_malloc(FRAME_CAP, MALLOC_CAP_SPIRAM);
    char req[256];
    recv(sock, req, sizeof(req), 0); // (any path: this port only streams)
    char head[160];
    int n = std::snprintf(head, sizeof(head),
                          "HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace;boundary=%s\r\n"
                          "Cache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\n\r\n", BOUNDARY);
    if (frame != nullptr && send_all(sock, head, (size_t) n)) {
        viewer_joined();
        uint32_t seq = 0, lastSeq = 0;
        int64_t waitingSince = esp_timer_get_time();
        while (true) {
            size_t len = cam_link_copy_frame(frame, FRAME_CAP, &seq);
            if (len == 0 || seq == lastSeq) {
                if (esp_timer_get_time() - waitingSince > 10000000) break; // no frames for 10 s: camera gone
                vTaskDelay(pdMS_TO_TICKS(5));
                continue;
            }
            lastSeq = seq;
            waitingSince = esp_timer_get_time();
            n = std::snprintf(head, sizeof(head), "--%s\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n", BOUNDARY,
                              (unsigned) len);
            if (!send_all(sock, head, (size_t) n) || !send_all(sock, frame, len) || !send_all(sock, "\r\n", 2)) break;
            count_frame(len);
        }
        viewer_left();
    }
    heap_caps_free(frame);
    shutdown(sock, SHUT_RDWR);
    close(sock);
    vTaskDelete(nullptr);
}

void server_task(void *arg) {
    (void) arg;
    int listener = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    int one = 1;
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    sockaddr_in addr = {};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(CAM_STREAM_PORT);
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(listener, (sockaddr *) &addr, sizeof(addr)) != 0 || listen(listener, 2) != 0) {
        ESP_LOGE(TAG, "can't listen on port %d", CAM_STREAM_PORT);
        close(listener);
        vTaskDelete(nullptr);
    }
    ESP_LOGI(TAG, "MJPEG stream on port %d (/stream)", CAM_STREAM_PORT);
    while (true) {
        int sock = accept(listener, nullptr, nullptr);
        if (sock < 0) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        xSemaphoreTake(s_lock, portMAX_DELAY);
        bool full = s_viewers >= CAM_STREAM_VIEWERS;
        xSemaphoreGive(s_lock);
        if (full) {
            const char *busy = "HTTP/1.1 503 Service Unavailable\r\nContent-Type: text/plain\r\n\r\nToo many viewers\r\n";
            send_all(sock, busy, std::strlen(busy));
            close(sock);
            continue;
        }
        timeval tv = {3, 0}; // a viewer that stops reading is dropped after 3 s
        setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
        setsockopt(sock, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
        setsockopt(sock, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
        // Below the control task and the link task: a late frame doesn't matter.
        if (xTaskCreate(viewer_task, "cam_viewer", 3072, (void *) (intptr_t) sock, tskIDLE_PRIORITY + 1, nullptr) != pdPASS) {
            close(sock);
        }
    }
}

} // namespace

void cam_stream_start() {
    s_lock = xSemaphoreCreateMutex();
    xTaskCreate(server_task, "cam_stream", 3072, nullptr, tskIDLE_PRIORITY + 1, nullptr);
}

int cam_stream_json(char *out, size_t len) {
    xSemaphoreTake(s_lock, portMAX_DELAY);
    int n = std::snprintf(out, len, "{\"viewers\":%d,\"viewersTotal\":%lu,\"framesSent\":%lu,\"sendFps\":%.1f,\"bytesSent\":%llu}",
                          s_viewers, (unsigned long) s_viewersTotal, (unsigned long) s_framesSent, (double) s_sendFps,
                          (unsigned long long) s_bytesSent);
    xSemaphoreGive(s_lock);
    return n;
}
