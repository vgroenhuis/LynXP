#pragma once

#include <cstddef>

// Robot-side storage for the Games & apps page (games.html/games.js): the
// active game/app, per-game settings, and high scores. Same idea as
// waypoints.hpp -- each document is an OPAQUE JSON blob to the firmware, its
// schema owned entirely by the JS, so adding a game or a setting never needs
// a firmware change (or a SETTINGS_VERSION bump wiping calibration).
//
// Stored per document name in NVS namespace "appdata", so every device that
// opens the robot's pages sees the same choices and the same scoreboard.

constexpr size_t APP_DATA_JSON_MAX_LEN = 4096;

// Known document names -- anything else is rejected, so a client can't
// create arbitrary NVS keys.
bool app_data_is_valid_name(const char *name);

// Loads the document into buf (NUL-terminated). Missing -> "{}".
void app_data_load(const char *name, char *buf, size_t bufSize);

// Persists the document. False if too long or the write failed.
bool app_data_save(const char *name, const char *json, size_t len);
