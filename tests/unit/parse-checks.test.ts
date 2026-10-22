import { describe, expect, it } from "vitest";
import {
	checkDates,
	docxHeadings,
	htmlHeadings,
	parseChecks,
} from "../../src/ats/parse-checks.js";
import {
	docxDocumentXml,
	renderDocx,
	renderHtml,
	renderText,
} from "../../src/render/index.js";
import * as fx from "../fixtures/resume/fixtures.js";

const BODY_TEXT = `Jordan Rivera\njordan.rivera@example.com | Austin, TX\n${"Built data pipelines in Python and SQL. ".repeat(8)}\nJan 2022 – Present`;

function page(body: string, css = "") {
	return `<!doctype html><html><head><style>${css}</style></head><body><h1>Jordan Rivera</h1>${body}</body></html>`;
}

const STANDARD =
	"<h2>Summary</h2><h2>Skills</h2><h2>Experience</h2><h2>Education</h2>";

describe("parseChecks", () => {
	it("passes a clean single-column resume", () => {
		expect(parseChecks({ html: page(STANDARD), text: BODY_TEXT })).toEqual([]);
	});

	it("passes the real renderer output for the fixture draft", () => {
		const d = fx.draft();
		expect(parseChecks({ html: renderHtml(d), text: renderText(d) })).toEqual(
			[],
		);
	});

	it("passes the real DOCX output for the fixture draft", async () => {
		const d = fx.draft();
		const docxXml = docxDocumentXml(await renderDocx(d));
		expect(docxHeadings(docxXml).length).toBeGreaterThan(0);
		expect(
			parseChecks({ html: renderHtml(d), text: renderText(d), docxXml }),
		).toEqual([]);
	});

	it("flags tables, images and multi-column CSS", () => {
		const html = page(
			`${STANDARD}<table><tr><td>x</td></tr></table><img src="a.png">`,
			"main{column-count:2}",
		);
		const out = parseChecks({ html, text: BODY_TEXT });
		expect(out).toContain("TABLE");
		expect(out).toContain("IMAGE");
		expect(out).toContain("COLUMNS");
	});

	it("flags grid columns and inline svg icons", () => {
		const html = page(
			`${STANDARD}<svg></svg><div style="display:grid;grid-template-columns:1fr 2fr"></div>`,
		);
		const out = parseChecks({ html, text: BODY_TEXT });
		expect(out).toEqual(expect.arrayContaining(["IMAGE", "COLUMNS"]));
	});

	it("flags DOCX tables, drawings, text boxes and section columns", () => {
		const docxXml =
			'<w:body><w:tbl/><w:drawing/><w:txbxContent/><w:sectPr><w:cols w:num="2"/></w:sectPr></w:body>';
		const out = parseChecks({ html: page(STANDARD), text: BODY_TEXT, docxXml });
		expect(out).toEqual(
			expect.arrayContaining(["TABLE", "IMAGE", "TEXTBOX", "COLUMNS"]),
		);
	});

	it("flags non-standard headings and a missing experience heading", () => {
		const out = parseChecks({
			html: page("<h2>About Me</h2><h2>My Journey</h2><h2>Skills</h2>"),
			text: BODY_TEXT,
		});
		expect(out).toContain("NONSTANDARD_HEADING:About Me");
		expect(out).toContain("NONSTANDARD_HEADING:My Journey");
		expect(out).toContain("MISSING_EXPERIENCE_HEADING");
		expect(out).not.toContain("NONSTANDARD_HEADING:Skills");
	});

	it("accepts standard heading variants", () => {
		const html = page(
			"<h2>Professional Summary</h2><h2>Technical Skills</h2><h2>Work Experience</h2><h2>Licenses &amp; Certifications</h2>",
		);
		expect(parseChecks({ html, text: BODY_TEXT })).toEqual([]);
	});

	it("flags bad date formats", () => {
		const text = `${BODY_TEXT}\n01/2020 – 03/2021\n2019-04 to 2020-01\nFall 2018\nSince '17`;
		const out = checkDates(text);
		expect(out).toEqual(
			expect.arrayContaining([
				"BAD_DATE_FORMAT:01/2020",
				"BAD_DATE_FORMAT:03/2021",
				"BAD_DATE_FORMAT:2019-04",
				"BAD_DATE_FORMAT:Fall 2018",
				"BAD_DATE_FORMAT:'17",
			]),
		);
		expect(
			checkDates("Jan 2022 – Present\nMarch 2019 – Dec 2021\n2017"),
		).toEqual([]);
	});

	it("flags more than one h1, missing email, short text and fancy glyphs", () => {
		const out = parseChecks({
			html: `${page(STANDARD)}<h1>Again</h1>`,
			text: "➢ Short resume text",
		});
		expect(out).toEqual(
			expect.arrayContaining([
				"NAME_NOT_SINGLE_H1:2",
				"TEXT_TOO_SHORT",
				"NO_EMAIL_IN_TEXT",
				"NONSTANDARD_GLYPH",
			]),
		);
	});
});

describe("heading extraction", () => {
	it("reads h2 text with nested tags and entities", () => {
		expect(
			htmlHeadings('<h2 class="x"><span>Skills &amp; Tools</span></h2>'),
		).toEqual(["Skills & Tools"]);
	});

	it("reads Heading1 paragraphs from DOCX XML", () => {
		const xml =
			'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>EXPERI</w:t></w:r><w:r><w:t xml:space="preserve">ENCE</w:t></w:r></w:p><w:p><w:r><w:t>body</w:t></w:r></w:p>';
		expect(docxHeadings(xml)).toEqual(["EXPERIENCE"]);
	});
});
