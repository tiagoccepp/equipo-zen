# El motor de trabajo

Cómo una tarea pasa de "se dijo en una reunión" a "hay un archivo navegable", y
cómo depurarlo cuando algo sale mal.

## Estados de una tarea

| Estado | Significa |
|---|---|
| `pending` | En la cola, esperando que alguien la tome |
| `in_progress` | Alguien la tomó (checkout atómico) y está corriendo |
| `done` | Terminó y produjo lo suyo |
| `blocked` | No pudo avanzar; `blocked_reason` dice por qué |
| `noted` | No es trabajo: es un acuerdo o un seguimiento registrado |

El checkout es atómico por SQL:

```sql
UPDATE tasks SET status = 'in_progress', run_count = run_count + 1
WHERE id = ? AND status = 'pending'
```

Si `changes !== 1`, otro se la llevó. Es lo que impide que dos heartbeats tomen
la misma tarea.

## Tipos de tarea (`kind`)

- `spec` — escribir el contrato del proyecto. Fase 1, bloquea a las demás.
- `entregable` — producir algo real.
- `revision` — leer el trabajo de un par y aprobarlo o pedir cambios.
- `refinamiento` — el contratista afina el perfil de alguien del equipo.
- `decision` / `seguimiento` — quedan en `noted`, nadie las "trabaja".

## Una corrida por dentro

`workforce.executeWork()` da hasta `MAX_STEPS_PER_RUN` pasos. En cada uno el
modelo devuelve **una** acción:

| Acción | Qué hace |
|---|---|
| `list_files` | Lista el proyecto (una sola vez por corrida) |
| `read_file` | Lee un archivo |
| `write_file` | Escribe el archivo COMPLETO, contenido crudo entre marcadores |
| `edit_file` | Reemplaza un fragmento (preferido sobre reescribir) |
| `finish` | Cierra — pero antes pasa por la verificación |
| `block` | Se traba y explica qué le falta |

Dos barreras contra pisar el trabajo ajeno:

1. **Un archivo que ya existía no se sobreescribe sin haberlo leído** en esta
   corrida.
2. **Un proyecto tiene una sola corrida a la vez** (`busyGoals`): el que entra
   ve lo que dejó el anterior.

`applyEdit()` intenta primero el reemplazo exacto y, si falla, uno tolerante a
espacios e indentación — el modelo casi nunca reproduce el sangrado tal cual, y
rechazarlo por eso quemaba pasos sin que el archivo avanzara.

## La verificación

Al primer `finish`, si la corrida escribió algo, corre `verify.js` sobre lo que
quedó **en disco**. Si encuentra problemas:

- No se acepta el `finish`.
- El informe vuelve como `lastObservation` del paso siguiente.
- El agente arregla y vuelve a intentar.

Corre **una sola vez por corrida**, para no encerrarlo en un bucle. Lo que quede
sin resolver se guarda como comentario de `verificacion` en la tarea, y el
revisor lo recibe para no volver a buscar lo ya medido.

## Topes

| Variable | Default | Para qué |
|---|---|---|
| `WORKFORCE_TICK_MS` | 5000 | Cada cuánto mira la cola |
| `WORKFORCE_MAX_CONCURRENT` | 2 | Corridas en paralelo (1 con reunión abierta) |
| `WORKFORCE_MAX_STEPS` | 12 | Pasos por corrida |
| `WORKFORCE_MAX_RUNS_PER_TASK` | 3 | Reintentos antes de bloquear |
| `WORKFORCE_STEP_TIMEOUT_MS` | 180000 | Tope por llamada al modelo |

La persona tiene prioridad: mientras hablás, el motor no arranca trabajo nuevo
(comparten la misma clave de API) y cede si empezás a hablar a mitad de un paso.

## Depurar una corrida

Todo queda en `work_runs.log_json`:

```bash
node -e "
const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('server/data/meetings.db');
const r = db.prepare('SELECT * FROM work_runs ORDER BY id DESC LIMIT 1').get();
console.log(r.status, '·', r.summary);
console.log(JSON.parse(r.log_json).map(s =>
  \`\${s.step}: \${s.action} \${s.path || ''} \${s.ok === false ? '✗ ' + (s.note||'') : ''}\`
).join('\n'));
"
```

Lo que se lee ahí:

- Muchos `write_file ✗` seguidos → el modelo no está usando los marcadores.
- Muchos `edit_file ✗` con "ese texto no está" → está copiando de memoria en vez
  de leer el archivo.
- `verify` con hallazgos y después `finish` → arregló y cerró: es lo esperado.
- `error` en el paso 1 → falló la llamada al modelo (clave o servicio).

También hay registro legible por reunión en `server/logs/`, y la pestaña
**Actividad** del proyecto muestra lo mismo en vivo.

## Cuándo una tarea queda bloqueada

- El modelo respondió `block` explicando qué le falta.
- Agotó los pasos **sin producir ningún archivo** (si produjo algo, cuenta como
  hecho y queda la revisión del par para juzgarlo).
- Falló la llamada al modelo `MAX_RUNS_PER_TASK` veces seguidas.

Una tarea bloqueada no se reintenta sola: se ve en el tablero con su motivo y se
resuelve hablándolo en la reunión.
