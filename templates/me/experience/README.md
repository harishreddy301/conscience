# experience/

One Markdown file per role or project, named `<employer-slug>-<start-year>.md` (for example `acme-2022.md`) or `proj-<name>.md`.

These READMEs are the most valuable thing you give the agents. A resume bullet says *what*. A README says *how big, for whom, with what, and what changed*. That depth lets the agents reword your real work for different jobs, and lets `metric-miner` propose believable numbers instead of inventing them.

## Format

Start every file with front matter. Then write the seven sections below as `##` headings (copy `_TEMPLATE.md`).

```yaml
---
kind: role            # role | project
employer: Acme Analytics
title: Data Engineer  # your official title (fixed; used in application forms)
title_variants:       # optional: other titles you approve for this role on a resume
  - Data Platform Engineer
  - Analytics Engineer
start: 2022-03        # YYYY-MM
end: present          # YYYY-MM or present
location: Austin, TX
---
```

| Section | What to write |
|---|---|
| `## Context` | The company, product and business problem, in 2–4 sentences. |
| `## Team & scale` | Team size, users, data volumes, request rates, budgets: any size you know. |
| `## What I did` | Bullets in your own words. One idea per bullet. Say "I" for your part, "we" for the team's. |
| `## Tools` | Languages, frameworks, platforms you actually used here. |
| `## Outcomes` | What changed because of your work. Write the numbers you **know**. |
| `## Numbers I'm unsure about` | Rough figures you believe but cannot prove ("I think about 30 analysts used it"). `metric-miner` turns these into estimates for you to confirm. |
| `## Anything else` | Awards, promotions, things you were trusted with, what you would do differently. |

## Rules

- **Title variants:** job titles differ from posting to posting. A tailored resume may show the official `title` or one of your `title_variants` for this role, whichever is closest to the job description. Only titles you list here are allowed; application forms always get the official title. The headline at the top of the resume follows the posted title of each job (within your targets).
- **Front matter is the truth** for employer, title and dates. When `/intake` finds a disagreement with your resume, it asks you once and writes your answer here.
- A number written under **Outcomes** is a fact. A number under **Numbers I'm unsure about** is only a hint: it is never used until you confirm it in `/confirm-metrics`.
- Files starting with `_` are ignored. `_example-acme-2022.md` is a fully worked fictional example.
- Edit freely, then run `/intake` again. Bullet ids stay stable.
