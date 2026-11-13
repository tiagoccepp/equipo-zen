// A-01: dispatch frío — la voz se congela en paquete cerrado ANTES de
// asignar/spawnear, y se rutea por DESCRIPCIÓN del agente (título,
// conocimiento, oficio, dominios), no solo por rol.

let packetSeq = 0;

function words(text) {
  return String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter((w) => w.length > 2);
}

const STOPWORDS = new Set(['que', 'una', 'para', 'con', 'los', 'las', 'del', 'the', 'and', 'for', 'que', 'por', 'como']);

// Congela texto libre en paquete: keywords, preguntas e imperativos.
export function freezePacket(text, { prefix = 'pkt' } = {}) {
  const raw = String(text || '').trim().slice(0, 2000);
  packetSeq += 1;
  const keywords = [...new Set(words(raw).filter((w) => !STOPWORDS.has(w)))].slice(0, 20);
  const questions = [...raw.matchAll(/([^.?!¿]+)\?/g)].map((m) => m[1].trim()).filter((s) => s.length > 0);
  return {
    id: `${prefix}-${packetSeq}`,
    text: raw,
    keywords,
    questions: questions.slice(0, 5),
    at: new Date().toISOString()
  };
}

function agentHaystack(agent) {
  return [
    agent?.title || '', agent?.knowledge || '', agent?.craft || '',
    (agent?.domains || []).join(' '), (agent?.aliases || []).join(' '), agent?.role || ''
  ].join(' ').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

// Score de fit agente↔paquete (0 = nada). Pondera título y dominios.
export function scoreAgentForPacket(agent, packet) {
  if (!agent || !packet) {
    return 0;
  }
  const hay = agentHaystack(agent);
  const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const title = norm(agent.title);
  const domains = norm((agent.domains || []).join(' '));
  let score = 0;
  for (const kw of packet.keywords || []) {
    if (title.includes(kw)) {
      score += 3;
    } else if (domains.includes(kw)) {
      score += 2;
    } else if (hay.includes(kw)) {
      score += 1;
    }
  }
  return score;
}

// Mejor agente para el paquete (null si nadie supera el umbral).
export function routePacketToAgent(packet, agents, { threshold = 2 } = {}) {
  let best = null;
  let bestScore = 0;
  for (const agent of agents || []) {
    if (!agent || agent.enabled === false || agent.status === 'inactive') {
      continue;
    }
    const score = scoreAgentForPacket(agent, packet);
    if (score > bestScore) {
      bestScore = score;
      best = agent;
    }
  }
  return bestScore >= threshold ? best : null;
}
