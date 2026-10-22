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
import {
	getVariant,
	listOutcomeEmails,
	listOutcomeEvents,
	listOutcomeRows,
	recordVariant,
} from "../../src/db/learn.js";
import {
	analyze,
	buildSamples,
	classifyFraming,
	classifyRoleFamily,
	deriveOutcome,
	explorationPlan,
	featureStats,
	learnStatus,
	learnSummary,
	lintPlaybook,
	markRun,
	phrasingTags,
	renderPlaybook,
	runAnalysis,
	type Sample,
	shouldExplore,
	titleChoiceOf,
	titleChoiceValues,
	variantFromResume,
	weekStart,
	wilsonLowerBound,
	writePlaybook,
	writeStats,
} from "../../src/learn/index.js";

const FIXTURES = join(import.meta.dirname, "..", "fixtures", "learn");
const NOW = new Date("2026-06-01T12:00:00.000Z");

function fixtureDb(): DatabaseSync {
	const db = new DatabaseSync(":memory:");
	db.exec(readFileSync(join(FIXTURES, "schema.fixture.sql"), "utf8"));
	return db;
}

interface SeedApp {
	id: number;
	title: string;
	status: string;
	applied_at: string | null;
	source?: string;
	events?: { kind: string; to_status?: string; at: string }[];
	emails?: { kind: string; received_at: string }[];
	variant?: Parameters<typeof recordVariant>[2];
}

function seed(db: DatabaseSync, apps: SeedApp[]): void {
	const t = "2026-01-01T00:00:00.000Z";
	db.prepare(
		"INSERT OR IGNORE INTO companies(id,name,name_norm,created_at) VALUES(1,'Acme','acme',?)",
	).run(t);
	let emailSeq = 0;
	for (const a of apps) {
		db.prepare(
			"INSERT INTO jobs(id,company_id,title,title_norm,discovered_at) VALUES(?,1,?,?,?)",
		).run(a.id, a.title, a.title.toLowerCase(), t);
		db.prepare(
			"INSERT INTO applications(id,job_id,status,source,applied_at,last_event_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
		).run(
			a.id,
			a.id,
			a.status,
			a.source ?? "conscience",
			a.applied_at,
			t,
			t,
			t,
		);
		for (const e of a.events ?? []) {
			db.prepare(
				"INSERT INTO application_events(application_id,kind,to_status,actor,at) VALUES(?,?,?,?,?)",
			).run(a.id, e.kind, e.to_status ?? null, "test", e.at);
		}
		for (const m of a.emails ?? []) {
			emailSeq += 1;
			db.prepare(
				"INSERT INTO emails(gmail_message_id,thread_id,received_at,from_addr,from_domain,subject,kind,confidence,application_id,ingested_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
			).run(
				`m${emailSeq}`,
				`t${emailSeq}`,
				m.received_at,
				"x@acme.test",
				"acme.test",
				"s",
				m.kind,
				0.9,
				a.id,
				t,
			);
		}
		if (a.variant) recordVariant(db, a.id, a.variant);
	}
}

const MAY = (d: number) =>
	`2026-05-${String(d).padStart(2, "0")}T09:00:00.000Z`;
const APR = (d: number) =>
	`2026-04-${String(d).padStart(2, "0")}T09:00:00.000Z`;

function variant(
	angle: string,
	framing: string,
	keywords: string[],
	bullets: string[],
) {
	return {
		angle,
		framing,
		keywords,
		bullet_ids: bullets,
		phrasing: ["shape:xyz"],
		ats_score: 85,
	};
}

/** 6 impact apps (4 callbacks), 6 skills-match apps (1 callback), 1 pending, 1 domain-reframe. */
function standardDataset(): SeedApp[] {
	const apps: SeedApp[] = [];
	let id = 0;
	const add = (
		status: string,
		angle: string,
		framing: string,
		events: SeedApp["events"] = [],
	) => {
		id += 1;
		apps.push({
			id,
			title: "Senior Backend Engineer",
			status,
			applied_at: APR(1 + id),
			events,
			variant: variant(
				angle,
				framing,
				["kubernetes", id % 2 ? "go" : "python"],
				["acme-2020.b01", `acme-2020.b0${2 + (id % 3)}`],
			),
		});
	};
	for (let i = 0; i < 4; i++)
		add("interviewing", "impact", "leadership", [
			{ kind: "transition", to_status: "interviewing", at: APR(20) },
		]);
	add("rejected", "impact", "leadership", [
		{ kind: "transition", to_status: "rejected", at: APR(25) },
	]);
	add("applied", "impact", "senior-ic"); // ghosted by silence
	add("assessment", "skills-match", "senior-ic");
	for (let i = 0; i < 3; i++) add("rejected", "skills-match", "senior-ic");
	add("ghosted", "skills-match", "generalist");
	add("applied", "skills-match", "generalist");
	add("rejected", "domain-reframe", "generalist");
	id += 1;
	apps.push({
		id,
		title: "Data Engineer",
		status: "applied",
		applied_at: MAY(28),
	}); // pending, no variant
	return apps;
}

describe("wilsonLowerBound", () => {
	it("handles empty and known values", () => {
		expect(wilsonLowerBound(0, 0)).toBe(0);
		expect(wilsonLowerBound(5, 10)).toBeCloseTo(0.2366, 3);
		expect(wilsonLowerBound(10, 10)).toBeCloseTo(0.7225, 3);
		expect(wilsonLowerBound(0, 10)).toBe(0);
	});
});

describe("deriveOutcome", () => {
	const base = {
		applied_at: "2026-05-01T00:00:00.000Z",
		events: [],
		emails: [],
	};
	it("labels callback statuses positive", () => {
		for (const status of ["interviewing", "assessment", "offer", "accepted"])
			expect(deriveOutcome({ ...base, status }, NOW).outcome).toBe("positive");
	});
	it("counts an earlier interview as positive even when later rejected", () => {
		const r = deriveOutcome(
			{
				...base,
				status: "rejected",
				events: [
					{
						kind: "transition",
						to_status: "interviewing",
						at: "2026-05-04T00:00:00.000Z",
					},
				],
			},
			NOW,
		);
		expect(r).toEqual({ outcome: "positive", time_to_response_days: 3 });
	});
	it("treats an interview-invite email as a callback", () => {
		const r = deriveOutcome(
			{
				...base,
				status: "applied",
				emails: [
					{ kind: "interview_invite", received_at: "2026-05-02T12:00:00.000Z" },
				],
			},
			NOW,
		);
		expect(r).toEqual({ outcome: "positive", time_to_response_days: 1.5 });
	});
	it("labels rejection negative with time to response", () => {
		const r = deriveOutcome(
			{
				...base,
				status: "rejected",
				events: [
					{
						kind: "transition",
						to_status: "rejected",
						at: "2026-05-11T00:00:00.000Z",
					},
				],
			},
			NOW,
		);
		expect(r).toEqual({ outcome: "negative", time_to_response_days: 10 });
	});
	it("ghosts after 21 silent days, otherwise pending", () => {
		expect(deriveOutcome({ ...base, status: "applied" }, NOW).outcome).toBe(
			"ghosted",
		);
		expect(
			deriveOutcome(
				{ ...base, status: "applied" },
				new Date("2026-05-15T00:00:00.000Z"),
			).outcome,
		).toBe("pending");
		expect(
			deriveOutcome(
				{ ...base, status: "ghosted" },
				new Date("2026-05-02T00:00:00.000Z"),
			).outcome,
		).toBe("ghosted");
	});
	it("does not count confirmation emails or pre-application events as responses", () => {
		const r = deriveOutcome(
			{
				...base,
				status: "applied",
				events: [
					{
						kind: "transition",
						to_status: "applied",
						at: "2026-05-01T00:00:00.000Z",
					},
				],
				emails: [
					{ kind: "confirmation", received_at: "2026-05-01T01:00:00.000Z" },
					{ kind: "recruiter", received_at: "2026-04-20T00:00:00.000Z" },
				],
			},
			new Date("2026-05-10T00:00:00.000Z"),
		);
		expect(r).toEqual({ outcome: "pending", time_to_response_days: null });
	});
});

describe("features", () => {
	it("classifies role families", () => {
		expect(classifyRoleFamily("Senior Software Engineer, Frontend")).toBe(
			"frontend",
		);
		expect(classifyRoleFamily("Machine Learning Engineer")).toBe("ml");
		expect(classifyRoleFamily("Site Reliability Engineer")).toBe("devops");
		expect(classifyRoleFamily("Engineering Manager")).toBe("management");
		expect(classifyRoleFamily("Backend Engineer (Go)")).toBe("backend");
		expect(classifyRoleFamily("Barista")).toBe("other");
	});
	it("classifies headline framing", () => {
		expect(classifyFraming("Tech Lead, Payments")).toBe("leadership");
		expect(classifyFraming("Senior Backend Engineer")).toBe("senior-ic");
		expect(classifyFraming("Backend Engineer | Go, Kafka")).toBe("specialist");
		expect(classifyFraming("Software Engineer")).toBe("generalist");
	});
	it("tags phrasing", () => {
		expect(
			phrasingTags("Cut p99 latency 40% by moving reads to Redis"),
		).toEqual(["opener:cut", "shape:xyz", "length:short"]);
		expect(phrasingTags("Owned the billing service")).toEqual([
			"opener:owned",
			"shape:plain",
			"length:short",
		]);
	});
	it("builds a variant from a tailored resume", () => {
		const v = variantFromResume(
			{
				run_id: "r1",
				angle: "impact",
				job: { title: "Platform Engineer" },
				basics: { headline: "Senior Platform Engineer" },
				experience: [
					{
						bullets: [
							{
								source_ids: ["acme-2020.b01"],
								text: "Cut deploy time 50% by adding CI caching",
								keywords: ["CI/CD", "Kubernetes"],
							},
						],
					},
				],
				layout: { pages: 1 },
			},
			{ ats_score: 88, keywords: ["kubernetes"] },
		);
		expect(v).toMatchObject({
			run_id: "r1",
			angle: "impact",
			framing: "senior-ic",
			role_family: "devops",
			keywords: ["kubernetes", "ci/cd"],
			bullet_ids: ["acme-2020.b01"],
			ats_score: 88,
			pages: 1,
		});
		expect(v.phrasing).toContain("shape:xyz");
	});
});

describe("recordVariant", () => {
	it("validates, upserts and dedupes", () => {
		const db = fixtureDb();
		seed(db, [
			{
				id: 1,
				title: "Backend Engineer",
				status: "applied",
				applied_at: MAY(1),
			},
		]);
		recordVariant(db, 1, {
			angle: "impact",
			keywords: ["go", "go"],
			bullet_ids: ["a.b01"],
			phrasing: [],
		});
		recordVariant(db, 1, {
			angle: "skills-match",
			keywords: ["rust"],
			submitted_at: MAY(2),
		});
		const row = getVariant(db, 1);
		expect(row?.angle).toBe("skills-match");
		expect(JSON.parse(row?.keywords_json ?? "[]")).toEqual(["rust"]);
		expect(row?.submitted_at).toBe(MAY(2));
		expect(() =>
			recordVariant(db, 1, { ats_score: 140 } as never),
		).toThrowError(/invalid resume variant/);
		expect(() => recordVariant(db, 0, {})).toThrowError(
			/invalid application id/,
		);
	});
});

describe("analysis", () => {
	let db: DatabaseSync;
	beforeEach(() => {
		db = fixtureDb();
		seed(db, standardDataset());
	});

	it("labels samples and computes totals", () => {
		const a = runAnalysis(db, { now: NOW });
		expect(a.totals).toEqual({
			submitted: 14,
			resolved: 13,
			positive: 5,
			negative: 5,
			ghosted: 3,
			pending: 1,
		});
		expect(a.baseline.rate).toBeCloseTo(5 / 13, 3);
		expect(a.samples_without_variant).toBe(1);
	});

	it("reports callback rate per angle with n, Wilson bound, lift and strength", () => {
		const a = runAnalysis(db, { now: NOW });
		const impact = a.features.angle.find((s) => s.value === "impact");
		expect(impact).toMatchObject({ n: 6, positives: 4, strength: "weak" });
		expect(impact?.wilson_lower).toBeCloseTo(wilsonLowerBound(4, 6), 3);
		expect(impact?.lift).toBeCloseTo(0.667 / 0.385, 1);
		// domain-reframe has n = 1: never reported
		expect(a.features.angle.some((s) => s.value === "domain-reframe")).toBe(
			false,
		);
		expect(a.features.angle.every((s) => s.n >= 3)).toBe(true);
		const kube = a.features.keyword.find((s) => s.value === "kubernetes");
		expect(kube).toMatchObject({ n: 13, strength: "moderate" });
	});

	it("ranks working patterns first and exposes exploration", () => {
		const a = runAnalysis(db, { now: NOW });
		expect(a.patterns[0]?.direction).toBe("working");
		expect(
			a.patterns.some(
				(p) => p.direction === "not_working" && p.value === "skills-match",
			),
		).toBe(true);
		expect(a.exploration.best_angle).toBe("impact");
		expect(a.exploration.explore_angles).toEqual([
			"skills-match",
			"domain-reframe",
		]);
		expect(a.exploration.ratio).toBe(0.2);
		for (const p of a.patterns)
			expect(p.claim).toMatch(/n=\d+, (weak|moderate)/);
	});

	it("limits keywords to the top 30", () => {
		const samples: Sample[] = Array.from({ length: 4 }, (_, i) => ({
			application_id: i + 1,
			company: "Acme",
			job_title: "Engineer",
			applied_at: APR(2),
			outcome: i % 2 ? "positive" : "negative",
			time_to_response_days: null,
			ats_score: null,
			has_variant: true,
			features: {
				framing: null,
				angle: null,
				role_family: "backend",
				source: "conscience",
				keywords: Array.from(
					{ length: 40 },
					(_, k) => `kw${String(k).padStart(2, "0")}`,
				),
				bullet_ids: [],
				phrasing: [],
			},
		}));
		expect(analyze(samples, { now: NOW }).features.keyword).toHaveLength(30);
	});

	it("uses the final draft angle and app source when no variant exists", () => {
		const db2 = fixtureDb();
		seed(db2, [
			{
				id: 1,
				title: "QA Engineer",
				status: "rejected",
				applied_at: APR(1),
				source: "external",
			},
		]);
		db2
			.prepare(
				"INSERT INTO resume_runs(id,application_id,workdir,jd_path,status,final_draft_id,ats_score,created_at,finalized_at) VALUES('r1',1,'w','j','finalized','d1',82,?,?)",
			)
			.run(APR(1), APR(1));
		db2
			.prepare(
				"INSERT INTO resume_drafts(run_id,id,angle,iteration,path,created_at) VALUES('r1','d1','impact',0,'p',?)",
			)
			.run(APR(1));
		const [s] = buildSamples(
			listOutcomeRows(db2),
			listOutcomeEvents(db2),
			listOutcomeEmails(db2),
			{ now: NOW },
		);
		expect(s).toMatchObject({
			outcome: "negative",
			ats_score: 82,
			has_variant: false,
			features: { angle: "impact", source: "external", role_family: "qa" },
		});
	});

	it("builds a weekly series keyed by Monday", () => {
		expect(weekStart("2026-04-05T23:00:00.000Z")).toBe("2026-03-30");
		expect(weekStart("2026-04-06T00:00:00.000Z")).toBe("2026-04-06");
		const a = runAnalysis(db, { now: NOW });
		expect(a.weekly.reduce((n, w) => n + w.submitted, 0)).toBe(14);
		expect(a.weekly.map((w) => w.week)).toEqual(
			[...a.weekly.map((w) => w.week)].sort(),
		);
	});
});

describe("exploration", () => {
	it("explores every fifth application at the default 20% ratio", () => {
		let hits = 0;
		for (let id = 1; id <= 2000; id++) if (shouldExplore(id, 0.2)) hits += 1;
		expect(hits / 2000).toBe(0.2);
		expect(shouldExplore(10)).toBe(true);
		expect(shouldExplore(11)).toBe(false);
		expect(shouldExplore(7, 0)).toBe(false);
	});
	it("rotates evenly when no angle has enough data", () => {
		const e = explorationPlan([]);
		expect(e.best_angle).toBeNull();
		expect(e.explore_angles).toEqual([
			"impact",
			"skills-match",
			"domain-reframe",
		]);
	});
	it("never treats a revision angle as the best draft angle", () => {
		const stats = featureStats(
			Array.from({ length: 3 }, (_, i) => ({
				application_id: i,
				company: "A",
				job_title: "E",
				applied_at: APR(2),
				outcome: "positive" as const,
				time_to_response_days: null,
				ats_score: null,
				has_variant: true,
				features: {
					framing: null,
					angle: "revision",
					role_family: "backend",
					source: "conscience",
					keywords: [],
					bullet_ids: [],
					phrasing: [],
				},
			})),
			"angle",
			0.5,
		);
		expect(explorationPlan(stats).best_angle).toBeNull();
	});
});

describe("playbook", () => {
	it("ships an example playbook that passes the citation lint", () => {
		const example = join(
			import.meta.dirname,
			"..",
			"..",
			"templates",
			"me",
			"learnings",
			"playbook.example.md",
		);
		expect(lintPlaybook(readFileSync(example, "utf8"))).toEqual({
			ok: true,
			issues: [],
		});
	});
	it("renders a playbook that passes its own citation lint", () => {
		const db = fixtureDb();
		seed(db, standardDataset());
		const md = renderPlaybook(runAnalysis(db, { now: NOW }));
		expect(md).toContain("# Resume playbook");
		expect(md).toContain("## What's working");
		expect(md).toMatch(/\*\*impact\*\*.*n=6, weak/);
		expect(lintPlaybook(md)).toEqual({ ok: true, issues: [] });
	});
	it("rejects uncited, under-sampled or mislabelled claims", () => {
		const md = [
			"# Playbook",
			"## How to read this",
			"- anything goes here",
			"## What's working",
			"- Lead with metrics.",
			"- Leadership framing wins (n=2, weak)",
			"- Kubernetes keyword helps (n=9, weak)",
			"- Impact angle helps (n=6, weak)",
		].join("\n");
		const r = lintPlaybook(md);
		expect(r.ok).toBe(false);
		expect(r.issues.map((i) => i.line)).toEqual([5, 6, 7]);
		expect(r.issues[2]?.message).toMatch(/moderate/);
	});
});

describe("status, summary and files", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "jh-learn-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("is due when never run, then up to date, then due after 5 new outcomes", () => {
		const db = fixtureDb();
		seed(db, standardDataset());
		const first = learnStatus(db, dir, { now: NOW, appId: 3 });
		expect(first).toMatchObject({
			due: true,
			reason: "never analyzed",
			resolved_now: 13,
			playbook_exists: false,
		});
		expect(first.explore).toEqual({
			app_id: 3,
			explore: shouldExplore(3, 0.2),
			ratio: 0.2,
		});
		markRun(db, runAnalysis(db, { now: NOW }));
		expect(learnStatus(db, dir, { now: NOW })).toMatchObject({
			due: false,
			new_outcomes: 0,
		});
		seed(
			db,
			[20, 21, 22, 23, 24].map((id) => ({
				id,
				title: "Backend Engineer",
				status: "rejected",
				applied_at: MAY(1),
			})),
		);
		expect(learnStatus(db, dir, { now: NOW })).toMatchObject({
			due: true,
			new_outcomes: 5,
		});
	});

	it("summarises for the dashboard", () => {
		const db = fixtureDb();
		seed(db, standardDataset());
		const s = learnSummary(db, NOW);
		expect(s.callback_rate).toBeCloseTo(5 / 13, 3);
		expect(s.top_patterns.length).toBeLessThanOrEqual(5);
		expect(s.by_angle.map((x) => x.value)).toContain("impact");
		expect(s.by_framing.length).toBeGreaterThan(0);
		expect(s.new_outcomes).toBe(13);
	});

	it("writes stats.json and playbook.md", () => {
		const db = fixtureDb();
		seed(db, standardDataset());
		const a = runAnalysis(db, { now: NOW });
		const learnings = join(dir, "learnings");
		const statsPath = writeStats(learnings, a);
		expect(JSON.parse(readFileSync(statsPath, "utf8")).totals.submitted).toBe(
			14,
		);
		const pbPath = writePlaybook(learnings, "# P");
		expect(readFileSync(pbPath, "utf8")).toBe("# P\n");
	});
});

describe("jh learn CLI", () => {
	let home: string;
	const saved = { ...process.env };
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "jh-learn-cli-"));
		mkdirSync(join(home, "me"));
		process.env.JOB_HUNTER_HOME = home;
		process.env.JOB_HUNTER_ME = join(home, "me");
		process.env.JOB_HUNTER_DB = join(home, "jh.db");
		process.exitCode = undefined;
	});
	afterEach(() => {
		process.env = { ...saved };
		process.exitCode = undefined;
		vi.restoreAllMocks();
		rmSync(home, { recursive: true, force: true });
	});

	async function run(args: string[]): Promise<string> {
		const out: string[] = [];
		vi.spyOn(process.stdout, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				out.push(String(chunk));
				return true;
			},
		);
		const { register } = await import("../../src/commands/learn.js");
		const program = new Command().exitOverride();
		register(program);
		await program.parseAsync(["node", "jh", ...args]);
		vi.restoreAllMocks();
		return out.join("");
	}

	async function seedRealDb(): Promise<void> {
		const { openDb } = await import("../../src/db/index.js");
		const db = openDb();
		try {
			seed(db, standardDataset());
		} finally {
			db.close();
		}
	}

	it("analyze writes stats.json and records the run", async () => {
		await seedRealDb();
		const out = JSON.parse(await run(["learn", "analyze", "--json"]));
		expect(out.analysis.totals.submitted).toBe(14);
		expect(out.stats_path).toBe(join(home, "me", "learnings", "stats.json"));
		const status = JSON.parse(
			await run(["learn", "status", "--json", "--app", "2"]),
		);
		expect(status.last_run_at).not.toBeNull();
		expect(status.explore.app_id).toBe(2);
	});

	it("playbook --write lints and writes; bad files exit 2", async () => {
		await seedRealDb();
		const ok = JSON.parse(
			await run(["learn", "playbook", "--write", "--json"]),
		);
		expect(ok.written).toBe(true);
		expect(ok.stats_path).toBe(join(home, "me", "learnings", "stats.json"));
		expect(readFileSync(ok.path, "utf8")).toContain("# Resume playbook");
		const bad = join(home, "bad.md");
		writeFileSync(bad, "# P\n## What's working\n- Use metrics everywhere\n");
		const err = JSON.parse(
			await run(["learn", "playbook", "--file", bad, "--write", "--json"]),
		);
		expect(err.error).toBe("validation");
		expect(process.exitCode).toBe(2);
	});

	it("rejects a non-numeric --app", async () => {
		const err = JSON.parse(
			await run(["learn", "status", "--app", "x", "--json"]),
		);
		expect(err.error).toBe("validation");
	});
});

describe("title_choice learning feature", () => {
	const resume = (headline: string, display?: string) => ({
		run_id: "r1",
		angle: "impact",
		job: { title: "Data Engineer" },
		basics: { headline },
		experience: [
			{
				title: "Data Engineer II",
				...(display ? { display_title: display } : {}),
				bullets: [
					{ source_ids: ["acme-2022.b01"], text: "Built pipelines in Python" },
				],
			},
		],
	});

	it("records posted title, headline and shown titles on the variant", () => {
		const v = variantFromResume(
			resume("Senior Data Platform Engineer", "Data Platform Engineer"),
			{ posted_title: "Senior Data Platform Engineer" },
		);
		expect(v.title_choice).toEqual({
			posted: "Senior Data Platform Engineer",
			headline: "Senior Data Platform Engineer",
			display_titles: ["Data Platform Engineer"],
			variants_used: 1,
		});
		// Without a snapshot the job title stands in for the posted title.
		expect(titleChoiceOf(resume("Data Engineer")).posted).toBe("Data Engineer");
	});

	it("agrees with jd compare on variants and headline matching", () => {
		// Case-only difference is not a variant (same rule as compare.ts).
		expect(
			titleChoiceOf(resume("Data Engineer", "data engineer ii")).variants_used,
		).toBe(0);
		// Punctuation-insensitive whole-word match, like the dashboard pill.
		expect(
			titleChoiceValues({
				posted: "Senior Data Engineer – Platform",
				headline: "Senior Data Engineer, Platform",
				display_titles: [],
				variants_used: 0,
			}),
		).toContain("headline:has-posted-title");
	});

	it("buckets values so they repeat across applications", () => {
		expect(
			titleChoiceValues({
				posted: "Senior Data Platform Engineer",
				headline: "Senior Data Platform Engineer | Python",
				display_titles: ["Data Platform Engineer"],
				variants_used: 1,
			}),
		).toEqual([
			"data <- data platform engineer",
			"headline:has-posted-title",
			"display:title-variant",
		]);
		expect(
			titleChoiceValues({
				posted: "Backend Engineer",
				headline: "Software Engineer",
				display_titles: ["Data Engineer II"],
				variants_used: 0,
			}),
		).toEqual([
			"backend <- data engineer ii",
			"headline:other-title",
			"display:official-titles",
		]);
	});

	it("stores title_choice and lets /learn see which titles got callbacks", () => {
		const db = fixtureDb();
		const tc = {
			posted: "Data Platform Engineer",
			headline: "Data Platform Engineer",
			display_titles: ["Data Platform Engineer"],
			variants_used: 1,
		};
		const apps: SeedApp[] = [1, 2, 3, 4].map((id) => ({
			id,
			title: "Data Platform Engineer",
			status: id <= 3 ? "interviewing" : "rejected",
			applied_at: APR(id),
			variant: { ...variant("impact", "generalist", [], []), title_choice: tc },
		}));
		seed(db, apps);
		const stored = getVariant(db, 1);
		expect(JSON.parse(stored?.title_choice_json ?? "null")).toEqual(tc);
		const a = runAnalysis(db, { now: NOW });
		const values = a.features.title_choice.map((f) => f.value);
		expect(values).toContain("data <- data platform engineer");
		const variantStat = a.features.title_choice.find(
			(f) => f.value === "display:title-variant",
		);
		expect(variantStat).toMatchObject({ n: 4, positives: 3 });
		expect(learnSummary(db, NOW).by_title_choice.length).toBeGreaterThan(0);
		db.close();
	});
});
