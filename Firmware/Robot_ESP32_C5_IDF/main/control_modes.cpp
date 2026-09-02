#include "control_modes.hpp"

#include "settings.hpp"
#include "odometry.hpp"
#include "board_pins.hpp"
#include "control_task.hpp"
#include "breadcrumb.hpp"
#include "log_task.hpp"

#include "esp_timer.h"

#include <cmath>
#include <cstdio>
#include <algorithm>

// Ported from Robot_Pico2W_SDK/src/control_modes.cpp. Every algorithm is
// unchanged -- only the platform substitutions noted inline (millis_now(),
// the logging block's printf -> log_task_submit(), and the header set
// above) differ from the source.

float V1[2] = {0, 0};
float controlJoyX = 0;
float controlJoyY = 0;
float controlFrameThetaRad = 0.0f;
float controlFrameRotateInput = 0.0f;

float goalX_m = 0.0f;
float goalY_m = 0.0f;
float goalHeadingRad = 0.0f;
bool goalHasHeading = false;
bool goalMaintainSpeed = false;

float wheelPosRev[2] = {0, 0};
float wheelVelRevPerSec[2] = {0, 0};
int motorPowerPwm[2] = {0, 0};

float gotoWheelVelSetpointRevPerSec[2] = {0, 0};
float gotoWheelPosSetpointRev[2] = {0, 0};
float gotoTargetHeadingRad = 0.0f;
bool gotoControllerNeedsInitFlag = false;
float gotoFfPwm[2] = {0, 0};
float gotoPPwm[2] = {0, 0};
float gotoIPwm[2] = {0, 0};
float manualVelSetpointRevPerSec[2] = {0, 0};
bool gotoDiagnosticsEnabled = false;

unsigned long lab1StartTimeMs = 0;
bool lab1Forward = true;
float lab2SetpointM[2] = {0.0, 0.0};
bool setSetpointToCurrentPosFlag = false;

bool resetEncodersFlag = false;
bool resetPoseFlag = false;
float resetPoseX_m = 0.0f;
float resetPoseY_m = 0.0f;
float resetPoseTheta_rad = 0.0f;

bool startDeadzoneCalibrationFlag = false;
bool deadzoneCalibrationActive = false;
int deadzoneCalibrationPwm = 0;
volatile bool settingsSaveRequestedFlag = false;

bool startEncoderCalibrationFlag = false;
int encoderCalibrationWheel = 0;
bool encoderCalibrationActive = false;
float encoderCalibrationRevsDone = 0.0f;

namespace {
unsigned long millis_now() { return (unsigned long) (esp_timer_get_time() / 1000); }
constexpr float GOTO_ARRIVAL_TOLERANCE_M = 0.03f;
constexpr float GOTO_HEADING_ARRIVAL_TOLERANCE_RAD = 3.0f * (float) M_PI / 180.0f; // ~3 degrees
constexpr float GOTO_HEADING_ROTATE_KP = 1.0f;
constexpr float GOTO_HEADING_ROTATE_MAX_FRACTION = 0.4f; // cap well below full speed -- final adjustment, not the main move
// Floor + tie-break for the in-place turn-toward-target branch below: as the
// target approaches directly behind the robot (180 deg off), the turn
// command's magnitude (proportional to sin of the angle) vanishes toward
// zero right as its sign becomes numerically unreliable -- without a floor,
// the robot commands an ever-shrinking turn that ends up below the motor
// deadzone and never actually turns at all.
constexpr float GOTO_INPLACE_TURN_MIN_FRACTION = 0.15f;
constexpr float GOTO_INPLACE_TURN_SIGN_DEADBAND = 0.02f;
constexpr unsigned long DEADZONE_RAMP_INTERVAL_MS = 20;
constexpr long DEADZONE_CALIBRATION_ENCODER_THRESHOLD = 20;
constexpr float ENCODER_CALIBRATION_TARGET_REVS = 10.0f;
constexpr float ENCODER_CALIBRATION_SPEED_REV_PER_SEC = 0.3f; // slow enough to count turns by eye
} // namespace

float wheelRadiusMeters() {
    return (settings.wheelDiameterMm / 1000.0f) / 2.0f;
}

// Fastest the chassis can physically spin in place: both wheels at
// settings.maxWheelSpeedRevPerSec in opposite directions, i.e.
// (vRight-vLeft)/wheelbase with vRight=+vMax, vLeft=-vMax -- the same
// (vRight-vLeft)/wheelbase convention updateOdometry() uses for dTheta.
// Recomputed from live settings rather than a fixed constant so it tracks
// wheelbase/wheel-diameter/max-speed calibration automatically.
float controlFrameMaxRotateRateRadPerSec() {
    float wheelbase_m = settings.wheelbaseMm / 1000.0f;
    if (wheelbase_m <= 0.0f) {
        return 0.0f;
    }
    float wheelCircumference_m = 2.0f * (float) M_PI * wheelRadiusMeters();
    float vMax_mps = settings.maxWheelSpeedRevPerSec * wheelCircumference_m;
    return 2.0f * vMax_mps / wheelbase_m;
}

float applyJoystickCurve(float value) {
    if (settings.cameraJoystickCurve == CAMERA_JOYSTICK_CURVE_QUADRATIC) {
        return std::copysign(value * value, value);
    }
    return value;
}

// Joystick input is converted to a target wheel VELOCITY (rev/s) and handed
// to gotoVelocityTrackingControl() -- the same rate-limited (maxAccelRevPerSec2/
// maxDecelRevPerSec2) feed-forward+PI pipeline the goto/manual-velocity
// controllers use -- rather than mapping joystick position straight to PWM.
// A direct PWM jump (e.g. slamming the joystick to full deflection, or
// releasing it from full speed) can spin the wheels faster than the robot
// can actually accelerate/decelerate, causing slip that the encoder-based
// odometry has no way to detect or correct for. Velocity is approximately
// proportional to PWM anyway, so this costs essentially nothing in feel
// while reusing an already-tuned, already-tested rate limiter instead of
// adding a second one.
void remoteControlMotors() {
    float targetVelRevPerSec[2];
    for (int wheel = 0; wheel < 2; wheel++) {
        targetVelRevPerSec[wheel] = std::clamp(V1[wheel], -1.0f, 1.0f) * settings.maxWheelSpeedRevPerSec;
    }
    applyServoTrackingConstraints(targetVelRevPerSec);
    gotoVelocityTrackingControl(targetVelRevPerSec);
}

// Field-oriented drive toward a WORLD-frame direction vector (not
// necessarily unit length, but within [-1,1] per component), for the
// control-frame joystick. See remoteControlMotors()'s comment for why this
// targets a velocity through gotoVelocityTrackingControl() rather than PWM
// directly.
//
// settings.controlFrameRotationStrategy picks which chassis face (front or
// back) gets driven toward worldDir -- see its own doc comment in
// settings.hpp for the two strategies and why FIXED_HEMISPHERE exists
// (keeping a front-mounted pan-servo camera, servoFollowControlFrame, able
// to track the control frame's forward direction without ever needing more
// than a 90 deg pan). Either way, `forward`/`left` themselves stay
// chassis-relative (computed from poseThetaRad) since those are what
// actually drive the wheels correctly for the chassis's real current
// orientation -- only which face the strategy AIMS for differs; the
// forward/left mixing below converges the chassis to match on its own,
// same as it already does every tick regardless of strategy.
void driveTowardWorldDirection(float worldDirX, float worldDirY) {
    float theta = poseThetaRad;
    float forward = worldDirX * std::cos(theta) + worldDirY * std::sin(theta);
    float left = -worldDirX * std::sin(theta) + worldDirY * std::cos(theta);

    bool driveForward;
    if (settings.controlFrameRotationStrategy == CONTROL_FRAME_ROTATION_FIXED_HEMISPHERE) {
        float ctForward = worldDirX * std::cos(controlFrameThetaRad) + worldDirY * std::sin(controlFrameThetaRad);
        driveForward = ctForward >= 0;
    } else {
        driveForward = forward >= 0;
    }

    if (driveForward) {
        V1[0] = forward - left;
        V1[1] = forward + left;
    } else if (!settings.controlFrameAllowReverse) {
        // controlFrameAllowReverse is its own setting, independent of
        // gotoAllowReverse -- this function is only ever reached from the
        // control-frame joystick, never the position controller (which
        // duplicates this same rotation logic itself, see
        // computeGotoTargetWheelVelocities()'s own comment on why). Same
        // in-place-turn approach, and the same magnitude floor + latched
        // sign to avoid the direction command vanishing right as the
        // commanded direction crosses due-behind (see
        // GOTO_INPLACE_TURN_MIN_FRACTION's doc comment) -- a human at the
        // joystick would likely just wiggle it and move on, but there's no
        // reason not to keep the same robustness here too.
        static float lastTurnSign = 1.0f;
        float turnMag = std::fabs(left);
        float turnSign;
        if (turnMag > GOTO_INPLACE_TURN_SIGN_DEADBAND) {
            turnSign = (left > 0) ? 1.0f : -1.0f;
            lastTurnSign = turnSign;
        } else {
            turnSign = lastTurnSign;
        }
        float rotFrac = turnSign * std::fmax(turnMag, GOTO_INPLACE_TURN_MIN_FRACTION);
        V1[0] = -rotFrac;
        V1[1] = rotFrac;
    } else {
        V1[0] = forward + left;
        V1[1] = forward - left;
    }
    float targetVelRevPerSec[2];
    for (int wheel = 0; wheel < 2; wheel++) {
        targetVelRevPerSec[wheel] = std::clamp(V1[wheel], -1.0f, 1.0f) * settings.maxWheelSpeedRevPerSec;
    }
    applyServoTrackingConstraints(targetVelRevPerSec);
    gotoVelocityTrackingControl(targetVelRevPerSec);
}

// See the doc comment in control_modes.hpp. Rebalances a target wheel
// velocity pair around its own average so the chassis's rotation rate
// (derived the same way updateOdometry() derives dTheta: (vRight-vLeft) /
// wheelbase) stays within what the physical servo can visually track, and
// (while the rotate trackpad is held) proactively adds chassis rotation to
// cover whatever the servo can't keep up with on its own.
void applyServoTrackingConstraints(float targetVelRevPerSec[2]) {
    if (!settings.servoFollowControlFrame) {
        return;
    }

    float wheelbase_m = settings.wheelbaseMm / 1000.0f;
    float wheelCircumference_m = 2.0f * (float) M_PI * wheelRadiusMeters();
    if (wheelbase_m <= 0.0f || wheelCircumference_m <= 0.0f) {
        return;
    }

    float vLeft = targetVelRevPerSec[0] * wheelCircumference_m;
    float vRight = targetVelRevPerSec[1] * wheelCircumference_m;
    float avgVel = (vLeft + vRight) / 2.0f;
    float chassisOmega = (vRight - vLeft) / wheelbase_m; // rad/s, same sign convention as updateOdometry()'s dTheta

    float maxOmega = settings.servoMaxRotationRateDegPerSec * (float) M_PI / 180.0f;

    // 1. Cap the chassis's own rotation rate to what the servo can track.
    if (std::fabs(chassisOmega) > maxOmega) {
        chassisOmega = std::copysign(maxOmega, chassisOmega);
    }

    // Both assist mechanisms below are gated on the rotate trackpad being
    // actively dragged (past its deadzone) -- i.e. only while the user is
    // actively pushing controlFrameThetaRad -- so neither ever fights an
    // ordinary control-frame joystick drive command. Without this gate,
    // commanding sustained sideways translation (which inherently runs the
    // chassis at a large, steady headingDiff relative to the control frame)
    // would trip the assist and have the base auto-rotate out from under
    // the driver instead of strafing as commanded.
    bool rotateActive = std::fabs(controlFrameRotateInput) > CONTROL_FRAME_ROTATE_DEADZONE;
    float assistOmega = 0.0f;

    // 2. Speed-based assist: the chassis can physically spin faster than
    // the servo can visually pan (controlFrameMaxRotateRateRadPerSec() vs
    // settings.servoMaxRotationRateDegPerSec/maxOmega here). Whenever the
    // trackpad commands a reference-frame rotation rate beyond what the
    // servo alone can track, the chassis immediately picks up exactly the
    // excess, so the RESIDUAL heading-diff rate of change stays within what
    // the servo can keep pace with, instead of racing straight to the
    // +/-90 endstop on every fast drag and then just sitting there.
    if (rotateActive) {
        // Must match the REAL formula ws_broadcast.cpp integrates
        // controlFrameThetaRad with (curve + settings.panMaxSpeedDegPerSec,
        // the joystick's own configured rate -- not the chassis's physical
        // max), or this would over/under-estimate how fast the reference is
        // actually being pushed.
        float commandedOmega = applyJoystickCurve(controlFrameRotateInput) * (settings.panMaxSpeedDegPerSec * (float) M_PI / 180.0f);
        if (commandedOmega > maxOmega) {
            assistOmega = commandedOmega - maxOmega;
        } else if (commandedOmega < -maxOmega) {
            assistOmega = commandedOmega + maxOmega;
        }
    }

    // 3. Proximity fallback: in case the speed-based assist above still
    // isn't enough (e.g. the chassis's own accel/decel limits mean it can't
    // spin up to speed instantly), also ramp in assist as the servo's
    // unclamped needed angle nears its +/-90 deg endstop, from none at the
    // margin threshold up to the chassis's own full physical spin speed
    // right at the endstop -- NOT capped at maxOmega (the servo's rate).
    // Capping this ramp at the servo's rate would defeat the entire point:
    // right at the endstop the servo genuinely cannot help anymore, so this
    // is exactly the situation where the chassis needs to use everything
    // it's physically got, not just match the servo's slower pace. Without
    // this, sustained rotation at/near max trackpad deflection lets
    // headingDiff creep past 90 deg indefinitely (the chassis can never
    // quite catch up), eventually wrapping past +/-180 into a sudden flip
    // to the opposite sign, and leaves a large hidden offset that only
    // surfaces later as a surprise chassis lurch once ordinary driving
    // resumes and the true heading error is revealed.
    if (rotateActive) {
        float headingDiffDeg = wrapToPi(controlFrameThetaRad - poseThetaRad) * 180.0f / (float) M_PI;
        float assistThresholdDeg = 90.0f - settings.servoAssistMarginDeg;
        float overshootDeg = std::fabs(headingDiffDeg) - assistThresholdDeg;
        if (overshootDeg > 0.0f) {
            float marginDeg = std::fmax(settings.servoAssistMarginDeg, 1.0f);
            float marginFraction = std::clamp(overshootDeg / marginDeg, 0.0f, 1.0f);
            float marginOmega = marginFraction * controlFrameMaxRotateRateRadPerSec();
            // Increasing poseThetaRad (positive chassisOmega) decreases a
            // positive headingDiff (and vice versa) -- same sign relation
            // ws_broadcast.cpp's servo-follow math uses.
            float marginOmegaSigned = (headingDiffDeg > 0.0f) ? marginOmega : -marginOmega;
            if (std::fabs(marginOmegaSigned) > std::fabs(assistOmega)) {
                assistOmega = marginOmegaSigned;
            }
        }
    }

    if (assistOmega != 0.0f) {
        bool sameSign = (chassisOmega >= 0.0f) == (assistOmega >= 0.0f);
        if (!sameSign || std::fabs(chassisOmega) < std::fabs(assistOmega)) {
            chassisOmega = assistOmega;
        }
    }

    float newDiff = chassisOmega * wheelbase_m;
    targetVelRevPerSec[0] = (avgVel - newDiff / 2.0f) / wheelCircumference_m;
    targetVelRevPerSec[1] = (avgVel + newDiff / 2.0f) / wheelCircumference_m;

    // Re-normalize (preserving the rotation/translation ratio, same
    // approach as computeGotoTargetWheelVelocities()'s maxWheelFrac clamp)
    // in case the assist term pushed either wheel's target past the
    // configured max -- the assist should help the camera catch up, not
    // demand more speed than the robot is otherwise allowed.
    float maxMagRevPerSec = std::fmax(std::fabs(targetVelRevPerSec[0]), std::fabs(targetVelRevPerSec[1]));
    if (maxMagRevPerSec > settings.maxWheelSpeedRevPerSec && maxMagRevPerSec > 0.0f) {
        float scale = settings.maxWheelSpeedRevPerSec / maxMagRevPerSec;
        targetVelRevPerSec[0] *= scale;
        targetVelRevPerSec[1] *= scale;
    }
}

void controlFrameJoystickControl() {
    float ct = controlFrameThetaRad;
    float worldJoyX = controlJoyX * std::cos(ct) - controlJoyY * std::sin(ct);
    float worldJoyY = controlJoyX * std::sin(ct) + controlJoyY * std::cos(ct);
    driveTowardWorldDirection(worldJoyX, worldJoyY);
}

void updateWheelActualTelemetry() {
    float countsPerRev = MOTOR_TRANSMISSION_RATIO * ENCODER_COUNTS_PER_REVOLUTION;
    for (int wheel = 0; wheel < 2; wheel++) {
        wheelPosRev[wheel] = encoderCount_steps[wheel] / countsPerRev;
        wheelVelRevPerSec[wheel] = encoderCountDerivative_steps[wheel] / countsPerRev;
    }
}

// Stage 1: given the current pose and (goalX_m, goalY_m), determine target
// wheel velocities (rev/s). Deliberately duplicates
// driveTowardWorldDirection()'s rotation + "closer face" branch (scaled to
// maxWheelSpeedRevPerSec instead of maxMotorPower) rather than refactoring
// into a shared helper -- kept in sync manually, not unified, per the
// source project's own comments.
void computeGotoTargetWheelVelocities(float targetVelRevPerSec[2], float *targetHeadingRad) {
    static float lastValidHeadingRad = 0.0f;

    float dx = goalX_m - poseX_m;
    float dy = goalY_m - poseY_m;
    float distance = std::sqrt(dx * dx + dy * dy);

    if (distance < GOTO_ARRIVAL_TOLERANCE_M) {
        if (settings.gotoPreserveHeading && goalHasHeading) {
            float headingError = wrapToPi(goalHeadingRad - poseThetaRad);
            if (std::fabs(headingError) > GOTO_HEADING_ARRIVAL_TOLERANCE_RAD) {
                // Same wheel-sign convention as the !gotoAllowReverse
                // in-place-turn branch below (wheelFrac[0]=-left,
                // wheelFrac[1]=left): positive headingError (goal CCW of
                // current) needs the same CCW spin that positive `left`
                // (goal to the left) needs there. Still routed through
                // gotoVelocityTrackingControl()'s rate limiter + PI tracking,
                // not a bypass. Recomputed fresh each tick from live heading
                // error rather than latched behind a state flag: a true
                // in-place rotation doesn't translate the robot, so distance
                // won't drift back over tolerance from rotation alone.
                float rotFrac = std::clamp(headingError * GOTO_HEADING_ROTATE_KP,
                                            -GOTO_HEADING_ROTATE_MAX_FRACTION, GOTO_HEADING_ROTATE_MAX_FRACTION);
                targetVelRevPerSec[0] = -rotFrac * settings.maxWheelSpeedRevPerSec;
                targetVelRevPerSec[1] = rotFrac * settings.maxWheelSpeedRevPerSec;
                *targetHeadingRad = goalHeadingRad;
                return;
            }
        }
        targetVelRevPerSec[0] = targetVelRevPerSec[1] = 0;
        *targetHeadingRad = lastValidHeadingRad;
        return;
    }

    // Waypoint auto-advance requests skip this distance-proportional
    // slowdown: the client re-targets the next waypoint well before precise
    // stopping matters, so crawling in for a stop that's about to be
    // superseded anyway would only cost momentum for no benefit. A plain
    // click-to-navigate or single Go To still ramps down normally, for
    // precise stopping at an arbitrary target.
    float speedFraction = goalMaintainSpeed ? 1.0f : std::clamp(distance * settings.gotoSpeedGain, 0.0f, 1.0f);
    float worldDirX = (dx / distance) * speedFraction;
    float worldDirY = (dy / distance) * speedFraction;

    float theta = poseThetaRad;
    float forward = worldDirX * std::cos(theta) + worldDirY * std::sin(theta);
    float left = -worldDirX * std::sin(theta) + worldDirY * std::cos(theta);

    float angleToGoal = std::atan2(dy, dx);
    float wheelFrac[2];
    if (forward >= 0) {
        wheelFrac[0] = forward - left;
        wheelFrac[1] = forward + left;
        lastValidHeadingRad = angleToGoal;
    } else if (!settings.gotoAllowReverse) {
        // Reverse driving disabled (settings.gotoAllowReverse): rotate in
        // place toward the target instead of backing into it like the
        // branch below. Reuses the same left/right turn-direction signal
        // already computed above, just without the negative forward bias
        // that would otherwise drive the robot backward -- once the turn
        // brings the target back within 90 deg of the nose, "forward >= 0"
        // takes over again with no discontinuity.
        //
        // `left` alone isn't enough right at this branch's own singularity
        // (target ~180 deg behind): its magnitude is proportional to
        // sin(angle-off), which vanishes exactly where forward crosses zero
        // into this branch, commanding a sub-deadzone turn that never
        // actually moves the robot -- reported as "nothing happens" when a
        // waypoint ends up directly behind it. A minimum turn magnitude
        // fixes that; a latched sign (rather than re-deciding from a
        // near-zero, noise-dominated `left` every tick) avoids the turn
        // direction chattering between left/right while `left` hovers near
        // zero -- once real rotation begins the geometry stops being
        // ambiguous and `left` takes back over on its own.
        static float lastTurnSign = 1.0f;
        float turnMag = std::fabs(left);
        float turnSign;
        if (turnMag > GOTO_INPLACE_TURN_SIGN_DEADBAND) {
            turnSign = (left > 0) ? 1.0f : -1.0f;
            lastTurnSign = turnSign;
        } else {
            turnSign = lastTurnSign;
        }
        float rotFrac = turnSign * std::fmax(turnMag, GOTO_INPLACE_TURN_MIN_FRACTION);
        wheelFrac[0] = -rotFrac;
        wheelFrac[1] = rotFrac;
        lastValidHeadingRad = angleToGoal;
    } else {
        // Approaching backward (tail is the closer face)
        wheelFrac[0] = forward + left;
        wheelFrac[1] = forward - left;
        lastValidHeadingRad = wrapToPi(angleToGoal + (float) M_PI);
    }
    *targetHeadingRad = lastValidHeadingRad;

    float maxWheelFrac = std::fmax(std::fabs(wheelFrac[0]), std::fabs(wheelFrac[1]));
    if (maxWheelFrac > 1.0f) {
        wheelFrac[0] /= maxWheelFrac;
        wheelFrac[1] /= maxWheelFrac;
    }

    targetVelRevPerSec[0] = wheelFrac[0] * settings.maxWheelSpeedRevPerSec;
    targetVelRevPerSec[1] = wheelFrac[1] * settings.maxWheelSpeedRevPerSec;
}

// Rate-limits a velocity setpoint toward `target`, using maxAccelRevPerSec2
// when speeding up and maxDecelRevPerSec2 when slowing down/reversing.
void rateLimitVelocitySetpoint(float target, float &setpoint, float dt) {
    float maxStepAccel = settings.maxAccelRevPerSec2 * dt;
    float maxStepDecel = settings.maxDecelRevPerSec2 * dt;

    bool speedingUp;
    if (setpoint == 0.0f) {
        speedingUp = true;
    } else if ((target > 0) == (setpoint > 0)) {
        speedingUp = std::fabs(target) > std::fabs(setpoint);
    } else {
        speedingUp = false;
    }

    float maxStep = speedingUp ? maxStepAccel : maxStepDecel;
    float delta = std::clamp(target - setpoint, -maxStep, maxStep);
    setpoint += delta;
}

// Stage 2: rate-limits the stage-1 target, integrates a wheel position
// setpoint from it, then tracks the rate-limited velocity setpoint with a
// feed-forward + PI controller per wheel (conditional-integration anti-windup).
void gotoVelocityTrackingControl(float targetVelRevPerSec[2]) {
    static float intErrorRevPerSec[2] = {0, 0};
    static float posSetpointAccumRev[2] = {0, 0};
    float dt = TIMER_INTERVAL_US / 1000000.0f;

    if (gotoControllerNeedsInitFlag) {
        gotoControllerNeedsInitFlag = false;
        for (int wheel = 0; wheel < 2; wheel++) {
            gotoWheelVelSetpointRevPerSec[wheel] = wheelVelRevPerSec[wheel];
            posSetpointAccumRev[wheel] = wheelPosRev[wheel];
            intErrorRevPerSec[wheel] = 0;
        }
    }

    for (int wheel = 0; wheel < 2; wheel++) {
        rateLimitVelocitySetpoint(targetVelRevPerSec[wheel], gotoWheelVelSetpointRevPerSec[wheel], dt);
        posSetpointAccumRev[wheel] += gotoWheelVelSetpointRevPerSec[wheel] * dt;
        gotoWheelPosSetpointRev[wheel] = posSetpointAccumRev[wheel];

        float error = gotoWheelVelSetpointRevPerSec[wheel] - wheelVelRevPerSec[wheel];

        float feedForwardPwm = gotoWheelVelSetpointRevPerSec[wheel] * settings.feedForwardPwmPerRevPerSec * settings.maxMotorPower;
        float proportionalPwm = settings.gotoVelKp * error;

        float outputBeforeThisTicksIntegral = feedForwardPwm + proportionalPwm + settings.gotoVelKi * intErrorRevPerSec[wheel];
        bool wouldWorsenHighSaturation = outputBeforeThisTicksIntegral >= settings.maxMotorPower && error > 0;
        bool wouldWorsenLowSaturation = outputBeforeThisTicksIntegral <= -settings.maxMotorPower && error < 0;
        if (!wouldWorsenHighSaturation && !wouldWorsenLowSaturation) {
            intErrorRevPerSec[wheel] += error * dt;
        }

        float integralPwm = settings.gotoVelKi * intErrorRevPerSec[wheel];

        gotoFfPwm[wheel] = feedForwardPwm;
        gotoPPwm[wheel] = proportionalPwm;
        gotoIPwm[wheel] = integralPwm;

        motorPower[wheel] = (int) std::clamp(feedForwardPwm + proportionalPwm + integralPwm,
                                              (float) -settings.maxMotorPower, (float) settings.maxMotorPower);
    }
}

void gotoPositionControl() {
    float targetVelRevPerSec[2];
    float targetHeadingRad;
    computeGotoTargetWheelVelocities(targetVelRevPerSec, &targetHeadingRad);
    gotoTargetHeadingRad = targetHeadingRad;
    applyServoTrackingConstraints(targetVelRevPerSec);
    gotoVelocityTrackingControl(targetVelRevPerSec);
}

void manualVelocityControl() {
    gotoVelocityTrackingControl(manualVelSetpointRevPerSec);
}

// Motor deadzone calibration: ramps PWM up slowly (equal on both wheels)
// until BOTH wheels show real cumulative encoder movement, then records
// that PWM as settings.motorDeadzonePwm.
void deadzoneCalibrationControl() {
    static unsigned long lastRampMs = 0;
    static long baselineEncoder[2] = {0, 0};

    if (startDeadzoneCalibrationFlag) {
        startDeadzoneCalibrationFlag = false;
        deadzoneCalibrationActive = true;
        deadzoneCalibrationPwm = 0;
        baselineEncoder[0] = encoderCount_steps[0];
        baselineEncoder[1] = encoderCount_steps[1];
        lastRampMs = millis_now();
    }

    if (!deadzoneCalibrationActive) {
        motorPower[0] = 0;
        motorPower[1] = 0;
        return;
    }

    long movedLeft = std::labs(encoderCount_steps[0] - baselineEncoder[0]);
    long movedRight = std::labs(encoderCount_steps[1] - baselineEncoder[1]);

    if (movedLeft >= DEADZONE_CALIBRATION_ENCODER_THRESHOLD && movedRight >= DEADZONE_CALIBRATION_ENCODER_THRESHOLD) {
        settings.motorDeadzonePwm = deadzoneCalibrationPwm;
        settingsSaveRequestedFlag = true; // this runs on the control task -- see the flag's doc comment
        motorPower[0] = 0;
        motorPower[1] = 0;
        deadzoneCalibrationActive = false;
        return;
    }

    if (deadzoneCalibrationPwm >= settings.maxMotorPower) {
        motorPower[0] = 0;
        motorPower[1] = 0;
        deadzoneCalibrationActive = false;
        return;
    }

    if (millis_now() - lastRampMs >= DEADZONE_RAMP_INTERVAL_MS) {
        lastRampMs += DEADZONE_RAMP_INTERVAL_MS;
        deadzoneCalibrationPwm++;
    }

    motorPower[0] = deadzoneCalibrationPwm;
    motorPower[1] = deadzoneCalibrationPwm;
}

// Spins ONE wheel exactly ENCODER_CALIBRATION_TARGET_REVS revolutions, per
// the firmware's own (hardcoded) counts-per-revolution, at a slow constant
// speed -- purely so the operator can visually count actual physical turns
// against the commanded 10 and judge whether MOTOR_TRANSMISSION_RATIO /
// ENCODER_COUNTS_PER_REVOLUTION (board_pins.hpp) are actually correct. Not
// a self-correcting calibration -- if the wheel visibly over/undershoots 10
// turns, that constant needs adjusting by hand, in proportion to the
// discrepancy observed.
void encoderCalibrationControl() {
    static float startWheelPosRev = 0.0f;

    if (startEncoderCalibrationFlag) {
        startEncoderCalibrationFlag = false;
        encoderCalibrationActive = true;
        startWheelPosRev = wheelPosRev[encoderCalibrationWheel];
    }

    if (!encoderCalibrationActive) {
        motorPower[0] = 0;
        motorPower[1] = 0;
        encoderCalibrationRevsDone = 0.0f;
        return;
    }

    float traveled = wheelPosRev[encoderCalibrationWheel] - startWheelPosRev;
    encoderCalibrationRevsDone = traveled;

    float targetVelRevPerSec[2] = {0.0f, 0.0f};
    if (traveled < ENCODER_CALIBRATION_TARGET_REVS) {
        targetVelRevPerSec[encoderCalibrationWheel] = ENCODER_CALIBRATION_SPEED_REV_PER_SEC;
    } else {
        encoderCalibrationActive = false;
    }
    gotoVelocityTrackingControl(targetVelRevPerSec);
}

void lab1ForwardControl() {
    if (millis_now() < lab1StartTimeMs + 800) {
        int power = settings.maxMotorPower * (lab1Forward ? 1 : -1);
        motorPower[0] = power;
        motorPower[1] = power;
    } else {
        motorPower[0] = 0;
        motorPower[1] = 0;
    }
}

void lab2FeedbackControl() {
    static float int_error_rad[2] = {0.0, 0.0};
    float wheelRadius_m = wheelRadiusMeters();
    for (int wheel = 0; wheel < 2; wheel++) {
        float wheel_pos_rad = encoderCount_steps[wheel] * 2 * (float) M_PI / (MOTOR_TRANSMISSION_RATIO * ENCODER_COUNTS_PER_REVOLUTION);
        if (setSetpointToCurrentPosFlag) {
            lab2SetpointM[wheel] = wheel_pos_rad * wheelRadius_m;
        }
        float lab2SetpointRad = lab2SetpointM[wheel] / wheelRadius_m;

        float error_rad = lab2SetpointRad - wheel_pos_rad;
        float diff_error_rad = -encoderCountDerivative_steps[wheel] * 2 * (float) M_PI / (MOTOR_TRANSMISSION_RATIO * ENCODER_COUNTS_PER_REVOLUTION);
        int_error_rad[wheel] += error_rad * TIMER_INTERVAL_US / 1000000.0f;

        float power = settings.kp * error_rad + settings.kd * diff_error_rad + settings.ki * int_error_rad[wheel];
        motorPower[wheel] = (int) std::clamp(power, (float) -settings.maxMotorPower, (float) settings.maxMotorPower);
    }

    if (settings.syncMotors) {
        motorPower[1] = motorPower[0];
    }
    setSetpointToCurrentPosFlag = false;
}

void applyLab2Turn(bool turnLeft) {
    float halfWheelbase_m = (settings.wheelbaseMm / 1000.0f) / 2.0f;
    float dArc_m = LAB2_TURN_ANGLE_RAD * halfWheelbase_m;
    if (turnLeft) {
        lab2SetpointM[0] -= dArc_m;
        lab2SetpointM[1] += dArc_m;
    } else {
        lab2SetpointM[0] += dArc_m;
        lab2SetpointM[1] -= dArc_m;
    }
}

void calcEncoderDerivatives() {
    static float rate[2], total[2];
    for (int wheel = 0; wheel < 2; wheel++) {
        rate[wheel] = -2 * (float) M_PI * settings.differentiatorCutoffHz * encoderCountDerivative_steps[wheel];
        total[wheel] += rate[wheel] * TIMER_INTERVAL_US / 1000000.0f;
        encoderCountDerivative_steps[wheel] = total[wheel] + 2 * (float) M_PI * settings.differentiatorCutoffHz * encoderCount_steps[wheel];
    }
}

void switchModeIfNeeded(int newMode) {
    if (settings.mode == newMode) {
        return;
    }
    settings.mode = newMode;
    if (newMode == LAB2_PID_1M) {
        setSetpointToCurrentPosFlag = true;
    }
    // All four of these modes now share gotoVelocityTrackingControl()'s
    // persistent velocity-setpoint/position-accumulator/integral state --
    // re-init on entry so it snaps to the robot's actual current velocity
    // instead of picking up wherever that state was left by whichever mode
    // ran before, which could otherwise demand a large, discontinuous
    // velocity-error correction on the very first tick of the new mode.
    if (newMode == GOTO_POSITION_CONTROL || newMode == MANUAL_VELOCITY_CONTROL ||
        newMode == TOUCHPAD_CONTROL || newMode == CONTROL_FRAME_CONTROL ||
        newMode == ENCODER_CALIBRATION) {
        gotoControllerNeedsInitFlag = true;
    }
    // Deliberately NOT saveSettings() here -- see settingsSaveRequestedFlag's
    // doc comment in control_modes.hpp. Drive mode is live UI state, not a
    // calibration value -- it doesn't need to survive a reboot the way the
    // rest of Settings does, and a flash/NVS write on every joystick touch
    // is exactly the pattern that tripped the Pico build's watchdog.
}

void stopAllMotion() {
    V1[0] = V1[1] = 0;
    controlJoyX = 0;
    controlJoyY = 0;
    manualVelSetpointRevPerSec[0] = manualVelSetpointRevPerSec[1] = 0;
    encoderCalibrationActive = false;
    switchModeIfNeeded(TOUCHPAD_CONTROL);
}

void controlModesTick() {
    breadcrumb_mark_core1(CORE1_CP_TICK_START);
    breadcrumb_mark_core1(CORE1_CP_ENCODER_DERIVATIVES);
    calcEncoderDerivatives();
    breadcrumb_mark_core1(CORE1_CP_WHEEL_TELEMETRY);
    updateWheelActualTelemetry();

    if (settings.mode == TOUCHPAD_CONTROL) {
        breadcrumb_mark_core1(CORE1_CP_MODE_TOUCHPAD);
        remoteControlMotors();
    } else if (settings.mode == LAB1_FWD_REV) {
        breadcrumb_mark_core1(CORE1_CP_MODE_LAB1);
        lab1ForwardControl();
    } else if (settings.mode == LAB2_PID_1M) {
        breadcrumb_mark_core1(CORE1_CP_MODE_LAB2);
        lab2FeedbackControl();
    } else if (settings.mode == CONTROL_FRAME_CONTROL) {
        breadcrumb_mark_core1(CORE1_CP_MODE_CONTROL_FRAME);
        controlFrameJoystickControl();
    } else if (settings.mode == GOTO_POSITION_CONTROL) {
        breadcrumb_mark_core1(CORE1_CP_MODE_GOTO);
        gotoPositionControl();
    } else if (settings.mode == DEADZONE_CALIBRATION) {
        breadcrumb_mark_core1(CORE1_CP_MODE_DEADZONE_CAL);
        deadzoneCalibrationControl();
    } else if (settings.mode == MANUAL_VELOCITY_CONTROL) {
        breadcrumb_mark_core1(CORE1_CP_MODE_MANUAL_VEL);
        manualVelocityControl();
    } else if (settings.mode == ENCODER_CALIBRATION) {
        breadcrumb_mark_core1(CORE1_CP_MODE_ENCODER_CAL);
        encoderCalibrationControl();
    } else {
        breadcrumb_mark_core1(CORE1_CP_MODE_OTHER);
        motorPower[0] = 0;
        motorPower[1] = 0;
    }

    for (int wheel = 0; wheel < 2; wheel++) {
        motorPowerPwm[wheel] = motorPower[wheel];
    }

    breadcrumb_mark_core1(CORE1_CP_LOGGING);
    if (settings.loggingEnabled) {
        static unsigned long lastDataStampUs = 0;
        static unsigned long startTimeUs = 0;
        static bool started = false;
        if (!started) {
            startTimeUs = (unsigned long) esp_timer_get_time();
            started = true;
        }
        unsigned long tm = (unsigned long) esp_timer_get_time() - startTimeUs;
        if (tm - lastDataStampUs > 1000000.0f / settings.dataLogRate) {
            lastDataStampUs += (unsigned long) (1000000.0f / settings.dataLogRate);
            if (tm - lastDataStampUs > 1000000.0f / settings.dataLogRate) {
                lastDataStampUs = tm;
            }
            // Built with snprintf (no I/O, so this can't block the control
            // task) and handed to log_task_submit(), which never blocks
            // either -- see log_task.hpp's header comment for why a plain
            // printf() here would be a real hazard on this platform.
            char line[LOG_LINE_MAX_LEN];
            int len = snprintf(line, sizeof(line), "%.4f", tm / 1000000.0f);
            float wheelRadius_m = wheelRadiusMeters();
            for (int wheel = 0; wheel < 2 && len > 0 && (size_t) len < sizeof(line); wheel++) {
                if (wheel == 1 && settings.logType == LEFT_WHEEL) {
                    break;
                }
                len += snprintf(line + len, sizeof(line) - len, ", %d", motorPower[wheel]);
                float scaleFactor = 1;
                switch (settings.logUnit) {
                    case ENCODER_STEPS: scaleFactor = 1; break;
                    case WHEEL_RAD: scaleFactor = 2 * (float) M_PI / (MOTOR_TRANSMISSION_RATIO * ENCODER_COUNTS_PER_REVOLUTION); break;
                    case WHEEL_DEG: scaleFactor = 360.0f / (MOTOR_TRANSMISSION_RATIO * ENCODER_COUNTS_PER_REVOLUTION); break;
                    case WHEEL_REV: scaleFactor = 1.0f / (MOTOR_TRANSMISSION_RATIO * ENCODER_COUNTS_PER_REVOLUTION); break;
                    case DISTANCE: scaleFactor = wheelRadius_m * 2 * (float) M_PI / (MOTOR_TRANSMISSION_RATIO * ENCODER_COUNTS_PER_REVOLUTION); break;
                }
                if ((size_t) len < sizeof(line)) {
                    len += snprintf(line + len, sizeof(line) - len, ", %.3f, %.3f",
                                     encoderCount_steps[wheel] * scaleFactor, encoderCountDerivative_steps[wheel] * scaleFactor);
                }
            }
            if (len > 0 && (size_t) len < sizeof(line) - 1) {
                line[len] = '\n';
                line[len + 1] = '\0';
            }
            log_task_submit(line);
        }
    }

    breadcrumb_mark_core1(CORE1_CP_ODOMETRY);
    static long prevEncoderCount_steps[2] = {0, 0};
    long dEncoderLeft = encoderCount_steps[0] - prevEncoderCount_steps[0];
    long dEncoderRight = encoderCount_steps[1] - prevEncoderCount_steps[1];
    updateOdometry(dEncoderLeft, dEncoderRight, wheelRadiusMeters(), settings.wheelbaseMm,
                   MOTOR_TRANSMISSION_RATIO, ENCODER_COUNTS_PER_REVOLUTION);
    prevEncoderCount_steps[0] = encoderCount_steps[0];
    prevEncoderCount_steps[1] = encoderCount_steps[1];

    breadcrumb_mark_core1(CORE1_CP_RESET_HANDLING);
    if (resetPoseFlag) {
        resetPoseTo(resetPoseX_m, resetPoseY_m, resetPoseTheta_rad);
        resetPoseFlag = false;
    }

    if (resetEncodersFlag) {
        encoderCount_steps[0] = 0;
        encoderCount_steps[1] = 0;
        prevEncoderCount_steps[0] = 0;
        prevEncoderCount_steps[1] = 0;
        resetEncodersFlag = false;
        gotoControllerNeedsInitFlag = true;
    }

    breadcrumb_mark_core1(CORE1_CP_TICK_END);
}
