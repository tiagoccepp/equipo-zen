/**
 * The host-neutral seam between the voice host (the Tauri desktop shell) and the
 * avatar's four-state controller.
 *
 * A host reduces whatever it observes (mic activity, TTS playback, a pending
 * Claude turn) into these three booleans; `deriveState` maps them to the avatar
 * state with a fixed priority. Keeping this pure and host-free keeps the seam
 * cheap: `tauriAdapter` produces these `VoiceSignals` transitions from Tauri
 * events; the demo drives the controller directly.
 */

import type { AvatarState } from '../avatar/AvatarController';

/**
 * Observable signals about the conversation, mapped to an avatar state. Pure and
 * unit-tested; the priority encodes the spec's behaviour: speaking overrides
 * listening overrides thinking overrides idle.
 */
export interface VoiceSignals {
  micActive: boolean;
  speaking: boolean;
  pendingResponse: boolean;
}

export function deriveState(signals: VoiceSignals): AvatarState {
  if (signals.speaking) {
    return 'speaking';
  }
  if (signals.micActive) {
    return 'listening';
  }
  if (signals.pendingResponse) {
    return 'thinking';
  }
  return 'idle';
}
