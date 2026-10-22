import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { register } from "../../src/commands/me.js";
import { mePaths } from "../../src/core/paths.js";
import {
	baseRoleId,
	digitTokens,
	ingestDraft,
	jaccard,
} from "../../src/me/ingest.js";
import {
	convertLegacyResume,
	initWorkspace,
	meStatus,
	migrateLegacy,
	upsertEnvLine,
	validateWorkspace,
	workspaceRel,
} from "../../src/me/init.js";
import {
	allSkills,
	experienceYears,
	loadMaster,
	slug,
} from "../../src/me/load.js";
import type { IntakeDraft } from "../../src/me/schema.js";
import {
	FIXTURES,
	loadDraft,
	runCli,
	type TempWorkspace,
	tempWorkspace,
} from "../fixtures/me/helpers.js";

let ws: TempWorkspace;
beforeEach(() => {
	ws = tempWorkspace();
});
afterEach(() => ws.cleanup());

const ACME = "acme-analytics-2022";

function bullets(roleId: string) {
	const role = loadMaster(ws.paths).roles.find((r) => r.id === roleId);
	if (!role) throw new Error(`no role ${roleId}`);
	return role;
}

describe("ids", () => {
	it("role ids are slug(employer)-YYYY, projects proj-<slug>", () => {
		expect(slug("Acme Analytics, Inc.")).toBe("acme-analytics-inc");
		expect(slug("Café Ünïcode")).toBe("cafe-unicode");
		expect(
			baseRoleId({
				kind: "role",
				employer: "Acme Analytics",
				title: "x",
				start: "2022-03",
			}),
		).toBe(ACME);
		expect(
			baseRoleId({
				kind: "project",
				employer: "Open source",
				title: "tiny-dq",
				start: "2023-01",
			}),
		).toBe("proj-tiny-dq");
		expect(jaccard("a b c d e", "a b c d e")).toBe(1);
	});

	it("first ingest assigns stable ids to every role, bullet and stated metric", () => {
		const r = ingestDraft(loadDraft(), { paths: ws.paths });
		expect(r.conflicts).toEqual([]);
		expect(r.written).toBe(true);
		const m = loadMaster(ws.paths);
		expect(m.roles.map((x) => x.id)).toEqual([
			ACME,
			"brightline-logistics-2019",
			"proj-tiny-dq",
		]);
		const acme = bullets(ACME);
		expect(acme.bullets.map((b) => b.id)).toEqual([
			`${ACME}.b01`,
			`${ACME}.b02`,
		]);
		expect(acme.next_bullet).toBe(3);
		expect(acme.bullets[0]?.metrics[0]).toMatchObject({
			id: `${ACME}.b01.m1`,
			status: "fact",
			value: "40 minutes",
		});
		expect(r.added).toContain(`${ACME}.b01.m1`);
		expect(m.skills.filter((s) => s.toLowerCase() === "python")).toHaveLength(
			1,
		);
		expect(existsSync(ws.paths.metricsMd)).toBe(true);
		expect(existsSync(join(ws.paths.intakeDir, "state.json"))).toBe(true);
	});

	it("disambiguates two roles that would get the same id", () => {
		const d = loadDraft();
		const first = d.roles[0];
		if (!first) throw new Error("fixture");
		d.roles.push({
			...first,
			title: "Analytics Engineer",
			start: "2022-11",
			end: "2023-01",
			bullets: [],
		});
		ingestDraft(d, { paths: ws.paths });
		expect(loadMaster(ws.paths).roles.map((r) => r.id)).toContain(`${ACME}-2`);
	});
});

describe("re-ingest", () => {
	it("ingesting the same draft twice is a no-op", () => {
		ingestDraft(loadDraft(), { paths: ws.paths });
		const before = readFileSync(ws.paths.masterResume, "utf8");
		const r = ingestDraft(loadDraft(), { paths: ws.paths });
		expect(r).toMatchObject({
			added: [],
			updated: [],
			retired: [],
			conflicts: [],
			written: false,
		});
		expect(readFileSync(ws.paths.masterResume, "utf8")).toBe(before);
	});

	it("a new bullet gets the next bNN and reworded bullets keep their id", () => {
		ingestDraft(loadDraft(), { paths: ws.paths });
		const d = loadDraft();
		const acme = d.roles[0];
		if (!acme?.bullets[1]) throw new Error("fixture");
		acme.bullets[1].text =
			"Introduced dbt tests and data contracts so broken upstream schemas fail in CI, not in dashboards.";
		acme.bullets.push({
			text: "Built a Kafka-to-Snowflake ingestion service for product events.",
			skills: ["Kafka"],
			fields: ["data engineering"],
			source_refs: ["experience/acme-2022.md#what-i-did"],
			metrics: [],
		});
		const r = ingestDraft(d, { paths: ws.paths });
		expect(r.added).toEqual([`${ACME}.b03`]);
		expect(r.updated).toEqual([`${ACME}.b02`]);
		expect(bullets(ACME).bullets[1]?.text).toContain("not in dashboards");
	});

	it("match_id wins over text similarity", () => {
		ingestDraft(loadDraft(), { paths: ws.paths });
		const d = loadDraft();
		const b = d.roles[0]?.bullets[1];
		if (!b) throw new Error("fixture");
		b.text =
			"Completely rewritten wording about schema contracts and dbt tests.";
		b.match_id = `${ACME}.b02`;
		const r = ingestDraft(d, { paths: ws.paths });
		expect(r.added).toEqual([]);
		expect(r.updated).toEqual([`${ACME}.b02`]);
	});

	it("a removed bullet is retired, never deleted, and its id is never reused", () => {
		ingestDraft(loadDraft(), { paths: ws.paths });
		const d = loadDraft();
		const acme = d.roles[0];
		if (!acme) throw new Error("fixture");
		acme.bullets.pop();
		const r1 = ingestDraft(d, { paths: ws.paths });
		expect(r1.retired).toEqual([`${ACME}.b02`]);
		expect(
			bullets(ACME).bullets.find((b) => b.id === `${ACME}.b02`)?.retired,
		).toBe(true);

		acme.bullets.push({
			text: "Wrote the on-call handbook and run the weekly incident review.",
			skills: [],
			fields: [],
			source_refs: ["x"],
			metrics: [],
		});
		const r2 = ingestDraft(d, { paths: ws.paths });
		expect(r2.added).toEqual([`${ACME}.b03`]);
		expect(r2.retired).toEqual([]);
		expect(bullets(ACME).bullets.map((b) => b.id)).toEqual([
			`${ACME}.b01`,
			`${ACME}.b02`,
			`${ACME}.b03`,
		]);
	});

	it("a role missing from the draft is kept and reported", () => {
		ingestDraft(loadDraft(), { paths: ws.paths });
		const d = loadDraft();
		d.roles = d.roles.slice(0, 1);
		const r = ingestDraft(d, { paths: ws.paths });
		expect(
			r.lint.filter((l) => l.code === "ROLE_MISSING").map((l) => l.role_id),
		).toEqual(["brightline-logistics-2019", "proj-tiny-dq"]);
		expect(loadMaster(ws.paths).roles).toHaveLength(3);
	});

	it("dry run reports but writes nothing", () => {
		const r = ingestDraft(loadDraft(), { paths: ws.paths, dryRun: true });
		expect(r.dry_run).toBe(true);
		expect(r.added.length).toBeGreaterThan(0);
		expect(existsSync(ws.paths.masterResume)).toBe(false);
	});
});

describe("conflicts", () => {
	function shiftedStart(): IntakeDraft {
		const d = loadDraft();
		const acme = d.roles[0];
		if (!acme) throw new Error("fixture");
		acme.start = "2021-11";
		return d;
	}

	it("a date conflict with the master is reported and nothing is written", () => {
		ingestDraft(loadDraft(), { paths: ws.paths });
		const before = readFileSync(ws.paths.masterResume, "utf8");
		const r = ingestDraft(shiftedStart(), { paths: ws.paths });
		expect(r.conflicts).toEqual([
			expect.objectContaining({
				kind: "fixed_fact",
				role_id: ACME,
				field: "start",
				values: ["2022-03", "2021-11"],
			}),
		]);
		expect(r.written).toBe(false);
		expect(readFileSync(ws.paths.masterResume, "utf8")).toBe(before);
	});

	it("allowFactChanges applies the confirmed date and keeps the role id", () => {
		ingestDraft(loadDraft(), { paths: ws.paths });
		const r = ingestDraft(shiftedStart(), {
			paths: ws.paths,
			allowFactChanges: true,
		});
		expect(r.conflicts).toEqual([]);
		expect(r.updated).toContain(ACME);
		expect(bullets(ACME).start).toBe("2021-11");
	});

	it("draft-reported conflicts, bad formats and end-before-start all block", () => {
		const d = loadDraft();
		d.conflicts = [
			{
				field: "acme.title",
				values: ["Data Engineer", "Senior Data Engineer"],
				sources: ["a", "b"],
			},
		];
		expect(ingestDraft(d, { paths: ws.paths }).conflicts[0]?.kind).toBe(
			"draft",
		);
		const bad = loadDraft();
		if (!bad.roles[1] || !bad.roles[0]) throw new Error("fixture");
		bad.roles[1].end = "2018-01";
		bad.roles[0].start = "March 2022";
		const kinds = ingestDraft(bad, { paths: ws.paths })
			.conflicts.map((c) => c.kind)
			.sort();
		expect(kinds).toEqual(["date_format", "date_order"]);
		expect(existsSync(ws.paths.masterResume)).toBe(false);
	});

	it("jh me ingest exits 2 with a conflicts list", async () => {
		ingestDraft(loadDraft(), { paths: ws.paths });
		const file = join(ws.base, "draft.json");
		writeFileSync(file, JSON.stringify(shiftedStart()));
		const run = await runCli(register, ["me", "ingest", file, "--json"]);
		expect(run.exitCode).toBe(2);
		const out = run.json() as { conflicts: { field: string }[] };
		expect(out.conflicts.map((c) => c.field)).toEqual(["start"]);
	});

	it("jh me ingest rejects a malformed draft with exit 2", async () => {
		const file = join(ws.base, "bad.json");
		writeFileSync(file, JSON.stringify({ roles: "nope" }));
		const run = await runCli(register, ["me", "ingest", file, "--json"]);
		expect(run.exitCode).toBe(2);
		expect(run.json()).toMatchObject({ error: "validation" });
	});
});

describe("lint", () => {
	it("a digit token without a metric produces a warning", () => {
		const d = loadDraft();
		d.roles[0]?.bullets.push({
			text: "Mentor 2 junior engineers and cut pager noise by 30% across 120 models on EC2 and S3.",
			skills: [],
			fields: [],
			source_refs: ["x"],
			metrics: [
				{ phrase: "across 120 models", value: "120 models", source_ref: "x" },
			],
		});
		const r = ingestDraft(d, { paths: ws.paths });
		const tokens = r.lint
			.filter((l) => l.code === "NUMBER_NO_METRIC")
			.map((l) => l.token);
		expect(tokens).toEqual(["2", "30%"]);
		expect(r.lint[0]?.bullet_id).toBe(`${ACME}.b03`);
	});

	it("tokenizes numbers like the resume validator", () => {
		expect(
			digitTokens(
				"from 6 hours to 40 minutes, $1.2M saved, 3x faster, EC2 and S3",
			),
		).toEqual(["6hours", "40", "$1.2m", "3x"]);
	});
});

describe("load helpers", () => {
	it("experienceYears unions role spans and ignores projects", () => {
		ingestDraft(loadDraft(), { paths: ws.paths });
		const m = loadMaster(ws.paths);
		expect(
			experienceYears(m, undefined, new Date("2025-06-15T00:00:00Z")),
		).toBe(6);
		expect(
			experienceYears(m, {
				version: 1,
				identity: { name: "", email: "", location: "", links: {} },
				experience_years: 9,
			}),
		).toBe(9);
		expect(allSkills(m).has("airflow")).toBe(true);
	});
});

describe("jh me init", () => {
	it("creates the tree with .example stripped and examples prefixed with _", async () => {
		const dir = join(ws.base, "fresh-me");
		writeFileSync(
			join(ws.home, ".env"),
			"APIFY_TOKEN=abc\nJOB_HUNTER_ME=old\n# keep me\n",
		);
		const run = await runCli(register, ["me", "init", "--dir", dir, "--json"]);
		expect(run.exitCode).toBe(0);
		const out = run.json() as { created: string[] };
		expect(out.created).toEqual(
			expect.arrayContaining([
				"README.md",
				"profile.yaml",
				"preferences.md",
				"targets.md",
				"master-resume.yaml",
				"confirmed-metrics.yaml",
				"experience/_TEMPLATE.md",
				"experience/_example-acme-2022.md",
				"sample-resume/_example-sample-resume.md",
				"stories/_TEMPLATE.md",
			]),
		);
		expect(out.created.some((f) => f.includes(".example"))).toBe(false);
		for (const sub of [".intake", ".cache", "experience"])
			expect(existsSync(join(dir, sub))).toBe(true);
		const env = readFileSync(join(ws.home, ".env"), "utf8");
		expect(env).toBe(
			`APIFY_TOKEN=abc\nJOB_HUNTER_ME="${dir.replace(/\\/g, "/")}"\n# keep me\n`,
		);
		expect(validateWorkspace(mePaths(dir)).ok).toBe(true);
	});

	it("is idempotent without --force and never clobbers generated files with it", async () => {
		const dir = join(ws.base, "again");
		initWorkspace({ dir });
		writeFileSync(
			join(dir, "profile.yaml"),
			"version: 1\nidentity: { name: Me, email: me@example.com, location: X }\n",
		);
		writeFileSync(
			join(dir, "master-resume.yaml"),
			"version: 1\nroles: []\n# mine\n",
		);
		const second = initWorkspace({ dir });
		expect(second.created).toEqual([]);
		expect(second.overwritten).toEqual([]);
		expect(readFileSync(join(dir, "profile.yaml"), "utf8")).toContain(
			"name: Me",
		);
		expect(second.envUpdated).toBe(false);
		const forced = initWorkspace({ dir, force: true });
		expect(forced.overwritten).toContain("profile.yaml");
		expect(forced.skipped).toContain("master-resume.yaml");
		expect(readFileSync(join(dir, "master-resume.yaml"), "utf8")).toContain(
			"# mine",
		);
	});

	it("helpers: workspaceRel and upsertEnvLine", () => {
		expect(workspaceRel("profile.example.yaml")).toBe("profile.yaml");
		expect(workspaceRel("experience/acme-2022.example.md")).toBe(
			"experience/_example-acme-2022.md",
		);
		expect(workspaceRel("experience/README.md")).toBe("experience/README.md");
		// The fictional playbook must never become the user's real playbook.
		expect(workspaceRel("learnings/playbook.example.md")).toBe(
			"learnings/_example-playbook.md",
		);
		expect(upsertEnvLine("", "JOB_HUNTER_ME", "D:/x")).toBe(
			'JOB_HUNTER_ME="D:/x"\n',
		);
		expect(upsertEnvLine("A=1\r\nB=2\r\n", "JOB_HUNTER_ME", "D:/x")).toBe(
			'A=1\r\nB=2\r\nJOB_HUNTER_ME="D:/x"\r\n',
		);
	});
});

describe("status, validate, migrate", () => {
	it("status tracks changes since the last intake", () => {
		initWorkspace({ dir: ws.me });
		writeFileSync(
			join(ws.me, "experience", "acme-2022.md"),
			"---\nkind: role\nemployer: Acme\ntitle: DE\nstart: 2022-03\nend: present\n---\n## Context\n",
		);
		expect(meStatus(ws.paths).needsIntake).toBe(true);
		ingestDraft(loadDraft(), { paths: ws.paths });
		const s = meStatus(ws.paths);
		expect(s.needsIntake).toBe(false);
		expect(s.lastIntake).not.toBeNull();
		expect(s.missing).toContain("sample-resume/<your resume>.pdf|docx|md");
		writeFileSync(
			join(ws.me, "experience", "acme-2022.md"),
			"---\nkind: role\nemployer: Acme\ntitle: DE\nstart: 2022-03\nend: present\n---\n## Context\nmore\n",
		);
		const after = meStatus(ws.paths);
		expect(after.needsIntake).toBe(true);
		expect(
			after.files.find((f) => f.rel === "experience/acme-2022.md")?.changed,
		).toBe(true);
	});

	it("validate flags bad experience front matter and unknown story ids", async () => {
		initWorkspace({ dir: ws.me });
		ingestDraft(loadDraft(), { paths: ws.paths });
		writeFileSync(
			join(ws.me, "experience", "bad.md"),
			"---\nkind: job\nemployer: X\ntitle: Y\nstart: 2022\nend: present\n---\n",
		);
		writeFileSync(
			join(ws.me, "stories", "s.md"),
			`---\nrole_id: ${ACME}\nbullet_ids: [${ACME}.b99]\n---\n`,
		);
		const v = validateWorkspace(ws.paths);
		expect(v.ok).toBe(false);
		expect(v.errors.map((e) => e.file)).toEqual(
			expect.arrayContaining(["experience/bad.md", "stories/s.md"]),
		);
		const run = await runCli(register, ["me", "validate", "--json"]);
		expect(run.exitCode).toBe(2);
	});

	it("migrate converts a legacy resume.yaml into a v1 master with stable ids", () => {
		const legacy = readFileSync(
			join(FIXTURES, "legacy-resume.fixture.yaml"),
			"utf8",
		);
		writeFileSync(join(ws.home, "resume.yaml"), legacy);
		initWorkspace({ dir: ws.me });
		const r = migrateLegacy(ws.paths);
		expect(r.converted).toHaveLength(1);
		const m = loadMaster(ws.paths);
		expect(m.roles[0]?.id).toBe(ACME);
		expect(m.roles[0]?.bullets[0]?.metrics[0]).toMatchObject({
			id: `${ACME}.b01.m1`,
			value: "2M events/day",
			status: "fact",
		});
		expect(existsSync(join(ws.paths.intakeDir, "legacy", "resume.yaml"))).toBe(
			true,
		);
		expect(migrateLegacy(ws.paths).skipped).toContain("master-resume.yaml");
		expect(convertLegacyResume({}).roles).toEqual([]);
	});
});

describe("title_variants", () => {
	const acme = (d: IntakeDraft) => d.roles[0] as IntakeDraft["roles"][number];

	it("carries user-approved title_variants into a new master role", () => {
		const d = loadDraft();
		acme(d).title_variants = [
			"Data Platform Engineer",
			" Analytics Engineer ",
			"data platform engineer",
			"Data Engineer",
		];
		ingestDraft(d, { paths: ws.paths });
		const role = bullets(ACME);
		expect(role.title).toBe("Data Engineer");
		expect(role.title_variants).toEqual([
			"Data Platform Engineer",
			"Analytics Engineer",
		]);
		expect(readFileSync(ws.paths.masterResume, "utf8")).toContain(
			"title_variants:",
		);
	});

	it("re-ingest replaces variants when the draft has them and keeps them when it does not", () => {
		const d = loadDraft();
		acme(d).title_variants = ["Data Platform Engineer"];
		ingestDraft(d, { paths: ws.paths });

		const changed = loadDraft();
		acme(changed).title_variants = ["Analytics Engineer"];
		const r = ingestDraft(changed, { paths: ws.paths });
		expect(r.conflicts).toEqual([]);
		expect(r.updated).toContain(ACME);
		expect(bullets(ACME).title_variants).toEqual(["Analytics Engineer"]);

		ingestDraft(loadDraft(), { paths: ws.paths });
		expect(bullets(ACME).title_variants).toEqual(["Analytics Engineer"]);

		const cleared = loadDraft();
		acme(cleared).title_variants = [];
		ingestDraft(cleared, { paths: ws.paths });
		expect(bullets(ACME).title_variants).toBeUndefined();
	});

	it("variants are not fixed facts: changing them raises no conflict", () => {
		ingestDraft(loadDraft(), { paths: ws.paths });
		const d = loadDraft();
		acme(d).title_variants = ["Data Platform Engineer"];
		const r = ingestDraft(d, { paths: ws.paths, dryRun: true });
		expect(r.conflicts).toEqual([]);
	});
});
