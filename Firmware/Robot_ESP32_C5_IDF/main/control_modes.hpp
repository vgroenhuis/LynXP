#pragma once

// Ported from Robot_Pico2W_SDK/src/control_modes.hpp -- declarations and
// constants unchanged (this is the shared state web_server.cpp will also
// reference once it exists). Only Arduino/Pico-SDK idiom swaps in the .cpp
// (millis_now() -> esp_timer_get_time()/1000, etc.); the control algorithms
// themselves are unchanged.

// -- Joystick / control-frame state --
extern float V1[2];
extern float controlJoyX;
extern float controlJoyY;
extern float controlFrameThetaRad;
// Signed drag fraction in [-1, 1] from the X axis of the camera control
// joystick (web UI) -- positive = CCW, matching updateOdometry()'s dTheta
// sign convention. Resent continuously (~25Hz) while held, same pattern as
// controlJoyX/controlJoyY. The poll task runs this through
// applyJoystickCurve() (settings.cameraJoystickCurve) and scales it by
// settings.panMaxSpeedDegPerSec to integrate controlFrameThetaRad -- a
// configured "joystick feel" rate, deliberately independent of the
// chassis's physical spin capability (controlFrameMaxRotateRateRadPerSec()
// below, still used as-is for the base-assist ceiling).
extern float controlFrameRotateInput;
constexpr float CONTROL_FRAME_ROTATE_DEADZONE = 0.03f; // ignores near-center touch/mouse noise

// Applies settings.cameraJoystickCurve to a raw signed joystick deflection
// fraction in [-1, 1] (linear: unchanged; quadratic: sign(value)*value^2,
// same max but gentler near center -- a common FPS camera-look feel).
// Shared by the pan (control-frame rotate) and tilt rate integrations in
// ws_broadcast.cpp, and by applyServoTrackingConstraints() below, which
// needs to know the REAL currently-commanded pan rate (after the curve) to
// compute how much the chassis needs to help.
float applyJoystickCurve(float value);

// -- Click-to-navigate target (world coordinates) --
extern float goalX_m;
extern float goalY_m;
extern float goalHeadingRad; // only meaningful when goalHasHeading is true
extern bool goalHasHeading; // set by waypoint goto; plain map-click goto leaves this false
extern bool goalMaintainSpeed; // set by waypoint auto-advance: skip the distance-proportional slowdown, since the client will re-target before precise stopping matters

// -- Actual wheel telemetry, live regardless of mode --
extern float wheelPosRev[2];
extern float wheelVelRevPerSec[2];
extern int motorPowerPwm[2];

// -- Goto controller (two-stage) state --
extern float gotoWheelVelSetpointRevPerSec[2];
extern float gotoWheelPosSetpointRev[2];
extern float gotoTargetHeadingRad;
extern bool gotoControllerNeedsInitFlag;
extern float gotoFfPwm[2];
extern float gotoPPwm[2];
extern float gotoIPwm[2];
extern float manualVelSetpointRevPerSec[2];
extern bool gotoDiagnosticsEnabled;

// -- Lab1 / Lab2 state --
extern unsigned long lab1StartTimeMs;
extern bool lab1Forward;
extern float lab2SetpointM[2];
extern bool setSetpointToCurrentPosFlag;
constexpr float LAB2_TURN_ANGLE_RAD = 3.14159265358979323846f / 2.0f;

// -- Cross-task one-shot flags --
extern bool resetEncodersFlag;
extern bool resetPoseFlag;
extern float resetPoseX_m;
extern float resetPoseY_m;
extern float resetPoseTheta_rad;

// -- Motor deadzone calibration --
extern bool startDeadzoneCalibrationFlag;
extern bool deadzoneCalibrationActive;
extern int deadzoneCalibrationPwm;

// -- Encoder count-per-revolution verification: spins one wheel a fixed,
// nominal number of revolutions (per the hardcoded MOTOR_TRANSMISSION_RATIO/
// ENCODER_COUNTS_PER_REVOLUTION in board_pins.hpp) at a slow, easy-to-count
// speed, so the operator can visually confirm it's really a whole number of
// physical turns -- not an auto-correcting calibration, just a verification
// aid for those hardcoded constants. --
extern bool startEncoderCalibrationFlag;
extern int encoderCalibrationWheel; // 0 = left, 1 = right
extern bool encoderCalibrationActive;
extern float encoderCalibrationRevsDone; // progress, for telemetry

// deadzoneCalibrationControl() runs on the control task, but saveSettings()
// (an NVS commit) should not run there -- it stalls the flash cache on both
// cores for a few ms, which the 1 kHz loop shouldn't eat inside its own
// tick. The control task sets this flag instead; a lower-priority task
// (added once web_server.cpp's poll loop exists) checks it and calls
// saveSettings() from there. Until that task exists, nothing consumes this
// flag yet -- deadzone calibration still updates settings.motorDeadzonePwm
// in RAM correctly, it just isn't auto-persisted until milestone D.
extern volatile bool settingsSaveRequestedFlag;

float wheelRadiusMeters();

// Fastest the chassis can physically spin in place (rad/s): both wheels at
// settings.maxWheelSpeedRevPerSec in opposite directions. Recomputed from
// live settings (wheelbase, wheel diameter, max wheel speed) rather than a
// fixed constant, so it tracks calibration automatically -- see the rotate
// trackpad's doc comment on controlFrameRotateInput above.
float controlFrameMaxRotateRateRadPerSec();

void remoteControlMotors();
void driveTowardWorldDirection(float worldDirX, float worldDirY);
void controlFrameJoystickControl();
void updateWheelActualTelemetry();

// Only active while settings.servoFollowControlFrame is on. Rebalances
// targetVelRevPerSec[2] (preserving its average/translation component) so
// the chassis's own rotation rate never asks the pan-servo to visually
// track faster than settings.servoMaxRotationRateDegPerSec. Also, but ONLY
// while the user is actively dragging the rotate trackpad
// (|controlFrameRotateInput| > CONTROL_FRAME_ROTATE_DEADZONE) -- since the
// chassis can physically spin faster than the servo can pan -- blends in
// two forms of assist: (1) whenever the trackpad commands a reference
// rotation rate beyond what the servo alone can track, the chassis
// immediately picks up the excess; (2) as a fallback for the brief spin-up
// lag from the chassis's own accel/decel limits, the chassis also ramps in
// rotation -- up to its own full physical spin speed, NOT the servo's
// slower rate -- as the servo's unclamped needed angle nears its +/-90 deg
// endstop. Both are gated on the trackpad specifically so neither fights an
// ordinary control-frame joystick drive command (e.g. sustained sideways
// translation runs at a large, steady heading difference by itself -- the
// assist must stay quiet through that, or the base would auto-rotate out
// from under the driver).
// Deliberately NOT called from manualVelocityControl(),
// deadzoneCalibrationControl(), encoderCalibrationControl(),
// lab1ForwardControl(), or lab2FeedbackControl() -- those aren't
// camera-following drive modes. The rotate trackpad's own code path (see
// ws_broadcast.cpp) never calls this function or touches wheel velocities
// directly -- it only advances controlFrameThetaRad and lets the control
// task's calls into this function (from the three drive functions above)
// react to controlFrameRotateInput on their own.
void applyServoTrackingConstraints(float targetVelRevPerSec[2]);

void computeGotoTargetWheelVelocities(float targetVelRevPerSec[2], float *targetHeadingRad);
void rateLimitVelocitySetpoint(float target, float &setpoint, float dt);
void gotoVelocityTrackingControl(float targetVelRevPerSec[2]);
void gotoPositionControl();
void manualVelocityControl();

void deadzoneCalibrationControl();
void encoderCalibrationControl();
void lab1ForwardControl();
void lab2FeedbackControl();
void applyLab2Turn(bool turnLeft);
void calcEncoderDerivatives();

// Switches settings.mode only if it actually differs (avoids redundant
// flash writes and redundant Lab2 setpoint-snap resets -- joystick messages
// arrive at ~25Hz once the WebSocket layer exists).
void switchModeIfNeeded(int newMode);

// Called by every reset button: zeroes every real-time drive setpoint and
// forces TOUCHPAD_CONTROL so the robot can't keep chasing a now-stale
// goal/heading/velocity regardless of which mode it was previously in.
void stopAllMotion();

// Runs the full mode dispatch + telemetry/odometry update for one 1kHz
// control tick, matching Robot_Pico2W_SDK's mainTask() body. Called from
// control_task.cpp's control task loop.
void controlModesTick();
