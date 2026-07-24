---
tags: [architecture, overview]
created: 2026-06-12
---

# System Overview

## Descripción General

Sistema de reunión en tiempo real donde un usuario conversa por voz y texto con dos agentes de IA que simulan ser empleados de una distribuidora.

## Diagrama de Componentes

```
┌─────────────────────────────────────────────────────────┐
│                    NAVEGADOR                             │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────────┐ │
│  │ UI/State │  │ Audio    │  │ Speech Recognizer     │ │
│  │ Render   │  │ Capture  │  │ (Browser API)         │ │
│  └────┬─────┘  └────┬─────┘  └───────────┬───────────┘ │
│       │              │                    │              │
│       └──────────────┼────────────────────┘              │
│                      │                                   │
│               WebSocket Client                           │
└──────────────────────┼───────────────────────────────────┘
                       │ ws://host:8787/meeting
┌──────────────────────┼───────────────────────────────────┐
│                SERVIDOR NODEJS                            │
│                      │                                   │
│  ┌───────────────────┴────────────────────────────────┐ │
│  │              MeetingSession                         │ │
│  │  ┌─────────┐  ┌──────────┐  ┌──────────────────┐  │ │
│  │  │ Router  │  │ Memory   │  │ Turn Queue       │  │ │
│  │  │ (Heur+  │  │ (80      │  │ (Promise chain)  │  │ │
│  │  │  AI)    │  │  turns)  │  │                  │  │ │
│  │  └────┬────┘  └──────────┘  └──────────────────┘  │ │
│  │       │                                            │ │
│  │  ┌────┴────────────────────────────────────────┐  │ │
│  │  │         Agent Runtime Map                    │  │ │
│  │  │  ┌──────────────┐  ┌──────────────┐         │  │ │
│  │  │  │ Julio        │  │ Tomasa       │         │  │ │
│  │  │  │ (programación)│  │ (operaciones)│         │  │ │
│  │  │  │ Text → TTS   │  │ Text → TTS   │         │  │ │
│  │  │  └──────────────┘  └──────────────┘         │  │ │
│  │  └─────────────────────────────────────────────┘  │ │
│  └────────────────────────────────────────────────────┘ │
│                      │                                   │
│  ┌───────────────────┴────────────────────────────────┐ │
│  │              ApiKeyRing                             │ │
│  │  Key 1 → Key 2 → Key 3 → Key 4 → Key 5 → Key 6   │ │
│  │  (rotación automática con cooldown)                 │ │
│  └────────────────────────────────────────────────────┘ │
│                      │                                   │
│  ┌───────────────────┴────────────────────────────────┐ │
│  │              TelemetryBridge                        │ │
│  │  Ring buffer → SSE stream → Analysis               │ │
│  └────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
                       │
                       ▼
              Google Gemini API
```

## Componentes Principales

Ver [[02 - Architecture/Backend Components|Backend Components]] y [[02 - Architecture/Frontend Components|Frontend Components]].

## Flujo de Datos

Ver [[02 - Architecture/Data Flow|Data Flow]].

## Modelos de IA

Ver [[02 - Architecture/AI Models|AI Models]].

## Estructura de Archivos

```
Equipo/
├── server/
│   ├── index.js              # Backend completo (~2400 líneas)
│   └── agents.config.json    # Definición de agentes
├── src/
│   ├── main.ts               # Frontend completo (~1600 líneas)
│   └── styles.css            # Estilos (~1000 líneas)
├── docs/                     # Documentación HTML
├── .env                      # Variables de entorno
└── .obsidian/                # Vault de Obsidian
```
