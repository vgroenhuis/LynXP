#include "odometry.hpp"

#include <cmath>

// Ported verbatim from Robot_Pico2W_SDK/src/odometry.cpp.

float poseX_m = 0.0f;
float poseY_m = 0.0f;
float poseThetaRad = 0.0f;

float wrapToPi(float angle) {
    return std::atan2(std::sin(angle), std::cos(angle));
}

void updateOdometry(long dEncoderLeft, long dEncoderRight, float wheelRadius_m, float wheelbaseMm,
                     int transmissionRatio, int countsPerRevolution) {
    if (std::abs(dEncoderLeft) > MAX_PLAUSIBLE_ENCODER_DELTA_PER_TICK ||
        std::abs(dEncoderRight) > MAX_PLAUSIBLE_ENCODER_DELTA_PER_TICK) {
        return;
    }

    float dPhiLeft = 2 * (float) M_PI * dEncoderLeft / (transmissionRatio * countsPerRevolution);
    float dPhiRight = 2 * (float) M_PI * dEncoderRight / (transmissionRatio * countsPerRevolution);

    float dLeft = dPhiLeft * wheelRadius_m;
    float dRight = dPhiRight * wheelRadius_m;

    float dCenter = (dLeft + dRight) / 2.0f;
    float dTheta = (dRight - dLeft) / (wheelbaseMm / 1000.0f);

    if (std::isnan(dTheta) || std::isinf(dTheta) || std::isnan(dCenter) || std::isinf(dCenter)) {
        return;
    }

    float thetaMid = poseThetaRad + dTheta / 2.0f;
    poseX_m += dCenter * std::cos(thetaMid);
    poseY_m += dCenter * std::sin(thetaMid);
    poseThetaRad = wrapToPi(poseThetaRad + dTheta);
}

void resetPoseTo(float x, float y, float theta) {
    poseX_m = x;
    poseY_m = y;
    poseThetaRad = theta;
}

void getPoseMatrix(float m[9]) {
    float c = std::cos(poseThetaRad);
    float s = std::sin(poseThetaRad);
    m[0] = c;  m[1] = -s; m[2] = poseX_m;
    m[3] = s;  m[4] = c;  m[5] = poseY_m;
    m[6] = 0;  m[7] = 0;  m[8] = 1;
}
