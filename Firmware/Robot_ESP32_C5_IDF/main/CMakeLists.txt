# Full feature parity with Robot_ESP32_S3_IDF: local control, WiFi/web
# server/WebSocket, the S3-CAM UART link, and OTA.
idf_component_register(
    SRCS
        "main.cpp"
        "board_pins.hpp"
        "motors.cpp"
        "encoders.cpp"
        "control_task.cpp"
        "serial_console.cpp"
        "settings.cpp"
        "waypoints.cpp"
        "control_modes.cpp"
        "odometry.cpp"
        "breadcrumb.cpp"
        "log_task.cpp"
        "wifi_connect.cpp"
        "uart_link.cpp"
        "ping_diag.cpp"
        "oled.cpp"
        "ina260.cpp"
        "button.cpp"
        "qr_display.cpp"
        "web_server.cpp"
        "ws_broadcast.cpp"
        "diagnostics.cpp"
        "watchdog.cpp"
        "littlefs_init.cpp"
        "ota.cpp"
    INCLUDE_DIRS "."
    REQUIRES
        driver          # gpio, ledc, pulse_cnt, gptimer
        esp_driver_gpio
        esp_driver_ledc
        esp_driver_pcnt
        esp_driver_gptimer
        esp_driver_i2c
        esp_driver_uart
        nvs_flash
        esp_timer
        lwip
        esp_wifi
        esp_event
        esp_netif
        esp_http_server
        app_update      # esp_ota_ops.h
        esp_partition
        cjson           # espressif/cjson managed component
        mdns            # espressif/mdns managed component
        ssd1306         # nopnop2002/ssd1306 managed component
        qrcode          # espressif/qrcode managed component
        joltwallet__littlefs   # joltwallet/littlefs's actual registered component name
)

littlefs_create_partition_image(storage littlefs_image FLASH_IN_PROJECT)
