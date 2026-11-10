"""Local STT server: Parakeet-TDT-0.6B-v3 via sherpa-onnx (faster and
better ES than Whisper small on CPU). Same API as whisper_server.py:
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
    # Own VmSwap: makes the root cause of slow STT visible (09/11:
    # kswapd evicts ~680MB of the encoder after 4min idle and the first decode
    # pays ~5s of page-in). Cheap: one read of /proc/self/status.
    out = {"ok": True, "model": "parakeet-v3"}
    try:
        with open("/proc/self/status") as fh:
            for line in fh:
                if line.startswith("VmSwap:"):
                    out["vmSwapKb"] = int(line.split()[1])
                    break
    except Exception:
        pass
    return out


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


def _find_warmup_wav():
    # REAL audio for the warmup (silence emits ~0 tokens and doesn't exercise
    # the TDT loop; the chirp does). Order: repo fixture, model test_wavs,
    # test_wavs next to the server.
    import glob

    here = os.path.dirname(os.path.abspath(__file__))
    candidates = [os.path.join(here, "..", "..", "tests", "fixtures", "parakeet-warmup.wav")]
    candidates += sorted(glob.glob(os.path.join(MODEL_DIR, "test_wavs", "*.wav")))
    candidates += sorted(glob.glob(os.path.join(here, "test_wavs", "*.wav")))
    for c in candidates:
        if os.path.isfile(c):
            return c
    return None


def _synth_chirp(seconds=0.7):
    # Fallback if there's no wav at all: 300->1400Hz chirp with harmonics
    # (never silence: it must emit real tokens).
    import numpy as np

    n = int(16000 * seconds)
    t = np.arange(n) / 16000
    f = 300 + (1400 - 300) * t / seconds
    phase = 2 * np.pi * np.cumsum(f) / 16000
    env = np.sin(np.pi * t / seconds) ** 0.5
    return (env * (0.6 * np.sin(phase) + 0.25 * np.sin(2 * phase))).astype(np.float32)


if __name__ == "__main__":
    import uvicorn

    # Tolerant warmup: loads encoder/decoder/joiner + FULL decode with
    # real speech so the first turn pays neither the load nor the page-in
    # (~5s under swap). If the model is missing, warn and start anyway (the
    # STT falls back to Whisper as before, the chain doesn't die).
    try:
        _rec = get_recognizer()
        _wav_path = _find_warmup_wav()
        if _wav_path:
            with open(_wav_path, "rb") as _fh:
                _samples, _ = _wav_to_float32(_fh.read())
            print(f"[parakeet] warmup con {_wav_path}")
        else:
            _samples = _synth_chirp()
            print("[parakeet] warmup con chirp sintetizado (sin fixture)")
        _s = _rec.create_stream()
        _s.accept_waveform(16000, _samples)
        _rec.decode_stream(_s)
        print(f"[parakeet] warmup texto: {(_s.result.text or '').strip()[:60]!r}")
    except Exception as _e:
        print(f"[parakeet] warmup falló ({_e}); arranco igual")
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.environ.get("PARAKEET_PORT", "7790")),
        log_level="warning",
    )
