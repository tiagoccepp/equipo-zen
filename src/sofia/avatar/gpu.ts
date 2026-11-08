/**
 * One-time WebGL backend probe.
 *
 * WebView2 (Chromium) falls back to a multi-threaded SOFTWARE rasterizer
 * (SwiftShader / WARP) when the GPU is blocklisted, the driver is broken/outdated,
 * or the app runs under Remote Desktop / a VM. Software-rendering a full-window
 * animated orb at 60fps saturates every CPU core, which is the cause of Q's
 * runaway-CPU symptom. We probe the backend once at startup so the orb can drop to
 * a light preset when there is no real GPU, and we log the renderer string either
 * way so the actual backend is always visible for diagnosis.
 */

export interface GpuInfo {
  /** The unmasked renderer string (or a best-effort fallback). */
  renderer: string;
  /** True when the renderer is a CPU/software rasterizer (SwiftShader, WARP, ...). */
  software: boolean;
}

// Substrings that identify a CPU/software WebGL backend across Chromium + Windows.
const SOFTWARE_RE = /swiftshader|software|basic render|microsoft basic|warp|llvmpipe/i;

/** True when a WebGL renderer string names a CPU/software rasterizer. */
export function isSoftwareRenderer(renderer: string): boolean {
  return SOFTWARE_RE.test(renderer);
}

let cached: GpuInfo | null = null;

/** Probe the WebGL backend once (result cached for the session). */
export function detectGpu(): GpuInfo {
  if (cached) return cached;
  cached = probe();
  return cached;
}

function probe(): GpuInfo {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const gl = (canvas.getContext('webgl2') ||
      canvas.getContext('webgl')) as WebGLRenderingContext | null;
    if (!gl) {
      // No WebGL at all: the machine cannot hardware-accelerate the orb, so treat
      // it as software (the light preset is the safe path).
      return { renderer: 'none', software: true };
    }
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = String(
      (dbg && gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) ||
        gl.getParameter(gl.RENDERER) ||
        'unknown',
    );
    // Release the probe context promptly rather than waiting for GC.
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return { renderer, software: isSoftwareRenderer(renderer) };
  } catch {
    // On an unexpected probe failure, do NOT degrade a machine that may be fine.
    return { renderer: 'error', software: false };
  }
}
