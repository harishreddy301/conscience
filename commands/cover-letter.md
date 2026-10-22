---
description: Write and render a short cover letter in your voice for an application that already has a finalized resume.
argument-hint: <app id>
---

Cover letter for application `$ARGUMENTS`.

CLI: `node "${CLAUDE_PLUGIN_ROOT:-D:/Projects/Job_Hunter}/dist/jh.mjs" <cmd> --json` (written `jh` below).

1. `jh app show $ARGUMENTS --json`. The status must be `tailored` or later and `<artifacts_dir>/resume.json` must exist; otherwise tell the user to run `/resume $ARGUMENTS` first.
2. Find the JD: `<artifacts_dir>/runs/<run_id>/jd.txt` (the `run_id` is in `resume.json`).
3. Dispatch `cover-letter-writer` with `app_id`, `artifacts_dir`, the JD path, and the company url if known. It writes `cover.md` and runs `jh cover render`.
4. Show the user the letter text (from `<artifacts_dir>/cover.md`) and the rendered files. If the user asks for changes, re-dispatch with their notes.
