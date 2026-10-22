import type { Db } from "../db/index.js";
import { nowIso, tx } from "../db/index.js";
import { setHoldReason } from "../db/policy.js";
import {
	getApplication,
	insertEvent,
	listApplications,
	updateApplicationStatus,
} from "../db/repo.js";
import { audit } from "./audit.js";
import {
	IllegalTransitionError,
	NotFoundError,
	ValidationError,
} from "./errors.js";

export const APP_STATUSES = [
	"discovered",
	"shortlisted",
	"dismissed",
	"tailored",
	"applied",
	"assessment",
	"interviewing",
	"offer",
	"accepted",
	"declined",
	"rejected",
	"ghosted",
	"withdrawn",
	"held",
] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

export const APP_SOURCES = ["conscience", "external", "email"] as const;
export type AppSource = (typeof APP_SOURCES)[number];

export const TERMINAL: ReadonlySet<AppStatus> = new Set<AppStatus>([
	"dismissed",
	"rejected",
	"accepted",
	"declined",
	"withdrawn",
]);

export const ACTIVE: ReadonlySet<AppStatus> = new Set<AppStatus>([
	"shortlisted",
	"tailored",
	"held",
	"applied",
	"assessment",
	"interviewing",
	"offer",
]);

/** Statuses that imply the application was submitted. */
export const SUBMITTED: ReadonlySet<AppStatus> = new Set<AppStatus>([
	"applied",
	"assessment",
	"interviewing",
	"offer",
	"accepted",
	"declined",
	"rejected",
	"ghosted",
]);

export function isAppStatus(s: string): s is AppStatus {
	return (APP_STATUSES as readonly string[]).includes(s);
}

/** Ungated edges. tailored->applied and pre-tailor ->applied are gated (see canTransition). */
const EDGES: Readonly<Record<AppStatus, readonly AppStatus[]>> = {
	discovered: ["shortlisted", "dismissed", "held"],
	shortlisted: ["tailored", "dismissed", "held"],
	dismissed: [],
	tailored: ["held"],
	// held (ADR-005): waiting on an escalation or a blocked form; released back
	// to shortlisted or tailored once answered, or dismissed.
	held: ["shortlisted", "tailored", "dismissed"],
	applied: ["assessment", "interviewing", "rejected", "ghosted"],
	assessment: ["interviewing", "offer", "rejected", "ghosted"],
	interviewing: ["assessment", "offer", "rejected", "ghosted"],
	offer: ["accepted", "declined"],
	accepted: [],
	declined: [],
	rejected: [],
	ghosted: ["assessment", "interviewing", "rejected"],
	withdrawn: [],
};

export interface TransitionCtx {
	external?: boolean;
	factcheckPassed?: boolean;
}

function canApply(from: AppStatus, ctx: TransitionCtx): boolean {
	if (from === "tailored") return Boolean(ctx.factcheckPassed || ctx.external);
	if (from === "discovered" || from === "shortlisted" || from === "held")
		return Boolean(ctx.external);
	return false;
}

/** Whether from->to is a legal edge. `external` satisfies the factcheck gate. */
export function canTransition(
	from: AppStatus,
	to: AppStatus,
	ctx: TransitionCtx = {},
): boolean {
	if (from === to) return false;
	if (to === "withdrawn") return !TERMINAL.has(from);
	if (to === "applied") return canApply(from, ctx);
	return EDGES[from].includes(to);
}

/** Pipeline rank. Equal ranks (assessment/interviewing/ghosted: in process, maybe silent) count as forward. */
const RANK: Readonly<Record<AppStatus, number>> = {
	discovered: 0,
	shortlisted: 1,
	tailored: 2,
	held: 2,
	applied: 3,
	ghosted: 4,
	assessment: 4,
	interviewing: 4,
	offer: 5,
	accepted: 6,
	declined: 6,
	rejected: 6,
	dismissed: 6,
	withdrawn: 6,
};

/** True when `to` is not behind `from` in the pipeline (used by soft moves). */
export function isForward(from: AppStatus, to: AppStatus): boolean {
	return from !== to && RANK[to] >= RANK[from];
}

export interface TransitionOpts {
	actor: string;
	/** Why the application is held (required for -> held; defaults to note). */
	holdReason?: string;
	note?: string;
	emailId?: number;
	external?: boolean;
	factcheckPassed?: boolean;
	soft?: boolean;
	detail?: unknown;
	/** Event time; defaults to now. */
	at?: string;
}

export interface TransitionResult {
	from: AppStatus;
	to: AppStatus;
	changed: boolean;
}

function refusalReason(from: AppStatus, to: AppStatus): string {
	if (to === "applied" && from === "tailored")
		return "tailored -> applied needs a passing fact-check (factcheck.json verdict 'pass') or an external application";
	if (
		to === "applied" &&
		(from === "discovered" || from === "shortlisted" || from === "held")
	)
		return `${from} -> applied is only allowed for applications made outside conscience (--external)`;
	if (TERMINAL.has(from)) return `${from} is terminal`;
	return `no edge ${from} -> ${to}`;
}

function eventDetail(opts: TransitionOpts): unknown {
	if (opts.note === undefined) return opts.detail;
	if (opts.detail === undefined) return { note: opts.note };
	if (
		typeof opts.detail === "object" &&
		opts.detail !== null &&
		!Array.isArray(opts.detail)
	)
		return { note: opts.note, ...opts.detail };
	return { note: opts.note, detail: opts.detail };
}

/**
 * Move an application to `to`, writing an application_events row and an audit line.
 * soft: an illegal or backward move returns {changed:false} instead of throwing.
 * Same-status moves are a no-op in both modes.
 */
export function transition(
	db: Db,
	appId: number,
	to: AppStatus,
	opts: TransitionOpts,
): TransitionResult {
	const result = tx(db, () => {
		const app = getApplication(db, appId);
		if (!app)
			throw new NotFoundError(`application ${appId} not found`, { appId });
		const from = app.status;
		if (from === to) return { from, to, changed: false };
		const ctx: TransitionCtx = {
			external: Boolean(opts.external || app.source !== "conscience"),
			factcheckPassed: opts.factcheckPassed,
		};
		const legal = canTransition(from, to, ctx);
		if (opts.soft && !(legal && isForward(from, to)))
			return { from, to, changed: false };
		if (!legal) {
			throw new IllegalTransitionError(
				`illegal transition ${from} -> ${to}: ${refusalReason(from, to)}`,
				{
					appId,
					from,
					to,
				},
			);
		}
		const holdReason = (opts.holdReason ?? opts.note)?.trim();
		if (to === "held" && !holdReason)
			throw new ValidationError(
				"moving to held needs a reason (--note)",
				{ appId },
				"hold_reason_required",
			);
		const at = opts.at ?? nowIso();
		updateApplicationStatus(db, appId, to, at);
		if (to === "held") setHoldReason(db, appId, holdReason ?? null);
		else if (from === "held") setHoldReason(db, appId, null);
		insertEvent(db, {
			application_id: appId,
			kind: "transition",
			from_status: from,
			to_status: to,
			actor: opts.actor,
			email_id: opts.emailId,
			detail: eventDetail(opts),
			at,
		});
		return { from, to, changed: true };
	});
	if (result.changed) {
		audit({
			actor: opts.actor,
			action: "app.transition",
			target: `application:${appId}`,
			detail: {
				from: result.from,
				to: result.to,
				note: opts.note,
				emailId: opts.emailId,
			},
		});
	}
	return result;
}

const DAY_MS = 86_400_000;

/** applied|assessment applications with no event for `days` (default 21) -> ghosted. Returns moved ids. */
export function ghostSweep(
	db: Db,
	o: { days?: number; now?: Date } = {},
): number[] {
	const days = o.days ?? 21;
	const now = o.now ?? new Date();
	const cutoff = new Date(now.getTime() - days * DAY_MS).toISOString();
	const stale = listApplications(db, {
		status: ["applied", "assessment"],
	}).filter((a) => a.last_event_at <= cutoff);
	const moved: number[] = [];
	for (const app of stale) {
		const r = transition(db, app.id, "ghosted", {
			actor: "ghost-sweep",
			soft: true,
			detail: { days, last_event_at: app.last_event_at },
			at: now.toISOString(),
		});
		if (r.changed) moved.push(app.id);
	}
	return moved;
}
