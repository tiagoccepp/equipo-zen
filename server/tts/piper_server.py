"""Servidor TTS local: Piper (español) persistente. Misma idea que
parakeet_server.py:
  GET  /health  → {"ok": true, "voices": [...], "loaded": [...]}
  POST /v1/tts   → WAV bytes. body: {"text": "...", "voice": "daniela"|"sharvard"|"carlfm"}

Voces (medido en CPU 2026-11-08, ver .audit/piper/PIPER-EVAL.md):
  daniela  F rioplatense, high,   ~300ms  (default agentes F)
  sharvard M español,    medium,  ~50ms   (default agentes M)
  carlfm   M español,    x_low,   ~25ms   (ultra-rápida)
mls_10246-low descartada (genera 9s de basura por frase).

Lanzar: python3 server/tts/piper_server.py  (puerto 7791, PIPER_PORT=...)
"""

import io
import os
import wave

from fastapi import FastAPI, Response
from pydantic import BaseModel

VOICE_DIR = os.environ.get(
    "PIPER_VOICE_DIR", os.path.expanduser("~/.local/share/piper")
)
VOICES = {
    "daniela": "es_AR-daniela-high.onnx",
    "sharvard": "es_ES-sharvard-medium.onnx",
    "carlfm": "es_ES-carlfm-x_low.onnx",
}
DEFAULT_VOICE = os.environ.get("PIPER_VOICE", "sharvard")

app = FastAPI(title="Piper local")
_loaded = {}


def get_voice(name):
    from piper import PiperVoice

    key = name if name in VOICES else DEFAULT_VOICE
    if key not in _loaded:
        _loaded[key] = PiperVoice.load(os.path.join(VOICE_DIR, VOICES[key]))
    return _loaded[key]


class TtsRequest(BaseModel):
    text: str
    voice: str | None = None


@app.get("/health")
def health():
    return {"ok": True, "voices": sorted(VOICES), "loaded": sorted(_loaded)}


@app.post("/v1/tts")
def tts(req: TtsRequest):
    text = (req.text or "").strip()
    if not text:
        return Response(status_code=400, content="texto vacío")
    voice = get_voice(req.voice or DEFAULT_VOICE)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        voice.synthesize_wav(text, w)
    return Response(content=buf.getvalue(), media_type="audio/wav")


if __name__ == "__main__":
    import uvicorn

    # Precarga + warmup de síntesis de las dos voces default (F+M): ningún
    # primer turno paga load (1.4s) ni el primer sintetizado (~2s ONNX).
    get_voice("daniela")
    get_voice(DEFAULT_VOICE)
    for _name in ("daniela", DEFAULT_VOICE):
        _buf = io.BytesIO()
        with wave.open(_buf, "wb") as _w:
            get_voice(_name).synthesize_wav("Hola.", _w)
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.environ.get("PIPER_PORT", "7791")),
        log_level="warning",
    )
