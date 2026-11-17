#pragma once

#include <cstdint>

// Flash / PSRAM self-test (GET /flashcheck). Started with ?start=<minutes>
// (1-30); runs in the background, at low priority, while the robot carries
// on -- so it can run once standing still and once while driving. Each pass:
//
//  - the running program, read straight from flash (SPI, cache bypassed)
//    and through the cache (as the CPU fetches code), each hashed and
//    checked against the SHA-256 the image carries, and compared with each
//    other chunk by chunk;
//  - the NVS partition (saved settings, Wi-Fi networks) read raw twice and
//    every entry's checksum checked -- without going through NVS, which
//    would erase an entry whose checksum fails, and without any of its
//    contents leaving the robot;
//  - 512 KB of PSRAM written with a pattern and read back.
//
// Wrong reads point at the hardware: only while driving -> supply or signal
// integrity; also at rest -> the flash / PSRAM / module itself.

struct FlashCheckResult {
    bool running;
    uint32_t passes;
    uint32_t secondsLeft;
    // program image
    uint32_t imageBytes;
    uint32_t directHashBad;     // passes whose direct (SPI) read didn't match the image's SHA-256
    uint32_t cacheHashBad;      // same, read through the cache
    uint32_t chunkMismatches;   // 4 KB chunks where the two reads differed
    uint32_t firstMismatchAddr; // flash address of the first differing byte (0: none)
    // NVS
    uint32_t nvsReadDiffs;      // passes where two raw reads of the partition differed
    uint32_t nvsEntries;        // written entries checked (last pass)
    uint32_t nvsBadHeaders;     // written entries whose header checksum fails (last pass)
    uint32_t nvsBadData;        // written strings/blobs whose data checksum fails (last pass)
    uint32_t nvsBadPages;       // pages whose header checksum fails (last pass)
    uint32_t nvsErasedBad;      // erased entries whose checksum fails (old damage, last pass)
    char nvsBadKeys[64];        // the keys of failing written entries (names only, e.g. "n2")
    // PSRAM
    uint32_t psramBytes;        // 0: couldn't allocate
    uint32_t psramBadWords;
    uint32_t psramFirstBadAddr;
};

void flash_check_register_routes();
// Copies the current/last result. False if no check has run since start-up.
bool flash_check_get(FlashCheckResult *out);
