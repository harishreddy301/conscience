import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppStatus } from "../../src/core/state.js";
import { type Db, openDb } from "../../src/db/index.js";
import {
	createApplication,
	insertJob,
	upsertCompany,
} from "../../src/db/repo.js";
import { insertEmail } from "../../src/db/tracking.js";
import {
	domainCandidates,
	domainOf,
	effectFor,
	isSharedSenderDomain,
	resolveLink,
} from "../../src/tracking/email-link.js";
import {
	EmailIngestItem,
	type EmailIngestItem as Item,
} from "../../src/tracking/schemas.js";

let home: string;
let db: Db;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jh-link-"));
	process.env.JOB_HUNTER_HOME = home;
	db = openDb(":memory:");
});
afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
	delete process.env.JOB_HUNTER_HOME;
});

function makeApp(name: string, domain: string | undefined, title = "Engineer") {
	const c = upsertCompany(db, { name, domain });
	const j = insertJob(db, { company_id: c.id, title });
	const a = createApplication(db, {
		job_id: j.id,
		status: "applied",
		source: "external",
	});
	return { companyId: c.id, appId: a.id };
}

function item(over: Partial<Record<string, unknown>> = {}): Item {
	return EmailIngestItem.parse({
		gmail_message_id: `m-${Math.random()}`,
		thread_id: "t-new",
		received_at: "2026-10-01T10:00:00Z",
		from: "Someone <someone@nowhere.example>",
		subject: "Hello",
		kind: "other",
		confidence: 0.9,
		...over,
	});
}

describe("domain helpers", () => {
	it("extracts the sender domain from display-name addresses", () => {
		expect(domainOf('"Jo Smith" <Jo@Mail.Acme.Example>')).toBe(
			"mail.acme.example",
		);
		expect(domainOf("plain@globex.example")).toBe("globex.example");
	});

	it("lists parent domains", () => {
		expect(domainCandidates("a.b.acme.example")).toEqual([
			"a.b.acme.example",
			"b.acme.example",
			"acme.example",
		]);
	});

	it("treats ATS and mailbox domains as shared", () => {
		expect(isSharedSenderDomain("greenhouse-mail.io")).toBe(true);
		expect(isSharedSenderDomain("us.myworkday.com")).toBe(true);
		expect(isSharedSenderDomain("gmail.com")).toBe(true);
		expect(isSharedSenderDomain("globex.example")).toBe(false);
	});
});

describe("resolveLink precedence", () => {
	it("explicit application id wins over everything", () => {
		const a = makeApp("Acme", "acme.example");
		const b = makeApp("Globex", "globex.example");
		const r = resolveLink(
			db,
			item({
				application_id: a.appId,
				from: "x@globex.example",
				company: "Globex",
			}),
		);
		expect(r).toEqual({
			applicationId: a.appId,
			companyId: a.companyId,
			via: "explicit",
		});
		expect(b.appId).not.toBe(a.appId);
	});

	it("an unknown explicit id falls through to the next rule", () => {
		const g = makeApp("Globex", "globex.example");
		const r = resolveLink(
			db,
			item({ application_id: 9999, from: "x@globex.example" }),
		);
		expect(r.via).toBe("domain");
		expect(r.applicationId).toBe(g.appId);
	});

	it("thread beats domain", () => {
		const a = makeApp("Acme", "acme.example");
		makeApp("Globex", "globex.example");
		insertEmail(db, {
			gmail_message_id: "seed",
			thread_id: "t-shared",
			received_at: "2026-09-01T00:00:00Z",
			from_addr: "x@acme.example",
			from_domain: "acme.example",
			subject: "seed",
			kind: "confirmation",
			confidence: 1,
			application_id: a.appId,
			company_id: a.companyId,
		});
		const r = resolveLink(
			db,
			item({ thread_id: "t-shared", from: "y@globex.example" }),
		);
		expect(r).toEqual({
			applicationId: a.appId,
			companyId: a.companyId,
			via: "thread",
		});
	});

	it("domain matches parent domains and beats the company hint", () => {
		const g = makeApp("Globex", "globex.example");
		makeApp("Acme", "acme.example");
		const r = resolveLink(
			db,
			item({ from: "t@mail.globex.example", company: "Acme" }),
		);
		expect(r).toEqual({
			applicationId: g.appId,
			companyId: g.companyId,
			via: "domain",
		});
	});

	it("skips ATS sender domains and uses the company hint", () => {
		const h = makeApp("Hooli", "greenhouse.io");
		const r = resolveLink(
			db,
			item({ from: "no-reply@greenhouse.io", company: "Hooli Inc." }),
		);
		expect(r.via).toBe("company_hint");
		expect(r.applicationId).toBe(h.appId);
	});

	it("returns none when nothing matches", () => {
		makeApp("Acme", "acme.example");
		expect(resolveLink(db, item({ from: "x@unknown.example" }))).toEqual({
			applicationId: null,
			companyId: null,
			via: "none",
		});
	});
});

describe("effectFor", () => {
	const cases: [
		Parameters<typeof effectFor>[0],
		AppStatus | null,
		number,
		ReturnType<typeof effectFor>,
	][] = [
		["confirmation", null, 0.9, { createApplication: true, to: "applied" }],
		["confirmation", null, 0.7, {}],
		["confirmation", "tailored", 0.7, { to: "applied" }],
		["confirmation", "applied", 0.9, {}],
		["rejection", "applied", 0.9, { to: "rejected" }],
		["rejection", null, 0.99, {}],
		[
			"interview_invite",
			"applied",
			0.8,
			{ to: "interviewing", createInterview: true },
		],
		[
			"interview_invite",
			null,
			0.85,
			{ to: "interviewing", createApplication: true, createInterview: true },
		],
		["interview_invite", null, 0.7, { createInterview: true }],
		["assessment", "applied", 0.8, { to: "assessment" }],
		["recruiter", "applied", 0.95, {}],
		["other", null, 1, {}],
		["rejection", "applied", 0.4, {}],
	];
	it.each(cases)("%s from %s at %s", (kind, current, conf, expected) => {
		expect(effectFor(kind, current, conf)).toEqual(expected);
	});
});
