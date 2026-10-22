/**
 * Ingest classified Gmail messages: dedupe, link, record, apply soft transitions,
 * create external applications and email-sourced interviews.
 */
import { audit } from "../core/audit.js";
import { type AppStatus, transition } from "../core/state.js";
import { type Db, tx } from "../db/index.js";
import {
	createApplication,
	getApplication,
	insertEvent,
	insertJob,
	upsertCompany,
} from "../db/repo.js";
import {
	findEmailByMessageId,
	insertEmail,
	insertInterview,
	updateInterview,
} from "../db/tracking.js";
import {
	domainOf,
	type Effect,
	effectFor,
	isSharedSenderDomain,
	type LinkVia,
	resolveLink,
} from "./email-link.js";
import type { EmailIngestItem, EmailRow } from "./schemas.js";

export const INGEST_ACTOR = "email-tracker";

export interface IngestItemResult {
	gmail_message_id: string;
	duplicate: boolean;
	email_id?: number;
	via?: LinkVia;
	application_id?: number | null;
	created_application?: boolean;
	from_status?: AppStatus | null;
	to_status?: AppStatus | null;
	changed?: boolean;
	interview_id?: number;
	planned?: Effect;
}

export interface IngestResult {
	ingested: number;
	duplicates: number;
	items: IngestItemResult[];
}

/** "careers.acme-robotics.com" -> "Acme Robotics" (fallback when no company hint). */
export function companyNameFromDomain(domain: string): string {
	const labels = domain.split(".");
	const base = labels.length >= 2 ? labels[labels.length - 2] : labels[0];
	return (base ?? domain)
		.split(/[-_]/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

/** Create company + job + application (source email) for an unknown employer. */
function createExternalApplication(
	db: Db,
	item: EmailIngestItem,
): { applicationId: number; companyId: number } | null {
	const domain = domainOf(item.from);
	const ownDomain =
		domain && !isSharedSenderDomain(domain) ? domain : undefined;
	const name =
		item.company ?? (ownDomain ? companyNameFromDomain(ownDomain) : undefined);
	if (!name) return null;
	const company = upsertCompany(db, { name, domain: ownDomain });
	const job = insertJob(db, {
		company_id: company.id,
		title: item.role ?? "Unknown role",
	});
	const app = createApplication(db, {
		job_id: job.id,
		status: "shortlisted",
		source: "email",
		// Backfilled mail: the clock starts at the email, not today, so the
		// ghost sweep and "days since last event" are right.
		last_event_at: item.received_at,
	});
	return { applicationId: app.id, companyId: company.id };
}

/** Statuses before submission: a reply from the employer proves an application went out. */
export const PRE_APPLIED: ReadonlySet<AppStatus> = new Set([
	"discovered",
	"shortlisted",
	"tailored",
]);

const LATERAL: ReadonlySet<AppStatus> = new Set(["assessment", "interviewing"]);

export function applyTransitions(
	db: Db,
	appId: number,
	to: AppStatus,
	emailId: number,
	item: EmailIngestItem,
	actor: string = INGEST_ACTOR,
): { from: AppStatus; to: AppStatus; changed: boolean } {
	const opts = {
		actor,
		emailId,
		external: true,
		soft: true,
		at: item.received_at,
		detail: { kind: item.kind, subject: item.subject },
	};
	const current = getApplication(db, appId)?.status;
	if (to !== "applied" && current && PRE_APPLIED.has(current)) {
		transition(db, appId, "applied", { ...opts, note: "inferred from email" });
	}
	// interviewing <-> assessment are lateral moves: an older email processed
	// after a newer status change must not flip the status back.
	if (current && LATERAL.has(current) && LATERAL.has(to)) {
		const last = lastTransitionAt(db, appId);
		if (last && item.received_at < last)
			return { from: current, to, changed: false };
	}
	const r = transition(db, appId, to, opts);
	return current && current !== r.from ? { ...r, from: current } : r;
}

function lastTransitionAt(db: Db, appId: number): string | null {
	const row = db
		.prepare(
			"SELECT MAX(at) AS at FROM application_events WHERE application_id = ? AND kind = 'transition'",
		)
		.get(appId) as { at: string | null } | undefined;
	return row?.at ?? null;
}

const DEDUPE_WINDOW_MS = 30 * 60_000;

/**
 * Existing non-cancelled interview this email repeats: same application (or
 * company when unlinked) starting within 30 minutes, or one from the same
 * thread that has no start yet / the same start. Reminders and replies then
 * update one row instead of adding duplicates.
 */
function findExistingInterview(
	db: Db,
	item: EmailIngestItem,
	appId: number | null,
	companyId: number | null,
): { id: number; start_at: string | null } | null {
	const start = item.interview?.start;
	const t = start ? Date.parse(start) : Number.NaN;
	if (!Number.isNaN(t) && (appId || companyId)) {
		const rows = (appId
			? db
					.prepare(
						"SELECT id, start_at FROM interviews WHERE status != 'cancelled' AND start_at IS NOT NULL AND application_id = ? ORDER BY id",
					)
					.all(appId)
			: db
					.prepare(
						"SELECT id, start_at FROM interviews WHERE status != 'cancelled' AND start_at IS NOT NULL AND application_id IS NULL AND company_id = ? ORDER BY id",
					)
					.all(companyId)) as unknown as Array<{
			id: number;
			start_at: string;
		}>;
		const hit = rows.find(
			(r) => Math.abs(Date.parse(r.start_at) - t) <= DEDUPE_WINDOW_MS,
		);
		if (hit) return hit;
	}
	if (item.thread_id) {
		const rows = db
			.prepare(
				`SELECT i.id, i.start_at FROM interviews i JOIN emails e ON e.id = i.source_email_id
				  WHERE i.status != 'cancelled' AND e.thread_id = ? ORDER BY i.id`,
			)
			.all(item.thread_id) as unknown as Array<{
			id: number;
			start_at: string | null;
		}>;
		const hit = rows.find(
			(r) =>
				r.start_at === null ||
				Number.isNaN(t) ||
				Math.abs(Date.parse(r.start_at) - t) <= DEDUPE_WINDOW_MS,
		);
		if (hit) return hit;
	}
	return null;
}

export function recordInterview(
	db: Db,
	item: EmailIngestItem,
	emailId: number,
	appId: number | null,
	companyId: number | null,
): number {
	const existing = findExistingInterview(db, item, appId, companyId);
	if (existing) {
		// A follow-up that adds the time (or link) fills in a tentative row.
		if (existing.start_at === null && item.interview?.start) {
			updateInterview(db, existing.id, {
				start_at: item.interview.start,
				end_at: item.interview.end ?? undefined,
				tz: item.interview.tz ?? undefined,
				meeting_link: item.interview.link ?? undefined,
				status: "scheduled",
			});
		}
		return existing.id;
	}
	const app = appId ? getApplication(db, appId) : undefined;
	return insertInterview(db, {
		application_id: appId,
		company_id: companyId,
		company_name:
			app?.company ??
			item.company ??
			companyNameFromDomain(domainOf(item.from)),
		role: item.role ?? app?.title ?? null,
		round: item.interview?.round,
		start_at: item.interview?.start ?? null,
		end_at: item.interview?.end ?? null,
		tz: item.interview?.tz ?? null,
		meeting_link: item.interview?.link ?? null,
		status: item.interview?.start ? "scheduled" : "tentative",
		source: "email",
		source_email_id: emailId,
	});
}

function ingestOne(
	db: Db,
	item: EmailIngestItem,
	dryRun: boolean,
): IngestItemResult {
	if (findEmailByMessageId(db, item.gmail_message_id))
		return { gmail_message_id: item.gmail_message_id, duplicate: true };
	const link = resolveLink(db, item);
	const current = link.applicationId
		? (getApplication(db, link.applicationId)?.status ?? null)
		: null;
	const effect = effectFor(item.kind, current, item.confidence);
	const base: IngestItemResult = {
		gmail_message_id: item.gmail_message_id,
		duplicate: false,
		via: link.via,
		application_id: link.applicationId,
		from_status: current,
	};
	if (dryRun) return { ...base, planned: effect };

	let { applicationId, companyId } = link;
	let created = false;
	if (effect.createApplication && !applicationId) {
		const made = createExternalApplication(db, item);
		if (made) {
			({ applicationId, companyId } = made);
			created = true;
		}
	}
	const emailId = insertEmail(db, {
		gmail_message_id: item.gmail_message_id,
		thread_id: item.thread_id,
		received_at: item.received_at,
		from_addr: item.from,
		from_domain: domainOf(item.from),
		subject: item.subject,
		snippet: item.snippet,
		kind: item.kind,
		confidence: item.confidence,
		application_id: applicationId,
		company_id: companyId,
		extracted: {
			company: item.company,
			role: item.role,
			interview: item.interview,
			assessment: item.assessment,
			via: link.via,
		},
	});
	const out: IngestItemResult = {
		...base,
		email_id: emailId,
		application_id: applicationId,
		created_application: created,
	};
	if (applicationId) {
		insertEvent(db, {
			application_id: applicationId,
			kind: "email",
			actor: INGEST_ACTOR,
			email_id: emailId,
			detail: { kind: item.kind, subject: item.subject },
			at: item.received_at,
		});
		if (effect.to) {
			const t = applyTransitions(db, applicationId, effect.to, emailId, item);
			out.to_status = t.to;
			out.changed = t.changed || created;
		}
	}
	if (effect.createInterview)
		out.interview_id = recordInterview(
			db,
			item,
			emailId,
			applicationId,
			companyId,
		);
	return out;
}

export function ingestEmails(
	db: Db,
	items: EmailIngestItem[],
	o: { dryRun?: boolean } = {},
): IngestResult {
	const res: IngestResult = { ingested: 0, duplicates: 0, items: [] };
	// Chronological order: Gmail lists newest first, and soft transitions
	// must reflect when things happened, not processing order.
	const ordered = [...items].sort((a, b) =>
		a.received_at < b.received_at ? -1 : a.received_at > b.received_at ? 1 : 0,
	);
	for (const item of ordered) {
		const r = o.dryRun
			? ingestOne(db, item, true)
			: tx(db, () => ingestOne(db, item, false));
		if (r.duplicate) res.duplicates++;
		else res.ingested++;
		res.items.push(r);
	}
	if (!o.dryRun && res.ingested > 0) {
		audit({
			actor: INGEST_ACTOR,
			action: "email.ingest",
			detail: { ingested: res.ingested, duplicates: res.duplicates },
		});
	}
	return res;
}

/** Rebuild the ingest view of a stored email (for manual linking). */
export function itemFromEmailRow(e: EmailRow): EmailIngestItem {
	let x: Partial<EmailIngestItem> = {};
	try {
		x = e.extracted_json ? JSON.parse(e.extracted_json) : {};
	} catch {
		x = {};
	}
	return {
		gmail_message_id: e.gmail_message_id,
		thread_id: e.thread_id,
		received_at: e.received_at,
		from: e.from_addr,
		subject: e.subject,
		snippet: e.snippet ?? undefined,
		kind: e.kind,
		confidence: e.confidence,
		company: x.company,
		role: x.role,
		interview: x.interview,
		assessment: x.assessment,
	} as EmailIngestItem;
}
