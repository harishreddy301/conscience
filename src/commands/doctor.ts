import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { Command } from "commander";
import { action, emit } from "../core/output.js";
import {
	dbPath,
	jhHome,
	type MeLocation,
	meDir,
	repoRoot,
} from "../core/paths.js";
import { openDb, userVersion } from "../db/index.js";
import { MIGRATIONS } from "../db/migrations.js";

export interface DoctorReport {
	node: string;
	nodeOk: boolean;
	home: string;
	me: MeLocation;
	meIgnored: boolean | null;
	db: string;
	dbOk: boolean;
	chrome: string | null;
	pendingMetrics: number | null;
	/** The private data repo clone for cloud sessions (ADR 006); null when not configured. */
	dataRepo: { path: string; ok: boolean } | null;
	warnings: string[];
}

const MIN_NODE: readonly [number, number] = [22, 13];

export function nodeVersionOk(
	version: string = process.versions.node,
): boolean {
	const [major = 0, minor = 0] = version.split(".").map(Number);
	return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

function isInside(child: string, parent: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return (
		rel === "" ||
		(!rel.startsWith(`..${sep}`) && rel !== ".." && !/^[a-zA-Z]:/.test(rel))
	);
}

/**
 * Whether git ignores the me/ workspace. A workspace outside the plugin checkout
 * cannot be committed (true). Inside it, `git check-ignore` decides; when git is
 * missing or the checkout is not a usable repo, the answer is null plus a warning.
 */
export function checkMeIgnored(
	mePath: string,
	root: string | null,
	warnings: string[],
): boolean | null {
	if (!root || !isInside(mePath, root)) return true;
	try {
		execFileSync("git", ["check-ignore", "-q", mePath], {
			cwd: root,
			stdio: "ignore",
			timeout: 10_000,
		});
		return true;
	} catch (e) {
		const status = (e as { status?: number | null }).status;
		if (status === 1) return false;
		warnings.push(
			"could not run `git check-ignore` (git missing or repo unusable); me/ privacy not verified",
		);
		return null;
	}
}

/**
 * The optional private data repo (ADR 006): when JOB_HUNTER_DATA_REPO is set it
 * must be a git clone that sits outside the plugin checkout. Visibility is
 * checked by `jh cloud export` itself (it needs the network).
 */
export function checkDataRepo(
	dir: string | undefined,
	root: string | null,
	warnings: string[],
): { path: string; ok: boolean } | null {
	if (!dir) return null;
	const path = resolve(dir);
	if (!existsSync(join(path, ".git"))) {
		warnings.push(`data repo ${path} is not a git clone; see ADR 006`);
		return { path, ok: false };
	}
	if (root && isInside(path, root)) {
		warnings.push(
			`data repo ${path} sits inside the plugin checkout; clone it elsewhere (ADR 006)`,
		);
		return { path, ok: false };
	}
	return { path, ok: true };
}

function checkDb(path: string, warnings: string[]): boolean {
	try {
		const db = openDb(path);
		try {
			const v = userVersion(db);
			if (v !== MIGRATIONS.length) {
				warnings.push(`db schema v${v}, expected v${MIGRATIONS.length}`);
				return false;
			}
			return true;
		} finally {
			db.close();
		}
	} catch (e) {
		warnings.push(`db error: ${(e as Error).message}`);
		return false;
	}
}

async function findChromeSafe(warnings: string[]): Promise<string | null> {
	try {
		const render = await import("../render/index.js");
		const found = render.findChrome();
		if (!found)
			warnings.push(
				"Chrome not found: PDF rendering disabled (set CHROME_PATH)",
			);
		return found;
	} catch {
		warnings.push("render module unavailable: Chrome not checked");
		return null;
	}
}

async function pendingMetricsSafe(
	me: MeLocation,
	warnings: string[],
): Promise<number | null> {
	if (!me.exists) return 0;
	try {
		const metrics = await import("../me/metrics.js");
		return metrics.pendingMetricCount();
	} catch (e) {
		warnings.push(`pending metrics not counted: ${(e as Error).message}`);
		return null;
	}
}

export async function runDoctor(): Promise<DoctorReport> {
	const warnings: string[] = [];
	const me = meDir();
	if (!me.exists)
		warnings.push(`me/ workspace not found at ${me.path}; run \`jh me init\``);
	const db = dbPath();
	return {
		node: process.versions.node,
		nodeOk: nodeVersionOk(),
		home: jhHome(),
		me,
		meIgnored: checkMeIgnored(me.path, repoRoot(), warnings),
		db,
		dbOk: checkDb(db, warnings),
		chrome: await findChromeSafe(warnings),
		pendingMetrics: await pendingMetricsSafe(me, warnings),
		dataRepo: checkDataRepo(
			process.env.JOB_HUNTER_DATA_REPO,
			repoRoot(),
			warnings,
		),
		warnings,
	};
}

export function doctorExitCode(r: DoctorReport): 0 | 2 {
	return !r.nodeOk || r.meIgnored === false ? 2 : 0;
}

function formatReport(r: DoctorReport): string {
	const ok = (b: boolean | null) =>
		b === null ? "unknown" : b ? "ok" : "FAIL";
	return [
		`node     ${r.node} ${r.nodeOk ? "ok" : "needs >= 22.13"}`,
		`home     ${r.home}`,
		`me       ${r.me.path} (${r.me.source}${r.me.exists ? "" : ", missing"})`,
		`ignored  ${ok(r.meIgnored)}${r.meIgnored === false ? " - me/ is NOT git-ignored; personal data could be committed" : ""}`,
		`db       ${r.db} ${ok(r.dbOk)}`,
		`chrome   ${r.chrome ?? "not found"}`,
		`metrics  ${r.pendingMetrics ?? "?"} pending`,
		`data     ${r.dataRepo ? `${r.dataRepo.path} ${ok(r.dataRepo.ok)}` : "not configured (optional, ADR 006)"}`,
		...r.warnings.map((w) => `warning: ${w}`),
	].join("\n");
}

export function register(program: Command): void {
	program
		.command("doctor")
		.description("check node, paths, me/ privacy, database and Chrome")
		.option("--json", "machine-readable output")
		.action(
			action(async (opts: { json?: boolean }) => {
				const report = await runDoctor();
				emit(report, opts.json, formatReport);
				process.exitCode = doctorExitCode(report);
			}),
		);
}
