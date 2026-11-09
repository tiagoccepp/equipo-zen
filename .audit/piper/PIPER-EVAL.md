# Piper TTS — Evaluación (2026-11-08)

Host: 7GB RAM, sin GPU. Medido con proceso persistente (`PiperVoice.load` una vez).

## Números (en caliente, CPU)

| Voz | Modelo | TTFA | "Enseguida, señor." | 2 oraciones | Load | RSS |
|---|---|---|---|---|---|---|
| daniela-high (F, rioplatense) | 114MB | 302ms | 302ms | 679ms | 1.4s | ~194MB |
| sharvard-medium (M) | 76MB | 47ms | 46ms | 120ms | 1.2s | ~146MB |
| carlfm-x_low | 28MB | 24ms | 25ms | 68ms | 1.3s | ~90MB |
| mls_10246-low | 63MB | — | DESCARTADA | — | — | — |

Muestras: `daniela-corta/larga.wav`, `sharvard-corta/larga.wav`, `carlfm-xlow-corta/larga.wav` (este dir).

## Veredicto

- **Piper es 15-70x más rápido que Edge cloud (~2s) y Supertonic (~1.7s).**
  TTFA de 24-47ms: el TTS deja de ser un factor en la latencia.
- Una voz residente usa ~100-150MB: entra cómoda en RAM.
- **mls_10246-low genera 9s de audio para una frase de 1s** (balbuceo/basura
  al final). No usar.
- API: `synthesize()` stremea 1 chunk por oración (sirve para TTFA);
  `synthesize_wav()` escribe archivo directo. Sin streaming intra-oración
  en esta versión.
- Integración: sidecar persistente `server/tts/piper_server.py` (puerto 7791,
  carga diferida) + `server/lib/piper.js`. El CLI frío recarga el modelo
  (1.2s) en cada llamada: NO usar CLI por síntesis.

## Recomendación

sharvard-medium como default de agentes M (47ms), daniela-high como default
de agentes F incl. Sofia (femenina rioplatense, 302ms — igual 6x más
rápida que Edge), carlfm-x_low como alternativa ultra-rápida (24ms).
Tito elige por oído entre daniela y las demás.
