import { shownTitle, type TailoredResume } from "../resume/schema.js";
import { splitEmphasis } from "./emphasis.js";
import {
	CLASSIC_CSS,
	CLASSIC_MONO_CSS,
	type Density,
	densityCss,
	JUSTIFY_CSS,
	MONO_CSS,
	type ResumeStyle,
	SECTION_ORDER,
	SECTION_TITLES,
	type SectionKey,
	THEME_CSS,
	type ThemeName,
	themeOf,
} from "./theme.js";

type Role = TailoredResume["experience"][number];
type Basics = TailoredResume["basics"];

const MONTHS = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
] as const;

export const EN_DASH = "–";

/** "2022-01" -> "Jan 2022", "present" -> "Present"; anything else passes through. */
export function formatDate(ym: string): string {
	const v = ym.trim();
	if (/^present$/i.test(v)) return "Present";
	const m = /^(\d{4})-(\d{2})$/.exec(v);
	if (!m) return v;
	const month = MONTHS[Number(m[2]) - 1];
	return month ? `${month} ${m[1]}` : v;
}

/**
 * "Jan 2022 – Present" (or "Jan 2022 to Present" with joiner "to");
 * a single date when start and end are equal.
 */
export function formatRange(
	start: string,
	end: string,
	joiner: string = EN_DASH,
): string {
	const a = formatDate(start);
	const b = formatDate(end);
	return a === b ? a : `${a} ${joiner} ${b}`;
}

/** Date range as the theme shows it: classic-navy writes "Jun 2026 to Present". */
export function themeRange(
	start: string,
	end: string,
	theme: ThemeName,
): string {
	return formatRange(start, end, theme === "classic-navy" ? "to" : EN_DASH);
}

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

/** Only http(s) and mailto links are emitted as anchors. */
export function safeHref(url: string): string | null {
	const u = url.trim();
	if (/^mailto:/i.test(u)) return u;
	if (/^https?:\/\//i.test(u)) return u;
	if (/^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(u)) return `https://${u}`;
	return null;
}

/** "https://www.linkedin.com/in/jane/" -> "linkedin.com/in/jane" */
export function displayUrl(url: string): string {
	return url
		.trim()
		.replace(/^mailto:/i, "")
		.replace(/^https?:\/\//i, "")
		.replace(/^www\./i, "")
		.replace(/\/$/, "");
}

/**
 * Contact items in reading order, shared by every format. Standard: email,
 * phone, location, links. classic-navy: location, phone, email, links.
 */
export function contactItems(
	b: Basics,
	theme: ThemeName = "standard",
): { text: string; href?: string }[] {
	const email = { text: b.email, href: `mailto:${b.email}` };
	const classic = theme === "classic-navy";
	const items: { text: string; href?: string }[] = [
		classic ? { text: b.location } : email,
	];
	if (b.phone) items.push({ text: b.phone });
	items.push(classic ? email : { text: b.location });
	for (const l of b.links ?? []) {
		const href = safeHref(l.url);
		items.push(
			href ? { text: displayUrl(l.url), href } : { text: displayUrl(l.url) },
		);
	}
	return items;
}

export function documentTitle(name: string, kind: string): string {
	return `${name} ${EN_DASH} ${kind}`;
}

function contactHtml(b: Basics, theme: ThemeName = "standard"): string {
	const parts = contactItems(b, theme).map((c) =>
		c.href
			? `<a href="${escapeHtml(c.href)}">${escapeHtml(c.text)}</a>`
			: `<span>${escapeHtml(c.text)}</span>`,
	);
	return `<p class="contact" data-kind="contact">${parts.join(' <span class="sep">|</span> ')}</p>`;
}

/** Headline terms split on "|" (classic-navy shows them with separators). */
export function headlineTerms(headline: string): string[] {
	return headline
		.split("|")
		.map((t) => t.trim())
		.filter(Boolean);
}

/** Name, headline and contact block, reused by the cover letter. */
export function headerHtml(
	b: Basics,
	withHeadline = true,
	theme: ThemeName = "standard",
): string {
	let headline = "";
	if (withHeadline && b.headline) {
		const inner =
			theme === "classic-navy"
				? headlineTerms(b.headline)
						.map((t) => `<span>${escapeHtml(t)}</span>`)
						.join(' <span class="sep">|</span> ')
				: escapeHtml(b.headline);
		headline = `<p class="headline" data-kind="headline">${inner}</p>`;
	}
	const name = theme === "classic-navy" ? b.name.toUpperCase() : b.name;
	return `<header><h1>${escapeHtml(name)}</h1>${headline}${contactHtml(b, theme)}</header>`;
}

function emphasisHtml(text: string, phrases?: readonly string[]): string {
	return splitEmphasis(text, phrases)
		.map((s) =>
			s.bold ? `<strong>${escapeHtml(s.text)}</strong>` : escapeHtml(s.text),
		)
		.join("");
}

function roleHtml(r: Role): string {
	const location = r.location
		? `<span class="location">${escapeHtml(r.location)}</span>`
		: "";
	const bullets = r.bullets
		.map((b) => `<li>${emphasisHtml(b.text, b.emphasis)}</li>`)
		.join("");
	return [
		`<div class="role">`,
		`<div class="role-head">`,
		`<span class="title">${escapeHtml(shownTitle(r))}</span>`,
		`<span class="employer">${escapeHtml(r.employer)}</span>`,
		location,
		`<span class="dates">${escapeHtml(formatRange(r.start, r.end))}</span>`,
		`</div>`,
		`<ul>${bullets}</ul>`,
		`</div>`,
	].join("");
}

function classicRoleHtml(r: Role, ri = 0, key = "experience"): string {
	const location = r.location
		? `<span class="location">${escapeHtml(r.location)}</span>`
		: "";
	const bullets = r.bullets
		.map(
			(b, bi) =>
				`<li data-kind="bullet" data-path="${key}[${ri}].bullets[${bi}]">${emphasisHtml(b.text, b.emphasis)}</li>`,
		)
		.join("");
	const env = r.environment?.length
		? `<p class="env" data-kind="env" data-path="${key}[${ri}].environment"><span class="label">Environment:</span> ${escapeHtml(r.environment.join(", "))}</p>`
		: "";
	return [
		`<div class="role" data-role-id="${escapeHtml(r.role_id)}">`,
		`<div class="row role-head"><span class="title">${escapeHtml(shownTitle(r))}</span><span class="dates">${escapeHtml(themeRange(r.start, r.end, "classic-navy"))}</span></div>`,
		`<div class="row role-sub"><span class="employer">${escapeHtml(r.employer)}</span>${location}</div>`,
		`<ul>${bullets}</ul>`,
		env,
		`</div>`,
	].join("");
}

function section(
	title: string,
	cls: string,
	body: string,
	theme: ThemeName = "standard",
): string {
	// classic-navy writes the caps into the text (no CSS transform, no letter-spacing).
	const shown = theme === "classic-navy" ? title.toUpperCase() : title;
	return `<section class="${cls}" data-section="${cls}"><h2>${escapeHtml(shown)}</h2>${body}</section>`;
}

export function educationLine(
	e: TailoredResume["education"][number],
	theme: ThemeName = "standard",
): {
	main: string;
	school: string;
	year: string;
	coursework: string[];
} {
	const classic = theme === "classic-navy";
	const sep = classic ? " in " : ", ";
	const main = e.field ? `${e.degree}${sep}${e.field}` : e.degree;
	const school = classic && e.gpa ? `${e.school} (GPA ${e.gpa})` : e.school;
	return { main, school, year: e.year, coursework: e.coursework ?? [] };
}

export function certificationLine(
	c: TailoredResume["certifications"][number],
): { main: string; year: string } {
	return {
		main: c.issuer ? `${c.name}, ${c.issuer}` : c.name,
		year: c.year ?? "",
	};
}

export function publicationLine(p: TailoredResume["publications"][number]): {
	title: string;
	venue: string;
	year: string;
	/** Short visible form of the link, e.g. "mdpi.com/1424-8220/26/14/4636". */
	link?: string;
	href?: string;
} {
	const href = p.url ? safeHref(p.url) : null;
	return {
		title: p.title,
		venue: p.note ? `${p.venue} (${p.note})` : p.venue,
		year: p.year,
		...(href && p.url ? { link: displayUrl(p.url), href } : {}),
	};
}

function summaryHtml(r: TailoredResume, theme: ThemeName): string {
	const p = `<p>${emphasisHtml(r.summary.text, r.summary.emphasis)}</p>`;
	const hl = r.summary.highlights ?? [];
	if (!hl.length) return p;
	const items = hl
		.map(
			(h, i) =>
				`<li data-kind="highlight" data-path="summary.highlights[${i}]"><strong>${escapeHtml(h.label)}:</strong> ${emphasisHtml(h.text, h.emphasis)}</li>`,
		)
		.join("");
	return `${p}<ul class="highlights${theme === "classic-navy" ? "" : " plain"}">${items}</ul>`;
}

/** "Venue Year" plus an optional role note: "IEEE Journal 2025 (acknowledged contributor)". */
export function classicPubTail(
	p: TailoredResume["publications"][number],
): string {
	return `${p.venue} ${p.year}${p.note ? ` (${p.note})` : ""}`;
}

function publicationsHtml(r: TailoredResume, theme: ThemeName): string {
	if (theme === "classic-navy") {
		// One row each: "Title, Venue Year" in bold navy; the title links to the paper.
		const items = r.publications
			.map((p, i) => {
				const l = publicationLine(p);
				const title = escapeHtml(p.display_title ?? l.title);
				const name =
					l.href !== undefined
						? `<a class="name" href="${escapeHtml(l.href)}">${title}</a>`
						: `<span class="name">${title}</span>`;
				return `<li data-kind="pub" data-path="publications[${i}]">${name}, ${escapeHtml(classicPubTail(p))}</li>`;
			})
			.join("");
		return `<ul class="squares">${items}</ul>`;
	}
	return r.publications
		.map((p) => {
			const l = publicationLine(p);
			return `<div class="pub-item"><span class="name">${escapeHtml(l.title)}, <span class="venue">${escapeHtml(l.venue)}</span>${l.href && l.link ? ` <span class="sep">|</span> <a href="${escapeHtml(l.href)}">${escapeHtml(l.link)}</a>` : ""}</span><span class="year">${escapeHtml(l.year)}</span></div>`;
		})
		.join("");
}

function educationHtml(r: TailoredResume, theme: ThemeName): string {
	return r.education
		.map((e) => {
			const l = educationLine(e, theme);
			if (theme !== "classic-navy")
				return `<div class="edu-item"><span class="degree">${escapeHtml(l.main)}</span><span class="school">${escapeHtml(l.school)}</span><span class="year">${escapeHtml(l.year)}</span></div>`;
			const course = l.coursework.length
				? `<p class="coursework" data-kind="coursework"><span class="label">Relevant Coursework:</span> ${escapeHtml(l.coursework.join(", "))}</p>`
				: "";
			return `<div class="edu-item"><div class="row"><span><span class="degree">${escapeHtml(l.main)}</span><span class="school">${escapeHtml(l.school)}</span></span><span class="year">${escapeHtml(l.year)}</span></div>${course}</div>`;
		})
		.join("");
}

function certificationsHtml(r: TailoredResume, theme: ThemeName): string {
	if (theme === "classic-navy") {
		const items = r.certifications
			.map((c, i) => {
				const l = certificationLine(c);
				return `<li data-kind="cert" data-path="certifications[${i}]"><span class="name">${escapeHtml(l.main)}</span>${l.year ? ` <span class="meta">| ${escapeHtml(l.year)}</span>` : ""}</li>`;
			})
			.join("");
		return `<ul class="squares">${items}</ul>`;
	}
	return r.certifications
		.map((c) => {
			const l = certificationLine(c);
			const year = l.year
				? `<span class="year">${escapeHtml(l.year)}</span>`
				: "";
			return `<div class="cert-item"><span class="name">${escapeHtml(l.main)}</span>${year}</div>`;
		})
		.join("");
}

function skillsHtml(r: TailoredResume): string {
	return r.skills
		.map(
			(g, i) =>
				`<p data-kind="skill" data-path="skills[${i}]"><span class="group">${escapeHtml(g.group)}:</span> ${escapeHtml(g.items.join(", "))}</p>`,
		)
		.join("");
}

function bodySections(r: TailoredResume): string[] {
	const theme = themeOf(r);
	const t = SECTION_TITLES[theme];
	const roles = (list: Role[], key: string) =>
		list
			.map((role, i) =>
				theme === "classic-navy"
					? classicRoleHtml(role, i, key)
					: roleHtml(role),
			)
			.join("");
	const sec = (title: string, cls: string, body: string) =>
		section(title, cls, body, theme);
	const build: Record<SectionKey, () => string | null> = {
		summary: () =>
			r.summary.text.trim()
				? sec(t.summary, "summary", summaryHtml(r, theme))
				: null,
		skills: () =>
			r.skills.length ? sec(t.skills, "skills", skillsHtml(r)) : null,
		experience: () =>
			sec(t.experience, "experience", roles(r.experience, "experience")),
		projects: () =>
			r.projects?.length
				? sec(t.projects, "projects", roles(r.projects, "projects"))
				: null,
		publications: () =>
			r.publications?.length
				? sec(t.publications, "publications", publicationsHtml(r, theme))
				: null,
		education: () =>
			r.education.length
				? sec(t.education, "education", educationHtml(r, theme))
				: null,
		certifications: () =>
			r.certifications?.length
				? sec(t.certifications, "certifications", certificationsHtml(r, theme))
				: null,
	};
	return SECTION_ORDER[theme]
		.map((k) => build[k]())
		.filter((x): x is string => x !== null);
}

/** Wrap a body in the themed document shell. */
export function htmlDocument(o: {
	title: string;
	body: string;
	density: Density;
	paper: "letter" | "a4";
	style?: ResumeStyle;
	justify?: boolean;
	theme?: ThemeName;
}): string {
	const theme = o.theme ?? "standard";
	const classic = theme === "classic-navy";
	const base = classic ? CLASSIC_CSS : THEME_CSS;
	const mono =
		o.style === "mono" ? (classic ? CLASSIC_MONO_CSS : MONO_CSS) : "";
	return [
		"<!doctype html>",
		'<html lang="en">',
		"<head>",
		'<meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${escapeHtml(o.title)}</title>`,
		`<style>${base}\n${densityCss(o.density, o.paper, theme)}${mono}${o.justify ? JUSTIFY_CSS : ""}</style>`,
		"</head>",
		`<body><main>${o.body}</main></body>`,
		"</html>",
	].join("\n");
}

export function renderHtml(
	r: TailoredResume,
	opts: { density?: Density } = {},
): string {
	const theme = themeOf(r);
	const body = [headerHtml(r.basics, true, theme), ...bodySections(r)].join(
		"\n",
	);
	return htmlDocument({
		title: documentTitle(r.basics.name, "Resume"),
		body,
		density: opts.density ?? 0,
		paper: r.layout?.paper ?? "letter",
		style: r.layout?.style ?? "color",
		justify: r.layout?.justify ?? false,
		theme,
	});
}
