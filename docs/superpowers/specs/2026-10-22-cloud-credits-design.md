# Run the resume work on cloud session credits

Date: 2026-10-22. Status: draft for review.

## Goal

Spend the $250 of Claude Code cloud session credits (they expire 2026-11-05, 02:59 EST) on the most expensive part of the job hunt, the resume loop, without breaking the project rules. The submit step and Gmail tracking stay local on the subscription.

**Success:** about 120 finalized, fact-checked, tailored resumes before Nov 5, with all of the credits used on job-hunt work and none of the local subscription usage spent on drafting.

## What the user decided (2026-10-22)

| Question | Decision |
|---|---|
| Where can personal data live for cloud sessions | A **private GitHub data repo**, separate from the code |
| Code repo | **Private for now**; make it public later, after a sanitizer pass |
| Quality level | **Balanced**: Sonnet 5.5 writes the drafts; Opus 5.5 still judges (hiring-manager) and decides (conscience) |
| API key / DeepSeek | Not used. The credits apply automatically to cloud sessions on the claude.ai account. |

## Facts this design relies on (from Claude Code docs, 2026-10-22)

- Cloud sessions clone a GitHub repo. Git-ignored and untracked files are never included, so `me/` and `~/.job-hunter/` stay local unless we push them.
- Each session's filesystem is its own. Nothing carries over except what is pushed to git. Results come back as pushed branches.
- Environments have env vars, a setup script that runs before Claude starts, and a network level (Trusted by default).
- Node 22 is pre-installed. No browser is listed, so the cloud does no Chrome rendering.
- Claude in Chrome only drives the local Chrome. Submitting stays local.
- The repo's `.claude/agents`, `.claude/commands` and `.claude/skills` load in a cloud session. Loading a repo-root `.claude-plugin` is **not documented**, so the setup script links the plugin folders into `.claude/` (verified first in Task 0's spike).
- The $250 credit is not described in the docs. The usage page at claude.ai/settings/usage is the only place to see what is left.

## Architecture: the cloud writes, the PC submits

```
 PC (subscription)                 GitHub (private)                 Cloud session (credits)
 ─────────────────                 ────────────────                 ───────────────────────
 /autopilot: scout, triage,
 eligibility (as today)
 jh cloud export ──push──────────▶ conscience-data repo
   me/  + db snapshot                packets/<packet>/  ──clone──▶ setup script: link plugin,
   + packet.json (app ids,                                          npm build, set env
     JD text)                                                       /cloud-resume <packet>:
                                                                     resume loop steps 0-6 per app
                                                                     (drafts, ATS, recruiter,
                                   results/<packet>/  ◀──push────    HM judge, revise, fact-check)
 jh cloud import ◀──pull─────────
   copy run dirs, merge DB rows,
   re-validate locally
 layout + formatter + finalize (local, needs Chrome)
 application-submitter fills, "Submit these N?" (as today)
```

### Units

1. **Code repo `conscience` (private, GitHub).** The current repo after a first commit and a sanitizer pass. It holds no personal data, as today.
2. **Data repo `conscience-data` (private, GitHub).** It holds:
   - `me/`: a copy of the user's `me/` folder, leaving out `tk.sh` and any `.env*`.
   - `packets/<id>/packet.json`: the batch to work on: app ids, company, title, URL and JD path.
   - `packets/<id>/jd/<appId>.txt`
   - `packets/<id>/jh.db`: a snapshot made with `VACUUM INTO`, about 3 MB.
   - `results/<id>/`: written by the cloud: one run dir per app, the cloud's `jh.db` and `summary.json`.

   Artifacts that already exist locally (94 MB) are never pushed.
3. **`jh cloud export --apps <ids> | --queue <n>`** (new, in `src/cloud/`). It builds the packet, commits it to a local clone of the data repo and pushes. It refuses to run if the data repo's remote is not private (`gh repo view --json visibility`) or if the clone sits inside the code repo.
4. **Cloud environment `conscience-cloud`.** Its settings:
   - Network: Trusted, which covers GitHub and npm. JD text comes from the packet, so no other domains are needed.
   - Env: `DATA_REPO=vvikasreddy/conscience-data` and `DATA_TOKEN`, a fine-grained PAT with contents read/write on that one repo only.
   - Setup script `scripts/cloud-setup.sh` does four things:
     - clones the data repo to `/root/conscience-data`;
     - links `agents/`, `commands/` and `skills/` into `.claude/`;
     - writes `.claude/settings.local.json` with the env values `CLAUDE_PLUGIN_ROOT=<repo>`, `JOB_HUNTER_ME=/root/conscience-data/me`, `JOB_HUNTER_HOME=/root/jh-home` and `JOB_HUNTER_DB=/root/jh-home/jh.db`;
     - copies the packet DB into place.
5. **`/cloud-resume <packet>` command** (new, `commands/cloud-resume.md`). It runs `skills/resume-loop` steps 0 to 6 for each app in the packet, with up to 3 apps in parallel. Then it writes `summary.json`, holding per-app status, ATS, HM verdict and `below_bar` reasons, and pushes `results/<packet>/` to the data repo. Two adjustments for the cloud:
   - Step 0 (pending estimated metrics) never asks the user. A role with estimates is tailored without them, and the app is listed in the summary.
   - It stops before layout, rendering and finalize, because those need Chrome. They run locally.
6. **`jh cloud import <packet>`** (new). It pulls the data repo, then does four things:
   - copies each run dir into `artifacts/<appId>/runs/`;
   - copies `resume_runs`, `resume_drafts` and `resume_reviews` rows from the cloud DB into the local DB with `ATTACH`, keyed by run id;
   - re-runs `jh resume validate` on each winner;
   - prints which apps are ready for layout and finalize.

   Run ids are timestamp-based and created in the cloud, so they do not collide with local ids. Rows are inserted only when the run id is new, so an import can be run twice safely.
7. **Local finish: `/cloud-finish <packet>`** (new command). For each imported app it runs resume-loop steps 7 to 10 (layout, `resume-formatter` on Haiku, finalize). Then it hands the app to the normal `/autopilot` submit step, which keeps the submit confirmation unchanged.

### Model changes (Balanced)

- `resume-writer`: opus → **sonnet**, applied everywhere, both cloud and local.
- `hiring-manager` and `conscience` stay on opus. Everything else is unchanged.
- `docs/ARCHITECTURE.md` roster and `tests/unit/agents-frontmatter.test.ts` are updated together.

### Rules this touches

- **"No personal data in the repo, ever."** This still holds for the code repo. The data repo is a separate, private, user-approved store, recorded in a new `docs/adr/006-private-data-repo-for-cloud.md`, with a matching line in CLAUDE.md under "Where the user's data lives".
- **"Never send `me/` data anywhere except the target application form."** The ADR adds one exception the user approved: the user's own private GitHub data repo, read only by the user's own cloud sessions. Export enforces it: the repo must be private, and an allowlist of files is applied.
- **Rule 1 (autonomy).** Cloud sessions never ask the user. Anything that needs the user goes into `summary.json` and is raised locally in the next run's single batched ask.
- **Rule 2 (facts).** No change. Validate, the fact-checker and `ESTIMATED_METRIC` all run in the cloud, and import validates again locally before finalize.
- **Submitting.** No change: local, through the existing `ready_to_submit` and confirmation flow.

## Budget and pacing

- Balanced is about $1.80 per app, so $250 covers about 120 apps. Allocation: about $15 for building and testing in cloud sessions, about $215 for resumes, $20 left as a buffer.
- Packets of 10 apps, about $18 each. About one packet a day lands at $250 by Nov 5.
- After each packet, the user checks claude.ai/settings/usage. Cloud sessions can't report credits, so `summary.json` records only app counts and draft counts.
- After the first packet, the per-app cost is re-checked. If it is over $2.50, recruiter-screen and the revise rounds are trimmed (`MAX_ITER` 3 → 2) before the next packet.
- Set `autonomy.daily_apply_cap` to 10 locally so the submit pace keeps up.

## Error handling

| Failure | What happens |
|---|---|
| Push fails | Export or the cloud session retries once, then stops with a clear message. The local DB is never changed by export. |
| Cloud session ends early (VM reclaimed) | Results for finished apps are pushed after each app, not only at the end. A second `/cloud-resume` run skips apps that already have results. |
| Schema mismatch between the cloud DB and the local DB | Import checks `PRAGMA user_version` and refuses on a mismatch. |
| Validation fails on import | Import reports the app with `valid: false` and its errors, and does not finalize it. `/cloud-finish` runs one local revise round for it, or lists it in the batched ask. |

## Testing

- Unit tests for `src/cloud/`:
  - the export file allowlist (`tk.sh`, `.env*` and backups are excluded);
  - the private-repo guard;
  - packet build;
  - import row merge and idempotency, against a fixture DB with the `.fixture.` infix.
- The agents-frontmatter test is updated for `resume-writer: sonnet`.
- Spike (Task 0): one cloud session on a fake packet with fictional fixture data confirms that the plugin loads, `jh` runs and a push to the data repo works, before any real data leaves the PC.
- End to end: one real packet of 2 apps, then a full packet of 10.

## Out of scope

- Claude in Chrome or form filling from the cloud.
- Gmail or Calendar from the cloud.
- Scheduled routines.
- The API key or DeepSeek path.
- Making the code repo public; that is a later sanitizer pass and its own decision.
