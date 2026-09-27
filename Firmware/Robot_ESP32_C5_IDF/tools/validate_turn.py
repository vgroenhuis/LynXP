"""Check a lens calibration against odometry: turn the chassis ~30 deg in
place (pan servo held) and compare the rotation measured from the before/
after stills with the odometry turn (wheelbase must already be calibrated).

usage: python validate_turn.py <calib_results.json or 'current'> [modes]
"""
import json, math, sys, time, urllib.request
import numpy as np
import calibrate as C

def main():
    robot = C.Robot(C.ROBOT_HOST)
    if sys.argv[1] == "current":
        camcal = robot.json("/appdata/camcal")
    else:
        camcal = C.proposal(json.loads(open(sys.argv[1]).read()))["camcal"]
    modes = (sys.argv[2] if len(sys.argv) > 2 else "qvga,vga,svga").split(",")
    cam = robot.json("/camdiag")["ip"]
    orig = json.loads(urllib.request.urlopen(f"http://{cam}/status", timeout=5).read())["framesize"]
    st = C.Stream(f"http://{cam}:81/stream"); st.start()
    try:
        for mode in modes:
            W, H = C.MODES[mode]
            m = camcal["modes"][f"{W}x{H}"]
            C.set_framesize(cam, mode); C.wait_resolution(st, W, H)
            robot.get("/debug/servo?pan=0&tilt=0"); time.sleep(1.5)
            a = C.gray(st.latest()[1])
            robot.get("/debug/panexp?kind=turnto&deg=30&rate=0.2&log_ms=25"); robot.wait_experiment()
            odo = robot.json("/debug/servo?pan=0&tilt=0")["turnedDeg"]; time.sleep(1.0)
            b = C.gray(st.latest()[1])
            fl = C.patch_flows(a, b)
            w = C.fit_rotation(fl, m["fPx"], m["k1"])
            cam_deg = math.degrees(np.linalg.norm(w)) if w is not None else float("nan")
            print(f"{mode}: odometry {odo:.2f} deg, image {cam_deg:.2f} deg -> ratio {cam_deg / odo:.3f} ({len(fl)} patches)")
            robot.get("/debug/panexp?kind=turnto&deg=-30&rate=0.2&log_ms=25"); robot.wait_experiment()
    finally:
        robot.get("/debug/servo?release=1"); C.set_framesize(cam, orig); st.stop = True

if __name__ == "__main__":
    main()
