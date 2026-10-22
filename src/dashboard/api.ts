/**
 * Dashboard API handlers. Pure request -> response objects; HTTP plumbing and
 * security checks live in server.ts.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import type { IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { NotFoundError } from "../core/errors.js";
import { artifactsDir } from "../core/paths.js";
import type { AppStatus } from "../core/state.js";
import type { Db } from "../db/index.js";
import { getBlock, getInterview, updateBlock } from "../db/tracking.js";
import { jdCompareForApp } from "../jd/compare.js";
import type { LearnSummary } from "../learn/index.js";
import { decideMetric } from "../me/metrics.js";
import { isInside } from "../tracking/interviews.js";
import {
	ClockInBody,
	ClockOutBody,
	MetricDecisionBody,
	StudyBlockPatch,
	StudyTaskBody,
} from "../tracking/schemas.js";
import {
	addStudyTask,
	clockIn,
	clockOut,
	finishStudyTask,
	studySummary,
} from "../tracking/study.js";
import {
	applicationsView,
	buildSummary,
	DEFAULT_APP_STATUSES,
	upcomingInterviews,
} from "../tracking/summary.js";
import { BOARD_ROUTES } from "./board.js";

export interface ApiRequest {
	method: string;
	path: string;
	query: URLSearchParams;
	params: string[];
	body: unknown;
	/** Request headers (board CSRF checks). Set by server.ts. */
	headers?: IncomingHttpHeaders;
	/** Who is calling: a non-loopback LAN client, and whether it is read-only. */
	client?: { remote: boolean; readOnly: boolean };
}

export interface ApiResponse {
	status: number;
	json?: unknown;
	body?: Buffer | string;
	contentType?: string;
	headers?: Record<string, string>;
}

export interface ApiDeps {
	db: Db;
	learn?: (db: Db) => LearnSummary;
	now?: () => Date;
}

type Handler = (
	req: ApiRequest,
	deps: ApiDeps,
) => ApiResponse | Promise<ApiResponse>;

export interface Route {
	method: "GET" | "POST";
	pattern: RegExp;
	handler: Handler;
}

const ok = (json: unknown, status = 200): ApiResponse => ({ status, json });
const nowOf = (d: ApiDeps): Date => (d.now ? d.now() : new Date());

const ALL_STATUSES: ReadonlySet<string> = new Set([
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
]);

export function parseStatuses(raw: string | null): AppStatus[] {
	if (!raw) return DEFAULT_APP_STATUSES;
	const list = raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => ALL_STATUSES.has(s)) as AppStatus[];
	return list.length ? list : DEFAULT_APP_STATUSES;
}

export function clampInt(
	raw: string | null,
	fallback: number,
	min: number,
	max: number,
): number {
	const n = raw === null ? Number.NaN : Number.parseInt(raw, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(max, Math.max(min, n));
}

function idParam(req: ApiRequest, i = 0): number {
	const n = Number(req.params[i]);
	if (!Number.isSafeInteger(n) || n <= 0) throw new NotFoundError("bad id");
	return n;
}

// ------------------------------------------------------------ handlers

const getSummary: Handler = (_r, d) => ok(buildSummary(d.db, nowOf(d)));

const getApplications: Handler = (r, d) =>
	ok(
		applicationsView(
			d.db,
			parseStatuses(r.query.get("status")),
			clampInt(r.query.get("limit"), 100, 1, 500),
			nowOf(d),
		),
	);

/** Resume vs JD: the finalized resume of one application against its JD snapshot. */
const getCompare: Handler = (r, d) => ok(jdCompareForApp(d.db, idParam(r)));

const getInterviews: Handler = (r, d) =>
	ok(
		upcomingInterviews(
			d.db,
			nowOf(d),
			clampInt(r.query.get("days"), 14, 1, 120),
		),
	);

const getStudy: Handler = (_r, d) => ok(studySummary(d.db, nowOf(d)));

const postClockIn: Handler = (r, d) => {
	const b = ClockInBody.parse(r.body ?? {});
	return ok(
		clockIn(d.db, { topic: b.topic, source: "dashboard" }, nowOf(d)),
		201,
	);
};

const postClockOut: Handler = (r, d) => {
	const b = ClockOutBody.parse(r.body ?? {});
	return ok(clockOut(d.db, { notes: b.notes }, nowOf(d)));
};

const postTask: Handler = (r, d) =>
	ok(addStudyTask(d.db, StudyTaskBody.parse(r.body ?? {})), 201);

const postTaskDone: Handler = (r, d) =>
	ok(finishStudyTask(d.db, idParam(r), nowOf(d)));

const postBlock: Handler = (r, d) => {
	const id = idParam(r);
	const existing = getBlock(d.db, id);
	if (!existing) throw new NotFoundError(`study block ${id} not found`);
	const p = StudyBlockPatch.parse(r.body ?? {});
	const start = p.start ?? existing.start_local;
	const end = p.end ?? existing.end_local;
	if (start >= end)
		return ok(
			{ error: "validation", message: "start must be before end" },
			400,
		);
	updateBlock(d.db, id, p);
	return ok(getBlock(d.db, id));
};

const postMetric: Handler = (r) => {
	const b = MetricDecisionBody.parse(r.body ?? {});
	const id = decodeURIComponent(r.params[0] ?? "");
	return ok(decideMetric(id, b));
};

const getLearn: Handler = (_r, d) =>
	d.learn
		? ok(d.learn(d.db))
		: ok({ error: "not_available", message: "learning is not enabled" }, 404);

/** Prep markdown, only when the stored path resolves inside artifactsDir(). */
const getPrep: Handler = (r, d) => {
	const iv = getInterview(d.db, idParam(r));
	if (!iv?.prep_path) throw new NotFoundError("no prep for this interview");
	const root = artifactsDir();
	if (!existsSync(iv.prep_path) || !existsSync(root))
		throw new NotFoundError("prep file missing");
	const real = realpathSync(iv.prep_path);
	if (!isInside(realpathSync(root), real))
		return ok(
			{ error: "forbidden", message: "prep path outside artifacts" },
			403,
		);
	return {
		status: 200,
		body: readFileSync(real, "utf8"),
		contentType: "text/markdown; charset=utf-8",
	};
};

const ARTIFACT_TYPES: Record<string, string> = {
	"resume.pdf": "application/pdf",
	"cover.pdf": "application/pdf",
	"resume.docx":
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"cover.docx":
		"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
};

const getArtifact: Handler = (r) => {
	const appId = idParam(r);
	const file = r.params[1] ?? "";
	const type = ARTIFACT_TYPES[file];
	const root = artifactsDir();
	const full = join(artifactsDir(appId), file);
	if (!type || !existsSync(full) || !existsSync(root))
		throw new NotFoundError("artifact not found");
	// Same containment rule as prep: never follow a link out of artifacts/.
	const real = realpathSync(full);
	if (!isInside(realpathSync(root), real))
		return ok(
			{ error: "forbidden", message: "artifact path outside artifacts" },
			403,
		);
	return {
		status: 200,
		body: readFileSync(real),
		contentType: type,
		headers: {
			"Content-Disposition": `${file.endsWith(".pdf") ? "inline" : "attachment"}; filename="${file}"`,
		},
	};
};

export const ROUTES: readonly Route[] = [
	{ method: "GET", pattern: /^\/api\/summary$/, handler: getSummary },
	{ method: "GET", pattern: /^\/api\/applications$/, handler: getApplications },
	{
		method: "GET",
		pattern: /^\/api\/applications\/(\d+)\/compare$/,
		handler: getCompare,
	},
	{ method: "GET", pattern: /^\/api\/interviews$/, handler: getInterviews },
	{
		method: "GET",
		pattern: /^\/api\/interviews\/(\d+)\/prep$/,
		handler: getPrep,
	},
	{ method: "GET", pattern: /^\/api\/study$/, handler: getStudy },
	{ method: "GET", pattern: /^\/api\/learn$/, handler: getLearn },
	{
		method: "GET",
		pattern: /^\/artifacts\/(\d+)\/((?:resume|cover)\.(?:pdf|docx))$/,
		handler: getArtifact,
	},
	{ method: "POST", pattern: /^\/api\/study\/clock-in$/, handler: postClockIn },
	{
		method: "POST",
		pattern: /^\/api\/study\/clock-out$/,
		handler: postClockOut,
	},
	{ method: "POST", pattern: /^\/api\/study\/tasks$/, handler: postTask },
	{
		method: "POST",
		pattern: /^\/api\/study\/tasks\/(\d+)\/done$/,
		handler: postTaskDone,
	},
	{
		method: "POST",
		pattern: /^\/api\/study\/blocks\/(\d+)$/,
		handler: postBlock,
	},
	{
		method: "POST",
		pattern: /^\/api\/metrics\/([A-Za-z0-9._-]{1,120})$/,
		handler: postMetric,
	},
	...BOARD_ROUTES,
];

export function matchRoute(
	method: string,
	path: string,
): { route: Route; params: string[] } | { methodNotAllowed: true } | null {
	let pathMatched = false;
	for (const route of ROUTES) {
		const m = route.pattern.exec(path);
		if (!m) continue;
		pathMatched = true;
		if (route.method === method) return { route, params: m.slice(1) };
	}
	return pathMatched ? { methodNotAllowed: true } : null;
}
