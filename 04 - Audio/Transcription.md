---
tags: [audio, transcription]
created: 2026-06-12
---

# Transcription

## Métodos de Transcripción

### 1. Gemini Live API (Principal)

- Sesión persistente via `LiveAudioTranscriberRuntime`
- Transcribe audio en tiempo real mientras el usuario habla
- Devuelve transcripción incremental (`user_audio_transcript_delta`)
- Se cierra al finalizar la sesión

### 2. Fallback a Modelo de Texto

Si la Live API falla o no está disponible:
- Los chunks de audio se acumulan
- Se envían al modelo `gemini-3.1-flash-lite` como archivo de audio
- Se obtiene una transcripción completa

### 3. Browser Speech API (Preview)

- Web Speech API del navegador
- Muestra transcripción en tiempo real como preview
- No se usa para la transcripción final
- Solo para feedback visual al usuario

## Eventos de Transcripción

| Evento | Dirección | Descripción |
|--------|-----------|-------------|
| `user_audio_transcript_delta` | S→C | Transcripción incremental |
| `user_audio_turn_final` | S→C | Transcripción final del turno |
| `audio_transcription_status` | S→C | Estado de la transcripción |
| `audio_transcription_empty` | S→C | Transcripción vacía |

## Errores Comunes

- **Live API no disponible**: se usa fallback automáticamente
- **Audio demasiado corto**: se cancela el turno (< 600ms)
- **Silencio detectado**: se procesa el turno con lo transcrito
- **API quota agotada**: se rota a la siguiente clave
