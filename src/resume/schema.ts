import { z } from "zod";

/**
 * Canonical tailored resume "conscience.resume/v1".
 * Every tailored bullet carries the master bullet ids it came from (provenance).
 */

export const MetricRef = z.object({
	metric_id: z.string().min(1),
	text: z.string(),
});
export type MetricRef = z.infer<typeof MetricRef>;

export const TBullet = z.object({
	id: z.string().min(1),
	source_ids: z.array(z.string().min(1)).min(1),
	text: z.string().min(10).max(260),
	metrics: z.array(MetricRef).default([]),
	keywords: z.array(z.string()).default([]),
	/**
	 * Exact phrases from `text` to show in bold, each bolded at its first
	 * occurrence. Required: 2-4 per bullet covering every metric (BOLD_MISSING,
	 * BOLD_EXCESS, METRIC_NOT_BOLD); the cap here is loose so the validator,
	 * not the schema, reports the excess.
	 */
	emphasis: z.array(z.string().min(2)).max(8).default([]),
});
export type TBullet = z.infer<typeof TBullet>;

export const TRole = z.object({
	role_id: z.string().min(1),
	kind: z.enum(["role", "project"]).default("role"),
	employer: z.string(),
	/** Official title, copied verbatim from the master (fixed; used in forms). */
	title: z.string(),
	/**
	 * Title shown on this resume: the official title or one of the master
	 * role's user-approved `title_variants` (closest to the JD). Omitted = title.
	 */
	display_title: z.string().min(1).optional(),
	start: z.string(),
	end: z.string(),
	location: z.string().optional(),
	bullets: z.array(TBullet).min(1),
	/**
	 * Optional "Environment:" line under the role: tools named in this role's
	 * bullets or in their source bullets' `skills` tags (ENV_UNKNOWN_TOOL otherwise).
	 */
	environment: z.array(z.string().min(1).max(40)).max(16).optional(),
});
export type TRole = z.infer<typeof TRole>;

export const ANGLES = [
	"impact",
	"skills-match",
	"domain-reframe",
	"revision",
] as const;
export type Angle = (typeof ANGLES)[number];

export const Education = z.object({
	school: z.string(),
	degree: z.string(),
	field: z.string(),
	year: z.string(),
	/** Copied verbatim from the master entry; rendered only when present. */
	gpa: z.string().optional(),
	coursework: z.array(z.string().min(1)).optional(),
});

/** A labeled summary bullet ("Label: text"), sourced like a tailored bullet. */
export const SummaryHighlight = z.object({
	label: z.string().min(2).max(40),
	text: z.string().min(10).max(260),
	/** Master bullet ids or "profile:<key>". */
	source_ids: z.array(z.string().min(1)).min(1),
	/** Exact phrases from `text` to show in bold: 1-2 per highlight; the label is always bold. */
	emphasis: z.array(z.string().min(2)).max(8).default([]),
});
export type SummaryHighlight = z.infer<typeof SummaryHighlight>;

/** Rendering themes. "classic-navy" is the default. */
export const THEMES = ["classic-navy", "standard"] as const;
export type ThemeName = (typeof THEMES)[number];
export const DEFAULT_THEME: ThemeName = "classic-navy";

export const Certification = z.object({
	name: z.string(),
	issuer: z.string().optional(),
	year: z.string().optional(),
});

export const Publication = z.object({
	title: z.string().min(1),
	venue: z.string().min(1),
	year: z.string(),
	url: z.string().optional(),
	note: z.string().optional(),
	/**
	 * Shorter title shown on this resume so the row fits one line. Must be a
	 * whole-word prefix of `title` (PUB_MISMATCH otherwise); display only.
	 */
	display_title: z.string().min(1).optional(),
});

export const TailoredResume = z.object({
	schema: z.literal("conscience.resume/v1"),
	run_id: z.string(),
	draft_id: z.string().regex(/^[a-z0-9-]+$/),
	angle: z.enum(ANGLES),
	iteration: z.number().int().min(0),
	job: z.object({
		app_id: z.number().int(),
		company: z.string(),
		title: z.string(),
		url: z.string().optional(),
	}),
	basics: z.object({
		name: z.string(),
		headline: z.string().max(120),
		email: z.string(),
		phone: z.string().optional(),
		location: z.string(),
		links: z
			.array(z.object({ label: z.string(), url: z.string() }))
			.default([]),
	}),
	/** source_ids are master bullet ids or "profile:<key>". */
	summary: z.object({
		text: z.string().max(450),
		source_ids: z.array(z.string()).min(1),
		/** Exact phrases from `text` to show in bold: the years and key stack terms (SUMMARY_BOLD_MISSING). */
		emphasis: z.array(z.string().min(2)).max(6).default([]),
		/** Optional 3-4 labeled bullets under the summary paragraph. */
		highlights: z.array(SummaryHighlight).max(4).default([]),
	}),
	skills: z.array(
		z.object({ group: z.string(), items: z.array(z.string()).min(1) }),
	),
	experience: z.array(TRole).min(1),
	projects: z.array(TRole).default([]),
	education: z.array(Education),
	certifications: z.array(Certification).default([]),
	/** Copied verbatim from the master `publications` (PUB_MISMATCH otherwise). */
	publications: z.array(Publication).default([]),
	layout: z
		.object({
			pages: z.union([z.literal(1), z.literal(2)]).default(2),
			paper: z.enum(["letter", "a4"]).default("letter"),
			/** "color": navy accents (default). "mono": all black, no color. */
			style: z.enum(["color", "mono"]).default("color"),
			/** Justify the summary and bullets so full lines end flush right. */
			justify: z.boolean().default(false),
			/** Visual theme: "classic-navy" (default) or "standard". */
			theme: z.enum(THEMES).default(DEFAULT_THEME),
		})
		.default({
			pages: 2,
			paper: "letter",
			style: "color",
			justify: false,
			theme: DEFAULT_THEME,
		}),
});
export type TailoredResume = z.infer<typeof TailoredResume>;

/** The title a reader sees for a role: display_title when set, else the official title. */
export function shownTitle(
	role: Pick<TRole, "title" | "display_title">,
): string {
	return role.display_title ?? role.title;
}

/** Title comparison key: trimmed, whitespace collapsed, lowercased. */
export function titleKey(t: string): string {
	return t.trim().replace(/\s+/g, " ").toLowerCase();
}

/** True when a role shows a title other than its official one (a title variant). */
export function usesTitleVariant(role: {
	title?: string;
	display_title?: string;
}): boolean {
	return (
		role.display_title !== undefined &&
		role.title !== undefined &&
		titleKey(role.display_title) !== titleKey(role.title)
	);
}

/** All roles (experience then projects) of a tailored resume. */
export function allRoles(r: TailoredResume): TRole[] {
	return [...r.experience, ...r.projects];
}

/** All bullets of a tailored resume, in document order. */
export function allBullets(r: TailoredResume): TBullet[] {
	return allRoles(r).flatMap((role) => role.bullets);
}
