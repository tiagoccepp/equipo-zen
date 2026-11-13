import { defineConfig } from 'vite';

// Dev proxy: the client always talks same-origin and Vite forwards to the
// backend (HTTP, WebSocket, and workspace deliverables). Replaces port-5173
// detection.
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
      // Without this, the embedded browser would request deliverables from Vite and
      // the SPA fallback would return the app inside the app.
      '/workspace': BACKEND,
      '/meeting': { target: `ws://127.0.0.1:${BACKEND_PORT}`, ws: true }
    }
  }
});
