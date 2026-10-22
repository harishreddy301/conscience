# stories/

STAR stories (Situation, Task, Action, Result) for interviews. The `interview-prep` agent picks the stories that fit each interview's likely questions, so a few strong ones go a long way. Five to eight stories is plenty.

Name each file `<slug>.md`, copy `_TEMPLATE.md`, and fill in the front matter:

```yaml
---
role_id: acme-analytics-2022        # a role id from master-resume.yaml
bullet_ids: [acme-analytics-2022.b01] # the master bullets this story backs up
competencies: [ownership, debugging under pressure, stakeholder management]
last_used: null                      # YYYY-MM-DD; interview-prep updates it
---
```

Run `/intake` first so the role and bullet ids exist, then `jh me validate` checks that every id in a story is real.

Rules:

- Same honesty rule as resumes: only things that happened, with numbers you would defend.
- Keep each story speakable in about two minutes.
- Files starting with `_` are ignored.
