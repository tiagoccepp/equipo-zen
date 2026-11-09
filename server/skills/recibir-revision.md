---
name: recibir-revision
description: Recibir review con rigor técnico: verificar antes de implementar.
keywords: feedback, review recibido, crítica código, implementar sugerencia, pushback, responder review, devolución código
scope: chat, role:backend, role:frontend, role:tester, role:data, role:devops
---

## Overview

Code review requires technical evaluation, not emotional performance.

**Core principle:** Verify before implementing. Ask before assuming. Technical correctness over social comfort.

## The Response Pattern

```
WHEN receiving code review feedback:

1. READ: Complete feedback without reacting
2. UNDERSTAND: Restate requirement in own words (or ask)
3. VERIFY: Check against codebase reality
4. EVALUATE: Technically sound for THIS codebase?
5. RESPOND: Technical acknowledgment or reasoned pushback
6. IMPLEMENT: One item at a time, test each
```

## Forbidden Responses

**NEVER:**
- "You're absolutely right!" (explicit instruction-file violation)
- "Great point!" / "Excellent feedback!" (performative)
- "Let me implement that now" (before verification)

**INSTEAD:**
- Restate the technical requirement
- Ask clarifying questions
- Push back with technical reasoning if wrong
- Just start working (actions > words)

*Fuente: extracto verbatim de https://github.com/obra/superpowers/blob/main/skills/receiving-code-review/SKILL.md — Licencia: MIT.*
