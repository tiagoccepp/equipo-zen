# Simulaciones — empresas con empleados IA

App local para crear **simulaciones de empresas** (una tecnológica, una automotora, una distribuidora… todas las que quieras) y conversar por voz o texto con sus **empleados IA**, cada uno con sus skills, conocimientos, personalidad y voz propia. Los empleados hablan en streaming, se los puede interrumpir a mitad de frase, recuerdan reuniones anteriores y **aprenden de lo que les enseñás**.

- **Razonamiento**: [MiniMax](https://platform.minimax.io) (API OpenAI-compatible, modelos M2–M3, elegible desde Ajustes).
- **Cerebro**: **MiniMax**, **DeepSeek** (`deepseek-v4-flash` para conversar, `deepseek-v4-pro` para el trabajo pesado) u **opencode Zen** (pool gratis con rotación: `beam-free` + 6 repuestos), a elección en ⚙ Ajustes. Cada proveedor guarda su clave por separado, así que cambiar de uno a otro y volver no obliga a pegarla de nuevo.
- **Voz de los empleados**: la del **navegador** (cero instalación: abrir y escuchar) — o [Supertonic TTS](https://github.com/supertone-inc/supertonic) **100% local** (ONNX, 31 idiomas, 10 voces) como mejora opcional.
- **Tu voz**: **Whisper** local vía faster-whisper si está instalado; si no, el **navegador** automáticamente (cero instalación) — o Groq (cloud), a elección en ⚙ Ajustes.

## Ejecutar

```bash
npm install
cp .env.example .env                 # o cargá las claves después desde ⚙ Ajustes

# Audio local (OPCIONAL, solo si querés mejor calidad de voz):
# python3 -m venv .venv-tts
# .venv-tts/bin/pip install 'supertonic[serve]' faster-whisper fastapi uvicorn

npm run dev                          # backend + frontend (+ TTS/STT locales si están instalados)
```

Abre la URL que imprime Vite. El backend escucha solo en loopback (`127.0.0.1:8787`); el cliente le habla vía proxy same-origin.

Scripts: `npm test` (suite `node:test`), `npm run typecheck`, `npm run build`.

## ¿Algo no anda?

```bash
npm run doctor
```

Dice qué está bien, qué falta y el comando exacto para arreglarlo (Node, claves,
voz local, transcripción local, base de datos y puertos). Sirve tanto para la
primera instalación como para cuando algo dejó de responder.

## Las organizaciones

No se crean empresas: elegís entre estudios técnicos predeterminados, cada uno
con su equipo armado y su criterio propio. Hoy son cuatro, definidos en
`server/company-templates.json`:

| Estudio | Hace | Equipo |
|---|---|---|
| 🌐 **Atelier Web** | Sitios y apps de navegador | CEO · directora de arte · front-end · full-stack · QA · talento |
| ⚙️ **Taller de Automatizaciones** | Procesos que corren solos | CEO · arquitecta de integraciones · dev · analista de procesos · QA · talento |
| 📱 **Estudio Móvil** | Apps móviles multiplataforma con React Native | CEO · diseñadora de producto móvil · dev RN · dev de plataforma · QA · talento |
| 🤖 **Estudio Android** | Apps Android **nativas** en Kotlin + Compose | CEO · diseñadora Material · dev Android · dev de plataforma · QA · talento |

Los dos estudios móviles entregan **apps de verdad, no páginas web**: el motor
compila el proyecto Android con Gradle, lo instala en el emulador y lo abre. Si
no compila, los errores del compilador vuelven al equipo con archivo y línea.

La primera vez que entrás a uno se instancia con toda su gente; después queda con
su historia. Las empresas de otros rubros que hayas creado antes siguen enteras
en **Archivadas**.

## El proyecto es la unidad de trabajo

Entrás a una empresa y ves **sus proyectos**. Entrás a un proyecto y ahí adentro
viven su reunión, sus tareas, su organigrama, su actividad y su vista previa.

Eso es lo que hace que el equipo entienda de qué le hablás: en vez de recibir el
contexto de toda la empresa, recibe el de *este* proyecto. Podés abrir una
reunión sobre algo ya entregado y pedir "cambiá el header" — saben qué archivos
hay y qué dice cada uno.

Los proyectos **se borran** desde su tarjeta. Un proyecto borrado se lleva sus
reuniones, sus tareas y su carpeta del entorno aislado. (Borrar una *reunión* es
lo contrario: preserva el trabajo que salió de ella.)

## La empresa digital (estilo [Paperclip](https://github.com/paperclipai/paperclip))

Cada simulación es una **empresa que trabaja de verdad**:

- **Jerarquía**: toda empresa tiene una **CEO** (interlocutora directa: si nadie tiene el dominio, ella toma el punto) y un **contratista de talento**; el resto del equipo le reporta a la CEO. Árbol observable en el panel Organigrama.
- **Paciencia conversacional**: si escribís/decís tu idea en varias partes, los agentes esperan (2.6s, más si la frase quedó abierta) y responden UNA vez con todo el contexto.
- **Arrancar sin cerrar la reunión**: el botón **Comenzar a trabajar** (junto a "Finalizar reunión") pone al equipo a producir con lo que ya tiene repartido, sin pasar por el cierre. Dice "Comenzar a trabajar" cuando hay tareas repartidas sin arrancar, y **Forzar a trabajar** el resto del tiempo — si nadie tiene nada asignado, no hace nada y lo avisa.
- **Reunión → trabajo**: en la reunión exponés qué querés lograr y se reparten tareas. Al tocar **Finalizar reunión**, la CEO repasa en voz alta quién quedó con qué (validación conversacional) y, cuando confirmás, se crea la **meta** y el equipo se pone a trabajar en segundo plano.
- **Trabajo real**: un motor de heartbeats (checkout atómico, máx. 2 corridas en paralelo, pasos acotados con herramientas de archivos sandboxeadas) hace que cada empleado PRODUZCA entregables reales en `workspace/<empresa>/` — una página web pedida en reunión termina siendo un `index.html` navegable en `/workspace/<empresa>/`. Todo con log durable por corrida.
- **Entorno aislado**: todo lo que la empresa produce vive en `workspace/<empresa>/<proyecto>/` y en ningún otro lado. El motor solo escribe ahí dentro (sin rutas relativas hacia afuera, sin archivos ocultos ni absolutos) y únicamente formatos de entregable (html/css/js/json/md/svg/csv…). La carpeta está fuera del control de versiones.
- **Cada tarea es un archivo con un dueño**: al cerrar la reunión, la CEO no reparte por disciplina sino por archivo — quién escribe `index.html`, quién `menu.json`. Lo que no es un archivo (una decisión, una revisión, "definir la paleta") no es una tarea de producción. El equipo solo entrega archivos: no existen Figma ni herramientas externas.
- **Una paleta para todos**: `tokens.css` lo escribe el primero que construye y es la fuente única de colores, tipografía y espaciado. Nadie escribe un valor a mano.
- **Una máquina revisa antes que un colega**: al terminar, un verificador **sin IA** mide lo que quedó escrito — HTML balanceado, enlaces muertos, imágenes sin `alt`, placeholders, inglés colado, colores fuera de los tokens, JavaScript que no parsea. Los hallazgos le vuelven al agente en el paso siguiente y los arregla ahí mismo.
- **Continuidad del trabajo**: el equipo trabaja **en fila por proyecto**, no en paralelo sobre los mismos archivos. Quien entra recibe el contrato, la bitácora de lo que dejó el anterior y el contenido real del archivo principal; tiene que **editar** con `edit_file` en vez de regenerar, y no puede sobreescribir un archivo que no leyó.
- **Revisión entre compañeros**: cuando alguien termina un entregable, un colega con skills afines lo lee de verdad —todos los archivos, no los tres primeros— y lo juzga contra los criterios de aceptación acordados. Deja su comentario y lo aprueba o pide cambios concretos.
- **Nadie te hace preguntas técnicas**: el equipo decide el stack, la arquitectura y cómo guardar los datos con su propio criterio (`server/playbooks/`), y te lo cuenta en términos de lo que vas a ver. Vos hablás del producto.
- **El equipo es fijo, pero se afina**: no se contrata gente nueva. El responsable de talento **refina a quien ya está** cuando se lo pedís ("que Delfina sepa de accesibilidad", "quiero a Nahuel más directo"): suma habilidades sin borrar las que tenía, reescribe su conocimiento y su oficio, y guarda la versión anterior por si hay que volver atrás.
- **Contratación automática (histórico)**: si una tarea necesita habilidades que nadie tiene, el contratista diseña al empleado ideal (perfil completo, voz incluida), lo suma al equipo reportando a la CEO y le delega el trabajo.

## Cómo funciona

- **Simulaciones**: el home es una galería de empresas; adentro de cada una, sus proyectos. Creá una desde plantilla (equipo pre-armado con skills y conocimientos) o desde cero. Cada empresa tiene su escenario, su equipo y su historial de reuniones, todo persistido en SQLite (`node:sqlite`, WAL — sobrevive a `kill -9`).
- **Empleados**: perfil completo editable — rol, skills (ruteo), **conocimientos del puesto** (se inyectan en su prompt), personalidad, límites y voz (10 presets Supertonic). Con versionado, changelog y rollback.
- **Reunión en tiempo real**: un router (heurístico + MiniMax para casos grupales) decide quién habla; el texto streamea por deltas y la voz se sintetiza localmente por oraciones a través de un `SpeakerGate` que garantiza que nunca hablen dos a la vez. **Barge-in**: hablá encima y el empleado baja el volumen, se corta y tu turno entra completo.
- **Auto-aprendizaje**: un observador (MiniMax) detecta correcciones/preferencias en lo que decís — solo turnos del usuario, con evidencia obligatoria — y las inyecta como MEMORIA APRENDIDA en el prompt del empleado correspondiente. Al cerrar cada reunión, una reflexión genera título+resumen y propone vocabulario/estilo (lo aditivo se auto-aplica con guardarraíles; el resto queda como sugerencia). Panel **Memoria** por empleado: ver, editar, borrar, pausar u olvidar todo.
- **Tareas**: por UI o por los propios empleados (`[TAREA_CREAR: …]`, con destinatario por nombre).

## Arquitectura

```
src/main.ts             cliente vanilla TS: Simulaciones → Proyectos → Proyecto,
                        render por regiones, transcript append-only, cola PCM con
                        ducking, barge-in, marcos de dispositivo
shared/protocol.ts      protocolo WS tipado + validadores
server/index.js         bootstrap
server/lib/
  config.js             env, modelos y proveedores   http.js       REST
  db.js / store.js      migraciones / repositorios (store no toca el disco)
  workforce.js          motor de trabajo: cola, corridas, contrato, revisión
  verify.js             verificación determinista de entregables (sin IA)
  playbooks.js          criterio técnico por nicho + estándar de diseño
  emulator.js           emulador de Android (adb) y simulador de iOS (simctl)
  llm.js                cliente MiniMax/DeepSeek (SSE, filtro <think>, rotación)
  meeting-session.js    una reunión en vivo    router.js       ruteo heurístico
  agent-runtime.js      prompts y streaming     turn-pipeline.js  cola + SpeakerGate
  supertonic.js         TTS local               stt.js / transcriber.js  oído
  settings.js           ajustes del usuario (SQLite) que pisan al .env
  learning.js           observador de aprendizajes  reflection.js  resumen + tuner
  key-ring.js           rotación de claves      telemetry.js   ring en RAM + SSE
server/playbooks/*.md           criterio de oficio y diseño que reciben al trabajar
server/company-templates.json   los cuatro estudios con sus equipos
server/stt/whisper_server.py    STT local (faster-whisper + FastAPI)
workspace/<empresa>/<proyecto>/ TODO lo que produce el equipo (fuera de git)
```

Para tocar el código, leé [CLAUDE.md](CLAUDE.md) — explica el porqué de cada
decisión y qué invariantes no romper. El motor de trabajo está detallado en
[docs/MOTOR-DE-TRABAJO.md](docs/MOTOR-DE-TRABAJO.md).

## Observabilidad local

- `GET /api/agents/:id/prompt-preview`: el system prompt REAL del empleado (escenario de su empresa, conocimientos, límites y memoria).
- `GET /api/companies` · `GET /api/companies/:id/projects` · `GET /api/projects/:goalId`
- `GET /api/meetings?goalId=` · `GET /api/changelog` · `GET /api/emulator/status`
- `GET /api/telemetry` · `/api/telemetry/stream` (SSE) · `/api/telemetry/analysis`

## Seguridad

App local de un solo usuario: bind en loopback, CORS con allowlist, validación y límites en todos los mensajes WS, TTS y base de datos sin salir de tu máquina. No la expongas a la red sin agregar autenticación.

## Borrar reuniones pasadas

Desde **Reuniones** (en el encabezado de la empresa) se borra cualquier reunión
salvo en la que estés sentado, y hay un botón para borrar todas las pasadas de
una. Qué se va y qué queda:

- **Se va**: la conversación (turnos), la reunión en sí, su telemetría, su
  resumen y sus entradas en el diario.
- **Queda**: los proyectos y entregables que salieron de ella, con sus tareas.
  Es trabajo, no charla — las tareas simplemente dejan de apuntar a la reunión.
- Las tareas que nunca llegaron a un proyecto sí se borran: solo existían en esa
  conversación.

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
