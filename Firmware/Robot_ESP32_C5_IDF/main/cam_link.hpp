#pragma once

#include <cstdint>

// The link to the S3 CAM firmware: the robot is the SPI master, the camera the
// slave (wires: board_pins.hpp's CAM_SPI_* pins; framing, acknowledgements and
// resynchronisation: cam_link_proto.h). It carries the same text lines the old
// UART link did -- the cam's periodic "STAT"/"NET" status lines and "AP" scan
// results towards the robot, "WIFI", "OTA" and "SCAN" towards the cam -- and
// has room for camera frames later (frame type VIDEO), so they can be streamed
// from here over this board's own (also 5 GHz) Wi-Fi. The cam's diagnostics
// fields (see ESP32_S3_CAM_IDF/main/main.c's status_link_send()) let a
// stuttering/dead camera stream be traced to WiFi, a reboot (brownout or
// otherwise), or the camera's own capture bus glitching -- without needing
// the cam's own (possibly also struggling) WiFi/HTTP to ask.

// Everything the cam last reported. Fields keep their previous value if a
// received line omits that key (forward/backward compatible with either
// side changing independently) -- only cam_link_peer_is_stale() tells you
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

// Sets up the SPI master and starts the link task. Call once from app_main().
void cam_link_start();

// Snapshot of the most recently parsed STAT line, whatever fields it had.
const CamDiagnostics &cam_link_get_diagnostics();

// "" until the first STAT line is received.
const char *cam_link_get_peer_mac();

// "0.0.0.0" until the peer reports it has joined WiFi.
const char *cam_link_get_peer_ip();

// SSID the cam reports being joined to, "" if none (or an older cam build
// that doesn't send NET lines).
const char *cam_link_get_peer_ssid();

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
bool cam_link_request_cam_scan();

// Idle: no request outstanding (or the last one was answered). Scanning:
// asked, waiting for its report. NoAnswer: asked >10 s ago and nothing came
// back -- typically camera firmware that predates scan reporting.
enum class CamScanState { Idle, Scanning, NoAnswer };
CamScanState cam_link_cam_scan_state();

// True if no STAT line has ever arrived, or none has arrived in >6s (peer
// rebooted, SPI cable unplugged, etc.) -- caller should show a "no link" state
// instead of stale data.
bool cam_link_peer_is_stale();

// Call after settings.otaUsername/otaPassword change: re-sends them to the
// camera (which guards its own /update with them) on the next link check.
void cam_link_credentials_changed();

// Link diagnostics as JSON (GET /camraw, console "camraw"): pins, transfer and
// frame counters, and the last 128-byte frame received and sent, in hex --
// all ff or all 00 received means the camera isn't driving MISO at all.
// Needs about 700 bytes of room.
int cam_link_raw_json(char *out, size_t len);

// Changes the link's SPI clock until the next restart (100 kHz .. 40 MHz;
// GET /camraw?clock=<Hz>, console "camclock <Hz>"), to find how fast the
// wires allow. False if out of range or the link isn't running.
bool cam_link_set_clock(int hz);

// Video from the camera over the link (cam_link_proto.h, "Video"): asks the
// camera for at most fps JPEGs per second (0: stop). False if out of range
// (0..30), out of PSRAM, or the link isn't running.
bool cam_link_set_video(int fps);

// True while video is asked of the camera (fps > 0).
bool cam_link_video_running();

// Video statistics as JSON (GET /camvideo): asked and measured frame rate,
// frames, chunks, bad chunks, dropped frames.
int cam_link_video_json(char *out, size_t len);

// Pause before each promised video area (0..50 ms, GET /camvideo?gap=<ms>).
void cam_link_set_video_gap(int ms);

// Copies the latest complete JPEG into out (up to cap bytes); returns its
// length (0: none yet, or it doesn't fit), *seq counts frames.
size_t cam_link_copy_frame(uint8_t *out, size_t cap, uint32_t *seq);
