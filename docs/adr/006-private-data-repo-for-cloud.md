# ADR-006: A private data repo for cloud sessions

- Status: accepted (user approved on 2026-10-22)
- Date: 2026-10-22
- Spec: `docs/superpowers/specs/2026-10-22-cloud-credits-design.md`

## Context

The user has $250 of Claude Code cloud session credits that expire on 2026-11-05 (02:59 EST). The resume loop (best-of-N drafts, ATS screen, recruiter screen, hiring-manager judge, bounded revision, fact check) is the most expensive part of the job hunt, so running it in cloud sessions moves that cost off the local subscription.

Cloud sessions clone a GitHub repo and nothing else. Git-ignored files (`me/`, `~/.job-hunter/`) never reach them, and each session's filesystem is thrown away except for what is pushed to git. The resume loop needs `me/` (the master resume, experience notes, confirmed metrics) and the application rows from `jh.db`. Two project rules stand in the way: "No personal data in the repo, ever" and "Never send `me/` data anywhere except the target application form".

## Decision

1. **A separate, private data repo.** The user's data for cloud sessions lives in its own private GitHub repo (`conscience-data`), never in the code repo. The code repo rule is unchanged: it holds no personal data.
2. **One exception to the `me/` rule.** `me/` data may go to the target application form **and** to the user's own private data repo, read only by the user's own cloud sessions. Nowhere else.
3. **`jh cloud export` is the only writer.** It enforces three guards before writing anything:
   - the data repo's remote must be private (`gh repo view --json visibility` returns `PRIVATE`), or it exits 2;
   - the data repo clone must not sit inside the code repo, or it exits 2;
   - an allowlist decides which `me/` files are copied: everything except `tk.sh`, `.env*`, `*.backup*` and files over 5 MB.
   Local artifacts (`~/.job-hunter/artifacts`) are never pushed.
4. **The cloud never submits.** Cloud sessions run resume-loop steps 0 to 6 only. They never open a browser, never edit `me/`, and never ask the user; anything only the user can answer goes into `summary.json` and is raised in the next local run's batched ask. Layout, rendering, finalize and submitting stay on the PC, with the usual confirmation flow.
5. **Import re-checks.** `jh cloud import` refuses a cloud DB with a different schema version, inserts only rows whose run id is new (safe to run twice), never changes `applications.status`, and re-validates every winner locally.
6. **Access is scoped.** Cloud sessions reach the data repo with a fine-grained PAT limited to that one repo (contents read/write, 30-day expiry), stored only in the cloud environment's settings. It is never committed or echoed.

## Consequences

- Personal data now exists in one more place: a private GitHub repo. Its safety depends on the repo staying private and on the PAT staying scoped.
- Export is the single choke point, so its guards are unit-tested (public repo, nested clone, secret files).
- `jh doctor` still requires `me/` to be git-ignored in the code repo.
- Making the code repo public later does not affect the data repo; that is a separate sanitizer pass and decision.

## Revocation

To undo this decision:

1. Delete the `conscience-data` repo on GitHub (and the local clone).
2. Revoke the fine-grained PAT and remove `DATA_TOKEN` from the cloud environment.
3. Unset `JOB_HUNTER_DATA_REPO` in `~/.job-hunter/.env`.

Nothing in the local workflow depends on the data repo; without it, the resume loop runs locally as before.
