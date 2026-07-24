---
tags: [architecture, ai, models]
created: 2026-06-12
updated: 2026-06-12
---

# AI Models

## Modelos en Uso

| Modelo | Variable | Uso | Temperatura | Max Tokens |
|--------|----------|-----|-------------|------------|
| `gemini-2.5-flash` | `GEMINI_AGENT_TEXT_MODEL` | Generación de texto de agentes | 0.8 | 200 |
| `gemini-2.5-flash` | `GEMINI_ROUTER_MODEL` | Orquestador IA | 0 | 300 |
| `gemini-2.0-flash-preview-tts` | `GEMINI_TTS_MODEL` | Text-to-Speech | — | — |
| `gemini-2.0-flash-preview` | `GEMINI_TRANSCRIBE_MODEL` | Transcripción de audio (fallback) | 0 | 64 |
| `gemini-2.0-flash-preview` | `GEMINI_LIVE_MODEL` | Audio en vivo (Live API) | — | — |

## Generación de Texto

Cada agente recibe:
- **System instruction** con su rol, personalidad, reglas y `SILENCIO` como keyword
- **Turn prompt** con el mensaje del usuario, contexto, tareas y respuestas previas
- **Temperatura 0.8** para respuestas variadas pero coherentes

## Orquestador IA

- **Temperatura 0** para decisiones consistentes
- **JSON estricto** como formato de salida
- Scoring guía: 9-10 (core domain), 6-8 (strong match), 3-5 (tangential), 0 (no connection)
- Regla: SILENCE IS VALID — no forzar participación

## SILENCIO

Si un agente no tiene nada que aportar, responde únicamente `SILENCIO`. El sistema descarta esta respuesta y no la muestra al usuario.

## TTS (Text-to-Speech)

- Modelo: `gemini-2.0-flash-preview-tts`
- Genera audio PCM a 24kHz
- chunks de ~60ms cada uno
- Timeout de 12s por llamada
