---
tags: [code, websocket, protocol]
created: 2026-06-12
---

# WebSocket Protocol

Endpoint: `ws://host:8787/meeting`

## Cliente → Servidor

| Evento | Payload | Descripción |
|--------|---------|-------------|
| `user_turn` | `{ text }` | Turno de texto |
| `audio_prepare` | `{}` | Preparar micrófono |
| `audio_start` | `{}` | Inicio de habla |
| `audio_chunk` | `{ data, mimeType }` | Chunk de audio PCM |
| `audio_end` | `{ transcriptHint }` | Fin de habla |
| `audio_cancel` | `{ reason, speechMs }` | Cancelar turno de audio |
| `audio_stop` | `{}` | Desactivar micrófono |
| `reset` | `{}` | Reiniciar sesión |
| `health` | `{}` | Pedir estado de claves |
| `spawn_agent` | `{ agent }` | Crear agente nuevo |
| `add_task` | `{ agentId, text }` | Agregar tarea |
| `toggle_task` | `{ agentId, taskId, completed }` | Marcar/desmarcar tarea |
| `delete_task` | `{ agentId, taskId }` | Eliminar tarea |

## Servidor → Cliente

| Evento | Payload | Descripción |
|--------|---------|-------------|
| `meeting_ready` | `{ id, agents, model, liveMode }` | Sesión lista |
| `meeting_reset` | `{}` | Sesión reiniciada |
| `meeting_warmup_start` | `{}` | Calentamiento iniciado |
| `meeting_warmup_complete` | `{ ok, failures }` | Calentamiento completado |
| `agents_updated` | `{ agents }` | Agentes/tareas cambiaron |
| `user_turn_received` | `{ turnId, text, source }` | Turno encolado |
| `route_decision` | `{ turnId, route }` | Ruteo decidido |
| `no_agent_response` | `{ turnId, note }` | Nadie respondió |
| `agent_turn_start` | `{ turnId, agentId }` | Agente empezó |
| `agent_transcript_delta` | `{ turnId, agentId, delta }` | Texto streaming |
| `agent_audio_chunk` | `{ turnId, agentId, data }` | Audio PCM |
| `agent_turn_complete` | `{ turnId, agentId, text }` | Agente terminó |
| `agent_silence` | `{ agentId, reason }` | Agente silencioso |
| `audio_listening_start` | `{}` | Escuchando audio |
| `audio_listening_stop` | `{}` | Dejó de escuchar |
| `user_audio_transcript_delta` | `{ delta, text }` | Transcripción incremental |
| `user_audio_turn_final` | `{ text, source }` | Transcripción final |
| `audio_transcription_status` | `{ message }` | Estado de transcripción |
| `audio_transcription_empty` | `{ message }` | Transcripción vacía |
| `api_rotation_start` | `{ scope, message }` | Rotando clave |
| `api_rotation_resolved` | `{ scope, keyId, model }` | Clave encontrada |
| `api_rotation_failed` | `{ scope, message }` | Claves agotadas |
| `health` | `{ keys, memory }` | Estado de claves |
| `error` | `{ message, detail }` | Error |
