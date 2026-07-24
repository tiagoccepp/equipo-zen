---
tags: [agents, routing]
created: 2026-06-12
---

# Routing Logic

Clase: `AgentRouter` en `server/index.js`

## Dos Capas de Ruteo

### 1. Heurístico (siempre se ejecuta)

Evalúa el texto del usuario contra cada agente y calcula un **score**:

| Señal | Puntos | Ejemplo |
|-------|--------|---------|
| Mención directa del nombre | +10 | "Julio, ¿qué opinás?" |
| Dominio del agente detectado | +3 por dominio | "El stock está bajo" → Tomasa |
| Saludo general | +2 | "Hola chicos" |
| Cierre general | +2 | "Gracias a todos" |
| Mensaje corto (< 20 chars) | +1 bonus | "Dale" |

**Umbrales:**
- Score ≥ 6: agente seleccionado directamente
- Score 4-5: se considera pero con señal débil
- Score < 4: no seleccionado

### 2. IA (condicional)

Se usa **solo** cuando:
- Es un saludo (coincide con `greetingRegex`)
- O el usuario habla al grupo (menciones a "chicos", "gente", etc.)

La IA recibe:
```json
{
  "message": "texto del usuario",
  "agents": [{ "id", "name", "title", "domains" }]
}
```

Y responde con:
```json
{
  "targets": [{ "agentId": "programacion", "order": 1 }],
  "reason": "razón de la decisión"
}
```

Si la IA falla o timeout (4.5s), se usa el resultado heurístico.

## Secuencia de Respuesta

Los agentes responden **secuencialmente**, no en paralelo:

1. Agente 1 genera texto → streaming → audio
2. Agente 1 termina
3. Agente 2 genera texto → streaming → audio
4. Agente 2 termina

Ver [[03 - Agents/Turn Protocol|Turn Protocol]].

## Followup Contextual

Si el usuario se dirige a un agente específico, se evalúa si el **otro** agente debería responder también:

- Solo se activa si el otro agente es **mencionado explícitamente** por nombre
- Score mínimo: 5
- No se activa en saludos ni cierres
- No se activa si el agente ya habló en los últimos 3 turnos

> [!decision] 2026-06-12
> Se removió la señal `crossSignal` del followup contextual porque causaba interferencia entre agentes. Ahora solo se activa con mención explícita.
