# TOKENS.md — Lovable (lovable.dev)

Dirección: **artful consumer** claro. Home = sidebar + héroe con mesh
gradient vibrante + saludo personal + COMPOSER GIGANTE centrado + grid de
proyectos en cards redondeadas. Docs limpias de 3 columnas.

## Paleta + tipo (de los bundles CSS + capturas)
- Display: `Camera Plain Variable` (grotesca geométrica)
- Body: system sans (`ui-sans-serif, system-ui…`)
- Mono: `Roboto Mono Variable`
- Mesh gradient: `#ff66f4` `#fd49a8` `#fb65c2` `#f388de` (rosas) +
  `#7491ff` (periwinkle) + naranja cálido + `#f4bf75` (tan)
- Base light: crema `#f5f4ef`-ish, cards blancas, sombras suaves
- Dark: `#1b1b1a` / `#0f172a`, gris `#767676` / `#777771`
- Prompt-box: radio grande (~20px), sombra suave, acciones abajo
  (+ / modo Build⌄ / mic / send circular)

## Patrones que copiamos (remix oscuro)
- Sidebar: logo + workspace switcher + nav + sección Projects + Recents +
  cards promo abajo + avatar footer
- Héroe: saludo «Ready to build, {nombre}?» + pill de novedad
- Composer gigante como acción primaria (1 campo → todo)
- Tabs de proyectos (My projects / Recently viewed / Shared / Templates)
- Mesh gradient como fondo del héroe (versión oscura: arc + magenta tenue)

## Veredicto auditoría (subagente, 07/11)
Top 3 para app chat-first oscura: 1) orbe = prompt colapsado que expande
a prompt box oscuro sobre mesh tenue (patrón OG), 2) mode picker
Chat/Plan/Build literal dentro del prompt, 3) reunión = chat 400px +
canvas + toolbar flotante con snap. Brand families: bubblegum `#b517a0`,
flamingo `#b8004c`, ocean `#1e52f1`/`#4d91ff`; dark real bg `#1b1b1b`,
depth `#0a0a0a`; botones «táctiles» (5–6 inset shadows), pills 20–24px.
