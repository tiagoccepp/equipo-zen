TECHNICAL CRITERIA (you decide, never ask the user):
- A script with a pure input→output function if it transforms one file into another.
- Named steps with logging and retry if it can fail in the middle.
- Idempotence: running it twice with the same input gives the same result.
- Validate input before processing: most failures are unexpectedly shaped data.
- Every failure is logged with the input that produced it. Nothing fails silently.
- NO NETWORK: deliver sample data so it can be seen working, and a 5-line README.
- Never credentials or personal data in code.
