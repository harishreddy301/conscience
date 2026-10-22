/**
 * Deterministic ATS parse checks on rendered output. Each returned string is
 * one failure; the code comes first, optionally followed by ":<detail>".
 */

export interface Rendered {
	html: string;
	text: string;
	docxXml?: string;
}

export const STANDARD_HEADINGS: ReadonlySet<string> = new Set([
	"summary",
	"professional summary",
	"profile",
	"skills",
	"technical skills",
	"core skills",
	"core competencies",
	"experience",
	"professional experience",
	"work experience",
	"employment history",
	"relevant experience",
	"education",
	"certifications",
	"certificates",
	"licenses and certifications",
	"certifications and licenses",
	"projects",
	"selected projects",
	"publications",
	"awards",
	"honors and awards",
	"volunteer experience",
	"languages",
	"additional information",
]);

const EXPERIENCE_HEADINGS = new Set([
	"experience",
	"professional experience",
	"work experience",
	"employment history",
	"relevant experience",
]);

const BAD_DATE_PATTERNS: readonly RegExp[] = [
	/\b(?:0?[1-9]|1[0-2])\/(?:\d{4}|\d{2})\b/g, // 01/2020, 1/20
	/\b\d{4}[/-](?:0[1-9]|1[0-2])\b/g, // 2020-01, 2020/01
	/(?:^|[\s(])['’]\d{2}\b/g, // '19
	/\b(?:spring|summer|fall|autumn|winter)\s+\d{4}\b/gi, // Fall 2020
	/\b\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{4}\b/gi, // 3 Jan 2020
];

const FANCY_GLYPHS = /[➢➤►▶✓✔★☆◆◇■□●○❖✦✪→⇒]/u;

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
	return decodeEntities(s.replace(/<[^>]*>/g, " "))
		.replace(/\s+/g, " ")
		.trim();
}

function normHeading(s: string): string {
	return s
		.toLowerCase()
		.replace(/&/g, " and ")
		.replace(/[^a-z ]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

/** Text of every <h2> in the HTML. */
export function htmlHeadings(html: string): string[] {
	return [...html.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) =>
		stripTags(m[1] ?? ""),
	);
}

/** Text of every Heading1 paragraph in a DOCX word/document.xml. */
export function docxHeadings(xml: string): string[] {
	const out: string[] = [];
	for (const m of xml.matchAll(/<w:p\b[\s\S]*?<\/w:p>/g)) {
		const p = m[0];
		if (!/<w:pStyle\s+w:val="Heading1"/.test(p)) continue;
		const text = [...p.matchAll(/<w:t\b[^>]*>([^<]*)<\/w:t>/g)]
			.map((t) => decodeEntities(t[1] ?? ""))
			.join("");
		out.push(text.trim());
	}
	return out;
}

/** Strip <style>/<script> then return CSS text from style blocks and attributes. */
function cssOf(html: string): string {
	const blocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(
		(m) => m[1] ?? "",
	);
	const attrs = [...html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map(
		(m) => m[1] ?? "",
	);
	return [...blocks, ...attrs].join("\n");
}

export function checkStructure(r: Rendered): string[] {
	const out: string[] = [];
	if (/<table\b/i.test(r.html) || /<w:tbl\b/.test(r.docxXml ?? ""))
		out.push("TABLE");
	if (
		/<(?:img|svg|picture|canvas|object|embed)\b/i.test(r.html) ||
		/<w:drawing\b|<w:pict\b/.test(r.docxXml ?? "")
	)
		out.push("IMAGE");
	const css = cssOf(r.html);
	const docxCols = /<w:cols\b[^>]*w:num="([2-9])"/.test(r.docxXml ?? "");
	if (
		/column-count\s*:|(?:^|[;{\s])columns\s*:|grid-template-columns\s*:/i.test(
			css,
		) ||
		docxCols
	)
		out.push("COLUMNS");
	if (/<w:txbxContent\b|<v:textbox\b/.test(r.docxXml ?? ""))
		out.push("TEXTBOX");
	const h1s = (r.html.match(/<h1\b/gi) ?? []).length;
	if (h1s !== 1) out.push(`NAME_NOT_SINGLE_H1:${h1s}`);
	return out;
}

export function checkHeadings(r: Rendered): string[] {
	const headings = [
		...htmlHeadings(r.html),
		...(r.docxXml ? docxHeadings(r.docxXml) : []),
	];
	const out = new Set<string>();
	for (const h of headings) {
		if (!STANDARD_HEADINGS.has(normHeading(h)))
			out.add(`NONSTANDARD_HEADING:${h}`);
	}
	if (!headings.some((h) => EXPERIENCE_HEADINGS.has(normHeading(h))))
		out.add("MISSING_EXPERIENCE_HEADING");
	return [...out];
}

export function checkDates(text: string): string[] {
	const out = new Set<string>();
	for (const re of BAD_DATE_PATTERNS) {
		for (const m of text.matchAll(re))
			out.add(`BAD_DATE_FORMAT:${m[0].trim()}`);
	}
	return [...out];
}

export function checkText(text: string): string[] {
	const out: string[] = [];
	if (text.replace(/\s+/g, "").length < 200) out.push("TEXT_TOO_SHORT");
	if (!/[\w.+-]+@[\w-]+\.[\w.-]+/.test(text)) out.push("NO_EMAIL_IN_TEXT");
	if (FANCY_GLYPHS.test(text)) out.push("NONSTANDARD_GLYPH");
	return out;
}

/** All parse failure codes for a rendered resume (empty = clean). */
export function parseChecks(rendered: Rendered): string[] {
	return [
		...checkStructure(rendered),
		...checkHeadings(rendered),
		...checkDates(rendered.text),
		...checkText(rendered.text),
	];
}
