# conscience

**An autonomous job-hunting team for [Claude Code](https://claude.com/claude-code).** You describe who you are once: your experience, the fields you've worked in, your targets, values and dealbreakers. A team of agents then works *as you*. It tailors your real experience to each job description (best of three drafts, judged by a simulated hiring manager, recruiter and ATS), renders a polished one- or two-page resume, fills applications, tracks replies from Gmail and Calendar, and keeps a local dashboard of your pipeline, interviews and study time.

> Status: v0.2 in development. Design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Decisions: [docs/adr/](docs/adr/).

**Honest expectations:** conscience improves callback odds; cannot guarantee a call. Nothing can. It makes every application as strong and as true as your experience allows, sends more of them, and learns from what gets responses.

## 🚀 For LinkedIn Visitors: How to Run This Locally

There is no live website for conscience, and that is on purpose. This agent handles highly sensitive data: your resume, work history, contact details and job-search emails. So it is built as a **100% private, local CLI tool** that runs on your own machine. Your data never leaves your computer except when an application is submitted to the employer you chose.

Get it running in four steps:

1. **Download the code:** clone this repository (or use **Code → Download ZIP**) and open the folder in a terminal.
2. **Install the tools:** [Node.js](https://nodejs.org/) 22.13 or newer, and [Claude Code](https://claude.com/claude-code).
3. **Build it:**
   ```sh
   npm install && npm run build
   ```
4. **Create your private workspace:**
   ```sh
   jh me init
   ```
   (Without `npm link`, run `node dist/jh.mjs me init` instead.) Your workspace is git-ignored, so your personal files are never committed. See `templates/me/` for example files that show the format.

Then follow the Quick start below to fill in your details and run your first `/today`.

## Quick start

```sh
# 0. build once (development clone)
npm install && npm run build
npm link                       # optional: makes a bare `jh` available

# 1. create your private workspace (git-ignored)
jh me init --dir D:\Projects\Job_Hunter\me
jh doctor                      # me.source=env, meIgnored=true
```

2. **Fill in `me/`** (each folder has a README):
   - `profile.yaml`: contact details, work authorization, target roles, skills, voice.
   - `preferences.md`: values, dealbreakers, how you sound.
   - `targets.md`: roles, companies, locations, salary floor.
   - `sample-resume/`: your current resume (PDF, DOCX or MD).
   - `experience/<role>.md`: one README per role or project (context, team and scale, what you did, tools, outcomes, numbers you are unsure about).
   - `stories/`: STAR stories for interviews (optional).
3. In Claude Code, run **`/intake`**. It extracts only facts stated in your files into `me/master-resume.yaml`, with stable ids.
4. Run **`/confirm-metrics`**. The metric-miner proposes conservative numbers derived from your READMEs; you accept, edit or reject each one. Only confirmed numbers ever appear on a resume.
5. Install the dashboard: **`jh dashboard install`** (starts at logon on http://127.0.0.1:4777; add `--open-at-logon` to open it too).
6. Each morning, run **`/today`**.

Without `npm link`, replace `jh` with `node dist/jh.mjs`.

## What `/today` does

`/today` is the **manager**: the main Claude Code session, with the `conscience` agent making judgement calls as you, orchestrates the whole team. In order it:
1. syncs Gmail and Calendar (`/track`) and queues interview prep;
2. sweeps the pipeline (ghosted applications, follow-ups due);
3. asks you about any pending estimated metrics;
4. refreshes outcome learning weekly (`/learn`);
5. lists applications ready to apply;
6. finds new roles at your target companies (job-scout) and tailors resumes for queued jobs (`/resume`);
7. fills applications and asks you **once**: "Submit these N?" (`/apply`);
8. reports, including your study streak.

## Commands

| Command | Does |
|---|---|
| `/today` | the daily run above |
| `/intake` | your files → `master-resume.yaml` |
| `/confirm-metrics` | decide estimated metrics |
| `/resume <url\|file\|app id> [--cover]` | best-of-3 tailored resume, fact-checked, rendered to PDF/DOCX |
| `/review-resume <app id>` | hiring-manager, recruiter and ATS review of an existing resume |
| `/ats-check <app id>` | ATS score, missing keywords, knockouts, parse problems |
| `/cover-letter <app id>` | short letter in your voice |
| `/apply [ids]` | fill forms, confirm once, submit |
| `/track` | Gmail + Calendar → pipeline and interviews |
| `/prep <interview id>` | company brief, likely questions, STAR answers |
| `/study` | study clock and blocks |
| `/learn` | what's working: callback rates by resume framing, angle and keywords |

## The team

| Agent | Role | Model |
|---|---|---|
| conscience | Decides as you: go/no-go, angle mix, tie-breaks, below-bar resumes, form answers | opus |
| resume-intake | Extracts stated facts from your resume and READMEs | sonnet |
| metric-miner | Proposes conservative metrics from your READMEs, for you to confirm | opus |
| resume-writer | Writes one tailored draft per angle, or revises | sonnet |
| hiring-manager | Ranks drafts and gives an interview / maybe / reject verdict | opus |
| ats-screener | Extracts JD keywords and knockouts, stores a short JD snapshot for resume-vs-JD compare; checks rendered parse order | sonnet |
| recruiter-screen | 6-second skim, 8-item checklist | haiku |
| fact-checker | Checks every claim against its source bullets | sonnet |
| resume-formatter | Renders PDF/DOCX/HTML/TXT and fits 1 or 2 pages | haiku |
| cover-letter-writer | Short letter in your voice | opus |
| application-submitter | Fills forms in Claude in Chrome; submits only what you confirm | sonnet |
| job-scout | Finds open roles at target companies via public ATS APIs | haiku |
| pipeline-clerk | Ghost sweep, follow-ups, transitions | haiku |
| outreach-drafter | Recruiter, referral and follow-up notes (≤ 80 words) | sonnet |
| email-tracker | Classifies Gmail and ingests it | sonnet |
| calendar-sync | Interviews from Calendar | haiku |
| interview-prep | Prep briefs from your stories | sonnet |
| outcome-analyst | Turns outcome statistics into a plain-language playbook | sonnet |

**fit-scorer is deferred.** Until it ships, job-scout filters by title and location only, and `conscience` makes the go/no-go call per job.

## Realism, variety and temperature

People ask whether a higher "temperature" would make resumes more varied or more human. Claude's temperature range is 0 to 1, and it cannot be set for Claude Code subagents at all, so conscience does not rely on it. **Realism** comes from your own words: the metric-miner derives numbers from the READMEs you wrote, and you confirm each one before it can be used. **Variety** comes from best-of-3: three drafts with deliberately different angles (impact, skills match, domain reframe), ranked by an opus hiring-manager and code scoring, then revised up to three times. Outcome learning keeps about 20% of drafts exploring other angles. None of this can guarantee a job call; the system maximises the odds.

## Privacy guarantee

- Everything personal stays on your machine: `me/` (your files) and `~/.job-hunter/` (database, artifacts, logs). Your data goes only to Claude (as with any Claude Code session) and to the employer's own form for applications you confirm. Mail and calendar are read through the connectors you enable; only the subject, sender and a 500-character snippet are stored, locally.
- `/me/` is git-ignored. `jh doctor` fails if it is not, and CI rejects commits that contain personal files. The repo ships only templates (`templates/me/**`, `*.example.*`) and fictional fixtures.
- The dashboard listens on 127.0.0.1 only and rejects other hosts.
- Job descriptions, emails and web pages are treated as data; agents never follow instructions inside them, and never send your data anywhere but the target form.
- Every action taken in your name is logged to `~/.job-hunter/logs/audit.jsonl`.

## Requirements

- Claude Code
- Node.js ≥ 22.13 (Node 24 recommended; uses `node:sqlite`)
- Google Chrome (PDF rendering; DOCX is produced without it)
- Optional: Claude in Chrome (for `/apply`), Gmail and Google Calendar connectors (for `/track`), `EXA_API_KEY` in `~/.job-hunter/.env` (for job-scout's `jh discover`)

## Development

```sh
npm install
npm run build       # bundles src/ → dist/jh.mjs and dist/dashboard.mjs (committed)
npm test
npm run typecheck
npm run lint
node dist/jh.mjs doctor
```
