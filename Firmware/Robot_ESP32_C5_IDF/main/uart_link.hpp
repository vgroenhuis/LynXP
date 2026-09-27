#pragma once

#include <cstdint>

// Listens on UART1 for the S3 CAM firmware's periodic status line, wired to
// this board's MI/MO header pins (board_pins.hpp). Ported from
// Test_ESP32_C5_IDF_for_S3_CAM/main/uart_link.c, extended with the cam's
// diagnostics fields (see ESP32_S3_CAM_IDF/main/main.c's status_uart_send())
// so a stuttering/dead camera stream can be traced to WiFi, a reboot
// (brownout or otherwise), or the camera's own capture bus glitching --
// without needing the cam's own (possibly also struggling) WiFi/HTTP to ask.

// Everything the cam last reported. Fields keep their previous value if a
// received line omits that key (forward/backward compatible with either
// side changing independently) -- only uart_link_peer_is_stale() tells you
// whether this snapshot is still current.
struct CamDiagnostics {
    char mac[18] = "";
    char ip[16] = "0.0.0.0";
    int rssiDbm = 0;             // 0 until at least one reading arrives
    uint32_t uptimeS = 0;
    uint32_t freeHeapBytes = 0;
    uint32_t minFreeHeapBytes = 0;
    uint32_t camFailCount = 0;   // esp_camera_fb_get() NULL count since the cam's last boot
    uint32_t rebootCount = 0;    // since the cam was last power-cycled (RTC memory, not NVS)
    int clients = 0;             // active /stream viewers
    char resetReason[16] = "";   // "POWERON", "BROWNOUT", "TASK_WDT", "USB", ... -- see reset_reason_str() on the cam
    char ssid[33] = "";          // network the cam is currently joined to ("" if none) -- from its NET line
};

// Configures UART1 and starts the RX task. Call once from app_main().
void uart_link_start();

// Snapshot of the most recently parsed STAT line, whatever fields it had.
const CamDiagnostics &uart_link_get_diagnostics();

// "" until the first STAT line is received.
const char *uart_link_get_peer_mac();

// "0.0.0.0" until the peer reports it has joined WiFi.
const char *uart_link_get_peer_ip();

// SSID the cam reports being joined to, "" if none (or an older cam build
// that doesn't send NET lines).
const char *uart_link_get_peer_ssid();

// WiFi hand-off: the cam has no network list or setup UI of its own. While
// the robot is online, the link task periodically checks whether the cam is
// on the same network and, if not, sends it the robot's current network
// ("WIFI ssid=<hex> pass=<hex>"), which the cam remembers and joins.
// Skipped when the cam is already on the robot's subnet (e.g. the same
// router's 2.4 GHz network), or the network has no 2.4 GHz (the S3 is
// 2.4 GHz-only).

// Asks the camera to scan (2.4 GHz, with its own external antenna) and
// report what it hears ("AP ..." lines, then "APEND"); the results show up
// in wifi_get_scan_results(). False (and nothing sent) if the camera isn't
// linked.
bool uart_link_request_cam_scan();

// Idle: no request outstanding (or the last one was answered). Scanning:
// asked, waiting for its report. NoAnswer: asked >10 s ago and nothing came
// back -- typically camera firmware that predates scan reporting.
enum class CamScanState { Idle, Scanning, NoAnswer };
CamScanState uart_link_cam_scan_state();

// True if no STAT line has ever arrived, or none has arrived in >6s (peer
// rebooted, UART unplugged, etc.) -- caller should show a "no link" state
// instead of stale data.
bool uart_link_peer_is_stale();
