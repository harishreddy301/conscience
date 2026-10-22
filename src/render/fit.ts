import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TailoredResume } from "../resume/schema.js";
import { dumpDomArgs, findChrome, removeQuietly, runChrome } from "./chrome.js";
import { renderDocx } from "./docx.js";
import { renderHtml } from "./html.js";
import { countPdfPages, pdfHasText, renderPdf, withHtmlFile } from "./pdf.js";
import { renderText } from "./text.js";
import {
	DENSITIES,
	type Density,
	densitySpec,
	type Paper,
	paperSize,
	type ThemeName,
	themeOf,
} from "./theme.js";

export type Format = "html" | "pdf" | "docx" | "txt";
export const FORMATS: readonly Format[] = ["html", "pdf", "docx", "txt"];

export interface RenderResult {
	files: Partial<Record<Format, string>>;
	pages: number | null;
	density: Density;
	overflow_lines?: number;
	pdf_text_ok?: boolean;
	warnings: string[];
}

export interface FitResult {
	density: Density;
	pages: number;
	overflow_lines?: number;
}

interface FitOutcome extends FitResult {
	/** PDF bytes at the chosen density when Chrome measured the layout. */
	pdf?: Buffer;
	measured: boolean;
}

const PX_PER_IN = 96;
const PT_PER_IN = 72;
/** Average Calibri glyph advance as a fraction of the font size. */
const AVG_CHAR_EM = 0.45;

function lineHeightPt(d: Density, theme: ThemeName = "standard"): number {
	const s = densitySpec(d, theme);
	return s.fontPt * s.lineHeight;
}

function contentBox(
	d: Density,
	paper: Paper,
	theme: ThemeName = "standard",
): { widthIn: number; heightIn: number } {
	const s = densitySpec(d, theme);
	const p = paperSize(paper);
	return {
		widthIn: p.widthIn - 2 * s.marginXIn,
		heightIn: p.heightIn - 2 * s.marginYIn,
	};
}

function wrappedLines(text: string, charsPerLine: number): number {
	return Math.max(1, Math.ceil(text.length / Math.max(20, charsPerLine)));
}

/** Deterministic layout estimate used when Chrome is unavailable. Returns content height in pt. */
export function estimateHeightPt(r: TailoredResume, d: Density): number {
	const theme = themeOf(r);
	const classic = theme === "classic-navy";
	const s = densitySpec(d, theme);
	const lh = lineHeightPt(d, theme);
	const box = contentBox(d, r.layout?.paper ?? "letter", theme);
	const cpl = (box.widthIn * PT_PER_IN) / (s.fontPt * AVG_CHAR_EM);
	const bulletCpl = cpl - 3;
	const sectionPt = 10.5 * 1.3 + s.sectionGapPt + 5;
	let h = 22 * 1.1 + lh * 2 + 6;
	if (r.summary.text.trim())
		h += sectionPt + wrappedLines(r.summary.text, cpl) * lh;
	for (const hl of r.summary.highlights ?? [])
		h += wrappedLines(`${hl.label}: ${hl.text}`, cpl - 3) * lh + 0.75;
	if (r.skills.length) {
		h += sectionPt;
		for (const g of r.skills)
			h += wrappedLines(`${g.group}: ${g.items.join(", ")}`, cpl) * lh;
	}
	const roles = [r.experience, r.projects ?? []];
	for (const list of roles) {
		if (!list.length) continue;
		h += sectionPt;
		for (const role of list) {
			h += s.roleGapPt + lh * (classic ? 2 : 1);
			for (const b of role.bullets)
				h += wrappedLines(b.text, bulletCpl) * lh + 0.75;
			if (classic && role.environment?.length)
				h +=
					wrappedLines(
						`Environment: ${role.environment.join(", ")}`,
						bulletCpl * 1.08,
					) * lh;
		}
	}
	if (r.publications?.length) {
		h += sectionPt;
		for (const p of r.publications)
			h +=
				wrappedLines(
					`${p.title} | ${p.venue}${p.note ? ` (${p.note})` : ""}${p.url ? ` | ${p.url}` : ""} | ${p.year}`,
					cpl,
				) * lh;
	}
	if (r.education.length) {
		h += sectionPt + r.education.length * lh;
		if (classic)
			for (const e of r.education)
				if (e.coursework?.length)
					h +=
						wrappedLines(
							`Relevant Coursework: ${e.coursework.join(", ")}`,
							cpl,
						) * lh;
	}
	if (r.certifications?.length) h += sectionPt + r.certifications.length * lh;
	return h;
}

function overflowLines(
	heightPt: number,
	target: 1 | 2,
	d: Density,
	paper: Paper,
	theme: ThemeName = "standard",
): number {
	const pagePt = contentBox(d, paper, theme).heightIn * PT_PER_IN;
	return Math.max(
		1,
		Math.ceil((heightPt - target * pagePt) / lineHeightPt(d, theme)),
	);
}

export function estimateFit(r: TailoredResume, target: 1 | 2): FitResult {
	const paper = r.layout?.paper ?? "letter";
	let last: FitResult = { density: 3, pages: 1 };
	for (const d of DENSITIES) {
		const h = estimateHeightPt(r, d);
		const pagePt = contentBox(d, paper, themeOf(r)).heightIn * PT_PER_IN;
		const pages = Math.max(1, Math.ceil(h / pagePt));
		last = { density: d, pages };
		if (pages <= target) return last;
	}
	return {
		...last,
		overflow_lines: overflowLines(
			estimateHeightPt(r, 3),
			target,
			3,
			paper,
			themeOf(r),
		),
	};
}

const MEASURE_SCRIPT = `<script>document.documentElement.setAttribute("data-jh-height",String(document.querySelector("main").getBoundingClientRect().height));</script>`;

/** Render at print width in Chrome and report the content height in pt. */
async function measureHeightPt(
	r: TailoredResume,
	d: Density,
): Promise<number | null> {
	const box = contentBox(d, r.layout?.paper ?? "letter", themeOf(r));
	const html = renderHtml(r, { density: d }).replace(
		"</body>",
		`<style>@media screen{main{max-width:none;width:${box.widthIn}in;padding:0}}</style>${MEASURE_SCRIPT}</body>`,
	);
	const run = await withHtmlFile(html, (url) =>
		runChrome((profile) => dumpDomArgs(profile, url)),
	);
	const m = /data-jh-height="([\d.]+)"/.exec(run.stdout);
	return m ? (Number(m[1]) / PX_PER_IN) * PT_PER_IN : null;
}

async function pdfAtDensity(
	r: TailoredResume,
	d: Density,
	workDir: string,
): Promise<{ pages: number; pdf: Buffer }> {
	const out = join(workDir, `fit-${d}.pdf`);
	const { pages } = await renderPdf(renderHtml(r, { density: d }), out);
	return { pages, pdf: readFileSync(out) };
}

async function chromeFit(
	r: TailoredResume,
	target: 1 | 2,
): Promise<FitOutcome> {
	const work = mkdtempSync(join(tmpdir(), "jh-fit-"));
	try {
		let last: { pages: number; pdf: Buffer } | null = null;
		for (const d of DENSITIES) {
			last = await pdfAtDensity(r, d, work);
			if (last.pages <= target)
				return { density: d, pages: last.pages, pdf: last.pdf, measured: true };
		}
		if (!last) throw new Error("no density steps");
		const measured = await measureHeightPt(r, 3).catch(() => null);
		const paper = r.layout?.paper ?? "letter";
		const overflow =
			measured === null
				? overflowLines(estimateHeightPt(r, 3), target, 3, paper, themeOf(r))
				: overflowLines(measured, target, 3, paper, themeOf(r));
		return {
			density: 3,
			pages: last.pages,
			pdf: last.pdf,
			measured: true,
			overflow_lines: overflow,
		};
	} finally {
		removeQuietly(work);
	}
}

async function fitResume(
	r: TailoredResume,
	target: 1 | 2,
): Promise<FitOutcome> {
	if (findChrome()) {
		try {
			return await chromeFit(r, target);
		} catch {
			// fall through to the estimate; renderAll reports the PDF failure separately
		}
	}
	return { ...estimateFit(r, target), measured: false };
}

/**
 * Step density 0..3 until the resume fits `target` pages. Uses Chrome when
 * available, otherwise a deterministic estimate. When nothing fits, density
 * is 3 and `overflow_lines` says how many lines must go.
 */
export async function fitPages(
	r: TailoredResume,
	target: 1 | 2,
): Promise<FitResult> {
	const { density, pages, overflow_lines } = await fitResume(r, target);
	return overflow_lines === undefined
		? { density, pages }
		: { density, pages, overflow_lines };
}

function asciiWord(s: string): string {
	return s
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^A-Za-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
}

/** "Jane Q. Doe" at "Acme, Inc." -> "Jane_Q_Doe_<kind>_Acme_Inc" */
export function artifactBaseName(
	name: string,
	kind: string,
	company: string,
): string {
	const parts = [asciiWord(name) || "Candidate", kind, asciiWord(company)];
	return parts.filter(Boolean).join("_");
}

export function resumeBaseName(r: TailoredResume): string {
	return artifactBaseName(r.basics.name, "Resume", r.job.company);
}

async function writePdf(
	r: TailoredResume,
	d: Density,
	path: string,
	fitted: Buffer | undefined,
): Promise<{ pages: number }> {
	if (fitted) {
		writeFileSync(path, fitted);
		return { pages: countPdfPages(fitted) };
	}
	return renderPdf(renderHtml(r, { density: d }), path);
}

/**
 * Write the requested formats as `First_Last_Resume_<Company>.<ext>`.
 * Density comes from `opts.density`, else from fitting to `layout.pages`.
 * A PDF failure becomes a warning; the other formats are still written.
 */
export async function renderAll(
	r: TailoredResume,
	outDir: string,
	formats: Format[],
	opts: { density?: Density } = {},
): Promise<RenderResult> {
	mkdirSync(outDir, { recursive: true });
	const base = join(outDir, resumeBaseName(r));
	const target = r.layout?.pages ?? 2;
	const warnings: string[] = [];
	const want = new Set(formats);
	const fit: FitOutcome =
		opts.density !== undefined
			? { density: opts.density, pages: 0, measured: false }
			: want.has("pdf")
				? await fitResume(r, target)
				: { ...estimateFit(r, target), measured: false };
	const result: RenderResult = {
		files: {},
		pages: null,
		density: fit.density,
		warnings,
	};
	if (want.has("pdf")) {
		const path = `${base}.pdf`;
		try {
			result.pages = (await writePdf(r, fit.density, path, fit.pdf)).pages;
			result.files.pdf = path;
			result.pdf_text_ok = pdfHasText(readFileSync(path));
			if (!result.pdf_text_ok) warnings.push("pdf_no_text_layer");
		} catch (e) {
			warnings.push(`pdf_failed: ${(e as Error).message}`);
		}
	}
	if (fit.overflow_lines !== undefined) {
		result.overflow_lines = fit.overflow_lines;
		warnings.push(
			`overflow: about ${fit.overflow_lines} line(s) over ${target} page(s) at the tightest density`,
		);
	} else if (result.pages !== null && result.pages > target) {
		warnings.push(
			`overflow: ${result.pages} pages for a ${target}-page target`,
		);
	}
	if (want.has("html")) {
		result.files.html = `${base}.html`;
		writeFileSync(
			result.files.html,
			renderHtml(r, { density: fit.density }),
			"utf8",
		);
	}
	if (want.has("txt")) {
		result.files.txt = `${base}.txt`;
		writeFileSync(result.files.txt, renderText(r), "utf8");
	}
	if (want.has("docx")) {
		result.files.docx = `${base}.docx`;
		writeFileSync(
			result.files.docx,
			await renderDocx(r, { density: fit.density }),
		);
	}
	return result;
}
