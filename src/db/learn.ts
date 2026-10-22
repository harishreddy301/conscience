import { z } from "zod";
import { JhError } from "../core/errors.js";
import type { Db } from "./index.js";

/** Posted JD title vs the headline and per-role display titles the resume used. */
export const TitleChoice = z.object({
	posted: z.string().min(1),
	headline: z.string(),
	display_titles: z.array(z.string().min(1)).default([]),
	/** How many roles showed an approved variant instead of the official title. */
	variants_used: z.number().int().min(0).default(0),
});
export type TitleChoice = z.output<typeof TitleChoice>;

/** What a finalized resume looked like when it went out. Recorded by `jh resume finalize` (W3). */
export const ResumeVariantInput = z.object({
	run_id: z.string().min(1).nullish(),
	angle: z.string().min(1).nullish(),
	framing: z.string().min(1).nullish(),
	keywords: z.array(z.string().min(1)).default([]),
	bullet_ids: z.array(z.string().min(1)).default([]),
	phrasing: z.array(z.string().min(1)).default([]),
	ats_score: z.number().int().min(0).max(100).nullish(),
	pages: z.number().int().min(1).max(10).nullish(),
	role_family: z.string().min(1).nullish(),
	source: z.string().min(1).nullish(),
	submitted_at: z.iso.datetime({ offset: true }).nullish(),
	/** Which titles the resume showed for which posted title (learning feature title_choice). */
	title_choice: TitleChoice.nullish(),
});
export type ResumeVariantInput = z.input<typeof ResumeVariantInput>;
export type ResumeVariant = z.output<typeof ResumeVariantInput>;

export interface ResumeVariantRow {
	application_id: number;
	run_id: string | null;
	angle: string | null;
	framing: string | null;
	keywords_json: string;
	bullet_ids_json: string;
	phrasing_json: string;
	ats_score: number | null;
	pages: number | null;
	role_family: string | null;
	source: string | null;
	submitted_at: string | null;
	title_choice_json: string | null;
}

/** One submitted application joined with its job, company, variant and final draft. */
export interface OutcomeRow {
	application_id: number;
	status: string;
	app_source: string;
	applied_at: string | null;
	created_at: string;
	job_title: string;
	company: string;
	run_id: string | null;
	angle: string | null;
	framing: string | null;
	keywords_json: string | null;
	bullet_ids_json: string | null;
	phrasing_json: string | null;
	ats_score: number | null;
	pages: number | null;
	role_family: string | null;
	variant_source: string | null;
	submitted_at: string | null;
	title_choice_json?: string | null;
	final_angle: string | null;
	final_ats: number | null;
}

export interface OutcomeEventRow {
	application_id: number;
	kind: string;
	from_status: string | null;
	to_status: string | null;
	at: string;
}

export interface OutcomeEmailRow {
	application_id: number;
	kind: string;
	received_at: string;
}

export const LearnState = z.object({
	last_run_at: z.string().nullable().default(null),
	resolved_at_last_run: z.number().int().min(0).default(0),
});
export type LearnState = z.infer<typeof LearnState>;

const LEARN_STATE_KEY = "learn.state";

/** Upsert the variant for an application. Validates input; throws JhError(exit 2) on bad data. */
export function recordVariant(
	db: Db,
	appId: number,
	v: ResumeVariantInput,
): void {
	if (!Number.isInteger(appId) || appId <= 0) {
		throw new JhError(`invalid application id ${appId}`, 2, "validation");
	}
	const parsed = ResumeVariantInput.safeParse(v);
	if (!parsed.success) {
		throw new JhError(
			"invalid resume variant",
			2,
			"validation",
			parsed.error.issues,
		);
	}
	const x = parsed.data;
	db.prepare(
		`INSERT INTO resume_variants(application_id, run_id, angle, framing, keywords_json, bullet_ids_json, phrasing_json, ats_score, pages, role_family, source, submitted_at, title_choice_json)
		 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
		 ON CONFLICT(application_id) DO UPDATE SET run_id=excluded.run_id, angle=excluded.angle, framing=excluded.framing,
		   keywords_json=excluded.keywords_json, bullet_ids_json=excluded.bullet_ids_json, phrasing_json=excluded.phrasing_json,
		   ats_score=excluded.ats_score, pages=excluded.pages, role_family=excluded.role_family, source=excluded.source,
		   submitted_at=COALESCE(excluded.submitted_at, resume_variants.submitted_at),
		   title_choice_json=COALESCE(excluded.title_choice_json, resume_variants.title_choice_json)`,
	).run(
		appId,
		x.run_id ?? null,
		x.angle ?? null,
		x.framing ?? null,
		JSON.stringify(dedupe(x.keywords)),
		JSON.stringify(dedupe(x.bullet_ids)),
		JSON.stringify(dedupe(x.phrasing)),
		x.ats_score ?? null,
		x.pages ?? null,
		x.role_family ?? null,
		x.source ?? null,
		x.submitted_at ?? null,
		x.title_choice ? JSON.stringify(x.title_choice) : null,
	);
}

export function getVariant(
	db: Db,
	appId: number,
): ResumeVariantRow | undefined {
	return db
		.prepare("SELECT * FROM resume_variants WHERE application_id = ?")
		.get(appId) as unknown as ResumeVariantRow | undefined;
}

/** Every application that was actually submitted (applied_at set or variant submitted_at set). */
export function listOutcomeRows(db: Db): OutcomeRow[] {
	return db
		.prepare(
			`SELECT a.id AS application_id, a.status, a.source AS app_source, a.applied_at, a.created_at,
			        j.title AS job_title, c.name AS company,
			        v.run_id, v.angle, v.framing, v.keywords_json, v.bullet_ids_json, v.phrasing_json,
			        v.ats_score, v.pages, v.role_family, v.source AS variant_source, v.submitted_at, v.title_choice_json,
			        (SELECT d.angle FROM resume_runs r JOIN resume_drafts d ON d.run_id = r.id AND d.id = r.final_draft_id
			          WHERE r.application_id = a.id AND r.status = 'finalized' ORDER BY r.finalized_at DESC LIMIT 1) AS final_angle,
			        (SELECT r.ats_score FROM resume_runs r
			          WHERE r.application_id = a.id AND r.status = 'finalized' ORDER BY r.finalized_at DESC LIMIT 1) AS final_ats
			   FROM applications a
			   JOIN jobs j ON j.id = a.job_id
			   JOIN companies c ON c.id = j.company_id
			   LEFT JOIN resume_variants v ON v.application_id = a.id
			  WHERE a.applied_at IS NOT NULL OR v.submitted_at IS NOT NULL
			  ORDER BY a.id`,
		)
		.all() as unknown as OutcomeRow[];
}

export function listOutcomeEvents(db: Db): OutcomeEventRow[] {
	return db
		.prepare(
			`SELECT e.application_id, e.kind, e.from_status, e.to_status, e.at
			   FROM application_events e
			   JOIN applications a ON a.id = e.application_id
			  WHERE a.applied_at IS NOT NULL
			     OR EXISTS (SELECT 1 FROM resume_variants v WHERE v.application_id = a.id AND v.submitted_at IS NOT NULL)
			  ORDER BY e.application_id, e.at`,
		)
		.all() as unknown as OutcomeEventRow[];
}

export function listOutcomeEmails(db: Db): OutcomeEmailRow[] {
	return db
		.prepare(
			`SELECT application_id, kind, received_at FROM emails
			  WHERE application_id IS NOT NULL ORDER BY application_id, received_at`,
		)
		.all() as unknown as OutcomeEmailRow[];
}

export function getLearnState(db: Db): LearnState {
	const row = db
		.prepare("SELECT value FROM settings WHERE key = ?")
		.get(LEARN_STATE_KEY) as { value: string } | undefined;
	if (!row) return LearnState.parse({});
	try {
		const parsed = LearnState.safeParse(JSON.parse(row.value));
		return parsed.success ? parsed.data : LearnState.parse({});
	} catch {
		return LearnState.parse({});
	}
}

export function setLearnState(db: Db, s: LearnState): void {
	const value = JSON.stringify(LearnState.parse(s));
	db.prepare(
		"INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
	).run(LEARN_STATE_KEY, value);
}

function dedupe(xs: string[]): string[] {
	return [...new Set(xs.map((x) => x.trim()).filter(Boolean))];
}
