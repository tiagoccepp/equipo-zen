// E-21: facturación futura (V-14, no es el enfoque) — seams, no cobro.
// Cuentas (hoy: 'local' única), planes (hoy: personal todo-habilitado),
// entitlements (default allow + policy inyectable) y ledger de uso real
// (tokens/costo por llamada, vía QW-05). Mañana: planes de verdad acá.

export const PLANS = {
  personal: { seats: 1, features: ['*'] },
  pro: { seats: 5, features: ['*'] },
  enterprise: { seats: -1, features: ['*'] }
};

let policyFn = null;

// Política futura (pagos/planes): fn(feature, ctx) → {ok, reason?}|null.
// null = "sin opinión, vale el default". Sin policy: todo permitido.
export function setEntitlementPolicy(fn) {
  policyFn = typeof fn === 'function' ? fn : null;
}

export function checkEntitlement(feature, ctx = {}) {
  if (policyFn) {
    try {
      const r = policyFn(feature, ctx);
      if (r && typeof r.ok === 'boolean') {
        return r;
      }
    } catch {
      // Policy caída: fail-open a default (no frena a Tito).
    }
  }
  return { ok: true, plan: ctx.plan || 'personal' };
}

export function accountPlan(settingsDb = null) {
  const v = typeof settingsDb === 'function' ? settingsDb('billing.plan') : null;
  const plan = String(v || 'personal').toLowerCase();
  return PLANS[plan] ? plan : 'personal';
}

// --- metering (sink pluggable; index.js lo conecta al store) ---
let usageSink = null;

export function setUsageSink(fn) {
  usageSink = typeof fn === 'function' ? fn : null;
}

export function emitUsage(record) {
  if (!usageSink || !record) {
    return;
  }
  try {
    usageSink(record);
  } catch {
    // Metering caído: el turno igual vale.
  }
}

export function __resetBilling() {
  policyFn = null;
  usageSink = null;
}
