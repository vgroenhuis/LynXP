#pragma once

// Mounts the "storage" partition (built by littlefs_create_partition_image()
// in main/CMakeLists.txt) at /littlefs, matching web_server.cpp's
// STATIC_FILES table. format_if_mount_failed=true means a corrupt or
// never-written filesystem doesn't brick boot -- it just serves 404s until
// the next filesystem OTA writes real content.
//
// Shared between main.cpp (initial boot mount) and ota.cpp (remounting
// after an unregister-erase-write cycle, or recovering after a failed
// filesystem OTA leaves the partition in an inconsistent state).
void littlefs_init();
