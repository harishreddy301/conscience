import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { vi } from "vitest";
import { type MePaths, mePaths } from "../../../src/core/paths.js";
import type { IntakeDraft } from "../../../src/me/schema.js";

export const FIXTURES = dirname(fileURLToPath(import.meta.url));

export interface TempWorkspace {
	base: string;
	home: string;
	me: string;
	paths: MePaths;
	cleanup: () => void;
}

const ENV_KEYS = ["JOB_HUNTER_HOME", "JOB_HUNTER_ME", "JOB_HUNTER_DB"] as const;

/** Isolated JOB_HUNTER_HOME + JOB_HUNTER_ME under the OS temp dir; restores env on cleanup. */
export function tempWorkspace(): TempWorkspace {
	const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
	const base = mkdtempSync(join(tmpdir(), "jh-me-"));
	const home = join(base, "home");
	const me = join(base, "me");
	mkdirSync(home, { recursive: true });
	mkdirSync(me, { recursive: true });
	process.env.JOB_HUNTER_HOME = home;
	process.env.JOB_HUNTER_ME = me;
	process.env.JOB_HUNTER_DB = ":memory:";
	return {
		base,
		home,
		me,
		paths: mePaths(me),
		cleanup: () => {
			for (const k of ENV_KEYS) {
				const v = saved[k];
				if (v === undefined) delete process.env[k];
				else process.env[k] = v;
			}
			rmSync(base, { recursive: true, force: true });
		},
	};
}

export function loadDraft(): IntakeDraft {
	return JSON.parse(
		readFileSync(join(FIXTURES, "intake-draft.fixture.json"), "utf8"),
	) as IntakeDraft;
}

export interface CliRun {
	stdout: string;
	exitCode: number;
	json: () => unknown;
}

/** Run one registered command in-process and capture stdout and the exit code. */
export async function runCli(
	register: (p: Command) => void,
	argv: string[],
): Promise<CliRun> {
	const program = new Command().exitOverride();
	register(program);
	let stdout = "";
	const spy = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: string | Uint8Array) => {
			stdout +=
				typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
			return true;
		});
	const errSpy = vi
		.spyOn(process.stderr, "write")
		.mockImplementation(() => true);
	const before = process.exitCode;
	process.exitCode = 0;
	try {
		await program.parseAsync(argv, { from: "user" });
	} finally {
		spy.mockRestore();
		errSpy.mockRestore();
	}
	const exitCode = Number(process.exitCode ?? 0);
	process.exitCode = before;
	return {
		stdout,
		exitCode,
		json: () => JSON.parse(stdout.trim().split("\n").pop() ?? "null"),
	};
}
