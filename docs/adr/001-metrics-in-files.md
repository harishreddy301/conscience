# ADR-001: Metrics live in `me/` files, not in SQLite

- Status: accepted
- Date: 2026-10-15

## Context

Resume numbers ("cut p95 latency 40%") are what recruiters notice first and what the user is most likely to be challenged on. Many real users do not have exact numbers. The plugin needs (a) a way to propose realistic numbers from the user's own READMEs, (b) a human decision on each one, and (c) a hard guarantee that only decided numbers reach a resume. Two designs were proposed: a `metric_claims` table in SQLite, or the metric status in the master resume plus a decision ledger in files.

## Decision

Metrics are stored in `me/`:
- Each metric sits on its master bullet in `master-resume.yaml` with `status: fact | estimated | rejected`, `derivation`, `source_ref`, `confidence`.
- `confirmed-metrics.yaml` is the append-only ledger of the user's decisions (accept, edit, reject), written only by `jh metrics confirm` (from `/confirm-metrics` or the dashboard).
- `metrics.md` is a generated, human-readable mirror.
- There is no metrics table.

`jh resume validate` enforces the rule in code: every numeric token in a tailored bullet must match a `fact` metric on one of its `source_ids` (`NUMBER_UNSOURCED`), and an estimate fails with `ESTIMATED_METRIC`.

## Consequences

- Human-reviewable, diff-able and portable: the user can read and edit their metrics in a text editor and back them up with `me/`.
- Losing or resetting `jh.db` never loses a metric decision.
- The dashboard confirms metrics by calling `src/me/metrics.ts`, so files are the single source of truth.
- Concurrent edits are possible in theory (editor and dashboard); `decideMetric` re-reads the file before writing.
