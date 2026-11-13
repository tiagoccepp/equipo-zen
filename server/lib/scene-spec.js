// SceneSpec v1 — a compact, versioned, declarative 3D scene authored by an
// agent and rendered by the app (src/stage). Spec-first on purpose: the model
// never ships JavaScript; it ships data that the renderer interprets.
//
// Shape (all lengths in meters, Y is up):
//
//   {
//     version: 1,
//     title: string,
//     subtitle?: string,
//     units: 'm',
//     background?: 'dark',
//     camera: { position: [x, y, z], target: [x, y, z], fov?: 20..100 },
//     parts: [{
//       id: string,                    // unique, [A-Za-z0-9._:-], <= 64 chars
//       label?: string,                // rendered as an HTML pill over the part
//       kind: 'box' | 'cylinder' | 'sphere' | 'cone' | 'torus' | 'plane' | 'tube' | 'group',
//       size?: [x, y, z],              // box/plane (plane uses x,y)
//       radius?: number,               // cylinder/sphere/cone/tube (torus: major)
//       height?: number,               // cylinder/cone/tube (torus: tube thickness)
//       radialSegments?: number,       // 8..64, round parts
//       position: [x, y, z],           // local to parent
//       rotation?: [x, y, z],          // radians
//       color: '#rrggbb',
//       metalness?: 0..1,
//       roughness?: 0..1,
//       opacity?: 0..1,
//       explode?: [x, y, z],           // offset (m) reached at explode factor 1
//       parent?: id                    // child transform follows the parent
//     }],
//     steps?: [{
//       id: string, title: string, body: string,
//       highlight?: string[],          // part ids; everything else dims
//       explode?: 0..3,                // global explosion factor for the step
//       camera?: { position, target, fov? },
//       duration?: 400..60000          // ms the step stays on screen
//     }],
//     legend?: [{ color: '#rrggbb', label: string }]
//   }
//
// Rules that keep scenes readable at a glance:
// - 1..200 parts; small scenes (10..60) explain better than dense ones.
// - ids are referenced by steps and parents, so they must be stable and unique.
// - `explode` is authored per part, not derived: the agent decides what moves
//   where, which is what makes the disassembly legible.
// - Only `dark` background exists in v1; the renderer is a dark studio.
//
// Validation policy: repair what is unambiguous (missing defaults, numeric
// strings, out-of-range clamps) and hard-fail what changes the author's intent
// (unknown kind, bad color, duplicate ids, dangling parent/highlight refs,
// non-finite numbers). The agent gets `errors` back and can fix the call.

export const SCENE_SPEC_VERSION = 1;
export const SCENE_MAX_PARTS = 200;
export const SCENE_MAX_STEPS = 24;
export const SCENE_MAX_LEGEND = 12;
export const SCENE_MAX_EXTENT = 200;

export const PART_KINDS = Object.freeze([
  'box',
  'cylinder',
  'sphere',
  'cone',
  'torus',
  'plane',
  'tube',
  'group'
]);

const PART_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const DEFAULT_COLOR = '#8d949c';
const DEFAULT_CAMERA_FOV = 40;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function trimText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Number with clamp. Non-finite values are hard errors: NaN silently becoming
// 0 is how a scene ends up with everything stacked at the origin.
function numberField(value, path, ctx, { min, max, def, label = '' }) {
  if (value === undefined || value === null) {
    return def;
  }
  let n = value;
  if (typeof n === 'string' && n.trim() !== '') {
    n = Number(n);
    if (Number.isFinite(n)) {
      ctx.warnings.push(`${path}: numeric string coerced to number`);
    }
  }
  if (typeof n !== 'number' || !Number.isFinite(n)) {
    ctx.errors.push(`${path}: must be a finite number`);
    return def;
  }
  if (n < min || n > max) {
    const clamped = Math.min(max, Math.max(min, n));
    ctx.warnings.push(`${path}: ${n} clamped to ${clamped}${label ? ` (${label})` : ''}`);
    return clamped;
  }
  return n;
}

function vec3Field(value, path, ctx, { def = [0, 0, 0], min = -SCENE_MAX_EXTENT, max = SCENE_MAX_EXTENT } = {}) {
  if (value === undefined || value === null) {
    return [...def];
  }
  if (!Array.isArray(value) || value.length !== 3) {
    ctx.errors.push(`${path}: must be an array [x, y, z]`);
    return [...def];
  }
  return [0, 1, 2].map((i) => numberField(value[i], `${path}[${i}]`, ctx, { min, max, def: def[i] }));
}

function colorField(value, path, ctx, def = DEFAULT_COLOR) {
  if (value === undefined || value === null) {
    ctx.warnings.push(`${path}: missing color, using ${def}`);
    return def;
  }
  if (typeof value !== 'string' || !HEX_RE.test(value.trim())) {
    ctx.errors.push(`${path}: color must be a hex string like #5fb49c`);
    return def;
  }
  let hex = value.trim().toLowerCase();
  if (hex.length === 4) {
    hex = `#${hex[1]}${hex[1]}${hex[2]}${hex[2]}${hex[3]}${hex[3]}`;
  }
  return hex;
}

function textField(value, path, ctx, { max, def = '', required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) {
      ctx.errors.push(`${path}: required text`);
    }
    return def;
  }
  if (typeof value !== 'string') {
    ctx.errors.push(`${path}: must be a string`);
    return def;
  }
  const text = trimText(value, max);
  if (required && !text) {
    ctx.errors.push(`${path}: cannot be empty`);
  }
  return text;
}

function idField(value, path, ctx) {
  if (typeof value !== 'string' || !PART_ID_RE.test(value.trim())) {
    ctx.errors.push(`${path}: id must match [A-Za-z0-9][A-Za-z0-9._:-]{0,63}`);
    return '';
  }
  return value.trim();
}

// Approximate world bounds from the declared extents. Only used to derive a
// camera when the author did not provide one (renderer does the exact framing).
function estimateBounds(parts) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const part of parts) {
    const reach = [0, 0, 0];
    if (part.kind === 'box' && part.size) {
      reach[0] = part.size[0] / 2;
      reach[1] = part.size[1] / 2;
      reach[2] = part.size[2] / 2;
    } else if (part.kind === 'plane' && part.size) {
      reach[0] = part.size[0] / 2;
      reach[1] = part.size[1] / 2;
    } else if (part.radius) {
      reach[0] = part.radius;
      reach[1] = Math.max(part.radius, (part.height || 0) / 2);
      reach[2] = part.radius;
    }
    for (let i = 0; i < 3; i += 1) {
      min[i] = Math.min(min[i], part.position[i] - reach[i]);
      max[i] = Math.max(max[i], part.position[i] + reach[i]);
    }
  }
  if (!Number.isFinite(min[0])) {
    return { center: [0, 0, 0], size: [1, 1, 1], diagonal: 1 };
  }
  const size = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const diagonal = Math.hypot(size[0], size[1], size[2]) || 1;
  return {
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size,
    diagonal
  };
}

function cameraField(value, path, ctx, fallback) {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isPlainObject(value)) {
    ctx.errors.push(`${path}: must be an object { position, target, fov }`);
    return null;
  }
  return {
    position: vec3Field(value.position, `${path}.position`, ctx, { def: fallback.position }),
    target: vec3Field(value.target, `${path}.target`, ctx, { def: fallback.target }),
    fov: numberField(value.fov, `${path}.fov`, ctx, { min: 20, max: 100, def: DEFAULT_CAMERA_FOV })
  };
}

function normalizePart(input, index, ctx) {
  const path = `parts[${index}]`;
  if (!isPlainObject(input)) {
    ctx.errors.push(`${path}: must be an object`);
    return null;
  }
  const kind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : '';
  if (!PART_KINDS.includes(kind)) {
    ctx.errors.push(`${path}.kind: unknown kind "${input.kind ?? ''}" (valid: ${PART_KINDS.join(', ')})`);
    return null;
  }
  const id = idField(input.id, `${path}.id`, ctx);
  if (!id) {
    return null;
  }

  const part = {
    id,
    kind,
    position: vec3Field(input.position, `${path}.position`, ctx),
    rotation: vec3Field(input.rotation, `${path}.rotation`, ctx, { min: -100, max: 100 }),
    color: colorField(input.color, `${path}.color`, ctx),
    metalness: numberField(input.metalness, `${path}.metalness`, ctx, { min: 0, max: 1, def: 0.35 }),
    roughness: numberField(input.roughness, `${path}.roughness`, ctx, { min: 0, max: 1, def: 0.55 }),
    opacity: numberField(input.opacity, `${path}.opacity`, ctx, { min: 0.05, max: 1, def: 1 }),
    explode: vec3Field(input.explode, `${path}.explode`, ctx, { min: -20, max: 20 })
  };

  const label = textField(input.label, `${path}.label`, ctx, { max: 80 });
  if (label) {
    part.label = label;
  }

  if (kind === 'box') {
    const size = vec3Field(input.size, `${path}.size`, ctx, { def: [0.2, 0.2, 0.2], min: 0.001, max: 50 });
    part.size = size;
  } else if (kind === 'plane') {
    const size = vec3Field(input.size, `${path}.size`, ctx, { def: [0.4, 0.4, 0.001], min: 0.001, max: 50 });
    part.size = size;
  } else if (kind === 'group') {
    // Pure transform node: no geometry, children inherit its transform.
  } else {
    part.radius = numberField(input.radius, `${path}.radius`, ctx, { min: 0.001, max: 50, def: 0.12 });
    const heightDef = kind === 'sphere' ? 0.24 : kind === 'torus' ? part.radius * 0.3 : 0.24;
    part.height = numberField(input.height, `${path}.height`, ctx, { min: 0.001, max: 50, def: heightDef });
    part.radialSegments = Math.round(
      numberField(input.radialSegments, `${path}.radialSegments`, ctx, { min: 8, max: 64, def: 24 })
    );
  }

  if (input.parent !== undefined && input.parent !== null) {
    if (typeof input.parent !== 'string' || !input.parent.trim()) {
      ctx.errors.push(`${path}.parent: must be a part id`);
    } else {
      part.parent = input.parent.trim();
    }
  }

  return part;
}

function normalizeStep(input, index, ctx, fallbackCamera) {
  const path = `steps[${index}]`;
  if (!isPlainObject(input)) {
    ctx.errors.push(`${path}: must be an object`);
    return null;
  }
  const title = textField(input.title, `${path}.title`, ctx, { max: 120, required: true });
  const step = {
    id: textField(input.id, `${path}.id`, ctx, { max: 64, def: `step-${index + 1}` }),
    title,
    body: textField(input.body, `${path}.body`, ctx, { max: 600 })
  };
  if (!PART_ID_RE.test(step.id) && !/^step-\d+$/.test(step.id)) {
    ctx.errors.push(`${path}.id: must match [A-Za-z0-9][A-Za-z0-9._:-]{0,63}`);
  }

  if (input.highlight !== undefined && input.highlight !== null) {
    if (!Array.isArray(input.highlight)) {
      ctx.errors.push(`${path}.highlight: must be an array of part ids`);
    } else {
      const seen = new Set();
      const ids = [];
      for (const raw of input.highlight) {
        if (typeof raw !== 'string' || !raw.trim()) {
          ctx.errors.push(`${path}.highlight: every entry must be a part id`);
          continue;
        }
        const id = raw.trim();
        if (!seen.has(id)) {
          seen.add(id);
          ids.push(id);
        }
      }
      step.highlight = ids;
    }
  }

  const explode = numberField(input.explode, `${path}.explode`, ctx, { min: 0, max: 3, def: 0 });
  step.explode = explode;
  step.camera = cameraField(input.camera, `${path}.camera`, ctx, fallbackCamera) || undefined;
  step.duration = Math.round(
    numberField(input.duration, `${path}.duration`, ctx, { min: 400, max: 60000, def: 4200 })
  );
  return step;
}

/**
 * Coerce a raw scene into canonical SceneSpec form. Repairs defaults and
 * out-of-range numbers; records hard errors for anything ambiguous.
 * @returns {{ spec: object|null, errors: string[], warnings: string[] }}
 */
export function normalizeSceneSpec(input) {
  const ctx = { errors: [], warnings: [] };
  if (!isPlainObject(input)) {
    return { spec: null, errors: ['scene: root must be an object'], warnings: [] };
  }

  // Version is authored by the model, so it is read before any clamp: an
  // unknown version is a hard error, never silently downgraded to v1.
  let version = SCENE_SPEC_VERSION;
  if (input.version !== undefined && input.version !== null) {
    version = numberField(input.version, 'version', ctx, { min: 1, max: 1000, def: SCENE_SPEC_VERSION });
    if (version !== SCENE_SPEC_VERSION) {
      ctx.errors.push(`version: unsupported version ${version} (this build reads v${SCENE_SPEC_VERSION})`);
    }
  }

  const title = textField(input.title, 'title', ctx, { max: 120, required: true });
  const subtitle = textField(input.subtitle, 'subtitle', ctx, { max: 200 });

  if (input.units !== undefined && input.units !== null && input.units !== 'm') {
    ctx.errors.push('units: only "m" (meters) is supported in v1');
  }
  if (input.background !== undefined && input.background !== null && input.background !== 'dark') {
    ctx.warnings.push('background: only "dark" exists in v1, using "dark"');
  }

  if (!Array.isArray(input.parts) || input.parts.length === 0) {
    ctx.errors.push('parts: must be a non-empty array');
    return { spec: null, errors: ctx.errors, warnings: ctx.warnings };
  }
  if (input.parts.length > SCENE_MAX_PARTS) {
    ctx.errors.push(`parts: ${input.parts.length} parts exceeds the limit of ${SCENE_MAX_PARTS}`);
    return { spec: null, errors: ctx.errors, warnings: ctx.warnings };
  }

  const parts = [];
  const partIds = new Set();
  for (let i = 0; i < input.parts.length; i += 1) {
    const part = normalizePart(input.parts[i], i, ctx);
    if (!part) {
      continue;
    }
    if (partIds.has(part.id)) {
      ctx.errors.push(`parts[${i}].id: duplicate id "${part.id}"`);
      continue;
    }
    partIds.add(part.id);
    parts.push(part);
  }

  if (parts.length === 0) {
    ctx.errors.push('parts: no valid part');
    return { spec: null, errors: ctx.errors, warnings: ctx.warnings };
  }

  // Parent refs must resolve and the graph must be acyclic (a cycle would make
  // the renderer's hierarchy build recurse forever).
  for (const part of parts) {
    if (!part.parent) {
      continue;
    }
    if (!partIds.has(part.parent)) {
      ctx.errors.push(`parts.${part.id}.parent: unknown part "${part.parent}"`);
    } else if (part.parent === part.id) {
      ctx.errors.push(`parts.${part.id}.parent: a part cannot parent itself`);
    }
  }
  const byId = new Map(parts.map((part) => [part.id, part]));
  for (const part of parts) {
    let cursor = part.parent ? byId.get(part.parent) : null;
    let hops = 0;
    while (cursor && hops < parts.length + 1) {
      if (cursor.id === part.id) {
        ctx.errors.push(`parts.${part.id}.parent: parent chain has a cycle`);
        break;
      }
      cursor = cursor.parent ? byId.get(cursor.parent) : null;
      hops += 1;
    }
  }

  const bounds = estimateBounds(parts);
  const fallbackCamera = {
    position: [
      Number((bounds.center[0] + bounds.diagonal * 0.62).toFixed(4)),
      Number((bounds.center[1] + bounds.diagonal * 0.42).toFixed(4)),
      Number((bounds.center[2] + bounds.diagonal * 0.72).toFixed(4))
    ],
    target: [
      Number(bounds.center[0].toFixed(4)),
      Number(bounds.center[1].toFixed(4)),
      Number(bounds.center[2].toFixed(4))
    ],
    fov: DEFAULT_CAMERA_FOV
  };
  const camera = cameraField(input.camera, 'camera', ctx, fallbackCamera) || fallbackCamera;

  const steps = [];
  const stepIds = new Set();
  if (input.steps !== undefined && input.steps !== null) {
    if (!Array.isArray(input.steps)) {
      ctx.errors.push('steps: must be an array');
    } else if (input.steps.length > SCENE_MAX_STEPS) {
      ctx.errors.push(`steps: ${input.steps.length} steps exceeds the limit of ${SCENE_MAX_STEPS}`);
    } else {
      for (let i = 0; i < input.steps.length; i += 1) {
        const step = normalizeStep(input.steps[i], i, ctx, camera);
        if (!step) {
          continue;
        }
        if (stepIds.has(step.id)) {
          ctx.errors.push(`steps[${i}].id: duplicate id "${step.id}"`);
          continue;
        }
        stepIds.add(step.id);
        for (const id of step.highlight || []) {
          if (!partIds.has(id)) {
            ctx.errors.push(`steps[${i}].highlight: unknown part id "${id}"`);
          }
        }
        steps.push(step);
      }
    }
  }

  const legend = [];
  if (input.legend !== undefined && input.legend !== null) {
    if (!Array.isArray(input.legend)) {
      ctx.errors.push('legend: must be an array');
    } else if (input.legend.length > SCENE_MAX_LEGEND) {
      ctx.warnings.push(`legend: keeping the first ${SCENE_MAX_LEGEND} entries`);
    }
    const items = Array.isArray(input.legend) ? input.legend.slice(0, SCENE_MAX_LEGEND) : [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (!isPlainObject(item)) {
        ctx.warnings.push(`legend[${i}]: ignored, must be an object`);
        continue;
      }
      const label = textField(item.label, `legend[${i}].label`, ctx, { max: 60 });
      if (!label) {
        ctx.warnings.push(`legend[${i}]: ignored, missing label`);
        continue;
      }
      legend.push({ color: colorField(item.color, `legend[${i}].color`, ctx), label });
    }
  }

  const spec = {
    version: SCENE_SPEC_VERSION,
    title,
    subtitle,
    units: 'm',
    background: 'dark',
    camera,
    parts,
    steps,
    legend
  };
  if (!subtitle) {
    delete spec.subtitle;
  }

  return { spec, errors: ctx.errors, warnings: ctx.warnings };
}

/**
 * Validate a raw scene. `spec` is null when hard errors exist, so callers can
 * publish only scenes the renderer will accept.
 * @returns {{ ok: boolean, errors: string[], warnings: string[], spec: object|null }}
 */
export function validateSceneSpec(input) {
  const { spec, errors, warnings } = normalizeSceneSpec(input);
  const ok = errors.length === 0 && Boolean(spec);
  return { ok, errors, warnings, spec: ok ? spec : null };
}

const VEC3_SCHEMA = {
  type: 'array',
  minItems: 3,
  maxItems: 3,
  items: { type: 'number' }
};

const CAMERA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['position', 'target'],
  properties: {
    position: VEC3_SCHEMA,
    target: VEC3_SCHEMA,
    fov: { type: 'number', minimum: 20, maximum: 100 }
  }
};

const PART_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'position', 'color'],
  properties: {
    id: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$' },
    label: { type: 'string', maxLength: 80 },
    kind: { type: 'string', enum: [...PART_KINDS] },
    size: VEC3_SCHEMA,
    radius: { type: 'number', minimum: 0.001, maximum: 50 },
    height: { type: 'number', minimum: 0.001, maximum: 50 },
    radialSegments: { type: 'integer', minimum: 8, maximum: 64 },
    position: VEC3_SCHEMA,
    rotation: VEC3_SCHEMA,
    color: { type: 'string', pattern: '^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' },
    metalness: { type: 'number', minimum: 0, maximum: 1 },
    roughness: { type: 'number', minimum: 0, maximum: 1 },
    opacity: { type: 'number', minimum: 0.05, maximum: 1 },
    explode: VEC3_SCHEMA,
    parent: { type: 'string' }
  }
};

const STEP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'body'],
  properties: {
    id: { type: 'string', maxLength: 64 },
    title: { type: 'string', maxLength: 120 },
    body: { type: 'string', maxLength: 600 },
    highlight: { type: 'array', maxItems: 64, items: { type: 'string' } },
    explode: { type: 'number', minimum: 0, maximum: 3 },
    camera: CAMERA_SCHEMA,
    duration: { type: 'integer', minimum: 400, maximum: 60000 }
  }
};

/**
 * LLM tool descriptor. The description is part of the prompt budget, so it
 * states the authoring rules in one compact block instead of prose.
 */
export const sceneRenderTool = {
  name: 'scene_render',
  description: [
    'Render an interactive 3D scene in the user panel, from data (never code).',
    'Use it when explaining something spatial: a machine, an assembly, a molecule, a layout.',
    'The app shows the scene live with an explode slider, part labels and your step timeline.',
    'Authoring rules: meters, Y up, 1..200 parts (40..70 reads best); unique ids;',
    'color #rrggbb; positions/rotations are local to the parent part; rotation in radians.',
    'kind one of: box (size [x,y,z]), cylinder/cone/tube (radius, height), sphere (radius),',
    'torus (radius = ring, height = tube), plane (size [x,y]), group (transform only).',
    'explode is the offset in meters that part travels at explode 1: the disassembly direction.',
    'label is a short name shown as a pill (label the 15..35 parts worth naming).',
    'steps (3..6) each set explode 0..1, highlight = part ids to keep lit, body = one or two',
    'sentences explaining that subsystem, and an optional camera. Call it once with the full',
    'scene; do not send partial updates.'
  ].join(' '),
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['version', 'title', 'parts'],
    properties: {
      version: { type: 'number', enum: [SCENE_SPEC_VERSION] },
      title: { type: 'string', maxLength: 120 },
      subtitle: { type: 'string', maxLength: 200 },
      units: { type: 'string', enum: ['m'] },
      background: { type: 'string', enum: ['dark'] },
      camera: CAMERA_SCHEMA,
      parts: {
        type: 'array',
        minItems: 1,
        maxItems: SCENE_MAX_PARTS,
        items: PART_SCHEMA
      },
      steps: {
        type: 'array',
        maxItems: SCENE_MAX_STEPS,
        items: STEP_SCHEMA
      },
      legend: {
        type: 'array',
        maxItems: SCENE_MAX_LEGEND,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['color', 'label'],
          properties: {
            color: { type: 'string', pattern: '^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$' },
            label: { type: 'string', maxLength: 60 }
          }
        }
      }
    }
  }
};

/**
 * Complete demo scene: a 60-degree V6 engine, authored exactly the way the
 * agent is told to author one. Doubles as the renderer's smoke test.
 * The frontend mirror lives in src/stage/demo-spec.ts (no server imports in
 * the browser bundle).
 */
export function sceneDemo() {
  const rad = (deg) => (deg * Math.PI) / 180;
  const bank = rad(30);
  const cos = Math.cos(bank);
  const sin = Math.sin(bank);
  const halfPi = Math.PI / 2;
  const parts = [];
  const add = (part) => {
    parts.push(part);
    return part;
  };

  // Shop floor: grounds the model, gives the eye a horizon.
  add({
    id: 'floor',
    kind: 'plane',
    size: [2.4, 2.4, 0.001],
    position: [0, -0.62, 0],
    rotation: [-halfPi, 0, 0],
    color: '#14181d',
    metalness: 0,
    roughness: 0.95
  });

  add({
    id: 'block',
    label: 'Cylinder block',
    kind: 'box',
    size: [0.62, 0.30, 0.34],
    position: [0, 0.11, 0],
    color: '#59616b',
    metalness: 0.45,
    roughness: 0.5
  });

  add({
    id: 'crankshaft',
    label: 'Crankshaft',
    kind: 'cylinder',
    radius: 0.03,
    height: 0.66,
    radialSegments: 28,
    position: [0, 0, 0],
    rotation: [0, 0, halfPi],
    color: '#a7b0b9',
    metalness: 0.85,
    roughness: 0.3,
    explode: [0, -0.18, 0]
  });

  add({
    id: 'crank-pulley',
    label: 'Pulley',
    kind: 'cylinder',
    radius: 0.055,
    height: 0.028,
    radialSegments: 28,
    position: [0, 0.35, 0],
    rotation: [0, 0, 0],
    color: '#6c7680',
    metalness: 0.55,
    roughness: 0.45,
    parent: 'crankshaft'
  });

  add({
    id: 'crank-gear',
    kind: 'cylinder',
    radius: 0.05,
    height: 0.022,
    radialSegments: 28,
    position: [0, -0.35, 0],
    rotation: [0, 0, 0],
    color: '#8a949e',
    metalness: 0.6,
    roughness: 0.4,
    parent: 'crankshaft'
  });

  add({
    id: 'trigger-wheel',
    label: 'Trigger wheel',
    kind: 'torus',
    radius: 0.046,
    height: 0.012,
    radialSegments: 32,
    position: [0, 0.29, 0],
    rotation: [halfPi, 0, 0],
    color: '#b0704f',
    metalness: 0.6,
    roughness: 0.4,
    parent: 'crankshaft'
  });

  add({
    id: 'oil-pan',
    label: 'Oil pan',
    kind: 'box',
    size: [0.52, 0.09, 0.28],
    position: [0, -0.075, 0],
    color: '#4a5158',
    metalness: 0.35,
    roughness: 0.65,
    explode: [0, -0.34, 0]
  });

  add({
    id: 'intake-plenum',
    label: 'Intake plenum',
    kind: 'box',
    size: [0.52, 0.07, 0.10],
    position: [0, 0.36, 0],
    color: '#5fb49c',
    metalness: 0.35,
    roughness: 0.45,
    explode: [0, 0.4, 0]
  });

  const boreX = [-0.24, -0.144, -0.048, 0.048, 0.144, 0.24];
  for (let i = 0; i < 6; i += 1) {
    const side = i % 2 === 0 ? 1 : -1;
    const x = boreX[i];
    const n = i + 1;
    // Each bank carries three cylinders: odd numbers +Z, even numbers -Z.
    add({
      id: `bore-${n}`,
      label: `Bore ${n}`,
      kind: 'cylinder',
      radius: 0.055,
      height: 0.185,
      radialSegments: 28,
      position: [x, 0.106, side * 0.061],
      rotation: [side * bank, 0, 0],
      color: '#3f464e',
      metalness: 0.3,
      roughness: 0.7
    });
    add({
      id: `piston-${n}`,
      label: `Piston ${n}`,
      kind: 'cylinder',
      radius: 0.048,
      height: 0.05,
      radialSegments: 28,
      position: [x, 0.121, side * 0.07],
      rotation: [side * bank, 0, 0],
      color: '#c3cad2',
      metalness: 0.75,
      roughness: 0.3,
      explode: [0, 0.2, side * 0.22]
    });
    add({
      id: `rod-${n}`,
      label: `Rod ${n}`,
      kind: 'box',
      size: [0.018, 0.115, 0.012],
      position: [x, 0.067, side * 0.039],
      rotation: [side * bank, 0, 0],
      color: '#9aa4ae',
      metalness: 0.8,
      roughness: 0.35,
      explode: [0, 0.1, side * 0.11]
    });
    add({
      id: `crank-pin-${n}`,
      kind: 'cylinder',
      radius: 0.028,
      height: 0.05,
      radialSegments: 24,
      position: [x, 0.03, side * 0.0175],
      rotation: [0, 0, halfPi],
      color: '#8f99a3',
      metalness: 0.8,
      roughness: 0.35,
      explode: [0, -0.1, 0]
    });
    add({
      id: `runner-${n}`,
      kind: 'cone',
      radius: 0.024,
      height: 0.11,
      radialSegments: 20,
      position: [x, 0.3, side * 0.06],
      rotation: [side * bank, 0, 0],
      color: '#4f9e8a',
      metalness: 0.3,
      roughness: 0.5,
      explode: [0, 0.3, side * 0.12]
    });
    add({
      id: `header-${n}`,
      kind: 'tube',
      radius: 0.017,
      height: 0.11,
      radialSegments: 20,
      position: [x, 0.2, side * 0.19],
      rotation: [side * rad(65), 0, 0],
      color: '#b0704f',
      metalness: 0.65,
      roughness: 0.4,
      explode: [0, 0.16, side * 0.24]
    });
  }

  for (const side of [1, -1]) {
    const tag = side > 0 ? 'r' : 'l';
    add({
      id: `head-${tag}`,
      label: side > 0 ? 'Right head' : 'Left head',
      kind: 'box',
      size: [0.6, 0.09, 0.17],
      position: [0, 0.215, side * 0.124],
      rotation: [side * bank, 0, 0],
      color: '#7d8791',
      metalness: 0.6,
      roughness: 0.42,
      explode: [0, 0.26, side * 0.3]
    });
    add({
      id: `cam-${tag}`,
      label: side > 0 ? 'Right cam' : 'Left cam',
      kind: 'cylinder',
      radius: 0.02,
      height: 0.56,
      radialSegments: 24,
      position: [0, 0.26, side * 0.15],
      rotation: [0, 0, halfPi],
      color: '#b6bec6',
      metalness: 0.85,
      roughness: 0.28,
      explode: [0, 0.34, side * 0.4]
    });
    add({
      id: `cover-${tag}`,
      label: side > 0 ? 'Right cam cover' : 'Left cam cover',
      kind: 'box',
      size: [0.58, 0.055, 0.14],
      position: [0, 0.286, side * 0.165],
      rotation: [side * bank, 0, 0],
      color: '#68727d',
      metalness: 0.5,
      roughness: 0.55,
      explode: [0, 0.4, side * 0.46]
    });
    add({
      id: `collector-${tag}`,
      label: side > 0 ? 'Right collector' : 'Left collector',
      kind: 'tube',
      radius: 0.028,
      height: 0.44,
      radialSegments: 24,
      position: [0, 0.16, side * 0.26],
      rotation: [0, 0, halfPi],
      color: '#9b5f43',
      metalness: 0.65,
      roughness: 0.42,
      explode: [0, 0.1, side * 0.34]
    });
    for (let i = 0; i < 3; i += 1) {
      const n = side > 0 ? i * 2 + 1 : i * 2 + 2;
      const x = boreX[n - 1];
      for (const dx of [-0.024, 0.024]) {
        add({
          id: `valve-${n}-${dx < 0 ? 'a' : 'b'}`,
          label: n === 1 && dx < 0 ? 'Intake valve' : undefined,
          kind: 'cylinder',
          radius: 0.011,
          height: 0.1,
          radialSegments: 16,
          position: [x + dx, 0.234, side * 0.135],
          rotation: [side * (bank + rad(6)), 0, 0],
          color: '#d5dbe0',
          metalness: 0.9,
          roughness: 0.22,
          explode: [0, 0.46, side * 0.54]
        });
      }
    }
  }

  // `undefined` label is dropped by the normalizer, so passing it is safe:
  // only the representative valve gets a pill.
  for (let i = 0; i < parts.length; i += 1) {
    if (parts[i].label === undefined) {
      delete parts[i].label;
    }
  }

  const highlightCylinders = [];
  for (let n = 1; n <= 6; n += 1) {
    highlightCylinders.push(`piston-${n}`, `rod-${n}`, `crank-pin-${n}`, `bore-${n}`);
  }

  const result = validateSceneSpec({
    version: 1,
    title: 'V6 engine, exploded',
    subtitle: 'Sixty-degree V6: block, rotating assembly, valvetrain, intake and exhaust.',
    units: 'm',
    background: 'dark',
    camera: { position: [1.15, 0.62, 1.3], target: [0, 0.1, 0], fov: 38 },
    parts,
    steps: [
      {
        id: 'block',
        title: 'The block holds the geometry',
        body: 'Six bores sit in two banks at sixty degrees. The block fixes the bore spacing, so every other part finds its place from here.',
        highlight: ['block', 'bore-1', 'bore-2', 'bore-3', 'bore-4', 'bore-5', 'bore-6'],
        explode: 0,
        camera: { position: [1.25, 0.5, 1.2], target: [0, 0.12, 0], fov: 38 },
        duration: 5000
      },
      {
        id: 'rotating',
        title: 'Crank, rods and pistons',
        body: 'The crankshaft turns the up-and-down motion of six pistons into rotation. Each rod links one piston to its crank pin.',
        highlight: ['crankshaft', 'crank-pulley', 'crank-gear', 'trigger-wheel', ...highlightCylinders],
        explode: 0.55,
        camera: { position: [1.45, 0.35, 1.45], target: [0, 0.06, 0], fov: 40 },
        duration: 6000
      },
      {
        id: 'valvetrain',
        title: 'Heads and valvetrain',
        body: 'One head per bank carries two valves per cylinder and a camshaft. The cam covers seal the oil; lift them and the whole valvetrain comes with them.',
        highlight: ['head-l', 'head-r', 'cover-l', 'cover-r', 'cam-l', 'cam-r',
          'valve-1-a', 'valve-1-b', 'valve-2-a', 'valve-2-b', 'valve-3-a', 'valve-3-b',
          'valve-4-a', 'valve-4-b', 'valve-5-a', 'valve-5-b', 'valve-6-a', 'valve-6-b'],
        explode: 0.85,
        camera: { position: [1.2, 0.7, 1.3], target: [0, 0.3, 0], fov: 40 },
        duration: 6000
      },
      {
        id: 'circuits',
        title: 'Air in, gas out, oil below',
        body: 'The plenum feeds six runners into the heads. Burnt gas leaves through the headers and collectors. The pan keeps the oil under the crank.',
        highlight: ['intake-plenum', 'runner-1', 'runner-2', 'runner-3', 'runner-4', 'runner-5', 'runner-6',
          'header-1', 'header-2', 'header-3', 'header-4', 'header-5', 'header-6',
          'collector-l', 'collector-r', 'oil-pan'],
        explode: 1,
        camera: { position: [1.5, 0.55, 1.5], target: [0, 0.15, 0], fov: 40 },
        duration: 6000
      }
    ],
    legend: [
      { color: '#59616b', label: 'Structure' },
      { color: '#c3cad2', label: 'Rotating assembly' },
      { color: '#b6bec6', label: 'Valvetrain' },
      { color: '#5fb49c', label: 'Intake' },
      { color: '#b0704f', label: 'Exhaust' }
    ]
  });
  if (!result.ok) {
    // A broken demo is a broken build: fail at the call site, not in the UI.
    throw new Error(`sceneDemo is not a valid scene: ${result.errors.join(' | ')}`);
  }
  return result.spec;
}
