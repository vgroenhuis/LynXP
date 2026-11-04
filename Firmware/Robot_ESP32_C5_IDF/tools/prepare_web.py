#!/usr/bin/env python3
"""Builds the littlefs image's contents from main/littlefs_image/ (run by
main/CMakeLists.txt before the image is made).

Every file is copied as-is. Next to each text file (.html .js .css .json
.svg) that compresses well goes NAME.gz, which web_server.cpp sends instead
(Content-Encoding: gzip) to browsers that accept it -- JavaScript shrinks to
about a quarter. And web_etags.txt lists each file's content hash, the
ETag web_server.cpp answers If-None-Match with: an unchanged file costs a
"304 Not Modified" instead of the whole file.

Deterministic (no timestamps in the .gz files) and only rewrites what
changed, so a filesystem OTA (/update-fs) still only rewrites the sectors
of the files that really changed.

usage: prepare_web.py SRC_DIR OUT_DIR
"""

import gzip
import hashlib
import os
import sys

COMPRESS = (".html", ".js", ".css", ".json", ".svg")
MIN_SIZE = 1024  # (smaller files: the saving doesn't pay for a second file)
MANIFEST = "web_etags.txt"


def write_if_changed(path, data):
    try:
        with open(path, "rb") as f:
            if f.read() == data:
                return
    except FileNotFoundError:
        pass
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def main(src, out):
    wanted = set()
    etags = []
    for root, dirs, files in os.walk(src):
        dirs.sort()
        for name in sorted(files):
            full = os.path.join(root, name)
            rel = os.path.relpath(full, src).replace(os.sep, "/")
            with open(full, "rb") as f:
                data = f.read()
            write_if_changed(os.path.join(out, rel), data)
            wanted.add(rel)
            etags.append(f"/{rel} {hashlib.md5(data).hexdigest()[:16]}")
            if name.endswith(COMPRESS) and len(data) >= MIN_SIZE:
                packed = gzip.compress(data, compresslevel=9, mtime=0)
                if len(packed) < len(data) * 0.9:
                    write_if_changed(os.path.join(out, rel + ".gz"), packed)
                    wanted.add(rel + ".gz")
    write_if_changed(os.path.join(out, MANIFEST), ("\n".join(etags) + "\n").encode())
    wanted.add(MANIFEST)
    # drop what's no longer in the source (a renamed or deleted page)
    for root, dirs, files in os.walk(out, topdown=False):
        for name in files:
            full = os.path.join(root, name)
            if os.path.relpath(full, out).replace(os.sep, "/") not in wanted:
                os.remove(full)
        if root != out and not os.listdir(root):
            os.rmdir(root)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
