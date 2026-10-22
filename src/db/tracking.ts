/**
 * SQL for the tracking tables: emails, interviews, study_*, sync_runs.
 * All SQL for W6 lives here (CLAUDE.md: only src/db touches SQL).
 */
import type {
	EmailKind,
	EmailRow,
	InterviewRound,
	InterviewRow,
	PrepStatus,
	StudyBlock,
	StudySession,
	StudyTask,
	SyncKind,
	SyncRunRow,
} from "../tracking/schemas.js";
import { type Db, nowIso, openDb } from "./index.js";

type Param = string | number | null;
const orNull = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

function all<T>(db: Db, sql: string, ...params: Param[]): T[] {
	return db.prepare(sql).all(...params) as unknown as T[];
}
function one<T>(db: Db, sql: string, ...params: Param[]): T | undefined {
	return db.prepare(sql).get(...params) as unknown as T | undefined;
}
function insert(db: Db, sql: string, ...params: Param[]): number {
	return Number(db.prepare(sql).run(...params).lastInsertRowid);
}
function exec(db: Db, sql: string, ...params: Param[]): number {
	return Number(db.prepare(sql).run(...params).changes);
}

/** Open the default DB, run `fn`, always close. */
export async function withDb<T>(fn: (db: Db) => T | Promise<T>): Promise<T> {
	const db = openDb();
	try {
		return await fn(db);
	} finally {
		db.close();
	}
}

// ---------------------------------------------------------------- emails

export interface NewEmail {
	gmail_message_id: string;
	thread_id: string;
	received_at: string;
	from_addr: string;
	from_domain: string;
	subject: string;
	snippet?: string;
	kind: EmailKind;
	confidence: number;
	application_id: number | null;
	company_id: number | null;
	extracted?: unknown;
}

export function findEmailByMessageId(
	db: Db,
	gmailMessageId: string,
): EmailRow | undefined {
	return one<EmailRow>(
		db,
		"SELECT * FROM emails WHERE gmail_message_id = ?",
		gmailMessageId,
	);
}

export function getEmail(db: Db, id: number): EmailRow | undefined {
	return one<EmailRow>(db, "SELECT * FROM emails WHERE id = ?", id);
}

export function insertEmail(db: Db, e: NewEmail): number {
	return insert(
		db,
		`INSERT INTO emails(gmail_message_id, thread_id, received_at, from_addr, from_domain, subject, snippet,
			kind, confidence, application_id, company_id, extracted_json, ingested_at)
		 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		e.gmail_message_id,
		e.thread_id,
		e.received_at,
		e.from_addr,
		e.from_domain,
		e.subject,
		orNull(e.snippet),
		e.kind,
		e.confidence,
		e.application_id,
		e.company_id,
		e.extracted === undefined ? null : JSON.stringify(e.extracted),
		nowIso(),
	);
}

/** Application and company already linked to any email in this thread. */
export function threadLink(
	db: Db,
	threadId: string,
): { application_id: number | null; company_id: number | null } | undefined {
	return one(
		db,
		`SELECT application_id, company_id FROM emails
		 WHERE thread_id = ? AND (application_id IS NOT NULL OR company_id IS NOT NULL)
		 ORDER BY application_id IS NULL, received_at DESC LIMIT 1`,
		threadId,
	);
}

export function linkEmail(
	db: Db,
	emailId: number,
	applicationId: number,
	companyId: number | null,
): void {
	exec(
		db,
		"UPDATE emails SET application_id = ?, company_id = COALESCE(?, company_id) WHERE id = ?",
		applicationId,
		companyId,
		emailId,
	);
}

export function listEmails(
	db: Db,
	f: { unlinked?: boolean; kind?: EmailKind; limit?: number } = {},
): (EmailRow & { company: string | null })[] {
	const where: string[] = [];
	const params: Param[] = [];
	if (f.unlinked) where.push("e.application_id IS NULL");
	if (f.kind) {
		where.push("e.kind = ?");
		params.push(f.kind);
	}
	params.push(f.limit ?? 50);
	return all(
		db,
		`SELECT e.*, c.name AS company FROM emails e LEFT JOIN companies c ON c.id = e.company_id
		 ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
		 ORDER BY e.received_at DESC LIMIT ?`,
		...params,
	);
}

/** Job-related unlinked emails (excludes "other"). */
export function countUnlinkedEmails(db: Db): number {
	const r = one<{ n: number }>(
		db,
		"SELECT COUNT(*) AS n FROM emails WHERE application_id IS NULL AND kind <> 'other'",
	);
	return r?.n ?? 0;
}

/** Assessment emails whose application is still in `assessment` (or unlinked). */
export function openAssessmentEmails(
	db: Db,
): (EmailRow & { company: string | null })[] {
	return all(
		db,
		`SELECT e.*, c.name AS company FROM emails e
		 LEFT JOIN companies c ON c.id = e.company_id
		 LEFT JOIN applications a ON a.id = e.application_id
		 WHERE e.kind = 'assessment' AND (a.id IS NULL OR a.status = 'assessment')
		 ORDER BY e.received_at DESC LIMIT 20`,
	);
}

/** Latest email subject per application id. */
export function lastEmailSubjects(
	db: Db,
	appIds: number[],
): Map<number, { subject: string; received_at: string }> {
	const out = new Map<number, { subject: string; received_at: string }>();
	if (!appIds.length) return out;
	const rows = all<{
		application_id: number;
		subject: string;
		received_at: string;
	}>(
		db,
		`SELECT application_id, subject, received_at FROM emails e
		 WHERE application_id IN (${appIds.map(() => "?").join(",")})
		   AND received_at = (SELECT MAX(received_at) FROM emails e2 WHERE e2.application_id = e.application_id)`,
		...appIds,
	);
	for (const r of rows) out.set(r.application_id, r);
	return out;
}

// ---------------------------------------------------------------- interviews

export interface InterviewFields {
	calendar_event_id?: string | null;
	application_id?: number | null;
	company_id?: number | null;
	company_name: string;
	role?: string | null;
	round?: InterviewRound;
	start_at?: string | null;
	end_at?: string | null;
	tz?: string | null;
	location?: string | null;
	meeting_link?: string | null;
	status?: InterviewRow["status"];
	source: InterviewRow["source"];
	source_email_id?: number | null;
}

export function getInterview(db: Db, id: number): InterviewRow | undefined {
	return one<InterviewRow>(db, "SELECT * FROM interviews WHERE id = ?", id);
}

export function getInterviewByEventId(
	db: Db,
	eventId: string,
): InterviewRow | undefined {
	return one<InterviewRow>(
		db,
		"SELECT * FROM interviews WHERE calendar_event_id = ?",
		eventId,
	);
}

export function insertInterview(db: Db, i: InterviewFields): number {
	return insert(
		db,
		`INSERT INTO interviews(calendar_event_id, application_id, company_id, company_name, role, round,
			start_at, end_at, tz, location, meeting_link, status, source, source_email_id, updated_at)
		 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		orNull(i.calendar_event_id),
		orNull(i.application_id),
		orNull(i.company_id),
		i.company_name,
		orNull(i.role),
		i.round ?? "other",
		orNull(i.start_at),
		orNull(i.end_at),
		orNull(i.tz),
		orNull(i.location),
		orNull(i.meeting_link),
		i.status ?? "scheduled",
		i.source,
		orNull(i.source_email_id),
		nowIso(),
	);
}

const PATCHABLE = [
	"calendar_event_id",
	"application_id",
	"company_id",
	"company_name",
	"role",
	"round",
	"start_at",
	"end_at",
	"tz",
	"location",
	"meeting_link",
	"status",
] as const;

/** Update only the provided (non-undefined) fields. */
export function updateInterview(
	db: Db,
	id: number,
	patch: Partial<InterviewFields>,
): void {
	const sets: string[] = [];
	const params: Param[] = [];
	for (const k of PATCHABLE) {
		const v = patch[k];
		if (v === undefined) continue;
		sets.push(`${k} = ?`);
		params.push(v);
	}
	sets.push("updated_at = ?");
	params.push(nowIso(), id);
	exec(db, `UPDATE interviews SET ${sets.join(", ")} WHERE id = ?`, ...params);
}

/**
 * Email-sourced interviews without a calendar event for the same company
 * (by id or normalized name), used for ±30m merge.
 */
export function unmergedEmailInterviews(
	db: Db,
	companyId: number | null,
	companyName: string,
): InterviewRow[] {
	return all<InterviewRow>(
		db,
		`SELECT * FROM interviews
		 WHERE calendar_event_id IS NULL AND source = 'email'
		   AND ((? IS NOT NULL AND company_id = ?) OR lower(company_name) = lower(?))`,
		companyId,
		companyId,
		companyName,
	);
}

export function listInterviews(
	db: Db,
	f: {
		fromIso?: string;
		toIso?: string;
		prep?: PrepStatus;
		includeCancelled?: boolean;
	} = {},
): InterviewRow[] {
	const where: string[] = [];
	const params: Param[] = [];
	if (f.fromIso) {
		where.push("start_at >= ?");
		params.push(f.fromIso);
	}
	if (f.toIso) {
		where.push("start_at <= ?");
		params.push(f.toIso);
	}
	if (f.prep) {
		where.push("prep_status = ?");
		params.push(f.prep);
	}
	if (!f.includeCancelled) where.push("status <> 'cancelled'");
	return all<InterviewRow>(
		db,
		`SELECT * FROM interviews ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
		 ORDER BY start_at IS NULL, start_at ASC LIMIT 200`,
		...params,
	);
}

export function setInterviewPrep(
	db: Db,
	id: number,
	status: PrepStatus,
	path: string | null | undefined,
): void {
	exec(
		db,
		"UPDATE interviews SET prep_status = ?, prep_path = COALESCE(?, prep_path), updated_at = ? WHERE id = ?",
		status,
		orNull(path),
		nowIso(),
		id,
	);
}

// ---------------------------------------------------------------- study blocks

export function listBlocks(db: Db, activeOnly = true): StudyBlock[] {
	return all<StudyBlock>(
		db,
		`SELECT * FROM study_blocks ${activeOnly ? "WHERE active = 1" : ""} ORDER BY start_local, id`,
	);
}

export function getBlock(db: Db, id: number): StudyBlock | undefined {
	return one<StudyBlock>(db, "SELECT * FROM study_blocks WHERE id = ?", id);
}

export function insertBlock(
	db: Db,
	b: { label: string; days: string; start: string; end: string },
): number {
	return insert(
		db,
		"INSERT INTO study_blocks(label, days, start_local, end_local, active, created_at) VALUES(?,?,?,?,1,?)",
		b.label,
		b.days,
		b.start,
		b.end,
		nowIso(),
	);
}

export function updateBlock(
	db: Db,
	id: number,
	p: { label?: string; days?: string; start?: string; end?: string },
): void {
	exec(
		db,
		`UPDATE study_blocks SET label = COALESCE(?, label), days = COALESCE(?, days),
			start_local = COALESCE(?, start_local), end_local = COALESCE(?, end_local) WHERE id = ?`,
		orNull(p.label),
		orNull(p.days),
		orNull(p.start),
		orNull(p.end),
		id,
	);
}

/** Soft-delete: sessions keep their block reference. */
export function deactivateBlock(db: Db, id: number): number {
	return exec(db, "UPDATE study_blocks SET active = 0 WHERE id = ?", id);
}

// ---------------------------------------------------------------- study sessions

export function openSession(db: Db): StudySession | undefined {
	return one<StudySession>(
		db,
		"SELECT * FROM study_sessions WHERE ended_at IS NULL LIMIT 1",
	);
}

export function getSession(db: Db, id: number): StudySession | undefined {
	return one<StudySession>(db, "SELECT * FROM study_sessions WHERE id = ?", id);
}

export function insertSession(
	db: Db,
	s: {
		block_id: number | null;
		started_at: string;
		topic?: string;
		source: "cli" | "dashboard";
	},
): number {
	return insert(
		db,
		"INSERT INTO study_sessions(block_id, started_at, topic, source) VALUES(?,?,?,?)",
		s.block_id,
		s.started_at,
		orNull(s.topic),
		s.source,
	);
}

export function closeSession(
	db: Db,
	id: number,
	endedAt: string,
	o: { notes?: string; autoClosed?: boolean } = {},
): void {
	exec(
		db,
		"UPDATE study_sessions SET ended_at = ?, notes = COALESCE(?, notes), auto_closed = ? WHERE id = ?",
		endedAt,
		orNull(o.notes),
		o.autoClosed ? 1 : 0,
		id,
	);
}

/** Sessions that started at/after `sinceIso` or are still open. */
export function sessionsSince(db: Db, sinceIso: string): StudySession[] {
	return all<StudySession>(
		db,
		"SELECT * FROM study_sessions WHERE started_at >= ? OR ended_at IS NULL ORDER BY started_at",
		sinceIso,
	);
}

export function recentSessions(db: Db, limit = 10): StudySession[] {
	return all<StudySession>(
		db,
		"SELECT * FROM study_sessions ORDER BY started_at DESC LIMIT ?",
		limit,
	);
}

// ---------------------------------------------------------------- study tasks

export function insertTask(
	db: Db,
	t: { title: string; planned_for?: string },
): number {
	return insert(
		db,
		"INSERT INTO study_tasks(title, planned_for, created_at) VALUES(?,?,?)",
		t.title,
		orNull(t.planned_for),
		nowIso(),
	);
}

export function getTask(db: Db, id: number): StudyTask | undefined {
	return one<StudyTask>(db, "SELECT * FROM study_tasks WHERE id = ?", id);
}

/** Open tasks plus tasks completed on/after `doneSinceIso`. */
export function listTasks(
	db: Db,
	f: { all?: boolean; doneSinceIso?: string } = {},
): StudyTask[] {
	if (f.all) {
		return all<StudyTask>(
			db,
			"SELECT * FROM study_tasks ORDER BY done_at IS NOT NULL, planned_for IS NULL, planned_for, id LIMIT 500",
		);
	}
	return all<StudyTask>(
		db,
		`SELECT * FROM study_tasks WHERE done_at IS NULL OR done_at >= ?
		 ORDER BY done_at IS NOT NULL, planned_for IS NULL, planned_for, id LIMIT 200`,
		f.doneSinceIso ?? "9999",
	);
}

export function completeTask(
	db: Db,
	id: number,
	doneAt: string,
	sessionId: number | null,
): number {
	return exec(
		db,
		"UPDATE study_tasks SET done_at = ?, session_id = COALESCE(?, session_id) WHERE id = ? AND done_at IS NULL",
		doneAt,
		sessionId,
		id,
	);
}

// ---------------------------------------------------------------- sync runs

export function lastOkCursor(db: Db, kind: SyncKind): string | null {
	const r = one<{ cursor: string | null }>(
		db,
		"SELECT cursor FROM sync_runs WHERE kind = ? AND ok = 1 AND cursor IS NOT NULL ORDER BY id DESC LIMIT 1",
		kind,
	);
	return r?.cursor ?? null;
}

export function insertSyncRun(db: Db, kind: SyncKind, actor: string): number {
	return insert(
		db,
		"INSERT INTO sync_runs(kind, started_at, actor) VALUES(?,?,?)",
		kind,
		nowIso(),
		actor,
	);
}

export function getSyncRun(db: Db, id: number): SyncRunRow | undefined {
	return one<SyncRunRow>(db, "SELECT * FROM sync_runs WHERE id = ?", id);
}

export function finishSyncRun(
	db: Db,
	id: number,
	r: {
		ok: boolean;
		itemsIn?: number;
		itemsNew?: number;
		cursor?: string;
		error?: string;
	},
): void {
	exec(
		db,
		"UPDATE sync_runs SET finished_at = ?, ok = ?, items_in = ?, items_new = ?, cursor = ?, error = ? WHERE id = ?",
		nowIso(),
		r.ok ? 1 : 0,
		orNull(r.itemsIn),
		orNull(r.itemsNew),
		orNull(r.cursor),
		orNull(r.error),
		id,
	);
}

export function latestSyncRun(db: Db, kind: SyncKind): SyncRunRow | undefined {
	return one<SyncRunRow>(
		db,
		"SELECT * FROM sync_runs WHERE kind = ? ORDER BY id DESC LIMIT 1",
		kind,
	);
}

export function lastOkSyncAt(db: Db, kind: SyncKind): string | null {
	const r = one<{ at: string | null }>(
		db,
		"SELECT MAX(finished_at) AS at FROM sync_runs WHERE kind = ? AND ok = 1",
		kind,
	);
	return r?.at ?? null;
}
