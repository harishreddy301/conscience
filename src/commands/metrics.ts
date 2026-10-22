import type { Command } from "commander";
import { z } from "zod";
import { audit } from "../core/audit.js";
import { ValidationError } from "../core/errors.js";
import { action, emit, readJsonInput } from "../core/output.js";
import { mePaths } from "../core/paths.js";
import {
	decideMetric,
	listMetrics,
	type MetricDecisionInput,
	type MetricView,
	proposeMetrics,
} from "../me/metrics.js";
import { MetricProposal } from "../me/schema.js";

interface JsonOpt {
	json?: boolean;
}

const Status = z.enum(["fact", "estimated", "rejected"]);

/** Accept either a bare array of proposals or {proposals:[...]}. */
const ProposalFile = z.union([
	z.array(MetricProposal),
	z
		.object({ proposals: z.array(MetricProposal) })
		.transform((o) => o.proposals),
]);

function formatList(rows: MetricView[]): string {
	if (!rows.length) return "no metrics";
	return rows
		.map(
			(m) =>
				`${m.id.padEnd(24)} ${m.status.padEnd(9)} ${m.value.padEnd(12)} ${m.phrase}${m.derivation ? `\n${" ".repeat(25)}why: ${m.derivation}` : ""}`,
		)
		.join("\n");
}

/** --accept | --edit <value> [--phrase] | --reject, exactly one. */
export function decisionFromOpts(o: {
	accept?: boolean;
	edit?: string;
	phrase?: string;
	reject?: boolean;
}): MetricDecisionInput {
	const chosen = [o.accept, o.edit !== undefined, o.reject].filter(
		Boolean,
	).length;
	if (chosen !== 1)
		throw new ValidationError(
			"choose exactly one of --accept, --edit <value>, --reject",
		);
	if (o.accept) return { action: "accept" };
	if (o.reject) return { action: "reject" };
	return { action: "edit", value: o.edit, phrase: o.phrase };
}

export function register(program: Command): void {
	const metrics = program
		.command("metrics")
		.description(
			"numbers attached to master-resume bullets: facts, estimates and your decisions",
		);

	metrics
		.command("list")
		.description("list metrics (estimated = waiting for your decision)")
		.option("--status <status>", "fact | estimated | rejected")
		.option("--role <id>", "only this role id")
		.option("--json", "machine-readable output")
		.action(
			action((opts: JsonOpt & { status?: string; role?: string }) => {
				const status =
					opts.status === undefined ? undefined : Status.parse(opts.status);
				emit(
					listMetrics({ status, roleId: opts.role }, mePaths()),
					opts.json,
					formatList,
				);
			}),
		);

	metrics
		.command("propose")
		.description(
			"record metric-miner estimates (JSON array of MetricProposal) as status estimated",
		)
		.requiredOption("--file <path>", "proposals JSON, or - for stdin")
		.option("--json", "machine-readable output")
		.action(
			action(async (opts: JsonOpt & { file: string }) => {
				const props = ProposalFile.parse(await readJsonInput(opts.file));
				const r = proposeMetrics(props, mePaths());
				audit({ actor: "metric-miner", action: "metrics.propose", detail: r });
				emit(
					r,
					opts.json,
					(d: typeof r) =>
						`added ${d.added.length}: ${d.added.join(", ") || "-"}; skipped ${d.skipped.length}`,
				);
			}),
		);

	metrics
		.command("confirm <id>")
		.description(
			"decide on a metric: --accept, --edit <value> [--phrase s], or --reject",
		)
		.option("--accept", "the estimate is right; make it a fact")
		.option("--edit <value>", "replace the value (becomes a fact)")
		.option("--phrase <s>", "with --edit: replace the phrase too")
		.option("--reject", "never use this number")
		.option("--json", "machine-readable output")
		.action(
			action(
				(
					id: string,
					opts: JsonOpt & {
						accept?: boolean;
						edit?: string;
						phrase?: string;
						reject?: boolean;
					},
				) => {
					const decision = decisionFromOpts(opts);
					const view = decideMetric(id, decision, mePaths());
					audit({
						actor: "user",
						action: `metrics.${decision.action}`,
						target: id,
						detail: { value: view.value },
					});
					emit(
						view,
						opts.json,
						(m: MetricView) => `${m.id} -> ${m.status} (${m.value})`,
					);
				},
			),
		);
}
