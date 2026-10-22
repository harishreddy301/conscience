import { z } from "zod";

const YEAR_MONTH = /^\d{4}-\d{2}$/;

/** One number attached to a master bullet. Only `fact` may reach a resume. */
export const Metric = z.object({
	id: z.string(),
	phrase: z.string(),
	value: z.string(),
	status: z.enum(["fact", "estimated", "rejected"]),
	derivation: z.string().optional(),
	source_ref: z.string(),
	confidence: z.enum(["high", "medium", "low"]).optional(),
});
export type Metric = z.infer<typeof Metric>;
export type MetricStatus = Metric["status"];

export const MasterBullet = z.object({
	id: z.string().regex(/^[a-z0-9-]+\.b\d{2,}$/),
	text: z.string(),
	skills: z.array(z.string()).default([]),
	fields: z.array(z.string()).default([]),
	source_refs: z.array(z.string()).default([]),
	metrics: z.array(Metric).default([]),
	retired: z.boolean().optional(),
});
export type MasterBullet = z.infer<typeof MasterBullet>;

export const MasterRole = z.object({
	id: z.string(),
	kind: z.enum(["role", "project"]).default("role"),
	employer: z.string(),
	/** Official title: fixed, used verbatim in application forms and background checks. */
	title: z.string(),
	/**
	 * Other titles the USER approved for this role (from experience front matter
	 * `title_variants:`). A tailored resume may display one of them instead of
	 * the official title; nothing else is allowed (TITLE_NOT_APPROVED).
	 */
	title_variants: z.array(z.string().min(1)).optional(),
	start: z.string().regex(YEAR_MONTH),
	end: z.union([z.literal("present"), z.string().regex(YEAR_MONTH)]),
	location: z.string().optional(),
	next_bullet: z.number().int().min(1),
	bullets: z.array(MasterBullet),
});
export type MasterRole = z.infer<typeof MasterRole>;

export const Education = z.object({
	school: z.string(),
	degree: z.string(),
	field: z.string(),
	year: z.string(),
	/** Optional; shown only when recorded by the user. */
	gpa: z.string().optional(),
	/** Optional relevant coursework, recorded by the user. */
	coursework: z.array(z.string().min(1)).optional(),
});
export type Education = z.infer<typeof Education>;

export const Certification = z.object({
	name: z.string(),
	issuer: z.string().optional(),
	year: z.string().optional(),
});
export type Certification = z.infer<typeof Certification>;

/** A paper or article the user authored or contributed to (copied verbatim to resumes). */
export const Publication = z.object({
	title: z.string().min(1),
	venue: z.string().min(1),
	year: z.string(),
	url: z.string().optional(),
	/** Short role note, e.g. "acknowledged contributor". */
	note: z.string().optional(),
});
export type Publication = z.infer<typeof Publication>;

export const MasterResume = z.object({
	version: z.literal(1),
	summary_seeds: z.array(z.string()).default([]),
	skills: z.array(z.string()).default([]),
	roles: z.array(MasterRole),
	education: z.array(Education).default([]),
	certifications: z.array(Certification).default([]),
	publications: z.array(Publication).default([]),
});
export type MasterResume = z.infer<typeof MasterResume>;

export const Profile = z
	.object({
		version: z.number(),
		identity: z.object({
			name: z.string(),
			email: z.string(),
			phone: z.string().optional(),
			location: z.string(),
			links: z.record(z.string(), z.string()).default({}),
		}),
		work_auth: z.unknown().optional(),
		targets: z
			.object({ roles: z.array(z.string()).default([]) })
			.passthrough()
			.optional(),
		skills: z
			.object({
				expert: z.array(z.string()).default([]),
				proficient: z.array(z.string()).default([]),
				familiar: z.array(z.string()).default([]),
			})
			.partial()
			.optional(),
		experience_years: z.number().optional(),
		voice: z
			.object({
				tone: z.string().optional(),
				banned_phrases: z.array(z.string()).default([]),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();
export type Profile = z.infer<typeof Profile>;

export const IntakeMetric = z.object({
	phrase: z.string(),
	value: z.string(),
	source_ref: z.string(),
});

export const IntakeBullet = z.object({
	match_id: z.string().optional(),
	text: z.string(),
	skills: z.array(z.string()),
	fields: z.array(z.string()),
	source_refs: z.array(z.string()).min(1),
	metrics: z.array(IntakeMetric),
});
export type IntakeBullet = z.infer<typeof IntakeBullet>;

export const IntakeRole = z.object({
	match_id: z.string().optional(),
	kind: z.enum(["role", "project"]),
	employer: z.string(),
	title: z.string(),
	/** Copied verbatim from the experience front matter `title_variants:` (user-approved). */
	title_variants: z.array(z.string().min(1)).optional(),
	start: z.string(),
	end: z.string(),
	location: z.string().optional(),
	source_refs: z.array(z.string()),
	bullets: z.array(IntakeBullet),
});
export type IntakeRole = z.infer<typeof IntakeRole>;

export const IntakeConflict = z.object({
	field: z.string(),
	values: z.array(z.string()),
	sources: z.array(z.string()),
});
export type IntakeConflict = z.infer<typeof IntakeConflict>;

/**
 * What resume-intake writes to me/.intake/draft.json. Intake metrics are always
 * status "fact" (stated verbatim in a source). Estimates come only via MetricProposal.
 */
export const IntakeDraft = z.object({
	roles: z.array(IntakeRole),
	education: MasterResume.shape.education,
	certifications: MasterResume.shape.certifications,
	publications: MasterResume.shape.publications,
	skills_seen: z.array(z.string()),
	conflicts: z.array(IntakeConflict),
});
export type IntakeDraft = z.infer<typeof IntakeDraft>;

/** What metric-miner writes; becomes an `estimated` metric until the user decides. */
export const MetricProposal = z.object({
	bullet_id: z.string(),
	phrase: z.string(),
	value: z.string(),
	derivation: z.string().min(5),
	source_ref: z.string(),
	confidence: z.enum(["high", "medium", "low"]),
});
export type MetricProposal = z.infer<typeof MetricProposal>;

export const MetricDecisionStatus = z.enum(["confirmed", "edited", "rejected"]);
export type MetricDecisionStatus = z.infer<typeof MetricDecisionStatus>;

export const MetricDecision = z.object({
	id: z.string(),
	bullet_id: z.string(),
	phrase: z.string(),
	value: z.string(),
	status: MetricDecisionStatus,
	derivation: z.string().optional(),
	decided_at: z.string(),
});
export type MetricDecision = z.infer<typeof MetricDecision>;

/** Append-only ledger of the user's metric decisions (me/confirmed-metrics.yaml). */
export const ConfirmedMetrics = z.object({
	version: z.literal(1),
	metrics: z.array(MetricDecision),
});
export type ConfirmedMetrics = z.infer<typeof ConfirmedMetrics>;

/** Front matter of me/experience/<id>.md (one role or project per file). */
export const ExperienceFrontMatter = z.object({
	kind: z.enum(["role", "project"]),
	employer: z.string().min(1),
	title: z.string().min(1),
	start: z.string().regex(YEAR_MONTH, "start must be YYYY-MM"),
	end: z.union([
		z.literal("present"),
		z.string().regex(YEAR_MONTH, "end must be YYYY-MM or present"),
	]),
	location: z.string().optional(),
	/**
	 * Other titles the user approves for this role on a tailored resume (for
	 * example "Data Platform Engineer" for an official "Data Engineer II").
	 * The official `title` stays fixed for application forms.
	 */
	title_variants: z.array(z.string().min(1)).optional(),
	/** Fixed facts the user settled during /intake; intake stops flagging them as conflicts. */
	confirmed_facts: z
		.array(z.enum(["employer", "title", "start", "end", "kind"]))
		.optional(),
});
export type ExperienceFrontMatter = z.infer<typeof ExperienceFrontMatter>;

/** Front matter of me/stories/<slug>.md (STAR stories for interviews). */
export const StoryFrontMatter = z.object({
	role_id: z.string().min(1),
	bullet_ids: z.array(z.string()).default([]),
	competencies: z.array(z.string()).default([]),
	last_used: z.union([z.string(), z.null()]).optional(),
});
export type StoryFrontMatter = z.infer<typeof StoryFrontMatter>;

/** Sections every experience README must contain (as `## <name>` headings). */
export const EXPERIENCE_SECTIONS = [
	"Context",
	"Team & scale",
	"What I did",
	"Tools",
	"Outcomes",
	"Numbers I'm unsure about",
	"Anything else",
] as const;

export function emptyMaster(): MasterResume {
	return {
		version: 1,
		summary_seeds: [],
		skills: [],
		roles: [],
		education: [],
		certifications: [],
		publications: [],
	};
}
