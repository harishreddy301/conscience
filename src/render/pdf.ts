import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { constants, inflateSync } from "node:zlib";
import { printToPdfArgs, removeQuietly, runChrome } from "./chrome.js";

/** Write `html` to a temp file and hand its file:// URL to `fn`. */
export async function withHtmlFile<T>(
	html: string,
	fn: (url: string) => Promise<T>,
): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "jh-html-"));
	const file = join(dir, "page.html");
	writeFileSync(file, html, "utf8");
	try {
		return await fn(pathToFileURL(file).href);
	} finally {
		removeQuietly(dir);
	}
}

/** Print HTML to PDF with headless Chrome (throwaway profile, 30s timeout). */
export async function renderPdf(
	html: string,
	outPdf: string,
): Promise<{ pages: number }> {
	const out = resolve(outPdf);
	mkdirSync(dirname(out), { recursive: true });
	rmSync(out, { force: true });
	const run = await withHtmlFile(html, (url) =>
		runChrome((profile) => printToPdfArgs(profile, url, out)),
	);
	if (!existsSync(out) || statSync(out).size === 0) {
		const tail = run.stderr.trim().split(/\r?\n/).slice(-3).join(" ");
		throw new Error(
			`Chrome did not write a PDF (exit ${run.code})${tail ? `: ${tail}` : ""}`,
		);
	}
	return { pages: countPdfPages(readFileSync(out)) };
}

/** Number of page objects (`/Type /Page`, not `/Pages`); falls back to the largest `/Count`. */
export function countPdfPages(buf: Buffer): number {
	const s = buf.toString("latin1");
	const pages = s.match(/\/Type\s*\/Page(?![A-Za-z])/g)?.length ?? 0;
	if (pages > 0) return pages;
	let max = 0;
	for (const m of s.matchAll(/\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)/g)) {
		max = Math.max(max, Number(m[1]));
	}
	return max;
}

interface PdfStream {
	dict: string;
	data: Buffer;
}

/** Every `stream ... endstream` body with its preceding dictionary text. */
export function pdfStreams(buf: Buffer): PdfStream[] {
	const s = buf.toString("latin1");
	const out: PdfStream[] = [];
	const re = /stream\r?\n/g;
	let m: RegExpExecArray | null = re.exec(s);
	while (m) {
		const start = m.index + m[0].length;
		const end = s.indexOf("endstream", start);
		if (end < 0) break;
		const dictStart = s.lastIndexOf("<<", m.index);
		out.push({
			dict: dictStart >= 0 ? s.slice(dictStart, m.index) : "",
			data: buf.subarray(start, end),
		});
		re.lastIndex = end + "endstream".length;
		m = re.exec(s);
	}
	return out;
}

function decodeStream(st: PdfStream): string | null {
	if (!/\/Filter\s*(\[\s*)?\/FlateDecode/.test(st.dict)) {
		return /\/Filter/.test(st.dict) ? null : st.data.toString("latin1");
	}
	try {
		return inflateSync(st.data).toString("latin1");
	} catch {
		try {
			return inflateSync(st.data, {
				finishFlush: constants.Z_SYNC_FLUSH,
			}).toString("latin1");
		} catch {
			return null;
		}
	}
}

/** True when some content stream draws text (Tj/TJ), i.e. the PDF has a selectable text layer. */
export function pdfHasText(buf: Buffer): boolean {
	for (const st of pdfStreams(buf)) {
		const body = decodeStream(st);
		if (body && /(\)|>|\])\s*T[jJ]\b/.test(body)) return true;
	}
	return false;
}
