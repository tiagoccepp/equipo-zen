// A-10: esfuerzo según complejidad — lead fuerte, workers chicos.
// scoreComplexity heurístico (rápido, sin LLM): largo, preguntas, verbos
// de acción, código, multi-parte. El router/saludos van a fast siempre.

const TOOL_VERBS = ['crea', 'creá', 'arma', 'armá', 'hacé', 'hace', 'busca', 'buscá', 'lee', 'leé', 'escribi', 'corregi', 'deploy', 'build', 'create', 'build', 'write', 'read', 'fix', 'run', 'make'];
const REASON_VERBS = ['por qué', 'porque', 'analiz', 'compar', 'decid', 'evalu', 'why', 'analyz', 'compare', 'decide', 'think'];
const GREETINGS_RE = /^(hola|hey|buenas|buen día|buenas tardes|buenas noches|hi|hello|qué tal|que tal|gracias|thanks|dale|ok|sí|si|no|bye|chau|adiós|adios)[\s!.,¿?]*$/i;

export function scoreComplexity(text) {
  const t = String(text || '').trim();
  if (!t) {
    return 'simple';
  }
  if (GREETINGS_RE.test(t) && t.length < 60) {
    return 'simple';
  }
  const low = t.toLowerCase();
  let score = 0;
  if (t.length > 400) {
    score += 2;
  } else if (t.length > 120) {
    score += 1;
  }
  const questions = (t.match(/\?/g) || []).length;
  score += Math.min(2, questions);
  for (const v of TOOL_VERBS) {
    if (low.includes(v)) {
      score += 1;
      break;
    }
  }
  for (const v of REASON_VERBS) {
    if (low.includes(v)) {
      score += 2;
      break;
    }
  }
  if (/```|tool:|http|error|traceback|no anda|no funciona/i.test(t)) {
    score += 2;
  }
  // Multi-parte (y/then/punto y coma): dos acciones ya es medium.
  const parts = t.split(/\by\b|\bthen\b|;/i).length;
  if (parts >= 2) {
    score += 1;
  }
  if (score <= 1) {
    return 'simple';
  }
  if (score <= 3) {
    return 'medium';
  }
  return 'complex';
}
