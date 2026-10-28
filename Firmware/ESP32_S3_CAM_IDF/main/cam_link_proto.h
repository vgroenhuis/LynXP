// Framing and reliable byte stream of the SPI link between the robot (ESP32-C5,
// SPI master) and the camera (ESP32-S3, SPI slave). Plain C, no OS or driver
// calls, so the very same file is used by both firmwares: keep
//   Robot_ESP32_C5_IDF/main/cam_link_proto.h
//   ESP32_S3_CAM_IDF/main/cam_link_proto.h
// identical (and unit-tested on a PC, see the scratchpad test in the commit).
//
// The robot clocks one fixed-size frame out and one in at the same time
// (full duplex), every few ms. A frame carries up to CAM_LINK_PAYLOAD_MAX
// bytes of a *byte stream* per direction -- the same text lines the UART link
// used ("STAT mac=... \n", "WIFI ...", "SCAN", ...), so the line handlers on
// both sides did not change. On top of the SPI wire this adds what a UART
// does not give:
//   - a CRC16 per frame (a damaged or half-clocked frame is dropped),
//   - stop-and-wait delivery: every data frame has a sequence number and is
//     repeated until the peer's `ack` says it arrived (duplicates are
//     discarded), so a lost frame costs a few ms, not a lost message,
//   - an `epoch` per boot: when the peer restarts, both sides resync
//     instead of waiting for sequence numbers that will never come.
// Frame types other than STREAM are ignored by the receiver (but their
// header is still processed), so VIDEO can be added later without breaking
// an older peer.
//
//  byte  0      magic 0xA5
//        1      type: 0 IDLE, 1 STREAM (text/bytes), 2 VIDEO (reserved: camera frames)
//        2      epoch of the sender (1..255, random per boot)
//        3      ack_epoch: the peer's epoch the `ack` refers to (0: none yet)
//        4      seq of the payload in this frame (1..255, 0 if none)
//        5      ack: last seq accepted from the peer
//        6..7   payload length, little endian
//        8..    payload, zero padded up to the CRC
//  last 2 bytes CRC16-CCITT (poly 0x1021, init 0xFFFF) of all bytes before, little endian
//
// Video (camera -> robot, since 1.1.0): bit 7 of the type byte
// (CAM_LINK_FLAG_VIDEO_NEXT) in a camera frame promises that the camera's
// *next* transaction carries a video area: the robot then clocks
// CAM_LINK_VIDEO_AREA more bytes right after that 128-byte frame, with CS
// still low. The camera only promises when it has video to send, so the link
// is no busier than before while video is off. A video area:
//  byte  0..1   'V' 'F'
//        2..3   frame id (little endian, counts up per JPEG)
//        4..7   total length of the JPEG
//        8..11  offset of this chunk in the JPEG
//        12..13 chunk length (0: nothing this time)
//        14..15 0
//        16..19 CRC32 (esp_rom_crc32_le, start 0) of bytes 0..15, then of the chunk
//        20..   the chunk
// Chunks are not repeated: a frame with a missing or damaged chunk is dropped
// (the next one is only a frame time away). The camera repeats a chunk only
// when the robot didn't clock its area at all (it missed the promise).
//
// Not thread safe: callers lock around calls (the transport task and the
// functions that enqueue text are different tasks).

#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>

#define CAM_LINK_FRAME_BYTES 128
#define CAM_LINK_HEADER_BYTES 8
#define CAM_LINK_CRC_BYTES 2
#define CAM_LINK_PAYLOAD_MAX (CAM_LINK_FRAME_BYTES - CAM_LINK_HEADER_BYTES - CAM_LINK_CRC_BYTES)
#define CAM_LINK_MAGIC 0xA5
#define CAM_LINK_FLAG_VIDEO_NEXT 0x80
#define CAM_LINK_VIDEO_AREA 4096
#define CAM_LINK_VIDEO_HEADER 20
#define CAM_LINK_VIDEO_DATA_MAX (CAM_LINK_VIDEO_AREA - CAM_LINK_VIDEO_HEADER)

enum { CAM_LINK_TYPE_IDLE = 0, CAM_LINK_TYPE_STREAM = 1, CAM_LINK_TYPE_VIDEO = 2 };

typedef struct {
    uint8_t epoch;      // this side's, never 0
    uint8_t peerEpoch;  // 0 until a frame of the peer has arrived
    uint8_t rxLast;     // last seq accepted from the peer
    uint8_t txSeq;      // seq of the frame waiting for its ack, 0: none
    uint8_t txLast;     // last seq handed out
    uint16_t pendLen;
    uint8_t pend[CAM_LINK_PAYLOAD_MAX];
    uint8_t *ring;      // bytes queued for sending (caller's storage)
    uint16_t ringCap;
    uint16_t ringHead;
    uint16_t ringCount;
    uint32_t framesGood;
    uint32_t framesBad;
    uint8_t txFlags;    // OR'ed into the type byte of the frames we send (CAM_LINK_FLAG_*)
    uint8_t peerFlags;  // the flags of the peer's last valid frame
} cam_link_t;

static inline uint16_t cam_link_crc16(const uint8_t *p, size_t n) {
    uint16_t crc = 0xFFFF;
    while (n--) {
        crc ^= (uint16_t) ((uint16_t) *p++ << 8);
        for (int i = 0; i < 8; i++) crc = (crc & 0x8000) ? (uint16_t) ((crc << 1) ^ 0x1021) : (uint16_t) (crc << 1);
    }
    return crc;
}

static inline uint8_t cam_link_next_seq(uint8_t s) { return s == 255 ? 1 : (uint8_t) (s + 1); }

static inline void cam_link_init(cam_link_t *l, uint8_t epoch, uint8_t *ring, uint16_t ringCap) {
    memset(l, 0, sizeof(*l));
    l->epoch = epoch ? epoch : 1;
    l->ring = ring;
    l->ringCap = ringCap;
}

// Free room in the send queue.
static inline size_t cam_link_space(const cam_link_t *l) { return (size_t) (l->ringCap - l->ringCount); }

// Queues bytes for sending; returns how many fitted.
static inline size_t cam_link_enqueue(cam_link_t *l, const uint8_t *data, size_t n) {
    size_t room = cam_link_space(l);
    if (n > room) n = room;
    for (size_t i = 0; i < n; i++) {
        l->ring[((uint32_t) l->ringHead + l->ringCount) % l->ringCap] = data[i];
        l->ringCount++;
    }
    return n;
}

// True while there is something to send or an ack to wait for: the transport
// polls faster then.
static inline bool cam_link_busy(const cam_link_t *l) { return l->txSeq != 0 || l->ringCount > 0; }

// Writes the next frame to send (always CAM_LINK_FRAME_BYTES long). A data
// frame stays the same, and is repeated, until the peer acknowledged it.
static inline void cam_link_build(cam_link_t *l, uint8_t out[CAM_LINK_FRAME_BYTES]) {
    if (l->txSeq == 0 && l->ringCount > 0) {
        size_t n = l->ringCount < CAM_LINK_PAYLOAD_MAX ? l->ringCount : CAM_LINK_PAYLOAD_MAX;
        for (size_t i = 0; i < n; i++) {
            l->pend[i] = l->ring[l->ringHead];
            l->ringHead = (uint16_t) (((uint32_t) l->ringHead + 1) % l->ringCap);
            l->ringCount--;
        }
        l->pendLen = (uint16_t) n;
        l->txLast = cam_link_next_seq(l->txLast);
        l->txSeq = l->txLast;
    }
    memset(out, 0, CAM_LINK_FRAME_BYTES);
    out[0] = CAM_LINK_MAGIC;
    out[1] = (uint8_t) ((l->txSeq ? CAM_LINK_TYPE_STREAM : CAM_LINK_TYPE_IDLE) | l->txFlags);
    out[2] = l->epoch;
    out[3] = l->peerEpoch;
    out[4] = l->txSeq;
    out[5] = l->rxLast;
    if (l->txSeq) {
        out[6] = (uint8_t) (l->pendLen & 0xFF);
        out[7] = (uint8_t) (l->pendLen >> 8);
        memcpy(out + CAM_LINK_HEADER_BYTES, l->pend, l->pendLen);
    }
    uint16_t crc = cam_link_crc16(out, CAM_LINK_FRAME_BYTES - CAM_LINK_CRC_BYTES);
    out[CAM_LINK_FRAME_BYTES - 2] = (uint8_t) (crc & 0xFF);
    out[CAM_LINK_FRAME_BYTES - 1] = (uint8_t) (crc >> 8);
}

// Handles a received frame. Returns -1 if it is not a valid frame (noise, an
// idle bus, a damaged frame), otherwise how many new stream bytes were copied
// to `out` (at least CAM_LINK_PAYLOAD_MAX of room; 0 for an idle frame, a
// duplicate, or a frame of another type).
static inline int cam_link_parse(cam_link_t *l, const uint8_t in[CAM_LINK_FRAME_BYTES], uint8_t *out) {
    if (in[0] != CAM_LINK_MAGIC) {
        l->framesBad++;
        return -1;
    }
    uint16_t crc = (uint16_t) (in[CAM_LINK_FRAME_BYTES - 2] | (in[CAM_LINK_FRAME_BYTES - 1] << 8));
    if (crc != cam_link_crc16(in, CAM_LINK_FRAME_BYTES - CAM_LINK_CRC_BYTES)) {
        l->framesBad++;
        return -1;
    }
    uint8_t type = in[1] & 0x7F, peerEpoch = in[2], ackEpoch = in[3], seq = in[4], ack = in[5];
    uint16_t len = (uint16_t) (in[6] | (in[7] << 8));
    if (peerEpoch == 0 || len > CAM_LINK_PAYLOAD_MAX) {
        l->framesBad++;
        return -1;
    }
    l->framesGood++;
    l->peerFlags = in[1] & 0x80;

    if (peerEpoch != l->peerEpoch) {
        // The peer is new or restarted: it expects our frames to start again
        // at 1 (a frame still waiting for its ack becomes frame 1), and its
        // own numbering starts again too.
        l->peerEpoch = peerEpoch;
        l->rxLast = 0;
        l->txLast = l->txSeq ? 1 : 0;
        if (l->txSeq) l->txSeq = 1;
    }
    if (ackEpoch == l->epoch && l->txSeq != 0 && ack == l->txSeq) {
        l->txSeq = 0;
        l->pendLen = 0;
    }
    if (type == CAM_LINK_TYPE_STREAM && len > 0 && seq != 0 && seq == cam_link_next_seq(l->rxLast)) {
        memcpy(out, in + CAM_LINK_HEADER_BYTES, len);
        l->rxLast = seq;
        return len;
    }
    return 0; // idle, a duplicate (re-acked by the next frame we send), another type, or out of order
}
