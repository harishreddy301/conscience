import { NotFoundError, ValidationError } from "../core/errors.js";
import {
	JdSnapshot,
	type JdSnapshotInput,
	type JdSnapshotRecord,
	JdTerm,
} from "../jd/schema.js";
import { type Db, nowIso } from "./index.js";

interface JdSnapshotRow {
	application_id: number;
	title_posted: string;
	seniority: string | null;
	must_haves_json: string;
	nice_to_haves_json: string;
	keywords_json: string;
	location: string | null;
	remote: string | null;
	salary: string | null;
	summary: string;
	source_url: string | null;
	captured_at: string;
}

function dedupeTerms(
	terms: JdSnapshot["must_haves"],
): JdSnapshot["must_haves"] {
	const seen = new Set<string>();
	return terms.filter((t) => {
		const k = t.term.toLowerCase();
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

function dedupe(xs: string[]): string[] {
	const seen = new Set<string>();
	return xs.filter((x) => {
		const k = x.toLowerCase();
		if (seen.has(k)) return false;
		seen.add(k);
		return true;
	});
}

/** Insert or replace the JD snapshot of an application. Validates input (exit 2 on bad data). */
export function upsertJdSnapshot(
	db: Db,
	appId: number,
	input: JdSnapshotInput | unknown,
): JdSnapshotRecord {
	const parsed = JdSnapshot.safeParse(input);
	if (!parsed.success)
		throw new ValidationError(
			"invalid JD snapshot",
			parsed.error.issues.map((i) => ({
				path: i.path.join("."),
				message: i.message,
			})),
		);
	const exists = db
		.prepare("SELECT 1 AS x FROM applications WHERE id = ?")
		.get(appId);
	if (!exists) throw new NotFoundError(`application ${appId} not found`);
	const s = parsed.data;
	const capturedAt = s.captured_at ?? nowIso();
	db.prepare(
		`INSERT INTO jd_snapshots(application_id, title_posted, seniority, must_haves_json, nice_to_haves_json,
		   keywords_json, location, remote, salary, summary, source_url, captured_at)
		 VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT(application_id) DO UPDATE SET title_posted=excluded.title_posted, seniority=excluded.seniority,
		   must_haves_json=excluded.must_haves_json, nice_to_haves_json=excluded.nice_to_haves_json,
		   keywords_json=excluded.keywords_json, location=excluded.location, remote=excluded.remote,
		   salary=excluded.salary, summary=excluded.summary,
		   source_url=COALESCE(excluded.source_url, jd_snapshots.source_url), captured_at=excluded.captured_at`,
	).run(
		appId,
		s.title_posted,
		s.seniority ?? null,
		JSON.stringify(dedupeTerms(s.must_haves)),
		JSON.stringify(dedupeTerms(s.nice_to_haves)),
		JSON.stringify(dedupe(s.keywords)),
		s.location ?? null,
		s.remote ?? null,
		s.salary ?? null,
		s.summary,
		s.source_url ?? null,
		capturedAt,
	);
	return getJdSnapshot(db, appId) as JdSnapshotRecord;
}

function parseTerms(json: string): JdSnapshotRecord["must_haves"] {
	try {
		const raw: unknown = JSON.parse(json);
		if (!Array.isArray(raw)) return [];
		return raw.flatMap((t) => {
			const r = JdTerm.safeParse(t);
			return r.success ? [r.data] : [];
		});
	} catch {
		return [];
	}
}

function parseStrings(json: string): string[] {
	try {
		const raw: unknown = JSON.parse(json);
		return Array.isArray(raw)
			? raw.filter((x): x is string => typeof x === "string")
			: [];
	} catch {
		return [];
	}
}

export function getJdSnapshot(
	db: Db,
	appId: number,
): JdSnapshotRecord | undefined {
	const row = db
		.prepare("SELECT * FROM jd_snapshots WHERE application_id = ?")
		.get(appId) as JdSnapshotRow | undefined;
	if (!row) return undefined;
	return {
		application_id: row.application_id,
		title_posted: row.title_posted,
		seniority: row.seniority,
		must_haves: parseTerms(row.must_haves_json),
		nice_to_haves: parseTerms(row.nice_to_haves_json),
		keywords: parseStrings(row.keywords_json),
		location: row.location,
		remote: row.remote,
		salary: row.salary,
		summary: row.summary,
		source_url: row.source_url,
		captured_at: row.captured_at,
	};
}
