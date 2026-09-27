#pragma once

// Pan-servo tracking experiments: scripted in-place rotations / servo steps
// with a 200 Hz log of chassis heading, wheel speeds and the servo command,
// plus runtime (non-persistent) knobs for the servo-follow loop in
// ws_broadcast.cpp so tracking fixes can be compared without reflashing.
// See debug_pan.cpp for the HTTP interface.

// Servo-follow update period in ms (default 20; ws_broadcast.cpp's poll loop
// runs every 20 ms, so values below that act as 20).
extern volatile int g_panFollowIntervalMs;
// Heading feedforward: aim the servo where the chassis will be this many ms
// from now (current chassis rate x lead), to cover the servo's own lag
// (default 70).
extern volatile float g_panLeadMs;
// Set while an experiment drives the pan servo directly.
extern volatile bool g_panFollowSuspended;

void debug_pan_register_routes();
