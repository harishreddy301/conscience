import { z } from "zod";
import { isDateKey, isHhmm, isValidTimeZone } from "./time.js";

/** Any parseable timestamp, normalized to UTC ISO-8601. */
export const IsoInstant = z
	.string()
	.min(1)
	.refine((s) => !Number.isNaN(Date.parse(s)), "not a valid timestamp")
	.transform((s) => new Date(s).toISOString());

export const EmailKind = z.enum([
	"confirmation",
	"rejection",
	"interview_invite",
	"assessment",
	"recruiter",
	"other",
]);
export type EmailKind = z.infer<typeof EmailKind>;

export const InterviewRound = z.enum([
	"recruiter_screen",
	"hiring_manager",
	"technical",
	"assessment",
	"onsite",
	"final",
	"other",
]);
export type InterviewRound = z.infer<typeof InterviewRound>;

const HttpUrl = z
	.string()
	.max(2000)
	.refine((s) => /^https?:\/\//i.test(s), "must be an http(s) URL");

const TimeZoneName = z
	.string()
	.min(1)
	.max(64)
	.refine(isValidTimeZone, "unknown IANA time zone");

/** One classified Gmail message, produced by the email-tracker agent. */
export const EmailIngestItem = z.object({
	gmail_message_id: z.string().min(1).max(200),
	thread_id: z.string().min(1).max(200),
	received_at: IsoInstant,
	from: z.string().min(3).max(320),
	subject: z.string().max(1000).default(""),
	/** Longer snippets are truncated to the 500-char DB limit. */
	snippet: z
		.string()
		.optional()
		.transform((s) => (s === undefined ? undefined : s.slice(0, 500))),
	kind: EmailKind,
	confidence: z.number().min(0).max(1),
	company: z.string().min(1).max(200).optional(),
	role: z.string().min(1).max(200).optional(),
	application_id: z.number().int().positive().nullable().optional(),
	interview: z
		.object({
			start: IsoInstant,
			end: IsoInstant.optional(),
			tz: TimeZoneName.optional(),
			link: HttpUrl.optional(),
			round: InterviewRound.optional(),
		})
		.optional(),
	assessment: z
		.object({ due_at: IsoInstant.optional(), link: HttpUrl.optional() })
		.optional(),
});
export type EmailIngestItem = z.infer<typeof EmailIngestItem>;

/** Accepts a bare array or `{items:[...]}`. */
export const EmailIngestBatch = z
	.union([
		z.array(EmailIngestItem),
		z.object({ items: z.array(EmailIngestItem) }),
	])
	.transform((v) => (Array.isArray(v) ? v : v.items));

/** One calendar event, produced by the calendar-sync agent. */
export const InterviewUpsertItem = z.object({
	calendar_event_id: z.string().min(1).max(300),
	company: z.string().min(1).max(200),
	role: z.string().min(1).max(200).optional(),
	application_id: z.number().int().positive().nullable().optional(),
	round: InterviewRound.optional(),
	start: IsoInstant,
	end: IsoInstant,
	tz: TimeZoneName,
	location: z.string().max(500).optional(),
	meeting_link: HttpUrl.optional(),
	status: z.enum(["scheduled", "tentative", "cancelled"]).default("scheduled"),
});
export type InterviewUpsertItem = z.infer<typeof InterviewUpsertItem>;

export const InterviewUpsertBatch = z
	.union([
		z.array(InterviewUpsertItem),
		z.object({ items: z.array(InterviewUpsertItem) }),
	])
	.transform((v) => (Array.isArray(v) ? v : v.items));

export const PrepStatus = z.enum(["none", "queued", "ready", "done"]);
export type PrepStatus = z.infer<typeof PrepStatus>;

export const SyncKind = z.enum(["gmail", "calendar"]);
export type SyncKind = z.infer<typeof SyncKind>;

// ---- study clock ----

export const DaysList = z
	.string()
	.regex(/^[1-7](,[1-7])*$/, "days must be ISO weekdays like 1,2,3 (1=Mon)")
	.transform((s) =>
		[...new Set(s.split(",").map(Number))].sort((a, b) => a - b).join(","),
	);

export const Hhmm = z.string().refine(isHhmm, "time must be HH:MM (24h)");
export const DateKey = z.string().refine(isDateKey, "date must be YYYY-MM-DD");

export const StudyBlockInput = z
	.object({
		label: z.string().min(1).max(80),
		days: DaysList,
		start: Hhmm,
		end: Hhmm,
	})
	.refine((b) => b.start < b.end, "start must be before end");

export const StudyBlockPatch = z
	.object({
		label: z.string().min(1).max(80).optional(),
		days: DaysList.optional(),
		start: Hhmm.optional(),
		end: Hhmm.optional(),
	})
	.refine((p) => Object.keys(p).length > 0, "nothing to update");

export const ClockInBody = z.object({
	topic: z.string().trim().max(120).optional(),
});
export const ClockOutBody = z.object({
	notes: z.string().trim().max(1000).optional(),
});
export const StudyTaskBody = z.object({
	title: z.string().trim().min(1).max(200),
	planned_for: DateKey.optional(),
});
export const MetricDecisionBody = z.object({
	action: z.enum(["accept", "edit", "reject"]),
	value: z.string().min(1).max(200).optional(),
	phrase: z.string().min(1).max(300).optional(),
});

/** Settings writable via `jh study set`. Values are numbers except timezone. */
export const STUDY_SETTING_KEYS = {
	"study.grace_minutes": z.coerce.number().int().min(0).max(180),
	"study.streak_min_minutes": z.coerce.number().int().min(1).max(1440),
	"study.max_session_minutes": z.coerce.number().int().min(15).max(1440),
	"study.weekly_goal_hours": z.coerce.number().min(1).max(168),
	timezone: TimeZoneName,
} as const;
export type StudySettingKey = keyof typeof STUDY_SETTING_KEYS;

export interface StudyBlock {
	id: number;
	label: string;
	days: string;
	start_local: string;
	end_local: string;
	active: number;
	created_at: string;
}

export interface StudySession {
	id: number;
	block_id: number | null;
	started_at: string;
	ended_at: string | null;
	topic: string | null;
	notes: string | null;
	source: "cli" | "dashboard";
	auto_closed: number;
}

export interface StudyTask {
	id: number;
	title: string;
	session_id: number | null;
	planned_for: string | null;
	done_at: string | null;
	created_at: string;
}

export interface StudySettings {
	graceMinutes: number;
	streakMinMinutes: number;
	maxSessionMinutes: number;
	weeklyGoalHours: number;
}

export type BlockState = "upcoming" | "in_progress" | "done" | "missed";

export interface BlockStatus {
	block_id: number;
	label: string;
	start_local: string;
	end_local: string;
	start_at: string;
	end_at: string;
	state: BlockState;
	minutes: number;
	/** null until a session is attributed to the block. */
	on_time: boolean | null;
	clocked_in: boolean;
}

export interface StudySummary {
	tz: string;
	today: string;
	now: string;
	open: (StudySession & { elapsed_minutes: number }) | null;
	blocks: BlockStatus[];
	allBlocks: StudyBlock[];
	todayMinutes: number;
	streak: number;
	week: { minutes: number; goalMinutes: number; pct: number };
	settings: StudySettings;
	tasks: StudyTask[];
	recent: StudySession[];
}

export interface InterviewRow {
	id: number;
	calendar_event_id: string | null;
	application_id: number | null;
	company_id: number | null;
	company_name: string;
	role: string | null;
	round: InterviewRound;
	start_at: string | null;
	end_at: string | null;
	tz: string | null;
	location: string | null;
	meeting_link: string | null;
	status: "tentative" | "scheduled" | "cancelled" | "done";
	prep_status: PrepStatus;
	prep_path: string | null;
	source: "calendar" | "email" | "manual";
	source_email_id: number | null;
	updated_at: string;
}

export interface EmailRow {
	id: number;
	gmail_message_id: string;
	thread_id: string;
	received_at: string;
	from_addr: string;
	from_domain: string;
	subject: string;
	snippet: string | null;
	kind: EmailKind;
	confidence: number;
	application_id: number | null;
	company_id: number | null;
	extracted_json: string | null;
	ingested_at: string;
}

export interface SyncRunRow {
	id: number;
	kind: SyncKind;
	started_at: string;
	finished_at: string | null;
	ok: number | null;
	items_in: number | null;
	items_new: number | null;
	cursor: string | null;
	error: string | null;
	actor: string;
}

export interface SyncFreshness {
	kind: SyncKind;
	lastOkAt: string | null;
	lastRun: SyncRunRow | null;
	/** Error code of the latest run if it failed (e.g. connector_unavailable). */
	error: string | null;
	stale: boolean;
}

export interface Summary {
	generatedAt: string;
	study: StudySummary;
	interviews: (InterviewRow & { startsInMinutes: number | null })[];
	pipeline: Record<string, number>;
	readyToApply: {
		applicationId: number;
		company: string;
		title: string;
		atsScore: number | null;
		quality: string | null;
	}[];
	pendingMetrics: {
		count: number;
		items: {
			id: string;
			bullet_id: string;
			phrase: string;
			value: string;
			derivation: string | undefined;
		}[];
	};
	emails: {
		recent: (EmailRow & { company: string | null })[];
		needsLinking: number;
	};
	assessments: {
		emailId: number;
		applicationId: number | null;
		company: string | null;
		subject: string;
		dueAt: string | null;
		link: string | null;
	}[];
	sync: { gmail: SyncFreshness; calendar: SyncFreshness };
}
