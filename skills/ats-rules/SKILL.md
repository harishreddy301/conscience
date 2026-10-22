---
name: ats-rules
description: How conscience scores resumes against applicant tracking systems - the 100-point rubric, knockouts, stuffing penalty, parse-safety rules, thresholds (pass 80, floor 60), and how to read an AtsReport. Read by ats-screener, resume-writer and hiring-manager.
---

# ATS rules

`jh ats score <draft.json> --keywords <keywords.json> [--rendered <dir>] --json` computes the score in code. Agents never compute it by hand.

## Rubric (100 points)

| Component | Points | What earns it |
|---|---|---|
| required | 35 | weighted share of `required` terms (or aliases) found in bullets, summary or skills |
| context | 10 | required terms used inside bullets, not only in the skills list |
| preferred | 10 | weighted share of `preferred` terms |
| title | 10 | the headline or a recent title matches one of `titles` |
| knockouts | 15 | `min_years`, `degree`, `work_auth`, `location`, `clearance` all satisfied by the profile and master |
| parse | 15 | minus 3 per parse failure (see below) |
| recency | 5 | required terms appear in the most recent roles |

- **Any failed knockout caps the total at 40.** A knockout is a fact; rewording cannot fix it. Report it to `conscience` (go/no-go).
- **Stuffing:** a term used more than 4 times costs 2 points per extra use.
- **Pass** ≥ 80. **Filter floor** 60 (drafts below are dropped before the hiring-manager).

## AtsReport fields

`total`, `components{required,context,preferred,title,knockouts,parse,recency}`, `missing_required[]`, `failed_knockouts[]`, `parse_failures[]`, `stuffing[{term,count}]`. Revise from `missing_required` only when the master supports the term.

## keywords.json (JdKeywords)

```json
{"required":[{"term":"Python","aliases":["py"],"weight":3}],
 "preferred":[{"term":"dbt","aliases":[],"weight":1}],
 "titles":["Data Engineer"],
 "knockouts":{"min_years":5,"degree":"BS Computer Science or equivalent"}}
```

Weights 1 to 3. Terms are normalized (lowercase, punctuation folded so `Node.js` = `nodejs`, naive plural stem), so do not list case or plural variants as aliases.

## Parse safety (what the theme guarantees and what can still fail)

The renderer is single-column with standard headings (Summary, Skills, Experience, Projects, Education, Certifications), real text (no images), plain-text dates `MMM YYYY – MMM YYYY`, and contact details in the body (not a header/footer). Parse failures that can still happen:
- PDF without extractable text (Chrome missing or failed): DOCX is still valid; upload the DOCX.
- Role line out of order (title, employer, location, dates expected).
- Unusual characters (emoji, decorative bullets) in text.
- Contact details missing from the first lines.

## Real ATS behavior to remember

- Workday and iCIMS re-parse the upload into fields: check the parsed fields before submit.
- Greenhouse and Lever keep the file and let recruiters keyword-search it: in-context keywords matter more than the score.
- Knockout questions on the form (years, authorization, relocation) are answered from the profile, never inflated.
