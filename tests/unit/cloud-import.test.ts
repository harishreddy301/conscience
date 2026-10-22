import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Run } from "../../src/cloud/git.js";
import { importResults } from "../../src/cloud/import.js";
import type { CloudSummary, PacketManifest } from "../../src/cloud/schema.js";
import { ValidationError } from "../../src/core/errors.js";
import { type Db, nowIso, openDb } from "../../src/db/index.js";
import {
	createApplication,
	insertJob,
	upsertCompany,
} from "../../src/db/repo.js";
import { getRun } from "../../src/db/resume.js";

const PACKET = "p-20261022-0905";
const RUN_ID = "1-20261022140000-ab12";
const CLOUD_WORKDIR = `/root/jh-home/artifacts/1/runs/${RUN_ID}`;

let tmp: string;
let db: Db;
let dataDir: string;
let artifactsRoot: string;
let savedHome: string | undefined;
let runs: { cmd: string; args: string[] }[];

const run: Run = async (cmd, args) => {
	runs.push({ cmd, args });
	return "";
};

const okValidate = () => ({ ok: true, errors: [] as string[] });

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "jh-cloud-import-"));
	savedHome = process.env.JOB_HUNTER_HOME;
	process.env.JOB_HUNTER_HOME = join(tmp, "home");
	runs = [];
	db = openDb(join(tmp, "local.db"));
	for (const [company, title] of [
		["Acme", "Data Engineer"],
		["Globex", "Analytics Engineer"],
	] as const) {
		const c = upsertCompany(db, { name: company });
		const j = insertJob(db, { company_id: c.id, title, jd_text: "jd" });
		createApplication(db, { job_id: j.id, status: "shortlisted" });
	}
	dataDir = join(tmp, "data");
	artifactsRoot = join(tmp, "artifacts");
	writePacket([1, 2]);
	writeCloudResults({ apps: [1] });
});

afterEach(() => {
	db.close();
	if (savedHome === undefined) delete process.env.JOB_HUNTER_HOME;
	else process.env.JOB_HUNTER_HOME = savedHome;
	rmSync(tmp, { recursive: true, force: true });
});

function writePacket(appIds: number[]): void {
	const dir = join(dataDir, "packets", PACKET);
	mkdirSync(dir, { recursive: true });
	const m: PacketManifest = {
		id: PACKET,
		created_at: nowIso(),
		schema_version: 4,
		apps: appIds.map((id) => ({
			app_id: id,
			company: "Acme",
			title: "Data Engineer",
			url: null,
			jd_path: `jd/${id}.txt`,
		})),
	};
	writeFileSync(join(dir, "packet.json"), JSON.stringify(m));
}

/** Cloud DB = snapshot of the local DB plus one run, 3 drafts, 2 reviews for app 1. */
function writeCloudResults(o: { apps: number[]; userVersion?: number }): void {
	const res = join(dataDir, "results", PACKET);
	mkdirSync(res, { recursive: true });
	const cloudPath = join(res, "jh.db");
	db.prepare("VACUUM INTO ?").run(cloudPath);
	const cloud = openDb(cloudPath);
	try {
		const now = nowIso();
		cloud
			.prepare(
				`INSERT INTO resume_runs(id, application_id, workdir, jd_path, keywords_json, iterations, ats_score, hm_verdict, created_at)
				 VALUES(?, 1, ?, ?, '{"required":[]}', 1, 86, 'interview', ?)`,
			)
			.run(RUN_ID, CLOUD_WORKDIR, `${CLOUD_WORKDIR}/jd.txt`, now);
		for (const d of ["d1-impact", "d2-skills-match", "d3-domain-reframe"])
			cloud
				.prepare(
					`INSERT INTO resume_drafts(run_id, id, angle, iteration, path, ats_score, valid, created_at)
					 VALUES(?, ?, ?, 0, ?, 80, 1, ?)`,
				)
				.run(
					RUN_ID,
					d,
					d.split("-").slice(1).join("-"),
					`${CLOUD_WORKDIR}/draft-${d}.json`,
					now,
				);
		for (const reviewer of ["hiring-manager", "fact-checker"])
			cloud
				.prepare(
					`INSERT INTO resume_reviews(run_id, draft_id, reviewer, verdict, score, json, created_at)
					 VALUES(?, 'd1-impact', ?, 'pass', 90, '{}', ?)`,
				)
				.run(RUN_ID, reviewer, now);
		cloud
			.prepare(
				`INSERT INTO jd_snapshots(application_id, title_posted, must_haves_json, nice_to_haves_json, keywords_json, summary, captured_at)
				 VALUES(1, 'Data Engineer', '[]', '[]', '[]', 'Fictional summary.', ?)`,
			)
			.run(now);
		if (o.userVersion !== undefined)
			cloud.exec(`PRAGMA user_version=${o.userVersion}`);
	} finally {
		cloud.close();
	}
	const runDir = join(res, "1", RUN_ID);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(join(runDir, "draft-d1-impact.json"), "{}");
	writeFileSync(join(runDir, "jd.txt"), "jd");
	const summary: CloudSummary = {
		packet_id: PACKET,
		finished_at: nowIso(),
		apps: o.apps.map((id) => ({
			app_id: id,
			run_id: RUN_ID,
			winner_draft_id: "d1-impact",
			status: "ready",
			ats: 86,
			hm_verdict: "interview",
			notes: [],
		})),
	};
	writeFileSync(join(res, "summary.json"), JSON.stringify(summary));
}

function count(table: string): number {
	return (
		db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }
	).n;
}

const opts = () => ({
	db,
	dataDir,
	packetId: PACKET,
	artifactsRoot,
	validate: okValidate,
	run,
});

describe("importResults", () => {
	it("imports new runs with their drafts and reviews", async () => {
		const r = await importResults(opts());
		expect(r.imported).toHaveLength(1);
		expect(r.imported[0]).toMatchObject({
			app_id: 1,
			run_id: RUN_ID,
			valid: true,
		});
		expect(
			(
				db
					.prepare("SELECT count(*) AS n FROM resume_drafts WHERE run_id = ?")
					.get(RUN_ID) as { n: number }
			).n,
		).toBe(3);
		expect(count("resume_reviews")).toBe(2);
		expect(count("jd_snapshots")).toBe(1);
		expect(runs.some((c) => c.cmd === "git" && c.args[0] === "pull")).toBe(
			true,
		);
	});

	it("rewrites workdir and paths to the local artifacts dir and copies files", async () => {
		await importResults(opts());
		const local = getRun(db, RUN_ID);
		expect(local?.workdir.startsWith(artifactsRoot)).toBe(true);
		expect(local?.jd_path).toBe(
			join(artifactsRoot, "1", "runs", RUN_ID, "jd.txt"),
		);
		const draft = db
			.prepare(
				"SELECT path FROM resume_drafts WHERE run_id = ? AND id = 'd1-impact'",
			)
			.get(RUN_ID) as { path: string };
		expect(draft.path).toBe(
			join(artifactsRoot, "1", "runs", RUN_ID, "draft-d1-impact.json"),
		);
		expect(existsSync(draft.path)).toBe(true);
		expect(readFileSync(draft.path, "utf8")).toBe("{}");
	});

	it("passes the winner draft to validate", async () => {
		const seen: string[] = [];
		await importResults({
			...opts(),
			validate: (p) => {
				seen.push(p);
				return { ok: true, errors: [] };
			},
		});
		expect(seen).toEqual([
			join(artifactsRoot, "1", "runs", RUN_ID, "draft-d1-impact.json"),
		]);
	});

	it("is idempotent", async () => {
		await importResults(opts());
		const before = [
			count("resume_runs"),
			count("resume_drafts"),
			count("resume_reviews"),
		];
		const again = await importResults(opts());
		expect(again.imported).toEqual([]);
		expect(again.skipped).toEqual([RUN_ID]);
		expect([
			count("resume_runs"),
			count("resume_drafts"),
			count("resume_reviews"),
		]).toEqual(before);
	});

	it("refuses a cloud DB with another schema version and changes nothing", async () => {
		rmSync(join(dataDir, "results"), { recursive: true });
		writeCloudResults({ apps: [1], userVersion: 999 });
		await expect(importResults(opts())).rejects.toBeInstanceOf(ValidationError);
		expect(count("resume_runs")).toBe(0);
		expect(count("resume_drafts")).toBe(0);
		expect(existsSync(join(artifactsRoot, "1"))).toBe(false);
	});

	it("reports apps missing from partial results", async () => {
		const r = await importResults(opts());
		expect(r.missing).toEqual([2]);
		expect(r.imported.map((x) => x.app_id)).toEqual([1]);
	});

	it("reports an invalid winner and never changes the application status", async () => {
		const r = await importResults({
			...opts(),
			validate: () => ({ ok: false, errors: ["TITLE_NOT_APPROVED"] }),
		});
		expect(r.imported[0]).toMatchObject({
			valid: false,
			errors: ["TITLE_NOT_APPROVED"],
		});
		const s = db
			.prepare("SELECT status FROM applications WHERE id = 1")
			.get() as {
			status: string;
		};
		expect(s.status).toBe("shortlisted");
	});
});

function rewriteSummary(mut: (s: CloudSummary) => void): void {
	const p = join(dataDir, "results", PACKET, "summary.json");
	const s = JSON.parse(readFileSync(p, "utf8")) as CloudSummary;
	mut(s);
	writeFileSync(p, JSON.stringify(s));
}

describe("importResults path safety", () => {
	it("rejects a traversal run_id and writes nothing", async () => {
		const victim = join(tmp, "victim");
		mkdirSync(victim);
		writeFileSync(join(victim, "keep.txt"), "keep");
		rewriteSummary((s) => {
			for (const a of s.apps) a.run_id = "../../../../victim";
		});
		await expect(importResults(opts())).rejects.toBeInstanceOf(ValidationError);
		expect(existsSync(artifactsRoot)).toBe(false);
		expect(existsSync(join(victim, "keep.txt"))).toBe(true);
		expect(count("resume_runs")).toBe(0);
	});

	it("rejects a traversal packet id before touching git or disk", async () => {
		await expect(
			importResults({ ...opts(), packetId: "../../etc" }),
		).rejects.toBeInstanceOf(ValidationError);
		expect(runs).toEqual([]);
		expect(existsSync(artifactsRoot)).toBe(false);
	});
});

describe("importResults rollback", () => {
	it("removes a partially copied run dir when the copy fails", async () => {
		const target = join(artifactsRoot, "1", "runs", RUN_ID);
		await expect(
			importResults({
				...opts(),
				copy: (_src: string, dest: string) => {
					mkdirSync(dest, { recursive: true });
					writeFileSync(join(dest, "partial.json"), "{}");
					throw new Error("disk full");
				},
			}),
		).rejects.toThrow("disk full");
		expect(existsSync(target)).toBe(false);
		expect(count("resume_runs")).toBe(0);
		// The cloud DB was detached: a second ATTACH under the same alias works.
		db.prepare("ATTACH DATABASE ':memory:' AS cloud").run();
		db.exec("DETACH DATABASE cloud");
	});
});

describe("importResults run state", () => {
	it("imports a cloud run marked finalized as a non-final local run", async () => {
		const cloud = openDb(join(dataDir, "results", PACKET, "jh.db"));
		try {
			cloud
				.prepare(
					"UPDATE resume_runs SET status = 'finalized', final_draft_id = 'd1-impact', finalized_at = ? WHERE id = ?",
				)
				.run(nowIso(), RUN_ID);
		} finally {
			cloud.close();
		}
		await importResults(opts());
		const local = getRun(db, RUN_ID);
		expect(local?.status).toBe("running");
		expect(local?.final_draft_id).toBeNull();
		expect(local?.finalized_at).toBeNull();
	});

	it("stores the local re-validation result on the winner draft", async () => {
		await importResults({
			...opts(),
			validate: () => ({ ok: false, errors: ["ESTIMATED_METRIC"] }),
		});
		const d = db
			.prepare(
				"SELECT valid FROM resume_drafts WHERE run_id = ? AND id = 'd1-impact'",
			)
			.get(RUN_ID) as { valid: number };
		expect(d.valid).toBe(0);
	});
});
