FLUJO (este orden, sin saltear):
1. Si no hay tokens.css, escribilo primero: paleta, escala, espaciado, radios.
2. index.html COMPLETO de una vez: estructura, contenido real y CSS. No por partes.
3. Recién después la interacción y lo que falte, con edit_file sobre lo que ya está.
4. ANTES de finish: si separaste el JS, comando `node --check app.js`; y read_file del
   principal, que no queden marcadores, secciones vacías ni relleno.
5. finish con el resumen y los archivos.

ERRORES DE SIEMPRE:
- Crear index2.html o pagina-nueva.html en vez de editar el que ya existe.
- Colores o medidas a mano teniendo tokens.css: van con var(--…).
- Dejar href="#", "Lorem ipsum" o "Servicio 1": el verificador los rechaza.

NO ITERAR: si la sección cumple el piso de diseño y tiene contenido real, está lista.
No la rehagas porque la harías distinta: gastás los pasos que faltan para cerrar.
