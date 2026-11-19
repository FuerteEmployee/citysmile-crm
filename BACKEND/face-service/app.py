"""HRMS face service: face detection + face embeddings for HRMS Face Attendance.

Stateless on purpose: it keeps no employees, photos or attendance. The Node
backend stores each employee's enrolled embeddings (FaceProfile) and does the
matching (src/hrms/utils/faceRecognition.js), so tenancy, permissions and the
attendance rules all stay in one place.

Models and head-pose logic are ported from BOTLens (YuNet detector + SFace
recogniser). Setup and run:

    python -m venv venv && venv/bin/pip install -r requirements.txt   (Windows: venv\\Scripts\\...)
    venv/bin/python -m uvicorn app:app --host 127.0.0.1 --port 8100
    # on the server, under PM2:
    pm2 start venv/bin/python --name face-service -- -m uvicorn app:app --host 127.0.0.1 --port 8100

The backend finds it via FACE_SERVICE_URL (default http://127.0.0.1:8100).

Keep it on 127.0.0.1: only the Node backend should call it. Set
FACE_SERVICE_KEY here and in the backend .env to require a shared key.
"""
import base64
import os
import threading
from typing import List

import cv2
import numpy as np
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel

MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
SERVICE_KEY = os.getenv("FACE_SERVICE_KEY", "")

# Big photos are downscaled before detection (faster, no accuracy loss for a
# face filling part of the frame); tiny frames are upscaled so YuNet still
# finds faces in them.
MAX_SIDE = 1280
MIN_SIDE = 400

detector = cv2.FaceDetectorYN.create(
    os.path.join(MODELS_DIR, "face_detection_yunet_2023mar.onnx"), "", (320, 320), 0.6, 0.3, 5000
)
recognizer = cv2.FaceRecognizerSF.create(os.path.join(MODELS_DIR, "face_recognition_sface_2021dec.onnx"), "")
# The detector keeps per-call state (its input size), and FastAPI runs sync
# endpoints on a thread pool, so model calls are serialised.
model_lock = threading.Lock()

app = FastAPI(title="HRMS Face Service")


class EmbedRequest(BaseModel):
    images: List[str]  # base64 JPEG/PNG; a "data:image/...;base64," prefix is fine
    max_faces: int = 5


def decode_image(b64: str):
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[-1]
    try:
        buf = np.frombuffer(base64.b64decode(b64), np.uint8)
    except Exception:
        return None
    return cv2.imdecode(buf, cv2.IMREAD_COLOR) if buf.size else None


def head_pose(det):
    """Rough yaw/pitch from YuNet's eye + nose landmarks (from BOTLens). Used by
    the enrolment screen to ask for a straight / left / right photo."""
    lex, ley, rex, rey, nx, ny = (float(v) for v in det[4:10])
    eye_dist = max(1.0, abs(rex - lex))
    ratio_x = (nx - min(lex, rex)) / eye_dist
    ratio_y = (ny - (ley + rey) / 2) / eye_dist
    yaw = "RIGHT" if ratio_x < 0.38 else "LEFT" if ratio_x > 0.62 else "CENTER"
    pitch = "UP" if ratio_y < 0.28 else "DOWN" if ratio_y > 0.58 else "CENTER"
    return {"yaw": yaw, "pitch": pitch}


def analyse(img, max_faces: int):
    h, w = img.shape[:2]
    long_side = max(h, w)
    scale = MAX_SIDE / long_side if long_side > MAX_SIDE else 2.0 if long_side < MIN_SIDE else 1.0
    work = cv2.resize(img, (0, 0), fx=scale, fy=scale) if scale != 1.0 else img

    faces = []
    with model_lock:
        detector.setInputSize((work.shape[1], work.shape[0]))
        _, dets = detector.detect(work)
        if dets is not None:
            # Largest face first: at a kiosk or in a selfie that is the person in front.
            for det in sorted(dets, key=lambda d: d[2] * d[3], reverse=True)[:max_faces]:
                feature = recognizer.feature(recognizer.alignCrop(work, det))[0]
                x, y, fw, fh = (float(v) / scale for v in det[0:4])
                faces.append({
                    "box": [round(x), round(y), round(fw), round(fh)],
                    "score": round(float(det[14]), 3),
                    "pose": head_pose(det),
                    "embedding": [round(float(v), 6) for v in feature],
                })
    return {"width": w, "height": h, "faces": faces}


@app.get("/health")
def health():
    return {"ok": True, "models": "yunet-2023mar + sface-2021dec"}


@app.post("/embed")
def embed(req: EmbedRequest, x_face_service_key: str = Header(default="")):
    if SERVICE_KEY and x_face_service_key != SERVICE_KEY:
        raise HTTPException(status_code=401, detail="Invalid face service key")
    if not 1 <= len(req.images) <= 10:
        raise HTTPException(status_code=400, detail="Send between 1 and 10 images")
    max_faces = max(1, min(req.max_faces, 10))
    results = []
    for b64 in req.images:
        img = decode_image(b64)
        results.append({"error": "Invalid image"} if img is None else analyse(img, max_faces))
    return {"results": results}
