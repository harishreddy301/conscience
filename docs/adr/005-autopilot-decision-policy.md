# ADR-005: Autopilot, a structured decision policy, and conscience as the default decider

- Status: accepted (user approved building it on 2026-10-21, including an official, user-set standing submit approval)
- Date: 2026-10-21

## Context

On 2026-10-21 the user ran a long day of applications and, while doing so, made a dozen standing decisions in chat: only recent postings (14 days, 21 for strong fits, never past 30); stop applying to Data Engineer roles; never apply to 4minds again; screen every FDE posting for clearance, citizen-only, green-card-only and no-sponsorship requirements in both the JD and the form, except where the user overrides for a specific role (Indicium AI); estimate soft form answers conservatively; apply when a Forward Deployed Engineer draft reaches only a hiring-manager "maybe" if the ATS score is 80+; list only the real M.S. coursework; enter the B.Tech only when a form asks; and stop asking "Submit these N?" every batch.

Those decisions ended up as dated prose bullets in `me/preferences.md` and comments in `me/profile.yaml`. Prose works for the `conscience` agent but has three problems:

1. **Not checkable.** Code cannot apply "14 days, 21 max for strong fits" or "max 2 per company", so every batch re-derives them by reading prose, and two agents can read them differently.
2. **Too many questions.** Without a written rule for each recurring judgement call, agents escalated things the user had already decided ("apply to this maybe?", "this form asks about clearance, continue?"). Rule 1 says conscience decides; it needs the rules in a form it can apply mechanically.
3. **No single loop.** `/today` and `/apply` each own part of the flow, with fixed caps and gates. A full run (scout, triage, screen, tailor, gate, submit, report) has no command and no stop conditions.

## Decision

### 1. `me/decision-policy.yaml`, the structured policy

A git-ignored, user-owned YAML file next to `profile.yaml`, validated by zod (`src/policy/schema.ts`). The template ships as `templates/me/decision-policy.example.yaml`. Sections:

| Section | Holds |
|---|---|
| `tracks` | named title families (`fde`, `ai_engineer`, `data_engineer`, ...) as case-insensitive title patterns; used by `triage` and `gates` |
| `triage` | `recency` (`prefer_days` 14, `strong_fit_days` 21, `max_days` 30); `titles` (`include_from: targets` plus extra `include`, `exclude_tracks`); `level_band` (seniority, title words to skip); `per_company` (`max_total` 2, `max_new_if_applied` 1); `company_blocklist`; `user_link_priority` |
| `eligibility` | `skip_if` (`clearance`, `citizen_only`, `green_card_only`, `no_sponsorship`, `government_client`); `scan` (`jd`, `form`); `overrides` (per application, `action: apply_truthfully`) |
| `questions` | `estimable` (allowed, `conservative`, saved to `profile.form_answers` marked as an estimate); `hard_fact_keys` (never estimated) |
| `preflight` | `browser`, `uploads_readable`, `daily_cap`, `account_ats` (e.g. `workday: logged_in_only`) |
| `throughput` | `tailor_parallel` 3, `submit_parallel_tabs` 3, `order` (fit, then recency), `max_minutes` |
| `gates` | `default` (HM verdict `interview`, `ats_min` 80, `recruiter_min` 6); `by_track` (e.g. `fde` also accepts `maybe` at ATS 80+); `layout` (the resume layout gate must pass) |
| `submit` | `confirm: per_batch \| standing`, with who set it, when, and their words |
| `escalate` | the only kinds that reach the user (below) |
| `corrections` | an append-only log of every change, each with a `rev` |

Recency boundaries: age ≤ `prefer_days` is eligible; ≤ `strong_fit_days` only for strong fits; ≤ `max_days` only for links the user supplied; older is skipped. A posting with no known date goes to conscience.

Eligibility screening is code first (`src/policy/eligibility.ts`): sentence-level patterns classify each hit as `required`, `preferred` or `mentioned`. Only `required` hits skip ("clearance preferred" does not; "active TS/SCI clearance required" does). `mentioned` hits go to conscience. An override with `action: apply_truthfully` means apply anyway and answer every such question truthfully.

### 2. Precedence

`eligibility.overrides` and `corrections` > the structured policy sections > `profile.yaml` > `preferences.md` prose > `learnings/playbook.md`.

The CLI computes the effective policy as defaults ← values derived from `profile.yaml` (targets, title excludes, blocklist, daily cap) ← the file's sections ← a replay of `corrections` in order. `preferences.md` stays the place for prose (values, voice, nuance); conscience reads it for anything the policy does not decide.

### 3. Corrections are append-only, and some fields belong to the user

`jh policy record` is the only writer. Each call applies `--set`, `--add` or `--remove` operations, appends one `corrections` entry (`rev`, `at`, `actor`, `ops`, `quote`, `reason`), bumps `rev`, and keeps the file's comments. Entries are never edited or removed.

User-only (refused unless `--actor user`, and `--actor user` needs `--quote` with the user's words):
- anything under `submit` (the standing approval);
- anything under `eligibility.overrides`;
- removing an `escalate` kind (agents may add kinds, never remove them).

### 4. Conscience is the default decider; six kinds escalate

Everything is decided by conscience from the policy, then the prose. Only these reach the user, collected into **one** message per run:

1. `plugin_feature_or_code`: the run needs a plugin feature or a code change;
2. `account_creation_signin_sso`: creating an account, signing in or SSO on a site (application-submitter returns `blocked:account` and never does these);
3. `legal_consent_not_preapproved`: a legal consent the profile does not pre-approve (arbitration is pre-approved by the user);
4. `hard_fact_unknown`: a fact only the user knows and `questions.hard_fact_keys` forbids estimating;
5. `spending_money`;
6. `withdraw_or_decline_offer_or_interview`.

Only the user can remove a kind. Escalations live in a new `escalations` table (`jh autopilot escalations list|add|answer`). An application waiting on one moves to a new **`held`** state with `applications.hold_reason`; it returns to `shortlisted` or `tailored` (or is dismissed) once answered.

### 5. Standing submit approval (Rule 1, amended)

The default stays: one "Submit these N?" per batch. When the user sets `submit.confirm: standing` themselves (recorded with `--actor user` and a quote; mirrored by `autonomy.submit_without_confirm: true` in `profile.yaml`, and `jh policy check` flags a mismatch), `/autopilot` submits every application that passes every gate without asking, then reports exactly what was sent. Agents can never set or revoke it.

### 6. `/autopilot`, the main-session loop

`commands/autopilot.md`: preflight → one batched escalation message (blocking hard facts only) → `run-plan` → scout if needed (user links first) → triage → eligibility → parallel tailoring (`tailor_parallel`) → policy gate → parallel fill and submit in separate tabs (`submit_parallel_tabs`, each submitter pinned to its `tab_id`) → `per_batch` confirm or `standing` → one report with one escalation list.

Stop conditions: the daily cap is reached; `max_minutes` passed; the browser is gone; the policy fails validation; `me/` is not git-ignored; three consecutive submit failures on one ATS; a form asks for an SSN, bank details or passwords (that application is held, the run continues); the candidate queue is empty after one scout.

### 7. CLI and audit

```
jh policy show [--raw]
jh policy check
jh policy record --actor <a> [--quote q] [--reason r] (--set p=v | --add p=v | --remove p=v)...
jh policy eval triage [--app ids] [--status s] [--strong ids]
jh policy eval eligibility <app_id> [--jd file] [--form file]
jh policy eval gate <app_id>
jh autopilot preflight
jh autopilot escalations list [--status open|answered|dismissed|all]
jh autopilot escalations add --kind k --question q [--app id] [--blocking] --actor a
jh autopilot escalations answer <id> --answer a [--dismiss] --actor user
```

Every evaluation and every record writes an audit line that carries `policy_rev`.

### 8. Conscience modes

New modes: `triage-batch`, `eligibility`, `question-class`, `run-plan`, `record-correction`. The policy is the first file conscience reads.

## Consequences

- Recurring judgement calls become deterministic and testable; conscience keeps the nuanced ones.
- The user is asked far less, and always in one batched message.
- A standing approval removes the last routine stop. It is user-only, logged with the user's words, revocable by the user, and reported after every batch.
- Widening the `applications.status` CHECK for `held` uses SQLite's documented `writable_schema` procedure for constraint changes that do not change the on-disk format, followed by a table rename round trip so every open connection reloads the schema. It needs a SQLite build that is not in defensive mode (true for `node:sqlite` on the supported Node versions).
- `preferences.md` keeps the dated prose for humans; `decision-policy.yaml` is what code enforces. `jh policy check` reports drift between them where it can (profile mirrors, hand-edits that a correction overrides).
