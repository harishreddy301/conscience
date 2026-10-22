# conscience: architecture (v0.2)

The binding rules are in `/CLAUDE.md`: **autonomy** (agents act as the user; one batch confirmation before submitting, or the user's own standing approval), **fixed experience, open wording**, **efficient browsing**, and **never fabricate; best-of-N instead of temperature**. Decisions are recorded in `docs/adr/`.

## Load-bearing principles

1. **The main session is the manager.** `/today` is the daily orchestrator: the main session plus the `conscience` agent decide and dispatch. Subagents cannot spawn subagents. Dispatch is hub-and-spoke; agents never talk to each other. They write files and state (`jh … --json`) and return only `{id, summary}`.
2. **Code does the deterministic work; LLMs judge and write.** The state machine, storage, validation (number guard, provenance), ATS scoring, rendering, email linking and the study clock live in `jh`. Agents write back through the CLI, which validates with zod.
3. **Personal data never lives in the repo.** User files live in a git-ignored `me/`; machine state in `~/.job-hunter/`. Only `templates/me/**` (`README.md`, `*.example.*`) and `.fixture.` files ship.
4. **Only facts reach output.** Every tailored bullet carries master bullet `source_ids`; every number must match a `fact` metric on those sources ([ADR-001](adr/001-metrics-in-files.md)).
5. **Agents sync external systems into SQLite.** The dashboard server never calls MCP ([ADR-002](adr/002-agents-sync-to-sqlite.md)).
6. **Variety from best-of-N, not temperature** ([ADR-003](adr/003-best-of-n-not-temperature.md)); **learning from outcomes** ([ADR-004](adr/004-outcome-learning.md)).
7. **A structured decision policy; conscience decides by default** ([ADR-005](adr/005-autopilot-decision-policy.md)). `me/decision-policy.yaml` holds the user's standing decisions; code applies its numeric rules (`jh policy eval`); only six escalation kinds ever reach the user, batched once per run.

## Layout

```
.claude-plugin/{plugin.json,marketplace.json}
agents/        18 agents (roster below)
skills/        conscience, jh-cli, resume-loop, tailoring, ats-rules, resume-style,
               me-workspace, metrics-policy, outcome-learning, ats-adapters
commands/      autopilot, today, resume, review-resume, ats-check, cover-letter, apply,
               intake, confirm-metrics, track, prep, study, learn
hooks/hooks.json   SessionStart auth check (auto-discovered; never listed in plugin.json)
src/           cli.ts, core/ (paths, errors, output, audit, state), db/ (migrations, repo,
               resume, tracking, learn, policy), me/, resume/, ats/, render/, tracking/, learn/,
               policy/ (schema, load/record, triage, eligibility, gate, check),
               dashboard/, commands/, adapters/, sources/
dashboard-ui/  index.html, app.js, app.css (copied to dist/dashboard-ui by the build)
dist/          jh.mjs, dashboard.mjs (committed bundles)
scripts/       install-dashboard.ps1, uninstall-dashboard.ps1, install-sync-task.ps1
templates/me/  workspace templates
tests/         unit/, fixtures/ (fictional, *.fixture.*)
docs/          ARCHITECTURE.md, adr/
```

## Agent roster

| Agent | Scope | Model | Tools |
|---|---|---|---|
| conscience | Default decider from `me/decision-policy.yaml`: triage batches, eligibility reviews, form-question classes, run plans, recording the user's corrections; go/no-go; angle mix with exploration; tie-breaks within 3 HM points; below_bar decision; form answers derivable from `me/`; outreach tone | opus | Read, Bash |
| resume-intake | `me/sample-resume` + `experience/*.md` + `stories/` → IntakeDraft. Only stated facts | sonnet | Read, Glob, Grep, Write, Bash |
| metric-miner | Conservative estimated metrics with arithmetic citing README lines | opus | Read, Glob, Grep, Write, Bash |
| resume-writer | One TailoredResume draft per call (impact, skills-match, domain-reframe) or a revise pass | opus | Read, Write, Glob, Grep, Bash |
| hiring-manager | Compare mode ranks drafts; single mode: interview/maybe/reject, must-have evidence, screen question | opus | Read, Write, Bash |
| ats-screener | JD keywords, aliases, knockouts → `keywords.json`; rendered parse-order check | sonnet | Read, Write, Grep, Bash |
| recruiter-screen | 6-second skim: 8-item binary checklist | haiku | Read, Write, Bash |
| fact-checker | Semantic claim-vs-source check after code validation; intake mode | sonnet | Read, Grep, Glob, Write, Bash |
| resume-formatter | `jh resume render`, page fit, rendered re-score | haiku | Bash, Read |
| cover-letter-writer | Short letter in the user's voice; one company page via WebFetch | opus | Read, Write, Bash, WebFetch |
| application-submitter | Fills ATS forms in Claude in Chrome up to submit, one pinned tab each; re-checks eligibility on the form; never creates accounts or signs in (`blocked:account`); submits confirmed ones or under the user's standing approval | sonnet | Read, Write, Bash, Claude in Chrome tools |
| pipeline-clerk | Ghost sweep, follow-ups due, transitions, counts | haiku | Bash |
| outreach-drafter | Recruiter, referral, follow-up notes ≤ 80 words | sonnet | Read, Write, Bash |
| job-scout | `jh discover` + public ATS APIs → `jh app add --status shortlisted` | haiku | Bash, Read, WebFetch |
| email-tracker | Gmail search, classify, `jh email ingest` | sonnet | inherits (Gmail tools + Bash, Read, Write) |
| calendar-sync | Calendar events for 30 days → `jh interview upsert` | haiku | inherits (Calendar tools + Bash, Write) |
| interview-prep | Company brief, likely questions, STAR answers from `me/stories` | sonnet | Read, Write, Grep, Glob, Bash, WebFetch |
| outcome-analyst | `jh learn analyze --json` → plain-language `me/learnings/playbook.md` | sonnet | per `agents/outcome-analyst.md` |
| fit-scorer | JD-vs-profile score | sonnet | **deferred**: conscience go/no-go covers it for now |

Opus is used by 5 agents (conscience, metric-miner, resume-writer, hiring-manager, cover-letter-writer). No browsing agent runs on opus. `tests/unit/agents-frontmatter.test.ts` enforces names, models and the `tools` string format.

## Data split

**`me/`** (resolved: `JOB_HUNTER_ME` → `<repoRoot>/me` → `<jhHome>/me` → legacy `<jhHome>/profile.yaml|resume.yaml`):
- `README.md`, `profile.yaml`, `preferences.md`, `targets.md`, `decision-policy.yaml` (ADR-005; written by `jh policy record`)
- `sample-resume/`, `experience/<id>.md` (front matter `kind: role|project`), `stories/<slug>.md`
- `master-resume.yaml` (generated by `jh me ingest`, text-editable), `confirmed-metrics.yaml` (written only by `jh metrics confirm`), `metrics.md` (generated mirror)
- `learnings/playbook.md`, `learnings/stats.json`
- `.intake/`, `.cache/`

**`~/.job-hunter/`** (`JOB_HUNTER_HOME`): `.env`, `jh.db` (`JOB_HUNTER_DB`), `artifacts/<appId>/`, `inbox/`, `logs/{audit.jsonl,dashboard.log}`, `cache/`.

**Titles:** a master role's `title` is the official title (fixed; used in forms). Optional `title_variants` (user-approved, from experience front matter) may be shown on a tailored resume as `display_title`; `jh resume validate` fails anything else (including a different spelling or casing) with `TITLE_NOT_APPROVED`. The headline follows the JD's posted title within the user's targets; validate warns `HEADLINE_OFF_TARGET` when the headline names none of `profile.targets.roles`.

**Ids:** role `slug(employer)-YYYY`; project `proj-<slug>`; bullet `<roleId>.bNN` (monotonic, never reused, `retired: true` instead of delete); metric `<bulletId>.mN`; tailored bullet `<firstSourceId>#t<n>`.

## SQLite schema (migrations 1 to 4, `src/db/migrations.ts`)

| Table | Holds |
|---|---|
| `companies` | name, normalized name (unique), domain, careers url, ATS, tenant, blocked |
| `jobs` | title, location, remote, url, `source_key` and `fingerprint` (unique), JD text |
| `applications` | one per job: status, source (`conscience`, `external`, `email`), applied_at, last_event_at, artifacts_dir |
| `application_events` | transitions, notes, emails, interviews, follow-ups with actor |
| `emails` | Gmail id, thread, sender domain, subject, snippet ≤ 500, kind, confidence, links |
| `interviews` | calendar event id, application, round, start/end, link, status, prep status and path |
| `study_blocks` | seeded "Morning study" 05:30–08:00 daily (editable) |
| `study_sessions` | clock in/out; one open session at most; block_id null outside blocks |
| `study_tasks` | study checklist items |
| `settings` | study grace, streak minimum, max session, weekly goal (15h), dashboard port (4777), timezone |
| `sync_runs` | gmail/calendar sync runs with cursor and error |
| `resume_runs` | one per /resume run: workdir, JD, keywords, iterations, final draft, ATS, HM verdict, quality |
| `resume_drafts` | drafts per run: angle, iteration, path, ATS, valid |
| `resume_reviews` | ReviewReports per draft (hiring-manager, recruiter-screen, ats-screener, fact-checker) |
| `resume_variants` | the submitted variant per application (angle, framing, keywords, bullet ids, phrasing, ATS, pages, role family, source, title choice) for outcome learning |
| `jd_snapshots` | (migration 2) one short glimpse of the JD per application: posted title, seniority, must-haves, nice-to-haves, keywords, location, remote, salary, summary ≤ 800, source url; written by ats-screener via `jh jd snapshot set`, compared with the finalized resume by `jh jd compare` |

| `escalations` | (migration 4) questions for the user, limited to the policy's six kinds: kind, application, question, blocking, status (`open`, `answered`, `dismissed`), answer, who asked and answered, `policy_rev` |

Migration 3 added `applications.requested_by`/`request_note` (user links); migration 4 added `applications.hold_reason` and the `held` status.

Metrics have no table: they live in `me/` files ([ADR-001](adr/001-metrics-in-files.md)).

## Application state machine (`src/core/state.ts`)

```
discovered   → shortlisted | dismissed
shortlisted  → tailored | dismissed
discovered | shortlisted | tailored → held  (needs a reason; ADR-005)
held         → shortlisted | tailored | dismissed
tailored     → applied                      (needs factcheck.json verdict "pass")
discovered | shortlisted → applied          (external path: applied outside conscience,
                                             found by email or added with --external)
applied      → assessment | interviewing | rejected | ghosted
assessment   → interviewing | offer | rejected | ghosted
interviewing → assessment | offer | rejected | ghosted
ghosted      → assessment | interviewing | rejected   (late replies)
offer        → accepted | declined
any non-terminal → withdrawn
```

- Terminal: dismissed, rejected, accepted, declined, withdrawn.
- Ghosting: `jh app ghost-sweep` moves `applied`/`assessment` with no event for 21 days.
- Emails cause **soft** transitions (forward only, never an error). A `confirmation` email on an unknown application creates an `external`/`email` application when confidence ≥ 0.8 and satisfies the fact-check gate.

## The resume loop (`skills/resume-loop`)

0. Pending estimated metrics → `/confirm-metrics` first.
1. `jh resume prepare` (after conscience go/no-go).
2. ats-screener extracts `keywords.json` → `jh ats keywords set`, and the JD snapshot → `jh jd snapshot set` (read by resume-writer, hiring-manager, fact-checker).
3. conscience picks the angle mix; N = 3 resume-writers in parallel, each self-validating.
4. `jh ats score` + recruiter-screen per draft; drop ATS < 60 or invalid; one hiring-manager compare; conscience tie-break within 3 points.
5. Up to 3 revise iterations with `jh resume gate` (ATS ≥ 80, HM `interview`, recruiter ≥ 6/8, valid); keep only improvements; stop early after two gains < 3.
6. fact-checker (a fail costs one revise round).
7. resume-formatter renders PDF/DOCX/HTML/TXT and fits 1 or 2 pages; rendered re-score. `jh resume layout` runs the layout gate (user spec in `profile.yaml > resume_layout`: exact page count, 2-line bullets with a 60 to 80% second line, one-line skills/Environment/publication rows, last page at least 85% full, bullets per role, no em dash), measured on real line boxes in headless Chrome.
8. Cover letter only on demand.
9. `jh resume finalize` (`--quality below_bar` when conscience accepts a gate miss) → artifacts, variant record, status `tailored`. Finalize always re-runs the layout gate on the final PDF and refuses (`layout_gate_failed`) when it fails; `below_bar` never bypasses it.

## Applying

application-submitter fills each form up to the final button (`ready_to_submit`), only for applications that pass `jh policy eval gate`. With `submit.confirm: per_batch` the main session asks once "Submit these N?" and submits the confirmed ones; with the user's standing approval (`submit.confirm: standing`, set only by the user) it submits everything that passed every gate and reports it. Then `jh app transition <id> applied`. Unknown form answers are classified by conscience (`question-class`): profile answers and conservative estimates are saved under `form_answers:` in `profile.yaml`; hard facts and unapproved legal consents become escalations.

## Decision policy and autopilot (ADR-005)

- `me/decision-policy.yaml` (template `templates/me/decision-policy.example.yaml`, zod in `src/policy/schema.ts`): `tracks`, `triage` (recency 14/21/30, titles from targets minus `exclude_tracks`, level band, per-company caps, blocklist, user links first), `eligibility` (`skip_if`, `scan` JD and form, per-application `overrides`), `questions`, `preflight`, `throughput`, `gates` (default and `by_track`, layout), `submit.confirm`, `escalate.kinds`, `standing_rules`, and the append-only `corrections` log with `rev`.
- Precedence: overrides and corrections > policy sections > `profile.yaml` > `preferences.md` prose > playbook. The effective policy replays `corrections` over the file and merges the profile layer (targets, title excludes, blocklist, daily cap).
- `jh policy record` is the only writer (comments preserved). `--actor user` needs `--quote`; `submit.*`, `eligibility.overrides` and removing an escalate kind are user-only.
- Escalate kinds: `plugin_feature_or_code`, `account_creation_signin_sso`, `legal_consent_not_preapproved`, `hard_fact_unknown`, `spending_money`, `withdraw_or_decline_offer_or_interview`. Everything else conscience decides.
- `/autopilot` (`commands/autopilot.md`): preflight → one batched escalation message → run plan → scout (user links first) → triage → eligibility → parallel tailoring → policy gate → parallel fill/submit in pinned tabs → per-batch confirm or standing approval → report with one escalation list. Stop conditions: daily cap, `max_minutes`, browser gone, policy conflicts, three consecutive submit failures on one ATS, empty queue after one scout.
- Every `jh policy eval`, `jh policy record` and escalation writes an audit line with `policy_rev`.

## Artifacts (`~/.job-hunter/artifacts/<appId>/`)

`resume.json`, `First_Last_Resume_<Co>.pdf|.docx`, `resume.html`, `resume.txt`, `cover.md|.pdf`, `provenance.json` (`{bullet_id: source_ids[]}`), `ats.json`, `review.json`, `factcheck.json`, `answers.json`, `outreach-*.md`, `prep-<interviewId>.md`, and `runs/<run_id>/{jd.txt, keywords.json, draft-*.json, review-*.json, render/}`.

## CLI (`jh`)

Every command supports `--json`. Exit codes: 0 ok, 1 runtime/not found, 2 validation/conflict, 3 illegal transition. Full reference: `skills/jh-cli/SKILL.md`.

```
jh doctor | discover <company>
jh app add|list|show|transition|ghost-sweep|set-posted
jh me init|path|status|extract|ingest|migrate|validate
jh metrics list|propose|confirm
jh resume prepare|validate|render|layout|review add|gate|status|finalize
jh ats keywords set|score
jh jd snapshot set|show|compare
jh cover render
jh email ingest|list|link
jh interview upsert|list|prep
jh study in|out|status|blocks|set|task
jh sync begin|end|status
jh dashboard serve|open|status|install|uninstall
jh learn analyze|playbook|status
jh policy show|check|record|eval triage|eval eligibility <id>|eval gate <id>
jh autopilot preflight|escalations list|add|answer
```

## Tracking and dashboard

- `/track`: email-tracker and calendar-sync write JSON to `~/.job-hunter/inbox/`, then `jh email ingest`, `jh interview upsert`, bracketed by `jh sync begin/end`. Email linking: explicit id → thread → sender domain (ATS domains skipped) → company hint; the rest show as "Needs linking".
- Dashboard (`dist/dashboard.mjs`, `node:http` + `node:sqlite`) on 127.0.0.1:4777: host check (421), POSTs need `X-JH: 1` and JSON (403), CSP `default-src 'self'`, 4 KB bodies. Started at logon by a Task Scheduler task with a respawning supervisor.
- Cards: sync freshness, study clock (block, timer, streak, week vs 15h, checklist), upcoming interviews with prep, ready to apply, applications table, pipeline counts, recent emails and needs-linking, assessments due, pending metrics (accept/edit/reject), and "What's working" (`GET /api/learn`). Clicking an application row opens a "Resume vs JD" side panel (`GET /api/applications/:id/compare`): must-haves ✓/✗ with the evidencing bullets, missing keywords, posted vs headline and display titles.

## Hooks

`hooks/hooks.json` registers SessionStart → `node "${CLAUDE_PLUGIN_ROOT}/hooks/auth-check.mjs"` (timeout 30). The audit trail is written by the CLI itself (`logs/audit.jsonl`). There are no approval hooks; the only approval is the submit confirmation (per batch, or the user's standing approval in the decision policy).

## Deferred

fit-scorer, the full multi-ATS scout pipeline (`jh scout`), LinkedIn (opt-in only, ToS), redacted export, marketplace release.
