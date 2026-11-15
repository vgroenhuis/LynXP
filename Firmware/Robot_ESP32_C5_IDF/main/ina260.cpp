#include "ina260.hpp"
#include "board_pins.hpp"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

namespace {

const char *TAG = "ina260";

// Register map (TI INA260 datasheet).
constexpr uint8_t REG_CONFIG = 0x00;
constexpr uint8_t REG_CURRENT = 0x01;     // signed, 1.25 mA/LSB
constexpr uint8_t REG_BUS_VOLTAGE = 0x02; // unsigned, 1.25 mV/LSB
constexpr uint8_t REG_POWER = 0x03;       // unsigned, 10 mW/LSB
constexpr uint8_t REG_MANUFACTURER_ID = 0xFE;
constexpr uint16_t MANUFACTURER_ID_EXPECTED = 0x5449; // "TI"

// Configuration (1.5.53): continuous voltage + current, 140 us conversions,
// averaged over 4 -- a fresh reading every ~1.1 ms, so a dip or a spike of a
// few ms (a servo starting or reversing) shows up in the min/max below. The
// power-on default (one 1.1 ms conversion each, no averaging) gave about the
// same noise but was only ever read a few times a second.
//   bits 14-12: 110 (fixed) | AVG 001 = 4 | VBUSCT 000 = 140 us | ISHCT 000 = 140 us | MODE 111
constexpr uint16_t CONFIG_FAST = 0x6207;

// INA260 supports I2C fast mode (400 kHz); matches the OLED's bus speed, and
// the new I2C driver lets each device on a shared bus request its own speed.
constexpr uint32_t I2C_FREQ_HZ = 400000;
constexpr uint32_t I2C_TIMEOUT_MS = 100;

// The sampler: voltage and current every 5 ms, their extremes kept until the
// telemetry takes them (ina260_take_extremes).
constexpr TickType_t SAMPLE_PERIOD = pdMS_TO_TICKS(5);

i2c_master_dev_handle_t g_dev = nullptr;
bool g_available = false;

portMUX_TYPE g_extMux = portMUX_INITIALIZER_UNLOCKED;
float g_vMin, g_vMax, g_iMin, g_iMax;
int g_samples = 0;

bool read_register16(uint8_t reg, uint16_t *value, bool logErrors = true) {
    uint8_t rx[2];
    esp_err_t err = i2c_master_transmit_receive(g_dev, &reg, 1, rx, sizeof(rx),
                                                 I2C_TIMEOUT_MS);
    if (err != ESP_OK) {
        if (logErrors) ESP_LOGE(TAG, "read reg 0x%02X failed: %s", reg, esp_err_to_name(err));
        return false;
    }
    *value = ((uint16_t) rx[0] << 8) | rx[1]; // big-endian on the wire
    return true;
}

bool write_register16(uint8_t reg, uint16_t value) {
    uint8_t tx[3] = {reg, (uint8_t) (value >> 8), (uint8_t) (value & 0xFF)};
    esp_err_t err = i2c_master_transmit(g_dev, tx, sizeof(tx), I2C_TIMEOUT_MS);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "write reg 0x%02X failed: %s", reg, esp_err_to_name(err));
        return false;
    }
    return true;
}

void sampler_task(void *) {
    int failures = 0;
    TickType_t wake = xTaskGetTickCount();
    for (;;) {
        uint16_t rawV, rawI;
        if (read_register16(REG_BUS_VOLTAGE, &rawV, false) && read_register16(REG_CURRENT, &rawI, false)) {
            failures = 0;
            float v = rawV * 1.25f / 1000.0f;
            float i = (int16_t) rawI * 1.25f;
            taskENTER_CRITICAL(&g_extMux);
            if (g_samples == 0) {
                g_vMin = g_vMax = v;
                g_iMin = g_iMax = i;
            } else {
                if (v < g_vMin) g_vMin = v;
                if (v > g_vMax) g_vMax = v;
                if (i < g_iMin) g_iMin = i;
                if (i > g_iMax) g_iMax = i;
            }
            g_samples++;
            taskEXIT_CRITICAL(&g_extMux);
        } else if (++failures == 20) {
            ESP_LOGW(TAG, "sampler: 20 failed reads in a row (backing off)");
        }
        if (failures >= 20) {
            vTaskDelay(pdMS_TO_TICKS(500)); // (a bus problem: don't hammer it)
            wake = xTaskGetTickCount();
        } else {
            vTaskDelayUntil(&wake, SAMPLE_PERIOD);
        }
    }
}

} // namespace

bool ina260_init(i2c_master_bus_handle_t bus) {
    i2c_device_config_t devCfg = {};
    devCfg.dev_addr_length = I2C_ADDR_BIT_LEN_7;
    devCfg.device_address = INA260_I2C_ADDR;
    devCfg.scl_speed_hz = I2C_FREQ_HZ;
    esp_err_t err = i2c_master_bus_add_device(bus, &devCfg, &g_dev);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "i2c_master_bus_add_device failed: %s", esp_err_to_name(err));
        return false;
    }

    uint16_t id = 0;
    if (!read_register16(REG_MANUFACTURER_ID, &id) || id != MANUFACTURER_ID_EXPECTED) {
        ESP_LOGE(TAG, "manufacturer ID mismatch: got 0x%04X, expected 0x%04X (wiring/address?)",
                 id, MANUFACTURER_ID_EXPECTED);
        return false;
    }

    // (a failed write just leaves the power-on defaults: still correct readings, only slower)
    write_register16(REG_CONFIG, CONFIG_FAST);

    g_available = true;
    ESP_LOGI(TAG, "INA260 found at 0x%02X", INA260_I2C_ADDR);
    if (xTaskCreate(sampler_task, "ina260", 2560, nullptr, tskIDLE_PRIORITY + 1, nullptr) != pdPASS) {
        ESP_LOGE(TAG, "sampler task not started (min/max won't be reported)");
    }
    return true;
}

bool ina260_is_available() {
    return g_available;
}

bool ina260_read(float *busVoltageV, float *currentMa, float *powerMw) {
    if (!g_available) return false;

    uint16_t rawVoltage, rawCurrentBits, rawPower;

    if (!read_register16(REG_BUS_VOLTAGE, &rawVoltage)) return false;
    if (!read_register16(REG_CURRENT, &rawCurrentBits)) return false;
    if (!read_register16(REG_POWER, &rawPower)) return false;

    // Current register is signed (negative = reverse flow); reinterpret the
    // raw bit pattern as two's complement rather than pointer-casting the
    // uint16_t* read buffer, which would violate strict aliasing.
    int16_t rawCurrent = (int16_t) rawCurrentBits;

    *busVoltageV = rawVoltage * 1.25f / 1000.0f;
    *currentMa = rawCurrent * 1.25f;
    *powerMw = rawPower * 10.0f;
    return true;
}

bool ina260_take_extremes(float *vMin, float *vMax, float *iMin, float *iMax) {
    bool any;
    taskENTER_CRITICAL(&g_extMux);
    any = g_samples > 0;
    if (any) {
        *vMin = g_vMin;
        *vMax = g_vMax;
        *iMin = g_iMin;
        *iMax = g_iMax;
    }
    g_samples = 0;
    taskEXIT_CRITICAL(&g_extMux);
    return any;
}
