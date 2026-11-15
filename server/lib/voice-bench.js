/**
 * Voice conversation benchmark harness (T7).
 *
 * Runs the same scripted scenario across variants and collects per-turn
 * timings (TTFB, end-to-end). Pure/stateless helpers plus an orchestrator that
 * accepts injected runners so tests can be fully deterministic with mocks.
 */

/** @typedef {{ id?: string, text: string, [k: string]: any }} ScenarioTurn */
/** @typedef {{ name: string, turns: ScenarioTurn[], [k: string]: any }} Scenario */
/** @typedef {{ variant: string, turn: number, run: number, ttfbMs: number, e2eMs: number, flags?: Record<string, any>, error?: string }} TimingSample */

/**
 * @param {number[]} values
 * @param {number} p percentile in [0,100]
 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return NaN;
  const pct = Number(p);
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
    throw new RangeError(`percentile p must be in [0,100], got ${p}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  if (pct === 0) return sorted[0];
  if (pct === 100) return sorted[sorted.length - 1];
  // Nearest-rank-ish linear interpolation (common for perf reports).
  const rank = (pct / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  const t = rank - lo;
  return sorted[lo] + (sorted[hi] - sorted[lo]) * t;
}

export function roundMs(ms, digits = 2) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return NaN;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function statBlock(values) {
  const clean = (values || []).filter((v) => Number.isFinite(v));
  if (clean.length === 0) {
    return { count: 0, p50: NaN, p95: NaN, min: NaN, max: NaN, avg: NaN };
  }
  const sum = clean.reduce((a, b) => a + b, 0);
  return {
    count: clean.length,
    p50: percentile(clean, 50),
    p95: percentile(clean, 95),
    min: Math.min(...clean),
    max: Math.max(...clean),
    avg: sum / clean.length,
  };
}

/**
 * @param {TimingSample[]} samples
 * @returns {Record<string, { variant: string, runs: number, turns: number, samples: number, errors: number, ttfb: any, e2e: any }>}
 */
export function summarizeSamples(samples) {
  const byVariant = new Map();
  for (const s of samples || []) {
    const key = String(s?.variant ?? '');
    if (!byVariant.has(key)) byVariant.set(key, []);
    byVariant.get(key).push(s);
  }
  /** @type {Record<string, any>} */
  const out = {};
  for (const [variant, list] of byVariant.entries()) {
    const ok = list.filter((s) => !s.error);
    const runs = new Set(list.map((s) => s.run)).size;
    const turns = new Set(list.map((s) => s.turn)).size;
    out[variant] = {
      variant,
      runs,
      turns,
      samples: list.length,
      errors: list.filter((s) => s.error).length,
      ttfb: statBlock(ok.map((s) => s.ttfbMs)),
      e2e: statBlock(ok.map((s) => s.e2eMs)),
    };
  }
  return out;
}

function fmt(n) {
  if (!Number.isFinite(n)) return '-';
  return String(roundMs(n, 2));
}

function fmtBlock(block) {
  return `p50=${fmt(block.p50)} p95=${fmt(block.p95)} min=${fmt(block.min)} max=${fmt(block.max)} avg=${fmt(block.avg)}`;
}

/**
 * @param {{
 *   scenario?: Scenario,
 *   variants?: Array<{name:string, flags?:Record<string,any>}|string>,
 *   summaries?: Record<string, any>,
 *   samples?: TimingSample[],
 *   meta?: Record<string, any>,
 *   title?: string
 * }} opts
 */
export function formatMarkdownReport(opts = {}) {
  const {
    scenario = { name: 'scenario', turns: [] },
    variants = [],
    summaries = {},
    samples = [],
    meta = {},
    title = 'Voice Conversation Benchmark',
  } = opts;
  const lines = [];
  const generatedAt = meta.generatedAt || new Date().toISOString();
  lines.push(`# ${title}`);
  lines.push('');
  lines.push(`- Generated: ${generatedAt}`);
  lines.push(`- Scenario: ${scenario.name || 'unnamed'} (${(scenario.turns || []).length} turns)`);
  if (meta.runs != null) lines.push(`- Runs: ${meta.runs}`);
  if (meta.notes) lines.push(`- Notes: ${meta.notes}`);
  lines.push('');

  lines.push('## Variants');
  lines.push('');
  if (!variants.length) {
    lines.push('_None_');
  } else {
    for (const v of variants) {
      const name = typeof v === 'string' ? v : v?.name;
      const flags = typeof v === 'string' ? null : v?.flags;
      const flagText = flags && Object.keys(flags).length ? ` flags=${JSON.stringify(flags)}` : '';
      lines.push(`- **${name}**${flagText}`);
    }
  }
  lines.push('');

  lines.push('## Summary (ms)');
  lines.push('');
  lines.push('| Variant | Samples | Errors | TTFB p50 | TTFB p95 | E2E p50 | E2E p95 |');
  lines.push('|---|---:|---:|---:|---:|---:|---:|');
  const keys = Object.keys(summaries || {});
  if (!keys.length) {
    lines.push('| _none_ | 0 | 0 | - | - | - | - |');
  } else {
    for (const key of keys) {
      const s = summaries[key];
      lines.push(
        `| ${s.variant} | ${s.samples} | ${s.errors} | ${fmt(s.ttfb.p50)} | ${fmt(s.ttfb.p95)} | ${fmt(s.e2e.p50)} | ${fmt(s.e2e.p95)} |`
      );
    }
  }
  lines.push('');

  lines.push('## Details');
  lines.push('');
  for (const key of keys) {
    const s = summaries[key];
    lines.push(`### ${s.variant}`);
    lines.push('');
    lines.push(`- Runs: ${s.runs}, Turns: ${s.turns}, Samples: ${s.samples}, Errors: ${s.errors}`);
    lines.push(`- TTFB: ${fmtBlock(s.ttfb)}`);
    lines.push(`- E2E: ${fmtBlock(s.e2e)}`);
    lines.push('');
  }

  if (samples && samples.length) {
    lines.push('## Samples');
    lines.push('');
    lines.push('| Variant | Run | Turn | TTFB ms | E2E ms | Error |');
    lines.push('|---|---:|---:|---:|---:|---|');
    for (const s of samples) {
      lines.push(
        `| ${s.variant} | ${s.run} | ${s.turn} | ${fmt(s.ttfbMs)} | ${fmt(s.e2eMs)} | ${s.error || ''} |`
      );
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Normalize a variant spec into { name, flags, runTurn, runScenario }.
 * @param {any} v
 */
function normalizeVariant(v) {
  if (!v) throw new Error('variant is required');
  if (typeof v === 'string') return { name: v, flags: {} };
  if (!v.name) throw new Error('variant.name is required');
  return {
    name: String(v.name),
    flags: v.flags && typeof v.flags === 'object' ? { ...v.flags } : {},
    ttsEngine: v.ttsEngine,
    sentenceStream: v.sentenceStream,
    runTurn: typeof v.runTurn === 'function' ? v.runTurn : null,
    runScenario: typeof v.runScenario === 'function' ? v.runScenario : null,
  };
}

/**
 * Default per-turn runner for mock/deterministic variants.
 * Produces timings from variant flags so comparisons are possible without real audio.
 * If `baseTimings` provided it is used directly.
 */
export function mockRunTurn({ turn, turnIndex, run, variant }) {
  const base = variant?.baseTimings;
  if (base) {
    const t = typeof base === 'function' ? base({ turn, turnIndex, run, variant }) : base;
    return {
      ttfbMs: Number(t.ttfbMs),
      e2eMs: Number(t.e2eMs),
    };
  }
  const flags = variant?.flags || {};
  const engine = flags.ttsEngine || variant?.ttsEngine || 'edge';
  const sentenceStream = !!(flags.sentenceStream ?? variant?.sentenceStream);
  const text = String(turn?.text || '');
  // Deterministic synthetic model: edge a bit slower TTFB than piper, sentence-stream lowers TTFB.
  const engineTtfb = engine === 'piper' ? 120 : engine === 'supertonic' ? 180 : 220;
  const engineChunk = engine === 'piper' ? 18 : engine === 'supertonic' ? 22 : 28;
  const streamBonus = sentenceStream ? 0.55 : 1;
  const len = Math.max(1, text.length || 20);
  const ttfbMs = Math.round((engineTtfb * streamBonus + (turnIndex * 3) + (run * 2)) * 100) / 100;
  const e2eMs = Math.round((ttfbMs + len * engineChunk * (sentenceStream ? 0.75 : 1)) * 100) / 100;
  return { ttfbMs, e2eMs };
}

/**
 * @param {{
 *   scenario: Scenario,
 *   variants: any[],
 *   runs?: number,
 *   runTurn?: (ctx:any)=>Promise<any>|any,
 *   onSample?: (s:TimingSample)=>void,
 * }} opts
 */
export async function runVoiceBench(opts = {}) {
  const {
    scenario,
    variants = [],
    runs = 1,
    runTurn,
    onSample,
  } = opts;
  if (!scenario || !Array.isArray(scenario.turns)) {
    throw new Error('scenario with turns[] is required');
  }
  if (!Array.isArray(variants) || variants.length === 0) {
    throw new Error('variants[] is required');
  }
  const runCount = Math.max(1, Number(runs) || 1);
  /** @type {TimingSample[]} */
  const samples = [];

  for (const rawVariant of variants) {
    const variant = normalizeVariant(rawVariant);
    for (let run = 1; run <= runCount; run++) {
      if (variant.runScenario) {
        const out = await variant.runScenario({ scenario, run, variant });
        const arr = Array.isArray(out) ? out : (out?.samples || []);
        for (let i = 0; i < arr.length; i++) {
          const s = arr[i] || {};
          const sample = {
            variant: variant.name,
            run,
            turn: Number.isFinite(s.turn) ? s.turn : (i + 1),
            ttfbMs: Number(s.ttfbMs),
            e2eMs: Number(s.e2eMs),
            flags: { ...variant.flags },
          };
          if (s.error) sample.error = String(s.error);
          samples.push(sample);
          onSample?.(sample);
        }
        continue;
      }

      for (let turnIndex = 0; turnIndex < scenario.turns.length; turnIndex++) {
        const turn = scenario.turns[turnIndex];
        const ctx = { scenario, turn, turnIndex, run, variant, turnNumber: turnIndex + 1 };
        const exec = variant.runTurn || runTurn || mockRunTurn;
        try {
          const r = await exec(ctx);
          const sample = {
            variant: variant.name,
            run,
            turn: turnIndex + 1,
            ttfbMs: Number(r?.ttfbMs),
            e2eMs: Number(r?.e2eMs),
            flags: { ...variant.flags },
          };
          samples.push(sample);
          onSample?.(sample);
        } catch (err) {
          const sample = {
            variant: variant.name,
            run,
            turn: turnIndex + 1,
            ttfbMs: NaN,
            e2eMs: NaN,
            flags: { ...variant.flags },
            error: err?.message || String(err),
          };
          samples.push(sample);
          onSample?.(sample);
        }
      }
    }
  }

  const summaries = summarizeSamples(samples);
  return { scenario, variants: variants.map(normalizeVariant), samples, summaries };
}

/**
 * Convenience: run + format markdown.
 */
export async function runVoiceBenchReport(opts = {}) {
  const result = await runVoiceBench(opts);
  const report = formatMarkdownReport({
    scenario: result.scenario,
    variants: result.variants,
    summaries: result.summaries,
    samples: opts.includeSamples ? result.samples : [],
    meta: { ...(opts.meta || {}), runs: opts.runs ?? 1 },
    title: opts.title,
  });
  return { ...result, report };
}

export const defaultScenario = {
  name: 'short-greeting',
  turns: [
    { id: 't1', text: 'Hola, ¿cómo estás?' },
    { id: 't2', text: 'Contame en una frase qué podés hacer.' },
    { id: 't3', text: 'Perfecto, gracias.' },
  ],
};

export const defaultVariants = [
  { name: 'edge/no-sentence-stream', flags: { ttsEngine: 'edge', sentenceStream: false } },
  { name: 'edge/sentence-stream', flags: { ttsEngine: 'edge', sentenceStream: true } },
  { name: 'piper/no-sentence-stream', flags: { ttsEngine: 'piper', sentenceStream: false } },
  { name: 'piper/sentence-stream', flags: { ttsEngine: 'piper', sentenceStream: true } },
];
