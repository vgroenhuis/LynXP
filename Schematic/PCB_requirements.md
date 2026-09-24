# LynXP main PCB — requirements

This document lists the requirements for a single main PCB that replaces the breadboard, the
breakout modules and the wiring of LynXP One (see [powerbank_circuit.png](powerbank_circuit.png)
and the [BOM in the README](../README.md#bill-of-materials)). As many functions as practical
should be on the PCB itself instead of on plug-in modules.

Key words: **must** = hard requirement, **should** = strongly preferred, **may** = optional/nice to have.
Items marked *(verify)* are facts the designer must check against the current datasheet before
committing to the layout.

---

## 1. Scope: what moves onto the PCB

| Function | LynXP One (breadboard) | PCB |
|---|---|---|
| Main MCU | Waveshare ESP32-C5-WIFI6-KIT devkit | **ESP32-C5-WROOM-1U** module soldered on the PCB |
| USB-PD trigger | Adafruit HUSB238 breakout | **HUSB238** chip + USB-C receptacle on the PCB |
| Current/voltage sensor | Adafruit INA260 breakout | **INA260** chip on the PCB |
| 5 V buck converter | OT253-B47 module | Buck converter on the PCB |
| 3.3 V supply | Devkit LDO | Regulator on the PCB |
| Motor driver | TB6612FNG module | **TB6612FNG** chip on the PCB |
| Servo and motor PWM | ESP32 LEDC | **PCA9685** 16-channel PWM driver (new) |
| Extra GPIO | — | **MCP23017** 16-bit I/O expander (new) |
| Programming | Devkit USB | One USB-C port to the ESP32-C5 native USB (no USB-UART chip) |
| Camera (XIAO ESP32-S3 Sense) | Loose jumper wires | Keyed connector for a 4-wire flat cable |
| OLED display | 1.3" 128×64 I²C module on jumper wires | **1.3" 128×64 OLED panel on the PCB** (see §5.1) |
| nOOds LED, buttons, power switch | Loose wires | Connectors / on-board parts |

Stays off-board: powerbank, motors, servos, XIAO ESP32-S3 Sense camera, nOOds LED.

---

## 2. Power input: USB-PD (HUSB238)

### 2.1 Negotiation
- **Must** have a USB-C receptacle (power only; CC1, CC2, VBUS, GND) for the powerbank, labelled
  **"POWER"** on the silkscreen, clearly different from the programming port.
- **Must** use the HUSB238 as PD sink controller. Default request: **12 V** (the GM37 motors are
  12 V motors; LynXP One ran them at 9 V).
- **Should** allow selecting the requested voltage (at least 9 V and 12 V; 5/15/20 V a bonus) with
  solder jumpers or a DIP switch on the HUSB238 voltage-select resistor network *(verify resistor
  values in the HUSB238 datasheet)*. The ISET/current resistor (10.5 kΩ on LynXP One) must also be
  on the board.
- **Must** connect the HUSB238 I²C (address 0x08) to the main I²C bus so firmware can read the
  contract and optionally request another PDO.
- If the powerbank can only deliver 9 V, the "12 V" rail simply carries 9 V. Everything on this rail
  must therefore work from 5 V up to 20 V (see 2.5).

### 2.2 On/off switch that wakes the powerbank (important)
Many powerbanks (including the Anker Zolo) switch their output off after a period of low current,
and only turn it on again when they detect a *new* attach event on the CC lines. Pulling and
re-inserting the cable works; switching the load does not.

- **Must**: the main on/off switch breaks the **CC1 and CC2** lines between the USB-C receptacle and
  the HUSB238 (one pole per CC line). Switching OFF looks like a cable unplug to the powerbank (it
  removes VBUS itself); switching ON is a fresh attach, which wakes the powerbank.
- **Must**: the same switch also puts the **PD controller to sleep when OFF and wakes it when ON**,
  so that every switch-on starts the PD controller from its initial state and it renegotiates the
  contract, instead of keeping stale state alive on residual VBUS/bulk-capacitor charge or on
  voltage back-fed from the programming USB port. Implement with an extra pole on the main switch,
  e.g. driving the PD controller's enable/sleep pin, or cutting its supply combined with a VBUS
  discharge path so it gets a clean power-on reset *(verify which mechanism the HUSB238 supports;
  a comparable PD sink controller with a proper enable pin is acceptable if the HUSB238 has none)*.
- The main switch is therefore a multi-pole switch (e.g. 3PDT/4PDT slide or toggle). There must be
  only this one power switch for the PD input; no separate wake/sleep buttons.
  - Side effect: the switch carries only CC signal current, so no high-current switch is needed.
  - Keep CC traces short, place the switch close to the receptacle and the HUSB238. The switch
    must be a real mechanical switch, large and easy to reach from outside the robot (panel or
    edge mount, or wired to an off-board panel switch via a small connector with a footprint for
    an on-board switch as well).
- **Should** use another pole of the same main switch to also open the PD output load switch,
  so the output is guaranteed off even with a non-compliant source.
- Note: the powerbank must be connected with a **USB-C to USB-C** cable. A USB-A to C cable has
  no CC handshake and cannot be woken or switched this way.

### 2.3 Inrush and capacitance
- USB-C limits sink bulk capacitance on VBUS before a contract is established (≤10 µF *(verify)*).
  Large bulk capacitors (motor/servo rails) **must** sit behind a load switch/PMOS that only closes
  once the HUSB238 reports a valid contract (as the Adafruit breakout does), with soft-start.

### 2.4 Protection
- **Must**: TVS diode on VBUS rated for the maximum selectable PD voltage (≥ 20 V standoff if 20 V
  can be selected).
- **Must**: fuse (PTC or eFuse) on the 12 V rail sized for the total budget (~2.5–3 A at 12 V for a
  30 W powerbank *(verify powerbank PDO list)*).
- **Should**: ESD protection on CC lines.

### 2.5 Current sensing (INA260)
- **Must** place an INA260 (integrated shunt, high-side) in series with the 12 V rail directly after
  the PD output switch, so it measures the complete robot consumption.
- I²C address: **0x40** (firmware `INA260_I2C_ADDR`), A0 and A1 hardwired to GND.
- ALERT pin left unconnected.

---

## 3. Power rails

| Rail | Source | Minimum rating | Notes |
|---|---|---|---|
| **12 V** (VBUS after PD, INA260, fuse) | HUSB238 | 3 A | Motors (TB6612 VM), buck inputs, exposed |
| **5 V** logic | Buck from 12 V | 3 A | Camera, nOOds, encoders (option), exposed |
| **V_SERVO** (5 V) | Separate buck from 12 V | 3 A continuous | 8 servo headers |
| **3.3 V** | Regulator from 5 V | 1 A | ESP32-C5, MCP23017, PCA9685, INA260, HUSB238 I/O |

- Bucks **must** accept 5–20 V input with margin (≥ 28 V abs. max) because the rail follows the PD
  voltage.
- Servos **should** get their own buck, separate from logic 5 V, so servo stall currents
  (MG996R ~2.5 A stall) cannot brown out the ESP32. Bulk capacitance on V_SERVO (≥ 470–1000 µF,
  low-ESR).
- 3.3 V regulator must handle ESP32-C5 Wi-Fi peaks (≥ 500 mA peak for the module alone); an LDO
  from 5 V with ≥ 1 A rating or a small buck.
- When only the programming USB port is connected, the 5 V/3.3 V logic **must** run from USB VBUS
  through an ORing diode / ideal diode, without back-feeding into the buck output or the PD side.
  V_SERVO and 12 V stay unpowered in that case.
- **Must**: power-good LED on each rail (12 V, 5 V, V_SERVO, 3.3 V).
- **Should**: test points on every rail and GND.

### 3.1 Exposed power
- **Must** expose **GND, 3.3 V, 5 V and 12 V** (and **should** V_SERVO) both on:
  - **screw terminals** (5.0 mm or 3.5 mm pitch, one terminal per rail + at least two GND), and
  - **2.54 mm female headers** (several pins per rail, e.g. a 2×N or 4×1 block per rail).
- Silkscreen voltage next to every pin. Use distinct connector colours or clear markings to avoid
  plugging a 3.3 V device into 12 V.

---

## 4. Main MCU: ESP32-C5-WROOM-1U

- **Must** use ESP32-C5-WROOM-1U (external antenna, U.FL/IPEX). A variant **with PSRAM is required**
  (current devkit is N16R8); choose flash/PSRAM size to match the firmware partition table
  ([partitions.csv](../Firmware/Robot_ESP32_C5_IDF/partitions.csv)) *(verify availability)*.
- **Must** route the U.FL cable to an external antenna mounting point away from motors, the metal
  frame and the powerbank; keep the module away from the buck converters and motor traces.
- **Must**: EN reset button, BOOT button on GPIO28, EN RC delay
  (10 kΩ / 1 µF), decoupling per module datasheet.
- Reserved pins (from [board_pins.hpp](../Firmware/Robot_ESP32_C5_IDF/main/board_pins.hpp)):
  GPIO13/14 = USB D−/D+, GPIO16–22 = flash/PSRAM, **GPIO15 cannot be used** (PSRAM).
- Strapping: **GPIO28 must not be externally driven** — only the BOOT button may pull it low. It
  may only connect to inputs (as the camera UART RX line in the pin map below). The other
  strapping pins need no special care.

### 4.1 Programming port
- **Must**: exactly one USB-C receptacle, labelled **"PROG"**, wired to the ESP32-C5 native
  USB-Serial/JTAG (GPIO13/14). No USB-UART converter chip. 5.1 kΩ Rd on its own CC1/CC2, ESD
  protection on D+/D− (e.g. USBLC6-2), 90 Ω differential routing.
- **Must**: a 2.54 mm UART0 header for an external USB-UART adapter: GND, U0TXD, U0RXD
  (GPIO11/GPIO12 *(verify)*), plus EN and BOOT so an adapter can also flash the module. 3.3 V pin
  via solder jumper, open by default.

### 4.2 Suggested pin map
Motor PWM and pan/tilt servos move to the PCA9685 and motor direction pins to the MCP23017 (see
§6, §7); the remaining ESP32 pins keep the bench-verified LynXP One assignment. The designer may
reassign pins; any change must be documented so `board_pins.hpp` can be updated.

| Function | Connection |
|---|---|
| Motor PWMA (right) / PWMB (left) | PCA9685 channel 8 / 9 |
| Motor AIN1, AIN2 (right) / BIN1, BIN2 (left) | MCP23017 GPA0, GPA1 / GPA2, GPA3 |
| Pan / tilt servo | PCA9685 channel 0 / 1 |
| Encoder left A, B | 26, 25 |
| Encoder right A, B | 24, 23 |
| I²C SDA / SCL | 2 / 3 |
| Camera UART RX / TX | 4 / 28 |
| QR pushbutton | 27 |
| UART0 TX / RX | 11 / 12 *(verify)* |

Freed GPIOs (0, 1, 5, 6, 7, 8, 9, 10) and other remaining GPIOs should go to: MCP23017 INTA/INTB, PCA9685 OE, an addressable status LED (WS2812/SK6812),
and a 2.54 mm female header with all remaining free GPIOs.

Encoders **must** stay on native GPIOs (PCNT peripheral).

---

## 5. I²C bus

- One 3.3 V I²C bus shared by all devices. No pull-up resistors on the PCB; the ESP32-C5's
  internal pull-ups are used.
- Address map (must be conflict-free — note the PCA9685 default **0x40 clashes with the INA260**):

| Device | Address |
|---|---|
| HUSB238 | 0x08 (fixed) |
| MCP23017 | 0x20 (A0–A2 solder jumpers) |
| OLED (SH1106/SSD1306-compatible) | 0x3C (0x3D via solder jumper) |
| INA260 | 0x40 (A0, A1 to GND) |
| PCA9685 | **0x41** (A0 to 3.3 V, A1–A5 to GND); its All-Call address 0x70 is also in use |

- **Should**: one or two Qwiic/STEMMA QT (JST-SH 4-pin, 3.3 V) connectors plus a 2.54 mm I²C
  header for add-ons.

### 5.1 On-board 1.3" OLED display
- **Must**: the 1.3" 128×64 monochrome OLED is part of the PCB, not a plug-in module. Use a bare
  1.3" OLED glass panel with integrated controller and FPC tail (typically 30-pin, soldered or in
  an FPC connector), with all support circuitry on the PCB. Panel colour white (as on LynXP One);
  blue or yellow acceptable.
- Controller: the current firmware uses the SSD1306 driver with a 2-column offset
  (`CONFIG_OFFSETX=2` in [sdkconfig.defaults](../Firmware/Robot_ESP32_C5_IDF/sdkconfig.defaults)),
  i.e. the LynXP One module is effectively an **SH1106** (132-column RAM). An SH1106 panel is
  preferred so firmware stays unchanged; an SSD1306/SSD1309 panel is acceptable if documented.
  *(verify controller of the chosen panel)*
- Interface: **I²C** on the shared bus, address 0x3C (0x3D selectable). Interface-select pins
  (BS0–BS2) strapped for I²C, D1/D2 joined for SDA as the panel datasheet specifies.
- Supply: logic from 3.3 V. The OLED drive voltage (VCC/VPP, typically 7–15 V) must be generated
  as required by the controller: internal charge pump with its flying capacitors (SH1106/SSD1306),
  or a small external boost converter if the panel needs external VCC (e.g. SSD1309). Include
  IREF resistor, VCOMH/VCC decoupling and all other passives from the panel's reference circuit.
- RES# (reset) connected to an MCP23017 output or ESP32 GPIO with RC fallback, so firmware can
  reset a hung display.
- **Should**: the display power can be switched off (load switch or controller sleep is enough).
- Mechanical: the panel **must** be on the top side, fully visible with the robot assembled,
  readable in the orientation the robot is normally viewed from (text upright). Provide a cut-out
  or keep-out under the FPC bend, and a mounting method for the glass (double-sided foam tape
  area and/or a 3D-printed bezel with M2/M2.5 holes; include the bezel in the STEP deliverable).
  Keep tall components and connectors away from the panel so it is not damaged or shadowed.
- **Should**: as a fallback, a 4-pin 2.54 mm female header on the same I²C bus for an external
  OLED module, with solder jumpers for both common pin orders (GND-VCC-SCL-SDA and
  VCC-GND-SCL-SDA).

---

## 6. PCA9685 PWM driver: servos and motor PWM

- **Must**: PCA9685 powered from 3.3 V (3.3 V signal levels are fine for hobby servos).
- **Must**: OE pin pulled **high** (outputs disabled) by default and controlled by an ESP32 GPIO,
  so servos and motors receive no pulses until firmware has initialised them. This also prevents
  the random boot-time pan rotation seen on LynXP One.
- **Note**: all 16 PCA9685 channels share one PWM frequency. With servos on the same chip, the
  motor PWM runs at the servo frequency (~50 Hz) instead of the current 20 kHz. This is acceptable
  for the TB6612FNG; expect audible motor noise and coarser low-speed behaviour.
- **Must**: **8 servo headers**, standard 3-pin 2.54 mm male (GND, V_SERVO, signal — in that
  order, with polarity marked on silkscreen), on PCA9685 channels 0–7:
  - channel 0 = **PAN**, channel 1 = **TILT**, channels 2–7 = **SPARE 1–6** (label space).
  - Series resistor (~220 Ω) on each signal line.
  - Spacing wide enough to plug in 8 servo connectors side by side.
- Channels 8 and 9: TB6612FNG PWMA (right motor) and PWMB (left motor).
- **Must**: break out PCA9685 channels 10–15 on a 2.54 mm female header (with GND and 5 V next to it).
- **Should**: channel 10 drives a logic-level low-side MOSFET for the **nOOds LED** (dimmable),
  with footprint for the series resistor (47 Ω on LynXP One) and a 2-pin connector.

---

## 7. MCP23017 GPIO expander

- **Must**: MCP23017 at 3.3 V, RESET pulled up (optionally to a GPIO), INTA/INTB to ESP32 GPIOs.
- **Note** *(verify)*: newer MCP23017 datasheets specify **GPA7 and GPB7 as output-only**. Use these
  two pins for outputs (LEDs, camera power enable) and not for switches.
- Suggested allocation:
  - GPA0–GPA3: TB6612FNG AIN1, AIN2, BIN1, BIN2 (outputs). Pull-downs on these four lines so both
    motors are stopped while the MCP23017 is in reset or not yet configured.
  - 8-position DIP switch (inputs, see §9).
  - Large user switches/buttons (inputs).
  - User LEDs, camera power enable, TB6612 STBY monitor (as needed).
  - All unused pins on a labelled 2.54 mm female header with GND and 3.3 V.

---

## 8. Motors

### 8.1 Driver
- **Must**: TB6612FNG on the PCB, VM = 12 V rail, VCC = 3.3 V, STBY pulled up (current firmware
  assumes always-enabled); **should** route STBY through the motor-enable switch (§9) and/or a GPIO.
- Channel A = RIGHT motor, channel B = LEFT motor (matches firmware).
- Generous copper and thermal vias for the TB6612FNG (1.2 A continuous / 3.2 A peak per channel).
  GM37-520 stall current at 12 V should be checked against this *(verify)*; if it is too high, a
  pin-compatible-in-function alternative with IN1/IN2/PWM control may be proposed.
- Bulk capacitor (≥ 100 µF) and 100 nF at VM.

### 8.2 Motor connectors (per motor, both motors)
All three options on the board, electrically in parallel (only one used at a time):
1. **6-pin 2.0 mm pitch socket** matching the GM37-520 encoder motor cable (JST-PH-style).
   Signals: M+, M−, encoder VCC, encoder GND, encoder A, encoder B. Pin order **must** be checked
   against the actual TT Motor GM37-520TB-1250-30-EN cable *(verify)*; silkscreen the pin names.
2. **2.54 mm female header** (6-pin, same signals).
3. **2-pin screw terminal** for M+/M− only (motors without encoder, or thick wires).

### 8.3 Encoders
- Encoder VCC selectable by jumper: **3.3 V (default)** or 5 V. The ESP32 is not 5 V tolerant, so
  with 5 V the A/B lines **must** be level-limited (resistor divider or buffer) before the GPIO.
- Footprints for pull-ups and small RC filters (DNP by default) on each A/B line.
- Encoder spec (for reference): 12 PPR, 30:1 gearbox.

---

## 9. Switches, buttons and labels

- **Main power switch** (large, see §2.2): DPDT (or more poles) breaking CC1/CC2.
- **Should**: large **motor-enable** switch (TB6612 STBY or VM) and **servo-power** switch
  (V_SERVO enable), both readable by firmware — handy for bench testing with the robot on the table.
- **Must**: at least **3–4 large user switches/buttons** (e.g. 12 mm tactile buttons with caps or
  toggle switches) on native GPIO or MCP23017:
  - one is the existing **QR button** (GPIO27, pull-up, active low),
  - the others free for firmware/minigame use.
- **Must**: at least one **8-position DIP switch** on the MCP23017 (e.g. robot ID, mode flags).
- **Must**: **space for labels** next to every user switch, DIP position, spare servo, spare
  header and exposed rail: white solder-mask/silkscreen fields that can be written on with a
  permanent marker, large enough for a short word.
- Reset (EN) and BOOT buttons (small is fine).

---

## 10. Camera (XIAO ESP32-S3 Sense)

- The camera sits on the pan-tilt head. A **4-wire flat cable** is soldered to the XIAO and ends in
  a connector that plugs into the PCB.
- **Must**: keyed, latching/friction-locked 4-pin connector on the PCB (e.g. JST-PH 2.0 mm or
  JST-XH 2.5 mm; the designer selects one and specifies the mating cable connector).
  Pinout:

| Pin | Signal | XIAO side | ESP32-C5 side |
|---|---|---|---|
| 1 | 5 V | 5V pad | 5 V rail |
| 2 | GND | GND | GND |
| 3 | CAM_TX | D0 (GPIO1, TX) | GPIO4 (UART1 RX) |
| 4 | CAM_RX | D1 (GPIO2, RX) | GPIO28 (UART1 TX) |

- 115200 baud, 3.3 V levels. Small series resistors (e.g. 100–330 Ω) on the UART lines.
- Place the connector so the cable has room to follow the pan/tilt motion; provide a strain-relief
  point (hole for a cable tie) next to it.
- **Should**: camera 5 V through a load switch controlled by the MCP23017, so firmware can
  power-cycle a hung camera. Budget ≥ 500 mA for the camera.
- Protect against back-feeding when the XIAO's own USB is plugged in for programming *(verify
  whether the XIAO already has a diode on its 5 V pin)*.

---

## 11. Other connectors and indicators

- Addressable status LED (WS2812/SK6812) on a free GPIO; **may** also add a 3-pin header to chain
  more.
- nOOds LED 2-pin connector (see §6).
- Female header breakout of all free ESP32 GPIOs, MCP23017 spare pins and PCA9685 channels 10–15,
  each group with GND and supply pins next to it.
- All connectors labelled on the silkscreen with signal name and voltage.

---

## 12. Mechanical and manufacturing

- Board outline and mounting holes **must** fit the LynXP frame in place of the breadboard and
  module holders (see the CAD in [CAD/LynXP One Sept 2026](<../CAD/LynXP One Sept 2026>),
  e.g. `Frame_16x10` and `BreadboardHolder_Clamp`). M3 mounting holes, isolated from GND or
  GND-connected by solder jumper.
- USB-C ports, main power switch, large user switches and DIP switch reachable with the robot
  assembled (board edge / top side). The POWER port faces the powerbank.
- The on-board OLED visible and the camera connector placed so the cable reaches the pan-tilt head.
- A 3D model (STEP) of the assembled PCB must be delivered for integration in the Solidworks
  assembly.
- Two-layer board preferred, four-layer acceptable. Solid ground plane; separate high-current
  (motor/servo) return paths from logic ground and join them near the power input.
- Parts should be available from JLCPCB/LCSC or similar for assembly; through-hole connectors and
  switches may be hand-soldered. Passive size ≥ 0603 (0805 preferred) for hand rework.
- Silkscreen: project name, board revision, date, polarity marks, pin-1 marks, rail voltages.

---

## 13. Deliverables

- Schematic (PDF + source, KiCad preferred), PCB layout source, Gerbers, BOM with manufacturer part
  numbers, pick-and-place file, STEP model.
- Pin map table (ESP32 GPIO, MCP23017 pin, PCA9685 channel per function) so
  [board_pins.hpp](../Firmware/Robot_ESP32_C5_IDF/main/board_pins.hpp) can be updated.
- Updated power/control diagram replacing [powerbank_circuit.png](powerbank_circuit.png).

## 14. Firmware impact (for information)

The following firmware changes follow from this board and are not part of the PCB design:
PCA9685 driver for servos and motor PWM (and OE control), MCP23017 driver for motor direction,
DIP switch/buttons/LEDs, motor updates over I²C (the 1 kHz control loop must budget for I²C
writes or update the motors at a lower rate), PD voltage
handling at 12 V instead of 9 V (motor PWM limits), camera power-cycling,
and any pin reassignments.
