# Simulaciones — guía del código

App local para simular estudios de tecnología con empleados IA. Se entra a una
empresa, se abre un **proyecto**, y adentro del proyecto se conversa por voz o
texto con el equipo, que después **produce entregables reales** en segundo plano.

Este documento es para quien (persona o modelo) tenga que tocar el código. No
repite lo que el código ya dice: explica **por qué** está armado así y qué
invariantes no hay que romper.

## La jerarquía manda

```
Empresa (companies)
  └── Proyecto (goals, kind='proyecto')   ← LA UNIDAD DE TRABAJO
        ├── Reuniones (meetings.goal_id)
        ├── Tareas (tasks.goal_id)
        ├── Corridas de trabajo (work_runs)
        └── Carpeta propia: workspace/<empresa>/<slug>/
```

**El proyecto es el contenedor de todo.** Es la decisión de diseño central:
cuando el contexto era la empresa entera, el agente recibía cinco webs distintas
y no entendía a cuál te referías con "cambiá el header". Con el proyecto como
límite, el prompt trae ese proyecto y nada más.

Consecuencias que hay que respetar:

- Una reunión **siempre** vive dentro de un proyecto (`meetings.goal_id`).
- `renderWorkSection(store, companyId, goalId)` con `goalId` filtra a ese
  proyecto. Sin `goalId` cae al comportamiento viejo (toda la empresa).
- Borrar un proyecto **sí** se lleva todo lo suyo. Borrar una **reunión** NO: lo
  que produjo trabajo sobrevive desligado. Son opuestos a propósito.

## El ciclo de una tarea

```
reunión → tareas asignadas → [Comenzar a trabajar] o [Finalizar reunión]
   → cola (store.workQueue, ordenada por phase)
   → checkout atómico (store.checkoutTask)
   → corrida: N pasos con herramientas de archivo (workforce.executeWork)
   → verificación determinista (verify.js) ← el agente arregla acá mismo
   → finish → revisión de un par (workforce.executeReview)
   → si pide cambios: una tarea de corrección de vuelta al autor
```

`workQueue` ordena por `tasks.phase` y después por fecha. La columna sobrevive a
una tarea de contrato que se eliminó (ver más abajo); sirve para priorizar sin
tener que migrar.

## El pedido del usuario es lo que manda

`store.userRequestForGoal(goalId)` trae los turnos del usuario de las reuniones
de ese proyecto, y van **primero y en todos los pasos** del prompt de trabajo.

Esto no es un adorno: cuando el prompt arrancaba con el título del proyecto, un
proyecto llamado "Trabajo de 27/7/2026" hacía que el equipo inventara una web
institucional genérica aunque en la reunión se hubiera pedido un menú de sushi
con parallax. El título es una derivación; las palabras del usuario son la
fuente de verdad.

## El esquema de archivos

Cada tarea `entregable` declara **qué archivo escribe** (`tasks.target_file`), y
cada archivo tiene **un solo dueño**. La CEO lo decide al cerrar la reunión.

Sin esto el equipo repartía por disciplina — "definir la paleta", "implementar
el parallax", "revisar prolijidad", "prototipo en Figma" — y esas tareas no
mapean a ningún archivo: el motor exige producir uno para dar la tarea por
hecha, así que agotaban los 12 pasos y quedaban bloqueadas. Reglas que se
desprenden y hay que sostener:

- Lo que no es un archivo no es un entregable: es `decision` o parte del archivo
  de otro.
- **No existen herramientas externas.** Nada de Figma, Photoshop ni Notion: el
  equipo solo escribe archivos del proyecto. Está prohibido en el prompt de
  reunión y `normalizeTargetFile()` descarta cualquier "archivo" que no lo sea.
- Si la tarea tenía archivo y ese archivo **ya existía**, la corrida cierra como
  hecha en vez de bloquearse: el trabajo estaba hecho, no fallado.

`tokens.css` es el único artefacto de coordinación que se conserva, porque evita
que cada agente invente su paleta. Lo escribe el primero que construye, en su
misma corrida. (Hubo un `PROYECTO.md` de varios KB: producirlo se comía una
corrida entera y competía con el producto. Se eliminó.)

`BITACORA.md` la escribe cada agente al terminar (`anotarEnBitacora`). Es el
traspaso entre compañeros — sin ella, lo que aprendió el anterior se perdía,
porque `lastObservation` solo vive dentro de una corrida.

## El prompt de trabajo tiene un presupuesto

El protocolo de acciones compite con todo lo demás que se le mete al prompt.
Cuando la documentación llegó a 14.000 caracteres contra 1.500 de protocolo, el
modelo **dejó de emitir acciones y empezó a responder en prosa markdown**,
imitando lo que lo rodeaba: cuatro corridas seguidas quemaron 12 pasos cada una
sin escribir un archivo.

Por eso los playbooks son listas de una línea y no documentos. **Si agregás algo
al prompt de trabajo, medí primero cuánto pesa.** A la tercera respuesta sin
acción la corrida se corta y vuelve a la cola.

## verify.js: la pieza de mayor palanca

Verificación **determinista, sin LLM**, sobre lo que quedó escrito en disco.
Corre antes de aceptar el `finish` y los hallazgos vuelven como observación del
paso siguiente: el agente arregla dentro de la misma corrida, cuando todavía
tiene el contexto entero.

Mide: HTML balanceado, `<title>`/`<meta description>`/`lang`, un solo `<h1>`,
`alt` en imágenes, enlaces `href="#"` muertos, `id` repetidos, referencias a
archivos inexistentes, recursos remotos, placeholders, inglés en la interfaz,
colores y tipografías fuera de `tokens.css`, y JS que no parsea.

**Regla de oro de ese archivo: cero falsos positivos tolerables.** Un hallazgo
inventado hace que el agente rompa algo que estaba bien. Ante la duda, no se
reporta — por eso "chat", "email" o "software" no cuentan como inglés, y el
negro, el blanco y `transparent` no cuentan como paleta propia.

Ese es el motivo de `noJuzgableComoScript`: `new Function` compila un **script
clásico**, así que un módulo ES (`import`/`export`/`await` arriba de todo) y el
JSX son `SyntaxError` ahí aunque estén perfectos. Se estaba marcando como roto un
`theme.js` con `export const`, cualquier `<script type="module">` y todo el JSX de
un proyecto React Native. Lo que no se puede juzgar en modo script no se reporta.

## Los playbooks

`server/playbooks/*.md`, cargados una vez al arrancar (`playbooks.js`):

- `diseno.md` — el piso de diseño, con reglas **verificables** (múltiplos de 4,
  contraste 4.5:1, duraciones 120–260 ms), no adjetivos. Es el piso **universal**:
  no nombra CSS, HTML ni `var(--…)`, porque viaja a los cinco nichos.
- `diseno-web.md` — lo que solo existe en una pantalla web (`var(--…)` desde
  `tokens.css`, `alt`, `href="#"`, 70 caracteres de ancho). Entra **solo** en el
  nicho `web`. Antes estaba dentro de `diseno.md` y llegaba igual a móvil: el
  prompt le exigía `tokens.css` tres líneas debajo de "Estilos con
  `StyleSheet.create`. Nada de CSS", que es exactamente cómo se cuela una web
  disfrazada de app. `renderDesignStandard(stack)` compone las dos partes, y la
  **revisión** también recibe el piso de su nicho.
- `archivoDeTokens(stack)` es el nombre del archivo de tokens de cada nicho
  (`tokens.css`, `src/theme.js`, `Tokens.kt`, o `null` en Python). El prompt de
  trabajo lo usa para no pedirle a un dev de React Native que escriba CSS.
- `<nicho>.md` (uno por `STACKS`) — qué tecnología usar en cada caso.
- `flujo-<nicho>.md` — el **orden** de trabajo: qué se andamia primero, con qué
  comando exacto se verifica antes del `finish`, los dos o tres errores que se
  cometen siempre ahí, y cuándo NO iterar. Sin esto las corridas escribían cinco
  archivos sin plan, dejaban el punto de entrada con la plantilla por defecto de
  Expo mientras el trabajo vivía en `src/screens/`, y se quedaban sin pasos.
- `roles.md` — qué hace y qué **no** hace cada oficio, y cuándo entra.

El flujo y los roles suman ~1,6 kB por paso, así que tienen **tope duro**: 900
caracteres cada flujo, 700 `roles.md`, verificado en
`tests/flujo-oficio.test.mjs`. Un nicho nuevo en `STACKS` sin su `flujo-` rompe
ese test a propósito.

Además, la documentación de oficio entera (`renderPlaybooks` + `renderFlujo` +
`renderRoles`) tiene techo **medido** de 4.200 caracteres por nicho. Antes el
guard comparaba dos bloques de documentación entre sí, que premiaba justo lo que
hay que evitar: engordar el criterio para poder engordar el flujo. Lo que importa
es el total contra el protocolo (~3.200 en el system), que es la relación que se
midió cuando el modelo dejó de emitir acciones.

Van al prompt de **trabajo**, nunca al de conversación: en la reunión el agente
habla como persona, no recita su manual.

Regla que atraviesa todo: **el equipo nunca le hace preguntas técnicas al
usuario.** Decide y lo comunica en términos de lo que se va a ver.

## Las apps móviles son apps, no webs

Los nichos `android` y `movil-rn` entregan una **app nativa que compila**, no una
página. `native-build.js` la compila de verdad antes de aceptar el `finish` y le
devuelve los errores del compilador al agente, igual que `verify.js` con el HTML.

- **Android**: Gradle + AGP 9 + Kotlin 2.2 + Compose, `compileSdk` 36. Verificado
  en esta máquina: compilación en frío de minutos, **en caliente ~5 s**, después
  `adb install` y arranque en el emulador. Gradle sale de la caché de
  `~/.gradle/wrapper/dists` porque los agentes no pueden escribir el jar binario
  del wrapper. **AGP 9 ya trae Kotlin**: aplicar `org.jetbrains.kotlin.android`
  aparte rompe la build.
- **React Native**: se valida sin `npm install` (serían cientos de MB por
  proyecto). `revisarReactNative()` chequea que sea una app móvil de verdad:
  dependencia `react-native`, `app.json`, y **cero etiquetas HTML o APIs del
  navegador** en el JSX — que es exactamente cómo se colaba una web disfrazada.

`CARPETAS_IGNORADAS` (build, .gradle, node_modules, dist, .expo, Pods) se
excluye de **todos** los listados de archivos. No es cosmético: sin eso, después
de la primera compilación el `list_files` del agente devolvía miles de rutas de
intermedios y le arruinaba el contexto.

## Paralelismo, olas y colaboración

**El cerrojo es por ARCHIVO, no por proyecto** (`puedeArrancar`/`tomarCerrojo`/
`soltarCerrojo`). Dos agentes construyen el mismo proyecto a la vez si cada uno
escribe lo suyo. Toman el proyecto ENTERO solamente las revisiones (leen todo) y
las tareas sin `target_file` (no se sabe qué van a tocar).

**Las olas (`tasks.phase`) son lo que reemplaza a la garantía que daba el
candado viejo.** Ese candado no era solo un candado: era la FILA que aseguraba
que el que entra ve lo que dejó el anterior. Sin ella, cuatro agentes arrancan
sobre un proyecto vacío, ninguno ve `tokens.css` porque todavía no existe, y
cada uno inventa su paleta. `store.faseAbierta(goalId)` devuelve la fase más
baja con trabajo vivo; nadie de una ola posterior arranca hasta que cierre. Las
tareas `blocked` no cuentan, así que una ola trabada se abre sola.

**Toda tarea encolada necesita `target_file`.** Sin él cae al modo exclusivo y
el paralelismo se apaga solo. Los tres caminos que encolan lo asignan:
`confirmMeetingClose` (lo decide la CEO), `startWorkNow` y el auto-encolado en
vivo (los dos por `inferir-archivo.js`, determinista para no gastar una llamada
al modelo por tarea).

**Colaboración**: la acción `consultar` deja que un agente le pregunte a un
compañero y reciba su respuesta con el criterio de esa persona, en el acto.
Tope de 2 por corrida. Queda registrada como comentario, así se ve en Actividad.

## La voz solo existe en el modo llamada

`MeetingSession.voiceEnabled` arranca en **false**. El cliente manda `set_voice`
al entrar y salir de la llamada. Fuera de la llamada no se sintetiza una sola
palabra — y, más importante, **no se toma el SpeakerGate**, que serializa a los
agentes de a uno para un audio que nadie estaba escuchando.

## Trampas que costaron y no son obvias

- **`'renata'.includes('')` es `true`.** Una consulta sin destinatario caía
  siempre en el primero de la lista en vez de en quien sabe. Hay guard.
- **`yaExiste` era una foto del arranque.** Con varios agentes, un archivo que
  un compañero creaba DURANTE tu corrida no estaba en la foto y `write_file` lo
  borraba entero. Ahora se consulta el disco.
- **`anotarEnBitacora` era read-modify-write.** Con dos `finish` simultáneos se
  perdía una entrada en silencio. Ahora es `appendFile`.
- **`completeGoalIfDone` anunciaba "meta cumplida"** cuando todas las tareas
  quedaban trabadas. Ahora exige que además alguien haya entregado algo.
- **Un selector de id `#cafe` se leía como color escrito a mano.** El verificador
  solo mira valores de declaración, no selectores. Y `font-family: inherit` es
  una palabra clave de CSS, no una tipografía.
- **`construirApp(dir)` sin el stack no puede saber que ahí iba una app**: una
  web entregada en un proyecto móvil pasaba derecho. Recibe `goal.stack`.
- **`DELETE FROM tasks WHERE meeting_id = ?` sin `AND goal_id IS NULL`.** Una
  reunión sin entregables cuelga una meta aparte de kind `acuerdo`; borrar el
  proyecto vaciaba esas decisiones, que son de OTRA meta. El registro sobrevivía
  pero quedaba en blanco.
- **`reassignCeoDeliverables` con afinidad 0 dejaba el entregable en la CEO.**
  Un pedido como habla cualquiera ("la landing del catálogo de plantas") no
  nombra ninguna tecnología, así que empataba en 0 y la jefa terminaba
  escribiendo el archivo — justo lo que esa función existe para evitar. El
  desempate es por carga, pero se va igual de sus manos.
- **El modelo manda VARIAS acciones en un mensaje.** No es prosa: quiere leer
  tres archivos de una. El parser voraz (`\{[\s\S]*\}`) tomaba de la primera
  llave a la última y quedaba JSON inválido — 21 pasos de una corrida
  descartados como "sin JSON de acción" cuando la respuesta era perfecta.
  `parseJsonObjects` extrae por llaves balanceadas y las lecturas se resuelven
  todas en UN paso.
- **El formato va repetido al FINAL de cada paso** (`RECORDATORIO_FORMATO`).
  Con el protocolo solo arriba del system y 15.000 caracteres de contexto en el
  medio, la recencia gana.
- **Un marcador de heredoc truncado terminaba DENTRO del archivo.** Un
  `theme.js` quedó terminado en `\n<<<`, el import rompía, y el equipo entero se
  trabó sin entender por qué. `limpiarMarcadores` los saca de todas las vías.
- **La validación de la app corría solo en el `finish`**, y las corridas casi
  siempre terminan agotando pasos: un proyecto móvil sin `package.json` se daba
  por entregado. Ahora también se valida en esa salida.
- **`patch.title ?? goal.title` deja pasar el string vacío.** El PATCH manda
  `title.trim()` sin validar, así que renombrar a espacios dejaba el proyecto
  sin nombre. El alta sí lo rechaza con 400: las dos puertas tienen que
  coincidir.

## Entornos de trabajo reales

Los agentes tienen **una terminal de verdad** dentro de la carpeta de su
proyecto (`herramientas.js`, acción `comando`). Existe porque escribir el
andamiaje a mano es la fuente principal de entregables roto: en FASA una app
React Native quedó sin `package.json` ni `app.json`. Con la herramienta, un
`npx create-expo-app` lo resuelve en un comando — verificado, el agente lo usó
y salió un proyecto Expo completo con assets y splash.

Cualquier comando se permite. Los riesgosos (`rm`, `mv`, `kill`) piden que el
agente explique el `porque`, y con eso se ejecutan. La lista de PROHIBIDO es
corta y tiene un solo criterio: nada que salga de la carpeta del proyecto o
deje la máquina peor de lo que estaba (`sudo`, `rm` a rutas absolutas, `git
push`, `ssh`, leer `.ssh`/`.env`). No es desconfianza: es que un `rm -rf ~` no
tiene vuelta atrás y ninguna tarea de producto lo necesita.

**Diseño: OpenPencil** (`openpencil.js`, MIT, github.com/ZSeven-W/openpencil).
Un servidor headless por proyecto; la diseñadora diseña con `op design`, define
tokens con `op design:upsert-vars` y exporta capturas. Su entregable es
`diseno.op` (JSON versionable) más un `.png`. Los tokens se traducen SOLOS al
lenguaje del nicho (`tokensComoCodigo`: `theme.js`, `Tokens.kt` o `tokens.css`)
y el dev los recibe en su prompt: **implementa el diseño, no lo reinterpreta**.
Se instala con `scripts/instalar-openpencil.sh` — no con brew, que compila desde
fuente y falla con Command Line Tools viejas; y hay que sacarle la cuarentena y
firmarlo o macOS lo mata con SIGKILL sin decir por qué.

## El tipo de tarea sale del oficio

`claseDeTareaPara`: el QA no recibe un archivo para escribir (sus revisiones las
crea el motor cuando hay algo entregado), el de talento hace `refinamiento`, y
quien diseña entrega `diseno.op`. Sin esto se les daba un archivo, agotaban los
pasos buscando qué escribir y quedaban trabadas — la mitad de las tareas
bloqueadas de FASA eran esto.

## El sandbox del workspace

Todo lo que produce la empresa vive en `workspace/<empresa>/<slug>/` y en ningún
otro lado. `safeWorkspacePath()` es la única puerta de escritura y rechaza:
rutas absolutas, `..`, segmentos ocultos, y extensiones fuera de la lista de
formatos de entregable. **No relajar esa guardia.**

`workspace/` está fuera del control de versiones.

## Cosas que parecen bugs y no lo son

- **El iframe de la vista previa usa `sandbox="allow-scripts"` SIN
  `allow-same-origin`.** Es a propósito: los entregables necesitan que su JS
  corra, y con los dos permisos juntos la página podría sacarse el sandbox sola.
  (Antes tenía solo `allow-same-origin`, así que nada interactivo funcionaba.)
- **`10.0.2.2` en `emulator.js`** es el loopback del host visto desde dentro del
  emulador de Android. El simulador de iOS sí usa `127.0.0.1`.
- **El intent genérico de Android no alcanza**: sin navegador por defecto,
  `am start` sale con código 0 y no abre nada. Por eso se apunta a Chrome
  explícitamente y después se verifica.
- **Se verifica por `ResumedActivity`, no por `mCurrentFocus`.** Con la pantalla
  recién encendida, `mCurrentFocus` se queda reportando `NotificationShade`
  aunque Chrome ya esté al frente — daba un falso "no se abrió".
- **Lo primero es despertar la pantalla** (`despertarPantalla`). Un dispositivo
  dormido devuelve capturas **negras** y no deja que ninguna app tome el foco;
  los dos síntomas se ven como bugs distintos y son el mismo.
- **Varios proyectos viejos comparten el slug `general`** (herencia de la
  migración v5). Por eso `deleteProject` consulta `slugSharedWithOthers` antes de
  borrar la carpeta.

## Migraciones

`server/lib/db.js`, array `MIGRATIONS`, una por versión de `user_version`.

**Nunca editar una migración ya aplicada** — se agrega una nueva al final. (Pasó:
la v9 se editó después de aplicada y el cambio nunca corrió; hubo que hacer una
v10.)

## Verificar cambios

```bash
npm test          # node:test, sin red
npm run typecheck
npm run doctor    # qué falta instalar y el comando exacto para arreglarlo
npm run dev       # backend + cliente + voz + transcripción

# ¿lo que entregó el equipo es una app bien armada, o archivos sueltos?
node scripts/auditar-app.mjs <carpeta> [stack]
node scripts/auditar-app.mjs --workspace     # todo lo producido, con el stack de la base
```

`auditar-app.mjs` audita la **estructura**: que estén los archivos que el nicho
exige y que encajen entre ellos (el `namespace` del módulo contra el `package` del
código, el punto de entrada contra las pantallas de `src/`). El contenido lo
siguen midiendo `verify.js` y `native-build.js` — el script los usa, no los
reimplementa.

Los tests **no pueden depender de nombres de la plantilla** (Bruno, Renata…):
las plantillas cambian. Se filtra por `role` y se usan los nombres reales.

## Mapa de archivos

| Archivo | Qué resuelve |
|---|---|
| `server/lib/db.js` | Esquema y migraciones |
| `server/lib/store.js` | Único acceso a datos. Sin `fs`: el disco lo maneja quien llama |
| `server/lib/workforce.js` | Motor de trabajo: cola, corridas, revisión, contrato |
| `server/lib/verify.js` | Verificación determinista de entregables |
| `server/lib/playbooks.js` | Carga de los criterios de oficio y diseño |
| `server/lib/meeting-session.js` | Una reunión en vivo: turnos, ruteo, cierre |
| `server/lib/agent-runtime.js` | Prompt de conversación y streaming por agente |
| `server/lib/llm.js` | Cliente MiniMax/DeepSeek con rotación clave×modelo |
| `server/lib/emulator.js` | Emulador de Android y simulador de iOS |
| `src/main.ts` | Todo el cliente (vistas, WS, audio, render por regiones) |
