---
description: Score a resume against a job description with the ATS rubric and list missing keywords, knockouts and parse problems.
argument-hint: <app id | draft.json> [--jd <file>] [--rendered]
---

ATS check: `$ARGUMENTS`

Read `${CLAUDE_PLUGIN_ROOT}/skills/ats-rules/SKILL.md`. CLI: `node "${CLAUDE_PLUGIN_ROOT:-D:/Projects/Job_Hunter}/dist/jh.mjs" <cmd> --json` (written `jh` below).

1. Resolve the draft and workdir as in `/review-resume` (app id → `<artifacts_dir>/resume.json` and `runs/<run_id>/`; draft path → its folder).
2. Keywords:
   - `--jd` given: dispatch `ats-screener` mode `extract` with `jd_path` = that file, `store: false`, no `app_id`, `workdir` = `<workdir>/review-jd/`, and score against `<workdir>/review-jd/keywords.json`. Nothing stored changes.
   - No `<workdir>/keywords.json`: dispatch `ats-screener` mode `extract` with `jd_path` = `<workdir>/jd.txt` plus `run_id` and `app_id` (it stores keywords and the JD snapshot).
   - Otherwise use `<workdir>/keywords.json`. For an app id, also run `jh jd show <app_id> --json`; on exit 1 (`no_snapshot`), backfill with `ats-screener` mode `extract`, `snapshot_only: true`, `run_id`, `app_id`, `workdir`, `jd_path` = `<workdir>/jd.txt` (skip the backfill and say so if that file is missing).
3. Score: `jh ats score <draft> --keywords <workdir>/keywords.json --json`. With `--rendered`, add `--rendered <dir>` where `<dir>` is the folder holding the rendered files (`<artifacts_dir>` for a finalized application, `<workdir>/render` for a draft).
4. Report the total against pass 80 and floor 60, each component, `missing_required` (mark the ones the master resume genuinely supports, citing the bullet id from `me/master-resume.yaml`), `failed_knockouts` (these cap the score at 40), `parse_failures`, and stuffing. Recommend `/resume` only if the master supports the missing terms.
