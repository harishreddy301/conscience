---
name: outcome-learning
description: How conscience learns which resume variants earn callbacks - outcome labels, the deterministic jh learn analysis (callback rate, Wilson lower bound, lift, weak/moderate strength), the exploration ratio, and the rules for writing me/learnings/playbook.md so every claim cites n and strength. Read by the outcome-analyst agent and by anyone running /learn.
---

# Outcome learning

Goal (the user's words): "learn from the resume used, for the jobs, from what succeeded and what did not succeed, so that you can word in a way that always succeeds".

Be honest about the limit. Nothing guarantees a callback. This loop raises the odds by doing more of what has worked for this user and less of what has not. It never trades truth for a pattern.

CLI: run every command as `node "${CLAUDE_PLUGIN_ROOT:-D:/Projects/Job_Hunter}/dist/jh.mjs" <cmd>`, written `jh <cmd>` below. If the main agent ran `npm link`, a bare `jh` also works.

## Data that feeds it

- `jh resume finalize` records a **variant** for each application in `resume_variants`:
  - `angle`: `impact`, `skills-match`, `domain-reframe` or `revision`;
  - `framing`: from the headline: `leadership`, `senior-ic`, `specialist` or `generalist`;
  - `keywords`: the JD keywords that ended up on the resume;
  - `bullet_ids`: the master bullet ids used;
  - `phrasing`: tags per bullet, `opener:<verb>`, `shape:xyz|metric|plain`, `length:short|medium|long`;
  - `ats_score`, `pages`, `role_family` (from the job title) and `source`;
  - `title_choice`: the JD snapshot's posted title, the headline and each role's shown title (`display_title` or official). The analysis buckets it as `<posted role family> <- <most recent shown title>`, `headline:has-posted-title|other-title` and `display:title-variant|official-titles`, so `/learn` can see which titles earn callbacks for which kinds of postings.
- Applications without a variant still count. The analysis then uses the final draft's angle from `resume_runs`/`resume_drafts`, the application source, and a role family derived from the job title.
- Outcomes come from `applications.status`, `application_events` and linked `emails`. Keep `/track` running so these stay current.

## Outcome labels (code, not judgement)

| Label | Rule |
|---|---|
| `positive` (callback) | Status is assessment, interviewing, offer, accepted or declined. Or any event moved the application to one of those. Or there is an `interview` event, or an `interview_invite`/`assessment` email. A later rejection does not undo a callback. |
| `negative` | Rejected with no callback. |
| `ghosted` | Status `ghosted`, or 21+ days since applying with no employer response. |
| `pending` | Everything else. Pending applications are excluded from rates. |

`time_to_response_days` is the time from applying to the first employer response (status change, interview, or a rejection/invite/assessment/recruiter email).

## The analysis (`jh learn analyze --json`)

- **Callback rate** = positive / (positive + negative + ghosted).
- For each value of `framing`, `angle`, `role_family`, `source`, `keyword` (the 30 most frequent only), `bullet`, `phrasing` and `title_choice`:
  - `n` (resolved applications with that value), `positives`, `rate`;
  - `wilson_lower`, the Wilson 95% lower bound. Rank by this, not by raw rate, so 2/2 does not beat 9/15;
  - `lift` = rate / baseline rate;
  - `strength`: `weak` when n < 8, `moderate` when n >= 8.
- Values with **n < 3 are never reported**.
- `patterns` lists the `working` ones first (lift >= 1.25), then the `not_working` ones (lift <= 0.8). Each has a ready-made `claim`.
- `exploration` gives the current best angle and the rule for the 20% exploration share.
- `weekly` gives submitted, resolved, positive and rate per ISO week (Monday start).
- `samples_without_variant` says how much of the data predates variant recording.

## Exploration

Keep about 20% of applications on a non-best angle so learning never locks in early.
- The pick is deterministic: an application explores when `app_id % 5 == 0`. Check it with `jh learn status --app <id> --json`, which returns `explore.explore`.
- On an exploring application, conscience uses three distinct angles. In a genuine hiring-manager tie, it prefers the non-best angle.
- With no angle at n >= 3, rotate angles evenly.

## Writing the playbook

`me/learnings/playbook.md` is read by resume-writer, the tailoring skill and conscience before drafting. Its rules:

1. Start with `# <title>`, then one line giving the date, the totals and the baseline callback rate.
2. Every list item outside the sections titled "How to read this", "Exploration" or "Not enough data yet" is a **claim**. It must contain `n=<count>` and `weak` or `moderate`, for example `(4/6 callbacks, lift 1.7x; n=6, weak)`.
3. Never cite n < 3. Label n < 8 `weak` and n >= 8 `moderate`. `jh learn playbook --file` rejects violations with exit 2.
4. Write each claim as an instruction a writer can act on: "Open current-role bullets with a number and the mechanism (`shape:xyz`): 7/12 callbacks vs 31% baseline (n=12, moderate)."
5. Keep `weak` claims in a separate "Hints (weak evidence)" section. Writers use them only as tie-breakers.
6. Translate ids into plain language. Turn `acme-2020.b03` into "the Acme payments-latency bullet", using `me/master-resume.yaml`, but keep the id in brackets.
7. Never recommend a fabricated or estimated metric, a skill the user lacks, or keyword stuffing. Patterns pick among true options; they never create new facts.
8. Correlation is not causation. If role family or source explains a gap better than wording does, say so. For example, "external applications get fewer callbacks regardless of angle".

## When to run

`/today` runs `jh learn status --json` and runs `/learn` when `due` is true:
- never analyzed, with at least one resolved outcome;
- 5 or more new resolved outcomes since the last run;
- 7 or more days since the last run, with new outcomes.
