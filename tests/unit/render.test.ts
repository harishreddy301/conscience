import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { coverRender, parseCoverFormats } from "../../src/commands/cover.js";
import { openDb } from "../../src/db/index.js";
import {
	createApplication,
	insertJob,
	upsertCompany,
} from "../../src/db/repo.js";
import type { Profile } from "../../src/me/schema.js";
import { chromeCandidates } from "../../src/render/chrome.js";
import { parseCoverMarkdown, renderCover } from "../../src/render/cover.js";
import { estimateHeightPt } from "../../src/render/fit.js";
import {
	artifactBaseName,
	type Density,
	docxDocumentXml,
	estimateFit,
	formatDate,
	formatRange,
	renderAll,
	renderDocx,
	renderHtml,
	renderText,
	resumeBaseName,
} from "../../src/render/index.js";
import { TailoredResume } from "../../src/resume/schema.js";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "render");
const resume = (): TailoredResume =>
	TailoredResume.parse(
		JSON.parse(readFileSync(join(FIXTURE, "resume.fixture.json"), "utf8")),
	);
/** The fixture in the older "standard" theme (the default is classic-navy). */
const standard = (): TailoredResume => {
	const r = resume();
	r.layout.theme = "standard";
	return r;
};

let tmp: string;
beforeAll(() => {
	tmp = mkdtempSync(join(tmpdir(), "jh-render-test-"));
});
afterAll(() => {
	rmSync(tmp, { recursive: true, force: true });
});

const bodyOf = (html: string): string =>
	html.slice(html.indexOf("<body>"), html.indexOf("</body>"));

describe("formatDate", () => {
	it.each([
		["2022-01", "Jan 2022"],
		["2019-12", "Dec 2019"],
		["present", "Present"],
		["Present", "Present"],
		["2016", "2016"],
		["2022-13", "2022-13"],
	])("%s -> %s", (input, out) => {
		expect(formatDate(input)).toBe(out);
	});

	it("joins a range with an en dash", () => {
		expect(formatRange("2022-01", "present")).toBe("Jan 2022 \u2013 Present");
		expect(formatRange("2023-03", "2023-03")).toBe("Mar 2023");
	});
});

describe("renderHtml (standard theme)", () => {
	const html = renderHtml(standard());

	it("has exactly one h1 with the name and a 'First Last – Resume' title", () => {
		expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
		expect(html).toContain("<h1>Jordan Avery</h1>");
		expect(html).toContain("<title>Jordan Avery \u2013 Resume</title>");
	});

	it("uses the standard section headings in order", () => {
		const h2 = [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
		expect(h2).toEqual([
			"Summary",
			"Skills",
			"Experience",
			"Projects",
			"Education",
			"Certifications",
		]);
	});

	it("omits empty optional sections", () => {
		const r = standard();
		r.projects = [];
		r.certifications = [];
		const h = renderHtml(r);
		expect(h).not.toContain("<h2>Projects</h2>");
		expect(h).not.toContain("<h2>Certifications</h2>");
	});

	it("contains no tables, images, svg, icons or multi-column CSS", () => {
		expect(html).not.toMatch(/<table|<img|<svg|<i\s|<canvas|<iframe/i);
		expect(html).not.toMatch(/column|grid|float\s*:/i);
		expect(html).not.toMatch(/position\s*:\s*(fixed|absolute)/i);
	});

	it("puts contact details in the body", () => {
		const body = bodyOf(html);
		expect(body).toContain("jordan.avery@example.com");
		expect(body).toContain("+1 555 010 0199");
		expect(body).toContain("Austin, TX");
		expect(body).toContain("linkedin.com/in/jordan-avery-example");
		expect(body).toContain('href="mailto:jordan.avery@example.com"');
	});

	it("orders each role as title, employer, location, dates", () => {
		const roles = bodyOf(html).split('<div class="role">').slice(1);
		expect(roles.length).toBe(4);
		for (const role of roles.slice(0, 3)) {
			const idx = ["title", "employer", "location", "dates"].map((c) =>
				role.indexOf(`class="${c}"`),
			);
			expect(idx.every((i) => i >= 0)).toBe(true);
			expect([...idx].sort((a, b) => a - b)).toEqual(idx);
		}
		expect(roles[0]).toContain(
			'<span class="dates">Jan 2022 \u2013 Present</span>',
		);
	});

	it("escapes HTML in content", () => {
		const r = resume();
		const role = r.experience[0];
		if (!role?.bullets[0]) throw new Error("fixture");
		role.bullets[0].text = "Shipped <script>alert(1)</script> & more things";
		const h = renderHtml(r);
		expect(h).not.toContain("<script>");
		expect(h).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; more");
	});

	it("reduces font size and margins as density increases", () => {
		const fonts = ([0, 1, 2, 3] as Density[]).map((d) => {
			const m = /--fs:([\d.]+)pt/.exec(renderHtml(standard(), { density: d }));
			return Number(m?.[1]);
		});
		expect(fonts).toEqual([10.2, 10, 9.8, 9.5]);
		for (let i = 1; i < fonts.length; i++)
			expect(fonts[i]).toBeLessThan(fonts[i - 1] as number);
		expect(renderHtml(standard(), { density: 0 })).toContain(
			"@page{size:Letter;margin:0.55in 0.6in}",
		);
	});

	it("uses A4 when layout.paper is a4", () => {
		const r = resume();
		r.layout.paper = "a4";
		expect(renderHtml(r)).toContain("size:A4");
	});

	it("applies the theme spec", () => {
		expect(html).toContain("font-family:Calibri");
		expect(html).toContain("break-inside:avoid");
		expect(html).toContain("letter-spacing:0.08em");
		expect(html).toContain("#1F3A5F");
	});
});

describe("classic-navy theme (default)", () => {
	/** Fixture with the optional classic fields filled in (fictional). */
	const classic = (): TailoredResume => {
		const r = resume();
		r.summary.highlights = [
			{
				label: "Streaming Pipelines",
				text: "Built Kafka and Spark streaming jobs feeding analytics tables.",
				source_ids: ["fabrikam-2022.b01"],
				emphasis: ["Kafka"],
			},
		];
		const role = r.experience[0];
		if (!role) throw new Error("fixture");
		role.environment = ["Python", "Kafka"];
		r.education = [
			{
				school: "Example State University",
				degree: "M.S.",
				field: "Data Science",
				year: "2019",
				coursework: ["Distributed Systems", "Databases"],
			},
		];
		r.certifications = [];
		r.publications = [
			{
				title: "A Fictional Study of Pipelines",
				venue: "Example Journal",
				year: "2024",
				url: "https://example.com/paper",
			},
		];
		return r;
	};

	it("is the default theme", () => {
		expect(resume().layout.theme).toBe("classic-navy");
		const html = renderHtml(resume());
		expect(html).toContain("#1F3864");
		expect(html).toContain("Calibri, Carlito, Arial");
	});

	it("uses standard ATS headings with Publications instead of Certifications", () => {
		const html = renderHtml(classic());
		const h2 = [...html.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
		// Caps are written into the text (no CSS text-transform or letter-spacing).
		expect(h2).toEqual([
			"PROFESSIONAL SUMMARY",
			"TECHNICAL SKILLS",
			"PROFESSIONAL EXPERIENCE",
			"PROJECTS",
			"EDUCATION",
			"PUBLICATIONS",
		]);
		expect(html).not.toContain("Certifications");
		expect(html).toContain('<ul class="squares">');
	});

	it("renders labeled highlights, two-line role heads and the Environment line", () => {
		const body = bodyOf(renderHtml(classic()));
		expect(body).toContain(
			'<li data-kind="highlight" data-path="summary.highlights[0]"><strong>Streaming Pipelines:</strong> Built <strong>Kafka</strong>',
		);
		expect(body).toContain('<span class="dates">Jan 2022 to Present</span>');
		expect(body).toContain(
			'<div class="row role-sub"><span class="employer">Fabrikam Logistics</span><span class="location">Austin, TX</span></div>',
		);
		expect(body).toContain(
			'<p class="env" data-kind="env" data-path="experience[0].environment"><span class="label">Environment:</span> Python, Kafka</p>',
		);
		expect(body).toContain("Relevant Coursework:");
		expect(body).toContain('<span class="degree">M.S. in Data Science</span>');
	});

	it("centers a location-first contact line and splits the headline", () => {
		const body = bodyOf(renderHtml(classic()));
		const contact =
			/<p class="contact" data-kind="contact">([\s\S]*?)<\/p>/.exec(
				body,
			)?.[1] ?? "";
		expect(contact.indexOf("Austin, TX")).toBeLessThan(
			contact.indexOf("jordan.avery@example.com"),
		);
		expect(body).toMatch(
			/<p class="headline" data-kind="headline"><span>Senior Data Engineer<\/span> <span class="sep">\|<\/span>/,
		);
	});

	it("omits coursework when none is recorded", () => {
		const r = classic();
		r.education = r.education.map(({ coursework: _c, ...e }) => e);
		expect(renderHtml(r)).not.toContain("Relevant Coursework");
	});

	it("stays ATS-safe: no tables, images or multi-column CSS", () => {
		const html = renderHtml(classic());
		expect(html).not.toMatch(/<table|<img|<svg|<canvas|<iframe/i);
		expect(html).not.toMatch(/column|grid|float\s*:/i);
		expect(html.match(/<h1[\s>]/g)).toHaveLength(1);
	});

	it("uses Calibri 9.75pt and 0.5in margins at every density (user spec)", () => {
		for (const d of [0, 1, 2, 3] as const) {
			const html = renderHtml(resume(), { density: d });
			expect(html).toContain("--fs:9.75pt");
			expect(html).toContain("margin:0.5in 0.5in");
		}
	});

	it("renders DOCX with headings, square publication bullets and no tables", async () => {
		const xml = docxDocumentXml(await renderDocx(classic()));
		expect(xml).not.toContain("<w:tbl");
		expect(xml).toContain("PROFESSIONAL EXPERIENCE");
		expect(xml).toContain("PUBLICATIONS");
		expect(xml).not.toContain("CERTIFICATIONS");
		expect(xml).toContain("Environment: ");
		expect(xml).toContain("Jan 2022 to Present");
		expect(xml).toContain("A Fictional Study of Pipelines");
	});

	it("puts highlights and the Environment line in the text output", () => {
		const text = renderText(classic());
		expect(text).toContain("- Streaming Pipelines: Built Kafka");
		expect(text).toContain("Environment: Python, Kafka");
		expect(text).toMatch(/^PROFESSIONAL EXPERIENCE$/m);
		expect(text.indexOf("EDUCATION")).toBeLessThan(
			text.indexOf("PUBLICATIONS"),
		);
	});
});

describe("renderText", () => {
	it("includes every bullet, the contact line and the headings", () => {
		const r = standard();
		const text = renderText(r);
		for (const role of [...r.experience, ...r.projects])
			for (const b of role.bullets) expect(text).toContain(`- ${b.text}`);
		expect(text).toContain("jordan.avery@example.com | +1 555 010 0199");
		expect(text).toContain(
			"Senior Data Engineer | Fabrikam Logistics | Austin, TX | Jan 2022 \u2013 Present",
		);
		expect(text).toMatch(/^EXPERIENCE$/m);
		expect(text).not.toMatch(/<[a-z]/i);
	});
});

describe("renderDocx", () => {
	it("produces Heading1 sections, bullets, right tab dates and no tables", async () => {
		const xml = docxDocumentXml(await renderDocx(standard()));
		const headings = xml.match(/<w:pStyle w:val="Heading1"\/>/g) ?? [];
		expect(headings).toHaveLength(6);
		expect(xml).not.toContain("<w:tbl");
		expect(xml).toContain("<w:numPr>");
		expect(xml).toMatch(/<w:tab w:val="right"/);
		expect(xml).toContain("jordan.avery@example.com");
		expect(xml).toContain("Jan 2022 \u2013 Present");
		expect(xml).toContain("EXPERIENCE");
	});

	it("rejects non-DOCX buffers", () => {
		expect(() => docxDocumentXml(Buffer.from("not a zip"))).toThrow(/DOCX/);
	});
});

describe("fit estimate", () => {
	it("height shrinks as density increases", () => {
		const r = resume();
		const h = ([0, 1, 2, 3] as Density[]).map((d) => estimateHeightPt(r, d));
		for (let i = 1; i < h.length; i++)
			expect(h[i]).toBeLessThan(h[i - 1] as number);
	});

	it("fits a short resume on one page at density 0", () => {
		const r = resume();
		r.experience = r.experience.slice(0, 1);
		r.projects = [];
		expect(estimateFit(r, 1)).toEqual({ density: 0, pages: 1 });
	});

	it("reports overflow lines when nothing fits", () => {
		const r = resume();
		const role = r.experience[0];
		if (!role) throw new Error("fixture");
		r.experience = Array.from({ length: 12 }, (_, i) => ({
			...role,
			role_id: `r${i}`,
		}));
		const fit = estimateFit(r, 1);
		expect(fit.density).toBe(3);
		expect(fit.pages).toBeGreaterThan(1);
		expect(fit.overflow_lines).toBeGreaterThan(0);
	});
});

describe("file naming", () => {
	it("builds First_Last_Resume_<Company>", () => {
		expect(resumeBaseName(resume())).toBe(
			"Jordan_Avery_Resume_Northwind_Analytics",
		);
		expect(artifactBaseName("José  Núñez", "Resume", "Acme, Inc.")).toBe(
			"Jose_Nunez_Resume_Acme_Inc",
		);
	});
});

describe("renderAll without PDF", () => {
	it("writes html, txt and docx with the canonical names", async () => {
		const out = join(tmp, "all");
		const res = await renderAll(resume(), out, ["html", "txt", "docx"]);
		const base = join(out, "Jordan_Avery_Resume_Northwind_Analytics");
		expect(res.files).toEqual({
			html: `${base}.html`,
			txt: `${base}.txt`,
			docx: `${base}.docx`,
		});
		for (const f of Object.values(res.files)) expect(existsSync(f)).toBe(true);
		expect(res.pages).toBeNull();
		expect([0, 1, 2, 3]).toContain(res.density);
	});

	it("honours an explicit density", async () => {
		const res = await renderAll(standard(), join(tmp, "dense"), ["html"], {
			density: 2,
		});
		expect(res.density).toBe(2);
		expect(readFileSync(res.files.html as string, "utf8")).toContain(
			"--fs:9.8pt",
		);
	});
});

describe("chromeCandidates", () => {
	it("puts CHROME_PATH first and covers the Windows install locations", () => {
		const c = chromeCandidates(
			{
				CHROME_PATH: "X:\\custom\\chrome.exe",
				ProgramFiles: "C:\\Program Files",
				"ProgramFiles(x86)": "C:\\Program Files (x86)",
				LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
			},
			"win32",
		);
		expect(c[0]).toBe("X:\\custom\\chrome.exe");
		expect(c.some((p) => /Program Files[\\/]Google[\\/]Chrome/.test(p))).toBe(
			true,
		);
		expect(
			c.some((p) => /AppData[\\/]Local[\\/]Google[\\/]Chrome/.test(p)),
		).toBe(true);
	});

	it("lists mac and linux paths", () => {
		expect(chromeCandidates({}, "darwin")[0]).toContain("Google Chrome.app");
		expect(chromeCandidates({}, "linux")).toContain("/usr/bin/google-chrome");
	});
});

describe("cover letters", () => {
	const md = readFileSync(join(FIXTURE, "cover.fixture.md"), "utf8");

	it("parses paragraphs, lists and inline marks", () => {
		const blocks = parseCoverMarkdown(md);
		expect(blocks.map((b) => b.kind)).toEqual(["p", "p", "p", "ul", "p", "p"]);
		const intro = blocks[1];
		expect(intro?.kind === "p" && intro.inlines.some((i) => i.bold)).toBe(true);
		const list = blocks[3];
		expect(list?.kind === "ul" && list.items.length).toBe(2);
		const link = blocks[4];
		expect(link?.kind === "p" && link.inlines.find((i) => i.href)?.href).toBe(
			"https://github.com/jordan-avery-example",
		);
	});

	it("renders txt and docx in the resume theme", async () => {
		const out = join(tmp, "cover");
		const res = await renderCover(
			md,
			resume().basics,
			"Northwind Analytics",
			out,
			["txt", "docx"],
		);
		expect(res.files.txt).toBe(join(out, "cover.txt"));
		const text = readFileSync(res.files.txt as string, "utf8");
		expect(text).toContain("Jordan Avery");
		expect(text).toContain("- led the move of nightly ETL jobs");
		expect(text).toContain("GitHub (https://github.com/jordan-avery-example)");
		expect(text).toContain("Sincerely,\nJordan Avery");
		expect(text).toContain("eight years I have built batch and streaming");
		const xml = docxDocumentXml(readFileSync(res.files.docx as string));
		expect(xml).toContain("Northwind Analytics");
		expect(xml).not.toContain("<w:tbl");
		expect(res.warnings).toEqual([]);
	});

	it("warns when the company is not mentioned", async () => {
		const res = await renderCover(
			"Hello there, team.",
			resume().basics,
			"Globex",
			join(tmp, "c2"),
			["txt"],
		);
		expect(
			res.warnings.some((w) => w.startsWith("cover_missing_company")),
		).toBe(true);
	});
});

describe("jh cover render", () => {
	const profile = (): Profile =>
		({
			version: 1,
			identity: {
				name: "Jordan Avery",
				email: "jordan.avery@example.com",
				location: "Austin, TX",
				links: { GitHub: "https://github.com/jordan-avery-example" },
			},
		}) as Profile;

	it("validates formats", () => {
		expect(parseCoverFormats("pdf, DOCX,docx")).toEqual(["pdf", "docx"]);
		expect(() => parseCoverFormats("pdf,html")).toThrow(/formats/);
	});

	it("renders into the application's artifacts dir using profile basics", async () => {
		const prev = process.env.JOB_HUNTER_HOME;
		process.env.JOB_HUNTER_HOME = join(tmp, "home");
		const db = openDb(":memory:");
		try {
			const co = upsertCompany(db, { name: "Northwind Analytics" });
			const job = insertJob(db, {
				company_id: co.id,
				title: "Senior Data Engineer",
			});
			const app = createApplication(db, { job_id: job.id });
			const mdPath = join(FIXTURE, "cover.fixture.md");
			const out = await coverRender(
				db,
				mdPath,
				app.id,
				["txt", "docx"],
				profile,
			);
			expect(out.out_dir).toBe(join(tmp, "home", "artifacts", String(app.id)));
			expect(existsSync(join(out.out_dir, "cover.md"))).toBe(true);
			expect(existsSync(join(out.out_dir, "cover.docx"))).toBe(true);
			expect(readFileSync(join(out.out_dir, "cover.txt"), "utf8")).toContain(
				"github.com/jordan-avery-example",
			);
			await expect(
				coverRender(db, mdPath, 9999, ["txt"], profile),
			).rejects.toThrow(/not found/);
		} finally {
			db.close();
			if (prev === undefined) delete process.env.JOB_HUNTER_HOME;
			else process.env.JOB_HUNTER_HOME = prev;
		}
	});
});
