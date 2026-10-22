import type {
	OutcomeEmailRow,
	OutcomeEventRow,
	OutcomeRow,
} from "../db/learn.js";
import { TitleChoice } from "../db/learn.js";
import {
	classifyRoleFamily,
	normalizeKeyword,
	titleChoiceValues,
} from "./features.js";

export type Outcome = "positive" | "negative" | "ghosted" | "pending";
export type Strength = "weak" | "moderate";
export type Direction = "working" | "not_working" | "neutral";

export const DIMENSIONS = [
	"framing",
	"angle",
	"role_family",
	"source",
	"keyword",
	"bullet",
	"phrasing",
	"title_choice",
] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** Angles the resume-writer produces in best-of-N (TailoredResume.angle minus "revision"). */
export const DRAFT_ANGLES = [
	"impact",
	"skills-match",
	"domain-reframe",
] as const;

export const DEFAULTS = {
	ghostDays: 21,
	minN: 3,
	moderateN: 8,
	keywordTop: 30,
	explorationRatio: 0.2,
	z: 1.96,
} as const;

export interface AnalyzeOptions {
	now?: Date;
	ghostDays?: number;
	explorationRatio?: number;
}

const POSITIVE_STATUSES = new Set([
	"assessment",
	"interviewing",
	"offer",
	"accepted",
	"declined",
]);
const POSITIVE_EMAILS = new Set(["interview_invite", "assessment"]);
const RESPONSE_EMAILS = new Set([
	"interview_invite",
	"assessment",
	"rejection",
	"recruiter",
]);
const DAY_MS = 86_400_000;

export interface SampleFeatures {
	framing: string | null;
	angle: string | null;
	role_family: string;
	source: string;
	keywords: string[];
	bullet_ids: string[];
	phrasing: string[];
	/** titleChoiceValues() of the submitted variant; [] when not recorded. */
	title_choice?: string[];
}

export interface Sample {
	application_id: number;
	company: string;
	job_title: string;
	applied_at: string;
	outcome: Outcome;
	time_to_response_days: number | null;
	ats_score: number | null;
	has_variant: boolean;
	features: SampleFeatures;
}

export interface FeatureStat {
	dimension: Dimension;
	value: string;
	n: number;
	positives: number;
	rate: number;
	wilson_lower: number;
	lift: number | null;
	strength: Strength;
}

export interface Pattern extends FeatureStat {
	direction: Direction;
	claim: string;
}

export interface Totals {
	submitted: number;
	resolved: number;
	positive: number;
	negative: number;
	ghosted: number;
	pending: number;
}

export interface WeeklyPoint {
	week: string;
	submitted: number;
	resolved: number;
	positive: number;
	rate: number | null;
}

export interface Exploration {
	ratio: number;
	best_angle: string | null;
	best_angle_strength: Strength | null;
	explore_angles: string[];
	rule: string;
}

export interface Analysis {
	generated_at: string;
	params: {
		ghost_days: number;
		min_n: number;
		moderate_n: number;
		keyword_top: number;
		exploration_ratio: number;
	};
	totals: Totals;
	baseline: { rate: number | null; wilson_lower: number | null };
	median_time_to_response_days: number | null;
	samples_without_variant: number;
	weekly: WeeklyPoint[];
	features: Record<Dimension, FeatureStat[]>;
	patterns: Pattern[];
	exploration: Exploration;
}

/** Wilson score interval lower bound for k successes out of n trials. 0 when n = 0. */
export function wilsonLowerBound(k: number, n: number, z = DEFAULTS.z): number {
	if (n <= 0) return 0;
	const p = k / n;
	const z2 = z * z;
	const centre = p + z2 / (2 * n);
	const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
	return Math.max(0, (centre - margin) / (1 + z2 / n));
}

export function strengthFor(n: number): Strength {
	return n >= DEFAULTS.moderateN ? "moderate" : "weak";
}

function daysBetween(fromIso: string, toIso: string): number {
	return (Date.parse(toIso) - Date.parse(fromIso)) / DAY_MS;
}

function round(x: number, digits = 3): number {
	const f = 10 ** digits;
	return Math.round(x * f) / f;
}

export interface OutcomeInput {
	status: string;
	applied_at: string;
	events: ReadonlyArray<Pick<OutcomeEventRow, "kind" | "to_status" | "at">>;
	emails: ReadonlyArray<Pick<OutcomeEmailRow, "kind" | "received_at">>;
}

/** Timestamps (ISO) of employer responses at or after applied_at. */
function responseTimes(o: OutcomeInput): string[] {
	const appliedMs = Date.parse(o.applied_at);
	const times: string[] = [];
	for (const e of o.events) {
		const isResponse =
			e.kind === "interview" ||
			(e.kind === "transition" &&
				e.to_status !== null &&
				(POSITIVE_STATUSES.has(e.to_status) || e.to_status === "rejected"));
		if (isResponse && Date.parse(e.at) >= appliedMs) times.push(e.at);
	}
	for (const m of o.emails) {
		if (RESPONSE_EMAILS.has(m.kind) && Date.parse(m.received_at) >= appliedMs)
			times.push(m.received_at);
	}
	return times.sort((a, b) => Date.parse(a) - Date.parse(b));
}

function reachedPositive(o: OutcomeInput): boolean {
	if (POSITIVE_STATUSES.has(o.status)) return true;
	if (o.events.some((e) => e.kind === "interview")) return true;
	if (
		o.events.some(
			(e) =>
				e.kind === "transition" &&
				e.to_status !== null &&
				POSITIVE_STATUSES.has(e.to_status),
		)
	)
		return true;
	return o.emails.some((m) => POSITIVE_EMAILS.has(m.kind));
}

function wasRejected(o: OutcomeInput): boolean {
	if (o.status === "rejected") return true;
	if (
		o.events.some((e) => e.kind === "transition" && e.to_status === "rejected")
	)
		return true;
	return o.emails.some((m) => m.kind === "rejection");
}

/**
 * Label an application. A callback at any point wins (positive), then rejection (negative),
 * then ghosted (status ghosted, or >= ghostDays since applying with no response), else pending.
 */
export function deriveOutcome(
	o: OutcomeInput,
	now: Date,
	ghostDays: number = DEFAULTS.ghostDays,
): { outcome: Outcome; time_to_response_days: number | null } {
	const responses = responseTimes(o);
	const first = responses[0];
	const ttr =
		first !== undefined ? round(daysBetween(o.applied_at, first), 1) : null;
	if (reachedPositive(o))
		return { outcome: "positive", time_to_response_days: ttr };
	if (wasRejected(o))
		return { outcome: "negative", time_to_response_days: ttr };
	if (o.status === "ghosted")
		return { outcome: "ghosted", time_to_response_days: null };
	const silentDays = daysBetween(o.applied_at, now.toISOString());
	if (responses.length === 0 && silentDays >= ghostDays)
		return { outcome: "ghosted", time_to_response_days: null };
	return { outcome: "pending", time_to_response_days: ttr };
}

function parseList(json: string | null): string[] {
	if (!json) return [];
	try {
		const v: unknown = JSON.parse(json);
		return Array.isArray(v)
			? v.filter((x): x is string => typeof x === "string")
			: [];
	} catch {
		return [];
	}
}

function parseTitleChoice(json: string | null | undefined): string[] {
	if (!json) return [];
	try {
		const r = TitleChoice.safeParse(JSON.parse(json));
		return r.success ? titleChoiceValues(r.data) : [];
	} catch {
		return [];
	}
}

function groupBy<T>(
	rows: ReadonlyArray<T>,
	key: (r: T) => number,
): Map<number, T[]> {
	const m = new Map<number, T[]>();
	for (const r of rows) {
		const k = key(r);
		const list = m.get(k);
		if (list) list.push(r);
		else m.set(k, [r]);
	}
	return m;
}

/** Join rows, events and emails into labelled samples. Rows with no submission date are skipped. */
export function buildSamples(
	rows: ReadonlyArray<OutcomeRow>,
	events: ReadonlyArray<OutcomeEventRow>,
	emails: ReadonlyArray<OutcomeEmailRow>,
	opts: AnalyzeOptions = {},
): Sample[] {
	const now = opts.now ?? new Date();
	const ghostDays = opts.ghostDays ?? DEFAULTS.ghostDays;
	const eventsByApp = groupBy(events, (e) => e.application_id);
	const emailsByApp = groupBy(emails, (e) => e.application_id);
	const samples: Sample[] = [];
	for (const r of rows) {
		const appliedAt = r.applied_at ?? r.submitted_at;
		if (!appliedAt || Number.isNaN(Date.parse(appliedAt))) continue;
		const { outcome, time_to_response_days } = deriveOutcome(
			{
				status: r.status,
				applied_at: appliedAt,
				events: eventsByApp.get(r.application_id) ?? [],
				emails: emailsByApp.get(r.application_id) ?? [],
			},
			now,
			ghostDays,
		);
		samples.push({
			application_id: r.application_id,
			company: r.company,
			job_title: r.job_title,
			applied_at: appliedAt,
			outcome,
			time_to_response_days,
			ats_score: r.ats_score ?? r.final_ats,
			has_variant: r.keywords_json !== null,
			features: {
				framing: r.framing,
				angle: r.angle ?? r.final_angle,
				role_family: r.role_family ?? classifyRoleFamily(r.job_title),
				source: r.variant_source ?? r.app_source,
				keywords: parseList(r.keywords_json).map(normalizeKeyword),
				bullet_ids: parseList(r.bullet_ids_json),
				phrasing: parseList(r.phrasing_json),
				title_choice: parseTitleChoice(r.title_choice_json),
			},
		});
	}
	return samples;
}

export function isResolved(s: Sample): boolean {
	return s.outcome !== "pending";
}

function valuesFor(s: Sample, d: Dimension): string[] {
	const f = s.features;
	switch (d) {
		case "framing":
			return f.framing ? [f.framing] : [];
		case "angle":
			return f.angle ? [f.angle] : [];
		case "role_family":
			return [f.role_family];
		case "source":
			return [f.source];
		case "keyword":
			return [...new Set(f.keywords)];
		case "bullet":
			return [...new Set(f.bullet_ids)];
		case "phrasing":
			return [...new Set(f.phrasing)];
		case "title_choice":
			return [...new Set(f.title_choice ?? [])];
	}
}

/** The keywordTop most frequent keywords among resolved samples (ties alphabetical). */
export function topKeywords(
	resolved: ReadonlyArray<Sample>,
	limit: number = DEFAULTS.keywordTop,
): Set<string> {
	const counts = new Map<string, number>();
	for (const s of resolved) {
		for (const k of valuesFor(s, "keyword"))
			counts.set(k, (counts.get(k) ?? 0) + 1);
	}
	const ranked = [...counts.entries()].sort(
		(a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
	);
	return new Set(ranked.slice(0, limit).map(([k]) => k));
}

/** Callback stats per value of one dimension. Values with n < minN are never reported. */
export function featureStats(
	resolved: ReadonlyArray<Sample>,
	dimension: Dimension,
	baselineRate: number | null,
	allow?: ReadonlySet<string>,
): FeatureStat[] {
	const tally = new Map<string, { n: number; positives: number }>();
	for (const s of resolved) {
		for (const v of valuesFor(s, dimension)) {
			if (allow && !allow.has(v)) continue;
			const t = tally.get(v) ?? { n: 0, positives: 0 };
			t.n += 1;
			if (s.outcome === "positive") t.positives += 1;
			tally.set(v, t);
		}
	}
	const stats: FeatureStat[] = [];
	for (const [value, t] of tally) {
		if (t.n < DEFAULTS.minN) continue;
		const rate = t.positives / t.n;
		stats.push({
			dimension,
			value,
			n: t.n,
			positives: t.positives,
			rate: round(rate),
			wilson_lower: round(wilsonLowerBound(t.positives, t.n)),
			lift:
				baselineRate && baselineRate > 0 ? round(rate / baselineRate, 2) : null,
			strength: strengthFor(t.n),
		});
	}
	return stats.sort(
		(a, b) =>
			b.wilson_lower - a.wilson_lower ||
			b.n - a.n ||
			a.value.localeCompare(b.value),
	);
}

function pct(x: number): string {
	return `${Math.round(x * 100)}%`;
}

export function directionFor(s: FeatureStat): Direction {
	if (s.lift === null) return "neutral";
	if (s.lift >= 1.25 && s.positives > 0) return "working";
	if (s.lift <= 0.8) return "not_working";
	return "neutral";
}

export function describeStat(
	s: FeatureStat,
	baselineRate: number | null,
): string {
	const vs = baselineRate !== null ? ` vs ${pct(baselineRate)} baseline` : "";
	const lift = s.lift !== null ? `, lift ${s.lift}x` : "";
	return `${s.dimension} = ${s.value}: ${s.positives}/${s.n} callbacks (${pct(s.rate)}${vs}${lift}; n=${s.n}, ${s.strength})`;
}

/** Working patterns (by Wilson lower bound) first, then not-working ones (lowest lift first). */
export function rankPatterns(
	stats: ReadonlyArray<FeatureStat>,
	baselineRate: number | null,
): Pattern[] {
	const patterns = stats
		.map((s) => ({
			...s,
			direction: directionFor(s),
			claim: describeStat(s, baselineRate),
		}))
		.filter((p) => p.direction !== "neutral");
	const working = patterns
		.filter((p) => p.direction === "working")
		.sort((a, b) => b.wilson_lower - a.wilson_lower || b.n - a.n);
	const notWorking = patterns
		.filter((p) => p.direction === "not_working")
		.sort((a, b) => (a.lift ?? 0) - (b.lift ?? 0) || b.n - a.n);
	return [...working, ...notWorking];
}

/** Monday (UTC) of the ISO week containing iso, as YYYY-MM-DD. */
export function weekStart(iso: string): string {
	const d = new Date(iso);
	const day = (d.getUTCDay() + 6) % 7;
	const monday = new Date(
		Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day),
	);
	return monday.toISOString().slice(0, 10);
}

export function weeklySeries(samples: ReadonlyArray<Sample>): WeeklyPoint[] {
	const weeks = new Map<string, WeeklyPoint>();
	for (const s of samples) {
		const week = weekStart(s.applied_at);
		const w = weeks.get(week) ?? {
			week,
			submitted: 0,
			resolved: 0,
			positive: 0,
			rate: null,
		};
		w.submitted += 1;
		if (isResolved(s)) w.resolved += 1;
		if (s.outcome === "positive") w.positive += 1;
		weeks.set(week, w);
	}
	return [...weeks.values()]
		.map((w) => ({
			...w,
			rate: w.resolved > 0 ? round(w.positive / w.resolved) : null,
		}))
		.sort((a, b) => a.week.localeCompare(b.week));
}

export function totalsOf(samples: ReadonlyArray<Sample>): Totals {
	const t: Totals = {
		submitted: samples.length,
		resolved: 0,
		positive: 0,
		negative: 0,
		ghosted: 0,
		pending: 0,
	};
	for (const s of samples) {
		t[s.outcome] += 1;
		if (isResolved(s)) t.resolved += 1;
	}
	return t;
}

function median(xs: number[]): number | null {
	if (xs.length === 0) return null;
	const s = [...xs].sort((a, b) => a - b);
	const mid = Math.floor(s.length / 2);
	const hi = s[mid] as number;
	return s.length % 2 ? hi : round(((s[mid - 1] as number) + hi) / 2, 1);
}

/** Keep about `ratio` of drafts on a non-best angle so learning never locks in early. */
export function explorationPlan(
	angleStats: ReadonlyArray<FeatureStat>,
	ratio: number = DEFAULTS.explorationRatio,
): Exploration {
	const draftAngles: ReadonlySet<string> = new Set(DRAFT_ANGLES);
	const best = angleStats.find((s) => draftAngles.has(s.value));
	if (!best) {
		return {
			ratio,
			best_angle: null,
			best_angle_strength: null,
			explore_angles: [...DRAFT_ANGLES],
			rule: `Not enough resolved outcomes per angle (need n >= ${DEFAULTS.minN}). Rotate the winning angle evenly across ${DRAFT_ANGLES.join(", ")}.`,
		};
	}
	const explore = DRAFT_ANGLES.filter((a) => a !== best.value);
	return {
		ratio,
		best_angle: best.value,
		best_angle_strength: best.strength,
		explore_angles: explore,
		rule: `Prefer the ${best.value} draft (n=${best.n}, ${best.strength}) when it passes the gate, but for about ${pct(ratio)} of applications (app_id % ${Math.max(1, Math.round(1 / ratio))} == 0; jh learn status --app <id> says explore=true) submit the best gate-passing draft from ${explore.join(" or ")} instead.`,
	};
}

/** Deterministic exploration pick: every round(1/ratio)-th application id (ratio 0.2 -> app_id % 5 == 0), matching the conscience skill. */
export function shouldExplore(
	appId: number,
	ratio: number = DEFAULTS.explorationRatio,
): boolean {
	if (ratio <= 0) return false;
	const period = Math.max(1, Math.round(1 / ratio));
	return appId % period === 0;
}

/** Full deterministic analysis over labelled samples. */
export function analyze(
	samples: ReadonlyArray<Sample>,
	opts: AnalyzeOptions = {},
): Analysis {
	const now = opts.now ?? new Date();
	const ratio = opts.explorationRatio ?? DEFAULTS.explorationRatio;
	const resolved = samples.filter(isResolved);
	const totals = totalsOf(samples);
	const baselineRate =
		totals.resolved > 0 ? round(totals.positive / totals.resolved) : null;
	const keywords = topKeywords(resolved);
	const features = Object.fromEntries(
		DIMENSIONS.map((d) => [
			d,
			featureStats(
				resolved,
				d,
				baselineRate,
				d === "keyword" ? keywords : undefined,
			),
		]),
	) as Record<Dimension, FeatureStat[]>;
	const ttr = samples
		.map((s) => s.time_to_response_days)
		.filter((x): x is number => x !== null);
	return {
		generated_at: now.toISOString(),
		params: {
			ghost_days: opts.ghostDays ?? DEFAULTS.ghostDays,
			min_n: DEFAULTS.minN,
			moderate_n: DEFAULTS.moderateN,
			keyword_top: DEFAULTS.keywordTop,
			exploration_ratio: ratio,
		},
		totals,
		baseline: {
			rate: baselineRate,
			wilson_lower:
				totals.resolved > 0
					? round(wilsonLowerBound(totals.positive, totals.resolved))
					: null,
		},
		median_time_to_response_days: median(ttr),
		samples_without_variant: samples.filter((s) => !s.has_variant).length,
		weekly: weeklySeries(samples),
		features,
		patterns: rankPatterns(
			DIMENSIONS.flatMap((d) => features[d]),
			baselineRate,
		),
		exploration: explorationPlan(features.angle, ratio),
	};
}
