// E-05: bus interno entre agentes (V-08) — mensajería directa peer-to-peer
// dentro de la reunión. Un agente le escribe a otro (agent_send); el otro
// lo ve en su próximo turno (inbox en el prompt). Async por diseño (v1);
// request/reply sincrónico viene en A-02/A-07.

export const BUS_MAX_TEXT = 1000;
export const BUS_MAX_INBOX = 20;
export const BUS_MAX_HISTORY = 100;

let busMsgSeq = 0;

export class AgentBus {
  constructor() {
    this.roster = new Set();
    this.inboxes = new Map();
    this.history = [];
  }

  setRoster(agentIds) {
    this.roster = new Set((agentIds || []).filter(Boolean));
  }

  // Envía {from} → {to} ('broadcast' = todos menos from).
  // Devuelve {ok, id?|error}.
  send(from, to, text, { re = null } = {}) {
    const clean = String(text || '').trim().slice(0, BUS_MAX_TEXT);
    if (!from || !this.roster.has(from)) {
      return { ok: false, error: `remitente desconocido: ${from}` };
    }
    if (!clean) {
      return { ok: false, error: 'mensaje vacío' };
    }
    const targets = to === 'broadcast'
      ? [...this.roster].filter((id) => id !== from)
      : [to];
    if (targets.length === 0) {
      return { ok: false, error: 'nadie para recibir (¿broadcast sin equipo?)' };
    }
    for (const t of targets) {
      if (!this.roster.has(t)) {
        return { ok: false, error: `destinatario desconocido: ${t}` };
      }
      if (t === from) {
        return { ok: false, error: 'no te podés escribir a vos mismo' };
      }
    }
    const at = new Date().toISOString();
    const ids = [];
    for (const t of targets) {
      busMsgSeq += 1;
      const msg = { id: `am-${busMsgSeq}`, from, to: t, text: clean, at, re: re || null };
      if (!this.inboxes.has(t)) {
        this.inboxes.set(t, []);
      }
      const box = this.inboxes.get(t);
      box.push(msg);
      while (box.length > BUS_MAX_INBOX) {
        box.shift();
      }
      this.history.push(msg);
      ids.push(msg.id);
    }
    while (this.history.length > BUS_MAX_HISTORY) {
      this.history.shift();
    }
    return { ok: true, id: ids[0], count: ids.length };
  }

  // Saca (drena) los pendientes del agente. Cada mensaje se entrega UNA vez.
  drain(agentId) {
    const box = this.inboxes.get(agentId) || [];
    this.inboxes.set(agentId, []);
    return box;
  }

  pending(agentId) {
    return (this.inboxes.get(agentId) || []).length;
  }

  recent(n = 10) {
    return this.history.slice(-Math.max(1, n));
  }
}

// Sección de prompt con los mensajes drenados (se llama UNA vez por turno).
export function renderInboxSection(messages, { english = false } = {}) {
  const list = (messages || []).filter((m) => m && m.text);
  if (list.length === 0) {
    return '';
  }
  const head = english
    ? 'DIRECT MESSAGES from teammates (answer what concerns you):'
    : 'MENSAJES DIRECTOS de compañeros (respondé lo que te toque):';
  const lines = list.map((m) => `- ${m.from} → vos: "${String(m.text).slice(0, 400)}"`);
  return [head, ...lines].join('\n');
}
