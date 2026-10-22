import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type MeSource = "env" | "repo" | "home" | "legacy";

export interface MeLocation {
	path: string;
	source: MeSource;
	exists: boolean;
}

export interface MePaths {
	root: string;
	readme: string;
	profile: string;
	preferences: string;
	targets: string;
	sampleResumeDir: string;
	experienceDir: string;
	storiesDir: string;
	masterResume: string;
	confirmedMetrics: string;
	metricsMd: string;
	intakeDir: string;
	cacheDir: string;
}

const PLUGIN_MANIFEST = join(".claude-plugin", "plugin.json");
const LEGACY_PROFILE = "profile.yaml";
const LEGACY_RESUME = "resume.yaml";

/** Machine state root: JOB_HUNTER_HOME or ~/.job-hunter. */
export function jhHome(): string {
	return resolve(process.env.JOB_HUNTER_HOME || join(homedir(), ".job-hunter"));
}

/**
 * The plugin checkout this code runs from: the nearest ancestor of `start`
 * (default: this module's own directory) containing .claude-plugin/plugin.json.
 * Detection uses the manifest alone, so it works without git.
 */
export function repoRoot(start?: string): string | null {
	let dir = resolve(start ?? dirname(fileURLToPath(import.meta.url)));
	for (;;) {
		if (existsSync(join(dir, PLUGIN_MANIFEST))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function hasLegacyFiles(home: string): boolean {
	return (
		existsSync(join(home, LEGACY_PROFILE)) ||
		existsSync(join(home, LEGACY_RESUME))
	);
}

/**
 * Resolve the personal workspace, in order:
 * JOB_HUNTER_ME -> <repoRoot>/me -> <jhHome>/me -> legacy files in jhHome
 * -> <jhHome>/me (not yet created).
 * `o.repo` overrides repo detection (null disables it); used by tests.
 */
export function meDir(o: { repo?: string | null } = {}): MeLocation {
	const fromEnv = process.env.JOB_HUNTER_ME;
	if (fromEnv) {
		const path = resolve(fromEnv);
		return { path, source: "env", exists: existsSync(path) };
	}
	const repo = o.repo === undefined ? repoRoot() : o.repo;
	if (repo) {
		const path = join(repo, "me");
		if (existsSync(path)) return { path, source: "repo", exists: true };
	}
	const home = jhHome();
	const homeMe = join(home, "me");
	if (existsSync(homeMe)) return { path: homeMe, source: "home", exists: true };
	if (hasLegacyFiles(home))
		return { path: home, source: "legacy", exists: true };
	return { path: homeMe, source: "home", exists: false };
}

function pathsUnder(root: string): MePaths {
	return {
		root,
		readme: join(root, "README.md"),
		profile: join(root, "profile.yaml"),
		preferences: join(root, "preferences.md"),
		targets: join(root, "targets.md"),
		sampleResumeDir: join(root, "sample-resume"),
		experienceDir: join(root, "experience"),
		storiesDir: join(root, "stories"),
		masterResume: join(root, "master-resume.yaml"),
		confirmedMetrics: join(root, "confirmed-metrics.yaml"),
		metricsMd: join(root, "metrics.md"),
		intakeDir: join(root, ".intake"),
		cacheDir: join(root, ".cache"),
	};
}

/**
 * Well-known files of the me/ workspace. With no `root`, uses meDir(); a legacy
 * workspace maps profile and master resume to <jhHome>/profile.yaml and resume.yaml.
 */
export function mePaths(root?: string): MePaths {
	if (root !== undefined) return pathsUnder(resolve(root));
	return mePathsFor(meDir());
}

/** mePaths for a resolved location (legacy-aware). */
export function mePathsFor(loc: MeLocation): MePaths {
	const paths = pathsUnder(loc.path);
	if (loc.source !== "legacy") return paths;
	return {
		...paths,
		profile: join(loc.path, LEGACY_PROFILE),
		masterResume: join(loc.path, LEGACY_RESUME),
	};
}

/** SQLite file: JOB_HUNTER_DB or <jhHome>/jh.db. */
export function dbPath(): string {
	const fromEnv = process.env.JOB_HUNTER_DB;
	if (fromEnv) return fromEnv === ":memory:" ? fromEnv : resolve(fromEnv);
	return join(jhHome(), "jh.db");
}

/** <jhHome>/artifacts, or <jhHome>/artifacts/<appId>. */
export function artifactsDir(appId?: number): string {
	const base = join(jhHome(), "artifacts");
	return appId === undefined ? base : join(base, String(appId));
}

export function inboxDir(): string {
	return join(jhHome(), "inbox");
}

export function logsDir(): string {
	return join(jhHome(), "logs");
}

/** mkdir -p; returns the path unchanged. */
export function ensureDir(p: string): string {
	mkdirSync(p, { recursive: true });
	return p;
}
