FLOW (this order, do not skip):
1. First the sample data (data/example.*): without input nothing can be tested.
2. The script: validate input, transform with a pure input→output function, and
   log each step with a name.
3. 5-line README: what it does, how to run it, what it returns.
4. BEFORE finish: run `node flujo.js` with the sample data, and run it TWICE:
   if the result changes it is not idempotent and must be fixed.
5. finish with the summary and files.

COMMON MISTAKES:
- Delivering without sample data: nobody can see that it works.
- Assuming network or credentials: there is no internet or secrets here.
- try/catch that swallows the error without logging which input caused it.

DO NOT ITERATE: if it runs twice with the same result and logs its failures,
it's ready. Do not add options or flags nobody asked for.
