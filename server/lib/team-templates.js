// E-03: equipo por proyecto — cada proyecto instancia su roster
// especializado según su stack. Los agentes son personas de la empresa;
// el roster del proyecto es QUÉ rol cubre QUIÉN (o qué falta → spawner).

// Stack → roles queridos (orden = prioridad). pablo/spawner son globales,
// no entran al roster.
export const TEAM_TEMPLATES = {
  web: ['orquestador', 'diseno', 'frontend', 'backend', 'tester', 'copy'],
  'movil-rn': ['orquestador', 'frontend', 'backend', 'tester'],
  android: ['orquestador', 'frontend', 'backend', 'tester'],
  python: ['orquestador', 'backend', 'data', 'tester'],
  automatizacion: ['orquestador', 'backend', 'devops'],
  default: ['orquestador', 'backend', 'frontend', 'tester']
};

export function teamTemplateFor(stack) {
  const key = String(stack || '').trim().toLowerCase();
  return [...(TEAM_TEMPLATES[key] || TEAM_TEMPLATES.default)];
}

// Keywords para matchear agentes viejos (role genérico 'worker'/'ceo')
// contra roles manos por título/skills/alias.
const ROLE_KEYWORDS = {
  orquestador: ['ceo', 'orquesta', 'director', 'coordina', 'jefa', 'jefe'],
  backend: ['backend', 'programador', 'programación', 'programacion', 'codigo', 'código', 'software', 'api'],
  frontend: ['frontend', 'front-end', 'front end'],
  diseno: ['diseño', 'diseno', 'arte', 'ux', 'ui', 'visual'],
  tester: ['tester', 'pruebas', 'qa', 'calidad', 'testing'],
  copy: ['copy', 'redacci', 'contenido', 'texto'],
  marketing: ['marketing', 'marca', 'publicidad'],
  ventas: ['ventas', 'comercial', 'vendedor'],
  data: ['datos', 'data', 'analítica', 'analitica'],
  devops: ['devops', 'infra', 'deploy', 'servidor', 'nube']
};

function agentHaystack(agent) {
  const parts = [
    agent?.title || '',
    agent?.role || '',
    (agent?.aliases || []).join(' '),
    (agent?.domains || []).join(' '),
    agent?.knowledge || ''
  ];
  return parts.join(' ').toLowerCase();
}

// Mejor agente libre para el rol: match exacto de role gana; si no,
// keywords en título/skills. Un agente cubre UN rol por proyecto.
export function matchAgentForRole(agents, role, taken = new Set()) {
  const key = String(role || '').trim().toLowerCase();
  const free = (agents || []).filter((a) => a && a.status === 'active' && !taken.has(a.id));
  const exact = free.find((a) => String(a.role || '').trim().toLowerCase() === key);
  if (exact) {
    return exact;
  }
  const keywords = ROLE_KEYWORDS[key] || [key];
  let best = null;
  let bestScore = 0;
  for (const agent of free) {
    const hay = agentHaystack(agent);
    let score = 0;
    for (const kw of keywords) {
      if (kw && hay.includes(kw)) {
        score += kw.length;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = agent;
    }
  }
  return bestScore > 0 ? best : null;
}

// Plan de roster: asigna agentes a roles; lo que no se cubre va a missing
// (lo crea el spawner E-04). Determinístico.
export function planProjectRoster(agents, stack) {
  const wanted = teamTemplateFor(stack);
  const taken = new Set();
  const assigned = [];
  const missing = [];
  for (const role of wanted) {
    const agent = matchAgentForRole(agents, role, taken);
    if (agent) {
      taken.add(agent.id);
      assigned.push({ role, agentId: agent.id });
    } else {
      missing.push(role);
    }
  }
  return { wanted, assigned, missing };
}
