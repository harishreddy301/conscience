---
description: Review an existing tailored resume (a finalized application or a draft JSON) as the hiring manager, a 6-second recruiter and the ATS, without changing it.
argument-hint: <app id | draft.json> [--jd <file>]
---

Review: `$ARGUMENTS`

CLI: `node "${CLAUDE_PLUGIN_ROOT:-D:/Projects/Job_Hunter}/dist/jh.mjs" <cmd> --json` (written `jh` below).

1. Resolve the resume and its run:
   - **App id:** `jh app show <id> --json` gives `artifacts_dir`. The resume is `<artifacts_dir>/resume.json`. Its `run_id` field names the run; the workdir is `<artifacts_dir>/runs/<run_id>/`, with `jd.txt` and `keywords.json`.
   - **Draft path:** read its `run_id`; the workdir is the draft's folder.
   - `--jd <file>` overrides the JD for this review only (then keywords must be re-extracted, step 2). This must not change anything stored.
2. Keywords and snapshot:
   - `--jd` given: dispatch `ats-screener` mode `extract` with `jd_path` = that file, `store: false`, no `app_id`, and `workdir` = `<workdir>/review-jd/` (create it). Use `<workdir>/review-jd/keywords.json` below. The stored snapshot and run keywords are left untouched.
   - Otherwise, if `keywords.json` is missing: dispatch `ats-screener` mode `extract` with that `run_id`, `app_id`, `workdir`, `jd_path` = `<workdir>/jd.txt` (it also stores the JD snapshot for `jh jd compare`).
   - Otherwise, for an app id, run `jh jd show <app_id> --json`. On exit 1 (`no_snapshot`, typical for applications finalized before v0.2), backfill: dispatch `ats-screener` mode `extract` with `snapshot_only: true`, `run_id`, `app_id`, `workdir`, and `jd_path` = `<workdir>/jd.txt` (if that file is missing, say the stored JD is gone and that the compare panel stays empty for this application; do not use a `--jd` file for the backfill).
3. Dispatch in **one message** (parallel):
   - `hiring-manager` mode `single` with the draft, `run_id`, `workdir`, `jd_path`, and `app_id` when reviewing an application (omit `app_id` when `--jd` was given, so it reads that JD rather than the stored snapshot);
   - `recruiter-screen` with the draft;
   - and run `jh ats score <draft> --keywords <workdir>/keywords.json [--rendered <artifacts_dir or workdir>/render] --json` yourself.
4. Run `jh resume gate <run_id> --draft <draft_id> --json`.
5. Report a compact scorecard: ATS total and missing required terms, recruiter checks (x/8 with the failed ids), HM verdict, score, must-have evidence gaps, top 3 fixes, screen question, and whether the gate passes. Do not modify the resume; suggest `/resume <app id>` to re-tailor.
