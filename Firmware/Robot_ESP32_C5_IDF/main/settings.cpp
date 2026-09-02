#include "settings.hpp"

#include "nvs.h"
#include "esp_log.h"

#include <cstring>

// Ported from Robot_Pico2W_SDK/src/settings.cpp. applyDefaultSettings() is
// unchanged field-for-field. saveSettings()/loadSettings() are rewritten on
// NVS (namespace "robot", key "settings") instead of a raw byte-dump to
// littlefs's /settings.dat -- no flash_safe_execute()/multicore_lockout
// equivalent is needed here, NVS handles its own cache-disable window
// internally without needing the caller to pause anything.

namespace {

// Bumped from the Pico firmware's 16: struct padding and int/bool layout
// differ between arm-none-eabi and xtensa-esp32s3-elf, so the first ESP32
// boot must fall through to applyDefaultSettings() rather than reinterpret
// a Pico-era (or previous-ESP32-build) blob of a different layout.
// 17: ESP32-S3 port -- struct layout/ABI change.
// 18: added servoMaxRotationRateDegPerSec, servoAssistMarginDeg.
// 19: added otaUsername, otaPassword.
// 20: added tiltMinPulseUs, tiltMaxPulseUs, tiltCenterPulseUs,
//     tiltMinAngleDeg, tiltZeroAngleDeg, tiltMaxAngleDeg.
// 21: added servoMinAngleDeg, servoMaxAngleDeg; dropped tiltZeroAngleDeg
//     (angle 0 is fixed as the center-pulse reference for both servos now).
// 22: added panMaxSpeedDegPerSec, tiltMaxSpeedDegPerSec, cameraJoystickCurve.
// 23: added webcamAddress, webcamStreamModeMjpeg, s3camAddress (moved off
//     browser localStorage so every device sees the same camera config).
// 24: ESP32-C5 port -- struct layout/ABI can differ between xtensa-esp32s3-elf
//     and riscv32-esp-elf (padding/alignment rules aren't guaranteed
//     identical), so the first C5 boot must fall through to
//     applyDefaultSettings() rather than reinterpret an S3-era blob.
// 25: dropped webcamAddress, webcamStreamModeMjpeg -- the "IP Webcam" panel
//     (built for a phone running the IP Webcam Android app) was removed;
//     this robot only ever streams from its own S3 CAM (s3camAddress).
// 26: dropped s3camAddress -- the S3 CAM's IP never needs to be entered or
//     persisted at all: the C5 already learns it live over the UART link
//     (uart_link.cpp) the moment the cam starts sending its status line, so
//     /camdiag's own reported ip is now the sole source of truth everywhere
//     (Main page's "Open cam page" link, cam.js's stream/settings link).
// 27: added fireballSpeedMps, monsterSpeedMps, monsterCount,
//     monsterStandoffDistanceM (Camera page's fireball/monster mini-game,
//     now configurable from the Main page's "Game settings" panel instead
//     of hardcoded in cam.js).
constexpr uint32_t SETTINGS_VERSION = 27;
constexpr const char *NVS_NAMESPACE = "robot";
constexpr const char *NVS_KEY = "settings";

const char *TAG = "settings";

} // namespace

Settings settings;

void applyDefaultSettings() {
    settings.settingsVersion = SETTINGS_VERSION;
    settings.mode = TOUCHPAD_CONTROL;
    settings.logType = LEFT_WHEEL;
    settings.logUnit = ENCODER_STEPS;
    settings.loggingEnabled = false;
    settings.debugWeb = true;
    settings.syncMotors = false;
    settings.dataLogRate = 100;
    settings.kp = 200.0f;
    settings.ki = 0.0f;
    settings.kd = 0.0f;
    settings.differentiatorCutoffHz = 20;
    settings.maxMotorPower = 1000;
    settings.wheelbaseMm = 170.0f; // measured on this chassis
    settings.wheelDiameterMm = 71.5f; // measured on this chassis
    settings.telemetryHz = 10.0f;
    settings.motorDeadzonePwm = 300.0f;
    settings.gotoSpeedGain = 10.0f;
    settings.maxWheelSpeedRevPerSec = 1.8f;
    settings.maxAccelRevPerSec2 = 5.0f;
    settings.maxDecelRevPerSec2 = 5.0f;
    settings.gotoVelKp = 1500.0f;
    settings.gotoVelKi = 1000.0f;
    settings.feedForwardPwmPerRevPerSec = 0.53f;
    settings.gotoAllowReverse = true;
    settings.gotoPreserveHeading = false; // opt-in, preserves today's behavior until turned on
    settings.controlFrameAllowReverse = true;
    settings.controlFrameRotationStrategy = CONTROL_FRAME_ROTATION_FIXED_HEMISPHERE;
    settings.servoMinPulseUs = 530.0f; // measured on this robot's actual pan servo
    settings.servoMaxPulseUs = 2410.0f;
    settings.servoCenterPulseUs = 1465.0f;
    settings.servoMinAngleDeg = -90.0f; // most hobby servos are 180 deg -- adjust for 270/360 deg servos
    settings.servoMaxAngleDeg = 90.0f;
    settings.servoFollowControlFrame = true;
    settings.servoMaxRotationRateDegPerSec = 270.0f; // approximate RC servo speed rating; user calibrates later
    settings.servoAssistMarginDeg = 45.0f;
    settings.panMaxSpeedDegPerSec = 180.0f; // game-controller-like look speed, not the chassis's physical max
    settings.tiltMaxSpeedDegPerSec = 120.0f;
    settings.cameraJoystickCurve = CAMERA_JOYSTICK_CURVE_QUADRATIC; // gentler near center for fine aiming, user's preferred feel
    // Measured on this robot's actual tilt servo -- min/max are inverted
    // relative to the pan servo's (min > max) because this servo horn is
    // mounted in the opposite rotational sense.
    settings.tiltMinPulseUs = 2250.0f;
    settings.tiltMaxPulseUs = 550.0f;
    settings.tiltCenterPulseUs = 1370.0f;
    settings.tiltMinAngleDeg = -90.0f; // most hobby servos are 180 deg -- adjust for 270/360 deg servos
    settings.tiltMaxAngleDeg = 90.0f;
    settings.cameraHeightMm = 100.0f; // measured on this robot's actual camera mount
    settings.cameraTiltDeg = 0.0f;
    settings.cameraVerticalFovDeg = 65.0f; // measured on this robot's actual camera -- notably wider than a typical ~42deg default
    settings.altSsid[0] = '\0';
    settings.altPassword[0] = '\0';
    std::strncpy(settings.otaUsername, "admin", sizeof(settings.otaUsername) - 1);
    settings.otaUsername[sizeof(settings.otaUsername) - 1] = '\0';
    settings.otaPassword[0] = '\0'; // empty = auth disabled until the user sets one
    settings.fireballSpeedMps = 0.5f;
    settings.monsterSpeedMps = 0.1f;
    settings.monsterCount = 2;
    settings.monsterStandoffDistanceM = 0.2f;
}

bool saveSettings() {
    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "nvs_open (RW) failed: %s", esp_err_to_name(err));
        return false;
    }

    err = nvs_set_blob(handle, NVS_KEY, &settings, sizeof(Settings));
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "settings save failed: %s", esp_err_to_name(err));
        return false;
    }
    ESP_LOGI(TAG, "Settings saved (%u bytes).", (unsigned) sizeof(Settings));
    return true;
}

bool loadSettings() {
    nvs_handle_t handle;
    esp_err_t err = nvs_open(NVS_NAMESPACE, NVS_READONLY, &handle);
    if (err != ESP_OK) {
        // ESP_ERR_NVS_NOT_FOUND on a genuinely first boot -- the "robot"
        // namespace doesn't exist yet. Not an error, just means defaults.
        ESP_LOGI(TAG, "no saved settings yet (%s)", esp_err_to_name(err));
        return false;
    }

    Settings loaded;
    size_t len = sizeof(Settings);
    err = nvs_get_blob(handle, NVS_KEY, &loaded, &len);
    nvs_close(handle);

    if (err != ESP_OK) {
        ESP_LOGI(TAG, "no saved settings yet (%s)", esp_err_to_name(err));
        return false;
    }
    if (len != sizeof(Settings)) {
        ESP_LOGW(TAG, "settings blob size mismatch (found %u, expected %u), ignoring",
                 (unsigned) len, (unsigned) sizeof(Settings));
        return false;
    }
    if (loaded.settingsVersion != SETTINGS_VERSION) {
        ESP_LOGW(TAG, "settings version mismatch (found %lu, expected %lu), ignoring",
                 (unsigned long) loaded.settingsVersion, (unsigned long) SETTINGS_VERSION);
        return false;
    }

    settings = loaded;
    ESP_LOGI(TAG, "Settings loaded.");
    return true;
}
