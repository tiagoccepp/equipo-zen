---
name: terminal
description: Usar la terminal con criterio: comandos seguros, salida acotada, riesgos justificados.
keywords: terminal, comando, correr, compilar, instalar, test, git, npm, script
scope: work
---

Reglas de terminal:
1. Comandos de lectura primero (`ls`, `cat`, `git status`): mirá antes de tocar.
2. Todo comando riesgoso (borrar, mover, instalar global) lleva `"porque"` explicando para qué.
3. Salidas largas: redirigí a archivo o paginá (`| head -50`); nunca vuelques megabytes al turno.
4. Un comando por paso; si falla, leé el error y corregí en el siguiente paso.
5. PROHIBIDO: `sudo`, `rm -rf /`, credenciales en comandos, `curl|sh`.
