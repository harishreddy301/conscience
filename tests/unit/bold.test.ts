import { describe, expect, it } from "vitest";
import { splitEmphasis, stripEmphasis } from "../../src/render/emphasis.js";
import { renderHtml } from "../../src/render/html.js";
import {
	docxDocumentXml,
	renderDocx,
	renderText,
} from "../../src/render/index.js";
import {
	applyBold,
	metricPhrases,
	suggestBold,
} from "../../src/resume/bold.js";
import type { TailoredResume } from "../../src/resume/schema.js";
import {
	EM_DASH,
	metricSpans,
	validateTailored,
} from "../../src/resume/validate.js";
import * as fx from "../fixtures/resume/fixtures.js";

const M = fx.master();
const P = fx.profile();

function check(mutate: (d: TailoredResume) => void) {
	const d = fx.draft();
	mutate(d);
	return validateTailored(d, M, P);
}
const codes = (r: { errors: { code: string }[] }) =>
	r.errors.map((e) => e.code);
const b = (d: TailoredResume, role: number, i: number) =>
	(d.experience[role] as TailoredResume["experience"][number]).bullets[
		i
	] as TailoredResume["experience"][number]["bullets"][number];

describe("bold key terms (validator)", () => {
	it("passes the fixture, which bolds 2-4 terms per bullet and every metric", () => {
		expect(check(() => {}).errors).toEqual([]);
	});

	it("BOLD_MISSING: a bullet with fewer than 2 bold spans", () => {
		const none = check((d) => {
			b(d, 0, 1).emphasis = [];
		});
		expect(codes(none)).toEqual(["BOLD_MISSING"]);
		const one = check((d) => {
			b(d, 0, 1).emphasis = ["Airflow DAGs"];
		});
		expect(codes(one)).toEqual(["BOLD_MISSING"]);
		expect(one.errors[0]?.path).toBe("experience[0].bullets[1].emphasis");
	});

	it("BOLD_EXCESS: more than 4 spans, or bold over 30% of the bullet", () => {
		const many = check((d) => {
			b(d, 0, 1).emphasis = ["Migrated", "batch", "ETL", "cron", "SQL"];
		});
		expect(codes(many)).toContain("BOLD_EXCESS");
		const wide = check((d) => {
			b(d, 0, 1).emphasis = [
				"Migrated nightly batch ETL",
				"SQL data quality checks",
			];
		});
		expect(codes(wide)).toEqual(["BOLD_EXCESS"]);
		expect(wide.errors[0]?.message).toMatch(/% of the bullet/);
	});

	it("METRIC_NOT_BOLD: every metric sits inside a bold span", () => {
		const r = check((d) => {
			b(d, 0, 0).emphasis = ["streaming ingestion", "AWS S3"];
		});
		expect(codes(r)).toEqual(["METRIC_NOT_BOLD"]);
		expect(r.errors[0]?.token).toBe("45%");
		// A range needs both ends bold: "6 hours" alone leaves "30 minutes" plain.
		const range = check((d) => {
			b(d, 1, 0).emphasis = ["SQL", "6 hours"];
		});
		expect(codes(range)).toEqual(["METRIC_NOT_BOLD"]);
		expect(range.errors[0]?.token).toBe("30 minutes");
	});

	it("does not treat tech tokens or bare years as metrics", () => {
		expect(
			metricSpans("Used S3, EC2, K-12 and Python 3.11 since 2021").map(
				(m) => m.raw,
			),
		).toEqual([]);
		expect(
			metricSpans("cut 45 minutes to under 15 for 1,000+ docs, 3x faster").map(
				(m) => m.raw,
			),
		).toEqual(["45 minutes", "15", "1,000+", "3x"]);
	});

	it("SUMMARY_BOLD_MISSING: the summary paragraph bolds something", () => {
		const r = check((d) => {
			d.summary.emphasis = [];
		});
		expect(codes(r)).toContain("SUMMARY_BOLD_MISSING");
	});

	it("HIGHLIGHT_LABEL_NOT_BOLD: the label lives in `label`, not inline in the text", () => {
		const ok = check((d) => {
			d.summary.highlights = [
				{
					label: "Streaming",
					text: "Cut pipeline latency by 45% by moving ingestion to streaming.",
					source_ids: ["acme-analytics-2021.b01"],
					emphasis: ["45%", "streaming"],
				},
			];
		});
		expect(ok.errors).toEqual([]);
		const inline = check((d) => {
			d.summary.highlights = [
				{
					label: "Data",
					text: "Streaming: cut pipeline latency by 45% by moving ingestion to streaming.",
					source_ids: ["acme-analytics-2021.b01"],
					emphasis: ["45%", "streaming"],
				},
			];
		});
		expect(codes(inline)).toEqual(["HIGHLIGHT_LABEL_NOT_BOLD"]);
	});

	it("BOLD_UNTRACEABLE: phrases must occur verbatim, not overlap, and text carries no markup", () => {
		expect(
			codes(
				check((d) => {
					b(d, 0, 1).emphasis = ["Airflow DAGs", "SQL", "Kafka"];
				}),
			),
		).toEqual(["BOLD_UNTRACEABLE"]);
		expect(
			codes(
				check((d) => {
					b(d, 0, 1).emphasis = ["Airflow DAGs", "DAGs with", "SQL"];
				}),
			),
		).toEqual(["BOLD_UNTRACEABLE"]);
		expect(
			codes(
				check((d) => {
					b(d, 0, 1).text =
						"Migrated nightly batch ETL from cron scripts to **Airflow DAGs** with SQL data quality checks";
				}),
			),
		).toContain("BOLD_UNTRACEABLE");
	});

	it("stripping the bold markup gives back exactly the validated text", () => {
		const d = fx.draft();
		for (const role of d.experience)
			for (const bl of role.bullets) {
				const segs = splitEmphasis(bl.text, bl.emphasis);
				expect(stripEmphasis(segs)).toBe(bl.text);
				expect(segs.filter((s) => s.bold).length).toBeGreaterThanOrEqual(2);
			}
	});
});

describe("bold rendering", () => {
	it("DOCX writes bold phrases as real bold runs", async () => {
		const xml = docxDocumentXml(await renderDocx(fx.draft()));
		const boldRun = (t: string) =>
			new RegExp(
				`<w:r>(?:(?!</w:r>).)*<w:b/>(?:(?!</w:r>).)*<w:t[^>]*>${t}</w:t></w:r>`,
				"s",
			);
		expect(xml).toMatch(boldRun("45%"));
		expect(xml).toMatch(boldRun("6 hours to 30 minutes"));
		expect(xml).toMatch(boldRun("8\\+ years"));
	});

	it("HTML wraps bold phrases in <strong>", () => {
		const html = renderHtml(fx.draft());
		expect(html).toContain("<strong>45%</strong>");
		expect(html).toContain("<strong>Airflow DAGs</strong>");
	});

	it("the .txt export strips bold and uses no em dash", () => {
		const d = fx.draft();
		d.publications = [
			{
				title: "Fictional Fixture Paper",
				venue: "Journal of Fixtures",
				year: "2024",
			},
		];
		for (const theme of ["classic-navy", "standard"] as const) {
			d.layout = { ...d.layout, theme };
			const text = renderText(d);
			expect(text).not.toContain(EM_DASH);
			expect(text).not.toContain("**");
			expect(text).toContain("Fictional Fixture Paper, Journal of Fixtures");
			expect(text).toContain("cutting report prep from 6 hours to 30 minutes");
		}
	});
});

describe("jh resume bold --suggest", () => {
	it("merges N to M ranges and keeps glued nouns", () => {
		const t = "cut 45 minutes to under 15 over a 150-case set and 1,000+ docs";
		expect(metricPhrases(t).map(([s, e]) => t.slice(s, e))).toEqual([
			"45 minutes to under 15",
			"150-case",
			"1,000+",
		]);
	});

	it("bolds every metric, then JD keywords and skills, within the rules", () => {
		const d = fx.draft();
		const s = suggestBold(d, M, P, fx.keywords());
		const first = s.find((x) => x.path === "experience[0].bullets[0]");
		expect(first?.suggested).toContain("45%");
		expect(first?.suggested.length).toBeGreaterThanOrEqual(2);
		expect(first?.suggested.length).toBeLessThanOrEqual(4);
		// Deterministic: the same input gives the same baseline.
		expect(suggestBold(d, M, P, fx.keywords())).toEqual(s);
	});

	it("applied suggestions pass the bold rules wherever none are short", () => {
		const d = fx.draft();
		const s = suggestBold(d, M, P, fx.keywords());
		const applied = applyBold(d, s);
		const r = validateTailored(applied, M, P);
		const shortPaths = s.filter((x) => x.short).map((x) => x.path);
		const boldErrors = r.errors.filter(
			(e) =>
				e.code.includes("BOLD") &&
				!shortPaths.some((p) => e.path.startsWith(p)),
		);
		expect(boldErrors).toEqual([]);
	});
});
