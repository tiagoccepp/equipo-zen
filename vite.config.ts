import { defineConfig } from 'vite';

// Proxy de dev: el cliente habla siempre same-origin y Vite reenvía al
// backend (HTTP, WebSocket y los entregables del workspace). Reemplaza la
// detección por puerto 5173.
const BACKEND_PORT = process.env.PORT || '8787';
const BACKEND = `http://127.0.0.1:${BACKEND_PORT}`;

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: 'index.html',
        orb: 'orb.html'
      }
    }
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': BACKEND,
      // Sin esto, el navegador integrado pediría los entregables a Vite y el
      // fallback de la SPA le devolvería la app dentro de la app.
      '/workspace': BACKEND,
      '/meeting': { target: `ws://127.0.0.1:${BACKEND_PORT}`, ws: true }
    }
  }
});
