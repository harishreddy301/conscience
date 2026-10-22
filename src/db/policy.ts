import type { Db } from "./index.js";
import { nowIso } from "./index.js";

/** SQL for ADR-005: holds, escalations and the triage candidate views. */

export function setHoldReason(
	db: Db,
	appId: number,
	reason: string | null,
): void {
	db.prepare("UPDATE applications SET hold_reason = ? WHERE id = ?").run(
		reason,
		appId,
	);
}

// ------------------------------------------------------------------ triage inputs

export interface CandidateRow {
	app_id: number;
	status: string;
	requested_by: string | null;
	company_id: number;
	company: string;
	title: string;
	posted_at: string | null;
	discovered_at: string;
	url: string | null;
}

export function triageCandidates(
	db: Db,
	f: { ids?: number[]; statuses?: string[] },
): CandidateRow[] {
	const where: string[] = [];
	const params: (string | number)[] = [];
	if (f.ids?.length) {
		where.push(`a.id IN (${f.ids.map(() => "?").join(",")})`);
		params.push(...f.ids);
	} else {
		const st = f.statuses?.length ? f.statuses : ["shortlisted", "discovered"];
		where.push(`a.status IN (${st.map(() => "?").join(",")})`);
		params.push(...st);
	}
	return db
		.prepare(
			`SELECT a.id AS app_id, a.status, a.requested_by, j.company_id, c.name AS company, j.title,
			        j.posted_at, j.discovered_at, COALESCE(j.url, j.canonical_url) AS url
			   FROM applications a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.id = j.company_id
			  WHERE ${where.join(" AND ")} ORDER BY a.id`,
		)
		.all(...params) as unknown as CandidateRow[];
}

const IN_FLIGHT = [
	"tailored",
	"held",
	"applied",
	"assessment",
	"interviewing",
	"offer",
	"accepted",
	"declined",
	"rejected",
	"ghosted",
];
const SUBMITTED = [
	"applied",
	"assessment",
	"interviewing",
	"offer",
	"accepted",
	"declined",
	"rejected",
	"ghosted",
];

export function companyStats(
	db: Db,
): Map<number, { in_flight: number; applied: number }> {
	const q = (list: string[]) => list.map((s) => `'${s}'`).join(",");
	const rows = db
		.prepare(
			`SELECT j.company_id AS company_id,
			        SUM(CASE WHEN a.status IN (${q(IN_FLIGHT)}) THEN 1 ELSE 0 END) AS in_flight,
			        SUM(CASE WHEN a.status IN (${q(SUBMITTED)}) THEN 1 ELSE 0 END) AS applied
			   FROM applications a JOIN jobs j ON j.id = a.job_id GROUP BY j.company_id`,
		)
		.all() as { company_id: number; in_flight: number; applied: number }[];
	return new Map(
		rows.map((r) => [
			r.company_id,
			{ in_flight: Number(r.in_flight), applied: Number(r.applied) },
		]),
	);
}

export function jobTextFor(
	db: Db,
	appId: number,
): { title: string; jd_text: string | null } | undefined {
	return db
		.prepare(
			"SELECT j.title, j.jd_text FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?",
		)
		.get(appId) as { title: string; jd_text: string | null } | undefined;
}

/** Applications that reached `applied` (by event time) since `sinceIso`. */
export function countAppliedSince(db: Db, sinceIso: string): number {
	const row = db
		.prepare(
			`SELECT COUNT(DISTINCT application_id) AS n FROM application_events
			  WHERE kind = 'transition' AND to_status = 'applied' AND at >= ?`,
		)
		.get(sinceIso) as { n: number } | undefined;
	return Number(row?.n ?? 0);
}

export function listArtifactsDirs(
	db: Db,
	statuses: string[],
): { app_id: number; artifacts_dir: string | null }[] {
	return db
		.prepare(
			`SELECT id AS app_id, artifacts_dir FROM applications
			  WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY id`,
		)
		.all(...statuses) as { app_id: number; artifacts_dir: string | null }[];
}

// ------------------------------------------------------------------ escalations

export type EscalationStatus = "open" | "answered" | "dismissed";

export interface EscalationRow {
	id: number;
	kind: string;
	application_id: number | null;
	question: string;
	context_json: string | null;
	blocking: number;
	status: EscalationStatus;
	answer: string | null;
	actor: string;
	answered_by: string | null;
	policy_rev: number | null;
	created_at: string;
	answered_at: string | null;
}

export interface NewEscalation {
	kind: string;
	application_id?: number | null;
	question: string;
	context?: unknown;
	blocking?: boolean;
	actor: string;
	policy_rev?: number | null;
}

/** Insert an escalation unless an identical open one exists; returns the row and whether it is new. */
export function addEscalation(
	db: Db,
	e: NewEscalation,
): { row: EscalationRow; created: boolean } {
	const existing = db
		.prepare(
			`SELECT * FROM escalations WHERE status = 'open' AND kind = ? AND question = ?
			   AND application_id IS ?`,
		)
		.get(e.kind, e.question, e.application_id ?? null) as
		| EscalationRow
		| undefined;
	if (existing) return { row: existing, created: false };
	const r = db
		.prepare(
			`INSERT INTO escalations(kind, application_id, question, context_json, blocking, status, actor, policy_rev, created_at)
			 VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?)`,
		)
		.run(
			e.kind,
			e.application_id ?? null,
			e.question,
			e.context === undefined ? null : JSON.stringify(e.context),
			e.blocking ? 1 : 0,
			e.actor,
			e.policy_rev ?? null,
			nowIso(),
		);
	return {
		row: getEscalation(db, Number(r.lastInsertRowid)) as EscalationRow,
		created: true,
	};
}

export function getEscalation(db: Db, id: number): EscalationRow | undefined {
	return db.prepare("SELECT * FROM escalations WHERE id = ?").get(id) as
		| EscalationRow
		| undefined;
}

export function listEscalations(
	db: Db,
	f: { status?: EscalationStatus | "all"; appId?: number } = {},
): EscalationRow[] {
	const where: string[] = [];
	const params: (string | number)[] = [];
	const st = f.status ?? "open";
	if (st !== "all") {
		where.push("status = ?");
		params.push(st);
	}
	if (f.appId !== undefined) {
		where.push("application_id = ?");
		params.push(f.appId);
	}
	return db
		.prepare(
			`SELECT * FROM escalations ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
			  ORDER BY blocking DESC, created_at, id`,
		)
		.all(...params) as unknown as EscalationRow[];
}

export function resolveEscalation(
	db: Db,
	id: number,
	r: { status: "answered" | "dismissed"; answer: string | null; by: string },
): void {
	db.prepare(
		"UPDATE escalations SET status = ?, answer = ?, answered_by = ?, answered_at = ? WHERE id = ?",
	).run(r.status, r.answer, r.by, nowIso(), id);
}
