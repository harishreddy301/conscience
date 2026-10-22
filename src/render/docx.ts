import { inflateRawSync } from "node:zlib";
import {
	AlignmentType,
	BorderStyle,
	Document,
	ExternalHyperlink,
	HeadingLevel,
	LevelFormat,
	LineRuleType,
	Packer,
	Paragraph,
	type ParagraphChild,
	TabStopType,
	TextRun,
} from "docx";
import { shownTitle, type TailoredResume } from "../resume/schema.js";
import { splitEmphasis } from "./emphasis.js";
import {
	certificationLine,
	classicPubTail,
	contactItems,
	documentTitle,
	educationLine,
	formatRange,
	headlineTerms,
	publicationLine,
	themeRange,
} from "./html.js";
import {
	accentHex,
	CLASSIC_GRAY,
	CLASSIC_NAVY,
	CRIMSON,
	type Density,
	densitySpec,
	type Paper,
	paperSize,
	SECTION_ORDER,
	SECTION_TITLES,
	type SectionKey,
	type ThemeName,
	themeOf,
} from "./theme.js";

type Role = TailoredResume["experience"][number];
type Basics = TailoredResume["basics"];

const NAVY_HEX = "1F3A5F";
const FONT = "Calibri";
const TWIP_PER_IN = 1440;
export const BULLET_REF = "resume-bullets";
/** Small square markers (publications/certifications in classic-navy). */
export const SQUARE_REF = "resume-squares";
/** docx sizes are half-points. */
const halfPt = (pt: number): number => Math.round(pt * 2);
/**
 * Word sizes come in half points only; round DOWN (9.75pt -> 9.5pt) so a line
 * that fits the PDF never wraps in Word.
 */
export const docxHalfPt = (pt: number): number => Math.floor(pt * 2);

interface PageGeometry {
	width: number;
	height: number;
	marginX: number;
	marginY: number;
	/** right tab stop at the right margin */
	contentWidth: number;
}

export function pageGeometry(
	paper: Paper,
	density: Density = 0,
	theme: ThemeName = "standard",
): PageGeometry {
	const size = paperSize(paper);
	const spec = densitySpec(density, theme);
	const width = Math.round(size.widthIn * TWIP_PER_IN);
	const marginX = Math.round(spec.marginXIn * TWIP_PER_IN);
	return {
		width,
		height: Math.round(size.heightIn * TWIP_PER_IN),
		marginX,
		marginY: Math.round(spec.marginYIn * TWIP_PER_IN),
		contentWidth: width - 2 * marginX,
	};
}

function sectionHeading(title: string): Paragraph {
	return new Paragraph({
		text: title.toUpperCase(),
		heading: HeadingLevel.HEADING_1,
	});
}

export function contactParagraphs(
	b: Basics,
	withHeadline = true,
	accent: string = NAVY_HEX,
): Paragraph[] {
	const out: Paragraph[] = [
		new Paragraph({
			children: [
				new TextRun({ text: b.name, bold: true, size: 44, color: accent }),
			],
			spacing: { after: 40 },
		}),
	];
	if (withHeadline && b.headline)
		out.push(
			new Paragraph({
				children: [new TextRun({ text: b.headline, size: halfPt(11.2) })],
				spacing: { after: 40 },
			}),
		);
	const runs: ParagraphChild[] = [];
	contactItems(b).forEach((c, i) => {
		if (i > 0) runs.push(new TextRun({ text: "  |  ", color: "666666" }));
		runs.push(
			c.href
				? new ExternalHyperlink({
						link: c.href,
						children: [new TextRun({ text: c.text, color: accent })],
					})
				: new TextRun(c.text),
		);
	});
	out.push(new Paragraph({ children: runs, spacing: { after: 60 } }));
	return out;
}

function headLine(
	left: ParagraphChild[],
	right: string,
	geo: PageGeometry,
	spaceBefore: number,
): Paragraph {
	return new Paragraph({
		tabStops: [{ type: TabStopType.RIGHT, position: geo.contentWidth }],
		keepNext: true,
		spacing: { before: spaceBefore, after: 20 },
		children: [...left, new TextRun({ text: `\t${right}` })],
	});
}

function emphasisRuns(text: string, phrases?: readonly string[]): TextRun[] {
	return splitEmphasis(text, phrases).map(
		(s) => new TextRun({ text: s.text, bold: s.bold }),
	);
}

function bullet(
	text: string,
	emphasis?: readonly string[],
	justify = false,
): Paragraph {
	return new Paragraph({
		children: emphasisRuns(text, emphasis),
		...(justify ? { alignment: AlignmentType.JUSTIFIED } : {}),
		numbering: { reference: BULLET_REF, level: 0 },
		spacing: { after: 15 },
	});
}

function roleParagraphs(
	r: Role,
	geo: PageGeometry,
	first: boolean,
	justify = false,
): Paragraph[] {
	const left = [
		new TextRun({ text: shownTitle(r), bold: true }),
		new TextRun({ text: `  |  ${r.employer}` }),
	];
	if (r.location) left.push(new TextRun({ text: `  |  ${r.location}` }));
	return [
		headLine(left, formatRange(r.start, r.end), geo, first ? 40 : 120),
		...r.bullets.map((b) => bullet(b.text, b.emphasis, justify)),
	];
}

function bodyParagraphs(r: TailoredResume, geo: PageGeometry): Paragraph[] {
	const out: Paragraph[] = [];
	const justify = r.layout?.justify ?? false;
	if (r.summary.text.trim())
		out.push(
			sectionHeading("Summary"),
			new Paragraph({
				children: emphasisRuns(r.summary.text, r.summary.emphasis),
				...(justify ? { alignment: AlignmentType.JUSTIFIED } : {}),
			}),
			// Labeled highlights: the label is always a bold run.
			...(r.summary.highlights ?? []).map(
				(h) =>
					new Paragraph({
						children: [
							new TextRun({ text: `${h.label}: `, bold: true }),
							...emphasisRuns(h.text, h.emphasis),
						],
						...(justify ? { alignment: AlignmentType.JUSTIFIED } : {}),
						numbering: { reference: BULLET_REF, level: 0 },
						spacing: { after: 15 },
					}),
			),
		);
	if (r.skills.length) {
		out.push(sectionHeading("Skills"));
		for (const g of r.skills)
			out.push(
				new Paragraph({
					children: [
						new TextRun({ text: `${g.group}: `, bold: true }),
						new TextRun(g.items.join(", ")),
					],
				}),
			);
	}
	out.push(sectionHeading("Experience"));
	r.experience.forEach((role, i) => {
		out.push(...roleParagraphs(role, geo, i === 0, justify));
	});
	if (r.projects?.length) {
		out.push(sectionHeading("Projects"));
		r.projects.forEach((role, i) => {
			out.push(...roleParagraphs(role, geo, i === 0, justify));
		});
	}
	if (r.publications?.length) {
		out.push(sectionHeading("Publications"));
		for (const p of r.publications) {
			const l = publicationLine(p);
			out.push(
				headLine(
					[
						new TextRun(`${l.title}, `),
						new TextRun({ text: l.venue, italics: true }),
						...(l.href && l.link
							? [
									new TextRun({ text: "  |  ", color: "666666" }),
									new ExternalHyperlink({
										link: l.href,
										children: [
											new TextRun({
												text: l.link,
												color: accentHex(r.layout?.style),
											}),
										],
									}),
								]
							: []),
					],
					l.year,
					geo,
					20,
				),
			);
		}
	}
	if (r.education.length) {
		out.push(sectionHeading("Education"));
		for (const e of r.education) {
			const l = educationLine(e);
			out.push(
				headLine(
					[
						new TextRun({ text: l.main, bold: true }),
						new TextRun(`  |  ${l.school}`),
					],
					l.year,
					geo,
					20,
				),
			);
		}
	}
	if (r.certifications?.length) {
		out.push(sectionHeading("Certifications"));
		for (const c of r.certifications) {
			const l = certificationLine(c);
			out.push(headLine([new TextRun(l.main)], l.year, geo, 20));
		}
	}
	return out;
}

// ---------------------------------------------------------------- classic-navy

interface Palette {
	navy: string;
	crimson: string;
	gray: string;
}

function palette(
	style: TailoredResume["layout"]["style"] | undefined,
): Palette {
	return style === "mono"
		? { navy: "000000", crimson: "000000", gray: "000000" }
		: {
				navy: CLASSIC_NAVY.slice(1),
				crimson: CRIMSON.slice(1),
				gray: CLASSIC_GRAY.slice(1),
			};
}

export function classicHeaderParagraphs(
	b: Basics,
	pal: Palette,
	fontPt: number,
	withHeadline = true,
): Paragraph[] {
	const out: Paragraph[] = [
		new Paragraph({
			alignment: AlignmentType.CENTER,
			children: [
				new TextRun({
					text: b.name.toUpperCase(),
					bold: true,
					size: 42,
					color: pal.navy,
				}),
			],
			spacing: { after: 20, line: 240, lineRule: LineRuleType.AUTO },
		}),
	];
	if (withHeadline && b.headline) {
		const style = {
			bold: true,
			color: pal.crimson,
			size: docxHalfPt(fontPt + 1.2),
		};
		const runs: TextRun[] = [];
		headlineTerms(b.headline).forEach((t, i) => {
			if (i > 0) runs.push(new TextRun({ text: "  |  ", ...style }));
			runs.push(new TextRun({ text: t, ...style }));
		});
		out.push(
			new Paragraph({
				alignment: AlignmentType.CENTER,
				children: runs,
				spacing: { after: 20 },
			}),
		);
	}
	const runs: ParagraphChild[] = [];
	contactItems(b, "classic-navy").forEach((c, i) => {
		if (i > 0)
			runs.push(
				new TextRun({
					text: " | ",
					color: pal.gray,
					size: docxHalfPt(fontPt - 1.5),
				}),
			);
		runs.push(
			c.href
				? new ExternalHyperlink({
						link: c.href,
						children: [
							new TextRun({
								text: c.text,
								color: pal.gray,
								size: docxHalfPt(fontPt - 1.5),
							}),
						],
					})
				: new TextRun({
						text: c.text,
						color: pal.gray,
						size: docxHalfPt(fontPt - 1.5),
					}),
		);
	});
	out.push(
		new Paragraph({
			alignment: AlignmentType.CENTER,
			children: runs,
			spacing: { after: 40 },
		}),
	);
	return out;
}

function classicEmphasisRuns(
	text: string,
	phrases: readonly string[] | undefined,
): TextRun[] {
	return splitEmphasis(text, phrases).map(
		(s) => new TextRun({ text: s.text, bold: s.bold }),
	);
}

function rightTab(
	geo: PageGeometry,
	children: ParagraphChild[],
	spaceBefore: number,
	keepNext = true,
): Paragraph {
	return new Paragraph({
		tabStops: [{ type: TabStopType.RIGHT, position: geo.contentWidth }],
		keepNext,
		spacing: { before: spaceBefore, after: 0 },
		children,
	});
}

function classicRole(
	r: Role,
	geo: PageGeometry,
	pal: Palette,
	fontPt: number,
	first: boolean,
	justify: boolean,
): Paragraph[] {
	const out: Paragraph[] = [
		rightTab(
			geo,
			[
				new TextRun({ text: shownTitle(r), bold: true, color: pal.navy }),
				new TextRun({
					text: `\t${themeRange(r.start, r.end, "classic-navy")}`,
					bold: true,
					color: pal.gray,
				}),
			],
			first ? 40 : 100,
		),
		rightTab(
			geo,
			[
				new TextRun({ text: r.employer, italics: true }),
				...(r.location
					? [
							new TextRun({
								text: `\t${r.location}`,
								italics: true,
								color: pal.gray,
							}),
						]
					: []),
			],
			0,
		),
		...r.bullets.map(
			(b) =>
				new Paragraph({
					children: classicEmphasisRuns(b.text, b.emphasis),
					...(justify ? { alignment: AlignmentType.JUSTIFIED } : {}),
					numbering: { reference: BULLET_REF, level: 0 },
					spacing: { after: 10 },
				}),
		),
	];
	if (r.environment?.length)
		out.push(
			new Paragraph({
				indent: { left: 300 },
				spacing: { before: 10, after: 0 },
				children: [
					new TextRun({
						text: "Environment: ",
						bold: true,
						italics: true,
						color: pal.gray,
						size: docxHalfPt(fontPt - 0.8),
					}),
					new TextRun({
						text: r.environment.join(", "),
						italics: true,
						color: pal.gray,
						size: docxHalfPt(fontPt - 0.8),
					}),
				],
			}),
		);
	return out;
}

function classicBody(
	r: TailoredResume,
	geo: PageGeometry,
	fontPt: number,
): Paragraph[] {
	const pal = palette(r.layout?.style);
	const t = SECTION_TITLES["classic-navy"];
	const justify = r.layout?.justify ?? false;
	const squares = (children: ParagraphChild[]) =>
		new Paragraph({
			children,
			numbering: { reference: SQUARE_REF, level: 0 },
			spacing: { after: 20 },
		});
	const build: Record<SectionKey, () => Paragraph[]> = {
		summary: () => {
			if (!r.summary.text.trim()) return [];
			return [
				sectionHeading(t.summary),
				new Paragraph({
					children: classicEmphasisRuns(r.summary.text, r.summary.emphasis),
					...(justify ? { alignment: AlignmentType.JUSTIFIED } : {}),
					spacing: { after: 20 },
				}),
				...(r.summary.highlights ?? []).map(
					(h) =>
						new Paragraph({
							children: [
								new TextRun({ text: `${h.label}: `, bold: true }),
								...classicEmphasisRuns(h.text, h.emphasis),
							],
							...(justify ? { alignment: AlignmentType.JUSTIFIED } : {}),
							numbering: { reference: BULLET_REF, level: 0 },
							spacing: { after: 10 },
						}),
				),
			];
		},
		skills: () =>
			r.skills.length
				? [
						sectionHeading(t.skills),
						...r.skills.map(
							(g) =>
								new Paragraph({
									spacing: { after: 6 },
									children: [
										new TextRun({
											text: `${g.group}: `,
											bold: true,
											color: pal.navy,
										}),
										new TextRun(g.items.join(", ")),
									],
								}),
						),
					]
				: [],
		experience: () => [
			sectionHeading(t.experience),
			...r.experience.flatMap((role, i) =>
				classicRole(role, geo, pal, fontPt, i === 0, justify),
			),
		],
		projects: () =>
			r.projects?.length
				? [
						sectionHeading(t.projects),
						...r.projects.flatMap((role, i) =>
							classicRole(role, geo, pal, fontPt, i === 0, justify),
						),
					]
				: [],
		education: () =>
			r.education.length
				? [
						sectionHeading(t.education),
						...r.education.flatMap((e) => {
							const l = educationLine(e, "classic-navy");
							const out = [
								rightTab(
									geo,
									[
										new TextRun({ text: l.main, bold: true, color: pal.navy }),
										new TextRun({ text: "  |  ", color: pal.gray }),
										new TextRun(l.school),
										new TextRun(`\t${l.year}`),
									],
									20,
									l.coursework.length > 0,
								),
							];
							if (l.coursework.length)
								out.push(
									new Paragraph({
										children: [
											new TextRun({
												text: "Relevant Coursework: ",
												bold: true,
												italics: true,
												color: pal.gray,
												size: docxHalfPt(fontPt - 0.8),
											}),
											new TextRun({
												text: l.coursework.join(", "),
												italics: true,
												color: pal.gray,
												size: docxHalfPt(fontPt - 0.8),
											}),
										],
									}),
								);
							return out;
						}),
					]
				: [],
		publications: () =>
			r.publications?.length
				? [
						sectionHeading(t.publications),
						...r.publications.map((p) => {
							// One row: "Title, Venue Year", bold navy, the title linked.
							const l = publicationLine(p);
							const title = new TextRun({
								text: p.display_title ?? l.title,
								bold: true,
								color: pal.navy,
							});
							return squares([
								l.href
									? new ExternalHyperlink({ link: l.href, children: [title] })
									: title,
								new TextRun({
									text: `, ${classicPubTail(p)}`,
									bold: true,
									color: pal.navy,
								}),
							]);
						}),
					]
				: [],
		certifications: () =>
			r.certifications?.length
				? [
						sectionHeading(t.certifications),
						...r.certifications.map((c) => {
							const l = certificationLine(c);
							return squares([
								new TextRun({ text: l.main, bold: true, color: pal.navy }),
								...(l.year ? [new TextRun(`  |  ${l.year}`)] : []),
							]);
						}),
					]
				: [],
	};
	return SECTION_ORDER["classic-navy"].flatMap((k) => build[k]());
}

/** Shared document shell: styles, bullet numbering and page geometry. */
export function buildDocument(o: {
	title: string;
	creator: string;
	paper: Paper;
	children: Paragraph[];
	/** Same density the PDF was fitted at, so DOCX and PDF agree. */
	density?: Density;
	/** Accent color hex (no #); defaults to navy. */
	accent?: string;
	theme?: ThemeName;
	/** Square marker color (hex, no #) for SQUARE_REF lists. */
	squareColor?: string;
}): Document {
	const theme = o.theme ?? "standard";
	const classic = theme === "classic-navy";
	const accent = o.accent ?? NAVY_HEX;
	const geo = pageGeometry(o.paper, o.density ?? 0, theme);
	const spec = densitySpec(o.density ?? 0, theme);
	return new Document({
		title: o.title,
		creator: o.creator,
		styles: {
			default: {
				document: {
					run: {
						font: FONT,
						size: classic ? docxHalfPt(spec.fontPt) : halfPt(spec.fontPt),
					},
					paragraph: {
						// classic-navy: exact line pitch = the PDF's font size x line height,
						// so Word paginates like the PDF.
						spacing: classic
							? {
									line: Math.round(spec.fontPt * spec.lineHeight * 20),
									lineRule: LineRuleType.EXACT,
								}
							: { line: Math.round(240 * 1.08) },
					},
				},
				heading1: {
					run: {
						font: FONT,
						size: halfPt(classic ? spec.fontPt + 1.3 : 10.5),
						bold: true,
						color: accent,
						...(classic ? {} : { characterSpacing: 16 }),
					},
					paragraph: {
						spacing: classic
							? { before: 140, after: 50 }
							: { before: 180, after: 60 },
						keepNext: true,
						border: {
							bottom: {
								style: BorderStyle.SINGLE,
								size: 6,
								color: accent,
								space: 1,
							},
						},
					},
				},
			},
		},
		numbering: {
			config: [
				{
					reference: BULLET_REF,
					levels: [
						{
							level: 0,
							format: LevelFormat.BULLET,
							text: "•",
							alignment: AlignmentType.LEFT,
							style: {
								paragraph: { indent: { left: 300, hanging: 220 } },
								...(classic ? { run: { color: accent } } : {}),
							},
						},
					],
				},
				{
					reference: SQUARE_REF,
					levels: [
						{
							level: 0,
							format: LevelFormat.BULLET,
							text: "\u25AA",
							alignment: AlignmentType.LEFT,
							style: {
								paragraph: { indent: { left: 340, hanging: 240 } },
								run: { color: o.squareColor ?? accent },
							},
						},
					],
				},
			],
		},
		sections: [
			{
				properties: {
					page: {
						size: { width: geo.width, height: geo.height },
						margin: {
							top: geo.marginY,
							bottom: geo.marginY,
							left: geo.marginX,
							right: geo.marginX,
						},
					},
				},
				children: o.children,
			},
		],
	});
}

export async function renderDocx(
	r: TailoredResume,
	opts: { density?: Density } = {},
): Promise<Buffer> {
	const paper = r.layout?.paper ?? "letter";
	const density = opts.density ?? 0;
	const theme = themeOf(r);
	const geo = pageGeometry(paper, density, theme);
	if (theme === "classic-navy") {
		const pal = palette(r.layout?.style);
		const fontPt = densitySpec(density, theme).fontPt;
		const doc = buildDocument({
			title: documentTitle(r.basics.name, "Resume"),
			creator: r.basics.name,
			paper,
			density,
			theme,
			accent: pal.navy,
			squareColor: pal.crimson,
			children: [
				...classicHeaderParagraphs(r.basics, pal, fontPt),
				...classicBody(r, geo, fontPt),
			],
		});
		return Packer.toBuffer(doc);
	}
	const doc = buildDocument({
		title: documentTitle(r.basics.name, "Resume"),
		creator: r.basics.name,
		paper,
		density,
		accent: accentHex(r.layout?.style),
		children: [
			...contactParagraphs(r.basics, true, accentHex(r.layout?.style)),
			...bodyParagraphs(r, geo),
		],
	});
	return Packer.toBuffer(doc);
}

/** Read one entry from a zip archive (stored or deflated) via the central directory. */
export function readZipEntry(buf: Buffer, name: string): Buffer | null {
	const eocdSig = 0x06054b50;
	let eocd = -1;
	for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
		if (buf.readUInt32LE(i) === eocdSig) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) return null;
	const count = buf.readUInt16LE(eocd + 10);
	let p = buf.readUInt32LE(eocd + 16);
	for (let n = 0; n < count; n++) {
		if (buf.readUInt32LE(p) !== 0x02014b50) return null;
		const method = buf.readUInt16LE(p + 10);
		const compSize = buf.readUInt32LE(p + 20);
		const nameLen = buf.readUInt16LE(p + 28);
		const extraLen = buf.readUInt16LE(p + 30);
		const commentLen = buf.readUInt16LE(p + 32);
		const localOff = buf.readUInt32LE(p + 42);
		const entryName = buf.toString("utf8", p + 46, p + 46 + nameLen);
		if (entryName === name) {
			const lNameLen = buf.readUInt16LE(localOff + 26);
			const lExtraLen = buf.readUInt16LE(localOff + 28);
			const start = localOff + 30 + lNameLen + lExtraLen;
			const data = buf.subarray(start, start + compSize);
			if (method === 0) return Buffer.from(data);
			if (method === 8) return inflateRawSync(data);
			return null;
		}
		p += 46 + nameLen + extraLen + commentLen;
	}
	return null;
}

/** word/document.xml of a DOCX buffer, for ATS parse checks. */
export function docxDocumentXml(buf: Buffer): string {
	const entry = readZipEntry(buf, "word/document.xml");
	if (!entry) throw new Error("not a DOCX: word/document.xml missing");
	return entry.toString("utf8");
}
