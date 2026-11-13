// E-10: auto-modificación segura — el agente propone mejoras; riesgo bajo
// se auto-aplica (versionado + rollback), el resto va a Tito.
// Irreversibles SIEMPRE a Tito. Determinístico, sin LLM.

export const PROPOSAL_KINDS = ['skill', 'taste', 'tier', 'prompt-note'];

// Clasifica riesgo. low = reversible y acotado; high = irreversible o
// sensible (a Tito sí o sí).
export function classifyRisk({ kind, action, payload = {} } = {}) {
  const act = String(action || '').toLowerCase();
  // Irreversibles / sensibles: siempre high.
  if (['delete', 'remove', 'drop', 'deny', 'revoke'].includes(act)) {
    return 'high';
  }
  if (kind === 'tier' && (act === 'allow' || payload?.tier === 'allow')) {
    return 'high'; // abrir permisos no es auto
  }
  if (kind === 'tier' && act === 'ask') {
    return 'medium'; // cerrar permisos: reversible pero sensible
  }
  if (kind === 'skill' && act === 'create') {
    return 'low';
  }
  if (kind === 'skill' && act === 'update') {
    return 'medium'; // pisa viva (versiona, pero avisa)
  }
  if (kind === 'taste' && ['create', 'update'].includes(act)) {
    return 'low';
  }
  if (kind === 'prompt-note' && act === 'create') {
    return 'low';
  }
  return 'medium'; // desconocido: a Tito
}

export function proposalSummary(p) {
  return `${p.kind}:${p.action} ${p.reason || ''}`.trim().slice(0, 200);
}

// Aplica una propuesta low-risk. Devuelve {applied, detail}.
export async function applyLowRisk({ store, goalId = null, proposal, skillsRoot = null }) {
  const kind = proposal?.kind;
  const action = proposal?.action;
  const payload = proposal?.payload || {};
  if (kind === 'skill' && action === 'create') {
    const ws = await import('./skill-workshop.js');
    const root = skillsRoot;
    const draft = ws.draftSkill({
      name: payload.name,
      description: payload.description || `Auto: ${proposal.reason || 'mejora propuesta'}`.slice(0, 200),
      keywords: payload.keywords || [],
      scope: payload.scope || 'chat',
      body: payload.body || ''
    }, { root });
    if (!draft.ok) {
      return { applied: false, detail: `dieta: ${draft.issues.join('; ')}` };
    }
    const ap = ws.approveDraft(draft.name, root);
    return ap.ok
      ? { applied: true, detail: `skill ${draft.name} creada` }
      : { applied: false, detail: ap.error };
  }
  if (kind === 'taste' && (action === 'create' || action === 'update')) {
    if (!store) {
      return { applied: false, detail: 'sin store' };
    }
    const row = store.upsertTaste({
      scope: payload.scope === 'global' ? 'global' : 'project',
      goalId: payload.scope === 'global' ? null : goalId,
      key: payload.key,
      value: payload.value,
      confidence: 0.7,
      source: 'self-improve'
    });
    return row
      ? { applied: true, detail: `gusto ${row.taste_key} guardado` }
      : { applied: false, detail: 'upsert falló' };
  }
  if (kind === 'prompt-note' && action === 'create') {
    // Nota al diario del proyecto (memoria operativa, reversible).
    return { applied: true, detail: `nota: ${String(payload.text || '').slice(0, 160)}`, note: true };
  }
  return { applied: false, detail: `sin aplicador low-risk para ${kind}:${action}` };
}
