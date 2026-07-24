---
tags: [telemetry, metrics]
created: 2026-06-12
---

# Metrics Reference

Endpoint: `GET /api/telemetry/analysis`

## Métricas Disponibles

### Volumen

| Métrica | Descripción |
|---------|-------------|
| `userTurns` | Turnos totales del usuario |
| `audioTurns` | Turnos de audio |
| `textTurns` | Turnos de texto |
| `routeDecisions` | Veces que se orquestó |
| `noAgentResponses` | Turnos sin respuesta |
| `agentCompletions` | Respuestas totales de agentes |
| `emptyAgentCompletions` | Agentes que empezaron sin texto |
| `fallbackTranscriptions` | Usos de fallback de transcripción |
| `alerts` | Alertas mostradas en UI |
| `errorAlerts` | Alertas de error |

### Latencia

| Métrica | Descripción | Umbral preocupante |
|---------|-------------|---------------------|
| `avgVisibleResponseMs` | Promedio hasta respuesta visible | > 4.5s |
| `maxVisibleResponseMs` | Máximo hasta respuesta visible | > 9s |
| `avgAgentResponseMs` | Promedio generación por agente | > 5s |
| `maxAgentResponseMs` | Máximo generación por agente | — |

### Análisis

| Campo | Descripción |
|-------|-------------|
| `slowTurns` | Turnos con latencia > 5000ms |
| `recommendations` | Recomendaciones automáticas |

## Recomendaciones Automáticas

El sistema genera recomendaciones basadas en umbrales:

| Condición | Recomendación |
|-----------|---------------|
| `noAgentResponses` > 30% | Revisar lógica de ruteo |
| `emptyAgentCompletions` > 20% | Revisar silence detection |
| `avgVisibleResponseMs` > 4500 | Considerar modelo más rápido |
| `fallbackTranscriptions` > 50% | Revisar Live API |
