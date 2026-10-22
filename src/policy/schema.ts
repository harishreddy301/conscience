import { z } from "zod";

/**
 * me/decision-policy.yaml (ADR-005). Every section has defaults, so an empty
 * file (or no file) still yields a complete policy. `prefault` makes nested
 * defaults parse through their own schema (zod 4 `default` would not).
 */

export const ESCALATE_KINDS = [
	"plugin_feature_or_code",
	"account_creation_signin_sso",
	"legal_consent_not_preapproved",
	"hard_fact_unknown",
	"spending_money",
	"withdraw_or_decline_offer_or_interview",
] as const;
export type EscalateKind = (typeof ESCALATE_KINDS)[number];

export const ELIGIBILITY_RULES = [
	"clearance",
	"citizen_only",
	"green_card_only",
	"no_sponsorship",
	"government_client",
] as const;
export type EligibilityRule = (typeof ELIGIBILITY_RULES)[number];

export const HM_VERDICTS = ["interview", "maybe", "reject"] as const;
export type HmVerdict = (typeof HM_VERDICTS)[number];

const Str = z.string().trim().min(1);

export const Track = z.object({
	title_patterns: z.array(Str).min(1),
	note: z.string().optional(),
});
export type Track = z.infer<typeof Track>;

export const Recency = z
	.object({
		prefer_days: z.number().int().positive().default(14),
		strong_fit_days: z.number().int().positive().default(21),
		max_days: z.number().int().positive().default(30),
	})
	.refine(
		(r) =>
			r.prefer_days <= r.strong_fit_days && r.strong_fit_days <= r.max_days,
		{ message: "need prefer_days <= strong_fit_days <= max_days" },
	);

export const Triage = z.object({
	recency: Recency.prefault({}),
	titles: z
		.object({
			include_from: z.enum(["targets", "none"]).default("targets"),
			include: z.array(Str).default([]),
			exclude_tracks: z.array(Str).default([]),
		})
		.prefault({}),
	level_band: z
		.object({
			seniority: z.array(Str).default([]),
			exclude_words: z.array(Str).default([]),
		})
		.prefault({}),
	per_company: z
		.object({
			max_total: z.number().int().positive().default(2),
			max_new_if_applied: z.number().int().nonnegative().default(1),
		})
		.prefault({}),
	company_blocklist: z.array(Str).default([]),
	user_link_priority: z.boolean().default(true),
});

export const EligibilityOverride = z.object({
	app_id: z.number().int().positive(),
	action: z.enum(["apply_truthfully"]),
	note: z.string().optional(),
});
export type EligibilityOverride = z.infer<typeof EligibilityOverride>;

export const Eligibility = z.object({
	skip_if: z.array(z.enum(ELIGIBILITY_RULES)).default([...ELIGIBILITY_RULES]),
	scan: z.array(z.enum(["jd", "form"])).default(["jd", "form"]),
	overrides: z.array(EligibilityOverride).default([]),
});

export const Questions = z.object({
	estimable: z
		.object({
			allow: z.boolean().default(true),
			style: z.enum(["conservative"]).default("conservative"),
			save_to: z
				.literal("profile.form_answers")
				.default("profile.form_answers"),
			mark: z.literal("estimate").default("estimate"),
		})
		.prefault({}),
	hard_fact_keys: z
		.array(Str)
		.default([
			"work_authorization",
			"sponsorship",
			"citizenship",
			"degrees",
			"employers",
			"dates",
			"job_titles",
			"certifications",
			"security_clearance",
			"criminal_history",
			"compensation_history",
			"references",
			"demographics",
		]),
});

export const AccountRule = z.enum(["logged_in_only", "skip", "guest_ok"]);

export const Preflight = z.object({
	browser: z.boolean().default(true),
	uploads_readable: z.boolean().default(true),
	daily_cap: z.number().int().positive().optional(),
	account_ats: z.record(z.string(), AccountRule).default({}),
});

export const Throughput = z.object({
	tailor_parallel: z.number().int().min(1).max(10).default(3),
	submit_parallel_tabs: z.number().int().min(1).max(10).default(3),
	order: z.array(z.enum(["fit", "recency"])).default(["fit", "recency"]),
	max_minutes: z.number().int().positive().default(240),
});

export const GateRule = z.object({
	verdicts: z.array(z.enum(HM_VERDICTS)).min(1),
	ats_min: z.number().int().min(0).max(100),
	recruiter_min: z.number().int().min(0).max(8).optional(),
});
export type GateRule = z.infer<typeof GateRule>;

export const Gates = z.object({
	default: GateRule.prefault({
		verdicts: ["interview"],
		ats_min: 80,
		recruiter_min: 6,
	}),
	by_track: z.record(z.string(), GateRule.partial()).default({}),
	layout: z.object({ required: z.boolean().default(true) }).prefault({}),
	factcheck_required: z.literal(true).default(true),
});

export const Submit = z.object({
	confirm: z.enum(["per_batch", "standing"]).default("per_batch"),
	set_by: z.string().optional(),
	set_at: z.string().optional(),
	quote: z.string().optional(),
});

export const Escalate = z.object({
	kinds: z.array(z.enum(ESCALATE_KINDS)).default([...ESCALATE_KINDS]),
	batch: z.enum(["once_per_run"]).default("once_per_run"),
});

/** Rules conscience and the writers apply that code does not evaluate. */
export const StandingRule = z.object({
	id: Str,
	scope: z.enum(["triage", "resume", "form", "any"]),
	rule: Str,
	source: z.string().optional(),
});
export type StandingRule = z.infer<typeof StandingRule>;

export const PolicyOp = z.object({
	op: z.enum(["set", "add", "remove"]),
	path: Str,
	value: z.unknown(),
});
export type PolicyOp = z.infer<typeof PolicyOp>;

export const Correction = z.object({
	rev: z.number().int().positive(),
	at: z.string(),
	actor: Str,
	ops: z.array(PolicyOp).min(1),
	quote: z.string().optional(),
	reason: z.string().optional(),
});
export type Correction = z.infer<typeof Correction>;

export const DecisionPolicy = z.object({
	version: z.literal(1).default(1),
	rev: z.number().int().nonnegative().default(0),
	updated_at: z.string().optional(),
	tracks: z.record(z.string(), Track).default({}),
	triage: Triage.prefault({}),
	eligibility: Eligibility.prefault({}),
	questions: Questions.prefault({}),
	preflight: Preflight.prefault({}),
	throughput: Throughput.prefault({}),
	gates: Gates.prefault({}),
	submit: Submit.prefault({}),
	escalate: Escalate.prefault({}),
	standing_rules: z.array(StandingRule).default([]),
	corrections: z.array(Correction).default([]),
});
export type DecisionPolicy = z.infer<typeof DecisionPolicy>;

/** Paths only the user may change (`jh policy record --actor user`). */
export const USER_ONLY_PREFIXES = ["submit", "eligibility.overrides"] as const;

/** Top-level keys `jh policy record` may write (never rev, corrections, version). */
export const WRITABLE_ROOTS = [
	"tracks",
	"triage",
	"eligibility",
	"questions",
	"preflight",
	"throughput",
	"gates",
	"submit",
	"escalate",
	"standing_rules",
] as const;
