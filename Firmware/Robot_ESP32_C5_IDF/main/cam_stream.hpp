#pragma once

#include <cstddef>

// MJPEG stream of the camera's frames through this board's own (5 GHz capable)
// Wi-Fi: http://<robot>:81/stream, like the camera's own stream on its
// port 81. The frames come over the SPI link (cam_link_set_video); the video
// there starts with the first viewer and stops after the last one, unless it
// was already running. A small socket server of its own, so a viewer never
// holds a worker of the main web server (port 80). At most CAM_STREAM_VIEWERS.
constexpr int CAM_STREAM_PORT = 81;
constexpr int CAM_STREAM_VIEWERS = 2;
constexpr int CAM_STREAM_FPS = 20; // asked of the camera while someone watches

// Starts the server task. Call once from app_main(), after Wi-Fi is set up.
void cam_stream_start();

// Viewer statistics as a JSON object (part of GET /camvideo).
int cam_stream_json(char *out, size_t len);
