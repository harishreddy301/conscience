---
description: Run the day as the manager - sync mail and calendar, sweep the pipeline, confirm pending metrics, tailor resumes for queued jobs, and apply. The main session plus the conscience agent orchestrate the whole team.
argument-hint: [--no-apply] [--no-scout] [--max-resumes 3]
---

Run today's job hunt. `$ARGUMENTS`

You (the main session) are the **manager**. For a full hands-off run (scout → triage → tailor → submit), use `/autopilot`; `/today` runs the daily housekeeping and a smaller batch. Both follow `me/decision-policy.yaml` (ADR-005): its triage, eligibility, gates, daily cap and `submit.confirm` override the defaults below. Load `${CLAUDE_PLUGIN_ROOT}/skills/conscience/SKILL.md` and `${CLAUDE_PLUGIN_ROOT}/skills/resume-loop/SKILL.md`. CLI: `node "${CLAUDE_PLUGIN_ROOT:-D:/Projects/Job_Hunter}/dist/jh.mjs" <cmd> --json` (written `jh` below). Run the steps in this order and keep a running tally for the final report.

## 0. Health

`jh doctor --json`. Stop if `meIgnored` is false (personal data at risk) or `me.exists` is false (run `/intake` first). Note `chrome` and `pendingMetrics`.
Then `jh policy check --json` (stop on conflicts) and `jh autopilot preflight --json` (note `remaining_today`, `submit_confirm` and blocking escalations; ask open blocking escalations in one message now).

## 1. Track

Run `/track` (email-tracker and calendar-sync ingest Gmail and Calendar into SQLite). If a connector is unavailable, note it and continue.
Then `jh interview list --upcoming --days 3 --json`: for each interview with `prep_status` `none`, run `/prep <interview id>`.

## 2. Ghost sweep and follow-ups

Dispatch `pipeline-clerk` with tasks `sweep` and `followups`. For each due follow-up, dispatch `outreach-drafter` with `kind: followup` (drafts only; the user sends them).

## 3. Pending metrics

`jh metrics list --status estimated --json`. If any exist, run the `/confirm-metrics` flow with the user now (a few quick accept/edit/reject decisions). Estimates never reach a resume until confirmed.

## 4. Outcome learning (weekly)

`jh learn status --json`. If the last analysis is 7 or more days old, or 5 or more new outcomes arrived since, run `/learn`.

## 5. Ready to apply

`jh app list --status tailored --json`: list them with ATS score and quality. These go to step 7.

## 6. Tailor queued jobs

1. Unless `--no-scout`: if fewer than 5 applications are `shortlisted`, dispatch `job-scout` (companies from `me/targets.md`).
2. `jh policy eval triage --json`: the "You asked" jobs (user links) first, then the policy's recency, title, level, blocklist and per-company rules; `conscience` mode `triage-batch` settles the `review` items. Dismiss the skips with their reasons. Take up to `--max-resumes` (default 3) of the `include` items in conscience's order.
3. For each: `jh policy eval eligibility <id> --json` (`skip` → dismiss; `review` → `conscience` mode `eligibility`), then dispatch `conscience` mode `go-no-go`. For each `go`, run the resume loop (`/resume <app id>`). Run jobs one after another; the drafts inside a job run in parallel.

## 7. Apply

Unless `--no-apply`: run `/apply` for everything `tailored` (the ready list from step 5 plus today's new ones). `/apply` applies the policy gate and the policy's `submit.confirm`: one batch confirmation (`per_batch`), or none under the user's standing approval (`standing`).

## 8. Study and report

`jh study status --json`. Then give a short report:
- synced: emails and interviews, connector problems;
- pipeline: counts by status, newly ghosted, follow-ups drafted;
- metrics confirmed;
- resumes finalized (ATS, verdict, quality) and dismissed (why);
- applications submitted today vs the cap;
- next interview with its prep status;
- study: today's block, streak, week hours vs goal.

Remind the user that this improves callback odds; it cannot guarantee a call.
