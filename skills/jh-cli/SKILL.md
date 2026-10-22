---
name: jh-cli
description: Reference for the jh CLI that every conscience agent and command uses to read and write state - the canonical call form, exit codes, JSON conventions, and every command with its flags (doctor, discover, app, me, metrics, resume, ats, cover, email, interview, study, sync, dashboard, learn, policy, autopilot, cloud).
---

# jh CLI reference

## Call form (canonical)

```sh
node "${CLAUDE_PLUGIN_ROOT:-D:/Projects/Job_Hunter}/dist/jh.mjs" <cmd> [args] --json
```

- `CLAUDE_PLUGIN_ROOT` is set inside the plugin; the fallback is the development clone.
- After the maintainer runs `npm link` in the repo, a bare `jh <cmd>` also works. Agents use the full form so they never depend on that.
- Below, `jh` means the full form.

## Conventions

- Always pass `--json` and parse stdout as JSON.
- Exit codes: **0** ok, **1** runtime error or not found, **2** validation error or conflict, **3** illegal state transition.
- With `--json`, errors print `{"error":"<code>","message":"…","details":…}` to stdout.
- `--file -` reads JSON from stdin where a command takes `--file`.
- Timestamps are UTC ISO-8601.
- Paths: user data in `me/` (`jh me path`), machine state in `~/.job-hunter/` (`JOB_HUNTER_HOME`), artifacts in `~/.job-hunter/artifacts/<appId>/`.

## Health and discovery

| Command | Does |
|---|---|
| `jh doctor` | `{node, nodeOk, home, me:{path,source,exists}, meIgnored, db, dbOk, chrome, pendingMetrics}`; exit 2 if Node is too old or `me/` is not git-ignored |
| `jh discover <company>` | finds a company's career boards: `{boards:[{ats,tenant,site?,url}], otherPages[]}`; needs `EXA_API_KEY` |

## Applications (`jh app`)

| Command | Does |
|---|---|
| `jh app add --company <c> --title <t> [--url u] [--domain d] [--status s] [--applied-at iso] [--source external\|email]` | creates company, job and application (returns the existing one on duplicates). Default status `shortlisted` |
| `jh app list [--status a,b] [--active] [--since 30d] [--limit n]` | newest activity first |
| `jh app show <id>` | application with company, title, url, status, `artifacts_dir` |
| `jh app transition <id> <status> [--note s] [--actor name] [--email-id n] [--external]` | state machine move; exit 3 if illegal. `applied` needs `factcheck.json` verdict `pass` unless `--external` |
| `jh app ghost-sweep [--days 21]` | `applied`/`assessment` with no event for N days become `ghosted` |

States: `discovered → shortlisted | dismissed`; `shortlisted → tailored | dismissed`; `discovered | shortlisted | tailored → held` (needs `--note`, stored as `hold_reason`); `held → shortlisted | tailored | dismissed`; `tailored → applied`; `discovered|shortlisted → applied` (external only); `applied → assessment | interviewing | rejected | ghosted`; `assessment → interviewing | offer | rejected | ghosted`; `interviewing → assessment | offer | rejected | ghosted`; `ghosted → assessment | interviewing | rejected`; `offer → accepted | declined`; any non-terminal → `withdrawn`.

## The user's workspace (`jh me`, `jh metrics`)

| Command | Does |
|---|---|
| `jh me init [--dir <path>] [--force]` | creates `me/` from templates and records `JOB_HUNTER_ME` in `~/.job-hunter/.env` |
| `jh me path` | where `me/` resolved from: `{path, source: env\|repo\|home\|legacy, exists}` |
| `jh me status` | `{files:[{rel,sha1,changed}], lastIntake, missing[]}` |
| `jh me extract` | DOCX/MD sample resumes to `me/.cache/text` (PDFs are read with the Read tool's `pages`) |
| `jh me ingest <draft.json>` | merges an IntakeDraft into `master-resume.yaml`: `{added,updated,retired,conflicts,lint}`; exit 2 on fixed-fact conflicts |
| `jh me migrate` | moves legacy `~/.job-hunter/profile.yaml`/`resume.yaml` into `me/` |
| `jh me validate` | schema-checks every `me/` file |
| `jh metrics list [--status fact\|estimated\|rejected] [--role id]` | metric views with bullet text |
| `jh metrics propose --file <proposals.json>` | adds estimated metrics (metric-miner only) |
| `jh metrics confirm <id> --accept \| --edit <value> [--phrase s] \| --reject` | the user's decision; only `/confirm-metrics` and the dashboard call it |

## Resume runs (`jh resume`, `jh ats`, `jh cover`)

| Command | Does |
|---|---|
| `jh resume prepare --jd <file> --company <c> --title <t> [--url u] [--app id]` | `{run_id, app_id, workdir, jd_path, master_path, profile_path, pending_estimates}`; workdir `<artifacts>/<app>/runs/<run_id>/` |
| `jh resume validate <draft.json>` | ValidationResult `{ok, errors[], warnings[]}`; exit 2 if not ok; registers the draft for its run |
| `jh resume render <draft.json> [--formats html,pdf,docx,txt] [--out dir] [--pages 1\|2]` | RenderResult `{files, pages, density, overflow_lines?, pdf_text_ok?, warnings}` |
| `jh resume review add <run_id> --file <review.json>` | stores a ReviewReport |
| `jh resume gate <run_id> --draft <id>` | GateResult `{pass, ats, hm_verdict, recruiter_passes, valid, factcheck, reasons}` |
| `jh resume status <run_id>` | drafts, reviews and scores so far |
| `jh resume finalize <run_id> --draft <id> [--quality ok\|below_bar]` | writes artifacts, provenance, ats/review/factcheck JSON; application → `tailored`; exit 2 if invalid or fact check not `pass` |
| `jh ats keywords set <run_id> --file <keywords.json>` | stores JdKeywords for the run |
| `jh ats score <draft.json> --keywords <file> [--rendered <dir>]` | AtsReport `{total, components, missing_required, failed_knockouts, parse_failures, stuffing}` |
| `jh cover render <cover.md> --app <id> [--formats pdf,docx,txt]` | renders the cover letter into the artifacts folder |
| `jh jd snapshot set <appId> --file <snap.json>` | stores the short JD snapshot (JdSnapshot: `title_posted`, `seniority?`, `must_haves[]` (term or `{term, aliases}`), `nice_to_haves[]`, `keywords[]`, `location?`, `remote?`, `salary?`, `summary` ≤ 800 chars, `source_url?`); ats-screener only |
| `jh jd show <appId>` | the stored snapshot (exit 1 `no_snapshot` if none) |
| `jh jd compare <appId> [--draft <draft.json>]` | deterministic resume vs JD: `must_haves[{term, covered, evidence[], also_in[]}]`, `missing_must_haves`, `keywords{covered, missing, coverage_pct}`, `titles{posted, headline, headline_matches_posted, headline_in_targets, display_titles[]}`; the finalized resume unless `--draft` |

## Tracking (`jh email`, `jh interview`, `jh sync`)

| Command | Does |
|---|---|
| `jh email ingest --file <path\|-> [--dry-run]` | classified emails into SQLite; links them and moves applications forward (soft) |
| `jh email list [--unlinked] [--kind k] [--limit n]` | stored emails |
| `jh email link <emailId> <appId>` | manual link |
| `jh interview upsert --file <path>` | calendar events keyed by `calendar_event_id` |
| `jh interview list [--upcoming] [--days 14] [--prep s]` | interviews |
| `jh interview prep <id> --status queued\|ready\|done [--path p]` | prep status |
| `jh sync begin --kind gmail\|calendar` | `{runId, cursor}` |
| `jh sync end <runId> (--ok --items n [--new n] [--cursor c] \| --error <code>)` | closes a sync run |
| `jh sync status` | freshness per source |

## Study clock and dashboard

| Command | Does |
|---|---|
| `jh study in [--topic t]` / `jh study out [--notes n]` | clock in/out (exit 2 `already_clocked_in` / `not_clocked_in`) |
| `jh study status` | today's block, streak, week hours vs goal |
| `jh study blocks list` / `jh study blocks add --label l --days 1,2,3 --start HH:MM --end HH:MM` / `jh study blocks rm <id>` | study blocks |
| `jh study set <key> <value>` | settings such as `timezone`, `study.weekly_goal_hours` |
| `jh study task add\|list\|done` | study checklist |
| `jh dashboard serve [--port] [--home]` / `open` / `status` / `install [--port] [--open-at-logon]` / `uninstall` | the local dashboard on 127.0.0.1:4777 |

## Outcome learning (`jh learn`)

| Command | Does |
|---|---|
| `jh learn analyze [--json]` | callback rates by framing, angle, role family, source, keyword; Wilson lower bound, lift, strength |
| `jh learn playbook --write` | writes `me/learnings/playbook.md` and `stats.json` |
| `jh learn status` | last analysis and new outcomes since |

## Decision policy (`jh policy`, ADR-005)

The user's structured decisions live in `me/decision-policy.yaml`. Precedence: `eligibility.overrides` and `corrections` > policy sections > `profile.yaml` > `preferences.md` > playbook. Every `eval` and `record` writes an audit line with `policy_rev`.

| Command | Does |
|---|---|
| `jh policy show [--raw]` | `{path, exists, rev, policy, derived, resolved}`: the effective policy (the file with `corrections` replayed; `--raw` = the file as written), the profile layer, and resolved target titles, blocklist, level words and daily cap |
| `jh policy check` | `{ok, rev, conflicts[], warnings[]}`; exit 2 on conflicts (`hand_edit_overridden`, `submit_mirror_mismatch`, `standing_not_user_set`, `escalate_kind_missing`, `unknown_track`, `duplicate_override`, ...) |
| `jh policy record --actor <a> [--quote q] [--reason r] [--set path=value]... [--add path=value]... [--remove path=value]...` | values are YAML (`--add 'eligibility.overrides={app_id: 80, action: apply_truthfully}'`); appends a correction, bumps `rev`, keeps comments: `{path, rev, correction}`. `--actor user` needs `--quote`. `submit.*`, `eligibility.overrides` and removing an `escalate` kind are user-only (exit 2 `user_only_field`); `rev`/`corrections` are not writable |
| `jh policy eval triage [--app ids] [--status s,...] [--strong ids] [--actor a]` | `{policy_rev, counts, results:[{app_id, company, title, track, age_days, user_link, decision: include\|review\|skip, reasons}]}`; default candidates `shortlisted,discovered`; user links first, then freshest; per-company caps applied in that order |
| `jh policy eval eligibility <app_id> [--jd file] [--form file]` | `{verdict: eligible\|skip\|review\|apply_truthfully, findings:[{rule, strength: required\|preferred\|mentioned, source: jd\|form, excerpt}], reasons, override, scanned}`; JD from the DB unless `--jd`; form from `<artifacts>/form.txt` unless `--form` |
| `jh policy eval gate <app_id>` | `{pass, track, rule, reasons, input}` from the finalized artifacts (`review.json`, `ats.json`, `factcheck.json`, `layout.json`) and the per-track gate |

## Autopilot (`jh autopilot`)

| Command | Does |
|---|---|
| `jh autopilot preflight` | `{ok, policy_rev, submit_confirm, checks:[{name, ok (null = main session checks), detail}], remaining_today, blocking_escalations, throughput, account_ats}`; checks policy, `me_ignored`, `uploads_readable`, `daily_cap`, `browser`, `blocking_escalations` |
| `jh autopilot escalations list [--status open\|answered\|dismissed\|all] [--app id]` | `{escalations:[…]}`, blocking first |
| `jh autopilot escalations add --kind <k> --question <q> --actor <a> [--app id] [--blocking] [--hold] [--context json]` | queues a question (deduplicated while open): `{escalation, created, held}`. Kinds: `plugin_feature_or_code`, `account_creation_signin_sso`, `legal_consent_not_preapproved`, `hard_fact_unknown`, `spending_money`, `withdraw_or_decline_offer_or_interview`; exit 2 `not_escalated` if the policy no longer lists the kind. `--hold` moves the application to `held` |
| `jh autopilot escalations answer <id> (--answer a \| --dismiss) [--actor user]` | the user's answer; only `--actor user` (exit 2 `user_only_field`). Release a held application afterwards with `jh app transition <id> shortlisted\|tailored` |

## Cloud sessions (`jh cloud`, ADR 006)

The resume loop can run in Claude Code cloud sessions through the user's private `conscience-data` repo. `JOB_HUNTER_DATA_REPO` names its local clone; without it every subcommand exits 1 (`data_repo_unset`).

| Command | Result |
|---|---|
| `jh cloud export [--apps 1,2] [--queue n]` | `PacketManifest {id, created_at, schema_version, apps:[{app_id, company, title, url, jd_path}]}`; writes `packets/<id>/` (packet.json, `jd/<appId>.txt`, a `jh.db` snapshot), mirrors the allowlisted `me/` (never `tk.sh`, `.env*`, `*.backup*` or files over 5 MB), commits and pushes. `--queue` (default 10) takes shortlisted apps with JD text and no finalized run. Exit 2 if the repo is not private or sits inside the code repo |
| `jh cloud import <packet>` | `ImportReport {packet_id, imported:[{app_id, run_id, valid, errors}], skipped:[run_id], missing:[app_id]}`; pulls, copies run dirs into `<artifacts>/<appId>/runs/`, inserts only new runs (re-running is safe), re-validates each winner. Exit 2 `schema_mismatch` when the cloud DB's schema differs. Never changes application status |
| `jh cloud status` | `{data_dir, packets:[{id, apps, has_results, imported}]}` |
