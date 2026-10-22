# ADR-004: Learn from outcomes with deterministic statistics and exploration

- Status: accepted
- Date: 2026-10-15

## Context

The user asked the system to "learn from the resume used, for the jobs, from what succeeded and what did not succeed". A single user produces small samples (tens of applications), so naive "what worked last time" would chase noise and lock in early.

## Decision

- `jh resume finalize` records the submitted variant per application in `resume_variants` (angle, framing, keywords, bullet ids, phrasing, ATS score, pages, role family, source).
- Outcomes are derived by code from status and events: `positive` (assessment, interviewing, offer), `negative` (rejected), `ghosted` (21+ days with no event), `pending` otherwise.
- `jh learn analyze` computes callback rates per feature value with `n`, the Wilson 95% lower bound and lift versus baseline. Patterns with `n < 3` are never reported; `n < 8` is `weak`, otherwise `moderate`.
- `outcome-analyst` (sonnet) turns the JSON into `me/learnings/playbook.md`; every claim cites n and strength.
- `resume-writer` reads the playbook before drafting; `conscience` uses it for the angle mix with **about 20% exploration** (jobs where `app_id % 5 == 0` use all three angles and prefer the non-best angle in ties).
- `/today` runs `/learn` weekly or after 5 new outcomes.

## Consequences

- Learning is honest about uncertainty and cannot override fact rules.
- Exploration costs a little expected performance now to keep estimates from freezing on early luck.
- The dashboard's "What's working" card shows the same summary (`GET /api/learn`).
