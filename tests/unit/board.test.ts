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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	IllegalTransitionError,
	NotFoundError,
} from "../../src/core/errors.js";
import { artifactsDir } from "../../src/core/paths.js";
import { type AppStatus, transition } from "../../src/core/state.js";
import {
	addJobLink,
	appliedRange,
	applyOutcome,
	buildBoard,
	columnFor,
	inRange,
	isSafePdfName,
	readArtifactPdf,
	safeHttpUrl,
} from "../../src/dashboard/board.js";
import { csrfFailure } from "../../src/dashboard/csrf.js";
import {
	detectAtsTarget,
	enrichJobLink,
	isPrivateAddress,
	LinkError,
	safeFetchJson,
	validateJobUrl,
} from "../../src/dashboard/joblink.js";
import { createServer, listening } from "../../src/dashboard/server.js";
import { type Db, openDb } from "../../src/db/index.js";
import {
	createApplication,
	getApplication,
	insertEvent,
	insertJob,
	listApplications,
	listEvents,
	upsertCompany,
} from "../../src/db/repo.js";
import { createRun, finalizeRun } from "../../src/db/resume.js";
import { listInterviews } from "../../src/db/tracking.js";

const TZ = "America/Los_Angeles";

let home: string;
let db: Db;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jh-board-"));
	process.env.JOB_HUNTER_HOME = home;
	process.env.JOB_HUNTER_ME = join(home, "missing-me");
	db = openDb(":memory:");
});
afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
	delete process.env.JOB_HUNTER_HOME;
	delete process.env.JOB_HUNTER_ME;
});

let seq = 0;
function seed(
	status: AppStatus,
	o: { applied_at?: string; source?: "conscience" | "external" } = {},
): number {
	seq += 1;
	const c = upsertCompany(db, { name: `Co${seq}` });
	const j = insertJob(db, {
		company_id: c.id,
		title: `Engineer ${seq}`,
		url: `https://example.com/jobs/${seq}`,
	});
	return createApplication(db, {
		job_id: j.id,
		status,
		source: o.source ?? "conscience",
		applied_at: o.applied_at,
	}).id;
}

// ---------------------------------------------------------------- date filter

describe("applied date filter (local time)", () => {
	// 2026-10-21T06:30Z is 23:30 on Oct 20 in Los Angeles (PDT, UTC-7).
	const now = new Date("2026-10-21T06:30:00Z");

	it("today is the local calendar day, not the UTC day", () => {
		const r = appliedRange("today", now, TZ);
		expect(r.from).toBe("2026-10-20T07:00:00.000Z");
		expect(r.to).toBe("2026-10-21T07:00:00.000Z");
		expect(inRange("2026-10-20T07:00:00.000Z", r)).toBe(true); // 00:00 local
		expect(inRange("2026-10-21T06:59:59.999Z", r)).toBe(true); // 23:59 local
		expect(inRange("2026-10-20T06:59:59.999Z", r)).toBe(false); // yesterday 23:59
		expect(inRange("2026-10-21T07:00:00.000Z", r)).toBe(false); // tomorrow 00:00
	});

	it("yesterday ends exactly where today starts", () => {
		const y = appliedRange("yesterday", now, TZ);
		const t = appliedRange("today", now, TZ);
		expect(y.to).toBe(t.from);
		expect(inRange("2026-10-20T06:59:59.999Z", y)).toBe(true);
		expect(inRange("2026-10-20T07:00:00.000Z", y)).toBe(false);
		expect(inRange("2026-10-19T07:00:00.000Z", y)).toBe(true);
		expect(inRange("2026-10-19T06:59:59.000Z", y)).toBe(false);
	});

	it("handles a DST change inside the last 7 days", () => {
		// PST -> PDT is not near; use Nov 3 2026 (PDT->PST on Nov 1).
		const r = appliedRange("7d", new Date("2026-11-03T20:00:00Z"), TZ);
		expect(r.from).toBe("2026-10-28T07:00:00.000Z"); // PDT midnight
		expect(r.to).toBe("2026-11-04T08:00:00.000Z"); // PST midnight
	});

	it("30d, all and custom ranges", () => {
		const d30 = appliedRange("30d", now, TZ);
		expect(d30.from).toBe("2026-09-21T07:00:00.000Z");
		const all = appliedRange("all", now, TZ);
		expect(inRange(null, all)).toBe(true);
		const c = appliedRange("custom", now, TZ, {
			from: "2026-10-10",
			to: "2026-10-01",
		});
		expect(c.from).toBe("2026-10-01T07:00:00.000Z");
		expect(c.to).toBe("2026-10-11T07:00:00.000Z");
		const bad = appliedRange("custom", now, TZ, { from: "2026-13-40" });
		expect(bad.preset).toBe("today");
	});

	it("the board counts only applications applied inside the range", () => {
		seed("applied", { applied_at: "2026-10-21T06:00:00.000Z" }); // today (local)
		seed("applied", { applied_at: "2026-10-20T06:00:00.000Z" }); // yesterday
		seed("assessment", { applied_at: "2026-10-15T18:00:00.000Z" });
		const b = buildBoard(db, {
			range: appliedRange("today", now, TZ),
			tz: TZ,
			now,
		});
		const applied = b.columns.find((c) => c.id === "applied");
		expect(applied?.count).toBe(1);
		expect(applied?.total).toBe(3);
		const y = buildBoard(db, {
			range: appliedRange("yesterday", now, TZ),
			tz: TZ,
			now,
		}).columns.find((c) => c.id === "applied");
		expect(y?.count).toBe(1);
		const all = buildBoard(db, {
			range: appliedRange("all", now, TZ),
			tz: TZ,
			now,
		}).columns.find((c) => c.id === "applied");
		expect(all?.count).toBe(3);
	});
});

// ---------------------------------------------------------------- columns

describe("column mapping", () => {
	const base = { run_status: null, held: false, hasAnswers: false };
	it.each([
		["discovered", base, "backlog"],
		["shortlisted", base, "backlog"],
		["shortlisted", { ...base, run_status: "running" }, "creating"],
		["shortlisted", { ...base, run_status: "abandoned" }, "backlog"],
		["tailored", base, "ready"],
		["tailored", { ...base, hasAnswers: true }, "applying"],
		["tailored", { ...base, held: 1 }, "skipped"],
		["held", base, "needs_you"],
		["held", { ...base, held: 1 }, "needs_you"],
		["applied", base, "applied"],
		["assessment", base, "applied"],
		["interviewing", base, "interviewing"],
		["offer", base, "interviewing"],
		["dismissed", base, "skipped"],
		["withdrawn", base, "skipped"],
		["rejected", base, "closed"],
		["ghosted", base, "closed"],
		["accepted", base, "closed"],
		["declined", base, "closed"],
	] as const)("%s %o -> %s", (status, extra, col) => {
		expect(columnFor({ status, ...extra })).toBe(col);
	});

	it("builds cards from runs, answers.json, holds and the You asked marker", () => {
		const creating = seed("shortlisted");
		createRun(db, {
			id: "r1",
			application_id: creating,
			workdir: "w",
			jd_path: "j",
		});
		const ready = seed("tailored");
		createRun(db, {
			id: "r2",
			application_id: ready,
			workdir: "w",
			jd_path: "j",
		});
		finalizeRun(db, "r2", {
			final_draft_id: "d1",
			ats_score: 86,
			hm_verdict: "strong_yes",
			quality: "ok",
			iterations: 1,
		});
		const dir = artifactsDir(ready);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "Ada_Lovelace_Resume_Co.pdf"), "%PDF-1.4");
		writeFileSync(join(dir, "cover.pdf"), "%PDF-1.4");
		const applying = seed("tailored");
		mkdirSync(artifactsDir(applying), { recursive: true });
		writeFileSync(
			join(artifactsDir(applying), "answers.json"),
			JSON.stringify({ status: "ready_to_submit" }),
		);
		const held = seed("tailored");
		insertEvent(db, {
			application_id: held,
			kind: "note",
			actor: "conscience",
			detail: { decision: "finalize-hold", note: "gap is substance" },
		});
		const now = new Date();
		const b = buildBoard(db, {
			range: appliedRange("all", now, TZ),
			tz: TZ,
			now,
		});
		const col = (id: string) => b.columns.find((c) => c.id === id);
		expect(col("creating")?.cards.map((c) => c.id)).toEqual([creating]);
		const r = col("ready")?.cards[0];
		expect(r?.id).toBe(ready);
		expect(r?.atsScore).toBe(86);
		expect(r?.hmVerdict).toBe("strong_yes");
		expect(r?.resumeUrl).toBe(
			`/api/board/${ready}/files/Ada_Lovelace_Resume_Co.pdf`,
		);
		expect(col("applying")?.cards[0]).toMatchObject({
			id: applying,
			answers: "ready_to_submit",
		});
		expect(col("skipped")?.cards[0]).toMatchObject({
			id: held,
			reason: "gap is substance",
		});
	});

	it("puts held applications in Needs you with their hold reason", () => {
		const waiting = seed("tailored");
		transition(db, waiting, "held", {
			actor: "application-submitter",
			note: "blocked:account NVIDIA Workday needs your login",
		});
		const hold = seed("tailored");
		insertEvent(db, {
			application_id: hold,
			kind: "note",
			actor: "conscience",
			detail: { decision: "finalize-hold", note: "gap is substance" },
		});
		const now = new Date();
		const b = buildBoard(db, {
			range: appliedRange("all", now, TZ),
			tz: TZ,
			now,
		});
		const ids = b.columns.map((c) => c.id);
		expect(ids.indexOf("needs_you")).toBe(ids.indexOf("ready") - 1);
		const col = (id: string) => b.columns.find((c) => c.id === id);
		expect(col("needs_you")?.cards).toEqual([
			expect.objectContaining({
				id: waiting,
				status: "held",
				reason: "blocked:account NVIDIA Workday needs your login",
			}),
		]);
		expect(col("skipped")?.cards.map((c) => c.id)).toEqual([hold]);
	});

	it("only passes http(s) posting links to the page", () => {
		expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
		expect(safeHttpUrl("https://x.example/a")).toBe("https://x.example/a");
	});
});

// ---------------------------------------------------------------- transitions

describe("card outcome actions", () => {
	it("a recruiter screen moves applied -> interviewing and records the round", () => {
		const id = seed("applied");
		const r = applyOutcome(
			db,
			id,
			{ action: "recruiter_screen", note: "call with Sam", date: "2026-10-20" },
			new Date("2026-10-21T18:00:00Z"),
			TZ,
		);
		expect(r).toMatchObject({
			from: "applied",
			to: "interviewing",
			changed: true,
		});
		expect(getApplication(db, id)?.status).toBe("interviewing");
		const iv = listInterviews(db).find((i) => i.application_id === id);
		expect(iv).toMatchObject({
			round: "recruiter_screen",
			source: "manual",
			status: "done",
		});
		const events = listEvents(db, id);
		expect(
			events.some((e) => e.kind === "transition" && e.actor === "user"),
		).toBe(true);
		expect(events.some((e) => e.kind === "interview")).toBe(true);
		const audit = readFileSync(join(home, "logs", "audit.jsonl"), "utf8");
		expect(audit).toContain('"action":"app.transition"');
		expect(audit).toContain('"action":"app.stage"');
		// A second stage stays in interviewing.
		const r2 = applyOutcome(db, id, { action: "technical" });
		expect(r2.changed).toBe(false);
		const b = buildBoard(db, {
			range: appliedRange("all", new Date(), TZ),
			tz: TZ,
			now: new Date(),
		});
		const card = b.columns
			.find((c) => c.id === "interviewing")
			?.cards.find((c) => c.id === id);
		expect(card?.stage).toBe("Technical");
	});

	it("legal status outcomes go through the state machine", () => {
		const a = seed("interviewing");
		expect(applyOutcome(db, a, { action: "offer" })).toMatchObject({
			to: "offer",
			changed: true,
		});
		const b = seed("applied");
		applyOutcome(db, b, { action: "rejected", note: "form email" });
		expect(getApplication(db, b)?.status).toBe("rejected");
		const c = seed("applied");
		applyOutcome(db, c, { action: "ghosted" });
		applyOutcome(db, c, { action: "technical" });
		expect(getApplication(db, c)?.status).toBe("interviewing");
		const d = seed("applied");
		applyOutcome(db, d, { action: "withdrawn" });
		expect(getApplication(db, d)?.status).toBe("withdrawn");
	});

	it("illegal outcomes throw IllegalTransitionError and change nothing", () => {
		const a = seed("applied");
		expect(() => applyOutcome(db, a, { action: "offer" })).toThrow(
			IllegalTransitionError,
		);
		const b = seed("rejected");
		expect(() => applyOutcome(db, b, { action: "withdrawn" })).toThrow(
			IllegalTransitionError,
		);
		expect(() => applyOutcome(db, b, { action: "recruiter_screen" })).toThrow(
			IllegalTransitionError,
		);
		expect(getApplication(db, b)?.status).toBe("rejected");
		expect(listInterviews(db).some((i) => i.application_id === b)).toBe(false);
		expect(() => applyOutcome(db, 9999, { action: "offer" })).toThrow(
			NotFoundError,
		);
		expect(() => applyOutcome(db, a, { action: "hired" })).toThrow();
		expect(() =>
			applyOutcome(db, a, { action: "rejected", date: "yesterday" }),
		).toThrow();
	});
});

// ---------------------------------------------------------------- add a link

describe("add a job link", () => {
	it.each([
		"javascript:alert(1)",
		"file:///etc/passwd",
		"data:text/html,hi",
		"ftp://example.com/job",
		"https://user:pw@example.com/job",
		"not a url",
		`https://example.com/${"a".repeat(2100)}`,
	])("rejects %s", (u) => {
		expect(() => validateJobUrl(u)).toThrow(LinkError);
	});

	it("accepts http and https", () => {
		expect(validateJobUrl("http://example.com/job#x").toString()).toBe(
			"http://example.com/job",
		);
	});

	it("never fetches the user's own URL or private hosts", async () => {
		const fetchSpy = vi.fn();
		for (const u of [
			"https://10.0.0.1/jobs/1",
			"https://127.0.0.1/api",
			"http://169.254.169.254/latest/meta-data",
			"http://boards.greenhouse.io/acme/jobs/123", // http, not https
		]) {
			const out = await enrichJobLink(new URL(u), {
				fetch: fetchSpy as unknown as typeof fetch,
				lookup: async () => ["93.184.216.34"],
			});
			expect(out.title).toBeUndefined();
		}
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("refuses an allow-listed host that resolves to a private address", async () => {
		const fetchSpy = vi.fn();
		const out = await enrichJobLink(
			new URL("https://boards.greenhouse.io/acme/jobs/123"),
			{
				fetch: fetchSpy as unknown as typeof fetch,
				lookup: async () => ["127.0.0.1"],
			},
		);
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(out).toMatchObject({ company: "Acme", ats: "greenhouse" });
		expect(out.title).toBeUndefined();
		await expect(
			safeFetchJson("https://evil.example/x", {
				lookup: async () => ["1.1.1.1"],
			}),
		).rejects.toThrow(/not allowed/);
		expect(isPrivateAddress("192.168.1.2")).toBe(true);
		expect(isPrivateAddress("::ffff:10.1.2.3")).toBe(true);
		expect(isPrivateAddress("fd00::1")).toBe(true);
		expect(isPrivateAddress("8.8.8.8")).toBe(false);
	});

	it("enriches Greenhouse links with redirects disabled", async () => {
		const fetchSpy = vi.fn(async (_u: string, init: RequestInit) => {
			expect(init.redirect).toBe("error");
			return new Response(
				JSON.stringify({
					title: "Staff Engineer\u0000",
					company_name: "Acme Robotics",
					location: { name: "Remote, US" },
					first_published: "2026-10-01T12:00:00Z",
				}),
				{ status: 200 },
			);
		});
		const r = await addJobLink(
			db,
			{
				url: "https://job-boards.greenhouse.io/acme/jobs/4012345",
				note: "referral",
			},
			{
				fetch: fetchSpy as unknown as typeof fetch,
				lookup: async () => ["104.18.0.1"],
			},
		);
		expect(fetchSpy).toHaveBeenCalledWith(
			"https://boards-api.greenhouse.io/v1/boards/acme/jobs/4012345",
			expect.anything(),
		);
		expect(r).toMatchObject({
			created: true,
			company: "Acme Robotics",
			title: "Staff Engineer",
			enriched: true,
		});
		const app = getApplication(db, r.id);
		expect(app).toMatchObject({
			status: "shortlisted",
			requested_by: "user",
			request_note: "referral",
		});
	});

	it("falls back to the hostname and marks You asked; re-adding is idempotent", async () => {
		const url = "https://careers.example.org/openings/senior-data-engineer";
		const r = await addJobLink(db, { url });
		expect(r).toMatchObject({
			created: true,
			company: "example.org",
			title: "Senior Data Engineer",
		});
		const again = await addJobLink(db, { url, note: "please" });
		expect(again).toMatchObject({ created: false, id: r.id });
		const requested = listApplications(db, { userRequested: true });
		expect(requested.map((a) => a.id)).toEqual([r.id]);
		expect(requested[0]?.request_note).toBe("please");
		await expect(
			addJobLink(db, { url: "javascript:alert(1)" }),
		).rejects.toThrow(LinkError);
	});

	it("recognizes Lever and Ashby posting URLs", () => {
		expect(
			detectAtsTarget(
				new URL(
					"https://jobs.lever.co/acme/0a1b2c3d-1111-2222-3333-444455556666",
				),
			)?.api,
		).toBe(
			"https://api.lever.co/v0/postings/acme/0a1b2c3d-1111-2222-3333-444455556666",
		);
		expect(
			detectAtsTarget(
				new URL(
					"https://jobs.ashbyhq.com/acme/0a1b2c3d-1111-2222-3333-444455556666",
				),
			)?.api,
		).toBe("https://api.ashbyhq.com/posting-api/job-board/acme");
	});
});

// ---------------------------------------------------------------- CSRF

describe("CSRF check", () => {
	const TOKEN = "t".repeat(43);
	const ok = {
		host: "127.0.0.1:4777",
		origin: "http://127.0.0.1:4777",
		cookie: `jh_csrf=${TOKEN}`,
		"x-csrf-token": TOKEN,
	};
	it("accepts same-origin with a matching token", () => {
		expect(csrfFailure(ok)).toBeNull();
		const { origin: _o, ...noOrigin } = ok;
		expect(
			csrfFailure({ ...noOrigin, "sec-fetch-site": "same-origin" }),
		).toBeNull();
	});
	it("rejects cross-origin, missing and mismatched tokens", () => {
		expect(csrfFailure({ ...ok, origin: "http://evil.example" })).toBe(
			"cross_origin",
		);
		expect(csrfFailure({ ...ok, origin: "null" })).toBe("cross_origin");
		const { origin: _o, ...noOrigin } = ok;
		expect(csrfFailure({ ...noOrigin, "sec-fetch-site": "cross-site" })).toBe(
			"cross_origin",
		);
		const { "x-csrf-token": _t, ...noHeader } = ok;
		expect(csrfFailure(noHeader)).toBe("csrf");
		expect(csrfFailure({ ...ok, cookie: "" })).toBe("csrf");
		expect(csrfFailure({ ...ok, "x-csrf-token": "u".repeat(43) })).toBe("csrf");
	});
});

// ---------------------------------------------------------------- resume files

describe("resume file route", () => {
	it("serves only safe PDF names from artifacts/<id>/", () => {
		const id = seed("tailored");
		const dir = artifactsDir(id);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "Resume.pdf"), "%PDF-1.4 ok");
		writeFileSync(join(artifactsDir(), "secret.pdf"), "%PDF secret");
		expect(readArtifactPdf(id, "Resume.pdf")?.toString()).toContain("ok");
		for (const bad of [
			"../secret.pdf",
			"..%2Fsecret.pdf",
			"..%5Csecret.pdf",
			"%2E%2E%2Fsecret.pdf",
			"..\\secret.pdf",
			"sub/../../secret.pdf",
			".hidden.pdf",
			"jh.db",
			"Resume.pdf%00.txt",
			"%E0%A4%A",
		]) {
			expect(() => readArtifactPdf(id, bad), bad).toThrow(NotFoundError);
		}
		expect(isSafePdfName("First_Last_Resume_Acme Co.pdf")).toBe(true);
		expect(isSafePdfName("a..pdf")).toBe(false);
	});
});

// ---------------------------------------------------------------- HTTP

describe("board HTTP endpoints", () => {
	let server: http.Server;
	let port: number;

	beforeEach(async () => {
		server = createServer(db, { port: 0 });
		port = await listening(server);
	});
	afterEach(async () => {
		await new Promise<void>((r) => server.close(() => r()));
	});

	function request(
		method: string,
		path: string,
		headers: Record<string, string> = {},
		body?: string,
	): Promise<{
		status: number;
		headers: http.IncomingHttpHeaders;
		body: string;
	}> {
		return new Promise((resolve, reject) => {
			const req = http.request(
				{
					host: "127.0.0.1",
					port,
					method,
					path,
					headers: { Host: `127.0.0.1:${port}`, ...headers },
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (c: Buffer) => chunks.push(c));
					res.on("end", () =>
						resolve({
							status: res.statusCode ?? 0,
							headers: res.headers,
							body: Buffer.concat(chunks).toString("utf8"),
						}),
					);
				},
			);
			req.on("error", reject);
			if (body !== undefined) req.write(body);
			req.end();
		});
	}

	async function session(): Promise<{ token: string; cookie: string }> {
		const r = await request("GET", "/api/board?range=all");
		expect(r.status).toBe(200);
		const token = (JSON.parse(r.body) as { csrf: string }).csrf;
		const set = String(r.headers["set-cookie"] ?? "");
		expect(set).toContain("HttpOnly");
		expect(set).toContain("SameSite=Strict");
		return { token, cookie: `jh_csrf=${token}` };
	}

	const postHeaders = (extra: Record<string, string>) => ({
		"Content-Type": "application/json",
		"X-JH": "1",
		Origin: `http://127.0.0.1:${port}`,
		...extra,
	});

	it("GET /api/board returns columns and a CSRF token", async () => {
		const r = await request("GET", "/api/board?range=today&tz=UTC");
		const b = JSON.parse(r.body) as {
			columns: { id: string }[];
			csrf: string;
			readOnly: boolean;
		};
		expect(b.columns.map((c) => c.id)).toEqual([
			"backlog",
			"creating",
			"needs_you",
			"ready",
			"applying",
			"applied",
			"interviewing",
			"skipped",
			"closed",
		]);
		expect(b.csrf).toMatch(/^[\w-]{43}$/);
		expect(b.readOnly).toBe(false);
	});

	it("rejects POSTs without a valid CSRF token or from another origin", async () => {
		const { token, cookie } = await session();
		const body = JSON.stringify({
			url: "https://example.com/jobs/data-engineer",
		});
		const noToken = await request(
			"POST",
			"/api/board/links",
			postHeaders({ Cookie: cookie }),
			body,
		);
		expect(noToken.status).toBe(403);
		expect(JSON.parse(noToken.body).error).toBe("csrf");
		const noCookie = await request(
			"POST",
			"/api/board/links",
			postHeaders({ "X-CSRF-Token": token }),
			body,
		);
		expect(noCookie.status).toBe(403);
		const cross = await request(
			"POST",
			"/api/board/links",
			postHeaders({
				Cookie: cookie,
				"X-CSRF-Token": token,
				Origin: "http://evil.example",
			}),
			body,
		);
		expect(cross.status).toBe(403);
		expect(JSON.parse(cross.body).error).toBe("cross_origin");
		const good = await request(
			"POST",
			"/api/board/links",
			postHeaders({ Cookie: cookie, "X-CSRF-Token": token }),
			body,
		);
		expect(good.status).toBe(201);
		const bad = await request(
			"POST",
			"/api/board/links",
			postHeaders({ Cookie: cookie, "X-CSRF-Token": token }),
			JSON.stringify({ url: "javascript:alert(1)" }),
		);
		expect(bad.status).toBe(400);
	});

	it("returns 409 for an illegal transition and 200 for a legal one", async () => {
		const { token, cookie } = await session();
		const id = seed("applied");
		const h = postHeaders({ Cookie: cookie, "X-CSRF-Token": token });
		const illegal = await request(
			"POST",
			`/api/board/${id}/outcome`,
			h,
			JSON.stringify({ action: "offer" }),
		);
		expect(illegal.status).toBe(409);
		expect(JSON.parse(illegal.body).error).toBe("illegal_transition");
		const legal = await request(
			"POST",
			`/api/board/${id}/outcome`,
			h,
			JSON.stringify({ action: "rejected" }),
		);
		expect(legal.status).toBe(200);
	});

	it("blocks path traversal on the resume route", async () => {
		const id = seed("tailored");
		mkdirSync(artifactsDir(id), { recursive: true });
		writeFileSync(join(artifactsDir(id), "Resume.pdf"), "%PDF-1.4");
		writeFileSync(join(home, "secret.pdf"), "secret");
		const okR = await request("GET", `/api/board/${id}/files/Resume.pdf`);
		expect(okR.status).toBe(200);
		expect(okR.headers["content-type"]).toBe("application/pdf");
		for (const p of [
			`/api/board/${id}/files/..%2F..%2Fsecret.pdf`,
			`/api/board/${id}/files/..%5C..%5Csecret.pdf`,
			`/api/board/${id}/files/%2e%2e%2f%2e%2e%2fsecret.pdf`,
			`/api/board/${id}/files/../../secret.pdf`,
		]) {
			const r = await request("GET", p);
			expect([400, 404]).toContain(r.status);
			expect(r.body).not.toContain("secret");
		}
		expect(existsSync(join(home, "secret.pdf"))).toBe(true);
	});
});
