import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	ExternalHyperlink,
	Packer,
	Paragraph,
	type ParagraphChild,
	TextRun,
} from "docx";
import type { TailoredResume } from "../resume/schema.js";
import { BULLET_REF, buildDocument, contactParagraphs } from "./docx.js";
import type { RenderResult } from "./fit.js";
import {
	contactItems,
	documentTitle,
	escapeHtml,
	headerHtml,
	htmlDocument,
	safeHref,
} from "./html.js";
import { pdfHasText, renderPdf } from "./pdf.js";

type Basics = TailoredResume["basics"];
export type CoverFormat = "pdf" | "docx" | "txt";

export interface Inline {
	text: string;
	bold?: boolean;
	italic?: boolean;
	href?: string;
	/** a hard line break; `text` is empty */
	br?: boolean;
}
export type Block =
	| { kind: "p"; inlines: Inline[] }
	| { kind: "ul"; items: Inline[][] };

const INLINE_RE = /\*\*(.+?)\*\*|\*(.+?)\*|_(.+?)_|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Parse **bold**, *italic* or _italic_ and [text](url); everything else is literal. */
export function parseInline(s: string): Inline[] {
	const out: Inline[] = [];
	let last = 0;
	for (const m of s.matchAll(INLINE_RE)) {
		if (m.index > last) out.push({ text: s.slice(last, m.index) });
		if (m[1] !== undefined) out.push({ text: m[1], bold: true });
		else if (m[2] !== undefined || m[3] !== undefined)
			out.push({ text: (m[2] ?? m[3]) as string, italic: true });
		else {
			const href = safeHref(m[5] ?? "");
			const text = m[4] ?? "";
			out.push(href ? { text, href } : { text });
		}
		last = m.index + m[0].length;
	}
	if (last < s.length) out.push({ text: s.slice(last) });
	return out;
}

/** A sign-off or address block: a few short lines whose breaks are meaningful. */
function isLineBlock(lines: string[]): boolean {
	return (
		lines.length > 1 && lines.length <= 4 && lines.every((l) => l.length < 60)
	);
}

/** Join paragraph lines with spaces, keeping breaks for line blocks and markdown hard breaks. */
export function paragraphInlines(
	lines: { text: string; hard: boolean }[],
): Inline[] {
	const keepAll = isLineBlock(lines.map((l) => l.text));
	const out: Inline[] = [];
	lines.forEach((l, i) => {
		if (i > 0) {
			const prev = lines[i - 1];
			if (keepAll || prev?.hard) out.push({ text: "", br: true });
			else out.push({ text: " " });
		}
		out.push(...parseInline(l.text));
	});
	return out;
}

/**
 * Minimal markdown: blank-line paragraphs, "- "/"* " lists, "#" lines as bold
 * paragraphs. Short multi-line blocks (sign-offs) keep their line breaks.
 */
export function parseCoverMarkdown(md: string): Block[] {
	const blocks: Block[] = [];
	let para: { text: string; hard: boolean }[] = [];
	let list: Inline[][] | null = null;
	const flush = () => {
		if (para.length)
			blocks.push({ kind: "p", inlines: paragraphInlines(para) });
		if (list) blocks.push({ kind: "ul", items: list });
		para = [];
		list = null;
	};
	for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
		const line = raw.trim();
		const item = /^[-*+]\s+(.*)$/.exec(line);
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		if (!line) flush();
		else if (heading) {
			flush();
			blocks.push({
				kind: "p",
				inlines: [{ text: heading[1] ?? "", bold: true }],
			});
		} else if (item) {
			if (para.length) flush();
			list ??= [];
			list.push(parseInline(item[1] ?? ""));
		} else {
			if (list) flush();
			para.push({ text: line, hard: / {2,}$|\\$/.test(raw) });
		}
	}
	flush();
	return blocks;
}

export function letterDate(d: Date = new Date()): string {
	return d.toLocaleDateString("en-US", {
		year: "numeric",
		month: "long",
		day: "numeric",
	});
}

function inlineHtml(parts: Inline[]): string {
	return parts
		.map((p) => {
			if (p.br) return "<br>";
			let h = escapeHtml(p.text);
			if (p.bold) h = `<strong>${h}</strong>`;
			if (p.italic) h = `<em>${h}</em>`;
			return p.href ? `<a href="${escapeHtml(p.href)}">${h}</a>` : h;
		})
		.join("");
}

export function coverHtml(
	blocks: Block[],
	basics: Basics,
	date: string,
): string {
	const body = blocks
		.map((b) =>
			b.kind === "p"
				? `<p>${inlineHtml(b.inlines)}</p>`
				: `<ul>${b.items.map((i) => `<li>${inlineHtml(i)}</li>`).join("")}</ul>`,
		)
		.join("\n");
	return htmlDocument({
		title: documentTitle(basics.name, "Cover Letter"),
		body: `${headerHtml(basics, false)}<article class="letter"><p class="date">${escapeHtml(date)}</p>${body}</article>`,
		density: 0,
		paper: "letter",
	});
}

const plain = (parts: Inline[]): string =>
	parts
		.map((p) => {
			if (p.br) return "\n";
			return p.href && p.href !== p.text ? `${p.text} (${p.href})` : p.text;
		})
		.join("");

export function coverText(
	blocks: Block[],
	basics: Basics,
	date: string,
): string {
	const lines = [
		basics.name,
		contactItems(basics)
			.map((c) => c.text)
			.join(" | "),
		"",
		date,
	];
	for (const b of blocks) {
		lines.push("");
		if (b.kind === "p") lines.push(plain(b.inlines));
		else lines.push(...b.items.map((i) => `- ${plain(i)}`));
	}
	return `${lines.join("\n")}\n`;
}

function docxRuns(parts: Inline[]): ParagraphChild[] {
	return parts.map((p) => {
		if (p.br) return new TextRun({ break: 1 });
		const run = new TextRun({ text: p.text, bold: p.bold, italics: p.italic });
		return p.href
			? new ExternalHyperlink({ link: p.href, children: [run] })
			: run;
	});
}

export async function coverDocx(
	blocks: Block[],
	basics: Basics,
	date: string,
): Promise<Buffer> {
	const body: Paragraph[] = [
		new Paragraph({ text: date, spacing: { before: 200, after: 160 } }),
	];
	for (const b of blocks) {
		if (b.kind === "p")
			body.push(
				new Paragraph({
					children: docxRuns(b.inlines),
					spacing: { after: 160 },
				}),
			);
		else
			for (const i of b.items)
				body.push(
					new Paragraph({
						children: docxRuns(i),
						numbering: { reference: BULLET_REF, level: 0 },
						spacing: { after: 60 },
					}),
				);
	}
	const doc = buildDocument({
		title: documentTitle(basics.name, "Cover Letter"),
		creator: basics.name,
		paper: "letter",
		children: [...contactParagraphs(basics, false), ...body],
	});
	return Packer.toBuffer(doc);
}

/**
 * Render a cover letter in the resume theme as cover.{pdf,docx,txt} in `outDir`.
 * A PDF failure becomes a warning; the other formats are still written.
 */
export async function renderCover(
	md: string,
	basics: Basics,
	company: string,
	outDir: string,
	formats: CoverFormat[],
): Promise<RenderResult> {
	mkdirSync(outDir, { recursive: true });
	const blocks = parseCoverMarkdown(md);
	const date = letterDate();
	const want = new Set(formats);
	const warnings: string[] = [];
	const result: RenderResult = { files: {}, pages: null, density: 0, warnings };
	if (!blocks.length) warnings.push("cover_empty");
	if (company && !md.toLowerCase().includes(company.toLowerCase()))
		warnings.push(`cover_missing_company: "${company}" is not mentioned`);
	if (want.has("pdf")) {
		const path = join(outDir, "cover.pdf");
		try {
			result.pages = (
				await renderPdf(coverHtml(blocks, basics, date), path)
			).pages;
			result.files.pdf = path;
			result.pdf_text_ok = pdfHasText(readFileSync(path));
			if (result.pages > 1)
				warnings.push(`cover_pages: ${result.pages} (aim for 1)`);
		} catch (e) {
			warnings.push(`pdf_failed: ${(e as Error).message}`);
		}
	}
	if (want.has("docx")) {
		result.files.docx = join(outDir, "cover.docx");
		writeFileSync(result.files.docx, await coverDocx(blocks, basics, date));
	}
	if (want.has("txt")) {
		result.files.txt = join(outDir, "cover.txt");
		writeFileSync(result.files.txt, coverText(blocks, basics, date), "utf8");
	}
	return result;
}
