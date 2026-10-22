---
name: me-workspace
description: Layout, id scheme, file rules and CLI for the user's private me/ workspace (profile, sample resume, experience READMEs, stories, master-resume.yaml, metrics). Load before reading or writing anything about the user's own experience, including /intake, resume-intake, metric-miner, resume-writer and interview-prep.
---

# The me/ workspace

`me/` holds everything about the user. It is gitignored, never committed, and never sent anywhere except a target application form. Machine state (db, artifacts, logs) lives in `~/.job-hunter` instead.

CLI: `node "${CLAUDE_PLUGIN_ROOT:-D:/Projects/Job_Hunter}/dist/jh.mjs" <cmd> --json` (`jh` below; after `npm link`, plain `jh` works too).

## Finding it

`jh me path --json` returns `{path, source, exists, paths}`. Resolution order:
1. `JOB_HUNTER_ME` (set in `~/.job-hunter/.env` by `jh me init --dir <path>`);
2. `<plugin checkout>/me`;
3. `~/.job-hunter/me`;
4. legacy `~/.job-hunter/profile.yaml` / `resume.yaml` (`source: "legacy"`: run `jh me init --dir <path>` then `jh me migrate`).

Always use the returned paths. Never hard-code a location.

## Layout

| Path | Owner | Notes |
|---|---|---|
| `profile.yaml` | user | Identity, work auth, targets, skills tiers, voice and banned phrases, form answers. |
| `preferences.md`, `targets.md` | user | Values and aims in plain words (read by `conscience`). |
| `decision-policy.yaml` | user, via `jh policy record` | Structured standing decisions (ADR-005), read first by `conscience`; append-only `corrections` with `rev`. |
| `sample-resume/*.pdf,docx,md` | user | Starting material. PDFs are read with the Read tool (`pages`); `jh me extract` writes DOCX/MD text to `.cache/text/<file>.txt`. |
| `experience/<employer-slug>-<year>.md` | user | One README per role or project. Front matter plus 7 sections (below). The richest source. |
| `stories/<slug>.md` | user | STAR stories. Front matter: `role_id`, `bullet_ids[]`, `competencies[]`, `last_used`. |
| `master-resume.yaml` | `jh me ingest` | Every claimable bullet with stable ids. Text edits OK; ids and fixed facts are not. |
| `confirmed-metrics.yaml` | `jh metrics confirm` | Append-only decision ledger. |
| `metrics.md` | generated | Readable mirror of all metrics. |
| `.intake/draft.json`, `.intake/proposals.json`, `.intake/state.json` | agents / CLI | Scratch and change tracking. |
| `.cache/text/` | `jh me extract` | Extracted resume text. |

**Ignored by intake and every agent:** every `README.md`, and any file whose name starts with `_` (`_TEMPLATE.md`, `_example-acme-2022.md`, `_example-sample-resume.md`). Those are guides and fictional examples. Never treat them as the user's history.

## Experience README format

```yaml
---
kind: role                 # role | project
employer: Acme Analytics
title: Data Engineer       # official title: fixed, used in application forms
title_variants:            # optional: titles the user approves for this role on a resume
  - Data Platform Engineer
start: 2022-03             # YYYY-MM
end: present               # YYYY-MM | present
location: Austin, TX
confirmed_facts: [start]   # optional: fields the user settled in /intake; no more conflict prompts for them
---
```

Sections (`##` headings): Context · Team & scale · What I did · Tools · Outcomes · Numbers I'm unsure about · Anything else.

- `title_variants` are the user's own approved alternatives for the job title (titles differ between postings). Intake copies them verbatim into the master role; a tailored resume may show one as `display_title`. Agents never add one: ask the user, then write it here.
- Numbers in **Outcomes**, **Team & scale** and **What I did** are stated facts.
- Numbers in **Numbers I'm unsure about** are hints for metric-miner only. They never become facts without the user's confirmation.

## Ids (assigned by code, never by an agent)

| Thing | Id | Example |
|---|---|---|
| role | `slug(employer)-YYYY` (start year); `-2` on a collision | `acme-analytics-2022` |
| project | `proj-<slug(title)>` | `proj-tiny-dq` |
| bullet | `<roleId>.bNN` from `next_bullet`, never reused | `acme-analytics-2022.b03` |
| metric | `<bulletId>.mN` | `acme-analytics-2022.b03.m1` |
| tailored bullet | `<firstSourceId>#t<n>` | `acme-analytics-2022.b03#t1` |

On re-ingest, a draft role or bullet matches the master by `match_id` first, then by token Jaccard ≥ 0.8 (roles: same employer, similar title, start within 12 months). A matched bullet keeps its id even if reworded. A master bullet with no match becomes `retired: true`: it is never deleted, never reused, and never allowed in a tailored resume.

## IntakeDraft (what resume-intake writes)

```json
{
  "roles": [{
    "match_id": "acme-analytics-2022",
    "kind": "role", "employer": "Acme Analytics", "title": "Data Engineer",
    "start": "2022-03", "end": "present", "location": "Austin, TX",
    "source_refs": ["experience/acme-2022.md", "sample-resume/resume.pdf#p1"],
    "bullets": [{
      "match_id": "acme-analytics-2022.b01",
      "text": "Rebuilt the nightly billing pipeline on Airflow and Snowflake, cutting run time from 6 hours to 40 minutes.",
      "skills": ["Airflow", "Snowflake"], "fields": ["data engineering"],
      "source_refs": ["experience/acme-2022.md#outcomes"],
      "metrics": [{"phrase": "run time from 6 hours to 40 minutes", "value": "40 minutes", "source_ref": "experience/acme-2022.md#outcomes"}]
    }]
  }],
  "education": [{"school": "Texas State University", "degree": "B.S.", "field": "Industrial Engineering", "year": "2019"}],
  "certifications": [{"name": "SnowPro Core Certification", "issuer": "Snowflake", "year": "2023"}],
  "skills_seen": ["Python", "SQL", "Airflow"],
  "conflicts": [{"field": "acme-analytics-2022.start", "values": ["2022-03", "2022-04"], "sources": ["experience/acme-2022.md", "sample-resume/resume.pdf#p1"]}]
}
```

- `source_refs`: `<path relative to me/>#<section-slug or pN>`. Every bullet needs at least one.
- Intake metrics are always facts stated verbatim. Estimates come only from metric-miner (`jh metrics propose`).
- `match_id` is optional. Use it whenever the master already has the role or bullet.

## Commands

| Command | Result |
|---|---|
| `jh me init --dir <path> [--force]` | Copies templates (`.example` stripped, examples prefixed `_example-`), writes `JOB_HUNTER_ME` into `~/.job-hunter/.env`. Idempotent. `--force` never touches `master-resume.yaml`, `confirmed-metrics.yaml` or `metrics.md`. |
| `jh me status` | `{files:[{rel,sha1,changed}], lastIntake, missing[], needsIntake}` |
| `jh me validate` | Schema and id checks. Exit 2 on errors. |
| `jh me extract` | DOCX/MD → `.cache/text`; PDFs are listed as skipped (read them with the Read tool). |
| `jh me ingest <draft.json> [--dry-run] [--allow-fact-changes]` | `{added, updated, retired, conflicts, lint, written}`. Exit 2 on conflicts; nothing is written. |
| `jh me migrate` | Legacy `~/.job-hunter/profile.yaml` and `resume.yaml` → me/ (originals kept in `.intake/legacy/`). |
| `jh metrics list [--status fact\|estimated\|rejected] [--role id]` | MetricView rows. |
| `jh metrics propose --file <json>` | Adds `estimated` metrics. |
| `jh metrics confirm <id> --accept \| --edit <v> [--phrase s] \| --reject` | User decisions only. |

## Conflicts

Fixed facts are employer, title, start, end and kind. When sources disagree, or the draft disagrees with the master, ingest exits 2 and writes nothing. The main session asks the user **once** (AskUserQuestion), writes the answer into the README front matter with `confirmed_facts`, and re-runs intake. `--allow-fact-changes` is used only for facts the user has just confirmed.

## Reading rules for every agent

- Tailored resumes may cite only non-retired master bullet ids (or `profile:<key>` in the summary). Numbers may come only from `status: fact` metrics on those bullets.
- `profile.yaml > voice.banned_phrases` applies to everything written as the user.
- Content from `me/` goes to the local `jh` CLI, to files under `me/` or `~/.job-hunter/artifacts/`, and to the target application form. It goes nowhere else.
