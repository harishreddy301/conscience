/**
 * The only schema DDL in the project. MIGRATIONS[n] upgrades user_version n -> n+1.
 * Append new migrations; never edit a shipped one.
 */
const MIGRATION_1 = `
CREATE TABLE companies(id INTEGER PRIMARY KEY, name TEXT NOT NULL, name_norm TEXT NOT NULL UNIQUE, domain TEXT, careers_url TEXT, ats TEXT, tenant TEXT, blocked INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX companies_domain ON companies(domain);
CREATE TABLE jobs(id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL REFERENCES companies(id), title TEXT NOT NULL, title_norm TEXT NOT NULL, location TEXT, remote INTEGER, url TEXT, canonical_url TEXT, source_key TEXT UNIQUE, fingerprint TEXT UNIQUE, jd_text TEXT, posted_at TEXT, discovered_at TEXT NOT NULL);
CREATE TABLE applications(id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL UNIQUE REFERENCES jobs(id),
  status TEXT NOT NULL CHECK(status IN ('discovered','shortlisted','dismissed','tailored','applied','assessment','interviewing','offer','accepted','declined','rejected','ghosted','withdrawn')),
  source TEXT NOT NULL DEFAULT 'conscience' CHECK(source IN ('conscience','external','email')),
  applied_at TEXT, last_event_at TEXT NOT NULL, artifacts_dir TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX applications_status ON applications(status, last_event_at);
CREATE TABLE emails(id INTEGER PRIMARY KEY, gmail_message_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL, received_at TEXT NOT NULL, from_addr TEXT NOT NULL, from_domain TEXT NOT NULL, subject TEXT NOT NULL, snippet TEXT CHECK(snippet IS NULL OR length(snippet)<=500),
  kind TEXT NOT NULL CHECK(kind IN ('confirmation','rejection','interview_invite','assessment','recruiter','other')), confidence REAL NOT NULL,
  application_id INTEGER REFERENCES applications(id), company_id INTEGER REFERENCES companies(id), extracted_json TEXT, ingested_at TEXT NOT NULL);
CREATE INDEX emails_thread ON emails(thread_id);
CREATE INDEX emails_received ON emails(received_at);
CREATE TABLE application_events(id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id), kind TEXT NOT NULL CHECK(kind IN ('transition','note','email','interview','followup')), from_status TEXT, to_status TEXT, actor TEXT NOT NULL, email_id INTEGER REFERENCES emails(id), detail_json TEXT, at TEXT NOT NULL);
CREATE INDEX app_events_app ON application_events(application_id, at);
CREATE TABLE interviews(id INTEGER PRIMARY KEY, calendar_event_id TEXT UNIQUE, application_id INTEGER REFERENCES applications(id), company_id INTEGER REFERENCES companies(id), company_name TEXT NOT NULL, role TEXT,
  round TEXT NOT NULL DEFAULT 'other' CHECK(round IN ('recruiter_screen','hiring_manager','technical','assessment','onsite','final','other')),
  start_at TEXT, end_at TEXT, tz TEXT, location TEXT, meeting_link TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK(status IN ('tentative','scheduled','cancelled','done')),
  prep_status TEXT NOT NULL DEFAULT 'none' CHECK(prep_status IN ('none','queued','ready','done')), prep_path TEXT,
  source TEXT NOT NULL CHECK(source IN ('calendar','email','manual')), source_email_id INTEGER REFERENCES emails(id), updated_at TEXT NOT NULL);
CREATE INDEX interviews_start ON interviews(start_at);
CREATE TABLE study_blocks(id INTEGER PRIMARY KEY, label TEXT NOT NULL, days TEXT NOT NULL, start_local TEXT NOT NULL, end_local TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE study_sessions(id INTEGER PRIMARY KEY, block_id INTEGER REFERENCES study_blocks(id), started_at TEXT NOT NULL, ended_at TEXT, topic TEXT, notes TEXT, source TEXT NOT NULL CHECK(source IN ('cli','dashboard')), auto_closed INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX study_one_open ON study_sessions((ended_at IS NULL)) WHERE ended_at IS NULL;
CREATE INDEX study_started ON study_sessions(started_at);
CREATE TABLE study_tasks(id INTEGER PRIMARY KEY, title TEXT NOT NULL, session_id INTEGER REFERENCES study_sessions(id), planned_for TEXT, done_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE sync_runs(id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('gmail','calendar')), started_at TEXT NOT NULL, finished_at TEXT, ok INTEGER, items_in INTEGER, items_new INTEGER, cursor TEXT, error TEXT, actor TEXT NOT NULL);
CREATE TABLE resume_runs(id TEXT PRIMARY KEY, application_id INTEGER NOT NULL REFERENCES applications(id), workdir TEXT NOT NULL, jd_path TEXT NOT NULL, keywords_json TEXT,
  status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','finalized','abandoned')), iterations INTEGER NOT NULL DEFAULT 0, final_draft_id TEXT, ats_score INTEGER, hm_verdict TEXT,
  quality TEXT CHECK(quality IN ('ok','below_bar')), created_at TEXT NOT NULL, finalized_at TEXT);
CREATE INDEX resume_runs_app ON resume_runs(application_id, created_at);
CREATE TABLE resume_drafts(run_id TEXT NOT NULL REFERENCES resume_runs(id), id TEXT NOT NULL, angle TEXT NOT NULL, iteration INTEGER NOT NULL, path TEXT NOT NULL, ats_score INTEGER, valid INTEGER, created_at TEXT NOT NULL, PRIMARY KEY(run_id, id));
CREATE TABLE resume_reviews(id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES resume_runs(id), draft_id TEXT NOT NULL, reviewer TEXT NOT NULL CHECK(reviewer IN ('hiring-manager','recruiter-screen','ats-screener','fact-checker')), verdict TEXT NOT NULL, score INTEGER NOT NULL, json TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX resume_reviews_draft ON resume_reviews(run_id, draft_id);
CREATE TABLE resume_variants(application_id INTEGER PRIMARY KEY REFERENCES applications(id), run_id TEXT, angle TEXT, framing TEXT, keywords_json TEXT NOT NULL, bullet_ids_json TEXT NOT NULL, phrasing_json TEXT NOT NULL, ats_score INTEGER, pages INTEGER, role_family TEXT, source TEXT, submitted_at TEXT);
INSERT INTO study_blocks(label,days,start_local,end_local,active,created_at) VALUES('Morning study','1,2,3,4,5,6,7','05:30','08:00',1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
INSERT INTO settings(key,value) VALUES('study.grace_minutes','30'),('study.streak_min_minutes','60'),('study.max_session_minutes','240'),('study.weekly_goal_hours','15'),('dashboard.port','4777');
`;

/**
 * v2: a short, structured glimpse of each job description (so the finalized
 * resume can be compared with the JD later, even if the posting disappears),
 * and the title choice of each submitted variant for outcome learning.
 */
const MIGRATION_2 = `
CREATE TABLE jd_snapshots(application_id INTEGER PRIMARY KEY REFERENCES applications(id), title_posted TEXT NOT NULL, seniority TEXT,
  must_haves_json TEXT NOT NULL, nice_to_haves_json TEXT NOT NULL, keywords_json TEXT NOT NULL,
  location TEXT, remote TEXT, salary TEXT, summary TEXT NOT NULL CHECK(length(summary)<=800), source_url TEXT, captured_at TEXT NOT NULL);
ALTER TABLE resume_variants ADD COLUMN title_choice_json TEXT;
`;

/**
 * v3: "You asked" marker. Jobs the user adds from the dashboard (or marks) carry
 * requested_by = 'user' so agents pick them up first (`jh app list --user-requested`).
 */
const MIGRATION_3 = `
ALTER TABLE applications ADD COLUMN requested_by TEXT CHECK(requested_by IS NULL OR requested_by IN ('user'));
ALTER TABLE applications ADD COLUMN request_note TEXT CHECK(request_note IS NULL OR length(request_note)<=500);
CREATE INDEX applications_requested ON applications(requested_by) WHERE requested_by IS NOT NULL;
`;

/**
 * v4 (ADR-005): autopilot escalations and the `held` state.
 * Widening the status CHECK uses SQLite's documented writable_schema procedure
 * (a constraint change that keeps the on-disk format); the rename round trip
 * after it makes every connection reload the schema.
 */
const MIGRATION_4 = `
ALTER TABLE applications ADD COLUMN hold_reason TEXT CHECK(hold_reason IS NULL OR length(hold_reason)<=500);
PRAGMA writable_schema=ON;
UPDATE sqlite_master SET sql = replace(sql, '''ghosted'',''withdrawn'')', '''ghosted'',''withdrawn'',''held'')') WHERE type='table' AND name='applications';
PRAGMA writable_schema=OFF;
ALTER TABLE applications RENAME TO applications__v4;
ALTER TABLE applications__v4 RENAME TO applications;
CREATE TABLE escalations(id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('plugin_feature_or_code','account_creation_signin_sso','legal_consent_not_preapproved','hard_fact_unknown','spending_money','withdraw_or_decline_offer_or_interview')),
  application_id INTEGER REFERENCES applications(id), question TEXT NOT NULL CHECK(length(question)<=1000), context_json TEXT,
  blocking INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','answered','dismissed')),
  answer TEXT CHECK(answer IS NULL OR length(answer)<=2000), actor TEXT NOT NULL, answered_by TEXT, policy_rev INTEGER,
  created_at TEXT NOT NULL, answered_at TEXT);
CREATE INDEX escalations_open ON escalations(status, created_at);
`;

export const MIGRATIONS: readonly string[] = Object.freeze([
	MIGRATION_1,
	MIGRATION_2,
	MIGRATION_3,
	MIGRATION_4,
]);

/** Tables created by the migrations, for doctor/tests. */
export const TABLES: readonly string[] = Object.freeze([
	"companies",
	"jobs",
	"applications",
	"emails",
	"application_events",
	"interviews",
	"study_blocks",
	"study_sessions",
	"study_tasks",
	"settings",
	"sync_runs",
	"resume_runs",
	"resume_drafts",
	"resume_reviews",
	"resume_variants",
	"jd_snapshots",
	"escalations",
]);
