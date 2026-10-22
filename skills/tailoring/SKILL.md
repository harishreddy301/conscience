---
name: tailoring
description: How to tailor the user's real experience to one job description - the three draft angles, the XYZ bullet formula, keyword mirroring, provenance ids, and the rule that only confirmed fact metrics reach a resume. Read by resume-writer, fact-checker and cover-letter-writer.
---

# Tailoring: fixed experience, open wording

## What is fixed (never change, never invent)

Employers, official job titles, start and end dates, degrees, certifications, work authorization, and every number. Numbers come only from master-resume metrics with `status: fact`. `estimated` metrics are proposals awaiting the user's `/confirm-metrics`; `rejected` ones are dead. `jh resume validate` enforces this and fails a draft with `NUMBER_UNSOURCED`, `ESTIMATED_METRIC` or `FIXED_FACT_CHANGED`.

## Titles: they depend on the job description

- **Headline** (`basics.headline`, the target title at the top): use the JD's posted title (`jh jd show <app_id>` → `title_posted`) when it is one of the user's targets; otherwise the closest target title. It names the job sought, never a title the user held.
- **Role titles:** `title` is the official title, copied verbatim (forms and background checks use it). `display_title` is what the resume shows: the official title or one of that role's user-approved `title_variants` from the master, whichever is closest to the posted title. Nothing else (`TITLE_NOT_APPROVED`). No variants recorded → show the official title; suggest in the run report that the user add `title_variants:` to `me/experience/<role>.md`.

## What is open (do it freely and well)

- Reword real work in the target field's vocabulary. A Spark job that fed dashboards is "data engineering" for a DE role, "analytics infrastructure" for an analytics role, "platform" for a platform role.
- Mirror the JD's exact phrasing for skills the user really has (`Amazon Web Services (AWS)` if the JD says that).
- Reorder, merge, split and re-emphasize bullets. Give the most space to the roles that prove the must-haves.
- Surface buried skills that are recorded in the master resume or profile.

## Provenance

Every tailored bullet has `source_ids` = the master bullet ids it came from (`acme-2022.b03`). Merged bullets list every source. The tailored id is `<firstSourceId>#t<n>`. The summary's `source_ids` may also use `profile:<key>`. Retired bullets cannot be used.

## The three angles (best-of-N)

| Angle | Lead with | Best when |
|---|---|---|
| `impact` | outcomes and scale: the biggest fact metrics first, verbs of ownership the sources support | the JD stresses results, ownership, seniority |
| `skills-match` | the JD's required stack, in its order; each bullet shows a required term in use | the JD is a long tool list or the ATS gate is the risk |
| `domain-reframe` | the target industry's problems; the same work told as that domain's story | the user is changing fields or the JD is domain-heavy |

All three use the same facts. They differ in selection, order and vocabulary, which is where real variety comes from (subagent temperature cannot be set).

## The XYZ bullet

"Accomplished **X**, as measured by **Y**, by doing **Z**."
- Start with a strong past-tense verb the source supports (Built, Cut, Migrated, Led only if the source shows leading).
- Put the JD keyword in the Z part, in context, not as a list.
- Y must be a fact metric from the source bullet. If there is none, write a qualitative result that the source states ("adopted by all three product teams") instead of a number.
- One idea per bullet, 1 to 2 lines (≤ 200 characters; validate warns above 220).

## Keyword mirroring

1. Cover every `required` term the master genuinely supports at least once in a bullet, plus once in skills or the summary.
2. Weight-3 terms belong in the top third of page 1 (headline, summary, first role).
3. Use the JD's spelling; add the alias once in parentheses if the master used another form.
4. Never more than 4 uses of one term (the stuffing penalty starts at 5).
5. Never add a required term the user lacks. A missing must-have is the hiring-manager's call, not something to paper over.

## Summary

At most 450 characters, 2 or 3 sentences: target title + years (`profile:experience_years`), the two strongest proof points in the JD's vocabulary, and the domain. No "passionate", no "results-driven".

## Learnings

If `me/learnings/playbook.md` exists, apply its `moderate` patterns (for example "quantified first bullet in current role: lift 1.6, n=14, moderate"). Treat `weak` patterns as tie-breakers only. Never let a playbook pattern override a fact rule.
