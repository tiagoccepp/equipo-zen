---
tags: [code, server, reference]
created: 2026-06-12
---

# Server Index

Archivo: `server/index.js` (~2400 líneas)

## Estructura

El archivo es un monolito que contiene todo el backend. Las clases principales:

### Líneas Clave

| Línea | Contenido |
|-------|-----------|
| 1-66 | Imports, Express setup, CORS |
| 68-123 | `TelemetryBridge` class |
| 127-159 | Endpoints de telemetría |
| 288-323 | `MeetingSession` constructor |
| 325-335 | `publicAgents()` |
| 380-517 | `handleClientMessage()` — todos los mensajes WS del cliente |
| 520-524 | `broadcastAgentsUpdated()` |
| 526-606 | `processAgentTaskCommands()` |
| 609-640 | `warmupLiveSessions()` |
| 642-660 | `enqueueUserTurn()` |
| 662-700 | `planRouteWithAi()` — orquestador IA |
| 700-800 | `processUserTurn()` — lógica principal de ruteo |
| 800-920 | Ciclo de agentes (text gen → TTS → completado) |
| 930-980 | `send()`, `close()`, `logTelemetry()`, `logClientMessage()` |
| 982-1100 | `AgentRouter` — heurístico + IA |
| 1100-1200 | `MeetingMemory` |
| 1200-1400 | `LiveAudioTranscriberRuntime` |
| 1400-1600 | Audio handling (micrófono, transcripción) |
| 1600-1800 | `ApiKeyRing` — rotación de claves |
| 1800-2000 | `generateContentWithRotation()` |
| 2000-2100 | Helpers (sanitize, analyze, errors) |
| 2100-2230 | `analyzeTelemetry()` |
| 2240-2290 | `sanitizeTelemetryPayload()` |
| 2300-2360 | Servidor HTTP + WebSocket setup |

## Funciones Importantes

### `handleClientMessage(message)`
Dispatch central para todos los mensajes del cliente. Maneja: `user_turn`, `audio_*`, `reset`, `health`, `spawn_agent`, `add_task`, `toggle_task`, `delete_task`.

### `processUserTurn(text, source)`
Orquesta un turno: evalúa ruteo → ejecuta agentes secuencialmente → procesa tareas.

### `processAgentTaskCommands(agentId, text)`
Parsea `[TAREA_CREAR]` y `[TAREA_COMPLETAR]` del texto del agente. Limpia las etiquetas antes de enviar al cliente.

### `generateContentWithRotation(prompt, options)`
Genera contenido usando Gemini con rotación automática de claves. Reintenta con siguiente clave si falla.

### `analyzeTelemetry(events)`
Calcula métricas agregadas: volumen, latencia, turnos lentos, recomendaciones.
