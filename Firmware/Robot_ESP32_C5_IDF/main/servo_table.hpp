#pragma once

#include <cstddef>

// Per-servo calibration tables: the pulse that turns the servo to each of
// -90, -75, ..., +90 degrees, measured by the camera calibration app's servo
// step (app_camservo.js) -- hobby servos aren't linear enough for the
// min / center / max pulses alone (a robot here was 1.5-1.8 degrees off
// halfway, ~2 cm at the distance of a block). Between those angles the
// pulse is interpolated. A servo without a table uses min / center / max as
// before (computeServoPulseUs / computeTiltServoPulseUs).
//
// Kept apart from the Settings blob (own NVS key): adding fields there
// bumps its version, which resets every saved setting.

constexpr int SERVO_TABLE_N = 13;          // -90 .. +90 every 15 degrees
constexpr float SERVO_TABLE_STEP_DEG = 15.0f;

struct ServoTable {
    bool valid;
    float pulseUs[SERVO_TABLE_N];
};

extern ServoTable g_panTable;
extern ServoTable g_tiltTable;

// From NVS (call once at boot, before the servos are driven).
void servo_tables_load();
bool servo_tables_save();

// "p0,p1,...,p12" (microseconds, increasing or decreasing throughout) or
// "none" (no table). False, out unchanged, if malformed.
bool servo_table_parse(const char *csv, ServoTable *out);

// The table's pulse for angleDeg (clamped to -90..90).
float servo_table_pulse(const ServoTable &t, float angleDeg);

// JSON: [p0,...,p12] or null.
void servo_table_json(const ServoTable &t, char *out, size_t outLen);
