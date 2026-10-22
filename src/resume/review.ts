import { z } from "zod";
import { ValidationError } from "../core/errors.js";

export const REVIEWERS = [
	"hiring-manager",
	"recruiter-screen",
	"ats-screener",
	"fact-checker",
] as const;
export type Reviewer = (typeof REVIEWERS)[number];

/** The eight recruiter-screen checks, in order. */
export const RECRUITER_CHECK_IDS = [
	"headline_title",
	"current_role_top",
	"years_inferable",
	"top5_skills_top",
	"first_bullet_quantified",
	"bullets_le_2_lines",
	"no_dense_paragraph",
	"contact_location",
] as const;

export const Finding = z.object({
	severity: z.enum(["blocker", "major", "minor"]),
	bullet_id: z.string().optional(),
	issue: z.string(),
	fix: z.string(),
});
export type Finding = z.infer<typeof Finding>;

export const ReviewReport = z.object({
	reviewer: z.enum(REVIEWERS),
	draft_id: z.string(),
	verdict: z.enum(["interview", "maybe", "reject", "pass", "fail"]),
	score: z.number().min(0).max(100),
	findings: z.array(Finding),
	top_fixes: z.array(z.string()).max(3),
	ranking: z.array(z.string()).optional(),
	checks: z
		.array(
			z.object({
				id: z.string(),
				pass: z.boolean(),
				note: z.string().optional(),
			}),
		)
		.optional(),
	must_haves: z
		.array(
			z.object({
				term: z.string(),
				evidence_bullet_id: z.string().nullable(),
			}),
		)
		.optional(),
	screen_question: z.string().optional(),
	notes: z.string().optional(),
});
export type ReviewReport = z.infer<typeof ReviewReport>;

export const GateResult = z.object({
	pass: z.boolean(),
	ats: z.number(),
	hm_verdict: z.string().nullable(),
	recruiter_passes: z.number(),
	valid: z.boolean(),
	factcheck: z.enum(["pass", "fail", "none"]),
	reasons: z.array(z.string()),
});
export type GateResult = z.infer<typeof GateResult>;

const VERDICTS_BY_REVIEWER: Record<Reviewer, readonly string[]> = {
	"hiring-manager": ["interview", "maybe", "reject"],
	"recruiter-screen": ["interview", "maybe", "reject", "pass", "fail"],
	"ats-screener": ["pass", "fail", "interview", "maybe", "reject"],
	"fact-checker": ["pass", "fail"],
};

/**
 * Parse a review and enforce reviewer-specific rules the shape alone cannot:
 * the fact-checker only says pass/fail, the hiring manager only
 * interview/maybe/reject, and recruiter-screen checks use the known ids.
 */
export function parseReview(input: unknown): ReviewReport {
	const rep = ReviewReport.parse(input);
	const allowed = VERDICTS_BY_REVIEWER[rep.reviewer];
	const issues: string[] = [];
	if (!allowed.includes(rep.verdict))
		issues.push(
			`${rep.reviewer} verdict must be one of ${allowed.join("|")} (got ${rep.verdict})`,
		);
	if (rep.reviewer === "recruiter-screen" && rep.checks) {
		const known = new Set<string>(RECRUITER_CHECK_IDS);
		for (const c of rep.checks)
			if (!known.has(c.id)) issues.push(`unknown recruiter check "${c.id}"`);
	}
	if (rep.reviewer === "fact-checker" && rep.verdict === "pass") {
		const blockers = rep.findings.filter((f) => f.severity === "blocker");
		if (blockers.length)
			issues.push("fact-checker cannot pass a draft with blocker findings");
	}
	if (issues.length)
		throw new ValidationError(issues.join("; "), { issues }, "invalid_review");
	return rep;
}

/** Number of passing recruiter-screen checks (distinct known ids). */
export function recruiterPasses(rep: ReviewReport | undefined): number {
	if (!rep?.checks) return 0;
	const known = new Set<string>(RECRUITER_CHECK_IDS);
	const passed = new Set(
		rep.checks.filter((c) => c.pass && known.has(c.id)).map((c) => c.id),
	);
	return passed.size;
}

/** Latest review per reviewer, given reviews in insertion order. */
export function latestByReviewer(
	reviews: readonly ReviewReport[],
): Partial<Record<Reviewer, ReviewReport>> {
	const out: Partial<Record<Reviewer, ReviewReport>> = {};
	for (const r of reviews) out[r.reviewer] = r;
	return out;
}

const SEVERITY_RANK = { blocker: 0, major: 1, minor: 2 } as const;

/**
 * Merge fixes from several reviews for the next revision: blockers first,
 * then each reviewer's top_fixes, then majors, deduped, at most `limit`.
 */
export function mergedFixes(
	reviews: readonly ReviewReport[],
	limit = 8,
): string[] {
	const findings = reviews
		.flatMap((r) => r.findings)
		.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
	const blockers = findings
		.filter((f) => f.severity === "blocker")
		.map((f) => fixLine(f));
	const tops = reviews.flatMap((r) => r.top_fixes);
	const majors = findings
		.filter((f) => f.severity === "major")
		.map((f) => fixLine(f));
	const seen = new Set<string>();
	const out: string[] = [];
	for (const fix of [...blockers, ...tops, ...majors]) {
		const key = fix.trim().toLowerCase();
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(fix);
		if (out.length >= limit) break;
	}
	return out;
}

function fixLine(f: Finding): string {
	return f.bullet_id ? `[${f.bullet_id}] ${f.fix}` : f.fix;
}
