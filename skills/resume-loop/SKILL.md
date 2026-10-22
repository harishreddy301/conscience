---
name: resume-loop
description: The /resume procedure run by the MAIN session to produce one finalized, fact-checked, ATS-scored resume for one job using best-of-N drafts, hub-and-spoke dispatch of the resume team, a quality gate, bounded revision, rendering and finalize. Load it for /resume, and from /today for each queued job.
---

# Resume loop (main session orchestrates; subagents never call each other)

CLI: `node "${CLAUDE_PLUGIN_ROOT:-D:/Projects/Job_Hunter}/dist/jh.mjs" <cmd>`, written `jh <cmd>` below. Always pass `--json` and parse stdout. Exit codes: 0 ok, 1 not found or runtime, 2 validation or conflict, 3 illegal transition.

**Defaults** (overridable by `/resume` flags): `N = 3` drafts, `MAX_ITER = 3` revise iterations, cover letter **off**, paper Letter.

**Thresholds** (code enforces them in `jh resume gate`):
- Pass: ATS ≥ **80**, hiring-manager verdict `interview`, recruiter checks ≥ **6/8**, `validate.ok`.
- Filter floor: drafts with ATS < **60** or failing validation are dropped before the hiring-manager sees them.
- Tie-break: `conscience` only when the top two HM scores are within **3** points.
- Early stop: ATS + HM score gain < **3** points for **2** rounds in a row.

**Budget per job:** 3 or 4 sonnet writer calls, 1 to 4 opus HM calls, about 4 haiku calls, about 3 sonnet calls. Do not exceed `N + MAX_ITER + 1` writer calls.

## Step 0: pending metrics

`jh metrics list --status estimated --json`. If any estimated metric belongs to a role that will appear in this resume (recent roles, or any role whose bullets match the JD), run the `/confirm-metrics` flow with the user first. Only the user knows these numbers; estimates never reach a resume (`ESTIMATED_METRIC` blocks them).

## Step 1: prepare

1. Get the JD text. Prefer an ATS API (Greenhouse/Lever/Ashby JSON) or WebFetch on the posting URL; use the browser only as a last resort. Save it as plain text to a temp file.
2. If you have an application id, run `conscience` in `go-no-go` mode first. On `no-go`, stop and report.
3. `jh resume prepare --jd <file> --company "<c>" --title "<t>" [--url <u>] [--app <id>] --json` gives `{run_id, app_id, workdir, jd_path, master_path, profile_path, pending_estimates}`. Keep all of it.

## Step 2: keywords

Dispatch `ats-screener` in mode `extract` with `run_id`, `app_id`, `workdir`, `jd_path` (and the posting `url`). It writes `<workdir>/keywords.json` and runs `jh ats keywords set`, then writes the short JD snapshot `<workdir>/jd-snapshot.json` (posted title, must-haves, keywords, ≤ 800-char summary) and runs `jh jd snapshot set <app_id>`. If `jh jd show <app_id> --json` still exits 1 afterwards, re-dispatch it once; the loop continues without a snapshot if it fails again.

Pass `app_id` to every resume-writer, hiring-manager and fact-checker dispatch: they read the snapshot with `jh jd show <app_id> --json` (posted title for the headline and `display_title` choice, must-haves for judging).

## Step 3: drafts (parallel)

1. Dispatch `conscience` in mode `angle-mix` with `app_id` and `n = N`. It returns `{"angles":[…]}` (exploration about 20% of jobs).
2. Dispatch **N `resume-writer` agents in one message** (parallel), mode `draft`, each with one angle and a draft id `d<k>-<angle>` (for example `d1-impact`, `d2-skills-match`, `d3-domain-reframe`). Each writes `<workdir>/draft-<id>.json`, sets the bold baseline with `jh resume bold <draft> --apply --json`, and self-validates (at most 2 fix rounds). Bold key terms are always on: every bullet bolds 2 to 4 terms including every metric, the summary bolds the years and key stack terms, and highlights bold their label plus 1 to 2 terms (skill `resume-style`, "Bold key terms").

## Step 4: score and filter

1. For each draft: `jh ats score <workdir>/draft-<id>.json --keywords <workdir>/keywords.json --json`.
2. Dispatch `recruiter-screen` for each draft in parallel (haiku).
3. Drop drafts with ATS < 60 or a failing validate. If none survive, run one revise round on the highest-ATS draft with its validate errors and `missing_required`, then re-score. If still none survive, go to step 9 with `below_bar` handled by `conscience`.
4. Dispatch **one** `hiring-manager` in mode `compare` with all surviving drafts.
5. Winner = HM rank 1. If the top two HM scores are within 3 points, dispatch `conscience` in mode `tie-break`.

## Step 5: revise the winner (at most MAX_ITER iterations)

Loop with `i = 1..MAX_ITER`:
1. `jh resume gate <run_id> --draft <winner> --json` gives GateResult. If `pass`, leave the loop.
2. Merge fixes: HM blockers first, then HM `top_fixes`, then failed recruiter checks, then ATS `missing_required` (only terms the master resume genuinely supports).
3. Dispatch `resume-writer` mode `revise` with `base_draft`, `new_draft_id = <winner>-r<i>`, `iteration = i`, and the merged fixes. Any `BOLD_*`, `METRIC_NOT_BOLD`, `SUMMARY_BOLD_MISSING` or `HIGHLIGHT_LABEL_NOT_BOLD` validate error is a blocker; reworded items must keep their bold (re-run `jh resume bold`).
4. Score the revision: `jh ats score`, `recruiter-screen`, `hiring-manager` in mode `single`.
5. Keep the revision only if (ATS + HM score) improved; otherwise keep the previous winner.
6. Early stop if the gain was < 3 points in 2 consecutive rounds.

## Step 6: fact check

Dispatch `fact-checker` (mode `resume`) on the winner. On `fail`: one revise round with its findings as blockers (it counts toward MAX_ITER; if the budget is spent, it still runs once), then fact-check again. A second fail stops the loop: report it and do not finalize.

## Step 7: render and layout gate

Run `jh resume layout <workdir>/draft-<winner>.json --out <workdir>/render/<winner> --json` (exit 2 on failure). It renders the classic-navy PDF/HTML/DOCX at the user's spec (`profile.yaml > resume_layout`: Letter, Calibri 9.75pt, 0.5in margins, exactly 2 pages, last page at least 85% full, every bullet and summary highlight exactly 2 lines with the second line 60 to 80% full, skills/Environment/publication rows exactly 1 line, 4 summary bullets, 8 skill groups, minimum bullets per role, no em dash) and measures real line boxes in headless Chrome. Its `bullets[]` lists `lines` and `last_fill` per bullet: at Calibri 9.75pt a line holds about 128 characters, so a 2-line bullet lands at about 205 to 230 characters. Send failing bullets back to `resume-writer` (revise) with their measured fill until it passes; `jh resume finalize` runs the same gate and refuses (`layout_gate_failed`) otherwise. Then read the PDF and look at both pages.


Dispatch `resume-formatter` with the winner and `pages` from the draft's `layout.pages`. If it reports `overflow:`, send its cuts as one revise round (counts toward MAX_ITER), fact-check the revision, and render again. Optionally dispatch `ats-screener` in mode `rendered-check` when the formatter reports parse failures.

## Step 8: cover letter (optional)

Only with `--cover`, or when the submitter reported a cover-letter field. Dispatch `cover-letter-writer` after step 9 (it reads the finalized `resume.json`).

## Step 9: finalize

- Gate passed: `jh resume finalize <run_id> --draft <winner> --json`.
- Gate never passed but the fact check passed: dispatch `conscience` in mode `below-bar`. On `finalize-apply` or `finalize-hold`, run `jh resume finalize <run_id> --draft <winner> --quality below_bar --json`. On `abandon`, `conscience` dismisses the application; do not finalize.
- Finalize refuses (exit 2) when validation fails or the fact check is not `pass`. Never work around it.

Finalize copies the renders to `<artifacts>/<app>/`, writes `provenance.json`, `ats.json`, `review.json`, `factcheck.json`, records the variant for outcome learning, and moves the application to `tailored`.

## Report to the user

One short block: company, title, app id, final ATS, HM verdict, recruiter checks, quality (`ok` or `below_bar`), iterations, files written, and the hiring-manager's `screen_question` (good interview prep).

Then `jh jd compare <app_id> --json` and add one line: must-haves covered (n/m) and any missing ones, keyword coverage %, the headline vs posted title (and if `headline_in_targets` is false, that it is outside the user's target roles), and which roles used an approved title variant. The dashboard shows the same comparison when the user clicks the application under "Ready to apply" (or in the Applications table once applied).

## Failure handling

- A subagent returns malformed output: re-dispatch it once with the error; then continue without it (a missing recruiter-screen just counts as 0/8 for that draft).
- `jh` exits 1: report the message; do not guess paths.
- Never edit `me/master-resume.yaml` from this loop. Missing facts are fixed through `/intake`.
