---
tags: [agents, protocol]
created: 2026-06-12
---

# Turn Protocol

## Flujo de un Turno

```
Usuario envía mensaje
    │
    ▼
Turno encolado (enqueueUserTurn)
    │
    ▼
Orquestación decide quiénes hablan
    │
    ▼
Para cada agente seleccionado (secuencial):
    │
    ├── agent_turn_start
    ├── generateText() → streaming de texto
    ├── agent_transcript_delta (múltiples)
    ├── processAgentTaskCommands() → parsea [TAREA_*]
    ├── generateAudio() → chunks PCM
    ├── agent_audio_chunk (múltiples)
    └── agent_turn_complete
```

## Reglas de Turnos

1. **Solo el agente seleccionado responde** — No hay respuestas no solicitadas
2. **Secuencial** — Un agente a la vez, no en paralelo
3. **Silencio permitido** — Un agente puede no responder si no tiene nada que decir
4. **Cierre detectado** — Si el usuario dice "gracias", "chau", etc., se responde con cierre
5. **Máximo 2 oraciones** — Los agentes deben ser concisos

## Prompt de Turno

Cada agente recibe un prompt que incluye:
- Su nombre y rol
- Reglas de comportamiento (humanizado, conciso, autónomo)
- Historial de conversación
- Tareas activas
- Mensaje del usuario

> [!important] Autonomía
> Los agentes deben ser autónomos: si les piden "pensá", deben proponer una solución, no decir "necesito más información".

## System Prompt

```
Sos {name}, {title}. Respondé como un humano real:
- Conciso: máx 2 oraciones, sin rodeos
- Natural: como un compañero de equipo
- Autónomo: si te piden algo, proponé, no esperes datos
- Si te hablan a vos, respondé solo vos
- Si te hablan "chicos" o al grupo, todos responden
- No repitas lo que dijo el otro
- Proponé soluciones concretas
```

## Turnos del Sistema

El servidor puede generar turnos del sistema:
- `"Se ha unido {nombre} ({título}) a la mesa de trabajo."` — Cuando se crea un agente nuevo
- Estos turnos se agregan a la memoria pero no generan respuesta de agentes
