import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChrome } from "../../src/render/chrome.js";
import { renderHtml } from "../../src/render/html.js";
import {
	DEFAULT_LAYOUT_SPEC,
	evaluateLayout,
	type LayoutMeasure,
	type LayoutSpec,
	layoutGate,
	layoutSpecFrom,
	measurementHtml,
	parseLayoutDump,
} from "../../src/render/layout.js";
import { TailoredResume } from "../../src/resume/schema.js";
import { validateTailored } from "../../src/resume/validate.js";
import * as fx from "../fixtures/resume/fixtures.js";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "render");
const resume = (): TailoredResume =>
	TailoredResume.parse(
		JSON.parse(readFileSync(join(FIXTURE, "resume.fixture.json"), "utf8")),
	);

const EM = String.fromCharCode(0x2014);

/** A measurement that satisfies the default spec for `r`. */
function goodMeasure(r: TailoredResume): LayoutMeasure {
	const items: LayoutMeasure["items"] = [
		{ kind: "headline", path: "headline", lines: 1, fills: [0.7], text: "h" },
		{ kind: "contact", path: "contact", lines: 1, fills: [0.8], text: "c" },
	];
	r.summary.highlights.forEach((_h, i) => {
		items.push({
			kind: "highlight",
			path: `summary.highlights[${i}]`,
			lines: 2,
			fills: [0.98, 0.7],
			text: "x",
		});
	});
	r.skills.forEach((_g, i) => {
		items.push({
			kind: "skill",
			path: `skills[${i}]`,
			lines: 1,
			fills: [0.9],
			text: "s",
		});
	});
	r.experience.forEach((role, ri) => {
		role.bullets.forEach((_b, bi) => {
			items.push({
				kind: "bullet",
				path: `experience[${ri}].bullets[${bi}]`,
				lines: 2,
				fills: [0.99, 0.72],
				text: "b",
			});
		});
	});
	return {
		items,
		sections: ["summary", "skills", "experience", "education"].map((key) => ({
			key,
			text_chars: 100,
		})),
		pages_sim: 2,
		last_page_fill: 0.92,
		page_fills: [0.97, 0.92],
		name_text: r.basics.name.toUpperCase(),
		letter_spacing: { h1: "normal", h2: "normal" },
		links: [
			`mailto:${r.basics.email}`,
			...(r.basics.links ?? []).map((l) => l.url),
		],
		body_text: "plain text",
	};
}

/** The default spec, sized to the fixture so a good measure passes. */
function specFor(
	r: TailoredResume,
	over: Partial<LayoutSpec> = {},
): LayoutSpec {
	return {
		...DEFAULT_LAYOUT_SPEC,
		summary_bullets: r.summary.highlights.length,
		skills_groups: r.skills.length,
		...over,
	};
}

const codes = (x: { failures: { code: string }[] }) =>
	x.failures.map((f) => f.code);

describe("layoutSpecFrom", () => {
	it("defaults to the user spec: 2 pages, 2-line bullets at 60-80%, 85% last page", () => {
		const s = layoutSpecFrom(undefined);
		expect(s.pages).toBe(2);
		expect(s.bullet_lines).toBe(2);
		expect(s.bullet_fill).toEqual([0.6, 0.8]);
		expect(s.min_last_page_fill).toBe(0.85);
		expect(s.summary_bullets).toBe(4);
		expect(s.skills_groups).toBe(8);
	});

	it("reads profile.yaml > resume_layout, including per-role bullet counts", () => {
		const s = layoutSpecFrom({
			resume_layout: {
				pages: 1,
				bullet_fill: [0.5, 0.9],
				role_bullets: { "acme-2022": 8, "bad-2020": "x" },
			},
		});
		expect(s.pages).toBe(1);
		expect(s.bullet_fill).toEqual([0.5, 0.9]);
		expect(s.role_bullets).toEqual({ "acme-2022": 8 });
	});
});

describe("evaluateLayout", () => {
	it("passes a measurement that meets every rule", () => {
		const r = resume();
		const g = evaluateLayout(r, goodMeasure(r), specFor(r), 2);
		expect(g.failures).toEqual([]);
		expect(g.pass).toBe(true);
	});

	it("fails a 1-page resume and the real PDF page count wins over the simulation", () => {
		const r = resume();
		const g = evaluateLayout(r, goodMeasure(r), specFor(r), 1);
		expect(g.pass).toBe(false);
		expect(codes(g)).toContain("PAGE_COUNT");
	});

	it("fails a half-empty last page", () => {
		const r = resume();
		const m = { ...goodMeasure(r), last_page_fill: 0.55 };
		expect(codes(evaluateLayout(r, m, specFor(r), 2))).toEqual([
			"LAST_PAGE_FILL",
		]);
	});

	it("fails a 1-line or 3-line bullet and a second line outside 60-80%", () => {
		const r = resume();
		const m = goodMeasure(r);
		const bullets = m.items.filter((i) => i.kind === "bullet");
		Object.assign(bullets[0] ?? {}, { lines: 1, fills: [0.9] });
		Object.assign(bullets[1] ?? {}, { lines: 3, fills: [1, 1, 0.2] });
		Object.assign(bullets[2] ?? {}, { lines: 2, fills: [1, 0.15] });
		Object.assign(bullets[3] ?? {}, { lines: 2, fills: [1, 0.95] });
		const g = evaluateLayout(r, m, specFor(r), 2);
		expect(codes(g)).toEqual([
			"BULLET_LINES",
			"BULLET_LINES",
			"BULLET_FILL",
			"BULLET_FILL",
		]);
		expect(g.bullets.length).toBe(
			m.items.filter((i) => i.kind === "bullet" || i.kind === "highlight")
				.length,
		);
	});

	it("fails a wrapped skills, Environment or publication line", () => {
		const r = resume();
		const m = goodMeasure(r);
		m.items.push(
			{
				kind: "env",
				path: "experience[0].environment",
				lines: 2,
				fills: [1, 0.1],
				text: "e",
			},
			{
				kind: "pub",
				path: "publications[0]",
				lines: 2,
				fills: [1, 0.2],
				text: "p",
			},
		);
		const skill = m.items.find((i) => i.kind === "skill");
		if (skill) Object.assign(skill, { lines: 2, fills: [1, 0.05] });
		expect(codes(evaluateLayout(r, m, specFor(r), 2))).toEqual([
			"LINE_WRAPS",
			"LINE_WRAPS",
			"LINE_WRAPS",
		]);
	});

	it("allows a one-line coursework row but not a second line under half full", () => {
		const r = resume();
		const one = goodMeasure(r);
		one.items.push({
			kind: "coursework",
			path: "coursework",
			lines: 1,
			fills: [0.9],
			text: "c",
		});
		const g1 = evaluateLayout(r, one, specFor(r), 2);
		expect(g1.pass).toBe(true);
		expect(g1.warnings.map((w) => w.code)).toEqual(["COURSEWORK_FILL"]);
		const two = goodMeasure(r);
		two.items.push({
			kind: "coursework",
			path: "coursework",
			lines: 2,
			fills: [1, 0.06],
			text: "c",
		});
		expect(codes(evaluateLayout(r, two, specFor(r), 2))).toEqual([
			"COURSEWORK_FILL",
		]);
	});

	it("fails roles below their configured bullet count", () => {
		const r = resume();
		const role = r.experience[0];
		if (!role) throw new Error("fixture has no role");
		const g = evaluateLayout(
			r,
			goodMeasure(r),
			specFor(r, { role_bullets: { [role.role_id]: role.bullets.length + 5 } }),
			2,
		);
		expect(codes(g)).toEqual(["ROLE_BULLETS"]);
	});

	it("fails the wrong number of summary bullets or skill groups", () => {
		const r = resume();
		const g = evaluateLayout(
			r,
			goodMeasure(r),
			specFor(r, { summary_bullets: 9, skills_groups: 9 }),
			2,
		);
		expect(codes(g)).toEqual(["SUMMARY_BULLETS", "SKILLS_GROUPS"]);
	});

	it("fails an empty or missing section, an em dash, letter-spacing, a misread name and a missing link", () => {
		const r = resume();
		const m = goodMeasure(r);
		m.sections = m.sections
			.filter((s) => s.key !== "skills")
			.map((s) => (s.key === "education" ? { ...s, text_chars: 0 } : s));
		m.body_text = `before ${EM} after`;
		m.letter_spacing = { h1: "1.6px", h2: "normal" };
		m.name_text = "V I K A S";
		m.links = [];
		const c = codes(evaluateLayout(r, m, specFor(r), 2));
		for (const code of [
			"EMPTY_SECTION",
			"EM_DASH",
			"LETTER_SPACING",
			"NAME_TEXT",
			"LINKS",
		])
			expect(c).toContain(code);
	});
});

describe("measurement plumbing", () => {
	it("injects the probe at the print content width", () => {
		const html = measurementHtml(renderHtml(resume()), {
			widthIn: 7.5,
			heightIn: 10,
		});
		expect(html).toContain("width:7.5in");
		expect(html).toContain("data-jh-layout");
		expect(html).toContain("var PAGE=960;");
	});

	it("decodes the base64 report Chrome leaves on <html>", () => {
		const report = { pages_sim: 2, items: [] };
		const b64 = Buffer.from(JSON.stringify(report)).toString("base64");
		expect(parseLayoutDump(`<html data-jh-layout="${b64}">`)).toEqual(report);
		expect(parseLayoutDump("<html>")).toBeNull();
	});

	it("marks every measured row in the classic-navy HTML", () => {
		const html = renderHtml(resume());
		for (const kind of ["bullet", "skill", "headline", "contact"])
			expect(html).toContain(`data-kind="${kind}"`);
		expect(html).toContain('data-section="experience"');
	});
});

describe("validate: spec text rules", () => {
	const M = fx.master();
	const P = fx.profile();

	it("rejects an em dash in a bullet (EM_DASH)", () => {
		const d = fx.draft();
		const b = d.experience[0]?.bullets[0];
		if (!b) throw new Error("fixture has no bullet");
		b.text = `${b.text.slice(0, 40)} ${EM} ${b.text.slice(40)}`;
		const v = validateTailored(d, M, P);
		expect(v.errors.map((e) => e.code)).toContain("EM_DASH");
	});

	it("accepts a whole-word prefix as a publication display_title and rejects anything else", () => {
		const master = {
			...M,
			publications: [
				{
					title:
						"Toward Robust EEG Classification Using Adaptive Architectures",
					venue: "MDPI Sensors",
					year: "2026",
				},
			],
		};
		const d = fx.draft();
		d.publications = [
			{
				...(master.publications[0] as (typeof master.publications)[number]),
				display_title: "Toward Robust EEG Classification Using",
			},
		];
		expect(validateTailored(d, master, P).errors).toEqual([]);
		d.publications = [
			{
				...(master.publications[0] as (typeof master.publications)[number]),
				display_title: "Robust EEG Classification With Transformers",
			},
		];
		expect(validateTailored(d, master, P).errors.map((e) => e.code)).toEqual([
			"PUB_MISMATCH",
		]);
	});
});

const chrome = findChrome();

describe.skipIf(!chrome)("layout gate in headless Chrome", () => {
	it("fails a 1-page, 1-bullet resume (the NVIDIA regression)", async () => {
		const r = resume();
		r.experience = r.experience.slice(0, 1).map((role) => ({
			...role,
			bullets: role.bullets.slice(0, 1),
		}));
		r.projects = [];
		const role = r.experience[0];
		if (!role) throw new Error("fixture has no role");
		const g = await layoutGate(r, {
			spec: layoutSpecFrom({
				resume_layout: { role_bullets: { [role.role_id]: 8 } },
			}),
		});
		expect(g.pass).toBe(false);
		expect(g.pages_sim).toBe(1);
		const c = codes(g);
		expect(c).toContain("PAGE_COUNT");
		expect(c).toContain("ROLE_BULLETS");
	}, 60_000);

	it("measures real line boxes: a long bullet is 2+ lines, a short one is 1", async () => {
		const r = resume();
		const role = r.experience[0];
		const b0 = role?.bullets[0];
		const b1 = role?.bullets[1];
		if (!role || !b0 || !b1) throw new Error("fixture has no bullets");
		b0.text = "Short bullet that fits on one line easily.";
		b1.text = `${"Built resilient streaming pipelines with Kafka and Python ".repeat(4).trim()}.`;
		const g = await layoutGate(r, { spec: layoutSpecFrom(undefined) });
		const lines = new Map(g.bullets.map((b) => [b.path, b.lines]));
		expect(lines.get("experience[0].bullets[0]")).toBe(1);
		expect(lines.get("experience[0].bullets[1]")).toBeGreaterThanOrEqual(2);
	}, 60_000);
});
