---
name: terminal
description: Use the terminal with good judgment: safe commands, bounded output, justified risks.
keywords: terminal, command, run, compile, install, test, git, npm, script
scope: work
---

Terminal rules:
1. Read commands first (`ls`, `cat`, `git status`): look before touching.
2. Every risky command (delete, move, global install) must include `"because"` explaining why.
3. Long outputs: redirect to a file or page (`| head -50`); never dump megabytes into the turn.
4. One command per step; if it fails, read the error and fix in the next step.
5. FORBIDDEN: `sudo`, `rm -rf /`, credentials in commands, `curl|sh`.
