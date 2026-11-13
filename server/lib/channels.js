// E-15: channels — Pablo alcanzable fuera de la app (Telegram hoy,
// WhatsApp-Meta experimental) + permisos granulares por channel.
// tito-only (default): solo el id de Tito interactúa. allowlist: suma ids.
// Inbound → outbox + subscribers; autoRespond=echo sirve para verificar el
// loop (el cerebro remoto viene con E-18/V-10).

export const CHANNEL_KINDS = ['telegram', 'whatsapp-meta'];

export function normalizeIdList(value) {
  return String(value || '').split(',')
    .map((s) => s.trim()).filter(Boolean);
}

// ¿Puede interactuar? {fromId} entrante o saliente. tito-only default.
export function channelMayInteract(channel, { fromId = null } = {}) {
  if (!channel || channel.enabled === false) {
    return { ok: false, reason: 'channel deshabilitado' };
  }
  const mode = channel.mode === 'allowlist' ? 'allowlist' : 'tito-only';
  const fid = String(fromId ?? '').trim();
  if (!fid) {
    return { ok: false, reason: 'sin remitente' };
  }
  const titoId = String(channel.titoId || '').trim();
  if (titoId && fid === titoId) {
    return { ok: true, via: 'tito' };
  }
  if (mode === 'allowlist' && (channel.allow || []).map(String).includes(fid)) {
    return { ok: true, via: 'allowlist' };
  }
  return { ok: false, reason: mode === 'tito-only' ? 'solo-Tito' : 'fuera de allowlist' };
}

// --- Telegram (Bot API) ---
const TG_API = 'https://api.telegram.org';

export async function tgCall(botToken, method, params = {}, { fetchFn = fetch, timeoutMs = 25000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchFn(`${TG_API}/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: ctrl.signal
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.ok === false) {
      throw new Error(`telegram ${method}: ${body.description || `HTTP ${res.status}`}`.slice(0, 200));
    }
    return body.result;
  } finally {
    clearTimeout(timer);
  }
}

export function tgParseUpdate(update) {
  const msg = update?.message || update?.edited_message || null;
  if (!msg || !msg.chat || msg.chat.id === undefined) {
    return null;
  }
  const text = String(msg.text || msg.caption || '').trim();
  if (!text) {
    return null;
  }
  return {
    updateId: update.update_id,
    chatId: String(msg.chat.id),
    fromId: String(msg.from?.id ?? msg.chat.id),
    fromName: [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || null,
    text: text.slice(0, 2000),
    date: msg.date || null
  };
}

// --- WhatsApp Cloud API (Meta, experimental: sin credenciales no se prueba en vivo) ---
const WA_API = 'https://graph.facebook.com/v21.0';

export async function waSend({ token, phoneId, to, text }, { fetchFn = fetch, timeoutMs = 25000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  timer.unref?.();
  try {
    const res = await fetchFn(`${WA_API}/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: String(text).slice(0, 4000) } }),
      signal: ctrl.signal
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      throw new Error(`whatsapp send: ${body.error?.message || `HTTP ${res.status}`}`.slice(0, 200));
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export function waParseWebhook(body) {
  try {
    const msg = body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0] || null;
    const text = msg?.text?.body;
    if (!msg || !text) {
      return null;
    }
    return {
      chatId: String(msg.from),
      fromId: String(msg.from),
      fromName: null,
      text: String(text).slice(0, 2000),
      messageId: msg.id || null
    };
  } catch {
    return null;
  }
}
