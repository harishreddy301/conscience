import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { action, emit } from "../core/output.js";
import { artifactsDir } from "../core/paths.js";
import { type Db, openDb } from "../db/index.js";
import { companyStats, jobTextFor, triageCandidates } from "../db/policy.js";
import { getApplication } from "../db/repo.js";
import { checkPolicy } from "../policy/check.js";
import { evaluateEligibility } from "../policy/eligibility.js";
import { policyGate } from "../policy/gate.js";
import {
	type EffectivePolicy,
	loadEffective,
	recordPolicy,
	resolved,
} from "../policy/load.js";
import type { PolicyOp } from "../policy/schema.js";
import { type TriageResult, triage } from "../policy/triage.js";

function withDb<T>(fn: (db: Db) => T): T {
	const db = openDb();
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

const IdSchema = z.coerce.number().int().positive();

export function parseIds(csv: string | undefined): number[] | undefined {
	if (!csv) return undefined;
	return csv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map((s) => IdSchema.parse(s));
}

function collect(v: string, prev: string[]): string[] {
	return [...prev, v];
}

/** "a.b=<yaml value>" -> {path, value}. */
export function parseAssignment(s: string): { path: string; value: unknown } {
	const i = s.indexOf("=");
	if (i <= 0)
		throw new ValidationError(`expected <path>=<value>, got: ${s}`, {
			arg: s,
		});
	const path = s.slice(0, i).trim();
	const rawValue = s.slice(i + 1).trim();
	if (!rawValue)
		throw new ValidationError(`missing value for ${path}`, { arg: s });
	let value: unknown;
	try {
		value = parseYaml(rawValue);
	} catch (e) {
		throw new ValidationError(
			`value for ${path} is not valid YAML: ${(e as Error).message}`,
		);
	}
	return { path, value };
}

export function buildOps(o: {
	set?: string[];
	add?: string[];
	remove?: string[];
}): PolicyOp[] {
	const ops: PolicyOp[] = [];
	for (const [op, list] of [
		["set", o.set],
		["add", o.add],
		["remove", o.remove],
	] as const)
		for (const s of list ?? []) ops.push({ op, ...parseAssignment(s) });
	return ops;
}

function readText(path: string | undefined): string | null {
	if (!path) return null;
	if (!existsSync(path)) throw new NotFoundError(`file not found: ${path}`);
	return readFileSync(path, "utf8");
}

function readJsonFile(path: string): Record<string, unknown> | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
	} catch {
		return null;
	}
}

// ------------------------------------------------------------------ eval helpers

export function runTriage(
	db: Db,
	e: EffectivePolicy,
	o: { ids?: number[]; statuses?: string[]; strong?: number[]; now?: Date },
): TriageResult[] {
	const rows = triageCandidates(db, { ids: o.ids, statuses: o.statuses });
	return triage(e, {
		candidates: rows.map((r) => ({
			app_id: r.app_id,
			company_id: r.company_id,
			company: r.company,
			title: r.title,
			status: r.status,
			posted_at: r.posted_at,
			user_link: r.requested_by === "user",
		})),
		companies: companyStats(db),
		strong: new Set(o.strong ?? []),
		now: o.now,
	});
}

function appDir(db: Db, appId: number): { dir: string; title: string } {
	const app = getApplication(db, appId);
	if (!app)
		throw new NotFoundError(`application ${appId} not found`, { appId });
	return { dir: app.artifacts_dir ?? artifactsDir(appId), title: app.title };
}

export function gateInputFromArtifacts(dir: string, title: string) {
	const review = readJsonFile(join(dir, "review.json"));
	const gate = (review?.gate ?? {}) as Record<string, unknown>;
	const ats = readJsonFile(join(dir, "ats.json"));
	const fact = readJsonFile(join(dir, "factcheck.json"));
	const layout = readJsonFile(join(dir, "layout.json"));
	const num = (v: unknown) => (typeof v === "number" ? v : null);
	return {
		title,
		ats: num(ats?.total) ?? num(gate.ats),
		hm_verdict: typeof gate.hm_verdict === "string" ? gate.hm_verdict : null,
		recruiter_passes: num(gate.recruiter_passes),
		valid: typeof gate.valid === "boolean" ? gate.valid : null,
		factcheck:
			fact?.verdict === "pass"
				? ("pass" as const)
				: fact?.verdict === "fail"
					? ("fail" as const)
					: ("none" as const),
		layout_pass: typeof layout?.pass === "boolean" ? layout.pass : null,
		quality: typeof review?.quality === "string" ? review.quality : null,
		finalized: review !== null,
	};
}

// ------------------------------------------------------------------ register

export function register(program: Command): void {
	const policy = program
		.command("policy")
		.description(
			"the structured decision policy in me/decision-policy.yaml (ADR-005)",
		);

	policy
		.command("show")
		.description("effective policy (file + corrections replay + profile layer)")
		.option("--raw", "the file as written, before the corrections replay")
		.option("--json", "machine-readable output")
		.action(
			action((opts: { raw?: boolean; json?: boolean }) => {
				const e = loadEffective();
				emit(
					{
						path: e.path,
						exists: e.exists,
						rev: e.rev,
						policy: opts.raw ? e.file : e.policy,
						derived: e.derived,
						resolved: resolved(e),
					},
					opts.json,
					(d) =>
						`${d.path}${d.exists ? "" : " (missing: defaults)"}  rev ${d.rev}\n${JSON.stringify(d.policy, null, 2)}`,
				);
			}),
		);

	policy
		.command("check")
		.description("schema and consistency checks; exit 2 on conflicts")
		.option("--json", "machine-readable output")
		.action(
			action((opts: { json?: boolean }) => {
				const r = checkPolicy(loadEffective());
				emit(r, opts.json, (d: ReturnType<typeof checkPolicy>) =>
					[
						`${d.ok ? "ok" : "CONFLICTS"}  rev ${d.rev}  ${d.path}`,
						...d.conflicts.map((c) => `  conflict ${c.code}: ${c.message}`),
						...d.warnings.map((w) => `  warning ${w.code}: ${w.message}`),
					].join("\n"),
				);
				if (!r.ok) process.exitCode = 2;
			}),
		);

	policy
		.command("record")
		.description(
			"change the policy and append a correction (rev bump). submit.*, eligibility.overrides and removing an escalate kind need --actor user",
		)
		.requiredOption("--actor <name>", "who decided (user needs --quote)")
		.option("--quote <text>", "the user's own words")
		.option("--reason <text>", "why")
		.option("--set <path=value>", "set a value (YAML)", collect, [])
		.option("--add <path=value>", "add to a list (YAML)", collect, [])
		.option("--remove <path=value>", "remove matching list items", collect, [])
		.option("--json", "machine-readable output")
		.action(
			action(
				(opts: {
					actor: string;
					quote?: string;
					reason?: string;
					set: string[];
					add: string[];
					remove: string[];
					json?: boolean;
				}) => {
					const ops = buildOps(opts);
					const r = recordPolicy({
						actor: opts.actor.trim(),
						ops,
						quote: opts.quote,
						reason: opts.reason,
					});
					audit({
						actor: opts.actor,
						action: "policy.record",
						target: "policy",
						detail: {
							policy_rev: r.rev,
							ops,
							quote: opts.quote,
							reason: opts.reason,
						},
					});
					emit(r, opts.json, (d) => `recorded rev ${d.rev} in ${d.path}`);
				},
			),
		);

	const ev = policy
		.command("eval")
		.description(
			"deterministic policy decisions (each is audited with policy_rev)",
		);

	ev.command("triage")
		.description(
			"recency, titles, level band, blocklist and per-company caps for candidate applications",
		)
		.option("--app <ids>", "comma-separated application ids")
		.option(
			"--status <list>",
			"statuses to consider (default shortlisted,discovered)",
		)
		.option("--strong <ids>", "app ids conscience judged a strong fit")
		.option("--actor <name>", "who asked", "conscience")
		.option("--json", "machine-readable output")
		.action(
			action(
				(opts: {
					app?: string;
					status?: string;
					strong?: string;
					actor: string;
					json?: boolean;
				}) => {
					const e = loadEffective();
					const results = withDb((db) =>
						runTriage(db, e, {
							ids: parseIds(opts.app),
							statuses: opts.status?.split(",").map((s) => s.trim()),
							strong: parseIds(opts.strong),
						}),
					);
					const counts = { include: 0, review: 0, skip: 0 };
					for (const r of results) counts[r.decision]++;
					audit({
						actor: opts.actor,
						action: "policy.eval.triage",
						detail: {
							policy_rev: e.rev,
							counts,
							decisions: results.map((r) => ({
								app_id: r.app_id,
								decision: r.decision,
								reasons: r.reasons,
							})),
						},
					});
					emit(
						{ policy_rev: e.rev, counts, results },
						opts.json,
						(d: { results: TriageResult[] }) =>
							d.results
								.map(
									(r) =>
										`#${r.app_id} ${r.decision.padEnd(7)} ${r.company} - ${r.title} (${r.age_days ?? "?"}d) ${r.reasons.join("; ")}`,
								)
								.join("\n"),
					);
				},
			),
		);

	ev.command("eligibility <app_id>")
		.description(
			"clearance / citizenship / green card / sponsorship / government screen of the JD and form text",
		)
		.option("--jd <file>", "JD text file (default: the stored JD)")
		.option("--form <file>", "form text file (default: <artifacts>/form.txt)")
		.option("--actor <name>", "who asked", "conscience")
		.option("--json", "machine-readable output")
		.action(
			action(
				(
					appIdRaw: string,
					opts: { jd?: string; form?: string; actor: string; json?: boolean },
				) => {
					const appId = IdSchema.parse(appIdRaw);
					const e = loadEffective();
					const texts = withDb((db) => {
						const job = jobTextFor(db, appId);
						if (!job)
							throw new NotFoundError(`application ${appId} not found`, {
								appId,
							});
						const { dir } = appDir(db, appId);
						const formDefault = join(dir, "form.txt");
						return {
							jd: readText(opts.jd) ?? job.jd_text,
							form:
								readText(opts.form) ??
								(existsSync(formDefault) ? readText(formDefault) : null),
						};
					});
					const r = evaluateEligibility(e, appId, texts);
					audit({
						actor: opts.actor,
						action: "policy.eval.eligibility",
						target: `application:${appId}`,
						detail: {
							policy_rev: e.rev,
							verdict: r.verdict,
							reasons: r.reasons,
						},
					});
					emit({ policy_rev: e.rev, ...r }, opts.json, (d) =>
						[`${d.verdict}`, ...d.reasons.map((x: string) => `  ${x}`)].join(
							"\n",
						),
					);
				},
			),
		);

	ev.command("gate <app_id>")
		.description(
			"the policy submit gate for a finalized application (per-track thresholds, fact check, layout)",
		)
		.option("--actor <name>", "who asked", "conscience")
		.option("--json", "machine-readable output")
		.action(
			action((appIdRaw: string, opts: { actor: string; json?: boolean }) => {
				const appId = IdSchema.parse(appIdRaw);
				const e = loadEffective();
				const input = withDb((db) => {
					const { dir, title } = appDir(db, appId);
					return gateInputFromArtifacts(dir, title);
				});
				const g = policyGate(e, input);
				if (!input.finalized) {
					g.pass = false;
					g.reasons.unshift("not finalized (no review.json)");
				}
				audit({
					actor: opts.actor,
					action: "policy.eval.gate",
					target: `application:${appId}`,
					detail: {
						policy_rev: e.rev,
						pass: g.pass,
						track: g.track,
						reasons: g.reasons,
					},
				});
				emit(
					{ policy_rev: e.rev, app_id: appId, ...g, input },
					opts.json,
					(d) =>
						`${d.pass ? "PASS" : "FAIL"} #${d.app_id} track ${d.track ?? "-"}${d.reasons.length ? `\n  ${d.reasons.join("\n  ")}` : ""}`,
				);
			}),
		);
}
