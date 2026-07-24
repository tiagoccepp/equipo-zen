---
tags: [code, client, reference]
created: 2026-06-12
---

# Client Main

Archivo: `src/main.ts` (~1600 líneas)

## Estructura

### Imports y Tipos (1-100)

- Tipos TypeScript para mensajes WebSocket
- Interfaces para Agent, Turn, State

### PcmAudioQueue (100-200)

Cola de reproducción de audio PCM.

| Método | Descripción |
|--------|-------------|
| `push(buffer)` | Agrega chunk a la cola |
| `stop()` | Detiene todo |
| `ensureContext()` | Gestiona AudioContext (cierra el anterior) |

### LiveMicrophoneStreamer (200-400)

Captura y streaming de micrófono.

| Método | Descripción |
|--------|-------------|
| `start()` | Inicia con Worklet |
| `stop()` | Detiene |
| `onAudioChunk` | Callback con cada chunk |

### BrowserSpeechRecognizer (400-500)

Wrapper de Web Speech API para preview.

### State (500-600)

Objeto global de estado reactivo.

### render() (600-900)

Re-render completo del DOM. Incluye:
- Header con estado de conexión
- Lista de agentes con tareas
- Conversación
- Orquestación (qué agentes hablan)
- Composer (input + botones)

### WebSocket (900-1100)

Conexión y manejo de mensajes del servidor.

### Event Listeners (1100-1400)

- Input de texto
- Botones (enviar, reiniciar, saludar)
- Toggle de micrófono
- Controles de micrófono (threshold, silence)

### trace() (1400-1450)

Función de telemetría: envía eventos al servidor via POST.

### Inicialización (1450-1638)

- Conexión WebSocket
- Setup de audio
- Render inicial
- Health check
