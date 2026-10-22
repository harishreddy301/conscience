# ADR-003: Variety from best-of-N drafts, not temperature

- Status: accepted
- Date: 2026-10-15

## Context

The user wants resumes that read as human and varied, not templated, and asked about raising "temperature". Claude's temperature range is 0 to 1, and Claude Code does not let a subagent set it. Even where it can be set, higher temperature mostly adds noise (and fabrication risk), not better choices.

## Decision

- Each `/resume` run dispatches **N = 3** `resume-writer` drafts in parallel with deliberately different **angles**: `impact`, `skills-match`, `domain-reframe`. `conscience` picks the angle mix (see ADR-004 for exploration).
- Drafts are filtered by code (validation, ATS ≥ 60), screened by `recruiter-screen`, and ranked by one opus `hiring-manager` compare call. `conscience` breaks ties within 3 points.
- The winner gets at most 3 revise iterations against the gate (ATS ≥ 80, HM `interview`, recruiter ≥ 6/8, valid), keeping only improvements and stopping early on small gains.
- Realism comes from facts: the user's READMEs and confirmed metrics (ADR-001), never from sampling.

## Consequences

- Variety is controlled and explainable: the three drafts differ in selection, order and vocabulary, all from the same facts.
- Cost is bounded: about 3–4 opus writer calls and 1–4 opus HM calls per job; N and the iteration cap are flags.
- Recorded as Rule 4 in `CLAUDE.md`.
