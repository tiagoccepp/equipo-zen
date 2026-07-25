// ═══════════════════════════════════════════════════════════════════════
// Esferas de partículas del modo llamada.
//
// Una sola <canvas> dibuja TODAS las esferas (una por empleado presente) con
// un único requestAnimationFrame. Cada esfera es una nube de puntos sobre una
// esfera unitaria: se proyecta ortográficamente, así que gire o salte, la
// silueta sigue siendo un círculo. Lo que cambia es el radio de cada
// partícula, nunca la forma del conjunto.
//
// Dos decisiones que valen la pena explicar:
//
//  1. El COLOR se armoniza en OKLCh: de cada `agent.color` conservamos solo el
//     tono (H) y le imponemos la misma luminosidad y una croma bajísima a
//     todos. En HSL "misma L" no es "mismo brillo percibido" (un amarillo con
//     L=60% grita y un azul con L=60% se hunde), y esa diferencia es
//     exactamente la que hace que seis colores se lean como un semáforo. En
//     OKLCh sí: las esferas quedan como una familia de grises con un dejo de
//     tono cada uno. Ver ORB_TONE.
//
//  2. El LAYOUT no lo decide el canvas. Cada esfera tiene un hueco en el DOM
//     (una celda de la grilla, con el nombre del empleado debajo como texto
//     real) y el canvas se limita a dibujar dentro del rectángulo que esa
//     celda ocupa. Así el responsive, el salto de línea y el centrado los
//     resuelve CSS, y el lector de pantalla lee nombres, no un dibujo.
// ═══════════════════════════════════════════════════════════════════════

const TAU = Math.PI * 2;
// Ángulo dorado: el paso que reparte puntos (o tonos) sin que se apelotonen.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

export type OrbTheme = 'light' | 'dark';

export type OrbAgent = {
  id: string;
  name: string;
  // Color original del empleado (#rrggbb). Se armoniza acá adentro.
  color: string;
};

// Dónde y de qué tamaño va cada esfera, en píxeles CSS relativos al canvas.
// Lo mide el cliente sobre el DOM (getBoundingClientRect de cada celda).
export type OrbSlot = {
  id: string;
  cx: number;
  cy: number;
  r: number;
};

// ── Color: una familia, no un semáforo ─────────────────────────────────
// Luminosidad y croma fijas por tema; del color del empleado solo sobrevive
// el tono. Los valores están elegidos contra los tokens de la app:
//   claro  → fondo #f5f3ed (L≈0.96): puntos a L=0.58 tienen contraste sobrado.
//   oscuro → fondo #171913 (L≈0.22): puntos a L=0.76 se leen sin brillar.
// La croma (0.05) es deliberadamente ridícula: apenas un dejo de tono.
export const ORB_TONE: Record<OrbTheme, { l: number; c: number }> = {
  light: { l: 0.58, c: 0.062 },
  dark: { l: 0.76, c: 0.065 }
};

// Separación mínima de tono entre dos esferas, en radianes (~31°). Hace falta
// porque el color del empleado NO es único: a la CEO y al contratista de las
// empresas viejas se les asignó el color de la empresa, y dos plantillas
// distintas repiten paletas. Con la croma tan baja, dos tonos a menos de 30°
// dan exactamente el mismo gris.
const MIN_HUE_GAP = 0.55;

type Rgb = { r: number; g: number; b: number };

function srgbToLinear(value: number) {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

function linearToSrgb(value: number) {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

export function parseHexColor(hex: string): Rgb | null {
  const match = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i.exec((hex || '').trim());
  if (!match) {
    return null;
  }
  const digits = match[1].length === 3
    ? match[1].split('').map((digit) => digit + digit).join('')
    : match[1];
  return {
    r: parseInt(digits.slice(0, 2), 16) / 255,
    g: parseInt(digits.slice(2, 4), 16) / 255,
    b: parseInt(digits.slice(4, 6), 16) / 255
  };
}

// sRGB → OKLab (Björn Ottosson). Es la única transformación que hace que
// "misma L" signifique "mismo brillo" para el ojo.
function rgbToOklab(rgb: Rgb) {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s
  };
}

function oklabToRgb(lab: { L: number; a: number; b: number }): Rgb {
  const l = Math.pow(lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b, 3);
  const m = Math.pow(lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b, 3);
  const s = Math.pow(lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b, 3);

  return {
    r: clamp01(linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    g: clamp01(linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    b: clamp01(linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s))
  };
}

function clamp01(value: number) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

function toHex(rgb: Rgb) {
  const byte = (value: number) => Math.round(clamp01(value) * 255).toString(16).padStart(2, '0');
  return `#${byte(rgb.r)}${byte(rgb.g)}${byte(rgb.b)}`;
}

// Tono (en radianes) del color del empleado. null si el color es inválido o
// un gris puro: no hay tono que conservar.
export function colorHue(hex: string): number | null {
  const rgb = parseHexColor(hex);
  if (!rgb) {
    return null;
  }
  const lab = rgbToOklab(rgb);
  if (Math.sqrt(lab.a * lab.a + lab.b * lab.b) < 0.004) {
    return null;
  }
  return Math.atan2(lab.b, lab.a);
}

// Un tono + la luminosidad y croma de la familia = el color final del punto.
export function orbColorFromHue(hue: number, theme: OrbTheme): string {
  const tone = ORB_TONE[theme];
  return toHex(oklabToRgb({
    L: tone.l,
    a: Math.cos(hue) * tone.c,
    b: Math.sin(hue) * tone.c
  }));
}

function hueDistance(a: number, b: number) {
  const diff = Math.abs(((a - b) % TAU + TAU + Math.PI) % TAU - Math.PI);
  return diff;
}

// Reparte los tonos de una llamada: el primero que llega conserva el suyo tal
// cual, y a los que caen demasiado cerca de uno ya tomado se los corre lo
// mínimo necesario. Determinista (mismo elenco → mismos tonos) y estable en el
// orden en que llega el equipo.
export function resolveOrbHues(colors: string[]): number[] {
  const taken: number[] = [];
  const free = (hue: number) => !taken.some((other) => hueDistance(hue, other) < MIN_HUE_GAP);

  // Último recurso: el medio del hueco más grande que quede. Con 8 esferas la
  // rueda se fragmenta y puede no quedar NINGÚN lugar a 0.55 de todos; ahí lo
  // correcto es repartir lo mejor posible, no repetir un tono.
  const widestGap = () => {
    const sorted = [...taken].sort((a, b) => a - b);
    let best = sorted[0] + TAU - sorted[sorted.length - 1];
    let hue = (sorted[sorted.length - 1] + best / 2) % TAU;
    for (let index = 1; index < sorted.length; index += 1) {
      const gap = sorted[index] - sorted[index - 1];
      if (gap > best) {
        best = gap;
        hue = sorted[index - 1] + gap / 2;
      }
    }
    return hue % TAU;
  };

  return colors.map((color, index) => {
    // Un gris (o un color roto) igual necesita un tono propio: el ángulo
    // dorado por posición reparte esos casos sin apelotonarlos.
    const original = colorHue(color) ?? (index * GOLDEN_ANGLE) % TAU;
    const nearest = (hue: number) => taken.reduce((min, other) => Math.min(min, hueDistance(hue, other)), Infinity);

    // Se busca el hueco libre más cercano probando a un lado y al otro, no
    // siempre en la misma dirección: así el tono se corre lo menos posible
    // (un rojo termina en un rojo apagado vecino, no en un verde).
    let hue = original;
    let best = original;
    let bestDistance = nearest(original);
    for (let step = 1; step <= 40 && !free(hue); step += 1) {
      const offset = Math.ceil(step / 2) * MIN_HUE_GAP * 0.4 * (step % 2 === 1 ? 1 : -1);
      hue = (original + offset + TAU) % TAU;
      const distance = nearest(hue);
      if (distance > bestDistance) {
        bestDistance = distance;
        best = hue;
      }
    }
    if (!free(hue)) {
      // Nada libre: se elige lo que más separe, entre el mejor candidato
      // cercano al tono original y el centro del hueco más grande que quede.
      const fallback = widestGap();
      hue = nearest(fallback) > bestDistance ? fallback : best;
    }
    taken.push(hue);
    return hue;
  });
}

// El tono del empleado, con la luminosidad y la croma de la familia.
// Un color ilegible (o gris puro) cae a un neutro del tema, nunca a negro.
export function harmonizeOrbColor(hex: string, theme: OrbTheme): string {
  const hue = colorHue(hex);
  if (hue === null) {
    return toHex(oklabToRgb({ L: ORB_TONE[theme].l, a: 0, b: 0 }));
  }
  return orbColorFromHue(hue, theme);
}

// ── Geometría de la nube ───────────────────────────────────────────────

// Cuántas partículas por esfera según su radio en píxeles CSS. Con 8 esferas
// grandes son ~4.300 puntos por frame, que se dibujan en 4 pasadas (una por
// bucket de profundidad), no en 4.300 llamadas a fill(). La densidad importa:
// con la mitad de puntos la nube se lee como un círculo punteado, no como una
// esfera.
export function particleCount(radius: number) {
  return Math.round(Math.min(720, Math.max(150, radius * 6.2)));
}

export type OrbParticle = {
  // Dirección sobre la esfera unitaria (|u| = 1).
  ux: number;
  uy: number;
  uz: number;
  // Radio propio dentro de la cáscara (0.72..1): le da volumen a la nube.
  rad: number;
  // Desfase del salto, para que las partículas no reboten todas juntas.
  phase: number;
};

// Pseudo-aleatorio determinista y sin estado (la misma esfera se ve igual en
// cada reconstrucción). Tiene que ser un hash con avalancha, no la parte
// fraccionaria de un irracional: esa opción parece aleatoria pero sigue siendo
// una secuencia lineal, y sumada al ángulo dorado dibuja meridianos visibles
// sobre la esfera (se vio: las nubes quedaban como melones).
function hashUnit(index: number, seed: number) {
  let hash = Math.imul((index | 0) ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(Math.round(seed * 1e6) | 0, 0xc2b2ae35);
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x2545f491);
  hash ^= hash >>> 13;
  return (hash >>> 0) / 4294967296;
}

// Distribución de Fibonacci (con temblor): puntos repartidos parejo sobre la
// esfera, sin los polos apelotonados que deja el muestreo por lat/long.
export function sphereParticles(count: number, seed = 0): OrbParticle[] {
  const total = Math.max(1, Math.round(count));
  const particles: OrbParticle[] = [];
  for (let index = 0; index < total; index += 1) {
    // Fibonacci puro dibuja espirales visibles (efecto muaré) sobre la esfera.
    // Un temblor chico en la altura y el ángulo rompe ese patrón y la nube
    // pasa de "malla" a "polvo", sin perder el reparto parejo.
    const uy = 1 - (2 * index + 1 + (hashUnit(index * 5 + 2, seed + 0.11) - 0.5) * 1.1) / total;
    const ring = Math.sqrt(Math.max(0, 1 - uy * uy));
    const theta = index * GOLDEN_ANGLE + seed + (hashUnit(index * 11 + 7, seed + 0.53) - 0.5) * 0.85;
    particles.push({
      ux: Math.cos(theta) * ring,
      uy,
      uz: Math.sin(theta) * ring,
      // Cáscara gruesa (72%..100% del radio): el borde queda definido y el
      // interior semitransparente, que es lo que hace leer una esfera y no un
      // aro de puntos.
      rad: 0.72 + 0.28 * hashUnit(index, seed),
      phase: hashUnit(index * 3 + 1, seed + 0.31) * TAU
    });
  }
  return particles;
}

// Seguimiento de la amplitud: sube rápido (la voz arranca de golpe) y baja
// lento (si bajara igual de rápido, las partículas titilarían con cada
// consonante sorda).
export function followEnergy(current: number, target: number, dt: number) {
  const rate = target > current ? 14 : 4.5;
  const step = Math.min(1, rate * Math.max(0, dt));
  return current + (target - current) * step;
}

// ── Movimiento ─────────────────────────────────────────────────────────
// Reposo: una sala en silencio. La flotación tiene período ~7 s y amplitud
// 6% del radio; la rotación da una vuelta cada ~40 s.
const FLOAT_SPEED = 0.9;
const FLOAT_AMPLITUDE = 0.06;
const DRIFT_SPEED = 0.6;
const DRIFT_AMPLITUDE = 0.022;
const ROTATION_SPEED = 0.155;
const TILT = 0.42;

// Al hablar: las partículas saltan hasta un 20% de su radio y toda la esfera
// hace un zoom de 7%. El techo (1.2 × 1.07 ≈ 1.28) es el que fija el radio
// base contra el hueco reservado en el DOM, así nada se sale de su celda.
const JUMP_AMPLITUDE = 0.2;
const JUMP_SPEED = 6.5;
const ZOOM_AMPLITUDE = 0.07;
const BASE_RADIUS_RATIO = 0.78;

// Opacidad por bucket de profundidad: el fondo de la nube se desvanece y el
// frente queda nítido. Es lo que hace que un círculo plano parezca un volumen.
const DEPTH_ALPHA = [0.34, 0.52, 0.74, 1];
const BUCKETS = DEPTH_ALPHA.length;

// Opacidad general de la esfera: en reposo respira apagada, al hablar se
// asienta. Con prefers-reduced-motion esto es TODO el cambio visible.
const ORB_ALPHA_IDLE = 0.78;
const ORB_ALPHA_SPEAKING = 1;
// Mientras habla alguien, el resto de la sala se corre un paso atrás.
const ORB_FOCUS_DIM = 0.62;

type Orb = {
  id: string;
  sourceColor: string;
  hue: number;
  color: string;
  particles: OrbParticle[];
  // Scratch de proyección: x, y, tamaño por partícula (se reusa cada frame).
  projected: Float32Array;
  bucket: Uint8Array;
  slot: OrbSlot | null;
  phaseFloat: number;
  phaseRot: number;
  energy: number;
  target: number;
  // Cuánto se atenúa la esfera cuando habla OTRO (1 = plena). Es el único
  // cambio visible con prefers-reduced-motion, y en movimiento normal ayuda a
  // que la mirada vaya a quien tiene la palabra.
  focus: number;
};

export type OrbFieldOptions = {
  // Amplitud actual de la voz del agente que habla (0..1).
  energy: () => number;
};

export class OrbField {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private options: OrbFieldOptions;
  private orbs: Orb[] = [];
  private theme: OrbTheme = 'light';
  private speakingId = '';
  private reduced = false;
  private raf = 0;
  private lastAt = 0;
  private clock = 0;
  private dpr = 1;
  private width = 0;
  private height = 0;
  // FPS medido sobre ventanas de ~1 s (para reportar, no para decidir nada).
  private fpsFrames = 0;
  private fpsSince = 0;
  private fpsValue = 0;
  private reducedMedia: MediaQueryList | null = null;

  constructor(canvas: HTMLCanvasElement, options: OrbFieldOptions) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.options = options;
    // El campo vive lo que vive la página, así que este listener no se
    // desengancha nunca (la llamada se abre y se cierra; el canvas es uno solo).
    if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
      this.reducedMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reduced = this.reducedMedia.matches;
      this.reducedMedia.addEventListener('change', this.onReducedChange);
    }
  }

  private onReducedChange = (event: MediaQueryListEvent) => {
    this.reduced = event.matches;
    this.kick();
  };

  get prefersReducedMotion() {
    return this.reduced;
  }

  // Reconstruye las nubes solo si cambió el elenco (id o color): sin esto,
  // cada mensaje del servidor reiniciaría las fases y las esferas pegarían
  // un salto.
  setAgents(agents: OrbAgent[]) {
    const signature = agents.map((agent) => `${agent.id}:${agent.color}`).join('|');
    const current = this.orbs.map((orb) => `${orb.id}:${orb.sourceColor}`).join('|');
    if (signature === current) {
      return;
    }

    const hues = resolveOrbHues(agents.map((agent) => agent.color));
    const previous = new Map(this.orbs.map((orb) => [orb.id, orb]));
    this.orbs = agents.map((agent, index) => {
      const kept = previous.get(agent.id);
      const hue = hues[index];
      if (kept && kept.sourceColor === agent.color && kept.hue === hue) {
        return kept;
      }
      return {
        id: agent.id,
        sourceColor: agent.color,
        hue,
        color: orbColorFromHue(hue, this.theme),
        particles: [],
        projected: new Float32Array(0),
        bucket: new Uint8Array(0),
        slot: null,
        // Cada esfera flota y gira con su propio desfase: nunca laten al unísono.
        phaseFloat: (index * 1.371) % TAU,
        phaseRot: (index * 2.117) % TAU,
        energy: 0,
        target: 0,
        focus: 1
      };
    });
    this.kick();
  }

  // Posiciones medidas en el DOM. Si cambió el radio, se rehace la nube con
  // la densidad que corresponde a ese tamaño.
  setSlots(slots: OrbSlot[]) {
    const byId = new Map(slots.map((slot) => [slot.id, slot]));
    for (const orb of this.orbs) {
      const slot = byId.get(orb.id) || null;
      const changed = !orb.slot || !slot || Math.abs(orb.slot.r - slot.r) > 0.5;
      orb.slot = slot;
      if (slot && (changed || orb.particles.length === 0)) {
        const count = particleCount(slot.r);
        orb.particles = sphereParticles(count, orb.phaseRot);
        orb.projected = new Float32Array(count * 3);
        orb.bucket = new Uint8Array(count);
      }
    }
    this.kick();
  }

  setTheme(theme: OrbTheme) {
    if (this.theme === theme) {
      return;
    }
    this.theme = theme;
    for (const orb of this.orbs) {
      orb.color = orbColorFromHue(orb.hue, theme);
    }
    this.kick();
  }

  setSpeaking(agentId: string) {
    if (this.speakingId === agentId) {
      return;
    }
    this.speakingId = agentId;
    this.kick();
  }

  resize(cssWidth: number, cssHeight: number) {
    const dpr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    const width = Math.max(1, Math.round(cssWidth));
    const height = Math.max(1, Math.round(cssHeight));
    if (this.width === width && this.height === height && this.dpr === dpr) {
      return;
    }
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round(width * dpr);
    this.canvas.height = Math.round(height * dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.ctx?.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.kick();
  }

  start() {
    if (this.raf || !this.ctx || this.orbs.length === 0) {
      return;
    }
    if (typeof document !== 'undefined' && document.hidden) {
      return;
    }
    this.lastAt = performance.now();
    this.fpsFrames = 0;
    this.fpsSince = this.lastAt;
    this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.fpsValue = 0;
  }

  get running() {
    return this.raf !== 0;
  }

  stats() {
    return {
      fps: Math.round(this.fpsValue),
      orbs: this.orbs.length,
      particles: this.orbs.reduce((total, orb) => total + orb.particles.length, 0)
    };
  }

  // Con movimiento reducido el bucle se apaga en cuanto la opacidad llega a
  // destino: no hay nada que animar hasta que alguien hable. Cualquier cambio
  // de estado lo vuelve a encender.
  private kick() {
    if (this.raf || !this.reduced) {
      return;
    }
    this.start();
  }

  private tick = (now: number) => {
    this.raf = 0;
    const ctx = this.ctx;
    if (!ctx) {
      return;
    }

    // dt acotado: si la pestaña estuvo trabada, no queremos un salto.
    const dt = Math.min(0.05, Math.max(0, (now - this.lastAt) / 1000));
    this.lastAt = now;
    this.clock += dt;

    this.fpsFrames += 1;
    if (now - this.fpsSince >= 1000) {
      this.fpsValue = (this.fpsFrames * 1000) / (now - this.fpsSince);
      this.fpsFrames = 0;
      this.fpsSince = now;
    }

    const energy = Math.min(1, Math.max(0, this.options.energy() || 0));
    let animating = false;
    ctx.clearRect(0, 0, this.width, this.height);

    for (const orb of this.orbs) {
      const speaking = orb.id === this.speakingId;
      // Con movimiento reducido la opacidad NO sigue la amplitud: seguir la voz
      // ahí sería un parpadeo, justo lo que hay que evitar. Sube una vez al
      // arrancar el turno y baja al terminarlo.
      orb.target = speaking ? (this.reduced ? 1 : energy) : 0;
      orb.energy = followEnergy(orb.energy, orb.target, dt);
      const focusTarget = !this.speakingId || speaking ? 1 : ORB_FOCUS_DIM;
      orb.focus = followEnergy(orb.focus, focusTarget, dt);
      if (Math.abs(orb.target - orb.energy) > 0.002 || Math.abs(focusTarget - orb.focus) > 0.002) {
        animating = true;
      }
      this.drawOrb(ctx, orb);
    }

    // En movimiento normal el bucle es continuo (flotación + rotación). En
    // reducido solo sigue mientras la opacidad esté viajando.
    if (!this.reduced || animating) {
      this.raf = requestAnimationFrame(this.tick);
    } else {
      this.fpsValue = 0;
    }
  };

  private drawOrb(ctx: CanvasRenderingContext2D, orb: Orb) {
    const slot = orb.slot;
    if (!slot || orb.particles.length === 0) {
      return;
    }

    const energy = orb.energy;
    const reduced = this.reduced;
    const radius = slot.r * BASE_RADIUS_RATIO;
    const zoom = reduced ? 1 : 1 + ZOOM_AMPLITUDE * energy;
    const rotation = reduced ? orb.phaseRot : orb.phaseRot + this.clock * ROTATION_SPEED;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const cosTilt = Math.cos(TILT);
    const sinTilt = Math.sin(TILT);

    const cx = slot.cx + (reduced ? 0 : Math.sin(this.clock * DRIFT_SPEED + orb.phaseFloat * 1.3) * slot.r * DRIFT_AMPLITUDE);
    const cy = slot.cy + (reduced ? 0 : Math.sin(this.clock * FLOAT_SPEED + orb.phaseFloat) * slot.r * FLOAT_AMPLITUDE);
    const dot = Math.min(1.7, Math.max(0.6, slot.r * 0.015));
    const jump = reduced ? 0 : JUMP_AMPLITUDE * energy;
    const jumpClock = this.clock * JUMP_SPEED;

    // Pasada 1: proyección. Una sola vuelta con trigonometría, guardada en
    // los scratch buffers de la esfera.
    const particles = orb.particles;
    const projected = orb.projected;
    const buckets = orb.bucket;
    for (let index = 0; index < particles.length; index += 1) {
      const particle = particles[index];
      // Giro sobre el eje Y (el de la nube), después inclinación sobre X.
      const x = particle.ux * cos + particle.uz * sin;
      const zRot = particle.uz * cos - particle.ux * sin;
      const y = particle.uy * cosTilt - zRot * sinTilt;
      const z = particle.uy * sinTilt + zRot * cosTilt;

      // El radio de CADA partícula late; el conjunto sigue siendo un círculo.
      const wave = jump > 0 ? jump * (0.55 + 0.45 * Math.sin(jumpClock + particle.phase)) : 0;
      const scale = radius * particle.rad * (1 + wave) * zoom;

      const depth = (z + 1) * 0.5;
      const offset = index * 3;
      projected[offset] = cx + x * scale;
      projected[offset + 1] = cy + y * scale;
      projected[offset + 2] = dot * (0.7 + 0.55 * depth);
      buckets[index] = Math.min(BUCKETS - 1, Math.max(0, Math.floor(depth * BUCKETS)));
    }

    // Pasada 2: un fill() por bucket de profundidad. Cuatro llamadas por
    // esfera en vez de una por partícula.
    const orbAlpha = (ORB_ALPHA_IDLE + (ORB_ALPHA_SPEAKING - ORB_ALPHA_IDLE) * energy) * orb.focus;
    ctx.fillStyle = orb.color;
    for (let bucket = 0; bucket < BUCKETS; bucket += 1) {
      ctx.beginPath();
      let drawn = false;
      for (let index = 0; index < particles.length; index += 1) {
        if (buckets[index] !== bucket) {
          continue;
        }
        const offset = index * 3;
        const size = projected[offset + 2];
        ctx.moveTo(projected[offset] + size, projected[offset + 1]);
        ctx.arc(projected[offset], projected[offset + 1], size, 0, TAU);
        drawn = true;
      }
      if (drawn) {
        ctx.globalAlpha = DEPTH_ALPHA[bucket] * orbAlpha;
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }
}
