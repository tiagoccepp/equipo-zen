---
tags: [setup, config]
created: 2026-06-12
---

# Environment Variables

Archivo: `.env` (copiar de `.env.example`)

## Claves API

| Variable | Descripción |
|----------|-------------|
| `GEMINI_API_KEYS` | Lista separada por comas de claves API |
| `GEMINI_API_KEY_1` a `_6` | Formato alternativo (una por variable) |

> [!warning] Cuota
> Las claves comparten cuota de Gemini. Se recomienda usar al menos 6 para rotación automática.

## Modelos

| Variable | Modelo por defecto | Uso |
|----------|-------------------|-----|
| `GEMINI_LIVE_MODEL` | `gemini-3.1-flash-live-preview` | Audio en vivo |
| `GEMINI_TRANSCRIBE_MODEL` | `gemini-3.1-flash-lite` | Transcripción fallback |
| `GEMINI_AGENT_TEXT_MODEL` | `gemini-3.1-flash-lite` | Generación de texto |
| `GEMINI_ROUTER_MODEL` | `gemini-3.1-flash-lite` | Orquestador IA |
| `GEMINI_TTS_MODEL` | `gemini-2.5-flash-preview-tts` | Text-to-Speech |

## Servidor

| Variable | Default | Descripción |
|----------|---------|-------------|
| `PORT` | `8787` | Puerto del backend |

## Rotación de Claves

Ver [[02 - Architecture/Backend Components#ApiKeyRing|ApiKeyRing]] para detalles de cómo se gestionan las claves.

## Cooldowns

| Error | Tiempo de bloqueo |
|-------|-------------------|
| 429 (cuota agotada) | 1 hora |
| Error de red | 45 segundos |
| Error permanente | 24 horas |
| Respuesta vacía | Inmediato (rotación) |
