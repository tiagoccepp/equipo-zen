// Desktop bridge (Tauri). Inert on web: isTauri() false and base ''.
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

let baseCache: string | null = null;

// Backend HTTP base. Web and `tauri dev` → '' (same-origin / Vite proxy).
// Packaged app → Node sidecar URL (ephemeral port).
export async function desktopApiBase(): Promise<string> {
  if (!isTauri()) {
    return '';
  }
  if (baseCache !== null) {
    return baseCache;
  }
  // `tauri dev` runs on http://127.0.0.1:5173 with Vite proxy → same-origin.
  // The packaged app lives on https://tauri.localhost (own protocol)
  // and the backend is the sidecar on 127.0.0.1:ephemeral-port.
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
