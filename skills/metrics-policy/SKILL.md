---
name: metrics-policy
description: Rules for numbers on a resume. Defines which metrics are facts, how metric-miner derives conservative estimates from the user's READMEs, how values and phrases are written so the number guard can match them, and how the user confirms them. Load for metric-miner, /confirm-metrics, resume-writer and fact-checker.
---

# Metrics policy

Numbers earn callbacks. A wrong number costs the offer, or worse. So the system holds one invariant:

> **Only `status: fact` metrics can appear in a tailored resume.** `jh resume validate` fails any draft containing a number that is not a fact metric on one of the bullet's `source_ids` (`NUMBER_UNSOURCED`), or that matches a pending estimate (`ESTIMATED_METRIC`).

## Lifecycle

```
README / resume states it ──► resume-intake ──► fact
README hints at it ─► metric-miner ─► estimated ─► /confirm-metrics ─┬─ accept ─► fact
                                                                   ├─ edit ───► fact (new value)
                                                                   └─ reject ─► rejected (never proposed again)
```

- Statuses live on each metric in `me/master-resume.yaml`. Every decision is also appended to `me/confirmed-metrics.yaml` (`confirmed | edited | rejected`, with `decided_at`), and `me/metrics.md` is regenerated.
- Re-ingest keeps all decisions. If the master is ever rebuilt, the ledger re-applies them.
- If a source later states an estimated value verbatim, ingest promotes it to fact.

## What counts as a fact

A number the user wrote as true in a resume, or in a README's Outcomes, Team & scale or What I did section. resume-intake copies it verbatim. A number under "Numbers I'm unsure about" is **not** a fact, even when it looks precise.

## How metric-miner may estimate

Allowed derivations, each from quantities written in the user's README:

1. **Restating a hinted number.** The README says "probably around a third" → `~30%`. Confidence `high` when the user gives the number itself, `medium` when the wording is vaguer.
2. **One multiplication or ratio.** "about 10 analysts" × "2 hours a week each" → `20 hours/week`, proposed as `15+ hours/week` after rounding down. Confidence `medium`.
3. **Before and after.** "900 credits" → "600 credits" → `~33% fewer`. Round toward the smaller claim (`~30%`). Confidence `medium`.
4. **Scale from Team & scale.** "40 million events per day at peak" can back a bullet about the ingestion service: `40M events/day (peak)`. Keep qualifiers like "peak".

Not allowed:

- quantities that are not in the user's files (industry benchmarks, typical team sizes, the job description);
- revenue, cost, profit or headcount impact without a base figure in the README;
- more than one chained inference, or combining numbers from different roles;
- percentages computed from a base the user did not give;
- re-proposing a rejected value, or one the bullet already has.

**Conservatism:** use the lower bound of any range, round down, and prefer `~`, `about` or `N+` phrasing. When unsure between two values, propose the smaller one. Use at most 2 proposals per bullet.

## Writing `value` and `phrase`

The validator matches numeric tokens. Write them so a resume line can reuse them exactly:

- `value` is the number with its unit, as it would read in a resume: `40 minutes`, `15 hours/week`, `~30%`, `40M events/day`, `$120K`, `3x`.
- `phrase` is a short resume-ready clause that **contains `value` verbatim**: "saving analysts about 15 hours/week".
- One number per metric. "From 6 hours to 40 minutes" is two numbers, so it needs the phrase to contain both, and the writer may use only the tokens present in `value` or `phrase`.
- Digits glued to letters (S3, EC2, Python 3.11) are not metrics and need none.

## Derivation text

Each derivation must stand on its own in a 5-second read inside AskUserQuestion. Name the source, quote the inputs and show the arithmetic:

`README "Numbers I'm unsure about": ~10 of 25 analysts x ~2 h/week = 20 h/week; rounded down to 15 h/week.`

## Confirming (/confirm-metrics, dashboard)

- Ask in batches of up to 4, each with the options Accept, Edit and Reject. Show the bullet, the phrase and the derivation.
- Only the user decides. Agents never call `jh metrics confirm` without an explicit answer from the user for that metric id.
- Edit takes the user's value exactly. If the user changes the wording, pass `--phrase` with a clause that contains the new value.

## For resume-writer and fact-checker

- Use a metric only through its `metric_id` on a source bullet: `metrics: [{metric_id, text}]` in the tailored bullet.
- Rephrase around a number freely, but never change the number, its unit or its qualifier (`~`, `+`, "peak").
- A pending estimate is invisible to drafting. If a role really needs it, the resume loop runs `/confirm-metrics` first.
