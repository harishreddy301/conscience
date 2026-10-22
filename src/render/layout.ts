import { readFileSync } from "node:fs";
import type { TailoredResume } from "../resume/schema.js";
import { dumpDomArgs, findChrome, runChrome } from "./chrome.js";
import { renderHtml } from "./html.js";
import { countPdfPages, withHtmlFile } from "./pdf.js";
import {
	type Density,
	densitySpec,
	type Paper,
	paperSize,
	themeOf,
} from "./theme.js";

/**
 * Layout gate: measures the rendered resume in headless Chrome (DOM line boxes
 * via Range.getClientRects at the exact print content width) and checks it
 * against the user's layout spec (profile.yaml > resume_layout). Finalize
 * refuses a resume that fails it, so a 1-page, 1-bullet resume cannot ship.
 */

export interface LayoutSpec {
	/** Exact page count of the PDF. */
	pages: number;
	/** Every experience bullet and summary highlight is exactly this many lines. */
	bullet_lines: number;
	/** Allowed fill of a bullet's last line, as fractions of the line width. */
	bullet_fill: [number, number];
	/** The last page must be at least this full (fraction of the content height). */
	min_last_page_fill: number;
	/** Labeled summary bullets required (0 = not checked). */
	summary_bullets: number;
	/** Skill groups required (0 = not checked). */
	skills_groups: number;
	/** Minimum bullets per master role id, for roles that appear on the resume. */
	role_bullets: Record<string, number>;
}

export const DEFAULT_LAYOUT_SPEC: LayoutSpec = {
	pages: 2,
	bullet_lines: 2,
	bullet_fill: [0.6, 0.8],
	min_last_page_fill: 0.85,
	summary_bullets: 4,
	skills_groups: 8,
	role_bullets: {},
};

function num(v: unknown): number | undefined {
	return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Merge `profile.yaml > resume_layout` over the defaults. */
export function layoutSpecFrom(profile?: unknown): LayoutSpec {
	const raw =
		profile && typeof profile === "object"
			? (profile as { resume_layout?: unknown }).resume_layout
			: undefined;
	const o = (raw && typeof raw === "object" ? raw : {}) as Record<
		string,
		unknown
	>;
	const fill = Array.isArray(o.bullet_fill) ? o.bullet_fill : [];
	const roles: Record<string, number> = {};
	if (o.role_bullets && typeof o.role_bullets === "object")
		for (const [k, v] of Object.entries(o.role_bullets)) {
			const n = num(v);
			if (n !== undefined) roles[k] = n;
		}
	const d = DEFAULT_LAYOUT_SPEC;
	return {
		pages: num(o.pages) ?? d.pages,
		bullet_lines: num(o.bullet_lines) ?? d.bullet_lines,
		bullet_fill: [
			num(fill[0]) ?? d.bullet_fill[0],
			num(fill[1]) ?? d.bullet_fill[1],
		],
		min_last_page_fill: num(o.min_last_page_fill) ?? d.min_last_page_fill,
		summary_bullets: num(o.summary_bullets) ?? d.summary_bullets,
		skills_groups: num(o.skills_groups) ?? d.skills_groups,
		role_bullets: roles,
	};
}

export type LineKind =
	| "bullet"
	| "highlight"
	| "skill"
	| "env"
	| "pub"
	| "cert"
	| "coursework"
	| "headline"
	| "contact";

export interface MeasuredLine {
	kind: LineKind;
	path: string;
	/** Rendered line boxes. */
	lines: number;
	/** Fill of each line (right edge of its text / content width). */
	fills: number[];
	text: string;
}

export interface LayoutMeasure {
	items: MeasuredLine[];
	sections: { key: string; text_chars: number }[];
	/** Pages from simulated pagination of the measured blocks. */
	pages_sim: number;
	/** Fill of the last simulated page (0..1). */
	last_page_fill: number;
	/** Fill of each simulated page. */
	page_fills: number[];
	name_text: string;
	letter_spacing: { h1: string; h2: string };
	links: string[];
	body_text: string;
}

/**
 * Runs inside Chrome. Writes a base64 JSON report onto <html data-jh-layout>.
 * Line boxes: rects of a Range over each element's contents, clustered by
 * vertical center (half a line height). Fill: right edge of the last cluster
 * minus the content-box left, over the content-box width.
 */
const MEASURE_JS = `(function(){
var PAGE=__PAGE_PX__;
function px(v){var n=parseFloat(v);return isFinite(n)?n:0}
function measure(el){
 var cs=getComputedStyle(el),r=el.getBoundingClientRect();
 var left=r.left+px(cs.borderLeftWidth)+px(cs.paddingLeft);
 var width=r.width-px(cs.borderLeftWidth)-px(cs.borderRightWidth)-px(cs.paddingLeft)-px(cs.paddingRight);
 var lh=px(cs.lineHeight)||px(cs.fontSize)*1.2;
 var range=document.createRange();range.selectNodeContents(el);
 var rects=Array.prototype.slice.call(range.getClientRects()).filter(function(x){return x.width>0.5&&x.height>0.5});
 rects.sort(function(a,b){return a.top-b.top});
 var lines=[];
 rects.forEach(function(x){var mid=(x.top+x.bottom)/2;var L=null;
  for(var i=0;i<lines.length;i++){if(Math.abs(lines[i].mid-mid)<lh*0.5){L=lines[i];break}}
  if(!L){lines.push({mid:mid,right:x.right})}else{L.right=Math.max(L.right,x.right)}});
 lines.sort(function(a,b){return a.mid-b.mid});
 return {lines:lines.length,fills:lines.map(function(l){return Math.round(((l.right-left)/width)*1000)/1000})};
}
var items=[];
document.querySelectorAll('[data-kind]').forEach(function(el){var m=measure(el);
 items.push({kind:el.getAttribute('data-kind'),path:el.getAttribute('data-path')||el.getAttribute('data-kind'),lines:m.lines,fills:m.fills,text:el.textContent.replace(/\\s+/g,' ').trim()})});
var sections=[];
document.querySelectorAll('section[data-section]').forEach(function(s){var h=s.querySelector('h2');
 var t=s.textContent.replace(/\\s+/g,'');var ht=h?h.textContent.replace(/\\s+/g,''):'';
 sections.push({key:s.getAttribute('data-section'),text_chars:t.length-ht.length})});
var atoms=[];
document.querySelectorAll('header,h2,.row,section p,li').forEach(function(el){
 if(el.closest('li')&&el.tagName!=='LI')return;
 var r=el.getBoundingClientRect();if(r.height<=0)return;
 var keep=el.tagName==='H2'||el.classList.contains('row');
 atoms.push({top:r.top+window.scrollY,bottom:r.bottom+window.scrollY,keep:keep})});
atoms.sort(function(a,b){return a.top-b.top});
var pages=1,pageTop=atoms.length?atoms[0].top:0,start=0,fills=[];
for(var i=0;i<atoms.length;i++){
 if(atoms[i].bottom-pageTop>PAGE+0.5&&i>start){var j=i;
  while(j-1>start&&atoms[j-1].keep)j--;
  fills.push(Math.min(1,(atoms[j-1].bottom-pageTop)/PAGE));
  pageTop=atoms[j].top;start=j;pages++;i=j;}
}
var lastBottom=atoms.length?atoms[atoms.length-1].bottom:0;
fills.push(Math.max(0,(lastBottom-pageTop)/PAGE));
var h1=document.querySelector('h1'),h2=document.querySelector('h2');
var links=Array.prototype.map.call(document.querySelectorAll('a[href]'),function(a){return a.getAttribute('href')});
var out={items:items,sections:sections,pages_sim:pages,last_page_fill:Math.round(fills[fills.length-1]*1000)/1000,
 page_fills:fills.map(function(f){return Math.round(f*1000)/1000}),
 name_text:h1?h1.textContent.trim():'',
 letter_spacing:{h1:h1?getComputedStyle(h1).letterSpacing:'',h2:h2?getComputedStyle(h2).letterSpacing:''},
 links:links,body_text:document.body.innerText};
var json=JSON.stringify(out);
document.documentElement.setAttribute('data-jh-layout',btoa(unescape(encodeURIComponent(json))));
})();`;

const PX_PER_IN = 96;

/** Content box (inches) of a resume at a density. */
export function contentBoxIn(
	density: Density,
	paper: Paper,
	theme: ReturnType<typeof themeOf>,
): { widthIn: number; heightIn: number } {
	const s = densitySpec(density, theme);
	const p = paperSize(paper);
	return {
		widthIn: p.widthIn - 2 * s.marginXIn,
		heightIn: p.heightIn - 2 * s.marginYIn,
	};
}

/** The HTML that Chrome measures: the print stylesheet at the exact content width. */
export function measurementHtml(
	html: string,
	box: { widthIn: number; heightIn: number },
): string {
	const script = MEASURE_JS.replace(
		"__PAGE_PX__",
		String(box.heightIn * PX_PER_IN),
	);
	return html.replace(
		"</body>",
		`<style>@media screen{main{max-width:none;width:${box.widthIn}in;padding:0;margin:0}body{margin:0}}</style><script>${script}</script></body>`,
	);
}

/** Decode the report Chrome left on <html data-jh-layout="...">. */
export function parseLayoutDump(dom: string): LayoutMeasure | null {
	const m = /data-jh-layout="([A-Za-z0-9+/=]+)"/.exec(dom);
	if (!m?.[1]) return null;
	return JSON.parse(
		Buffer.from(m[1], "base64").toString("utf8"),
	) as LayoutMeasure;
}

/** Measure a rendered resume HTML in headless Chrome. */
export async function measureLayout(
	html: string,
	box: { widthIn: number; heightIn: number },
): Promise<LayoutMeasure> {
	const run = await withHtmlFile(measurementHtml(html, box), (url) =>
		runChrome((profile) => dumpDomArgs(profile, url)),
	);
	const report = parseLayoutDump(run.stdout);
	if (!report)
		throw new Error(
			`layout measurement failed (Chrome exit ${run.code}): no report in the dumped DOM`,
		);
	return report;
}

export type LayoutCode =
	| "PAGE_COUNT"
	| "LAST_PAGE_FILL"
	| "BULLET_LINES"
	| "BULLET_FILL"
	| "LINE_WRAPS"
	| "COURSEWORK_FILL"
	| "ROLE_BULLETS"
	| "SUMMARY_BULLETS"
	| "SKILLS_GROUPS"
	| "EMPTY_SECTION"
	| "EM_DASH"
	| "LETTER_SPACING"
	| "NAME_TEXT"
	| "LINKS"
	| "NOT_MEASURED";

export interface LayoutIssue {
	code: LayoutCode;
	path: string;
	message: string;
}

export interface LayoutGateResult {
	pass: boolean;
	spec: LayoutSpec;
	pages: number | null;
	pages_sim: number | null;
	last_page_fill: number | null;
	failures: LayoutIssue[];
	warnings: LayoutIssue[];
	/** Per bullet: lines and last-line fill, for the writer's next revision. */
	bullets: { path: string; lines: number; last_fill: number; text: string }[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const REQUIRED_SECTIONS = ["summary", "skills", "experience", "education"];

/** Pure rules over a measurement. `pdfPages` (when known) wins over the simulation. */
export function evaluateLayout(
	r: TailoredResume,
	m: LayoutMeasure,
	spec: LayoutSpec,
	pdfPages: number | null = null,
): LayoutGateResult {
	const failures: LayoutIssue[] = [];
	const warnings: LayoutIssue[] = [];
	const fail = (code: LayoutCode, path: string, message: string) =>
		failures.push({ code, path, message });
	const pages = pdfPages ?? m.pages_sim;
	if (pages !== spec.pages)
		fail(
			"PAGE_COUNT",
			"$",
			`${pages} page(s); the spec needs exactly ${spec.pages}`,
		);
	if (pages === spec.pages && m.last_page_fill < spec.min_last_page_fill)
		fail(
			"LAST_PAGE_FILL",
			"$",
			`last page is ${pct(m.last_page_fill)} full; needs at least ${pct(spec.min_last_page_fill)}`,
		);
	const [lo, hi] = spec.bullet_fill;
	const bullets: LayoutGateResult["bullets"] = [];
	for (const it of m.items) {
		const last = it.fills[it.fills.length - 1] ?? 0;
		if (it.kind === "bullet" || it.kind === "highlight") {
			bullets.push({
				path: it.path,
				lines: it.lines,
				last_fill: last,
				text: it.text,
			});
			if (it.lines !== spec.bullet_lines)
				fail(
					"BULLET_LINES",
					it.path,
					`${it.lines} line(s), needs exactly ${spec.bullet_lines}: "${it.text.slice(0, 60)}..."`,
				);
			else if (last < lo || last > hi)
				fail(
					"BULLET_FILL",
					it.path,
					`last line ${pct(last)} full, needs ${pct(lo)} to ${pct(hi)}: "${it.text.slice(0, 60)}..."`,
				);
			continue;
		}
		if (it.kind === "coursework") {
			if (it.lines > 2)
				fail("COURSEWORK_FILL", it.path, `${it.lines} lines, at most 2`);
			else if (it.lines === 2 && last < 0.5)
				fail(
					"COURSEWORK_FILL",
					it.path,
					`second line ${pct(last)} full, needs over 50%`,
				);
			else if (it.lines === 1)
				warnings.push({
					code: "COURSEWORK_FILL",
					path: it.path,
					message:
						"coursework fits one line (allowed: only the courses the user recorded are listed)",
				});
			continue;
		}
		if (it.lines !== 1)
			fail(
				"LINE_WRAPS",
				it.path,
				`${it.kind} line wraps to ${it.lines} lines; must be exactly 1: "${it.text.slice(0, 60)}..."`,
			);
	}
	for (const role of r.experience) {
		const need = spec.role_bullets[role.role_id];
		if (need !== undefined && role.bullets.length < need)
			fail(
				"ROLE_BULLETS",
				role.role_id,
				`${role.bullets.length} bullet(s) for ${role.employer}; the spec needs ${need}`,
			);
	}
	const hl = r.summary.highlights?.length ?? 0;
	if (spec.summary_bullets > 0 && hl !== spec.summary_bullets)
		fail(
			"SUMMARY_BULLETS",
			"summary.highlights",
			`${hl} summary bullet(s); needs ${spec.summary_bullets}`,
		);
	if (spec.skills_groups > 0 && r.skills.length !== spec.skills_groups)
		fail(
			"SKILLS_GROUPS",
			"skills",
			`${r.skills.length} skill group(s); needs ${spec.skills_groups}`,
		);
	const present = new Map(m.sections.map((s) => [s.key, s.text_chars]));
	for (const key of REQUIRED_SECTIONS)
		if (!present.has(key))
			fail("EMPTY_SECTION", key, `section "${key}" is missing`);
	for (const s of m.sections)
		if (s.text_chars < 10)
			fail("EMPTY_SECTION", s.key, `section "${s.key}" is empty`);
	const em = String.fromCharCode(0x2014);
	if (m.body_text.includes(em))
		fail("EM_DASH", "$", "the rendered resume contains an em dash");
	for (const [tag, v] of Object.entries(m.letter_spacing))
		if (v && v !== "normal" && Number.parseFloat(v) !== 0)
			fail("LETTER_SPACING", tag, `${tag} has letter-spacing ${v}`);
	const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
	if (norm(m.name_text) !== norm(r.basics.name))
		fail(
			"NAME_TEXT",
			"basics.name",
			`name reads "${m.name_text}", expected "${r.basics.name}"`,
		);
	const wantLinks = [
		`mailto:${r.basics.email}`,
		...(r.basics.links ?? []).map((l) => l.url),
	];
	for (const w of wantLinks) {
		const key = norm(w)
			.replace(/^https?:\/\/(www\.)?/, "")
			.replace(/\/$/, "");
		if (
			!m.links.some((h) =>
				norm(h)
					.replace(/^https?:\/\/(www\.)?/, "")
					.replace(/\/$/, "")
					.includes(key),
			)
		)
			fail("LINKS", "basics", `no clickable link for ${w}`);
	}
	return {
		pass: failures.length === 0,
		spec,
		pages,
		pages_sim: m.pages_sim,
		last_page_fill: m.last_page_fill,
		failures,
		warnings,
		bullets,
	};
}

/**
 * Measure and judge a resume. Renders the HTML at `density` unless `html` is
 * given; `pdfPath` adds the real page count. Without Chrome the gate fails
 * closed (NOT_MEASURED): the layout cannot be proven.
 */
export async function layoutGate(
	r: TailoredResume,
	o: {
		spec: LayoutSpec;
		density?: Density;
		html?: string;
		pdfPath?: string;
	},
): Promise<LayoutGateResult> {
	const theme = themeOf(r);
	const density = o.density ?? 0;
	const pdfPages = o.pdfPath ? countPdfPages(readFileSync(o.pdfPath)) : null;
	if (!findChrome())
		return {
			pass: false,
			spec: o.spec,
			pages: pdfPages,
			pages_sim: null,
			last_page_fill: null,
			failures: [
				{
					code: "NOT_MEASURED",
					path: "$",
					message:
						"Chrome not found; the layout gate cannot measure the resume",
				},
			],
			warnings: [],
			bullets: [],
		};
	const html = o.html ?? renderHtml(r, { density });
	const box = contentBoxIn(density, r.layout?.paper ?? "letter", theme);
	const m = await measureLayout(html, box);
	return evaluateLayout(r, m, o.spec, pdfPages);
}
