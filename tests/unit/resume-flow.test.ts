import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Rendering PDFs needs Chrome; stub renderAll with the real HTML/text/DOCX
// writers plus a placeholder PDF so the flow is deterministic everywhere.
vi.mock("../../src/render/index.js", async (importOriginal) => {
	const real =
		await importOriginal<typeof import("../../src/render/index.js")>();
	return {
		...real,
		renderAll: vi.fn(
			async (
				r: Parameters<typeof real.renderAll>[0],
				outDir: string,
				formats: string[],
			) => {
				mkdirSync(outDir, { recursive: true });
				const base = join(outDir, real.resumeBaseName(r));
				const files: Record<string, string> = {};
				const write = async (
					fmt: string,
					body: () => string | Promise<Buffer>,
				) => {
					if (!formats.includes(fmt)) return;
					files[fmt] = `${base}.${fmt}`;
					writeFileSync(files[fmt], await body());
				};
				await write("html", () => real.renderHtml(r));
				await write("txt", () => real.renderText(r));
				await write("docx", () => real.renderDocx(r));
				await write("pdf", () => "%PDF-1.4 stub");
				return { files, pages: 1, density: 0, warnings: [] };
			},
		),
		// The layout gate needs Chrome; tests drive its verdict directly.
		layoutGate: vi.fn(async () => layoutVerdict.current),
	};
});

const PASSING_LAYOUT = {
	pass: true,
	spec: {},
	pages: 2,
	pages_sim: 2,
	last_page_fill: 0.92,
	failures: [],
	warnings: [],
	bullets: [],
};
const layoutVerdict: { current: Record<string, unknown> } = vi.hoisted(() => ({
	current: {},
}));
layoutVerdict.current = PASSING_LAYOUT;

import { register as registerAts } from "../../src/commands/ats.js";
import { register as registerResume } from "../../src/commands/resume.js";
import { type Db, openDb } from "../../src/db/index.js";
import { getVariant } from "../../src/db/learn.js";
import { getApplication } from "../../src/db/repo.js";
import { getRun, latestFinalRun, listDrafts } from "../../src/db/resume.js";
import { FRAMINGS } from "../../src/learn/features.js";
import { RECRUITER_CHECK_IDS } from "../../src/resume/review.js";
import { fixturePath } from "../fixtures/resume/fixtures.js";

const ENV_KEYS = ["JOB_HUNTER_HOME", "JOB_HUNTER_ME", "JOB_HUNTER_DB"] as const;
const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> =
	{};
let root: string;

/** Run `jh <args> --json` in-process; returns parsed stdout and the exit code. */
// biome-ignore lint/suspicious/noExplicitAny: CLI JSON output is asserted field by field
async function jh(...args: string[]): Promise<{ out: any; code: number }> {
	const program = new Command().exitOverride();
	registerResume(program);
	registerAts(program);
	let stdout = "";
	const spy = vi
		.spyOn(process.stdout, "write")
		.mockImplementation((chunk: unknown) => {
			stdout += String(chunk);
			return true;
		});
	process.exitCode = 0;
	try {
		await program.parseAsync(["node", "jh", ...args, "--json"]);
	} finally {
		spy.mockRestore();
	}
	const code = Number(process.exitCode ?? 0);
	process.exitCode = 0;
	return {
		out: stdout.trim()
			? JSON.parse(stdout.trim().split("\n").pop() as string)
			: null,
		code,
	};
}

function withDb<T>(fn: (db: Db) => T): T {
	const db = openDb();
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

function writeJson(path: string, data: unknown): string {
	writeFileSync(path, JSON.stringify(data, null, 2));
	return path;
}

beforeAll(() => {
	for (const k of ENV_KEYS) saved[k] = process.env[k];
	root = mkdtempSync(join(tmpdir(), "jh-resume-flow-"));
	const me = join(root, "me");
	mkdirSync(me, { recursive: true });
	copyFileSync(
		fixturePath("master-resume.fixture.yaml"),
		join(me, "master-resume.yaml"),
	);
	copyFileSync(fixturePath("profile.fixture.yaml"), join(me, "profile.yaml"));
	process.env.JOB_HUNTER_HOME = join(root, "home");
	process.env.JOB_HUNTER_ME = me;
	delete process.env.JOB_HUNTER_DB;
});

afterAll(() => {
	for (const k of ENV_KEYS) {
		if (saved[k] === undefined) delete process.env[k];
		else process.env[k] = saved[k];
	}
	rmSync(root, { recursive: true, force: true });
});

describe("jh resume flow", () => {
	let runId: string;
	let appId: number;
	let workdir: string;
	let draftPath: string;
	const draftId = "impact-1";

	it("prepare creates company, job, application and run", async () => {
		const { out, code } = await jh(
			"resume",
			"prepare",
			"--jd",
			fixturePath("jd.fixture.txt"),
			"--company",
			"Initech",
			"--title",
			"Senior Data Engineer",
			"--url",
			"https://jobs.example.com/initech/123",
		);
		expect(code).toBe(0);
		runId = out.run_id;
		appId = out.app_id;
		workdir = out.workdir;
		expect(out.pending_estimates).toBe(1);
		expect(existsSync(out.jd_path)).toBe(true);
		expect(workdir).toContain(join("artifacts", String(appId), "runs", runId));
		withDb((db) => {
			const app = getApplication(db, appId);
			expect(app?.company).toBe("Initech");
			expect(app?.status).toBe("shortlisted");
			expect(getRun(db, runId)?.status).toBe("running");
		});
	});

	it("ats keywords set stores keywords on the run", async () => {
		const { out, code } = await jh(
			"ats",
			"keywords",
			"set",
			runId,
			"--file",
			fixturePath("keywords.fixture.json"),
		);
		expect(code).toBe(0);
		expect(out.required).toBe(5);
		expect(existsSync(join(workdir, "keywords.json"))).toBe(true);
	});

	it("validate passes and registers the draft", async () => {
		const draft = JSON.parse(
			readFileSync(fixturePath("tailored.fixture.json"), "utf8"),
		);
		draft.run_id = runId;
		draft.job.app_id = appId;
		draftPath = writeJson(join(workdir, `draft-${draftId}.json`), draft);
		const { out, code } = await jh("resume", "validate", draftPath);
		expect(code).toBe(0);
		expect(out.ok).toBe(true);
		expect(out.registered).toBe(true);
		expect(out.ats).toBeGreaterThanOrEqual(80);
		withDb((db) =>
			expect(listDrafts(db, runId).map((d) => d.id)).toEqual([draftId]),
		);
	});

	it("validate exits 2 for an invalid draft", async () => {
		const bad = JSON.parse(readFileSync(draftPath, "utf8"));
		bad.draft_id = "bad-1";
		bad.experience[0].title = "Chief Data Officer";
		const { out, code } = await jh(
			"resume",
			"validate",
			writeJson(join(workdir, "draft-bad-1.json"), bad),
		);
		expect(code).toBe(2);
		expect(out.errors[0].code).toBe("FIXED_FACT_CHANGED");
	});

	it("review add x3, then the gate passes", async () => {
		const reviews = [
			{
				reviewer: "hiring-manager",
				draft_id: draftId,
				verdict: "interview",
				score: 86,
				findings: [],
				top_fixes: [],
			},
			{
				reviewer: "recruiter-screen",
				draft_id: draftId,
				verdict: "pass",
				score: 88,
				findings: [
					{
						severity: "minor",
						issue: "headline is long",
						fix: "trim headline",
					},
				],
				top_fixes: ["trim headline"],
				checks: RECRUITER_CHECK_IDS.map((id, i) => ({ id, pass: i !== 4 })),
			},
			{
				reviewer: "ats-screener",
				draft_id: draftId,
				verdict: "pass",
				score: 90,
				findings: [],
				top_fixes: [],
			},
		];
		for (const [i, r] of reviews.entries()) {
			const { out, code } = await jh(
				"resume",
				"review",
				"add",
				runId,
				"--file",
				writeJson(join(root, `review-${i}.json`), r),
			);
			expect(code).toBe(0);
			expect(out.reviewer).toBe(r.reviewer);
		}
		const { out, code } = await jh("resume", "gate", runId, "--draft", draftId);
		expect(code).toBe(0);
		expect(out.reasons).toEqual([]);
		expect(out).toMatchObject({
			pass: true,
			hm_verdict: "interview",
			recruiter_passes: 7,
			valid: true,
			factcheck: "none",
		});
		expect(out.ats).toBeGreaterThanOrEqual(80);
	});

	it("review add rejects a reviewer/verdict mismatch", async () => {
		const bad = {
			reviewer: "fact-checker",
			draft_id: draftId,
			verdict: "interview",
			score: 50,
			findings: [],
			top_fixes: [],
		};
		const { out, code } = await jh(
			"resume",
			"review",
			"add",
			runId,
			"--file",
			writeJson(join(root, "review-bad.json"), bad),
		);
		expect(code).toBe(2);
		expect(out.error).toBe("invalid_review");
	});

	it("finalize refuses without a fact-checker pass (exit 2)", async () => {
		const { out, code } = await jh(
			"resume",
			"finalize",
			runId,
			"--draft",
			draftId,
		);
		expect(code).toBe(2);
		expect(out.error).toBe("factcheck_required");
		withDb((db) =>
			expect(getApplication(db, appId)?.status).toBe("shortlisted"),
		);
	});

	it("finalize refuses a resume that fails the layout gate (1 page, 1 bullet)", async () => {
		const fc = {
			reviewer: "fact-checker",
			draft_id: draftId,
			verdict: "pass",
			score: 100,
			findings: [],
			top_fixes: [],
		};
		await jh(
			"resume",
			"review",
			"add",
			runId,
			"--file",
			writeJson(join(root, "fc-layout.json"), fc),
		);
		layoutVerdict.current = {
			...PASSING_LAYOUT,
			pass: false,
			pages: 1,
			failures: [
				{
					code: "PAGE_COUNT",
					path: "$",
					message: "1 page(s); the spec needs exactly 2",
				},
				{
					code: "ROLE_BULLETS",
					path: "acme",
					message: "1 bullet(s); the spec needs 8",
				},
			],
		};
		try {
			const { out, code } = await jh(
				"resume",
				"finalize",
				runId,
				"--draft",
				draftId,
			);
			expect(code).toBe(2);
			expect(out.error).toBe("layout_gate_failed");
			withDb((db) => {
				expect(getApplication(db, appId)?.status).toBe("shortlisted");
				expect(getRun(db, runId)?.status).toBe("running");
			});
		} finally {
			layoutVerdict.current = PASSING_LAYOUT;
		}
	});

	it("finalize with a fact-checker pass writes artifacts and marks the app tailored", async () => {
		const fc = {
			reviewer: "fact-checker",
			draft_id: draftId,
			verdict: "pass",
			score: 100,
			findings: [],
			top_fixes: [],
		};
		expect(
			(
				await jh(
					"resume",
					"review",
					"add",
					runId,
					"--file",
					writeJson(join(root, "fc.json"), fc),
				)
			).code,
		).toBe(0);
		const { out, code } = await jh(
			"resume",
			"finalize",
			runId,
			"--draft",
			draftId,
		);
		expect(code).toBe(0);
		expect(out.quality).toBe("ok");
		expect(out.status).toBe("tailored");
		const dir = out.artifacts_dir as string;
		for (const f of [
			"resume.json",
			"resume.html",
			"resume.txt",
			"resume.pdf",
			"resume.docx",
			"provenance.json",
			"ats.json",
			"review.json",
			"factcheck.json",
		])
			expect(existsSync(join(dir, f)), f).toBe(true);
		expect(existsSync(join(dir, "Jordan_Rivera_Resume_Initech.pdf"))).toBe(
			true,
		);
		const prov = JSON.parse(readFileSync(join(dir, "provenance.json"), "utf8"));
		expect(prov["acme-analytics-2021.b01#t1"]).toEqual([
			"acme-analytics-2021.b01",
		]);
		expect(
			JSON.parse(readFileSync(join(dir, "factcheck.json"), "utf8")).verdict,
		).toBe("pass");
		withDb((db) => {
			const app = getApplication(db, appId);
			expect(app?.status).toBe("tailored");
			expect(app?.artifacts_dir).toBe(dir);
			expect(latestFinalRun(db, appId)).toMatchObject({
				run_id: runId,
				quality: "ok",
				hm_verdict: "interview",
			});
			const v = getVariant(db, appId);
			expect(v?.angle).toBe("impact");
			expect(v?.role_family).toBe("data");
			expect(FRAMINGS).toContain(v?.framing);
			const phrasing: string[] = JSON.parse(v?.phrasing_json ?? "[]");
			expect(phrasing.some((t) => t.startsWith("opener:"))).toBe(true);
			expect(phrasing.some((t) => t.startsWith("shape:"))).toBe(true);
			expect(JSON.parse(v?.bullet_ids_json ?? "[]")).toContain(
				"acme-analytics-2021.b01",
			);
		});
	});

	it("finalize refuses a second time (run no longer running)", async () => {
		const { out, code } = await jh(
			"resume",
			"finalize",
			runId,
			"--draft",
			draftId,
		);
		expect(code).toBe(2);
		expect(out.error).toBe("run_not_running");
	});

	it("status lists drafts with their latest reviews", async () => {
		const { out, code } = await jh("resume", "status", runId);
		expect(code).toBe(0);
		expect(out.run.status).toBe("finalized");
		const d = out.drafts.find((x: { id: string }) => x.id === draftId);
		expect(
			d.reviews.map((r: { reviewer: string }) => r.reviewer).sort(),
		).toEqual([
			"ats-screener",
			"fact-checker",
			"hiring-manager",
			"recruiter-screen",
		]);
	});

	it("ats score reads a rendered directory", async () => {
		const { out, code } = await jh(
			"ats",
			"score",
			draftPath,
			"--keywords",
			fixturePath("keywords.fixture.json"),
			"--rendered",
			join(workdir, "render", "final"),
		);
		expect(code).toBe(0);
		expect(out.total).toBeGreaterThanOrEqual(80);
		expect(out.parse_failures).toEqual([]);
	});

	it("render writes formats to the run's render dir", async () => {
		const { out, code } = await jh(
			"resume",
			"render",
			draftPath,
			"--formats",
			"html,txt",
			"--pages",
			"1",
		);
		expect(code).toBe(0);
		expect(out.out_dir).toBe(join(workdir, "render", draftId));
		expect(Object.keys(out.files).sort()).toEqual(["html", "txt"]);
	});
});
