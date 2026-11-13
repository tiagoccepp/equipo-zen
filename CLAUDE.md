# Simulations — code guide

Local app for simulating technology studios with AI employees. You enter a company, open a **project**, and inside the project you converse by voice or text with the team, which later **produces real deliverables** in the background.

This document is for anyone (person or model) who needs to modify the code. It does not repeat what the code already says: it explains **why** it is built this way and which invariants must not be broken.

## Hierarchy rules

```
Company (companies)
  └── Project (goals, kind='proyecto')   ← THE UNIT OF WORK
        ├── Meetings (meetings.goal_id)
        ├── Tasks (tasks.goal_id)
        ├── Work runs (work_runs)
        └── Its own folder: workspace/<company>/<slug>/
```

**The project is the container for everything.** This is the central design decision: when the context was the entire company, the agent received five different websites and could not understand which one you meant by "change the header". With the project as the boundary, the prompt brings that project and nothing else.

Consequences that must be respected:

- A meeting **always** lives inside a project (`meetings.goal_id`).
- `renderWorkSection(store, companyId, goalId)` with `goalId` filters to that project. Without `goalId` it falls back to the old behavior (the whole company).
- Deleting a project **does** take everything inside it. Deleting a **meeting** does NOT: work produced from it survives detached. They are opposites on purpose.

## The lifecycle of a task

```
meeting → assigned tasks → [Start working] or [End meeting]
   → queue (store.workQueue, ordered by phase)
   → atomic checkout (store.checkoutTask)
   → run: N steps with file tools (workforce.executeWork)
   → deterministic verification (verify.js) ← the agent fixes it right here
   → finish → peer review (workforce.executeReview)
   → if changes requested: a correction task back to the author
```

`workQueue` orders by `tasks.phase` and then by date. The column survives a removed contract-task schema (see below); it is used for prioritization without requiring a migration.

## The user's request is what matters

`store.userRequestForGoal(goalId)` brings the user's turns from that project's meetings, and they go **first and in every step** of the work prompt.

This is not decoration: when the prompt started with the project title, a project named "Work from 27/7/2026" caused the team to invent a generic corporate website even though the meeting asked for a sushi menu with parallax. The title is a derivation; the user's words are the source of truth.

## The file scheme

Each `deliverable` task declares **which file it writes** (`tasks.target_file`), and each file has **a single owner**. The CEO decides this when closing the meeting.

Without this, the team assigned by discipline — "define the palette", "implement parallax", "review neatness", "prototype in Figma" — and those tasks do not map to any file: the engine requires producing one to mark the task done, so they exhausted their 12 steps and got blocked. Rules that follow and must be upheld:

- What is not a file is not a deliverable: it is a `decision` or part of someone else's file.
- **External tools do not exist.** No Figma, Photoshop, or Notion: the team only writes project files. This is forbidden in the meeting prompt and `normalizeTargetFile()` discards any "file" that is not one.
- If the task had a file and that file **already existed**, the run closes as done instead of blocking: the work was done, not failed.

`tokens.css` is the only coordination artifact preserved, because it prevents each agent from inventing their own palette. The first builder writes it in the same run. (There used to be a multi-KB `PROYECTO.md`: producing it consumed an entire run and competed with the product. It was removed.)

`BITACORA.md` is written by each agent at the end (`anotarEnBitacora`). It is the handoff between peers — without it, what the previous one learned was lost, because `lastObservation` only lives within a run.

## The work prompt has a budget

The action protocol competes with everything else injected into the prompt. When documentation reached 14,000 characters against 1,500 of protocol, the model **stopped emitting actions and started replying in markdown prose**, imitating what surrounded it: four runs in a row burned 12 steps each without writing a file.

That is why playbooks are one-line lists, not documents. **If you add something to the work prompt, measure how much it weighs first.** On the third response without an action the run is cut and returned to the queue.

## verify.js: the highest-leverage piece

**Deterministic verification, no LLM**, on what ended up written to disk. It runs before accepting `finish` and findings return as the next step's observation: the agent fixes within the same run, while it still has full context.

It checks: balanced HTML, `<title>`/`<meta description>`/`lang`, a single `<h1>`, `alt` on images, dead `href="#"` links, duplicate `id`s, references to missing files, remote resources, placeholders, stray English in the UI, colors and fonts outside `tokens.css`, and JS that does not parse.

**Golden rule for that file: zero tolerable false positives.** An invented finding makes the agent break something that was fine. When in doubt, do not report — that's why "chat", "email", or "software" do not count as stray English, and black, white, and `transparent` do not count as a custom palette.

That is why `noJuzgableComoScript` exists: `new Function` compiles a **classic script**, so an ES module (`import`/`export`/top-level `await`) and JSX are `SyntaxError` there even if perfect. A `theme.js` with `export const`, any `<script type="module">`, and all JSX in a React Native project were being marked as broken. What cannot be judged in script mode is not reported.

## Playbooks

`server/playbooks/*.md`, loaded once at startup (`playbooks.js`):

- `diseno.md` — the design floor, with **verifiable** rules (multiples of 4, 4.5:1 contrast, 120–260 ms durations), not adjectives. It is the **universal** floor: it does not name CSS, HTML, or `var(--…)`, because it travels to all five niches.
- `diseno-web.md` — what only exists on a web screen (`var(--…)` from `tokens.css`, `alt`, `href="#"`, 70-character line width). It enters **only** the `web` niche. Before it lived inside `diseno.md` and reached mobile too: the prompt required `tokens.css` three lines below "Styles with `StyleSheet.create`. No CSS.", which is exactly how a web page disguised as an app slips in. `renderDesignStandard(stack)` composes the two parts, and **review** also receives the floor for its niche.
- `archivoDeTokens(stack)` is the token file name for each niche (`tokens.css`, `src/theme.js`, `Tokens.kt`, or `null` in Python). The work prompt uses it to avoid asking a React Native dev to write CSS.
- `<niche>.md` (one per `STACKS`) — which technology to use in each case.
- `flujo-<niche>.md` — the work **order**: what is scaffolded first, which exact command verifies before `finish`, the two or three mistakes always made there, and when NOT to iterate. Without this, runs wrote five files without a plan, left the entry point with Expo's default template while the work lived in `src/screens/`, and ran out of steps.
- `roles.md` — what each role does and does **not** do, and when they come in.

The flow and roles add ~1.6 kB per step, so they have a **hard cap**: 900 characters per flow, 700 for `roles.md`, verified in `tests/flujo-oficio.test.mjs`. A new niche in `STACKS` without its `flujo-` breaks that test on purpose.

Also, the entire craft documentation (`renderPlaybooks` + `renderFlujo` + `renderRoles`) has a **measured** ceiling of 4,200 characters per niche. Before, the guard compared two documentation blocks against each other, which rewarded exactly what must be avoided: inflating criteria to be able to inflate the flow. What matters is the total against the protocol (~3,200 in the system prompt), which is the ratio measured when the model stopped emitting actions.

They go into the **work** prompt, never the conversation prompt: in a meeting the agent speaks as a person, not reciting its manual.

A rule that cuts across everything: **the team never asks the user technical questions.** They decide and communicate in terms of what will be seen.

## Mobile apps are apps, not websites

The `android` and `movil-rn` niches deliver a **native app that compiles**, not a page. `native-build.js` actually compiles it before accepting `finish` and returns compiler errors to the agent, just like `verify.js` does with HTML.

- **Android**: Gradle + AGP 9 + Kotlin 2.2 + Compose, `compileSdk` 36. Verified on this machine: cold compile in minutes, **warm ~5 s**, then `adb install` and launch on the emulator. Gradle comes from `~/.gradle/wrapper/dists` cache because agents cannot write the wrapper binary jar. **AGP 9 already includes Kotlin**: applying `org.jetbrains.kotlin.android` separately breaks the build.
- **React Native**: validated without `npm install` (that would be hundreds of MB per project). `revisarReactNative()` checks it is truly a mobile app: `react-native` dependency, `app.json`, and **zero HTML tags or browser APIs** in JSX — exactly how a web page disguised as an app slipped through.

`IGNORED_FOLDERS` (build, .gradle, node_modules, dist, .expo, Pods) are excluded from **all** file listings. Not cosmetic: without this, after the first compile the agent's `list_files` returned thousands of intermediate paths and ruined its context.

## Parallelism, waves, and collaboration

**The lock is per FILE, not per project** (`puedeArrancar`/`tomarCerrojo`/`soltarCerrojo`). Two agents build the same project at once if each writes their own file. The ENTIRE project is taken only by reviews (read everything) and tasks without `target_file` (unknown what they will touch).

**Waves (`tasks.phase`) replace the guarantee the old lock provided.** That lock was not just a lock: it was the QUEUE that ensured whoever enters sees what the previous one left. Without it, four agents start on an empty project, nobody sees `tokens.css` because it doesn't exist yet, and each invents their palette. `store.faseAbierta(goalId)` returns the lowest phase with live work; nobody from a later wave starts until it closes. `blocked` tasks do not count, so a stuck wave opens on its own.

**Every queued task needs `target_file`.** Without it, it falls into exclusive mode and parallelism turns itself off. The three paths that enqueue assign it: `confirmMeetingClose` (decided by the CEO), `startWorkNow`, and live auto-enqueue (both via `inferir-archivo.js`, deterministic to avoid spending a model call per task).

**Collaboration**: the `consultar` action lets an agent ask a peer and receive their answer with that person's criteria, immediately. Limit of 2 per run. Recorded as a comment so it shows in Activity.

## Voice only exists in call mode

`MeetingSession.voiceEnabled` starts at **false**. The client sends `set_voice` when entering and leaving the call. Outside the call not a single word is synthesized — and more importantly, **the SpeakerGate is not taken**, which serializes agents one at a time for audio nobody was listening to.

## Traps that cost time and are not obvious

- **`'renata'.includes('')` is `true`.** A consultation without a recipient always fell to the first in the list instead of whoever knows. There is a guard.
- **`yaExiste` was a snapshot at start.** With multiple agents, a file a peer created DURING your run was not in the snapshot and `write_file` erased it entirely. Now the disk is consulted.
- **`anotarEnBitacora` was read-modify-write.** With two simultaneous `finish`es one entry was silently lost. Now it is `appendFile`.
- **`completeGoalIfDone` announced "goal completed"** when all tasks ended up blocked. Now it also requires that someone actually delivered something.
- **An id selector `#cafe` was read as a handwritten color.** The verifier only looks at declaration values, not selectors. And `font-family: inherit` is a CSS keyword, not a font.
- **`construirApp(dir)` without the stack cannot know an app was expected there**: a web delivered in a mobile project passed through. It receives `goal.stack`.
- **`DELETE FROM tasks WHERE meeting_id = ?` without `AND goal_id IS NULL`.** A meeting without deliverables hangs a separate `acuerdo`-kind goal; deleting the project emptied those decisions, which belong to ANOTHER goal. The record survived but ended up blank.
- **`reassignCeoDeliverables` with affinity 0 left the deliverable on the CEO.** A request phrased in plain language ("the plant catalog landing page") names no technology, so it tied at 0 and the boss ended up writing the file — exactly what that function exists to prevent. Tiebreak is by load, but it still leaves her hands.
- **The model sends SEVERAL actions in one message.** Not prose: it wants to read three files at once. The greedy parser (`\{[\s\S]*\}`) took from the first brace to the last and produced invalid JSON — 21 steps of a run discarded as "no action JSON" when the response was perfect. `parseJsonObjects` extracts by balanced braces and reads are resolved all in ONE step.
- **The format is repeated at the END of each step** (`RECORDATORIO_FORMATO`). With the protocol only at the top of the system prompt and 15,000 characters of context in the middle, recency wins.
- **A truncated heredoc marker ended INSIDE the file.** A `theme.js` ended with `\n<<<`, the import broke, and the whole team got stuck without understanding why. `limpiarMarcadores` removes them from all paths.
- **App validation ran only on `finish`**, and runs almost always end by exhausting steps: a mobile project without `package.json` was considered delivered. Now it is also validated on that exit.
- **`patch.title ?? goal.title` lets an empty string through.** PATCH sends `title.trim()` without validation, so renaming to spaces left the project nameless. Creation rejects it with 400: both gates must match.

## Real work environments

Agents have **a real terminal** inside their project folder (`herramientas.js`, `comando` action). It exists because writing scaffolding by hand is the main source of broken deliverables: in FASA a React Native app ended up without `package.json` or `app.json`. With the tool, `npx create-expo-app` solves it in one command — verified, the agent used it and produced a complete Expo project with assets and splash.

Any command is allowed. Risky ones (`rm`, `mv`, `kill`) require the agent to explain `why`, and with that they run. The FORBIDDEN list is short and has a single criterion: nothing that leaves the project folder or leaves the machine worse off (`sudo`, `rm` on absolute paths, `git push`, `ssh`, reading `.ssh`/`.env`). Not distrust: `rm -rf ~` has no undo and no product task needs it.

**Design: OpenPencil** (`openpencil.js`, MIT, github.com/ZSeven-W/openpencil). A headless server per project; the designer designs with `op design`, defines tokens with `op design:upsert-vars`, and exports screenshots. Their deliverable is `diseno.op` (versionable JSON) plus a `.png`. Tokens are translated AUTOMATICALLY to the niche's language (`tokensComoCodigo`: `theme.js`, `Tokens.kt`, or `tokens.css`) and the dev receives them in their prompt: **implement the design, do not reinterpret it**. Installed with `scripts/instalar-openpencil.sh` — not with brew, which compiles from source and fails with old Command Line Tools; and quarantine must be removed and it must be signed or macOS kills it with SIGKILL without explanation.

## Task type comes from the role

`claseDeTareaPara`: QA does not receive a file to write (their reviews are created by the engine when something is delivered), talent does `refinement`, and whoever designs delivers `diseno.op`. Without this they were given a file, exhausted steps looking for what to write, and got blocked — half of FASA's blocked tasks were this.

## Workspace sandbox

Everything the company produces lives in `workspace/<company>/<slug>/` and nowhere else. `safeWorkspacePath()` is the only write gate and rejects: absolute paths, `..`, hidden segments, and extensions outside the deliverable format list. **Do not relax that guard.**

`workspace/` is outside version control.

## Things that look like bugs and are not

- **The preview iframe uses `sandbox="allow-scripts"` WITHOUT `allow-same-origin`.** Intentional: deliverables need their JS to run, and with both permissions together the page could remove the sandbox itself. (Before it had only `allow-same-origin`, so nothing interactive worked.)
- **`10.0.2.2` in `emulator.js`** is the host loopback as seen from inside the Android emulator. The iOS simulator does use `127.0.0.1`.
- **The generic Android intent is not enough**: without a default browser, `am start` exits with code 0 and opens nothing. That's why it targets Chrome explicitly and then verifies.
- **Verification uses `ResumedActivity`, not `mCurrentFocus`.** With the screen just woken up, `mCurrentFocus` keeps reporting `NotificationShade` even if Chrome is in front — it gave a false "did not open".
- **First step is to wake the screen** (`despertarPantalla`). A sleeping device returns **black** captures and does not let any app take focus; both symptoms look like different bugs and are the same one.
- **Several old projects share the slug `general`** (inheritance from migration v5). That's why `deleteProject` checks `slugSharedWithOthers` before deleting the folder.

## Migrations

`server/lib/db.js`, `MIGRATIONS` array, one per `user_version`.

**Never edit an already-applied migration** — add a new one at the end. (It happened: v9 was edited after being applied and the change never ran; a v10 had to be added.)

## Verify changes

```bash
npm test          # node:test, no network
npm run typecheck
npm run doctor    # what is missing and the exact command to fix it
npm run dev       # backend + client + voice + transcription

# is what the team delivered a well-formed app, or loose files?
node scripts/auditar-app.mjs <folder> [stack]
node scripts/auditar-app.mjs --workspace     # everything produced, with stack from DB
```

`auditar-app.mjs` audits **structure**: that the files required by the niche exist and fit together (module `namespace` against code `package`, entry point against `src/` screens). Content is still measured by `verify.js` and `native-build.js` — the script uses them, it does not reimplement them.

Tests **must not depend on template names** (Bruno, Renata…): templates change. Filter by `role` and use real names.

## File map

| File | What it solves |
|---|---|
| `server/lib/db.js` | Schema and migrations |
| `server/lib/store.js` | Single data access. No `fs`: disk is handled by the caller |
| `server/lib/workforce.js` | Work engine: queue, runs, review, contract |
| `server/lib/verify.js` | Deterministic deliverable verification |
| `server/lib/playbooks.js` | Loading of craft and design criteria |
| `server/lib/meeting-session.js` | One live meeting: turns, routing, closing |
| `server/lib/agent-runtime.js` | Conversation prompt and per-agent streaming |
| `server/lib/llm.js` | MiniMax/DeepSeek client with key×model rotation |
| `server/lib/emulator.js` | Android emulator and iOS simulator |
| `src/main.ts` | Entire client (views, WS, audio, region-based rendering) |
