---
name: react-best-practices
description: React/Next.js performante: reglas de Vercel por prioridad.
keywords: react, nextjs, next.js, performance, rendimiento, bundle, waterfall, suspense, frontend react, re-render
scope: chat, role:frontend, role:diseno
---

## When to Apply

Reference these guidelines when:
- Writing new React components or Next.js pages
- Implementing data fetching (client or server-side)
- Reviewing code for performance issues
- Refactoring existing React/Next.js code
- Optimizing bundle size or load times

## Rule Categories by Priority

| Priority | Category | Impact | Prefix |
|----------|----------|--------|--------|
| 1 | Eliminating Waterfalls | CRITICAL | `async-` |
| 2 | Bundle Size Optimization | CRITICAL | `bundle-` |
| 3 | Server-Side Performance | HIGH | `server-` |
| 4 | Client-Side Data Fetching | MEDIUM-HIGH | `client-` |
| 5 | Re-render Optimization | MEDIUM | `rerender-` |
| 6 | Rendering Performance | MEDIUM | `rendering-` |
| 7 | JavaScript Performance | LOW-MEDIUM | `js-` |
| 8 | Advanced Patterns | LOW | `advanced-` |

*Source: verbatim excerpt from https://github.com/vercel-labs/agent-skills/blob/main/skills/vercel-react-best-practices/SKILL.md — License: MIT.*
