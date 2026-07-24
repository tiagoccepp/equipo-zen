---
tags: [telemetry, system]
created: 2026-06-12
---

# Telemetry System

## Arquitectura

```
Servidor (MeetingSession)
    │
    ├── logTelemetry(type, payload)
    │       │
    │       ▼
    │   TelemetryBridge.add(event)
    │       │
    │       ├── Ring buffer (800 eventos max)
    │       └── SSE → clientes conectados
    │
Cliente (main.ts)
    │
    └── trace(type, payload)
            │
            ▼
        POST /api/telemetry
            │
            ▼
        TelemetryBridge.add(event)
```

## Endpoints

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/telemetry?limit=N` | Últimos N eventos |
| GET | `/api/telemetry/stream` | Stream SSE en vivo |
| GET | `/api/telemetry/analysis` | Métricas agregadas |
| POST | `/api/telemetry` | Recibir evento |
| POST | `/api/telemetry/reset` | Limpiar historial |

## Tipos de Eventos del Servidor

| Evento | Categoría | Descripción |
|--------|-----------|-------------|
| `meeting_session_created` | Sesión | Nueva sesión WebSocket |
| `meeting_session_closed` | Sesión | Sesión finalizada |
| `meeting_session_summary` | Sesión | Resumen al cerrar |
| `meeting_warmup_start` | Sesión | Calentamiento de sesiones Live |
| `meeting_warmup_complete` | Sesión | Calentamiento completado |
| `user_turn_enqueued` | Turno | Turno del usuario encolado |
| `route_decision` | Ruteo | Orquestación decidida |
| `no_agent_response` | Ruteo | Nadie seleccionado |
| `ai_route_planned` | Ruteo | IA decidió targets |
| `ai_route_failed` | Ruteo | IA falló |
| `agent_turn_start` | Agente | Agente empezó a generar |
| `agent_turn_complete` | Agente | Agente terminó |
| `agent_silence` | Agente | Agente no respondió |
| `agent_spawned` | Agente | Nuevo agente creado |
| `task_added` | Tarea | Tarea agregada (UI) |
| `task_toggled` | Tarea | Tarea marcada/desmarcada |
| `task_deleted` | Tarea | Tarea eliminada |
| `task_created_by_agent` | Tarea | Agente creó tarea |
| `task_completed_by_agent` | Tarea | Agente completó tarea |
| `api_rotation_start` | API | Rotando clave |
| `api_rotation_resolved` | API | Clave encontrada |
| `api_rotation_failed` | API | Todas las claves fallaron |
| `turn_error` | Error | Error de orquestación |

## Dashboard de Auditoría

Ver `http://127.0.0.1:8787/auditoria` para el dashboard en vivo con:
- Stream SSE en tiempo real
- Filtros por origen, tipo y búsqueda
- Eventos expandibles con payload completo
- Estadísticas en vivo
- Sidebar con estado del sistema

## Seguridad

Los payloads se sanitizan antes de almacenar:
- Claves API redactadas
- Tokens de autorización omitidos
- Datos de audio/base64 omitidos
- Texto limitado a 4000 caracteres
- Profundidad máxima: 6 niveles
