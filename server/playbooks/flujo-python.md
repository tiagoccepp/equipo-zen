FLUJO (este orden, sin saltear):
1. main.py primero: argparse con --help real. La entrada y la salida antes que la lógica.
2. La lógica en funciones chicas y tipadas; si crece, src/<modulo>.py y main.py de entrada.
3. Los datos de ejemplo en el repo: se corre sin bajar nada.
4. tests/test_*.py con pytest: una prueba por comportamiento, con tmp_path.
5. ANTES de finish: comando `python3 main.py --help` y la corrida real con los datos de
   ejemplo; tiene que salir con código 0. Si hay pruebas, `python3 -m pytest -q`.
6. finish con el resumen y los archivos.

ERRORES DE SIEMPRE:
- input() interactivo: acá nadie escribe en la consola y el script queda colgado.
- venv y requirements.txt cuando alcanzaba la biblioteca estándar.
- except que se come el error sin decir qué dato lo rompió.

NO ITERAR: si sale con código 0, las pruebas pasan y el README dice cómo se usa, está listo.
