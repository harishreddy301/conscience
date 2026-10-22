import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { register } from "../../src/commands/me.js";
import { ValidationError } from "../../src/core/errors.js";
import {
	decodeXml,
	docxXmlToText,
	extractDocxText,
	extractSampleResumes,
	readZipEntry,
	zipEntries,
} from "../../src/me/extract.js";
import {
	runCli,
	type TempWorkspace,
	tempWorkspace,
} from "../fixtures/me/helpers.js";

interface Entry {
	name: string;
	data: string;
	store?: boolean;
}

/** Minimal zip writer (local headers + central directory + EOCD) so no binary fixture is committed. */
function buildZip(entries: Entry[]): Buffer {
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;
	for (const e of entries) {
		const raw = Buffer.from(e.data, "utf8");
		const body = e.store ? raw : deflateRawSync(raw);
		const name = Buffer.from(e.name, "utf8");
		const method = e.store ? 0 : 8;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(method, 8);
		local.writeUInt32LE(crc32(raw), 14);
		local.writeUInt32LE(body.length, 18);
		local.writeUInt32LE(raw.length, 22);
		local.writeUInt16LE(name.length, 26);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(method, 10);
		central.writeUInt32LE(crc32(raw), 16);
		central.writeUInt32LE(body.length, 20);
		central.writeUInt32LE(raw.length, 24);
		central.writeUInt16LE(name.length, 28);
		central.writeUInt32LE(offset, 42);
		locals.push(local, name, body);
		centrals.push(central, name);
		offset += local.length + name.length + body.length;
	}
	const cd = Buffer.concat(centrals);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(cd.length, 12);
	eocd.writeUInt32LE(offset, 16);
	return Buffer.concat([...locals, cd, eocd]);
}

const DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t>Jordan Rivera</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Data Engineer, </w:t></w:r><w:r><w:t>Acme &amp; Co</w:t></w:r><w:r><w:tab/><w:t>Mar 2022 &#8211; Present</w:t></w:r></w:p>
<w:p><w:r><w:t>Cut run time from 6 hours to 40 minutes.</w:t><w:br/><w:t>Second line</w:t></w:r></w:p>
</w:body></w:document>`;

function tinyDocx(store = false): Buffer {
	return buildZip([
		{ name: "[Content_Types].xml", data: "<Types/>", store: true },
		{ name: "word/document.xml", data: DOCUMENT_XML, store },
	]);
}

const EXPECTED =
	"Jordan Rivera\nData Engineer, Acme & Co\tMar 2022 – Present\nCut run time from 6 hours to 40 minutes.\nSecond line";

let ws: TempWorkspace;
beforeEach(() => {
	ws = tempWorkspace();
});
afterEach(() => ws.cleanup());

describe("docx extraction", () => {
	it("a tiny docx built with zlib extracts its paragraph text", () => {
		expect(extractDocxText(tinyDocx())).toBe(EXPECTED);
	});

	it("reads stored (uncompressed) entries too", () => {
		expect(extractDocxText(tinyDocx(true))).toBe(EXPECTED);
		expect(zipEntries(tinyDocx()).map((e) => e.name)).toEqual([
			"[Content_Types].xml",
			"word/document.xml",
		]);
	});

	it("rejects non-zip input and missing entries", () => {
		expect(() =>
			extractDocxText(Buffer.from("not a zip at all, definitely not")),
		).toThrow(ValidationError);
		expect(() =>
			readZipEntry(
				buildZip([{ name: "a.txt", data: "x" }]),
				"word/document.xml",
			),
		).toThrow(/not found/);
	});

	it("decodes XML entities and ignores empty paragraphs", () => {
		expect(decodeXml("&lt;a&gt; &quot;b&quot; &#x41;&#66; &apos;")).toBe(
			'<a> "b" AB \'',
		);
		expect(
			docxXmlToText("<w:p></w:p><w:p><w:r><w:t>x</w:t></w:r></w:p><w:p/>"),
		).toBe("x");
	});
});

describe("extractSampleResumes", () => {
	it("writes DOCX and MD text to .cache/text, skips PDFs and _examples", async () => {
		mkdirSync(ws.paths.sampleResumeDir, { recursive: true });
		writeFileSync(join(ws.paths.sampleResumeDir, "resume.docx"), tinyDocx());
		writeFileSync(join(ws.paths.sampleResumeDir, "resume.md"), "﻿# Jordan\n");
		writeFileSync(join(ws.paths.sampleResumeDir, "resume.pdf"), "%PDF-1.4");
		writeFileSync(
			join(ws.paths.sampleResumeDir, "_example-sample-resume.md"),
			"fictional",
		);
		writeFileSync(join(ws.paths.sampleResumeDir, "broken.docx"), "nope");
		const r = extractSampleResumes(ws.paths);
		expect(r.written.map((w) => w.source)).toEqual([
			"sample-resume/resume.docx",
			"sample-resume/resume.md",
		]);
		expect(
			readFileSync(join(ws.paths.cacheDir, "text", "resume.docx.txt"), "utf8"),
		).toBe(`${EXPECTED}\n`);
		expect(
			readFileSync(join(ws.paths.cacheDir, "text", "resume.md.txt"), "utf8"),
		).toBe("# Jordan\n\n");
		expect(r.skipped.map((s) => s.source)).toEqual([
			"sample-resume/broken.docx",
			"sample-resume/resume.pdf",
		]);
		expect(r.skipped[1]?.reason).toMatch(/Read tool/);
		expect(
			existsSync(
				join(ws.paths.cacheDir, "text", "_example-sample-resume.md.txt"),
			),
		).toBe(false);

		const run = await runCli(register, ["me", "extract", "--json"]);
		expect(run.exitCode).toBe(0);
		expect((run.json() as { written: unknown[] }).written).toHaveLength(2);
	});

	it("returns an empty result when sample-resume/ does not exist", () => {
		expect(extractSampleResumes(ws.paths)).toMatchObject({
			written: [],
			skipped: [],
		});
	});
});
