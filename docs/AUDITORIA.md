# Auditoría del Sistema

Schematic completo de ejecución: qué hace la IA, cuándo se ejecuta cada elemento, qué acciones corren y cómo flujea todo.

---

## 1. Mapa de Ejecución por Evento

Cada acción del usuario desencadena una cadena de ejecución. Este mapa muestra exactamente qué se ejecuta y en qué orden.

### 1.1 Evento: Usuario envía un mensaje de texto

```
TIEMPO  EVENTO                          FUNCIÓN                         MODELO USADO
──────  ─────────────────────────────── ─────────────────────────────── ──────────────
0ms     WebSocket recibe message        handleClientMessage()
1ms     Tipo "user_turn" detectado      ─
2ms     Se encola el turno              enqueueUserTurn()               ─
3ms     Se guarda en memoria            memory.add('user', ...)        ─
4ms     Se envía al cliente             user_turn_received              ─
5ms     Se inicia procesamiento         processUserTurn(turnId, text)   ─
6ms     ┌─ ORQUESTACIÓN
7ms     │  Se evalúa ruta heurística    router.route(text, memory)     ─
8ms     │  ¿Es saludo?                  isGreetingTurn()               ─
8ms     │  ¿Es cierre?                  regex cierre                   ─
9ms     │  ¿Grupo mencionado?           regex grupo                    ─
10ms    │  Se evalúan dominios          domain matching                ─
11ms    │  Se calculan scores           ─                              ─
12ms    │  ¿Usar IA router?             shouldUseAiRouter()            ─
12ms    │  SÍ ──► planRouteWithAi()     ─                              gemini-3.1-flash-lite
13ms    │       Se genera prompt del    ─                              ─
        │       orquestador                                        ─
14ms    │       Se llama a Gemini       generateContentWithRotation()  gemini-3.1-flash-lite
15ms    │       Se parsea JSON          parseJsonFromModel()           ─
16ms    │  NO ──► Se usa ruta           ─                              ─
        │       heurística                                          ─
17ms    │  route_decision enviado       send({type:'route_decision'})  ─
18ms    └─ FIN ORQUESTACIÓN
19ms    ┌─ RESPUESTA DE AGENTES
20ms    │  Para cada target:
21ms    │  ┌─ AGENTE[i]
22ms    │  │  agent_turn_start enviado  send({type:'agent_turn_start'})
23ms    │  │
24ms    │  │  Se genera texto           agent.generateText()           gemini-3.1-flash-lite
25ms    │  │  ┌─ Se construye prompt    buildSystemInstruction()       ─
26ms    │  │  │  (system instruction)   ─                              ─
27ms    │  │  │  Se incluyen tareas     ─                              ─
28ms    │  │  │  Se incluye contexto    memory.recentContext()         ─
29ms    │  │  │  Se incluyen reglas     ─                              ─
30ms    │  │  │
31ms    │  │  │  Se construye prompt    buildTurnPrompt()              ─
32ms    │  │  │  del turno              ─                              ─
33ms    │  │  │
34ms    │  │  │  Se llama a Gemini      generateContentWithRotation()  gemini-3.1-flash-lite
35ms    │  │  │  ┌─ Se adquiere key     keyRing.acquire()              ─
36ms    │  │  │  │  Se ejecuta request  ai.models.generateContent()    gemini-3.1-flash-lite
37ms    │  │  │  │  Se valida respuesta hasContent check               ─
38ms    │  │  │  │  ¿Respuesta vacía?   ─                              ─
        │  │  │  │  SÍ ──► Se reporta   keyRing.reportFailure()       ─
        │  │  │  │        falla, rota   ─                              ─
        │  │  │  │  NO ──► OK           keyRing.reportSuccess()       ─
39ms    │  │  │  └─ Retorna response    ─                              ─
40ms    │  │  │
41ms    │  │  │  Se limpia texto        cleanAgentText()               ─
42ms    │  │  │  Se envía delta         agent_transcript_delta         ─
43ms    │  │  │  (streaming al UI)      ─                              ─
44ms    │  │  │
45ms    │  │  │  Se genera audio        agent.generateAudio()          gemini-2.5-flash-preview-tts
46ms    │  │  │  ┌─ Se adquiere key     keyRing.acquire()              ─
47ms    │  │  │  │  Se llama a Gemini   ai.models.generateContent()    gemini-2.5-flash-preview-tts
48ms    │  │  │  │  Se extraen partes   extractAudioParts()            ─
49ms    │  │  │  │  de audio            ─                              ─
50ms    │  │  │  │  Se envían chunks    agent_audio_chunk              ─
51ms    │  │  │  └─ (async, no bloquea) ─                              ─
52ms    │  │  │
53ms    │  │  │  Se parsean tareas      processAgentTaskCommands()     ─
54ms    │  │  │  ┌─ [TAREA_CREAR: ...]  regex create                  ─
55ms    │  │  │  │  [TAREA_COMPLETAR:]  regex complete                ─
56ms    │  │  │  │  Se limpian tags     stripTaskTags()               ─
57ms    │  │  │  │  ¿Hubo cambios?      ─                              ─
        │  │  │  │  SÍ ──► broadcast   broadcastAgentsUpdated()       ─
58ms    │  │  │  │
59ms    │  │  │  Se guarda en memoria   memory.add('agent', ...)       ─
60ms    │  │  │
61ms    │  │  │  agent_turn_complete    send({type:'agent_turn_complete'})
        │  │  │  enviado                ─                              ─
62ms    │  └─ FIN AGENTE[i]
63ms    │
64ms    │  ¿Hay contextual followup?    processContextualFollowups()   ─
65ms    │  ┌─ Solo si el otro agente
66ms    │  │  fue mencionado por nombre
67ms    │  │  nextContextualTarget()    ─                              ─
68ms    │  │  ¿Score >= 5?             ─                              ─
        │  │  SÍ ──► Se ejecuta turno  ─                              ─
        │  │        contextual         ─                              ─
69ms    │  └─ FIN FOLLOWUP
70ms    └─ FIN RESPUESTA
71ms
72ms    Se retorna al queue            turnQueue promise chain        ─
```

### 1.2 Evento: Usuario habla (audio en vivo)

```
TIEMPO  EVENTO                          FUNCIÓN                         MODELO USADO
──────  ─────────────────────────────── ─────────────────────────────── ──────────────
0ms     Usuario presiona botón mic      toggleLiveAudio()               ─
1ms     Se crea BrowserSpeechRecognizer browserSpeech.start()           ─
2ms     Se crea LiveMicrophoneStreamer  microphone.start()              ─
3ms     Se obtiene MediaStream          navigator.getUserMedia()        ─
4ms     Se crea AudioContext (16kHz)    new AudioContext()              ─
5ms     Se carga AudioWorklet           audioWorklet.addModule()        ─
6ms     Se conectan nodos               source → worklet → mute → dest ─
7ms     Microfono listo                 trace('microphone_ready')       ─
        │
        │  ┌─ MIENTRAS EL USUARIO HABLA
8ms     │  │  Cada ~60ms llega chunk    handlePcmChunk()               ─
9ms     │  │  Se calcula RMS            ─                              ─
10ms    │  │  Se actualiza medidor      onMeter() → render()           ─
11ms    │  │
12ms    │  │  ¿RMS > umbral?            micThresholds()                ─
        │  │  SÍ ──► speaking = true    ─                              ─
13ms    │  │        Se detiene audio    state.audio.stop()             ─
        │  │        del agente          ─                              ─
14ms    │  │        Se envía audio_start send({type:'audio_start'})     ─
15ms    │  │        Se envían preBuffer send({type:'audio_chunk'})     ─
16ms    │  │
17ms    │  │  Se envía chunk al server  send({type:'audio_chunk'})     ─
18ms    │  │
19ms    │  │  ¿Silencio > 800ms?        ─                              ─
        │  │  SÍ ──► speaking = false   ─                              ─
20ms    │  │        Se envía audio_end  send({type:'audio_end'})       ─
21ms    │  │        con transcriptHint  ─                              ─
22ms    │  └─ FIN LOOP AUDIO
        │
        │  ┌─ EN EL SERVIDOR
23ms    │  │  audio_start recibido      transcriber.startListening()   ─
24ms    │  │  Se prepara sesión Live    transcriber.ensureSession()    ─
25ms    │  │  ┌─ ¿Sesión activa?       ─                              ─
        │  │  │  SÍ ──► Se reutiliza   ─                              ─
        │  │  │  NO ──► connectWithRotation()                          ─
26ms    │  │  │        Se adquiere key  keyRing.acquire()              ─
27ms    │  │  │        Se conecta       ai.live.connect()              gemini-3.1-flash-live-preview
28ms    │  │  │        onopen: OK       keyRing.reportSuccess()       ─
29ms    │  │  │        onerror: fail    keyRing.reportFailure()       ─
30ms    │  │  └─
31ms    │  │
32ms    │  │  audio_chunk recibido      transcriber.sendAudio()        ─
33ms    │  │  Se envía a Live API       session.sendRealtimeInput()    gemini-3.1-flash-live-preview
34ms    │  │
35ms    │  │  audio_end recibido        transcriber.endAudio()         ─
36ms    │  │  ┌─ ¿Tiene transcriptHint? ─                              ─
        │  │  │  SÍ ──► acceptClient   ─                              ─
        │  │  │        Transcript()     ─                              ─
37ms    │  │  │  NO ──► scheduleFinalize()                             ─
38ms    │  │  │        └─► finalizeTranscript()                        ─
39ms    │  │  │            └─► ¿Audio buffer > 1600 bytes?             ─
        │  │  │               SÍ ──► transcribeBufferedAudio()        gemini-3.1-flash-lite
        │  │  │               NO ──► Se descarta                      ─
40ms    │  │  │
41ms    │  │  │  emitFinalTranscript()  ─                              ─
42ms    │  │  │  Se envía al cliente    user_audio_turn_final          ─
43ms    │  │  │  Se encola como turno   enqueueAudioTranscript()       ─
44ms    │  │  └─ (se procesa como       ─                              ─
        │  │      texto normal)                                        ─
45ms    │  └─ FIN SERVIDOR
```

---

## 2. Tabla de Modelos y Acciones

Cada modelo de Gemini se ejecuta en momentos específicos:

```
ACCIÓN                        MODELO                          TIMEOUT    CUÁNDO SE EJECUTA
────────────────────────────  ──────────────────────────────  ─────────  ──────────────────────────────
Generar texto de agente       gemini-3.1-flash-lite           8.5s       Cada turno de agente
Orquestador IA                gemini-3.1-flash-lite           4.5s       Saludos o grupo addressed
Generar audio (TTS)           gemini-2.5-flash-preview-tts    12s        Después de cada texto de agente
Transcribir audio (fallback)  gemini-3.1-flash-lite           —          Si Live API no transcribe
Audio en vivo                 gemini-3.1-flash-live-preview   —          Mientras el usuario habla
```

---

## 3. Flujo de Claves (ApiKeyRing)

```
                    ┌─────────────────────────────────────┐
                    │           ApiKeyRing                 │
                    │                                      │
                    │  key-1 ──● cooldown: 0s (libre)     │
                    │  key-2 ──● cooldown: 0s (libre)     │
                    │  key-3 ──● cooldown: 45s (fallida)  │
                    │  key-4 ──● cooldown: 3600s (cuota)  │
                    │  key-5 ──● cooldown: 0s (libre)     │
                    │  key-6 ──● cooldown: 86400s (perm)  │
                    │                                      │
                    │  cursor: 3 (próxima a probar)       │
                    └─────────────────────────────────────┘

acquire():
  1. Empieza en cursor
  2. Por cada key:
     ¿cooldownUntil <= ahora?
       SÍ ──► La devuelve, avanza cursor
       NO ──► Siguiente key
  3. Si todas están en cooldown ──► Retorna null

reportFailure(key, error):
  key.failures += 1
  key.lastError = error.message
  ¿Es error de cuota (429)?
    SÍ ──► cooldown = 1 hora
    NO ──► ¿Es error permanente?
      SÍ ──► cooldown = 24 horas
      NO ──► cooldown = 45 segundos

reportSuccess(key):
  key.failures = 0
  key.lastError = null
```

---

## 4. Mapa de Eventos WebSocket

### 4.1 Cliente → Servidor

```
TIPO                    DATOS                           CUÁNDO
──────────────────────  ──────────────────────────────  ──────────────────────
user_turn               { text }                        Usuario escribe texto
audio_prepare           —                               Usuario activa mic
audio_start             —                               Inicio de habla detectado
audio_chunk             { data, mimeType }              Mientras habla (~60ms)
audio_end               { transcriptHint }              Fin de habla
audio_cancel            { reason, speechMs }            Habla muy corta
audio_stop              —                               Usuario desactiva mic
reset                   —                               "Reiniciar reunión"
health                  —                               "Estado de claves"
spawn_agent             { agent }                       "Sumar al Equipo"
add_task                { agentId, text }               Nuevo tarea
toggle_task             { agentId, taskId, completed }  Checkbox
delete_task             { agentId, taskId }             Eliminar tarea
```

### 4.2 Servidor → Cliente

```
TIPO                        DATOS                           CUÁNDO
──────────────────────────  ──────────────────────────────  ──────────────────────
meeting_ready               { id, agents, model, liveMode } Al conectar
meeting_reset               —                               Después de reset
agents_updated              { agents }                      Cambio de tareas/agente
user_turn_received          { turnId, text, source }        Turno encolado
route_decision              { turnId, route }               Después de orquestar
no_agent_response           { turnId, note }                Nadie responde
agent_turn_start            { turnId, agentId }             Agente empieza
agent_transcript_delta      { turnId, agentId, delta }      Texto streaming
agent_audio_chunk           { turnId, agentId, data }       Chunk de voz
agent_turn_complete         { turnId, agentId, text }       Agente terminó
agent_warning               { turnId, agentId, message }    Advertencia
agent_silence               { agentId, reason }             Agente declina
audio_listening_start       —                               Live API escuchando
audio_listening_stop        —                               Live API paró
user_audio_transcript_delta { delta, text }                 Transcripción parcial
user_audio_turn_final       { text, source }                Transcripción final
api_rotation_start          { scope, message }              Rotando clave
api_rotation_resolved       { scope, keyId }                Clave funcionó
api_rotation_failed         { scope, message }              Todas fallaron
health                      { keys }                        Estado de claves
error                       { message, detail }             Error general
```

---

## 5. Métricas de Telemetría

El endpoint `GET /api/telemetry/analysis` devuelve:

```json
{
  "generatedAt": "2026-06-12T00:57:39.209Z",
  "windowEvents": 150,
  "metrics": {
    "totalEvents": 150,
    "userTurns": 12,
    "audioTurns": 3,
    "textTurns": 9,
    "routeDecisions": 12,
    "noAgentResponses": 1,
    "agentCompletions": 18,
    "emptyAgentCompletions": 2,
    "fallbackTranscriptions": 1,
    "clientTranscriptions": 0,
    "liveTranscriptions": 2,
    "alerts": 5,
    "errorAlerts": 1,
    "avgVisibleResponseMs": 3200,
    "maxVisibleResponseMs": 7800,
    "avgAgentResponseMs": 2100,
    "maxAgentResponseMs": 5400
  },
  "slowTurns": [...],
  "recentAlerts": [...],
  "recommendations": [
    "No se detectaron fricciones fuertes en la ventana analizada."
  ]
}
```

### 5.1 Definición de Métricas

| Métrica | Qué mide |
|---------|----------|
| `userTurns` | Turnos totales del usuario |
| `audioTurns` / `textTurns` | Desglose por tipo de entrada |
| `routeDecisions` | Veces que el orquestador evaluó |
| `noAgentResponses` | Turnos donde nadie respondió |
| `agentCompletions` | Respuestas totales de agentes |
| `emptyAgentCompletions` | Agentes que empezaron turno sin texto final |
| `avgVisibleResponseMs` | Tiempo promedio desde usuario hasta respuesta visible |
| `maxVisibleResponseMs` | Tiempo máximo de respuesta visible |
| `avgAgentResponseMs` | Tiempo promedio de generación por agente |
| `fallbackTranscriptions` | Veces que se usó transcripción fallback |

---

## 6. Schematic de la UI

```
┌─────────────────────────────────────────────────────────────────────┐
│  MESA DE TRABAJO                              [Conectado ●]        │
│  Reunión en vivo                              [Sumar al Equipo +]  │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  COLABORADORES                                               │   │
│  │                                                               │   │
│  │  ┌─────────────────────┐  ┌─────────────────────┐           │   │
│  │  │ J │ Julio            │  │ T │ Tomasa           │           │   │
│  │  │   │ Programador      │  │   │ Operaciones      │           │   │
│  │  │   │ prog · código ·  │  │   │ ventas · stock · │           │   │
│  │  │   │ api              │  │   │ pedidos          │           │   │
│  │  │                     │  │                     │           │   │
│  │  │ Tareas: 0/2         │  │ Tareas: 1/3         │           │   │
│  │  │ [██░░░░░░░░] 0%     │  │ [██████░░░░] 33%    │           │   │
│  │  │                     │  │                     │           │   │
│  │  │ [ ] Diseñar API     │  │ [x] Revisar stock   │           │   │
│  │  │ [ ] Implementar JWT │  │ [ ] Rutas reparto   │           │   │
│  │  │                     │  │ [ ] Cobranzas       │           │   │
│  │  │ [Sumar tarea...]    │  │ [Sumar tarea...]    │           │   │
│  │  └─────────────────────┘  └─────────────────────┘           │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  CONVERSACIÓN                                                │   │
│  │                                                               │   │
│  │  ┌─ Sistema ─────────────────────────────────────────────┐  │   │
│  │  │ Modo Live conectado. Julio y Tomasa responden por     │  │   │
│  │  │ sesiones Gemini Live en el backend.                    │  │   │
│  │  └───────────────────────────────────────────────────────┘  │   │
│  │                                                               │   │
│  │  ┌─ Tu ──────────────────────────────────────────────────┐  │   │
│  │  │ Hola chicos                                           │  │   │
│  │  └───────────────────────────────────────────────────────┘  │   │
│  │                                                               │   │
│  │  ┌─ Julio ───────────────────────────────────────────────┐  │   │
│  │  │ Todo bien, ¿cómo anda todo? ¿Arrancamos?             │  │   │
│  │  └───────────────────────────────────────────────────────┘  │   │
│  │                                                               │   │
│  │  ┌─ Tomasa ──────────────────────────────────────────────┐  │   │
│  │  │ Todo bien, Julio. Dale, arranquemos que tengo varios  │  │   │
│  │  │ temas de stock para revisar.                           │  │   │
│  │  └───────────────────────────────────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  ORQUESTACIÓN                                               │   │
│  │  ┌───────────────────────────────────────────────────────┐  │   │
│  │  │ Julio     dominio detectado  [saludo]                │  │   │
│  │  │ Tomasa    dominio detectado  [saludo]                │  │   │
│  │  └───────────────────────────────────────────────────────┘  │   │
│  │                                                               │   │
│  │  Claves: [key-1 ✓] [key-2 ✓] [key-3 ✓] [key-4 ✓]         │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  MICRÓFONO                                                   │   │
│  │  [🎤]  Audio Live                                           │   │
│  │  Escuchando audio real.                                      │   │
│  │                                                               │   │
│  │  [████████░░░░░░░░] ████████  Sensibilidad: 55%             │   │
│  │  Cierre: 800ms    Mínimo voz: 600ms                         │   │
│  │  [Ruido] [Normal ✓] [Suave]                                 │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  ┌──────────────────────────────────┐  ┌────────────────┐  │   │
│  │  │ [Reunión]                        │  │ [Enviar]       │  │   │
│  │  │ Di o escribe: revisemos una      │  └────────────────┘  │   │
│  │  │ arquitectura...                  │                       │   │
│  │  └──────────────────────────────────┘                       │   │
│  │  [Reiniciar reunión]  [Estado de claves]                    │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 7. Logs de Auditoría

Cada acción genera un evento de telemetría. Para ver los logs en tiempo real:

```bash
# Últimos 200 eventos
curl http://127.0.0.1:8787/api/telemetry?limit=200

# Stream en vivo (SSE)
curl http://127.0.0.1:8787/api/telemetry/stream

# Análisis completo
curl http://127.0.0.1:8787/api/telemetry/analysis

# Limpiar historial
curl -X POST http://127.0.0.1:8787/api/telemetry/reset
```

### 7.1 Tipos de Eventos Registrados

| Evento | Qué registra |
|--------|-------------|
| `page_loaded` | Carga de la página, user agent, viewport |
| `socket_open` / `socket_close` | Conexiones WebSocket |
| `meeting_ready` | Sesión iniciada, modelo, agentes |
| `meeting_warmup_start/complete` | Calentamiento de sesiones Live |
| `manual_turn_submitted` | Turno de texto enviado |
| `speech_started` / `speech_ended` | Inicio/fin de habla del usuario |
| `speech_discarded` | Habla descartada (muy corta) |
| `route_decision` | Orquestación: targets, razón, score |
| `agent_turn_start` | Agente empieza a responder |
| `agent_visible_complete` | Respuesta visible (con tiempos) |
| `ai_route_planned` / `ai_route_failed` | Resultado del orquestador IA |
| `contextual_route_decision` | Followup contextual activado |
| `api_rotation_start/resolved/failed` | Rotación de claves |
| `ui_alert` | Alertas mostradas al usuario |
| `client_audio_chunk_summary` | Resumen de chunks de audio |
