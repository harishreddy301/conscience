/**
 * Read model for the dashboard job board (kanban). One row per application with
 * its job, the latest resume run, the latest finalized run, the latest
 * interview round and the latest event detail. SQL only; mapping lives in
 * src/dashboard/board.ts.
 */
import type { AppSource, AppStatus } from "../core/state.js";
import type { Db } from "./index.js";

export interface BoardRow {
	id: number;
	status: AppStatus;
	source: AppSource;
	applied_at: string | null;
	last_event_at: string;
	created_at: string;
	artifacts_dir: string | null;
	requested_by: string | null;
	request_note: string | null;
	company: string;
	title: string;
	location: string | null;
	posted_at: string | null;
	url: string | null;
	/** Status of the newest resume run (any status). */
	run_status: string | null;
	/** Newest finalized run. */
	ats_score: number | null;
	hm_verdict: string | null;
	quality: string | null;
	/** Newest non-cancelled interview round linked to the application. */
	interview_round: string | null;
	/** 1 when conscience decided finalize-hold (recorded in an event detail). */
	held: number;
	/** detail_json of the newest event (reason notes for skipped cards). */
	last_detail: string | null;
	/** Why a `held` application waits on the user (ADR-005, schema v4). */
	hold_reason: string | null;
}

const BOARD_SQL = `
WITH lr AS (
  SELECT application_id, status,
         ROW_NUMBER() OVER (PARTITION BY application_id ORDER BY created_at DESC, id DESC) AS rn
    FROM resume_runs),
lf AS (
  SELECT application_id, ats_score, hm_verdict, quality,
         ROW_NUMBER() OVER (PARTITION BY application_id ORDER BY finalized_at DESC, id DESC) AS rn
    FROM resume_runs WHERE status = 'finalized'),
li AS (
  SELECT application_id, round,
         ROW_NUMBER() OVER (PARTITION BY application_id ORDER BY updated_at DESC, id DESC) AS rn
    FROM interviews WHERE application_id IS NOT NULL AND status <> 'cancelled'),
le AS (
  SELECT application_id, detail_json,
         ROW_NUMBER() OVER (PARTITION BY application_id ORDER BY at DESC, id DESC) AS rn
    FROM application_events)
SELECT a.id, a.status, a.source, a.applied_at, a.last_event_at, a.created_at, a.artifacts_dir,
       a.requested_by, a.request_note,
       c.name AS company, j.title, j.location, j.posted_at, COALESCE(j.url, j.canonical_url) AS url,
       lr.status AS run_status, lf.ats_score, lf.hm_verdict, lf.quality,
       li.round AS interview_round,
       EXISTS(SELECT 1 FROM application_events e
               WHERE e.application_id = a.id AND e.detail_json LIKE '%finalize-hold%') AS held,
       le.detail_json AS last_detail, a.hold_reason
  FROM applications a
  JOIN jobs j ON j.id = a.job_id
  JOIN companies c ON c.id = j.company_id
  LEFT JOIN lr ON lr.application_id = a.id AND lr.rn = 1
  LEFT JOIN lf ON lf.application_id = a.id AND lf.rn = 1
  LEFT JOIN li ON li.application_id = a.id AND li.rn = 1
  LEFT JOIN le ON le.application_id = a.id AND le.rn = 1
 ORDER BY (a.requested_by IS NOT NULL) DESC, a.last_event_at DESC, a.id DESC
 LIMIT ?`;

/** Every application as a board row, "You asked" first, then newest activity. */
export function boardRows(db: Db, limit = 2000): BoardRow[] {
	return db.prepare(BOARD_SQL).all(limit) as unknown as BoardRow[];
}

/** The application id for a job URL (exact url or canonical_url match). */
export function applicationIdByUrl(db: Db, url: string): number | undefined {
	const row = db
		.prepare(
			`SELECT a.id FROM applications a JOIN jobs j ON j.id = a.job_id
			  WHERE j.url = ? OR j.canonical_url = ? ORDER BY a.id LIMIT 1`,
		)
		.get(url, url) as { id: number } | undefined;
	return row?.id;
}

export function applicationIdForJob(db: Db, jobId: number): number | undefined {
	const row = db
		.prepare("SELECT id FROM applications WHERE job_id = ?")
		.get(jobId) as { id: number } | undefined;
	return row?.id;
}
