import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	isMap,
	isScalar,
	isSeq,
	parseDocument,
	parse as parseYaml,
} from "yaml";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { mePaths } from "../core/paths.js";
import { loadProfile, writeFileAtomic } from "../me/load.js";
import type { Profile } from "../me/schema.js";
import { applyOps, deepEqual, getIn, splitPath } from "./ops.js";
import {
	type Correction,
	DecisionPolicy,
	ESCALATE_KINDS,
	type PolicyOp,
	USER_ONLY_PREFIXES,
	WRITABLE_ROOTS,
} from "./schema.js";

export const POLICY_FILE = "decision-policy.yaml";

export function policyPath(meRoot: string = mePaths().root): string {
	return join(meRoot, POLICY_FILE);
}

/** Values derived from profile.yaml (lower precedence than the policy file). */
export interface Derived {
	target_titles: string[];
	seniority: string[];
	exclude_words: string[];
	company_blocklist: string[];
	daily_cap: number | null;
	submit_without_confirm: boolean | null;
}

export interface EffectivePolicy {
	path: string;
	exists: boolean;
	/** File sections with corrections replayed on top (precedence: corrections > sections). */
	policy: DecisionPolicy;
	/** The file as written, before the corrections replay. */
	file: DecisionPolicy;
	derived: Derived;
	rev: number;
}

function readRaw(path: string): Record<string, unknown> {
	if (!existsSync(path)) return {};
	let raw: unknown;
	try {
		raw = parseYaml(readFileSync(path, "utf8").replace(/^﻿/, ""));
	} catch (e) {
		throw new ValidationError(
			`decision policy is not valid YAML: ${(e as Error).message}`,
			{ file: path },
		);
	}
	if (raw === null || raw === undefined) return {};
	if (typeof raw !== "object" || Array.isArray(raw))
		throw new ValidationError("decision policy must be a YAML mapping", {
			file: path,
		});
	return raw as Record<string, unknown>;
}

export function parsePolicy(raw: unknown, file = POLICY_FILE): DecisionPolicy {
	const parsed = DecisionPolicy.safeParse(raw ?? {});
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => ({
			path: i.path.join("."),
			message: i.message,
		}));
		throw new ValidationError(`decision policy is invalid (${file})`, issues);
	}
	return parsed.data;
}

/**
 * Replay every correction's ops, in order, on a copy of the parsed file (so a
 * list op on a section the file leaves to defaults starts from the default).
 */
export function replayCorrections(
	base: DecisionPolicy | Record<string, unknown>,
	corrections: readonly Correction[],
): Record<string, unknown> {
	const copy = structuredClone(base) as Record<string, unknown>;
	for (const c of corrections) applyOps(copy, c.ops);
	return copy;
}

function strList(v: unknown): string[] {
	return Array.isArray(v)
		? v.filter((x): x is string => typeof x === "string" && x.trim() !== "")
		: [];
}

export function deriveFromProfile(profile: Profile | null): Derived {
	const p = (profile ?? {}) as Record<string, unknown>;
	const targets = (p.targets ?? {}) as Record<string, unknown>;
	const autonomy = (p.autonomy ?? {}) as Record<string, unknown>;
	const cap = autonomy.daily_apply_cap;
	const swc = autonomy.submit_without_confirm;
	return {
		target_titles: strList(targets.roles),
		seniority: strList(targets.seniority),
		exclude_words: strList(targets.title_exclude),
		company_blocklist: strList(p.company_blocklist),
		daily_cap: typeof cap === "number" && cap > 0 ? cap : null,
		submit_without_confirm: typeof swc === "boolean" ? swc : null,
	};
}

function tryProfile(): Profile | null {
	try {
		return loadProfile();
	} catch (e) {
		if (e instanceof NotFoundError) return null;
		throw e;
	}
}

/** Build the effective policy from raw file data and an optional profile. Pure. */
export function buildEffective(
	raw: Record<string, unknown>,
	profile: Profile | null,
	path = POLICY_FILE,
	exists = true,
): EffectivePolicy {
	const file = parsePolicy(raw, path);
	const policy = parsePolicy(replayCorrections(file, file.corrections), path);
	return {
		path,
		exists,
		policy,
		file,
		derived: deriveFromProfile(profile),
		rev: policy.rev,
	};
}

export function loadEffective(
	o: { path?: string; profile?: Profile | null } = {},
): EffectivePolicy {
	const path = o.path ?? policyPath();
	const profile = o.profile === undefined ? tryProfile() : o.profile;
	return buildEffective(readRaw(path), profile, path, existsSync(path));
}

// ------------------------------------------------------------------ resolved views

function uniqCi(list: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const s of list) {
		const k = s.toLowerCase();
		if (!seen.has(k)) {
			seen.add(k);
			out.push(s);
		}
	}
	return out;
}

/** Title families, blocklist, level band and cap after merging the profile layer. */
export function resolved(e: EffectivePolicy) {
	const t = e.policy.triage;
	return {
		target_titles: uniqCi([
			...(t.titles.include_from === "targets" ? e.derived.target_titles : []),
			...t.titles.include,
		]),
		company_blocklist: uniqCi([
			...t.company_blocklist,
			...e.derived.company_blocklist,
		]),
		exclude_words: uniqCi([
			...t.level_band.exclude_words,
			...e.derived.exclude_words,
		]),
		seniority: t.level_band.seniority.length
			? t.level_band.seniority
			: e.derived.seniority,
		daily_cap: e.policy.preflight.daily_cap ?? e.derived.daily_cap,
	};
}

// ------------------------------------------------------------------ record

export interface RecordInput {
	actor: string;
	ops: PolicyOp[];
	quote?: string;
	reason?: string;
	at?: string;
}

function startsWithPath(path: string, prefix: string): boolean {
	return path === prefix || path.startsWith(`${prefix}.`);
}

/**
 * Authorization for policy ops. User-only: `submit.*`, `eligibility.overrides`,
 * and removing an escalate kind. `--actor user` needs the user's own words.
 */
export function authorize(input: RecordInput, current: DecisionPolicy): void {
	const isUser = input.actor === "user";
	if (isUser && !input.quote?.trim())
		throw new ValidationError(
			"--actor user needs --quote with the user's own words",
			undefined,
			"quote_required",
		);
	for (const o of input.ops) {
		const parts = splitPath(o.path);
		const root = parts[0] as string;
		if (!(WRITABLE_ROOTS as readonly string[]).includes(root))
			throw new ValidationError(
				`${o.path} is not writable (allowed roots: ${WRITABLE_ROOTS.join(", ")})`,
				{ path: o.path },
				"path_not_writable",
			);
		if (isUser) continue;
		const userOnly = USER_ONLY_PREFIXES.some(
			(p) => startsWithPath(o.path, p) || startsWithPath(p, o.path),
		);
		if (userOnly)
			throw new ValidationError(
				`${o.path} can only be changed by the user (--actor user)`,
				{ path: o.path, actor: input.actor },
				"user_only_field",
			);
		if (startsWithPath("escalate.kinds", o.path)) {
			const before = current.escalate.kinds;
			const after = getIn(applyOps({ escalate: { kinds: [...before] } }, [o]), [
				"escalate",
				"kinds",
			]);
			const afterList = Array.isArray(after) ? after : [];
			const removed = before.filter((k) => !afterList.includes(k));
			if (removed.length)
				throw new ValidationError(
					`only the user can remove an escalate kind (${removed.join(", ")})`,
					{ removed, actor: input.actor },
					"user_only_field",
				);
		}
	}
}

export interface RecordResult {
	path: string;
	rev: number;
	correction: Correction;
}

const NEW_FILE =
	"# me/decision-policy.yaml: the structured decision policy (ADR-005).\n" +
	"# Change it with `jh policy record`; every change is appended to `corrections`.\n" +
	"version: 1\nrev: 0\n";

/**
 * Apply ops to the policy file (comments preserved), append a correction with
 * the next rev, validate the result and write it atomically.
 */
export function recordPolicy(
	input: RecordInput,
	path: string = policyPath(),
): RecordResult {
	if (!input.ops.length)
		throw new ValidationError(
			"nothing to record: pass --set, --add or --remove",
		);
	const text = existsSync(path)
		? readFileSync(path, "utf8").replace(/^﻿/, "")
		: NEW_FILE;
	const doc = parseDocument(text);
	if (doc.errors.length)
		throw new ValidationError(
			`decision policy is not valid YAML: ${doc.errors[0]?.message}`,
		);
	const raw = (doc.toJS() ?? {}) as Record<string, unknown>;
	const fileParsed = parsePolicy(raw, path);
	const before = parsePolicy(
		replayCorrections(fileParsed, fileParsed.corrections),
		path,
	);
	authorize(input, before);

	for (const o of input.ops) {
		const parts = splitPath(o.path);
		if (o.op === "set") {
			doc.setIn(parts, doc.createNode(o.value));
			continue;
		}
		const cur = doc.getIn(parts, true);
		if (doc.getIn(parts) != null && !isSeq(cur))
			throw new ValidationError(`${o.path} is not a list`, { path: o.path });
		const fromFile = getIn(fileParsed, parts);
		const js = isSeq(cur)
			? (cur.toJSON() as unknown[])
			: Array.isArray(fromFile)
				? [...fromFile]
				: [];
		const next = applyOps({ v: js }, [{ ...o, path: "v" }]).v as unknown[];
		if (!deepEqual(js, next) || !isSeq(cur))
			doc.setIn(parts, doc.createNode(next));
	}

	const rev = before.rev + 1;
	const at = input.at ?? new Date().toISOString();
	const correction: Correction = {
		rev,
		at,
		actor: input.actor,
		ops: input.ops,
		...(input.quote ? { quote: input.quote } : {}),
		...(input.reason ? { reason: input.reason } : {}),
	};
	doc.setIn(["rev"], rev);
	if (!doc.has("updated_at") && isMap(doc.contents)) {
		// Keep updated_at next to rev rather than at the end of the file.
		const items = doc.contents.items;
		const i = items.findIndex(
			(p) => isScalar(p.key) && (p.key as { value: unknown }).value === "rev",
		);
		items.splice(i + 1, 0, doc.createPair("updated_at", at));
	} else doc.set("updated_at", at);
	const corr = doc.get("corrections", true);
	if (corr && isSeq(corr)) {
		corr.flow = false; // "corrections: []" in a template is a flow seq; log entries read better as blocks
		corr.add(doc.createNode(correction));
	} else doc.set("corrections", doc.createNode([correction]));
	if (!isMap(doc.contents))
		throw new ValidationError("decision policy must be a YAML mapping");

	const after = (doc.toJS() ?? {}) as Record<string, unknown>;
	parsePolicy(after, path);
	const afterFile = parsePolicy(after, path);
	parsePolicy(replayCorrections(afterFile, afterFile.corrections), path);
	writeFileAtomic(path, doc.toString({ lineWidth: 0 }));
	return { path, rev, correction };
}

/** All six escalate kinds, for checks. */
export const REQUIRED_ESCALATE_KINDS = ESCALATE_KINDS;
