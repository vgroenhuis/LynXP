#pragma once

#include <cstdint>

// ICMP-pings the S3 CAM (once its IP is known via uart_link.cpp), giving a
// live, continuously-updated WiFi-link-quality signal that correlates in
// real time with camera stream stutter. Complements uart_link.cpp's
// diagnostics: UART keeps working even if the cam-to-router WiFi hop is the
// problem, so on its own it can't tell "cam is stalled" apart from "the
// path between here and the cam is stalled" -- both look identical from the
// UART side. This does, since it exercises that exact path.

// Starts a background task that (re)targets an ICMP ping session at the
// cam's IP whenever uart_link reports one. Call once from app_main(), after
// uart_link_start().
void ping_diag_start();

struct PingStats {
    bool active = false;    // false until the cam's IP is known and a session is running
    uint32_t sent = 0;
    uint32_t received = 0;  // received <= sent; (sent-received)/sent is the loss rate
    uint32_t lastRttMs = 0; // 0 if the most recent probe timed out
    uint32_t avgRttMs = 0;  // exponential moving average over received replies only
};

PingStats ping_diag_get_stats();
