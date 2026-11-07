#pragma once

#include <cstddef>

// Per-servo calibration tables: the pulse that turns the servo to each of
// -90, -85, ..., +90 degrees, measured by the camera calibration app's servo
// step (app_camservo.js) -- hobby servos aren't linear enough for the
// min / center / max pulses alone (a robot here was 1.5-1.8 degrees off
// halfway, ~2 cm at the distance of a block). Between those angles the
// pulse is interpolated. A servo without a table uses min / center / max as
// before (computeServoPulseUs / computeTiltServoPulseUs).
//
// Kept apart from the Settings blob (own NVS key): adding fields there
// bumps its version, which resets every saved setting.

constexpr int SERVO_TABLE_N = 37;          // -90 .. +90 every 5 degrees (the tilt servo is uneven on a finer scale than 15)
constexpr float SERVO_TABLE_STEP_DEG = 5.0f;
constexpr int SERVO_TABLE_N_OLD = 13;      // (tables every 15 degrees: still read, and accepted by /set)

struct ServoTable {
    bool valid;
    float pulseUs[SERVO_TABLE_N];
};

extern ServoTable g_panTable;
extern ServoTable g_tiltTable;

// From NVS (call once at boot, before the servos are driven).
void servo_tables_load();
bool servo_tables_save();

// "p0,p1,...,p36" (microseconds, increasing or decreasing throughout) -- or
// the old 13 every 15 degrees, spread over the 37 -- or "none" (no table).
// False, out unchanged, if malformed.
bool servo_table_parse(const char *csv, ServoTable *out);

// The table's pulse for angleDeg (clamped to -90..90).
float servo_table_pulse(const ServoTable &t, float angleDeg);

// JSON: [p0,...,p36] or null.
void servo_table_json(const ServoTable &t, char *out, size_t outLen);

// Backlash. backlashDeg = where a servo ends up arriving turning toward +,
// less where it ends up arriving turning toward - (degrees; measured by the
// servo step, app_camservo.js). Persisted with the tables (servo_tables_save()).
//
// Measured on the checkerboard (fw 1.5.18, 2026-11-07): the pan servo
// OVERSHOOTS, arriving ~1.1 deg further than told in the way it turned (0.85
// deg at 20 deg/s .. 1.3 at 300 deg/s, the same for steps of 2 to 30 deg);
// the tilt servo ~0.1 deg. And both ignore small reversals: from rest, pan
// doesn't move at all for a reversal of up to ~1-1.5 deg (tilt ~0.5), and
// same-way steps under ~0.5 deg (tilt ~0.3) barely move.
//
// backlashDeg > 0 (overshoot): the command goes through a play band of that
// width -- told to turn back by less than backlashDeg it holds still (where
// the servo, having overshot, already points), and from there on it follows
// backlashDeg / 2 behind the target. That's continuous: the old "shift by
// half against the way it last turned" jumped the full backlash the other way
// at every reversal, which swung the camera ~0.5 deg the WRONG way for a
// reversal under ~0.5 deg (and left it where it was up to ~2.5 deg).
// backlashDeg < 0 (a servo that stops short, the classic gear gap): the
// command leads by half of it in the way it turns, jumping across the gap at
// a reversal.
//
// kickDeg: when the command starts moving after standing still, or turns
// the other way, it's pushed kickDeg further for one PWM frame -- to get the
// servo out of its dead zone (a 20 ms kick of 1.5-3 deg made 0.5-1 deg tilt
// reversals land within ~0.1 deg instead of not moving). 0 = off.
extern float g_panBacklashDeg;
extern float g_tiltBacklashDeg;
extern float g_panKickDeg;
extern float g_tiltKickDeg;

struct BacklashState {
    bool started;
    float last;              // the last angle asked for
    float cmd;               // the angle commanded for it (without a kick)
    float out;               // where the servo is estimated to point: the target it last moved to
    int dir;                 // (backlashDeg < 0) the way the target last turned: +1, -1 (0: not yet)
    int cmdDir;              // the way the command last moved
    unsigned long movedMs;   // when the command last moved
    unsigned long kickUntilMs;
    int kickDir;             // 0: no kick going on
};
// The angle to command for angleDeg, given how the servo turned so far.
float servo_backlash_adjust(BacklashState *s, float angleDeg, float backlashDeg, float kickDeg, unsigned long nowMs);
// True (once) when a kick has ended and the command should be written again.
bool servo_kick_ended(BacklashState *s, unsigned long nowMs);
