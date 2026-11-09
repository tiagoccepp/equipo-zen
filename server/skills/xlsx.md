---
name: xlsx
description: Planillas Excel: crear, editar, fórmulas, pandas, openpyxl.
keywords: excel, xlsx, planilla, spreadsheet, hoja de cálculo, csv, openpyxl, pandas, fórmula, xlsm
scope: chat, role:data, role:backend
---

| Task | Approach |
|---|---|
| **Create** or **edit** with formulas/formatting | `openpyxl` — see gotchas below |
| **Bulk data** in or out | `pandas` (`read_excel`, `to_excel`) |
| **Quick look** at a sheet | `markitdown file.xlsx` — `## SheetName` per sheet; reads `.xlsm` too. No cell coordinates, so don't plan edits from it |
| **Read** a model (formulas *and* values) | two `load_workbook` passes — see gotchas |

> `openpyxl`, `pandas`, and `markitdown` are preinstalled — do not run `pip install` first; write the script and import directly. Only if an import fails (or the `markitdown` command is missing): `pip install` the missing package.

## Requirements for every output

- **Professional font** (Arial, Times New Roman) throughout, unless the user says otherwise.
- **Zero formula errors.** Never ship while `recalc.py` reports `errors_found`. If you think an error predates you, prove it: load the *original* with `data_only=True` and look at that cell. An error you introduced looks exactly like one you inherited.

*Fuente: extracto verbatim de https://github.com/anthropics/skills/blob/main/skills/xlsx/SKILL.md — Licencia: Apache-2.0.*
