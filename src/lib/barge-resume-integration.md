# Barge-resume integration notes (T3)

Module: `src/lib/barge-resume.ts` (pure/stateful, no browser deps).  
Goal: on **false** barge-in keep pending speech and resume from the next pending segment; on **real** interruption/new turn drop.

## Ownership / wiring

- Keep one `BargeResumeBuffer<ReplaySegment>` per active output stream/turn (or a single buffer reset per turn). `beginTurn(turnId)` on agent speech start; `reset()`/`cancel()` on session stop.
- Define a replay descriptor that can re-create the original VoiceOut call, e.g.
  `{ kind: 'mp3'|'pcm'; data: string; sampleRate?: number; tag: unknown }`.
- `enqueue(...)` must happen when a segment is accepted into the playback pipeline (same order as sent to `VoiceOut.enqueuePcm/playMp3`).
- `markStarted(idOrTag)` must be driven by `VoiceOut.onChunkStart(tag)` (scheduled/audible-start boundary). Use stable segment ids and also pass the chunk `tag` so either can match.

## Decision flow

1. **Interrupt detected** (barge-in/explicit interrupt): `voiceOut.flush()` (or T1 cancel-by-turnId) then `buffer.interrupt()`.
2. Classify interruption (T2/turn-taking + context): if false backchannel/noise and `result.canResume` → `buffer.resume()` and re-enqueue returned replay payloads in order; else → `buffer.cancel()` (+ notify server real interrupt as today).
3. **Turn completed normally** (`onDrained` / final segment done with no pending): `buffer.cancel()` or `buffer.reset()` for the turn to prevent stale resume.
4. **New turn supersedes**: `buffer.beginTurn(newTurnId)` drops prior state.

## VoiceOut considerations

- `flush()` increments `epoch` and drops queued/decoding work without firing `onDrained`; resume must re-enqueue pending segments explicitly.
- Started segment at interruption is treated as cut (not replayed) — matches "continue from next pending segment".
- Rapid toggles: safe; repeated `interrupt()` while interrupted is idempotent-ish in effect (pending remainder unchanged), `resume()` only acts from `interrupted` with pending items.
- Coordinate with T1: if T1 introduces `turnId`-scoped queues/cancellation, buffer `beginTurn(turnId)` should align and cancel/resume decisions must use the same turn identity.

## Helpers exported

- `createBargeResumeBuffer<T>()` — stateful buffer.
- `decideResumeAction(isFalseBargeIn, hasPending)` → `'resume' | 'drop'`.
- `replayPayloads(segments)` → payload array in order.
