#pragma once

// Ported verbatim from Robot_Pico2W_SDK/src/odometry.hpp -- pure math, zero
// platform dependencies, so nothing changes for the ESP32 port.

extern float poseX_m;
extern float poseY_m;
extern float poseThetaRad;

// Guards against a single noisy encoder tick poisoning the pose with NaN --
// kept even though the ESP32's PCNT glitch filter should make spurious
// single-tick spikes rarer than the Pico's GPIO-IRQ decoding did.
constexpr long MAX_PLAUSIBLE_ENCODER_DELTA_PER_TICK = 500;

float wrapToPi(float angle);

void updateOdometry(long dEncoderLeft, long dEncoderRight, float wheelRadius_m, float wheelbaseMm,
                     int transmissionRatio, int countsPerRevolution);

void resetPoseTo(float x, float y, float theta);

// Row-major 3x3 SE(2) transform (rotation + translation), for the Camera
// page's floor-grid overlay.
void getPoseMatrix(float m[9]);
