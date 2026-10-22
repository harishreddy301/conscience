---
name: resume-style
description: The conscience resume house style - voice, bullet length, banned phrases, section order, page length, and the rendered layout (one-column ATS-safe theme, Letter paper, density steps). Read by resume-writer, hiring-manager, resume-formatter, cover-letter-writer and outreach-drafter.
---

# Resume style

## Voice

- The user's voice comes from `me/preferences.md` and `profile.yaml` `voice` (`tone`, `banned_phrases`). Read both.
- Implied first person, no pronouns ("Built…", not "I built…"). Validate warns on pronouns.
- Plain, concrete verbs. Specific nouns (system names, data sizes, user groups) beat adjectives.
- Banned everywhere: "responsible for", "passionate", "synergy", "rockstar", "results-driven", "team player", "go-getter", "detail-oriented", plus `voice.banned_phrases`.

## Bullets

- 3 to 6 bullets for the current or most relevant role, 2 to 4 for older ones, 1 or 2 for roles over 10 years old.
- At most 200 characters (2 lines); validate warns over 220 and fails over 260.
- The first bullet of the current role carries a fact metric when one exists (recruiter check `first_bullet_quantified`).
- No sub-bullets, no paragraphs.

## Bold key terms (always on; enforced)

Matches the user's liked format (`me/format-reference/liked-format.pdf`; spec in `me/format-reference/resume-spec.md`). Not optional: `jh resume validate` fails a draft that breaks these rules, and `jh resume finalize` refuses it.

- Bold lives in each item's `emphasis` list: exact phrases copied from `text`, each bolded at its first occurrence. `text` stays plain (no `**`, no HTML), so stripping bold gives back the validated text (`BOLD_UNTRACEABLE` otherwise).
- **Bullets: 2 to 4 bold phrases**: main tools/platforms, the core concept, and every metric (`BOLD_MISSING` under 2, `BOLD_EXCESS` over 4).
- **Every metric is bold** (`METRIC_NOT_BOLD`): any number with a unit or currency (%, x, +, K, M, ms, minutes, $) and any count ("150-case", "under 15"). Bold a range as one phrase: "45 minutes to under 15". Tech tokens (S3, K-12, Python 3.11) and years are not metrics.
- **Bold never covers more than 30% of a bullet's characters** (aim for about 25%; `BOLD_EXCESS`). Bold the term, not the clause.
- **Summary paragraph**: bold the years and key stack terms (`SUMMARY_BOLD_MISSING` if none).
- **Highlights**: the label is always bold (keep it in `label`, never as a "Label:" lead-in inside `text`: `HIGHLIGHT_LABEL_NOT_BOLD`); bold 1 to 2 more phrases.
- Baseline: `jh resume bold <draft.json> --apply --json` proposes spans deterministically (metric phrases, then JD keywords, then recorded skills) and lists `short` items that still need a core-concept phrase; `--suggest` (the default) only prints.

Example bullet: "Built **hybrid BM25 plus semantic RAG** over **1,000+** policy documents with **LangChain**, raising retrieval accuracy from **71% to 89%** on a labeled golden set."

Example highlight: "**Agentic AI:** **Multi-agent LLM workflows** on Bedrock AgentCore, LangChain and FastAPI with function calling, plus real-time voice agents on the **Gemini Live API**."

## Section order

1. Name and contact (email, phone, location, 1 to 3 links)
2. Headline: the target title (or the closest true equivalent) and a short specialty, at most 120 characters
3. Summary (at most 450 characters)
4. Skills: 3 to 5 groups named as the JD groups them
5. Experience (reverse chronological)
6. Projects (only when they prove a must-have the roles do not)
7. Education, then Certifications

## Length

- 1 page under 7 years of experience; 2 pages otherwise. Never 3.
- Cut in this order when over: oldest role's weakest bullets, projects, extra skill groups, summary length.

## Layout (code: `src/render`; agents do not style)

- One column, Letter paper by default (A4 via `layout.paper`). No tables, images or columns in either theme.
- **`classic-navy` (default, `layout.theme`)**: Calibri/Carlito/Arial, body 10.5pt. Name centered, bold, uppercase, navy `#1F3864`; headline centered in crimson with " | " between terms; gray contact line (location, phone, email, links). Headings: Professional Summary, Technical Skills, Professional Experience, Projects, Education, Publications (Certifications only when real ones exist), navy uppercase with a navy rule. Summary paragraph plus optional "**Label:** text" highlights. Key terms are bold in bullets, summary and highlights (see "Bold key terms"). Each role: bold navy title with bold dates right ("Jun 2026 to Present"), then italic employer with italic location right, bullets, optional italic "Environment:" line. Education: bold navy degree " | school (GPA)" with year right, optional "Relevant Coursework:" line. Publications use small crimson squares.
- **`standard`**: name 22pt semibold, headings 10.5pt uppercase with a rule, body 10.2pt; one role line (title, employer, location, dates `MMM YYYY – MMM YYYY`).
- Fitting: density steps 0 to 3 (classic-navy body 10.5 → 9.7pt, standard 10.2 → 9.5pt; margins ~0.55 → 0.5in). If density 3 still overflows, the content must be cut.
- Output files: `First_Last_Resume_<Company>.pdf` and `.docx`, plus `resume.html` and `resume.txt` (for paste fields).
