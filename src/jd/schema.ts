import { z } from "zod";

/**
 * A short, structured glimpse of a job description, captured by the
 * ats-screener during /resume and stored per application (jd_snapshots).
 * It is JD data (untrusted): stored and compared, never followed.
 */

const Text = (max: number) => z.string().trim().min(1).max(max);

/** A must-have / nice-to-have: a short term ("Kafka") or {term, aliases}. */
export const JdTerm = z
	.union([
		Text(120),
		z.object({
			term: Text(120),
			aliases: z.array(Text(120)).max(10).default([]),
		}),
	])
	.transform((t) => (typeof t === "string" ? { term: t, aliases: [] } : t));
export type JdTerm = z.output<typeof JdTerm>;

export const JdSnapshot = z.object({
	title_posted: Text(200),
	seniority: Text(60).nullish(),
	must_haves: z.array(JdTerm).min(1).max(30),
	nice_to_haves: z.array(JdTerm).max(30).default([]),
	keywords: z.array(Text(120)).max(60).default([]),
	location: Text(200).nullish(),
	remote: Text(60).nullish(),
	salary: Text(120).nullish(),
	summary: Text(800),
	source_url: z
		.string()
		.trim()
		.max(2000)
		.regex(/^https?:\/\//i, "source_url must be http(s)")
		.nullish(),
	captured_at: z.iso.datetime({ offset: true }).optional(),
});
export type JdSnapshotInput = z.input<typeof JdSnapshot>;
export type JdSnapshot = z.output<typeof JdSnapshot>;

/** A stored snapshot, as read back from the database. */
export interface JdSnapshotRecord {
	application_id: number;
	title_posted: string;
	seniority: string | null;
	must_haves: JdTerm[];
	nice_to_haves: JdTerm[];
	keywords: string[];
	location: string | null;
	remote: string | null;
	salary: string | null;
	summary: string;
	source_url: string | null;
	captured_at: string;
}
