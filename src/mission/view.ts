// Mission Control — vista dashboard. Monta 6 tarjetas con auto-refresh 5s.
// Uso (hook del main): import { mountMissionControl } from './mission/view.ts';
//   const mc = mountMissionControl(el, { getLiveSpeakers: () => [...] });
// Degradación: cada fetch falla aislado → tarjeta en "—", el resto vive.

import type { MissionLiveHooks } from './types.ts';
import {
  fetchAudio,
  fetchAudioDevices,
  fetchLatency,
  fetchLive,
  fetchLocalDevices,
  fetchSala,
  fetchSidecars,
  fetchWork
} from './api.ts';
import {
  renderAudio,
  renderEquipo,
  renderLatencia,
  renderSala,
  renderSidecars,
  renderTareas
} from './cards.ts';

export interface MissionControlHandle {
  destroy: () => void;
  refresh: () => Promise<void>;
}

export interface MissionControlOptions extends MissionLiveHooks {
  /** Ms entre refreshes (default 5000). */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 5000;

export function mountMissionControl(container: HTMLElement, opts: MissionControlOptions = {}): MissionControlHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const hooks: MissionLiveHooks = {
    getLiveSpeakers: opts.getLiveSpeakers,
    getVoiceActive: opts.getVoiceActive
  };
  container.classList.add('mc-grid');
  container.setAttribute('role', 'region');
  container.setAttribute('aria-label', 'Mission Control');

  let alive = true;
  let refreshing = false;

  async function refresh(): Promise<void> {
    if (!alive || refreshing) {
      return;
    }
    refreshing = true;
    try {
      // Cada tarjeta fetch aislado: Promise.all con getters que nunca tiran.
      const [live, work, sidecars, latency, audio, devices, audioRt, sala] = await Promise.all([
        fetchLive(),
        fetchWork(),
        fetchSidecars(),
        fetchLatency(),
        fetchAudio(),
        fetchLocalDevices(),
        fetchAudioDevices(),
        fetchSala()
      ]);
      if (!alive) {
        return;
      }
      container.innerHTML =
        renderEquipo(live, work, hooks) +
        renderTareas(work) +
        renderSidecars(sidecars) +
        renderLatencia(latency) +
        renderAudio(audio, devices, audioRt) +
        renderSala(sala);
    } finally {
      refreshing = false;
    }
  }

  void refresh();
  const timer = setInterval(() => {
    // Pausa en background: ahorra 7 fetches/5s por pestaña oculta.
    if (!document.hidden) {
      void refresh();
    }
  }, intervalMs);

  return {
    refresh,
    destroy: () => {
      alive = false;
      clearInterval(timer);
    }
  };
}
