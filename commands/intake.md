---
description: Build or refresh master-resume.yaml from your me/ workspace (sample resume + experience READMEs) with stable ids, settle fact conflicts with you once, then propose metrics.
argument-hint: "[--no-metrics]"
---

Intake: `$ARGUMENTS`

Load `${CLAUDE_PLUGIN_ROOT}/skills/me-workspace/SKILL.md`. CLI: `node "${CLAUDE_PLUGIN_ROOT:-D:/Projects/Job_Hunter}/dist/jh.mjs" <cmd> --json` (written `jh` below).

## 1. Check the workspace

- `jh me status --json`.
  - `exists: false`: if `jh me path --json` shows `source: "legacy"`, run `jh me init --dir <path the user wants>` and then `jh me migrate --json`. Otherwise tell the user to run `jh me init --dir <path>`, put a resume in `sample-resume/` and write `experience/*.md`, then stop.
  - `missing` lists `sample-resume/...` **and** `experience/...`: there is nothing to ingest. Stop and say which files to add (point at `experience/_example-acme-2022.md`).
  - `needsIntake: false` and no arguments: say the master resume is current and go to step 5.
- `jh me validate --json`. Errors in `experience/*.md` front matter (bad dates, missing fields): show them and stop. The user fixes the README.

## 2. Draft

Dispatch the `resume-intake` agent: "Run intake for the me/ workspace." It writes `<me>/.intake/draft.json` and returns `{id, summary}`.

## 3. Settle conflicts (ask once)

Read the draft's `conflicts`, then run `jh me ingest <draft> --dry-run --json` and add its `conflicts` (exit 2 means conflicts; `fixed_fact` ones compare the master with the draft).

If there are none, go to step 4. Otherwise ask the user with **AskUserQuestion**, up to 4 questions per call:
- `header`: the role and the field (e.g. "Acme start").
- `question`: "Which is right for <title> at <employer>: <value A> (<source A>) or <value B> (<source B>)?"
- options: each value, labelled with its source. The user can type another value with "Other".

Then write each answer into that role's README front matter in `<me>/experience/<file>.md` (Edit tool): set the field to the chosen value and add the field name to `confirmed_facts: [...]`, so intake never asks again. For a role with no README, create `<me>/experience/<employer-slug>-<year>.md` from `_TEMPLATE.md` with the confirmed front matter.

Re-dispatch `resume-intake` once so the draft reflects the answers. If any `fixed_fact` conflict remains because the user changed a date or title that the master already has, ingest with `--allow-fact-changes` in step 4. That flag is allowed **only** for the facts the user just confirmed.

## 4. Ingest

`jh me ingest <me>/.intake/draft.json --json` (add `--allow-fact-changes` per step 3). Report `added`, `updated` and `retired` in one line each. List `lint` warnings in short form: a `NUMBER_NO_METRIC` warning means a bullet mentions a number that has no metric yet.

## 5. Metrics

Unless `--no-metrics` was given, dispatch `metric-miner`: "Propose estimated metrics for bullets without numbers." Then run `/confirm-metrics` so the user decides on the new estimates right away.

## 6. Finish

Say in 3 lines or fewer: roles and bullets in the master, facts versus pending estimates (`jh metrics list --status estimated --json`), and the next step (`/resume <job>`).

Never show the user's whole master resume in chat; it is in `<me>/master-resume.yaml` and `<me>/metrics.md`.
