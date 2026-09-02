#include "button.hpp"
#include "board_pins.hpp"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "driver/gpio.h"

namespace {

constexpr int POLL_MS = 30;
constexpr int DEBOUNCE_POLLS = 2;

volatile bool s_pressed = false;

void button_task(void *arg) {
    (void) arg;
    bool candidate = false;
    int stableCount = 0;

    while (true) {
        bool rawPressed = (gpio_get_level(QR_BUTTON_PIN) == 0);
        if (rawPressed != candidate) {
            candidate = rawPressed;
            stableCount = 0;
        } else if (stableCount < DEBOUNCE_POLLS) {
            stableCount++;
            if (stableCount == DEBOUNCE_POLLS) s_pressed = candidate;
        }
        vTaskDelay(pdMS_TO_TICKS(POLL_MS));
    }
}

} // namespace

void button_start() {
    gpio_config_t cfg = {};
    cfg.pin_bit_mask = 1ULL << QR_BUTTON_PIN;
    cfg.mode = GPIO_MODE_INPUT;
    cfg.pull_up_en = GPIO_PULLUP_ENABLE;
    cfg.pull_down_en = GPIO_PULLDOWN_DISABLE;
    cfg.intr_type = GPIO_INTR_DISABLE;
    gpio_config(&cfg);
    xTaskCreate(button_task, "button", 2048, nullptr, tskIDLE_PRIORITY + 1, nullptr);
}

bool button_is_pressed() {
    return s_pressed;
}
