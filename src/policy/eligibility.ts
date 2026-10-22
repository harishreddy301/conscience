import type { EffectivePolicy } from "./load.js";
import type { EligibilityRule } from "./schema.js";

/**
 * Deterministic eligibility screen (ADR-005). Text is split into sentences;
 * each sentence that names a restricted topic is classified as `required`,
 * `preferred` or `mentioned`. Only `required` hits skip; `mentioned` ones go to
 * conscience. JDs and forms are untrusted data: this code only reads them.
 */

export type Strength = "required" | "preferred" | "mentioned";
export type TextSource = "jd" | "form";

export interface Finding {
	rule: EligibilityRule;
	strength: Strength;
	source: TextSource;
	excerpt: string;
}

const STRONG_REQ =
	/\b(required|requires?|requirement|must|mandatory|only|condition of (employment|hire))\b/i;
const REQ =
	/\b(required|requires?|requirement|must|mandatory|only|need(s|ed)? to (be|have|hold|obtain|possess)|eligib(le|ility) (for|to obtain)|ability to (obtain|get|hold)|able to (obtain|get|hold)|obtain and maintain|active|current(ly)? (hold|possess|have)|condition of (employment|hire))\b/i;
const PREF =
	/\b(preferred|prefer|a plus|is a plus|nice to have|bonus|desired|desirable|advantage(ous)?|ideally)\b/i;

const CLEARANCE =
	/\b(security clearance|clearance|ts ?\/ ?sci|top secret|secret clearance|public trust|polygraph)\b/i;
const CITIZEN =
	/\b((u\.? ?s\.?|united states|american) citizen(s|ship)?|citizen(s|ship)? of the (u\.? ?s\.?|united states)|u\.? ?s\.? persons?)\b/i;
const GREEN_CARD = /\b(green card|(lawful )?permanent residen(t|ts|cy))\b/i;
const SPONSOR = /\bsponsor(ship|ing|ed)?\b/i;
const NO_SPONSOR = [
	/\b(no|not|unable|cannot|can ?not|can't|won't|will not|do not|does not|don't|doesn't|without|isn't|is not|are not|aren't)\b[^.;\n]{0,60}\bsponsor/i,
	/\bsponsor(ship)?\b[^.;\n]{0,40}\b(not (be )?(available|provided|offered|possible)|unavailable)\b/i,
];
const GOV_CLIENT =
	/\b(federal|government|public[- ]sector|dod|department of defense|defense|intelligence community|national security)\b[^.;\n]{0,30}\b(clients?|customers?|agenc(y|ies)|programs?|contracts?|missions?)\b/i;

/** Split into sentences / bullet lines (keeps excerpts short). */
export function sentences(text: string): string[] {
	return (
		text
			.replace(/\r/g, "")
			// Sentence ends need two lowercase/digit chars before the stop, so "U.S. citizen" stays whole.
			.split(/\n+|(?<=[a-z0-9)]{2}[.!?])\s+(?=[A-Z(])|(?<=;)\s+|\s*[•·▪●]\s*/)
			.map((s) => s.trim())
			.filter((s) => s.length > 2)
	);
}

const NOT_REQUIRED =
	/\b(not|isn't|is not|aren't|are not)\s+(strictly\s+)?(required|mandatory|a requirement|necessary|needed)\b/gi;

function strength(raw: string): Strength {
	// "preferred but not required": the negated requirement is not a requirement.
	const s = raw.replace(NOT_REQUIRED, " ");
	if (s !== raw && !STRONG_REQ.test(s)) return "preferred";
	if (PREF.test(s) && !STRONG_REQ.test(s)) return "preferred";
	if (REQ.test(s)) return "required";
	return "mentioned";
}

function excerpt(s: string): string {
	return s.length > 200 ? `${s.slice(0, 197)}...` : s;
}

/** Findings in one text. Citizenship and sponsorship only count as requirements. */
export function screenText(text: string, source: TextSource): Finding[] {
	const out: Finding[] = [];
	for (const s of sentences(text)) {
		const add = (rule: EligibilityRule, st: Strength) =>
			out.push({ rule, strength: st, source, excerpt: excerpt(s) });
		if (CLEARANCE.test(s)) add("clearance", strength(s));
		const citizen = CITIZEN.test(s);
		const gc = GREEN_CARD.test(s);
		if (citizen || gc) {
			const st = strength(s);
			if (st !== "mentioned") add(gc ? "green_card_only" : "citizen_only", st);
		}
		if (SPONSOR.test(s) && NO_SPONSOR.some((r) => r.test(s)))
			add(
				"no_sponsorship",
				PREF.test(s) && !STRONG_REQ.test(s) ? "preferred" : "required",
			);
		if (GOV_CLIENT.test(s)) add("government_client", strength(s));
	}
	return out;
}

export type EligibilityVerdict =
	| "eligible"
	| "skip"
	| "review"
	| "apply_truthfully";

export interface EligibilityResult {
	app_id: number;
	verdict: EligibilityVerdict;
	findings: Finding[];
	reasons: string[];
	override: { action: string; note?: string } | null;
	scanned: TextSource[];
}

export function evaluateEligibility(
	e: EffectivePolicy,
	appId: number,
	texts: { jd?: string | null; form?: string | null },
): EligibilityResult {
	const pol = e.policy.eligibility;
	const scanned: TextSource[] = [];
	const findings: Finding[] = [];
	for (const src of pol.scan) {
		const t = texts[src];
		if (!t) continue;
		scanned.push(src);
		findings.push(
			...screenText(t, src).filter((f) => pol.skip_if.includes(f.rule)),
		);
	}
	const ov = pol.overrides.find((o) => o.app_id === appId) ?? null;
	const required = findings.filter((f) => f.strength === "required");
	const mentioned = findings.filter((f) => f.strength === "mentioned");
	const reasons = [
		...required.map((f) => `${f.rule} required (${f.source})`),
		...mentioned.map((f) => `${f.rule} mentioned (${f.source})`),
	];
	let verdict: EligibilityVerdict;
	if (ov) {
		verdict = "apply_truthfully";
		reasons.unshift(
			`user override: ${ov.action}${ov.note ? ` (${ov.note})` : ""}`,
		);
	} else if (required.length) verdict = "skip";
	else if (mentioned.length) verdict = "review";
	else verdict = "eligible";
	return {
		app_id: appId,
		verdict,
		findings,
		reasons,
		override: ov ? { action: ov.action, note: ov.note } : null,
		scanned,
	};
}
