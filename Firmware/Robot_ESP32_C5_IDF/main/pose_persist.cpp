#include "pose_persist.hpp"
#include "odometry.hpp"
#include "control_modes.hpp"

#include "esp_attr.h"
#include "esp_log.h"

#include <cmath>
#include <cstdint>
#include <cstring>

namespace {

constexpr uint32_t POSE_MAGIC = 0x9053E5A7;

struct RtcPose {
    uint32_t magic;
    float x_m;
    float y_m;
    float theta_rad;
    uint32_t check; // FNV-1a over the three floats, so a half-written or noise copy isn't taken
};

RTC_NOINIT_ATTR RtcPose g_rtcPose;

uint32_t checksum(float x, float y, float th) {
    float v[3] = {x, y, th};
    const uint8_t *b = reinterpret_cast<const uint8_t *>(v);
    uint32_t h = 2166136261u;
    for (size_t i = 0; i < sizeof(v); i++) h = (h ^ b[i]) * 16777619u;
    return h ^ POSE_MAGIC;
}

} // namespace

void pose_persist_save() {
    // (the checksum is written last: a restart halfway through leaves a copy that doesn't check)
    g_rtcPose.check = 0;
    g_rtcPose.x_m = poseX_m;
    g_rtcPose.y_m = poseY_m;
    g_rtcPose.theta_rad = poseThetaRad;
    g_rtcPose.magic = POSE_MAGIC;
    g_rtcPose.check = checksum(poseX_m, poseY_m, poseThetaRad);
}

bool pose_persist_restore() {
    const RtcPose p = g_rtcPose;
    bool ok = p.magic == POSE_MAGIC && p.check == checksum(p.x_m, p.y_m, p.theta_rad) && std::isfinite(p.x_m) &&
              std::isfinite(p.y_m) && std::isfinite(p.theta_rad) && std::fabs(p.x_m) < 1000.0f && std::fabs(p.y_m) < 1000.0f;
    if (!ok) {
        ESP_LOGI("pose", "No pose kept from before (power-on): starting at (0, 0, 0)");
        return false;
    }
    resetPoseTo(p.x_m, p.y_m, wrapToPi(p.theta_rad));
    controlFrameThetaRad = poseThetaRad; // (the pan servo starts centered: the camera looks along the chassis)
    ESP_LOGI("pose", "Pose kept from before the restart: x=%.3f y=%.3f theta=%.3f", poseX_m, poseY_m, poseThetaRad);
    return true;
}
