#include "encoders.hpp"
#include "board_pins.hpp"

#include "driver/pulse_cnt.h"
#include "esp_log.h"

namespace {

const char *TAG = "encoders";

// Hardware counter is 16-bit. These are the accumulation watch points:
// pcnt_unit_config_t.flags.accum_count folds the counter into a running
// total every time it reaches either one, so pcnt_unit_get_count() returns a
// value that keeps growing past +/-32767 instead of wrapping. Must stay well
// inside the int16 range and satisfy low_limit < 0 < high_limit.
constexpr int PCNT_LOW_LIMIT = -30000;
constexpr int PCNT_HIGH_LIMIT = 30000;

// Bring-up test only, so no target speed to size this against precisely --
// 1 us leaves ample margin against contact bounce/electrical noise for any
// hobby-motor encoder. Raise if the wiring proves noisy in practice.
constexpr uint32_t GLITCH_FILTER_NS = 1000;

pcnt_unit_handle_t g_unit[2] = {nullptr, nullptr};

} // namespace

void encoders_init() {
    for (int wheel = 0; wheel < 2; wheel++) {
        pcnt_unit_config_t unitConfig = {};
        unitConfig.low_limit = PCNT_LOW_LIMIT;
        unitConfig.high_limit = PCNT_HIGH_LIMIT;
        unitConfig.flags.accum_count = 1;
        ESP_ERROR_CHECK(pcnt_new_unit(&unitConfig, &g_unit[wheel]));

        pcnt_glitch_filter_config_t filter = {};
        filter.max_glitch_ns = GLITCH_FILTER_NS;
        ESP_ERROR_CHECK(pcnt_unit_set_glitch_filter(g_unit[wheel], &filter));

        gpio_num_t pinA = ENCODER_PIN[wheel][0];
        gpio_num_t pinB = ENCODER_PIN[wheel][1];

        // x4 quadrature decoding: channel A counts on every edge of A using
        // B's level to pick direction; channel B mirrors that using A's
        // level. 4 counts per full quadrature cycle.
        pcnt_chan_config_t chanAConfig = {};
        chanAConfig.edge_gpio_num = pinA;
        chanAConfig.level_gpio_num = pinB;
        pcnt_channel_handle_t chanA;
        ESP_ERROR_CHECK(pcnt_new_channel(g_unit[wheel], &chanAConfig, &chanA));
        ESP_ERROR_CHECK(pcnt_channel_set_edge_action(
            chanA, PCNT_CHANNEL_EDGE_ACTION_DECREASE, PCNT_CHANNEL_EDGE_ACTION_INCREASE));
        ESP_ERROR_CHECK(pcnt_channel_set_level_action(
            chanA, PCNT_CHANNEL_LEVEL_ACTION_KEEP, PCNT_CHANNEL_LEVEL_ACTION_INVERSE));

        pcnt_chan_config_t chanBConfig = {};
        chanBConfig.edge_gpio_num = pinB;
        chanBConfig.level_gpio_num = pinA;
        pcnt_channel_handle_t chanB;
        ESP_ERROR_CHECK(pcnt_new_channel(g_unit[wheel], &chanBConfig, &chanB));
        ESP_ERROR_CHECK(pcnt_channel_set_edge_action(
            chanB, PCNT_CHANNEL_EDGE_ACTION_INCREASE, PCNT_CHANNEL_EDGE_ACTION_DECREASE));
        ESP_ERROR_CHECK(pcnt_channel_set_level_action(
            chanB, PCNT_CHANNEL_LEVEL_ACTION_KEEP, PCNT_CHANNEL_LEVEL_ACTION_INVERSE));

        // Required for accum_count to do anything -- without watch points at
        // exactly these two values, the driver never folds the hardware
        // counter into the running total.
        ESP_ERROR_CHECK(pcnt_unit_add_watch_point(g_unit[wheel], PCNT_LOW_LIMIT));
        ESP_ERROR_CHECK(pcnt_unit_add_watch_point(g_unit[wheel], PCNT_HIGH_LIMIT));

        ESP_ERROR_CHECK(pcnt_unit_enable(g_unit[wheel]));
        ESP_ERROR_CHECK(pcnt_unit_clear_count(g_unit[wheel]));
        ESP_ERROR_CHECK(pcnt_unit_start(g_unit[wheel]));
    }

    ESP_LOGI(TAG, "PCNT: left A/B=GPIO%d/%d, right A/B=GPIO%d/%d, glitch filter %lu ns",
             ENCODER_PIN[0][0], ENCODER_PIN[0][1], ENCODER_PIN[1][0], ENCODER_PIN[1][1],
             (unsigned long) GLITCH_FILTER_NS);
}

void encoders_read(long out[2]) {
    for (int wheel = 0; wheel < 2; wheel++) {
        int count = 0;
        pcnt_unit_get_count(g_unit[wheel], &count);
        out[wheel] = (long) count * ENCODER_SIGN[wheel];
    }
}

void encoders_reset() {
    for (int wheel = 0; wheel < 2; wheel++) {
        pcnt_unit_clear_count(g_unit[wheel]);
    }
}
