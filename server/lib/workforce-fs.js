// Salida de compilación y dependencias: NO son entregables. Vive aparte de
// workforce.js para que andamiaje.js pueda usarlo sin un ciclo de imports.
export const CARPETAS_IGNORADAS = new Set(['build', '.gradle', 'node_modules', 'dist', '.expo', 'Pods', '.venv', '__pycache__']);

export function esCarpetaIgnorada(nombre) {
  return CARPETAS_IGNORADAS.has(nombre);
}
