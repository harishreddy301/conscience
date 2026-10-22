import { ReviewReport } from "../resume/review.js";
import { type Db, nowIso } from "./index.js";

export type RunStatus = "running" | "finalized" | "abandoned";
export type Quality = "ok" | "below_bar";

export interface ResumeRunRow {
	id: string;
	application_id: number;
	workdir: string;
	jd_path: string;
	keywords_json: string | null;
	status: RunStatus;
	iterations: number;
	final_draft_id: string | null;
	ats_score: number | null;
	hm_verdict: string | null;
	quality: Quality | null;
	created_at: string;
	finalized_at: string | null;
}

export interface ResumeDraftRow {
	run_id: string;
	id: string;
	angle: string;
	iteration: number;
	path: string;
	ats_score: number | null;
	valid: number | null;
	created_at: string;
}

export interface ResumeReviewRow {
	id: number;
	run_id: string;
	draft_id: string;
	reviewer: ReviewReport["reviewer"];
	verdict: string;
	score: number;
	json: string;
	created_at: string;
}

export function createRun(
	db: Db,
	r: { id: string; application_id: number; workdir: string; jd_path: string },
): void {
	db.prepare(
		`INSERT INTO resume_runs(id, application_id, workdir, jd_path, created_at)
		 VALUES(?, ?, ?, ?, ?)`,
	).run(r.id, r.application_id, r.workdir, r.jd_path, nowIso());
}

export function getRun(db: Db, id: string): ResumeRunRow | undefined {
	return db.prepare("SELECT * FROM resume_runs WHERE id = ?").get(id) as
		| ResumeRunRow
		| undefined;
}

export function listRuns(db: Db, appId: number): ResumeRunRow[] {
	return db
		.prepare(
			"SELECT * FROM resume_runs WHERE application_id = ? ORDER BY created_at DESC, id DESC",
		)
		.all(appId) as unknown as ResumeRunRow[];
}

export function setRunKeywords(db: Db, id: string, kwJson: string): void {
	db.prepare("UPDATE resume_runs SET keywords_json = ? WHERE id = ?").run(
		kwJson,
		id,
	);
}

export function setRunStatus(db: Db, id: string, status: RunStatus): void {
	db.prepare("UPDATE resume_runs SET status = ? WHERE id = ?").run(status, id);
}

/** Insert or update a draft; null-ish score/valid keep the stored values. */
export function upsertDraft(
	db: Db,
	d: {
		run_id: string;
		id: string;
		angle: string;
		iteration: number;
		path: string;
		ats_score?: number;
		valid?: boolean;
	},
): void {
	const valid = d.valid === undefined ? null : d.valid ? 1 : 0;
	db.prepare(
		`INSERT INTO resume_drafts(run_id, id, angle, iteration, path, ats_score, valid, created_at)
		 VALUES(?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(run_id, id) DO UPDATE SET angle = excluded.angle, iteration = excluded.iteration,
		   path = excluded.path,
		   ats_score = COALESCE(excluded.ats_score, resume_drafts.ats_score),
		   valid = COALESCE(excluded.valid, resume_drafts.valid)`,
	).run(
		d.run_id,
		d.id,
		d.angle,
		d.iteration,
		d.path,
		d.ats_score ?? null,
		valid,
		nowIso(),
	);
	db.prepare(
		"UPDATE resume_runs SET iterations = MAX(iterations, ?) WHERE id = ?",
	).run(d.iteration, d.run_id);
}

export function getDraft(
	db: Db,
	runId: string,
	draftId: string,
): ResumeDraftRow | undefined {
	return db
		.prepare("SELECT * FROM resume_drafts WHERE run_id = ? AND id = ?")
		.get(runId, draftId) as ResumeDraftRow | undefined;
}

export function listDrafts(db: Db, runId: string): ResumeDraftRow[] {
	return db
		.prepare(
			"SELECT * FROM resume_drafts WHERE run_id = ? ORDER BY iteration, created_at, id",
		)
		.all(runId) as unknown as ResumeDraftRow[];
}

export function addReview(db: Db, runId: string, rep: ReviewReport): number {
	const r = db
		.prepare(
			`INSERT INTO resume_reviews(run_id, draft_id, reviewer, verdict, score, json, created_at)
			 VALUES(?, ?, ?, ?, ?, ?, ?)`,
		)
		.run(
			runId,
			rep.draft_id,
			rep.reviewer,
			rep.verdict,
			Math.round(rep.score),
			JSON.stringify(rep),
			nowIso(),
		);
	return Number(r.lastInsertRowid);
}

/** Reviews in insertion order (oldest first), optionally for one draft. */
export function listReviews(
	db: Db,
	runId: string,
	draftId?: string,
): ReviewReport[] {
	const rows = (draftId === undefined
		? db
				.prepare("SELECT * FROM resume_reviews WHERE run_id = ? ORDER BY id")
				.all(runId)
		: db
				.prepare(
					"SELECT * FROM resume_reviews WHERE run_id = ? AND draft_id = ? ORDER BY id",
				)
				.all(runId, draftId)) as unknown as ResumeReviewRow[];
	return rows.map((row) => ReviewReport.parse(JSON.parse(row.json)));
}

export function finalizeRun(
	db: Db,
	id: string,
	f: {
		final_draft_id: string;
		ats_score: number;
		hm_verdict: string | null;
		quality: Quality;
		iterations: number;
	},
): void {
	db.prepare(
		`UPDATE resume_runs SET status = 'finalized', final_draft_id = ?, ats_score = ?, hm_verdict = ?,
		   quality = ?, iterations = ?, finalized_at = ? WHERE id = ?`,
	).run(
		f.final_draft_id,
		Math.round(f.ats_score),
		f.hm_verdict,
		f.quality,
		f.iterations,
		nowIso(),
		id,
	);
}

/** Latest finalized run for an application (dashboard "ready to apply"). */
export function latestFinalRun(
	db: Db,
	appId: number,
):
	| {
			run_id: string;
			ats_score: number | null;
			hm_verdict: string | null;
			quality: string | null;
			finalized_at: string | null;
	  }
	| undefined {
	return db
		.prepare(
			`SELECT id AS run_id, ats_score, hm_verdict, quality, finalized_at FROM resume_runs
			  WHERE application_id = ? AND status = 'finalized'
			  ORDER BY finalized_at DESC, id DESC LIMIT 1`,
		)
		.get(appId) as
		| {
				run_id: string;
				ats_score: number | null;
				hm_verdict: string | null;
				quality: string | null;
				finalized_at: string | null;
		  }
		| undefined;
}
