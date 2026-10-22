import { containsTitle } from "../ats/keywords.js";
import type { ResumeVariantInput, TitleChoice } from "../db/learn.js";
import { usesTitleVariant } from "../resume/schema.js";

/** Role families used to bucket jobs. Order matters: first match wins. */
export const ROLE_FAMILIES = [
	"management",
	"ml",
	"data",
	"security",
	"devops",
	"mobile",
	"qa",
	"frontend",
	"fullstack",
	"backend",
	"other",
] as const;
export type RoleFamily = (typeof ROLE_FAMILIES)[number];

const ROLE_FAMILY_PATTERNS: ReadonlyArray<[RoleFamily, RegExp]> = [
	[
		"management",
		/\b(engineering manager|manager|director|head of|vp|vice president)\b/,
	],
	[
		"ml",
		/\b(machine learning|ml|ai|deep learning|llm|nlp|computer vision|applied scientist)\b/,
	],
	[
		"data",
		/\b(data|analytics|analyst|bi|etl|warehouse|business intelligence)\b/,
	],
	["security", /\b(security|appsec|infosec|cyber|penetration)\b/],
	[
		"devops",
		/\b(devops|sre|site reliability|platform|infrastructure|cloud|devsecops)\b/,
	],
	["mobile", /\b(ios|android|mobile|react native|flutter)\b/],
	["qa", /\b(qa|quality|test|sdet|automation engineer)\b/],
	["frontend", /\b(front[- ]?end|ui|web developer|react|angular|vue)\b/],
	["fullstack", /\b(full[- ]?stack)\b/],
	[
		"backend",
		/\b(back[- ]?end|software engineer|software developer|developer|programmer|api|java|python|golang|\.net|node)\b/,
	],
];

/** Deterministically bucket a job title into a role family. */
export function classifyRoleFamily(title: string): RoleFamily {
	const t = title.toLowerCase();
	for (const [family, re] of ROLE_FAMILY_PATTERNS) {
		if (re.test(t)) return family;
	}
	return "other";
}

export const FRAMINGS = [
	"leadership",
	"senior-ic",
	"specialist",
	"generalist",
] as const;
export type Framing = (typeof FRAMINGS)[number];

/**
 * How the headline positions the candidate.
 * leadership: lead/manager/head; senior-ic: senior/staff/principal;
 * specialist: names a stack or domain (separator or "in"/"for"); generalist: otherwise.
 */
export function classifyFraming(headline: string): Framing {
	const h = headline.toLowerCase();
	if (/\b(lead|leader|manager|head|director)\b/.test(h)) return "leadership";
	if (/\b(senior|sr\.?|staff|principal|architect)\b/.test(h))
		return "senior-ic";
	if (/[|•·/]|\b(in|for|specializing|focused)\b/.test(h)) return "specialist";
	return "generalist";
}

/** Lowercase, trim, collapse whitespace. Keeps symbols such as "c++" and "node.js". */
export function normalizeKeyword(k: string): string {
	return k.trim().toLowerCase().replace(/\s+/g, " ");
}

const XYZ_CONNECTOR = /\b(by|using|through|via|leveraging)\b/i;
const HAS_NUMBER = /\d/;

/**
 * Phrasing tags for one bullet:
 * - `opener:<verb>` the leading verb (lowercased);
 * - `shape:xyz` (number + "by/using/through" mechanism), `shape:metric` (number only) or `shape:plain`;
 * - `length:short|medium|long` (<110, <180, >=180 chars).
 */
export function phrasingTags(text: string): string[] {
	const trimmed = text.trim();
	const first = trimmed.split(/\s+/)[0] ?? "";
	const verb = first.toLowerCase().replace(/[^a-z-]/g, "");
	const tags: string[] = [];
	if (verb) tags.push(`opener:${verb}`);
	const hasNumber = HAS_NUMBER.test(trimmed);
	if (hasNumber && XYZ_CONNECTOR.test(trimmed)) tags.push("shape:xyz");
	else if (hasNumber) tags.push("shape:metric");
	else tags.push("shape:plain");
	const len = trimmed.length;
	tags.push(`length:${len < 110 ? "short" : len < 180 ? "medium" : "long"}`);
	return tags;
}

/** Structural subset of conscience.resume/v1 (TailoredResume) used for feature extraction. */
export interface ResumeLike {
	run_id: string;
	angle: string;
	job: { title: string };
	basics: { headline: string };
	experience: ReadonlyArray<ResumeRoleLike>;
	projects?: ReadonlyArray<ResumeRoleLike>;
	layout?: { pages?: number };
}
interface ResumeRoleLike {
	title?: string;
	display_title?: string;
	bullets: ReadonlyArray<{
		source_ids: ReadonlyArray<string>;
		text: string;
		keywords?: ReadonlyArray<string>;
	}>;
}

export interface VariantExtras {
	ats_score?: number | null;
	pages?: number | null;
	source?: string | null;
	submitted_at?: string | null;
	/** JD keywords actually matched; merged with per-bullet keywords. */
	keywords?: ReadonlyArray<string>;
	/** The JD snapshot's title_posted; defaults to the job title. */
	posted_title?: string | null;
}

/** Posted title vs the titles the resume showed (headline + experience display titles). */
export function titleChoiceOf(
	r: ResumeLike,
	postedTitle?: string | null,
): TitleChoice {
	const shown = r.experience
		.filter((role) => role.title !== undefined)
		.map((role) => ({
			shown: (role.display_title ?? role.title) as string,
			variant: usesTitleVariant(role),
		}));
	return {
		posted: (postedTitle ?? "").trim() || r.job.title,
		headline: r.basics.headline,
		display_titles: shown.map((s) => s.shown),
		variants_used: shown.filter((s) => s.variant).length,
	};
}

/**
 * Bucketed learning values for a title choice, so values repeat across
 * applications (n >= 3): "<posted family> <- <most recent display title>" and
 * whether the headline carried the posted title.
 */
export function titleChoiceValues(tc: TitleChoice): string[] {
	const family = classifyRoleFamily(tc.posted);
	const out: string[] = [];
	const recent = tc.display_titles[0];
	if (recent) out.push(`${family} <- ${normalizeKeyword(recent)}`);
	out.push(
		containsTitle(tc.headline, tc.posted)
			? "headline:has-posted-title"
			: "headline:other-title",
	);
	if (tc.variants_used > 0) out.push("display:title-variant");
	else out.push("display:official-titles");
	return out;
}

/** Build the variant record W3's finalize stores via recordVariant(). */
export function variantFromResume(
	r: ResumeLike,
	extras: VariantExtras = {},
): ResumeVariantInput {
	const roles = [...r.experience, ...(r.projects ?? [])];
	const bullets = roles.flatMap((role) => role.bullets);
	const keywords = new Set<string>();
	for (const k of extras.keywords ?? []) keywords.add(normalizeKeyword(k));
	for (const b of bullets) {
		for (const k of b.keywords ?? []) keywords.add(normalizeKeyword(k));
	}
	const bulletIds = new Set<string>();
	for (const b of bullets) for (const id of b.source_ids) bulletIds.add(id);
	const phrasing = new Set<string>();
	for (const b of bullets)
		for (const t of phrasingTags(b.text)) phrasing.add(t);
	return {
		run_id: r.run_id,
		angle: r.angle,
		framing: classifyFraming(r.basics.headline),
		keywords: [...keywords].filter(Boolean),
		bullet_ids: [...bulletIds],
		phrasing: [...phrasing],
		ats_score: extras.ats_score ?? null,
		pages: extras.pages ?? r.layout?.pages ?? null,
		role_family: classifyRoleFamily(r.job.title),
		source: extras.source ?? null,
		submitted_at: extras.submitted_at ?? null,
		title_choice: titleChoiceOf(r, extras.posted_title),
	};
}
