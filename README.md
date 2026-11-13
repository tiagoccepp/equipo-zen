# J.A.B.S — Just A Better System

> A local-first, voice-forward AI workspace: talk to Pablo, run projects with dedicated agent teams, and keep work moving with verifiable execution.

J.A.B.S is a desktop/web app (Tauri + Node + TypeScript/vanilla UI) built around one idea: **your assistant should feel present, not like a chat tab**. You start in **Home** with Pablo, your personal assistant. When work becomes complex, you open a **Project** and give it a dedicated team that can plan, execute, and verify in parallel.

## Why it’s interesting

- **Home + Projects model (in progress):** personal assistant by default, project-scoped teams for engineering/product flows.
- **Voice-first interaction:** continuous listening/speaking pipeline with local/cloud fallbacks (Parakeet/Whisper/Groq/Deepgram STT, Supertonic/Deepgram/Edge/Piper TTS), barge-in and turn handling.
- **Operational console UI:** dense dark interface with live activity stream, agent presence/orbs, jobs, manager, and settings.
- **Real work engine:** projects, tasks, work runs, tool execution, deterministic verification hooks, approvals/permissions, and workspace outputs under `workspace/`.
- **Generative 3D stage (spec-driven):** declarative `SceneSpec` modules for agent-generated/explodable 3D explanations (demo: V6 engine) with safe validation and isolated rendering.
- **JABS presence/insights modules:** ambient pulse, nudges, session brief, and quick-action primitives (`src/presence`, `src/jabs`) designed for low-overhead awareness.
- **Local-first runtime:** SQLite state, local sidecars, desktop packaging (Tauri), and configurable providers/models/devices.

## Current status (honest)

This is an active build with strong foundations and ongoing integration work.

- **Working now:** backend API/server, project/company/task data model, voice/runtime plumbing, desktop shell, console/jobs/manager/settings views, frontend build, new UI direction, and multiple new feature modules/reports.
- **Partially wired / in progress:** full Home-vs-Projects scoping in runtime, complete Settings coverage for every backend capability, end-to-end wiring of some new modules (scene/presence/insights/channel/spawner/checkpoint paths), and full English/QA polish across all legacy text and docs.
- **Known gaps:** some backend capabilities are API-only; CI/release workflow needs alignment with `desktop-tauri`; Windows sidecar packaging and full cross-platform verification are not complete in this environment.

See `/home/tito/research/` for audits, plans, and feature reports generated during development.

## Quick start

```bash
npm install
npm run dev
```

- Frontend: Vite dev server (URL printed by Vite)
- Backend: Node server on loopback (default `127.0.0.1:8787`, proxied in dev)

Useful scripts:

```bash
npm run typecheck
npm test
npm run build
npm run build:desktop -- deb
```

## Architecture (high level)

- `src/` — UI (vanilla TS), voice client, FX/orbs/stage, jobs/manager/mission views, presence/JABS modules
- `server/` — HTTP/WS server, agent runtime, store/SQLite, work engine, permissions/approvals, voice/sidecars, tools/MCP/channels/scheduler
- `shared/` — protocol/types shared across client and server
- `src-tauri/` — desktop app shell, tray/single-instance behavior, embedded sidecar runtime
- `workspace/` — project deliverables and generated artifacts (runtime data)
- `tests/` — `node:test` suite
- `research/` docs (in `/home/tito/research`) — audits, design notes, integration reports

## Configuration

- Settings UI exposes core LLM/STT/TTS/audio/energy/split controls (coverage varies by build).
- Provider keys and runtime options can be configured via environment and/or persisted settings (secrets are masked in public settings responses).
- Local voice sidecars (Supertonic/Piper/Parakeet/Whisper) can be enabled for lower-latency, offline-capable voice.

## Desktop

J.A.B.S ships as a Tauri app with an embedded Node backend/sidecar. Linux packaging is supported via the desktop build script; Windows/macOS artifacts depend on CI/toolchain availability.

```bash
npm run build:desktop -- deb,appimage
```

## Research and product direction

- Comparable systems and patterns: `/home/tito/research/inspiration-2026-11-13.md`
- Monetization/pricing notes: `/home/tito/research/monetization-2026-11-13.md`
- 3D stage spec/report: `/home/tito/research/scene3d-2026-11-13.md`
- Presence and JABS innovations: `/home/tito/research/presence-2026-11-13.md`, `/home/tito/research/jabs-innovations-2026-11-13.md`
- Settings/latency/home-projects audits and plans: `/home/tito/research/settings-audit-2026-11-13.md`, `/home/tito/research/latency-audit-2026-11-13.md`, `/home/tito/research/home-projects-2026-11-13.md`

## License / notes

Internal/active development project. Validate provider terms, voice model licenses, and asset licenses (especially for pixel-art/3D assets) before redistribution.
