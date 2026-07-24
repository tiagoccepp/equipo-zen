---
tags: [architecture, data-flow]
created: 2026-06-12
---

# Data Flow

## Flujo de un Turno de Texto

```
1. Usuario escribe y presiona Enviar
   │
   ▼
2. Cliente envía WS: { type: "user_turn", text: "..." }
   │
   ▼
3. Servidor recibe → handleClientMessage()
   │
   ▼
4. enqueueUserTurn() → memory.add() → envía user_turn_received
   │
   ▼
5. AgentRouter.route(text, memory)
   │ ├── Heurístico: score por dominio, saludo, mención
   │ └── IA (opcional): Gemini decide quiénes hablan
   │
   ▼
6. route_decision → cliente muestra selección
   │
   ▼
7. Para cada agente seleccionado (secuencial):
   │
   ├── LiveAgentRuntime.generateText()
   │   └── Gemini gemini-3.1-flash-lite → texto streaming
   │
   ├── agent_transcript_delta → UI muestra texto
   │
   ├── processAgentTaskCommands() → parsea [TAREA_*]
   │
   ├── LiveAgentRuntime.generateAudio()
   │   └── Gemini gemini-2.5-flash-preview-tts → PCM chunks
   │
   ├── agent_audio_chunk → PcmAudioQueue → altavoz
   │
   └── agent_turn_complete → siguiente agente
```

## Flujo de Audio (Micrófono)

```
1. Usuario activa micrófono
   │
   ▼
2. AudioWorklet captura PCM a 16kHz
   │
   ▼
3. Detección de habla (RMS > threshold)
   │
   ▼
4. audio_start → servidor inicia detección
   │
   ▼
5. audio_chunk cada ~60ms
   │
   ▼
6. Servidor → Gemini Live API (transcripción)
   │
   ▼
7. user_audio_transcript_delta → UI muestra transcripción
   │
   ▼
8. Silencio detectado → audio_end
   │
   ▼
9. Turno procesado igual que texto
```

## Flujo de Rotación de Claves

```
1. Llamada a Gemini falla
   │
   ├── 429 → cooldown 1 hora
   ├── Error de red → cooldown 45 seg
   ├── Respuesta vacía → marca como fallida
   └── Error permanente → cooldown 24 horas
   │
   ▼
2. api_rotation_start → cliente notificado
   │
   ▼
3. Siguiente clave intenta acquire()
   │
   ├── Éxito → api_rotation_resolved
   └── Todas fallaron → api_rotation_failed
```

## WebSocket Protocol

Ver [[06 - Code Reference/WebSocket Protocol|WebSocket Protocol]] para la lista completa de eventos.

### Cliente → Servidor

| Evento | Uso |
|--------|-----|
| `user_turn` | Turno de texto |
| `audio_prepare` | Activar micrófono |
| `audio_start/chunk/end` | Streaming de audio |
| `audio_cancel` | Cancelar turno de audio |
| `reset` | Reiniciar sesión |
| `health` | Estado de claves |
| `spawn_agent` | Crear agente nuevo |
| `add_task/toggle_task/delete_task` | Gestionar tareas |

### Servidor → Cliente

| Evento | Uso |
|--------|-----|
| `meeting_ready` | Sesión inicializada |
| `route_decision` | Orquestación decidida |
| `agent_turn_start/complete` | Ciclo de agente |
| `agent_transcript_delta` | Texto streaming |
| `agent_audio_chunk` | Audio PCM |
| `agents_updated` | Cambio en tareas/agentes |
| `api_rotation_*` | Rotación de claves |
| `error` | Error del servidor |
