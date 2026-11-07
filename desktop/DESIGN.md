# DESIGN.md — Equipo Desktop «Consola Jarvis»

Contrato de diseño de la app de escritorio (Tauri Win/Linux/Mac) + tema
oscuro global. Desde v2 (07/11) TODA la app es oscura: home estilo Lovable
(sidebar + héroe con mesh tenue + composer gigante) y workspace estilo
Paperclip (3 columnas: agentes / conversación / contexto), acento arc
y Unbounded. El skin desktop vive bajo `body.desktop`, el orbe en
`orb.html`, y el tema global en `src/theme.css`. Todo cambio visual
posterior obedece a este archivo. Tokens: `.audit/*/TOKENS.md`.

## Brief

- Producto: el equipo IA como app instalada. Acción primaria por pantalla:
  home → «⚡ Hablar con el equipo» (1 clic a la reunión); orbe → expandir /
  hablar; llamada → conversar por voz.
- Tono: consola de comando serena (Jarvis), no sci-fi ruidoso. Oscuro,
  preciso, una sola luz.

## Paleta (OKLCH → hex)

- `--jb-void: #07090D` fondo principal (casi negro azulado, NO #0B0B0B).
- `--jb-panel: #0E1319` paneles y tarjetas.
- `--jb-line: #1E2833` bordes y hairlines.
- `--jb-text: #E8E6DF` blanco cálido (texto).
- `--jb-dim: #9AA4B0` texto secundario.
- `--jb-arc: #38D1FF` ACENTO único: azul arc-reactor. Usos visibles por
  pantalla ≤2 (orbe + 1 CTA o estado). Variante sobre panel claro: ninguna —
  el skin desktop es siempre oscuro.
- Estados: ok `#3FD08C`, warn `#F5A524`, danger `#F2555A` (solo puntos y
  texto pequeño).

Contraste verificado sobre pares rendidos: texto/blanco-cálido sobre void
≈15:1; dim sobre void ≈7:1; arc solo para gráfico grande y labels ≥14px
bold (≈3:1 decorativo, nunca texto chico).

## Tipografía (self-hosted, `src/assets/fonts/`)

- Display/orbe/wordmark: **Unbounded 600–800** (latin woff2, `swap`).
- Body/UI desktop: la pila existente de la app (no se toca).
- Mono/datos: la existente.
- Escala: hero 44–64px; h1 vistas 28px; body 15px; labels 12px uppercase con
  tracking solo en la palabra «EQUIPO» y estados del orbe.

## Layout

- Concepto: «panel de vuelo con una sola luz». Fondo void, paneles con
  hairline 1px, radio 14px paneles / 999px orbe y pills, sin sombras
  difusas (una sola sombra dura bajo el orbe: `0 18px 50px rgb(0 0 0 /.55)`).
- Home desktop (ASCII):
  ```
  ┌──────────────────────────────────────┐
  │ ● ● ●   EQUIPO · CONSOLA      [tray] │  ← titlebar propia (frameless)
  │                                      │
  │   Tu equipo ya está en la sala.      │  ← hero Unbounded 56px
  │   Seis especialistas. Una reunión.   │
  │   [⚡ Hablar con el equipo]          │  ← CTA único arc
  │                                      │
  │   EMPRESAS (grid, quiet)             │
  └──────────────────────────────────────┘
  ```
- Idea no-convencional: el orbe ES la app minimizada — no un icono de
  bandeja mudo: pulsa al hablar, escucha al click, arrastra a cualquier
  borde. La ventana principal es «la sala»; el orbe es «el intercom».
- Cristal del orbe (gusto Tito 07/11, verbatim): glass3d con blur 5px +
  brightness 1.38 + saturate 1.6, grano sutil y bisel interior. Ruido
  self-hosted en data URI (sin red externa). Núcleo del canvas translúcido
  para que el cuerpo lo dé el cristal.

## Motion (≤6)

- Orbe: respiración idle (scale 1→1.04, 4s, ease-in-out, transform only);
  hablando: anillos concéntricos opacity; escuchando: pulso arc.
- Ventana principal: assembly del hero (fade+rise 12px, 300ms) al entrar.
- Hover: color/border ≥.4s, sin tilt ni glows que sigan el cursor.
- Todo responde a input mid-animación; `prefers-reduced-motion` congela el
  orbe en un círculo estático con punto de estado.
- Ventana orbe: transiciones opacity/transform only (compositor).

## Principios (qué la hace distinta)

1. Una sola luz: todo quieto menos el orbe/CTA arc.
2. La app cabe en 96px: el orbe flotante es ciudadano de primera.
3. Frameless con titlebar propia mínima (drag region + 3 botones).
4. Español rioplatense, segunda persona, CTAs que nombran la acción.
5. Cero setup visible: primer arranque → «Hablar» en <10s.

## Ban-list self-check

- Fuente identity: Unbounded (display) — NO Inter/system como idea visual.
- Color: azul arc sobre void, NO gradiente púrpura→azul, NO verde-ácido.
- Sin eyebrow caps sobre cada heading (solo «EQUIPO · CONSOLA» en titlebar
  y estados del orbe, info real). Sin middots meta, sin «→» en CTAs
  (el CTA usa ⚡, verbo en el label), sin cards idénticas con la misma sombra.
- Revisado vs. demos KonsensWebs: pairing Unbounded+body-app no usado antes.
