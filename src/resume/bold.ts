import type { JdKeywords } from "../ats/keywords.js";
import type { MasterResume, Profile } from "../me/schema.js";
import { locateEmphasis } from "../render/emphasis.js";
import type { TailoredResume, TRole } from "./schema.js";
import { BOLD_RULES, metricSpans } from "./validate.js";

/**
 * Deterministic bold baseline ("jh resume bold --suggest"): every metric
 * phrase first, then JD keywords (required before preferred, heavier first),
 * then the user's recorded skills, within the bold rules (count and share).
 * Agents start from this and adjust; the validator has the final word.
 */

export interface BoldSuggestion {
	path: string;
	kind: "bullet" | "highlight" | "summary";
	text: string;
	current: string[];
	suggested: string[];
	/** Fewer than the minimum could be found: add a core-concept phrase by hand. */
	short: boolean;
}

interface Candidate {
	term: string;
	rank: number;
}

const RANGE_GAP_RE =
	/^\s*(?:to|to under|to over|to below|to above|to about|to roughly|->|→|-|–|and)\s*$/i;

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Metric phrases of a text as [start, end): each number token, widened over a
 * trailing "+" and a glued "-word" ("150-case"), a following "years"/"yrs",
 * and merged across "N to M" style gaps ("45 minutes to under 15").
 */
export function metricPhrases(text: string): [number, number][] {
	const raw = metricSpans(text).map(({ start, end }) => {
		let e = end;
		const tail = /^(?:\+|-[A-Za-z]+|\s(?:years?|yrs?)\b)+/.exec(text.slice(e));
		if (tail) e += tail[0].length;
		return [start, e] as [number, number];
	});
	const out: [number, number][] = [];
	for (const span of raw) {
		const last = out[out.length - 1];
		if (last && RANGE_GAP_RE.test(text.slice(last[1], span[0])))
			last[1] = span[1];
		else if (last && span[0] < last[1]) last[1] = Math.max(last[1], span[1]);
		else out.push([...span]);
	}
	return out;
}

/** First whole-term, case-insensitive occurrence of `term`, as [start, end). */
function findTerm(text: string, term: string): [number, number] | null {
	const t = term.trim();
	if (t.length < 2) return null;
	const m = new RegExp(
		`(^|[^A-Za-z0-9])(${escapeRe(t)})(?=$|[^A-Za-z0-9])`,
		"i",
	).exec(text);
	if (!m) return null;
	const start = m.index + (m[1]?.length ?? 0);
	return [start, start + t.length];
}

/** Ranked bold candidates: JD required, JD preferred, then recorded skills. */
export function boldCandidates(
	master: MasterResume,
	profile?: Profile,
	keywords?: JdKeywords | null,
): Candidate[] {
	const out: Candidate[] = [];
	const seen = new Set<string>();
	const add = (term: string, rank: number) => {
		const k = term.trim().toLowerCase();
		if (k.length < 2 || seen.has(k)) return;
		seen.add(k);
		out.push({ term: term.trim(), rank });
	};
	const kw = (
		list: { term: string; aliases?: string[]; weight?: number }[],
		base: number,
	) =>
		[...list]
			.sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))
			.forEach((k) => {
				for (const t of [k.term, ...(k.aliases ?? [])])
					add(t, base + (3 - (k.weight ?? 1)));
			});
	if (keywords) {
		kw(keywords.required, 0);
		kw(keywords.preferred, 10);
	}
	const skills = [
		...master.skills,
		...master.roles.flatMap((r) =>
			r.bullets.filter((b) => !b.retired).flatMap((b) => b.skills),
		),
		...(profile?.skills?.expert ?? []),
		...(profile?.skills?.proficient ?? []),
		...(profile?.skills?.familiar ?? []),
	];
	for (const s of skills) add(s, 20);
	return out;
}

/** Fact metric phrases recorded in the master, usable verbatim as bold spans. */
function factPhrases(master: MasterResume): string[] {
	return master.roles
		.flatMap((r) => r.bullets)
		.flatMap((b) => b.metrics)
		.filter((m) => m.status === "fact")
		.flatMap((m) => [m.phrase, m.value])
		.filter((p) => p && p.length <= 40);
}

const LEAD_WORD_RE =
	/^(?:a|an|the|at|by|to|of|for|in|on|from|with|across|over|while|and)$|(?:ing|ed)$/i;

/** Drop leading articles, prepositions and verbs ("reaching 97% accuracy" -> "97% accuracy"), never past `limit`. */
function trimLead(
	text: string,
	start: number,
	end: number,
	limit: number,
): [number, number] {
	let s = start;
	for (;;) {
		const m = /^(\S+)\s+/.exec(text.slice(s, limit));
		if (!m?.[1] || !LEAD_WORD_RE.test(m[1])) break;
		s += m[0].length;
	}
	return [s, end];
}

/** Suggest emphasis phrases for one text. */
export function suggestFor(
	text: string,
	candidates: readonly Candidate[],
	facts: readonly string[],
	limits: { min: number; max: number; maxRatio?: number },
): { suggested: string[]; short: boolean } {
	const spans: [number, number][] = [];
	const budget = limits.maxRatio ? text.length * limits.maxRatio : Infinity;
	const used = () => spans.reduce((n, [s, e]) => n + (e - s), 0);
	const free = (s: number, e: number) =>
		!spans.some(([a, b]) => s < b && e > a);
	const take = (s: number, e: number, force = false) => {
		if (spans.length >= limits.max || !free(s, e)) return;
		if (!force && used() + (e - s) > budget) return;
		spans.push([s, e]);
	};
	// 1. Metrics (always): a recorded fact phrase when it covers the number, else the number phrase.
	for (const [s, e] of metricPhrases(text)) {
		const fact = facts
			.map((f) => [text.indexOf(f), f.length] as const)
			.find(([at, len]) => at >= 0 && at <= s && at + len >= e && len <= 32);
		if (fact) {
			const [fs, fe] = trimLead(text, fact[0], fact[0] + fact[1], s);
			take(fs, fe, true);
		} else take(s, e, true);
	}
	// 2. Key terms: JD keywords, then skills; longer spellings first within a rank.
	const ordered = [...candidates].sort(
		(a, b) => a.rank - b.rank || b.term.length - a.term.length,
	);
	for (const c of ordered) {
		if (spans.length >= limits.max) break;
		const hit = findTerm(text, c.term);
		if (hit) take(hit[0], hit[1]);
	}
	spans.sort((a, b) => a[0] - b[0]);
	// Keep only phrases whose first occurrence is the chosen span, so rendering matches.
	const suggested = spans
		.map(([s, e]) => text.slice(s, e))
		.filter((p, i, all) => all.indexOf(p) === i);
	const placed = locateEmphasis(text, suggested).spans.length;
	return { suggested, short: placed < limits.min };
}

function roleFields(
	roles: TRole[],
	key: string,
): { path: string; text: string; current: string[] }[] {
	return roles.flatMap((role, ri) =>
		role.bullets.map((b, bi) => ({
			path: `${key}[${ri}].bullets[${bi}]`,
			text: b.text,
			current: b.emphasis,
		})),
	);
}

/** Suggestions for every bullet, the summary and each highlight of a draft. */
export function suggestBold(
	r: TailoredResume,
	master: MasterResume,
	profile?: Profile,
	keywords?: JdKeywords | null,
): BoldSuggestion[] {
	const cands = boldCandidates(master, profile, keywords);
	const facts = factPhrases(master);
	const out: BoldSuggestion[] = [];
	const bulletLimits = { ...BOLD_RULES.bullet, maxRatio: BOLD_RULES.maxRatio };
	for (const f of [
		...roleFields(r.experience, "experience"),
		...roleFields(r.projects, "projects"),
	])
		out.push({
			...f,
			kind: "bullet",
			...suggestFor(f.text, cands, facts, bulletLimits),
		});
	if (r.summary.text.trim())
		out.push({
			path: "summary",
			kind: "summary",
			text: r.summary.text,
			current: r.summary.emphasis,
			...suggestFor(r.summary.text, cands, facts, {
				min: 1,
				max: 4,
				maxRatio: 0.25,
			}),
		});
	(r.summary.highlights ?? []).forEach((h, i) => {
		out.push({
			path: `summary.highlights[${i}]`,
			kind: "highlight",
			text: h.text,
			current: h.emphasis,
			...suggestFor(h.text, cands, facts, {
				...BOLD_RULES.highlight,
				maxRatio: BOLD_RULES.maxRatio,
			}),
		});
	});
	return out;
}

/** A copy of the draft with every emphasis list replaced by the suggestion. */
export function applyBold(
	r: TailoredResume,
	suggestions: readonly BoldSuggestion[],
): TailoredResume {
	const copy: TailoredResume = structuredClone(r);
	const by = new Map(suggestions.map((s) => [s.path, s.suggested]));
	const set = (roles: TRole[], key: string) =>
		roles.forEach((role, ri) => {
			role.bullets.forEach((b, bi) => {
				const s = by.get(`${key}[${ri}].bullets[${bi}]`);
				if (s) b.emphasis = s;
			});
		});
	set(copy.experience, "experience");
	set(copy.projects, "projects");
	const sum = by.get("summary");
	if (sum) copy.summary.emphasis = sum;
	(copy.summary.highlights ?? []).forEach((h, i) => {
		const s = by.get(`summary.highlights[${i}]`);
		if (s) h.emphasis = s;
	});
	return copy;
}
