# Cloud Credits Resume Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the resume loop in Claude Code cloud sessions, which are billed to the $250 credit that expires 2026-11-05, while scouting, finalize and submit stay on the PC.

**Architecture:** `jh cloud export` builds a "packet" and pushes it to a private `conscience-data` GitHub repo. The packet holds the shortlisted apps, their JD text, `me/` and a DB snapshot. In the cloud, a setup script links the plugin and points `jh` at the data repo, and `/cloud-resume` runs resume-loop steps 0 to 6 per app and pushes the results. `jh cloud import` merges the results into the local DB. `/cloud-finish` then runs layout, formatting and finalize locally and hands off to the existing submit flow.

**Tech Stack:** Node ≥ 22.13, TypeScript, commander, zod, `node:sqlite`, vitest, esbuild (`npm run build` → committed `dist/`), `git` and `gh` CLIs.

**Spec:** `docs/superpowers/specs/2026-10-22-cloud-credits-design.md`

## Global Constraints

- The code repo never contains personal data. `/me/`, `.env*` and `.github/.env` stay ignored, and `jh doctor` must still pass.
- The data repo must be **private**. Export refuses otherwise.
- The export allowlist covers `me/**` except `tk.sh`, `.env*`, `*.backup*` and anything over 5 MB.
- No local artifacts go to the cloud. The 94 MB `~/.job-hunter/artifacts` is never pushed.
- Cloud sessions never ask the user. Anything only the user can answer goes into `summary.json`.
- Cloud stops after resume-loop step 6 (fact check). Layout, render and finalize run locally, because they need Chrome.
- Roster change: `resume-writer` moves to `sonnet`. `hiring-manager` and `conscience` stay `opus`.
- Packet size defaults to 10 apps, with at most 3 apps in parallel in a cloud session.
- CLI output follows the existing convention: `--json`, `emit()`, and exit codes 0, 1, 2, 3.
- Fixtures use the `.fixture.` infix and fictional people only.

## Review Focus

1. **Import run twice.** Re-importing the same packet must insert nothing new and report the runs as `skipped`. Test in Task 4.
2. **A cloud DB from an older or newer schema.** Import must refuse with exit 2 when the `user_version` values differ, and leave the local DB untouched. Test in Task 4.
3. **A secret file sitting in `me/`.** `me/tk.sh`, `me/.env` and `me/sub/.env.local` must never be copied. Test in Task 3.
4. **Data repo accidentally public, or cloned inside the code repo.** Export refuses with exit 2 before writing anything. Test in Task 3.
5. **Partial cloud results**, where the session died after 4 of 10 apps. Import takes the 4 finished apps, and `/cloud-resume` re-run skips apps that already have `results/<packet>/<appId>/`. Test in Task 4, plus the command text in Task 6.

---

### Task 0: Repos, first commit, PAT (needs the user for 2 steps)

**Files:**
- Modify: `.gitignore` (add `layout-*.json` at root if Step 1 finds personal data)

- [ ] **Step 1: Sanitizer pass.** Run the `ecc:opensource-sanitizer` agent on the working tree, with `layout-d1-skills-match.json`, `.agents/`, `.claude/`, `docs/` and `tests/fixtures/` in scope. Expected: PASS or PASS-WITH-WARNINGS, with no real names, emails, phone numbers or keys. Fix by ignoring or moving files, never by committing them.
- [ ] **Step 2: Confirm ignores.** Run `git check-ignore -v me .github/.env .claude/settings.local.json`. Expected: all three are ignored. Then run `node dist/jh.mjs doctor --json`. Expected: `ok: true` for the me-ignored check.
- [ ] **Step 3: First commit, then create the private code repo.**
  ```bash
  git add -A && git commit -m "chore: initial import of conscience plugin"
  gh repo create vvikasreddy/conscience --private --source . --push
  ```
- [ ] **Step 4: Create the private data repo.** Clone it outside the code repo:
  ```bash
  gh repo create vvikasreddy/conscience-data --private --clone   # run in D:/Projects
  ```
  Then set `JOB_HUNTER_DATA_REPO=D:/Projects/conscience-data` in `~/.job-hunter/.env`.
- [ ] **Step 5 (USER): fine-grained PAT.** In GitHub settings, create a fine-grained token limited to `vvikasreddy/conscience-data`, with Contents set to read and write and a 30-day expiry. Only the user can create tokens.
- [ ] **Step 6 (USER): cloud environment.** At claude.ai/code, open environment settings and create `conscience-cloud`:
  - Network: Trusted.
  - Env vars: `DATA_REPO=vvikasreddy/conscience-data` and `DATA_TOKEN=<pat>`.
  - Setup script: `bash scripts/cloud-setup.sh`. The script itself is added in Task 5.

  Run `/web-setup` once in the CLI so cloud sessions can clone the private code repo.

### Task 1: Balanced roster (resume-writer → sonnet)

**Files:**
- Modify: `agents/resume-writer.md` (frontmatter `model:`)
- Modify: `docs/ARCHITECTURE.md:44` (roster row) and `:61` (opus count becomes 4, with the list lacking resume-writer)
- Modify: `tests/unit/agents-frontmatter.test.ts:14`
- Modify: `skills/resume-loop/SKILL.md:18` (budget line: "3 or 4 sonnet writer calls")

- [ ] **Step 1:** Change the test's `ROSTER["resume-writer"]` to `"sonnet"`.
- [ ] **Step 2:** Run `npx vitest run tests/unit/agents-frontmatter.test.ts`. Expected: FAIL on the resume-writer model.
- [ ] **Step 3:** Update the agent frontmatter, the ARCHITECTURE rows and the SKILL budget line.
- [ ] **Step 4:** Run the same test. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(agents): resume-writer on sonnet (balanced plan)`.

### Task 2: ADR 006 and the CLAUDE.md data rule

**Files:**
- Create: `docs/adr/006-private-data-repo-for-cloud.md`, with Context (the credits and the deadline), Decision (the private data repo, the allowlist, the private guard, cloud never submits), Consequences, and Revocation (delete the repo and revoke the PAT).
- Modify: `CLAUDE.md`:
  - under "Where the user's data lives", add one line: "Optional: a private `conscience-data` GitHub repo, used only by `jh cloud export/import` for the user's own cloud sessions (ADR 006)";
  - under "Untrusted data", amend the `me/` sentence to "…except the target application form and the user's private data repo (ADR 006)".

- [ ] **Step 1:** Write both. Commit: `docs: ADR 006 private data repo for cloud sessions`.

### Task 3: `src/cloud/export.ts`, which builds and pushes a packet

**Files:**
- Create: `src/cloud/schema.ts`, `src/cloud/export.ts`, `src/cloud/git.ts`
- Test: `tests/unit/cloud-export.test.ts`, `tests/fixtures/cloud/me.fixture/` (a fictional `profile.yaml`, `master-resume.yaml`, `tk.sh`, `.env`, `sub/.env.local`, `master-resume.backup-1.yaml`)

**Interfaces:**
- Produces, in `schema.ts` (zod schemas plus inferred types):
  - `PacketApp = { app_id: number; company: string; title: string; url: string | null; jd_path: string }`, where `jd_path` is relative, for example `jd/12.txt`.
  - `PacketManifest = { id: string; created_at: string; schema_version: number; apps: PacketApp[] }`, where `id` = `p-YYYYMMDD-HHMM` in local time.
  - `CloudSummary = { packet_id: string; finished_at: string; apps: { app_id: number; run_id: string | null; status: "ready" | "below_bar" | "no_go" | "failed"; ats: number | null; hm_verdict: string | null; notes: string[] }[] }`.
- Produces, in `git.ts`:
  - `type Run = (cmd: string, args: string[], cwd: string) => Promise<string>`, with `defaultRun` built on `execFile`.
  - `assertPrivateRemote(dataDir: string, run: Run): Promise<void>` runs `gh repo view --json visibility -q .visibility` and throws `ValidationError` unless the result is `PRIVATE`.
  - `commitAndPush(dataDir: string, message: string, run: Run): Promise<void>` runs add, commit and push, retrying the push once.
- Produces, in `export.ts`:
  - `isExportable(relPath: string, sizeBytes: number): boolean`
  - `selectApps(db: Db, opts: { appIds?: number[]; queue?: number }): PacketApp[]`. The queue picks `shortlisted` apps where `jobs.jd_text IS NOT NULL` and no finalized `resume_runs` row exists, ordered by `last_event_at`, default 10.
  - `exportPacket(opts: { db: Db; meDir: string; dataDir: string; codeRepoRoot: string; appIds?: number[]; queue?: number; run?: Run; now?: Date }): Promise<PacketManifest>`. It does five things:
    - writes `packets/<id>/packet.json` and `packets/<id>/jd/<appId>.txt`;
    - writes `packets/<id>/jh.db` via `VACUUM INTO`;
    - mirrors the allowlisted `me/` into `dataDir/me/`, deleting files that are no longer present;
    - commits;
    - pushes.

- [ ] **Step 1: Write the failing tests.**
  - `isExportable`: true for `profile.yaml` and `experience/a.md`; false for `tk.sh`, `.env`, `sub/.env.local`, `master-resume.backup-1.yaml`, and any file with `sizeBytes = 6_000_000`.
  - `exportPacket refuses public repo`: a fake `run` returns `PUBLIC`. The call rejects with `ValidationError`, and `dataDir/packets` does not exist.
  - `exportPacket refuses dataDir inside codeRepoRoot`: rejects with `ValidationError`.
  - `exportPacket writes packet`: uses a temp DB with 2 shortlisted apps carrying `jd_text` and a fake private `run`. The manifest has 2 apps; `jd/<id>.txt` equals the stored `jd_text`; `jh.db` opens with the same `userVersion`; `dataDir/me/tk.sh` is absent; and the fake `run` received `push`.
  - `selectApps queue skips finalized`: an app with a finalized run is not selected.
- [ ] **Step 2:** Run `npx vitest run tests/unit/cloud-export.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Implement the three files. Use `ValidationError` from `src/core/errors.ts`, `openDb` and `userVersion` from `src/db/index.ts`, and log `audit("cloud.export", …)` with actor `jh`.
- [ ] **Step 4:** Run the same tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(cloud): packet export to private data repo`.

### Task 4: `src/cloud/import.ts`, which merges results

**Files:**
- Create: `src/cloud/import.ts`
- Test: `tests/unit/cloud-import.test.ts`

**Interfaces:**
- Consumes: `PacketManifest`, `CloudSummary`, `Run`, `defaultRun` (Task 3).
- Produces:
  - `type ImportReport = { packet_id: string; imported: { app_id: number; run_id: string; valid: boolean; errors: string[] }[]; skipped: string[]; missing: number[] }`
  - `importResults(opts: { db: Db; dataDir: string; packetId: string; artifactsRoot: string; validate: (draftPath: string) => { ok: boolean; errors: string[] }; run?: Run }): Promise<ImportReport>`

  Behavior, in order:
  1. `git pull` in `dataDir`.
  2. Read `results/<id>/summary.json`.
  3. `ATTACH` `results/<id>/jh.db`.
  4. Refuse with `ValidationError` if the attached `user_version` differs from the local one.
  5. In one `tx`, copy only `resume_runs`, `resume_drafts` and `resume_reviews` rows whose run id is not yet local, plus each `jd_snapshots` row whose `application_id` has no local row.
  6. Copy `results/<id>/<appId>/<run_id>/` to `<artifactsRoot>/<appId>/runs/<run_id>/`, and rewrite the `workdir` column of `resume_runs` to the local path.
  7. Call `validate` on the winner draft file.

  Apps listed in the manifest but missing from the summary go in `missing`. Import never changes `applications.status`.

- [ ] **Step 1: Write the failing tests.** They use a fixture cloud DB made by migrating a temp DB, inserting 1 run, 3 drafts and 2 reviews for app 1, and writing `summary.json`.
  - `imports new runs`: `imported.length === 1`, and the local `resume_drafts` count for that run is 3.
  - `rewrites workdir`: `getRun(db, id).workdir` starts with `artifactsRoot`.
  - `idempotent`: a second call gives `imported: []` and `skipped: [run_id]`, and the row counts are unchanged.
  - `refuses schema mismatch`: the cloud DB is set to `PRAGMA user_version = 999`. The call rejects with `ValidationError`, and the local counts are unchanged.
  - `partial results`: a manifest of apps [1, 2] with a summary holding only app 1 gives `missing: [2]`.
  - `invalid winner`: `validate` returns `{ok: false, errors: ["TITLE_NOT_APPROVED"]}`, so the result has `valid: false` and those errors.
- [ ] **Step 2:** Run `npx vitest run tests/unit/cloud-import.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. The column lists must match `src/db/migrations.ts`; select explicit columns, never `*`.
- [ ] **Step 4:** Run the same tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(cloud): import cloud resume runs`.

### Task 5: `jh cloud` CLI, setup script, cloud doctor check

**Files:**
- Create: `src/commands/cloud.ts`, exporting `register(program: Command)`, with subcommands:
  - `jh cloud export [--apps 1,2] [--queue 10] --json` prints the `PacketManifest`.
  - `jh cloud import <packet> --json` prints the `ImportReport`. Its `validate` wraps the existing resume validate function in `src/resume/validate.ts`.
  - `jh cloud status --json` prints the packets in the data repo, each with `{id, apps, has_results, imported}`.
  - The data dir comes from `JOB_HUNTER_DATA_REPO`; if it is unset, the command fails with exit 1 and the message `set JOB_HUNTER_DATA_REPO (see ADR 006)`.
- Modify: `src/cli.ts:2-50` to import and add `registerCloud`.
- Create: `scripts/cloud-setup.sh`. It runs only when `$DATA_TOKEN` is set, with `set -euo pipefail`, and does seven things:
  1. clones `https://x-access-token:$DATA_TOKEN@github.com/$DATA_REPO` to `/root/conscience-data` (or pulls if it exists);
  2. runs `mkdir -p .claude/agents .claude/commands .claude/skills`;
  3. links each `agents/*.md` into `.claude/agents/` and each `commands/*.md` into `.claude/commands/`;
  4. links each `skills/*/` folder into `.claude/skills/`;
  5. writes `.claude/settings.local.json` with an `env` holding `CLAUDE_PLUGIN_ROOT=$PWD`, `JOB_HUNTER_ME=/root/conscience-data/me`, `JOB_HUNTER_HOME=/root/jh-home`, `JOB_HUNTER_DB=/root/jh-home/jh.db` and `JOB_HUNTER_DATA_REPO=/root/conscience-data`;
  6. runs `mkdir -p /root/jh-home`;
  7. runs `node dist/jh.mjs doctor --json || true`.

  It never echoes the token, and git is configured with `credential.helper` unset.
- Test: `tests/unit/cli-cloud.test.ts`
  - `cloud export without JOB_HUNTER_DATA_REPO exits 1`;
  - `cloud status lists packets`, against a temp data dir holding one packet with a results folder, giving `has_results: true`.

- [ ] **Step 1:** Write the failing CLI tests, following the pattern in `tests/unit/cli-app.test.ts`.
- [ ] **Step 2:** Run `npx vitest run tests/unit/cli-cloud.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement `cloud.ts` and the script, then register the command.
- [ ] **Step 4:** Run `npm run typecheck && npm run lint && npx vitest run && npm run build`. Expected: everything is green, and `dist/jh.mjs` contains `cloud`.
- [ ] **Step 5:** Commit: `feat(cloud): jh cloud export|import|status and cloud setup script`, then `git push`.

### Task 6: `/cloud-resume`, `/cloud-finish`, and the spike

**Files:**
- Create: `commands/cloud-resume.md`, the main-session procedure for a cloud session. Its steps:
  1. `jh cloud status --json`, then pick the packet named in the argument, or the newest one without results.
  2. Copy `packets/<id>/jh.db` to `$JOB_HUNTER_DB`, unless a previous attempt already did.
  3. For each app without `results/<id>/<appId>/`, at most 3 at a time, run `skills/resume-loop` **steps 0 to 6 only**, with these cloud overrides:
     - step 0 never asks the user; affected roles go into `notes`;
     - step 1 reads the JD from `packets/<id>/<jd_path>` and runs no WebFetch.
  4. After each app, copy its run dir to `results/<id>/<appId>/<run_id>/`, update `summary.json`, copy the DB with `VACUUM INTO results/<id>/jh.db`, then commit and push.
  5. Finish with a one-line report.

  It never submits, never opens a browser, and never edits `me/`.
- Create: `commands/cloud-finish.md`, the local procedure:
  1. `jh cloud import <packet> --json`.
  2. For each `valid` app, run resume-loop steps 7 to 10 (layout, formatter, finalize) against the imported `run_id`.
  3. Apps that are not `valid`: run one local revise round, or report them in the batched ask.
  4. Hand off to `/autopilot` step 7 (gate) and step 8 (fill, then "Submit these N?").
- Modify: `skills/resume-loop/SKILL.md` to add a short "Cloud mode" note that points to `commands/cloud-resume.md` for the two overrides.
- Modify: `.claude-plugin/plugin.json` to append the two new commands to the `commands` array.

- [ ] **Step 1: Spike with fake data.**
  - Locally, set `JOB_HUNTER_ME=tests/fixtures/cloud/me.fixture`, use a temp DB holding one fictional shortlisted app, and run `jh cloud export --queue 1`.
  - Then run `claude --cloud "/cloud-resume"` in env `conscience-cloud`.
  - Expected: the session lists `/cloud-resume` and the plugin agents, `jh doctor` runs, and `results/<id>/summary.json` is pushed with 1 app.
  - If the agents don't load, change the setup script's linking (the only undocumented step) before continuing.
- [ ] **Step 2:** Run `jh cloud import <id>` locally on the spike packet. Expected: `imported.length === 1`. Then delete the spike packet folders from the data repo and push.
- [ ] **Step 3:** Commit and push: `feat(cloud): cloud-resume and cloud-finish commands`.

### Task 7: First real packets and the budget check

- [ ] **Step 1:** Locally, run `/autopilot` up to shortlisting so at least 10 apps are `shortlisted` with JD text. Then run `jh cloud export --queue 2`.
- [ ] **Step 2:** Run `claude --cloud "/cloud-resume"`. When it finishes, note the credit balance on claude.ai/settings/usage before and after, and write the cost per app to `me/learnings/cloud-cost.md`.
- [ ] **Step 3:** Run `/cloud-finish <id>` locally. Expected: 2 finalized resumes and a "Submit these 2?" prompt.
- [ ] **Step 4: Decide the pace.**
  - At or under $2.50 per app: packets of 10, one or two a day, until about $20 of credit is left.
  - Over $2.50: set `MAX_ITER = 2` in the resume-loop defaults for cloud mode, then re-measure on the next packet.
- [ ] **Step 5:** Set `autonomy.daily_apply_cap: 10` in `me/profile.yaml`.

---

## Schedule against the Nov 5 deadline

| Day | Work |
|---|---|
| Oct 22–23 | Tasks 0–5. The build itself can run in a cloud session to use credits instead of the subscription. |
| Oct 23 | Task 6 spike, then Task 7 with 2 apps |
| Oct 24 – Nov 4 | About 1 packet of 10 per day, about 12 packets, about 120 apps |
| Nov 4 | Stop exporting new packets when the balance is under $20; finish and import what's left |
