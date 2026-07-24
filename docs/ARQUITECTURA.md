# Arquitectura del Sistema de Agentes

Guía técnica completa de cómo funciona el sistema por dentro.

---

## 1. Vista General

```
┌─────────────────────────────────────────────────────────────────┐
│                        NAVEGADOR (Frontend)                      │
│                                                                  │
│  ┌──────────┐   ┌──────────────┐   ┌─────────────────────────┐  │
│  │ UI React │◄──│  WebSocket   │◄──│  AudioCapture (PCM)     │  │
│  │ (render) │──►│  Client      │──►│  @ 16kHz mono           │  │
│  └──────────┘   └──────┬───────┘   └─────────────────────────┘  │
│                        │                                         │
│  ┌─────────────────────┼─────────────────────────────────────┐  │
│  │                     │         Web Audio API                │  │
│  │  ┌──────────────────▼──────────────────┐                  │  │
│  │  │   PcmAudioQueue (reproduce 24kHz)   │                  │  │
│  │  └─────────────────────────────────────┘                  │  │
│  └───────────────────────────────────────────────────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │ ws://127.0.0.1:8787/meeting
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                       SERVIDOR (Backend)                         │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    MeetingSession                         │   │
│  │                                                           │   │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────┐  │   │
│  │  │ AgentRouter  │  │ MeetingMemory│  │ LiveAudioTrans- │  │   │
│  │  │ (orquestador)│  │ (memoria)    │  │ criberRuntime   │  │   │
│  │  └──────┬──────┘  └──────────────┘  └────────────────┘  │   │
│  │         │                                                 │   │
│  │         ▼                                                 │   │
│  │  ┌──────────────────────────────────────────────────┐    │   │
│  │  │              LiveAgentRuntime (×N)                │    │   │
│  │  │  ┌──────────┐  ┌───────────┐  ┌──────────────┐  │    │   │
│  │  │  │generate  │  │generate   │  │processAgent  │  │    │   │
│  │  │  │Text      │  │Audio(TTS) │  │TaskCommands  │  │    │   │
│  │  │  └──────────┘  └───────────┘  └──────────────┘  │    │   │
│  │  └──────────────────────────────────────────────────┘    │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    ApiKeyRing                             │   │
│  │  Rotación de claves Gemini con cooldown y failover       │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                    TelemetryBridge                        │   │
│  │  Eventos estructurados para monitoreo local              │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                     GOOGLE GEMINI API                            │
│                                                                  │
│  ┌───────────────┐  ┌──────────────┐  ┌──────────────────────┐ │
│  │ Live API      │  │ Text Gen     │  │ TTS (texto-a-voz)    │ │
│  │ (audio in/out)│  │ (respuestas) │  │ (gemini-2.5-flash-   │ │
│  │               │  │ (gemini-3.1- │  │  preview-tts)        │ │
│  │               │  │  flash-lite) │  │                      │ │
│  └───────────────┘  └──────────────┘  └──────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

---

## 2. Ciclo de Vida de un Mensaje

### 2.1 El usuario escribe o habla

```
USUARIO                          SISTEMA
   │                                │
   │  "Hola Julio, ¿cómo va?"      │
   │───────────────────────────────►│
   │                                │
   │                    ┌───────────┴───────────┐
   │                    │   WebSocket recibe     │
   │                    │   tipo: "user_turn"    │
   │                    └───────────┬───────────┘
   │                                │
   │                    ┌───────────▼───────────┐
   │                    │  MeetingSession        │
   │                    │  .enqueueUserTurn()    │
   │                    │  (agrega a la cola)    │
   │                    └───────────┬───────────┘
   │                                │
   │                    ┌───────────▼───────────┐
   │                    │  processUserTurn()     │
   │                    │  (procesa el turno)    │
   │                    └───────────┬───────────┘
   │                                │
```

### 2.2 Orquestación: ¿Quién responde?

```
   │                    ┌───────────────────────────────┐
   │                    │      routeUserTurn()           │
   │                    │                                │
   │                    │  1. AgentRouter.route()        │
   │                    │     (heurística: alias,        │
   │                    │      dominios, saludo,         │
   │                    │      cierre)                   │
   │                    │                                │
   │                    │  2. ¿Es saludo o grupo?        │
   │                    │     SÍ ──► route heurística    │
   │                    │     NO ──► ¿Hay IA router?     │
   │                    │            SÍ ──► planRouteWithAi()
   │                    │            NO ──► route heurística
   │                    │                                │
   │                    │  Retorna: { targets: [...],    │
   │                    │             reason: "..." }    │
   │                    └───────────┬───────────────────┘
   │                                │
   │                    ┌───────────▼───────────┐
   │                    │  route_decision        │
   │                    │  (se envía al cliente) │
   │                    └───────────┬───────────┘
   │                                │
```

### 2.3 Respuesta de los agentes (secuencial)

```
   │                    ┌───────────────────────────────────┐
   │                    │  for (target of route.targets)    │
   │                    │                                    │
   │                    │  ┌─────────────────────────────┐  │
   │                    │  │  AGENTE 1 (ej: Julio)       │  │
   │                    │  │                              │  │
   │                    │  │  agent_turn_start ──────────►│──┼──► UI muestra "Julio hablando..."
   │                    │  │                              │  │
   │                    │  │  generateText()             │  │
   │                    │  │    └─► Gemini API (texto)   │  │
   │                    │  │                              │  │
   │                    │  │  agent_transcript_delta ────►│──┼──► UI muestra texto streaming
   │                    │  │                              │  │
   │                    │  │  generateAudio()            │  │
   │                    │  │    └─► Gemini API (TTS)     │  │
   │                    │  │                              │  │
   │                    │  │  agent_audio_chunk ─────────►│──┼──► PcmAudioQueue reproduce voz
   │                    │  │                              │  │
   │                    │  │  processAgentTaskCommands()  │  │
   │                    │  │    └─► Parsea [TAREA_CREAR]  │  │
   │                    │  │    └─► Parsea [TAREA_COMPLETAR] │
   │                    │  │                              │  │
   │                    │  │  agent_turn_complete ───────►│──┼──► UI muestra respuesta final
   │                    │  └─────────────────────────────┘  │
   │                    │                                    │
   │                    │  ┌─────────────────────────────┐  │
   │                    │  │  AGENTE 2 (ej: Tomasa)      │  │
   │                    │  │  (mismo proceso, secuencial) │  │
   │                    │  └─────────────────────────────┘  │
   │                    └───────────────────────────────────┘
   │                                │
```

---

## 3. Componentes Principales

### 3.1 AgentRouter (Orquestador)

**Archivo:** `server/index.js` — clase `AgentRouter`

El orquestador decide qué agente responde. Usa un sistema de dos capas:

**Capa 1 — Heurística (rápida, local):**
- Detecta saludos (`isGreetingTurn`)
- Detecta cierres ("gracias", "perfecto", etc.)
- Detecta menciones directas ("Julio", "Tomasa")
- Detecta si se habla al grupo ("chicos", "equipo", "ambos")
- Compara dominios del agente contra palabras del mensaje

**Capa 2 — IA Router (inteligente, remota):**
- Solo se activa para saludos o cuando se habla al grupo
- Envía el contexto al modelo Gemini para decidir
- Retorna JSON con targets y razón

**Flujo de decisión:**
```
Mensaje del usuario
        │
        ▼
¿Es cierre? ──SÍ──► Devuelve último agente que habló
        │
        NO
        ▼
¿Es saludo? ──SÍ──► Devuelve todos los agentes (o los mencionados)
        │
        NO
        ▼
¿Se habla al grupo? ──SÍ──► IA Router decide quiénes
        │
        NO
        ▼
Evalúa por agente:
  - ¿Mencionaron su nombre? (+8 pts)
  - ¿Hay palabras de sus dominios? (+2 pts c/u)
  - ¿Hay señal de colaboración? (+1 pt)
  - ¿Es pregunta? (+1 pt)
        │
        ▼
¿Score >= 4? ──SÍ──► Agente responde
        │
        NO
        ▼
Nadie responde (sin inventar)
```

### 3.2 LiveAgentRuntime (Agente)

**Archivo:** `server/index.js` — clase `LiveAgentRuntime`

Cada agente tiene su propia instancia. Responsabilidades:

1. **Generar texto** (`generateText`):
   - Construye system prompt con identidad, tareas y protocolo
   - Construye prompt del turno con contexto y reglas
   - Llama a Gemini API con modelo `gemini-3.1-flash-lite`
   - Retorna texto limpio (sin etiquetas internas)

2. **Generar audio** (`generateAudio`):
   - Toma el texto generado
   - Llama a Gemini TTS con modelo `gemini-2.5-flash-preview-tts`
   - Retorna chunks de audio PCM

3. **Gestionar tareas** (`processAgentTaskCommands`):
   - Parsea etiquetas `[TAREA_CREAR: id: desc]`
   - Parsea etiquetas `[TAREA_COMPLETAR: #n]`
   - Actualiza el estado de tareas
   - Limpia las etiquetas del texto visible

### 3.3 ApiKeyRing (Rotación de Claves)

**Archivo:** `server/index.js` — clase `ApiKeyRing`

Gestiona 6 claves Gemini con rotación automática:

```
Clave disponible ──► Se usa ──► ¿Funcionó?
                              │
                         SÍ ──► Se queda disponible
                         NO ──► Se marca como fallida
                                │
                                ▼
                         cooldownUntil = ahora + X tiempo
                         │
                         ├── Error de cuota (429): 1 hora
                         ├── Error permanente: 24 horas
                         └── Error de red: 45 segundos
```

### 3.4 MeetingMemory (Memoria)

**Archivo:** `server/index.js` — clase `MeetingMemory`

Almacena los últimos 80 turnos de la conversación:

- **recentContext(limit)**: Devuelve los últimos N turnos formateados para los prompts
- **lastAgentTurn()**: Devuelve el último turno de un agente (para cierres y contextual followups)
- **seedTurnsFor(agent)**: Crea contexto semilla para reconexiones

### 3.5 TelemetryBridge (Telemetría)

**Archivo:** `server/index.js` — clase `TelemetryBridge`

Registra eventos estructurados para monitoreo:

| Endpoint | Qué muestra |
|----------|-------------|
| `GET /api/telemetry` | Últimos 800 eventos |
| `GET /api/telemetry/stream` | SSE en vivo |
| `GET /api/telemetry/analysis` | Métricas: latencias, alertas, turnos sin respuesta |
| `POST /api/telemetry/reset` | Limpia el historial |

---

## 4. Modelos de IA

| Modelo | Uso | Timeout |
|--------|-----|---------|
| `gemini-3.1-flash-live-preview` | Audio en vivo (entrada/salida) | — |
| `gemini-3.1-flash-lite` | Texto de agentes + orquestador | 8.5s / 4.5s |
| `gemini-2.5-flash-preview-tts` | Texto-a-voz (TTS) | 12s |
| `gemini-3.1-flash-lite` | Transcripción de audio (fallback) | — |

---

## 5. Protocolos

### 5.1 Protocolo de Turnos

- Los agentes responden **secuencialmente** (uno a la vez, nunca al mismo tiempo)
- Si el orquestador selecciona 2 agentes, primero habla el que tiene mayor score
- El contextual followup solo se activa si el otro agente es **mencionado por nombre** en la respuesta

### 5.2 Protocolo de Tareas

Los agentes pueden crear y completar tareas autónomamente:

```
Agente dice: "Armo la API [TAREA_CREAR: programacion: Implementar endpoint de login]"
                                 │
                                 ▼
El servidor parsea la etiqueta
Crea la tarea en el agente "programacion"
Actualiza la UI
Limpia la etiqueta del texto visible
```

### 5.3 Protocolo de Silencio

- Si un agente no debe hablar, **no genera respuesta**
- No envía "SILENCIO" como texto visible
- El orquestador simplemente no lo incluye en los targets

### 5.4 Protocolo de Cierre

Cuando el usuario dice algo como "gracias", "perfecto", "dale":
- Solo responde el último agente que habló
- Confirma breve que entendió
- No abre nuevos temas

---

## 6. Frontend

### 6.1 Captura de Audio

```
Micrófono ──► AudioContext (16kHz)
      │
      ▼
AudioWorkletNode (pcm-capture-processor)
      │
      ├─► Detecta inicio de habla (RMS > umbral)
      ├─► Envía chunks PCM al servidor
      └─► Detecta fin de habla (silencio > 800ms)
```

### 6.2 Reproducción de Audio

```
Servidor envía agent_audio_chunk (base64 PCM 24kHz)
      │
      ▼
PcmAudioQueue
      │
      ├─► Decodifica base64 a Int16Array
      ├─► Crea AudioBuffer (24kHz, mono)
      ├─► Programa reproducción secuencial
      └─► Cola dinámica: espera a que termine el anterior
```

### 6.3 Transcripción de Voz del Usuario

Se usa un sistema dual:

1. **Web Speech API** (navegador): Transcripción local en tiempo real como vista previa
2. **Gemini Live API** (servidor): Transcripción precisa como fuente oficial

El texto final del usuario viene del servidor. La vista previa del navegador es solo para mostrar al usuario mientras habla.
