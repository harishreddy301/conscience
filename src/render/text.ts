import { shownTitle, type TailoredResume } from "../resume/schema.js";
import {
	certificationLine,
	contactItems,
	educationLine,
	publicationLine,
	themeRange,
} from "./html.js";
import {
	SECTION_ORDER,
	SECTION_TITLES,
	type SectionKey,
	type ThemeName,
	themeOf,
} from "./theme.js";

type Role = TailoredResume["experience"][number];

function heading(title: string): string[] {
	return ["", title.toUpperCase()];
}

function roleLines(r: Role, theme: ThemeName): string[] {
	const head = [
		shownTitle(r),
		r.employer,
		r.location,
		themeRange(r.start, r.end, theme),
	]
		.filter((p): p is string => Boolean(p))
		.join(" | ");
	const env = r.environment?.length
		? [`Environment: ${r.environment.join(", ")}`]
		: [];
	return [head, ...r.bullets.map((b) => `- ${b.text}`), ...env];
}

function rolesBlock(roles: Role[], theme: ThemeName): string[] {
	return roles.flatMap((r, i) =>
		i === 0 ? roleLines(r, theme) : ["", ...roleLines(r, theme)],
	);
}

/** Plain text for paste-in application fields. Same section order as HTML. */
export function renderText(r: TailoredResume): string {
	const theme = themeOf(r);
	const t = SECTION_TITLES[theme];
	const lines: string[] = [r.basics.name];
	if (r.basics.headline) lines.push(r.basics.headline);
	lines.push(
		contactItems(r.basics, theme)
			.map((c) => c.text)
			.join(" | "),
	);
	const build: Record<SectionKey, () => string[]> = {
		summary: () =>
			r.summary.text.trim()
				? [
						...heading(t.summary),
						r.summary.text,
						...(r.summary.highlights ?? []).map(
							(h) => `- ${h.label}: ${h.text}`,
						),
					]
				: [],
		skills: () =>
			r.skills.length
				? [
						...heading(t.skills),
						...r.skills.map((g) => `${g.group}: ${g.items.join(", ")}`),
					]
				: [],
		experience: () => [
			...heading(t.experience),
			...rolesBlock(r.experience, theme),
		],
		projects: () =>
			r.projects?.length
				? [...heading(t.projects), ...rolesBlock(r.projects, theme)]
				: [],
		publications: () =>
			r.publications?.length
				? [
						...heading(t.publications),
						...r.publications.map((p) => {
							const l = publicationLine(p);
							// No em dash: "Title, Venue | link | year".
							return `${l.title}, ${l.venue}${l.link ? ` | ${l.link}` : ""}${l.year ? ` | ${l.year}` : ""}`;
						}),
					]
				: [],
		education: () =>
			r.education.length
				? [
						...heading(t.education),
						...r.education.flatMap((e) => {
							const l = educationLine(e, theme);
							const line = [l.main, l.school, l.year]
								.filter(Boolean)
								.join(" | ");
							return l.coursework.length
								? [line, `Relevant Coursework: ${l.coursework.join(", ")}`]
								: [line];
						}),
					]
				: [],
		certifications: () =>
			r.certifications?.length
				? [
						...heading(t.certifications),
						...r.certifications.map((c) => {
							const l = certificationLine(c);
							return l.year ? `${l.main} | ${l.year}` : l.main;
						}),
					]
				: [],
	};
	for (const k of SECTION_ORDER[theme]) lines.push(...build[k]());
	return `${lines.join("\n")}\n`;
}
