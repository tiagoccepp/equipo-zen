# Simulaciones — empresas con empleados IA

App local para crear **simulaciones de empresas** (una tecnológica, una automotora, una distribuidora… todas las que quieras) y conversar por voz o texto con sus **empleados IA**, cada uno con sus skills, conocimientos, personalidad y voz propia. Los empleados hablan en streaming, se los puede interrumpir a mitad de frase, recuerdan reuniones anteriores y **aprenden de lo que les enseñás**.

- **Razonamiento**: [MiniMax](https://platform.minimax.io) (API OpenAI-compatible, modelos M2–M3, elegible desde Ajustes).
- **Voz de los empleados**: [Supertonic TTS](https://github.com/supertone-inc/supertonic) corriendo **100% local** (ONNX, 31 idiomas, 10 voces).
- **Tu voz**: **Whisper** (el open source de OpenAI) corriendo **local** vía faster-whisper — o Groq (cloud) o el navegador, a elección en ⚙ Ajustes. Por defecto: todo local.

## Ejecutar

```bash
npm install
cp .env.example .env                 # o cargá las claves después desde ⚙ Ajustes

# Audio local (una sola vez; los modelos se descargan en el primer arranque):
python3 -m venv .venv-tts
.venv-tts/bin/pip install 'supertonic[serve]' faster-whisper fastapi uvicorn

npm run dev                          # backend + frontend + TTS + STT locales
```

Abre la URL que imprime Vite. El backend escucha solo en loopback (`127.0.0.1:8787`); el cliente le habla vía proxy same-origin.

Scripts: `npm test` (suite `node:test`), `npm run typecheck`, `npm run build`.

## La empresa digital (estilo [Paperclip](https://github.com/paperclipai/paperclip))

Cada simulación es una **empresa que trabaja de verdad**:

- **Jerarquía**: toda empresa tiene una **CEO** (interlocutora directa: si nadie tiene el dominio, ella toma el punto) y un **contratista de talento**; el resto del equipo le reporta a la CEO. Árbol observable en el panel Organigrama.
- **Paciencia conversacional**: si escribís/decís tu idea en varias partes, los agentes esperan (2.6s, más si la frase quedó abierta) y responden UNA vez con todo el contexto.
- **Reunión → trabajo**: en la reunión exponés qué querés lograr y se reparten tareas. Al tocar **Finalizar reunión**, la CEO repasa en voz alta quién quedó con qué (validación conversacional) y, cuando confirmás, se crea la **meta** y el equipo se pone a trabajar en segundo plano.
- **Trabajo real**: un motor de heartbeats (checkout atómico, máx. 2 corridas en paralelo, pasos acotados con herramientas de archivos sandboxeadas) hace que cada empleado PRODUZCA entregables reales en `workspace/<empresa>/` — una página web pedida en reunión termina siendo un `index.html` navegable en `/workspace/<empresa>/`. Todo con log durable por corrida.
- **Entorno aislado**: todo lo que la empresa produce vive en `workspace/<empresa>/<proyecto>/` y en ningún otro lado. El motor solo escribe ahí dentro (sin rutas relativas hacia afuera, sin archivos ocultos ni absolutos) y únicamente formatos de entregable (html/css/js/json/md/svg/csv…). La carpeta está fuera del control de versiones.
- **Continuidad del trabajo**: el equipo trabaja **en fila por proyecto**, no en paralelo sobre los mismos archivos. Quien entra recibe en su prompt el contenido real del archivo principal y la identidad visual ya definida (variables `:root`, tipografías, clases y secciones existentes), tiene que **editar** con `edit_file` en vez de regenerar, y no puede sobreescribir un archivo que no leyó. Así el estilo no cambia de cara en cada vuelta.
- **Revisión entre compañeros**: cuando alguien termina un entregable, un colega con skills afines lo lee de verdad, deja su comentario y lo aprueba o pide cambios concretos (una vuelta de correcciones). Las interacciones quedan registradas.
- **Contratación automática**: si una tarea necesita habilidades que nadie tiene, el contratista diseña al empleado ideal (perfil completo, voz incluida), lo suma al equipo reportando a la CEO y le delega el trabajo.

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
  transcriber.js        captura PCM del turno + STT según Ajustes
  stt.js                Whisper local | Groq | navegador (+ WAV builder)
  settings.js           ajustes del usuario (SQLite) que pisan al .env
  db.js / store.js      SQLite (migraciones v2: companies) / repositorios
  learning.js           observador de aprendizajes  reflection.js  resumen + tuner del router
  key-ring.js           rotación de claves          memory.js      memoria de reunión
  telemetry.js          ring en RAM + SSE + análisis
server/company-templates.json   plantillas de empresas con equipos
server/stt/whisper_server.py    STT local (faster-whisper + FastAPI)
```

## Observabilidad local

- `GET /api/agents/:id/prompt-preview`: el system prompt REAL del empleado (escenario de su empresa, conocimientos, límites y memoria).
- `GET /api/companies` · `GET /api/meetings?companyId=` · `GET /api/changelog`
- `GET /api/telemetry` · `/api/telemetry/stream` (SSE) · `/api/telemetry/analysis`

## Seguridad

App local de un solo usuario: bind en loopback, CORS con allowlist, validación y límites en todos los mensajes WS, TTS y base de datos sin salir de tu máquina. No la expongas a la red sin agregar autenticación.

> El vault Obsidian (`00 - Index` … `08 - Roadmap`) describe una arquitectura vieja (era Gemini, pre-empresas). La referencia vigente es este README + el código.

## Diario de la empresa (logs)

Todo lo que pasa queda registrado en `server/data/logs/AAAA-MM-DD.jsonl`, en
texto plano legible: tu mensaje tal cual lo escribiste, las respuestas de cada
empleado, el ruteo, las interrupciones, cada paso del trabajo y los errores del
modelo. Sirve para reconstruir qué pasó cuando algo falla, sin depender de que
la app siga abierta.

- Consultarlo desde la app: `GET /api/logs?day=2026-07-25&kind=mensaje_usuario&search=web`
- O abrirlo a mano: `tail -f server/data/logs/$(date +%F).jsonl`
- Nunca escribe claves (las tapa aunque aparezcan dentro de un texto), recorta
  los textos enormes y rota el archivo por tamaño.
- Se apaga con `SESSION_LOG=0`.

Para comprobar a mano que la interrupción corta el audio de verdad, con el
sistema levantado: mandá un turno, y en cuanto lleguen los primeros
`agent_audio_chunk` mandá `{"type":"interrupt","reason":"barge_in"}` — el
servidor responde `agent_interrupted` y deja de enviar audio en el acto.

Para ver el prompt exacto que recibe un empleado (con su oficio, sus límites,
lo aprendido y el estado del trabajo en curso): `GET /api/agents/<id>/prompt-preview`.
Entre el diario y ese preview se reconstruye cualquier caso que haya fallado.
