import { defineConfig } from 'vite';

// Proxy de dev: el cliente habla siempre same-origin y Vite reenvía al
// backend (HTTP y WebSocket). Reemplaza la detección por puerto 5173.
export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
      '/meeting': { target: 'ws://127.0.0.1:8787', ws: true }
    }
  }
});
