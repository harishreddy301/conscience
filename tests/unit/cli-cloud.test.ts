import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codeRepoRootOrFail, register } from "../../src/commands/cloud.js";
import { checkDataRepo } from "../../src/commands/doctor.js";

const ENV_KEYS = [
	"JOB_HUNTER_HOME",
	"JOB_HUNTER_DB",
	"JOB_HUNTER_ME",
	"JOB_HUNTER_DATA_REPO",
] as const;
const saved: Record<string, string | undefined> = {};
let tmp: string;
let out: string[];

beforeEach(() => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	tmp = mkdtempSync(join(tmpdir(), "jh-cli-cloud-"));
	process.env.JOB_HUNTER_HOME = join(tmp, "home");
	process.env.JOB_HUNTER_DB = join(tmp, "jh.db");
	process.env.JOB_HUNTER_ME = join(tmp, "me");
	delete process.env.JOB_HUNTER_DATA_REPO;
	process.exitCode = undefined;
	out = [];
	vi.spyOn(process.stdout, "write").mockImplementation(
		(chunk: string | Uint8Array) => {
			out.push(String(chunk));
			return true;
		},
	);
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = undefined;
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(tmp, { recursive: true, force: true });
});

async function jh(...argv: string[]): Promise<unknown> {
	out = [];
	const program = new Command().exitOverride();
	register(program);
	await program.parseAsync(argv, { from: "user" });
	const last = out.join("").trim().split("\n").at(-1) ?? "null";
	return JSON.parse(last);
}

describe("jh cloud", () => {
	it("export without JOB_HUNTER_DATA_REPO exits 1", async () => {
		const r = (await jh("cloud", "export", "--queue", "2", "--json")) as {
			error: string;
			message: string;
		};
		expect(process.exitCode).toBe(1);
		expect(r.message).toContain("set JOB_HUNTER_DATA_REPO (see ADR 006)");
	});

	it("import without JOB_HUNTER_DATA_REPO exits 1", async () => {
		await jh("cloud", "import", "p-20261022-0905", "--json");
		expect(process.exitCode).toBe(1);
	});

	it("status lists packets with their results", async () => {
		const data = join(tmp, "data");
		process.env.JOB_HUNTER_DATA_REPO = data;
		for (const id of ["p-20261022-0905", "p-20261023-1000"]) {
			mkdirSync(join(data, "packets", id), { recursive: true });
			writeFileSync(
				join(data, "packets", id, "packet.json"),
				JSON.stringify({
					id,
					created_at: "2026-10-22T09:05:00.000Z",
					schema_version: 4,
					apps: [
						{
							app_id: 1,
							company: "Acme",
							title: "Data Engineer",
							url: null,
							jd_path: "jd/1.txt",
						},
					],
				}),
			);
		}
		mkdirSync(join(data, "results", "p-20261022-0905"), { recursive: true });

		const r = (await jh("cloud", "status", "--json")) as {
			packets: {
				id: string;
				apps: number;
				has_results: boolean;
				imported: boolean;
			}[];
		};
		expect(process.exitCode ?? 0).toBe(0);
		expect(r.packets).toEqual([
			{ id: "p-20261022-0905", apps: 1, has_results: true, imported: false },
			{ id: "p-20261023-1000", apps: 1, has_results: false, imported: false },
		]);
	});
});

describe("jh cloud status with a corrupt packet", () => {
	it("reports the corrupt packet instead of failing", async () => {
		const data = join(tmp, "data");
		process.env.JOB_HUNTER_DATA_REPO = data;
		mkdirSync(join(data, "packets", "p-20261022-0905"), { recursive: true });
		writeFileSync(
			join(data, "packets", "p-20261022-0905", "packet.json"),
			"{not json",
		);
		mkdirSync(join(data, "packets", "p-20261022-0906"), { recursive: true });
		writeFileSync(
			join(data, "packets", "p-20261022-0906", "packet.json"),
			JSON.stringify({ id: "p-20261022-0906", apps: "nope" }),
		);
		mkdirSync(join(data, "results", "p-20261022-0906"), { recursive: true });
		writeFileSync(
			join(data, "results", "p-20261022-0906", "summary.json"),
			"{",
		);
		const r = (await jh("cloud", "status", "--json")) as {
			packets: { id: string; apps: number; error?: string }[];
		};
		expect(process.exitCode ?? 0).toBe(0);
		expect(r.packets.map((p) => p.id)).toEqual([
			"p-20261022-0905",
			"p-20261022-0906",
		]);
		for (const p of r.packets) {
			expect(p.apps).toBe(0);
			expect(p.error).toMatch(/packet\.json/);
		}
	});
});

describe("codeRepoRootOrFail", () => {
	it("fails closed when the code repo cannot be located", () => {
		expect(() => codeRepoRootOrFail(null)).toThrow(/code repo/);
		expect(codeRepoRootOrFail(tmp)).toBe(tmp);
	});
});

describe("doctor data repo check", () => {
	it("is null when JOB_HUNTER_DATA_REPO is unset", () => {
		expect(checkDataRepo(undefined, tmp, [])).toBeNull();
	});

	it("fails a missing clone or one inside the code repo", () => {
		const warnings: string[] = [];
		expect(
			checkDataRepo(join(tmp, "nope"), join(tmp, "code"), warnings),
		).toEqual({ path: join(tmp, "nope"), ok: false });
		const inside = join(tmp, "code", "conscience-data");
		mkdirSync(join(inside, ".git"), { recursive: true });
		expect(checkDataRepo(inside, join(tmp, "code"), warnings)?.ok).toBe(false);
		expect(warnings).toHaveLength(2);
	});

	it("passes a git clone outside the code repo", () => {
		const data = join(tmp, "data");
		mkdirSync(join(data, ".git"), { recursive: true });
		expect(checkDataRepo(data, join(tmp, "code"), [])?.ok).toBe(true);
	});
});
