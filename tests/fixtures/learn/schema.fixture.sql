-- Subset of migrations 1 and 2 (contracts.md section 3 + amendments W7; title_choice_json from migration 2) needed by the learn tests.
CREATE TABLE companies(id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_norm TEXT NOT NULL UNIQUE, domain TEXT, careers_url TEXT, ats TEXT, tenant TEXT, blocked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE jobs(id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), title TEXT NOT NULL, title_norm TEXT NOT NULL, location TEXT, remote INTEGER, url TEXT, canonical_url TEXT, source_key TEXT UNIQUE, fingerprint TEXT UNIQUE, jd_text TEXT, posted_at TEXT, discovered_at TEXT NOT NULL);
CREATE TABLE applications(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  status TEXT NOT NULL CHECK(status IN ('discovered','shortlisted','dismissed','tailored','applied','assessment','interviewing','offer','accepted','declined','rejected','ghosted','withdrawn')),
  source TEXT NOT NULL DEFAULT 'conscience' CHECK(source IN ('conscience','external','email')),
  applied_at TEXT, last_event_at TEXT NOT NULL, artifacts_dir TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE emails(id INTEGER PRIMARY KEY, gmail_message_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL, received_at TEXT NOT NULL, from_addr TEXT NOT NULL, from_domain TEXT NOT NULL, subject TEXT NOT NULL, snippet TEXT CHECK(snippet IS NULL OR length(snippet)<=500),
  kind TEXT NOT NULL CHECK(kind IN ('confirmation','rejection','interview_invite','assessment','recruiter','other')), confidence REAL NOT NULL,
  application_id INTEGER REFERENCES applications(id), company_id INTEGER REFERENCES companies(id), extracted_json TEXT, ingested_at TEXT NOT NULL);
CREATE TABLE application_events(id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id), kind TEXT NOT NULL CHECK(kind IN ('transition','note','email','interview','followup')), from_status TEXT, to_status TEXT, actor TEXT NOT NULL, email_id INTEGER REFERENCES emails(id), detail_json TEXT, at TEXT NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE resume_runs(id TEXT PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id), workdir TEXT NOT NULL, jd_path TEXT NOT NULL, keywords_json TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','finalized','abandoned')), iterations INTEGER NOT NULL DEFAULT 0, final_draft_id TEXT, ats_score INTEGER, hm_verdict TEXT,
  quality TEXT CHECK(quality IN ('ok','below_bar')), created_at TEXT NOT NULL, finalized_at TEXT);
CREATE TABLE resume_drafts(run_id TEXT NOT NULL REFERENCES resume_runs(id), id TEXT NOT NULL, angle TEXT NOT NULL, iteration INTEGER NOT NULL, path TEXT NOT NULL, ats_score INTEGER, valid INTEGER, created_at TEXT NOT NULL, PRIMARY KEY(run_id, id));
CREATE TABLE resume_variants(application_id INTEGER PRIMARY KEY REFERENCES applications(id), run_id TEXT, angle TEXT, framing TEXT, keywords_json TEXT NOT NULL, bullet_ids_json TEXT NOT NULL, phrasing_json TEXT NOT NULL, ats_score INTEGER, pages INTEGER, role_family TEXT, source TEXT, submitted_at TEXT, title_choice_json TEXT);
