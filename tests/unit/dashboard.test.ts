import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { artifactsDir } from "../../src/core/paths.js";
import { CSP, createServer, listening } from "../../src/dashboard/server.js";
import {
	childArgs,
	createRotatingLog,
	nextBackoff,
	parseDashboardArgs,
	rotateIfNeeded,
} from "../../src/dashboard/supervisor.js";
import { type Db, openDb } from "../../src/db/index.js";
import { upsertJdSnapshot } from "../../src/db/jd.js";
import {
	createApplication,
	insertJob,
	upsertCompany,
} from "../../src/db/repo.js";
import { createRun, finalizeRun } from "../../src/db/resume.js";
import { insertInterview, setInterviewPrep } from "../../src/db/tracking.js";
import type { LearnSummary } from "../../src/learn/index.js";
import * as fx from "../fixtures/resume/fixtures.js";

interface Res {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
	json: () => unknown;
}

let home: string;
let db: Db;
let server: http.Server;
let port: number;

function request(
	method: string,
	path: string,
	o: { headers?: Record<string, string>; body?: string } = {},
): Promise<Res> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				method,
				path,
				headers: { Host: `127.0.0.1:${port}`, ...o.headers },
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () => {
					const body = Buffer.concat(chunks).toString("utf8");
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body,
						json: () => JSON.parse(body),
					});
				});
			},
		);
		req.on("error", reject);
		if (o.body !== undefined) req.write(o.body);
		req.end();
	});
}

const JSON_HEADERS = { "Content-Type": "application/json", "X-JH": "1" };
const post = (path: string, body: unknown = {}) =>
	request("POST", path, { headers: JSON_HEADERS, body: JSON.stringify(body) });

async function start(learn?: (db: Db) => LearnSummary): Promise<void> {
	server = createServer(db, { port: 0, learn });
	port = await listening(server);
}

beforeEach(async () => {
	home = mkdtempSync(join(tmpdir(), "jh-dash-"));
	process.env.JOB_HUNTER_HOME = home;
	process.env.JOB_HUNTER_ME = join(home, "missing-me");
	db = openDb(":memory:");
	await start();
});
afterEach(async () => {
	await new Promise<void>((r) => server.close(() => r()));
	db.close();
	rmSync(home, { recursive: true, force: true });
	delete process.env.JOB_HUNTER_HOME;
	delete process.env.JOB_HUNTER_ME;
});

describe("dashboard server security", () => {
	it("GET /healthz is 200 with the CSP header", async () => {
		const r = await request("GET", "/healthz");
		expect(r.status).toBe(200);
		expect(r.json()).toMatchObject({ ok: true });
		expect(r.headers["content-security-policy"]).toBe(CSP);
		expect(r.headers["x-content-type-options"]).toBe("nosniff");
	});

	it("a bad Host header gets 421", async () => {
		const r = await request("GET", "/healthz", {
			headers: { Host: "evil.example" },
		});
		expect(r.status).toBe(421);
		const r2 = await request("GET", "/api/summary", {
			headers: { Host: `localhost:${port + 1}` },
		});
		expect(r2.status).toBe(421);
		expect(
			(
				await request("GET", "/healthz", {
					headers: { Host: `localhost:${port}` },
				})
			).status,
		).toBe(200);
	});

	it("POST without X-JH or JSON content type gets 403", async () => {
		const noHeader = await request("POST", "/api/study/clock-in", {
			headers: { "Content-Type": "application/json" },
			body: "{}",
		});
		expect(noHeader.status).toBe(403);
		const form = await request("POST", "/api/study/clock-in", {
			headers: {
				"Content-Type": "application/x-www-form-urlencoded",
				"X-JH": "1",
			},
			body: "topic=x",
		});
		expect(form.status).toBe(403);
	});

	it("rejects bodies over 4 KB with 413 and bad JSON with 400", async () => {
		const big = await post("/api/study/clock-in", { topic: "x".repeat(5000) });
		expect(big.status).toBe(413);
		const bad = await request("POST", "/api/study/clock-in", {
			headers: JSON_HEADERS,
			body: "{nope",
		});
		expect(bad.status).toBe(400);
	});

	it("unknown routes are 404 and wrong methods 405", async () => {
		expect((await request("GET", "/api/nope")).status).toBe(404);
		expect((await request("GET", "/api/study/clock-in")).status).toBe(405);
	});
});

describe("study clock over HTTP", () => {
	it("clock-in 201, second clock-in 409, clock-out 200, clock-out again 409", async () => {
		const a = await post("/api/study/clock-in", { topic: "DP" });
		expect(a.status).toBe(201);
		expect(a.json()).toMatchObject({ topic: "DP", source: "dashboard" });
		const b = await post("/api/study/clock-in", {});
		expect(b.status).toBe(409);
		expect(b.json()).toMatchObject({ error: "already_clocked_in" });
		const c = await post("/api/study/clock-out", { notes: "ok" });
		expect(c.status).toBe(200);
		const d = await post("/api/study/clock-out", {});
		expect(d.status).toBe(409);
		expect(d.json()).toMatchObject({ error: "not_clocked_in" });
	});

	it("validates bodies (topic <= 120)", async () => {
		const r = await post("/api/study/clock-in", { topic: "x".repeat(121) });
		expect(r.status).toBe(400);
		expect(r.json()).toMatchObject({ error: "validation" });
	});

	it("GET /api/study includes tasks; tasks can be added and completed", async () => {
		const t = await post("/api/study/tasks", { title: "Read SQL chapter" });
		expect(t.status).toBe(201);
		const id = (t.json() as { id: number }).id;
		const done = await post(`/api/study/tasks/${id}/done`);
		expect(done.status).toBe(200);
		expect((done.json() as { done_at: string | null }).done_at).not.toBeNull();
		const s = (await request("GET", "/api/study")).json() as {
			tasks: { id: number }[];
		};
		expect(s.tasks.map((x) => x.id)).toContain(id);
		expect((await post("/api/study/tasks/999/done")).status).toBe(404);
	});

	it("study blocks are editable (06:00-08:00) and validated", async () => {
		const s = (await request("GET", "/api/study")).json() as {
			allBlocks: { id: number }[];
		};
		const id = s.allBlocks[0]?.id as number;
		const ok = await post(`/api/study/blocks/${id}`, {
			start: "06:00",
			end: "08:00",
		});
		expect(ok.status).toBe(200);
		expect(ok.json()).toMatchObject({
			start_local: "06:00",
			end_local: "08:00",
		});
		expect(
			(await post(`/api/study/blocks/${id}`, { start: "09:00" })).status,
		).toBe(400);
		expect(
			(await post(`/api/study/blocks/${id}`, { start: "6am" })).status,
		).toBe(400);
	});
});

describe("read APIs", () => {
	it("/api/summary has all card keys; pendingMetrics is empty without me/", async () => {
		const r = await request("GET", "/api/summary");
		expect(r.status).toBe(200);
		const s = r.json() as Record<string, unknown>;
		for (const k of [
			"study",
			"interviews",
			"pipeline",
			"readyToApply",
			"pendingMetrics",
			"sync",
			"emails",
			"assessments",
		])
			expect(s).toHaveProperty(k);
		expect(s.pendingMetrics).toEqual({ count: 0, items: [] });
		expect(s.sync).toMatchObject({
			gmail: { lastOkAt: null, stale: true },
			calendar: { error: null },
		});
	});

	it("/api/applications filters by status with last email and idle days", async () => {
		const c = upsertCompany(db, { name: "Globex", domain: "globex.example" });
		const j = insertJob(db, { company_id: c.id, title: "Data Engineer" });
		createApplication(db, {
			job_id: j.id,
			status: "applied",
			source: "external",
		});
		const j2 = insertJob(db, { company_id: c.id, title: "Analyst" });
		createApplication(db, { job_id: j2.id, status: "shortlisted" });
		const rows = (
			await request(
				"GET",
				"/api/applications?status=applied,assessment,interviewing,offer",
			)
		).json() as {
			title: string;
			lastEmailSubject: string | null;
			daysSinceLastEvent: number;
		}[];
		expect(rows.map((r) => r.title)).toEqual(["Data Engineer"]);
		expect(rows[0]).toMatchObject({
			lastEmailSubject: null,
			daysSinceLastEvent: 0,
		});
	});

	it("/api/learn uses the injected learnSummary or 404s", async () => {
		expect((await request("GET", "/api/learn")).status).toBe(404);
		await new Promise<void>((r) => server.close(() => r()));
		await start(() => ({ callback_rate: 0.25 }) as unknown as LearnSummary);
		const r = await request("GET", "/api/learn");
		expect(r.status).toBe(200);
		expect(r.json()).toMatchObject({ callback_rate: 0.25 });
	});
});

describe("files", () => {
	function interviewWithPrep(path: string): number {
		const id = insertInterview(db, {
			company_name: "Globex",
			source: "manual",
			start_at: "2026-10-20T15:00:00Z",
		});
		setInterviewPrep(db, id, "ready", path);
		return id;
	}

	it("serves prep markdown only from inside artifactsDir()", async () => {
		const dir = join(artifactsDir(), "7");
		mkdirSync(dir, { recursive: true });
		const inside = join(dir, "prep-1.md");
		writeFileSync(inside, "# Prep\n");
		const ok = await request(
			"GET",
			`/api/interviews/${interviewWithPrep(inside)}/prep`,
		);
		expect(ok.status).toBe(200);
		expect(ok.headers["content-type"]).toContain("text/markdown");
		expect(ok.body).toBe("# Prep\n");

		const outside = join(home, "secret.md");
		writeFileSync(outside, "nope");
		const bad = await request(
			"GET",
			`/api/interviews/${interviewWithPrep(outside)}/prep`,
		);
		expect(bad.status).toBe(403);
		expect((await request("GET", "/api/interviews/9999/prep")).status).toBe(
			404,
		);
	});

	it("serves whitelisted artifacts only", async () => {
		const dir = join(artifactsDir(), "3");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "resume.pdf"), "%PDF-1.4");
		writeFileSync(join(dir, "provenance.json"), "{}");
		const pdf = await request("GET", "/artifacts/3/resume.pdf");
		expect(pdf.status).toBe(200);
		expect(pdf.headers["content-type"]).toBe("application/pdf");
		expect((await request("GET", "/artifacts/3/provenance.json")).status).toBe(
			404,
		);
		expect((await request("GET", "/artifacts/3/cover.docx")).status).toBe(404);
		expect((await request("GET", "/artifacts/3/..%2Fresume.pdf")).status).toBe(
			404,
		);
	});

	it("serves the UI with the clock button", async () => {
		const r = await request("GET", "/");
		if (!existsSync(join(process.cwd(), "dashboard-ui", "index.html"))) {
			expect(r.status).toBe(503);
			return;
		}
		expect(r.status).toBe(200);
		expect(r.body).toContain('id="clock-in-btn"');
		expect(r.body).not.toMatch(/<script>(?!<)/);
		const js = await request("GET", "/app.js");
		expect(js.headers["content-type"]).toContain("javascript");
	});
});

describe("supervisor helpers", () => {
	it("backs off 1s -> 60s and resets after a healthy run", () => {
		let d = 0;
		const seq: number[] = [];
		for (let i = 0; i < 8; i++) {
			d = nextBackoff(d, 500);
			seq.push(d);
		}
		expect(seq).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
		expect(nextBackoff(60000, 120_000)).toBe(1000);
	});

	it("parses args and builds child args", () => {
		const a = parseDashboardArgs(["--port", "4777", "--home=C:/jh", "--child"]);
		expect(a).toEqual({ port: 4777, home: "C:/jh", child: true });
		expect(childArgs({ port: 1, child: false })).toEqual([
			"--child",
			"--port",
			"1",
		]);
		expect(() => parseDashboardArgs(["--port", "x"])).toThrow();
	});

	it("rotates the log at the size limit keeping 3 files", () => {
		const log = join(home, "dashboard.log");
		const write = createRotatingLog(log, { maxBytes: 200, keep: 3 });
		for (let i = 0; i < 40; i++) write(`line ${i} ${"x".repeat(30)}`);
		expect(existsSync(log)).toBe(true);
		expect(existsSync(`${log}.1`)).toBe(true);
		expect(existsSync(`${log}.2`)).toBe(true);
		expect(existsSync(`${log}.3`)).toBe(false);
		expect(readFileSync(log, "utf8")).toContain("line 39");
		expect(rotateIfNeeded(join(home, "absent.log"), 10)).toBe(false);
	});
});

describe("GET /api/applications/:id/compare", () => {
	function appWithSnapshot(): number {
		const c = upsertCompany(db, { name: "Initech" });
		const j = insertJob(db, {
			company_id: c.id,
			title: "Senior Data Engineer",
		});
		const app = createApplication(db, { job_id: j.id, status: "tailored" });
		upsertJdSnapshot(db, app.id, {
			title_posted: "Senior Data Engineer",
			must_haves: ["Python", "Spark"],
			keywords: ["Python", "Airflow", "Spark"],
			summary: "Fictional data platform role.",
		});
		return app.id;
	}

	function finalizeWithResume(appId: number): void {
		const dir = join(artifactsDir(), String(appId));
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "resume.json"), JSON.stringify(fx.draft()));
		createRun(db, {
			id: "run-1",
			application_id: appId,
			workdir: dir,
			jd_path: join(dir, "jd.txt"),
		});
		finalizeRun(db, "run-1", {
			final_draft_id: "d1",
			ats_score: 88,
			hm_verdict: "interview",
			quality: "ok",
			iterations: 1,
		});
	}

	it("returns the resume vs JD comparison", async () => {
		const id = appWithSnapshot();
		finalizeWithResume(id);
		const r = await request("GET", `/api/applications/${id}/compare`);
		expect(r.status).toBe(200);
		expect(r.headers["content-security-policy"]).toBe(CSP);
		const body = r.json() as {
			missing_must_haves: string[];
			keywords: { coverage_pct: number; missing: string[] };
			titles: { posted: string; headline_matches_posted: boolean };
			must_haves: {
				term: string;
				covered: boolean;
				evidence: { id: string }[];
			}[];
		};
		expect(body.missing_must_haves).toEqual(["Spark"]);
		expect(body.must_haves[0]).toMatchObject({ term: "Python", covered: true });
		expect(body.keywords.missing).toEqual(["Spark"]);
		expect(body.keywords.coverage_pct).toBe(67);
		expect(body.titles).toMatchObject({
			posted: "Senior Data Engineer",
			headline_matches_posted: true,
		});
	});

	it("is 404 without a snapshot or a finalized resume, and for unknown ids", async () => {
		const c = upsertCompany(db, { name: "Hooli" });
		const j = insertJob(db, { company_id: c.id, title: "Analyst" });
		const bare = createApplication(db, { job_id: j.id });
		const noSnap = await request("GET", `/api/applications/${bare.id}/compare`);
		expect(noSnap.status).toBe(404);
		expect((noSnap.json() as { error: string }).error).toBe("no_snapshot");
		const id = appWithSnapshot();
		expect(
			(await request("GET", `/api/applications/${id}/compare`)).status,
		).toBe(404);
		expect(
			(await request("GET", "/api/applications/99999/compare")).status,
		).toBe(404);
	});

	it("keeps the Host allow-list and rejects POST", async () => {
		const id = appWithSnapshot();
		expect(
			(
				await request("GET", `/api/applications/${id}/compare`, {
					headers: { Host: "evil.example" },
				})
			).status,
		).toBe(421);
		expect((await post(`/api/applications/${id}/compare`)).status).toBe(405);
	});
});
