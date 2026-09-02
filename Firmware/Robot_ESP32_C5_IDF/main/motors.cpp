#include "motors.hpp"
#include "board_pins.hpp"

#include "driver/gpio.h"
#include "driver/ledc.h"
#include "esp_log.h"

#include <algorithm>
#include <cstdlib>

namespace {

const char *TAG = "motors";

// ESP32-C5 LEDC: low-speed mode only, same as the S3's low-speed bank.
constexpr ledc_mode_t LEDC_MODE = LEDC_LOW_SPEED_MODE;

constexpr ledc_timer_t SERVO_TIMER = LEDC_TIMER_0;
constexpr ledc_channel_t SERVO_CHANNEL = LEDC_CHANNEL_0;
constexpr ledc_channel_t TILT_SERVO_CHANNEL = LEDC_CHANNEL_3; // shares SERVO_TIMER

constexpr ledc_timer_t MOTOR_TIMER = LEDC_TIMER_1;
constexpr ledc_channel_t MOTOR_CHANNEL[2] = {LEDC_CHANNEL_1, LEDC_CHANNEL_2}; // left, right

// Pin both timers to the same explicit clock source so the second
// ledc_timer_config() call can't have the driver silently retune the first
// via LEDC_AUTO_CLK picking different sources per timer. ESP32-C5 has no
// APB-clock LEDC source (that was Xtensa-chip-only) -- LEDC_USE_PLL_DIV_CLK
// is its equivalent here: per soc/clk_tree_defs.h it's literally
// SOC_MOD_CLK_PLL_F80M, a fixed 80 MHz clock derived from the PLL,
// independent of which crystal (40/48 MHz) this board has. 50 Hz * 2^14 =
// 0.8 MHz and 20 kHz * 2^11 = 41 MHz, both comfortably under 80 MHz.
constexpr ledc_clk_cfg_t LEDC_CLOCK = LEDC_USE_PLL_DIV_CLK;
constexpr uint32_t LEDC_CLK_HZ = 80 * 1000 * 1000;

constexpr ledc_timer_bit_t SERVO_RESOLUTION = LEDC_TIMER_14_BIT;
constexpr uint32_t SERVO_PERIOD_US = 1000000 / SERVO_PWM_FREQ_HZ; // 20000

// Chosen at init via ledc_find_suitable_duty_resolution() so changing
// MOTOR_PWM_FREQ_HZ can't silently produce an invalid timer config.
uint32_t g_motorResolutionBits = 0;
uint32_t g_motorFullScaleDuty = 0;

// Every pin this module ever drives, motor AND servo. Originally just the
// four motor GPIOs; SERVO_PIN/TILT_SERVO_PIN were added after observing the
// pan servo visibly (and, when it was on GPIO28, randomly CW/CCW) twitch at
// boot -- see board_pins.hpp's SERVO_PIN comment for the full story of why
// that pin was moved off a strapping pin entirely. Keeping both servo pins
// claimed here regardless: closing the reset-to-motors_init() gap where they'd
// otherwise sit completely unclaimed and undriven is good practice on its
// own, strapping pin or not.
constexpr gpio_num_t ALL_DRIVER_PINS[] = {
    MOTOR_ENABLE_PIN[0],  MOTOR_ENABLE_PIN[1],
    MOTOR_DIR_PIN[0][0],  MOTOR_DIR_PIN[0][1],
    MOTOR_DIR_PIN[1][0],  MOTOR_DIR_PIN[1][1],
    SERVO_PIN,            TILT_SERVO_PIN,
};

} // namespace

void motors_force_safe_state() {
    uint64_t mask = 0;
    for (gpio_num_t pin : ALL_DRIVER_PINS) {
        mask |= (1ULL << pin);
    }

    gpio_config_t cfg = {};
    cfg.pin_bit_mask = mask;
    cfg.mode = GPIO_MODE_OUTPUT;
    cfg.pull_up_en = GPIO_PULLUP_DISABLE;
    // Pulldowns so the pads are actively held low even in the window between
    // gpio_config() claiming them and the levels below being written.
    cfg.pull_down_en = GPIO_PULLDOWN_ENABLE;
    cfg.intr_type = GPIO_INTR_DISABLE;
    gpio_config(&cfg);

    for (gpio_num_t pin : ALL_DRIVER_PINS) {
        gpio_set_level(pin, 0);
    }
}

void motors_init() {
    // motors_force_safe_state() already configured the motor pins; this
    // just restates the intent if init is ever called standalone.
    motors_force_safe_state();

    g_motorResolutionBits = ledc_find_suitable_duty_resolution(LEDC_CLK_HZ, MOTOR_PWM_FREQ_HZ);
    // LEDC treats duty == 2^resolution as 100%, so that -- not 2^res - 1 --
    // is what a full-scale power of 1000 must map to.
    g_motorFullScaleDuty = 1u << g_motorResolutionBits;

    ledc_timer_config_t motorTimer = {};
    motorTimer.speed_mode = LEDC_MODE;
    motorTimer.duty_resolution = (ledc_timer_bit_t) g_motorResolutionBits;
    motorTimer.timer_num = MOTOR_TIMER;
    motorTimer.freq_hz = MOTOR_PWM_FREQ_HZ;
    motorTimer.clk_cfg = LEDC_CLOCK;
    ESP_ERROR_CHECK(ledc_timer_config(&motorTimer));

    ledc_timer_config_t servoTimer = {};
    servoTimer.speed_mode = LEDC_MODE;
    servoTimer.duty_resolution = SERVO_RESOLUTION;
    servoTimer.timer_num = SERVO_TIMER;
    servoTimer.freq_hz = SERVO_PWM_FREQ_HZ;
    servoTimer.clk_cfg = LEDC_CLOCK;
    ESP_ERROR_CHECK(ledc_timer_config(&servoTimer));

    for (int wheel = 0; wheel < 2; wheel++) {
        ledc_channel_config_t ch = {};
        ch.gpio_num = MOTOR_ENABLE_PIN[wheel];
        ch.speed_mode = LEDC_MODE;
        ch.channel = MOTOR_CHANNEL[wheel];
        ch.timer_sel = MOTOR_TIMER;
        ch.duty = 0;
        ch.hpoint = 0;
        ESP_ERROR_CHECK(ledc_channel_config(&ch));
    }

    ledc_channel_config_t servoCh = {};
    servoCh.gpio_num = SERVO_PIN;
    servoCh.speed_mode = LEDC_MODE;
    servoCh.channel = SERVO_CHANNEL;
    servoCh.timer_sel = SERVO_TIMER;
    servoCh.duty = 0; // no pulse until the test sequence commands one
    servoCh.hpoint = 0;
    ESP_ERROR_CHECK(ledc_channel_config(&servoCh));

    ledc_channel_config_t tiltServoCh = {};
    tiltServoCh.gpio_num = TILT_SERVO_PIN;
    tiltServoCh.speed_mode = LEDC_MODE;
    tiltServoCh.channel = TILT_SERVO_CHANNEL;
    tiltServoCh.timer_sel = SERVO_TIMER;
    tiltServoCh.duty = 0;
    tiltServoCh.hpoint = 0;
    ESP_ERROR_CHECK(ledc_channel_config(&tiltServoCh));

    // Direction pins stay plain GPIO outputs -- never PWM.
    for (int wheel = 0; wheel < 2; wheel++) {
        for (int i = 0; i < 2; i++) {
            gpio_set_direction(MOTOR_DIR_PIN[wheel][i], GPIO_MODE_OUTPUT);
            gpio_set_level(MOTOR_DIR_PIN[wheel][i], 0);
        }
    }

    ESP_LOGI(TAG, "TB6612FNG: %d Hz, %lu-bit duty (full scale %lu); left PWM=%d IN=%d/%d, right PWM=%d IN=%d/%d",
             MOTOR_PWM_FREQ_HZ, (unsigned long) g_motorResolutionBits,
             (unsigned long) g_motorFullScaleDuty,
             MOTOR_ENABLE_PIN[0], MOTOR_DIR_PIN[0][0], MOTOR_DIR_PIN[0][1],
             MOTOR_ENABLE_PIN[1], MOTOR_DIR_PIN[1][0], MOTOR_DIR_PIN[1][1]);
    ESP_LOGI(TAG, "pan servo on GPIO%d, tilt servo on GPIO%d: both %d Hz, %d-bit duty (%lu us period)",
             SERVO_PIN, TILT_SERVO_PIN, SERVO_PWM_FREQ_HZ, (int) SERVO_RESOLUTION,
             (unsigned long) SERVO_PERIOD_US);
}

void motors_run(int power, int wheel) {
    int magnitude = std::abs(power);
    if (magnitude > 1000) {
        magnitude = 1000;
    }

    // Direction first, duty second, so the bridge is never briefly enabled in
    // the old direction after a sign change (direction pins are static
    // GPIOs, so there's no PWM-latch race to worry about either way).
    bool forward = (power > 0) != MOTOR_INVERT[wheel];
    gpio_set_level(MOTOR_DIR_PIN[wheel][0], forward ? 1 : 0);
    gpio_set_level(MOTOR_DIR_PIN[wheel][1], forward ? 0 : 1);

    uint32_t duty = (uint32_t) (((uint64_t) magnitude * g_motorFullScaleDuty) / 1000);
    ledc_set_duty(LEDC_MODE, MOTOR_CHANNEL[wheel], duty);
    ledc_update_duty(LEDC_MODE, MOTOR_CHANNEL[wheel]);
}

void motors_coast_all() {
    for (int wheel = 0; wheel < 2; wheel++) {
        ledc_set_duty(LEDC_MODE, MOTOR_CHANNEL[wheel], 0);
        ledc_update_duty(LEDC_MODE, MOTOR_CHANNEL[wheel]);
        gpio_set_level(MOTOR_DIR_PIN[wheel][0], 0);
        gpio_set_level(MOTOR_DIR_PIN[wheel][1], 0);
    }
}

namespace {
uint32_t g_lastServoDuty = 0;
uint32_t g_lastTiltServoDuty = 0;
} // namespace

void servo_set_pulse_us(uint16_t pulse_us) {
    if (pulse_us > SERVO_PERIOD_US) {
        pulse_us = SERVO_PERIOD_US;
    }
    uint32_t fullScale = 1u << SERVO_RESOLUTION;
    uint32_t duty = (uint32_t) (((uint64_t) pulse_us * fullScale) / SERVO_PERIOD_US);
    g_lastServoDuty = duty;
    esp_err_t err1 = ledc_set_duty(LEDC_MODE, SERVO_CHANNEL, duty);
    esp_err_t err2 = ledc_update_duty(LEDC_MODE, SERVO_CHANNEL);
    if (err1 != ESP_OK || err2 != ESP_OK) {
        ESP_LOGE(TAG, "servo_set_pulse_us(%d): set_duty=%s update_duty=%s",
                 pulse_us, esp_err_to_name(err1), esp_err_to_name(err2));
    }
}

void tilt_servo_set_pulse_us(uint16_t pulse_us) {
    if (pulse_us > SERVO_PERIOD_US) {
        pulse_us = SERVO_PERIOD_US;
    }
    uint32_t fullScale = 1u << SERVO_RESOLUTION;
    uint32_t duty = (uint32_t) (((uint64_t) pulse_us * fullScale) / SERVO_PERIOD_US);
    g_lastTiltServoDuty = duty;
    esp_err_t err1 = ledc_set_duty(LEDC_MODE, TILT_SERVO_CHANNEL, duty);
    esp_err_t err2 = ledc_update_duty(LEDC_MODE, TILT_SERVO_CHANNEL);
    if (err1 != ESP_OK || err2 != ESP_OK) {
        ESP_LOGE(TAG, "tilt_servo_set_pulse_us(%d): set_duty=%s update_duty=%s",
                 pulse_us, esp_err_to_name(err1), esp_err_to_name(err2));
    }
}

uint32_t servo_last_duty() {
    return g_lastServoDuty;
}

uint32_t tilt_servo_last_duty() {
    return g_lastTiltServoDuty;
}
