# Your `me/` workspace

Everything the agents know about you lives in this folder. It is **gitignored** (`/me/`) and never leaves your machine, except when an application form needs a field from it.

Created by:

```
jh me init --dir D:/Projects/Job_Hunter/me     # or any folder; the path is saved as JOB_HUNTER_ME in ~/.job-hunter/.env
```

## What goes where

| Path | You write it? | What it is |
|---|---|---|
| `profile.yaml` | yes | Contact details, work authorization, targets, skills tiers, voice, standard form answers. |
| `preferences.md` | yes | Your values and how you like to be represented. The `conscience` agent decides as you from this. |
| `targets.md` | yes | Roles, companies, locations and salary you are aiming for, in plain words. |
| `decision-policy.yaml` | recommended | Your standing decisions in structured form: recency, titles, per-company caps, eligibility screen, gates, submit confirmation, and the only questions that may reach you. `conscience` reads it first. Change it with `jh policy record`. |
| `sample-resume/` | yes | Your current resume(s): PDF, DOCX or MD. Starting material, not the source of truth. |
| `experience/<employer-YYYY>.md` | yes | One README per role or project: the real story behind the bullets. **This is the most valuable input.** |
| `stories/<slug>.md` | yes | STAR stories for interviews, linked to bullet ids. |
| `master-resume.yaml` | generated | Every bullet you can claim, with stable ids (`acme-analytics-2022.b03`). Written by `jh me ingest`. Text edits are fine; never change ids, employers, titles or dates by hand. |
| `confirmed-metrics.yaml` | generated | Ledger of your decisions on estimated numbers. Written only by `jh metrics confirm`. |
| `metrics.md` | generated | Readable mirror of every number: facts, pending estimates, rejected. |
| `.intake/`, `.cache/` | generated | Intake drafts, change tracking and extracted text. Safe to delete. |

Files whose names start with `_` (like `_TEMPLATE.md` or `_example-acme-2022.md`) are guides. Intake ignores them, and so do the agents.

## The flow

1. Fill in `profile.yaml`, `preferences.md` and `targets.md`.
2. Put your resume in `sample-resume/`.
3. Write one `experience/<employer-YYYY>.md` per role. Copy `experience/_TEMPLATE.md` and read `experience/_example-acme-2022.md` for the level of detail that helps.
4. Run **`/intake`**. The `resume-intake` agent reads everything and writes `.intake/draft.json`. Then `jh me ingest` merges it into `master-resume.yaml`. If two sources disagree on a date or title, you are asked once and the answer is saved in the README front matter.
5. Run **`/confirm-metrics`**. The `metric-miner` agent proposes conservative numbers from your READMEs, showing its arithmetic. You accept, edit or reject each one. Only accepted numbers ever reach a resume.
6. Run `/resume <job>`. Every tailored bullet traces back to a master bullet id.

Re-run `/intake` whenever you edit a README. Ids never change: edited bullets keep their id, new bullets get the next number, and removed bullets are marked `retired: true`. Their ids are never reused.

## Rules the agents follow

- **Fixed:** employers, titles, dates, degrees, certifications, numbers and work authorization come only from you.
- **Open:** wording, ordering, emphasis and framing change per job.
- An estimated number is never used until you accept it.

Check the workspace at any time:

```
jh me status      # what changed since the last intake, what is missing
jh me validate    # schema and id checks
jh metrics list --status estimated
```
