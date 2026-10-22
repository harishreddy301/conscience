import { containsTitle, normTerm } from "../ats/keywords.js";
import { allSkills, experienceYears, normSkill } from "../me/load.js";
import type {
	MasterBullet,
	MasterResume,
	MasterRole,
	Metric,
	Profile,
} from "../me/schema.js";
import { locateEmphasis } from "../render/emphasis.js";
import {
	TailoredResume,
	type TBullet,
	type TRole,
	titleKey,
} from "./schema.js";

export type IssueCode =
	| "SCHEMA"
	| "FIXED_FACT_CHANGED"
	| "TITLE_NOT_APPROVED"
	| "HEADLINE_OFF_TARGET"
	| "UNKNOWN_SOURCE"
	| "RETIRED_SOURCE"
	| "UNKNOWN_SKILL"
	| "NUMBER_UNSOURCED"
	| "ESTIMATED_METRIC"
	| "EDU_MISMATCH"
	| "PUB_MISMATCH"
	| "ENV_UNKNOWN_TOOL"
	| "CERT_MISMATCH"
	| "BANNED_PHRASE"
	| "BULLET_TOO_LONG"
	| "EM_DASH"
	| "PRONOUN"
	| "BOLD_MISSING"
	| "BOLD_EXCESS"
	| "BOLD_UNTRACEABLE"
	| "METRIC_NOT_BOLD"
	| "SUMMARY_BOLD_MISSING"
	| "HIGHLIGHT_LABEL_NOT_BOLD";

export interface ValidationIssue {
	path: string;
	code: IssueCode;
	message: string;
	token?: string;
}

export interface ValidationResult {
	ok: boolean;
	errors: ValidationIssue[];
	warnings: ValidationIssue[];
}

export const DEFAULT_BANNED_PHRASES = [
	"responsible for",
	"passionate",
	"synergy",
	"rockstar",
] as const;

export const SOFT_BULLET_LIMIT = 235;

// ---------------------------------------------------------------- numbers

const UNIT_ALIASES: Record<string, string> = {
	"%": "%",
	x: "x",
	"+": "+",
	k: "k",
	thousand: "k",
	m: "m",
	mm: "m",
	mn: "m",
	million: "m",
	b: "b",
	bn: "b",
	billion: "b",
	ms: "ms",
	s: "s",
	sec: "s",
	secs: "s",
	seconds: "s",
	min: "min",
	mins: "min",
	minute: "min",
	minutes: "min",
	h: "h",
	hr: "h",
	hrs: "h",
	hours: "h",
	day: "d",
	days: "d",
	week: "wk",
	weeks: "wk",
	month: "mo",
	months: "mo",
	year: "yr",
	years: "yr",
	yr: "yr",
	yrs: "yr",
};

// Longest alternatives first so "ms" wins over "m" and "million" over "m".
const UNIT_RE =
	"%|x|\\+|thousand|million|billion|seconds|secs|sec|minutes|minute|mins|min|ms|mm|mn|bn|hours|hrs|hr|h|days|day|weeks|week|months|month|years|year|yrs|yr|k|m|b|s";
const NUMBER_RE = new RegExp(
	`(?<![A-Za-z0-9.])([$€£₹]?)(\\d[\\d,.]*\\d|\\d)(?:(\\s?)(${UNIT_RE})(?![A-Za-z]))?`,
	"gi",
);

interface RawToken {
	raw: string;
	normalized: string;
	index: number;
	end: number;
	hasUnit: boolean;
	currency: string;
	digits: string;
}

function normalizeToken(currency: string, digits: string, unit: string) {
	const d = digits.replace(/,/g, "").replace(/\.0+$/, "");
	const u = unit
		? (UNIT_ALIASES[unit.toLowerCase()] ?? unit.toLowerCase())
		: "";
	return `${currency}${d}${u}`;
}

function scanNumbers(text: string): RawToken[] {
	const out: RawToken[] = [];
	for (const m of text.matchAll(NUMBER_RE)) {
		const [raw, currency = "", digits = "", , unit = ""] = m;
		const index = m.index ?? 0;
		out.push({
			raw,
			normalized: normalizeToken(currency, digits, unit),
			index,
			end: index + raw.length,
			hasUnit: unit !== "",
			currency,
			digits,
		});
	}
	return out;
}

/** True for a token glued to letters ("3D", "5G") or a version after a tool name ("Python 3.11"). */
function isTechToken(text: string, t: RawToken): boolean {
	if (t.hasUnit || t.currency) return false;
	if (/^[A-Za-z]/.test(text.slice(t.end, t.end + 1))) return true;
	// A product or grade code glued by a hyphen: "K-12", "GPT-4".
	if (/[A-Za-z]-$/.test(text.slice(0, t.index))) return true;
	const isVersion = /^\d+(?:\.\d+)+$/.test(t.digits);
	const before = text.slice(0, t.index);
	// A capitalized tool name before it ("Python 3.11", "Spring Boot 3.2").
	return isVersion && /(?:^|\s)[A-Z][A-Za-z+#.]*\s$/.test(before);
}

/**
 * Normalized numeric tokens in a text: currency kept, thousands separators
 * removed, units folded ("hours" -> "h", "million" -> "m"). Tokens glued to
 * letters (S3, EC2, 3D) and versions after a word (Python 3.11) are skipped.
 */
export function numericTokens(text: string): string[] {
	return scanNumbers(text)
		.filter((t) => !isTechToken(text, t))
		.map((t) => t.normalized);
}

// ---------------------------------------------------------------- master index

interface BulletEntry {
	bullet: MasterBullet;
	role: MasterRole;
}

interface MasterIndex {
	roles: Map<string, MasterRole>;
	bullets: Map<string, BulletEntry>;
}

function indexMaster(master: MasterResume): MasterIndex {
	const roles = new Map<string, MasterRole>();
	const bullets = new Map<string, BulletEntry>();
	for (const role of master.roles) {
		roles.set(role.id, role);
		for (const bullet of role.bullets) bullets.set(bullet.id, { bullet, role });
	}
	return { roles, bullets };
}

function metricTokens(metrics: readonly Metric[]): Set<string> {
	const out = new Set<string>();
	for (const m of metrics) {
		for (const t of numericTokens(`${m.value} ${m.phrase}`)) out.add(t);
	}
	return out;
}

function yearsOf(...dates: string[]): Set<string> {
	const out = new Set<string>();
	for (const d of dates) {
		const y = /^(\d{4})/.exec(d)?.[1];
		if (y) out.add(y);
	}
	return out;
}

// ---------------------------------------------------------------- checks

type Push = (issue: ValidationIssue) => void;

interface Ctx {
	master: MasterResume;
	profile?: Profile;
	index: MasterIndex;
	error: Push;
	warn: Push;
}

function checkRole(ctx: Ctx, role: TRole, path: string): void {
	const m = ctx.index.roles.get(role.role_id);
	if (!m) {
		ctx.error({
			path: `${path}.role_id`,
			code: "UNKNOWN_SOURCE",
			message: `role ${role.role_id} is not in the master resume`,
			token: role.role_id,
		});
		return;
	}
	for (const field of ["employer", "title", "start", "end"] as const) {
		if (role[field] !== m[field]) {
			ctx.error({
				path: `${path}.${field}`,
				code: "FIXED_FACT_CHANGED",
				message: `${field} must be "${m[field]}" (got "${role[field]}")`,
				token: role[field],
			});
		}
	}
	checkDisplayTitle(ctx, role, m, path);
	checkEnvironment(ctx, role, path);
	role.bullets.forEach((b, i) => {
		checkBullet(ctx, b, m, `${path}.bullets[${i}]`);
	});
}

/** Titles a resume may show for a master role: the official one plus the user's approved variants. */
export function approvedTitles(m: MasterRole): string[] {
	return [m.title, ...(m.title_variants ?? [])];
}

/**
 * display_title must be exactly the official title or one of the master
 * role's user-approved title_variants, spelled as the user wrote it, so the
 * rendered resume never shows a casing or spelling the user did not approve.
 */
function checkDisplayTitle(
	ctx: Ctx,
	role: TRole,
	m: MasterRole,
	path: string,
): void {
	if (role.display_title === undefined) return;
	const approved = approvedTitles(m);
	if (approved.includes(role.display_title)) return;
	const respelled = approved.find(
		(t) => titleKey(t) === titleKey(role.display_title as string),
	);
	if (respelled !== undefined) {
		ctx.error({
			path: `${path}.display_title`,
			code: "TITLE_NOT_APPROVED",
			message: `"${role.display_title}" differs from the approved spelling: use "${respelled}" exactly`,
			token: role.display_title,
		});
		return;
	}
	const variants = m.title_variants?.length
		? `one of its title_variants (${m.title_variants.map((t) => `"${t}"`).join(", ")})`
		: "no title_variants (add them to the role's experience front matter and re-run /intake)";
	ctx.error({
		path: `${path}.display_title`,
		code: "TITLE_NOT_APPROVED",
		message: `"${role.display_title}" is not approved for ${m.id}: use the official title "${m.title}" or ${variants}`,
		token: role.display_title,
	});
}

/** Resolve a bullet's sources; returns the live master bullets it may draw on. */
function resolveSources(
	ctx: Ctx,
	b: TBullet,
	role: MasterRole,
	path: string,
): MasterBullet[] {
	const live: MasterBullet[] = [];
	b.source_ids.forEach((id, i) => {
		const entry = ctx.index.bullets.get(id);
		const p = `${path}.source_ids[${i}]`;
		if (!entry) {
			ctx.error({
				path: p,
				code: "UNKNOWN_SOURCE",
				message: `bullet ${id} is not in the master resume`,
				token: id,
			});
		} else if (entry.role.id !== role.id) {
			ctx.error({
				path: p,
				code: "UNKNOWN_SOURCE",
				message: `bullet ${id} belongs to ${entry.role.id}, not ${role.id}`,
				token: id,
			});
		} else if (entry.bullet.retired) {
			ctx.error({
				path: p,
				code: "RETIRED_SOURCE",
				message: `bullet ${id} is retired`,
				token: id,
			});
		} else live.push(entry.bullet);
	});
	return live;
}

function checkMetricRefs(
	ctx: Ctx,
	b: TBullet,
	sources: MasterBullet[],
	path: string,
): void {
	const byId = new Map(sources.flatMap((s) => s.metrics.map((m) => [m.id, m])));
	b.metrics.forEach((ref, i) => {
		const m = byId.get(ref.metric_id);
		const p = `${path}.metrics[${i}]`;
		if (!m) {
			ctx.error({
				path: p,
				code: "UNKNOWN_SOURCE",
				message: `metric ${ref.metric_id} is not on any of this bullet's sources`,
				token: ref.metric_id,
			});
		} else if (m.status === "estimated") {
			ctx.error({
				path: p,
				code: "ESTIMATED_METRIC",
				message: `metric ${m.id} is an unconfirmed estimate; run jh metrics confirm first`,
				token: m.value,
			});
		} else if (m.status === "rejected") {
			ctx.error({
				path: p,
				code: "NUMBER_UNSOURCED",
				message: `metric ${m.id} was rejected by the user`,
				token: m.value,
			});
		}
	});
}

function checkNumbers(
	ctx: Ctx,
	text: string,
	path: string,
	facts: Set<string>,
	estimates: Set<string>,
	allowed: Set<string>,
): void {
	for (const token of numericTokens(text)) {
		if (facts.has(token) || allowed.has(token)) continue;
		if (estimates.has(token)) {
			ctx.error({
				path,
				code: "ESTIMATED_METRIC",
				message: `"${token}" comes from an unconfirmed estimate`,
				token,
			});
		} else {
			ctx.error({
				path,
				code: "NUMBER_UNSOURCED",
				message: `"${token}" is not a confirmed metric on this bullet's sources`,
				token,
			});
		}
	}
}

function splitMetrics(sources: MasterBullet[]) {
	const all = sources.flatMap((s) => s.metrics);
	return {
		facts: metricTokens(all.filter((m) => m.status === "fact")),
		estimates: metricTokens(all.filter((m) => m.status === "estimated")),
	};
}

function checkBullet(
	ctx: Ctx,
	b: TBullet,
	role: MasterRole,
	path: string,
): void {
	const sources = resolveSources(ctx, b, role, path);
	checkMetricRefs(ctx, b, sources, path);
	const { facts, estimates } = splitMetrics(sources);
	checkNumbers(
		ctx,
		b.text,
		`${path}.text`,
		facts,
		estimates,
		yearsOf(role.start, role.end),
	);
	if (b.text.length > SOFT_BULLET_LIMIT) {
		ctx.warn({
			path: `${path}.text`,
			code: "BULLET_TOO_LONG",
			message: `${b.text.length} chars; keep bullets to ${SOFT_BULLET_LIMIT} (two lines)`,
		});
	}
}

function yearsAllowance(ctx: Ctx): Set<string> {
	const y = experienceYears(ctx.master, ctx.profile);
	return new Set([`${y}`, `${y}+`, `${y}yr`]);
}

/** Resolve summary-style source ids (master bullet ids or "profile:<key>"). */
function resolveSummarySources(
	ctx: Ctx,
	ids: readonly string[],
	path: string,
): MasterBullet[] {
	const sources: MasterBullet[] = [];
	ids.forEach((id, i) => {
		const p = `${path}[${i}]`;
		if (id.startsWith("profile:")) {
			const key = id.slice("profile:".length);
			if (ctx.profile && !(key in ctx.profile)) {
				ctx.error({
					path: p,
					code: "UNKNOWN_SOURCE",
					message: `profile has no key "${key}"`,
					token: id,
				});
			}
			return;
		}
		const entry = ctx.index.bullets.get(id);
		if (!entry)
			ctx.error({
				path: p,
				code: "UNKNOWN_SOURCE",
				message: `bullet ${id} is not in the master resume`,
				token: id,
			});
		else if (entry.bullet.retired)
			ctx.error({
				path: p,
				code: "RETIRED_SOURCE",
				message: `bullet ${id} is retired`,
				token: id,
			});
		else sources.push(entry.bullet);
	});
	return sources;
}

function checkSummaryAndHeadline(ctx: Ctx, r: TailoredResume): void {
	const sources = resolveSummarySources(
		ctx,
		r.summary.source_ids,
		"summary.source_ids",
	);
	const { facts, estimates } = splitMetrics(sources);
	const allowed = yearsAllowance(ctx);
	checkNumbers(ctx, r.summary.text, "summary.text", facts, estimates, allowed);
	(r.summary.highlights ?? []).forEach((h, i) => {
		const path = `summary.highlights[${i}]`;
		const own = resolveSummarySources(ctx, h.source_ids, `${path}.source_ids`);
		const m = splitMetrics(own);
		checkNumbers(ctx, h.text, `${path}.text`, m.facts, m.estimates, allowed);
		checkNumbers(ctx, h.label, `${path}.label`, m.facts, m.estimates, allowed);
	});
	checkNumbers(
		ctx,
		r.basics.headline,
		"basics.headline",
		new Set(),
		new Set(),
		allowed,
	);
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True when `tool` appears in `text` as a whole term (case-insensitive). */
export function mentionsTool(text: string, tool: string): boolean {
	const t = tool.trim();
	if (!t) return false;
	return new RegExp(`(^|[^A-Za-z0-9])${escapeRe(t)}($|[^A-Za-z0-9])`, "i").test(
		text,
	);
}

/**
 * The "Environment:" line may list only tools named in that role's bullets
 * or tagged in `skills` on those bullets' master sources.
 */
function checkEnvironment(ctx: Ctx, role: TRole, path: string): void {
	if (!role.environment?.length) return;
	const text = role.bullets.map((b) => b.text).join(" | ");
	const tags = new Set<string>();
	for (const b of role.bullets)
		for (const id of b.source_ids) {
			const e = ctx.index.bullets.get(id);
			if (e && !e.bullet.retired)
				for (const sk of e.bullet.skills) tags.add(normSkill(sk));
		}
	role.environment.forEach((tool, i) => {
		if (tags.has(normSkill(tool)) || mentionsTool(text, tool)) return;
		ctx.error({
			path: `${path}.environment[${i}]`,
			code: "ENV_UNKNOWN_TOOL",
			message: `"${tool}" is not named in this role's bullets or their source skills`,
			token: tool,
		});
	});
}

function checkIdentity(ctx: Ctx, r: TailoredResume): void {
	const id = ctx.profile?.identity;
	if (!id) return;
	if (r.basics.name.trim() !== id.name.trim())
		ctx.error({
			path: "basics.name",
			code: "FIXED_FACT_CHANGED",
			message: `name must be "${id.name}"`,
			token: r.basics.name,
		});
	if (r.basics.email.trim().toLowerCase() !== id.email.trim().toLowerCase())
		ctx.error({
			path: "basics.email",
			code: "FIXED_FACT_CHANGED",
			message: `email must be "${id.email}"`,
			token: r.basics.email,
		});
}

function checkSkills(ctx: Ctx, r: TailoredResume): void {
	const known = new Set([...allSkills(ctx.master, ctx.profile)].map(normTerm));
	r.skills.forEach((g, gi) => {
		g.items.forEach((item, ii) => {
			if (!known.has(normTerm(item)))
				ctx.error({
					path: `skills[${gi}].items[${ii}]`,
					code: "UNKNOWN_SKILL",
					message: `"${item}" is not in master skills, bullet skills or profile skills`,
					token: item,
				});
		});
	});
}

function sameRecord(a: object, b: object): boolean {
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const k of keys) {
		const x = (a as Record<string, unknown>)[k];
		const y = (b as Record<string, unknown>)[k];
		if (Array.isArray(x) || Array.isArray(y)) {
			if (JSON.stringify(x ?? null) !== JSON.stringify(y ?? null)) return false;
			continue;
		}
		if ((x ?? undefined) !== (y ?? undefined)) return false;
	}
	return true;
}

function checkEduCerts(ctx: Ctx, r: TailoredResume): void {
	r.education.forEach((e, i) => {
		if (!ctx.master.education.some((m) => sameRecord(m, e)))
			ctx.error({
				path: `education[${i}]`,
				code: "EDU_MISMATCH",
				message: `"${e.degree}, ${e.school}" does not exactly match a master education entry`,
			});
	});
	r.certifications.forEach((c, i) => {
		if (!ctx.master.certifications.some((m) => sameRecord(m, c)))
			ctx.error({
				path: `certifications[${i}]`,
				code: "CERT_MISMATCH",
				message: `"${c.name}" does not exactly match a master certification`,
			});
	});
	(r.publications ?? []).forEach((p, i) => {
		const { display_title, ...record } = p;
		if (!(ctx.master.publications ?? []).some((m) => sameRecord(m, record)))
			ctx.error({
				path: `publications[${i}]`,
				code: "PUB_MISMATCH",
				message: `"${p.title}" does not exactly match a master publication`,
			});
		else if (
			display_title !== undefined &&
			!isWordPrefix(display_title, p.title)
		)
			ctx.error({
				path: `publications[${i}].display_title`,
				code: "PUB_MISMATCH",
				message: `display_title "${display_title}" must be a whole-word prefix of the title (at least 4 words)`,
			});
	});
}

/** Every free-text field the reader sees, with its JSON path. */
function textFields(r: TailoredResume): { path: string; text: string }[] {
	const out = [
		{ path: "basics.headline", text: r.basics.headline },
		{ path: "summary.text", text: r.summary.text },
		...(r.summary.highlights ?? []).map((h, i) => ({
			path: `summary.highlights[${i}].text`,
			text: `${h.label}: ${h.text}`,
		})),
	];
	const add = (roles: TRole[], key: string) =>
		roles.forEach((role, ri) => {
			role.bullets.forEach((b, bi) => {
				out.push({ path: `${key}[${ri}].bullets[${bi}].text`, text: b.text });
			});
		});
	add(r.experience, "experience");
	add(r.projects, "projects");
	return out;
}

const PRONOUN_RE =
	/\b(?:I(?![/\-.&]\w)|[Mm]y|[Mm]e|[Ww]e|[Oo]ur|[Mm]yself|[Mm]ine)\b/;

function checkVoice(ctx: Ctx, r: TailoredResume): void {
	const banned = [
		...DEFAULT_BANNED_PHRASES,
		...(ctx.profile?.voice?.banned_phrases ?? []),
	].map((p) => p.toLowerCase());
	for (const { path, text } of textFields(r)) {
		const lower = text.toLowerCase();
		for (const phrase of banned) {
			if (phrase && lower.includes(phrase))
				ctx.warn({
					path,
					code: "BANNED_PHRASE",
					message: `avoid "${phrase}"`,
					token: phrase,
				});
		}
		const pronoun = PRONOUN_RE.exec(text);
		if (pronoun)
			ctx.warn({
				path,
				code: "PRONOUN",
				message: `drop first-person "${pronoun[0]}"; start with a verb`,
				token: pronoun[0],
			});
	}
}

/** Hyphen-like dashes compare equal so "CNN-Transformer" matches "CNN–Transformer". */
function dashWords(s: string): string[] {
	return s
		.replace(/[‐-―-]/g, "-")
		.replace(/[:,;.]+$/, "")
		.split(/\s+/)
		.filter(Boolean);
}

/** True when `short` is the first N (>= 4) whole words of `full`. */
export function isWordPrefix(short: string, full: string): boolean {
	const a = dashWords(short.trim());
	const b = dashWords(full.trim());
	if (a.length < 4 || a.length > b.length) return false;
	return a.every((w, i) => {
		const v = b[i] ?? "";
		return i === a.length - 1 ? v.replace(/[:,;.]+$/, "") === w : v === w;
	});
}

export const EM_DASH = String.fromCharCode(0x2014);

/** The user never wants em dashes (U+2014) anywhere on a resume. */
function checkEmDash(ctx: Ctx, r: TailoredResume): void {
	const fields = [
		...textFields(r),
		...r.skills.map((g, i) => ({
			path: `skills[${i}]`,
			text: `${g.group}: ${g.items.join(", ")}`,
		})),
		...r.experience.map((role, i) => ({
			path: `experience[${i}].environment`,
			text: (role.environment ?? []).join(", "),
		})),
		...(r.publications ?? []).map((p, i) => ({
			path: `publications[${i}].display_title`,
			text: p.display_title ?? "",
		})),
	];
	for (const { path, text } of fields)
		if (text.includes(EM_DASH))
			ctx.error({
				path,
				code: "EM_DASH",
				message: "em dash found; use a comma, colon or plain hyphen instead",
				token: EM_DASH,
			});
}

// ---------------------------------------------------------------- bold

/** Bold key terms (me/format-reference/resume-spec.md, "Bold key terms"). */
export const BOLD_RULES = {
	bullet: { min: 2, max: 4 },
	highlight: { min: 1, max: 2 },
	/** Bold characters may cover at most this share of a bullet or highlight. */
	maxRatio: 0.3,
} as const;

/** Inline bold markup is not allowed: bold lives in `emphasis` so `text` stays plain. */
const INLINE_MARKUP_RE = /\*\*|__|<\/?(?:b|strong)(?:\s[^>]*)?>/i;

/**
 * Numeric metric phrases in a text that must be bold: every number with a
 * unit or currency ("28%", "3x", "1,000+", "$2M", "45 minutes") and every
 * bare count ("150-case", "under 15"). Tech tokens (S3, K-12, Python 3.11)
 * and bare years (2024) are not metrics.
 */
export function metricSpans(
	text: string,
): { raw: string; start: number; end: number }[] {
	return scanNumbers(text)
		.filter((t) => !isTechToken(text, t))
		.filter(
			(t) => t.hasUnit || t.currency || !/^(?:19|20)\d{2}$/.test(t.digits),
		)
		.map((t) => ({ raw: t.raw, start: t.index, end: t.end }));
}

interface BoldOpts {
	min: number;
	max?: number;
	maxRatio?: number;
	missingCode: IssueCode;
	what: string;
}

/**
 * One text's bold spans: traceable (each phrase occurs in `text`, no
 * overlaps, no inline markup, so stripping bold gives back `text`), within
 * count and share limits, and covering every metric.
 */
function checkBoldText(
	ctx: Ctx,
	text: string,
	emphasis: readonly string[],
	path: string,
	o: BoldOpts,
): void {
	const markup = INLINE_MARKUP_RE.exec(text);
	if (markup)
		ctx.error({
			path: `${path}.text`,
			code: "BOLD_UNTRACEABLE",
			message: `inline markup "${markup[0]}" in text; keep text plain and list bold phrases in emphasis`,
			token: markup[0],
		});
	const { spans, missing, overlapping } = locateEmphasis(text, emphasis);
	for (const p of missing)
		ctx.error({
			path: `${path}.emphasis`,
			code: "BOLD_UNTRACEABLE",
			message: `emphasis "${p}" does not occur verbatim in the text`,
			token: p,
		});
	for (const p of overlapping)
		ctx.error({
			path: `${path}.emphasis`,
			code: "BOLD_UNTRACEABLE",
			message: `emphasis "${p}" overlaps another bold phrase; merge them into one`,
			token: p,
		});
	if (spans.length < o.min)
		ctx.error({
			path: `${path}.emphasis`,
			code: o.missingCode,
			message: `${o.what} has ${spans.length} bold span(s); bold at least ${o.min} key terms (main tools, the core concept, every metric)`,
		});
	if (o.max !== undefined && spans.length > o.max)
		ctx.error({
			path: `${path}.emphasis`,
			code: "BOLD_EXCESS",
			message: `${o.what} has ${spans.length} bold spans; at most ${o.max}`,
		});
	const boldChars = spans.reduce((n, [s, e]) => n + (e - s), 0);
	if (o.maxRatio !== undefined && text.length > 0) {
		const ratio = boldChars / text.length;
		if (ratio > o.maxRatio)
			ctx.error({
				path: `${path}.emphasis`,
				code: "BOLD_EXCESS",
				message: `bold covers ${Math.round(ratio * 100)}% of the ${o.what}; keep it under ${Math.round(o.maxRatio * 100)}% (bold the term, not the clause)`,
			});
	}
	for (const m of metricSpans(text)) {
		if (spans.some(([s, e]) => m.start >= s && m.end <= e)) continue;
		ctx.error({
			path: `${path}.emphasis`,
			code: "METRIC_NOT_BOLD",
			message: `metric "${m.raw}" is not bold; add the metric phrase (e.g. "${m.raw}" or the whole "N to M" range) to emphasis`,
			token: m.raw,
		});
	}
}

/** A highlight's label belongs in `label` (rendered bold), not inline in its text. */
const INLINE_LABEL_RE = /^\s*([A-Z][^:.;]{1,39}):\s/;

function checkBold(ctx: Ctx, r: TailoredResume): void {
	const bullet = (roles: TRole[], key: string) =>
		roles.forEach((role, ri) => {
			role.bullets.forEach((b, bi) => {
				checkBoldText(ctx, b.text, b.emphasis, `${key}[${ri}].bullets[${bi}]`, {
					...BOLD_RULES.bullet,
					maxRatio: BOLD_RULES.maxRatio,
					missingCode: "BOLD_MISSING",
					what: "bullet",
				});
			});
		});
	bullet(r.experience, "experience");
	bullet(r.projects, "projects");
	if (r.summary.text.trim())
		checkBoldText(ctx, r.summary.text, r.summary.emphasis, "summary", {
			min: 1,
			missingCode: "SUMMARY_BOLD_MISSING",
			what: "summary",
		});
	(r.summary.highlights ?? []).forEach((h, i) => {
		const path = `summary.highlights[${i}]`;
		const inline = INLINE_LABEL_RE.exec(h.text);
		if (!h.label.trim() || inline)
			ctx.error({
				path: inline ? `${path}.text` : `${path}.label`,
				code: "HIGHLIGHT_LABEL_NOT_BOLD",
				message: inline
					? `text starts with its own label "${inline[1]}:", which renders plain; put it in label (always bold) and start text with the substance`
					: "highlight needs a label; the label is what renders bold",
				token: inline?.[1],
			});
		checkBoldText(ctx, h.text, h.emphasis, path, {
			...BOLD_RULES.highlight,
			maxRatio: BOLD_RULES.maxRatio,
			missingCode: "BOLD_MISSING",
			what: "highlight",
		});
	});
}

function checkDuplicateBulletIds(ctx: Ctx, r: TailoredResume): void {
	const seen = new Set<string>();
	for (const [key, roles] of [
		["experience", r.experience],
		["projects", r.projects],
	] as const) {
		roles.forEach((role, ri) => {
			role.bullets.forEach((b, bi) => {
				if (seen.has(b.id))
					ctx.error({
						path: `${key}[${ri}].bullets[${bi}].id`,
						code: "SCHEMA",
						message: `duplicate bullet id ${b.id}`,
						token: b.id,
					});
				seen.add(b.id);
			});
		});
	}
}

function schemaIssues(err: {
	issues: { path: PropertyKey[]; message: string }[];
}): ValidationIssue[] {
	return err.issues.map((i) => ({
		path: i.path.map(String).join(".") || "$",
		code: "SCHEMA" as const,
		message: i.message,
	}));
}

/**
 * Validate a tailored draft against the master resume (Rule 2: experience is
 * fixed, wording is open). Errors fail the draft; warnings are advice.
 */
/**
 * The headline follows the JD title, but only within the user's targets:
 * warn when profile.targets.roles is set and the headline names none of them.
 */
function checkHeadlineTargets(ctx: Ctx, r: TailoredResume): void {
	const targets = ctx.profile?.targets?.roles ?? [];
	if (targets.length === 0) return;
	if (targets.some((t) => containsTitle(r.basics.headline, t))) return;
	ctx.warn({
		path: "basics.headline",
		code: "HEADLINE_OFF_TARGET",
		message: `headline "${r.basics.headline}" names none of your target roles (${targets.join(", ")}); confirm this title is one you want to pursue`,
		token: r.basics.headline,
	});
}

export function validateTailored(
	r: unknown,
	master: MasterResume,
	profile?: Profile,
): ValidationResult {
	const parsed = TailoredResume.safeParse(r);
	if (!parsed.success)
		return { ok: false, errors: schemaIssues(parsed.error), warnings: [] };
	const errors: ValidationIssue[] = [];
	const warnings: ValidationIssue[] = [];
	const ctx: Ctx = {
		master,
		profile,
		index: indexMaster(master),
		error: (i) => errors.push(i),
		warn: (i) => warnings.push(i),
	};
	const draft = parsed.data;
	checkDuplicateBulletIds(ctx, draft);
	checkIdentity(ctx, draft);
	draft.experience.forEach((role, i) => {
		checkRole(ctx, role, `experience[${i}]`);
	});
	draft.projects.forEach((role, i) => {
		checkRole(ctx, role, `projects[${i}]`);
	});
	checkSummaryAndHeadline(ctx, draft);
	checkHeadlineTargets(ctx, draft);
	checkSkills(ctx, draft);
	checkEduCerts(ctx, draft);
	checkVoice(ctx, draft);
	checkEmDash(ctx, draft);
	checkBold(ctx, draft);
	return { ok: errors.length === 0, errors, warnings };
}
