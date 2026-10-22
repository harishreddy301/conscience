import type { Command } from "commander";
import { z } from "zod";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { action, emit } from "../core/output.js";
import { setSetting } from "../db/repo.js";
import {
	deactivateBlock,
	getBlock,
	insertBlock,
	listBlocks,
	listTasks,
	updateBlock,
	withDb,
} from "../db/tracking.js";
import {
	ClockInBody,
	ClockOutBody,
	STUDY_SETTING_KEYS,
	type StudyBlock,
	StudyBlockInput,
	StudyBlockPatch,
	type StudySession,
	type StudySettingKey,
	type StudySummary,
	type StudyTask,
	StudyTaskBody,
} from "../tracking/schemas.js";
import {
	addStudyTask,
	clockIn,
	clockOut,
	finishStudyTask,
	studySummary,
} from "../tracking/study.js";

const Id = z.coerce.number().int().positive();

function fmtMinutes(m: number): string {
	const h = Math.floor(m / 60);
	return h ? `${h}h ${Math.round(m % 60)}m` : `${Math.round(m)}m`;
}

export function humanStudy(s: StudySummary): string {
	const lines = [
		s.open
			? `CLOCKED IN since ${s.open.started_at} (${fmtMinutes(s.open.elapsed_minutes)})${s.open.topic ? ` - ${s.open.topic}` : ""}`
			: "not clocked in",
	];
	for (const b of s.blocks) {
		const onTime = b.on_time === null ? "" : b.on_time ? ", on time" : ", late";
		lines.push(
			`block ${b.label} ${b.start_local}-${b.end_local}: ${b.state} (${fmtMinutes(b.minutes)}${onTime})`,
		);
	}
	lines.push(
		`today ${fmtMinutes(s.todayMinutes)} | streak ${s.streak} day(s) | week ${fmtMinutes(s.week.minutes)} / ${fmtMinutes(s.week.goalMinutes)} (${s.week.pct}%)`,
	);
	const open = s.tasks.filter((t) => !t.done_at);
	if (open.length)
		lines.push(`tasks: ${open.map((t) => `#${t.id} ${t.title}`).join("; ")}`);
	return lines.join("\n");
}

const humanSession = (s: StudySession): string =>
	`session ${s.id}: ${s.started_at} -> ${s.ended_at ?? "open"}${s.auto_closed ? " (auto-closed at max)" : ""}${s.block_id ? "" : " (outside any block)"}`;

const humanBlocks = (rows: StudyBlock[]): string =>
	rows.length
		? rows
				.map(
					(b) =>
						`${String(b.id).padStart(3)}  ${b.label}  ${b.start_local}-${b.end_local}  days ${b.days}${b.active ? "" : "  (inactive)"}`,
				)
				.join("\n")
		: "no study blocks";

const humanTasks = (rows: StudyTask[]): string =>
	rows.length
		? rows
				.map(
					(t) =>
						`${t.done_at ? "[x]" : "[ ]"} #${t.id} ${t.title}${t.planned_for ? ` (for ${t.planned_for})` : ""}`,
				)
				.join("\n")
		: "no tasks";

/** Resolve "grace_minutes" -> "study.grace_minutes"; validate the value. */
export function parseStudySetting(
	key: string,
	value: string,
): { key: StudySettingKey; value: string | number } {
	const full = (
		key in STUDY_SETTING_KEYS ? key : `study.${key}`
	) as StudySettingKey;
	const schema = STUDY_SETTING_KEYS[full];
	if (!schema)
		throw new ValidationError(`unknown setting: ${key}`, {
			allowed: Object.keys(STUDY_SETTING_KEYS),
		});
	return { key: full, value: schema.parse(value) };
}

function registerBlocks(study: Command): void {
	const blocks = study.command("blocks").description("manage study blocks");
	blocks
		.command("list")
		.option("--all", "include inactive blocks")
		.option("--json", "machine-readable output")
		.action(
			action(async (opts: { all?: boolean; json?: boolean }) => {
				emit(
					await withDb((db) => listBlocks(db, !opts.all)),
					opts.json,
					humanBlocks,
				);
			}),
		);
	blocks
		.command("add")
		.requiredOption("--label <s>", "block label")
		.requiredOption("--days <list>", "ISO weekdays, e.g. 1,2,3,4,5 (1=Mon)")
		.requiredOption("--start <HH:MM>", "local start time")
		.requiredOption("--end <HH:MM>", "local end time")
		.option("--json", "machine-readable output")
		.action(
			action(async (opts: Record<string, string> & { json?: boolean }) => {
				const b = StudyBlockInput.parse(opts);
				const row = await withDb((db) => getBlock(db, insertBlock(db, b)));
				emit(row, opts.json, (r: StudyBlock) => humanBlocks([r]));
			}),
		);
	blocks
		.command("edit <id>")
		.description("change a block's label, days or times (e.g. 06:00-08:00)")
		.option("--label <s>")
		.option("--days <list>")
		.option("--start <HH:MM>")
		.option("--end <HH:MM>")
		.option("--json", "machine-readable output")
		.action(
			action(
				async (
					id: string,
					opts: Record<string, string> & { json?: boolean },
				) => {
					const blockId = Id.parse(id);
					const { json: _json, ...rest } = opts;
					const patch = StudyBlockPatch.parse(rest);
					const row = await withDb((db) => {
						const cur = getBlock(db, blockId);
						if (!cur)
							throw new NotFoundError(`study block ${blockId} not found`);
						if (
							(patch.start ?? cur.start_local) >= (patch.end ?? cur.end_local)
						)
							throw new ValidationError("start must be before end");
						updateBlock(db, blockId, patch);
						return getBlock(db, blockId) as StudyBlock;
					});
					emit(row, opts.json, (r: StudyBlock) => humanBlocks([r]));
				},
			),
		);
	blocks
		.command("rm <id>")
		.description("deactivate a block (history is kept)")
		.option("--json", "machine-readable output")
		.action(
			action(async (id: string, opts: { json?: boolean }) => {
				const blockId = Id.parse(id);
				const changed = await withDb((db) => deactivateBlock(db, blockId));
				if (!changed)
					throw new NotFoundError(`study block ${blockId} not found`);
				emit(
					{ id: blockId, active: false },
					opts.json,
					() => `block ${blockId} deactivated`,
				);
			}),
		);
}

function registerTasks(study: Command): void {
	const task = study.command("task").description("study checklist");
	task
		.command("add <title>")
		.option("--for <date>", "planned date YYYY-MM-DD")
		.option("--json", "machine-readable output")
		.action(
			action(async (title: string, opts: { for?: string; json?: boolean }) => {
				const body = StudyTaskBody.parse({ title, planned_for: opts.for });
				const row = await withDb((db) => addStudyTask(db, body));
				emit(row, opts.json, (t: StudyTask) => humanTasks([t]));
			}),
		);
	task
		.command("list")
		.option("--all", "include tasks completed before today")
		.option("--json", "machine-readable output")
		.action(
			action(async (opts: { all?: boolean; json?: boolean }) => {
				const rows = await withDb((db) =>
					opts.all ? listTasks(db, { all: true }) : studySummary(db).tasks,
				);
				emit(rows, opts.json, humanTasks);
			}),
		);
	task
		.command("done <id>")
		.option("--json", "machine-readable output")
		.action(
			action(async (id: string, opts: { json?: boolean }) => {
				const row = await withDb((db) => finishStudyTask(db, Id.parse(id)));
				emit(row, opts.json, (t: StudyTask) => humanTasks([t]));
			}),
		);
}

export function register(program: Command): void {
	const study = program
		.command("study")
		.description("study clock: clock in/out, blocks, streak and weekly hours");

	study
		.command("in")
		.description("clock in")
		.option("--topic <s>", "what you are studying (<=120 chars)")
		.option("--json", "machine-readable output")
		.action(
			action(async (opts: { topic?: string; json?: boolean }) => {
				const b = ClockInBody.parse({ topic: opts.topic });
				const s = await withDb((db) =>
					clockIn(db, { topic: b.topic, source: "cli" }),
				);
				emit(s, opts.json, humanSession);
			}),
		);

	study
		.command("out")
		.description("clock out")
		.option("--notes <s>", "session notes (<=1000 chars)")
		.option("--json", "machine-readable output")
		.action(
			action(async (opts: { notes?: string; json?: boolean }) => {
				const b = ClockOutBody.parse({ notes: opts.notes });
				const s = await withDb((db) => clockOut(db, { notes: b.notes }));
				emit(s, opts.json, humanSession);
			}),
		);

	study
		.command("status")
		.description("today's blocks, open session, streak and week progress")
		.option("--json", "machine-readable output")
		.action(
			action(async (opts: { json?: boolean }) => {
				emit(await withDb((db) => studySummary(db)), opts.json, humanStudy);
			}),
		);

	study
		.command("set <key> <value>")
		.description(
			`set a study setting: ${Object.keys(STUDY_SETTING_KEYS).join(", ")} (study. prefix optional)`,
		)
		.option("--json", "machine-readable output")
		.action(
			action(async (key: string, value: string, opts: { json?: boolean }) => {
				const s = parseStudySetting(key, value);
				await withDb((db) => setSetting(db, s.key, s.value));
				audit({
					actor: "user",
					action: "study.set",
					target: s.key,
					detail: s.value,
				});
				emit(s, opts.json, () => `${s.key} = ${s.value}`);
			}),
		);

	registerBlocks(study);
	registerTasks(study);
}
