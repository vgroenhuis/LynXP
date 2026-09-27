#include "serial_console.hpp"
#include "board_pins.hpp"
#include "control_task.hpp"
#include "control_modes.hpp"
#include "odometry.hpp"
#include "motors.hpp"
#include "settings.hpp"
#include "waypoints.hpp"
#include "wifi_connect.hpp"
#include "wifi_networks.hpp"

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "driver/uart.h"
#include "driver/uart_vfs.h"

#include <cstdio>
#include <cstring>
#include <cstdlib>
#include <algorithm>

namespace {

const char *TAG = "console";

// Next whitespace-separated token from *p into out; "double quotes" keep
// spaces (SSIDs may contain them). False if there's no token left.
bool next_token(const char **p, char *out, size_t outLen) {
    const char *s = *p;
    while (*s == ' ') s++;
    if (*s == '\0') return false;
    size_t n = 0;
    if (*s == '"') {
        s++;
        while (*s != '\0' && *s != '"') {
            if (n + 1 < outLen) out[n++] = *s;
            s++;
        }
        if (*s == '"') s++;
    } else {
        while (*s != '\0' && *s != ' ') {
            if (n + 1 < outLen) out[n++] = *s;
            s++;
        }
    }
    out[n] = '\0';
    *p = s;
    return true;
}

// "wifi ..." -- manage saved networks from the serial console, e.g. to get a
// robot with no phone handy (or no working OLED for the hotspot password)
// online. Note the console reads input on the UART0 pins, not the native USB
// port the logs also appear on.
void handle_wifi_command(const char *args) {
    char verb[12], ssid[34], password[66];
    if (!next_token(&args, verb, sizeof(verb))) verb[0] = '\0';

    if (std::strcmp(verb, "list") == 0 || verb[0] == '\0') {
        WifiStatus st;
        wifi_get_status(&st);
        printf("connected=%d ssid=\"%s\" ip=%s rssi=%d | hotspot %s \"%s\" (open) | prefer 5 GHz %s\n", st.connected,
               st.ssid, st.ip, st.rssi, st.apActive ? "ON" : "off", wifi_ap_get_ssid(), wifi_get_prefer_5ghz() ? "on" : "off");
        size_t n = wifi_networks_count();
        for (size_t i = 0; i < n; i++) {
            WifiCredential c;
            if (wifi_networks_get(i, &c)) printf("  saved: \"%s\"%s\n", c.ssid, c.password[0] ? "" : " (open)");
        }
        if (n == 0) printf("  no saved networks\n");
    } else if (std::strcmp(verb, "add") == 0 && next_token(&args, ssid, sizeof(ssid))) {
        if (!next_token(&args, password, sizeof(password))) password[0] = '\0';
        bool ok = wifi_networks_add(ssid, password);
        printf("wifi add \"%s\" -> %s\n", ssid, ok ? "saved" : "FAILED (too long / list full)");
        if (ok && !wifi_is_connected()) wifi_request_connect(ssid);
    } else if (std::strcmp(verb, "forget") == 0 && next_token(&args, ssid, sizeof(ssid))) {
        bool ok = wifi_networks_remove(ssid);
        printf("wifi forget \"%s\" -> %s\n", ssid, ok ? "forgotten" : "not saved");
        if (ok) wifi_networks_changed();
    } else if (std::strcmp(verb, "scan") == 0) {
        char mode[12] = "";
        next_token(&args, mode, sizeof(mode));
        int m = std::strcmp(mode, "passive") == 0 ? 1 : std::strcmp(mode, "long") == 0 ? 2 : 0;
        wifi_request_debug_scan(m);
        printf("wifi scan (%s) requested -- results follow in the log\n", m == 1 ? "passive" : m == 2 ? "long" : "normal");
    } else if (std::strcmp(verb, "connect") == 0 && next_token(&args, ssid, sizeof(ssid))) {
        bool ok = wifi_networks_find(ssid, nullptr);
        if (ok) wifi_request_connect(ssid);
        printf("wifi connect \"%s\" -> %s\n", ssid, ok ? "switching" : "not saved");
    } else {
        printf("usage: wifi list | wifi add <ssid> [password] | wifi forget <ssid> | wifi connect <ssid>"
               "  (quote an SSID with spaces)\n");
    }
}

void handle_line(const char *line) {
    int mode_val;
    float x, y;
    float delta;
    int us;

    // Matches Robot_Pico2W_SDK/src/main.cpp's handle_test_serial_command()
    // command-for-command: this is the same stand-in for the WebSocket
    // control channel, letting every mode be exercised before web_server.cpp
    // exists (milestone D). Superseded by real WS commands once it does, but
    // kept afterwards as a bench tool independent of Wi-Fi being up.
    //
    // NOTE: milestone B's raw "m <left> <right>" command is gone -- now that
    // controlModesTick() runs every tick, any direct motorPower[] write gets
    // overwritten within 1ms by whichever mode is active. "j"/"mode"/etc.
    // below all go through the real control_modes.cpp state instead.
    if (std::strcmp(line, "wifi") == 0 || std::strncmp(line, "wifi ", 5) == 0) {
        handle_wifi_command(line + 4);

    } else if (std::sscanf(line, "mode %d", &mode_val) == 1) {
        settings.mode = mode_val;
        printf("mode=%d\n", settings.mode);

    } else if (std::sscanf(line, "j %f %f", &x, &y) == 2) {
        V1[0] = y + x;
        V1[1] = y - x;
        printf("V1=(%.2f, %.2f)\n", V1[0], V1[1]);

    } else if (std::strcmp(line, "lab1 forward") == 0 || std::strcmp(line, "lab1 backward") == 0) {
        lab1Forward = (std::strcmp(line, "lab1 forward") == 0);
        lab1StartTimeMs = (unsigned long) (esp_timer_get_time() / 1000);
        printf(lab1Forward ? "Lab1 FORWARD\n" : "Lab1 BACKWARD\n");

    } else if (std::sscanf(line, "lab2setpoint %f", &delta) == 1) {
        lab2SetpointM[0] += delta;
        lab2SetpointM[1] += delta;
        printf("lab2 setpoints=(%.3f, %.3f)\n", lab2SetpointM[0], lab2SetpointM[1]);

    } else if (std::strcmp(line, "lab2turn left") == 0 || std::strcmp(line, "lab2turn right") == 0) {
        applyLab2Turn(std::strcmp(line, "lab2turn left") == 0);
        printf("lab2 setpoints=(%.3f, %.3f)\n", lab2SetpointM[0], lab2SetpointM[1]);

    } else if (std::sscanf(line, "goto %f %f", &x, &y) == 2) {
        goalX_m = x;
        goalY_m = y;
        settings.mode = GOTO_POSITION_CONTROL;
        gotoControllerNeedsInitFlag = true;
        printf("goto target=(%.3f, %.3f)\n", goalX_m, goalY_m);

    } else if (std::strcmp(line, "reset_encoders") == 0) {
        resetEncodersFlag = true;
        printf("Encoders reset requested\n");

    } else if (std::strcmp(line, "reset_pose") == 0) {
        resetPoseX_m = resetPoseY_m = resetPoseTheta_rad = 0.0f;
        resetPoseFlag = true;
        printf("Pose reset requested\n");

    } else if (std::strcmp(line, "logging on") == 0 || std::strcmp(line, "logging off") == 0) {
        settings.loggingEnabled = (std::strcmp(line, "logging on") == 0);
        printf("logging=%d\n", settings.loggingEnabled);

    } else if (std::strcmp(line, "pose") == 0) {
        printf("pose x=%.3f y=%.3f theta=%.3f\n", poseX_m, poseY_m, poseThetaRad);

    } else if (std::strcmp(line, "mp") == 0) {
        printf("V1=(%.3f,%.3f) motorPower=[%d,%d] wheelVelRevPerSec=[%.4f,%.4f] "
               "gotoWheelVelSetpointRevPerSec=[%.4f,%.4f] mode=%d\n",
               V1[0], V1[1], motorPower[WHEEL_LEFT], motorPower[WHEEL_RIGHT],
               wheelVelRevPerSec[0], wheelVelRevPerSec[1],
               gotoWheelVelSetpointRevPerSec[0], gotoWheelVelSetpointRevPerSec[1], settings.mode);

    } else if (std::strcmp(line, "stop") == 0) {
        stopAllMotion();
        printf("stopped\n");

    } else if (std::sscanf(line, "servo %d", &us) == 1) {
        servo_set_pulse_us((uint16_t) std::clamp(us, 0, 20000));
        printf("servo pulse=%d us, duty=%lu\n", us, (unsigned long) servo_last_duty());

    } else if (std::strcmp(line, "enc") == 0) {
        printf("encoderCount_steps=[%ld, %ld]\n",
               encoderCount_steps[WHEEL_LEFT], encoderCount_steps[WHEEL_RIGHT]);

    } else if (std::strcmp(line, "ticks") == 0) {
        printf("controlTickCount=%lu missedTicks=%lu\n",
               (unsigned long) g_controlTickCount, (unsigned long) g_controlMissedTicks);

    } else if (std::strcmp(line, "settings show") == 0) {
        printf("settingsVersion=%lu mode=%d kp=%.3f ki=%.3f kd=%.3f wheelDiameterMm=%.1f "
               "wheelbaseMm=%.1f maxMotorPower=%d\n",
               (unsigned long) settings.settingsVersion, settings.mode, settings.kp, settings.ki,
               settings.kd, settings.wheelDiameterMm, settings.wheelbaseMm, settings.maxMotorPower);

    } else if (std::sscanf(line, "settings set kp %f", &x) == 1) {
        // RAM only -- "settings save" persists it. Exercises one float field
        // end-to-end without needing the full /set HTTP surface, which
        // doesn't exist until milestone D.
        settings.kp = x;
        printf("settings.kp=%.3f (not yet saved)\n", settings.kp);

    } else if (std::strcmp(line, "settings save") == 0) {
        printf("saveSettings() -> %s\n", saveSettings() ? "OK" : "FAILED");

    } else if (std::strcmp(line, "settings load") == 0) {
        printf("loadSettings() -> %s\n", loadSettings() ? "OK" : "FAILED (defaults unchanged)");

    } else if (std::strcmp(line, "settings default") == 0) {
        applyDefaultSettings();
        printf("applyDefaultSettings() done (not yet saved)\n");

    } else if (std::strcmp(line, "wp save") == 0) {
        // Fixed test fixture rather than typed input: the real payload comes
        // from a browser POST body (up to 4096 bytes) once web_server.cpp
        // exists in milestone D, which the 128-byte console line buffer
        // couldn't hold anyway. This just proves the NVS round-trip.
        static const char testJson[] = "[{\"name\":\"Test\",\"x\":1.5,\"y\":2.5,\"heading\":0}]";
        bool ok = saveWaypointsJson(testJson, sizeof(testJson) - 1);
        printf("saveWaypointsJson() -> %s\n", ok ? "OK" : "FAILED");

    } else if (std::strcmp(line, "wp load") == 0) {
        static char buf[WAYPOINTS_JSON_MAX_LEN];
        loadWaypointsJson(buf, sizeof(buf));
        printf("waypoints=%s\n", buf);

    } else {
        printf("Unknown test command: %s\n", line);
    }
}

void print_help() {
    printf("commands: mode <n> | j <x> <y> | lab1 forward|backward | lab2setpoint <d> | "
           "lab2turn left|right | goto <x> <y> | reset_encoders | reset_pose | "
           "logging on|off | pose | mp | stop | servo <us> | enc | ticks | "
           "settings show|save|load|default|set kp <v> | wp save|load | "
           "wifi list|add <ssid> [pw]|forget <ssid>|connect <ssid>\n");
}

void console_task(void *arg) {
    (void) arg;
    char line[192]; // room for "wifi add <32-char ssid> <64-char key>"

    printf("LynXP ESP32-C5: bench console ready.\n");
    print_help();

    while (true) {
        if (fgets(line, sizeof(line), stdin) == nullptr) {
            vTaskDelay(pdMS_TO_TICKS(50));
            continue;
        }
        size_t len = std::strlen(line);
        while (len > 0 && (line[len - 1] == '\n' || line[len - 1] == '\r')) {
            line[--len] = '\0';
        }
        if (len == 0) {
            continue;
        }
        handle_line(line);
    }
}

} // namespace

void serial_console_start() {
    // ESP-IDF's UART console defaults to uart_vfs_dev_use_nonblocking():
    // read() returns whatever's in the RX FIFO right now, even zero bytes,
    // rather than blocking for more. A human typing one key at a time hits
    // this directly -- read() gets the single byte just typed, then (before
    // the next keystroke arrives) returns 0 again, which fgets() treats as
    // EOF and returns the partial line early. Confirmed on this board:
    // typing "e" alone produced "Unknown test command: e" immediately,
    // while pasting "enc" (arriving as one fast burst, no gap for a
    // zero-byte read to land in) worked correctly. The original S3 firmware
    // never hit this because it used the native USB-Serial-JTAG console
    // instead of plain UART0, which doesn't default to this mode. Switching
    // to the real interrupt-driven driver makes reads properly block until
    // a full line (up to the newline) has actually arrived.
    // CONFIG_ESP_CONSOLE_UART_NUM is a plain int Kconfig macro; C++ (unlike
    // C) won't implicitly convert that to uart_port_t for the driver calls
    // below, so it needs an explicit cast.
    constexpr uart_port_t CONSOLE_UART = (uart_port_t) CONFIG_ESP_CONSOLE_UART_NUM;

    setvbuf(stdin, nullptr, _IONBF, 0);
    uart_vfs_dev_port_set_rx_line_endings(CONSOLE_UART, ESP_LINE_ENDINGS_CR);
    uart_vfs_dev_port_set_tx_line_endings(CONSOLE_UART, ESP_LINE_ENDINGS_CRLF);

    uart_config_t uartConfig = {};
    uartConfig.baud_rate = CONFIG_ESP_CONSOLE_UART_BAUDRATE;
    uartConfig.data_bits = UART_DATA_8_BITS;
    uartConfig.parity = UART_PARITY_DISABLE;
    uartConfig.stop_bits = UART_STOP_BITS_1;
    uartConfig.source_clk = UART_SCLK_DEFAULT;
    ESP_ERROR_CHECK(uart_driver_install(CONSOLE_UART, 256, 0, 0, nullptr, 0));
    ESP_ERROR_CHECK(uart_param_config(CONSOLE_UART, &uartConfig));
    uart_vfs_dev_use_driver(CONSOLE_UART);

    BaseType_t ok = xTaskCreate(console_task, "console", 4096, nullptr, 3, nullptr);
    if (ok != pdPASS) {
        ESP_LOGE(TAG, "xTaskCreate failed");
    }
}
