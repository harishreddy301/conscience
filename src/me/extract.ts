import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { ValidationError } from "../core/errors.js";
import { ensureDir, type MePaths, mePaths } from "../core/paths.js";
import { isUserContent } from "./init.js";
import { writeFileAtomic } from "./load.js";

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;

interface ZipEntry {
	name: string;
	method: number;
	compressedSize: number;
	localOffset: number;
}

function findEocd(buf: Buffer): number {
	const min = Math.max(0, buf.length - 22 - 0xffff);
	for (let i = buf.length - 22; i >= min; i--)
		if (buf.readUInt32LE(i) === EOCD_SIG) return i;
	throw new ValidationError(
		"not a zip file (no end-of-central-directory record)",
	);
}

/** List the central directory of a (non-zip64) zip archive. */
export function zipEntries(buf: Buffer): ZipEntry[] {
	const eocd = findEocd(buf);
	const count = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	const out: ZipEntry[] = [];
	for (let i = 0; i < count; i++) {
		if (p + 46 > buf.length || buf.readUInt32LE(p) !== CENTRAL_SIG)
			throw new ValidationError("corrupt zip central directory");
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		out.push({
			method: buf.readUInt16LE(p + 10),
			compressedSize: buf.readUInt32LE(p + 20),
			localOffset: buf.readUInt32LE(p + 42),
			name: buf.toString("utf8", p + 46, p + 46 + nameLen),
		});
		p += 46 + nameLen + extraLen + commentLen;
	}
	return out;
}

/** Read one entry's bytes (stored or deflated). */
export function readZipEntry(buf: Buffer, name: string): Buffer {
	const e = zipEntries(buf).find((x) => x.name === name);
	if (!e) throw new ValidationError(`zip entry not found: ${name}`);
	if (buf.readUInt32LE(e.localOffset) !== LOCAL_SIG)
		throw new ValidationError("corrupt zip local header");
	const start =
		e.localOffset +
		30 +
		buf.readUInt16LE(e.localOffset + 26) +
		buf.readUInt16LE(e.localOffset + 28);
	const data = buf.subarray(start, start + e.compressedSize);
	if (e.method === 0) return Buffer.from(data);
	if (e.method === 8)
		return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
	throw new ValidationError(`unsupported zip compression method ${e.method}`);
}

const ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
};

export function decodeXml(s: string): string {
	return s.replace(
		/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
		(_, ent: string) => {
			if (ent[0] === "#")
				return String.fromCodePoint(
					ent[1]?.toLowerCase() === "x"
						? Number.parseInt(ent.slice(2), 16)
						: Number(ent.slice(1)),
				);
			return ENTITIES[ent.toLowerCase()] ?? "";
		},
	);
}

/** Plain text of one <w:p> paragraph: runs, tabs and line breaks. */
function paragraphText(xml: string): string {
	let out = "";
	for (const m of xml.matchAll(
		/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:(?:br|cr)\s*\/>/g,
	)) {
		if (m[1] !== undefined) out += decodeXml(m[1]);
		else if (m[0].startsWith("<w:tab")) out += "\t";
		else out += "\n";
	}
	return out;
}

/** Paragraph text of word/document.xml, one paragraph per line. */
export function docxXmlToText(xml: string): string {
	const paragraphs = xml.match(/<w:p[\s>][\s\S]*?<\/w:p>/g) ?? [];
	return paragraphs
		.map(paragraphText)
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function extractDocxText(buf: Buffer): string {
	return docxXmlToText(readZipEntry(buf, "word/document.xml").toString("utf8"));
}

export interface ExtractResult {
	outDir: string;
	written: { source: string; out: string; chars: number }[];
	skipped: { source: string; reason: string }[];
}

function textOf(file: string): { text: string } | { reason: string } {
	const ext = extname(file).toLowerCase();
	if (ext === ".docx") return { text: extractDocxText(readFileSync(file)) };
	if (ext === ".md" || ext === ".txt")
		return { text: readFileSync(file, "utf8").replace(/^﻿/, "") };
	if (ext === ".pdf")
		return {
			reason:
				"PDF: resume-intake reads it directly with the Read tool (pages parameter)",
		};
	return { reason: `unsupported file type ${ext || "(none)"}` };
}

/** Write me/.cache/text/<file name>.txt (e.g. resume.docx.txt) for every DOCX/MD/TXT in me/sample-resume/. */
export function extractSampleResumes(
	paths: MePaths = mePaths(),
): ExtractResult {
	const outDir = ensureDir(join(paths.cacheDir, "text"));
	const result: ExtractResult = { outDir, written: [], skipped: [] };
	let names: string[] = [];
	try {
		names = readdirSync(paths.sampleResumeDir).sort();
	} catch {
		return result;
	}
	for (const name of names) {
		const file = join(paths.sampleResumeDir, name);
		if (!statSync(file).isFile() || !isUserContent(name)) continue;
		const source = `sample-resume/${name}`;
		try {
			const r = textOf(file);
			if ("reason" in r) {
				result.skipped.push({ source, reason: r.reason });
				continue;
			}
			const out = join(outDir, `${name}.txt`);
			writeFileAtomic(out, `${r.text}\n`);
			result.written.push({ source, out, chars: r.text.length });
		} catch (e) {
			result.skipped.push({ source, reason: (e as Error).message });
		}
	}
	return result;
}
