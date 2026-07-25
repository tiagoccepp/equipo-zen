# Simulaciones — empresas con empleados IA

App local para crear **simulaciones de empresas** (una tecnológica, una automotora, una distribuidora… todas las que quieras) y conversar por voz o texto con sus **empleados IA**, cada uno con sus skills, conocimientos, personalidad y voz propia. Los empleados hablan en streaming, se los puede interrumpir a mitad de frase, recuerdan reuniones anteriores y **aprenden de lo que les enseñás**.

- **Razonamiento**: [MiniMax](https://platform.minimax.io) (API OpenAI-compatible, modelos M2–M3).
- **Voz**: [Supertonic TTS](https://github.com/supertone-inc/supertonic) corriendo **100% local** (ONNX, 31 idiomas incluido español, 10 voces).
- **Reconocimiento de voz del usuario**: SpeechRecognition del navegador (Chrome recomendado).

## Ejecutar

```bash
npm install
cp .env.example .env                 # poné tu MINIMAX_API_KEY (sin clave: modo simulación)

# Voz local (una sola vez; descarga ~250 MB de modelos en el primer arranque):
python3 -m venv .venv-tts
.venv-tts/bin/pip install 'supertonic[serve]'

npm run dev                          # levanta backend + frontend + TTS local
```

Abre la URL que imprime Vite. El backend escucha solo en loopback (`127.0.0.1:8787`); el cliente le habla vía proxy same-origin.

Scripts: `npm test` (suite `node:test`), `npm run typecheck`, `npm run build`.

## Cómo funciona

- **Simulaciones**: el home es una galería de empresas. Creá una desde plantilla (equipo pre-armado con skills y conocimientos) o desde cero. Cada empresa tiene su escenario, su equipo y su historial de reuniones, todo persistido en SQLite (`node:sqlite`, WAL — sobrevive a `kill -9`).
- **Empleados**: perfil completo editable — rol, skills (ruteo), **conocimientos del puesto** (se inyectan en su prompt), personalidad, límites y voz (10 presets Supertonic). Con versionado, changelog y rollback.
- **Reunión en tiempo real**: un router (heurístico + MiniMax para casos grupales) decide quién habla; el texto streamea por deltas y la voz se sintetiza localmente por oraciones a través de un `SpeakerGate` que garantiza que nunca hablen dos a la vez. **Barge-in**: hablá encima y el empleado baja el volumen, se corta y tu turno entra completo.
- **Auto-aprendizaje**: un observador (MiniMax) detecta correcciones/preferencias en lo que decís — solo turnos del usuario, con evidencia obligatoria — y las inyecta como MEMORIA APRENDIDA en el prompt del empleado correspondiente. Al cerrar cada reunión, una reflexión genera título+resumen y propone vocabulario/estilo (lo aditivo se auto-aplica con guardarraíles; el resto queda como sugerencia). Panel **Memoria** por empleado: ver, editar, borrar, pausar u olvidar todo.
- **Tareas**: por UI o por los propios empleados (`[TAREA_CREAR: …]`, con destinatario por nombre).

## Arquitectura

```
src/main.ts             cliente vanilla TS: vistas Simulaciones/Workspace, render por regiones,
                        transcript append-only, cola PCM con ducking, barge-in, drawers
shared/protocol.ts      protocolo WS tipado + validadores (Node 26 type-stripping + Vite)
server/index.js         bootstrap
server/lib/
  config.js             env + modelos + flags       http.js       REST (companies/meetings/agents/memoria)
  llm.js                cliente MiniMax (SSE, filtro <think>, rotación)
  supertonic.js         adaptador TTS local (WAV→PCM para el gate)
  ws.js                 WS + validación             meeting-session.js  orquestación por empresa
  router.js             ruteo heurístico            turn-pipeline.js    TurnQueue cancelable + SpeakerGate
  agent-runtime.js      stream (MiniMax+Supertonic) | mock, prompts
  transcriber.js        STT vía hint del navegador
  db.js / store.js      SQLite (migraciones v2: companies) / repositorios
  learning.js           observador de aprendizajes  reflection.js  resumen + tuner del router
  key-ring.js           rotación de claves          memory.js      memoria de reunión
  telemetry.js          ring en RAM + SSE + análisis
server/company-templates.json   plantillas de empresas con equipos
```

## Observabilidad local

- `GET /api/agents/:id/prompt-preview`: el system prompt REAL del empleado (escenario de su empresa, conocimientos, límites y memoria).
- `GET /api/companies` · `GET /api/meetings?companyId=` · `GET /api/changelog`
- `GET /api/telemetry` · `/api/telemetry/stream` (SSE) · `/api/telemetry/analysis`

## Seguridad

App local de un solo usuario: bind en loopback, CORS con allowlist, validación y límites en todos los mensajes WS, TTS y base de datos sin salir de tu máquina. No la expongas a la red sin agregar autenticación.

> El vault Obsidian (`00 - Index` … `08 - Roadmap`) describe una arquitectura vieja (era Gemini, pre-empresas). La referencia vigente es este README + el código.
