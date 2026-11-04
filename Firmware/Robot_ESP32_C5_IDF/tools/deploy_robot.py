#!/usr/bin/env python3
"""Uploads a build to the robot over Wi-Fi: the firmware (/update) and the
web files' LittleFS image (/update-fs, zlib-compressed), then checks that the
robot serves the new files. Run `idf.py build` first.

The OTA password is asked for (or taken from LYNXP_OTA_PASSWORD); the user
name is "admin" unless --user says otherwise.

usage: deploy_robot.py [--robot 192.168.0.17] [--user admin] [--firmware-only | --web-only]
"""

import argparse
import base64
import getpass
import hashlib
import os
import time
import urllib.error
import urllib.request
import zlib

BUILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "build")


def post(url, data, auth, timeout=300):
    req = urllib.request.Request(url, data=data, method="POST",
                                 headers={"Content-Type": "application/octet-stream", "Authorization": auth})
    try:
        return urllib.request.urlopen(req, timeout=timeout).read().decode(errors="replace").strip()
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{url}: HTTP {e.code} {e.read().decode(errors='replace').strip()}")


def wait_until_up(robot, seconds=90):
    end = time.time() + seconds
    time.sleep(5)
    while time.time() < end:
        try:
            urllib.request.urlopen(f"{robot}/wifi/status", timeout=3).read()
            return
        except Exception:
            time.sleep(2)
    raise SystemExit("the robot didn't come back")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--robot", default="192.168.0.17")
    ap.add_argument("--user", default="admin")
    only = ap.add_mutually_exclusive_group()
    only.add_argument("--firmware-only", action="store_true")
    only.add_argument("--web-only", action="store_true")
    a = ap.parse_args()
    robot = "http://" + a.robot
    password = os.environ.get("LYNXP_OTA_PASSWORD")
    if password is None:
        password = getpass.getpass(f"OTA password for {a.user}@{a.robot}: ")
    auth = "Basic " + base64.b64encode(f"{a.user}:{password}".encode()).decode()

    if not a.web_only:
        fw = open(os.path.join(BUILD, "robot_firmware.bin"), "rb").read()
        print(f"firmware ({len(fw) // 1024} KB) ...", post(f"{robot}/update", fw, auth))
        wait_until_up(robot)

    if not a.firmware_only:
        image = zlib.compress(open(os.path.join(BUILD, "storage.bin"), "rb").read(), 9)
        print(f"web files ({len(image) // 1024} KB compressed) ...", post(f"{robot}/update-fs?format=zlib", image, auth))
        wait_until_up(robot)
        # what the robot serves now == what was built (asked without gzip: the originals)
        web = os.path.join(BUILD, "littlefs_web")
        for f in ("cam.html", "cam.js", "lynx_common.js"):
            got = urllib.request.urlopen(f"{robot}/{f}", timeout=10).read()
            same = hashlib.md5(got).digest() == hashlib.md5(open(os.path.join(web, f), "rb").read()).digest()
            print(f"  {f}: {'ok' if same else 'DIFFERENT'}")
    print("done")


if __name__ == "__main__":
    main()
