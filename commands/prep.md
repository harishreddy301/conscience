---
description: Build an interview prep pack (company brief, role fit, likely questions, STAR answers from your real experience) for an upcoming interview.
argument-hint: <interview id | company name> (default: the next interview without prep)
---

Prep: `$ARGUMENTS`

CLI: `node "${CLAUDE_PLUGIN_ROOT:-D:/Projects/Job_Hunter}/dist/jh.mjs" <cmd> --json` (written `jh` below).

## 1. Pick the interview

- `jh interview list --upcoming --days 30 --json`.
- A number in the arguments: use that `id`.
- A name: the soonest interview whose `company_name` matches (case-insensitive). Several rounds: take the soonest.
- Nothing given: the soonest interview with `prep_status` `none` or `queued`.
- None found: say so and suggest `/track` to sync the calendar first.

If its `prep_status` is already `ready`, show the existing pack's path and ask whether to rebuild only if the user passed the same id explicitly; otherwise just show it.

## 2. Build

Dispatch `interview-prep` (sonnet) with `interview_id`. It writes `prep-<id>.md` under the artifacts folder and runs `jh interview prep <id> --status ready --path <file> --json`.

## 3. Show

- Read the pack and show the Snapshot, Role fit table and the top 3 STAR answers.
- Link: the dashboard serves it at `http://127.0.0.1:4777/api/interviews/<id>/prep` (when `jh dashboard status --json` shows it running).
- If the summary lists gaps, add one line on how to address each before the interview.

After the interview, mark it done: `jh interview prep <id> --status done --json`.
