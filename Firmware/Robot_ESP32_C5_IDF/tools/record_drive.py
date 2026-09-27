"""Record a manual drive for overlay tuning: every camera frame (with the
camera's own capture timestamp and the PC arrival time) plus the robot's
pose/servo log at 50 Hz, with PC<->robot clock syncs along the way.

Waits (up to --wait-min minutes) until the robot starts moving, keeps ~5 s
before that, then records --secs seconds of driving. Nothing here moves the
robot -- whoever is driving does.

usage: python record_drive.py [--secs 70] [--wait-min 20] [--out calib_out/drive_<time>.pkl]
"""
import argparse
import math
import pickle
import threading
import time
import urllib.request
from pathlib import Path

import calibrate as C

LOG_MS = 20


def now_us():
    return time.perf_counter_ns() // 1000


class TimestampedStream(threading.Thread):
    """MJPEG reader keeping (pc_arrival_us, camera_capture_us, jpeg)."""

    def __init__(self, url):
        super().__init__(daemon=True)
        self.url = url
        self.frames = []
        self.stop = False
        self.keep_after_us = 0  # frames arriving before this are dropped (pre-drive idle)

    def run(self):
        r = urllib.request.urlopen(self.url, timeout=10)
        buf = b""
        while not self.stop:
            chunk = r.read1(65536)
            if not chunk:
                break
            buf += chunk
            while True:
                h = buf.find(b"X-Timestamp: ")
                s = buf.find(b"\xff\xd8", h if h >= 0 else 0)
                e = buf.find(b"\xff\xd9", s + 2) if s >= 0 else -1
                if h < 0 or s < 0 or e < 0:
                    break
                ts_line = buf[h + 13: buf.find(b"\r\n", h)]
                t = now_us()
                try:
                    cam_us = int(round(float(ts_line) * 1e6))
                except ValueError:
                    cam_us = None
                self.frames.append((t, cam_us, buf[s:e + 2]))
                buf = buf[e + 2:]
                # while idle, keep only the last few seconds
                if self.keep_after_us and self.frames and self.frames[0][0] < self.keep_after_us:
                    self.frames = [f for f in self.frames if f[0] >= self.keep_after_us]
        r.close()


def sync(robot, n=15):
    """Lowest-RTT (pc_mid_us, robot_us, rtt_us) of n /debug/now round trips."""
    best = None
    for _ in range(n):
        t0 = now_us()
        rb = int(robot.get("/debug/now"))
        t1 = now_us()
        if best is None or t1 - t0 < best[2]:
            best = ((t0 + t1) // 2, rb, t1 - t0)
    return best


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--secs", type=float, default=70)
    ap.add_argument("--wait-min", type=float, default=20)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    robot = C.Robot(C.ROBOT_HOST)
    params = robot.json("/params")
    camcal = robot.json("/appdata/camcal")
    cam = robot.json("/camdiag")["ip"]
    cam_status = C.json.loads(urllib.request.urlopen(f"http://{cam}/status", timeout=5).read())
    stream = TimestampedStream(f"http://{cam}:81/stream")
    stream.start()

    syncs = [sync(robot, 10)]
    robot.get(f"/debug/panexp?kind=record&secs=600&log_ms={LOG_MS}")
    rows, header, nxt = [], None, 0

    def drain():
        nonlocal nxt, header
        text = robot.get(f"/debug/panlog?from={nxt}", timeout=10)
        lines = text.strip().splitlines()
        meta = dict(kv.split("=") for kv in lines[0][2:].split(","))
        nxt = int(meta["next"])
        header = lines[1].split(",")
        rows.extend(lines[2:])

    # Kept deliberately light on requests: the robot's WebSocket sender has a
    # known hang under network load (see the ws_broadcast notes), so no
    # /pose polling -- motion is detected from the robot's own log.
    print(f"Recording is armed -- start driving whenever you like (waiting up to {args.wait_min:.0f} min).", flush=True)
    t_wait_end = time.time() + args.wait_min * 60
    moving_since = None
    ref = None
    while time.time() < t_wait_end:
        time.sleep(1.0)
        drain()
        if not rows:
            continue
        v = [float(x) for x in rows[-1].split(",")]
        col = {h: i for i, h in enumerate(header)}
        state = (v[col["x_m"]], v[col["y_m"]], v[col["theta_rad"]], v[col["servo_deg"]], v[col["tilt_deg"]])
        if ref is None:
            ref = state
        moved = (math.hypot(state[0] - ref[0], state[1] - ref[1]) > 0.02 or abs(state[2] - ref[2]) > math.radians(3)
                 or abs(state[3] - ref[3]) > 3 or abs(state[4] - ref[4]) > 3)
        if moved:
            moving_since = time.time()
            break
        stream.keep_after_us = now_us() - 5_000_000
        rows[:] = rows[-int(5000 / LOG_MS):]
    if moving_since is None:
        print("No driving seen -- giving up.")
    else:
        stream.keep_after_us = 0
        print(f"Driving detected -- recording {args.secs:.0f} s...", flush=True)
        t_end = moving_since + args.secs
        last_sync = time.time()
        while time.time() < t_end:
            time.sleep(1.5)
            drain()
            if time.time() - last_sync > 20:
                syncs.append(sync(robot, 5))
                last_sync = time.time()
        print("Done recording.", flush=True)
    robot.get("/debug/panexp?kind=stop")
    time.sleep(0.3)
    drain()
    syncs.append(sync(robot))
    stream.stop = True
    stream.join(3)

    out = Path(args.out) if args.out else C.OUT / f"drive_{time.strftime('%Y%m%d_%H%M%S')}.pkl"
    out.parent.mkdir(exist_ok=True)
    rec = {"params": params, "camcal": camcal, "cam_status": cam_status, "log_ms": LOG_MS,
           "robot_header": header, "robot_rows": rows, "syncs": syncs, "frames": stream.frames}
    out.write_bytes(pickle.dumps(rec))
    span = (stream.frames[-1][0] - stream.frames[0][0]) / 1e6 if len(stream.frames) > 1 else 0
    print(f"saved {out}: {len(stream.frames)} frames over {span:.1f} s, {len(rows)} robot samples, {len(syncs)} clock syncs")


if __name__ == "__main__":
    main()
