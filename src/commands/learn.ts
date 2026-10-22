import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { JhError } from "../core/errors.js";
import { action, emit } from "../core/output.js";
import { meDir } from "../core/paths.js";
import { type Db, openDb } from "../db/index.js";
import {
	type Analysis,
	learningsDir,
	learnStatus,
	lintPlaybook,
	markRun,
	renderPlaybook,
	runAnalysis,
	writePlaybook,
	writeStats,
} from "../learn/index.js";

interface JsonOpt {
	json?: boolean;
}

function withDb<T>(fn: (db: Db) => T): T {
	const db = openDb();
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

/** `<me>/learnings` when the me/ workspace exists, else null. */
function resolveLearningsDir(): string | null {
	const me = meDir();
	return me.exists ? learningsDir(me.path) : null;
}

function parsePositiveInt(
	name: string,
	raw: string | undefined,
): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n <= 0) {
		throw new JhError(`${name} must be a positive integer`, 2, "validation", {
			[name]: raw,
		});
	}
	return n;
}

function pct(x: number | null): string {
	return x === null ? "n/a" : `${Math.round(x * 100)}%`;
}

function humanAnalysis(d: {
	analysis: Analysis;
	stats_path: string | null;
}): string {
	const a = d.analysis;
	const t = a.totals;
	const lines = [
		`submitted ${t.submitted}  resolved ${t.resolved}  callbacks ${t.positive}  rejected ${t.negative}  ghosted ${t.ghosted}  pending ${t.pending}`,
		`callback rate ${pct(a.baseline.rate)}  median response ${a.median_time_to_response_days ?? "n/a"} days`,
		"",
		"top patterns:",
		...(a.patterns.length
			? a.patterns.slice(0, 10).map((p) => `  [${p.direction}] ${p.claim}`)
			: ["  none yet (need n >= 3 per value)"]),
		"",
		`exploration: ${a.exploration.rule}`,
	];
	if (d.stats_path) lines.push(`stats: ${d.stats_path}`);
	return lines.join("\n");
}

function analyzeCmd(opts: JsonOpt & { dryRun?: boolean; ghostDays?: string }) {
	const ghostDays = parsePositiveInt("ghost-days", opts.ghostDays);
	const dir = resolveLearningsDir();
	const result = withDb((db) => {
		const analysis = runAnalysis(db, { ghostDays });
		if (!opts.dryRun) markRun(db, analysis);
		return analysis;
	});
	const statsPath = dir && !opts.dryRun ? writeStats(dir, result) : null;
	emit({ analysis: result, stats_path: statsPath }, opts.json, humanAnalysis);
}

function playbookCmd(opts: JsonOpt & { write?: boolean; file?: string }) {
	const analysis = withDb((db) => runAnalysis(db));
	const markdown = opts.file
		? readFileSync(opts.file, "utf8")
		: renderPlaybook(analysis);
	const lint = lintPlaybook(markdown);
	if (!lint.ok) {
		throw new JhError(
			"playbook claims must cite n and weak|moderate",
			2,
			"validation",
			lint.issues,
		);
	}
	if (!opts.write) {
		emit(
			{ written: false, path: null, markdown, lint },
			opts.json,
			(d) => d.markdown,
		);
		return;
	}
	const dir = resolveLearningsDir();
	if (!dir) {
		throw new JhError(
			"me/ workspace not found; run jh me init first",
			1,
			"not_found",
		);
	}
	const path = writePlaybook(dir, markdown);
	const statsPath = writeStats(dir, analysis);
	emit(
		{ written: true, path, stats_path: statsPath, lint },
		opts.json,
		(d) => `wrote ${d.path} and ${d.stats_path}`,
	);
}

function statusCmd(opts: JsonOpt & { app?: string }) {
	const appId = parsePositiveInt("app", opts.app);
	const dir = resolveLearningsDir();
	const status = withDb((db) => learnStatus(db, dir, { appId }));
	emit(status, opts.json, (s: typeof status) =>
		[
			`learn ${s.due ? "DUE" : "not due"}: ${s.reason}`,
			`last run ${s.last_run_at ?? "never"}; resolved ${s.resolved_now} (${s.new_outcomes} new)`,
			`playbook ${s.playbook_exists ? s.playbook_path : "missing"}`,
			...(s.explore
				? [
						`app ${s.explore.app_id}: ${s.explore.explore ? "EXPLORE a non-best angle" : "use the best angle"}`,
					]
				: []),
		].join("\n"),
	);
}

/** `jh learn analyze|playbook|status` (W7 outcome learning). */
export function register(program: Command): void {
	const learn = program
		.command("learn")
		.description("learn which resume variants earn callbacks");
	learn
		.command("analyze")
		.description(
			"label outcomes, compute callback rates per feature, write me/learnings/stats.json",
		)
		.option("--ghost-days <n>", "days of silence that count as ghosted", "21")
		.option("--dry-run", "do not write stats.json or record the run")
		.option("--json", "machine-readable output")
		.action(action(analyzeCmd));
	learn
		.command("playbook")
		.description(
			"render (or lint an agent-written) playbook; --write saves me/learnings/playbook.md",
		)
		.option("--file <md>", "agent-written playbook to lint and save")
		.option("--write", "write me/learnings/playbook.md")
		.option("--json", "machine-readable output")
		.action(action(playbookCmd));
	learn
		.command("status")
		.description(
			"whether /learn is due; with --app, whether that application should explore",
		)
		.option("--app <id>", "application id for the exploration decision")
		.option("--json", "machine-readable output")
		.action(action(statusCmd));
}
