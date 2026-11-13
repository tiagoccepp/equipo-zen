# DESIGN.md — J.A.B.S Desktop "Jarvis Console"

Design contract for the desktop app (Tauri Win/Linux/Mac) + global dark theme. Since v2 (07/11) the ENTIRE app is dark: home in Lovable style (sidebar + hero with subtle mesh + giant composer) and workspace in Paperclip style (3 columns: agents / conversation / context), arc accent and Unbounded. The desktop skin lives under `body.desktop`, the orb in `orb.html`, and the global theme in `src/theme.css`. Every later visual change must follow this file. Tokens: `.audit/*/TOKENS.md`.

## Brief

- Product: the AI team as an installed app. Primary action per screen: home → "⚡ Talk to the team" (1 click to the meeting); orb → expand / talk; call → converse by voice.
- Tone: serene command console (Jarvis), not noisy sci-fi. Dark, precise, a single light.

## Palette (OKLCH → hex)

- `--jb-void: #07090D` main background (bluish near-black, NOT #0B0B0B).
- `--jb-panel: #0E1319` panels and cards.
- `--jb-line: #1E2833` borders and hairlines.
- `--jb-text: #E8E6DF` warm white (text).
- `--jb-dim: #9AA4B0` secondary text.
- `--jb-arc: #38D1FF` single ACCENT: arc-reactor blue. Visible uses per screen ≤2 (orb + 1 CTA or status). Variant on light panel: none — the desktop skin is always dark.
- States: ok `#3FD08C`, warn `#F5A524`, danger `#F2555A` (only dots and small text).

Contrast verified on rendered pairs: warm white text over void ≈15:1; dim over void ≈7:1; arc only for large graphics and labels ≥14px bold (≈3:1 decorative, never small text).

## Typography (self-hosted, `src/assets/fonts/`)

- Display/orb/wordmark: **Unbounded 600–800** (latin woff2, `swap`).
- Desktop body/UI: the app's existing stack (not changed).
- Mono/data: the existing one.
- Scale: hero 44–64px; view h1 28px; body 15px; labels 12px uppercase with tracking only on the word "J.A.B.S" and orb states.

## Layout

- Concept: "flight panel with a single light". Void background, panels with 1px hairline, radius 14px panels / 999px orb and pills, no diffuse shadows (a single hard shadow under the orb: `0 18px 50px rgb(0 0 0 /.55)`).
- Desktop home (ASCII):
  ```
  ┌──────────────────────────────────────┐
  │ ● ● ●   J.A.B.S · CONSOLE    [tray]  │  ← custom titlebar (frameless)
  │                                      │
  │   Your team is already in the room.  │  ← hero Unbounded 56px
  │   Six specialists. One meeting.      │
  │   [⚡ Talk to the team]              │  ← single arc CTA
  │                                      │
  │   COMPANIES (grid, quiet)            │
  └──────────────────────────────────────┘
  ```
- Non-conventional idea: the orb IS the minimized app — not a mute tray icon: it pulses when speaking, listens on click, drags to any edge. The main window is "the room"; the orb is "the intercom".
- Orb glass (Tito's preference 07/11, verbatim intent): glass3d with blur 5px + brightness 1.38 + saturate 1.6, subtle grain and inner bevel. Noise self-hosted in data URI (no external network). Canvas core translucent so the body is provided by the glass.

## Motion (≤6)

- Orb: idle breathing (scale 1→1.04, 4s, ease-in-out, transform only); speaking: concentric rings opacity; listening: arc pulse.
- Main window: hero assembly (fade+rise 12px, 300ms) on entry.
- Hover: color/border ≥.4s, no tilt or cursor-following glows.
- Everything responds to input mid-animation; `prefers-reduced-motion` freezes the orb into a static circle with a status dot.
- Orb window: opacity/transform transitions only (compositor).

## Principles (what makes it distinct)

1. A single light: everything quiet except the orb/arc CTA.
2. The app fits in 96px: the floating orb is a first-class citizen.
3. Frameless with a minimal custom titlebar (drag region + 3 buttons).
4. Clear, direct language; CTAs name the action.
5. Zero visible setup: first launch → "Talk" in <10s.

## Ban-list self-check

- Font identity: Unbounded (display) — NOT Inter/system as the visual idea.
- Color: arc blue on void, NO purple→blue gradient, NO acid green.
- No eyebrow caps above every heading (only "J.A.B.S · CONSOLE" in the titlebar and orb states, real info). No meta middots, no "→" in CTAs (the CTA uses ⚡, verb in the label), no identical cards with the same shadow.
- Reviewed against KonsensWebs demos: Unbounded+app-body pairing not used before.
