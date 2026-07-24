---
tags: [architecture, backend, code]
created: 2026-06-12
---

# Backend Components

Archivo: `server/index.js` (~2400 líneas, archivo monolítico)

## Clases Principales

### MeetingSession

La clase central. Una instancia por cada conexión WebSocket.

| Responsabilidad | Detalle |
|----------------|---------|
| Gestión de sesión | ID única, agentes, memoria, turnos |
| WebSocket | Maneja todos los mensajes del cliente |
| Orquestación | Decide qué agente responde |
| Cola de turnos | Ejecuta agentes secuencialmente |
| Telemetría | Registra eventos para auditoría |

**Propiedades clave:**
- `id` — ID de sesión (nanoid 10)
- `sessionAgents` — Lista mutable de agentes
- `agents` — Map de `LiveAgentRuntime` por ID
- `router` — Instancia de `AgentRouter`
- `memory` — `MeetingMemory` (últimos 80 turnos)
- `transcriber` — `LiveAudioTranscriberRuntime`
- `turnQueue` — Promise chain para turnos secuenciales

Ver [[06 - Code Reference/Server Index|Server Index]] para la referencia completa.

### AgentRouter

Ruteo en dos capas:

1. **Heurístico** — Matching de dominios, saludos, cierres, menciones
2. **IA** — Llama a Gemini para saludos o mensajes grupales

Ver [[03 - Agents/Routing Logic|Routing Logic]].

### LiveAgentRuntime

Runtime por agente. Responsabilidades:

- Generar texto via `generateText()` → Gemini
- Generar audio via `generateAudio()` → TTS
- Parsear comandos de tareas (`[TAREA_CREAR]`, `[TAREA_COMPLETAR]`)
- Enviar eventos de telemetría

### ApiKeyRing

Gestiona hasta 6 claves API con rotación automática.

```
acquire() → Key actual → siguiente llamada
cooldown() → bloquea temporalmente la clave
snapshot() → estado de todas las claves
```

Ver [[01 - Setup/Environment Variables#Rotación de Claves|Rotación de Claves]].

### MeetingMemory

Almacena los últimos 80 turnos de conversación para contexto en prompts.

- `add(role, agent, text)` — Agrega un turno
- `snapshot()` — Retorna los turnos para el prompt

### TelemetryBridge

Buffer circular en memoria (800 eventos max).

- `add(event)` — Registra evento y notifica clientes SSE
- `list(limit)` — Retorna eventos recientes
- `stream(req, res)` — Endpoint SSE
- `analyzeTelemetry(events)` — Métricas agregadas

Ver [[05 - Telemetry/Telemetry System|Telemetry System]].

### LiveAudioTranscriberRuntime

Gestiona la sesión de Gemini Live API para transcripción de audio en tiempo real.

- `ensureSession()` — Inicia o reutiliza la sesión
- `close()` — Cierra la sesión
- Fallback a transcripción via modelo de texto si falla

## Endpoints HTTP

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/agents` | Lista de agentes y modelo |
| GET | `/api/telemetry` | Últimos N eventos |
| GET | `/api/telemetry/stream` | Stream SSE en vivo |
| GET | `/api/telemetry/analysis` | Métricas y análisis |
| POST | `/api/telemetry` | Recibir evento del cliente |
| POST | `/api/telemetry/reset` | Limpiar historial |
| GET | `/arquitectura` | Docs de arquitectura (HTML) |
| GET | `/auditoria` | Dashboard de auditoría (HTML) |
