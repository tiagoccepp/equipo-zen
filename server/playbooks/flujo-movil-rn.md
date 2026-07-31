FLUJO (este orden, sin saltear):
1. ANDAMIÁ con la herramienta oficial, nunca a mano:
   comando `npx create-expo-app@latest . --template blank`
2. src/theme.js: colores, tipografía y espaciado. Fuente única.
3. Las pantallas en src/screens/, lo reutilizable en src/components/.
4. Recién ahí el punto de entrada (App.js/App.jsx): borrá lo de la plantilla y
   montá TUS pantallas.
5. ANTES de finish: comando `npx tsc --noEmit`. Si falla, arreglá y repetilo.
6. finish con el resumen y los archivos.

ERRORES DE SIEMPRE:
- Dejar App.js con la pantalla por defecto de Expo mientras el trabajo vive en
  src/screens/: se abre la app y se ve el cartel de Expo, no el producto.
- div, span o className: esto no es una web y no arranca.
- Estilos sueltos en vez de StyleSheet.create con valores de theme.js.

NO ITERAR: si compila, navega y usa el tema, está lista. Nada de librerías extra.
