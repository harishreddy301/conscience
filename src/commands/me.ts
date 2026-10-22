import type { Command } from "commander";
import { audit } from "../core/audit.js";
import { action, emit, readJsonInput } from "../core/output.js";
import { meDir, mePaths } from "../core/paths.js";
import { extractSampleResumes } from "../me/extract.js";
import { type IngestResult, ingestDraft } from "../me/ingest.js";
import {
	defaultMeDir,
	type InitResult,
	initWorkspace,
	type MeStatus,
	meStatus,
	migrateLegacy,
	validateWorkspace,
	type WorkspaceValidation,
} from "../me/init.js";

interface JsonOpt {
	json?: boolean;
}

function formatInit(r: InitResult): string {
	return [
		`me/ workspace: ${r.dir}`,
		`  created ${r.created.length}, overwritten ${r.overwritten.length}, kept ${r.skipped.length}`,
		`  JOB_HUNTER_ME ${r.envUpdated ? "written to" : "already set in"} ${r.envFile}`,
		"Next: drop your resume into sample-resume/, write experience/<employer-YYYY>.md files, then run /intake.",
	].join("\n");
}

function formatStatus(s: MeStatus): string {
	const lines = [
		`me/ ${s.root}${s.exists ? "" : " (missing: run `jh me init`)"}`,
	];
	lines.push(
		`last intake: ${s.lastIntake ?? "never"}${s.needsIntake ? "  -> run /intake" : ""}`,
	);
	for (const f of s.files) lines.push(`  ${f.changed ? "*" : " "} ${f.rel}`);
	if (s.missing.length) lines.push(`missing: ${s.missing.join(", ")}`);
	return lines.join("\n");
}

function formatIngest(r: IngestResult): string {
	if (r.conflicts.length)
		return [
			"conflicts (nothing written):",
			...r.conflicts.map(
				(c) =>
					`  ${c.role_id ?? "-"} ${c.field}: ${c.values.join(" vs ")} [${c.sources.join(", ")}]`,
			),
		].join("\n");
	const lines = [
		`${r.dry_run ? "dry run: " : ""}added ${r.added.length}, updated ${r.updated.length}, retired ${r.retired.length}${r.written ? "" : " (no change written)"}`,
	];
	for (const l of r.lint)
		lines.push(
			`  warn ${l.code} ${l.bullet_id ?? l.role_id ?? ""} ${l.token ?? ""}`.trimEnd(),
		);
	return lines.join("\n");
}

function formatValidation(v: WorkspaceValidation): string {
	const row =
		(kind: string) => (i: { file: string; path?: string; message: string }) =>
			`  ${kind} ${i.file}${i.path ? ` ${i.path}` : ""}: ${i.message}`;
	return [
		v.ok ? "me/ is valid" : "me/ has errors",
		...v.errors.map(row("error")),
		...v.warnings.map(row("warn")),
	].join("\n");
}

function registerInit(me: Command): void {
	me.command("init")
		.description(
			"create the me/ workspace from templates and record JOB_HUNTER_ME in <jhHome>/.env",
		)
		.option(
			"--dir <path>",
			"where to create it (default: $JOB_HUNTER_ME or <jhHome>/me)",
		)
		.option(
			"--force",
			"overwrite template files you have not changed (generated files are always kept)",
		)
		.option("--json", "machine-readable output")
		.action(
			action((opts: JsonOpt & { dir?: string; force?: boolean }) => {
				const r = initWorkspace({ dir: opts.dir, force: opts.force });
				audit({
					actor: "cli",
					action: "me.init",
					target: r.dir,
					detail: { created: r.created.length },
				});
				emit(r, opts.json, formatInit);
			}),
		);
}

function registerReadOnly(me: Command): void {
	me.command("path")
		.description(
			"show where the me/ workspace resolves and its well-known files",
		)
		.option("--json", "machine-readable output")
		.action(
			action((opts: JsonOpt) => {
				const loc = meDir();
				emit(
					{ ...loc, paths: mePaths() },
					opts.json,
					(d: typeof loc) =>
						`${d.path} (${d.source}${d.exists ? "" : ", missing"})`,
				);
			}),
		);
	me.command("status")
		.description(
			"list workspace files, what changed since the last intake, and what is missing",
		)
		.option("--json", "machine-readable output")
		.action(
			action((opts: JsonOpt) =>
				emit(meStatus(mePaths()), opts.json, formatStatus),
			),
		);
	me.command("validate")
		.description(
			"check profile, master resume, ledger, experience and story front matter",
		)
		.option("--json", "machine-readable output")
		.action(
			action((opts: JsonOpt) => {
				const v = validateWorkspace(mePaths());
				emit(v, opts.json, formatValidation);
				if (!v.ok) process.exitCode = 2;
			}),
		);
}

function registerIntake(me: Command): void {
	me.command("extract")
		.description(
			"extract DOCX/MD sample resumes to me/.cache/text (PDFs are read by the intake agent)",
		)
		.option("--json", "machine-readable output")
		.action(
			action((opts: JsonOpt) =>
				emit(
					extractSampleResumes(mePaths()),
					opts.json,
					(r: ReturnType<typeof extractSampleResumes>) =>
						[
							...r.written.map((w) => `  wrote ${w.out} (${w.chars} chars)`),
							...r.skipped.map((s) => `  skip  ${s.source}: ${s.reason}`),
						].join("\n") || "no sample resumes found",
				),
			),
		);
	me.command("ingest <draft>")
		.description(
			"merge an intake draft (JSON, or - for stdin) into master-resume.yaml with stable ids",
		)
		.option("--dry-run", "report what would change without writing")
		.option(
			"--allow-fact-changes",
			"apply employer/title/date changes the user has confirmed",
		)
		.option("--json", "machine-readable output")
		.action(
			action(
				async (
					draft: string,
					opts: JsonOpt & { dryRun?: boolean; allowFactChanges?: boolean },
				) => {
					const input = await readJsonInput(draft);
					const r = ingestDraft(input, {
						dryRun: opts.dryRun,
						allowFactChanges: opts.allowFactChanges,
					});
					if (r.written)
						audit({
							actor: "cli",
							action: "me.ingest",
							target: "master-resume.yaml",
							detail: {
								added: r.added.length,
								updated: r.updated.length,
								retired: r.retired.length,
							},
						});
					emit(r, opts.json, formatIngest);
					if (r.conflicts.length) process.exitCode = 2;
				},
			),
		);
	me.command("migrate")
		.description(
			"copy legacy <jhHome>/profile.yaml and resume.yaml into the me/ workspace",
		)
		.option("--json", "machine-readable output")
		.action(
			action((opts: JsonOpt) => {
				const r = migrateLegacy(mePaths(defaultMeDir()));
				audit({ actor: "cli", action: "me.migrate", target: r.dir, detail: r });
				emit(
					r,
					opts.json,
					(d: typeof r) =>
						`copied: ${d.copied.join(", ") || "-"}; converted: ${d.converted.join(", ") || "-"}; kept: ${d.skipped.join(", ") || "-"}`,
				);
			}),
		);
}

export function register(program: Command): void {
	const me = program
		.command("me")
		.description(
			"the personal me/ workspace (resume, experience READMEs, stories)",
		);
	registerInit(me);
	registerReadOnly(me);
	registerIntake(me);
}
