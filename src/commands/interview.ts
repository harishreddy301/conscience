import type { Command } from "commander";
import { z } from "zod";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { action, emit, readJsonInput } from "../core/output.js";
import { artifactsDir } from "../core/paths.js";
import {
	getInterview,
	listInterviews,
	setInterviewPrep,
	withDb,
} from "../db/tracking.js";
import { isAllowedPrepPath, upsertInterviews } from "../tracking/interviews.js";
import {
	type InterviewRow,
	InterviewUpsertBatch,
	PrepStatus,
} from "../tracking/schemas.js";

const Id = z.coerce.number().int().positive();
const ListOpts = z.object({
	upcoming: z.boolean().optional(),
	days: z.coerce.number().int().min(1).max(365).default(14),
	prep: PrepStatus.optional(),
});
const DAY_MS = 86_400_000;

function humanInterviews(rows: InterviewRow[]): string {
	if (!rows.length) return "no interviews";
	return rows
		.map(
			(i) =>
				`${String(i.id).padStart(4)}  ${(i.start_at ?? "unscheduled").slice(0, 16).replace("T", " ")}Z  ${i.company_name}${i.role ? ` - ${i.role}` : ""}  [${i.round}, ${i.status}, prep ${i.prep_status}]`,
		)
		.join("\n");
}

export function register(program: Command): void {
	const iv = program
		.command("interview")
		.description("interviews synced from calendar and email");

	iv.command("upsert")
		.description(
			"upsert calendar events (JSON array or {items}); merges with email-sourced interviews within 30m",
		)
		.requiredOption("--file <path>", "JSON file, or - for stdin")
		.option("--json", "machine-readable output")
		.action(
			action(async (opts: { file: string; json?: boolean }) => {
				const items = InterviewUpsertBatch.parse(
					await readJsonInput(opts.file),
				);
				const res = await withDb((db) => upsertInterviews(db, items));
				audit({
					actor: "calendar-sync",
					action: "interview.upsert",
					detail: res,
				});
				emit(
					res,
					opts.json,
					(r: typeof res) =>
						`inserted ${r.inserted}, updated ${r.updated}, merged ${r.merged}`,
				);
			}),
		);

	iv.command("list")
		.description("list interviews")
		.option("--upcoming", "only interviews from now on")
		.option("--days <n>", "horizon in days with --upcoming", "14")
		.option("--prep <status>", "filter by prep status: none|queued|ready|done")
		.option("--json", "machine-readable output")
		.action(
			action(async (opts: Record<string, unknown> & { json?: boolean }) => {
				const f = ListOpts.parse(opts);
				const now = Date.now();
				const rows = await withDb((db) =>
					listInterviews(db, {
						prep: f.prep,
						...(f.upcoming
							? {
									fromIso: new Date(now).toISOString(),
									toIso: new Date(now + f.days * DAY_MS).toISOString(),
								}
							: {}),
					}),
				);
				emit(rows, opts.json, humanInterviews);
			}),
		);

	iv.command("prep <id>")
		.description(
			"set interview prep status (and the prep markdown path under artifacts)",
		)
		.requiredOption("--status <s>", "none|queued|ready|done")
		.option("--path <file>", "prep markdown; must be under <jhHome>/artifacts")
		.option("--json", "machine-readable output")
		.action(
			action(
				async (
					id: string,
					opts: { status: string; path?: string; json?: boolean },
				) => {
					const interviewId = Id.parse(id);
					const status = PrepStatus.parse(opts.status);
					if (opts.path && !isAllowedPrepPath(opts.path))
						throw new ValidationError(
							`prep path must be inside ${artifactsDir()}`,
						);
					const row = await withDb((db) => {
						if (!getInterview(db, interviewId))
							throw new NotFoundError(`interview ${interviewId} not found`);
						setInterviewPrep(db, interviewId, status, opts.path);
						return getInterview(db, interviewId) as InterviewRow;
					});
					emit(
						row,
						opts.json,
						(r: InterviewRow) =>
							`interview ${r.id}: prep ${r.prep_status}${r.prep_path ? ` (${r.prep_path})` : ""}`,
					);
				},
			),
		);
}
