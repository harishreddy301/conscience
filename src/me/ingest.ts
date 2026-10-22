import { existsSync, readFileSync } from "node:fs";
import { ValidationError } from "../core/errors.js";
import { type MePaths, mePaths } from "../core/paths.js";
import { writeIntakeState } from "./init.js";
import {
	loadMaster,
	masterToYaml,
	normSkill,
	slug,
	writeFileAtomic,
	ymToMonths,
} from "./load.js";

export { slug };

import {
	applyLedger,
	loadLedger,
	nextMetricId,
	normValue,
	renderMetricsMd,
} from "./metrics.js";
import {
	emptyMaster,
	type IntakeBullet,
	IntakeDraft,
	type IntakeRole,
	type MasterBullet,
	type MasterResume,
	type MasterRole,
} from "./schema.js";

export interface IngestConflict {
	kind: "draft" | "fixed_fact" | "date_format" | "date_order";
	role_id?: string;
	field: string;
	values: string[];
	sources: string[];
}

export interface LintWarning {
	code: "NUMBER_NO_METRIC" | "ROLE_MISSING";
	role_id?: string;
	bullet_id?: string;
	token?: string;
	message: string;
}

export interface IngestResult {
	added: string[];
	updated: string[];
	retired: string[];
	conflicts: IngestConflict[];
	lint: LintWarning[];
	written: boolean;
	dry_run: boolean;
}

export interface IngestOptions {
	paths?: MePaths;
	dryRun?: boolean;
	/** The user confirmed that the draft's employer/title/dates replace the master's. */
	allowFactChanges?: boolean;
	now?: Date;
}

const YEAR_MONTH = /^\d{4}-\d{2}$/;
const JACCARD_MIN = 0.8;
const ROLE_FALLBACK_MONTHS = 12;
const FIXED_FIELDS = ["kind", "employer", "title", "start", "end"] as const;

// --- ids --------------------------------------------------------------------

/** role: slug(employer)-YYYY; project: proj-<slug(title)>; suffix -2, -3 on collision. */
export function baseRoleId(
	r: Pick<IntakeRole, "kind" | "employer" | "title" | "start">,
): string {
	if (r.kind === "project") return `proj-${slug(r.title)}`;
	return `${slug(r.employer)}-${r.start.slice(0, 4)}`;
}

function uniqueId(base: string, taken: Set<string>): string {
	if (!taken.has(base)) return base;
	for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

export function bulletId(roleId: string, n: number): string {
	return `${roleId}.b${String(n).padStart(2, "0")}`;
}

// --- matching ---------------------------------------------------------------

export function tokens(s: string): Set<string> {
	return new Set(
		s
			.toLowerCase()
			.split(/[^a-z0-9]+/)
			.filter(Boolean),
	);
}

export function jaccard(a: string, b: string): number {
	const ta = tokens(a);
	const tb = tokens(b);
	if (!ta.size && !tb.size) return 1;
	let inter = 0;
	for (const t of ta) if (tb.has(t)) inter++;
	return inter / (ta.size + tb.size - inter);
}

function normEnd(end: string): string {
	return end.trim().toLowerCase() === "present" ? "present" : end.trim();
}

function matchRole(
	d: IntakeRole,
	roles: MasterRole[],
	claimed: Set<string>,
): MasterRole | undefined {
	const free = roles.filter((r) => !claimed.has(r.id));
	if (d.match_id) {
		const byId = free.find((r) => r.id === d.match_id);
		if (byId) return byId;
	}
	const sameEmployer = free.filter(
		(r) => r.kind === d.kind && slug(r.employer) === slug(d.employer),
	);
	return sameEmployer.find(
		(r) =>
			jaccard(r.title, d.title) >= JACCARD_MIN &&
			(!YEAR_MONTH.test(d.start) ||
				Math.abs(ymToMonths(r.start) - ymToMonths(d.start)) <=
					ROLE_FALLBACK_MONTHS),
	);
}

function bestBullet(
	text: string,
	pool: MasterBullet[],
): MasterBullet | undefined {
	let best: MasterBullet | undefined;
	let score = 0;
	for (const b of pool) {
		const s = jaccard(text, b.text);
		if (s >= JACCARD_MIN && s > score) {
			best = b;
			score = s;
		}
	}
	return best;
}

// --- validation of the draft ------------------------------------------------

function dateConflicts(d: IntakeRole, label: string): IngestConflict[] {
	const out: IngestConflict[] = [];
	const end = normEnd(d.end);
	if (!YEAR_MONTH.test(d.start))
		out.push({
			kind: "date_format",
			role_id: label,
			field: "start",
			values: [d.start],
			sources: d.source_refs,
		});
	if (end !== "present" && !YEAR_MONTH.test(end))
		out.push({
			kind: "date_format",
			role_id: label,
			field: "end",
			values: [d.end],
			sources: d.source_refs,
		});
	if (!out.length && end !== "present" && ymToMonths(end) < ymToMonths(d.start))
		out.push({
			kind: "date_order",
			role_id: label,
			field: "end",
			values: [d.start, end],
			sources: d.source_refs,
		});
	return out;
}

function factDiffs(existing: MasterRole, d: IntakeRole): IngestConflict[] {
	const incoming = {
		kind: d.kind,
		employer: d.employer,
		title: d.title,
		start: d.start,
		end: normEnd(d.end),
	};
	return FIXED_FIELDS.filter((f) => existing[f] !== incoming[f]).map((f) => ({
		kind: "fixed_fact" as const,
		role_id: existing.id,
		field: f,
		values: [existing[f], incoming[f]],
		sources: ["master-resume.yaml", ...d.source_refs],
	}));
}

// --- merge ------------------------------------------------------------------

interface MergeLog {
	added: string[];
	updated: string[];
	retired: string[];
}

function sameMetric(
	a: { value: string; phrase: string },
	b: { value: string; phrase: string },
): boolean {
	return (
		normValue(a.value) === normValue(b.value) ||
		normValue(a.phrase) === normValue(b.phrase)
	);
}

function mergeMetrics(
	bullet: MasterBullet,
	incoming: IntakeBullet["metrics"],
	log: MergeLog,
): void {
	for (const dm of incoming) {
		const existing = bullet.metrics.find((m) => sameMetric(m, dm));
		if (existing) {
			if (existing.status === "estimated") {
				existing.status = "fact";
				existing.source_ref = dm.source_ref;
			}
			continue;
		}
		const id = nextMetricId(bullet);
		bullet.metrics.push({
			id,
			phrase: dm.phrase,
			value: dm.value,
			status: "fact",
			source_ref: dm.source_ref,
		});
		log.added.push(id);
	}
}

function newBullet(
	role: MasterRole,
	d: IntakeBullet,
	log: MergeLog,
): MasterBullet {
	const id = bulletId(role.id, role.next_bullet);
	role.next_bullet += 1;
	const b: MasterBullet = {
		id,
		text: d.text,
		skills: d.skills,
		fields: d.fields,
		source_refs: d.source_refs,
		metrics: [],
	};
	log.added.push(id);
	mergeMetrics(b, d.metrics, log);
	return b;
}

function updateBullet(b: MasterBullet, d: IntakeBullet, log: MergeLog): void {
	const before = JSON.stringify(b);
	b.text = d.text;
	b.skills = d.skills;
	b.fields = d.fields;
	b.source_refs = d.source_refs;
	delete b.retired;
	mergeMetrics(b, d.metrics, log);
	if (JSON.stringify(b) !== before) log.updated.push(b.id);
}

function mergeBullets(
	role: MasterRole,
	incoming: IntakeBullet[],
	log: MergeLog,
): void {
	const claimed = new Set<string>();
	const assigned = new Map<IntakeBullet, MasterBullet>();
	for (const d of incoming) {
		const hit = d.match_id
			? role.bullets.find((b) => b.id === d.match_id && !claimed.has(b.id))
			: undefined;
		if (hit) {
			claimed.add(hit.id);
			assigned.set(d, hit);
		}
	}
	for (const d of incoming) {
		if (assigned.has(d)) continue;
		const hit = bestBullet(
			d.text,
			role.bullets.filter((b) => !claimed.has(b.id)),
		);
		if (hit) {
			claimed.add(hit.id);
			assigned.set(d, hit);
		}
	}
	for (const d of incoming) {
		const hit = assigned.get(d);
		if (hit) updateBullet(hit, d, log);
		else role.bullets.push(newBullet(role, d, log));
	}
	for (const b of role.bullets) {
		if (claimed.has(b.id) || b.retired || log.added.includes(b.id)) continue;
		b.retired = true;
		log.retired.push(b.id);
	}
}

function newRole(d: IntakeRole, taken: Set<string>, log: MergeLog): MasterRole {
	const id = uniqueId(baseRoleId(d), taken);
	taken.add(id);
	const role: MasterRole = {
		id,
		kind: d.kind,
		employer: d.employer,
		title: d.title,
		...titleVariantsOf(d),
		start: d.start,
		end: normEnd(d.end),
		...(d.location ? { location: d.location } : {}),
		next_bullet: 1,
		bullets: [],
	};
	log.added.push(id);
	for (const b of d.bullets) role.bullets.push(newBullet(role, b, log));
	return role;
}

/**
 * User-approved display titles for a role, trimmed and de-duplicated
 * (case-insensitive); the official title itself is dropped. Empty -> omitted.
 */
export function titleVariantsOf(
	d: Pick<IntakeRole, "title" | "title_variants">,
): { title_variants?: string[] } {
	const seen = new Set([d.title.trim().toLowerCase()]);
	const out: string[] = [];
	for (const raw of d.title_variants ?? []) {
		const t = raw.trim();
		const k = t.toLowerCase();
		if (!t || seen.has(k)) continue;
		seen.add(k);
		out.push(t);
	}
	return out.length ? { title_variants: out } : {};
}

function applyFacts(role: MasterRole, d: IntakeRole, log: MergeLog): void {
	const before = JSON.stringify({ ...role, bullets: [] });
	role.kind = d.kind;
	role.employer = d.employer;
	role.title = d.title;
	role.start = d.start;
	role.end = normEnd(d.end);
	if (d.location) role.location = d.location;
	// The experience front matter owns title_variants: a draft that carries the
	// field (even empty) replaces them; a draft without it keeps the master's.
	if (d.title_variants !== undefined) {
		const v = titleVariantsOf(d).title_variants;
		if (v) role.title_variants = v;
		else delete role.title_variants;
	}
	if (JSON.stringify({ ...role, bullets: [] }) !== before)
		log.updated.push(role.id);
}

function mergeSkills(existing: string[], seen: string[]): string[] {
	const byNorm = new Map<string, string>();
	for (const s of [...existing, ...seen]) {
		const n = normSkill(s);
		if (n && !byNorm.has(n)) byNorm.set(n, s.trim());
	}
	return [...byNorm.values()];
}

function mergeByKey<T>(
	existing: T[],
	incoming: T[],
	key: (t: T) => string,
): T[] {
	const out = new Map<string, T>();
	for (const t of existing) out.set(key(t), t);
	for (const t of incoming) out.set(key(t), t);
	return [...out.values()];
}

// --- lint -------------------------------------------------------------------

const NUMBER_TOKEN =
	/(?<![A-Za-z0-9.])[$€£₹]?\d[\d,.]*\s?(?:%|x|k|m|b|\+|ms|s|h|hrs?|hours|days|weeks|months|years|yrs)?(?![A-Za-z0-9])/gi;

/** Digit tokens a reader would take as a claim (tokens glued to letters, e.g. S3/EC2, are skipped). */
export function digitTokens(text: string): string[] {
	return [...text.matchAll(NUMBER_TOKEN)]
		.map((m) => normToken(m[0]))
		.filter((t) => /\d/.test(t));
}

function normToken(t: string): string {
	return t
		.toLowerCase()
		.replace(/[\s,]+/g, "")
		.replace(/[.]+$/, "");
}

function lintRole(role: MasterRole): LintWarning[] {
	const out: LintWarning[] = [];
	const years = new Set([role.start.slice(0, 4), role.end.slice(0, 4)]);
	for (const b of role.bullets) {
		if (b.retired) continue;
		const known = new Set<string>();
		for (const m of b.metrics) {
			if (m.status === "rejected") continue;
			known.add(normValue(m.value));
			for (const t of [...digitTokens(m.value), ...digitTokens(m.phrase)])
				known.add(t);
		}
		for (const t of new Set(digitTokens(b.text))) {
			if (known.has(t) || years.has(t)) continue;
			out.push({
				code: "NUMBER_NO_METRIC",
				role_id: role.id,
				bullet_id: b.id,
				token: t,
				message: `"${t}" in ${b.id} has no metric; add it to the source as a stated number or let metric-miner propose one`,
			});
		}
	}
	return out;
}

// --- entry point ------------------------------------------------------------

function parseDraft(draft: unknown): IntakeDraft {
	const r = IntakeDraft.safeParse(draft);
	if (r.success) return r.data;
	throw new ValidationError(
		"intake draft is invalid",
		r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
	);
}

function emptyResult(
	dryRun: boolean,
	conflicts: IngestConflict[],
): IngestResult {
	return {
		added: [],
		updated: [],
		retired: [],
		conflicts,
		lint: [],
		written: false,
		dry_run: dryRun,
	};
}

interface RoleMergeOutcome {
	conflicts: IngestConflict[];
	missing: MasterRole[];
}

function mergeRoles(
	master: MasterResume,
	draft: IntakeDraft,
	o: IngestOptions,
	log: MergeLog,
): RoleMergeOutcome {
	const claimed = new Set<string>();
	const pairs: [IntakeRole, MasterRole | undefined][] = draft.roles.map((d) => {
		const hit = matchRole(d, master.roles, claimed);
		if (hit) claimed.add(hit.id);
		return [d, hit];
	});
	const conflicts = o.allowFactChanges
		? []
		: pairs.flatMap(([d, hit]) => (hit ? factDiffs(hit, d) : []));
	if (conflicts.length) return { conflicts, missing: [] };
	const taken = new Set(master.roles.map((r) => r.id));
	for (const [d, hit] of pairs) {
		if (!hit) {
			master.roles.push(newRole(d, taken, log));
			continue;
		}
		applyFacts(hit, d, log);
		mergeBullets(hit, d.bullets, log);
	}
	return {
		conflicts: [],
		missing: master.roles.filter(
			(r) => !claimed.has(r.id) && !log.added.includes(r.id),
		),
	};
}

/**
 * Merge a resume-intake draft into me/master-resume.yaml with stable ids.
 * Conflicts (draft-reported, bad dates, or changed fixed facts) abort without writing.
 */
export function ingestDraft(
	input: unknown,
	o: IngestOptions = {},
): IngestResult {
	const paths = o.paths ?? mePaths();
	const dryRun = Boolean(o.dryRun);
	const draft = parseDraft(input);
	const pre: IngestConflict[] = [
		...draft.conflicts.map((c) => ({ kind: "draft" as const, ...c })),
		...draft.roles.flatMap((r) => dateConflicts(r, baseRoleId(r))),
	];
	if (pre.length) return emptyResult(dryRun, pre);

	const exists = existsSync(paths.masterResume);
	const master = exists ? structuredClone(loadMaster(paths)) : emptyMaster();
	const log: MergeLog = { added: [], updated: [], retired: [] };
	const merged = mergeRoles(master, draft, o, log);
	if (merged.conflicts.length) return emptyResult(dryRun, merged.conflicts);

	master.skills = mergeSkills(master.skills, draft.skills_seen);
	master.education = mergeByKey(
		master.education,
		draft.education,
		(e) => `${slug(e.school)}|${slug(e.degree)}|${slug(e.field)}`,
	);
	master.certifications = mergeByKey(
		master.certifications,
		draft.certifications,
		(c) => slug(c.name),
	);
	master.publications = mergeByKey(
		master.publications,
		draft.publications,
		(p) => slug(p.title, 80),
	);
	const ledger = loadLedger(paths);
	applyLedger(master, ledger);

	const lint: LintWarning[] = [
		...merged.missing.map((r) => ({
			code: "ROLE_MISSING" as const,
			role_id: r.id,
			message: `${r.id} is in the master resume but not in this draft; it was kept unchanged`,
		})),
		...master.roles.flatMap(lintRole),
	];
	const yaml = masterToYaml(master);
	const before = exists ? readFileSync(paths.masterResume, "utf8") : null;
	const changed = yaml !== before;
	if (!dryRun) {
		if (changed) writeFileAtomic(paths.masterResume, yaml);
		if (changed || !existsSync(paths.metricsMd))
			writeFileAtomic(paths.metricsMd, renderMetricsMd(master, ledger));
		writeIntakeState(paths, o.now ?? new Date());
	}
	return {
		...log,
		conflicts: [],
		lint,
		written: changed && !dryRun,
		dry_run: dryRun,
	};
}
