#pragma once

// The robot's odometry pose kept across reboots that don't cut the power --
// a firmware update (OTA), a web files update (/update-fs remounts by
// rebooting), a watchdog or panic restart. Without it the pose started over
// at (0, 0, 0) and every place the camera page had remembered (the cube map,
// the world frame from the frame cube) was off by wherever the robot had been.
//
// The pose is copied into RTC memory (RTC_NOINIT_ATTR, like breadcrumb.cpp's)
// every control tick, with a magic word and a checksum; at boot it's taken
// back if both hold. After a real power-off the RTC memory is noise: the
// checksum fails and the pose starts at (0, 0, 0) as before.

// Every control tick, after the odometry update: the pose as it is now.
void pose_persist_save();

// At boot, before the control task starts: the previous boot's pose (and the
// control frame along the chassis heading -- the pan servo starts centered),
// if there is one. True if it was restored.
bool pose_persist_restore();
