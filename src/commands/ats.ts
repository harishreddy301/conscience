import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { JdKeywords } from "../ats/keywords.js";
import type { Rendered } from "../ats/parse-checks.js";
import { type AtsReport, scoreResume } from "../ats/score.js";
import { NotFoundError } from "../core/errors.js";
import { action, emit, readJsonInput } from "../core/output.js";
import { ensureDir } from "../core/paths.js";
import { type Db, openDb } from "../db/index.js";
import { setRunKeywords } from "../db/resume.js";
import { loadProfile } from "../me/load.js";
import type { Profile } from "../me/schema.js";
import { docxDocumentXml } from "../render/index.js";
import { requireRun } from "../resume/gate.js";
import { TailoredResume } from "../resume/schema.js";

function withDb<T>(fn: (db: Db) => T): T {
	const db = openDb();
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

function optionalProfile(): Profile | undefined {
	try {
		return loadProfile();
	} catch (e) {
		if (e instanceof NotFoundError) return undefined;
		throw e;
	}
}

/** Store JD keywords on a run (DB + <workdir>/keywords.json). */
export function setKeywords(db: Db, runId: string, json: unknown) {
	const run = requireRun(db, runId);
	const kw = JdKeywords.parse(json);
	const text = JSON.stringify(kw);
	setRunKeywords(db, run.id, text);
	const path = join(ensureDir(run.workdir), "keywords.json");
	writeFileSync(path, `${JSON.stringify(kw, null, 2)}\n`, "utf8");
	return {
		run_id: run.id,
		required: kw.required.length,
		preferred: kw.preferred.length,
		titles: kw.titles.length,
		knockouts: Object.keys(kw.knockouts).length,
		path,
	};
}

function pick(files: string[], ext: string): string | undefined {
	const matches = files.filter((f) => f.toLowerCase().endsWith(`.${ext}`));
	return matches.find((f) => f.toLowerCase() === `resume.${ext}`) ?? matches[0];
}

/** Load rendered html/txt (and docx XML when present) from a render directory. */
export function loadRendered(dir: string): Rendered | undefined {
	const abs = resolve(dir);
	if (!existsSync(abs))
		throw new NotFoundError(`rendered directory not found: ${dir}`);
	const files = readdirSync(abs);
	const html = pick(files, "html");
	const txt = pick(files, "txt");
	if (!html || !txt) return undefined;
	const docx = pick(files, "docx");
	return {
		html: readFileSync(join(abs, html), "utf8"),
		text: readFileSync(join(abs, txt), "utf8"),
		docxXml: docx ? docxDocumentXml(readFileSync(join(abs, docx))) : undefined,
	};
}

function humanReport(r: AtsReport): string {
	const c = r.components;
	const lines = [
		`ATS ${r.total}/100  required ${c.required} context ${c.context} preferred ${c.preferred} title ${c.title} knockouts ${c.knockouts} parse ${c.parse} recency ${c.recency}`,
	];
	if (r.missing_required.length)
		lines.push(`missing required: ${r.missing_required.join(", ")}`);
	if (r.failed_knockouts.length)
		lines.push(`failed knockouts: ${r.failed_knockouts.join("; ")}`);
	if (r.parse_failures.length)
		lines.push(`parse failures: ${r.parse_failures.join(", ")}`);
	for (const s of r.stuffing)
		lines.push(`stuffing: "${s.term}" used ${s.count} times`);
	return lines.join("\n");
}

async function runKeywordsSet(
	runId: string,
	o: { file: string; json?: boolean },
) {
	const json = await readJsonInput(o.file);
	const out = withDb((db) => setKeywords(db, runId, json));
	emit(
		out,
		o.json,
		(x: ReturnType<typeof setKeywords>) =>
			`keywords set on ${x.run_id}: ${x.required} required, ${x.preferred} preferred`,
	);
}

async function runKeywordsGet(runId: string, o: { json?: boolean }) {
	const run = withDb((db) => requireRun(db, runId));
	if (!run.keywords_json)
		throw new NotFoundError(`run ${runId} has no keywords yet`);
	emit(
		JdKeywords.parse(JSON.parse(run.keywords_json)),
		o.json,
		(k: JdKeywords) =>
			[
				`required: ${k.required.map((x) => x.term).join(", ")}`,
				`preferred: ${k.preferred.map((x) => x.term).join(", ")}`,
			].join("\n"),
	);
}

async function runScore(
	draftFile: string,
	o: { keywords: string; rendered?: string; json?: boolean },
) {
	const draft = TailoredResume.parse(await readJsonInput(draftFile));
	const kw = JdKeywords.parse(await readJsonInput(o.keywords));
	const rendered = o.rendered ? loadRendered(o.rendered) : undefined;
	const report = scoreResume(draft, kw, rendered, optionalProfile());
	emit(report, o.json, humanReport);
}

export function register(program: Command): void {
	const ats = program
		.command("ats")
		.description("JD keywords and the deterministic 100-point ATS score");

	const keywords = ats
		.command("keywords")
		.description("JD keywords of a resume run");
	keywords
		.command("set <run_id>")
		.description("store JdKeywords JSON (from the ats-screener) on a run")
		.requiredOption("--file <path>", "keywords JSON file, or - for stdin")
		.option("--json", "machine-readable output")
		.action(action(runKeywordsSet));
	keywords
		.command("get <run_id>")
		.description("print the keywords stored on a run")
		.option("--json", "machine-readable output")
		.action(action(runKeywordsGet));

	ats
		.command("score <draft>")
		.description(
			"score a TailoredResume draft against JD keywords (pass >= 80, floor 60)",
		)
		.requiredOption("--keywords <file>", "JdKeywords JSON file")
		.option(
			"--rendered <dir>",
			"directory with rendered .html/.txt(/.docx) to parse-check",
		)
		.option("--json", "machine-readable output")
		.action(action(runScore));
}
