#include "captive_dns.hpp"

#include "esp_log.h"
#include "lwip/sockets.h"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#include <cstring>

// Deliberately tiny rather than ESP-IDF's captive_portal example
// dns_server component: that one logs every packet at INFO, and handles
// multi-question packets nobody sends in practice. This answers the single
// question real resolvers send, echoing the question back and appending one
// A record -- any EDNS additional record in the request is dropped (ARCOUNT 0).

namespace {

const char *TAG = "captive_dns";

constexpr uint16_t DNS_PORT = 53;
constexpr size_t HEADER_LEN = 12;
constexpr uint16_t TYPE_A = 1;
constexpr uint16_t CLASS_IN = 1;
// Short, so a phone that leaves the hotspot doesn't hang on to "everything
// is 192.168.4.1" for long.
constexpr uint32_t ANSWER_TTL_S = 10;

uint32_t s_answerIp = 0;
bool s_started = false;

void put16(uint8_t *p, uint16_t v) { p[0] = v >> 8; p[1] = v & 0xFF; }
uint16_t get16(const uint8_t *p) { return (uint16_t) ((p[0] << 8) | p[1]); }

// Returns the reply length, or 0 to send nothing.
size_t build_reply(const uint8_t *req, size_t len, uint8_t *reply, size_t replyMax) {
    if (len < HEADER_LEN) return 0;
    if (req[2] & 0x80) return 0;             // QR set: it's a response, not a query
    if ((req[2] & 0x78) != 0) return 0;      // opcode != standard query
    if (get16(req + 4) != 1) return 0;       // exactly one question

    // Walk QNAME (length-prefixed labels, no compression in a question).
    size_t pos = HEADER_LEN;
    while (pos < len && req[pos] != 0) {
        if (req[pos] & 0xC0) return 0;
        pos += 1 + req[pos];
    }
    pos += 1; // the root label
    if (pos + 4 > len) return 0;
    uint16_t qtype = get16(req + pos);
    uint16_t qclass = get16(req + pos + 2);
    size_t questionEnd = pos + 4;

    bool answerA = qtype == TYPE_A && qclass == CLASS_IN;
    size_t replyLen = questionEnd + (answerA ? 16 : 0);
    if (replyLen > replyMax) return 0;

    std::memcpy(reply, req, questionEnd);
    reply[2] = 0x80 | 0x04 | (req[2] & 0x01); // QR, AA, echo RD
    reply[3] = 0x80;                          // RA, RCODE NOERROR
    put16(reply + 6, answerA ? 1 : 0);        // ANCOUNT
    put16(reply + 8, 0);                      // NSCOUNT
    put16(reply + 10, 0);                     // ARCOUNT

    if (answerA) {
        uint8_t *a = reply + questionEnd;
        put16(a, 0xC000 | HEADER_LEN);        // name: pointer to the question's QNAME
        put16(a + 2, TYPE_A);
        put16(a + 4, CLASS_IN);
        put16(a + 6, (uint16_t) (ANSWER_TTL_S >> 16));
        put16(a + 8, (uint16_t) (ANSWER_TTL_S & 0xFFFF));
        put16(a + 10, 4);
        std::memcpy(a + 12, &s_answerIp, 4);  // already network byte order
    }
    return replyLen;
}

void dns_task(void *) {
    int sock = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (sock < 0) {
        ESP_LOGE(TAG, "socket() failed: errno %d", errno);
        vTaskDelete(nullptr);
        return;
    }
    sockaddr_in addr = {};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(DNS_PORT);
    addr.sin_addr.s_addr = htonl(INADDR_ANY);
    if (bind(sock, (sockaddr *) &addr, sizeof(addr)) < 0) {
        ESP_LOGE(TAG, "bind(53) failed: errno %d", errno);
        close(sock);
        vTaskDelete(nullptr);
        return;
    }
    ESP_LOGI(TAG, "captive DNS listening on port %u", DNS_PORT);

    uint8_t req[512];
    uint8_t reply[512 + 16];
    while (true) {
        sockaddr_in from = {};
        socklen_t fromLen = sizeof(from);
        int n = recvfrom(sock, req, sizeof(req), 0, (sockaddr *) &from, &fromLen);
        if (n <= 0) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        size_t replyLen = build_reply(req, (size_t) n, reply, sizeof(reply));
        if (replyLen > 0) sendto(sock, reply, replyLen, 0, (sockaddr *) &from, fromLen);
    }
}

} // namespace

void captive_dns_start(uint32_t answerIp) {
    s_answerIp = answerIp;
    if (s_started) return;
    s_started = true;
    xTaskCreate(dns_task, "captive_dns", 3072, nullptr, tskIDLE_PRIORITY + 1, nullptr);
}
