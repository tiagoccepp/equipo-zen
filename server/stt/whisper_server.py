"""Local STT server: Whisper (OpenAI open source) via faster-whisper.

Runs 100% on-machine; downloads the model from Hugging Face on first
boot. API:
  GET  /health                → {"ok": true, "model": "tiny", "loaded": false}
  POST /v1/transcribe         → {"text": "...", "language": "es", "durationMs": 1234, "confidence": 0.87}
       body JSON: {"audio_base64": "<wav>", "language": "es"|null}

confidence: average of exp(avg_logprob) per segment weighted by
  duration (avg_logprob in (-inf, 0]; exp maps it to (0, 1]). None if no
  segments. stt.js retries on Deepgram if VERY low (§2e).
"""

import base64
import io
import math
import os
import time

from fastapi import FastAPI
from pydantic import BaseModel
from faster_whisper import WhisperModel

# faster-whisper 1.2.1 passes metadata_errors to av.open, but av>=15 removed it
# (uncapped Requires-Dist). The kwarg is dropped: WAVs carry no metadata.
try:
    import av
    _av_open = av.open

    def _open_compat(*args, **kwargs):
        kwargs.pop('metadata_errors', None)
        return _av_open(*args, **kwargs)

    av.open = _open_compat
    import faster_whisper.audio
    faster_whisper.audio.av.open = _open_compat
except ImportError:
    pass

MODEL_NAME = os.environ.get("WHISPER_MODEL", "tiny")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")
# WHISPER_PRELOAD=0: lazy load (the model loads on the first
# /v1/transcribe, not at startup). The watchdog spawns with 0: Whisper is the
# last local fallback and with the box at 96% RAM it can't hold memory
# while idle. Default 1 = preload (historic behavior when run by hand).
PRELOAD = os.environ.get("WHISPER_PRELOAD", "1") != "0"

app = FastAPI(title="Whisper local")
_model = None
_loaded_name = None


def get_model(name: str = None):
    global _model, _loaded_name
    wanted = name or MODEL_NAME
    if _model is None or _loaded_name != wanted:
        _model = WhisperModel(wanted, device=DEVICE, compute_type=COMPUTE)
        _loaded_name = wanted
    return _model


class TranscribeRequest(BaseModel):
    audio_base64: str
    language: str | None = None
    model: str | None = None


@app.get("/health")
def health():
    return {"ok": True, "model": _loaded_name or MODEL_NAME, "loaded": _loaded_name is not None}


@app.post("/v1/transcribe")
def transcribe(request: TranscribeRequest):
    started = time.monotonic()
    audio = io.BytesIO(base64.b64decode(request.audio_base64))
    model = get_model(request.model)
    segments, info = model.transcribe(
        audio,
        language=request.language,
        vad_filter=True,
        beam_size=1,
    )
    # segments is a generator: materialized for text + confidence.
    seg_list = list(segments)
    text = " ".join(s.text.strip() for s in seg_list).strip()
    confidence = None
    total_dur = sum(max(0.0, (s.end or 0.0) - (s.start or 0.0)) for s in seg_list)
    if seg_list and total_dur > 0:
        weighted = sum(
            math.exp(max(-20.0, s.avg_logprob or -20.0)) * max(0.0, (s.end or 0.0) - (s.start or 0.0))
            for s in seg_list
        )
        confidence = round(weighted / total_dur, 4)
    return {
        "text": text,
        "language": info.language,
        "durationMs": round((time.monotonic() - started) * 1000),
        "confidence": confidence,
    }


if __name__ == "__main__":
    import uvicorn

    # Preload so the first turn doesn't pay the model load, except
    # WHISPER_PRELOAD=0 (lazy: the watchdog uses it, see above).
    if PRELOAD:
        get_model()
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("WHISPER_PORT", "7789")), log_level="warning")
