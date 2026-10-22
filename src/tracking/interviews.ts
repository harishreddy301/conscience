/**
 * Interview upsert from calendar events, merging with email-sourced interviews (±30 min).
 */
import { isAbsolute, relative, resolve } from "node:path";
import { artifactsDir } from "../core/paths.js";
import { transition } from "../core/state.js";
import { type Db, tx } from "../db/index.js";
import {
	findCompanyByName,
	getApplication,
	listApplications,
} from "../db/repo.js";
import {
	getInterviewByEventId,
	type InterviewFields,
	insertInterview,
	unmergedEmailInterviews,
	updateInterview,
} from "../db/tracking.js";
import type { InterviewRow, InterviewUpsertItem } from "./schemas.js";

export const MERGE_WINDOW_MINUTES = 30;

export interface UpsertResult {
	inserted: number;
	updated: number;
	merged: number;
}

interface Linked {
	applicationId: number | null;
	companyId: number | null;
}

function linkFor(db: Db, item: InterviewUpsertItem): Linked {
	if (item.application_id) {
		const app = getApplication(db, item.application_id);
		if (app) return { applicationId: app.id, companyId: app.company_id };
	}
	const company = findCompanyByName(db, item.company);
	if (!company) return { applicationId: null, companyId: null };
	const apps = listApplications(db, { companyId: company.id, limit: 1 });
	return { applicationId: apps[0]?.id ?? null, companyId: company.id };
}

function fieldsFrom(item: InterviewUpsertItem, link: Linked): InterviewFields {
	return {
		calendar_event_id: item.calendar_event_id,
		application_id: link.applicationId,
		company_id: link.companyId,
		company_name: item.company,
		role: item.role ?? null,
		round: item.round,
		start_at: item.start,
		end_at: item.end,
		tz: item.tz,
		location: item.location ?? null,
		meeting_link: item.meeting_link ?? null,
		status: item.status,
		source: "calendar",
	};
}

function withinWindow(a: string | null, b: string): boolean {
	if (!a) return false;
	const diff = Math.abs(Date.parse(a) - Date.parse(b));
	return diff <= MERGE_WINDOW_MINUTES * 60_000;
}

/** An email-sourced interview for the same company within ±30m (or undated). */
export function findMergeCandidate(
	db: Db,
	item: InterviewUpsertItem,
	companyId: number | null,
): InterviewRow | undefined {
	const candidates = unmergedEmailInterviews(db, companyId, item.company);
	return (
		candidates.find((c) => withinWindow(c.start_at, item.start)) ??
		candidates.find((c) => c.start_at === null)
	);
}

const PRE_APPLIED = new Set(["discovered", "shortlisted", "tailored"]);

function markInterviewing(db: Db, appId: number | null): void {
	if (!appId) return;
	const opts = { actor: "calendar-sync", soft: true, external: true };
	// An interview proves the application went out: hop through `applied`.
	const status = getApplication(db, appId)?.status;
	if (status && PRE_APPLIED.has(status))
		transition(db, appId, "applied", {
			...opts,
			note: "inferred from calendar interview",
		});
	transition(db, appId, "interviewing", {
		...opts,
		note: "calendar interview",
	});
}

/** Keep fields that the calendar does not know (e.g. an email-provided round). */
function mergePatch(
	existing: InterviewRow,
	f: InterviewFields,
): Partial<InterviewFields> {
	return {
		...f,
		application_id: f.application_id ?? existing.application_id,
		company_id: f.company_id ?? existing.company_id,
		role: f.role ?? existing.role,
		round: f.round ?? existing.round,
		meeting_link: f.meeting_link ?? existing.meeting_link,
		location: f.location ?? existing.location,
	};
}

type UpsertOutcome = keyof UpsertResult;

function upsertOne(db: Db, item: InterviewUpsertItem): UpsertOutcome {
	const link = linkFor(db, item);
	const fields = fieldsFrom(item, link);
	const existing =
		getInterviewByEventId(db, item.calendar_event_id) ??
		findMergeCandidate(db, item, link.companyId);
	let outcome: UpsertOutcome = "inserted";
	let appId = link.applicationId;
	if (existing) {
		updateInterview(db, existing.id, mergePatch(existing, fields));
		appId = appId ?? existing.application_id;
		outcome = existing.calendar_event_id ? "updated" : "merged";
	} else {
		insertInterview(db, fields);
	}
	if (item.status !== "cancelled" && item.round !== "assessment")
		markInterviewing(db, appId);
	return outcome;
}

export function upsertInterviews(
	db: Db,
	items: InterviewUpsertItem[],
): UpsertResult {
	const res: UpsertResult = { inserted: 0, updated: 0, merged: 0 };
	for (const item of items) res[tx(db, () => upsertOne(db, item))]++;
	return res;
}

/** True when `p` resolves inside `root` (no traversal, same drive). */
export function isInside(root: string, p: string): boolean {
	const rel = relative(resolve(root), resolve(p));
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** Prep files must live under the artifacts directory. */
export function isAllowedPrepPath(p: string): boolean {
	return isInside(artifactsDir(), p);
}
