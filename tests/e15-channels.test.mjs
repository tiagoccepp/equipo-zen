// E-15: channels — permisos, Telegram fake-HTTP, WhatsApp parse.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  channelMayInteract,
  normalizeIdList,
  tgParseUpdate,
  waParseWebhook,
  waSend
} from '../server/lib/channels.js';
import {
  __resetChannelState,
  channelInbox,
  onChannelInbound,
  pollTelegramOnce,
  sendTelegram
} from '../server/lib/channel-runtime.js';

afterEach(() => { __resetChannelState(); });

const TG = { id: 'telegram', kind: 'telegram', enabled: true, botToken: 'TOK', titoId: '111', mode: 'tito-only', allow: [] };

test('e15: permisos tito-only vs allowlist', () => {
  assert.deepEqual(normalizeIdList('a, b,,c'), ['a', 'b', 'c']);
  assert.equal(channelMayInteract(TG, { fromId: '111' }).ok, true, 'Tito pasa');
  assert.equal(channelMayInteract(TG, { fromId: '111' }).via, 'tito');
  const r = channelMayInteract(TG, { fromId: '222' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'solo-Tito');
  const al = { ...TG, mode: 'allowlist', allow: ['222'] };
  assert.equal(channelMayInteract(al, { fromId: '222' }).via, 'allowlist');
  assert.equal(channelMayInteract(al, { fromId: '333' }).ok, false);
  assert.equal(channelMayInteract({ ...TG, enabled: false }, { fromId: '111' }).ok, false);
  assert.equal(channelMayInteract(TG, {}).ok, false, 'sin remitente');
});

test('e15: poll Telegram — acepta Tito, bloquea resto, offset avanza', async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({
        ok: true,
        result: [
          { update_id: 10, message: { chat: { id: 111 }, from: { id: 111, first_name: 'Tito' }, text: 'hola' } },
          { update_id: 11, message: { chat: { id: 222 }, from: { id: 222 }, text: 'spam' } },
          { update_id: 12, message: { chat: { id: 111 }, text: '' } }
        ]
      })
    };
  };
  const seen = [];
  onChannelInbound((e) => seen.push(e));
  const offsetRef = {};
  const accepted = await pollTelegramOnce({ fetchFn, config: TG, offsetRef });
  assert.equal(accepted.length, 2, 'vacío se descarta');
  assert.equal(accepted[0].allowed, true);
  assert.equal(accepted[0].text, 'hola');
  assert.equal(accepted[1].allowed, false, 'no-Tito bloqueado');
  assert.equal(offsetRef.current, 13, 'offset avanza');
  assert.equal(seen.length, 1, 'subscriber solo aceptados');
  assert.equal(channelInbox().length, 2, 'inbox registra todo');
});

test('e15: inbound duplicado no re-notifica ni re-encola', async () => {
  const fetchFn = async (url) => {
    if (String(url).includes('getUpdates')) {
      return { ok: true, json: async () => ({ ok: true, result: [{ update_id: 20, message: { chat: { id: 111 }, from: { id: 111 }, text: 'dup' } }] }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
  const seen = [];
  onChannelInbound((e) => seen.push(e));
  const offsetRef = {};
  await pollTelegramOnce({ fetchFn, config: TG, offsetRef });
  await pollTelegramOnce({ fetchFn, config: TG, offsetRef });
  assert.equal(seen.length, 1, 'subscriber solo una vez');
  assert.equal(channelInbox().length, 1, 'inbox no duplica');
  const accepted = await pollTelegramOnce({ fetchFn, config: TG, offsetRef });
  assert.equal(accepted[0].duplicate, true, 'reentrega marcada duplicada');
});

test('e15: echo auto-responde + send con gate', async () => {
  const posts = [];
  const fetchFn = async (url, init) => {
    posts.push({ url, body: JSON.parse(init.body) });
    if (String(url).includes('getUpdates')) {
      return { ok: true, json: async () => ({ ok: true, result: [{ update_id: 1, message: { chat: { id: 111 }, from: { id: 111 }, text: 'ping' } }] }) };
    }
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 9 } }) };
  };
  await pollTelegramOnce({ fetchFn, config: { ...TG, autoRespond: true }, offsetRef: {} });
  assert.ok(posts.some((p) => String(p.url).includes('sendMessage') && p.body.text === 'eco: ping'), 'echo enviado');
  await sendTelegram({ to: '111', text: 'hola Tito' }, { fetchFn, config: TG });
  await assert.rejects(() => sendTelegram({ to: '999', text: 'x' }, { fetchFn, config: TG }), /bloqueado/, 'destino no-Tito');
  await assert.rejects(() => sendTelegram({ to: '111', text: 'x' }, { fetchFn, config: { ...TG, botToken: '' } }), /sin botToken/);
});

test('e15: tgParseUpdate + WhatsApp parse/send', async () => {
  assert.equal(tgParseUpdate({}), null);
  assert.equal(tgParseUpdate({ message: { chat: { id: 1 }, text: '  ' } }), null);
  const p = tgParseUpdate({ update_id: 5, message: { chat: { id: 7 }, from: { id: 7, first_name: 'A' }, text: 'hi', date: 1 } });
  assert.deepEqual(p, { updateId: 5, chatId: '7', fromId: '7', fromName: 'A', text: 'hi', date: 1 });
  const w = waParseWebhook({ entry: [{ changes: [{ value: { messages: [{ from: '549', text: { body: 'hola' }, id: 'm1' }] } }] }] });
  assert.deepEqual(w, { chatId: '549', fromId: '549', fromName: null, text: 'hola', messageId: 'm1' });
  assert.equal(waParseWebhook({}), null);
  const fetchFn = async () => ({ ok: true, json: async () => ({ messages: [{ id: 'w1' }] }) });
  const r = await waSend({ token: 'T', phoneId: 'P', to: '549', text: 'hola' }, { fetchFn });
  assert.ok(r.messages, 'wa send ok');
  const bad = async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'bad' } }) });
  await assert.rejects(() => waSend({ token: 'T', phoneId: 'P', to: 'x', text: 'y' }, { fetchFn: bad }), /bad/);
});
