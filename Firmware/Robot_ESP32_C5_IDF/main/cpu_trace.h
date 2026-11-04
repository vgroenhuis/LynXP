#pragma once

// CPU time per task: for a short while (cpu_trace_start(), e.g. 1 s) every
// FreeRTOS context switch is logged into PSRAM -- time, core, task -- from
// the scheduler's traceTASK_SWITCHED_IN hook (cpu_trace_hook.h). Afterwards
// cpu_trace_blob() packs it up; the robot uploads its own and the camera's to
// the CloSer lab demos page, which draws them as timelines. Nothing is sent
// while recording, so the recording itself hardly disturbs what it measures
// (the hook costs about a microsecond per switch).
//
// Interrupts aren't logged: their time counts for the task they interrupted.
// Identical copy in both firmwares (like cam_link_proto.h).
//
// Blob (little-endian):
//   header, 32 bytes: "CPUT", u8 version (1), u8 cores, u16 tasks,
//     u32 total bytes, u32 duration (us), u32 events, u32 lost (no room),
//     char chip[8]
//   tasks x 24 bytes: u32 handle, u8 priority, u8 flags (1: ended during
//     the recording, name unknown), u16 0, char name[16]
//   events x 8 bytes: u32 time since the start (us), u32 handle | core
//     (bit 0; handles are 4-byte aligned). Each core starts with an event
//     at time 0 for the task running then.

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define CPU_TRACE_MAX_MS 2000

// Starts a recording of ms milliseconds (1..CPU_TRACE_MAX_MS). False if one
// is running, or there's no PSRAM for the log. chip: a short name for the
// blob ("ESP32-C5").
bool cpu_trace_start(uint32_t ms, const char *chip);

// True while recording.
bool cpu_trace_running(void);

// The last finished recording as a blob (see above) in *out, allocated in
// PSRAM (free() it); returns its length, or 0 if there's none (or one is
// still running).
size_t cpu_trace_blob(uint8_t **out);

#ifdef __cplusplus
}
#endif
