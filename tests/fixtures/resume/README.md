# Resume engine fixtures

Fictional, sanitized data for `tests/unit/resume-validate.test.ts`,
`ats-score.test.ts`, `parse-checks.test.ts` and `resume-flow.test.ts`.
"Jordan Rivera", Acme Analytics, Globex Corporation and Initech are invented.

- `master-resume.fixture.yaml`: master resume with a fact metric, an estimated
  metric and a retired bullet.
- `profile.fixture.yaml`: identity, work authorization, skills tiers, voice.
- `jd.fixture.txt`, `keywords.fixture.json`: a fictional posting and its keywords.
- `tailored.fixture.json`: a valid `conscience.resume/v1` draft.

Invalid draft variants are built in the tests by mutating the valid draft, so
each test shows exactly which fact it breaks.
