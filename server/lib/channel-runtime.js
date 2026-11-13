// E-15: runtime de channels — config desde settings, polling Telegram,
// outbox inbound, envío con permisos. Un poller por channel.

import {
  channelMayInteract,
  normalizeIdList,
  tgCall,
  tgParseUpdate,
  waSend
} from './channels.js';
import { dbValue } from './settings.js';

export const CHANNEL_POLL_MS = 30000;

function tgConfig() {
  return {
    id: 'telegram',
    kind: 'telegram',
    enabled: String(dbValue('channels.telegram.enabled') || '').toLowerCase() === 'true',
    botToken: dbValue('channels.telegram.botToken') || process.env.TELEGRAM_BOT_TOKEN || '',
    titoId: dbValue('channels.telegram.titoId') || process.env.TELEGRAM_TITO_ID || '',
    mode: dbValue('channels.telegram.mode') || 'tito-only',
    allow: normalizeIdList(dbValue('channels.telegram.allow')),
    autoRespond: String(dbValue('channels.telegram.autoRespond') || '').toLowerCase() === 'echo'
  };
}

function waConfig() {
  return {
    id: 'whatsapp',
    kind: 'whatsapp-meta',
    enabled: String(dbValue('channels.whatsapp.enabled') || '').toLowerCase() === 'true',
    token: dbValue('channels.whatsapp.token') || process.env.WHATSAPP_TOKEN || '',
    phoneId: dbValue('channels.whatsapp.phoneId') || process.env.WHATSAPP_PHONE_ID || '',
    titoId: dbValue('channels.whatsapp.titoId') || process.env.WHATSAPP_TITO_ID || '',
    mode: dbValue('channels.whatsapp.mode') || 'tito-only',
    allow: normalizeIdList(dbValue('channels.whatsapp.allow'))
  };
}

export function channelConfigs() {
  return [tgConfig(), waConfig()].filter((c) => c.enabled);
}

const inbox = []; // inbound aceptado (cap 100)
const subscribers = new Set();

export function onChannelInbound(fn) {
  if (typeof fn === 'function') {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  }
  return () => {};
}

export function channelInbox() {
  return [...inbox];
}

export function __resetChannelState() {
  inbox.length = 0;
  subscribers.clear();
}

function acceptInbound(channel, parsed) {
  const gate = channelMayInteract(channel, { fromId: parsed.fromId });
  const entry = {
    at: new Date().toISOString(),
    channel: channel.id,
    ...parsed,
    allowed: gate.ok,
    via: gate.via || null,
    blockedReason: gate.ok ? null : gate.reason
  };
  inbox.push(entry);
  while (inbox.length > 100) {
    inbox.shift();
  }
  if (gate.ok) {
    for (const fn of subscribers) {
      try {
        fn(entry);
      } catch { /* subscriber caído no frena */ }
    }
  }
  return entry;
}

// Envía por Telegram (con gate de permisos en destino).
export async function sendTelegram({ to, text }, { fetchFn = fetch, config = null } = {}) {
  const channel = config || tgConfig();
  if (!channel.botToken) {
    throw new Error('telegram sin botToken');
  }
  const gate = channelMayInteract({ ...channel, enabled: true }, { fromId: to });
  if (!gate.ok) {
    throw new Error(`telegram destino bloqueado: ${gate.reason}`);
  }
  return tgCall(channel.botToken, 'sendMessage', {
    chat_id: to,
    text: String(text).slice(0, 4000)
  }, { fetchFn });
}

// Envía por WhatsApp (con gate).
export async function sendWhatsapp({ to, text }, { fetchFn = fetch, config = null } = {}) {
  const channel = config || waConfig();
  if (!channel.token || !channel.phoneId) {
    throw new Error('whatsapp sin token/phoneId');
  }
  const gate = channelMayInteract({ ...channel, enabled: true }, { fromId: to });
  if (!gate.ok) {
    throw new Error(`whatsapp destino bloqueado: ${gate.reason}`);
  }
  return waSend({ token: channel.token, phoneId: channel.phoneId, to, text }, { fetchFn });
}

// Una pasada de polling Telegram. offsetRef: {current} mutable.
export async function pollTelegramOnce({ fetchFn = fetch, config = null, offsetRef = null } = {}) {
  const channel = config || tgConfig();
  if (!channel.enabled || !channel.botToken) {
    return [];
  }
  const params = { timeout: 0, limit: 20 };
  if (offsetRef && Number.isFinite(offsetRef.current)) {
    params.offset = offsetRef.current;
  }
  const updates = await tgCall(channel.botToken, 'getUpdates', params, { fetchFn });
  const accepted = [];
  for (const u of updates || []) {
    if (offsetRef && Number.isFinite(u?.update_id)) {
      offsetRef.current = u.update_id + 1;
    }
    const parsed = tgParseUpdate(u);
    if (!parsed) {
      continue;
    }
    const entry = acceptInbound(channel, parsed);
    accepted.push(entry);
    // autoRespond=echo: devuelve el texto (verifica el loop completo).
    if (entry.allowed && channel.autoRespond) {
      try {
        await tgCall(channel.botToken, 'sendMessage', { chat_id: parsed.chatId, text: `eco: ${parsed.text}` }, { fetchFn });
      } catch { /* echo caído: el inbound igual quedó */ }
    }
  }
  return accepted;
}

let pollTimer = null;
const pollOffsets = {};

export function startChannelPolling({ fetchFn = fetch, pollMs = CHANNEL_POLL_MS } = {}) {
  stopChannelPolling();
  const tick = async () => {
    for (const channel of channelConfigs()) {
      if (channel.kind !== 'telegram') {
        continue;
      }
      try {
        if (!pollOffsets[channel.id]) {
          pollOffsets[channel.id] = {};
        }
        await pollTelegramOnce({ fetchFn, config: channel, offsetRef: pollOffsets[channel.id] });
      } catch { /* próximo tick reintenta */ }
    }
  };
  pollTimer = setInterval(tick, pollMs);
  pollTimer.unref?.();
  return () => stopChannelPolling();
}

export function stopChannelPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}
