# Camera link: ESP32-C5 (robot) <-> ESP32-S3 (camera)

The robot board and the camera talk over **SPI**: the ESP32-C5 is the master, the XIAO
ESP32-S3 Sense the slave. (It was a 115200-baud UART with text lines.) SPI has the bandwidth to
later pass camera frames to the C5, which can then serve the stream over its own Wi-Fi, also on 5 GHz
(the S3 is 2.4 GHz only). Today the link carries exactly what the UART carried; video is not
sent over it yet.

## Wiring

| Signal | ESP32-C5 (breadboard robot) | XIAO ESP32-S3 Sense |
|---|---|---|
| SCLK | GPIO11 | D8 = GPIO7 |
| MOSI | GPIO12 | D10 = GPIO9 |
| MISO | GPIO4 | D9 = GPIO8 |
| CS | GPIO28 | D3 = GPIO4 |
| 5 V, GND | 5 V, GND | 5V, GND |

Rewire from the UART setup: the old wires on C5 GPIO4/GPIO28 and S3 D0/D1 (GPIO1/2) are no
longer used (GPIO4 and GPIO28 are reused, as MISO and CS). Pin constants: `Robot_ESP32_C5_IDF/main/board_pins.hpp`
(`CAM_SPI_*`) and `ESP32_S3_CAM_IDF/main/main.c` (`STATUS_SPI_*`). The planned PCB uses other C5 pins
(`Schematic/PCB_requirements.md` §4.2 and §10).

Things to know:
- **Console on the native USB port.** GPIO11/12 were the UART0 console pins. The C5 console (logs and the
  bench console) now runs over the dev kit's native USB-C port (`CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG` in
  `sdkconfig.defaults`). Do not use the kit's UART (CH343) USB port while the camera is wired: its serial
  chip also drives GPIO12 (MOSI). An existing `sdkconfig` has the old console setting: delete it (or
  `idf.py fullclean`) so the new default is picked up. Flashing over the native USB port works as before.
- Both boards must be flashed: an old camera or an old robot does not understand the new link.
- Keep the wires short (the clock is 4 MHz, `LINK_SPI_CLOCK_HZ` in `cam_link.cpp`).
- Without a working link the robot logs every 30 s `no valid frame from the camera ... check the SPI wires`.

## Protocol

`Robot_ESP32_C5_IDF/main/cam_link_proto.h` (the same file in `ESP32_S3_CAM_IDF/main`, keep them
identical) defines it; the header comment has the byte layout.

- The robot clocks one 128-byte full-duplex frame every 5 ms (25 ms when idle). Each frame carries up to
  118 bytes of a byte stream per direction, the same text lines as before (`STAT`, `NET`, `AP`, `APEND` to
  the robot; `WIFI`, `OTA`, `SCAN` to the camera), so the line handlers did not change.
- CRC16 per frame; a damaged frame is ignored. Stop-and-wait delivery with sequence numbers and
  acknowledgements: a lost frame is repeated, a duplicate dropped. An epoch byte per boot lets both
  sides resynchronise when one restarts.
- Frame type `VIDEO` (2) is reserved for camera frames. Receivers ignore types they do not know, so an
  older peer does not break when it is used.
- Next step for streaming (not done): a data-ready line from the S3 (so the C5 does not have to poll),
  bigger or back-to-back transactions for VIDEO frames, and an MJPEG endpoint on the C5.

## Test

The protocol logic is plain C and tested on a PC: `gcc -O1 -Wall -Wextra -o /tmp/cam_link_proto_test
Firmware/tests/cam_link_proto_test.c && /tmp/cam_link_proto_test` (lossless in-order delivery in both
directions with up to 40 % of the frames corrupted, and recovery after either side restarts).
The firmware itself was written without an ESP-IDF toolchain at hand: it still has to be built and tried on
the two boards.
