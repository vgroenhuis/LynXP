#pragma once

// ESP-IDF replacement for Robot_Pico2W_SDK/src/wifi_connect.cpp's Mongoose-
// driven Wi-Fi setup. Same policy: prefer settings.altSsid/altPassword (set
// via POST /wifi once web_server.cpp exists) if present, else scan the
// compiled-in fallback network list from wifi_creds.h (same multi-network
// scheme as ESP32_S3_CAM_IDF) and join whichever one is in range; retry
// indefinitely on disconnect.

// Starts Wi-Fi STA and mDNS ("lynxp.local"). Non-blocking -- does NOT
// wait for an IP before returning, unlike the Test_ESP32_S3_Feather_ESP_IDF
// spike's wifi_init_sta(). The console/motors/control loop must stay usable
// even if Wi-Fi never comes up (unplugged router, wrong password, etc.).
// Call once from app_main(), after settings are loaded.
void wifi_connect_start();

// Re-applies new credentials at runtime (from POST /wifi) and reconnects.
// Copies the strings internally, so the caller's buffers don't need to
// outlive the call -- points at settings.altSsid/altPassword after the
// caller has already persisted them there, same as the Pico version.
void wifi_reconnect_with(const char *ssid, const char *password);

// True once an IP address has been obtained.
bool wifi_is_connected();

// This device's station MAC, formatted "AA:BB:CC:DD:EE:FF". Valid as soon as
// wifi_connect_start() returns (read from efuse, not dependent on a
// connection existing yet) -- unlike the IP below, never empty.
const char *wifi_connect_get_mac();

// Dotted-quad IP address once connected, else "0.0.0.0". Reflects the most
// recent IP_EVENT_STA_GOT_IP; not cleared back to "0.0.0.0" on disconnect,
// so callers should gate display on wifi_is_connected() rather than on this
// string alone.
const char *wifi_connect_get_ip();
