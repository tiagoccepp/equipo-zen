// Additive integration helpers for Presence HUD/briefing and JABS ambient pulse.
// Lazy-load friendly; designed to be called from app.ts integration points.

import type { PresenceSnapshot, Signal, Briefing } from '../presence/signals.ts';

export interface PresenceIntegrationHandle {
  dispose: () => void;
}

export interface JabsIntegrationHandle {
  dispose: () => void;
  refresh: () => Promise<unknown>;
}

/**
 * Mount a compact presence HUD and an optional briefing panel.
 * Uses startPresence (polling) + createPresenceHud/createBriefingPanel.
 */
export async function mountConsolePresence(opts: {
  hudMount: HTMLElement;
  briefingMount?: HTMLElement;
}): Promise<PresenceIntegrationHandle> {
  // @ts-expect-error - Vite CSS side-effect import
  await import('../presence/presence.css');
  const presence = await import('../presence/presence.ts');
  const hudMod = await import('../presence/hud.ts');
  const briefingMod = await import('../presence/briefing.ts');
  const signalsMod = await import('../presence/signals.ts');

  const briefing = opts.briefingMount ? briefingMod.createBriefingPanel({ mount: opts.briefingMount }) : null;
  const hud = hudMod.createPresenceHud({
    mount: opts.hudMount,
    onBriefingToggle: (open) => { if (briefing) (open ? briefing.open() : briefing.close()); }
  });

  const handle = presence.startPresence({
    onSnapshot: (snapshot: PresenceSnapshot) => {
      // Minimal HUD metrics; host can enrich by mapping snapshot fields.
      const connectivity = snapshot.connectivity as { ok?: boolean } | undefined;
      hud.update({
        latencyMs: snapshot.latencyMs ?? null,
        latencyOk: connectivity ? connectivity.ok !== false : null,
        lastActivityAt: typeof snapshot.lastActivityAt === 'number' ? snapshot.lastActivityAt : null
      });
    },
    onSignals: (signals: Signal[]) => {
      hud.setSignals(signals);
    },
    onBriefing: (b: Briefing) => {
      briefing?.setBriefing(b);
      if (briefing && presence.shouldShowReturnBriefing(presence.getLastSeen(), Date.now())) {
        briefing.open();
      }
    },
    lastSeenAt: () => presence.getLastSeen()
  });

  return {
    dispose: () => {
      handle.stop();
      hud.destroy();
      briefing?.destroy();
    }
  };
}

/**
 * Mount JABS ambient pulse UI blocks (pulse/brief/nudges/actions).
 * Any mount element may be omitted.
 */
export async function mountJabsAmbient(opts: {
  pulseMount?: HTMLElement | null;
  briefMount?: HTMLElement | null;
  nudgesMount?: HTMLElement | null;
  actionsMount?: HTMLElement | null;
  companyId?: string | null;
  onAction?: (action: unknown) => void;
}): Promise<JabsIntegrationHandle> {
  // @ts-expect-error - Vite CSS side-effect import
  await import('../jabs/jabs.css');
  const ambient = await import('../jabs/ambient.ts');

  const pulse = new ambient.AmbientPulse({ companyId: opts.companyId ?? null });
  const unsub = pulse.subscribe((state) => {
    if (opts.pulseMount) ambient.renderPulse(opts.pulseMount, state.pulse);
    if (opts.briefMount) ambient.renderBrief(opts.briefMount, state.brief);
    if (opts.nudgesMount) ambient.renderNudges(opts.nudgesMount, state.nudges, (key) => pulse.dismissNudge(key));
    if (opts.actionsMount) ambient.renderActions(opts.actionsMount, state.actions, (a) => opts.onAction?.(a));
  });

  pulse.start();
  return {
    pulse,
    refresh: () => pulse.refresh(),
    dispose: () => {
      unsub();
      pulse.stop();
    }
  } as JabsIntegrationHandle & { pulse: typeof pulse };
}
