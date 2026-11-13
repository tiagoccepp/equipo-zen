// M-09: modo plan por voz — el agente propone, Tito aprueba hablando.
// El plan vive en tasks (kind='plan', status pending/approved/rejected):
// cero tablas nuevas. La voz ("dale", "hacelo") resuelve sin clicks.

// Fronteras unicode-safe (\b no ve tildes: 'pará'/'sí' fallarían). 
const B = '[^a-záéíóúñ]';
const APPROVE_RE = new RegExp(`(^|${B})(dale|hacelo|hazlo|aprobado|apruebo|aprobada|adelante|procede|procedé|de una|mandale|bueno dale|sí dale|si dale|go ahead|do it|approved|proceed|yes do it|sounds good)(?![a-záéíóúñ])`, 'i');
const REJECT_RE = new RegExp(`(^|${B})(no|para|pará|basta|todavía no|aún no|mejor no|cambia|cambiá|espera|esperá|stop|don't|dont|not yet|hold off|rechazo)(?![a-záéíóúñ])`, 'i');

// Clasifica la respuesta de Tito ante un plan pendiente.
export function classifyPlanReply(text) {
  const t = String(text || '').trim();
  if (!t) {
    return 'unclear';
  }
  // Solo 'sí'/'ok'/'dale' pelado = approve (en contexto de plan pendiente).
  // ('si hacés X' condicional NO: por eso 'si' suelto exige texto exacto.)
  if (/^(s[ií]|ok|dale|yes)\W*$/i.test(t)) {
    return 'approve';
  }
  // "no, dale" → el dale gana si viene después del no.
  const approveAt = t.search(APPROVE_RE);
  const rejectAt = t.search(REJECT_RE);
  if (approveAt === -1 && rejectAt === -1) {
    return t.length < 140 ? 'unclear' : 'amend';
  }
  if (approveAt !== -1 && (rejectAt === -1 || approveAt > rejectAt)) {
    return t.length > 140 ? 'amend' : 'approve';
  }
  if (rejectAt !== -1) {
    return t.length > 140 ? 'amend' : 'reject';
  }
  return 'unclear';
}

// Revisa si el texto resuelve el plan pendiente del proyecto. Devuelve
// {resolved, plan, verdict} o {resolved:false}. No lanza.
export function maybeResolvePlan(store, goalId, text) {
  try {
    if (!store || !goalId) {
      return { resolved: false };
    }
    const plan = store.planForGoal(goalId);
    if (!plan) {
      return { resolved: false };
    }
    const verdict = classifyPlanReply(text);
    if (verdict === 'approve') {
      store.finishTask(plan.id, { status: 'approved', summary: `Aprobado por voz: "${String(text).slice(0, 160)}"` });
      return { resolved: true, plan, verdict };
    }
    if (verdict === 'reject') {
      store.finishTask(plan.id, { status: 'rejected', summary: `Rechazado por voz: "${String(text).slice(0, 160)}"` });
      return { resolved: true, plan, verdict };
    }
    return { resolved: false, plan, verdict };
  } catch {
    return { resolved: false };
  }
}

// A-05: heurística de reversibilidad de pasos (auto-proceed solo si todo
// es reversible; si algo suena destructivo/externo, espera a Tito).
const IRREVERSIBLE_STEP_RE = /\b(borrar|delete|drop|\brm\b|commit|push|deploy|enviar|send|publicar|comprar|pagar|suscribir|eliminar)\b/i;

export function planStepsReversible(steps) {
  const list = Array.isArray(steps) ? steps : [];
  if (list.length === 0) {
    return false;
  }
  return !list.some((s) => IRREVERSIBLE_STEP_RE.test(String(s || '')));
}

// Auto-proceed temporizado (voz): si sigue pendiente y es reversible,
// se aprueba solo + notificación. Devuelve {proceeded, reason}.
export async function planAutoProceed(store, planId) {
  if (!store || !planId) {
    return { proceeded: false, reason: 'sin store/plan' };
  }
  const plan = store.getTask(planId);
  if (!plan || plan.kind !== 'plan' || plan.status !== 'pending') {
    return { proceeded: false, reason: 'ya resuelto' };
  }
  let data = {};
  try {
    data = JSON.parse(plan.text);
  } catch {
    return { proceeded: false, reason: 'plan ilegible' };
  }
  if (!planStepsReversible(data.steps)) {
    return { proceeded: false, reason: 'pasos irreversibles: espera a Tito' };
  }
  store.finishTask(plan.id, { status: 'approved', summary: 'Auto-proceed: reversible y sin veto en ventana.' });
  try {
    const { dispatchNotification, settingsAnnounce } = await import('./notifications.js');
    await dispatchNotification({
      title: `Plan auto-procedido: ${String(data.title || '').slice(0, 120)}`,
      detail: (data.steps || []).join('\n').slice(0, 800),
      announce: settingsAnnounce
    });
  } catch { /* notify caída: igual procedió */ }
  return { proceeded: true, plan: data.title };
}

export function planStepsText(plan) {
  try {
    const data = JSON.parse(plan?.text || '{}');
    const steps = Array.isArray(data.steps) ? data.steps : [];
    return steps.map((s, i) => `${i + 1}. ${s}`).join('\n');
  } catch {
    return String(plan?.text || '');
  }
}
