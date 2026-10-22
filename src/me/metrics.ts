import { existsSync } from "node:fs";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { type MePaths, mePaths } from "../core/paths.js";
import {
	loadMaster,
	readValidated,
	saveMaster,
	writeFileAtomic,
	writeYaml,
} from "./load.js";
import {
	ConfirmedMetrics,
	type MasterBullet,
	type MasterResume,
	type MasterRole,
	type Metric,
	type MetricDecision,
	MetricProposal,
	type MetricStatus,
} from "./schema.js";

export interface MetricView extends Metric {
	bullet_id: string;
	role_id: string;
	bullet_text: string;
}

export type MetricAction = "accept" | "edit" | "reject";

export interface MetricDecisionInput {
	action: MetricAction;
	value?: string;
	phrase?: string;
}

const LEDGER_HEADER =
	"# Decision ledger written only by `jh metrics confirm` (and the dashboard).\n" +
	"# Append-only: the latest entry per id wins. Do not hand-edit.\n";

/** Lowercased, whitespace- and comma-free form used to compare metric values. */
export function normValue(v: string): string {
	return v.toLowerCase().replace(/[\s,]+/g, "");
}

export function loadLedger(paths: MePaths = mePaths()): ConfirmedMetrics {
	if (!existsSync(paths.confirmedMetrics)) return { version: 1, metrics: [] };
	return readValidated(
		paths.confirmedMetrics,
		ConfirmedMetrics,
		"confirmed metrics",
	);
}

function saveLedger(ledger: ConfirmedMetrics, paths: MePaths): void {
	writeYaml(paths.confirmedMetrics, ledger, LEDGER_HEADER);
}

/** Latest decision per metric id. */
export function latestDecisions(
	ledger: ConfirmedMetrics,
): Map<string, MetricDecision> {
	const out = new Map<string, MetricDecision>();
	for (const d of ledger.metrics) out.set(d.id, d);
	return out;
}

function liveBullets(
	m: MasterResume,
): { role: MasterRole; bullet: MasterBullet }[] {
	const out: { role: MasterRole; bullet: MasterBullet }[] = [];
	for (const role of m.roles)
		for (const bullet of role.bullets)
			if (!bullet.retired) out.push({ role, bullet });
	return out;
}

function toView(
	role: MasterRole,
	bullet: MasterBullet,
	metric: Metric,
): MetricView {
	return {
		...metric,
		bullet_id: bullet.id,
		role_id: role.id,
		bullet_text: bullet.text,
	};
}

function loadMasterOrNull(paths: MePaths): MasterResume | null {
	return existsSync(paths.masterResume) ? loadMaster(paths) : null;
}

export function listMetrics(
	f: { status?: MetricStatus; roleId?: string } = {},
	paths: MePaths = mePaths(),
): MetricView[] {
	const master = loadMasterOrNull(paths);
	if (!master) return [];
	return liveBullets(master)
		.filter(({ role }) => !f.roleId || role.id === f.roleId)
		.flatMap(({ role, bullet }) =>
			bullet.metrics.map((mt) => toView(role, bullet, mt)),
		)
		.filter((v) => !f.status || v.status === f.status);
}

/** Next metric number for a bullet: max existing N + 1, so ids are never reused. */
export function nextMetricId(bullet: MasterBullet): string {
	let max = 0;
	for (const mt of bullet.metrics) {
		const n = Number(mt.id.slice(bullet.id.length + 2));
		if (mt.id.startsWith(`${bullet.id}.m`) && Number.isInteger(n) && n > max)
			max = n;
	}
	return `${bullet.id}.m${max + 1}`;
}

function findBullet(
	m: MasterResume,
	bulletId: string,
): { role: MasterRole; bullet: MasterBullet } | null {
	for (const role of m.roles)
		for (const bullet of role.bullets)
			if (bullet.id === bulletId) return { role, bullet };
	return null;
}

/** Record metric-miner proposals as `estimated` metrics. Duplicates of any existing value are skipped. */
export function proposeMetrics(
	props: MetricProposal[],
	paths: MePaths = mePaths(),
): { added: string[]; skipped: string[] } {
	const parsed = props.map((p, i) => {
		const r = MetricProposal.safeParse(p);
		if (!r.success)
			throw new ValidationError(
				`proposal ${i} is invalid`,
				r.error.issues.map((x) => ({
					path: `${i}.${x.path.join(".")}`,
					message: x.message,
				})),
			);
		return r.data;
	});
	const master = loadMaster(paths);
	const added: string[] = [];
	const skipped: string[] = [];
	for (const p of parsed) {
		const hit = findBullet(master, p.bullet_id);
		if (
			!hit ||
			hit.bullet.retired ||
			hit.bullet.metrics.some(
				(mt) => normValue(mt.value) === normValue(p.value),
			)
		) {
			skipped.push(p.bullet_id);
			continue;
		}
		const id = nextMetricId(hit.bullet);
		hit.bullet.metrics.push({
			id,
			phrase: p.phrase,
			value: p.value,
			status: "estimated",
			derivation: p.derivation,
			source_ref: p.source_ref,
			confidence: p.confidence,
		});
		added.push(id);
	}
	if (added.length) {
		saveMaster(master, paths);
		regenerateMetricsMd(paths, master);
	}
	return { added, skipped };
}

function findMetric(
	m: MasterResume,
	id: string,
): { role: MasterRole; bullet: MasterBullet; metric: Metric } | null {
	for (const role of m.roles)
		for (const bullet of role.bullets)
			for (const metric of bullet.metrics)
				if (metric.id === id) return { role, bullet, metric };
	return null;
}

function applyAction(
	metric: Metric,
	d: MetricDecisionInput,
): MetricDecision["status"] {
	if (d.action === "reject") {
		metric.status = "rejected";
		return "rejected";
	}
	if (d.action === "edit") {
		const value = d.value?.trim();
		if (!value) throw new ValidationError("edit needs a non-empty value");
		metric.value = value;
		if (d.phrase?.trim()) metric.phrase = d.phrase.trim();
		metric.status = "fact";
		return "edited";
	}
	metric.status = "fact";
	return "confirmed";
}

/** The user's verdict on a metric: accept/edit -> fact, reject -> rejected. Appends to the ledger. */
export function decideMetric(
	id: string,
	d: MetricDecisionInput,
	paths: MePaths = mePaths(),
	now: Date = new Date(),
): MetricView {
	const master = loadMaster(paths);
	const hit = findMetric(master, id);
	if (!hit) throw new NotFoundError(`metric not found: ${id}`);
	const status = applyAction(hit.metric, d);
	const ledger = loadLedger(paths);
	ledger.metrics.push({
		id,
		bullet_id: hit.bullet.id,
		phrase: hit.metric.phrase,
		value: hit.metric.value,
		status,
		...(hit.metric.derivation ? { derivation: hit.metric.derivation } : {}),
		decided_at: now.toISOString(),
	});
	saveMaster(master, paths);
	saveLedger(ledger, paths);
	regenerateMetricsMd(paths, master, ledger);
	return toView(hit.role, hit.bullet, hit.metric);
}

export function pendingMetricCount(paths: MePaths = mePaths()): number {
	try {
		return listMetrics({ status: "estimated" }, paths).length;
	} catch (e) {
		if (e instanceof NotFoundError) return 0;
		throw e;
	}
}

/**
 * Re-apply ledger decisions to a master resume (after a re-ingest or a rebuild),
 * so the user's verdicts survive. Returns the ids that changed.
 */
export function applyLedger(
	master: MasterResume,
	ledger: ConfirmedMetrics,
): string[] {
	const changed: string[] = [];
	for (const d of latestDecisions(ledger).values()) {
		const status: MetricStatus = d.status === "rejected" ? "rejected" : "fact";
		const hit = findMetric(master, d.id);
		if (hit) {
			if (hit.metric.status === status && hit.metric.value === d.value)
				continue;
			hit.metric.status = status;
			hit.metric.value = d.value;
			hit.metric.phrase = d.phrase;
			changed.push(d.id);
			continue;
		}
		const owner = findBullet(master, d.bullet_id);
		if (!owner || !d.id.startsWith(`${d.bullet_id}.m`)) continue;
		owner.bullet.metrics.push({
			id: d.id,
			phrase: d.phrase,
			value: d.value,
			status,
			...(d.derivation ? { derivation: d.derivation } : {}),
			source_ref: "confirmed-metrics.yaml",
		});
		changed.push(d.id);
	}
	return changed;
}

const STATUS_LABEL: Record<MetricStatus, string> = {
	fact: "fact",
	estimated: "ESTIMATED (pending)",
	rejected: "rejected",
};

function cell(s: string | undefined): string {
	return (s ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function roleSection(
	role: MasterRole,
	decisions: Map<string, MetricDecision>,
): string[] {
	const rows: string[] = [];
	for (const b of role.bullets) {
		if (b.retired) continue;
		for (const mt of b.metrics) {
			const decided = decisions.get(mt.id)?.decided_at.slice(0, 10) ?? "";
			rows.push(
				`| \`${mt.id}\` | ${cell(mt.value)} | ${cell(mt.phrase)} | ${STATUS_LABEL[mt.status]} | ${cell(mt.derivation)} | ${decided} |`,
			);
		}
	}
	if (!rows.length) return [];
	return [
		`## ${role.title}, ${role.employer} (\`${role.id}\`)`,
		"",
		"| id | value | phrase | status | derivation | decided |",
		"|---|---|---|---|---|---|",
		...rows,
		"",
	];
}

/** Human-readable mirror of every metric in the master resume. */
export function renderMetricsMd(
	master: MasterResume,
	ledger: ConfirmedMetrics,
): string {
	const decisions = latestDecisions(ledger);
	const all = liveBullets(master).flatMap(({ bullet }) => bullet.metrics);
	const count = (s: MetricStatus) => all.filter((m) => m.status === s).length;
	const lines = [
		"<!-- Generated by jh. Do not edit: run `jh metrics confirm <id>` or /confirm-metrics. -->",
		"# Metrics",
		"",
		`Facts: ${count("fact")} · Pending estimates: ${count("estimated")} · Rejected: ${count("rejected")}`,
		"",
		"Only **fact** metrics can appear in a resume. Estimated numbers wait here until you accept, edit or reject them.",
		"",
	];
	for (const role of master.roles) lines.push(...roleSection(role, decisions));
	if (!all.length)
		lines.push("_No metrics yet. Run /intake, then /confirm-metrics._", "");
	return lines.join("\n");
}

export function regenerateMetricsMd(
	paths: MePaths = mePaths(),
	master?: MasterResume,
	ledger?: ConfirmedMetrics,
): void {
	const m = master ?? loadMaster(paths);
	writeFileAtomic(
		paths.metricsMd,
		renderMetricsMd(m, ledger ?? loadLedger(paths)),
	);
}
