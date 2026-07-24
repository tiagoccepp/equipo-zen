---
tags: [setup, reference]
created: 2026-06-12
---

# Dependencies

## Runtime

| Paquete | Versión | Uso |
|---------|---------|-----|
| `@google/genai` | ^2.8.0 | SDK de Google Gemini (Live API, TTS, text gen) |
| `express` | ^5.2.1 | Servidor HTTP para API y archivos estáticos |
| `ws` | ^8.18.3 | Servidor WebSocket para comunicación en tiempo real |
| `nanoid` | ^5.1.6 | IDs únicos cortos (sesiones, turnos, tareas) |
| `dotenv` | ^17.2.3 | Carga variables de `.env` |
| `concurrently` | ^10.0.3 | Ejecuta servidor + cliente simultáneamente |

## Dev

| Paquete | Versión | Uso |
|---------|---------|-----|
| `vite` | ^7.2.7 | Build tool y dev server para el frontend |
| `typescript` | ^5.9.3 | Compilador TypeScript |
| `@vitejs/plugin-react` | ^5.1.2 | Plugin Vite (presente pero el proyecto usa vanilla TS) |

## Scripts

```json
"dev": "concurrently \"npm run dev:server\" \"npm run dev:client\"",
"dev:server": "node --watch server/index.js",
"dev:client": "vite --host 127.0.0.1 --port 5173",
"build": "tsc && vite build",
"preview": "vite preview --host 127.0.0.1 --port 5173"
```

> [!note]
> A pesar de tener `@vitejs/plugin-react` instalado, el frontend es vanilla TypeScript sin framework.
