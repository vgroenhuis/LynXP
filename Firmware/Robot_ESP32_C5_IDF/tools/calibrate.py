"""LynXP camera / servo / odometry calibration from the robot's own camera.

The robot only ever turns in place (debug_pan.cpp's /debug/panexp and
/debug/servo). Needs numpy + Pillow.

Measurements
  turn   One 360 deg in-place turn per camera resolution, pan servo held.
         * Focal length: summing the frame-to-frame horizontal image shift
           over a closed loop gives f * 2*pi pixels whatever the lens, and
           camera-position parallax cancels over the loop. The small offset
           between the first and last still frames is subtracted.
         * Wheelbase: odometry's turn vs the true turn (360 deg + that offset)
           gives the effective wheelbase.
         * Camera tilt: yawing about the world vertical rolls the image of a
           camera pitched by a at sin(a) x the yaw rate, measured from the
           vertical shift difference between the left and right image halves.
  pan    Pan servo stepped through its range while the chassis stands still;
         the angle actually turned is measured from the image (f known), and
         each side of the piecewise-linear pulse mapping is refitted through
         the (kept) center pulse.
  tilt   Same for the tilt servo, from vertical image shifts.

usage:
  python calibrate.py measure [--modes vga,qvga,...] [--skip-pan] [--skip-tilt]
  python calibrate.py apply <results.json>     # writes robot settings + camcal
"""
import argparse
import datetime
import http.client
import io
import json
import math
import pickle
import sys
import threading
import time
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

ROBOT_HOST = "192.168.0.17"
OUT = Path(__file__).parent / "calib_out"
MODES = {"qvga": (320, 240), "cif": (400, 296), "vga": (640, 480), "svga": (800, 600), "xga": (1024, 768), "hd": (1280, 720)}


# -- robot / camera I/O ---------------------------------------------------------

class Robot:
    """One keep-alive connection: the robot's small socket pool dislikes a
    burst of fresh connections."""

    def __init__(self, host):
        self.host = host
        self.conn = None

    def get(self, path, timeout=10, tries=4):
        for attempt in range(tries):
            try:
                if self.conn is None:
                    self.conn = http.client.HTTPConnection(self.host, timeout=timeout)
                self.conn.request("GET", path)
                r = self.conn.getresponse()
                body = r.read().decode()
                if r.status == 409:
                    return None
                if r.status >= 400:
                    raise RuntimeError(f"{path}: HTTP {r.status} {body[:100]}")
                return body
            except (OSError, http.client.HTTPException):
                self.conn = None
                if attempt == tries - 1:
                    raise
                time.sleep(0.5)

    def json(self, path):
        return json.loads(self.get(path))

    def wait_experiment(self, max_s=40):
        t_end = time.time() + max_s
        while time.time() < t_end:
            time.sleep(0.5)
            if self.get("/debug/panlog") is not None:
                return
        raise RuntimeError("experiment didn't finish")


class Stream(threading.Thread):
    def __init__(self, url):
        super().__init__(daemon=True)
        self.url = url
        self.frames = []  # (t_s, jpeg)
        self.stop = False

    def run(self):
        r = urllib.request.urlopen(self.url, timeout=10)
        buf = b""
        while not self.stop:
            chunk = r.read1(65536)
            if not chunk:
                break
            buf += chunk
            while True:
                s = buf.find(b"\xff\xd8")
                e = buf.find(b"\xff\xd9", s + 2) if s >= 0 else -1
                if s < 0 or e < 0:
                    break
                self.frames.append((time.time(), buf[s:e + 2]))
                buf = buf[e + 2:]
        r.close()

    def since(self, t):
        return [f for f in self.frames if f[0] >= t]

    def latest(self):
        return self.frames[-1] if self.frames else None


def gray(jpg):
    return np.asarray(Image.open(io.BytesIO(jpg)).convert("L"), dtype=np.float32)


# -- image registration ------------------------------------------------------------

_LP = {}


def _lowpass(shape, sigma_px=3.0):
    if shape not in _LP:
        fy = np.fft.fftfreq(shape[0])[:, None]
        fx = np.fft.fftfreq(shape[1])[None, :]
        _LP[shape] = np.exp(-2 * (math.pi * sigma_px) ** 2 * (fx * fx + fy * fy))
    return _LP[shape]


def _window(shape):
    return np.hanning(shape[0])[:, None] * np.hanning(shape[1])[None, :]


def phase_shift(a, b, with_peak=False):
    """(dx, dy) such that b ~= a shifted by (dx, dy) pixels (sub-pixel).
    with_peak=True also returns the correlation peak height (match quality)."""
    a = a - a.mean()
    b = b - b.mean()
    w = _window(a.shape)
    R = np.fft.fft2(b * w) * np.conj(np.fft.fft2(a * w))
    R /= np.abs(R) + 1e-9
    # Low-pass the (whitened) cross-power spectrum: the camera's JPEG 8x8
    # block grid is identical in every frame and otherwise dominates the
    # correlation, snapping shifts to multiples of 8 px. A Gaussian cutoff
    # well below 1/8 cycle/px removes it and keeps the peak smooth enough
    # for sub-pixel refinement.
    R *= _lowpass(a.shape)
    c = np.fft.ifft2(R).real
    iy, ix = np.unravel_index(np.argmax(c), c.shape)
    H, W = c.shape

    def refine(l, m, r):
        den = l - 2 * m + r
        return 0.5 * (l - r) / den if den != 0 else 0.0

    dx = ix + refine(c[iy, ix - 1], c[iy, ix], c[iy, (ix + 1) % W])
    dy = iy + refine(c[iy - 1, ix], c[iy, ix], c[(iy + 1) % H, ix])
    if dx > W / 2:
        dx -= W
    if dy > H / 2:
        dy -= H
    if with_peak:
        lp = _lowpass(a.shape)
        return dx, dy, float(c[iy, ix] / (lp.sum() / lp.size))  # 1.0 = perfect match
    return dx, dy


def aligned_shift(a, b, iters=2, with_peak=False):
    """phase_shift() refined: after a first estimate, the overlapping parts of
    a and b (aligned at the integer shift) are correlated again for the small
    remainder. Phase correlation through a tapered window underestimates
    shifts that are a sizable fraction of the window; the remainder never is."""
    dx, dy, pk = phase_shift(a, b, with_peak=True)
    H, W = a.shape
    for _ in range(iters):
        ix, iy = int(round(dx)), int(round(dy))
        if abs(ix) > W // 2 or abs(iy) > H // 2:
            break
        ax0, ax1 = max(0, -ix), min(W, W - ix)
        ay0, ay1 = max(0, -iy), min(H, H - iy)
        if ax1 - ax0 < 24 or ay1 - ay0 < 24:
            break
        ca = a[ay0:ay1, ax0:ax1]
        cb = b[ay0 + iy:ay1 + iy, ax0 + ix:ax1 + ix]
        rdx, rdy, pk = phase_shift(ca, cb, with_peak=True)
        dx, dy = ix + rdx, iy + rdy
        if abs(rdx) < 0.05 and abs(rdy) < 0.05:
            break
    return (dx, dy, pk) if with_peak else (dx, dy)


def patch_flows(a, b, cols=None, rows=None):
    """Shift of each patch on a cols x rows grid between frames a and b:
    array of (x, y, du, dv, peak), x/y relative to the image center.
    Coarse to fine: the overall shift is found first (whole-frame phase
    correlation), then each patch of `a` is matched against the patch of `b`
    displaced by that much -- a patch can only find shifts well under its own
    size. Featureless or poorly matching patches are left out. The default
    grid keeps patches >= ~80 px: smaller ones, after the anti-JPEG-grid
    low-pass, underestimate their shifts."""
    H, W = a.shape
    cols = cols or max(3, min(8, W // 80))
    rows = rows or max(3, min(5, H // 80))
    ph, pw = H // rows, W // cols
    gx, gy, gpk = phase_shift(a, b, with_peak=True)
    gx, gy = (int(round(gx)), int(round(gy))) if gpk > 0.1 else (0, 0)
    out = []
    for r in range(rows):
        for c in range(cols):
            y0, x0 = r * ph, c * pw
            y1, x1 = y0 + gy, x0 + gx
            if y1 < 0 or x1 < 0 or y1 + ph > H or x1 + pw > W:
                # displaced patch leaves the frame: match in place instead
                y1, x1, ox, oy = y0, x0, 0, 0
            else:
                ox, oy = gx, gy
            pa = a[y0:y0 + ph, x0:x0 + pw]
            pb = b[y1:y1 + ph, x1:x1 + pw]
            if pa.std() < 4:
                continue
            du, dv, peak = aligned_shift(pa, pb, with_peak=True)
            if peak < 0.3:
                continue
            out.append(((c + 0.5) * pw - W / 2, (r + 0.5) * ph - H / 2, du + ox, dv + oy, peak))
    return np.array(out)


# -- lens model -------------------------------------------------------------------
# Kannala-Brandt style radial model: a camera-frame direction at angle theta
# from the optical axis lands at distance f * (theta + k1 theta^3) from the
# image center. k1 = 0 is an equidistant fisheye; k1 ~ 1/3 matches a pinhole
# near the center (tan theta = theta + theta^3/3 + ...). Unlike the
# polynomial Brown model it doesn't fold back at the corners for strong
# barrel distortion. The camera page's overlays use the same model (Lynx.lens).

def project(xn, yn, f, k1):
    rn = np.hypot(xn, yn)
    th = np.arctan(rn)
    rd = th + k1 * th ** 3
    s = np.where(rn > 1e-12, rd / np.maximum(rn, 1e-12), 1.0)
    return f * xn * s, f * yn * s


def unproject(px, py, f, k1):
    xd, yd = px / f, py / f
    rd = np.hypot(xd, yd)
    th = rd.copy()
    for _ in range(20):  # Newton on theta + k1 theta^3 = rd
        th = th - (th + k1 * th ** 3 - rd) / (1 + 3 * k1 * th ** 2)
    rn = np.tan(np.clip(th, 0, 1.5))
    s = np.where(rd > 1e-12, rn / np.maximum(rd, 1e-12), 1.0)
    return xd * s, yd * s


def rotation_jacobian(x, y, f, k1, eps=1e-4):
    """d(pixel)/d(w) at pixels (x, y) for a small camera rotation w
    (camera axes x right, y down, z forward): rows (du, dv) x cols (wx, wy, wz)."""
    xn, yn = unproject(x, y, f, k1)
    d = np.stack([xn, yn, np.ones_like(xn)], 1)
    J = np.zeros((len(x), 2, 3))
    for i in range(3):
        e = np.zeros(3)
        e[i] = eps
        d2 = d - np.cross(e, d)  # camera rotated by e = scene rotated by -e
        u, v = project(d2[:, 0] / d2[:, 2], d2[:, 1] / d2[:, 2], f, k1)
        J[:, 0, i] = (u - x) / eps
        J[:, 1, i] = (v - y) / eps
    return J


def fit_rotation(flows, f, k1=1.0 / 3, return_residual=False):
    """Small camera rotation (wx, wy, wz) in radians from patch flows, least
    squares through the lens model, with one round of outlier rejection
    (parallax from near objects, bad matches)."""
    if len(flows) < 4:
        return (None, None) if return_residual else None
    x, y, du, dv, pk = flows.T
    J = rotation_jacobian(x, y, f, k1)
    A = np.concatenate([J[:, 0, :], J[:, 1, :]])
    rhs = np.concatenate([du, dv])
    wts = np.concatenate([pk, pk])
    for _ in range(2):
        sw = np.sqrt(wts)
        w, *_ = np.linalg.lstsq(A * sw[:, None], rhs * sw, rcond=None)
        res = np.abs(A @ w - rhs)
        keep = res < max(3 * np.median(res), 1.0)
        if keep.all() or keep.sum() < 8:
            break
        A, rhs, wts = A[keep], rhs[keep], wts[keep]
    if return_residual:
        return w, float(np.sqrt(np.average((A @ w - rhs) ** 2, weights=wts)))
    return w


def mask_static_cells(pair_flows):
    """Drop grid cells whose content hardly moves while the rest of the frame
    does -- the robot's own body at the bottom of the view turns with the
    camera and would drag every rotation estimate towards zero."""
    moving = [fl for fl in pair_flows if len(fl) and np.median(np.abs(fl[:, 2])) > 4]
    ratios = {}
    for fl in moving:
        m = np.median(np.abs(fl[:, 2]))
        for x, y, du, dv, pk in fl:
            ratios.setdefault((x, y), []).append(abs(du) / m)
    static = {k for k, v in ratios.items() if len(v) > 10 and np.median(v) < 0.5}
    out = [np.array([q for q in fl if (q[0], q[1]) not in static]) if len(fl) else fl for fl in pair_flows]
    return out, static


def band(img, frac=0.5):
    h = img.shape[0]
    return img[int(h * (1 - frac) / 2): int(h * (1 + frac) / 2)]


# -- measurements -------------------------------------------------------------------

def measure_turn(robot, stream, cam, mode, direction, params, tilt=0):
    W, H = MODES[mode]
    set_framesize(cam, mode)
    wait_resolution(stream, W, H)
    robot.get(f"/debug/servo?pan=0&tilt={tilt}")  # pan held at 0 through the turn (turnto suspends follow)
    time.sleep(1.2)
    start_jpg = stream.latest()[1]
    t0 = time.time()
    rate = 0.25 if W <= 640 else 0.18  # slower where the frame rate is lower
    robot.get(f"/debug/panexp?kind=turnto&deg={360 * direction}&rate={rate}&log_ms=25")
    robot.wait_experiment()
    # Read the odometry total while still holding the pan servo at 0: releasing
    # it first hands it back to follow mode, which may swing it before the
    # last frame is taken (and that swing would count as part of the turn).
    turned_odo = robot.json("/debug/servo?pan=0")["turnedDeg"]
    time.sleep(0.8)
    end_t, _ = stream.latest()
    robot.get("/debug/servo?release=1")
    frames = [j for t, j in stream.since(t0) if t <= end_t]
    rec = {"mode": mode, "direction": direction, "tilt": tilt, "turned_odo": turned_odo,
           "wheelbaseMm": params["wheelbaseMm"], "start_jpg": start_jpg, "frames": frames}
    OUT.mkdir(exist_ok=True)
    path = OUT / f"turn_{time.strftime('%Y%m%d_%H%M%S')}_{mode}_{'L' if direction > 0 else 'R'}_t{tilt}.pkl"
    path.write_bytes(pickle.dumps(rec))
    res = analyze_turn(rec)
    res["raw"] = path.name
    print(json.dumps(res))
    return res


def far_band(img):
    """The distant part of the view: with the camera ~10 cm above the floor,
    the lower half is nearby floor, whose parallax (the camera sits off the
    chassis' rotation axis, so it also slides sideways while turning) would
    pollute every rotation measurement. The top 10% is often sky/ceiling."""
    H = img.shape[0]
    return img[int(0.10 * H): int(0.50 * H)]


def center_window(img, frac=0.3):
    W = img.shape[1]
    return img[:, int(W * (1 - frac) / 2): int(W * (1 + frac) / 2)]


def yaw_ratio_model(xs, y, f, k1):
    """Horizontal image motion at (x, y) for a small yaw, relative to x = 0."""
    J = rotation_jacobian(np.array(xs, float), np.full(len(xs), float(y)), f, k1)
    J0 = rotation_jacobian(np.array([0.0]), np.array([float(y)]), f, k1)
    return J[:, 0, 1] / J0[0, 0, 1]


def analyze_turn(rec):
    mode, direction, tilt, turned_odo = rec["mode"], rec["direction"], rec["tilt"], rec["turned_odo"]
    W, H = MODES[mode]
    start = gray(rec["start_jpg"])
    imgs = [start] + [gray(j) for j in rec["frames"]]
    frames = rec["frames"]
    bands = [far_band(im) for im in imgs]

    # 1. Focal length at the image center, from the loop: the center of the
    #    distant band moves f * d(theta) per frame whatever the lens' distortion.
    steps = [aligned_shift(center_window(a), center_window(b))[0] for a, b in zip(bands, bands[1:])]
    eps_px = aligned_shift(bands[0], bands[-1])[0]  # whole band: the leftover can be large
    total_px = float(np.sum(steps))
    sgn = 1.0 if total_px > 0 else -1.0
    f = sgn * (total_px - eps_px) / (2 * math.pi)
    eps_deg = math.degrees(eps_px / f) * sgn
    true_turn = 360.0 + eps_deg

    # 2. Distortion: how much faster the distant band moves off-center.
    band_y = (0.10 + 0.50) / 2 * H - H / 2  # band's mean y, relative to the image center
    cols = max(5, min(9, W // 70))
    pw = W // cols
    per_col = [[] for _ in range(cols)]
    for a, b, c in zip(bands, bands[1:], steps):
        if abs(c) < 4:
            continue  # standing still
        g = int(round(c))
        for i in range(cols):
            x0 = i * pw
            if x0 + g < 0 or x0 + g + pw > W:
                continue  # its displaced counterpart left the frame
            pa, pb = a[:, x0:x0 + pw], b[:, x0 + g:x0 + g + pw]
            if pa.std() < 5:
                continue
            du, _, pk = aligned_shift(pa, pb, with_peak=True)
            if pk > 0.3:
                per_col[i].append((du + g) / c)
    xs = [(i + 0.5) * pw - W / 2 for i in range(cols)]
    ratios = [float(np.median(v)) if len(v) > 10 else float("nan") for v in per_col]
    ok = [i for i, r in enumerate(ratios) if math.isfinite(r)]
    best_k1, best_err = None, None
    for k1 in np.arange(-0.10, 0.501, 0.01):
        pred = yaw_ratio_model([xs[i] for i in ok], band_y, f, k1)
        err = float(np.sum((np.array([ratios[i] for i in ok]) - pred) ** 2))
        if best_err is None or err < best_err:
            best_k1, best_err = float(k1), err
    k1 = best_k1

    # 3. Tilt: the chassis turns about the world vertical, (0, -cos a, -sin a)
    #    in camera axes for a camera pitched down by a; distant-band patches
    #    only. Band rows are offset back to full-image coordinates.
    y_off = int(0.10 * H) + (bands[0].shape[0] / 2) - H / 2
    wsum = np.zeros(3)
    used = 0
    for a, b in zip(bands, bands[1:]):
        fl = patch_flows(a, b, cols=cols, rows=2)
        if len(fl) < 6:
            continue
        fl[:, 1] += y_off
        w = fit_rotation(fl, f, k1)
        if w is not None:
            wsum += w
            used += 1
    ax = wsum / np.linalg.norm(wsum)
    ax = ax if ax[1] < 0 else -ax
    tilt_meas = math.degrees(math.atan2(-ax[2], -ax[1]))

    res = {
        "mode": mode, "width": W, "height": H, "direction": direction, "frames": len(frames),
        "f_px": f, "k1": k1, "k1_fit_err": best_err, "col_x": xs, "col_ratio": ratios,
        "hfov_deg": 2 * math.degrees(math.atan(unproject(np.array([W / 2]), np.array([0.0]), f, k1)[0][0])),
        "vfov_deg": 2 * math.degrees(math.atan(unproject(np.array([0.0]), np.array([H / 2]), f, k1)[1][0])),
        "odometry_turn_deg": abs(turned_odo), "true_turn_deg": true_turn, "leftover_deg": eps_deg,
        "wheelbase_mm_corrected": rec["wheelbaseMm"] * abs(turned_odo) / true_turn,
        "camera_tilt_deg": tilt_meas, "tilt_servo_cmd": tilt, "rotation_frames_used": used,
        "static_cells": [],
    }
    return res


def step_servo(robot, stream, axis, angles, f, k1, static=(), settle=0.9):
    """Hold the servo at each angle in turn; return measured angle per step."""
    measured = []
    prev_img = None
    acc = 0.0
    for a in angles:
        robot.get(f"/debug/servo?{axis}={a}")
        time.sleep(settle)
        img = gray(stream.latest()[1])
        if prev_img is not None:
            # distant band only (see far_band); rows back in full-image coordinates
            H, W = img.shape
            fl = patch_flows(far_band(prev_img), far_band(img), cols=max(5, min(9, W // 70)), rows=2)
            if len(fl):
                fl[:, 1] += int(0.10 * H) + far_band(img).shape[0] / 2 - H / 2
            w = fit_rotation(fl, f, k1)
            if w is None:
                raise RuntimeError(f"{axis} step to {a}: image too featureless to measure")
            # pan +angle = camera turns left = negative rotation about the
            # (down-pointing) camera y axis; tilt +angle = camera tilts up =
            # positive rotation about camera x
            main = -w[1] if axis == "pan" else w[0]
            acc += math.copysign(math.degrees(np.linalg.norm(w)), main)
        measured.append((a, acc))
        prev_img = img
    return measured


def measure_servo(robot, stream, cam, axis, f, k1, mode, span, static=()):
    W, H = MODES[mode]
    set_framesize(cam, mode)
    wait_resolution(stream, W, H)
    other = "tilt" if axis == "pan" else "pan"
    robot.get(f"/debug/servo?{other}=0&{axis}=0")
    time.sleep(1.0)
    step = 5
    up = list(range(0, span + 1, step))
    down = list(range(0, -span - 1, -step))
    m_up = step_servo(robot, stream, axis, up, f, k1, static)
    robot.get(f"/debug/servo?{axis}=0")
    time.sleep(1.0)
    m_down = step_servo(robot, stream, axis, down, f, k1, static)
    robot.get(f"/debug/servo?{axis}=0")
    time.sleep(0.6)
    robot.get("/debug/servo?release=1")
    pts = sorted(set(m_up + m_down))
    print(json.dumps({"axis": axis, "points": pts}))
    return pts


# -- camera control -------------------------------------------------------------

def set_framesize(cam, mode):
    urllib.request.urlopen(f"http://{cam}/control?var=framesize&val={mode}", timeout=5).read()


def wait_resolution(stream, W, H, timeout=10):
    t_end = time.time() + timeout
    while time.time() < t_end:
        f = stream.latest()
        if f is not None:
            img = Image.open(io.BytesIO(f[1]))
            if img.size == (W, H):
                return f[0]
        time.sleep(0.2)
    raise RuntimeError(f"stream never switched to {W}x{H}")


# -- fitting / applying ---------------------------------------------------------

def fit_servo(points, p):
    """Refit each side of the piecewise-linear pulse mapping so that commanded
    angle == actual angle, keeping the center pulse (0 deg = mounting forward).
    points: [(commanded_deg, measured_deg)]; p: pulse settings for this servo
    (minPulse, centerPulse, maxPulse, minAngle, maxAngle)."""
    def pulse(a):
        if a <= 0:
            return p["minPulse"] + (a - p["minAngle"]) / -p["minAngle"] * (p["centerPulse"] - p["minPulse"])
        return p["centerPulse"] + a / p["maxAngle"] * (p["maxPulse"] - p["centerPulse"])

    out = {}
    for side, sel in (("min", lambda a: a < 0), ("max", lambda a: a > 0)):
        pts = [(pulse(a) - p["centerPulse"], m) for a, m in points if sel(a)]
        if len(pts) < 2:
            continue
        x = np.array([q[0] for q in pts])
        y = np.array([q[1] for q in pts])
        k = float((x @ y) / (x @ x))  # deg per us, through the center
        limit = p["minAngle"] if side == "min" else p["maxAngle"]
        out[side + "Pulse"] = p["centerPulse"] + limit / k
        cmd = np.array([a for a, _ in points if sel(a)], dtype=float)
        out[side + "Gain"] = float(np.mean(y / cmd))  # actual / commanded angle, before refitting
        out[side + "Residual_deg"] = float(np.sqrt(np.mean((y - k * x) ** 2)))
    return out


def measure(args):
    robot = Robot(ROBOT_HOST)
    params = robot.json("/params")
    cam = robot.json("/camdiag")["ip"]
    status = json.loads(urllib.request.urlopen(f"http://{cam}/status", timeout=5).read())
    original_mode = status["framesize"]
    stream = Stream(f"http://{cam}:81/stream")
    stream.start()
    results = {"when": datetime.datetime.now().isoformat(timespec="seconds"), "before": params, "turns": [], "servos": {}}
    try:
        robot.get("/debug/servo?pan=0&tilt=0")
        time.sleep(1.0)
        robot.get("/debug/servo?release=1")
        modes = args.modes.split(",")
        direction = 1
        for mode in modes:
            results["turns"].append(measure_turn(robot, stream, cam, mode, direction, params))
            direction = -direction  # alternate, so any tether never winds up
        if "vga" in modes:  # a second VGA turn the other way, for the wheelbase average
            results["turns"].append(measure_turn(robot, stream, cam, "vga", direction, params))
            direction = -direction
            # tilt-sign/scale check: camera held 20 deg further down should
            # read ~20 deg more tilt (positive tilt servo angle = camera up)
            results["tilt_check"] = measure_turn(robot, stream, cam, "vga", direction, params, tilt=-20)
            robot.get("/debug/servo?tilt=0")
            time.sleep(0.5)
            robot.get("/debug/servo?release=1")
        vga = [t for t in results["turns"] if t["mode"] == "vga"]
        if vga:
            f_vga = float(np.mean([t["f_px"] for t in vga]))
            k1_vga = float(np.mean([t["k1"] for t in vga]))
            # the robot's own body in view: moves relative to the camera when
            # the servos turn it, so it's no reference for the servo steps
            static = {tuple(c) for t in vga for c in t["static_cells"]}
            if not args.skip_pan:
                results["servos"]["pan"] = measure_servo(robot, stream, cam, "pan", f_vga, k1_vga, "vga", 60, static)
            if not args.skip_tilt:
                results["servos"]["tilt"] = measure_servo(robot, stream, cam, "tilt", f_vga, k1_vga, "vga", 30, static)
    finally:
        try:
            robot.get("/debug/servo?release=1")
        except Exception:
            pass
        set_framesize(cam, original_mode)
        stream.stop = True
    OUT.mkdir(exist_ok=True)
    path = OUT / f"calib_{time.strftime('%Y%m%d_%H%M%S')}.json"
    path.write_text(json.dumps(results, indent=1))
    print("saved", path)
    summarize(results)


def proposal(results):
    b = results["before"]
    turns = results["turns"]
    # camcal version 2: lens model r = fPx * (theta + k1 theta^3), see calibrate.py
    prop = {"settings": {}, "camcal": {"version": 2, "measured": results["when"], "modes": {}}}
    by_mode = {}
    for t in turns:
        by_mode.setdefault(t["mode"], []).append(t)
    for mode, ts in by_mode.items():
        f = float(np.mean([t["f_px"] for t in ts]))
        W, H = MODES[mode]
        k1 = float(np.mean([t["k1"] for t in ts]))
        prop["camcal"]["modes"][f"{W}x{H}"] = {
            "fPx": round(f, 2), "k1": round(k1, 4), "name": mode,
            "hfovDeg": round(float(np.mean([t["hfov_deg"] for t in ts])), 2),
            "vfovDeg": round(float(np.mean([t["vfov_deg"] for t in ts])), 2)}
    prop["settings"]["wheelbaseMm"] = round(float(np.mean([t["wheelbase_mm_corrected"] for t in turns])), 1)
    prop["settings"]["cameraTiltDeg"] = round(float(np.mean([t["camera_tilt_deg"] for t in turns])), 1)
    if "640x480" in prop["camcal"]["modes"]:
        prop["settings"]["cameraVerticalFovDeg"] = prop["camcal"]["modes"]["640x480"]["vfovDeg"]
    # Servos: rather than moving the end pulses out to wherever +-90 deg would
    # be (possibly past the servo's or mount's mechanical stops), keep the
    # pulses and correct the ANGLE each end pulse really produces -- identical
    # mapping inside the range, and never driven further than before.
    sv = results.get("servos", {})
    for axis, pre in (("pan", "servo"), ("tilt", "tilt")):
        if axis not in sv:
            continue
        p = {"minPulse": b[pre + "MinPulseUs"], "centerPulse": b[pre + "CenterPulseUs"], "maxPulse": b[pre + "MaxPulseUs"],
             "minAngle": b[pre + "MinAngleDeg"], "maxAngle": b[pre + "MaxAngleDeg"]}
        fit = fit_servo([tuple(q) for q in sv[axis]], p)
        prop[axis + "_fit"] = fit
        for side in ("min", "max"):
            if side + "Pulse" in fit:
                old_span = p[side + "Pulse"] - p["centerPulse"]
                new_span = fit[side + "Pulse"] - p["centerPulse"]
                limit = p[side + "Angle"] * old_span / new_span
                prop["settings"][pre + side.capitalize() + "AngleDeg"] = round(limit, 1)
    return prop


def summarize(results):
    prop = proposal(results)
    b = results["before"]
    print("\nproposed changes:")
    for k, v in prop["settings"].items():
        print(f"  {k}: {b.get(k)} -> {v}")
    for k, v in prop["camcal"]["modes"].items():
        print(f"  camera {k}: {v}")
    for axis in ("pan_fit", "tilt_fit"):
        if axis in prop:
            print(f"  {axis}: {prop[axis]}")


def apply(args):
    results = json.loads(Path(args.results).read_text())
    prop = proposal(results)
    robot = Robot(ROBOT_HOST)
    q = "&".join(f"{k}={v}" for k, v in prop["settings"].items())
    print("/set", robot.get(f"/set?{q}"))
    body = json.dumps(prop["camcal"])
    conn = http.client.HTTPConnection(ROBOT_HOST, timeout=10)
    conn.request("POST", "/appdata/camcal", body, {"Content-Type": "application/json"})
    r = conn.getresponse()
    print("/appdata/camcal", r.status, r.read()[:80])


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    m = sub.add_parser("measure")
    m.add_argument("--modes", default="vga,qvga,cif,svga,xga,hd")
    m.add_argument("--skip-pan", action="store_true")
    m.add_argument("--skip-tilt", action="store_true")
    a = sub.add_parser("apply")
    a.add_argument("results")
    s = sub.add_parser("summary")
    s.add_argument("results")
    r = sub.add_parser("reanalyze")  # recompute turns from saved raw frames
    r.add_argument("raw", nargs="+")
    args = ap.parse_args()
    if args.cmd == "measure":
        measure(args)
    elif args.cmd == "apply":
        apply(args)
    elif args.cmd == "reanalyze":
        for p in args.raw:
            print(json.dumps(analyze_turn(pickle.loads(Path(p).read_bytes()))))
    else:
        summarize(json.loads(Path(args.results).read_text()))
