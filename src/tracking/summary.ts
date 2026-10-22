/**
 * Dashboard read models: GET /api/summary and GET /api/applications.
 */
import type { AppStatus } from "../core/state.js";
import type { Db } from "../db/index.js";
import {
	type ApplicationView,
	countByStatus,
	listApplications,
} from "../db/repo.js";
import { latestFinalRun } from "../db/resume.js";
import {
	countUnlinkedEmails,
	lastEmailSubjects,
	lastOkSyncAt,
	latestSyncRun,
	listEmails,
	listInterviews,
	openAssessmentEmails,
} from "../db/tracking.js";
import { listMetrics } from "../me/metrics.js";
import type { Summary, SyncFreshness, SyncKind } from "./schemas.js";
import { studySummary } from "./study.js";

/** A sync older than this is shown as stale. */
export const SYNC_STALE_HOURS = 8;
export const INTERVIEW_HORIZON_DAYS = 14;
const DAY_MS = 86_400_000;

export function upcomingInterviews(
	db: Db,
	now: Date,
	days = INTERVIEW_HORIZON_DAYS,
): Summary["interviews"] {
	// Include interviews that started in the last 2h (still "now").
	const from = new Date(now.getTime() - 2 * 3_600_000).toISOString();
	const to = new Date(now.getTime() + days * DAY_MS).toISOString();
	return listInterviews(db, { fromIso: from, toIso: to }).map((i) => ({
		...i,
		startsInMinutes: i.start_at
			? Math.round((Date.parse(i.start_at) - now.getTime()) / 60_000)
			: null,
	}));
}

export function readyToApply(db: Db): Summary["readyToApply"] {
	return listApplications(db, { status: ["tailored"], limit: 50 }).map((a) => {
		const run = latestFinalRun(db, a.id);
		return {
			applicationId: a.id,
			company: a.company,
			title: a.title,
			atsScore: run?.ats_score ?? null,
			quality: run?.quality ?? null,
		};
	});
}

/** Estimated metrics awaiting the user's decision; empty when me/ is missing. */
export function pendingMetrics(): Summary["pendingMetrics"] {
	try {
		const items = listMetrics({ status: "estimated" }).map((m) => ({
			id: m.id,
			bullet_id: m.bullet_id,
			phrase: m.phrase,
			value: m.value,
			derivation: m.derivation,
		}));
		return { count: items.length, items };
	} catch {
		return { count: 0, items: [] };
	}
}

export function assessmentsDue(db: Db): Summary["assessments"] {
	return openAssessmentEmails(db).map((e) => {
		const x = parseExtracted(e.extracted_json);
		return {
			emailId: e.id,
			applicationId: e.application_id,
			company: e.company ?? x.company ?? null,
			subject: e.subject,
			dueAt: x.assessment?.due_at ?? null,
			link: x.assessment?.link ?? null,
		};
	});
}

interface Extracted {
	company?: string;
	assessment?: { due_at?: string; link?: string };
}

function parseExtracted(json: string | null): Extracted {
	if (!json) return {};
	try {
		const v = JSON.parse(json) as unknown;
		return v && typeof v === "object" ? (v as Extracted) : {};
	} catch {
		return {};
	}
}

export function syncFreshness(
	db: Db,
	kind: SyncKind,
	now: Date,
): SyncFreshness {
	const lastRun = latestSyncRun(db, kind) ?? null;
	const lastOkAt = lastOkSyncAt(db, kind);
	const stale =
		!lastOkAt ||
		now.getTime() - Date.parse(lastOkAt) > SYNC_STALE_HOURS * 3_600_000;
	return {
		kind,
		lastOkAt,
		lastRun,
		error: lastRun && lastRun.ok === 0 ? (lastRun.error ?? "unknown") : null,
		stale,
	};
}

export function buildSummary(db: Db, now: Date = new Date()): Summary {
	return {
		generatedAt: now.toISOString(),
		study: studySummary(db, now),
		interviews: upcomingInterviews(db, now),
		pipeline: countByStatus(db),
		readyToApply: readyToApply(db),
		pendingMetrics: pendingMetrics(),
		emails: {
			recent: listEmails(db, { limit: 10 }),
			needsLinking: countUnlinkedEmails(db),
		},
		assessments: assessmentsDue(db),
		sync: {
			gmail: syncFreshness(db, "gmail", now),
			calendar: syncFreshness(db, "calendar", now),
		},
	};
}

export const DEFAULT_APP_STATUSES: AppStatus[] = [
	"applied",
	"assessment",
	"interviewing",
	"offer",
];

export interface ApplicationRowView extends ApplicationView {
	lastEmailSubject: string | null;
	daysSinceLastEvent: number;
}

/** Applications table for the dashboard card. */
export function applicationsView(
	db: Db,
	statuses: AppStatus[],
	limit: number,
	now: Date = new Date(),
): ApplicationRowView[] {
	const apps = listApplications(db, { status: statuses, limit });
	const subjects = lastEmailSubjects(
		db,
		apps.map((a) => a.id),
	);
	return apps.map((a) => ({
		...a,
		lastEmailSubject: subjects.get(a.id)?.subject ?? null,
		daysSinceLastEvent: Math.max(
			0,
			Math.floor((now.getTime() - Date.parse(a.last_event_at)) / DAY_MS),
		),
	}));
}
