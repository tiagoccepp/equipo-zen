---
name: docx
description: Documentos Word: crear, editar, leer docx.
keywords: word, docx, documento word, informe, carta, memo, plantilla, dotx, pandoc
scope: chat, role:copy, role:data, role:backend
---

A `.docx` is a ZIP archive of XML files. Choose your approach by task:

| Task | Approach |
|---|---|
| **Create** a new document | Write a `docx` (npm) script — see gotchas below |

## Creating with docx-js — gotchas

`docx` is preinstalled — do not run `npm install` first; write the script and `require('docx')` directly. Only if that require fails: `npm install docx`. The model knows the API; these are the footguns:

- **Page size defaults to A4.** For US Letter set `page: { size: { width: 12240, height: 15840 } }` (DXA; 1440 = 1″).
- **Landscape:** pass portrait dimensions and `orientation: PageOrientation.LANDSCAPE` — docx-js swaps width/height internally.

*Fuente: extracto verbatim de https://github.com/anthropics/skills/blob/main/skills/docx/SKILL.md — Licencia: Apache-2.0.*
