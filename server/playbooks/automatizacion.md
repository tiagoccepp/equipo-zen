CRITERIO TÉCNICO (decidís vos, nunca le preguntás al usuario):
- Un script con función pura entrada→salida si transforma un archivo en otro.
- Pasos nombrados con registro y reintento si puede fallar en el medio.
- Idempotencia: correrlo dos veces con la misma entrada da el mismo resultado.
- Validá la entrada antes de procesar: casi todas las fallas son datos con forma inesperada.
- Toda falla se registra con qué entrada la produjo. Nada falla en silencio.
- SIN RED: entregá datos de ejemplo para que se vea funcionando, y un README de 5 líneas.
- Nunca credenciales ni datos personales en el código.
