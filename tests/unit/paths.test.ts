import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	artifactsDir,
	dbPath,
	ensureDir,
	inboxDir,
	jhHome,
	logsDir,
	meDir,
	mePaths,
	mePathsFor,
	repoRoot,
} from "../../src/core/paths.js";

const ENV_KEYS = ["JOB_HUNTER_HOME", "JOB_HUNTER_ME", "JOB_HUNTER_DB"] as const;

let tmp: string;
let home: string;
let repo: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	tmp = mkdtempSync(join(tmpdir(), "jh-paths-"));
	home = join(tmp, "home");
	repo = join(tmp, "repo");
	mkdirSync(home, { recursive: true });
	mkdirSync(join(repo, ".claude-plugin"), { recursive: true });
	writeFileSync(join(repo, ".claude-plugin", "plugin.json"), "{}");
	process.env.JOB_HUNTER_HOME = home;
	delete process.env.JOB_HUNTER_ME;
	delete process.env.JOB_HUNTER_DB;
});

afterEach(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(tmp, { recursive: true, force: true });
});

describe("jhHome", () => {
	it("uses JOB_HUNTER_HOME", () => {
		expect(jhHome()).toBe(resolve(home));
	});
	it("defaults to ~/.job-hunter", () => {
		delete process.env.JOB_HUNTER_HOME;
		expect(jhHome().endsWith(".job-hunter")).toBe(true);
	});
});

describe("repoRoot", () => {
	it("finds the dir with .claude-plugin/plugin.json without needing .git", () => {
		const deep = join(repo, "dist", "x");
		mkdirSync(deep, { recursive: true });
		expect(repoRoot(deep)).toBe(resolve(repo));
	});
	it("returns null when no manifest is above", () => {
		expect(repoRoot(home)).toBeNull();
	});
	it("detects this checkout from the module location", () => {
		expect(repoRoot()).not.toBeNull();
	});
});

describe("meDir resolution order", () => {
	it("prefers JOB_HUNTER_ME over everything", () => {
		mkdirSync(join(repo, "me"));
		mkdirSync(join(home, "me"));
		const envMe = join(tmp, "elsewhere");
		process.env.JOB_HUNTER_ME = envMe;
		expect(meDir({ repo })).toEqual({
			path: resolve(envMe),
			source: "env",
			exists: false,
		});
	});

	it("uses <repo>/me when it exists", () => {
		mkdirSync(join(repo, "me"));
		mkdirSync(join(home, "me"));
		expect(meDir({ repo })).toEqual({
			path: join(repo, "me"),
			source: "repo",
			exists: true,
		});
	});

	it("falls back to <home>/me when the repo has no me/", () => {
		mkdirSync(join(home, "me"));
		expect(meDir({ repo })).toEqual({
			path: join(resolve(home), "me"),
			source: "home",
			exists: true,
		});
	});

	it("uses legacy home files when no me/ exists", () => {
		writeFileSync(join(home, "resume.yaml"), "x: 1");
		expect(meDir({ repo })).toEqual({
			path: resolve(home),
			source: "legacy",
			exists: true,
		});
	});

	it("reports a missing <home>/me when nothing exists", () => {
		expect(meDir({ repo: null })).toEqual({
			path: join(resolve(home), "me"),
			source: "home",
			exists: false,
		});
	});
});

describe("mePaths", () => {
	it("returns every well-known key under the root", () => {
		const root = join(tmp, "ws");
		const p = mePaths(root);
		expect(Object.keys(p).sort()).toEqual(
			[
				"root",
				"readme",
				"profile",
				"preferences",
				"targets",
				"sampleResumeDir",
				"experienceDir",
				"storiesDir",
				"masterResume",
				"confirmedMetrics",
				"metricsMd",
				"intakeDir",
				"cacheDir",
			].sort(),
		);
		expect(p.root).toBe(resolve(root));
		expect(p.readme).toBe(join(resolve(root), "README.md"));
		expect(p.masterResume).toBe(join(resolve(root), "master-resume.yaml"));
		expect(p.confirmedMetrics).toBe(
			join(resolve(root), "confirmed-metrics.yaml"),
		);
		expect(p.sampleResumeDir).toBe(join(resolve(root), "sample-resume"));
		expect(p.intakeDir).toBe(join(resolve(root), ".intake"));
		expect(p.cacheDir).toBe(join(resolve(root), ".cache"));
	});

	it("defaults to meDir()", () => {
		process.env.JOB_HUNTER_ME = join(tmp, "ws");
		expect(mePaths().root).toBe(resolve(join(tmp, "ws")));
		expect(mePaths().profile).toBe(
			join(resolve(join(tmp, "ws")), "profile.yaml"),
		);
	});

	it("maps a legacy workspace to <home>/profile.yaml and <home>/resume.yaml", () => {
		writeFileSync(join(home, "profile.yaml"), "x: 1");
		const loc = meDir({ repo: null });
		expect(loc.source).toBe("legacy");
		const p = mePathsFor(loc);
		expect(p.profile).toBe(join(resolve(home), "profile.yaml"));
		expect(p.masterResume).toBe(join(resolve(home), "resume.yaml"));
		expect(p.metricsMd).toBe(join(resolve(home), "metrics.md"));
	});
});

describe("machine paths", () => {
	it("dbPath honours JOB_HUNTER_DB, else <home>/jh.db", () => {
		expect(dbPath()).toBe(join(resolve(home), "jh.db"));
		const custom = join(tmp, "custom.db");
		process.env.JOB_HUNTER_DB = custom;
		expect(dbPath()).toBe(resolve(custom));
		process.env.JOB_HUNTER_DB = ":memory:";
		expect(dbPath()).toBe(":memory:");
	});

	it("artifacts, inbox and logs live under home", () => {
		const h = resolve(home);
		expect(artifactsDir()).toBe(join(h, "artifacts"));
		expect(artifactsDir(7)).toBe(join(h, "artifacts", "7"));
		expect(inboxDir()).toBe(join(h, "inbox"));
		expect(logsDir()).toBe(join(h, "logs"));
	});

	it("ensureDir creates nested dirs and returns the path", () => {
		const p = join(tmp, "a", "b", "c");
		expect(ensureDir(p)).toBe(p);
		expect(ensureDir(p)).toBe(p);
	});
});
