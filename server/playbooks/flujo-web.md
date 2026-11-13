FLOW (this order, do not skip):
1. If tokens.css does not exist, write it first: palette, scale, spacing, radii.
2. index.html COMPLETE in one go: structure, real content, and CSS. Not in parts.
3. Only after that add interaction and what's missing, using edit_file on what exists.
4. BEFORE finish: if you separated JS, run `node --check app.js`; and read_file the
   main file to ensure no markers, empty sections, or placeholders.
5. finish with the summary and files.

COMMON MISTAKES:
- Creating index2.html or new-page.html instead of editing the existing one.
- Hardcoded colors or measurements when tokens.css exists: use var(--…).
- Leaving href="#", "Lorem ipsum", or "Service 1": the verifier rejects them.

DO NOT ITERATE: if the section meets the design floor and has real content, it's ready.
Don't redo it because you'd make it different: you waste steps needed to close.
