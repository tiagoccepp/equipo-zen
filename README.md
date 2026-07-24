# Reunión con Julio y Tomasa

App local para conversar por voz o texto con agentes IA como si estuvieran en una reunión: Julio (programador) y Tomasa (operaciones y datos comerciales), sobre el escenario de una distribuidora. Los agentes hablan con voz nativa de Gemini Live, se los puede interrumpir a mitad de frase, recuerdan reuniones anteriores y **aprenden de lo que les enseñás** conversando.

## Ejecutar

```bash
npm install
cp .env.example .env   # completar claves; sin claves corre en modo simulación
npm run dev
```

Abre la URL que imprime Vite (normalmente `http://127.0.0.1:5173`). El backend escucha solo en loopback (`127.0.0.1:8787`); el cliente le habla vía proxy same-origin de Vite.

Scripts: `npm test` (suite `node:test`), `npm run typecheck`, `npm run build`.

## Qué hace

- **Conversación en tiempo real**: cada agente mantiene una sesión Gemini Live persistente con su propia voz (`speechConfig`); el texto streamea por deltas y el audio nativo por chunks. Si Live no está disponible cae automáticamente a `generateContentStream` + TTS por oraciones, y sin claves a un modo simulación conversable. Un `SpeakerGate` en el servidor garantiza que nunca hablen dos a la vez.
- **Barge-in**: hablá sobre un agente y su volumen baja al instante; si sostenés la voz ~250 ms se corta su audio, se aborta la generación en curso y tu turno entra con lo que dijiste desde el primer fonema (pre-buffer).
- **Orquestación**: un router heurístico (menciones con límite de palabra, dominios, cierres de tema por frase) decide quién habla; saludos y turnos grupales pasan por un router IA con JSON estricto. Los agentes deshabilitados para la reunión no reciben la palabra.
- **Persistencia total (SQLite, `node:sqlite`)**: reuniones, turnos, agentes, tareas, aprendizajes, sugerencias y changelog sobreviven a reconexiones, recargas y `kill -9` (WAL). Al volver, la reunión se retoma con historial, roster y tareas; "Reiniciar reunión" la archiva (recuperable desde el drawer Reuniones) y abre una nueva.
- **Personalización**: crear agentes nuevos y **editar a Julio/Tomasa** (voz, estilo, dominios, alias, límites) desde la UI, con versionado de perfil, changelog y rollback (`POST /api/agents/:id/rollback`). El escenario de la empresa es editable por reunión y se inyecta en los prompts.
- **Auto-aprendizaje**: un observador asíncrono detecta correcciones y preferencias en lo que decís (solo turnos del usuario, con evidencia obligatoria), las guarda y las inyecta como "MEMORIA APRENDIDA" en el prompt del agente correspondiente. Al cerrar cada reunión, una reflexión genera título + resumen y propone vocabulario/estilo: el vocabulario aditivo se auto-aplica con guardarraíles; todo lo demás queda como sugerencia para aprobar. Panel "Memoria" por agente: ver, editar, borrar, pausar u olvidar todo.
- **Tareas**: por UI o por los propios agentes (tags `[TAREA_*]` en modo texto, tool calling `crear_tarea`/`completar_tarea` en modo Live).

## Arquitectura

```
src/main.ts             cliente vanilla TS: shell estático + render por regiones,
                        transcript append-only, cola PCM con ducking, barge-in, drawers
shared/protocol.ts      protocolo WS tipado + validadores (corre nativo en Node 26 y Vite)
server/index.js         bootstrap
server/lib/
  config.js             env + modelos + flags        http.js       REST (meetings/agents/memoria/telemetría)
  ws.js                 WS + validación de entrada   meeting-session.js  orquestación
  router.js             ruteo heurístico             gemini.js     rotación (unaria + streaming)
  turn-pipeline.js      TurnQueue cancelable + SpeakerGate
  agent-runtime.js      fachada live→stream→mock + prompts
  agent-live-backend.js sesión Gemini Live por agente (voz nativa, tools, resumption)
  transcriber.js        transcripción Live del usuario (+ fallback WAV)
  db.js / store.js      SQLite (migraciones) / repositorios
  learning.js           observador de aprendizajes + MEMORIA APRENDIDA
  reflection.js         resumen post-reunión + tuner del router
  key-ring.js           rotación de claves + slots Live
  model-registry.js     validación de modelos al arrancar
  memory.js             memoria de reunión (RAM 80 + persistencia + seeds)
  telemetry.js          ring en RAM + SSE + análisis
```

## Observabilidad local

- `GET /api/telemetry?limit=200` · `GET /api/telemetry/stream` (SSE) · `GET /api/telemetry/analysis`
- `GET /api/agents/:id/prompt-preview`: el system prompt REAL del agente (escenario, límites y memoria incluidos) — la herramienta clave para inspeccionar qué ve el modelo.
- `GET /api/meetings`, `GET /api/changelog`: historial y toda mutación que afectó prompts (quién, qué, cuándo).
- Dashboards HTML: `/auditoria`, `/audit-graph`, `/arquitectura`, `/vault`.

## Seguridad

Pensada como app local de un solo usuario: bind en loopback, CORS con allowlist, lector del vault restringido a `.md` no ocultos, validación y límites en todos los mensajes WS. No la expongas a la red sin agregar autenticación.

> Nota: la documentación del vault Obsidian (`00 - Index` … `08 - Roadmap`) describe la arquitectura ANTERIOR al overhaul de julio 2026 y quedó desactualizada; la referencia vigente es este README + el código.
