#pragma once

#include "driver/i2c_master.h"

// Adafruit INA260 high-side voltage/current/power sensor. Attaches as a
// second device on the OLED's existing I2C bus (see oled.cpp) rather than
// installing its own bus on the same physical port. Ported from
// Test_ESP32_C5_Robot_Peripherals/main/ina260.cpp.

// Adds the INA260 device to `bus` and confirms it's actually an INA260 by
// reading back the manufacturer ID register. Returns false (logs the error)
// if either step fails -- callers should treat that as "no current sensor
// present" rather than aborting the whole firmware. Only ever called once,
// from oled_status_start() (which owns the shared I2C bus).
bool ina260_init(i2c_master_bus_handle_t bus);

// True once ina260_init() has succeeded -- lets any file check availability
// without needing to call init itself or coordinate with whichever file did.
bool ina260_is_available();

// Reads all three measurement registers. Returns false (leaving
// *busVoltageV/*currentMa/*powerMw unchanged) on I2C error or if
// ina260_init() was never called/never succeeded.
bool ina260_read(float *busVoltageV, float *currentMa, float *powerMw);
