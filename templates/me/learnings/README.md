# me/learnings

This folder holds what conscience has learned from your application outcomes: which resume variants got callbacks and which did not. `/learn` generates it, and `/today` runs `/learn` weekly or after 5 new outcomes.

| File | Written by | Read by |
|---|---|---|
| `playbook.md` | the `outcome-analyst` agent via `jh learn playbook --file … --write` (or the deterministic baseline from `jh learn playbook --write`) | resume-writer, the tailoring skill and conscience, before every draft |
| `stats.json` | `jh learn analyze` and `jh learn playbook --write` | you, the outcome-analyst, and debugging |

## How outcomes are counted

- **Callback (positive):** the application reached assessment, interviewing or offer, or an interview invite arrived. A later rejection does not undo it.
- **Rejected (negative):** rejected with no callback.
- **Ghosted:** 21 or more days since applying with no reply.
- **Pending:** too early to tell. Pending applications are excluded from rates.

Every pattern in the playbook cites `n`, the number of resolved applications behind it, and a strength:
- **weak:** n < 8. Use it only as a tie-breaker.
- **moderate:** n ≥ 8.

Patterns with n < 3 are never shown.

## What this cannot do

Nothing guarantees a job call. The playbook shifts the odds toward wording that has worked for *you*. It never overrides the fact rules: no invented or estimated numbers, and no skills you don't have. About 20% of applications deliberately try a non-best angle, so the system keeps learning instead of locking in early.

## Editing

You may edit `playbook.md` by hand. Keep the `n=…, weak|moderate` citations, because `jh learn playbook --file playbook.md --write` checks them. The next `/learn` run regenerates the file, so put lasting preferences in `preferences.md` instead.

`playbook.example.md` shows the format with fictional numbers.
