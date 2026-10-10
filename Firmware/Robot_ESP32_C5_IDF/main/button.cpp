#include "button.hpp"
#include "board_pins.hpp"
#include "status_led.hpp"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "led_strip.h"

// The QR pushbutton and the onboard RGB LED (WS2812) share QR_BUTTON_PIN:
// the pin is a pulled-up input (read for the button) except for the moment
// a new colour is sent. A WS2812 keeps its colour without refreshing, so
// that's only when the colour changes (status_led.cpp) -- and never while
// the button is held (it shorts the data line). Same pattern as the bring-up
// test project's button_led.cpp: led_strip_del() frees the RMT channel but
// leaves the GPIO as it was, so the input is set up again after every write.

namespace {

const char *TAG = "button";
constexpr int POLL_MS = 30;
constexpr int DEBOUNCE_POLLS = 2;

volatile bool s_pressed = false;

void configure_as_button_input() {
    gpio_config_t cfg = {};
    cfg.pin_bit_mask = 1ULL << QR_BUTTON_PIN;
    cfg.mode = GPIO_MODE_INPUT;
    cfg.pull_up_en = GPIO_PULLUP_ENABLE;
    cfg.pull_down_en = GPIO_PULLDOWN_DISABLE;
    cfg.intr_type = GPIO_INTR_DISABLE;
    gpio_config(&cfg);
}

// Sends one colour to the LED; the pin is an input again afterwards.
bool write_led(StatusLedColor c) {
    led_strip_config_t stripConfig = {};
    stripConfig.strip_gpio_num = QR_BUTTON_PIN;
    stripConfig.max_leds = 1;
    stripConfig.led_model = LED_MODEL_WS2812;
    // RGB, not the usual WS2812 GRB: on this Waveshare board GRB showed red as green and green as red
    stripConfig.color_component_format = LED_STRIP_COLOR_COMPONENT_FMT_RGB;
    led_strip_rmt_config_t rmtConfig = {};
    rmtConfig.resolution_hz = 10 * 1000 * 1000;
    led_strip_handle_t strip = nullptr;
    esp_err_t err = led_strip_new_rmt_device(&stripConfig, &rmtConfig, &strip);
    if (err != ESP_OK) {
        static bool logged = false; // (once: it's retried every poll)
        if (!logged) ESP_LOGE(TAG, "led_strip_new_rmt_device failed: %s", esp_err_to_name(err));
        logged = true;
        configure_as_button_input();
        return false;
    }
    led_strip_set_pixel(strip, 0, c.r, c.g, c.b);
    led_strip_refresh(strip);
    led_strip_del(strip);
    configure_as_button_input();
    return true;
}

void button_task(void *arg) {
    (void) arg;
    bool candidate = false;
    int stableCount = 0;
    bool written = false;
    StatusLedColor shown = { 0, 0, 0 };

    while (true) {
        bool rawPressed = (gpio_get_level(QR_BUTTON_PIN) == 0);
        if (rawPressed != candidate) {
            candidate = rawPressed;
            stableCount = 0;
        } else if (stableCount < DEBOUNCE_POLLS) {
            stableCount++;
            if (stableCount == DEBOUNCE_POLLS) s_pressed = candidate;
        }
        // the LED: only with the button up (and settled), only when its colour changes
        if (!rawPressed && !candidate) {
            StatusLedColor c = status_led_color((uint32_t) (esp_timer_get_time() / 1000));
            if (!written || c.r != shown.r || c.g != shown.g || c.b != shown.b) {
                written = write_led(c);
                shown = c;
            }
        } else {
            written = false; // (pressing it may have disturbed the LED: send the colour again after)
        }
        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
    }
}

} // namespace

void button_start() {
    configure_as_button_input();
    xTaskCreate(button_task, "button", 4096, nullptr, tskIDLE_PRIORITY + 1, nullptr);
}

bool button_is_pressed() {
    return s_pressed;
}
