import { DEFAULT_THEME, type ThemeName } from "../resume/schema.js";

export { DEFAULT_THEME, type ThemeName };

/**
 * ATS-safe resume themes ("classic-navy" default, "standard"). One column, no tables, icons, images
 * or multi-column layout. Density-dependent values are CSS variables that
 * `densityCss()` sets, so one stylesheet serves every density step.
 */

export type Density = 0 | 1 | 2 | 3;
export type Paper = "letter" | "a4";

export const DENSITIES: readonly Density[] = [0, 1, 2, 3];

export const NAVY = "#1F3A5F";

export type ResumeStyle = "color" | "mono";

/** Accent color (hex without #) for DOCX output. */
export function accentHex(style: ResumeStyle = "color"): string {
	return style === "mono" ? "000000" : NAVY.slice(1);
}

/** Justified summary and bullets; the last line of each stays left-aligned. */
export const JUSTIFY_CSS = `
section.summary p,li{text-align:justify;text-justify:inter-word;hyphens:manual}
`;

/** Overrides that turn the theme into plain black on white. */
export const MONO_CSS = `
body{color:#000}
h1{color:#000;font-weight:700}
a{color:#000}
h2{color:#000;border-bottom-color:#000}
.contact .sep,.role-head .employer::before,.role-head .location::before,.edu-item .school::before{color:#000}
strong{color:#000}
`;
export const FONT_STACK = `Calibri, "Segoe UI", Arial, sans-serif`;

export interface DensitySpec {
	/** body font size in pt */
	fontPt: number;
	/** horizontal page margin in inches */
	marginXIn: number;
	/** vertical page margin in inches */
	marginYIn: number;
	lineHeight: number;
	/** space above each h2, in pt */
	sectionGapPt: number;
	/** space between roles, in pt */
	roleGapPt: number;
}

const SPECS: Record<Density, DensitySpec> = {
	0: {
		fontPt: 10.2,
		marginXIn: 0.6,
		marginYIn: 0.55,
		lineHeight: 1.28,
		sectionGapPt: 9,
		roleGapPt: 6,
	},
	1: {
		fontPt: 10,
		marginXIn: 0.55,
		marginYIn: 0.55,
		lineHeight: 1.25,
		sectionGapPt: 8,
		roleGapPt: 5,
	},
	2: {
		fontPt: 9.8,
		marginXIn: 0.5,
		marginYIn: 0.5,
		lineHeight: 1.22,
		sectionGapPt: 7,
		roleGapPt: 4,
	},
	3: {
		fontPt: 9.5,
		marginXIn: 0.5,
		marginYIn: 0.5,
		lineHeight: 1.2,
		sectionGapPt: 6,
		roleGapPt: 3,
	},
};

/**
 * classic-navy (the user's layout spec, 2026-10-21): Calibri 9.75pt and 0.5in
 * margins at every density. Density only tightens line height and gaps, so
 * fitting never changes the font size and the loosest step that fits the
 * target pages fills the last page best.
 */
const CLASSIC_SPECS: Record<Density, DensitySpec> = {
	0: {
		fontPt: 9.75,
		marginXIn: 0.5,
		marginYIn: 0.5,
		lineHeight: 1.3,
		sectionGapPt: 9,
		roleGapPt: 6,
	},
	1: {
		fontPt: 9.75,
		marginXIn: 0.5,
		marginYIn: 0.5,
		lineHeight: 1.26,
		sectionGapPt: 8,
		roleGapPt: 5,
	},
	2: {
		fontPt: 9.75,
		marginXIn: 0.5,
		marginYIn: 0.5,
		lineHeight: 1.22,
		sectionGapPt: 7,
		roleGapPt: 4,
	},
	3: {
		fontPt: 9.75,
		marginXIn: 0.5,
		marginYIn: 0.5,
		lineHeight: 1.18,
		sectionGapPt: 6,
		roleGapPt: 3,
	},
};

export function densitySpec(
	d: Density,
	theme: ThemeName = "standard",
): DensitySpec {
	return theme === "classic-navy" ? CLASSIC_SPECS[d] : SPECS[d];
}

/** classic-navy palette. */
export const CLASSIC_NAVY = "#1F3864";
export const CRIMSON = "#C0302B";
export const CLASSIC_GRAY = "#555555";
export const CLASSIC_FONT_STACK = `Calibri, Carlito, Arial, sans-serif`;

/** Section names per theme (all in the ATS standard-heading list). */
export type SectionKey =
	| "summary"
	| "skills"
	| "experience"
	| "projects"
	| "publications"
	| "education"
	| "certifications";

export const SECTION_TITLES: Record<ThemeName, Record<SectionKey, string>> = {
	standard: {
		summary: "Summary",
		skills: "Skills",
		experience: "Experience",
		projects: "Projects",
		publications: "Publications",
		education: "Education",
		certifications: "Certifications",
	},
	"classic-navy": {
		summary: "Professional Summary",
		skills: "Technical Skills",
		experience: "Professional Experience",
		projects: "Projects",
		publications: "Publications",
		education: "Education",
		certifications: "Certifications",
	},
};

export const SECTION_ORDER: Record<ThemeName, readonly SectionKey[]> = {
	standard: [
		"summary",
		"skills",
		"experience",
		"projects",
		"publications",
		"education",
		"certifications",
	],
	"classic-navy": [
		"summary",
		"skills",
		"experience",
		"projects",
		"education",
		"publications",
		"certifications",
	],
};

/** The resolved theme of a resume (default classic-navy). */
export function themeOf(r: { layout?: { theme?: ThemeName } }): ThemeName {
	return r.layout?.theme ?? DEFAULT_THEME;
}

/** Page size in inches. */
export function paperSize(p: Paper): { widthIn: number; heightIn: number } {
	return p === "a4"
		? { widthIn: 8.27, heightIn: 11.69 }
		: { widthIn: 8.5, heightIn: 11 };
}

/** Static stylesheet. Variables are set per render by `densityCss`. */
export const THEME_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:${FONT_STACK};font-size:var(--fs);line-height:var(--lh);color:#1a1a1a;background:#fff}
main{max-width:7.4in;margin:0 auto}
@media screen{main{padding:0.5in 0}}
h1{font-size:22pt;font-weight:600;color:${NAVY};line-height:1.1;letter-spacing:0.01em}
.headline{font-size:calc(var(--fs) + 1pt);margin-top:2pt}
.contact{margin-top:3pt}
.contact a,.contact span{white-space:nowrap}
.contact .sep{padding:0 0.15em;color:#666}
a{color:${NAVY};text-decoration:none}
h2{font-size:10.5pt;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:${NAVY};border-bottom:0.75pt solid ${NAVY};padding-bottom:1.5pt;margin-top:var(--sg);margin-bottom:3pt;break-after:avoid}
section p{margin-top:1pt}
.skills p{margin-top:1pt}
.skills .group{font-weight:600}
.role{margin-top:var(--rg)}
.role:first-of-type{margin-top:2pt}
.role-head{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 0.5em;break-after:avoid}
.role-head .title{font-weight:600}
.role-head .employer::before,.role-head .location::before,.edu-item .school::before{content:"|";padding-right:0.5em;color:#666}
.role-head .dates{margin-left:auto;white-space:nowrap}
ul{margin:1.5pt 0 0 1.15em;list-style:disc outside}
li{margin-top:0.75pt;padding-left:0.15em;break-inside:avoid}
strong{font-weight:600;color:#111}
.edu-item,.cert-item,.pub-item{display:flex;flex-wrap:wrap;align-items:baseline;gap:0 0.5em;break-inside:avoid}
.pub-item{margin-top:1pt;flex-wrap:nowrap}
.pub-item .name{flex:1}
.pub-item .venue{font-style:italic}
.edu-item .year,.cert-item .year,.pub-item .year{margin-left:auto;white-space:nowrap}
.letter{margin-top:14pt}
.letter p{margin-top:8pt}
.letter ul{margin-top:6pt}
.letter .date{margin-top:10pt}
`;

/**
 * classic-navy: centered navy name, crimson headline, gray contact line,
 * navy uppercase headings with a rule, two-line role heads (title/dates,
 * employer/location), italic Environment line, square publication markers.
 * One column; flex rows only align a date to the right edge.
 */
export const CLASSIC_CSS = `
*{box-sizing:border-box;margin:0;padding:0}
html{-webkit-print-color-adjust:exact;print-color-adjust:exact}
body{font-family:${CLASSIC_FONT_STACK};font-size:var(--fs);line-height:var(--lh);color:#1a1a1a;background:#fff}
main{max-width:7.5in;margin:0 auto}
@media screen{main{padding:0.5in 0}}
header{text-align:center}
h1{font-size:21pt;font-weight:700;color:${CLASSIC_NAVY};letter-spacing:normal;line-height:1.1}
.headline{font-size:calc(var(--fs) + 1.2pt);font-weight:700;color:${CRIMSON};margin-top:2pt}
.headline .sep{padding:0 0.4em}
.contact{font-size:calc(var(--fs) - 1.5pt);color:${CLASSIC_GRAY};margin-top:2pt}
.contact a,.contact span{white-space:nowrap}
.contact .sep{padding:0 0.2em}
.contact a{color:${CLASSIC_GRAY}}
a{color:${CLASSIC_NAVY};text-decoration:none}
h2{font-size:calc(var(--fs) + 1.3pt);font-weight:700;letter-spacing:normal;color:${CLASSIC_NAVY};border-bottom:0.75pt solid ${CLASSIC_NAVY};padding-bottom:1pt;margin-top:var(--sg);margin-bottom:3pt;break-after:avoid;page-break-after:avoid}
strong{font-weight:700}
section p{margin-top:1pt}
ul{margin:1.5pt 0 0 1.25em;list-style:disc outside}
li{margin-top:0.6pt;padding-left:0.2em;break-inside:avoid}
li::marker{color:${CLASSIC_NAVY}}
.highlights{margin-top:2pt}
.skills p{margin-top:0.6pt}
.skills .group{font-weight:700;color:${CLASSIC_NAVY}}
.role{margin-top:var(--rg)}
.role:first-of-type{margin-top:2pt}
.row{display:flex;justify-content:space-between;align-items:baseline;gap:0 1em;break-after:avoid;page-break-after:avoid;break-inside:avoid}
.role ul{break-before:avoid}
.role li:first-child{break-before:avoid}
.role .title{font-weight:700;color:${CLASSIC_NAVY}}
.role .dates{font-weight:700;color:${CLASSIC_GRAY};white-space:nowrap}
.role .employer{font-style:italic}
.role .location{font-style:italic;color:${CLASSIC_GRAY};white-space:nowrap}
.env{margin:1pt 0 0 1.45em;font-size:calc(var(--fs) - 0.8pt);font-style:italic;color:${CLASSIC_GRAY};break-inside:avoid}
.env .label{font-weight:700}
.edu-item{margin-top:1pt;break-inside:avoid}
.edu-item .degree{font-weight:700;color:${CLASSIC_NAVY}}
.edu-item .school::before{content:"|";padding:0 0.45em;color:${CLASSIC_GRAY}}
.edu-item .year{white-space:nowrap}
.coursework{font-size:calc(var(--fs) - 0.8pt);font-style:italic;color:${CLASSIC_GRAY};margin-top:0.5pt}
.coursework .label{font-weight:700}
ul.squares{list-style:square outside;margin-left:1.35em}
ul.squares li::marker{color:${CRIMSON}}
ul.squares li{font-weight:700;color:${CLASSIC_NAVY}}
ul.squares a{color:${CLASSIC_NAVY}}
ul.squares .name{font-weight:700;color:${CLASSIC_NAVY}}
.letter{margin-top:14pt}
.letter p{margin-top:8pt}
.letter ul{margin-top:6pt}
.letter .date{margin-top:10pt}
`;

/** classic-navy in plain black. */
export const CLASSIC_MONO_CSS = `
body,h1,.headline,.contact,a,h2,.skills .group,.role .title,.role .location,.env,.edu-item .degree,.coursework,ul.squares .name,ul.squares .meta{color:#000}
h2{border-bottom-color:#000}
li::marker,ul.squares li::marker{color:#000}
`;

/** Per-render variables and the @page rule (vars are not allowed in @page). */
export function densityCss(
	d: Density,
	paper: Paper,
	theme: ThemeName = "standard",
): string {
	const s = densitySpec(d, theme);
	const size = paper === "a4" ? "A4" : "Letter";
	return [
		`@page{size:${size};margin:${s.marginYIn}in ${s.marginXIn}in}`,
		`:root{--fs:${s.fontPt}pt;--lh:${s.lineHeight};--sg:${s.sectionGapPt}pt;--rg:${s.roleGapPt}pt}`,
	].join("\n");
}
