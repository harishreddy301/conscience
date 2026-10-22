import { createHash } from "node:crypto";
import type { SQLInputValue } from "node:sqlite";
import type { AppSource, AppStatus } from "../core/state.js";
import { ACTIVE, APP_STATUSES, SUBMITTED } from "../core/state.js";
import type { Db } from "./index.js";
import { nowIso, tx } from "./index.js";

export interface CompanyRow {
	id: number;
	name: string;
	name_norm: string;
	domain: string | null;
	careers_url: string | null;
	ats: string | null;
	tenant: string | null;
	blocked: number;
	created_at: string;
}

export interface JobRow {
	id: number;
	company_id: number;
	title: string;
	title_norm: string;
	location: string | null;
	remote: number | null;
	url: string | null;
	canonical_url: string | null;
	source_key: string | null;
	fingerprint: string | null;
	jd_text: string | null;
	posted_at: string | null;
	discovered_at: string;
}

export interface ApplicationRow {
	id: number;
	job_id: number;
	status: AppStatus;
	source: AppSource;
	applied_at: string | null;
	last_event_at: string;
	artifacts_dir: string | null;
	created_at: string;
	updated_at: string;
	/** 'user' when the user asked for this job ("You asked"); schema v3. */
	requested_by?: "user" | null;
	request_note?: string | null;
}

export interface ApplicationView extends ApplicationRow {
	company_id: number;
	company: string;
	company_domain: string | null;
	title: string;
	url: string | null;
}

export interface EventRow {
	id: number;
	application_id: number;
	kind: "transition" | "note" | "email" | "interview" | "followup";
	from_status: string | null;
	to_status: string | null;
	actor: string;
	email_id: number | null;
	detail_json: string | null;
	at: string;
}

// ---------- normalization ----------

const COMPANY_SUFFIXES = new Set([
	"inc",
	"llc",
	"ltd",
	"corp",
	"co",
	"plc",
	"gmbh",
]);
const TITLE_ABBREVIATIONS: Readonly<Record<string, string>> = {
	sr: "senior",
	snr: "senior",
	jr: "junior",
	mgr: "manager",
	eng: "engineer",
	engr: "engineer",
	dev: "developer",
};

function words(s: string): string[] {
	return s
		.normalize("NFKD")
		.replace(/\p{M}+/gu, "")
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim()
		.split(" ")
		.filter(Boolean);
}

/** Lowercase, strip punctuation and trailing legal suffixes (inc, llc, ...), collapse spaces. */
export function normName(s: string): string {
	const w = words(s);
	while (w.length > 1 && COMPANY_SUFFIXES.has(w[w.length - 1] as string))
		w.pop();
	return w.join(" ");
}

/** Lowercase, strip punctuation, expand common abbreviations (sr -> senior). */
export function normTitle(s: string): string {
	return words(s)
		.map((w) => TITLE_ABBREVIATIONS[w] ?? w)
		.join(" ");
}

function normDomain(d: string | undefined): string | undefined {
	if (!d) return undefined;
	const host = d
		.trim()
		.toLowerCase()
		.replace(/^[a-z]+:\/\//, "")
		.replace(/^www\./, "")
		.split(/[/?#:]/)[0];
	return host || undefined;
}

function cityOf(location: string | undefined): string {
	if (!location) return "";
	return words(location.split(",")[0] ?? "").join(" ");
}

function fingerprintOf(
	nameNorm: string,
	titleNorm: string,
	location?: string,
): string {
	return createHash("sha1")
		.update(`${nameNorm}|${titleNorm}|${cityOf(location)}`)
		.digest("hex");
}

// ---------- companies ----------

export function getCompany(db: Db, id: number): CompanyRow | undefined {
	return db.prepare("SELECT * FROM companies WHERE id = ?").get(id) as
		| CompanyRow
		| undefined;
}

export function findCompanyByDomain(
	db: Db,
	domain: string,
): CompanyRow | undefined {
	const d = normDomain(domain);
	if (!d) return undefined;
	return db
		.prepare("SELECT * FROM companies WHERE domain = ? ORDER BY id LIMIT 1")
		.get(d) as CompanyRow | undefined;
}

export function findCompanyByName(
	db: Db,
	name: string,
): CompanyRow | undefined {
	return db
		.prepare("SELECT * FROM companies WHERE name_norm = ?")
		.get(normName(name)) as CompanyRow | undefined;
}

/** Insert by name_norm, or fill the existing row's null domain/careers_url/ats/tenant. */
export function upsertCompany(
	db: Db,
	c: {
		name: string;
		domain?: string;
		careers_url?: string;
		ats?: string;
		tenant?: string;
	},
): CompanyRow {
	const nameNorm = normName(c.name);
	if (!nameNorm) throw new Error("company name is empty after normalization");
	const domain = normDomain(c.domain) ?? null;
	return tx(db, () => {
		db.prepare(
			`INSERT INTO companies(name, name_norm, domain, careers_url, ats, tenant, created_at)
			 VALUES(?, ?, ?, ?, ?, ?, ?)
			 ON CONFLICT(name_norm) DO UPDATE SET
			   domain = COALESCE(companies.domain, excluded.domain),
			   careers_url = COALESCE(companies.careers_url, excluded.careers_url),
			   ats = COALESCE(companies.ats, excluded.ats),
			   tenant = COALESCE(companies.tenant, excluded.tenant)`,
		).run(
			c.name.trim(),
			nameNorm,
			domain,
			c.careers_url ?? null,
			c.ats ?? null,
			c.tenant ?? null,
			nowIso(),
		);
		return db
			.prepare("SELECT * FROM companies WHERE name_norm = ?")
			.get(nameNorm) as unknown as CompanyRow;
	});
}

// ---------- jobs ----------

export function getJob(db: Db, id: number): JobRow | undefined {
	return db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
		| JobRow
		| undefined;
}

function findExistingJob(
	db: Db,
	sourceKey: string | undefined,
	fingerprint: string,
): JobRow | undefined {
	if (sourceKey) {
		const bySource = db
			.prepare("SELECT * FROM jobs WHERE source_key = ?")
			.get(sourceKey) as JobRow | undefined;
		if (bySource) return bySource;
	}
	return db
		.prepare("SELECT * FROM jobs WHERE fingerprint = ?")
		.get(fingerprint) as JobRow | undefined;
}

/**
 * Insert a job, deduplicating on source_key then fingerprint
 * (sha1 of company name_norm | title_norm | city). A duplicate returns the
 * existing row with its null url/canonical_url/jd_text/posted_at filled in.
 */
export function insertJob(
	db: Db,
	j: {
		company_id: number;
		title: string;
		location?: string;
		remote?: boolean;
		url?: string;
		canonical_url?: string;
		source_key?: string;
		jd_text?: string;
		posted_at?: string;
	},
): JobRow {
	return tx(db, () => {
		const company = getCompany(db, j.company_id);
		if (!company) throw new Error(`company ${j.company_id} not found`);
		const titleNorm = normTitle(j.title);
		const fp = fingerprintOf(company.name_norm, titleNorm, j.location);
		const existing = findExistingJob(db, j.source_key, fp);
		if (existing) {
			db.prepare(
				`UPDATE jobs SET url = COALESCE(url, ?), canonical_url = COALESCE(canonical_url, ?),
				 jd_text = COALESCE(jd_text, ?), posted_at = COALESCE(posted_at, ?) WHERE id = ?`,
			).run(
				j.url ?? null,
				j.canonical_url ?? null,
				j.jd_text ?? null,
				j.posted_at ?? null,
				existing.id,
			);
			return getJob(db, existing.id) as JobRow;
		}
		const r = db
			.prepare(
				`INSERT INTO jobs(company_id, title, title_norm, location, remote, url, canonical_url, source_key, fingerprint, jd_text, posted_at, discovered_at)
				 VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				j.company_id,
				j.title.trim(),
				titleNorm,
				j.location ?? null,
				j.remote === undefined ? null : j.remote ? 1 : 0,
				j.url ?? null,
				j.canonical_url ?? null,
				j.source_key ?? null,
				fp,
				j.jd_text ?? null,
				j.posted_at ?? null,
				nowIso(),
			);
		return getJob(db, Number(r.lastInsertRowid)) as JobRow;
	});
}

export function setJobJd(db: Db, id: number, jd: string): void {
	db.prepare("UPDATE jobs SET jd_text = ? WHERE id = ?").run(jd, id);
}

export function setJobPostedAt(db: Db, id: number, postedAt: string): void {
	db.prepare("UPDATE jobs SET posted_at = ? WHERE id = ?").run(postedAt, id);
}

// ---------- applications ----------

const APP_VIEW_SQL = `SELECT a.*, j.company_id AS company_id, c.name AS company, c.domain AS company_domain,
	j.title AS title, COALESCE(j.url, j.canonical_url) AS url
	FROM applications a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.id = j.company_id`;

/** Create the application for a job (default 'shortlisted', 'conscience'); returns the existing one for that job. */
export function createApplication(
	db: Db,
	a: {
		job_id: number;
		status?: AppStatus;
		source?: AppSource;
		applied_at?: string;
		/** Defaults to applied_at ?? now; email backfills pass the email's time. */
		last_event_at?: string;
	},
): ApplicationRow {
	return tx(db, () => {
		const existing = db
			.prepare("SELECT * FROM applications WHERE job_id = ?")
			.get(a.job_id) as ApplicationRow | undefined;
		if (existing) return existing;
		const now = nowIso();
		const status = a.status ?? "shortlisted";
		const appliedAt = a.applied_at ?? (SUBMITTED.has(status) ? now : null);
		const r = db
			.prepare(
				`INSERT INTO applications(job_id, status, source, applied_at, last_event_at, created_at, updated_at)
				 VALUES(?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				a.job_id,
				status,
				a.source ?? "conscience",
				appliedAt,
				a.last_event_at ?? appliedAt ?? now,
				now,
				now,
			);
		return db
			.prepare("SELECT * FROM applications WHERE id = ?")
			.get(Number(r.lastInsertRowid)) as unknown as ApplicationRow;
	});
}

export function getApplication(
	db: Db,
	id: number,
): ApplicationView | undefined {
	return db.prepare(`${APP_VIEW_SQL} WHERE a.id = ?`).get(id) as
		| ApplicationView
		| undefined;
}

/** Filtered application views, newest activity first. */
export function listApplications(
	db: Db,
	f: {
		status?: AppStatus[];
		active?: boolean;
		sinceIso?: string;
		companyId?: number;
		/** Only applications the user asked for (requested_by = 'user'). */
		userRequested?: boolean;
		limit?: number;
	} = {},
): ApplicationView[] {
	const where: string[] = [];
	const params: SQLInputValue[] = [];
	const addIn = (statuses: readonly string[]) => {
		where.push(`a.status IN (${statuses.map(() => "?").join(",")})`);
		params.push(...statuses);
	};
	if (f.status?.length) addIn(f.status);
	if (f.active) addIn([...ACTIVE]);
	if (f.sinceIso) {
		where.push("a.last_event_at >= ?");
		params.push(f.sinceIso);
	}
	if (f.companyId !== undefined) {
		where.push("j.company_id = ?");
		params.push(f.companyId);
	}
	if (f.userRequested) where.push("a.requested_by = 'user'");
	let sql = APP_VIEW_SQL;
	if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
	sql += " ORDER BY a.last_event_at DESC, a.id DESC";
	if (f.limit !== undefined) {
		sql += " LIMIT ?";
		params.push(Math.max(0, Math.floor(f.limit)));
	}
	return db.prepare(sql).all(...params) as unknown as ApplicationView[];
}

export function countByStatus(db: Db): Record<AppStatus, number> {
	const out = Object.fromEntries(APP_STATUSES.map((s) => [s, 0])) as Record<
		AppStatus,
		number
	>;
	const rows = db
		.prepare("SELECT status, COUNT(*) AS n FROM applications GROUP BY status")
		.all() as {
		status: AppStatus;
		n: number;
	}[];
	for (const r of rows) out[r.status] = r.n;
	return out;
}

/** Low-level status write. Only core/state.transition should call this. */
export function updateApplicationStatus(
	db: Db,
	id: number,
	to: AppStatus,
	at: string,
): void {
	db.prepare(
		`UPDATE applications SET status = ?, updated_at = ?,
		 applied_at = CASE WHEN ? = 'applied' THEN COALESCE(applied_at, ?) ELSE applied_at END
		 WHERE id = ?`,
	).run(to, at, to, at, id);
}

/** Mark an application as asked for by the user ("You asked"). Keeps an existing note when `note` is undefined. */
export function setUserRequested(db: Db, id: number, note?: string): void {
	db.prepare(
		`UPDATE applications SET requested_by = 'user', request_note = COALESCE(?, request_note), updated_at = ?
		 WHERE id = ?`,
	).run(note ?? null, nowIso(), id);
}

export function setArtifactsDir(db: Db, id: number, dir: string): void {
	db.prepare(
		"UPDATE applications SET artifacts_dir = ?, updated_at = ? WHERE id = ?",
	).run(dir, nowIso(), id);
}

// ---------- events ----------

/** Insert an application event and bump applications.last_event_at (never backwards). */
export function insertEvent(
	db: Db,
	e: {
		application_id: number;
		kind: EventRow["kind"];
		from_status?: string;
		to_status?: string;
		actor: string;
		email_id?: number;
		detail?: unknown;
		at?: string;
	},
): number {
	const at = e.at ?? nowIso();
	return tx(db, () => {
		const r = db
			.prepare(
				`INSERT INTO application_events(application_id, kind, from_status, to_status, actor, email_id, detail_json, at)
				 VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				e.application_id,
				e.kind,
				e.from_status ?? null,
				e.to_status ?? null,
				e.actor,
				e.email_id ?? null,
				e.detail === undefined ? null : JSON.stringify(e.detail),
				at,
			);
		db.prepare(
			"UPDATE applications SET last_event_at = MAX(last_event_at, ?), updated_at = ? WHERE id = ?",
		).run(at, nowIso(), e.application_id);
		return Number(r.lastInsertRowid);
	});
}

export function listEvents(db: Db, appId: number): EventRow[] {
	return db
		.prepare(
			"SELECT * FROM application_events WHERE application_id = ? ORDER BY at, id",
		)
		.all(appId) as unknown as EventRow[];
}

// ---------- settings ----------

/** Setting value parsed as JSON; a non-JSON stored value is returned as a raw string. */
/** Anything with zod's safeParse shape. */
export interface SettingSchema<T> {
	safeParse(v: unknown): { success: true; data: T } | { success: false };
}

/**
 * Read a JSON setting. Without `schema` the type is caller-asserted (internal
 * keys only); with it, a stored value of the wrong shape yields `fallback`.
 */
export function getSetting<T>(
	db: Db,
	key: string,
	fallback: T,
	schema?: SettingSchema<T>,
): T {
	const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
		| { value: string }
		| undefined;
	if (!row) return fallback;
	let raw: unknown;
	try {
		raw = JSON.parse(row.value);
	} catch {
		raw = row.value;
	}
	if (!schema) return raw as T;
	const parsed = schema.safeParse(raw);
	return parsed.success ? parsed.data : fallback;
}

export function setSetting(db: Db, key: string, value: unknown): void {
	db.prepare(
		"INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(key, JSON.stringify(value));
}

/** settings.timezone, else the system time zone. */
export function timezone(db: Db): string {
	const tz = getSetting<unknown>(db, "timezone", null);
	if (typeof tz === "string" && tz.trim()) return tz.trim();
	return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
