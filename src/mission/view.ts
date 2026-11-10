// Mission Control — dashboard view. Mounts 6 cards with 5s auto-refresh.
// Usage (main hook): import { mountMissionControl } from './mission/view.ts';
//   const mc = mountMissionControl(el, { getLiveSpeakers: () => [...] });
// Degradation: each fetch fails in isolation → card shows "—", the rest lives.

import type { MissionLiveHooks } from './types.ts';
import {
  fetchAudio,
  fetchAudioDevices,
  fetchConnectivity,
  fetchLatency,
  fetchLive,
  fetchLocalDevices,
  fetchSala,
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

export interface MissionControlHandle {
  destroy: () => void;
  refresh: () => Promise<void>;
}

export interface MissionControlOptions extends MissionLiveHooks {
  /** Ms between refreshes (default 5000). */
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
      // Each card fetches in isolation: Promise.all with getters that never throw.
      const [live, work, sidecars, latency, audio, devices, audioRt, sala, conn] = await Promise.all([
        fetchLive(),
        fetchWork(),
        fetchSidecars(),
        fetchLatency(),
        fetchAudio(),
        fetchLocalDevices(),
        fetchAudioDevices(),
        fetchSala(),
        fetchConnectivity()
      ]);
      if (!alive) {
        return;
      }
      container.innerHTML =
        renderConnectivityBadge(conn) +
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
    // Background pause: saves 9 fetches/5s per hidden tab.
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
