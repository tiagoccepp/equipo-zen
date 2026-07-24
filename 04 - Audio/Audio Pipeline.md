---
tags: [audio, pipeline]
created: 2026-06-12
---

# Audio Pipeline

## Captura de Audio (Micrófono → Servidor)

```
Micrófono del navegador
    │
    ▼
AudioWorklet (PcmCaptureProcessor)
    │ ├── Downsamplea a 16kHz
    │ └── Convierte a PCM Int16
    │
    ▼
LiveMicrophoneStreamer
    │ ├── Detecta habla (RMS > threshold)
    │ ├── Detecta silencio (> endSilenceMs)
    │ └── Envía chunks cada ~60ms
    │
    ▼
WebSocket: audio_chunk { data, mimeType }
    │
    ▼
Servidor → Gemini Live API (transcripción)
```

## Generación de Audio (Servidor → Navegador)

```
Agente genera texto
    │
    ▼
generateAudio() → Gemini TTS
    │
    ▼
Chunks PCM a 24kHz
    │
    ▼
WebSocket: agent_audio_chunk { data }
    │
    ▼
PcmAudioQueue
    │ ├── AudioBufferSourceNode
    │ └── Reproducción secuencial
    │
    ▼
Altavoz del navegador
```

## Configuración del Micrófono

Ver [[04 - Audio/Microphone Settings|Microphone Settings]].

## Transcripción

Ver [[04 - Audio/Transcription|Transcription]].

## Parámetros de Audio

| Parámetro | Valor | Descripción |
|-----------|-------|-------------|
| Sample rate entrada | 16kHz | Micrófono (downsampled) |
| Sample rate TTS | 24kHz | Salida de Gemini TTS |
| Formato | PCM Int16 | Ambos sentidos |
| Chunk size | ~60ms | Streaming de micrófono |
| Mime type | `audio/pcm;rate=16000` | Para chunks del micrófono |
