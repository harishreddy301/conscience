import type { Command } from "commander";
import { z } from "zod";
import { audit } from "../core/audit.js";
import {
	ConflictError,
	NotFoundError,
	ValidationError,
} from "../core/errors.js";
import { action, emit } from "../core/output.js";
import type { Db } from "../db/index.js";
import {
	finishSyncRun,
	getSyncRun,
	insertSyncRun,
	lastOkCursor,
	withDb,
} from "../db/tracking.js";
import {
	type SyncFreshness,
	SyncKind,
	type SyncRunRow,
} from "../tracking/schemas.js";
import { syncFreshness } from "../tracking/summary.js";

const Id = z.coerce.number().int().positive();
const Count = z.coerce.number().int().min(0);
const ErrorCode = z
	.string()
	.regex(
		/^[a-z][a-z0-9_]{1,63}$/,
		"error must be a snake_case code like connector_unavailable",
	);

const EndOpts = z
	.object({
		ok: z.boolean().optional(),
		items: Count.optional(),
		new: Count.optional(),
		cursor: z.string().min(1).max(500).optional(),
		error: ErrorCode.optional(),
	})
	.refine(
		(o) => Boolean(o.ok) !== Boolean(o.error),
		"pass exactly one of --ok or --error",
	)
	.refine((o) => !o.ok || o.items !== undefined, "--ok needs --items <n>");

export function beginSync(db: Db, kind: SyncKind, actor: string) {
	const runId = insertSyncRun(db, kind, actor);
	return { runId, kind, cursor: lastOkCursor(db, kind) };
}

export function endSync(
	db: Db,
	runId: number,
	o: z.infer<typeof EndOpts>,
): SyncRunRow {
	const run = getSyncRun(db, runId);
	if (!run) throw new NotFoundError(`sync run ${runId} not found`);
	if (run.finished_at) throw new ConflictError("sync_run_already_finished");
	finishSyncRun(db, runId, {
		ok: Boolean(o.ok),
		itemsIn: o.items,
		itemsNew: o.new,
		cursor: o.cursor,
		error: o.error,
	});
	return getSyncRun(db, runId) as SyncRunRow;
}

const humanFreshness = (rows: SyncFreshness[]): string =>
	rows
		.map(
			(f) =>
				`${f.kind.padEnd(9)} last ok ${f.lastOkAt ?? "never"}${f.stale ? " (stale)" : ""}${f.error ? `  ERROR ${f.error}` : ""}`,
		)
		.join("\n");

export function register(program: Command): void {
	const sync = program
		.command("sync")
		.description("bookkeeping for Gmail/Calendar sync runs done by agents");

	sync
		.command("begin")
		.description(
			"start a sync run; returns {runId, cursor} (cursor = last successful one)",
		)
		.requiredOption("--kind <kind>", "gmail|calendar")
		.option("--actor <name>", "agent name", "agent")
		.option("--json", "machine-readable output")
		.action(
			action(async (opts: { kind: string; actor: string; json?: boolean }) => {
				const kind = SyncKind.parse(opts.kind);
				const res = await withDb((db) => beginSync(db, kind, opts.actor));
				emit(
					res,
					opts.json,
					(r: typeof res) =>
						`run ${r.runId} (${r.kind}) cursor ${r.cursor ?? "none"}`,
				);
			}),
		);

	sync
		.command("end <runId>")
		.description(
			"finish a run: --ok --items n [--new n] [--cursor c] | --error <code>",
		)
		.option("--ok", "the run succeeded")
		.option("--items <n>", "items fetched")
		.option("--new <n>", "items that were new")
		.option(
			"--cursor <c>",
			"resume cursor for next run (e.g. newest ISO timestamp)",
		)
		.option("--error <code>", "failure code, e.g. connector_unavailable")
		.option("--json", "machine-readable output")
		.action(
			action(
				async (
					runId: string,
					opts: Record<string, unknown> & { json?: boolean },
				) => {
					const id = Id.parse(runId);
					const parsed = EndOpts.safeParse(opts);
					if (!parsed.success)
						throw new ValidationError(
							parsed.error.issues[0]?.message ?? "invalid options",
						);
					const row = await withDb((db) => endSync(db, id, parsed.data));
					audit({
						actor: row.actor,
						action: "sync.end",
						target: `${row.kind}:${row.id}`,
						detail: {
							ok: row.ok,
							items_in: row.items_in,
							items_new: row.items_new,
							error: row.error,
						},
					});
					emit(
						row,
						opts.json,
						(r: SyncRunRow) =>
							`run ${r.id} ${r.ok ? "ok" : `failed: ${r.error}`}`,
					);
				},
			),
		);

	sync
		.command("status")
		.description("freshness of the last gmail and calendar syncs")
		.option("--json", "machine-readable output")
		.action(
			action(async (opts: { json?: boolean }) => {
				const now = new Date();
				const rows = await withDb((db) => [
					syncFreshness(db, "gmail", now),
					syncFreshness(db, "calendar", now),
				]);
				emit(rows, opts.json, humanFreshness);
			}),
		);
}
