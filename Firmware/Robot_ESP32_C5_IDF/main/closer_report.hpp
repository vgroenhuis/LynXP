#pragma once

#include <cstddef>

// Reports this robot to the CloSer lab demos page
// (https://closer.ram.eemcs.utwente.nl/labdemos/) about once a minute:
// address, firmware, Wi-Fi signal, memory, WebSocket clients and the
// INA260's supply readings -- so the page can show whether the robot is on
// and where to reach it. The same heartbeat API the other lab demos use (see
// the lab demos README), and their updates from the server
// (closer_update.hpp); not their Wi-Fi manager (this firmware has its own).
//
// Each robot has its own device key, "<demo id>.<secret>" (e.g.
// "lynxp-one.xxxx"), made on the server with `python -m labdemos.cli add
// <id>` and stored in NVS from the serial console: `closer key <key>`. No
// key, no reports -- a robot nobody registered stays quiet.

// Starts the background reporter (low priority: the TLS handshake is a few
// hundred ms of CPU, which must not disturb the control loop). Call once from
// app_main(), after wifi_connect_start().
void closer_report_start();

// Stores (or with "" clears) the device key in NVS; takes effect at the next
// report. False if the key is too long or the NVS write failed.
bool closer_report_set_key(const char *key);

// The demo id from the stored key ("" if none), and what the last report
// got back ("" before the first one) -- for the serial console.
const char *closer_report_demo_id();
const char *closer_report_last_result();
// Sends the next report now instead of at the end of the interval (the
// page's "Check for updates").
void closer_report_now();
// The stored key, for closer_update.cpp's downloads.
const char *closer_report_device_key();

// Records for one second which task runs when, on this board and on the
// camera (cpu_trace.h), and then sends both to the lab demos page, which
// draws them. Asked for by the page (GET /cputrace?start=1 on this board, or
// "trace": true in a heartbeat reply). False if there is no key, one is
// already under way, or the last one was less than 10 s ago.
bool closer_report_request_trace();

// "idle", "asked", "recording", "uploading", "sent", "failed: ...".
const char *closer_report_trace_state();
