#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  defaultScenario,
  defaultVariants,
  runVoiceBenchReport,
} from '../server/lib/voice-bench.js';

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    runs: 1,
    out: null,
    json: false,
    includeSamples: false,
    scenario: 'default',
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--samples') opts.includeSamples = true;
    else if (a === '--runs') opts.runs = Number(argv[++i] || 1);
    else if (a.startsWith('--runs=')) opts.runs = Number(a.slice('--runs='.length));
    else if (a === '--out') opts.out = argv[++i] || null;
    else if (a.startsWith('--out=')) opts.out = a.slice('--out='.length);
    else if (a === '--scenario') opts.scenario = argv[++i] || 'default';
    else if (a.startsWith('--scenario=')) opts.scenario = a.slice('--scenario='.length);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

function helpText() {
  return `Usage: node scripts/voice-bench.mjs [options]

Options:
  --runs <n>        Run the scenario n times per variant (default: 1)
  --out <file>      Write markdown report to file (stdout still prints)
  --json            Print JSON result to stdout instead of markdown
  --samples         Include per-sample table in markdown report
  --scenario <id>   Scenario id: default (default)
  -h, --help        Show help

Notes:
  - Deterministic mock variants by default (no network/audio).
  - Variants compared: edge vs piper with sentence-stream on/off.
`;
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const opts = parseArgs(argv);
  if (opts.help) {
    stdout.write(helpText());
    return { exitCode: 0 };
  }

  const scenario = opts.scenario === 'default' ? defaultScenario : defaultScenario;
  const result = await runVoiceBenchReport({
    scenario,
    variants: defaultVariants,
    runs: opts.runs,
    includeSamples: opts.includeSamples,
    meta: {
      generatedAt: new Date().toISOString(),
      notes: 'Deterministic mock benchmark (no real network/audio).',
    },
    title: 'J.A.B.S Voice Conversation Benchmark',
  });

  const output = opts.json ? JSON.stringify(result, null, 2) + '\n' : result.report + '\n';
  stdout.write(output);
  if (opts.out) {
    const target = path.resolve(opts.out);
    await writeFile(target, opts.json ? JSON.stringify(result, null, 2) + '\n' : result.report, 'utf8');
    stderr.write(`Wrote report to ${target}\n`);
  }
  return { exitCode: 0, result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exitCode = 1;
  });
}
