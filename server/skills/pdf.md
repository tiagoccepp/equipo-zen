---
name: pdf
description: Work with PDFs: read, extract, merge, split, create.
keywords: pdf, pdf document, extract text, merge pdf, split pdf, read pdf, pypdf, pdf form
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

*Source: verbatim excerpt from https://github.com/anthropics/skills/blob/main/skills/pdf/SKILL.md — Licencia: Apache-2.0.*
