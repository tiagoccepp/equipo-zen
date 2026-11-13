// F-10a: registro del gateway WS único — introspección e higiene.
// Puro (sin sockets reales): ws.js lo alimenta, /api/ws/stats lo expone.

const connections = new Map(); // id -> {companyId, meetingId, connectedAt, lastSeen}
let connSeq = 0;

export function wsRegister({ companyId = null, meetingId = null } = {}) {
  connSeq += 1;
  const id = `ws-${connSeq}`;
  const now = Date.now();
  connections.set(id, { companyId, meetingId, connectedAt: now, lastSeen: now });
  return id;
}

export function wsUpdate(id, patch = {}) {
  const c = connections.get(id);
  if (!c) {
    return false;
  }
  if (patch.companyId !== undefined) {
    c.companyId = patch.companyId;
  }
  if (patch.meetingId !== undefined) {
    c.meetingId = patch.meetingId;
  }
  c.lastSeen = Date.now();
  return true;
}

export function wsTouch(id) {
  const c = connections.get(id);
  if (c) {
    c.lastSeen = Date.now();
  }
}

export function wsUnregister(id) {
  return connections.delete(id);
}

export function wsStats() {
  const list = [...connections.entries()].map(([id, c]) => ({ id, ...c }));
  const byCompany = {};
  for (const c of list) {
    const k = c.companyId || '(sin empresa)';
    byCompany[k] = (byCompany[k] || 0) + 1;
  }
  return { connections: list.length, byCompany, list };
}

export function wsStaleIds(maxIdleMs = 10 * 60 * 1000) {
  const now = Date.now();
  return [...connections.entries()]
    .filter(([, c]) => now - c.lastSeen > maxIdleMs)
    .map(([id]) => id);
}

export function __resetWsRegistry() {
  connections.clear();
  connSeq = 0;
}
