"""Servidor TTS local: Piper (español + inglés) persistente. Misma idea que
parakeet_server.py:
  GET  /health  → {"ok": true, "voices": [...], "loaded": [...]}
  POST /v1/tts   → WAV bytes. body: {"text": "...", "voice": "daniela"|"sharvard"|"carlfm"|"lessac"|"jenny"}

Voces ES (medido en CPU 2026-11-08, ver .audit/piper/PIPER-EVAL.md):
  daniela  F rioplatense, high,   ~300ms  (default agentes F)
  sharvard M español,    medium,  ~50ms   (default agentes M)
  carlfm   M español,    x_low,   ~25ms   (ultra-rápida)
mls_10246-low descartada (genera 9s de basura por frase).

Voces EN (medium, ~50-100ms estimados en CPU, mismo orden que sharvard):
  lessac   M inglés EEUU, medium (default agentes M en inglés)
  jenny    F inglés EEUU, medium (default agentes F en inglés)
Con voces EN, Piper va primero en ambos idiomas: cada oración en inglés
evita los ~2.4s de espera a la nube Deepgram.

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
    "lessac": "en_US-lessac-medium.onnx",
    "jenny": "en_US-jenny-medium.onnx",
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

    # Precarga + warmup de síntesis de las voces default ES (F+M) y EN
    # (F+M): ningún primer turno paga load (1.4s) ni el primer sintetizado
    # (~2s ONNX). Cada voz con warmup tolerante: si su .onnx falta o está
    # corrupto, se avisa y el servidor igual arranca (esa voz fallará bajo
    # demanda y la cadena cae al siguiente TTS, pero el español no muere).
    _warmup = [
        ("daniela", "Hola."),
        (DEFAULT_VOICE, "Hola."),
        ("lessac", "Hello."),
        ("jenny", "Hello."),
    ]
    for _name, _text in _warmup:
        try:
            _buf = io.BytesIO()
            with wave.open(_buf, "wb") as _w:
                get_voice(_name).synthesize_wav(_text, _w)
        except Exception as _e:
            _loaded.pop(_name, None)
            print(f"warmup: voz '{_name}' no disponible ({_e}), sigo sin ella")
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=int(os.environ.get("PIPER_PORT", "7791")),
        log_level="warning",
    )
