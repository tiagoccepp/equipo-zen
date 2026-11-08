"""Servidor STT local: Parakeet-TDT-0.6B-v3 vía sherpa-onnx (más rápido y
mejor ES que Whisper small en CPU). Misma API que whisper_server.py:
  GET  /health                → {"ok": true, "model": "parakeet-v3"}
  POST /v1/transcribe         → {"text": "...", "language": "es", "durationMs": 1234}
       body JSON: {"audio_base64": "<wav>", "language": "es"|null}
"""

import base64
import io
import os
import time
import wave

from fastapi import FastAPI
from pydantic import BaseModel

MODEL_DIR = os.environ.get(
    "PARAKEET_DIR",
    "/home/tito/.local/share/equipo/sherpa/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
)
THREADS = int(os.environ.get("PARAKEET_THREADS", "4"))

app = FastAPI(title="Parakeet local")
_recognizer = None


def get_recognizer():
    global _recognizer
    if _recognizer is None:
        import sherpa_onnx

        _recognizer = sherpa_onnx.OfflineRecognizer.from_transducer(
            encoder=os.path.join(MODEL_DIR, "encoder.int8.onnx"),
            decoder=os.path.join(MODEL_DIR, "decoder.int8.onnx"),
            joiner=os.path.join(MODEL_DIR, "joiner.int8.onnx"),
            tokens=os.path.join(MODEL_DIR, "tokens.txt"),
            num_threads=THREADS,
            sample_rate=16000,
            feature_dim=128,
            decoding_method="greedy_search",
            model_type="nemo_transducer",
        )
    return _recognizer


class TranscribeRequest(BaseModel):
    audio_base64: str
    language: str | None = None
    model: str | None = None


@app.get("/health")
def health():
    return {"ok": True, "model": "parakeet-v3"}


def _wav_to_float32(raw: bytes):
    import numpy as np

    with wave.open(io.BytesIO(raw), "rb") as w:
        assert w.getframerate() == 16000, f"solo 16kHz, llegó {w.getframerate()}"
        assert w.getnchannels() == 1, "solo mono"
        assert w.getsampwidth() == 2, "solo 16-bit"
        frames = w.readframes(w.getnframes())
    return (np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0, w.getnframes() / 16000)


@app.post("/v1/transcribe")
def transcribe(request: TranscribeRequest):
    started = time.monotonic()
    raw = base64.b64decode(request.audio_base64)
    samples, duration_s = _wav_to_float32(raw)
    recognizer = get_recognizer()
    stream = recognizer.create_stream()
    stream.accept_waveform(16000, samples)
    recognizer.decode_stream(stream)
    text = stream.result.text.strip()
    duration_ms = int((time.monotonic() - started) * 1000)
    return {"text": text, "language": request.language or "es", "durationMs": duration_ms}
