#pragma once

#include <cstddef>

// The robot's list of remembered WiFi networks, persisted in NVS (its own
// "wifinets" namespace -- deliberately NOT inside the Settings blob, so a
// SETTINGS_VERSION bump never makes the robot forget how to get online).
// Replaces the old compiled-in wifi_creds.h list and the single
// settings.altSsid override: networks are added/forgotten at runtime from
// the web UI (Main page "Wi-Fi networks" panel, or the setup hotspot's
// captive-portal page -- see wifi_connect.cpp).
//
// Thread-safe: every function takes an internal mutex, since the HTTP
// handlers, wifi_connect.cpp's manager task and uart_link.cpp's cam-sync
// all touch the list from different tasks.

struct WifiCredential {
    char ssid[33];     // 32 bytes max per 802.11 + NUL
    char password[65]; // 63-char WPA2 passphrase or 64-hex PSK + NUL; "" = open network
};

// Upper bound on remembered networks. "As many as you like" in practice --
// each entry is ~100 bytes of NVS, and this cap just keeps a runaway client
// from filling the 32 KB NVS partition that Settings/waypoints also live in.
constexpr size_t WIFI_NETWORKS_MAX = 50;

// Loads the list from NVS. On the first boot after the switch away from
// wifi_creds.h, also imports (once) whatever network the WiFi driver itself
// last had configured -- i.e. the network the robot was on under the old
// firmware -- plus the legacy settings.altSsid override if one was set, so
// an OTA to this firmware doesn't knock a remote robot offline.
// Call after loadSettings() and after esp_wifi_init() (the driver's own
// persisted config is only readable once it's initialised).
void wifi_networks_init();

size_t wifi_networks_count();

// Copies entry i (in the order they were added) into *out. False if out of range.
bool wifi_networks_get(size_t index, WifiCredential *out);

// Looks up a saved network by exact SSID. out may be nullptr (existence check).
bool wifi_networks_find(const char *ssid, WifiCredential *out);

// Adds a network, or updates the password of an already-saved SSID.
// False if the SSID is empty/too long, the password too long, or the list is full.
bool wifi_networks_add(const char *ssid, const char *password);

// Forgets a saved network. False if it wasn't saved.
bool wifi_networks_remove(const char *ssid);
