import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { register as registerAutopilot } from "../../src/commands/autopilot.js";
import { buildOps, parseAssignment } from "../../src/commands/policy.js";
import { ValidationError } from "../../src/core/errors.js";
import { canTransition, transition } from "../../src/core/state.js";
import { type Db, openDb, userVersion } from "../../src/db/index.js";
import { MIGRATIONS } from "../../src/db/migrations.js";
import {
	addEscalation,
	companyStats,
	listEscalations,
	resolveEscalation,
} from "../../src/db/policy.js";
import {
	createApplication,
	getApplication,
	insertJob,
	upsertCompany,
} from "../../src/db/repo.js";
import type { Profile } from "../../src/me/schema.js";
import { checkPolicy } from "../../src/policy/check.js";
import {
	evaluateEligibility,
	screenText,
} from "../../src/policy/eligibility.js";
import { type PolicyGateInput, policyGate } from "../../src/policy/gate.js";
import {
	buildEffective,
	type EffectivePolicy,
	loadEffective,
	parsePolicy,
	recordPolicy,
} from "../../src/policy/load.js";
import { ESCALATE_KINDS } from "../../src/policy/schema.js";
import {
	type CompanyStats,
	type TriageCandidate,
	triage,
} from "../../src/policy/triage.js";

const ROOT = join(import.meta.dirname, "..", "..");
const TEMPLATE = join(ROOT, "templates", "me", "decision-policy.example.yaml");
const FIX = join(ROOT, "tests", "fixtures", "policy");

const PROFILE = {
	version: 1,
	identity: { name: "Pat Example", email: "pat@example.com", location: "X" },
	targets: {
		roles: ["Forward Deployed Engineer", "AI Engineer"],
		seniority: ["mid", "senior"],
		title_exclude: ["intern"],
	},
	company_blocklist: ["Globex"],
	autonomy: { daily_apply_cap: 20, submit_without_confirm: false },
} as unknown as Profile;

const BASE_RAW = {
	tracks: {
		fde: { title_patterns: ["forward deployed"] },
		data_engineer: { title_patterns: ["data engineer"] },
	},
	triage: { titles: { exclude_tracks: ["data_engineer"] } },
	gates: {
		by_track: { fde: { verdicts: ["interview", "maybe"], ats_min: 80 } },
	},
};

function eff(raw: Record<string, unknown> = BASE_RAW, profile = PROFILE) {
	return buildEffective(structuredClone(raw), profile);
}

let tmp: string;
beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "jh-policy-"));
});
afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

// ------------------------------------------------------------------ schema

describe("policy schema", () => {
	it("fills every section from defaults", () => {
		const p = parsePolicy({});
		expect(p.rev).toBe(0);
		expect(p.triage.recency).toEqual({
			prefer_days: 14,
			strong_fit_days: 21,
			max_days: 30,
		});
		expect(p.triage.per_company).toEqual({
			max_total: 2,
			max_new_if_applied: 1,
		});
		expect(p.gates.default).toMatchObject({
			verdicts: ["interview"],
			ats_min: 80,
		});
		expect(p.submit.confirm).toBe("per_batch");
		expect(p.escalate.kinds).toEqual([...ESCALATE_KINDS]);
		expect(p.throughput).toMatchObject({
			tailor_parallel: 3,
			submit_parallel_tabs: 3,
		});
	});

	it("parses the shipped template", () => {
		const raw = parseYaml(readFileSync(TEMPLATE, "utf8"));
		const p = parsePolicy(raw);
		expect(p.preflight.account_ats.workday).toBe("logged_in_only");
		expect(Object.keys(p.tracks)).toContain("fde");
	});

	it("rejects recency out of order and unknown enum values", () => {
		expect(() =>
			parsePolicy({ triage: { recency: { prefer_days: 30, max_days: 14 } } }),
		).toThrow(ValidationError);
		expect(() => parsePolicy({ submit: { confirm: "always" } })).toThrow(
			ValidationError,
		);
		expect(() =>
			parsePolicy({ escalate: { kinds: ["ask_about_everything"] } }),
		).toThrow(ValidationError);
	});

	it("merges the profile layer below the policy", () => {
		const e = eff({
			...BASE_RAW,
			triage: { ...BASE_RAW.triage, company_blocklist: ["Initech"] },
			preflight: { daily_cap: 50 },
		});
		expect(e.derived.target_titles).toContain("AI Engineer");
		expect(e.policy.preflight.daily_cap).toBe(50);
	});
});

// ------------------------------------------------------------------ record

describe("jh policy record", () => {
	function file(): string {
		const f = join(tmp, "decision-policy.yaml");
		writeFileSync(
			f,
			"# my comment stays\nversion: 1\nrev: 0\nsubmit:\n  confirm: per_batch\ncorrections: []\n",
		);
		return f;
	}

	it("applies ops, appends a correction, bumps rev and keeps comments", () => {
		const f = file();
		const r = recordPolicy(
			{
				actor: "conscience",
				ops: [{ op: "set", path: "triage.recency.prefer_days", value: 10 }],
				reason: "user said 10 days in chat",
			},
			f,
		);
		expect(r.rev).toBe(1);
		const text = readFileSync(f, "utf8");
		expect(text).toContain("# my comment stays");
		const e = loadEffective({ path: f, profile: null });
		expect(e.rev).toBe(1);
		expect(e.policy.triage.recency.prefer_days).toBe(10);
		expect(e.policy.corrections).toHaveLength(1);
		expect(e.policy.corrections[0]).toMatchObject({
			rev: 1,
			actor: "conscience",
		});

		const r2 = recordPolicy(
			{
				actor: "conscience",
				ops: [
					{ op: "add", path: "triage.company_blocklist", value: "Initech" },
				],
			},
			f,
		);
		expect(r2.rev).toBe(2);
		const e2 = loadEffective({ path: f, profile: null });
		expect(e2.policy.corrections.map((c) => c.rev)).toEqual([1, 2]);
		expect(e2.policy.triage.company_blocklist).toEqual(["Initech"]);
	});

	it("refuses user-only fields for any actor but the user", () => {
		const f = file();
		const tryAs = (
			actor: string,
			path: string,
			op: "set" | "add" = "set",
			value: unknown = "standing",
		) => recordPolicy({ actor, ops: [{ op, path, value }] }, f);
		expect(() => tryAs("conscience", "submit.confirm")).toThrow(
			/only be changed by the user/,
		);
		expect(() => tryAs("conscience", "submit")).toThrow(/user/);
		expect(() =>
			tryAs("conscience", "eligibility.overrides", "add", {
				app_id: 7,
				action: "apply_truthfully",
			}),
		).toThrow(/user/);
		expect(() => tryAs("conscience", "eligibility")).toThrow(/user/);
		expect(() =>
			recordPolicy(
				{
					actor: "conscience",
					ops: [
						{ op: "remove", path: "escalate.kinds", value: "spending_money" },
					],
				},
				f,
			),
		).toThrow(/only the user can remove an escalate kind/);
		// nothing was written
		expect(loadEffective({ path: f, profile: null }).rev).toBe(0);
	});

	it("lets the user change them, with a quote", () => {
		const f = file();
		expect(() =>
			recordPolicy(
				{
					actor: "user",
					ops: [{ op: "set", path: "submit.confirm", value: "standing" }],
				},
				f,
			),
		).toThrow(/--quote/);
		recordPolicy(
			{
				actor: "user",
				quote: "make it official",
				ops: [{ op: "set", path: "submit.confirm", value: "standing" }],
			},
			f,
		);
		const e = loadEffective({ path: f, profile: null });
		expect(e.policy.submit.confirm).toBe("standing");
		expect(checkPolicy(e).conflicts.map((c) => c.code)).not.toContain(
			"standing_not_user_set",
		);
		recordPolicy(
			{
				actor: "user",
				quote: "no need to ask me about money",
				ops: [
					{ op: "remove", path: "escalate.kinds", value: "spending_money" },
				],
			},
			f,
		);
		const e2 = loadEffective({ path: f, profile: null });
		expect(e2.policy.escalate.kinds).not.toContain("spending_money");
		expect(checkPolicy(e2).ok).toBe(true);
	});

	it("refuses non-writable roots and invalid results", () => {
		const f = file();
		expect(() =>
			recordPolicy(
				{ actor: "conscience", ops: [{ op: "set", path: "rev", value: 9 }] },
				f,
			),
		).toThrow(/not writable/);
		expect(() =>
			recordPolicy(
				{
					actor: "conscience",
					ops: [{ op: "set", path: "throughput.tailor_parallel", value: 99 }],
				},
				f,
			),
		).toThrow(ValidationError);
		expect(loadEffective({ path: f, profile: null }).rev).toBe(0);
	});

	it("parses --set/--add/--remove arguments as YAML", () => {
		expect(parseAssignment("submit.confirm=standing")).toEqual({
			path: "submit.confirm",
			value: "standing",
		});
		expect(
			parseAssignment(
				"eligibility.overrides={app_id: 80, action: apply_truthfully}",
			),
		).toEqual({
			path: "eligibility.overrides",
			value: { app_id: 80, action: "apply_truthfully" },
		});
		expect(buildOps({ set: ["a.b=1"], add: ["c=x"], remove: [] })).toEqual([
			{ op: "set", path: "a.b", value: 1 },
			{ op: "add", path: "c", value: "x" },
		]);
		expect(() => parseAssignment("nope")).toThrow(ValidationError);
	});
});

// ------------------------------------------------------------------ precedence and check

describe("precedence and jh policy check", () => {
	it("corrections win over a hand edit, and check reports it", () => {
		const raw = {
			...BASE_RAW,
			rev: 1,
			triage: { ...BASE_RAW.triage, recency: { prefer_days: 7 } },
			corrections: [
				{
					rev: 1,
					at: "2026-10-21T00:00:00Z",
					actor: "conscience",
					ops: [{ op: "set", path: "triage.recency.prefer_days", value: 10 }],
				},
			],
		};
		const e = eff(raw);
		expect(e.file.triage.recency.prefer_days).toBe(7);
		expect(e.policy.triage.recency.prefer_days).toBe(10);
		const c = checkPolicy(e);
		expect(c.ok).toBe(false);
		expect(c.conflicts.map((x) => x.code)).toContain("hand_edit_overridden");
	});

	it("flags a standing approval nobody recorded and a profile mirror mismatch", () => {
		const e = eff({ ...BASE_RAW, submit: { confirm: "standing" } });
		const codes = checkPolicy(e).conflicts.map((x) => x.code);
		expect(codes).toContain("standing_not_user_set");
		expect(codes).toContain("submit_mirror_mismatch");
	});

	it("flags unknown tracks and escalate kinds removed without the user", () => {
		const e = eff({
			...BASE_RAW,
			triage: { titles: { exclude_tracks: ["nope"] } },
			escalate: { kinds: ["hard_fact_unknown"] },
		});
		const codes = checkPolicy(e).conflicts.map((x) => x.code);
		expect(codes).toContain("unknown_track");
		expect(codes).toContain("escalate_kind_missing");
	});

	it("is clean for a consistent policy", () => {
		expect(checkPolicy(eff()).ok).toBe(true);
	});
});

// ------------------------------------------------------------------ triage

const NOW = new Date("2026-10-21T12:00:00Z");
function daysAgo(n: number): string {
	return new Date(NOW.getTime() - n * 86_400_000).toISOString();
}

let nextId = 1;
function cand(
	p: Partial<TriageCandidate> & { age?: number | null },
): TriageCandidate {
	const { age = 1, ...rest } = p;
	return {
		app_id: nextId++,
		company_id: 1,
		company: "Acme",
		title: "Forward Deployed Engineer",
		status: "shortlisted",
		posted_at: age === null ? null : daysAgo(age),
		user_link: false,
		...rest,
	};
}

function run(
	cands: TriageCandidate[],
	o: {
		companies?: Map<number, CompanyStats>;
		strong?: number[];
		e?: EffectivePolicy;
	} = {},
) {
	return triage(o.e ?? eff(), {
		candidates: cands,
		companies: o.companies ?? new Map(),
		strong: new Set(o.strong ?? []),
		now: NOW,
	});
}

describe("policy eval triage: recency boundaries 14 / 21 / 30", () => {
	it.each([
		[0, false, false, "include"],
		[14, false, false, "include"],
		[15, false, false, "review"],
		[15, true, false, "include"],
		[21, true, false, "include"],
		[22, true, false, "skip"],
		[22, false, true, "include"],
		[30, false, true, "include"],
		[31, false, true, "skip"],
		[31, true, false, "skip"],
	] as const)(
		"age %i strong=%s userLink=%s -> %s",
		(age, strong, userLink, want) => {
			const c = cand({ age, company_id: 100 + age, user_link: userLink });
			const [r] = run([c], { strong: strong ? [c.app_id] : [] });
			expect(r?.decision).toBe(want);
		},
	);

	it("sends an unknown posting date to review", () => {
		const [r] = run([cand({ age: null })]);
		expect(r?.decision).toBe("review");
		expect(r?.reasons.join()).toMatch(/unknown/);
	});
});

describe("policy eval triage: titles, level band, blocklist", () => {
	it("skips excluded tracks, off-target titles and out-of-band levels", () => {
		const rs = run([
			cand({ title: "Senior Data Engineer", company_id: 11 }),
			cand({ title: "Account Executive", company_id: 12 }),
			cand({ title: "AI Engineer Intern", company_id: 13 }),
			cand({ title: "Senior AI Engineer", company_id: 14 }),
			cand({ title: "Software Engineer, Forward Deployed", company_id: 15 }),
		]);
		const by = Object.fromEntries(rs.map((r) => [r.title, r]));
		expect(by["Senior Data Engineer"]?.decision).toBe("skip");
		expect(by["Senior Data Engineer"]?.reasons.join()).toMatch(
			/excluded track/,
		);
		expect(by["Account Executive"]?.decision).toBe("skip");
		expect(by["AI Engineer Intern"]?.reasons.join()).toMatch(/level band/);
		expect(by["Senior AI Engineer"]?.decision).toBe("include");
		expect(by["Software Engineer, Forward Deployed"]?.decision).toBe("include");
		expect(by["Software Engineer, Forward Deployed"]?.track).toBe("fde");
	});

	it("blocks companies from the policy and the profile, case and spacing insensitive", () => {
		const e = eff({
			...BASE_RAW,
			triage: { ...BASE_RAW.triage, company_blocklist: ["4minds"] },
		});
		const rs = run(
			[
				cand({ company: "4MindsAI Inc.", company_id: 21 }),
				cand({ company: "Globex Corp", company_id: 22 }),
				cand({ company: "4minds", company_id: 23, user_link: true }),
			],
			{ e },
		);
		expect(rs.map((r) => r.decision)).toEqual(["review", "skip", "skip"]);
	});

	it("user links go first and bypass title filters", () => {
		const rs = run([
			cand({ title: "Data Engineer", company_id: 31 }),
			cand({ title: "Data Engineer", company_id: 32, user_link: true }),
		]);
		expect(rs[0]?.user_link).toBe(true);
		expect(rs[0]?.decision).toBe("include");
		expect(rs[1]?.decision).toBe("skip");
	});
});

describe("policy eval triage: per-company caps", () => {
	it("allows max_total new per fresh company, freshest first", () => {
		const rs = run([cand({ age: 5 }), cand({ age: 1 }), cand({ age: 3 })]);
		expect(rs.map((r) => [r.age_days, r.decision])).toEqual([
			[1, "include"],
			[3, "include"],
			[5, "skip"],
		]);
		expect(rs[2]?.reasons.join()).toMatch(/company cap/);
	});

	it("allows only max_new_if_applied once one is submitted", () => {
		const rs = run([cand({}), cand({})], {
			companies: new Map([[1, { in_flight: 1, applied: 1 }]]),
		});
		expect(rs.map((r) => r.decision)).toEqual(["include", "skip"]);
	});

	it("allows none when the company is at max_total", () => {
		const rs = run([cand({})], {
			companies: new Map([[1, { in_flight: 2, applied: 2 }]]),
		});
		expect(rs[0]?.decision).toBe("skip");
	});

	it("counts tailored and held but not dismissed applications", () => {
		const db = openDb(":memory:");
		try {
			const co = upsertCompany(db, { name: "Acme" });
			for (const status of ["tailored", "dismissed", "applied"] as const) {
				const job = insertJob(db, { company_id: co.id, title: `R ${status}` });
				createApplication(db, { job_id: job.id, status });
			}
			expect(companyStats(db).get(co.id)).toEqual({ in_flight: 2, applied: 1 });
		} finally {
			db.close();
		}
	});
});

// ------------------------------------------------------------------ eligibility

function fixture(name: string): string {
	return readFileSync(join(FIX, `${name}.fixture.jd.txt`), "utf8");
}

describe("policy eval eligibility (regex fixtures)", () => {
	it.each([
		["clearance-required", "skip", "clearance"],
		["clearance-preferred", "eligible", "clearance"],
		["citizen-only", "skip", "citizen_only"],
		["green-card", "skip", "green_card_only"],
		["no-sponsorship", "skip", "no_sponsorship"],
		["gov-mentioned", "review", "government_client"],
		["clean", "eligible", null],
	] as const)("%s -> %s", (name, verdict, rule) => {
		const r = evaluateEligibility(eff(), 5, { jd: fixture(name) });
		expect(r.verdict).toBe(verdict);
		if (rule) expect(r.findings.map((f) => f.rule)).toContain(rule);
		else expect(r.findings).toEqual([]);
	});

	it("distinguishes 'clearance preferred' from 'clearance required'", () => {
		expect(screenText("Secret clearance preferred.", "jd")[0]?.strength).toBe(
			"preferred",
		);
		expect(screenText("Secret clearance required.", "jd")[0]?.strength).toBe(
			"required",
		);
		expect(
			screenText("Must be able to obtain a security clearance.", "jd")[0]
				?.strength,
		).toBe("required");
		expect(
			screenText("An active clearance is a plus.", "jd")[0]?.strength,
		).toBe("preferred");
	});

	it("keeps 'U.S. citizen' in one sentence", () => {
		expect(
			screenText("You must be a U.S. citizen. We ship fast.", "jd"),
		).toEqual([
			expect.objectContaining({ rule: "citizen_only", strength: "required" }),
		]);
	});

	it("ignores ordinary citizenship and sponsorship questions on a form", () => {
		const form =
			"Are you a U.S. citizen?\nWill you now or in the future require visa sponsorship?";
		expect(evaluateEligibility(eff(), 5, { form }).verdict).toBe("eligible");
	});

	it("scans the form too", () => {
		const form =
			"This role requires an active Top Secret clearance. Do you hold one?";
		const r = evaluateEligibility(eff(), 5, { jd: fixture("clean"), form });
		expect(r.verdict).toBe("skip");
		expect(r.scanned).toEqual(["jd", "form"]);
		expect(r.findings[0]?.source).toBe("form");
	});

	it("a user override applies truthfully", () => {
		const e = eff({
			...BASE_RAW,
			eligibility: { overrides: [{ app_id: 80, action: "apply_truthfully" }] },
		});
		const r = evaluateEligibility(e, 80, { jd: fixture("no-sponsorship") });
		expect(r.verdict).toBe("apply_truthfully");
		expect(r.findings).toHaveLength(1);
		expect(
			evaluateEligibility(e, 81, { jd: fixture("no-sponsorship") }).verdict,
		).toBe("skip");
	});

	it("honours skip_if and scan", () => {
		const e = eff({
			...BASE_RAW,
			eligibility: { skip_if: ["clearance"], scan: ["jd"] },
		});
		expect(
			evaluateEligibility(e, 1, { jd: fixture("no-sponsorship") }).verdict,
		).toBe("eligible");
		expect(
			evaluateEligibility(e, 1, { form: "Active TS/SCI clearance required." })
				.verdict,
		).toBe("eligible");
	});
});

// ------------------------------------------------------------------ gate

describe("policy eval gate", () => {
	const base: PolicyGateInput = {
		title: "AI Engineer",
		ats: 85,
		hm_verdict: "interview",
		recruiter_passes: 7,
		valid: true,
		factcheck: "pass",
		layout_pass: true,
	};
	it.each([
		["default interview ats 85", {}, true],
		["default maybe", { hm_verdict: "maybe" }, false],
		["default ats 79", { ats: 79 }, false],
		[
			"fde maybe ats 80",
			{ title: "Forward Deployed Engineer", hm_verdict: "maybe", ats: 80 },
			true,
		],
		[
			"fde maybe ats 79",
			{ title: "Forward Deployed Engineer", hm_verdict: "maybe", ats: 79 },
			false,
		],
		[
			"fde reject",
			{ title: "Forward Deployed Engineer", hm_verdict: "reject" },
			false,
		],
		["recruiter 5", { recruiter_passes: 5 }, false],
		["fact check missing", { factcheck: "none" }, false],
		["layout failed", { layout_pass: false }, false],
		["layout unknown", { layout_pass: null }, false],
		["invalid", { valid: false }, false],
	] as const)("%s", (_name, patch, pass) => {
		const r = policyGate(eff(), { ...base, ...patch } as PolicyGateInput);
		expect(r.pass, r.reasons.join("; ")).toBe(pass);
	});

	it("skips the layout check when not required", () => {
		const e = eff({
			...BASE_RAW,
			gates: { ...BASE_RAW.gates, layout: { required: false } },
		});
		expect(policyGate(e, { ...base, layout_pass: null }).pass).toBe(true);
	});
});

// ------------------------------------------------------------------ held + escalations

describe("held state and escalation queue", () => {
	let db: Db;
	let home: string;
	let saved: string | undefined;
	beforeEach(() => {
		saved = process.env.JOB_HUNTER_HOME;
		home = join(tmp, "home");
		process.env.JOB_HUNTER_HOME = home;
		db = openDb(":memory:");
	});
	afterEach(() => {
		db.close();
		if (saved === undefined) delete process.env.JOB_HUNTER_HOME;
		else process.env.JOB_HUNTER_HOME = saved;
	});

	function app(status: "shortlisted" | "tailored" = "shortlisted"): number {
		const co = upsertCompany(db, { name: "Acme" });
		const job = insertJob(db, { company_id: co.id, title: `R${nextId++}` });
		return createApplication(db, { job_id: job.id, status }).id;
	}

	it("has held edges", () => {
		expect(canTransition("shortlisted", "held")).toBe(true);
		expect(canTransition("tailored", "held")).toBe(true);
		expect(canTransition("held", "tailored")).toBe(true);
		expect(canTransition("held", "shortlisted")).toBe(true);
		expect(canTransition("held", "dismissed")).toBe(true);
		expect(canTransition("held", "withdrawn")).toBe(true);
		expect(canTransition("held", "applied")).toBe(false);
		expect(canTransition("held", "applied", { external: true })).toBe(true);
		expect(canTransition("applied", "held")).toBe(false);
	});

	it("needs a reason, stores it, and clears it on release", () => {
		const id = app("tailored");
		expect(() => transition(db, id, "held", { actor: "conscience" })).toThrow(
			/reason/,
		);
		transition(db, id, "held", {
			actor: "conscience",
			note: "blocked:account",
		});
		const held = getApplication(db, id) as unknown as Record<string, unknown>;
		expect(held.status).toBe("held");
		expect(held.hold_reason).toBe("blocked:account");
		transition(db, id, "tailored", { actor: "user" });
		const back = getApplication(db, id) as unknown as Record<string, unknown>;
		expect(back.status).toBe("tailored");
		expect(back.hold_reason).toBeNull();
	});

	it("migrates a v3 database with data and keeps foreign keys intact", () => {
		const f = join(tmp, "v3.db");
		const raw = new DatabaseSync(f);
		raw.exec("PRAGMA foreign_keys=ON");
		for (const sql of MIGRATIONS.slice(0, 3)) raw.exec(sql as string);
		raw.exec("PRAGMA user_version=3");
		raw.exec(`INSERT INTO companies(id,name,name_norm,created_at) VALUES(1,'Acme','acme','t');
			INSERT INTO jobs(id,company_id,title,title_norm,discovered_at) VALUES(1,1,'FDE','fde','t');
			INSERT INTO applications(id,job_id,status,last_event_at,created_at,updated_at) VALUES(1,1,'shortlisted','t','t','t');
			INSERT INTO application_events(application_id,kind,actor,at) VALUES(1,'note','t','t');`);
		expect(() =>
			raw.prepare("UPDATE applications SET status='held' WHERE id=1").run(),
		).toThrow(/CHECK/);
		raw.close();

		const d = openDb(f);
		try {
			expect(userVersion(d)).toBe(MIGRATIONS.length);
			transition(d, 1, "held", { actor: "t", note: "r" });
			expect(
				(getApplication(d, 1) as unknown as Record<string, unknown>)
					.hold_reason,
			).toBe("r");
			expect(() =>
				d.prepare("UPDATE applications SET status='bogus' WHERE id=1").run(),
			).toThrow(/CHECK/);
			expect(() =>
				d
					.prepare(
						"INSERT INTO application_events(application_id,kind,actor,at) VALUES(999,'note','t','t')",
					)
					.run(),
			).toThrow(/FOREIGN KEY/);
			expect(d.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
			expect(
				(
					d.prepare("PRAGMA integrity_check").get() as {
						integrity_check: string;
					}
				).integrity_check,
			).toBe("ok");
			const names = (
				d
					.prepare("SELECT name FROM sqlite_master WHERE type='table'")
					.all() as {
					name: string;
				}[]
			).map((r) => r.name);
			expect(names).toContain("escalations");
			expect(names).not.toContain("applications__v4");
		} finally {
			d.close();
		}
	});

	it("dedups open escalations, lists blocking first, resolves", () => {
		const id = app();
		const a = addEscalation(db, {
			kind: "hard_fact_unknown",
			application_id: id,
			question: "High school name?",
			actor: "conscience",
		});
		const b = addEscalation(db, {
			kind: "hard_fact_unknown",
			application_id: id,
			question: "High school name?",
			actor: "conscience",
		});
		expect(a.created).toBe(true);
		expect(b.created).toBe(false);
		expect(b.row.id).toBe(a.row.id);
		const c = addEscalation(db, {
			kind: "account_creation_signin_sso",
			question: "Create a Workday account for Initech?",
			blocking: true,
			actor: "application-submitter",
		});
		expect(listEscalations(db).map((x) => x.id)).toEqual([c.row.id, a.row.id]);
		resolveEscalation(db, a.row.id, {
			status: "answered",
			answer: "Lincoln High",
			by: "user",
		});
		expect(listEscalations(db).map((x) => x.id)).toEqual([c.row.id]);
		expect(listEscalations(db, { status: "all" })).toHaveLength(2);
		expect(() =>
			db
				.prepare(
					"INSERT INTO escalations(kind, question, actor, created_at) VALUES('ask_everything','q','x','t')",
				)
				.run(),
		).toThrow(/CHECK/);
	});
});

// ------------------------------------------------------------------ CLI: escalations

describe("jh autopilot escalations (CLI)", () => {
	const KEYS = ["JOB_HUNTER_HOME", "JOB_HUNTER_DB", "JOB_HUNTER_ME"] as const;
	const saved: Record<string, string | undefined> = {};
	let out: string[];

	beforeEach(() => {
		for (const k of KEYS) saved[k] = process.env[k];
		process.env.JOB_HUNTER_HOME = join(tmp, "home");
		process.env.JOB_HUNTER_DB = join(tmp, "jh.db");
		process.env.JOB_HUNTER_ME = join(tmp, "me");
		mkdirSync(join(tmp, "me"), { recursive: true });
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
		for (const k of KEYS) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	});

	async function jh(...argv: string[]): Promise<Record<string, unknown>> {
		out = [];
		const program = new Command().exitOverride();
		registerAutopilot(program);
		await program.parseAsync(argv, { from: "user" });
		return JSON.parse(out.join("").trim().split("\n").at(-1) ?? "null");
	}

	function seedApp(): number {
		const db = openDb();
		try {
			const co = upsertCompany(db, { name: "Initech" });
			const job = insertJob(db, { company_id: co.id, title: "FDE" });
			return createApplication(db, { job_id: job.id, status: "tailored" }).id;
		} finally {
			db.close();
		}
	}

	it("adds with --hold, refuses non-user answers, answers as the user", async () => {
		const id = seedApp();
		const added = await jh(
			"autopilot",
			"escalations",
			"add",
			"--kind",
			"account_creation_signin_sso",
			"--question",
			"Workday wants a new account. Create one?",
			"--app",
			String(id),
			"--blocking",
			"--hold",
			"--actor",
			"application-submitter",
			"--json",
		);
		expect(added.created).toBe(true);
		expect(added.held).toBe(true);
		const escId = (added.escalation as { id: number }).id;

		const refused = await jh(
			"autopilot",
			"escalations",
			"answer",
			String(escId),
			"--answer",
			"yes",
			"--actor",
			"conscience",
			"--json",
		);
		expect(refused.error).toBe("user_only_field");
		expect(process.exitCode).toBe(2);
		process.exitCode = undefined;

		const ok = await jh(
			"autopilot",
			"escalations",
			"answer",
			String(escId),
			"--answer",
			"no, skip it",
			"--json",
		);
		expect((ok.escalation as { status: string }).status).toBe("answered");
		const list = await jh("autopilot", "escalations", "list", "--json");
		expect(list.escalations).toEqual([]);
	});

	it("refuses kinds the user removed from the policy", async () => {
		writeFileSync(
			join(tmp, "me", "decision-policy.yaml"),
			"escalate:\n  kinds: [hard_fact_unknown]\n",
		);
		const r = await jh(
			"autopilot",
			"escalations",
			"add",
			"--kind",
			"spending_money",
			"--question",
			"Pay $10?",
			"--actor",
			"conscience",
			"--json",
		);
		expect(r.error).toBe("not_escalated");
	});

	it("preflight reports the cap and blocking escalations", async () => {
		writeFileSync(
			join(tmp, "me", "profile.yaml"),
			"version: 1\nidentity: {name: Pat, email: p@example.com, location: X}\nautonomy: {daily_apply_cap: 3}\n",
		);
		const r = await jh("autopilot", "preflight", "--json");
		expect(r.remaining_today).toBe(3);
		expect(r.submit_confirm).toBe("per_batch");
		const names = (r.checks as { name: string }[]).map((c) => c.name);
		expect(names).toEqual(
			expect.arrayContaining([
				"policy",
				"me_ignored",
				"uploads_readable",
				"daily_cap",
				"browser",
				"blocking_escalations",
			]),
		);
	});
});
