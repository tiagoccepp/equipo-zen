---
name: pdf
description: Trabajar con PDFs: leer, extraer, unir, dividir, crear.
keywords: pdf, documento pdf, extraer texto, unir pdf, merge pdf, dividir pdf, leer pdf, pypdf, formulario pdf
scope: chat, role:data, role:backend, role:copy
---

## Overview

This guide covers essential PDF processing operations using Python libraries and command-line tools. For advanced features, JavaScript libraries, and detailed examples, see REFERENCE.md. If you need to fill out a PDF form, read FORMS.md and follow its instructions.

## Quick Start

```python
from pypdf import PdfReader, PdfWriter

# Read a PDF
reader = PdfReader("document.pdf")
print(f"Pages: {len(reader.pages)}")

# Extract text
text = ""
for page in reader.pages:
    text += page.extract_text()
```

*Fuente: extracto verbatim de https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md — Licencia: Apache-2.0.*
