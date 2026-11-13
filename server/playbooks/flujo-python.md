FLOW (this order, do not skip):
1. main.py first: argparse with a real --help. Input and output before logic.
2. Logic in small, typed functions; if it grows, src/<module>.py and main.py as entry.
3. Sample data in the repo: it runs without downloading anything.
4. tests/test_*.py with pytest: one test per behavior, using tmp_path.
5. BEFORE finish: run `python3 main.py --help` and the real run with sample data;
   it must exit with code 0. If there are tests, `python3 -m pytest -q`.
6. finish with the summary and files.

COMMON MISTAKES:
- Interactive input(): nobody types in the console here and the script hangs.
- venv and requirements.txt when the standard library is enough.
- except that swallows the error without saying which data broke it.

DO NOT ITERATE: if it exits with code 0, tests pass, and the README explains how to use it, it's ready.
