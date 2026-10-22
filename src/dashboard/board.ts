/**
 * Dashboard job board (kanban): read model, Applied date filter, outcome
 * actions and "Add a job link". Routes are exported as BOARD_ROUTES and
 * appended to api.ts ROUTES; HTTP plumbing stays in server.ts.
 *
 * Columns (see columnFor):
 *   backlog       discovered, or shortlisted with no running resume run
 *   creating      shortlisted with a running resume run
 *   needs_you     held (ADR-005): waiting on the user (login, hard fact, consent); shows hold_reason
 *   ready         tailored (finalized ok, or below_bar without a finalize-hold)
 *   applying      tailored with <artifacts>/<id>/answers.json (submitter filled the form)
 *   applied       applied, assessment   (date-filtered by applied_at, local time)
 *   interviewing  interviewing, offer   (sub-stage badge)
 *   skipped       dismissed, withdrawn, tailored + finalize-hold (collapsed)
 *   closed        rejected, ghosted, accepted, declined (collapsed)
 */
import { createHash } from "node:crypto";
import {
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { audit } from "../core/audit.js";
import { NotFoundError } from "../core/errors.js";
import { artifactsDir } from "../core/paths.js";
import { type AppStatus, transition } from "../core/state.js";
import {
	applicationIdByUrl,
	applicationIdForJob,
	type BoardRow,
	boardRows,
} from "../db/board.js";
import { type Db, tx } from "../db/index.js";
import {
	createApplication,
	getApplication,
	insertEvent,
	insertJob,
	setUserRequested,
	timezone,
	upsertCompany,
} from "../db/repo.js";
import { insertInterview } from "../db/tracking.js";
import { isInside } from "../tracking/interviews.js";
import {
	addDaysKey,
	isDateKey,
	isValidTimeZone,
	localDateKey,
	startOfLocalDay,
} from "../tracking/time.js";
import type { ApiDeps, ApiRequest, ApiResponse, Route } from "./api.js";
import { csrfFailure, issueCsrf } from "./csrf.js";
import {
	AddLinkBody,
	companyFromHost,
	type EnrichDeps,
	enrichJobLink,
	LinkError,
	titleFromPath,
	validateJobUrl,
} from "./joblink.js";

// ------------------------------------------------------------ columns

export const COLUMNS = [
	{ id: "backlog", label: "Backlog" },
	{ id: "creating", label: "Creating resume" },
	{ id: "needs_you", label: "Needs you" },
	{ id: "ready", label: "Ready to apply" },
	{ id: "applying", label: "Applying" },
	{ id: "applied", label: "Applied" },
	{ id: "interviewing", label: "Interviewing" },
	{ id: "skipped", label: "Skipped" },
	{ id: "closed", label: "Closed" },
] as const;
export type ColumnId = (typeof COLUMNS)[number]["id"];

export interface ColumnInput {
	status: AppStatus;
	run_status: string | null;
	held: boolean | number;
	hasAnswers: boolean;
}

/** Map an application to its board column. Pure. */
export function columnFor(r: ColumnInput): ColumnId {
	switch (r.status) {
		case "discovered":
			return "backlog";
		case "shortlisted":
			return r.run_status === "running" ? "creating" : "backlog";
		case "held":
			return "needs_you";
		case "tailored":
			if (r.held) return "skipped";
			return r.hasAnswers ? "applying" : "ready";
		case "applied":
		case "assessment":
			return "applied";
		case "interviewing":
		case "offer":
			return "interviewing";
		case "dismissed":
		case "withdrawn":
			return "skipped";
		default:
			return "closed";
	}
}

// ------------------------------------------------------------ applied date filter

export const RANGE_PRESETS = [
	"today",
	"yesterday",
	"7d",
	"30d",
	"all",
	"custom",
] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];

export interface AppliedRange {
	preset: RangePreset;
	/** Inclusive start (UTC ISO), or null for no lower bound. */
	from: string | null;
	/** Exclusive end (UTC ISO), or null for no upper bound. */
	to: string | null;
}

function validKey(s: string | null | undefined): s is string {
	if (!s || !isDateKey(s)) return false;
	const t = Date.parse(`${s}T00:00:00Z`);
	return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

/**
 * Local-day bounds for a preset in time zone `tz`. "today" is
 * [local midnight, next local midnight); "7d" and "30d" include today.
 * "custom" takes inclusive YYYY-MM-DD keys (swapped if reversed); an invalid
 * custom range falls back to today.
 */
export function appliedRange(
	preset: RangePreset,
	now: Date,
	tz: string,
	custom: { from?: string | null; to?: string | null } = {},
): AppliedRange {
	const today = localDateKey(now, tz);
	const span = (fromKey: string, toKeyInclusive: string): AppliedRange => ({
		preset,
		from: startOfLocalDay(fromKey, tz).toISOString(),
		to: startOfLocalDay(addDaysKey(toKeyInclusive, 1), tz).toISOString(),
	});
	switch (preset) {
		case "all":
			return { preset, from: null, to: null };
		case "yesterday": {
			const y = addDaysKey(today, -1);
			return span(y, y);
		}
		case "7d":
			return span(addDaysKey(today, -6), today);
		case "30d":
			return span(addDaysKey(today, -29), today);
		case "custom": {
			const a = custom.from;
			const b = custom.to;
			if (validKey(a) && validKey(b)) return a <= b ? span(a, b) : span(b, a);
			if (validKey(a)) return { ...span(a, a), to: null };
			if (validKey(b)) return { ...span(b, b), from: null };
			return { ...span(today, today), preset: "today" };
		}
		default:
			return span(today, today);
	}
}

export function inRange(iso: string | null, r: AppliedRange): boolean {
	if (r.from === null && r.to === null) return true;
	if (!iso) return false;
	const t = Date.parse(iso);
	if (!Number.isFinite(t)) return false;
	if (r.from !== null && t < Date.parse(r.from)) return false;
	if (r.to !== null && t >= Date.parse(r.to)) return false;
	return true;
}

// ------------------------------------------------------------ artifacts

/** Safe PDF file name inside artifacts/<id>/ (no separators, no "..", no leading dot). */
const SAFE_PDF = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,150}\.pdf$/i;

export function isSafePdfName(name: string): boolean {
	return SAFE_PDF.test(name) && !name.includes("..");
}

/** Newest resume PDF in artifacts/<id>/ (name mentions "resume", not "cover"). */
export function resumePdfName(appId: number): string | null {
	const dir = artifactsDir(appId);
	if (!existsSync(dir)) return null;
	let best: { name: string; mtime: number } | null = null;
	for (const name of readdirSync(dir)) {
		if (!isSafePdfName(name) || !/resume/i.test(name) || /cover/i.test(name))
			continue;
		try {
			const st = statSync(join(dir, name));
			if (!st.isFile()) continue;
			if (!best || st.mtimeMs > best.mtime) best = { name, mtime: st.mtimeMs };
		} catch {
			// vanished between readdir and stat
		}
	}
	return best?.name ?? null;
}

/** answers.json status written by application-submitter, or null when absent. */
function answersStatus(appId: number): string | null {
	const file = join(artifactsDir(appId), "answers.json");
	if (!existsSync(file)) return null;
	try {
		if (statSync(file).size > 256_000) return "present";
		const j = JSON.parse(readFileSync(file, "utf8")) as { status?: unknown };
		return typeof j.status === "string" ? j.status.slice(0, 60) : "present";
	} catch {
		return "present";
	}
}

/** Read a PDF from artifacts/<appId>/ by name. Throws NotFoundError; null when it escapes the dir. */
export function readArtifactPdf(appId: number, rawName: string): Buffer | null {
	let name: string;
	try {
		name = decodeURIComponent(rawName);
	} catch {
		throw new NotFoundError("file not found");
	}
	if (!isSafePdfName(name)) throw new NotFoundError("file not found");
	const dir = artifactsDir(appId);
	const full = join(dir, name);
	if (!existsSync(dir) || !existsSync(full))
		throw new NotFoundError("file not found");
	const real = realpathSync(full);
	if (!isInside(realpathSync(dir), real)) return null;
	if (!statSync(real).isFile()) throw new NotFoundError("file not found");
	return readFileSync(real);
}

// ------------------------------------------------------------ read model

export interface BoardCard {
	id: number;
	column: ColumnId;
	status: AppStatus;
	company: string;
	title: string;
	location: string | null;
	postedAt: string | null;
	appliedAt: string | null;
	lastEventAt: string;
	atsScore: number | null;
	hmVerdict: string | null;
	quality: string | null;
	youAsked: boolean;
	requestNote: string | null;
	postingUrl: string | null;
	resumeUrl: string | null;
	stage: string | null;
	reason: string | null;
	answers: string | null;
}

export interface BoardColumn {
	id: ColumnId;
	label: string;
	/** Cards shown (Applied: inside the date range). */
	count: number;
	/** All cards in the column, ignoring the date filter. */
	total: number;
	cards: BoardCard[];
}

export interface Board {
	generatedAt: string;
	tz: string;
	range: AppliedRange;
	columns: BoardColumn[];
}

const MAX_CARDS_PER_COLUMN = 300;

/** Only http(s) links reach the page. */
export function safeHttpUrl(u: string | null): string | null {
	if (!u) return null;
	try {
		const p = new URL(u);
		return p.protocol === "http:" || p.protocol === "https:"
			? p.toString()
			: null;
	} catch {
		return null;
	}
}

function reasonOf(detailJson: string | null): string | null {
	if (!detailJson) return null;
	try {
		const d = JSON.parse(detailJson) as Record<string, unknown>;
		for (const k of ["note", "reason", "decision"]) {
			const v = d?.[k];
			if (typeof v === "string" && v.trim()) return v.trim().slice(0, 200);
		}
	} catch {
		// not JSON
	}
	return null;
}

const STAGE_LABEL: Record<string, string> = {
	recruiter_screen: "Recruiter screen",
	hiring_manager: "Hiring manager",
	technical: "Technical",
	assessment: "Assessment",
	onsite: "Onsite/Final",
	final: "Onsite/Final",
	other: "Interview",
};

function stageOf(r: BoardRow): string | null {
	if (r.status === "offer") return "Offer";
	if (r.status === "assessment") return "Assessment";
	if (r.status === "interviewing")
		return r.interview_round
			? (STAGE_LABEL[r.interview_round] ?? "Interview")
			: "Interview";
	if (r.status === "ghosted" || r.status === "rejected") return r.status;
	return null;
}

function toCard(r: BoardRow): BoardCard {
	const pre = r.status === "tailored";
	const answers = pre ? answersStatus(r.id) : null;
	const column = columnFor({
		status: r.status,
		run_status: r.run_status,
		held: r.held,
		hasAnswers: answers !== null,
	});
	const hasResume = !["discovered", "shortlisted", "dismissed"].includes(
		r.status,
	);
	const pdf = hasResume ? resumePdfName(r.id) : null;
	return {
		id: r.id,
		column,
		status: r.status,
		company: r.company,
		title: r.title,
		location: r.location,
		postedAt: r.posted_at,
		appliedAt: r.applied_at,
		lastEventAt: r.last_event_at,
		atsScore: r.ats_score,
		hmVerdict: r.hm_verdict,
		quality: r.quality,
		youAsked: r.requested_by === "user",
		requestNote: r.request_note,
		postingUrl: safeHttpUrl(r.url),
		resumeUrl: pdf
			? `/api/board/${r.id}/files/${encodeURIComponent(pdf)}`
			: null,
		stage: stageOf(r),
		reason:
			column === "skipped"
				? reasonOf(r.last_detail)
				: column === "needs_you"
					? r.hold_reason?.trim().slice(0, 200) || reasonOf(r.last_detail)
					: null,
		answers,
	};
}

export function buildBoard(
	db: Db,
	o: { range: AppliedRange; tz: string; now: Date },
): Board {
	const byCol = new Map<ColumnId, BoardCard[]>(COLUMNS.map((c) => [c.id, []]));
	for (const r of boardRows(db)) {
		const card = toCard(r);
		byCol.get(card.column)?.push(card);
	}
	const columns = COLUMNS.map((c) => {
		const all = byCol.get(c.id) ?? [];
		const shown =
			c.id === "applied"
				? all.filter((x) => inRange(x.appliedAt ?? x.lastEventAt, o.range))
				: all;
		return {
			id: c.id,
			label: c.label,
			count: shown.length,
			total: all.length,
			cards: shown.slice(0, MAX_CARDS_PER_COLUMN),
		};
	});
	return {
		generatedAt: o.now.toISOString(),
		tz: o.tz,
		range: o.range,
		columns,
	};
}

// ------------------------------------------------------------ outcome actions

export const OUTCOMES = {
	recruiter_screen: { stage: "recruiter_screen" },
	technical: { stage: "technical" },
	onsite: { stage: "onsite" },
	offer: { to: "offer" },
	rejected: { to: "rejected" },
	ghosted: { to: "ghosted" },
	withdrawn: { to: "withdrawn" },
} as const satisfies Record<
	string,
	{ stage: "recruiter_screen" | "technical" | "onsite" } | { to: AppStatus }
>;
export type Outcome = keyof typeof OUTCOMES;

export const OutcomeBody = z.object({
	action: z.enum(Object.keys(OUTCOMES) as [Outcome, ...Outcome[]]),
	note: z.string().trim().max(500).optional(),
	date: z.string().refine(validKey, "date must be YYYY-MM-DD").optional(),
});
export type OutcomeBody = z.infer<typeof OutcomeBody>;

export interface OutcomeResult {
	id: number;
	from: AppStatus;
	to: AppStatus;
	changed: boolean;
	interviewId?: number;
}

/**
 * Record an outcome as the user. Status changes go through core/state
 * transition() (same path as `jh app transition`, actor "user", audit logged);
 * an illegal move throws IllegalTransitionError (HTTP 409). Interview stages
 * also add a manual interviews row and an 'interview' event.
 */
export function applyOutcome(
	db: Db,
	appId: number,
	raw: unknown,
	now: Date = new Date(),
	tz?: string,
): OutcomeResult {
	const b = OutcomeBody.parse(raw);
	const app = getApplication(db, appId);
	if (!app) throw new NotFoundError(`application ${appId} not found`);
	const spec = OUTCOMES[b.action];
	const note = b.note || undefined;
	const extra = b.date ? { date: b.date } : undefined;
	if ("to" in spec) {
		const r = transition(db, appId, spec.to, {
			actor: "user",
			note,
			detail: extra,
		});
		return { id: appId, ...r };
	}
	const stage = spec.stage;
	const out = tx(db, () => {
		const r =
			app.status === "interviewing"
				? { from: app.status, to: app.status, changed: false }
				: transition(db, appId, "interviewing", {
						actor: "user",
						note,
						detail: { stage, ...extra },
					});
		const today = localDateKey(now, tz ?? timezone(db));
		const interviewId = insertInterview(db, {
			application_id: appId,
			company_id: app.company_id,
			company_name: app.company,
			role: app.title,
			round: stage,
			status: b.date && b.date < today ? "done" : "scheduled",
			source: "manual",
		});
		insertEvent(db, {
			application_id: appId,
			kind: "interview",
			actor: "user",
			detail: { stage, interview_id: interviewId, ...extra, note },
		});
		return { id: appId, ...r, interviewId };
	});
	audit({
		actor: "user",
		action: "app.stage",
		target: `application:${appId}`,
		detail: { stage, interviewId: out.interviewId, date: b.date },
	});
	return out;
}

// ------------------------------------------------------------ add a job link

export interface AddLinkResult {
	created: boolean;
	id: number;
	company: string;
	title: string;
	enriched: boolean;
}

function untitled(url: string): string {
	return `Untitled posting ${createHash("sha1").update(url).digest("hex").slice(0, 6)}`;
}

/** Mark an existing application "You asked", nudging discovered -> shortlisted. */
function markExisting(db: Db, id: number, note?: string): AddLinkResult {
	const app = getApplication(db, id);
	if (!app) throw new NotFoundError(`application ${id} not found`);
	setUserRequested(db, id, note);
	if (app.status === "discovered")
		transition(db, id, "shortlisted", {
			actor: "user",
			soft: true,
			detail: { requested_by: "user" },
		});
	insertEvent(db, {
		application_id: id,
		kind: "note",
		actor: "user",
		detail: { requested_by: "user", ...(note ? { note } : {}) },
	});
	return {
		created: false,
		id,
		company: app.company,
		title: app.title,
		enriched: false,
	};
}

/**
 * Validate a pasted job URL, enrich it when it is a Greenhouse/Ashby/Lever
 * posting, and create a shortlisted application marked requested_by='user'
 * ("You asked"). Source stays 'conscience' (the DB's source CHECK has no
 * 'user'), so the fact-check gate still applies when agents apply.
 */
export async function addJobLink(
	db: Db,
	raw: unknown,
	deps: EnrichDeps = {},
): Promise<AddLinkResult> {
	const b = AddLinkBody.parse(raw);
	const u = validateJobUrl(b.url);
	const url = u.toString();
	const note = b.note || undefined;
	const known = applicationIdByUrl(db, url);
	if (known !== undefined) {
		const r = tx(db, () => markExisting(db, known, note));
		audit({
			actor: "user",
			action: "app.request",
			target: `application:${r.id}`,
			detail: { created: false, host: u.hostname },
		});
		return r;
	}
	const e = await enrichJobLink(u, deps);
	const company = e.company ?? companyFromHost(u);
	const title = e.title ?? titleFromPath(u) ?? untitled(url);
	const result = tx(db, () => {
		const c = upsertCompany(db, {
			name: company,
			domain: e.ats ? undefined : companyFromHost(u),
		});
		const job = insertJob(db, {
			company_id: c.id,
			title,
			url,
			location: e.location,
			posted_at: e.posted_at,
		});
		// A deduplicated job may already have an application: mark that one.
		const prior = applicationIdForJob(db, job.id);
		if (prior !== undefined) return markExisting(db, prior, note);
		const app = createApplication(db, {
			job_id: job.id,
			status: "shortlisted",
			source: "conscience",
		});
		setUserRequested(db, app.id, note);
		insertEvent(db, {
			application_id: app.id,
			kind: "transition",
			to_status: "shortlisted",
			actor: "user",
			detail: {
				created: true,
				source: "user",
				requested_by: "user",
				...(note ? { note } : {}),
			},
			at: app.created_at,
		});
		return {
			created: true,
			id: app.id,
			company: c.name,
			title: job.title,
			enriched: Boolean(e.title),
		};
	});
	audit({
		actor: "user",
		action: "app.request",
		target: `application:${result.id}`,
		detail: {
			created: result.created,
			host: u.hostname,
			enriched: result.enriched,
		},
	});
	return result;
}

// ------------------------------------------------------------ HTTP handlers

type BoardReq = ApiRequest;
type Handler = (
	req: BoardReq,
	deps: ApiDeps & { enrich?: EnrichDeps },
) => ApiResponse | Promise<ApiResponse>;

const forbidden = (error: string, message: string): ApiResponse => ({
	status: 403,
	json: { error, message },
});

function idOf(req: ApiRequest): number {
	const n = Number(req.params[0]);
	if (!Number.isSafeInteger(n) || n <= 0) throw new NotFoundError("bad id");
	return n;
}

/** CSRF + read-only gate for board POSTs; null when allowed. */
function guardPost(req: BoardReq): ApiResponse | null {
	if (req.client?.readOnly)
		return forbidden("read_only", "dashboard is read-only on LAN");
	const why = csrfFailure(req.headers ?? {});
	if (why === "cross_origin")
		return forbidden("cross_origin", "cross-origin request refused");
	if (why) return forbidden("csrf", "missing or invalid CSRF token");
	return null;
}

function tzOf(req: ApiRequest, db: Db): string {
	const t = req.query.get("tz");
	return t && t.length <= 64 && isValidTimeZone(t) ? t : timezone(db);
}

function presetOf(raw: string | null): RangePreset {
	return (RANGE_PRESETS as readonly string[]).includes(raw ?? "")
		? (raw as RangePreset)
		: "today";
}

const getBoard: Handler = (req, d) => {
	const now = d.now ? d.now() : new Date();
	const tz = tzOf(req, d.db);
	const range = appliedRange(presetOf(req.query.get("range")), now, tz, {
		from: req.query.get("from"),
		to: req.query.get("to"),
	});
	const csrf = issueCsrf(req.headers ?? {});
	return {
		status: 200,
		json: {
			...buildBoard(d.db, { range, tz, now }),
			csrf: csrf.token,
			readOnly: Boolean(req.client?.readOnly),
		},
		headers: csrf.setCookie ? { "Set-Cookie": csrf.setCookie } : undefined,
	};
};

const postOutcome: Handler = (req, d) => {
	const denied = guardPost(req);
	if (denied) return denied;
	const now = d.now ? d.now() : new Date();
	return {
		status: 200,
		json: applyOutcome(d.db, idOf(req), req.body ?? {}, now),
	};
};

const postLink: Handler = async (req, d) => {
	const denied = guardPost(req);
	if (denied) return denied;
	try {
		const r = await addJobLink(d.db, req.body ?? {}, d.enrich);
		return { status: r.created ? 201 : 200, json: r };
	} catch (e) {
		if (e instanceof LinkError)
			return { status: 400, json: { error: e.code, message: e.message } };
		throw e;
	}
};

const getFile: Handler = (req) => {
	const id = idOf(req);
	const name = req.params[1] ?? "";
	const buf = readArtifactPdf(id, name);
	if (!buf)
		return forbidden("forbidden", "artifact path outside the artifacts dir");
	const safe = decodeURIComponent(name);
	return {
		status: 200,
		body: buf,
		contentType: "application/pdf",
		headers: { "Content-Disposition": `inline; filename="${safe}"` },
	};
};

export const BOARD_ROUTES: readonly Route[] = [
	{
		method: "GET",
		pattern: /^\/api\/board$/,
		handler: getBoard as Route["handler"],
	},
	{
		method: "GET",
		pattern: /^\/api\/board\/(\d+)\/files\/([^/]{1,400})$/,
		handler: getFile as Route["handler"],
	},
	{
		method: "POST",
		pattern: /^\/api\/board\/(\d+)\/outcome$/,
		handler: postOutcome as Route["handler"],
	},
	{
		method: "POST",
		pattern: /^\/api\/board\/links$/,
		handler: postLink as Route["handler"],
	},
];
