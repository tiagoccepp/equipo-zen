// M-02: toolkit showFigure tipado — evolución de setGlyph. Las figuras son
// specs JSON validadas (nunca codegen): diagram/progress/checklist/notice
// + glyph (compat legacy). El servidor construye, el cliente dibuja.

export const FIGURE_MAX_CODE_CHARS = 20 * 1024;
export const FIGURE_MAX_ITEMS = 30;
export const FIGURE_MAX_TEXT_CHARS = 500;
import { sanitizeWidgetHtml } from './widget-sandbox.js';

export const FIGURE_KINDS = ['diagram', 'progress', 'checklist', 'notice', 'glyph', 'chart', 'slide', 'widget'];
// M-03: chart-spec declarativa (bar/line/pie). Cero codegen: solo números +
// etiquetas; el cliente dibuja SVG puro calculado, nunca evalúa nada.
export const CHART_TYPES = ['bar', 'line', 'pie'];
export const CHART_MAX_LABELS = 12;
export const CHART_MAX_SERIES = 4;
export const CHART_MAX_VALUE = 1e12;
export const NOTICE_TONES = ['info', 'ok', 'warn', 'bad'];

// Construye + valida. Devuelve {ok:true, figure} o {ok:false, error}.
export function figure(spec = {}) {
  const kind = String(spec.kind || '').trim().toLowerCase();
  if (!FIGURE_KINDS.includes(kind)) {
    return { ok: false, error: `kind inválido: ${kind || '(vacío)'} (válidos: ${FIGURE_KINDS.join(', ')})` };
  }
  switch (kind) {
    case 'diagram': {
      const code = String(spec.code || '').trim();
      if (!code) {
        return { ok: false, error: 'diagram necesita code' };
      }
      if (code.length > FIGURE_MAX_CODE_CHARS) {
        return { ok: false, error: `diagram muy largo (máx ${FIGURE_MAX_CODE_CHARS})` };
      }
      return { ok: true, figure: { kind, code } };
    }
    case 'progress': {
      const pct = Number(spec.pct);
      if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
        return { ok: false, error: 'progress necesita pct 0..100' };
      }
      const label = String(spec.label || '').slice(0, FIGURE_MAX_TEXT_CHARS);
      return { ok: true, figure: { kind, pct: Math.round(pct), label } };
    }
    case 'checklist': {
      const items = Array.isArray(spec.items) ? spec.items : null;
      if (!items || items.length === 0) {
        return { ok: false, error: 'checklist necesita items no vacío' };
      }
      if (items.length > FIGURE_MAX_ITEMS) {
        return { ok: false, error: `checklist muy larga (máx ${FIGURE_MAX_ITEMS})` };
      }
      const clean = [];
      for (const it of items) {
        const text = String(it?.text || '').trim().slice(0, 200);
        if (!text) {
          return { ok: false, error: 'checklist con ítem vacío' };
        }
        clean.push({ text, done: it?.done === true });
      }
      return { ok: true, figure: { kind, items: clean } };
    }
    case 'notice': {
      const tone = String(spec.tone || 'info').trim().toLowerCase();
      if (!NOTICE_TONES.includes(tone)) {
        return { ok: false, error: `tone inválido: ${tone}` };
      }
      const text = String(spec.text || '').trim().slice(0, FIGURE_MAX_TEXT_CHARS);
      if (!text) {
        return { ok: false, error: 'notice necesita text' };
      }
      return { ok: true, figure: { kind, tone, text } };
    }
    case 'glyph': {
      const name = String(spec.name || '').trim().slice(0, 80);
      if (!name) {
        return { ok: false, error: 'glyph necesita name' };
      }
      return { ok: true, figure: { kind, name } };
    }
    case 'widget': {
      const title = String(spec.title || '').trim().slice(0, 120);
      const clean = sanitizeWidgetHtml(spec.html || '');
      if (!clean) {
        return { ok: false, error: 'widget sin html mostrable' };
      }
      const height = Number(spec.height);
      return {
        ok: true,
        figure: {
          kind,
          title,
          html: clean,
          height: Number.isFinite(height) ? Math.min(600, Math.max(80, Math.round(height))) : 220
        }
      };
    }
    case 'slide': {
      const title = String(spec.title || '').trim().slice(0, 120);
      const bullets = Array.isArray(spec.bullets) ? spec.bullets : null;
      if (!title) {
        return { ok: false, error: 'slide necesita title' };
      }
      if (!bullets || bullets.length === 0 || bullets.length > 8) {
        return { ok: false, error: 'slide necesita 1..8 bullets' };
      }
      const clean = [];
      for (const b of bullets) {
        const s = String(b ?? '').trim().slice(0, 200);
        if (!s) {
          return { ok: false, error: 'slide con bullet vacío' };
        }
        clean.push(s);
      }
      return { ok: true, figure: { kind, title, bullets: clean } };
    }
    case 'chart': {
      const chartType = String(spec.chartType || spec.type || '').trim().toLowerCase();
      if (!CHART_TYPES.includes(chartType)) {
        return { ok: false, error: `chartType inválido (válidos: ${CHART_TYPES.join(', ')})` };
      }
      const labels = Array.isArray(spec.labels) ? spec.labels : null;
      if (!labels || labels.length === 0 || labels.length > CHART_MAX_LABELS) {
        return { ok: false, error: `chart necesita 1..${CHART_MAX_LABELS} labels` };
      }
      const cleanLabels = [];
      for (const l of labels) {
        const s = String(l ?? '').trim().slice(0, 40);
        if (!s) {
          return { ok: false, error: 'chart con label vacío' };
        }
        cleanLabels.push(s);
      }
      // values (pie/bar simple) o series ([{name, values}]).
      let series = [];
      if (Array.isArray(spec.series)) {
        if (spec.series.length === 0 || spec.series.length > CHART_MAX_SERIES) {
          return { ok: false, error: `chart necesita 1..${CHART_MAX_SERIES} series` };
        }
        for (const s of spec.series) {
          const name = String(s?.name ?? '').trim().slice(0, 40);
          const values = Array.isArray(s?.values) ? s.values : null;
          if (!values || values.length !== cleanLabels.length) {
            return { ok: false, error: `serie "${name || '?'}": values debe tener ${cleanLabels.length} números` };
          }
          series.push({ name: name || 'serie', values: null });
          series[series.length - 1].values = values;
        }
        if (chartType === 'pie' && series.length !== 1) {
          return { ok: false, error: 'pie acepta exactamente 1 serie' };
        }
      } else if (Array.isArray(spec.values)) {
        if (spec.values.length !== cleanLabels.length) {
          return { ok: false, error: `values debe tener ${cleanLabels.length} números` };
        }
        series = [{ name: '', values: spec.values }];
      } else {
        return { ok: false, error: 'chart necesita values o series' };
      }
      for (const s of series) {
        const clean = [];
        for (const v of s.values) {
          const n = Number(v);
          if (!Number.isFinite(n) || Math.abs(n) > CHART_MAX_VALUE) {
            return { ok: false, error: `valor inválido en serie "${s.name}"` };
          }
          clean.push(n);
        }
        s.values = clean;
      }
      const title = String(spec.title || '').trim().slice(0, 120);
      return { ok: true, figure: { kind, chartType, title, labels: cleanLabels, series } };
    }
    default:
      return { ok: false, error: `kind sin validador: ${kind}` };
  }
}

// M-10: carril efímero — key estable (upsert en vez de append) + flag
// ephemeral (vive en la zona viva, no en el historial). Se validan acá.
export function decorateFigure(figure, spec = {}) {
  const out = { ...figure };
  const key = String(spec.key || '').trim().slice(0, 64);
  if (key) {
    out.key = key;
  }
  if (spec.ephemeral === true) {
    out.ephemeral = true;
  }
  return out;
}

// Evento WS listo para emitir (o null si inválido — caller loguea motivo).
export function figureEvent(turnId, agentId, spec) {
  const r = figure(spec);
  if (!r.ok) {
    return null;
  }
  return { type: 'agent_figure', turnId, agentId, figure: decorateFigure(r.figure, spec) };
}

// Compat: el gesto v2 legacy equivale a una figura glyph.
export function glyphFigure(name) {
  return figure({ kind: 'glyph', name });
}
