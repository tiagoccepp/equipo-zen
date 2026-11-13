# The Work Engine

How a task goes from "it was mentioned in a meeting" to "there is a browsable file", and how to debug it when something goes wrong.

## Task states

| State | Meaning |
|---|---|
| `pending` | In the queue, waiting for someone to take it |
| `in_progress` | Someone took it (atomic checkout) and it is running |
| `done` | Finished and produced its output |
| `blocked` | Could not move forward; `blocked_reason` explains why |
| `noted` | Not work: it is a recorded agreement or follow-up |

Checkout is atomic in SQL:

```sql
UPDATE tasks SET status = 'in_progress', run_count = run_count + 1
WHERE id = ? AND status = 'pending'
```

If `changes !== 1`, someone else took it. This is what prevents two heartbeats from taking the same task.

## Task types (`kind`)

- `spec` — write the project contract. Phase 1, blocks the rest.
- `deliverable` — produce something real.
- `review` — read a peer's work and approve it or request changes.
- `refinement` — the talent contractor fine-tunes someone's profile.
- `decision` / `follow-up` — stay as `noted`, nobody "works" on them.

## Inside a run

`workforce.executeWork()` allows up to `MAX_STEPS_PER_RUN` steps. In each one the model returns **one** action:

| Action | What it does |
|---|---|
| `list_files` | Lists the project (only once per run) |
| `read_file` | Reads a file |
| `write_file` | Writes the COMPLETE file, raw content between markers |
| `edit_file` | Replaces a fragment (preferred over rewriting) |
| `finish` | Closes — but it goes through verification first |
| `block` | Gets stuck and explains what is missing |

Two barriers against overwriting someone else's work:

1. **A file that already existed cannot be overwritten without having been read** in this run.
2. **A project has only one run at a time** (`busyGoals`): whoever enters sees what the previous one left behind.

`applyEdit()` first tries an exact replacement and, if it fails, one tolerant to whitespace and indentation — the model almost never reproduces indentation exactly, and rejecting it for that burned steps without the file making progress.

## Verification

On the first `finish`, if the run wrote anything, `verify.js` runs on what ended up **on disk**. If it finds problems:

- The `finish` is not accepted.
- The report comes back as `lastObservation` for the next step.
- The agent fixes it and tries again.

It runs **only once per run**, to avoid trapping it in a loop. Anything left unresolved is saved as a `verification` comment on the task, and the reviewer receives it so they don't look again for what was already measured.

## Limits

| Variable | Default | Purpose |
|---|---|---|
| `WORKFORCE_TICK_MS` | 5000 | How often the queue is checked |
| `WORKFORCE_MAX_CONCURRENT` | 2 | Parallel runs (1 with an open meeting) |
| `WORKFORCE_MAX_STEPS` | 12 | Steps per run |
| `WORKFORCE_MAX_RUNS_PER_TASK` | 3 | Retries before blocking |
| `WORKFORCE_STEP_TIMEOUT_MS` | 180000 | Timeout per model call |

The person has priority: while you speak, the engine does not start new work (they share the same API key) and yields if you start speaking in the middle of a step.

## Debugging a run

Everything is stored in `work_runs.log_json`:

```bash
node -e "
const {DatabaseSync} = require('node:sqlite');
const db = new DatabaseSync('server/data/meetings.db');
const r = db.prepare('SELECT * FROM work_runs ORDER BY id DESC LIMIT 1').get();
console.log(r.status, '·', r.summary);
console.log(JSON.parse(r.log_json).map(s =>
  \`\${s.step}: \${s.action} \${s.path || ''} \${s.ok === false ? '✗ ' + (s.note||'') : ''}\`
).join('\n'));
"
```

What to read there:

- Many `write_file ✗` in a row → the model is not using the markers.
- Many `edit_file ✗` with "that text is not there" → it is copying from memory instead of reading the file.
- `verify` with findings and then `finish` → it fixed and closed: expected.
- `error` on step 1 → the model call failed (key or service).

There is also a readable log per meeting in `server/logs/`, and the project's **Activity** tab shows the same thing live.

## When a task gets blocked

- The model replied `block` explaining what it needs.
- It ran out of steps **without producing any file** (if it produced something, it counts as done and peer review judges it).
- The model call failed `MAX_RUNS_PER_TASK` times in a row.

A blocked task does not retry on its own: it shows up on the board with its reason and is resolved by discussing it in the meeting.
