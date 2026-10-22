import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "../../src/commands/jd.js";
import { artifactsDir } from "../../src/core/paths.js";
import { type Db, migrate, openDb, userVersion } from "../../src/db/index.js";
import { getJdSnapshot, upsertJdSnapshot } from "../../src/db/jd.js";
import { MIGRATIONS } from "../../src/db/migrations.js";
import {
	createApplication,
	insertJob,
	upsertCompany,
} from "../../src/db/repo.js";
import { createRun, finalizeRun, upsertDraft } from "../../src/db/resume.js";
import { compareResumeToJd, jdCompareForApp } from "../../src/jd/compare.js";
import type { JdSnapshotRecord } from "../../src/jd/schema.js";
import { renderHtml, renderText } from "../../src/render/index.js";
import type { TailoredResume } from "../../src/resume/schema.js";
import * as fx from "../fixtures/resume/fixtures.js";

const SNAP = {
	title_posted: "Senior Data Engineer",
	seniority: "senior",
	must_haves: [
		"Python",
		{ term: "Apache Airflow", aliases: ["Airflow"] },
		"Kafka",
		"Spark",
	],
	nice_to_haves: ["Snowflake", "Terraform"],
	keywords: ["Python", "Airflow", "Kafka", "Spark", "Terraform"],
	location: "Austin, TX",
	remote: "hybrid",
	summary:
		"Owns batch and streaming pipelines for a fictional billing platform.",
	source_url: "https://jobs.example/initech/123",
};

let home: string;
let db: Db;

function newApp(title = "Senior Data Engineer"): number {
	const c = upsertCompany(db, { name: "Initech" });
	const j = insertJob(db, { company_id: c.id, title });
	return createApplication(db, { job_id: j.id, status: "shortlisted" }).id;
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jh-jd-"));
	process.env.JOB_HUNTER_HOME = home;
	db = openDb(":memory:");
});
afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
	delete process.env.JOB_HUNTER_HOME;
});

describe("migration 2", () => {
	it("creates jd_snapshots and adds resume_variants.title_choice_json", () => {
		const cols = (t: string) =>
			(
				db.prepare(`PRAGMA table_info(${t})`).all() as unknown as {
					name: string;
				}[]
			).map((c) => c.name);
		expect(cols("jd_snapshots")).toEqual([
			"application_id",
			"title_posted",
			"seniority",
			"must_haves_json",
			"nice_to_haves_json",
			"keywords_json",
			"location",
			"remote",
			"salary",
			"summary",
			"source_url",
			"captured_at",
		]);
		expect(cols("resume_variants")).toContain("title_choice_json");
	});

	it("upgrades a v1 database in place and keeps its rows", () => {
		const raw = new DatabaseSync(":memory:");
		raw.exec("PRAGMA foreign_keys=ON");
		raw.exec(MIGRATIONS[0] as string);
		raw.exec("PRAGMA user_version=1");
		raw.exec(
			`INSERT INTO companies(name,name_norm,created_at) VALUES('A','a','2026-01-01');
			 INSERT INTO jobs(company_id,title,title_norm,discovered_at) VALUES(1,'DE','de','2026-01-01');
			 INSERT INTO applications(job_id,status,last_event_at,created_at,updated_at) VALUES(1,'applied','2026-01-01','2026-01-01','2026-01-01');
			 INSERT INTO resume_variants(application_id,keywords_json,bullet_ids_json,phrasing_json) VALUES(1,'[]','[]','[]');`,
		);
		expect(migrate(raw)).toBe(MIGRATIONS.length);
		expect(userVersion(raw)).toBe(MIGRATIONS.length);
		const v = raw
			.prepare("SELECT title_choice_json FROM resume_variants")
			.get() as { title_choice_json: string | null };
		expect(v.title_choice_json).toBeNull();
		raw.close();
	});

	it("enforces summary <= 800 characters in SQL too", () => {
		const id = newApp();
		expect(() =>
			db
				.prepare(
					`INSERT INTO jd_snapshots(application_id,title_posted,must_haves_json,nice_to_haves_json,keywords_json,summary,captured_at)
					 VALUES(?,?,?,?,?,?,?)`,
				)
				.run(id, "x", "[]", "[]", "[]", "y".repeat(801), "2026-01-01"),
		).toThrow();
	});
});

describe("jd snapshot storage", () => {
	it("validates, normalizes terms and round-trips", () => {
		const id = newApp();
		const s = upsertJdSnapshot(db, id, {
			...SNAP,
			must_haves: [...SNAP.must_haves, "python"],
		});
		expect(s.application_id).toBe(id);
		expect(s.must_haves).toEqual([
			{ term: "Python", aliases: [] },
			{ term: "Apache Airflow", aliases: ["Airflow"] },
			{ term: "Kafka", aliases: [] },
			{ term: "Spark", aliases: [] },
		]);
		expect(s.salary).toBeNull();
		expect(Date.parse(s.captured_at)).not.toBeNaN();
		expect(getJdSnapshot(db, id)).toEqual(s);
	});

	it("replaces on re-set and keeps the earlier source_url when omitted", () => {
		const id = newApp();
		upsertJdSnapshot(db, id, SNAP);
		const again = upsertJdSnapshot(db, id, {
			...SNAP,
			source_url: undefined,
			title_posted: "Staff Data Engineer",
		});
		expect(again.title_posted).toBe("Staff Data Engineer");
		expect(again.source_url).toBe(SNAP.source_url);
	});

	it("rejects bad input with exit 2 and unknown applications with exit 1", () => {
		const id = newApp();
		for (const bad of [
			{ ...SNAP, summary: "x".repeat(801) },
			{ ...SNAP, must_haves: [] },
			{ ...SNAP, source_url: "javascript:alert(1)" },
			{ ...SNAP, title_posted: "" },
		]) {
			expect(() => upsertJdSnapshot(db, id, bad)).toThrow(
				expect.objectContaining({ exitCode: 2 }),
			);
		}
		expect(() => upsertJdSnapshot(db, 999, SNAP)).toThrow(
			expect.objectContaining({ exitCode: 1 }),
		);
		expect(getJdSnapshot(db, 999)).toBeUndefined();
	});
});

function snapRecord(over: Partial<JdSnapshotRecord> = {}): JdSnapshotRecord {
	const id = newApp();
	return { ...upsertJdSnapshot(db, id, SNAP), ...over };
}

describe("compareResumeToJd", () => {
	it("reports covered must-haves with evidence lines, missing ones, keywords and titles", () => {
		const c = compareResumeToJd(1, fx.draft(), snapRecord());
		const byTerm = Object.fromEntries(c.must_haves.map((m) => [m.term, m]));
		expect(byTerm.Python?.covered).toBe(true);
		expect(byTerm.Python?.evidence.map((e) => e.id)).toContain(
			"acme-analytics-2021.b01#t1",
		);
		expect(byTerm.Python?.evidence.some((e) => e.kind === "summary")).toBe(
			true,
		);
		expect(byTerm["Apache Airflow"]?.covered).toBe(true);
		expect(byTerm["Apache Airflow"]?.evidence[0]?.id).toBe(
			"acme-analytics-2021.b02#t1",
		);
		// In the skills list only: not evidence.
		expect(byTerm.Kafka?.covered).toBe(false);
		expect(byTerm.Kafka?.also_in).toEqual(["skills"]);
		expect(byTerm.Spark?.covered).toBe(false);
		expect(c.missing_must_haves).toEqual(["Kafka", "Spark"]);
		expect(c.must_have_coverage_pct).toBe(50);
		expect(c.keywords).toEqual({
			total: 5,
			covered: ["Python", "Airflow", "Kafka"],
			missing: ["Spark", "Terraform"],
			coverage_pct: 60,
		});
		expect(c.nice_to_haves).toEqual([
			{ term: "Snowflake", covered: true },
			{ term: "Terraform", covered: false },
		]);
		expect(c.titles.headline_matches_posted).toBe(true);
		expect(c.titles.display_titles[0]).toEqual({
			role_id: "acme-analytics-2021",
			employer: "Acme Analytics",
			official: "Senior Data Engineer",
			shown: "Senior Data Engineer",
			uses_variant: false,
		});
	});

	it("uses display titles and flags a headline that differs from the posted title", () => {
		const d = fx.draft();
		(d.experience[0] as TailoredResume["experience"][number]).display_title =
			"Senior Data Platform Engineer";
		const c = compareResumeToJd(
			1,
			d,
			snapRecord({ title_posted: "Staff Analytics Engineer" }),
		);
		expect(c.titles.headline_matches_posted).toBe(false);
		expect(c.titles.display_titles[0]).toMatchObject({
			shown: "Senior Data Platform Engineer",
			uses_variant: true,
		});
	});

	it("counts a keyword as covered through its must-have aliases", () => {
		// The resume writes "Airflow"; the keyword is the must-have's canonical term.
		const c = compareResumeToJd(
			1,
			fx.draft(),
			snapRecord({ keywords: ["Apache Airflow"] }),
		);
		expect(c.must_haves.find((m) => m.term === "Apache Airflow")?.covered).toBe(
			true,
		);
		expect(c.keywords.covered).toEqual(["Apache Airflow"]);
		expect(c.keywords.missing).toEqual([]);
	});

	it("treats a display title that only differs in case from the official one as no variant", () => {
		const d = fx.draft();
		(d.experience[0] as TailoredResume["experience"][number]).display_title =
			"senior data engineer";
		const c = compareResumeToJd(1, d, snapRecord());
		expect(c.titles.display_titles[0]?.uses_variant).toBe(false);
	});

	it("matches the headline to the posted title ignoring punctuation, and checks targets", () => {
		const d = fx.draft();
		d.basics.headline = "Senior Data Engineer, Platform";
		const s = snapRecord({ title_posted: "Senior Data Engineer – Platform" });
		const c = compareResumeToJd(1, d, s, null, ["Senior Data Engineer"]);
		expect(c.titles.headline_matches_posted).toBe(true);
		expect(c.titles.headline_in_targets).toBe(true);
		expect(
			compareResumeToJd(1, d, s, null, ["Engineering Manager"]).titles
				.headline_in_targets,
		).toBe(false);
		expect(compareResumeToJd(1, d, s).titles.headline_in_targets).toBeNull();
	});

	it("is deterministic", () => {
		const s = snapRecord();
		expect(compareResumeToJd(1, fx.draft(), s)).toEqual(
			compareResumeToJd(1, fx.draft(), s),
		);
	});
});

function finalize(appId: number, resume: TailoredResume): string {
	const dir = artifactsDir(appId);
	const workdir = join(dir, "runs", "r1");
	mkdirSync(workdir, { recursive: true });
	const draftPath = join(workdir, "draft-d1.json");
	writeFileSync(draftPath, JSON.stringify(resume));
	createRun(db, {
		id: "r1",
		application_id: appId,
		workdir,
		jd_path: join(workdir, "jd.txt"),
	});
	upsertDraft(db, {
		run_id: "r1",
		id: "d1-impact",
		angle: "impact",
		iteration: 0,
		path: draftPath,
	});
	finalizeRun(db, "r1", {
		final_draft_id: "d1-impact",
		ats_score: 85,
		hm_verdict: "interview",
		quality: "ok",
		iterations: 0,
	});
	return draftPath;
}

describe("jdCompareForApp", () => {
	it("needs a snapshot and a finalized resume", () => {
		const id = newApp();
		expect(() => jdCompareForApp(db, id)).toThrow(
			expect.objectContaining({ code: "no_snapshot" }),
		);
		upsertJdSnapshot(db, id, SNAP);
		expect(() => jdCompareForApp(db, id)).toThrow(/no finalized resume/);
		expect(() => jdCompareForApp(db, 4242)).toThrow(/not found/);
	});

	it("compares the finalized resume.json, falling back to the final draft", () => {
		const id = newApp();
		upsertJdSnapshot(db, id, SNAP);
		const draftPath = finalize(id, fx.draft());
		const viaDraft = jdCompareForApp(db, id);
		expect(viaDraft.resume_source).toContain("draft-d1.json");
		const final = fx.draft();
		final.basics.headline = "Staff Engineer";
		writeFileSync(join(artifactsDir(id), "resume.json"), JSON.stringify(final));
		const viaFinal = jdCompareForApp(db, id);
		expect(viaFinal.resume_source).toContain("resume.json");
		expect(viaFinal.titles.headline).toBe("Staff Engineer");
		expect(existsSync(draftPath)).toBe(true);
	});

	it("never reads a final draft stored outside the artifacts directory", () => {
		const id = newApp();
		upsertJdSnapshot(db, id, SNAP);
		const outside = mkdtempSync(join(tmpdir(), "jh-outside-"));
		try {
			const p = join(outside, "draft.json");
			writeFileSync(p, JSON.stringify(fx.draft()));
			createRun(db, {
				id: "r2",
				application_id: id,
				workdir: outside,
				jd_path: p,
			});
			upsertDraft(db, {
				run_id: "r2",
				id: "d1",
				angle: "impact",
				iteration: 0,
				path: p,
			});
			finalizeRun(db, "r2", {
				final_draft_id: "d1",
				ats_score: 80,
				hm_verdict: null,
				quality: "ok",
				iterations: 0,
			});
			expect(() => jdCompareForApp(db, id)).toThrow(/missing/);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("compares an explicit --draft before finalize", () => {
		const id = newApp();
		upsertJdSnapshot(db, id, SNAP);
		const p = join(home, "draft.json");
		writeFileSync(p, JSON.stringify(fx.draft()));
		const c = jdCompareForApp(db, id, { draftPath: p });
		expect(c.missing_must_haves).toEqual(["Kafka", "Spark"]);
	});
});

describe("rendering display titles", () => {
	it("shows display_title instead of the official title", () => {
		const d = fx.draft();
		(d.experience[0] as TailoredResume["experience"][number]).display_title =
			"Senior Data Platform Engineer";
		expect(renderText(d)).toContain("Senior Data Platform Engineer | Acme");
		expect(renderHtml(d)).toContain(
			'<span class="title">Senior Data Platform Engineer</span>',
		);
	});
});

describe("jh jd CLI", () => {
	let out: string[];
	let dbFile: string;

	beforeEach(() => {
		dbFile = join(home, "jh.db");
		process.env.JOB_HUNTER_DB = dbFile;
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
		delete process.env.JOB_HUNTER_DB;
	});

	async function jh(...argv: string[]): Promise<unknown> {
		out = [];
		const program = new Command().exitOverride();
		register(program);
		await program.parseAsync(argv, { from: "user" });
		return JSON.parse(out.join("").trim().split("\n").at(-1) ?? "null");
	}

	it("snapshot set, show and compare --draft", async () => {
		const fileDb = openDb(dbFile);
		const c = upsertCompany(fileDb, { name: "Initech" });
		const j = insertJob(fileDb, {
			company_id: c.id,
			title: "Senior Data Engineer",
		});
		const appId = createApplication(fileDb, { job_id: j.id }).id;
		fileDb.close();

		const snapFile = join(home, "snap.json");
		writeFileSync(snapFile, JSON.stringify(SNAP));
		const set = (await jh(
			"jd",
			"snapshot",
			"set",
			String(appId),
			"--file",
			snapFile,
			"--json",
		)) as { application_id: number; must_haves: unknown[] };
		expect(set.application_id).toBe(appId);
		expect(set.must_haves).toHaveLength(4);

		const shown = (await jh("jd", "show", String(appId), "--json")) as {
			title_posted: string;
		};
		expect(shown.title_posted).toBe("Senior Data Engineer");

		const draftFile = join(home, "draft.json");
		writeFileSync(draftFile, JSON.stringify(fx.draft()));
		const cmp = (await jh(
			"jd",
			"compare",
			String(appId),
			"--draft",
			draftFile,
			"--json",
		)) as { missing_must_haves: string[] };
		expect(cmp.missing_must_haves).toEqual(["Kafka", "Spark"]);

		const missing = (await jh("jd", "show", "77", "--json")) as {
			error: string;
		};
		expect(missing.error).toBe("no_snapshot");
		expect(process.exitCode).toBe(1);

		process.exitCode = undefined;
		writeFileSync(snapFile, JSON.stringify({ ...SNAP, summary: "" }));
		const bad = (await jh(
			"jd",
			"snapshot",
			"set",
			String(appId),
			"--file",
			snapFile,
			"--json",
		)) as { error: string };
		expect(bad.error).toBe("validation");
		expect(process.exitCode).toBe(2);
	});
});
