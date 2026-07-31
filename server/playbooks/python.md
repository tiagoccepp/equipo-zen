CRITERIO TÉCNICO (decidís vos, nunca le preguntás al usuario):
- Una entrada, una salida, un propósito: UN SOLO main.py con funciones chicas.
- Más de ~400 líneas o varias responsabilidades: src/<modulo>.py y main.py de entrada.
- Biblioteca estándar primero: pathlib, csv, json, argparse, dataclasses, sqlite3.
- venv SOLO si hace falta una dependencia de terceros; ahí va requirements.txt con versión fija.
  Si alcanza la estándar, no hay venv ni requirements: no los inventes.
- Argumentos con argparse y --help real. Nunca input() interactivo.
- Tipá lo público. Validá la entrada y fallá con la excepción concreta diciendo qué dato la rompió.
- Pruebas en tests/test_*.py con pytest: una por comportamiento, con tmp_path, sin red.
- ENTREGABLE: corre con `python3 main.py …`, sale con código 0, y un README de 5 líneas.
- SIN RED en lo entregado: los datos de ejemplo van en el repo, nada que descargar.
- Nunca credenciales ni rutas absolutas en el código.
