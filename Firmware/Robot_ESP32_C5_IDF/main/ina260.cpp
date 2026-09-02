#include "ina260.hpp"
#include "board_pins.hpp"

#include "esp_log.h"

namespace {

const char *TAG = "ina260";

// Register map (TI INA260 datasheet). Default power-on config (continuous
// shunt+bus conversion) is used as-is -- REG_CONFIG is never written.
constexpr uint8_t REG_CURRENT = 0x01;     // signed, 1.25 mA/LSB
constexpr uint8_t REG_BUS_VOLTAGE = 0x02; // unsigned, 1.25 mV/LSB
constexpr uint8_t REG_POWER = 0x03;       // unsigned, 10 mW/LSB
constexpr uint8_t REG_MANUFACTURER_ID = 0xFE;
constexpr uint16_t MANUFACTURER_ID_EXPECTED = 0x5449; // "TI"

// INA260 supports I2C fast mode (400 kHz); matches the OLED's bus speed, and
// the new I2C driver lets each device on a shared bus request its own speed.
constexpr uint32_t I2C_FREQ_HZ = 400000;
constexpr uint32_t I2C_TIMEOUT_MS = 100;

i2c_master_dev_handle_t g_dev = nullptr;
bool g_available = false;

bool read_register16(uint8_t reg, uint16_t *value) {
    uint8_t rx[2];
    esp_err_t err = i2c_master_transmit_receive(g_dev, &reg, 1, rx, sizeof(rx),
                                                 I2C_TIMEOUT_MS);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "read reg 0x%02X failed: %s", reg, esp_err_to_name(err));
        return false;
    }
    *value = ((uint16_t) rx[0] << 8) | rx[1]; // big-endian on the wire
    return true;
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

    g_available = true;
    ESP_LOGI(TAG, "INA260 found at 0x%02X", INA260_I2C_ADDR);
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
