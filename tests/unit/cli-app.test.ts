import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PostedAtSchema,
	parseSince,
	parseStatuses,
	parseWhen,
	register,
} from "../../src/commands/app.js";
import {
	checkMeIgnored,
	doctorExitCode,
	nodeVersionOk,
	runDoctor,
} from "../../src/commands/doctor.js";
import { openDb } from "../../src/db/index.js";
import { setArtifactsDir } from "../../src/db/repo.js";

const ENV_KEYS = ["JOB_HUNTER_HOME", "JOB_HUNTER_DB", "JOB_HUNTER_ME"] as const;
const saved: Record<string, string | undefined> = {};
let tmp: string;
let out: string[];

beforeEach(() => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	tmp = mkdtempSync(join(tmpdir(), "jh-cli-"));
	process.env.JOB_HUNTER_HOME = join(tmp, "home");
	process.env.JOB_HUNTER_DB = join(tmp, "jh.db");
	process.env.JOB_HUNTER_ME = join(tmp, "me");
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

describe("jh app", () => {
	it("adds an external applied application and lists it", async () => {
		const added = (await jh(
			"app",
			"add",
			"--company",
			"Acme",
			"--title",
			"DE",
			"--status",
			"applied",
			"--source",
			"external",
			"--json",
		)) as { created: boolean; application: Record<string, unknown> };
		expect(process.exitCode ?? 0).toBe(0);
		expect(added.created).toBe(true);
		expect(added.application).toMatchObject({
			company: "Acme",
			title: "DE",
			status: "applied",
			source: "external",
		});
		expect(added.application.applied_at).toBeTruthy();

		const list = (await jh("app", "list", "--json")) as unknown[];
		expect(list).toHaveLength(1);

		const again = (await jh(
			"app",
			"add",
			"--company",
			"Acme Inc.",
			"--title",
			"DE",
			"--json",
		)) as {
			created: boolean;
		};
		expect(again.created).toBe(false);
		expect((await jh("app", "list", "--json")) as unknown[]).toHaveLength(1);
	});

	it("filters list by status, active and since", async () => {
		await jh("app", "add", "--company", "A", "--title", "X", "--json");
		await jh(
			"app",
			"add",
			"--company",
			"B",
			"--title",
			"Y",
			"--status",
			"rejected",
			"--json",
		);
		expect(
			(await jh(
				"app",
				"list",
				"--status",
				"shortlisted",
				"--json",
			)) as unknown[],
		).toHaveLength(1);
		expect(
			(await jh("app", "list", "--active", "--json")) as unknown[],
		).toHaveLength(1);
		expect(
			(await jh(
				"app",
				"list",
				"--since",
				"30d",
				"--limit",
				"5",
				"--json",
			)) as unknown[],
		).toHaveLength(2);
		const bad = (await jh("app", "list", "--status", "nope", "--json")) as {
			error: string;
		};
		expect(bad.error).toBe("validation");
		expect(process.exitCode).toBe(2);
	});

	it("an illegal transition sets exitCode 3 with a JSON error", async () => {
		const added = (await jh(
			"app",
			"add",
			"--company",
			"Acme",
			"--title",
			"DE",
			"--json",
		)) as {
			application: { id: number };
		};
		const err = (await jh(
			"app",
			"transition",
			String(added.application.id),
			"offer",
			"--json",
		)) as {
			error: string;
			details: unknown;
		};
		expect(process.exitCode).toBe(3);
		expect(err.error).toBe("illegal_transition");
		expect(err.details).toMatchObject({ from: "shortlisted", to: "offer" });
	});

	it("transition to applied reads factcheck.json", async () => {
		const added = (await jh(
			"app",
			"add",
			"--company",
			"Acme",
			"--title",
			"DE",
			"--json",
		)) as {
			application: { id: number };
		};
		const id = added.application.id;
		await jh(
			"app",
			"transition",
			String(id),
			"tailored",
			"--actor",
			"resume-writer",
			"--json",
		);
		const dir = join(tmp, "artifacts", String(id));
		mkdirSync(dir, { recursive: true });
		const db = openDb();
		setArtifactsDir(db, id, dir);
		db.close();

		writeFileSync(
			join(dir, "factcheck.json"),
			JSON.stringify({ reviewer: "fact-checker", verdict: "fail" }),
		);
		await jh("app", "transition", String(id), "applied", "--json");
		expect(process.exitCode).toBe(3);

		process.exitCode = undefined;
		writeFileSync(
			join(dir, "factcheck.json"),
			JSON.stringify({ reviewer: "fact-checker", verdict: "pass" }),
		);
		const ok = (await jh(
			"app",
			"transition",
			String(id),
			"applied",
			"--note",
			"submitted",
			"--json",
		)) as {
			changed: boolean;
		};
		expect(process.exitCode ?? 0).toBe(0);
		expect(ok.changed).toBe(true);

		const shown = (await jh("app", "show", String(id), "--json")) as {
			events: unknown[];
		};
		expect(shown.events).toHaveLength(3);
	});

	it("show of a missing id exits 1 with not_found", async () => {
		const err = (await jh("app", "show", "42", "--json")) as { error: string };
		expect(err.error).toBe("not_found");
		expect(process.exitCode).toBe(1);
	});

	it("ghost-sweep reports moved ids", async () => {
		await jh(
			"app",
			"add",
			"--company",
			"Old",
			"--title",
			"DE",
			"--source",
			"external",
			"--applied-at",
			"2020-01-01",
			"--json",
		);
		const r = (await jh("app", "ghost-sweep", "--json")) as {
			ghosted: number[];
			days: number;
		};
		expect(r.days).toBe(21);
		expect(r.ghosted).toHaveLength(1);
	});

	it("stores --posted-at on the job and updates it with set-posted", async () => {
		const added = (await jh(
			"app",
			"add",
			"--company",
			"Acme",
			"--title",
			"DE",
			"--posted-at",
			"2024-03-05",
			"--json",
		)) as { application: { id: number; job_id: number } };
		const postedOf = () => {
			const db = openDb();
			try {
				return (
					db
						.prepare("SELECT posted_at FROM jobs WHERE id = ?")
						.get(added.application.job_id) as { posted_at: string | null }
				).posted_at;
			} finally {
				db.close();
			}
		};
		expect(postedOf()).toBe("2024-03-05T12:00:00.000Z");

		const r = (await jh(
			"app",
			"set-posted",
			String(added.application.id),
			"2024-04-01T08:00:00Z",
			"--json",
		)) as { posted_at: string };
		expect(r.posted_at).toBe("2024-04-01T08:00:00.000Z");
		expect(postedOf()).toBe("2024-04-01T08:00:00.000Z");
	});

	it("rejects an invalid or future --posted-at", async () => {
		await jh(
			"app",
			"add",
			"--company",
			"Acme",
			"--title",
			"DE",
			"--posted-at",
			"not-a-date",
			"--json",
		).catch(() => null);
		expect(process.exitCode ?? 0).not.toBe(0);
		expect(PostedAtSchema.safeParse("2999-01-01").success).toBe(false);
		expect(PostedAtSchema.safeParse("2024-03-05").success).toBe(true);
	});
});

describe("app input parsing", () => {
	it("parses dates, relative windows and status lists", () => {
		expect(parseWhen("2024-03-05")).toBe("2024-03-05T12:00:00.000Z");
		expect(() => parseWhen("yesterday-ish")).toThrow(/invalid date/);
		const now = new Date("2030-01-31T00:00:00.000Z");
		expect(parseSince("30d", now)).toBe("2030-01-01T00:00:00.000Z");
		expect(parseSince("1w", now)).toBe("2030-01-24T00:00:00.000Z");
		expect(parseStatuses("applied, offer")).toEqual(["applied", "offer"]);
		expect(() => parseStatuses("applied,bogus")).toThrow(/bogus/);
	});
});

describe("jh doctor", () => {
	it("checks node versions", () => {
		expect(nodeVersionOk("22.13.0")).toBe(true);
		expect(nodeVersionOk("22.12.9")).toBe(false);
		expect(nodeVersionOk("24.0.0")).toBe(true);
	});

	it("treats a me/ outside the checkout as ignored", () => {
		const w: string[] = [];
		expect(checkMeIgnored(join(tmp, "me"), join(tmp, "repo"), w)).toBe(true);
		expect(checkMeIgnored(join(tmp, "me"), null, w)).toBe(true);
		expect(w).toEqual([]);
	});

	it("returns null with a warning when git cannot answer", () => {
		const repo = join(tmp, "norepo");
		mkdirSync(join(repo, "me"), { recursive: true });
		const w: string[] = [];
		const r = checkMeIgnored(join(repo, "me"), repo, w);
		if (r === null) expect(w.length).toBe(1);
		else expect(typeof r).toBe("boolean");
	});

	it("reports the environment and a healthy db", async () => {
		const r = await runDoctor();
		expect(r.home).toBe(join(tmp, "home"));
		expect(r.me).toEqual({
			path: join(tmp, "me"),
			source: "env",
			exists: false,
		});
		expect(r.meIgnored).toBe(true);
		expect(r.db).toBe(join(tmp, "jh.db"));
		expect(r.dbOk).toBe(true);
		expect(r.pendingMetrics).toBe(0);
		expect(doctorExitCode(r)).toBe(r.nodeOk ? 0 : 2);
		expect(doctorExitCode({ ...r, nodeOk: true, meIgnored: false })).toBe(2);
		expect(doctorExitCode({ ...r, nodeOk: true, meIgnored: null })).toBe(0);
	});
});
