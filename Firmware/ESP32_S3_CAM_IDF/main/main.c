// XIAO ESP32S3 Sense: low-latency MJPEG stream over WiFi for remote robot control.
#include <string.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <netinet/in.h>
#include <netinet/tcp.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"
#include "freertos/semphr.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_http_server.h"
#include "esp_heap_caps.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "esp_attr.h"
#include "nvs_flash.h"
#include "esp_camera.h"
#include "driver/uart.h"
#include "nvs.h"
#include "esp_ota_ops.h"
#include "esp_app_desc.h"

static const char *TAG = "cam";

// XIAO ESP32S3 Sense camera pin map (OV3660). Confirmed against Espressif's
// arduino-esp32 camera_pins.h, CAMERA_MODEL_XIAO_ESP32S3 block.
#define PWDN_GPIO_NUM  -1
#define RESET_GPIO_NUM -1
#define XCLK_GPIO_NUM  10
#define SIOD_GPIO_NUM  40
#define SIOC_GPIO_NUM  39
#define Y9_GPIO_NUM    48
#define Y8_GPIO_NUM    11
#define Y7_GPIO_NUM    12
#define Y6_GPIO_NUM    14
#define Y5_GPIO_NUM    16
#define Y4_GPIO_NUM    18
#define Y3_GPIO_NUM    17
#define Y2_GPIO_NUM    15
#define VSYNC_GPIO_NUM 38
#define HREF_GPIO_NUM  47
#define PCLK_GPIO_NUM  13

static char s_mac_str[18];
static char s_ip_str[16] = "0.0.0.0";

// Diagnostics for the STAT UART line below -- see its own comment for what
// each one is trying to distinguish (WiFi vs. power/brownout vs. camera-bus
// noise as the cause of a stuttering/dead stream).
//
// RTC_DATA_ATTR: survives a brownout/watchdog/panic/software reset (exactly
// the reboots this is trying to count), but re-zeroes on a true power cycle
// (VDD fully off then back on) -- "reboots since this was last plugged in"
// is the useful number here, not a lifetime total that would need NVS wear
// to persist.
RTC_DATA_ATTR static uint32_t s_reboot_count = 0;
// Count of esp_camera_fb_get() returning NULL -- unlike a WiFi drop or a
// full reset, a camera/DVP-bus glitch (e.g. from nearby motor EMI) can stall
// frame capture without disturbing the network link or crashing the chip at
// all, so this is the one field that can catch that case specifically.
// Deliberately NOT RTC-persisted: it's a per-boot count, and a fresh boot
// having zero stutters so far is exactly right.
static volatile uint32_t s_cam_fail_count = 0;

// Frame-interval and network-send timing -- unlike camfail (a hard
// esp_camera_fb_get() NULL), these catch a frame that succeeds but arrives
// LATE, either because the capture side stalled (camera/DVP bus contention)
// or because pushing the previous frame out over the socket took unusually
// long (network-side delay actually affecting the live stream, not a
// synthetic ping -- see diag.html's whole reason for existing). "Slow"
// thresholds are generous (a normal frame at even 10 fps is 100ms apart) so
// only genuine multi-frame-period stalls count, not routine jitter.
#define FRAME_INTERVAL_SLOW_MS 200
#define SEND_SLOW_MS 200

static volatile uint32_t s_frame_count = 0;
static volatile uint32_t s_last_frame_interval_ms = 0;
static volatile uint32_t s_max_frame_interval_ms = 0;
static volatile uint32_t s_slow_frame_count = 0;

// Written by whichever stream_client_task most recently pushed a frame --
// with normally at most one viewer this is that viewer's timing; with
// several, it's just whichever sent last, good enough for "is the network
// currently struggling" without the bookkeeping of per-client stats.
static volatile uint32_t s_last_send_ms = 0;
static volatile uint32_t s_max_send_ms = 0;
static volatile uint32_t s_slow_send_count = 0;

static void status_uart_send(void);
static int get_active_clients(void);
static void hex_encode(const char *in, char *out, size_t out_len);

// Full esp_reset_reason_t as of IDF v6.1 -- notably including USB/JTAG,
// which are the common, benign cases on this board during development (its
// native USB peripheral is both the flashing interface and the RTS-toggle
// reset line a serial monitor uses), so they shouldn't get lumped into a
// generic "UNKNOWN" that would otherwise look like a real problem.
static const char *reset_reason_str(esp_reset_reason_t reason) {
    switch (reason) {
        case ESP_RST_UNKNOWN:    return "UNKNOWN";
        case ESP_RST_POWERON:    return "POWERON";
        case ESP_RST_EXT:        return "EXT";
        case ESP_RST_SW:         return "SW";
        case ESP_RST_PANIC:      return "PANIC";
        case ESP_RST_INT_WDT:    return "INT_WDT";
        case ESP_RST_TASK_WDT:   return "TASK_WDT";
        case ESP_RST_WDT:        return "WDT";
        case ESP_RST_DEEPSLEEP:  return "DEEPSLEEP";
        case ESP_RST_BROWNOUT:   return "BROWNOUT";
        case ESP_RST_SDIO:       return "SDIO";
        case ESP_RST_USB:        return "USB";
        case ESP_RST_JTAG:       return "JTAG";
        case ESP_RST_EFUSE:      return "EFUSE";
        case ESP_RST_PWR_GLITCH: return "PWR_GLITCH";
        case ESP_RST_CPU_LOCKUP: return "CPU_LOCKUP";
        default:                 return "UNRECOGNIZED";
    }
}

// ---------------------------------------------------------------------------
// WiFi. No compiled-in credentials: the robot (ESP32-C5) owns the list of
// networks and its setup UI, and tells this camera which network to join
// over the status UART ("WIFI ssid=<hex> pass=<hex>", see
// status_uart_rx_task()) whenever the camera isn't on the same network as
// the robot. The camera remembers every network it's been given (most
// recent first, in NVS), so after a reboot it rejoins by itself without
// waiting for the robot -- and still works standalone on USB for testing.
//
// This S3 is 2.4 GHz only; the robot knows that and won't send a 5 GHz-only
// network (its own C5 radio does both bands).
// ---------------------------------------------------------------------------

#define CAM_WIFI_MAX 10
#define WIFI_CONNECT_TIMEOUT_MS 15000
#define WIFI_RETRY_INTERVAL_MS 3000

typedef struct {
    char ssid[33];
    char pass[65];
} cam_wifi_net_t;

#define WIFI_CONNECTED_BIT BIT0
#define WIFI_FAILED_BIT    BIT1
#define WIFI_PUSH_BIT      BIT2  // the robot sent a network to switch to
#define WIFI_SCAN_BIT      BIT3  // the robot asked what networks this camera can hear
#define SCAN_PASSIVE_MS    150   // listen-only channels need to catch at least one ~102 ms beacon
#define SCAN_REPORT_MAX    30

static void status_uart_write(const char *line, int len);
static void ota_mark_valid_once(void);

static EventGroupHandle_t s_wifi_event_group;
static SemaphoreHandle_t s_wifi_lock;
static cam_wifi_net_t s_nets[CAM_WIFI_MAX]; // most recently used/pushed first
static int s_net_count = 0;
static volatile bool s_wifi_connected = false;
static char s_attempt_ssid[33] = "";
static char s_connected_ssid[33] = "";
static char s_pending_ssid[33] = "";       // set by a push; wifi_task switches to it

static void copy_str(char *dst, size_t dst_len, const char *src) {
    size_t n = strnlen(src, dst_len - 1);
    memcpy(dst, src, n);
    dst[n] = '\0';
}

// wifi_config_t's ssid[32]/password[64] aren't NUL-terminated when full.
static void copy_field(uint8_t *dst, size_t dst_len, const char *src) {
    memset(dst, 0, dst_len);
    size_t n = strlen(src);
    memcpy(dst, src, n < dst_len ? n : dst_len);
}

static void nets_save_locked(void) {
    nvs_handle_t h;
    if (nvs_open("camwifi", NVS_READWRITE, &h) != ESP_OK) return;
    if (s_net_count > 0) {
        nvs_set_blob(h, "nets", s_nets, s_net_count * sizeof(cam_wifi_net_t));
    } else {
        nvs_erase_key(h, "nets");
    }
    nvs_commit(h);
    nvs_close(h);
}

// Moves (or inserts) a network to the front of the list. Only writes flash
// if something actually changed. Returns true if the list changed.
static bool nets_promote_locked(const char *ssid, const char *pass) {
    if (s_net_count > 0 && strcmp(s_nets[0].ssid, ssid) == 0 && strcmp(s_nets[0].pass, pass) == 0) return false;
    cam_wifi_net_t entry = {0};
    copy_str(entry.ssid, sizeof(entry.ssid), ssid);
    copy_str(entry.pass, sizeof(entry.pass), pass);
    int existing = -1;
    for (int i = 0; i < s_net_count; i++) {
        if (strcmp(s_nets[i].ssid, ssid) == 0) { existing = i; break; }
    }
    int shift_end = existing >= 0 ? existing : (s_net_count < CAM_WIFI_MAX ? s_net_count++ : CAM_WIFI_MAX - 1);
    memmove(&s_nets[1], &s_nets[0], shift_end * sizeof(cam_wifi_net_t));
    s_nets[0] = entry;
    nets_save_locked();
    return true;
}

// Loads the remembered list. On the very first boot of this firmware the
// list doesn't exist yet: seed it with whatever network the WiFi driver last
// used (it persists that itself) -- i.e. the one the old hardcoded-credentials
// firmware was on -- so updating doesn't knock the camera offline.
static void nets_load(void) {
    nvs_handle_t h;
    size_t len = sizeof(s_nets);
    bool found = false;
    if (nvs_open("camwifi", NVS_READONLY, &h) == ESP_OK) {
        found = nvs_get_blob(h, "nets", s_nets, &len) == ESP_OK;
        uint8_t migrated = 0;
        if (nvs_get_u8(h, "migrated", &migrated) == ESP_OK && migrated) found = true;
        nvs_close(h);
    }
    s_net_count = found ? (int) (len / sizeof(cam_wifi_net_t)) : 0;
    for (int i = 0; i < s_net_count; i++) {
        s_nets[i].ssid[32] = '\0';
        s_nets[i].pass[64] = '\0';
    }

    if (!found) {
        wifi_config_t cfg = {0};
        if (esp_wifi_get_config(WIFI_IF_STA, &cfg) == ESP_OK && cfg.sta.ssid[0] != '\0') {
            char ssid[33] = {0}, pass[65] = {0};
            memcpy(ssid, cfg.sta.ssid, sizeof(cfg.sta.ssid));
            memcpy(pass, cfg.sta.password, sizeof(cfg.sta.password));
            nets_promote_locked(ssid, pass);
            ESP_LOGI(TAG, "Imported last-used network \"%s\"", ssid);
        }
        if (nvs_open("camwifi", NVS_READWRITE, &h) == ESP_OK) {
            nvs_set_u8(h, "migrated", 1);
            nvs_commit(h);
            nvs_close(h);
        }
    }
    ESP_LOGI(TAG, "%d remembered network(s)", s_net_count);
}

// Called from the UART RX task when the robot sends a network.
static void wifi_handle_push(const char *ssid, const char *pass) {
    if (ssid[0] == '\0') return;
    xSemaphoreTake(s_wifi_lock, portMAX_DELAY);
    bool changed = nets_promote_locked(ssid, pass);
    bool switch_needed = !s_wifi_connected || strcmp(s_connected_ssid, ssid) != 0;
    if (switch_needed) copy_str(s_pending_ssid, sizeof(s_pending_ssid), ssid);
    xSemaphoreGive(s_wifi_lock);
    if (switch_needed) {
        ESP_LOGI(TAG, "Robot says: join \"%s\"%s", ssid, changed ? " (new/updated)" : "");
        xEventGroupSetBits(s_wifi_event_group, WIFI_PUSH_BIT);
    }
}

static void wifi_event_handler(void *arg, esp_event_base_t event_base,
                                int32_t event_id, void *event_data) {
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *event = (wifi_event_sta_disconnected_t *)event_data;
        ESP_LOGW(TAG, "WiFi %s, reason=%d", s_wifi_connected ? "disconnected" : "connect failed", event->reason);
        s_wifi_connected = false;
        snprintf(s_ip_str, sizeof(s_ip_str), "0.0.0.0");
        xEventGroupSetBits(s_wifi_event_group, WIFI_FAILED_BIT);
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        snprintf(s_ip_str, sizeof(s_ip_str), IPSTR, IP2STR(&event->ip_info.ip));
        copy_str(s_connected_ssid, sizeof(s_connected_ssid), s_attempt_ssid);
        s_wifi_connected = true;
        ESP_LOGI(TAG, "Connected to %s - stream ready at http://%s/ (MJPEG on port 81)", s_connected_ssid, s_ip_str);
        status_uart_send(); // push the new IP to the C5 immediately instead of waiting for the next heartbeat
        ota_mark_valid_once(); // a freshly OTA'd image has now proven itself
        xEventGroupSetBits(s_wifi_event_group, WIFI_CONNECTED_BIT);
    }
}

static bool wifi_attempt(const char *ssid) {
    cam_wifi_net_t net = {0};
    bool known = false;
    xSemaphoreTake(s_wifi_lock, portMAX_DELAY);
    for (int i = 0; i < s_net_count; i++) {
        if (strcmp(s_nets[i].ssid, ssid) == 0) { net = s_nets[i]; known = true; break; }
    }
    if (known) copy_str(s_attempt_ssid, sizeof(s_attempt_ssid), ssid);
    xSemaphoreGive(s_wifi_lock);
    if (!known) return false;

    ESP_LOGI(TAG, "Connecting to WiFi: %s", net.ssid);
    wifi_config_t wifi_cfg = {0};
    copy_field(wifi_cfg.sta.ssid, sizeof(wifi_cfg.sta.ssid), net.ssid);
    copy_field(wifi_cfg.sta.password, sizeof(wifi_cfg.sta.password), net.pass);
    wifi_cfg.sta.threshold.authmode = net.pass[0] ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;

    xEventGroupClearBits(s_wifi_event_group, WIFI_CONNECTED_BIT | WIFI_FAILED_BIT);
    if (esp_wifi_set_config(WIFI_IF_STA, &wifi_cfg) != ESP_OK || esp_wifi_connect() != ESP_OK) return false;
    EventBits_t bits = xEventGroupWaitBits(s_wifi_event_group, WIFI_CONNECTED_BIT | WIFI_FAILED_BIT,
                                           pdFALSE, pdFALSE, pdMS_TO_TICKS(WIFI_CONNECT_TIMEOUT_MS));
    if ((bits & WIFI_CONNECTED_BIT) && s_wifi_connected) return true;
    esp_wifi_disconnect();
    return false;
}

// Scans, then tries the most recently used remembered network that's in
// range. A network pushed by the robot is tried straight away (no scan
// needed, so hidden networks work too). Retries forever, and rejoins after
// any later disconnect.
static const wifi_scan_config_t SCAN_CFG = {
    .show_hidden = false,
    .scan_type = WIFI_SCAN_TYPE_ACTIVE,
    .scan_time.active.min = 60,
    .scan_time.active.max = 120,
    .scan_time.passive = SCAN_PASSIVE_MS,
    .home_chan_dwell_time = WIFI_SCAN_HOME_CHANNEL_DWELL_DEFAULT_TIME,
};

// Scans and reports every network heard to the robot, one
// "AP ssid=<hex> rssi=<dBm> ch=<n> sec=<0|1>" line each (strongest access
// point per SSID), then "APEND". This camera's external antenna often hears
// 2.4 GHz networks the robot's own board antenna misses. While streaming,
// this briefly stalls the picture -- it only runs when asked.
static void scan_and_report(void) {
    uint16_t n = SCAN_REPORT_MAX;
    wifi_ap_record_t *records = malloc(n * sizeof(wifi_ap_record_t));
    int sent = 0;
    if (records && esp_wifi_scan_start(&SCAN_CFG, true) == ESP_OK &&
        esp_wifi_scan_get_ap_records(&n, records) == ESP_OK) {
        for (int i = 0; i < n; i++) {
            const char *ssid = (const char *)records[i].ssid;
            if (ssid[0] == '\0') continue;
            bool dup = false; // records come strongest first, so the first of each SSID wins
            for (int j = 0; j < i && !dup; j++) dup = strcmp((const char *)records[j].ssid, ssid) == 0;
            if (dup) continue;
            char hex[67];
            hex_encode(ssid, hex, sizeof(hex));
            char line[128];
            int len = snprintf(line, sizeof(line), "AP ssid=%s rssi=%d ch=%d sec=%d\n", hex, records[i].rssi,
                               records[i].primary, records[i].authmode != WIFI_AUTH_OPEN);
            status_uart_write(line, len);
            sent++;
        }
    }
    free(records);
    esp_wifi_clear_ap_list();
    status_uart_write("APEND\n", 6);
    ESP_LOGI(TAG, "Reported %d network(s) to the robot", sent);
}

static void wifi_task(void *arg) {
    while (true) {
        if (!s_wifi_connected) {
            char target[33] = "";
            xSemaphoreTake(s_wifi_lock, portMAX_DELAY);
            copy_str(target, sizeof(target), s_pending_ssid);
            s_pending_ssid[0] = '\0';
            int count = s_net_count;
            xSemaphoreGive(s_wifi_lock);

            if (target[0] == '\0' && count > 0 && esp_wifi_scan_start(&SCAN_CFG, true) == ESP_OK) {
                uint16_t n = 20;
                wifi_ap_record_t *records = malloc(n * sizeof(wifi_ap_record_t));
                if (records && esp_wifi_scan_get_ap_records(&n, records) == ESP_OK) {
                    xSemaphoreTake(s_wifi_lock, portMAX_DELAY);
                    for (int i = 0; i < s_net_count && target[0] == '\0'; i++) {
                        for (int j = 0; j < n; j++) {
                            if (strcmp((const char *)records[j].ssid, s_nets[i].ssid) == 0) {
                                copy_str(target, sizeof(target), s_nets[i].ssid);
                                break;
                            }
                        }
                    }
                    xSemaphoreGive(s_wifi_lock);
                }
                free(records);
                esp_wifi_clear_ap_list();
            }

            if (target[0] != '\0' && wifi_attempt(target)) continue;
            // Wait out the retry interval -- or less, if the robot sends a network.
            EventBits_t woke = xEventGroupWaitBits(s_wifi_event_group, WIFI_PUSH_BIT | WIFI_SCAN_BIT, pdTRUE, pdFALSE,
                                                   pdMS_TO_TICKS(WIFI_RETRY_INTERVAL_MS));
            if (woke & WIFI_SCAN_BIT) scan_and_report();
            continue;
        }

        EventBits_t bits = xEventGroupWaitBits(s_wifi_event_group, WIFI_FAILED_BIT | WIFI_PUSH_BIT | WIFI_SCAN_BIT,
                                               pdTRUE, pdFALSE, portMAX_DELAY);
        if (bits & WIFI_SCAN_BIT) scan_and_report();
        if ((bits & WIFI_PUSH_BIT) && s_wifi_connected) {
            // The robot is on a different network -- follow it.
            esp_wifi_disconnect();
            xEventGroupWaitBits(s_wifi_event_group, WIFI_FAILED_BIT, pdTRUE, pdFALSE, pdMS_TO_TICKS(3000));
            s_wifi_connected = false;
        }
    }
}

static void wifi_start(void) {
    s_wifi_lock = xSemaphoreCreateMutex();
    esp_netif_create_default_wifi_sta();

    wifi_init_config_t init_cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&init_cfg));

    esp_event_handler_instance_t wifi_handler, ip_handler;
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, &wifi_handler));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(
        IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, &ip_handler));

    nets_load(); // after esp_wifi_init(): the first-boot import reads the driver's persisted config

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_start());
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE)); // no modem sleep - lowest latency

    xTaskCreate(wifi_task, "wifi", 4096, NULL, tskIDLE_PRIORITY + 2, NULL);
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

static bool init_camera(void) {
    camera_config_t config = {
        .pin_pwdn = PWDN_GPIO_NUM,
        .pin_reset = RESET_GPIO_NUM,
        .pin_xclk = XCLK_GPIO_NUM,
        .pin_sccb_sda = SIOD_GPIO_NUM,
        .pin_sccb_scl = SIOC_GPIO_NUM,
        .pin_d7 = Y9_GPIO_NUM,
        .pin_d6 = Y8_GPIO_NUM,
        .pin_d5 = Y7_GPIO_NUM,
        .pin_d4 = Y6_GPIO_NUM,
        .pin_d3 = Y5_GPIO_NUM,
        .pin_d2 = Y4_GPIO_NUM,
        .pin_d1 = Y3_GPIO_NUM,
        .pin_d0 = Y2_GPIO_NUM,
        .pin_vsync = VSYNC_GPIO_NUM,
        .pin_href = HREF_GPIO_NUM,
        .pin_pclk = PCLK_GPIO_NUM,
        .xclk_freq_hz = 20000000,
        .ledc_timer = LEDC_TIMER_0,
        .ledc_channel = LEDC_CHANNEL_0,
        .pixel_format = PIXFORMAT_JPEG,
        .frame_size = FRAMESIZE_VGA, // 640x480 default
        .jpeg_quality = 12,          // lower = higher quality/larger frame; 10-14 is a good latency/quality trade-off
        .fb_count = 2,               // double-buffer so capture and send can overlap
        .fb_location = CAMERA_FB_IN_PSRAM,
        .grab_mode = CAMERA_GRAB_LATEST, // always serve the freshest frame, drop stale ones
    };

    esp_err_t err = esp_camera_init(&config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Camera init failed: 0x%x", err);
        return false;
    }

    // esp_camera_init() already auto-probes the attached sensor over SCCB
    // and configures the matching driver internally (both OV3660_SUPPORT
    // and OV5640_SUPPORT are enabled -- see sdkconfig) -- this board can
    // carry either module, swapped as needed. What's sensor-specific is
    // everything below: register-level corrections one module needs that
    // the other doesn't.
    sensor_t *s = esp_camera_sensor_get();
    if (s->id.PID == OV3660_PID) {
        // OV3660 is mounted inverted on this board - same vflip correction
        // Espressif's own CameraWebServer example applies for this sensor.
        ESP_LOGI(TAG, "Detected OV3660 sensor - applying vflip correction");
        s->set_vflip(s, 1);
    } else if (s->id.PID == OV5640_PID) {
        // No known mounting-orientation quirk for this module on this board.
        ESP_LOGI(TAG, "Detected OV5640 sensor - no mounting-orientation correction needed");
    } else {
        ESP_LOGW(TAG, "Detected unrecognized sensor PID 0x%04x - no mounting-orientation correction applied", s->id.PID);
    }

    // Brightness/saturation defaults tuned by eye on this robot's actual
    // camera module - flatter than either sensor's own factory register
    // defaults or Espressif's OV3660 example correction (brightness=1,
    // saturation=-2), by the user's own visual judgment on real footage.
    s->set_brightness(s, 0);
    s->set_saturation(s, 0);

    return true;
}

// ---------------------------------------------------------------------------
// Status UART link to the companion ESP32-C5 (drives the shared OLED).
//
// UART1 on GPIO1/GPIO2 (XIAO header pins D0/D1) - not UART0/GPIO43-44
// (D6/D7), which is the primary console (CONFIG_ESP_CONSOLE_UART_NUM=0) and
// already carries ESP_LOGI output.
// ---------------------------------------------------------------------------

#define STATUS_UART_PORT     UART_NUM_1
#define STATUS_UART_TX_GPIO  1
#define STATUS_UART_RX_GPIO  2
#define STATUS_UART_BAUD     115200
#define STATUS_UART_PERIOD_MS 2000

static void status_uart_init(void) {
    uart_config_t cfg = {
        .baud_rate = STATUS_UART_BAUD,
        .data_bits = UART_DATA_8_BITS,
        .parity = UART_PARITY_DISABLE,
        .stop_bits = UART_STOP_BITS_1,
        .flow_ctrl = UART_HW_FLOWCTRL_DISABLE,
        .source_clk = UART_SCLK_DEFAULT,
    };
    ESP_ERROR_CHECK(uart_driver_install(STATUS_UART_PORT, 512, 0, 0, NULL, 0));
    ESP_ERROR_CHECK(uart_param_config(STATUS_UART_PORT, &cfg));
    ESP_ERROR_CHECK(uart_set_pin(STATUS_UART_PORT, STATUS_UART_TX_GPIO, STATUS_UART_RX_GPIO,
                                  UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE));
}

// Sends "STAT mac=<mac> ip=<ip> rssi=<dBm> uptime=<s> heap=<bytes>
// minheap=<bytes> camfail=<n> reboots=<n> clients=<n> reset=<reason>\n".
// Key=value line format so the receiving end (currently Robot_ESP32_S3_IDF's
// uart_link.cpp) can pick up additional fields later, or this firmware can
// add more, without either side needing to change in lockstep -- unknown
// keys are just ignored, and a key missing from an older sender is left at
// its previous/default value on the receiver.
//
// Aimed at telling apart the three suspects for the stream stuttering/
// dying: rssi trending down points at WiFi; reset != "POWERON" (especially
// "BROWNOUT") means it actually rebooted, which a bare stutter wouldn't;
// camfail climbing with rssi/reset both clean points at the camera's own
// DVP bus glitching (e.g. from motor EMI) independent of the network.
static void status_uart_send(void) {
    wifi_ap_record_t ap_info;
    int rssi = (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) ? ap_info.rssi : 0;

    char line[192];
    int len = snprintf(line, sizeof(line),
        "STAT mac=%s ip=%s rssi=%d uptime=%lld heap=%u minheap=%u camfail=%lu reboots=%lu clients=%d reset=%s\n",
        s_mac_str, s_ip_str, rssi,
        (long long) (esp_timer_get_time() / 1000000),
        (unsigned) esp_get_free_heap_size(), (unsigned) esp_get_minimum_free_heap_size(),
        (unsigned long) s_cam_fail_count, (unsigned long) s_reboot_count,
        get_active_clients(), reset_reason_str(esp_reset_reason()));
    uart_write_bytes(STATUS_UART_PORT, line, len);

    // Which network this camera is on, so the robot can tell whether it
    // needs to hand over its own. A separate line rather than a STAT field:
    // an older robot build (192-byte line buffer) would otherwise drop whole
    // STAT lines when the SSID is long. Hex, since SSIDs may contain spaces.
    char ssid_hex[sizeof(s_connected_ssid) * 2];
    hex_encode(s_wifi_connected ? s_connected_ssid : "", ssid_hex, sizeof(ssid_hex));
    len = snprintf(line, sizeof(line), "NET ssid=%s\n", ssid_hex);
    uart_write_bytes(STATUS_UART_PORT, line, len);
}

static void status_uart_write(const char *line, int len) {
    uart_write_bytes(STATUS_UART_PORT, line, len);
}

static void status_uart_task(void *arg) {
    while (true) {
        status_uart_send();
        vTaskDelay(pdMS_TO_TICKS(STATUS_UART_PERIOD_MS));
    }
}

static void hex_encode(const char *in, char *out, size_t out_len) {
    static const char HEX[] = "0123456789abcdef";
    size_t j = 0;
    for (size_t i = 0; in[i] != '\0' && j + 2 < out_len; i++) {
        uint8_t b = (uint8_t) in[i];
        out[j++] = HEX[b >> 4];
        out[j++] = HEX[b & 0xF];
    }
    out[j] = '\0';
}

static void hex_decode(const char *in, char *out, size_t out_len) {
    size_t j = 0;
    for (size_t i = 0; in[i] != '\0' && in[i] != ' ' && in[i + 1] != '\0' && j + 1 < out_len; i += 2) {
        char pair[3] = {in[i], in[i + 1], '\0'};
        out[j++] = (char) strtol(pair, NULL, 16);
    }
    out[j] = '\0';
}

// Lines from the robot:
//   WIFI ssid=<hex> pass=<hex>   join this network
//   SCAN                         report what this camera hears
static void status_uart_rx_task(void *arg) {
    char line[320];
    size_t len = 0;
    uint8_t byte;
    while (true) {
        if (uart_read_bytes(STATUS_UART_PORT, &byte, 1, portMAX_DELAY) <= 0) continue;
        if (byte == '\r') continue;
        if (byte != '\n') {
            if (len < sizeof(line) - 1) line[len++] = (char) byte;
            else len = 0; // overlong -- drop, resync on the next newline
            continue;
        }
        line[len] = '\0';
        len = 0;
        if (strcmp(line, "SCAN") == 0) {
            xEventGroupSetBits(s_wifi_event_group, WIFI_SCAN_BIT);
            continue;
        }
        if (strncmp(line, "WIFI ", 5) != 0) continue;
        const char *s = strstr(line, "ssid=");
        const char *p = strstr(line, "pass=");
        if (s == NULL) continue;
        char ssid[33], pass[65];
        hex_decode(s + 5, ssid, sizeof(ssid));
        hex_decode(p ? p + 5 : "", pass, sizeof(pass));
        wifi_handle_push(ssid, pass);
    }
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

extern const uint8_t index_html_start[] asm("_binary_index_html_start");
extern const uint8_t index_html_end[]   asm("_binary_index_html_end");
extern const uint8_t settings_html_start[] asm("_binary_settings_html_start");
extern const uint8_t settings_html_end[]   asm("_binary_settings_html_end");
extern const uint8_t diag_html_start[] asm("_binary_diag_html_start");
extern const uint8_t diag_html_end[]   asm("_binary_diag_html_end");

#define PART_BOUNDARY "frameboundary"
static const char *STREAM_CONTENT_TYPE = "multipart/x-mixed-replace;boundary=" PART_BOUNDARY;
static const char *STREAM_BOUNDARY = "\r\n--" PART_BOUNDARY "\r\n";
// X-Timestamp: when the frame was captured (camera clock, esp_timer seconds
// since boot, microsecond resolution) -- lets a viewer that parses the
// stream itself pair each frame with robot telemetry from the same moment,
// independent of how long that frame spent in buffers and on WiFi.
static const char *STREAM_PART = "Content-Type: image/jpeg\r\nContent-Length: %u\r\nX-Timestamp: %lld.%06ld\r\n\r\n";

static httpd_handle_t s_main_httpd = NULL;
static httpd_handle_t s_stream_httpd = NULL;

static esp_err_t index_handler(httpd_req_t *req) {
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, (const char *)index_html_start, index_html_end - index_html_start);
}

static esp_err_t settings_handler(httpd_req_t *req) {
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, (const char *)settings_html_start, settings_html_end - settings_html_start);
}

static esp_err_t diag_page_handler(httpd_req_t *req) {
    httpd_resp_set_type(req, "text/html");
    return httpd_resp_send(req, (const char *)diag_html_start, diag_html_end - diag_html_start);
}

static framesize_t framesize_from_str(const char *s) {
    if (!strcmp(s, "qvga")) return FRAMESIZE_QVGA;
    if (!strcmp(s, "cif")) return FRAMESIZE_CIF;
    if (!strcmp(s, "vga")) return FRAMESIZE_VGA;
    if (!strcmp(s, "svga")) return FRAMESIZE_SVGA;
    if (!strcmp(s, "xga")) return FRAMESIZE_XGA;
    if (!strcmp(s, "hd")) return FRAMESIZE_HD;
    return FRAMESIZE_INVALID;
}

static const char *framesize_to_str(framesize_t fs) {
    switch (fs) {
        case FRAMESIZE_QVGA: return "qvga";
        case FRAMESIZE_CIF:  return "cif";
        case FRAMESIZE_VGA:  return "vga";
        case FRAMESIZE_SVGA: return "svga";
        case FRAMESIZE_XGA:  return "xga";
        case FRAMESIZE_HD:   return "hd";
        default: return "vga";
    }
}

// GET /control?var=<name>&val=<value> - sets one camera setting.
static esp_err_t control_handler(httpd_req_t *req) {
    char query[64];
    char variable[32] = {0};
    char value_str[16] = {0};

    if (httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK ||
        httpd_query_key_value(query, "var", variable, sizeof(variable)) != ESP_OK ||
        httpd_query_key_value(query, "val", value_str, sizeof(value_str)) != ESP_OK) {
        httpd_resp_send_404(req);
        return ESP_FAIL;
    }

    sensor_t *s = esp_camera_sensor_get();
    int res = 0;

    if (!strcmp(variable, "framesize")) {
        framesize_t fs = framesize_from_str(value_str);
        if (fs == FRAMESIZE_INVALID) {
            httpd_resp_send_404(req);
            return ESP_FAIL;
        }
        res = s->set_framesize(s, fs);
    } else {
        int val = atoi(value_str);
        if (!strcmp(variable, "quality")) res = s->set_quality(s, val);
        else if (!strcmp(variable, "brightness")) res = s->set_brightness(s, val);
        else if (!strcmp(variable, "contrast")) res = s->set_contrast(s, val);
        else if (!strcmp(variable, "saturation")) res = s->set_saturation(s, val);
        else if (!strcmp(variable, "hmirror")) res = s->set_hmirror(s, val);
        else if (!strcmp(variable, "vflip")) res = s->set_vflip(s, val);
        else {
            httpd_resp_send_404(req);
            return ESP_FAIL;
        }
    }

    if (res != 0) {
        httpd_resp_send_500(req);
        return ESP_FAIL;
    }

    httpd_resp_set_type(req, "text/plain");
    return httpd_resp_send(req, "OK", 2);
}

// GET /diag: the same fields sent over the STAT UART line (see
// status_uart_send()'s comment), exposed over HTTP too -- useful standalone
// (e.g. off the rover, direct to a phone hotspot) where the UART link has
// nothing on the other end to read it.
static esp_err_t diag_handler(httpd_req_t *req) {
    wifi_ap_record_t ap_info;
    int rssi = (esp_wifi_sta_get_ap_info(&ap_info) == ESP_OK) ? ap_info.rssi : 0;

    char json[400];
    int len = snprintf(json, sizeof(json),
        "{\"mac\":\"%s\",\"ip\":\"%s\",\"rssiDbm\":%d,\"uptimeS\":%lld,"
        "\"freeHeapBytes\":%u,\"minFreeHeapBytes\":%u,\"camFailCount\":%lu,"
        "\"rebootCount\":%lu,\"clients\":%d,\"resetReason\":\"%s\","
        "\"frameCount\":%lu,\"lastFrameIntervalMs\":%lu,\"maxFrameIntervalMs\":%lu,"
        "\"slowFrameCount\":%lu,"
        "\"lastSendMs\":%lu,\"maxSendMs\":%lu,\"slowSendCount\":%lu}",
        s_mac_str, s_ip_str, rssi, (long long) (esp_timer_get_time() / 1000000),
        (unsigned) esp_get_free_heap_size(), (unsigned) esp_get_minimum_free_heap_size(),
        (unsigned long) s_cam_fail_count, (unsigned long) s_reboot_count,
        get_active_clients(), reset_reason_str(esp_reset_reason()),
        (unsigned long) s_frame_count, (unsigned long) s_last_frame_interval_ms,
        (unsigned long) s_max_frame_interval_ms, (unsigned long) s_slow_frame_count,
        (unsigned long) s_last_send_ms, (unsigned long) s_max_send_ms,
        (unsigned long) s_slow_send_count);
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_send(req, json, len);
}

static esp_err_t status_handler(httpd_req_t *req) {
    sensor_t *s = esp_camera_sensor_get();
    const esp_app_desc_t *app = esp_app_get_description();
    char json[384];
    int len = snprintf(json, sizeof(json),
        "{\"mac\":\"%s\",\"ip\":\"%s\",\"framesize\":\"%s\",\"quality\":%d,"
        "\"brightness\":%d,\"contrast\":%d,\"saturation\":%d,\"hmirror\":%d,\"vflip\":%d,"
        "\"fwVersion\":\"%s\",\"fwBuilt\":\"%s %s\",\"otaSlot\":\"%s\"}",
        s_mac_str, s_ip_str, framesize_to_str(s->status.framesize), s->status.quality,
        s->status.brightness, s->status.contrast, s->status.saturation,
        s->status.hmirror, s->status.vflip,
        app->version, app->date, app->time, esp_ota_get_running_partition()->label);
    httpd_resp_set_type(req, "application/json");
    // Read cross-origin by the robot's pages (camera firmware update panel).
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    return httpd_resp_send(req, json, len);
}

// ---------------------------------------------------------------------------
// OTA: POST /update with the raw firmware image as the body -- from the
// robot's Main page (S3 CAM panel), or `curl --data-binary @fw.bin
// http://<cam>/update`. Written to the other app slot, then booted; the new
// image has to prove itself by joining WiFi (ota_mark_valid_once()) or the
// bootloader rolls back to this one on the next reboot. Deliberately no
// Content-Type requirement, so a browser can send it as text/plain and skip
// a CORS preflight; the OPTIONS handler covers clients that preflight anyway.
// ---------------------------------------------------------------------------

static void ota_mark_valid_once(void) {
    static bool done = false;
    if (done) return;
    done = true;
    esp_ota_img_states_t state;
    if (esp_ota_get_state_partition(esp_ota_get_running_partition(), &state) == ESP_OK &&
        state == ESP_OTA_IMG_PENDING_VERIFY) {
        esp_ota_mark_app_valid_cancel_rollback();
        ESP_LOGI(TAG, "New firmware confirmed good (joined WiFi) -- rollback cancelled");
    }
}

static esp_err_t update_options_handler(httpd_req_t *req) {
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "POST, OPTIONS");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "Content-Type");
    httpd_resp_send(req, NULL, 0);
    return ESP_OK;
}

static esp_err_t update_handler(httpd_req_t *req) {
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    const esp_partition_t *part = esp_ota_get_next_update_partition(NULL);
    if (part == NULL || req->content_len <= 0 || (size_t) req->content_len > part->size) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, part ? "Missing or oversized image" : "No OTA partition -- flash once over USB");
        return ESP_OK;
    }
    esp_ota_handle_t ota;
    esp_err_t err = esp_ota_begin(part, OTA_SIZE_UNKNOWN, &ota);
    if (err != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, esp_err_to_name(err));
        return ESP_OK;
    }
    ESP_LOGI(TAG, "OTA: receiving %d bytes into %s", req->content_len, part->label);
    static char buf[4096]; // one update at a time -- httpd serves this server's requests sequentially
    int remaining = req->content_len;
    while (remaining > 0) {
        int n = httpd_req_recv(req, buf, remaining < (int) sizeof(buf) ? remaining : (int) sizeof(buf));
        if (n == HTTPD_SOCK_ERR_TIMEOUT) continue;
        if (n <= 0 || esp_ota_write(ota, buf, n) != ESP_OK) {
            esp_ota_abort(ota);
            httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Upload interrupted or flash write failed");
            return ESP_OK;
        }
        remaining -= n;
    }
    err = esp_ota_end(ota); // also validates the image
    if (err == ESP_OK) err = esp_ota_set_boot_partition(part);
    if (err != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, err == ESP_ERR_OTA_VALIDATE_FAILED ? "Not a valid camera firmware image" : esp_err_to_name(err));
        return ESP_OK;
    }
    httpd_resp_sendstr(req, "OK, camera rebooting into new firmware...");
    ESP_LOGI(TAG, "OTA complete, rebooting");
    vTaskDelay(pdMS_TO_TICKS(500));
    esp_restart();
    return ESP_OK;
}

// ---------------------------------------------------------------------------
// Multi-client streaming: one capture task feeds a shared "latest frame"
// buffer; each connected viewer gets its own task that just copies out
// whatever's current and sends it. This decouples the camera driver's own
// (small, fb_count=2) buffer pool from how many viewers are connected or how
// slow any one of their network sends is - without it, one client holding a
// frame buffer mid-send could starve the others (or even stall capture).
// ---------------------------------------------------------------------------

#define MAX_STREAM_CLIENTS 4

static SemaphoreHandle_t s_frame_mutex;
static uint8_t *s_frame_buf = NULL;
static size_t s_frame_len = 0;
static size_t s_frame_cap = 0;
static volatile uint32_t s_frame_seq = 0;
static int64_t s_frame_ts_us = 0; // capture time of s_frame_buf

static SemaphoreHandle_t s_stream_slots; // counting semaphore, one per free viewer slot

// Forward-declared near the top alongside status_uart_send(), for the same
// reason: status_uart_send() calls this, but MAX_STREAM_CLIENTS/
// s_stream_slots don't exist yet at that point in the file.
static int get_active_clients(void) {
    if (s_stream_slots == NULL) return 0; // not created yet (before start_camera_server())
    return MAX_STREAM_CLIENTS - (int) uxSemaphoreGetCount(s_stream_slots);
}

static void capture_task(void *arg) {
    int64_t last_capture_us = 0;

    while (true) {
        camera_fb_t *fb = esp_camera_fb_get();
        if (!fb) {
            ESP_LOGE(TAG, "Camera capture failed");
            s_cam_fail_count++;
            vTaskDelay(pdMS_TO_TICKS(10));
            continue;
        }

        int64_t now_us = esp_timer_get_time();
        if (last_capture_us != 0) {
            uint32_t interval_ms = (uint32_t) ((now_us - last_capture_us) / 1000);
            s_last_frame_interval_ms = interval_ms;
            if (interval_ms > s_max_frame_interval_ms) s_max_frame_interval_ms = interval_ms;
            if (interval_ms > FRAME_INTERVAL_SLOW_MS) s_slow_frame_count++;
        }
        last_capture_us = now_us;
        s_frame_count++;

        xSemaphoreTake(s_frame_mutex, portMAX_DELAY);
        if (fb->len > s_frame_cap) {
            uint8_t *grown = heap_caps_malloc(fb->len, MALLOC_CAP_SPIRAM);
            if (grown) {
                free(s_frame_buf);
                s_frame_buf = grown;
                s_frame_cap = fb->len;
            }
        }
        if (s_frame_buf && fb->len <= s_frame_cap) {
            memcpy(s_frame_buf, fb->buf, fb->len);
            s_frame_len = fb->len;
            s_frame_ts_us = (int64_t) fb->timestamp.tv_sec * 1000000LL + fb->timestamp.tv_usec;
            s_frame_seq++;
        }
        xSemaphoreGive(s_frame_mutex);

        esp_camera_fb_return(fb);
    }
}

// Runs on its own task per connected viewer, handed the request via the
// async-handler API so stream_handler can return immediately and the httpd
// worker stays free to accept the next viewer instead of blocking on this
// one for as long as it stays connected.
static void stream_client_task(void *pvParameters) {
    httpd_req_t *req = (httpd_req_t *)pvParameters;

    esp_err_t res = httpd_resp_set_type(req, STREAM_CONTENT_TYPE);
    if (res == ESP_OK) res = httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    // Lets the robot's pages (a different origin: the robot's IP, port 80)
    // read frames back out of an <img crossorigin> via a canvas -- needed by
    // the in-browser object detection app (detect.js). Without it the canvas
    // is "tainted" and getImageData() throws.
    if (res == ESP_OK) res = httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");

    // Disable Nagle on this socket - every frame should go out immediately
    // rather than being batched, which matters for a robot-control feed.
    int sockfd = httpd_req_to_sockfd(req);
    if (sockfd >= 0) {
        int one = 1;
        setsockopt(sockfd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));

        // Without this, a client that vanishes uncleanly (dropped WiFi, tab
        // closed abruptly - no TCP FIN/RST reaching us promptly) can leave
        // httpd_resp_send_chunk() blocked on send() indefinitely, so this
        // task never reaches its cleanup below and the viewer slot leaks
        // forever. Bounding the send lets a dead peer be detected and the
        // slot reclaimed.
        struct timeval send_timeout = {.tv_sec = 3, .tv_usec = 0};
        setsockopt(sockfd, SOL_SOCKET, SO_SNDTIMEO, &send_timeout, sizeof(send_timeout));
    }

    uint32_t last_seq = 0;
    uint8_t *local_buf = NULL;
    size_t local_cap = 0;
    char part_buf[112];

    while (res == ESP_OK) {
        // Wait for the capture task to publish a frame we haven't sent yet.
        uint32_t seq;
        do {
            xSemaphoreTake(s_frame_mutex, portMAX_DELAY);
            seq = s_frame_seq;
            xSemaphoreGive(s_frame_mutex);
            if (seq == last_seq) vTaskDelay(pdMS_TO_TICKS(5));
        } while (seq == last_seq);

        xSemaphoreTake(s_frame_mutex, portMAX_DELAY);
        size_t len = s_frame_len;
        if (len > local_cap) {
            uint8_t *grown = heap_caps_malloc(len, MALLOC_CAP_SPIRAM);
            if (grown) {
                free(local_buf);
                local_buf = grown;
                local_cap = len;
            }
        }
        if (local_buf && len <= local_cap) memcpy(local_buf, s_frame_buf, len);
        int64_t ts_us = s_frame_ts_us;
        last_seq = s_frame_seq;
        xSemaphoreGive(s_frame_mutex);

        if (!local_buf) {
            res = ESP_FAIL;
            break;
        }

        // Timed end-to-end (boundary+header+data as one unit): this is the
        // actual network delivery path for a real frame under real load,
        // unlike a synthetic /diag ping -- a WiFi-layer stall (e.g. the
        // hotspot power-save buffering diagnosed earlier) shows up here
        // directly, since send() blocks until the peer's TCP stack ACKs.
        int64_t send_start_us = esp_timer_get_time();
        res = httpd_resp_send_chunk(req, STREAM_BOUNDARY, strlen(STREAM_BOUNDARY));
        if (res == ESP_OK) {
            size_t hlen = snprintf(part_buf, sizeof(part_buf), STREAM_PART, len,
                                   (long long) (ts_us / 1000000), (long) (ts_us % 1000000));
            res = httpd_resp_send_chunk(req, part_buf, hlen);
        }
        if (res == ESP_OK) {
            res = httpd_resp_send_chunk(req, (const char *)local_buf, len);
        }
        if (res == ESP_OK) {
            uint32_t send_ms = (uint32_t) ((esp_timer_get_time() - send_start_us) / 1000);
            s_last_send_ms = send_ms;
            if (send_ms > s_max_send_ms) s_max_send_ms = send_ms;
            if (send_ms > SEND_SLOW_MS) s_slow_send_count++;
        }
    }

    free(local_buf);
    httpd_req_async_handler_complete(req);
    xSemaphoreGive(s_stream_slots);
    ESP_LOGI(TAG, "Stream client disconnected");
    vTaskDelete(NULL);
}

static esp_err_t stream_handler(httpd_req_t *req) {
    if (xSemaphoreTake(s_stream_slots, 0) != pdTRUE) {
        httpd_resp_set_status(req, "503 Too Many Viewers");
        httpd_resp_sendstr(req, "Stream is full - try again later");
        return ESP_OK;
    }

    httpd_req_t *async_req = NULL;
    esp_err_t err = httpd_req_async_handler_begin(req, &async_req);
    if (err != ESP_OK) {
        xSemaphoreGive(s_stream_slots);
        return err;
    }

    if (xTaskCreate(stream_client_task, "stream_client", 4096, async_req,
                     tskIDLE_PRIORITY + 2, NULL) != pdPASS) {
        httpd_req_async_handler_complete(async_req);
        xSemaphoreGive(s_stream_slots);
        return ESP_FAIL;
    }
    return ESP_OK;
}

// Two separate servers, like the official Espressif camera example: /stream
// clients are long-lived (until they disconnect), which would tie up
// sockets that index/settings/control/status need if they all shared one
// server.
static void start_camera_server(void) {
    s_frame_mutex = xSemaphoreCreateMutex();
    s_stream_slots = xSemaphoreCreateCounting(MAX_STREAM_CLIENTS, MAX_STREAM_CLIENTS);
    xTaskCreate(capture_task, "capture", 4096, NULL, tskIDLE_PRIORITY + 3, NULL);

    httpd_config_t main_config = HTTPD_DEFAULT_CONFIG();
    main_config.server_port = 80;
    main_config.stack_size = 8192;

    httpd_uri_t index_uri = {"/", HTTP_GET, index_handler, NULL};
    httpd_uri_t settings_uri = {"/settings", HTTP_GET, settings_handler, NULL};
    httpd_uri_t control_uri = {"/control", HTTP_GET, control_handler, NULL};
    httpd_uri_t status_uri = {"/status", HTTP_GET, status_handler, NULL};
    httpd_uri_t diag_uri = {"/diag", HTTP_GET, diag_handler, NULL};
    httpd_uri_t diag_page_uri = {"/diag.html", HTTP_GET, diag_page_handler, NULL};
    httpd_uri_t update_uri = {"/update", HTTP_POST, update_handler, NULL};
    httpd_uri_t update_options_uri = {"/update", HTTP_OPTIONS, update_options_handler, NULL};
    main_config.recv_wait_timeout = 10; // an upload pauses briefly while flash sectors erase

    if (httpd_start(&s_main_httpd, &main_config) == ESP_OK) {
        httpd_register_uri_handler(s_main_httpd, &update_uri);
        httpd_register_uri_handler(s_main_httpd, &update_options_uri);
        httpd_register_uri_handler(s_main_httpd, &index_uri);
        httpd_register_uri_handler(s_main_httpd, &settings_uri);
        httpd_register_uri_handler(s_main_httpd, &control_uri);
        httpd_register_uri_handler(s_main_httpd, &status_uri);
        httpd_register_uri_handler(s_main_httpd, &diag_uri);
        httpd_register_uri_handler(s_main_httpd, &diag_page_uri);
    }

    httpd_config_t stream_config = HTTPD_DEFAULT_CONFIG();
    stream_config.server_port = 81;
    stream_config.ctrl_port += 1; // must differ from the main server's control port too
    stream_config.stack_size = 8192;
    stream_config.max_open_sockets = MAX_STREAM_CLIENTS + 1; // +1 headroom, per esp_http_server's own async-handler guidance

    httpd_uri_t stream_uri = {"/stream", HTTP_GET, stream_handler, NULL};

    if (httpd_start(&s_stream_httpd, &stream_config) == ESP_OK) {
        httpd_register_uri_handler(s_stream_httpd, &stream_uri);
    }
}

// ---------------------------------------------------------------------------

void app_main(void) {
    s_reboot_count++;
    ESP_LOGI(TAG, "Boot #%lu, reset reason: %s", (unsigned long) s_reboot_count,
             reset_reason_str(esp_reset_reason()));

    ESP_ERROR_CHECK(nvs_flash_init());
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());
    s_wifi_event_group = xEventGroupCreate();

    // Read straight from efuse - works even before the WiFi driver starts,
    // so this is available immediately at boot regardless of whether a
    // configured network is ever in range.
    uint8_t mac[6];
    esp_read_mac(mac, ESP_MAC_WIFI_STA);
    snprintf(s_mac_str, sizeof(s_mac_str), "%02X:%02X:%02X:%02X:%02X:%02X",
             mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
    ESP_LOGI(TAG, "MAC address: %s", s_mac_str);

    status_uart_init();
    xTaskCreate(status_uart_task, "status_uart", 3072, NULL, tskIDLE_PRIORITY + 1, NULL);

    if (!init_camera()) {
        ESP_LOGE(TAG, "Halting: camera init failed");
        while (true) vTaskDelay(pdMS_TO_TICKS(1000));
    }

    // Non-blocking: joins (and keeps rejoining) in the background. The HTTP
    // servers don't need an IP to start -- they just become reachable once
    // one arrives.
    wifi_start();
    xTaskCreate(status_uart_rx_task, "status_uart_rx", 3072, NULL, tskIDLE_PRIORITY + 1, NULL);

    start_camera_server();
}
