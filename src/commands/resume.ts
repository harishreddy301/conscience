import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Command } from "commander";
import { JdKeywords } from "../ats/keywords.js";
import { scoreResume } from "../ats/score.js";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { action, emit, readJsonInput } from "../core/output.js";
import { artifactsDir, ensureDir, mePaths } from "../core/paths.js";
import { type Db, openDb } from "../db/index.js";
import {
	createApplication,
	getApplication,
	getJob,
	insertJob,
	setJobJd,
	upsertCompany,
} from "../db/repo.js";
import {
	addReview,
	createRun,
	getRun,
	listDrafts,
	listReviews,
	type Quality,
	type ResumeRunRow,
	upsertDraft,
} from "../db/resume.js";
import { pendingMetricCount } from "../me/metrics.js";
import {
	FORMATS,
	type Format,
	layoutGate,
	layoutSpecFrom,
	renderAll,
} from "../render/index.js";
import { applyBold, suggestBold } from "../resume/bold.js";
import { finalizeResume } from "../resume/finalize.js";
import {
	assessDraft,
	loadMe,
	type MeData,
	requireDraft,
	requireRun,
	runKeywords,
} from "../resume/gate.js";
import { latestByReviewer, parseReview } from "../resume/review.js";
import { TailoredResume } from "../resume/schema.js";
import { type ValidationResult, validateTailored } from "../resume/validate.js";

// ---------------------------------------------------------------- helpers

function withDb<T>(fn: (db: Db) => T): T {
	const db = openDb();
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

async function withDbAsync<T>(fn: (db: Db) => Promise<T>): Promise<T> {
	const db = openDb();
	try {
		return await fn(db);
	} finally {
		db.close();
	}
}

function parseIntArg(v: string | undefined, name: string): number | undefined {
	if (v === undefined) return undefined;
	const n = Number(v);
	if (!Number.isInteger(n) || n <= 0)
		throw new ValidationError(`--${name} must be a positive integer`);
	return n;
}

/** "<appId>-<yyyymmddhhmmss>-<hex4>": sortable and unique per prepare. */
export function newRunId(appId: number, now = new Date()): string {
	const stamp = now
		.toISOString()
		.replace(/[-:TZ.]/g, "")
		.slice(0, 14);
	return `${appId}-${stamp}-${randomBytes(2).toString("hex")}`;
}

// ---------------------------------------------------------------- prepare

export interface PrepareInput {
	jd: string;
	company: string;
	title: string;
	url?: string;
	app?: number;
}

export interface PrepareResult {
	run_id: string;
	app_id: number;
	workdir: string;
	jd_path: string;
	master_path: string;
	profile_path: string;
	pending_estimates: number;
}

function resolveApplication(db: Db, o: PrepareInput, jdText: string): number {
	if (o.app !== undefined) {
		const app = getApplication(db, o.app);
		if (!app) throw new NotFoundError(`application ${o.app} not found`);
		const job = getJob(db, app.job_id);
		if (job && !job.jd_text) setJobJd(db, job.id, jdText);
		return app.id;
	}
	const company = upsertCompany(db, { name: o.company });
	const job = insertJob(db, {
		company_id: company.id,
		title: o.title,
		url: o.url,
		jd_text: jdText,
	});
	if (!job.jd_text) setJobJd(db, job.id, jdText);
	return createApplication(db, { job_id: job.id }).id;
}

/** Create company/job/application as needed and open a resume run with its workdir. */
export function prepareRun(db: Db, o: PrepareInput): PrepareResult {
	if (!existsSync(o.jd)) throw new NotFoundError(`JD file not found: ${o.jd}`);
	const jdText = readFileSync(o.jd, "utf8");
	if (jdText.trim().length < 50)
		throw new ValidationError(`JD file ${o.jd} is too short to tailor against`);
	const paths = mePaths();
	if (!existsSync(paths.masterResume))
		throw new NotFoundError(
			`master resume not found at ${paths.masterResume}; run /intake first`,
			{ path: paths.masterResume },
			"master_missing",
		);
	const appId = resolveApplication(db, o, jdText);
	const runId = newRunId(appId);
	const workdir = ensureDir(join(artifactsDir(appId), "runs", runId));
	const jdPath = join(workdir, "jd.txt");
	copyFileSync(o.jd, jdPath);
	createRun(db, { id: runId, application_id: appId, workdir, jd_path: jdPath });
	audit({
		actor: "jh resume prepare",
		action: "resume.prepare",
		target: `application:${appId}`,
		detail: { run_id: runId, company: o.company, title: o.title },
	});
	return {
		run_id: runId,
		app_id: appId,
		workdir,
		jd_path: jdPath,
		master_path: paths.masterResume,
		profile_path: paths.profile,
		pending_estimates: pendingMetricCount(paths),
	};
}

// ---------------------------------------------------------------- validate

export interface ValidateOutput extends ValidationResult {
	registered: boolean;
	run_id?: string;
	draft_id?: string;
	ats?: number;
}

function runMismatch(
	run: ResumeRunRow,
	appId: number,
): ValidationResult["errors"] {
	if (run.application_id === appId) return [];
	return [
		{
			path: "job.app_id",
			code: "SCHEMA",
			message: `run ${run.id} is for application ${run.application_id}, draft says ${appId}`,
		},
	];
}

/** Validate a draft file; register it on its run when the run exists. */
export function validateDraftFile(
	db: Db,
	file: string,
	json: unknown,
	me: MeData = loadMe(),
): ValidateOutput {
	const result = validateTailored(json, me.master, me.profile);
	const parsed = TailoredResume.safeParse(json);
	if (!parsed.success) return { ...result, registered: false };
	const draft = parsed.data;
	const run = getRun(db, draft.run_id);
	if (!run) return { ...result, registered: false, draft_id: draft.draft_id };
	result.errors.push(...runMismatch(run, draft.job.app_id));
	result.ok = result.errors.length === 0;
	const kw = runKeywords(run);
	const ats =
		kw && result.ok
			? scoreResume(draft, kw, undefined, me.profile).total
			: undefined;
	upsertDraft(db, {
		run_id: run.id,
		id: draft.draft_id,
		angle: draft.angle,
		iteration: draft.iteration,
		path: resolve(file),
		ats_score: ats,
		valid: result.ok,
	});
	return {
		...result,
		registered: true,
		run_id: run.id,
		draft_id: draft.draft_id,
		ats,
	};
}

function humanValidation(v: ValidateOutput): string {
	const lines = [v.ok ? "valid" : `INVALID (${v.errors.length} errors)`];
	for (const e of v.errors)
		lines.push(`  error ${e.code} ${e.path}: ${e.message}`);
	for (const w of v.warnings)
		lines.push(`  warn  ${w.code} ${w.path}: ${w.message}`);
	if (v.registered)
		lines.push(
			`registered ${v.draft_id} on run ${v.run_id}${v.ats !== undefined ? ` (ATS ${v.ats})` : ""}`,
		);
	return lines.join("\n");
}

// ---------------------------------------------------------------- render

export function parseFormats(csv: string | undefined): Format[] {
	if (!csv) return [...FORMATS];
	const parts = csv
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	const bad = parts.filter((p) => !(FORMATS as readonly string[]).includes(p));
	if (bad.length || !parts.length)
		throw new ValidationError(`unknown format: ${bad.join(", ") || "(none)"}`, {
			allowed: FORMATS,
		});
	return parts as Format[];
}

function defaultRenderDir(db: Db, file: string, r: TailoredResume): string {
	const run = getRun(db, r.run_id);
	const base = run ? run.workdir : dirname(resolve(file));
	return join(base, "render", r.draft_id);
}

// ---------------------------------------------------------------- review / status

export function addReviewFromJson(db: Db, runId: string, json: unknown) {
	const run = requireRun(db, runId);
	const rep = parseReview(json);
	requireDraft(db, run.id, rep.draft_id);
	const id = addReview(db, run.id, rep);
	const copy = join(
		ensureDir(run.workdir),
		`review-${rep.draft_id}-${rep.reviewer}-${id}.json`,
	);
	writeFileSync(copy, `${JSON.stringify(rep, null, 2)}\n`, "utf8");
	return {
		id,
		run_id: run.id,
		draft_id: rep.draft_id,
		reviewer: rep.reviewer,
		verdict: rep.verdict,
		score: rep.score,
		path: copy,
	};
}

export function runStatus(db: Db, runId: string) {
	const run = requireRun(db, runId);
	const drafts = listDrafts(db, run.id).map((d) => {
		const latest = latestByReviewer(listReviews(db, run.id, d.id));
		return {
			id: d.id,
			angle: d.angle,
			iteration: d.iteration,
			path: d.path,
			ats_score: d.ats_score,
			valid: d.valid === null ? null : d.valid === 1,
			reviews: Object.values(latest).map((r) => ({
				reviewer: r.reviewer,
				verdict: r.verdict,
				score: r.score,
			})),
		};
	});
	return {
		run: {
			...run,
			keywords_json: undefined,
			has_keywords: run.keywords_json !== null,
		},
		drafts,
	};
}

function humanStatus(s: ReturnType<typeof runStatus>): string {
	const lines = [
		`run ${s.run.id} (${s.run.status}) app ${s.run.application_id} iterations ${s.run.iterations}`,
	];
	for (const d of s.drafts) {
		const reviews = d.reviews
			.map((r) => `${r.reviewer}=${r.verdict}/${r.score}`)
			.join(" ");
		lines.push(
			`  ${d.id} [${d.angle} i${d.iteration}] valid=${d.valid} ats=${d.ats_score ?? "-"} ${reviews}`,
		);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------- actions

interface JsonOpt {
	json?: boolean;
}

async function runPrepare(
	o: JsonOpt & {
		jd: string;
		company: string;
		title: string;
		url?: string;
		app?: string;
	},
) {
	const out = withDb((db) =>
		prepareRun(db, {
			jd: o.jd,
			company: o.company,
			title: o.title,
			url: o.url,
			app: parseIntArg(o.app, "app"),
		}),
	);
	emit(
		out,
		o.json,
		(r: PrepareResult) =>
			`run ${r.run_id} for application ${r.app_id}\nworkdir ${r.workdir}\npending estimates: ${r.pending_estimates}`,
	);
}

async function runValidate(file: string, o: JsonOpt) {
	const json = await readJsonInput(file);
	const out = withDb((db) => validateDraftFile(db, file, json));
	emit(out, o.json, humanValidation);
	if (!out.ok) process.exitCode = 2;
}

async function runRender(
	file: string,
	o: JsonOpt & { formats?: string; out?: string; pages?: string },
) {
	const r = TailoredResume.parse(await readJsonInput(file));
	if (o.pages !== undefined) {
		if (o.pages !== "1" && o.pages !== "2")
			throw new ValidationError("--pages must be 1 or 2");
		r.layout = { ...r.layout, pages: o.pages === "1" ? 1 : 2 };
	}
	const formats = parseFormats(o.formats);
	const outDir = o.out
		? resolve(o.out)
		: withDb((db) => defaultRenderDir(db, file, r));
	const result = await renderAll(r, ensureDir(outDir), formats);
	emit(
		{ ...result, out_dir: outDir },
		o.json,
		(x: typeof result & { out_dir: string }) =>
			[
				`rendered to ${x.out_dir} (pages ${x.pages ?? "?"}, density ${x.density})`,
				...Object.values(x.files),
				...x.warnings.map((w) => `warning: ${w}`),
			].join("\n"),
	);
}

/**
 * Render a draft (PDF/HTML/DOCX, fitted to the spec's page count) and run the
 * layout gate on the result. Exit 2 when the layout fails; the JSON lists each
 * failing bullet with its line count and last-line fill for the next revision.
 */
async function runLayout(file: string, o: JsonOpt & { out?: string }) {
	const r = TailoredResume.parse(await readJsonInput(file));
	const me = loadMe();
	const spec = layoutSpecFrom(me.profile);
	r.layout = { ...r.layout, pages: spec.pages === 1 ? 1 : 2 };
	const outDir = o.out
		? resolve(o.out)
		: withDb((db) => defaultRenderDir(db, file, r));
	const render = await renderAll(r, ensureDir(outDir), ["pdf", "html", "docx"]);
	const gate = await layoutGate(r, {
		spec,
		density: render.density,
		pdfPath: render.files.pdf,
	});
	emit(
		{ ...gate, files: render.files, density: render.density, out_dir: outDir },
		o.json,
		(x: typeof gate & { out_dir: string }) =>
			[
				`layout ${x.pass ? "PASS" : "FAIL"}: pages ${x.pages}, last page ${Math.round((x.last_page_fill ?? 0) * 100)}% full (${x.out_dir})`,
				...x.failures.map((f) => `  - ${f.code} ${f.path}: ${f.message}`),
				...x.warnings.map((w) => `  warning ${w.code}: ${w.message}`),
			].join(String.fromCharCode(10)),
	);
	if (!gate.pass) process.exitCode = 2;
}

/**
 * Propose bold spans for every bullet, the summary and each highlight from
 * metric phrases, the run's JD keywords and the user's recorded skills.
 * --apply writes them into the draft (or --out); validation still decides.
 */
async function runBold(
	file: string,
	o: JsonOpt & {
		suggest?: boolean;
		apply?: boolean;
		keywords?: string;
		out?: string;
	},
) {
	const r = TailoredResume.parse(await readJsonInput(file));
	const me = loadMe();
	let keywords: JdKeywords | null = null;
	if (o.keywords)
		keywords = JdKeywords.parse(JSON.parse(readFileSync(o.keywords, "utf8")));
	else
		try {
			keywords = withDb((db) => {
				const run = getRun(db, r.run_id);
				return run ? runKeywords(run) : null;
			});
		} catch {
			keywords = null;
		}
	const suggestions = suggestBold(r, me.master, me.profile, keywords);
	let written: string | undefined;
	if (o.apply) {
		written = resolve(o.out ?? file);
		writeFileSync(
			written,
			`${JSON.stringify(applyBold(r, suggestions), null, 2)}\n`,
		);
	}
	const out = {
		draft_id: r.draft_id,
		keywords: keywords !== null,
		written,
		short: suggestions.filter((s) => s.short).map((s) => s.path),
		suggestions,
	};
	emit(out, o.json, (x: typeof out) =>
		[
			`bold suggestions for ${x.draft_id} (JD keywords ${x.keywords ? "used" : "not found"})`,
			...x.suggestions.map(
				(s) =>
					`  ${s.path}${s.short ? " [SHORT: add a core-concept term]" : ""}: ${s.suggested.map((p) => `**${p}**`).join(", ")}`,
			),
			...(x.written ? [`written to ${x.written}`] : []),
		].join(String.fromCharCode(10)),
	);
}

async function runReviewAdd(runId: string, o: JsonOpt & { file: string }) {
	const json = await readJsonInput(o.file);
	const out = withDb((db) => addReviewFromJson(db, runId, json));
	emit(
		out,
		o.json,
		(x: ReturnType<typeof addReviewFromJson>) =>
			`review ${x.id}: ${x.reviewer} ${x.verdict} (${x.score}) on ${x.draft_id}`,
	);
}

async function runGate(runId: string, o: JsonOpt & { draft: string }) {
	const gate = withDb((db) => {
		const a = assessDraft(db, runId, o.draft);
		const row = requireDraft(db, runId, o.draft);
		upsertDraft(db, { ...row, ats_score: a.atsScore, valid: a.validation.ok });
		return a.gate;
	});
	emit(gate, o.json, (g: typeof gate) =>
		[
			`gate ${g.pass ? "PASS" : "FAIL"}: ats ${g.ats}, hm ${g.hm_verdict ?? "-"}, recruiter ${g.recruiter_passes}/8, valid ${g.valid}, factcheck ${g.factcheck}`,
			...g.reasons.map((r) => `  - ${r}`),
		].join("\n"),
	);
}

async function runStatusCmd(runId: string, o: JsonOpt) {
	emit(
		withDb((db) => runStatus(db, runId)),
		o.json,
		humanStatus,
	);
}

async function runFinalize(
	runId: string,
	o: JsonOpt & { draft: string; quality?: string; formats?: string },
) {
	if (
		o.quality !== undefined &&
		o.quality !== "ok" &&
		o.quality !== "below_bar"
	)
		throw new ValidationError("--quality must be ok or below_bar");
	const out = await withDbAsync((db) =>
		finalizeResume(db, {
			runId,
			draftId: o.draft,
			quality: o.quality as Quality | undefined,
			formats: o.formats ? parseFormats(o.formats) : undefined,
		}),
	);
	emit(out, o.json, (x: typeof out) =>
		[
			`finalized ${x.draft_id} for application ${x.app_id} (ATS ${x.ats}, ${x.quality})`,
			`artifacts ${x.artifacts_dir}`,
			...x.warnings.map((w) => `warning: ${w}`),
		].join("\n"),
	);
}

// ---------------------------------------------------------------- register

export function register(program: Command): void {
	const resume = program
		.command("resume")
		.description(
			"tailor a resume per job: prepare, validate, render, review, gate, status, finalize",
		);

	resume
		.command("prepare")
		.description(
			"open a resume run for a JD (creates company/job/application if needed)",
		)
		.requiredOption("--jd <file>", "job description text file")
		.requiredOption("--company <name>", "company name")
		.requiredOption("--title <title>", "job title")
		.option("--url <url>", "posting URL")
		.option("--app <id>", "existing application id")
		.option("--json", "machine-readable output")
		.action(action(runPrepare));

	resume
		.command("validate <draft>")
		.description(
			"check a TailoredResume draft against me/ (fixed facts, provenance, numbers, skills); exit 2 if invalid",
		)
		.option("--json", "machine-readable output")
		.action(action(runValidate));

	resume
		.command("render <draft>")
		.description(
			"render a draft to html/pdf/docx/txt, auto-fitting to 1 or 2 pages",
		)
		.option("--formats <list>", "comma-separated: html,pdf,docx,txt")
		.option(
			"--out <dir>",
			"output directory (default <workdir>/render/<draft_id>)",
		)
		.option("--pages <n>", "target pages: 1 or 2")
		.option("--json", "machine-readable output")
		.action(action(runRender));

	resume
		.command("layout <draft>")
		.description(
			"render a draft and run the layout gate (pages, 2-line bullets at 60-80% fill, one-line skills/Environment/publications, full last page, bullets per role, no em dash); exit 2 on failure",
		)
		.option(
			"--out <dir>",
			"output directory (default <workdir>/render/<draft_id>)",
		)
		.option("--json", "machine-readable output")
		.action(action(runLayout));

	resume
		.command("bold <draft>")
		.description(
			"suggest bold key terms per bullet/summary/highlight (metrics, JD keywords, recorded skills); --apply writes them into the draft",
		)
		.option("--suggest", "print suggestions (the default)")
		.option("--apply", "write the suggestions into the draft's emphasis lists")
		.option("--out <file>", "with --apply: write here instead of in place")
		.option(
			"--keywords <file>",
			"JdKeywords JSON (default: the run's stored keywords)",
		)
		.option("--json", "machine-readable output")
		.action(action(runBold));

	const review = resume
		.command("review")
		.description("store reviewer reports for a run");
	review
		.command("add <run_id>")
		.description(
			"add a ReviewReport (hiring-manager, recruiter-screen, ats-screener, fact-checker)",
		)
		.requiredOption("--file <path>", "review JSON file, or - for stdin")
		.option("--json", "machine-readable output")
		.action(action(runReviewAdd));

	resume
		.command("gate <run_id>")
		.description(
			"apply the quality gate: ATS >= 80, HM interview, recruiter >= 6/8, valid",
		)
		.requiredOption("--draft <id>", "draft id")
		.option("--json", "machine-readable output")
		.action(action(runGate));

	resume
		.command("status <run_id>")
		.description("drafts, reviews and scores of a run")
		.option("--json", "machine-readable output")
		.action(action(runStatusCmd));

	resume
		.command("finalize <run_id>")
		.description(
			"write final artifacts and mark the application tailored (exit 2 without a fact-check pass)",
		)
		.requiredOption("--draft <id>", "draft id to ship")
		.option("--quality <q>", "ok|below_bar (default: from the gate)")
		.option("--formats <list>", "comma-separated: html,pdf,docx,txt")
		.option("--json", "machine-readable output")
		.action(action(runFinalize));
}
