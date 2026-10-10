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

// Backlash: a hobby servo stops short by a fraction of a degree in whichever
// direction it was turning (pan measured 1.5 degrees between arriving from
// the left and from the right). backlashDeg = where it ends up turning toward
// + less where it ends up turning toward - (degrees; measured by the servo
// step, app_camservo.js); the command is shifted by half of it against the
// way the servo last turned, so it ends up in the same place either way.
// Persisted with the tables (servo_tables_save()).
extern float g_panBacklashDeg;
extern float g_tiltBacklashDeg;

struct BacklashState {
    bool started;
    float last;   // the last angle asked for
    int dir;      // the way it last turned: +1, -1 (0: not yet)
};
// The angle to command for angleDeg, given how the servo turned so far.
float servo_backlash_adjust(BacklashState *s, float angleDeg, float backlashDeg);
