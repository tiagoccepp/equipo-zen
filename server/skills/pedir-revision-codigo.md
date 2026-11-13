---
name: pedir-revision-codigo
description: Request code review on time: when and how to dispatch a reviewer.
keywords: code review, review code, reviewer, merge, pull request, code feedback, before merge
scope: chat, role:backend, role:frontend, role:tester, role:data, role:devops
---

Dispatch a code reviewer subagent to catch issues before they cascade. The reviewer gets precisely crafted context for evaluation — never your session's history.

**Core principle:** Review early, review often.

## When to Request Review

**Mandatory:**
- After each task in subagent-driven development
- After completing major feature
- Before merge to main

**Optional but valuable:**
- When stuck (fresh perspective)
- Before refactoring (baseline check)
- After fixing complex bug


**3. Act on feedback:**
- Fix Critical issues immediately
- Fix Important issues before proceeding
- Note Minor issues for later
- Push back if reviewer is wrong (with reasoning)

*Source: verbatim excerpt from https://github.com/obra/superpowers/blob/main/skills/requesting-code-review/SKILL.md — License: MIT.*
