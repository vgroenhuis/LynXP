#!/usr/bin/env python3
"""Builds the web demo: the robot's web pages (main/littlefs_image/) as a
static site that runs without a robot -- for GitHub Pages (the workflow
.github/workflows/web-demo.yml), or locally:

    python3 tools/web_demo/build.py OUT_DIR
    python3 -m http.server -d OUT_DIR 8000     (then open http://localhost:8000)

Every file is copied as-is, except the pages: robot_sim.js (a simulated
robot, see there) goes in first, and the robot's root-relative links (/cam,
/games, /gametable.html...) become relative ones, so the site works in a
sub-folder (https://<user>.github.io/<repo>/).
"""

import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "..", "main", "littlefs_image")
ROUTES = {"/": "index.html", "/cam": "cam.html", "/games": "games.html", "/wifi": "wifi.html", "/tags": "tags.html"}
SKIP = re.compile(r"\.(png|jpe?g|gz)$", re.I)  # (stray screenshots, build output)


def fix_links(html):
    def repl(m):
        attr, path, rest = m.group(1), m.group(2), m.group(3) or ""
        if path in ROUTES:
            path = ROUTES[path]
        elif re.fullmatch(r"/[\w.-]+\.html", path):
            path = path[1:]
        else:
            return m.group(0)
        return f'{attr}="{path}{rest}"'

    return re.sub(r'\b(href|action)="(/[\w./-]*?)([?#][^"]*)?"', repl, html)


def main():
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    out = sys.argv[1]
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)
    for name in sorted(os.listdir(SRC)):
        src = os.path.join(SRC, name)
        if not os.path.isfile(src) or SKIP.search(name):
            continue
        dst = os.path.join(out, name)
        if name.endswith(".html"):
            with open(src, encoding="utf-8") as f:
                html = f.read()
            html = fix_links(html)
            # the simulated robot: before any of the page's own scripts
            html = re.sub(r"(<head[^>]*>)", r'\1\n  <script src="robot_sim.js"></script>', html, count=1)
            with open(dst, "w", encoding="utf-8") as f:
                f.write(html)
        else:
            shutil.copyfile(src, dst)
    shutil.copyfile(os.path.join(HERE, "robot_sim.js"), os.path.join(out, "robot_sim.js"))
    open(os.path.join(out, ".nojekyll"), "w").close()
    print(f"web demo: {len(os.listdir(out))} files in {out}")


if __name__ == "__main__":
    main()
