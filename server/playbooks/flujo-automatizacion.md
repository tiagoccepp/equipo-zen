FLUJO (este orden, sin saltear):
1. Primero los datos de ejemplo (datos/ejemplo.*): sin entrada no se prueba nada.
2. El script: valida la entrada, transforma con función pura entrada→salida y
   registra cada paso con nombre.
3. README de 5 líneas: qué hace, cómo se corre, qué devuelve.
4. ANTES de finish: comando `node flujo.js` con los datos de ejemplo, y corrélo DOS
   veces: si el resultado cambia no es idempotente y hay que arreglarlo.
5. finish con el resumen y los archivos.

ERRORES DE SIEMPRE:
- Entregar sin datos de ejemplo: nadie puede ver que funcione.
- Suponer red o credenciales: acá no hay internet ni secretos.
- try/catch que se come el error sin registrar qué entrada lo produjo.

NO ITERAR: si corre dos veces con el mismo resultado y deja registro de sus fallas,
está listo. No agregues opciones ni banderas que nadie pidió.
