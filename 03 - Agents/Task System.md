---
tags: [agents, tasks]
created: 2026-06-12
---

# Task System

## Descripción

Cada agente puede tener una lista de tareas pendientes. Las tareas se gestionan desde la UI y pueden ser creadas/completadas por los agentes via comandos especiales en sus respuestas.

## Comandos de Agentes

Los agentes pueden incluir estas etiquetas en su texto:

### Crear Tarea

```
[TAREA_CREAR: descripción de la tarea]
```
Crea una tarea auto-asignada al agente que habla.

```
[TAREA_CREAR: agentId: descripción]
```
Crea una tarea para un agente específico.

### Completar Tarea

```
[TAREA_COMPLETAR: #1]
```
Marca la tarea #1 como completada.

```
[TAREA_COMPLETAR: task-id]
```
Marca una tarea por su ID.

## Parsing

El método `processAgentTaskCommands(agentId, text)`:

1. Busca `[TAREA_CREAR: target: desc]` (target explícito)
2. Busca `[TAREA_CREAR: desc]` (auto-asignación)
3. Busca `[TAREA_COMPLETAR: ref]` (completado)
4. Limpia las etiquetas del texto antes de enviar al cliente
5. Emite `agents_updated` si hubo cambios

> [!warning] Bug corregido
> El regex de auto-asignación coincidía también con el de target explícito, causando tareas duplicadas. Se corrigió agregando `!taskText.includes(':')` como condición adicional.

## Telemetría

| Evento | Descripción |
|--------|-------------|
| `task_added` | Tarea agregada desde la UI |
| `task_toggled` | Tarea marcada/desmarcada desde la UI |
| `task_deleted` | Tarea eliminada desde la UI |
| `task_created_by_agent` | Agente creó tarea via `[TAREA_CREAR]` |
| `task_completed_by_agent` | Agente completó tarea via `[TAREA_COMPLETAR]` |

## Gestión desde UI

La UI permite:
- Agregar tareas manualmente a cada agente
- Marcar/desmarcar tareas como completadas
- Eliminar tareas

Los cambios se envían via WebSocket y se propagan a todos los clientes conectados.
