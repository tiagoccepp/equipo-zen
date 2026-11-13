// QW-03: anuncio estático inmediato por tool (sin LLM).
// - Toda tool del registry tiene frase ES+EN, salvo `now` (instantánea).
// - runToolLoop dispara onFirstToolCall UNA vez con el primer tool.
// - Sin callback, conducta idéntica a antes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { toolAnnouncePhrase } from '../server/lib/agent-runtime.js';
import { listTools, runToolLoop } from '../server/lib/manos.js';

test('qw03: cobertura de frases por tool (ES+EN), now excluido', () => {
  const names = listTools().map((t) => String(t.name || t));
  assert.ok(names.length > 5, `registry con tools (n=${names.length})`);
  for (const name of names) {
    if (name === 'now') {
      assert.equal(toolAnnouncePhrase(name, 'es'), null, 'now sin anuncio ES');
      assert.equal(toolAnnouncePhrase(name, 'en'), null, 'now sin anuncio EN');
      continue;
    }
    if (name.startsWith('mcp_')) continue; // frase genérica MCP, ver abajo
    const es = toolAnnouncePhrase(name, 'es');
    const en = toolAnnouncePhrase(name, 'en');
    assert.ok(es && es.length >= 8, `${name} tiene frase ES`);
    assert.ok(en && en.length >= 8, `${name} tiene frase EN`);
  }
});

test('qw03: mcp_* y desconocidas usan genéricas, now null', () => {
  assert.ok(toolAnnouncePhrase('mcp_github', 'es').includes('integraci'), 'mcp ES');
  assert.ok(toolAnnouncePhrase('mcp_x', 'en').includes('integration'), 'mcp EN');
  assert.ok(toolAnnouncePhrase('tool_futura', 'es').length >= 8, 'default ES');
  assert.equal(toolAnnouncePhrase(null, 'es'), null, 'null → null');
});

test('qw03: runToolLoop dispara onFirstToolCall una sola vez', async () => {
  const seen = [];
  let n = 0;
  const out = await runToolLoop({
    system: 'test',
    messages: [{ role: 'user', content: 'hola' }],
    completeChat: async () => {
      n += 1;
      if (n === 1) return { text: '```tool:now\n{}\n```\n```tool:now\n{}\n```' };
      return { text: 'listo' };
    },
    onFirstToolCall: (tool) => { seen.push(tool); }
  });
  assert.deepEqual(seen, ['now'], 'un disparo con el primer tool');
  assert.ok(out && typeof out.toolSummary === 'string', 'loop termina normal');
});

test('qw03: sin callback, conducta intacta', async () => {
  let n = 0;
  const out = await runToolLoop({
    system: 'test',
    messages: [{ role: 'user', content: 'hola' }],
    completeChat: async () => {
      n += 1;
      if (n === 1) return { text: '```tool:now\n{}\n```' };
      return { text: 'listo' };
    }
  });
  assert.ok(out && typeof out.toolSummary === 'string', 'sin callback funciona');
});
