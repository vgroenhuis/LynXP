# Camera link: ESP32-C5 (robot) <-> ESP32-S3 (camera)

The robot board and the camera talk over **SPI**: the ESP32-C5 is the master, the XIAO
ESP32-S3 Sense the slave. (It was a 115200-baud UART with text lines.) SPI has the bandwidth to
later pass camera frames to the C5, which can then serve the stream over its own Wi-Fi, also on 5 GHz
(the S3 is 2.4 GHz only). Today the link carries exactly what the UART carried; video is not
sent over it yet.

## Wiring

| Signal | ESP32-C5 (breadboard robot) | XIAO ESP32-S3 Sense |
|---|---|---|
| SCLK | GPIO14 (USB D+ pin) | D9 = GPIO8 (new wire) |
| MOSI | GPIO13 (USB D- pin) | D10 = GPIO9 (new wire) |
| MISO | GPIO4 | D0 = GPIO1 (the old UART wire) |
| CS | GPIO28 | D1 = GPIO2 (the old UART wire) |
| 5 V, GND | 5 V, GND | 5V, GND |

SPI mode 3 (clock idles high), CS driven by the robot with 20 us setup time, 10 MHz (measured: no errors at
10, 16, 26.7 and 40 MHz, every frame bad at 20 MHz; motors off).
Since 1.0.7 SCLK and MOSI are on the C5's native USB pins: on the dev kit the UART0 pins GPIO11/12 also
go to the CH343 USB-serial chip, which drives GPIO12 whenever the board has 5 V, so MOSI could not work
there (1.0.6 test: with MOSI left off, 292 of 293 frames from the camera were valid).

Rewire from the UART setup: the two UART wires stay as they are, with the same direction (S3 D0 to
C5 GPIO4 was the camera's TX and is now MISO; C5 GPIO28 to S3 D1 was the robot's TX and is now CS);
only the SCLK (C5 GPIO14 to D9) and MOSI (C5 GPIO13 to D10) wires are new. Pin constants: `Robot_ESP32_C5_IDF/main/board_pins.hpp`
(`CAM_SPI_*`) and `ESP32_S3_CAM_IDF/main/main.c` (`STATUS_SPI_*`). The planned PCB uses other C5 pins
(`Schematic/PCB_requirements.md` §4.2 and §10).

Things to know:
- **Console on the UART port, native USB only for power.** GPIO13/14 (the native USB pins) carry SCLK
  and MOSI, so the app switches the USB-Serial-JTAG off; logs, the bench console and flashing go through
  the dev kit's UART (CH343) USB port, as before the SPI link. An existing `sdkconfig` keeps the old
  console setting: delete it (or `idf.py fullclean`) so the new defaults are picked up.
- Both boards must be flashed: an old camera or an old robot does not understand the new link.
- Keep the wires short (the clock is 10 MHz, `LINK_SPI_CLOCK_HZ` in `cam_link.cpp`; `camclock <Hz>` on the
  robot's console or `/camraw?clock=<Hz>` changes it until the next restart, `/camraw` shows the error counts).
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

## Video through the robot (since robot 1.2.0, camera 1.1.0)

The camera's JPEGs go over the link to the robot, which streams them over its own (5 GHz capable) Wi-Fi:
`http://<robot>:81/stream` (MJPEG, at most 2 viewers; `cam_stream.cpp`). Without a free pin for a
data-ready line the robot polls: a flag bit in the camera's control frame promises a 4 KB video area in
the next transaction, which the robot clocks right after the 128-byte frame with CS still low, straight
into PSRAM. Each area carries a chunk of a JPEG with frame id, offset and CRC32; a frame with a missing
or damaged chunk is dropped (layout in `cam_link_proto.h`). The robot asks for video with the line
`VIDEO fps=<n>`; the stream does that by itself while someone watches.

- The camera needs ~3 ms to set up the next chunk: the robot pauses that long before each area
  (`/camvideo?gap=<ms>`), and polls every 2 ms between frames while video is on.
- Test endpoints on the robot: `/camvideo?fps=<n>` (start/stop, statistics and timings),
  `/camframe.jpg` (the last frame that came over the link).
- Measured 2026-10-28, frames ~22 KB (VGA, quality 12): link alone 18.4 fps at 10 MHz, 26.5 fps at
  26.7 MHz, no errors. With one viewer of the robot's stream: 14-16 fps, at most 91 ms between frames
  (the camera's own 2.4 GHz stream: 16 fps but gaps up to 390 ms). Robot meanwhile: control loop
  >= 993 Hz (average 126 -> ~290 us, worst ~2.4 ms), internal RAM free 34 -> 24 KB.
- Next: bigger video areas (fewer pauses), the camera preparing chunks ahead, the robot's camera page
  showing this stream.

## Test

The protocol logic is plain C and tested on a PC: `gcc -O1 -Wall -Wextra -o /tmp/cam_link_proto_test
Firmware/tests/cam_link_proto_test.c && /tmp/cam_link_proto_test` (lossless in-order delivery in both
directions with up to 40 % of the frames corrupted, and recovery after either side restarts).
The firmware itself was written without an ESP-IDF toolchain at hand: it still has to be built and tried on
the two boards.
