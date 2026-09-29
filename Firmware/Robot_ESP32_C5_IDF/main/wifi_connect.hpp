#pragma once

#include <cstddef>
#include <cstdint>

// WiFi connection manager. Joins one of the networks remembered in
// wifi_networks.hpp (no compiled-in credentials any more), and when none of
// them can be joined, opens a WPA2 setup hotspot ("LynXP-XXXX", password
// shown on the OLED) with a captive portal that lands on the /wifi page,
// where a phone can pick a nearby network and enter its password -- the
// usual smart-device onboarding flow. The hotspot shuts itself off again
// once the robot is back on a real network and nobody's connected to it.
//
// Band note: this C5 does 2.4 + 5 GHz, but the S3 camera is 2.4 GHz only and
// is told by the robot which network to join (uart_link.cpp) -- so among
// saved networks in range, ones with a 2.4 GHz access point are preferred,
// and the UI flags 5 GHz-only networks as unusable for the camera.

// Starts WiFi (STA, plus the hotspot when needed) and mDNS ("lynxp.local").
// Non-blocking: the console/motors/control loop stay usable with no WiFi at
// all. Call once from app_main(), after settings are loaded.
void wifi_connect_start();

// True once an IP address has been obtained on a real (station) network.
bool wifi_is_connected();

// This device's station MAC, "AA:BB:CC:DD:EE:FF". Valid as soon as
// wifi_connect_start() returns.
const char *wifi_connect_get_mac();

// Station IP once connected, else "0.0.0.0". Gate display on
// wifi_is_connected() -- not cleared on disconnect.
const char *wifi_connect_get_ip();

// Setup hotspot state (for the OLED and the web UI). The hotspot is open (no
// password); its SSID is fixed once wifi_connect_start() has returned.
bool wifi_ap_is_active();
const char *wifi_ap_get_ssid();

// True if addr (network byte order, as from getsockname()) is the hotspot's
// own address -- i.e. a request arrived through the setup hotspot.
bool wifi_is_ap_address(uint32_t addrNetOrder);

struct WifiStatus {
    bool connected;
    char ssid[33];          // network currently joined ("" if none)
    char ip[16];
    int rssi;               // dBm, 0 if not connected
    int channel;            // primary channel of the access point joined, 0 if not connected
    uint8_t bssid[6];       // that access point's address (all 0 if not connected)
    bool connectedOn5Ghz;
    bool connecting;
    char connectingSsid[33];
    bool apActive;
    int apClients;
    bool scanning;
    uint32_t scanSeq;       // increments after every completed scan
};
void wifi_get_status(WifiStatus *out);

// One entry per SSID seen in the most recent scan (strongest BSS wins).
struct WifiScanEntry {
    char ssid[33];
    int8_t rssi;        // as heard by the robot (0 if only the camera hears it)
    int8_t camRssi;     // as heard by the camera, 0 if it didn't report it
    uint8_t channel;    // primary channel of the strongest access point
    bool secure;        // anything but open
    bool has24;         // a 2.4 GHz access point for this SSID is in range
    bool has5;          // a 5 GHz access point for this SSID is in range
    bool robotHears;    // false = only the camera reported it
    int8_t rssi5;       // strongest 5 GHz access point (if has5)
    uint8_t channel5;
    uint8_t bssid5[6];
};

// One access point (BSS) heard in the robot's last scan. Big networks (e.g.
// iotroam on a campus) have many, on different channels, and the strongest
// isn't always the best -- one on a crowded channel can drop out.
struct WifiApEntry {
    char ssid[33];
    uint8_t bssid[6];
    int8_t rssi;
    uint8_t channel;
};
// Copies up to max access points, strongest first; returns how many.
size_t wifi_get_scan_aps(WifiApEntry *out, size_t max);

// Stick to one access point of a saved network: used whenever the robot
// joins that network (falling back to any of its access points if this one
// can't be reached), and switched to right away. channel 0 = unknown.
// Persisted; one pin at a time. False if ssid isn't a saved network.
bool wifi_pin_ap(const char *ssid, const uint8_t bssid[6], uint8_t channel);
// Back to automatic (strongest access point); the connection stays as is.
void wifi_unpin_ap();
// The pinned access point, if any (ssid: 33 bytes).
bool wifi_get_pinned_ap(char *ssid, uint8_t bssid[6], uint8_t *channel);

// Prefer networks (and, for dual-band SSIDs, access points) on 5 GHz --
// usually far less congested. Off by default: then 2.4 GHz-capable networks
// come first, so the 2.4 GHz-only camera can follow the robot. Persisted.
bool wifi_get_prefer_5ghz();
void wifi_set_prefer_5ghz(bool prefer);
// Copies up to max entries, strongest first; returns how many. Includes
// what the camera heard on its last scan (see wifi_set_camera_scan()).
size_t wifi_get_scan_results(WifiScanEntry *out, size_t max);
// Stores the camera's own scan results (relayed over UART on request).
void wifi_set_camera_scan(const WifiScanEntry *entries, size_t count);
// True if the most recent scan saw this SSID only on 5 GHz (so the S3 camera
// can't join it). False if it has 2.4 GHz or simply wasn't seen.
bool wifi_ssid_is_5ghz_only(const char *ssid);
// True if a scan (the robot's or the camera's) saw this SSID on 2.4 GHz.
bool wifi_ssid_has_24ghz(const char *ssid);
// True if the dotted-quad ip is on the robot's own (station) subnet -- e.g.
// the camera on a router's 2.4 GHz network while the robot uses its 5 GHz one.
bool wifi_ip_in_our_subnet(const char *ip);

// Asynchronous requests to the manager task -- all return immediately.
void wifi_request_scan();
// Diagnostics: next scan uses mode 0 = normal, 1 = passive (400 ms per
// channel), 2 = long active (200-400 ms), and logs every raw record.
void wifi_request_debug_scan(int mode, int channel = 0);
// Regulatory/band state as seen by the driver at the last diagnostic scan.
const char *wifi_debug_info();
// Switch to this saved network now (even if already connected elsewhere);
// tried directly without waiting for it to show up in a scan, so hidden
// networks work too.
void wifi_request_connect(const char *ssid);
// The saved list changed (network added/forgotten): re-evaluate right away
// instead of at the next retry tick -- and drop the current connection if
// its network was just forgotten.
void wifi_networks_changed();
