# Reunion con Julio y Tomasa

App local para conversar con dos agentes especializados como si estuvieran en una reunion: Julio como programador y Tomasa como especialista en operaciones y datos comerciales. La simulacion base es una distribuidora que gestiona inventario, pedidos, rutas, cobranzas y reportes. Julio construye el sistema; Tomasa valida que sirva al trabajo real de la empresa.

## Ejecutar

```bash
npm install
cp .env.example .env
npm run dev
```

Abre `http://127.0.0.1:5173`.

## Configurar claves

Edita `.env`:

```bash
GEMINI_API_KEYS=clave1,clave2,clave3,clave4,clave5,clave6
GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview
PORT=8787
```

Tambien puedes usar `GEMINI_API_KEY_1` a `GEMINI_API_KEY_6`. Si no configuras claves, la app corre en modo simulacion para probar la reunion sin consumir API.

Nota operativa: la rotacion implementada es failover ante errores de cuota, red o sesion. El diseno asume que tus claves pueden pertenecer a proyectos distintos para que la conversacion siga con una clave disponible. Revisa tus limites activos en AI Studio y cumple las politicas de uso.

## Como funciona

- `server/agents.config.json`: roles, dominios, alias, voz, limites y escenario de empresa simulada.
- `server/index.js`: WebSocket de reunion, transcriptor Live, orquestador, memoria, sesiones Gemini Live y rotacion de claves.
- `src/main.ts`: interfaz de reunion, captura PCM 16 kHz desde microfono, reproduccion PCM 24 kHz y transcripcion.
- `src/styles.css`: layout responsive para escritorio y movil.

## Observabilidad local

El backend mantiene un puente de telemetria local para revisar la experiencia completa sin enviar datos fuera de la maquina:

- `GET http://127.0.0.1:8787/api/telemetry?limit=200`: ultimos eventos estructurados.
- `GET http://127.0.0.1:8787/api/telemetry/stream`: stream SSE en vivo para seguir la interaccion.
- `GET http://127.0.0.1:8787/api/telemetry/analysis`: resumen de latencias, alertas, transcripcion, turnos sin respuesta y recomendaciones.
- `POST http://127.0.0.1:8787/api/telemetry/reset`: limpia el historial en memoria.

El puente registra clicks principales, escritura, audio, transcripciones, rutas del orquestador y respuestas finales. No guarda chunks de audio ni claves de API.

## Protocolo actual

- Un agente responde si el contexto cae dentro de su dominio, aunque no lo nombres.
- Julio y Tomasa pueden reaccionar entre ellos por contenido; Julio se enfoca en implementacion y Tomasa en procesos/datos comerciales.
- Si corresponde que hablen los dos, hablan por turnos, nunca al mismo tiempo.
- Si no hay dominio claro, el orquestador no envia el turno a ningun agente ni agrega mensajes al chat.
- Cada agente recibe instrucciones estrictas para devolver `SILENCIO` si no debe intervenir.
- Si el usuario cierra un tema, el ultimo agente responde `Ok, ya entendí.` y se calla.
- La memoria local guarda los ultimos turnos solo durante la reunion y se usa para rehidratar contexto al reconectar.

## Referencias oficiales usadas

- Google AI Live API overview: https://ai.google.dev/gemini-api/docs/live-api
- Google GenAI SDK Live quickstart: https://ai.google.dev/gemini-api/docs/live-api/get-started-sdk
- Live API capabilities: https://ai.google.dev/gemini-api/docs/live-api/capabilities
- Live session management: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/live-api/start-manage-session
