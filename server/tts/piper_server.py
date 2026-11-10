"""Local TTS server: persistent Piper (Spanish + English). Same idea as
parakeet_server.py:
  GET  /health  → {"ok": true, "voices": [...], "loaded": [...]}
  POST /v1/tts   → WAV bytes. body: {"text": "...", "voice": "daniela"|"sharvard"|"carlfm"|"lessac"|"jenny"}

ES voices (measured on CPU 2026-11-08, see .audit/piper/PIPER-EVAL.md):
  daniela  F rioplatense, high,   ~300ms  (default F agents)
  sharvard M peninsular, medium,  ~50ms   (default M agents)
  carlfm   M peninsular, x_low,   ~25ms   (ultra-fast)
mls_10246-low discarded (generates 9s of garbage per sentence).

EN voices (medium, ~50-100ms estimated on CPU, same order as sharvard):
  lessac   M US English, medium (default M agents in English)
  jenny    F US English, medium (default F agents in English)
With EN voices, Piper goes first in both languages: every English sentence
avoids the ~2.4s wait for the Deepgram cloud.

Run: python3 server/tts/piper_server.py  (port 7791, PIPER_PORT=...)
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

    # Preload + synthesis warmup of the default ES (F+M) and EN
    # (F+M) voices: no first turn pays the load (1.4s) nor the first synthesis
    # (~2s ONNX). Each voice with tolerant warmup: if its .onnx is missing or
    # corrupt, warn and the server still starts (that voice will fail on
    # demand and the chain falls to the next TTS, but Spanish doesn't die).
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
