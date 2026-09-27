"""Packs an .onnx model into the robot's "model" partition format, for
installing over USB instead of uploading from the Games & apps page.

Layout (must match main/model_store.cpp): a 4096-byte header sector --
magic "LXMODEL1", u32 size, u32 FNV-1a checksum of the file, 48-byte name --
then the file itself.

    python tools/model_partition_image.py yolov8n-lynxp.onnx build/model.bin
    parttool.py -p COM7 write_partition --partition-name model --input build/model.bin
"""

import struct
import sys
from pathlib import Path


def fnv1a(data: bytes) -> int:
    h = 2166136261
    for b in data:
        h = ((h ^ b) * 16777619) & 0xFFFFFFFF
    return h


def main():
    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    data = src.read_bytes()
    name = src.name.encode()[:47]
    header = struct.pack("<8sII48s", b"LXMODEL1", len(data), fnv1a(data), name)
    dst.write_bytes(header.ljust(4096, b"\xff") + data)
    print(f"{dst}: {len(data)} bytes, version {fnv1a(data):08x}")


if __name__ == "__main__":
    main()
