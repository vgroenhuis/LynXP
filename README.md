# LynXP

![LynXP](Pictures/orange-blue/2026-09-04%2009.02.47.jpg)

LynXP is a wheeled robot with pan-tilt camera and web-based control interface, through which minigames can be played.

## Electronics

The power and control circuit (powerbank, USB power delivery trigger, current sensor, buck converter, ESP32-C5, ESP32-S3-Sense camera, motor driver, servos, motors, OLED, and status LED):

![Power and control circuit diagram](Schematic/powerbank_circuit.svg)

Also available as [PDF](Schematic/powerbank_circuit.pdf) or [PNG](Schematic/powerbank_circuit.png).

## Bill of Materials

| Component | Part | Qty | Cost (each) | Supplier | Notes |
|---|---|---|---|---|---|
| Powerbank | Anker Zolo 10.000 mAh | 1 | €35 | [Anker](https://www.anker.com/products/a1688) / [GSMNetShop](https://gsmnetshop.nl/products/externe-batterij-anker-zolo-10000mah-30w-qc-plus-pd-1-x-usb-a-2-x-usb-c-zwart-a1688h11) / [DeBatterijPro](https://www.debatterijpro.nl/nl/product/anker-zolo-powerbank-10000mah-30w-qc-pluspd-met-usb-c-kabel-zwart.html) | Dimensions 110x65.5x25 mm. A different powerbank is possible, but may need design adjustments. |
| Camera module | Seeed XIAO ESP32S3 Sense | 1 | €16 | [Seeed Studio](https://www.seeedstudio.com/XIAO-ESP32S3-Sense-p-5639.html) / [TinyTronics](https://www.tinytronics.nl/en/development-boards/microcontroller-boards/with-wi-fi/seeed-studio-xiao-esp32-s3-sense) / [Reichelt](https://www.reichelt.com/nl/nl/shop/product/xiao_esp32s3_sense_wifi_bt_camera_ov3660_zonder_header-358353) |  |
| Drive motor | TT Motor GM37-520TB-1250-30-EN (12V, 30:1 transmission) | 2 | €10 | [Alibaba](https://www.alibaba.com/product-detail/TT-Motor-High-Torque-37mm-GM37_1601884925507.html) / [Aliexpress](https://nl.aliexpress.com/item/1005007677802607.html) / [Funduinoshop](https://funduinoshop.com/nl/doe-het-zelf-workshop/kits/chassis/jgb37-520-encoder-tandwielmotor-kit-12v-12rpm-met-wiel) / [TTmotor](https://www.ttmotor.com/high-torque-dc-gear-motor-589121520253040455580100120160750rpm-product/) | GM37 is a quite common geared DC motor size, but it is hard to find one in EU with encoder attached. |
| Main MCU | ESP32-C5-WIFI6-KIT-N16R8-M | 1 | €13 | [Aliexpress](https://nl.aliexpress.com/item/1005012275503208.html) | Compatible with ESP32-C5-DevkitC-1 from Espressif |
| USB-PD trigger board | HUSB238 | 1 | €11 | [Adafruit](https://www.adafruit.com/product/5991) / [Kiwi-electronics](https://www.kiwi-electronics.com/en/adafruit-usb-type-c-power-delivery-dummy-i2c-or-switchable-husb238-20162) | |
| Current sensor | INA260 | 1 | €11 | [Adafruit](https://www.adafruit.com/product/4226) / [Kiwi-electronics](https://www.kiwi-electronics.com/nl/adafruit-ina260-high-or-low-side-voltage-current-power-sensor-4222)  | Optional |
| Pan servo | MG996R 180° | 1 | €7 | [TinyTronics](https://www.tinytronics.nl/en/mechanics-and-actuators/motors/servomotors/mg996r-servo) / [Otronic](https://www.otronic.nl/nl/servo-mg996r-180-graden.html)  | Orange-blue has SRT DL3020 which is overkill |
| OLED display | SSD1306, 128x64, 1.3" | 1 | €7 | [TinyTronics](https://www.tinytronics.nl/en/displays/oled/1.3-inch-oled-display-128*64-pixels-white-i2c) | Orange-blue LynXP has 0.96", but this is too small |
| nOOds flexible LED | 30 cm | 1 | €5 | [Adafruit](https://www.adafruit.com/product/5509) / [Kiwi-electronics](https://www.kiwi-electronics.com/en/leds-114/other-leds-360/noods-flexible-led-filament-3v-300mm-long-warm-white-11360)  | Optional |
| Breadboard | EIC premium 400 points | 1 | €4 | [Tinytronics](https://www.tinytronics.nl/en/tools-and-mounting/prototyping-supplies/breadboards/eic-premium-breadboard-400-points-transparent) | |
| Motor driver | TB6612FNG | 1 | €3 | [Otronic](https://www.otronic.nl/nl/motor-driver-module-tb6612fng-voor-arduino.html) | |
| Tilt servo | SG90 180° | 1 | €3 | [Bits&Parts](https://www.bitsandparts.nl/servo-motor-analoog-micro-servo-9g-sg90-180%C2%B0-p1907205) / [TinyTronics](https://www.tinytronics.nl/en/mechanics-and-actuators/motors/servomotors/sg90-mini-servo) | Orange-blue has Hitec HS-53 |
| Bearing | 608ZZ | 3 | €1 | [123-3D](https://www.123-3d.nl/123-3D-Kogellager-608ZZ-10-stuks-i1406.html) | For caster |
| Buck converter | OT253-B47 | 1 | €2 | [Otronic](https://www.otronic.nl/en/step-down-buck-converter-from-45v-24v-to-5v-3a-4r.html) | |
| O-ring | 31x5 mm | 2 | €1 | [Lagerkoning](https://www.lagerkoning.nl/o-ring-31x5mm-nbr-70.html) / [O-ring-stocks](https://www.o-ring-stocks.eu/nl/o-ring-31x5-nbr-nitril-70-shore-a-zwart-ors543) | For wheels |
| On/off switch | 12x19 mm | 1 | €1 | [Tinytronics](https://www.tinytronics.nl/en/switches/manual-switches/rocker-switches/standaard-built-in-rocker-switch-small) | Optional; SPDT is better because switch closed = off |
| Pushbutton | 12 mm | 1 | €1 | [Kiwi-electronics](https://www.tinytronics.nl/en/switches/manual-switches/rocker-switches/standaard-built-in-rocker-switch-normal) | Or use a toggle switch |
| **Total** | | | **€144** | | |

Total excludes filament, wires, screws, resistors.

## Photos

More photos:
- [Orange-blue version](Pictures/orange-blue)
- [Older iterations](Pictures/older%20iterations)

## AI disclaimer
Claude was used to help developing software and circuit diagrams. No AI tools were used for hardware development.
