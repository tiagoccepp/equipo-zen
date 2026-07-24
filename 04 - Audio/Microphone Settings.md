---
tags: [audio, microphone]
created: 2026-06-12
---

# Microphone Settings

## Parámetros

| Parámetro | Default | Descripción |
|-----------|---------|-------------|
| `speechThreshold` | 0.012 | Umbral RMS para detectar habla |
| `endSilenceMs` | 800ms | Tiempo de silencio para cortar |
| `minSpeechMs` | 600ms | Duración mínima de habla |

## Presets

La UI ofrece presets predefinidos:

| Preset | Threshold | End Silence | Min Speech |
|--------|-----------|-------------|------------|
| Normal | 0.012 | 800ms | 600ms |
| Sensible | 0.008 | 600ms | 400ms |
| Relaxed | 0.018 | 1200ms | 800ms |

## Detección de Habla

El `LiveMicrophoneStreamer` calcula el RMS (Root Mean Square) del audio capturado:

```
RMS = sqrt(sum(samples²) / N)
```

Si RMS > `speechThreshold` por más de `minSpeechMs`, se considera que el usuario empezó a hablar.

Cuando RMS < `speechThreshold` por más de `endSilenceMs`, se considera que terminó de hablar.

## Configuración desde UI

Los parámetros se pueden cambiar en tiempo de ejecución desde los controles de la UI. Los cambios se aplican inmediatamente.
