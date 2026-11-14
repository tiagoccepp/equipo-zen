---
name: tdd
description: TDD: failing test first, minimal code after.
keywords: tdd, test driven, failing test, red green, refactor, write test, test first, watch it fail, primero el test que falla, código mínimo, test primero, test que falla primero
scope: chat, role:backend, role:frontend, role:tester, role:data
---

## Overview

Write the test first. Watch it fail. Write minimal code to pass.

**Core principle:** If you didn't watch the test fail, you don't know if it tests the right thing.

**Violating the letter of the rules is violating the spirit of the rules.**


## The Iron Law

```
NO PRODUCTION CODE WITHOUT A FAILING TEST FIRST
```

Write code before the test? Delete it. Start over.

**No exceptions:**
- Don't keep it as "reference"
- Don't "adapt" it while writing tests
- Don't look at it
- Delete means delete

Implement fresh from tests. Period.


### Verify RED - Watch It Fail

**MANDATORY. Never skip.**

```bash
npm test path/to/test.test.ts
```

Confirm:
- Test fails (not errors)
- Failure message is expected
- Fails because feature missing (not typos)

*Source: verbatim excerpt from https://github.com/obra/superpowers/blob/main/skills/test-driven-development/SKILL.md — Licencia: MIT.*
