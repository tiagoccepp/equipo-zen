---
tags: [setup, guide]
created: 2026-06-12
---

# Quick Start

## Requisitos
- Node.js 18+
- 6 claves de API de Google Gemini

## Instalación

```bash
cd Equipo
npm install
```

## Configurar variables de entorno

Copiar `.env.example` a `.env` y configurar las claves API. Ver [[01 - Setup/Environment Variables|Variables de entorno]].

## Ejecutar

```bash
npm run dev
```

Esto inicia:
- **Servidor** en `http://127.0.0.1:8787`
- **Cliente** en `http://127.0.0.1:5173`

## Verificar

Abrir `http://127.0.0.1:5173` en el navegador. Los agentes deberían estar visibles en la UI.

## URLs útiles

| URL | Descripción |
|-----|-------------|
| `http://127.0.0.1:5173` | Aplicación principal |
| `http://127.0.0.1:8787/arquitectura` | Documentación de arquitectura |
| `http://127.0.0.1:8787/auditoria` | Dashboard de auditoría en vivo |
| `ws://127.0.0.1:8787/meeting` | WebSocket endpoint |

## Comandos útiles

```bash
npm run dev:server    # Solo servidor (con --watch)
npm run dev:client    # Solo Vite
npm run build         # Build de producción
```
