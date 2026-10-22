import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readSync,
} from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { action, emit } from "../core/output.js";
import { artifactsDir, meDir, repoRoot } from "../core/paths.js";
import { canTransition, transition } from "../core/state.js";
import { type Db, openDb } from "../db/index.js";
import {
	addEscalation,
	countAppliedSince,
	type EscalationRow,
	getEscalation,
	listArtifactsDirs,
	listEscalations,
	resolveEscalation,
} from "../db/policy.js";
import { getApplication } from "../db/repo.js";
import { checkPolicy } from "../policy/check.js";
import {
	type EffectivePolicy,
	loadEffective,
	resolved,
} from "../policy/load.js";
import { ESCALATE_KINDS } from "../policy/schema.js";
import { checkMeIgnored } from "./doctor.js";

function withDb<T>(fn: (db: Db) => T): T {
	const db = openDb();
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

const IdSchema = z.coerce.number().int().positive();
const DAY_MS = 86_400_000;

// ------------------------------------------------------------------ preflight

export interface PreflightCheck {
	name: string;
	/** null: cannot be checked from the CLI (the main session checks it). */
	ok: boolean | null;
	detail: string;
}

/** True when `dir` holds a .pdf whose first bytes are "%PDF". */
export function pdfReadable(dir: string | null): boolean {
	if (!dir || !existsSync(dir)) return false;
	const pdf = readdirSync(dir).find(
		(f) => f.toLowerCase().endsWith(".pdf") && f !== "cover.pdf",
	);
	if (!pdf) return false;
	try {
		const fd = openSync(join(dir, pdf), "r");
		try {
			const buf = Buffer.alloc(4);
			readSync(fd, buf, 0, 4, 0);
			return buf.toString("latin1") === "%PDF";
		} finally {
			closeSync(fd);
		}
	} catch {
		return false;
	}
}

export function runPreflight(
	db: Db,
	e: EffectivePolicy,
	now: Date = new Date(),
): {
	ok: boolean;
	policy_rev: number;
	submit_confirm: string;
	checks: PreflightCheck[];
	remaining_today: number | null;
	blocking_escalations: EscalationRow[];
	throughput: EffectivePolicy["policy"]["throughput"];
	account_ats: Record<string, string>;
} {
	const checks: PreflightCheck[] = [];
	const pc = checkPolicy(e);
	checks.push({
		name: "policy",
		ok: pc.ok,
		detail: pc.ok
			? `rev ${pc.rev}${e.exists ? "" : " (defaults: no policy file)"}`
			: pc.conflicts.map((c) => c.code).join(", "),
	});

	const me = meDir();
	const warnings: string[] = [];
	const ignored = checkMeIgnored(me.path, repoRoot(), warnings);
	checks.push({
		name: "me_ignored",
		ok: ignored,
		detail: ignored === false ? "me/ is NOT git-ignored" : me.path,
	});

	const pf = e.policy.preflight;
	if (pf.uploads_readable) {
		const apps = listArtifactsDirs(db, ["tailored"]);
		const bad = apps
			.filter((a) => !pdfReadable(a.artifacts_dir ?? artifactsDir(a.app_id)))
			.map((a) => a.app_id);
		checks.push({
			name: "uploads_readable",
			ok: bad.length === 0,
			detail: bad.length
				? `no readable resume PDF for #${bad.join(", #")}`
				: `${apps.length} tailored application(s) have a readable PDF`,
		});
	}

	const cap = resolved(e).daily_cap;
	const appliedToday = countAppliedSince(
		db,
		new Date(now.getTime() - DAY_MS).toISOString(),
	);
	const remaining = cap === null ? null : Math.max(0, cap - appliedToday);
	checks.push({
		name: "daily_cap",
		ok: remaining === null || remaining > 0,
		detail:
			cap === null
				? `${appliedToday} applied in the last 24h (no cap)`
				: `${appliedToday}/${cap} applied in the last 24h`,
	});

	if (pf.browser)
		checks.push({
			name: "browser",
			ok: null,
			detail:
				"main session: confirm Claude in Chrome is connected (tabs_context_mcp) before filling",
		});

	const blocking = listEscalations(db, { status: "open" }).filter(
		(x) => x.blocking === 1,
	);
	checks.push({
		name: "blocking_escalations",
		ok: blocking.length === 0,
		detail: blocking.length
			? `${blocking.length} open blocking escalation(s): ask the user once`
			: "none",
	});

	return {
		ok: checks.every((c) => c.ok !== false),
		policy_rev: e.rev,
		submit_confirm: e.policy.submit.confirm,
		checks,
		remaining_today: remaining,
		blocking_escalations: blocking,
		throughput: e.policy.throughput,
		account_ats: e.policy.preflight.account_ats,
	};
}

// ------------------------------------------------------------------ register

const AddOpts = z.object({
	kind: z.enum(ESCALATE_KINDS),
	question: z.string().trim().min(1).max(1000),
	app: IdSchema.optional(),
	blocking: z.boolean().optional(),
	hold: z.boolean().optional(),
	context: z.string().optional(),
	actor: z.string().trim().min(1),
	json: z.boolean().optional(),
});

function parseContext(raw: string | undefined): unknown {
	if (raw === undefined) return undefined;
	try {
		return JSON.parse(raw);
	} catch {
		return { note: raw };
	}
}

export function register(program: Command): void {
	const ap = program
		.command("autopilot")
		.description(
			"support for /autopilot: preflight and the escalation queue (ADR-005)",
		);

	ap.command("preflight")
		.description(
			"policy, me/ privacy, readable uploads, daily cap and blocking escalations before a run",
		)
		.option("--json", "machine-readable output")
		.action(
			action((opts: { json?: boolean }) => {
				const e = loadEffective();
				const r = withDb((db) => runPreflight(db, e));
				audit({
					actor: "autopilot",
					action: "autopilot.preflight",
					detail: {
						policy_rev: r.policy_rev,
						ok: r.ok,
						failed: r.checks.filter((c) => c.ok === false).map((c) => c.name),
					},
				});
				emit(r, opts.json, (d: ReturnType<typeof runPreflight>) =>
					[
						`${d.ok ? "ready" : "NOT READY"}  policy rev ${d.policy_rev}  submit ${d.submit_confirm}  remaining today ${d.remaining_today ?? "-"}`,
						...d.checks.map(
							(c) =>
								`  ${c.ok === null ? "?" : c.ok ? "ok" : "FAIL"}  ${c.name}: ${c.detail}`,
						),
					].join("\n"),
				);
			}),
		);

	const esc = ap
		.command("escalations")
		.description(
			"the escalation queue: only the policy's escalate kinds reach the user",
		);

	esc
		.command("list")
		.option("--status <s>", "open|answered|dismissed|all", "open")
		.option("--app <id>", "only this application")
		.option("--json", "machine-readable output")
		.action(
			action((opts: { status: string; app?: string; json?: boolean }) => {
				const status = z
					.enum(["open", "answered", "dismissed", "all"])
					.parse(opts.status);
				const appId = opts.app ? IdSchema.parse(opts.app) : undefined;
				const rows = withDb((db) => listEscalations(db, { status, appId }));
				emit(
					{ escalations: rows },
					opts.json,
					(d: { escalations: EscalationRow[] }) =>
						d.escalations.length
							? d.escalations
									.map(
										(x) =>
											`#${x.id} ${x.status} ${x.blocking ? "BLOCKING " : ""}${x.kind}${x.application_id ? ` app #${x.application_id}` : ""}: ${x.question}${x.answer ? ` -> ${x.answer}` : ""}`,
									)
									.join("\n")
							: "no escalations",
				);
			}),
		);

	esc
		.command("add")
		.description(
			"queue a question for the user (refused unless the kind is one of the policy's escalate kinds)",
		)
		.requiredOption("--kind <kind>", ESCALATE_KINDS.join("|"))
		.requiredOption("--question <text>", "exact question for the user")
		.requiredOption("--actor <name>", "who escalates")
		.option("--app <id>", "application it concerns")
		.option(
			"--blocking",
			"the run cannot continue for this application without it",
		)
		.option(
			"--hold",
			"move the application to held with this question as the reason",
		)
		.option("--context <json>", "extra context (JSON)")
		.option("--json", "machine-readable output")
		.action(
			action((raw: Record<string, unknown>) => {
				const o = AddOpts.parse(raw);
				const e = loadEffective();
				if (!e.policy.escalate.kinds.includes(o.kind))
					throw new ValidationError(
						`${o.kind} is not an escalate kind in the policy: conscience decides it`,
						{ kind: o.kind, kinds: e.policy.escalate.kinds },
						"not_escalated",
					);
				const result = withDb((db) => {
					if (o.app !== undefined && !getApplication(db, o.app))
						throw new NotFoundError(`application ${o.app} not found`, {
							appId: o.app,
						});
					const { row, created } = addEscalation(db, {
						kind: o.kind,
						application_id: o.app ?? null,
						question: o.question,
						context: parseContext(o.context),
						blocking: o.blocking,
						actor: o.actor,
						policy_rev: e.rev,
					});
					let held = false;
					if (o.hold && o.app !== undefined) {
						const app = getApplication(db, o.app);
						if (app && canTransition(app.status, "held")) {
							transition(db, o.app, "held", {
								actor: o.actor,
								note: `escalation #${row.id}: ${o.question}`.slice(0, 500),
							});
							held = true;
						}
					}
					return { escalation: row, created, held };
				});
				if (result.created)
					audit({
						actor: o.actor,
						action: "escalation.add",
						target: o.app ? `application:${o.app}` : undefined,
						detail: {
							policy_rev: e.rev,
							id: result.escalation.id,
							kind: o.kind,
							blocking: Boolean(o.blocking),
						},
					});
				emit(
					result,
					o.json,
					(d) =>
						`${d.created ? "queued" : "already open"} escalation #${d.escalation.id}${d.held ? " (application held)" : ""}`,
				);
			}),
		);

	esc
		.command("answer <id>")
		.description("record the user's answer (or --dismiss); only --actor user")
		.option("--answer <text>", "the user's answer")
		.option("--dismiss", "close without an answer")
		.option("--actor <name>", "must be user", "user")
		.option("--json", "machine-readable output")
		.action(
			action(
				(
					idRaw: string,
					opts: {
						answer?: string;
						dismiss?: boolean;
						actor: string;
						json?: boolean;
					},
				) => {
					const id = IdSchema.parse(idRaw);
					if (opts.actor !== "user")
						throw new ValidationError(
							"only the user answers escalations (--actor user)",
							{ actor: opts.actor },
							"user_only_field",
						);
					if (!opts.dismiss && !opts.answer?.trim())
						throw new ValidationError("pass --answer <text> or --dismiss");
					const row = withDb((db) => {
						const cur = getEscalation(db, id);
						if (!cur)
							throw new NotFoundError(`escalation ${id} not found`, { id });
						if (cur.status !== "open")
							throw new ValidationError(
								`escalation ${id} is already ${cur.status}`,
								{ id },
								"already_resolved",
							);
						resolveEscalation(db, id, {
							status: opts.dismiss ? "dismissed" : "answered",
							answer: opts.dismiss ? null : (opts.answer?.trim() ?? null),
							by: opts.actor,
						});
						return getEscalation(db, id) as EscalationRow;
					});
					audit({
						actor: opts.actor,
						action: "escalation.answer",
						target: row.application_id
							? `application:${row.application_id}`
							: undefined,
						detail: { id, status: row.status, kind: row.kind },
					});
					emit(
						{ escalation: row },
						opts.json,
						(d) =>
							`escalation #${d.escalation.id} ${d.escalation.status}${d.escalation.application_id ? `; release app #${d.escalation.application_id} with jh app transition <id> shortlisted|tailored` : ""}`,
					);
				},
			),
		);
}
