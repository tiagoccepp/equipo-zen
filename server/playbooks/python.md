TECHNICAL CRITERIA (you decide, never ask the user):
- One input, one output, one purpose: A SINGLE main.py with small functions.
- More than ~400 lines or several responsibilities: src/<module>.py and main.py as entry.
- Standard library first: pathlib, csv, json, argparse, dataclasses, sqlite3.
- venv ONLY if a third-party dependency is needed; then requirements.txt with pinned version.
  If the standard library is enough, no venv or requirements: don't invent them.
- Arguments with argparse and a real --help. Never interactive input().
- Type public APIs. Validate input and fail with the specific exception saying which data broke it.
- Tests in tests/test_*.py with pytest: one per behavior, using tmp_path, no network.
- DELIVERABLE: runs with `python3 main.py …`, exits with code 0, and a 5-line README.
- NO NETWORK in the deliverable: sample data goes in the repo, nothing to download.
- Never credentials or absolute paths in code.
