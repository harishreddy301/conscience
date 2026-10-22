---
description: Review estimated metrics proposed from your READMEs and accept, edit or reject each one, 4 at a time. Only accepted numbers can appear in a resume.
argument-hint: "[role id]"
---

Confirm metrics: `$ARGUMENTS`

Load `${CLAUDE_PLUGIN_ROOT}/skills/metrics-policy/SKILL.md`. CLI: `node "${CLAUDE_PLUGIN_ROOT:-D:/Projects/Job_Hunter}/dist/jh.mjs" <cmd> --json` (written `jh` below).

This is one of the few places the user must decide: only they know whether a number is true (CLAUDE.md Rule 1, "information only the user knows").

## 1. Load pending estimates

`jh metrics list --status estimated --json`, plus `--role <id>` if an argument was given. Each item has `id`, `bullet_id`, `bullet_text`, `phrase`, `value`, `derivation`, `confidence`.

- None pending: if the master has bullets without any fact metric and metric-miner has not run since the last `/intake`, offer to dispatch `metric-miner`. Otherwise say "No estimates waiting" and stop.
- Order them by role, then by confidence (high first), so related numbers are asked together.

## 2. Ask in batches of up to 4

For each batch, make one **AskUserQuestion** call with one question per metric:
- `header`: the metric's `value`, shortened to 12 characters or fewer.
- `question`: `"<bullet_text>" — proposed: <phrase>. How we got it: <derivation>. Is <value> right?`
- `options` (single select):
  1. `Accept`: "Use <value> as written"
  2. `Reject`: "Never use this number"
  3. `Edit`: "I'll give the right number"

The user may also answer with "Other" and type a value directly; treat that as Edit with that value.

For each answer:
- Accept: `jh metrics confirm <id> --accept --json`
- Reject: `jh metrics confirm <id> --reject --json`
- Edit: if the user has not typed the value yet, ask once in plain text: "What is the right value for <phrase>?". Then run `jh metrics confirm <id> --edit "<value>" --json`. If the user also rewords the clause, add `--phrase "<new phrase containing the value>"`.

A user who says "skip" or does not answer leaves the metric pending. Never accept on the user's behalf, and never guess a value.

## 3. Finish

Report in one line: accepted N, edited N, rejected N, still pending N (`jh metrics list --status estimated --json`). `<me>/metrics.md` and `<me>/confirmed-metrics.yaml` are updated by the CLI. Do not edit them by hand.

The dashboard's "Pending metrics" card calls the same CLI logic, so decisions made there show up here and the other way round.
