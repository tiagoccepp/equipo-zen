# Contexto del Proyecto: Reunión de Agentes en Vivo

Este proyecto implementa una plataforma de reunión en tiempo real ("Mesa de trabajo") donde el usuario puede interactuar con múltiples colaboradores de inteligencia artificial de forma conversacional (tanto por texto como por voz en vivo mediante Gemini Live API).

## Arquitectura y Stack Tecnológico

### Backend
- **Node.js + Express**: Servidor HTTP básico que gestiona las peticiones de telemetría y endpoints estáticos.
- **WebSockets (`ws`)**: Canal de comunicación bidireccional y de baja latencia para transmitir texto, eventos de orquestación, flujos de audio PCM y actualizaciones de estado del equipo en tiempo real.
- **Gemini Live API (`@google/genai` v2.8.0)**: Conexión WebSocket directa con el modelo `gemini-3.1-flash-live-preview` para respuestas por audio en tiempo real con latencia ultra-baja.
- **Orquestador Local (`AgentRouter`)**: Enruta los mensajes del usuario al colaborador más idóneo basándose en sus alias y dominios. Gestiona turnos contextuales (diálogos consecutivos entre colaboradores).
- **Sistema de Claves Rotativas**: Balancea y rota las API keys provistas para maximizar la disponibilidad y mitigar límites de cuotas.

### Client (Frontend)
- **Vanilla TypeScript + CSS**: Interfaz interactiva ligera, fluida y responsiva compilada con Vite.
- **Web Audio API**: 
  - Captura audio a 16kHz en mono con un `AudioWorkletProcessor` personalizado (`pcm-capture-processor`) para minimizar la latencia.
  - Reproduce flujos de audio PCM a 24kHz del backend usando colas de buffer encoladas dinámicamente (`PcmAudioQueue`).
- **Web Speech API (`webkitSpeechRecognition`)**: Reconocimiento de voz local en el navegador como vía rápida/respaldo de transcripción para guiar a los colaboradores.

---

## Estado Actual e Implementación Realizada

### 1. Gestión Dinámica y Mutable de Colaboradores
- El servidor inicializa el estado a partir de `agents.config.json` pero mantiene una lista mutable `this.sessionAgents` por sesión.
- Se implementaron mensajes WebSocket (`spawn_agent`, `add_task`, `toggle_task`, `delete_task`) para permitir al usuario añadir nuevos miembros al equipo y gestionar sus tareas.
- Se emite el evento `agents_updated` para sincronizar en tiempo real a todos los clientes.

### 2. Tablero de Tareas Orgánico
- Cada colaborador cuenta con un listado de tareas interactivo en su card.
- Se dibuja una barra de progreso que indica el porcentaje de tareas completadas utilizando un degradado sutil con el color de firma del colaborador.
- Los checkboxes de tareas están diseñados con animaciones y tachados CSS para darle un toque cálido e interactivo.
- Un formulario compacto en el card permite añadir tareas escribiendo y pulsando enter.

### 3. Reclutamiento Interactivo ("Sumar al Equipo")
- Se diseñó un panel lateral derecho (drawer) con desenfoque de fondo glassmorphism, transiciones fluidas de escala y opacidad, y inputs amigables.
- Permite definir nombre, rol, áreas de dominio, estilo de habla, voz en vivo de Gemini, color de firma y tareas iniciales.

### 4. Orquestación Conversacional Autónoma de Tareas
- Los colaboradores (tanto en modo Live como en Mock) reciben instrucciones detalladas sobre sus tareas y pueden proponer o completar tareas de forma autónoma.
- El backend procesa las etiquetas `[TAREA_CREAR: ...]` y `[TAREA_COMPLETAR: ...]` devueltas por los colaboradores, realiza las modificaciones en el estado y limpia el mensaje en la UI para evitar ruido visual técnico.

---

## Próximos Pasos
- **Persistencia de Sesiones:** Guardar el estado de los colaboradores dinámicos y sus tareas en base de datos (p. ej. SQLite o Firebase Firestore) para que persistan tras reiniciar el servidor.
- **Sistemas Agénticos Complejos:** Integrar frameworks de agentes autónomos avanzados (p. ej., OpenClaw, Hermes Agent, LangGraph) para permitir subtareas complejas, ejecuciones en segundo plano y herramientas automatizadas (tool use).
