import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { deflateSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { renderCover } from "../../src/render/cover.js";
import {
	countPdfPages,
	findChrome,
	fitPages,
	lastChromeArgs,
	pdfHasText,
	renderAll,
	renderHtml,
	renderPdf,
} from "../../src/render/index.js";
import { TailoredResume } from "../../src/resume/schema.js";

const FIXTURE = join(import.meta.dirname, "..", "fixtures", "render");
const resume = (): TailoredResume =>
	TailoredResume.parse(
		JSON.parse(readFileSync(join(FIXTURE, "resume.fixture.json"), "utf8")),
	);

/** A tiny synthetic PDF with one content stream. */
function syntheticPdf(content: string, pages = 1, compress = true): Buffer {
	const data = compress
		? deflateSync(Buffer.from(content, "latin1"))
		: Buffer.from(content, "latin1");
	const filter = compress ? "/Filter /FlateDecode " : "";
	const pageObjs = Array.from(
		{ length: pages },
		(_, i) =>
			`${i + 4} 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 3 0 R >>\nendobj\n`,
	).join("");
	return Buffer.concat([
		Buffer.from(
			`%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Count ${pages} >>\nendobj\n${pageObjs}3 0 obj\n<< ${filter}/Length ${data.length} >>\nstream\n`,
			"latin1",
		),
		data,
		Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
	]);
}

describe("PDF inspection (no Chrome needed)", () => {
	it("finds text drawn with Tj or TJ in deflated streams", () => {
		expect(
			pdfHasText(syntheticPdf("BT /F1 12 Tf 72 720 Td (Hello) Tj ET")),
		).toBe(true);
		expect(pdfHasText(syntheticPdf("BT /F1 12 Tf [(He) 20 (llo)] TJ ET"))).toBe(
			true,
		);
		expect(pdfHasText(syntheticPdf("BT <0048> Tj ET", 1, false))).toBe(true);
	});

	it("is false for image-only or path-only content", () => {
		expect(pdfHasText(syntheticPdf("q 100 0 0 100 0 0 cm /Im0 Do Q"))).toBe(
			false,
		);
		expect(pdfHasText(syntheticPdf("0 0 m 100 100 l S"))).toBe(false);
	});

	it("counts page objects, not the page tree", () => {
		expect(countPdfPages(syntheticPdf("0 0 m S", 3))).toBe(3);
	});
});

const chrome = findChrome();

describe.skipIf(!chrome)("headless Chrome PDF", () => {
	let tmp: string;
	beforeAll(() => {
		tmp = mkdtempSync(join(tmpdir(), "jh-pdf-test-"));
	});
	afterAll(() => {
		rmSync(tmp, { recursive: true, force: true });
	});

	it("renders a PDF with a text layer", async () => {
		const out = join(tmp, "resume.pdf");
		const { pages } = await renderPdf(renderHtml(resume()), out);
		expect(pages).toBeGreaterThanOrEqual(1);
		const buf = readFileSync(out);
		expect(buf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
		expect(pdfHasText(buf)).toBe(true);
	}, 60_000);

	it("uses a throwaway profile under the temp dir, never the user's profile", async () => {
		await renderPdf(renderHtml(resume()), join(tmp, "profile-check.pdf"));
		const args = lastChromeArgs();
		const dirArg = args.find((a) => a.startsWith("--user-data-dir="));
		expect(dirArg).toBeDefined();
		const dir = resolve((dirArg as string).slice("--user-data-dir=".length));
		expect(dir.startsWith(resolve(tmpdir()) + sep)).toBe(true);
		expect(args.join(" ")).not.toMatch(/Staffing|--profile-directory/i);
		expect(args).toContain("--headless=new");
		expect(existsSync(dir)).toBe(false);
	}, 60_000);

	it("fits to one page or reports overflow", async () => {
		const fit = await fitPages(resume(), 1);
		expect(fit.pages <= 1 || (fit.overflow_lines ?? 0) > 0).toBe(true);
		expect([0, 1, 2, 3]).toContain(fit.density);
	}, 180_000);

	it("renderAll writes every format including the PDF", async () => {
		const out = join(tmp, "all");
		const res = await renderAll(resume(), out, ["pdf", "docx", "html", "txt"]);
		expect(res.files.pdf).toBe(
			join(out, "Jordan_Avery_Resume_Northwind_Analytics.pdf"),
		);
		expect(res.pages).toBeGreaterThanOrEqual(1);
		expect(res.pages).toBeLessThanOrEqual(2);
		expect(res.pdf_text_ok).toBe(true);
		expect(res.warnings.filter((w) => w.startsWith("pdf_failed"))).toEqual([]);
	}, 180_000);

	it("renders a one-page cover letter PDF", async () => {
		const md = readFileSync(join(FIXTURE, "cover.fixture.md"), "utf8");
		const res = await renderCover(
			md,
			resume().basics,
			"Northwind Analytics",
			join(tmp, "cover"),
			["pdf"],
		);
		expect(res.files.pdf).toBe(join(tmp, "cover", "cover.pdf"));
		expect(res.pages).toBe(1);
		expect(res.pdf_text_ok).toBe(true);
	}, 60_000);
});
