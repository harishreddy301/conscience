# Cloud export fixtures

Fictional data for `tests/unit/cloud-export.test.ts` and the Task 6 spike.
`me.fixture/` is a `me/` workspace for the invented "Jordan Rivera" (copied
from `tests/fixtures/resume/`). It includes `master-resume.backup-1.yaml` so the
export allowlist can be tested. The secret-like files the allowlist must skip
(`tk.sh`, `.env`, `sub/.env.local`) are created by the test in a temp copy, so
no file named like a secret is ever committed.
