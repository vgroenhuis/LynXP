#pragma once

// Quadrature encoders decoded in hardware by the PCNT peripheral. See
// board_pins.hpp for pins and the empirically-TBD ENCODER_SIGN table.

void encoders_init();

// out[0] = left count, out[1] = right count. Signed, sign-corrected per
// ENCODER_SIGN, and monotonically accumulating past +/-32767 (see
// PCNT_LOW_LIMIT/HIGH_LIMIT in encoders.cpp) rather than wrapping.
void encoders_read(long out[2]);
void encoders_reset();
