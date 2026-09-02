#pragma once

#include <cstdint>

// Ported from Robot_Pico2W_SDK/src/settings.hpp. Struct layout and every
// field name are kept identical -- app.js/cam.js reference these by name
// over /params and /set (once web_server.cpp exists), and control_modes.cpp
// (ported in milestone E) reads them directly. Only the storage backend
// changes: NVS (settings.cpp) instead of a raw littlefs file.

enum MODES {
    TOUCHPAD_CONTROL = 0,
    LAB1_FWD_REV,
    LAB2_PID_1M,
    CONTROL_FRAME_CONTROL,
    GOTO_POSITION_CONTROL,
    DEADZONE_CALIBRATION,
    MANUAL_VELOCITY_CONTROL,
    ENCODER_CALIBRATION
};
enum LOG_TYPES { LEFT_WHEEL = 0, BOTH_WHEELS };
enum LOG_UNIT { ENCODER_STEPS, WHEEL_RAD, WHEEL_DEG, WHEEL_REV, DISTANCE };
enum CONTROL_FRAME_ROTATION_STRATEGY { CONTROL_FRAME_ROTATION_CLOSEST_FACE = 0, CONTROL_FRAME_ROTATION_FIXED_HEMISPHERE };
enum CAMERA_JOYSTICK_CURVE { CAMERA_JOYSTICK_CURVE_LINEAR = 0, CAMERA_JOYSTICK_CURVE_QUADRATIC };

struct Settings {
    uint32_t settingsVersion;
    int mode;
    int logType;
    int logUnit;
    bool loggingEnabled;
    bool debugWeb;
    bool syncMotors;
    float dataLogRate;
    float kp, ki, kd;
    float differentiatorCutoffHz;
    int maxMotorPower;
    float wheelbaseMm;
    float wheelDiameterMm;
    float telemetryHz;
    float motorDeadzonePwm;
    float gotoSpeedGain;
    float maxWheelSpeedRevPerSec;
    float maxAccelRevPerSec2;
    float maxDecelRevPerSec2;
    float gotoVelKp;
    float gotoVelKi;
    float feedForwardPwmPerRevPerSec;
    bool gotoAllowReverse;
    bool gotoPreserveHeading;
    bool controlFrameAllowReverse;
    int controlFrameRotationStrategy;
    float servoMinPulseUs;
    float servoMaxPulseUs;
    float servoCenterPulseUs;
    // Angle 0 always means "camera facing the same direction as the
    // chassis" -- load-bearing beyond just the pulse mapping below,
    // since servoFollowControlFrame and the whole control-frame tracking
    // system (control_modes.cpp, ws_broadcast.cpp) assume it, so it's kept
    // fixed rather than made a calibration value like the endpoints below.
    // Most pan servos are 180 deg (-90..+90, the long-standing default) but
    // some are wider -- see computeServoPulseUs() in web_server.cpp.
    float servoMinAngleDeg;
    float servoMaxAngleDeg;
    bool servoFollowControlFrame;
    // The two below only take effect while servoFollowControlFrame is on --
    // they constrain the CHASSIS's own rotation, not the servo or the
    // control-frame reference (the rotate trackpad drives controlFrameThetaRad
    // directly, independent of both -- see control_modes.cpp).
    float servoMaxRotationRateDegPerSec; // caps chassis angular rate to what the physical RC servo can visually track while compensating
    float servoAssistMarginDeg; // chassis starts rotating to help the servo re-center once its needed angle is within this many degrees of +/-90
    // Camera control joystick feel (see the "Camera pan/tilt behaviour"
    // panel and setupCameraJoystick() in app.js) -- deliberately independent
    // of the chassis's own physical spin speed (controlFrameMaxRotateRateRadPerSec()
    // in control_modes.cpp, still used as-is for the base-assist ceiling in
    // applyServoTrackingConstraints()): this is the joystick's own
    // configured turn rate, meant to feel like a game controller's look
    // stick rather than "as fast as the hardware can physically go." The
    // curve applies to both axes (see app.js's applyJoystickCurve()) --
    // quadratic gives finer control near center while still reaching the
    // same max speed at full deflection, a common FPS camera-look feel.
    float panMaxSpeedDegPerSec;
    float tiltMaxSpeedDegPerSec;
    int cameraJoystickCurve;
    // Tilt servo (camera platform, TILT_SERVO_PIN). Same generalized min/max
    // angle range as the pan servo above (some tilt servos are 270 or even
    // 360 deg, not the usual 180), and angle 0 is likewise fixed as the
    // center-pulse reference point -- see computeTiltServoPulseUs() in
    // web_server.cpp. Tilt has no control-frame tracking coupling, but kept
    // fixed anyway for consistency with the pan servo's fields.
    float tiltMinPulseUs;
    float tiltMaxPulseUs;
    float tiltCenterPulseUs;
    float tiltMinAngleDeg;
    float tiltMaxAngleDeg;
    float cameraHeightMm;
    float cameraTiltDeg;
    float cameraVerticalFovDeg;
    char altSsid[100];
    char altPassword[100];
    // HTTP Basic Auth credentials guarding /update and /update-fs. Empty
    // otaPassword means auth is disabled (the pre-existing open behavior) --
    // see ota.cpp's ota_check_basic_auth().
    char otaUsername[32];
    char otaPassword[32];
    // Camera page's fireball/monster mini-game (see cam.js) -- purely
    // cosmetic, no effect on the robot itself, but configurable from the
    // Main page rather than hardcoded so the "feel" can be tuned without a
    // firmware change.
    float fireballSpeedMps;
    float monsterSpeedMps;
    int monsterCount;
    float monsterStandoffDistanceM; // where a monster settles once caught up -- directly in front of the camera
};

extern Settings settings;

void applyDefaultSettings();

// Persists/loads `settings` as a raw blob in NVS (namespace "robot", key
// "settings"), version-checked via Settings::settingsVersion -- same
// contract as the Pico version's littlefs file, just a different backend.
bool saveSettings();
bool loadSettings();
