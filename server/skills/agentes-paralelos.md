---
name: agentes-paralelos
description: Paralelizar con subagentes: un agente por dominio independiente.
keywords: paralelo, subagente, subagentes, delegar, concurrente, dispatch, múltiples fallos, repartir, en paralelo
scope: chat, role:orquestador, role:backend, role:tester
---

## Overview

You delegate tasks to specialized agents with isolated context. By precisely crafting their instructions and context, you ensure they stay focused and succeed at their task. They should never inherit your session's context or history — you construct exactly what they need. This also preserves your own context for coordination work.

When you have multiple unrelated failures (different test files, different subsystems, different bugs), investigating them sequentially wastes time. Each investigation is independent and can happen in parallel.

**Core principle:** Dispatch one agent per independent problem domain. Let them work concurrently.


**Use when:**
- 3+ test files failing with different root causes
- Multiple subsystems broken independently
- Each problem can be understood without context from others
- No shared state between investigations

**Don't use when:**
- Failures are related (fix one might fix others)
- Need to understand full system state
- Agents would interfere with each other

*Fuente: extracto verbatim de https://github.com/obra/superpowers/blob/main/skills/dispatching-parallel-agents/SKILL.md — Licencia: MIT.*
