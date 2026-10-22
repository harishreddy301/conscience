import type { Profile } from "../me/schema.js";
import { renderHtml, renderText } from "../render/index.js";
import {
	allRoles,
	shownTitle,
	type TailoredResume,
	type TRole,
} from "../resume/schema.js";
import { countKeyword, type JdKeywords, normTerm, tokens } from "./keywords.js";
import { parseChecks, type Rendered } from "./parse-checks.js";

export const ATS_PASS = 80;
export const ATS_FLOOR = 60;
export const KNOCKOUT_CAP = 40;
export const STUFFING_LIMIT = 4;
export const STUFFING_COST = 2;
export const PARSE_COST = 3;

export const MAX = {
	required: 35,
	context: 10,
	preferred: 10,
	title: 10,
	knockouts: 15,
	parse: 15,
	recency: 5,
} as const;

export interface AtsReport {
	total: number;
	components: {
		required: number;
		context: number;
		preferred: number;
		title: number;
		knockouts: number;
		parse: number;
		recency: number;
	};
	missing_required: string[];
	failed_knockouts: string[];
	parse_failures: string[];
	stuffing: { term: string; count: number }[];
}

interface Kw {
	term: string;
	aliases: string[];
	weight: number;
}

/** Token views of the resume used by every component. */
interface Corpus {
	all: string[];
	/** Writer-controlled text only (no education or certification names). */
	free: string[];
	bullets: string[];
	recent: string[];
}

function roleTokens(role: TRole): string[] {
	return role.bullets.flatMap((b) => [...tokens(b.text), "|"]);
}

/** Most recent role: "present" first, then latest end, then latest start. */
export function mostRecentRole(r: TailoredResume): TRole | undefined {
	const key = (role: TRole) =>
		`${role.end === "present" ? "9999-99" : role.end}|${role.start}`;
	return [...r.experience].sort((a, b) => key(b).localeCompare(key(a)))[0];
}

const toTokens = (parts: string[]) =>
	// "|" separators stop a phrase from matching across two fields.
	parts.flatMap((p) => [...tokens(p), "|"]);

function buildCorpus(r: TailoredResume): Corpus {
	const free: string[] = [
		r.basics.headline,
		r.summary.text,
		...(r.summary.highlights ?? []).map((h) => `${h.label}: ${h.text}`),
		...r.skills.flatMap((g) => [g.group, ...g.items]),
		...allRoles(r).flatMap((role) => [
			shownTitle(role),
			...role.bullets.map((b) => b.text),
		]),
	];
	const fixed = [
		...r.education.map((e) => `${e.degree} ${e.field} ${e.school}`),
		...r.certifications.map((c) => `${c.name} ${c.issuer ?? ""}`),
	];
	// "Environment:" lines may only restate tools from the role's own bullets
	// (validate: ENV_UNKNOWN_TOOL), so they count for matching but not stuffing.
	const environment = allRoles(r)
		.filter((role) => role.environment?.length)
		.map((role) => (role.environment ?? []).join(", "));
	const freeTokens = toTokens(free);
	const all = [...freeTokens, ...toTokens(fixed), ...toTokens(environment)];
	const bullets = allRoles(r).flatMap(roleTokens);
	const recentRole = mostRecentRole(r);
	return {
		all,
		free: freeTokens,
		bullets,
		recent: recentRole ? roleTokens(recentRole) : [],
	};
}

function weightedShare(terms: Kw[], hit: (k: Kw) => boolean): number {
	const total = terms.reduce((s, k) => s + k.weight, 0);
	if (total === 0) return 1;
	return terms.filter(hit).reduce((s, k) => s + k.weight, 0) / total;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function titleScore(r: TailoredResume, kw: JdKeywords): number {
	const wanted = (kw.titles.length ? kw.titles : [r.job.title])
		.map(normTerm)
		.filter(Boolean);
	const headline = normTerm(r.basics.headline);
	if (wanted.some((t) => ` ${headline} `.includes(` ${t} `))) return MAX.title;
	const recentRole = mostRecentRole(r);
	const recent = normTerm(recentRole ? shownTitle(recentRole) : "");
	if (wanted.some((t) => t === recent)) return MAX.title * 0.7;
	const overlap = (a: string, b: string) => {
		const x = new Set(a.split(" "));
		const y = b.split(" ").filter(Boolean);
		return y.length ? y.filter((w) => x.has(w)).length / y.length : 0;
	};
	const best = Math.max(
		0,
		...wanted.map((t) => Math.max(overlap(headline, t), overlap(recent, t))),
	);
	return best >= 0.5 ? MAX.title * 0.5 : 0;
}

// ---------------------------------------------------------------- knockouts

const YM = /^(\d{4})-(\d{2})$/;

function monthIndex(ym: string, now: Date): number | null {
	if (ym === "present") return now.getUTCFullYear() * 12 + now.getUTCMonth();
	const m = YM.exec(ym);
	return m ? Number(m[1]) * 12 + Number(m[2]) - 1 : null;
}

/** Years of role experience shown on the resume (overlaps counted once). */
export function resumeYears(r: TailoredResume, now = new Date()): number {
	const spans = r.experience
		.filter((x) => x.kind === "role")
		.map((x) => [monthIndex(x.start, now), monthIndex(x.end, now)] as const)
		.filter(
			(s): s is readonly [number, number] => s[0] !== null && s[1] !== null,
		)
		.map(([s, e]) => [s, e + 1] as const)
		.sort((a, b) => a[0] - b[0]);
	let total = 0;
	let end = Number.NEGATIVE_INFINITY;
	for (const [s, e] of spans) {
		const from = Math.max(s, end);
		if (e > from) total += e - from;
		end = Math.max(end, e);
	}
	return Math.floor(total / 12);
}

const DEGREE_LEVELS: ReadonlyArray<[RegExp, number]> = [
	[/\b(ph\s?d|doctor(ate)?\w*|dphil)\b/, 4],
	[/\b(masters?|ms|msc|mba|meng|mtech|mca)\b/, 3],
	[/\b(bachelors?|bs|bsc|ba|beng|btech|bca|undergraduate)\b/, 2],
	[/\b(associates?)\b/, 1],
];

function degreeLevel(s: string): number {
	const t = s
		.toLowerCase()
		.replace(/[.'’]/g, "")
		.replace(/[^a-z ]+/g, " ");
	for (const [re, level] of DEGREE_LEVELS) if (re.test(t)) return level;
	return 0;
}

function flatten(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (typeof v !== "object") return String(v);
	if (Array.isArray(v)) return v.map(flatten).join(" ");
	return Object.entries(v as Record<string, unknown>)
		.map(([k, x]) => `${k} ${flatten(x)}`)
		.join(" ");
}

function needsSponsorship(workAuth: unknown): boolean {
	if (!workAuth || typeof workAuth !== "object")
		return /\bneeds? sponsor/i.test(flatten(workAuth));
	for (const [k, v] of Object.entries(workAuth as Record<string, unknown>)) {
		if (/sponsor/i.test(k) && /(needs?|requires?)/i.test(k) && v === true)
			return true;
		if (typeof v === "object" && needsSponsorship(v)) return true;
	}
	return false;
}

const STOP = new Set(["and", "or", "the", "in", "of", "a", "an", "usa", "us"]);

function locationOk(
	req: string,
	r: TailoredResume,
	profile?: Profile,
): boolean {
	const want = normTerm(req);
	if (/\b(remote|anywhere)\b/.test(want)) return true;
	const have = normTerm(
		`${r.basics.location} ${profile?.identity.location ?? ""}`,
	);
	const words = new Set(have.split(" "));
	return want
		.split(" ")
		.some((w) => w.length > 1 && !STOP.has(w) && words.has(w));
}

/** Evaluate JD knockouts; returns human-readable failures. */
export function knockoutFailures(
	r: TailoredResume,
	kw: JdKeywords,
	profile?: Profile,
): { checked: number; failed: string[] } {
	const k = kw.knockouts;
	const failed: string[] = [];
	let checked = 0;
	if (k.min_years !== undefined) {
		checked++;
		const years = Math.max(resumeYears(r), profile?.experience_years ?? 0);
		if (years < k.min_years)
			failed.push(`min_years: needs ${k.min_years}, resume shows ${years}`);
	}
	if (k.degree) {
		checked++;
		const need = degreeLevel(k.degree);
		const have = Math.max(0, ...r.education.map((e) => degreeLevel(e.degree)));
		const text = normTerm(
			r.education.map((e) => `${e.degree} ${e.field}`).join(" "),
		);
		const ok = need > 0 ? have >= need : text.includes(normTerm(k.degree));
		if (!ok) failed.push(`degree: needs ${k.degree}`);
	}
	if (k.work_auth) {
		checked++;
		const wa = profile?.work_auth;
		const noSponsor = /sponsor/i.test(k.work_auth);
		const citizen = /citizen/i.test(k.work_auth);
		if (
			(noSponsor && needsSponsorship(wa)) ||
			(citizen && wa !== undefined && !/citizen/i.test(flatten(wa)))
		)
			failed.push(`work_auth: ${k.work_auth}`);
	}
	if (k.location) {
		checked++;
		if (!locationOk(k.location, r, profile))
			failed.push(`location: ${k.location}`);
	}
	if (k.clearance) {
		checked++;
		const text = `${flatten(profile?.work_auth)} ${r.certifications.map((c) => c.name).join(" ")} ${r.summary.text}`;
		if (!/clearance|secret|ts\/sci/i.test(text))
			failed.push(`clearance: ${k.clearance}`);
	}
	return { checked, failed };
}

// ---------------------------------------------------------------- scoring

function stuffingOf(corpus: Corpus, terms: Kw[]) {
	return terms
		.map((k) => ({ term: k.term, count: countKeyword(corpus.free, k) }))
		.filter((s) => s.count > STUFFING_LIMIT);
}

function parseScore(r: TailoredResume, rendered?: Rendered) {
	const view = rendered ?? { html: renderHtml(r), text: renderText(r) };
	const failures = parseChecks(view);
	return {
		failures,
		points: Math.max(0, MAX.parse - PARSE_COST * failures.length),
	};
}

/**
 * Score a tailored resume against JD keywords on the 100-point rubric:
 * required 35, context 10, preferred 10, title 10, knockouts 15, parse 15,
 * recency 5. A failed knockout caps the total at 40; each use of a term past
 * 4 costs 2 points.
 */
export function scoreResume(
	r: TailoredResume,
	kw: JdKeywords,
	rendered?: Rendered,
	profile?: Profile,
): AtsReport {
	const corpus = buildCorpus(r);
	const required = kw.required as Kw[];
	const preferred = kw.preferred as Kw[];
	const found = (k: Kw) => countKeyword(corpus.all, k) > 0;
	const inBullets = (k: Kw) => countKeyword(corpus.bullets, k) > 0;
	const inRecent = (k: Kw) => countKeyword(corpus.recent, k) > 0;

	const requiredFound = required.filter(found);
	const ko = knockoutFailures(r, kw, profile);
	const parse = parseScore(r, rendered);
	const recencyShare =
		required.length === 0
			? 1
			: requiredFound.length === 0
				? 0
				: weightedShare(requiredFound, inRecent);

	const components = {
		required: round1(MAX.required * weightedShare(required, found)),
		context: round1(
			MAX.context *
				(required.length === 0
					? 1
					: weightedShare(required, (k) => found(k) && inBullets(k))),
		),
		preferred: round1(MAX.preferred * weightedShare(preferred, found)),
		title: round1(titleScore(r, kw)),
		knockouts: round1(
			ko.checked === 0
				? MAX.knockouts
				: (MAX.knockouts * (ko.checked - ko.failed.length)) / ko.checked,
		),
		parse: parse.points,
		recency: round1(MAX.recency * recencyShare),
	};
	const stuffing = stuffingOf(corpus, [...required, ...preferred]);
	const penalty = stuffing.reduce(
		(s, x) => s + STUFFING_COST * (x.count - STUFFING_LIMIT),
		0,
	);
	const raw = Object.values(components).reduce((s, n) => s + n, 0) - penalty;
	let total = Math.max(0, Math.min(100, Math.round(raw)));
	if (ko.failed.length) total = Math.min(total, KNOCKOUT_CAP);

	return {
		total,
		components,
		missing_required: required.filter((k) => !found(k)).map((k) => k.term),
		failed_knockouts: ko.failed,
		parse_failures: parse.failures,
		stuffing,
	};
}
