// Puente desktop (Tauri). En web es inerte: isTauri() false y base ''.
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

let baseCache: string | null = null;

// Base HTTP del backend. Web y `tauri dev` → '' (same-origin / proxy Vite).
// App empaquetada → URL del sidecar Node (puerto efímero).
export async function desktopApiBase(): Promise<string> {
  if (!isTauri()) {
    return '';
  }
  if (baseCache !== null) {
    return baseCache;
  }
  // `tauri dev` corre en http://127.0.0.1:5173 con proxy Vite → same-origin.
  // La app empaquetada vive en https://tauri.localhost (protocolo propio)
  // y el backend es el sidecar en 127.0.0.1:puerto-efímero.
  const { hostname, protocol } = window.location;
  const empaquetada = hostname === 'tauri.localhost'
    || hostname.endsWith('.tauri.localhost')
    || protocol === 'tauri:'
    || protocol === 'asset:';
  if (!empaquetada) {
    baseCache = '';
    return '';
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    baseCache = await invoke<string>('backend_url');
  } catch {
    baseCache = '';
  }
  return baseCache;
}

export async function tinvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}
