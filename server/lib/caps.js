// E-27: topes por proyecto (tokens/RAM/tiempo), default SIN topes.
// Postergado imponerlos (decisión Tito: primero funciona); el mecanismo
// queda listo y se enforcea SOLO si Tito setea un tope. Puro + testeable.

export function checkCaps({ caps = {}, usage = {} } = {}) {
  const errors = [];
  const warnings = [];
  const tokensCap = Number(caps.tokens);
  const tokensUsed = Number(usage.tokens) || 0;
  if (Number.isFinite(tokensCap) && tokensCap > 0) {
    if (tokensUsed >= tokensCap) {
      errors.push(`tope de tokens alcanzado (${tokensUsed}/${tokensCap})`);
    } else if (tokensUsed >= tokensCap * 0.8) {
      warnings.push(`tokens al ${Math.round((tokensUsed / tokensCap) * 100)}%`);
    }
  }
  const timeCap = Number(caps.timeMin);
  const elapsedMin = Number(usage.elapsedMin) || 0;
  if (Number.isFinite(timeCap) && timeCap > 0) {
    if (elapsedMin >= timeCap) {
      errors.push(`tope de tiempo alcanzado (${Math.round(elapsedMin)}/${timeCap} min)`);
    } else if (elapsedMin >= timeCap * 0.8) {
      warnings.push(`tiempo al ${Math.round((elapsedMin / timeCap) * 100)}%`);
    }
  }
  const ramCap = Number(caps.ramMb);
  const ramUsed = Number(usage.ramMb) || 0;
  if (Number.isFinite(ramCap) && ramCap > 0) {
    if (ramUsed >= ramCap) {
      errors.push(`tope de RAM alcanzado (${Math.round(ramUsed)}/${ramCap} MB)`);
    } else if (ramUsed >= ramCap * 0.8) {
      warnings.push(`RAM al ${Math.round((ramUsed / ramCap) * 100)}%`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

export function ramMbNow() {
  try {
    return Math.round(process.memoryUsage().rss / 1024 / 1024);
  } catch {
    return 0;
  }
}
