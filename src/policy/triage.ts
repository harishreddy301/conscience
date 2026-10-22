import type { EffectivePolicy } from "./load.js";
import { resolved } from "./load.js";
import type { DecisionPolicy } from "./schema.js";

const DAY_MS = 86_400_000;

/** Lowercase words separated by single spaces, padded for whole-word `includes`. */
export function normWords(s: string): string {
	return ` ${s
		.toLowerCase()
		.replace(/[^a-z0-9+#]+/g, " ")
		.trim()} `;
}

export function containsPhrase(text: string, phrase: string): boolean {
	const p = normWords(phrase).trim();
	return p !== "" && normWords(text).includes(` ${p} `);
}

/** First track (in file order) whose title pattern appears in the title. */
export function trackOf(
	title: string,
	tracks: DecisionPolicy["tracks"],
): string | null {
	for (const [name, t] of Object.entries(tracks))
		if (t.title_patterns.some((p) => containsPhrase(title, p))) return name;
	return null;
}

function matchingTracks(
	title: string,
	tracks: DecisionPolicy["tracks"],
): string[] {
	return Object.entries(tracks)
		.filter(([, t]) => t.title_patterns.some((p) => containsPhrase(title, p)))
		.map(([n]) => n);
}

export interface TriageCandidate {
	app_id: number;
	company_id: number;
	company: string;
	title: string;
	status: string;
	posted_at: string | null;
	user_link: boolean;
}

export interface CompanyStats {
	/** Applications to this company that are tailored, held or submitted. */
	in_flight: number;
	/** Applications to this company already submitted. */
	applied: number;
}

export type TriageDecision = "include" | "review" | "skip";

export interface TriageResult {
	app_id: number;
	company: string;
	title: string;
	track: string | null;
	age_days: number | null;
	user_link: boolean;
	decision: TriageDecision;
	reasons: string[];
}

export interface TriageInput {
	candidates: readonly TriageCandidate[];
	companies: ReadonlyMap<number, CompanyStats>;
	/** App ids conscience judged a strong fit (unlocks strong_fit_days). */
	strong?: ReadonlySet<number>;
	now?: Date;
}

export function ageDays(postedAt: string | null, now: Date): number | null {
	if (!postedAt) return null;
	const t = Date.parse(postedAt);
	if (Number.isNaN(t)) return null;
	return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS));
}

/**
 * Recency verdict. age <= prefer: ok; <= strong_fit: ok for strong fits;
 * <= max: ok for user links only; older: skip. Unknown date: review.
 */
export function recencyVerdict(
	age: number | null,
	r: DecisionPolicy["triage"]["recency"],
	o: { strong: boolean; userLink: boolean },
): { decision: TriageDecision; reason?: string } {
	if (age === null)
		return { decision: "review", reason: "posting date unknown" };
	if (age > r.max_days)
		return {
			decision: "skip",
			reason: `posted ${age}d ago, older than ${r.max_days}d`,
		};
	if (age <= r.prefer_days || o.userLink) return { decision: "include" };
	if (age <= r.strong_fit_days)
		return o.strong
			? { decision: "include" }
			: {
					decision: "review",
					reason: `posted ${age}d ago: only strong fits past ${r.prefer_days}d`,
				};
	return {
		decision: "skip",
		reason: `posted ${age}d ago, past ${r.strong_fit_days}d (only user links up to ${r.max_days}d)`,
	};
}

function blocked(company: string, blocklist: readonly string[]): string | null {
	const c = normWords(company).replace(/ /g, "");
	for (const b of blocklist) {
		const k = normWords(b).replace(/ /g, "");
		if (k && c.includes(k)) return b;
	}
	return null;
}

function judge(
	c: TriageCandidate,
	e: EffectivePolicy,
	strong: boolean,
	now: Date,
): TriageResult {
	const p = e.policy;
	const r = resolved(e);
	const track = trackOf(c.title, p.tracks);
	const age = ageDays(c.posted_at, now);
	const base = {
		app_id: c.app_id,
		company: c.company,
		title: c.title,
		track,
		age_days: age,
		user_link: c.user_link,
	};
	const reasons: string[] = [];
	let decision: TriageDecision = "include";
	const worse = (d: TriageDecision, why: string) => {
		reasons.push(why);
		if (d === "skip" || (d === "review" && decision === "include"))
			decision = d;
	};

	const hit = blocked(c.company, r.company_blocklist);
	if (hit)
		worse(
			c.user_link ? "review" : "skip",
			`company on blocklist (${hit})${c.user_link ? "; the user linked it" : ""}`,
		);

	if (!c.user_link) {
		const excluded = matchingTracks(c.title, p.tracks).filter((t) =>
			p.triage.titles.exclude_tracks.includes(t),
		);
		if (excluded.length)
			worse("skip", `excluded track: ${excluded.join(", ")}`);
		const level = r.exclude_words.find((w) => containsPhrase(c.title, w));
		if (level) worse("skip", `title outside level band ("${level}")`);
		const onTarget =
			r.target_titles.some((t) => containsPhrase(c.title, t)) ||
			matchingTracks(c.title, p.tracks).some(
				(t) => !p.triage.titles.exclude_tracks.includes(t),
			);
		if (!onTarget) worse("skip", "title is not one of the targets");
	}

	const rec = recencyVerdict(age, p.triage.recency, {
		strong,
		userLink: c.user_link,
	});
	if (rec.reason) worse(rec.decision, rec.reason);
	return { ...base, decision, reasons };
}

/**
 * Deterministic triage of a candidate batch. Order: user links first (when
 * user_link_priority), then freshest; unknown dates last. Per-company caps are
 * applied in that order to candidates still included.
 */
export function triage(e: EffectivePolicy, input: TriageInput): TriageResult[] {
	const now = input.now ?? new Date();
	const strong = input.strong ?? new Set<number>();
	const pri = e.policy.triage.user_link_priority;
	const judged = input.candidates.map((c) => ({
		c,
		r: judge(c, e, strong.has(c.app_id), now),
	}));
	judged.sort((a, b) => {
		if (pri && a.c.user_link !== b.c.user_link) return a.c.user_link ? -1 : 1;
		const aa = a.r.age_days ?? Number.POSITIVE_INFINITY;
		const bb = b.r.age_days ?? Number.POSITIVE_INFINITY;
		if (aa !== bb) return aa - bb;
		return a.c.app_id - b.c.app_id;
	});

	const caps = e.policy.triage.per_company;
	const added = new Map<number, number>();
	for (const { c, r } of judged) {
		if (r.decision !== "include") continue;
		const n = added.get(c.company_id) ?? 0;
		if (c.user_link) {
			// The user asked for it: never capped, but it uses a slot.
			added.set(c.company_id, n + 1);
			continue;
		}
		const s = input.companies.get(c.company_id) ?? { in_flight: 0, applied: 0 };
		const room = Math.max(0, caps.max_total - s.in_flight);
		const allowed =
			s.applied > 0 ? Math.min(caps.max_new_if_applied, room) : room;
		if (n >= allowed) {
			r.decision = "skip";
			r.reasons.push(
				s.applied > 0
					? `company cap: ${s.in_flight} in flight, at most ${caps.max_new_if_applied} new once applied (max ${caps.max_total})`
					: `company cap: at most ${caps.max_total} per company`,
			);
			continue;
		}
		added.set(c.company_id, n + 1);
	}
	return judged.map((j) => j.r);
}
