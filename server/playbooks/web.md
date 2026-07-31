CRITERIO TÉCNICO (decidís vos, nunca le preguntás al usuario):
- Sitio de contenido, landing o menú: un solo index.html con el CSS embebido.
- Si necesita interacción (acordeón, pestañas, filtro, parallax): JS a mano, sin librerías.
- Si pasa de ~600 líneas: separá styles.css y app.js.
- Formularios: validación nativa de HTML primero; JS solo para lo que falte.
- Grid para la estructura, flex para alinear. rem para texto y espacios.
- Se diseña desde 360px hacia arriba. Nunca scroll horizontal.
- SIN INTERNET donde esto se abre: nada de CDN, fuentes remotas ni imágenes por URL.
  Usá SVG en línea, degradados CSS y la pila tipográfica del sistema.
