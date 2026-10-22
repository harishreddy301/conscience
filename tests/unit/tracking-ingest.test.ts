import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register as registerEmail } from "../../src/commands/email.js";
import { register as registerInterview } from "../../src/commands/interview.js";
import { register as registerSync } from "../../src/commands/sync.js";
import { type Db, openDb } from "../../src/db/index.js";
import {
	createApplication,
	findCompanyByName,
	getApplication,
	insertJob,
	listApplications,
	listEvents,
	upsertCompany,
} from "../../src/db/repo.js";
import {
	getInterviewByEventId,
	listEmails,
	listInterviews,
} from "../../src/db/tracking.js";
import { ingestEmails } from "../../src/tracking/ingest.js";
import { upsertInterviews } from "../../src/tracking/interviews.js";
import {
	EmailIngestBatch,
	InterviewUpsertBatch,
} from "../../src/tracking/schemas.js";
import { buildSummary } from "../../src/tracking/summary.js";

const fixture = (name: string): unknown =>
	JSON.parse(
		readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"),
	);

let home: string;
let db: Db;
let globexApp: number;
let initechApp: number;

function seedApp(name: string, domain: string, title: string): number {
	const c = upsertCompany(db, { name, domain });
	const j = insertJob(db, { company_id: c.id, title });
	return createApplication(db, {
		job_id: j.id,
		status: "applied",
		source: "external",
		applied_at: "2026-09-20T00:00:00Z",
	}).id;
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jh-ingest-"));
	process.env.JOB_HUNTER_HOME = home;
	process.env.JOB_HUNTER_ME = join(home, "no-me");
	db = openDb(":memory:");
	globexApp = seedApp("Globex Systems", "globex.example", "Data Engineer");
	initechApp = seedApp("Initech", "initech.example", "Analyst");
});
afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
	delete process.env.JOB_HUNTER_HOME;
	delete process.env.JOB_HUNTER_ME;
});

const emails = () => EmailIngestBatch.parse(fixture("gmail-sample.json"));
const events = () =>
	InterviewUpsertBatch.parse(fixture("calendar-sample.json"));

describe("ingestEmails", () => {
	it("counts duplicates by gmail_message_id and ingests the rest", () => {
		const r = ingestEmails(db, emails());
		expect(r.duplicates).toBe(1);
		expect(r.ingested).toBe(5);
		expect(listEmails(db, { limit: 100 })).toHaveLength(5);
		const again = ingestEmails(db, emails());
		expect(again).toMatchObject({ ingested: 0, duplicates: 6 });
	});

	it("a confident confirmation from an ATS creates an external application", () => {
		ingestEmails(db, emails());
		const hooli = findCompanyByName(db, "Hooli");
		expect(hooli).toBeDefined();
		const apps = listApplications(db, { companyId: hooli?.id });
		expect(apps).toHaveLength(1);
		expect(apps[0]?.source).toBe("email");
		expect(apps[0]?.title).toBe("Platform Engineer");
		expect(apps[0]?.applied_at).toBe("2026-10-01T14:05:00.000Z");
		// ATS domain must not be stored as the company's domain.
		expect(hooli?.domain).toBeNull();
	});

	it("follows the thread for later emails and moves to assessment", () => {
		const r = ingestEmails(db, emails());
		const m5 = r.items.find((i) => i.gmail_message_id === "m-005");
		expect(m5?.via).toBe("thread");
		const app = getApplication(db, m5?.application_id as number);
		expect(app?.status).toBe("assessment");
		const s = buildSummary(db, new Date("2026-10-07T00:00:00Z"));
		expect(s.assessments[0]).toMatchObject({
			dueAt: "2026-10-11T23:59:00.000Z",
			link: "https://assess.example.com/t/xyz",
		});
	});

	it("interview_invite moves to interviewing and creates an interview", () => {
		ingestEmails(db, emails());
		expect(getApplication(db, globexApp)?.status).toBe("interviewing");
		const ivs = listInterviews(db);
		const globex = ivs.find((i) => i.company_name === "Globex Systems");
		expect(globex).toMatchObject({
			application_id: globexApp,
			source: "email",
			round: "recruiter_screen",
			start_at: "2026-10-20T15:00:00.000Z",
			meeting_link: "https://meet.example.com/abc-defg",
		});
	});

	it("rejection (matched by sender subdomain) moves to rejected", () => {
		ingestEmails(db, emails());
		expect(getApplication(db, initechApp)?.status).toBe("rejected");
		const kinds = listEvents(db, initechApp).map((e) => e.kind);
		expect(kinds).toContain("email");
		expect(kinds).toContain("transition");
	});

	it("low-confidence 'other' mail stays unlinked and changes nothing", () => {
		const r = ingestEmails(db, emails());
		const m4 = r.items.find((i) => i.gmail_message_id === "m-004");
		expect(m4).toMatchObject({ via: "none", application_id: null });
		expect(
			listEmails(db, { unlinked: true }).map((e) => e.gmail_message_id),
		).toEqual(["m-004"]);
		expect(buildSummary(db).emails.needsLinking).toBe(0);
	});

	it("dry-run writes nothing", () => {
		const r = ingestEmails(db, emails(), { dryRun: true });
		expect(r.ingested).toBe(6);
		expect(r.items[0]?.planned).toEqual({
			createApplication: true,
			to: "applied",
		});
		expect(listEmails(db)).toHaveLength(0);
		expect(getApplication(db, initechApp)?.status).toBe("applied");
	});

	it("soft transitions never move backwards", () => {
		ingestEmails(db, emails());
		const late = EmailIngestBatch.parse([
			{
				gmail_message_id: "m-late",
				thread_id: "t-x",
				received_at: "2026-10-09T00:00:00Z",
				from: "noreply@globex.example",
				subject: "Application received",
				kind: "confirmation",
				confidence: 0.99,
			},
		]);
		const r = ingestEmails(db, late);
		expect(r.items[0]?.changed).toBe(false);
		expect(getApplication(db, globexApp)?.status).toBe("interviewing");
	});

	function tailoredApp(): number {
		const c = upsertCompany(db, {
			name: "Umbrella",
			domain: "umbrella.example",
		});
		const j = insertJob(db, { company_id: c.id, title: "Backend Engineer" });
		const id = createApplication(db, {
			job_id: j.id,
			status: "shortlisted",
			source: "conscience",
		}).id;
		db.prepare("UPDATE applications SET status = 'tailored' WHERE id = ?").run(
			id,
		);
		return id;
	}

	it("an interview invite moves a tailored application via applied", () => {
		const app = tailoredApp();
		const r = ingestEmails(
			db,
			EmailIngestBatch.parse([
				{
					gmail_message_id: "u-1",
					thread_id: "u-t1",
					received_at: "2026-10-10T12:00:00Z",
					from: "recruiting@umbrella.example",
					subject: "Interview",
					kind: "interview_invite",
					confidence: 0.95,
					application_id: app,
					interview: { start: "2026-10-20T15:00:00Z" },
				},
			]),
		);
		expect(r.items[0]?.changed).toBe(true);
		expect(r.items[0]?.from_status).toBe("tailored");
		const after = getApplication(db, app);
		expect(after?.status).toBe("interviewing");
		expect(after?.applied_at).not.toBeNull();
	});

	it("a rejection moves a tailored application to rejected", () => {
		const app = tailoredApp();
		ingestEmails(
			db,
			EmailIngestBatch.parse([
				{
					gmail_message_id: "u-r",
					thread_id: "u-tr",
					received_at: "2026-10-10T12:00:00Z",
					from: "noreply@umbrella.example",
					subject: "Update",
					kind: "rejection",
					confidence: 0.95,
					application_id: app,
				},
			]),
		);
		expect(getApplication(db, app)?.status).toBe("rejected");
	});

	it("a reminder for the same interview does not add a second row", () => {
		const app = tailoredApp();
		const mail = (id: string, thread: string, start: string) => ({
			gmail_message_id: id,
			thread_id: thread,
			received_at: "2026-10-10T12:00:00Z",
			from: "recruiting@umbrella.example",
			subject: "Interview",
			kind: "interview_invite",
			confidence: 0.95,
			application_id: app,
			interview: { start },
		});
		ingestEmails(
			db,
			EmailIngestBatch.parse([
				mail("d-1", "d-t1", "2026-10-20T15:00:00Z"),
				mail("d-2", "d-t2", "2026-10-20T11:10:00-04:00"),
			]),
		);
		const rows = listInterviews(db, {}).filter((i) => i.application_id === app);
		expect(rows).toHaveLength(1);
	});

	it("applies emails in received_at order, not input order", () => {
		const app = tailoredApp();
		const base = {
			from: "recruiting@umbrella.example",
			subject: "Next steps",
			confidence: 0.95,
			application_id: app,
		};
		ingestEmails(
			db,
			EmailIngestBatch.parse([
				{
					...base,
					gmail_message_id: "o-new",
					thread_id: "o-t2",
					received_at: "2026-10-12T00:00:00Z",
					kind: "interview_invite",
					interview: { start: "2026-10-20T15:00:00Z" },
				},
				{
					...base,
					gmail_message_id: "o-old",
					thread_id: "o-t1",
					received_at: "2026-10-05T00:00:00Z",
					kind: "assessment",
				},
			]),
		);
		expect(getApplication(db, app)?.status).toBe("interviewing");
	});

	it("an application created from an old email keeps the email's time", () => {
		ingestEmails(
			db,
			EmailIngestBatch.parse([
				{
					gmail_message_id: "old-1",
					thread_id: "old-t",
					received_at: "2026-08-01T09:00:00Z",
					from: "noreply@vandelay.example",
					company: "Vandelay",
					role: "Importer",
					subject: "Thanks for applying",
					kind: "confirmation",
					confidence: 0.99,
				},
			]),
		);
		const c = findCompanyByName(db, "Vandelay");
		const app = listApplications(db, { companyId: c?.id })[0];
		expect(app?.status).toBe("applied");
		const row = db
			.prepare("SELECT last_event_at FROM applications WHERE id = ?")
			.get(app?.id ?? 0) as { last_event_at: string };
		expect(Date.parse(row.last_event_at)).toBe(
			Date.parse("2026-08-01T09:00:00Z"),
		);
	});
});

describe("upsertInterviews", () => {
	it("merges a calendar event within ±30m into the email-sourced interview", () => {
		ingestEmails(db, emails());
		const r = upsertInterviews(db, events());
		expect(r).toEqual({ inserted: 2, updated: 0, merged: 1 });
		const merged = getInterviewByEventId(db, "evt-100");
		expect(merged).toMatchObject({
			source: "email",
			application_id: globexApp,
			round: "recruiter_screen",
			start_at: "2026-10-20T15:15:00.000Z",
		});
		expect(
			listInterviews(db).filter((i) => i.company_name === "Globex Systems"),
		).toHaveLength(1);
	});

	it("does not merge events more than 30 minutes apart", () => {
		ingestEmails(db, emails());
		const far = InterviewUpsertBatch.parse([
			{
				calendar_event_id: "evt-far",
				company: "Globex Systems",
				start: "2026-10-20T16:00:00Z",
				end: "2026-10-20T16:30:00Z",
				tz: "UTC",
			},
		]);
		expect(upsertInterviews(db, far)).toEqual({
			inserted: 1,
			updated: 0,
			merged: 0,
		});
	});

	it("a cancelled event sets status cancelled, and re-upsert updates", () => {
		upsertInterviews(db, events());
		expect(getInterviewByEventId(db, "evt-102")?.status).toBe("cancelled");
		const cancel = InterviewUpsertBatch.parse([
			{
				...(fixture("calendar-sample.json") as object[])[1],
				status: "cancelled",
			},
		]);
		expect(upsertInterviews(db, cancel)).toEqual({
			inserted: 0,
			updated: 1,
			merged: 0,
		});
		expect(getInterviewByEventId(db, "evt-101")?.status).toBe("cancelled");
		expect(listInterviews(db).map((i) => i.calendar_event_id)).not.toContain(
			"evt-101",
		);
	});

	it("a calendar interview moves a linked application to interviewing", () => {
		const ev = InterviewUpsertBatch.parse([
			{
				calendar_event_id: "evt-init",
				company: "Initech",
				start: "2026-10-25T10:00:00Z",
				end: "2026-10-25T11:00:00Z",
				tz: "UTC",
			},
		]);
		upsertInterviews(db, ev);
		expect(getApplication(db, initechApp)?.status).toBe("interviewing");
	});
});

describe("CLI: jh email / interview / sync", () => {
	let out: string[];

	beforeEach(() => {
		process.env.JOB_HUNTER_DB = join(home, "cli.db");
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
		registerEmail(program);
		registerInterview(program);
		registerSync(program);
		await program.parseAsync(argv, { from: "user" });
		return JSON.parse(out.join("").trim().split("\n").at(-1) ?? "null");
	}

	const fixturePath = (name: string) =>
		fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));

	it("ingests, lists and links email; validation errors exit 2", async () => {
		const r = await jh(
			"email",
			"ingest",
			"--file",
			fixturePath("gmail-sample.json"),
			"--json",
		);
		expect(r).toMatchObject({ ingested: 5, duplicates: 1 });
		const created = (
			r as { items: { gmail_message_id: string; application_id: number }[] }
		).items.find((i) => i.gmail_message_id === "m-002")?.application_id;
		// No seeded Initech app here: the rejection and the digest stay unlinked.
		const unlinked = (await jh("email", "list", "--unlinked", "--json")) as {
			id: number;
			gmail_message_id: string;
		}[];
		expect(unlinked.map((e) => e.gmail_message_id).sort()).toEqual([
			"m-003",
			"m-004",
		]);
		const rejection = unlinked.find((e) => e.gmail_message_id === "m-003");
		const linked = (await jh(
			"email",
			"link",
			String(rejection?.id),
			String(created),
			"--json",
		)) as { transition: { from: string; to: string; changed: boolean } };
		expect(linked.transition).toEqual({
			from: "interviewing",
			to: "rejected",
			changed: true,
		});

		const bad = join(home, "bad.json");
		writeFileSync(bad, JSON.stringify([{ gmail_message_id: "x" }]));
		const err = (await jh("email", "ingest", "--file", bad, "--json")) as {
			error: string;
		};
		expect(err.error).toBe("validation");
		expect(process.exitCode).toBe(2);
	});

	it("upserts and lists interviews; prep paths must be under artifacts", async () => {
		const r = await jh(
			"interview",
			"upsert",
			"--file",
			fixturePath("calendar-sample.json"),
			"--json",
		);
		expect(r).toEqual({ inserted: 3, updated: 0, merged: 0 });
		const all = (await jh("interview", "list", "--json")) as { id: number }[];
		expect(all).toHaveLength(2);
		const id = String(all[0]?.id);
		const err = (await jh(
			"interview",
			"prep",
			id,
			"--status",
			"ready",
			"--path",
			join(home, "x.md"),
			"--json",
		)) as { error: string };
		expect(err.error).toBe("validation");
		const okPath = join(home, "artifacts", "unlinked", `prep-${id}.md`);
		const ok = (await jh(
			"interview",
			"prep",
			id,
			"--status",
			"ready",
			"--path",
			okPath,
			"--json",
		)) as { prep_status: string; prep_path: string };
		expect(ok).toMatchObject({ prep_status: "ready", prep_path: okPath });
	});

	it("sync begin/end round trip returns the last good cursor", async () => {
		const b = (await jh("sync", "begin", "--kind", "gmail", "--json")) as {
			runId: number;
			cursor: string | null;
		};
		expect(b.cursor).toBeNull();
		await jh(
			"sync",
			"end",
			String(b.runId),
			"--ok",
			"--items",
			"4",
			"--new",
			"2",
			"--cursor",
			"2026-10-06T11:00:00Z",
			"--json",
		);
		const b2 = (await jh("sync", "begin", "--kind", "gmail", "--json")) as {
			runId: number;
			cursor: string;
		};
		expect(b2.cursor).toBe("2026-10-06T11:00:00Z");
		await jh(
			"sync",
			"end",
			String(b2.runId),
			"--error",
			"connector_unavailable",
			"--json",
		);
		const st = (await jh("sync", "status", "--json")) as {
			kind: string;
			error: string | null;
		}[];
		expect(st[0]).toMatchObject({
			kind: "gmail",
			error: "connector_unavailable",
		});
		const twice = (await jh(
			"sync",
			"end",
			String(b2.runId),
			"--error",
			"x_y",
			"--json",
		)) as { error: string };
		expect(twice.error).toBe("sync_run_already_finished");
		const both = (await jh(
			"sync",
			"end",
			String(b2.runId),
			"--ok",
			"--error",
			"x_y",
			"--json",
		)) as { error: string };
		expect(both.error).toBe("validation");
	});
});
