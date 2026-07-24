---
tags: [decisions, log]
created: 2026-06-12
updated: 2026-06-12
---

# Decision Log

Registro de decisiones técnicas importantes del proyecto.

---

## 2026-06-12: Reescritura completa de prompts del sistema

**Decisión:** Reemplazar todos los prompts del sistema con versiones mejoradas.

**Cambios:**
- **Orquestador:** Ahora en inglés, JSON estricto, scoring guide 0-10, regla SILENCE IS VALID
- **System Instruction:** Nuevo template con `SILENCIO` como keyword explícito, voseo rioplatense, secciones claras
- **Turn Prompt:** Más limpio, con `---` separadores, recordatorio de SILENCIO
- **Transcriber:** Prompts en inglés, más precisos
- **Seed de Contexto:** Formato `[CONTEXT SEED — DO NOT RESPOND]`

**Modelos actualizados:**
- Agentes: `gemini-2.5-flash` (antes `gemini-3.1-flash-lite`)
- Orquestador: `gemini-2.5-flash` (antes `gemini-3.1-flash-lite`)
- TTS: `gemini-2.0-flash-preview-tts`
- Transcripción: `gemini-2.0-flash-preview`

**Temperaturas:**
- Orquestador: 0 (antes 0.1)
- Agentes: 0.8 (antes 0.45)
- Transcriptor: 0

**Max tokens:**
- Orquestador: 300 (antes 260)
- Agentes: 200 (antes 150)

**Razón:** Los prompts anteriores causaban problemas: Tomasa le hablaba al usuario cuando debería dirigirse a Julio, los agentes no reconocían cuándo el usuario les hablaba a ellos vs al grupo, y faltaba la keyword `SILENCIO` para respuestas vacías.

---

## 2026-06-12: Modelo de texto — gemini-2.5-flash

**Decisión:** Usar `gemini-2.5-flash` para generación de texto de agentes y orquestador.

**Razón:** Gemini 2.5 Flash tiene mejor razonamiento que 3.1-flash-lite, permite mejores decisiones de routing y respuestas más contextuales.

---

## 2026-06-12: Modelo TTS — gemini-2.0-flash-preview-tts

**Decisión:** Usar `gemini-2.0-flash-preview-tts` para TTS.

**Razón:** Modelo más reciente y estable para generación de voz.

---

## 2026-06-12: Followup contextual restrictivo

**Decisión:** Remover `crossSignal` del followup contextual. Solo activar con mención explícita del otro agente.

**Razón:** Causaba interferencia entre agentes — respondían cuando no debían.

**Cambio:** Se requiere score ≥ 5 Y mención explícita del nombre del otro agente.

---

## 2026-06-12: Humanización de respuestas

**Decisión:** Reescribir system prompts para respuestas humanizadas.

**Reglas:**
- Máximo 2 oraciones
- Sin lenguaje técnico innecesario
- Autonomía: proponer soluciones, no pedir datos
- Estilo personal: Julio (pibe cracks), Tomasa (mina práctica)

---

## 2026-06-12: Telemetría para tareas

**Decisión:** Agregar eventos de telemetría para creación/completado de tareas.

**Eventos nuevos:** `task_added`, `task_toggled`, `task_deleted`, `task_created_by_agent`, `task_completed_by_agent`.

**Razón:** Necesidad de auditar qué hacen los agentes con las tareas en tiempo real.

---

## 2026-06-12: Resumen de sesión

**Decisión:** Generar `meeting_session_summary` al cerrar la sesión.

**Contenido:** Duración, turnos, respuestas de agentes, errores, rotaciones.

**Razón:** Dar visibilidad del rendimiento de la sesión completa.
