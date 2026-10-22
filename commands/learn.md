---
description: Learn from application outcomes. Label callbacks, rejections and ghosts, compute what resume variants worked, and refresh me/learnings/playbook.md for the resume writers.
argument-hint: [--force] (run even when jh learn status says not due)
---

Learn: `$ARGUMENTS`

Load `${CLAUDE_PLUGIN_ROOT}/skills/outcome-learning/SKILL.md`. CLI: `node "${CLAUDE_PLUGIN_ROOT:-D:/Projects/Job_Hunter}/dist/jh.mjs" <cmd> --json` (written `jh` below).

## 1. Is it due?

Run `jh learn status --json`.
- `due: false` and no `--force`: report `reason`, `last_run_at` and `new_outcomes`, then stop.
- `resolved_now: 0`: say there are no resolved outcomes yet ("apply, then let /track pick up replies") and stop.
- `playbook_path: null`: the me/ workspace is missing. Tell the user to run `jh me init` and stop.

## 2. Fresh outcomes first

If the last `/track` was more than 12 hours ago (`jh sync status --json`), run `/track` so new rejections and invites are counted. Then run `jh app ghost-sweep --json`.

## 3. Analyse and write the playbook

Dispatch the `outcome-analyst` agent. It runs `jh learn analyze`, drafts the playbook, lints it with `jh learn playbook --file … --write`, and returns `{id, summary}`.

If the agent fails, run `jh learn playbook --write --json` yourself. This writes the deterministic baseline playbook.

## 4. Report

Read `me/learnings/stats.json` and `me/learnings/playbook.md`. Show the user:
- submitted, resolved, the callback rate and the median days to response;
- the top 3 `moderate` patterns, each with n. If there are none, say that every pattern is still weak and give the count needed (n >= 8);
- the current best angle and the exploration rule (about 20% of applications, `app_id % 5 == 0`, use a non-best angle);
- one line of caution: these are correlations from a small sample, and nothing guarantees a callback.

The dashboard's "What's working" card shows the same numbers from `GET /api/learn`.
