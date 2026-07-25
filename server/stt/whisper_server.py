"""Servidor STT local: Whisper (open source de OpenAI) vía faster-whisper.

Corre 100% en la máquina; descarga el modelo de Hugging Face en el primer
arranque. API:
  GET  /health                → {"ok": true, "model": "small"}
  POST /v1/transcribe         → {"text": "...", "language": "es", "durationMs": 1234}
       body JSON: {"audio_base64": "<wav>", "language": "es"|null}
"""

import base64
import io
import os
import time

from fastapi import FastAPI
from pydantic import BaseModel
from faster_whisper import WhisperModel

MODEL_NAME = os.environ.get("WHISPER_MODEL", "small")
DEVICE = os.environ.get("WHISPER_DEVICE", "auto")
COMPUTE = os.environ.get("WHISPER_COMPUTE", "int8")

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
    return {"ok": True, "model": _loaded_name or MODEL_NAME}


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
    text = " ".join(segment.text.strip() for segment in segments).strip()
    return {
        "text": text,
        "language": info.language,
        "durationMs": round((time.monotonic() - started) * 1000),
    }


if __name__ == "__main__":
    import uvicorn

    # Precarga para que el primer turno no pague la carga del modelo.
    get_model()
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("WHISPER_PORT", "7789")), log_level="warning")
