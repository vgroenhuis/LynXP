#include "wifi_networks.hpp"
#include "settings.hpp"

#include "nvs.h"
#include "esp_log.h"
#include "esp_wifi.h"

#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#include <cstdio>
#include <cstring>

// Storage layout, namespace "wifinets": one blob per network under keys
// "n0".."n<count-1>" (a WifiCredential each, in the order added), "count"
// (u16), and "migrated" (u8, set once the one-time import in
// wifi_networks_init() has run). One key per entry rather than one big blob,
// so adding a network is a single small write instead of rewriting the whole
// list every time.

namespace {

const char *TAG = "wifi_networks";
constexpr const char *NVS_NAMESPACE = "wifinets";

SemaphoreHandle_t s_mutex = nullptr;
WifiCredential s_nets[WIFI_NETWORKS_MAX];
size_t s_count = 0;

struct Lock {
    Lock() { xSemaphoreTake(s_mutex, portMAX_DELAY); }
    ~Lock() { xSemaphoreGive(s_mutex); }
};

void entry_key(size_t index, char *key, size_t keyLen) {
    std::snprintf(key, keyLen, "n%u", (unsigned) index);
}

// Writes entries [from, s_count) plus the count, and erases the key one past
// the end (the slot a removal just vacated). Caller holds the lock.
bool persist_from(size_t from, bool eraseOnePastEnd) {
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) != ESP_OK) return false;
    esp_err_t err = ESP_OK;
    char key[16];
    for (size_t i = from; i < s_count && err == ESP_OK; i++) {
        entry_key(i, key, sizeof(key));
        err = nvs_set_blob(h, key, &s_nets[i], sizeof(WifiCredential));
    }
    if (err == ESP_OK && eraseOnePastEnd) {
        entry_key(s_count, key, sizeof(key));
        nvs_erase_key(h, key); // ESP_ERR_NVS_NOT_FOUND is fine
    }
    if (err == ESP_OK) err = nvs_set_u16(h, "count", (uint16_t) s_count);
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    if (err != ESP_OK) ESP_LOGE(TAG, "saving network list failed: %s", esp_err_to_name(err));
    return err == ESP_OK;
}

int index_of(const char *ssid) {
    for (size_t i = 0; i < s_count; i++) {
        if (std::strcmp(s_nets[i].ssid, ssid) == 0) return (int) i;
    }
    return -1;
}

// Caller holds the lock.
bool add_locked(const char *ssid, const char *password) {
    if (ssid == nullptr || ssid[0] == '\0' || std::strlen(ssid) >= sizeof(WifiCredential::ssid)) return false;
    if (password == nullptr) password = "";
    if (std::strlen(password) >= sizeof(WifiCredential::password)) return false;

    int existing = index_of(ssid);
    size_t slot;
    if (existing >= 0) {
        slot = (size_t) existing;
    } else {
        if (s_count >= WIFI_NETWORKS_MAX) return false;
        slot = s_count++;
    }
    WifiCredential &c = s_nets[slot];
    std::memset(&c, 0, sizeof(c));
    std::strncpy(c.ssid, ssid, sizeof(c.ssid) - 1);
    std::strncpy(c.password, password, sizeof(c.password) - 1);
    return persist_from(slot, false);
}

// One-time import so the switch away from compiled-in credentials doesn't
// strand a robot that's currently only online thanks to them.
void migrate_once() {
    nvs_handle_t h;
    uint8_t migrated = 0;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u8(h, "migrated", &migrated);
        nvs_close(h);
    }
    if (migrated) return;

    // The WiFi driver persists the last esp_wifi_set_config() to its own NVS
    // namespace -- under the old firmware that's the network it last joined
    // (from wifi_creds.h or the altSsid override).
    wifi_config_t cfg = {};
    if (esp_wifi_get_config(WIFI_IF_STA, &cfg) == ESP_OK && cfg.sta.ssid[0] != '\0') {
        char ssid[33] = {};
        char pass[65] = {};
        std::memcpy(ssid, cfg.sta.ssid, sizeof(cfg.sta.ssid));
        std::memcpy(pass, cfg.sta.password, sizeof(cfg.sta.password));
        if (add_locked(ssid, pass)) ESP_LOGI(TAG, "imported last-used network \"%s\"", ssid);
    }
    if (settings.legacyAltSsid[0] != '\0') {
        settings.legacyAltSsid[sizeof(settings.legacyAltSsid) - 1] = '\0';
        settings.legacyAltPassword[sizeof(settings.legacyAltPassword) - 1] = '\0';
        if (add_locked(settings.legacyAltSsid, settings.legacyAltPassword)) {
            ESP_LOGI(TAG, "imported legacy alternate network \"%s\"", settings.legacyAltSsid);
        }
        // Not needed any more -- and no reason to keep a plaintext copy around.
        std::memset(settings.legacyAltSsid, 0, sizeof(settings.legacyAltSsid));
        std::memset(settings.legacyAltPassword, 0, sizeof(settings.legacyAltPassword));
        saveSettings();
    }

    if (nvs_open(NVS_NAMESPACE, NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_u8(h, "migrated", 1);
        nvs_commit(h);
        nvs_close(h);
    }
}

} // namespace

void wifi_networks_init() {
    if (s_mutex == nullptr) s_mutex = xSemaphoreCreateMutex();
    Lock lock;

    s_count = 0;
    nvs_handle_t h;
    if (nvs_open(NVS_NAMESPACE, NVS_READONLY, &h) == ESP_OK) {
        uint16_t count = 0;
        nvs_get_u16(h, "count", &count);
        char key[16];
        for (size_t i = 0; i < count && s_count < WIFI_NETWORKS_MAX; i++) {
            entry_key(i, key, sizeof(key));
            WifiCredential c;
            size_t len = sizeof(c);
            if (nvs_get_blob(h, key, &c, &len) == ESP_OK && len == sizeof(c)) {
                c.ssid[sizeof(c.ssid) - 1] = '\0';
                c.password[sizeof(c.password) - 1] = '\0';
                s_nets[s_count++] = c;
            }
        }
        nvs_close(h);
    }

    migrate_once();
    ESP_LOGI(TAG, "%u saved network(s)", (unsigned) s_count);
}

size_t wifi_networks_count() {
    Lock lock;
    return s_count;
}

bool wifi_networks_get(size_t index, WifiCredential *out) {
    Lock lock;
    if (index >= s_count) return false;
    *out = s_nets[index];
    return true;
}

bool wifi_networks_find(const char *ssid, WifiCredential *out) {
    Lock lock;
    int i = index_of(ssid);
    if (i < 0) return false;
    if (out) *out = s_nets[i];
    return true;
}

bool wifi_networks_add(const char *ssid, const char *password) {
    Lock lock;
    return add_locked(ssid, password);
}

bool wifi_networks_remove(const char *ssid) {
    Lock lock;
    int i = index_of(ssid);
    if (i < 0) return false;
    for (size_t j = (size_t) i; j + 1 < s_count; j++) s_nets[j] = s_nets[j + 1];
    s_count--;
    return persist_from((size_t) i, true);
}
