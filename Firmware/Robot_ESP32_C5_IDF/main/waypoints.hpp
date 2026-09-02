#pragma once

#include <cstddef>

// Ported from Robot_Pico2W_SDK/src/waypoints.hpp -- API and semantics
// unchanged, NVS backend instead of a littlefs file.
//
// Server-side storage for the user-defined waypoint list (name/x/y/heading,
// NOT including the fixed "Home" waypoint at the origin, which both the
// Main and Camera pages hardcode client-side and never send here). Moved
// from each browser's own localStorage -- which is per-device and never
// synced -- to the robot's own storage, so every connected device sees the
// same list.
//
// Deliberately an OPAQUE JSON blob as far as the firmware is concerned: the
// array-of-objects schema is owned entirely by the JS frontend
// (app.js/cam.js). The robot just persists and returns whatever text it's
// given, capped at WAYPOINTS_JSON_MAX_LEN -- no server-side parsing of
// individual fields, so there's no schema to keep in sync between C++ and
// JS.
constexpr size_t WAYPOINTS_JSON_MAX_LEN = 4096;

// Loads the stored JSON text into buf (NUL-terminated), up to bufSize-1
// bytes. Missing data is not an error -- treated as an empty list, "[]",
// matching a fresh localStorage.getItem() that returned null.
void loadWaypointsJson(char *buf, size_t bufSize);

// Persists the given JSON text (as posted by a client) to NVS. Returns
// false (without writing) if len exceeds WAYPOINTS_JSON_MAX_LEN, or if the
// write itself failed.
bool saveWaypointsJson(const char *json, size_t len);
