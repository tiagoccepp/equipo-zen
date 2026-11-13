// E-18: notificaciones (V-12) — mensaje corto al channel configurado +
// aviso por voz si Pablo está despierto; detalle a pedido (API/tool).
// Los meetings vivos registran su anunciador de voz; sin nadie despierto,
// solo channel + log.

const voiceAnnouncers = new Set();
const log = [];
let notifSeq = 0;

export function registerVoiceAnnouncer(fn) {
  if (typeof fn === 'function') {
    voiceAnnouncers.add(fn);
    return () => voiceAnnouncers.delete(fn);
  }
  return () => {};
}

export function notificationLog({ limit = 50 } = {}) {
  return log.slice(-Math.max(1, limit)).reverse();
}

export function notificationGet(id) {
  return log.find((n) => n.id === id) || null;
}

export function __resetNotifications() {
  voiceAnnouncers.clear();
  log.length = 0;
  notifSeq = 0;
}

// Despacha: channel (si hay) + log + voz (si hay despiertos).
// announce: async ({title, detail, goalId}) → envía al channel o null.
// short: texto corto hablable (default = title).
export async function dispatchNotification({ title, detail = '', goalId = null, short = null, announce = null }) {
  const clean = String(title || '').trim().slice(0, 200);
  if (!clean) {
    return null;
  }
  notifSeq += 1;
  const entry = {
    id: `nt-${notifSeq}`,
    at: new Date().toISOString(),
    title: clean,
    detail: String(detail || '').slice(0, 2000),
    goalId,
    channel: null,
    channelError: null,
    voiced: false
  };
  if (typeof announce === 'function') {
    try {
      const r = await announce({ title: clean, detail: entry.detail, goalId });
      entry.channel = r?.channel || 'custom';
    } catch (error) {
      entry.channelError = String(error?.message || error).slice(0, 200);
    }
  }
  if (voiceAnnouncers.size > 0) {
    const spoken = String(short || clean).slice(0, 200);
    for (const fn of voiceAnnouncers) {
      try {
        const r = await fn({ title: clean, short: spoken, goalId, id: entry.id });
        if (r) {
          entry.voiced = true;
        }
      } catch { /* anunciador caído no frena */ }
    }
  }
  log.push(entry);
  while (log.length > 100) {
    log.shift();
  }
  return entry;
}

// Puente default: settings notify.* → envío real por channel.
export async function settingsAnnounce({ title, detail, goalId }) {
  const { getNotifyChannel, getNotifyTo } = await import('./settings.js');
  const channel = getNotifyChannel();
  const to = getNotifyTo();
  if (channel === 'none' || !to) {
    return null;
  }
  const rt = await import('./channel-runtime.js');
  const text = detail ? `${title}\n${detail.slice(0, 1500)}` : title;
  if (channel === 'telegram') {
    await rt.sendTelegram({ to, text });
    return { channel: 'telegram' };
  }
  await rt.sendWhatsapp({ to, text });
  return { channel: 'whatsapp' };
}
