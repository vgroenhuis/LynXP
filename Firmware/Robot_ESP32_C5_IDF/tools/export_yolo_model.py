"""Builds the object-detection model the LynXP web UI runs (detect.js).

Exports Ultralytics YOLOv8n (COCO, 80 classes) to ONNX with a dynamic input
size, then stores its weights as float16 with a Cast back to float32 in front
of each one. That halves the file (~12.8 MB -> ~6.4 MB, so it fits the
robot's "model" flash partition) without any accuracy loss worth measuring:
onnxruntime constant-folds the Casts when the session is created, so
inference itself still runs entirely in float32.

Usage (needs: pip install ultralytics onnx onnxruntime):
    python tools/export_yolo_model.py [out.onnx]   (default: yolov8n-lynxp.onnx)
Then install it from the Games & apps page, or:
    curl --data-binary @yolov8n-lynxp.onnx "http://<robot-ip>/models/upload?name=yolov8n-lynxp.onnx"
"""

import sys
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
from onnx import TensorProto, helper, numpy_helper
from ultralytics import YOLO
from ultralytics.utils import ASSETS


def compress_weights_to_fp16(model: onnx.ModelProto) -> int:
    graph = model.graph
    casts, kept, converted = [], [], 0
    for init in graph.initializer:
        if init.data_type == TensorProto.FLOAT and int(np.prod(init.dims)) > 16:
            half = numpy_helper.from_array(numpy_helper.to_array(init).astype(np.float16), init.name + "__fp16")
            kept.append(half)
            casts.append(helper.make_node("Cast", [half.name], [init.name], to=TensorProto.FLOAT,
                                          name=init.name + "__cast"))
            converted += 1
        else:
            kept.append(init)
    del graph.initializer[:]
    graph.initializer.extend(kept)
    nodes = casts + list(graph.node)
    del graph.node[:]
    graph.node.extend(nodes)
    return converted


def letterbox(img_bgr, size):
    import cv2
    h, w = img_bgr.shape[:2]
    scale = min(size / w, size / h)
    resized = cv2.resize(img_bgr, (round(w * scale), round(h * scale)))
    canvas = np.full((size, size, 3), 114, np.uint8)
    canvas[: resized.shape[0], : resized.shape[1]] = resized
    x = canvas[:, :, ::-1].astype(np.float32).transpose(2, 0, 1)[None] / 255.0
    return np.ascontiguousarray(x)


def main():
    out_path = Path(sys.argv[1] if len(sys.argv) > 1 else "yolov8n-lynxp.onnx").resolve()
    exported = Path(YOLO("yolov8n.pt").export(format="onnx", imgsz=320, dynamic=True, simplify=True, opset=17)).resolve()
    if out_path == exported:
        sys.exit(f"Output path {out_path} would overwrite Ultralytics' own export -- pick another name.")

    model = onnx.load(str(exported))
    n = compress_weights_to_fp16(model)
    onnx.checker.check_model(model)
    onnx.save(model, str(out_path))
    print(f"{n} weight tensors -> fp16; {exported.stat().st_size / 1e6:.1f} MB -> {out_path.stat().st_size / 1e6:.1f} MB")

    # Sanity check: both models agree, at two input sizes, on a real image.
    import cv2
    img = cv2.imread(str(ASSETS / "bus.jpg"))
    for size in (320, 416):
        x = letterbox(img, size)
        ref = ort.InferenceSession(str(exported)).run(None, {"images": x})[0]
        new = ort.InferenceSession(str(out_path)).run(None, {"images": x})[0]
        box_diff = np.abs(ref[0, :4] - new[0, :4]).max()      # rows 0-3: cx, cy, w, h in input pixels
        score_diff = np.abs(ref[0, 4:] - new[0, 4:]).max()    # rows 4-83: class scores, 0..1
        print(f"{size}px: output {new.shape}, max box diff {box_diff:.2f} px, max score diff {score_diff:.4f}, "
              f"anchors > 0.5: ref {(ref[0, 4:].max(0) > 0.5).sum()} / fp16 {(new[0, 4:].max(0) > 0.5).sum()}")


if __name__ == "__main__":
    main()
