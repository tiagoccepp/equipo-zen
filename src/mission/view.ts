// Mission Control — dashboard view. Mounts 6 cards with 5s auto-refresh.
// Usage (main hook): import { mountMissionControl } from './mission/view.ts';
// const mc = mountMissionControl(el, { getLiveSpeakers: () => [...] });
// Degradation: each fetch fails in isolation → card shows "—", the rest lives.

import type { MissionLiveHooks } from './types.ts';
import {
 fetchAudioDevices,
 fetchConnectivity,
 fetchLatency,
 fetchLive,
 fetchLocalDevices,
 fetchSalaAudioBundle,
 fetchSidecars,
 fetchWork
} from './api.ts';
import {
 renderAudio,
 renderConnectivityBadge,
 renderEquipo,
 renderLatencia,
 renderSala,
 renderSidecars,
 renderTareas
} from './cards.ts';
import { replaceInnerHtmlIfChanged } from '../lib/dom-batch.ts';
import { canPollElement, payloadSignature } from '../lib/polling.ts';
import { mountOffice } from './office/index.ts';

export interface MissionControlHandle {
 destroy: () => void;
 refresh: () => Promise<void>;
}

export interface MissionControlOptions extends MissionLiveHooks {
 /** Ms between refreshes (default 5000). */
 intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 5000;
const CONNECTIVITY_EVERY_N_REFRESHES = 6; // ~30s by default, decouples slow probe from hot path

export function mountMissionControl(container: HTMLElement, opts: MissionControlOptions = {}): MissionControlHandle {
 const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
 const hooks: MissionLiveHooks = {
 getLiveSpeakers: opts.getLiveSpeakers,
 getVoiceActive: opts.getVoiceActive
 };
 container.classList.remove('mc-grid');
 container.classList.add('mc-mission-root');
 container.setAttribute('role', 'region');
 container.setAttribute('aria-label', 'Mission Control');
 container.innerHTML = `
 <section class="mc-card mc-office-section" aria-label="Project Office">
 <header class="mc-card-head"><span class="mc-emoji" aria-hidden="true"></span><h3>Project Office</h3></header>
 <div class="mc-card-body mc-office-body"></div>
 </section>
 <div class="mc-cards-slot mc-grid"></div>`;
 const cardsSlot = container.querySelector('.mc-cards-slot') as HTMLElement;
 const officeBody = container.querySelector('.mc-office-body') as HTMLElement;

 const office = mountOffice(officeBody, {
 getLiveSpeakers: () => { try { return hooks.getLiveSpeakers?.() || []; } catch { return []; } },
 getVoiceActive: () => { try { return hooks.getVoiceActive?.() ?? false; } catch { return false; } }
 });

 let alive = true;
 let refreshing = false;
 let lastHtml = '';
 let lastSignature = '';
 let refreshCount = 0;
 let lastConnectivity: Awaited<ReturnType<typeof fetchConnectivity>> = null;

 async function refresh(): Promise<void> {
 if (!alive || refreshing || !canPollElement(container)) {
 return;
 }
 refreshing = true;
 try {
 refreshCount += 1;
 const shouldRefreshConnectivity = refreshCount === 1 || refreshCount % CONNECTIVITY_EVERY_N_REFRESHES === 0;
 const connPromise = shouldRefreshConnectivity ? fetchConnectivity() : Promise.resolve(lastConnectivity);

 // Each card fetches in isolation: Promise.all with getters that never throw.
 const [live, work, sidecars, latency, salaAudio, devices, audioRt, conn, officeDone] = await Promise.all([
 fetchLive(),
 fetchWork(),
 fetchSidecars(),
 fetchLatency(),
 fetchSalaAudioBundle(),
 fetchLocalDevices(),
 fetchAudioDevices(),
 connPromise,
 office.refresh().then(() => true, () => false)
 ]);
 void officeDone;
 if (!alive) {
 return;
 }
 if (shouldRefreshConnectivity) {
 lastConnectivity = conn;
 }
 const effectiveConn = conn ?? lastConnectivity;
 const audio = salaAudio.audio;
 const sala = salaAudio.sala;

 const signature = payloadSignature({
 live,
 work,
 sidecars,
 latency,
 sala,
 audio,
 devices,
 audioRt,
 effectiveConn,
 speakers: (() => { try { return hooks.getLiveSpeakers?.() || []; } catch { return []; } })(),
 voiceOn: (() => { try { return hooks.getVoiceActive?.() ?? null; } catch { return null; } })()
 });
 if (signature === lastSignature) {
 return;
 }

 const html =
 renderConnectivityBadge(effectiveConn) +
 renderEquipo(live, work, hooks) +
 renderTareas(work) +
 renderSidecars(sidecars) +
 renderLatencia(latency) +
 renderAudio(audio, devices, audioRt) +
 renderSala(sala);
 const res = replaceInnerHtmlIfChanged(cardsSlot, html, lastHtml);
 if (res.changed) {
 lastHtml = html;
 lastSignature = signature;
 }
 } finally {
 refreshing = false;
 }
 }

 void refresh();
 const timer = setInterval(() => {
 // Background/mounted pause: saves fetches when hidden or view detached.
 if (canPollElement(container)) {
 void refresh();
 }
 }, intervalMs);

 return {
 refresh,
 destroy: () => {
 alive = false;
 clearInterval(timer);
 office.destroy();
 }
 };
}
