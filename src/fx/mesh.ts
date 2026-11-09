// ═══════════════════════════════════════════════════════════════════════
// fx/mesh.ts — fondo mesh oscuro que RESPIRA con la energía del audio.
//
// Paleta consola: grises pizarra fríos a alfa baja. Textura que respira con
// la energía del audio (funcional), no blobs decorativos de marca.
// Con prefers-reduced-motion se pinta un frame estático y no hay loop.
//
// Hook del main (detrás del canvas de orbes, mismo tamaño):
//
//   <canvas id="mesh"></canvas>  <!-- position:fixed/absolute, z-index:0 -->
//   <canvas id="orbs"></canvas>  <!-- encima, transparente -->
//
//   import { mountMesh } from './fx/mesh.ts';
//   const mesh = mountMesh(document.getElementById('mesh'), { energy: () => level });
//   // en resize: mesh.resize(w, h) — … mesh.dispose()
// ═══════════════════════════════════════════════════════════════════════

export type MeshOptions = {
  // Energía del audio (0..1). La provee el main (misma que OrbField).
  energy: () => number;
};

export type MeshHandle = {
  resize: (cssWidth: number, cssHeight: number) => void;
  dispose: () => void;
};

// [x, y, radioBase, color, velocidad, fase] — posiciones relativas.
const BLOBS: Array<[number, number, number, string, number, number]> = [
  [0.22, 0.3, 0.55, '#2b3542', 0.5, 0.0],
  [0.8, 0.62, 0.6, '#1e3330', 0.34, 2.1],
  [0.55, 0.85, 0.45, '#262c36', 0.42, 4.2]
];

export function mountMesh(canvas: HTMLCanvasElement, options: MeshOptions): MeshHandle {
  const ctx = canvas.getContext('2d');
  let w = 0;
  let h = 0;
  let raf = 0;
  let lastAt = 0;
  let clock = 0;
  let level = 0;
  const reduced = typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function paint() {
    if (!ctx || w === 0 || h === 0) return;
    ctx.fillStyle = '#0b0c0e';
    ctx.fillRect(0, 0, w, h);
    const dim = Math.min(w, h);
    for (const [bx, by, br, color, speed, phase] of BLOBS) {
      const breathe = 1 + 0.1 * Math.sin(clock * speed + phase) + level * 0.22;
      const r = br * dim * breathe;
      const grad = ctx.createRadialGradient(bx * w, by * h, 0, bx * w, by * h, r);
      grad.addColorStop(0, color + '3d'); // ~24% alfa, tenue
      grad.addColorStop(1, color + '00');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w, h);
    }
    // Viñeta para que el centro (prompt/orbes) mande.
    const vg = ctx.createRadialGradient(w / 2, h / 2, dim * 0.2, w / 2, h / 2, dim * 0.95);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.5)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }

  function tick(now: number) {
    raf = 0;
    const dt = Math.min(0.05, Math.max(0, (now - lastAt) / 1000));
    lastAt = now;
    clock += dt;
    const target = Math.min(1, Math.max(0, options.energy() || 0));
    const step = Math.min(1, (target > level ? 8 : 3) * dt);
    level += (target - level) * step;
    paint();
    raf = requestAnimationFrame(tick);
  }

  function resize(cssWidth: number, cssHeight: number) {
    const dpr = Math.min(1.5, Math.max(1, window.devicePixelRatio || 1));
    w = Math.max(1, Math.round(cssWidth));
    h = Math.max(1, Math.round(cssHeight));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (reduced) paint();
    else if (!raf) {
      lastAt = performance.now();
      raf = requestAnimationFrame(tick);
    }
  }

  // Primer frame apenas se monta (el main llama resize con el tamaño real).
  if (reduced) paint();
  else {
    lastAt = typeof performance !== 'undefined' ? performance.now() : 0;
    raf = requestAnimationFrame(tick);
  }

  return {
    resize,
    dispose: () => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }
  };
}
