"""Estimate where the camera sits relative to the chassis' rotation axis from
recorded in-place turns (calibrate.py's raw turn_*.pkl, pan servo held at 0).
Floor points move by the rotation (measured from the distant band) PLUS the
camera's own sideways travel around the axis, which depends on the offset --
solved by least squares: a = forward, b = left of the axis (m).

usage: python camera_offset.py <f_px> <k1> <height_m> <tilt_deg> turn_*.pkl ...
"""
import math, pickle, sys
import numpy as np
import calibrate as C

def main():
    f, k1, h, tilt = (float(v) for v in sys.argv[1:5])
    t = math.radians(tilt)
    A_all, r_all = [], []
    for path in sys.argv[5:]:
        rec = pickle.loads(open(path, "rb").read())
        imgs = [C.gray(j) for j in rec["frames"]]
        H, W = imgs[0].shape
        cols = max(5, min(9, W // 70))
        for a, b in zip(imgs, imgs[1:]):
            # rotation from the distant band
            fa, fb = C.far_band(a), C.far_band(b)
            fl = C.patch_flows(fa, fb, cols=cols, rows=2)
            if len(fl) < 6:
                continue
            fl[:, 1] += int(0.10 * H) + fa.shape[0] / 2 - H / 2
            w = C.fit_rotation(fl, f, k1)
            if w is None or abs(w[1]) < math.radians(0.8):
                continue  # standing still
            dth = -w[1]  # chassis turn this frame (left = +)
            # floor band: rows 60-90% of the height (below the horizon, above the robot's own body)
            y0, y1 = int(0.60 * H), int(0.90 * H)
            flf = C.patch_flows(a[y0:y1], b[y0:y1], cols=cols, rows=2)
            if not len(flf):
                continue
            flf[:, 1] += y0 + (y1 - y0) / 2 - H / 2
            x, y, du, dv, pk = flf.T
            J = C.rotation_jacobian(x, y, f, k1)
            rot = np.einsum("nij,j->ni", J, w)
            ru, rv = du - rot[:, 0], dv - rot[:, 1]
            # floor point for each patch: ray-floor intersection
            xn, yn = C.unproject(x, y, f, k1)
            down = yn * math.cos(t) + math.sin(t)
            ok = down > 0.02
            s = h / down  # z (depth along the optical axis)
            # camera translation in camera axes for offset (a fwd, b left): T = (-a*dth, 0, -b*dth)
            # flow of a point at depth z from translation T: d(xn) = (-Tx + xn*Tz)/z, d(yn) = (-Ty + yn*Tz)/z
            # pixel flow ~ local lens scale x d(xn, yn); use a numerical derivative of project()
            eps = 1e-4
            pu0, pv0 = C.project(xn, yn, f, k1)
            pux, pvx = C.project(xn + eps, yn, f, k1)
            puy, pvy = C.project(xn, yn + eps, f, k1)
            Jx = np.stack([(pux - pu0) / eps, (pvx - pv0) / eps], 1)  # d(pixel)/d(xn)
            Jy = np.stack([(puy - pu0) / eps, (pvy - pv0) / eps], 1)  # d(pixel)/d(yn)
            # d(xn) per unit a: (a*dth)/z ; per unit b: (xn * -b*dth)/z -> coefficient -xn*dth/z
            dxa = dth / s; dya = 0 * s
            dxb = -xn * dth / s; dyb = -yn * dth / s
            ca = Jx * dxa[:, None] + Jy * dya[:, None]
            cb = Jx * dxb[:, None] + Jy * dyb[:, None]
            for i in np.nonzero(ok & (s < 3.0))[0]:
                A_all.append([ca[i, 0], cb[i, 0]]); r_all.append(ru[i])
                A_all.append([ca[i, 1], cb[i, 1]]); r_all.append(rv[i])
    A, r = np.array(A_all), np.array(r_all)
    keep = np.ones(len(r), bool)
    for _ in range(3):
        sol, *_ = np.linalg.lstsq(A[keep], r[keep], rcond=None)
        res = np.abs(A @ sol - r)
        keep = res < max(3 * np.median(res[keep]), 0.5)
    print(f"camera offset from the rotation axis: forward {sol[0]*100:.1f} cm, left {sol[1]*100:.1f} cm "
          f"({keep.sum()} of {len(r)} equations kept, residual {np.sqrt(np.mean((A[keep] @ sol - r[keep])**2)):.2f} px)")

if __name__ == "__main__":
    main()
