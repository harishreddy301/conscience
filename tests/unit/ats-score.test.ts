import { describe, expect, it } from "vitest";
import {
	countKeyword,
	JdKeywords,
	normTerm,
	tokens,
} from "../../src/ats/keywords.js";
import { resumeYears, scoreResume } from "../../src/ats/score.js";
import type { TailoredResume } from "../../src/resume/schema.js";
import * as fx from "../fixtures/resume/fixtures.js";

/** A clean rendered view so the parse component is a known 15/15. */
const CLEAN = {
	html: "<html><body><h1>Jordan Rivera</h1><h2>Summary</h2><h2>Skills</h2><h2>Experience</h2><h2>Education</h2></body></html>",
	text: `Jordan Rivera\njordan.rivera@example.com\n${"Built data pipelines in Python. ".repeat(10)}\nJan 2022 – Present`,
};

const P = fx.profile();
const score = (d: TailoredResume, kw = fx.keywords()) =>
	scoreResume(d, kw, CLEAN, P);
type Bullet = TailoredResume["experience"][number]["bullets"][number];
const bullet = (d: TailoredResume, role: number, i: number) =>
	d.experience[role]?.bullets[i] as Bullet;

describe("normTerm", () => {
	it("folds punctuation so Node.js matches nodejs", () => {
		expect(normTerm("Node.js")).toBe("nodejs");
		expect(normTerm("nodejs")).toBe("nodejs");
		expect(normTerm("CI/CD")).toBe(normTerm("cicd"));
	});

	it("keeps C++, C# and .NET distinct", () => {
		expect(normTerm("C++")).toBe("cpp");
		expect(normTerm("C#")).toBe("csharp");
		expect(normTerm(".NET")).toBe("dotnet");
		expect(normTerm("C")).toBe("c");
	});

	it("stems plurals", () => {
		expect(normTerm("data pipelines")).toBe(normTerm("data pipeline"));
		expect(normTerm("APIs")).toBe("api");
		expect(normTerm("strategies")).toBe("strategy");
		expect(normTerm("AWS")).toBe("aws");
	});

	it("counts aliases without double counting overlaps", () => {
		const t = tokens("React Native apps and React web apps");
		expect(countKeyword(t, { term: "React", aliases: ["React Native"] })).toBe(
			2,
		);
	});
});

describe("scoreResume", () => {
	it("scores a full match at least 80", () => {
		const r = score(fx.draft());
		expect(r.missing_required).toEqual([]);
		expect(r.failed_knockouts).toEqual([]);
		expect(r.parse_failures).toEqual([]);
		expect(r.stuffing).toEqual([]);
		expect(r.total).toBeGreaterThanOrEqual(80);
		expect(r.components).toEqual({
			required: 35,
			context: 10,
			preferred: 10,
			title: 10,
			knockouts: 15,
			parse: 15,
			recency: 5,
		});
	});

	it("caps the total at 40 when a knockout fails", () => {
		const kw = fx.keywords();
		kw.knockouts.min_years = 20;
		const r = score(fx.draft(), kw);
		expect(r.failed_knockouts).toHaveLength(1);
		expect(r.failed_knockouts[0]).toMatch(/^min_years/);
		expect(r.total).toBe(40);
	});

	it("fails degree and location knockouts it cannot satisfy", () => {
		const kw = fx.keywords();
		kw.knockouts.degree = "PhD in Physics";
		kw.knockouts.location = "Berlin, Germany";
		const r = score(fx.draft(), kw);
		expect(r.failed_knockouts.map((f) => f.split(":")[0])).toEqual([
			"degree",
			"location",
		]);
		expect(r.total).toBeLessThanOrEqual(40);
	});

	it("fails a no-sponsorship knockout when the profile needs sponsorship", () => {
		const kw = fx.keywords();
		kw.knockouts.work_auth =
			"Must be authorized to work in the US without sponsorship";
		expect(score(fx.draft(), kw).failed_knockouts).toEqual([]);
		const needs = { ...P, work_auth: { needs_sponsorship: true } };
		expect(
			scoreResume(fx.draft(), kw, CLEAN, needs).failed_knockouts,
		).toHaveLength(1);
	});

	it("costs 2 points per use past 4: a term used 6 times costs 4 points", () => {
		const base = score(fx.draft());
		const d = fx.draft();
		bullet(d, 0, 1).text =
			"Migrated nightly batch ETL from cron scripts to Airflow DAGs with SQL and Python checks";
		bullet(d, 1, 1).text =
			"Built Tableau dashboards for sales leadership, fed by Python extracts";
		const r = score(d);
		expect(r.stuffing).toEqual([{ term: "Python", count: 6 }]);
		expect(base.total - r.total).toBe(4);
	});

	it("does not count Environment lines toward stuffing", () => {
		const base = score(fx.draft());
		const d = fx.draft();
		const role = d.experience[0];
		if (!role) throw new Error("fixture");
		role.environment = ["Python", "SQL", "Airflow"];
		const r = score(d);
		expect(r.stuffing).toEqual(base.stuffing);
		expect(r.total).toBe(base.total);
	});

	it("matches 'Node.js' in the resume to the keyword 'nodejs'", () => {
		const kw = JdKeywords.parse({
			required: [{ term: "nodejs" }],
			titles: ["Senior Data Engineer"],
		});
		const r = score(fx.draft(), kw);
		expect(r.missing_required).toEqual([]);
		expect(r.components.required).toBe(35);
	});

	it("matches plurals", () => {
		const kw = JdKeywords.parse({
			required: [{ term: "data pipeline" }, { term: "dashboard" }],
		});
		expect(score(fx.draft(), kw).missing_required).toEqual([]);
	});

	it("gives context points only when the term appears in a bullet", () => {
		const kw = JdKeywords.parse({ required: [{ term: "Kafka" }] });
		const r = score(fx.draft(), kw);
		expect(r.components.required).toBe(35);
		expect(r.components.context).toBe(0);
		const d = fx.draft();
		bullet(d, 0, 0).text =
			"Built streaming ingestion on Kafka and AWS S3 in Python, cutting pipeline latency by 45%";
		expect(score(d, kw).components.context).toBe(10);
	});

	it("reports missing required terms and scales the required component by weight", () => {
		const kw = JdKeywords.parse({
			required: [
				{ term: "Python", weight: 3 },
				{ term: "Spark", weight: 1 },
			],
		});
		const r = score(fx.draft(), kw);
		expect(r.missing_required).toEqual(["Spark"]);
		expect(r.components.required).toBe(26.3);
	});

	it("awards recency only for terms in the most recent role", () => {
		const kw = JdKeywords.parse({ required: [{ term: "Tableau" }] });
		expect(score(fx.draft(), kw).components.recency).toBe(0);
		const kw2 = JdKeywords.parse({ required: [{ term: "Airflow" }] });
		expect(score(fx.draft(), kw2).components.recency).toBe(5);
	});

	it("gives partial title credit when only the latest role title matches", () => {
		const d = fx.draft();
		d.basics.headline = "Data platform builder";
		expect(score(d).components.title).toBe(7);
	});

	it("subtracts 3 points per parse failure", () => {
		const r = scoreResume(
			fx.draft(),
			fx.keywords(),
			{ ...CLEAN, html: `${CLEAN.html}<table></table>` },
			P,
		);
		expect(r.parse_failures).toEqual(["TABLE"]);
		expect(r.components.parse).toBe(12);
	});

	it("computes years from role dates with overlaps counted once", () => {
		const d = fx.draft();
		expect(resumeYears(d, new Date("2026-10-15T00:00:00Z"))).toBe(9);
	});
});
