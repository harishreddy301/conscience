import type { Command } from "commander";
import { z } from "zod";
import { audit } from "../core/audit.js";
import { NotFoundError } from "../core/errors.js";
import { action, emit, readJsonInput } from "../core/output.js";
import { type Db, openDb } from "../db/index.js";
import { getJdSnapshot, upsertJdSnapshot } from "../db/jd.js";
import { type JdCompare, jdCompareForApp } from "../jd/compare.js";
import type { JdSnapshotRecord } from "../jd/schema.js";

const AppId = z.coerce.number().int().positive();

function withDb<T>(fn: (db: Db) => T): T {
	const db = openDb();
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

const terms = (ts: { term: string }[]) => ts.map((t) => t.term).join(", ");

function humanSnapshot(s: JdSnapshotRecord): string {
	return [
		`${s.title_posted}${s.seniority ? ` (${s.seniority})` : ""}`,
		[s.location, s.remote, s.salary].filter(Boolean).join(" · "),
		`must-haves: ${terms(s.must_haves)}`,
		s.nice_to_haves.length ? `nice-to-haves: ${terms(s.nice_to_haves)}` : "",
		s.keywords.length ? `keywords: ${s.keywords.join(", ")}` : "",
		"",
		s.summary,
	]
		.filter((l, i) => l !== "" || i === 5)
		.join("\n");
}

function humanCompare(c: JdCompare): string {
	const lines = [
		`posted: ${c.titles.posted}`,
		`headline: ${c.titles.headline} (${c.titles.headline_matches_posted ? "matches posted title" : "differs from posted title"}${c.titles.headline_in_targets === false ? "; outside your target roles" : ""})`,
		...c.titles.display_titles.map(
			(t) =>
				`  ${t.employer}: ${t.shown}${t.uses_variant ? ` (variant of ${t.official})` : ""}`,
		),
		`must-haves ${c.must_haves.filter((m) => m.covered).length}/${c.must_haves.length}:`,
		...c.must_haves.map((m) => {
			const ev = m.evidence.find((e) => e.kind === "bullet");
			return `  ${m.covered ? "✓" : "✗"} ${m.term}${ev ? `  [${ev.id}] ${ev.text}` : m.also_in.length ? `  (only in ${m.also_in.join(", ")})` : ""}`;
		}),
		`keywords ${c.keywords.covered.length}/${c.keywords.total} (${c.keywords.coverage_pct ?? "n/a"}%)`,
	];
	if (c.keywords.missing.length)
		lines.push(`missing keywords: ${c.keywords.missing.join(", ")}`);
	return lines.join("\n");
}

async function runSnapshotSet(
	id: string,
	o: { file: string; json?: boolean },
): Promise<void> {
	const appId = AppId.parse(id);
	const input = await readJsonInput(o.file);
	const snap = withDb((db) => upsertJdSnapshot(db, appId, input));
	audit({
		actor: "jh jd snapshot set",
		action: "jd.snapshot",
		target: `application:${appId}`,
		detail: {
			title_posted: snap.title_posted,
			must_haves: snap.must_haves.length,
			keywords: snap.keywords.length,
		},
	});
	emit(
		snap,
		o.json,
		(s: JdSnapshotRecord) =>
			`JD snapshot stored for application ${s.application_id}: ${s.must_haves.length} must-haves, ${s.keywords.length} keywords`,
	);
}

async function runShow(id: string, o: { json?: boolean }): Promise<void> {
	const appId = AppId.parse(id);
	const snap = withDb((db) => getJdSnapshot(db, appId));
	if (!snap)
		throw new NotFoundError(
			`application ${appId} has no JD snapshot`,
			undefined,
			"no_snapshot",
		);
	emit(snap, o.json, humanSnapshot);
}

async function runCompare(
	id: string,
	o: { draft?: string; json?: boolean },
): Promise<void> {
	const appId = AppId.parse(id);
	const c = withDb((db) => jdCompareForApp(db, appId, { draftPath: o.draft }));
	emit(c, o.json, humanCompare);
}

export function register(program: Command): void {
	const jd = program
		.command("jd")
		.description(
			"short JD snapshot per application and a deterministic resume-vs-JD compare",
		);
	const snapshot = jd
		.command("snapshot")
		.description("store the JD snapshot of an application");
	snapshot
		.command("set <appId>")
		.description(
			"store JdSnapshot JSON (title_posted, must_haves, keywords, summary ≤ 800 chars, …)",
		)
		.requiredOption("--file <path>", "snapshot JSON file, or - for stdin")
		.option("--json", "machine-readable output")
		.action(action(runSnapshotSet));
	jd.command("show <appId>")
		.description("print the stored JD snapshot")
		.option("--json", "machine-readable output")
		.action(action(runShow));
	jd.command("compare <appId>")
		.description(
			"compare the finalized resume (or --draft) with the JD snapshot: must-haves, keywords, titles",
		)
		.option(
			"--draft <path>",
			"compare this draft JSON instead of the finalized resume",
		)
		.option("--json", "machine-readable output")
		.action(action(runCompare));
}
