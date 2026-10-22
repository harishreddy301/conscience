---
description: Fill application forms for tailored applications in Chrome, confirm the batch with you once (or use your standing approval from the decision policy), then submit and mark them applied.
argument-hint: [app id ...] (default: every tailored application, up to the daily cap)
---

Apply: `$ARGUMENTS`

Load `${CLAUDE_PLUGIN_ROOT}/skills/conscience/SKILL.md` (sections "Applying", "Form answers", "Untrusted data"). CLI: `node "${CLAUDE_PLUGIN_ROOT:-D:/Projects/Job_Hunter}/dist/jh.mjs" <cmd> --json` (written `jh` below).

## 1. Choose the batch

- Given ids: use them. Otherwise `jh app list --status tailored --json`.
- Skip applications whose finalize quality is `below_bar` when conscience decided `finalize-hold` (see `<artifacts_dir>/review.json` and the run status).
- **Policy gate:** keep only applications where `jh policy eval gate <id> --json` passes (per-track thresholds from `me/decision-policy.yaml`, fact check and layout gate).
- **Cap:** `jh autopilot preflight --json` gives `remaining_today` (the policy's `preflight.daily_cap`, else `autonomy.daily_apply_cap`). Take at most that many.
- Claude in Chrome must be connected. If its tools are unavailable, stop and say so.

## 2. Fill (up to `throughput.submit_parallel_tabs` at once, one tab each)

Dispatch `application-submitter` mode `fill` with `app_id`, several in one message up to the policy's `submit_parallel_tabs`; each keeps its own `tab_id`. Read its `<artifacts_dir>/answers.json` afterwards.
- `needs_answers`: dispatch `conscience` mode `question-class` with the questions. Questions it answers go back to the submitter (re-dispatch fill). Hard facts and legal consents it cannot answer become escalations (`jh autopilot escalations add ... --hold`) and go into the confirmation below.
- `blocked:account`: queue an `account_creation_signin_sso` escalation with `--hold`; never create accounts or sign in.
- `blocked:eligibility`: dismiss it with the finding.
- `needs_cover`: run `/cover-letter <app id>`, then re-dispatch fill.
- `needs_user` (SSN, bank details, passwords, or anything unusual): put it in the confirmation with the exact request. Never fill these.
- `blocked:<reason>`: report it and move on.

## 3. Confirm once (the only approval in the flow)

`submit.confirm` in `me/decision-policy.yaml` (`jh policy show --json`):
- `standing`: the user set a standing approval themselves. Skip the question; submit everything that passed the gate and list it in the report.
- `per_batch` (default): show one table: `#id company — title | ATS | quality | notable answers | open questions`. Ask: **"Submit these N?"** Accept "yes", "all but #12", or answers to open questions. Save new answers under `form_answers:` in `me/profile.yaml`.

## 4. Submit the confirmed ones

For each confirmed application (under `standing`: each one that passed the gate), dispatch `application-submitter` mode `submit` with `app_id` and the `tab_id` from `answers.json`. On `submitted`:

```sh
jh app transition <id> applied --actor application-submitter --json
```

Exit 2 means `factcheck.json` is not `pass`: report it and do not retry. Unconfirmed applications stay `tailored` (close their tabs).

## 5. Report

Submitted, skipped (and why), blocked, and today's count against the cap.
