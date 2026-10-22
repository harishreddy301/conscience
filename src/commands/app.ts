import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { action, emit } from "../core/output.js";
import { artifactsDir } from "../core/paths.js";
import type { AppStatus } from "../core/state.js";
import {
	APP_STATUSES,
	ghostSweep,
	isAppStatus,
	SUBMITTED,
	transition,
} from "../core/state.js";
import { type Db, openDb } from "../db/index.js";
import {
	type ApplicationView,
	createApplication,
	getApplication,
	insertEvent,
	insertJob,
	listApplications,
	listEvents,
	setJobPostedAt,
	upsertCompany,
} from "../db/repo.js";

// ---------- input parsing ----------

const DAY_MS = 86_400_000;

/** Accepts an ISO timestamp or YYYY-MM-DD; returns UTC ISO. */
export function parseWhen(s: string): string {
	const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s);
	if (Number.isNaN(t)) throw new ValidationError(`invalid date: ${s}`);
	return new Date(t).toISOString();
}

/** "30d" / "12h" / "2w" relative to now, or an absolute date. */
export function parseSince(s: string, now: Date = new Date()): string {
	const m = /^(\d+)\s*([hdw])$/i.exec(s.trim());
	if (!m) return parseWhen(s);
	const unit = (m[2] as string).toLowerCase();
	const hours = unit === "h" ? 1 : unit === "d" ? 24 : 24 * 7;
	return new Date(
		now.getTime() - Number(m[1]) * hours * (DAY_MS / 24),
	).toISOString();
}

export function parseStatuses(csv: string): AppStatus[] {
	const parts = csv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	const bad = parts.filter((p) => !isAppStatus(p));
	if (bad.length)
		throw new ValidationError(`unknown status: ${bad.join(", ")}`, {
			allowed: APP_STATUSES,
		});
	return parts as AppStatus[];
}

const StatusSchema = z.enum(APP_STATUSES);
const IdSchema = z.coerce.number().int().positive();

/** Posting date: ISO or YYYY-MM-DD, not in the future (1 day of clock skew allowed). */
export const PostedAtSchema = z
	.string()
	.trim()
	.min(1)
	.refine(
		(s) => {
			const t = Date.parse(
				/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T12:00:00Z` : s,
			);
			return Number.isFinite(t) && t <= Date.now() + DAY_MS;
		},
		{ message: "posted-at must be an ISO date not in the future" },
	)
	.transform((s) => parseWhen(s));

const AddOpts = z.object({
	company: z.string().trim().min(1),
	title: z.string().trim().min(1),
	url: z.url().optional(),
	domain: z.string().trim().min(1).optional(),
	location: z.string().trim().min(1).optional(),
	status: StatusSchema.optional(),
	appliedAt: z.string().optional(),
	postedAt: PostedAtSchema.optional(),
	source: z.enum(["external", "email"]).optional(),
	actor: z.string().trim().min(1).default("user"),
	json: z.boolean().optional(),
});

const ListOpts = z.object({
	status: z.string().optional(),
	active: z.boolean().optional(),
	since: z.string().optional(),
	userRequested: z.boolean().optional(),
	limit: z.coerce.number().int().positive().optional(),
	json: z.boolean().optional(),
});

const TransitionOpts = z.object({
	note: z.string().optional(),
	actor: z.string().trim().min(1).default("user"),
	emailId: z.coerce.number().int().positive().optional(),
	external: z.boolean().optional(),
	json: z.boolean().optional(),
});

const SweepOpts = z.object({
	days: z.coerce.number().int().positive().default(21),
	json: z.boolean().optional(),
});

// ---------- helpers ----------

function withDb<T>(fn: (db: Db) => T): T {
	const db = openDb();
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

function requireApp(db: Db, id: number): ApplicationView {
	const app = getApplication(db, id);
	if (!app) throw new NotFoundError(`application ${id} not found`, { id });
	return app;
}

/** factcheck.json in the application's artifacts dir; passed when verdict === "pass". */
export function readFactcheckPassed(app: ApplicationView): boolean {
	const file = join(
		app.artifacts_dir ?? artifactsDir(app.id),
		"factcheck.json",
	);
	if (!existsSync(file)) return false;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as {
			verdict?: unknown;
		};
		return parsed.verdict === "pass";
	} catch {
		return false;
	}
}

function daysAgo(iso: string | null, now = Date.now()): string {
	if (!iso) return "-";
	return `${Math.max(0, Math.floor((now - Date.parse(iso)) / DAY_MS))}d`;
}

function formatRow(a: ApplicationView): string {
	return [
		String(a.id).padStart(4),
		a.status.padEnd(12),
		`${a.company} - ${a.title}`.padEnd(48),
		`applied ${a.applied_at?.slice(0, 10) ?? "-"}`,
		`last ${daysAgo(a.last_event_at)}`,
	].join("  ");
}

function formatList(rows: ApplicationView[]): string {
	return rows.length ? rows.map(formatRow).join("\n") : "no applications";
}

// ---------- actions ----------

export interface AddResult {
	created: boolean;
	application: ApplicationView;
}

export function addApplication(db: Db, raw: unknown): AddResult {
	const o = AddOpts.parse(raw);
	const status: AppStatus = o.status ?? (o.source ? "applied" : "shortlisted");
	// A submitted application that conscience did not make itself is external by definition.
	const source =
		o.source ?? (SUBMITTED.has(status) ? "external" : "conscience");
	const appliedAt = o.appliedAt ? parseWhen(o.appliedAt) : undefined;
	const company = upsertCompany(db, { name: o.company, domain: o.domain });
	const job = insertJob(db, {
		company_id: company.id,
		title: o.title,
		url: o.url,
		location: o.location,
		posted_at: o.postedAt,
	});
	const existing = listApplications(db, { companyId: company.id }).find(
		(a) => a.job_id === job.id,
	);
	if (existing) return { created: false, application: existing };
	const app = createApplication(db, {
		job_id: job.id,
		status,
		source,
		applied_at: appliedAt,
	});
	insertEvent(db, {
		application_id: app.id,
		kind: "transition",
		to_status: status,
		actor: o.actor,
		detail: { created: true, source },
		at: app.applied_at ?? app.created_at,
	});
	audit({
		actor: o.actor,
		action: "app.add",
		target: `application:${app.id}`,
		detail: { company: company.name, title: job.title, status, source },
	});
	return { created: true, application: requireApp(db, app.id) };
}

function runAdd(opts: unknown): void {
	const json = (opts as { json?: boolean }).json;
	const r = withDb((db) => addApplication(db, opts));
	emit(
		r,
		json,
		(d: AddResult) =>
			`${d.created ? "added" : "exists"}: ${formatRow(d.application)}`,
	);
}

function runList(opts: unknown): void {
	const o = ListOpts.parse(opts);
	const rows = withDb((db) =>
		listApplications(db, {
			status: o.status ? parseStatuses(o.status) : undefined,
			active: o.active,
			sinceIso: o.since ? parseSince(o.since) : undefined,
			userRequested: o.userRequested,
			limit: o.limit,
		}),
	);
	emit(rows, o.json, formatList);
}

function runShow(id: string, opts: { json?: boolean }): void {
	const appId = IdSchema.parse(id);
	const out = withDb((db) => ({
		application: requireApp(db, appId),
		events: listEvents(db, appId),
	}));
	emit(out, opts.json, (d: typeof out) =>
		[
			formatRow(d.application),
			...(d.application.url ? [`  url: ${d.application.url}`] : []),
			...d.events.map(
				(e) =>
					`  ${e.at}  ${e.kind}  ${e.from_status ?? ""}->${e.to_status ?? ""}  by ${e.actor}`,
			),
		].join("\n"),
	);
}

function runTransition(id: string, status: string, opts: unknown): void {
	const appId = IdSchema.parse(id);
	const to = StatusSchema.parse(status);
	const o = TransitionOpts.parse(opts);
	const r = withDb((db) => {
		const app = requireApp(db, appId);
		const factcheckPassed =
			to === "applied" ? readFactcheckPassed(app) : undefined;
		const res = transition(db, appId, to, {
			actor: o.actor,
			note: o.note,
			emailId: o.emailId,
			external: o.external,
			factcheckPassed,
		});
		return { id: appId, ...res };
	});
	emit(r, o.json, (d: typeof r) =>
		d.changed
			? `application ${d.id}: ${d.from} -> ${d.to}`
			: `application ${d.id}: already ${d.to}`,
	);
}

export function setPosted(
	db: Db,
	id: number,
	date: string,
	actor = "user",
): { id: number; job_id: number; posted_at: string } {
	const appId = IdSchema.parse(id);
	const postedAt = PostedAtSchema.parse(date);
	const app = requireApp(db, appId);
	setJobPostedAt(db, app.job_id, postedAt);
	audit({
		actor,
		action: "app.set_posted",
		target: `application:${appId}`,
		detail: { job_id: app.job_id, posted_at: postedAt },
	});
	return { id: appId, job_id: app.job_id, posted_at: postedAt };
}

function runSetPosted(
	id: string,
	date: string,
	opts: { actor?: string; json?: boolean },
): void {
	const r = withDb((db) => setPosted(db, Number(id), date, opts.actor));
	emit(
		r,
		opts.json,
		(d: typeof r) => `application ${d.id}: posted ${d.posted_at.slice(0, 10)}`,
	);
}

function runSweep(opts: unknown): void {
	const o = SweepOpts.parse(opts);
	const ghosted = withDb((db) => ghostSweep(db, { days: o.days }));
	if (ghosted.length)
		audit({
			actor: "ghost-sweep",
			action: "app.ghost_sweep",
			detail: { ids: ghosted, days: o.days },
		});
	emit({ ghosted, days: o.days }, o.json, () =>
		ghosted.length
			? `ghosted ${ghosted.length}: ${ghosted.join(", ")}`
			: "nothing to ghost",
	);
}

export function register(program: Command): void {
	const app = program
		.command("app")
		.description(
			"track job applications (add, list, show, transition, ghost-sweep)",
		);

	app
		.command("add")
		.description(
			"record an application (use --source external for ones made outside conscience)",
		)
		.requiredOption("--company <name>", "company name")
		.requiredOption("--title <title>", "job title")
		.option("--url <url>", "posting URL")
		.option("--domain <domain>", "company email/web domain")
		.option("--location <loc>", "job location (City, Region)")
		.option("--status <status>", `initial status (${APP_STATUSES.join("|")})`)
		.option("--applied-at <date>", "when it was applied (ISO or YYYY-MM-DD)")
		.option(
			"--posted-at <date>",
			"when the posting was published (ISO or YYYY-MM-DD)",
		)
		.option("--source <source>", "external|email (default: conscience)")
		.option("--actor <actor>", "who is recording this", "user")
		.option("--json", "machine-readable output")
		.action(action(runAdd));

	app
		.command("list")
		.description("list applications, newest activity first")
		.option("--status <list>", "comma-separated statuses")
		.option("--active", "only active statuses")
		.option("--since <when>", "last activity since (30d, 2w, 12h or a date)")
		.option(
			"--user-requested",
			'only jobs the user asked for ("You asked"); process these first',
		)
		.option("--limit <n>", "max rows")
		.option("--json", "machine-readable output")
		.action(action(runList));

	app
		.command("show <id>")
		.description("show one application with its event history")
		.option("--json", "machine-readable output")
		.action(action(runShow));

	app
		.command("transition <id> <status>")
		.description(
			"move an application through the state machine (exit 3 if illegal)",
		)
		.option("--note <text>", "note stored on the event")
		.option("--actor <actor>", "who is making the change", "user")
		.option("--email-id <id>", "email that triggered this")
		.option("--external", "the application was made outside conscience")
		.option("--json", "machine-readable output")
		.action(action(runTransition));

	app
		.command("set-posted <id> <date>")
		.description("record when an application's posting was published")
		.option("--actor <actor>", "who is recording this", "user")
		.option("--json", "machine-readable output")
		.action(action(runSetPosted));

	app
		.command("ghost-sweep")
		.description(
			"mark applied/assessment applications with no activity as ghosted",
		)
		.option("--days <n>", "days of silence before ghosting", "21")
		.option("--json", "machine-readable output")
		.action(action(runSweep));
}
