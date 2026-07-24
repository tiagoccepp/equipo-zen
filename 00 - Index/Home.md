---
aliases: [Home, Dashboard, Inicio]
tags: [index, moc]
created: 2026-06-12
updated: 2026-06-12
---

# Home - Reunión con Agentes

> Sistema de reunión en tiempo real con dos agentes de IA (Julio y Tomasa) que conversan por voz y texto simulando una distribuidora.

## Navegación Rápida

### [[01 - Setup/Quick Start|Setup]]
- [[01 - Setup/Quick Start|Instalación y ejecución]]
- [[01 - Setup/Environment Variables|Variables de entorno]]
- [[01 - Setup/Dependencies|Dependencias]]

### [[02 - Architecture/System Overview|Arquitectura]]
- [[02 - Architecture/System Overview|Vista general del sistema]]
- [[02 - Architecture/Backend Components|Componentes del backend]]
- [[02 - Architecture/Frontend Components|Componentes del frontend]]
- [[02 - Architecture/Data Flow|Flujo de datos]]
- [[02 - Architecture/AI Models|Modelos de IA]]

### [[03 - Agents/Agent Configuration|Agentes]]
- [[03 - Agents/Agent Configuration|Configuración de Julio y Tomasa]]
- [[03 - Agents/Routing Logic|Lógica de ruteo]]
- [[03 - Agents/Turn Protocol|Protocolo de turnos]]
- [[03 - Agents/Task System|Sistema de tareas]]

### [[04 - Audio/Audio Pipeline|Audio y Voz]]
- [[04 - Audio/Audio Pipeline|Pipeline de audio]]
- [[04 - Audio/Transcription|Transcripción]]
- [[04 - Audio/Microphone Settings|Configuración del micrófono]]

### [[05 - Telemetry/Telemetry System|Telemetría]]
- [[05 - Telemetry/Telemetry System|Sistema de telemetría]]
- [[05 - Telemetry/Metrics Reference|Referencia de métricas]]

### [[06 - Code Reference/Server Index|Referencia de Código]]
- [[06 - Code Reference/Server Index|server/index.js]]
- [[06 - Code Reference/Client Main|src/main.ts]]
- [[06 - Code Reference/WebSocket Protocol|Protocolo WebSocket]]

### [[07 - Decision Log/Decision Log|Log de Decisiones]]

### [[08 - Roadmap/Current Status|Roadmap]]
- [[08 - Roadmap/Current Status|Estado actual]]
- [[08 - Roadmap/Next Steps|Próximos pasos]]

---

## Resumen del Proyecto

| Campo | Valor |
|-------|-------|
| Nombre | `reunion-dos-agentes-live` |
| Versión | `0.1.0` |
| Backend | Node.js + Express + WebSocket |
| Frontend | Vanilla TypeScript + Vite |
| IA | Google Gemini (Live API, TTS, Text) |
| Agentes | [[03 - Agents/Agent Configuration#Julio\|Julio]] (programación) + [[03 - Agents/Agent Configuration#Tomasa\|Tomasa]] (operaciones) |
| Puerto servidor | `8787` |
| Puerto cliente | `5173` |

## Últimos Cambios

- **2026-06-12**: Sistema de auditoría en vivo con SSE streaming
- **2026-06-12**: Telemetría para tareas y creación de agentes
- **2026-06-12**: Resumen de sesión al cerrar
- **2026-06-12**: Humanización de respuestas de agentes
- **2026-06-12**: Fix de duplicación de tareas en `processAgentTaskCommands`
