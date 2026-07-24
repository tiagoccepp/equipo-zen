---
tags: [architecture, frontend, code]
created: 2026-06-12
---

# Frontend Components

Archivo: `src/main.ts` (~1600 líneas, vanilla TypeScript)

## Componentes Principales

### PcmAudioQueue

Reproduce chunks de audio PCM secuencialmente a 24kHz via Web Audio API.

```
chunk binario → AudioBufferSourceNode → altavoz
```

- `push(arrayBuffer)` — Agrega chunk a la cola
- `stop()` — Detiene reproducción
- `ensureContext()` — Crea/reinicia AudioContext (cierra el anterior para evitar memory leaks)

### LiveMicrophoneStreamer

Captura audio del micrófono a 16kHz, detecta inicio/fin de habla por RMS.

- `start()` — Inicia captura con Worklet
- `stop()` — Detiene captura
- Detección de silencio: `endSilenceMs` (default 800ms)
- Detección de habla mínima: `minSpeechMs` (default 600ms)
- Umbral RMS: `speechThreshold` (default 0.012)

### BrowserSpeechRecognizer

Wrapper del Web Speech API para transcripción en tiempo real del lado del navegador.

- Útil como preview mientras habla el usuario
- El servidor usa Gemini Live API para la transcripción real

### state (objeto global)

Estado reactivo central:

| Propiedad | Tipo | Descripción |
|-----------|------|-------------|
| `sessionId` | string | ID de la sesión actual |
| `agents` | Agent[] | Agentes activos con tareas |
| `turns` | Turn[] | Historial de turnos en UI |
| `recording` | boolean | ¿Micrófono activo? |
| `isSpeaking` | boolean | ¿Usuario hablando? |
| `alerts` | Alert[] | Notificaciones |

### render()

Re-render completo del DOM vía `innerHTML`. No usa virtual DOM ni framework.

- Se ejecuta cuando cambia el estado
- Optimizado con `requestAnimationFrame` para evitar renders duplicados
- Se llama desde el medidor de micrófono (ahora con throttling)

## Audio Worklet

`PcmCaptureProcessor` — Worklet inline que:
1. Recibe audio del micrófono
2. Downsamplea de sample rate del sistema a 16kHz
3. Convierte a PCM Int16
4. Envía al thread principal via `port.postMessage`

## Estilos

Archivo: `src/styles.css` (~1000 líneas)
- CSS custom properties para colores
- Layout responsive con flexbox/grid
- Animaciones para estados de grabación
