/**
 * Deterministic "resume vs JD" comparison: which must-haves the finalized
 * tailored resume evidences (and with which lines), which are missing, how
 * many snapshot keywords it covers, and how its titles line up with the
 * posted title. No LLM involved; same input, same output.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import {
	containsTitle,
	countKeyword,
	normTerm,
	tokens,
} from "../ats/keywords.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { artifactsDir } from "../core/paths.js";
import type { Db } from "../db/index.js";
import { getJdSnapshot } from "../db/jd.js";
import { getApplication } from "../db/repo.js";
import { getDraft, getRun, latestFinalRun } from "../db/resume.js";
import { loadProfile } from "../me/load.js";
import {
	allRoles,
	shownTitle,
	TailoredResume,
	type TRole,
	usesTitleVariant,
} from "../resume/schema.js";
import { isInside } from "../tracking/interviews.js";
import type { JdSnapshotRecord, JdTerm } from "./schema.js";

export type LineKind = "headline" | "summary" | "bullet" | "skills" | "title";

export interface ResumeLine {
	kind: LineKind;
	/** Tailored bullet id, role id (title) or skill group; null for headline/summary. */
	id: string | null;
	text: string;
}

export interface MustHaveResult {
	term: string;
	/** True when at least one experience/project bullet shows the term in use. */
	covered: boolean;
	/** Bullet and summary lines that mention the term (the evidence). */
	evidence: ResumeLine[];
	/** Other places it appears (headline, skills, titles); not evidence on their own. */
	also_in: LineKind[];
}

export interface TitleRow {
	role_id: string;
	employer: string;
	official: string;
	shown: string;
	uses_variant: boolean;
}

export interface JdCompare {
	app_id: number;
	resume_source: string | null;
	snapshot: JdSnapshotRecord;
	must_haves: MustHaveResult[];
	missing_must_haves: string[];
	must_have_coverage_pct: number | null;
	nice_to_haves: { term: string; covered: boolean }[];
	keywords: {
		total: number;
		covered: string[];
		missing: string[];
		coverage_pct: number | null;
	};
	titles: {
		posted: string;
		headline: string;
		headline_matches_posted: boolean;
		/** Headline contains one of profile.targets.roles; null when no targets are known. */
		headline_in_targets: boolean | null;
		display_titles: TitleRow[];
	};
}

/** Every line a reader sees, in document order. */
export function resumeLines(r: TailoredResume): ResumeLine[] {
	const out: ResumeLine[] = [
		{ kind: "headline", id: null, text: r.basics.headline },
		{ kind: "summary", id: null, text: r.summary.text },
		...(r.summary.highlights ?? []).map((h) => ({
			kind: "summary" as const,
			id: null,
			text: `${h.label}: ${h.text}`,
		})),
	];
	for (const g of r.skills)
		out.push({
			kind: "skills",
			id: g.group,
			text: `${g.group}: ${g.items.join(", ")}`,
		});
	for (const role of allRoles(r)) {
		out.push({ kind: "title", id: role.role_id, text: shownTitle(role) });
		for (const b of role.bullets)
			out.push({ kind: "bullet", id: b.id, text: b.text });
	}
	return out;
}

function mentions(line: ResumeLine, t: JdTerm): boolean {
	return countKeyword(tokens(line.text), t) > 0;
}

function pctOf(part: number, total: number): number | null {
	return total > 0 ? Math.round((part / total) * 100) : null;
}

function titleRow(role: TRole): TitleRow {
	return {
		role_id: role.role_id,
		employer: role.employer,
		official: role.title,
		shown: shownTitle(role),
		uses_variant: usesTitleVariant(role),
	};
}

/** Pure comparison of a tailored resume with a JD snapshot. */
export function compareResumeToJd(
	appId: number,
	r: TailoredResume,
	snap: JdSnapshotRecord,
	resumeSource: string | null = null,
	targets: readonly string[] = [],
): JdCompare {
	const lines = resumeLines(r);
	const must = snap.must_haves.map((t): MustHaveResult => {
		const hits = lines.filter((l) => mentions(l, t));
		const evidence = hits.filter(
			(l) => l.kind === "bullet" || l.kind === "summary",
		);
		const also = [
			...new Set(
				hits
					.filter((l) => l.kind !== "bullet" && l.kind !== "summary")
					.map((l) => l.kind),
			),
		];
		return {
			term: t.term,
			covered: evidence.some((l) => l.kind === "bullet"),
			evidence,
			also_in: also,
		};
	});
	const anywhere = (t: JdTerm) => lines.some((l) => mentions(l, t));
	// Keywords inherit the aliases of the must-have / nice-to-have with the same term.
	const aliasMap = new Map<string, string[]>();
	for (const t of [...snap.must_haves, ...snap.nice_to_haves]) {
		const key = normTerm(t.term);
		aliasMap.set(key, [...(aliasMap.get(key) ?? []), ...t.aliases]);
	}
	const covered = snap.keywords.filter((k) =>
		anywhere({ term: k, aliases: aliasMap.get(normTerm(k)) ?? [] }),
	);
	const missing = snap.keywords.filter((k) => !covered.includes(k));
	const coveredMust = must.filter((m) => m.covered).length;
	return {
		app_id: appId,
		resume_source: resumeSource,
		snapshot: snap,
		must_haves: must,
		missing_must_haves: must.filter((m) => !m.covered).map((m) => m.term),
		must_have_coverage_pct: pctOf(coveredMust, must.length),
		nice_to_haves: snap.nice_to_haves.map((t) => ({
			term: t.term,
			covered: anywhere(t),
		})),
		keywords: {
			total: snap.keywords.length,
			covered,
			missing,
			coverage_pct: pctOf(covered.length, snap.keywords.length),
		},
		titles: {
			posted: snap.title_posted,
			headline: r.basics.headline,
			headline_matches_posted: containsTitle(
				r.basics.headline,
				snap.title_posted,
			),
			headline_in_targets:
				targets.length > 0
					? targets.some((t) => containsTitle(r.basics.headline, t))
					: null,
			display_titles: allRoles(r).map(titleRow),
		},
	};
}

function readResume(path: string): TailoredResume {
	let raw: unknown;
	try {
		raw = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/, ""));
	} catch (e) {
		throw new ValidationError(
			`resume JSON is unreadable: ${(e as Error).message}`,
		);
	}
	return TailoredResume.parse(raw);
}

/** A path is usable only when it exists and really resolves inside artifacts/. */
function insideArtifacts(path: string): string | null {
	const root = artifactsDir();
	if (!existsSync(path) || !existsSync(root)) return null;
	const real = realpathSync(path);
	return isInside(realpathSync(root), real) ? real : null;
}

/**
 * The finalized tailored resume of an application: <artifacts>/<app>/resume.json,
 * else the final draft of the latest finalized run. Only files inside the
 * artifacts directory are read.
 */
export function loadFinalResume(
	db: Db,
	appId: number,
): { resume: TailoredResume; path: string } {
	const run = latestFinalRun(db, appId);
	if (!run)
		throw new NotFoundError(`application ${appId} has no finalized resume yet`);
	const candidates = [join(artifactsDir(appId), "resume.json")];
	const full = getRun(db, run.run_id);
	const draft = full?.final_draft_id
		? getDraft(db, run.run_id, full.final_draft_id)
		: undefined;
	if (draft) candidates.push(draft.path);
	for (const c of candidates) {
		const real = insideArtifacts(c);
		if (real) return { resume: readResume(real), path: real };
	}
	throw new NotFoundError(
		`finalized resume file for application ${appId} is missing`,
	);
}

/** The user's profile.targets.roles, or [] when no readable profile exists. */
export function profileTargetRoles(): string[] {
	try {
		return loadProfile().targets?.roles ?? [];
	} catch {
		return [];
	}
}

/**
 * Compare an application's JD snapshot with its finalized resume, or with an
 * explicit draft file (`draftPath`, used during /resume before finalize).
 */
export function jdCompareForApp(
	db: Db,
	appId: number,
	o: { draftPath?: string; targets?: readonly string[] } = {},
): JdCompare {
	if (!getApplication(db, appId))
		throw new NotFoundError(`application ${appId} not found`);
	const targets = o.targets ?? profileTargetRoles();
	const snap = getJdSnapshot(db, appId);
	if (!snap)
		throw new NotFoundError(
			`application ${appId} has no JD snapshot; run jh jd snapshot set first`,
			undefined,
			"no_snapshot",
		);
	if (o.draftPath) {
		const p = resolve(o.draftPath);
		if (!existsSync(p))
			throw new NotFoundError(`file not found: ${o.draftPath}`);
		return compareResumeToJd(appId, readResume(p), snap, p, targets);
	}
	const { resume, path } = loadFinalResume(db, appId);
	return compareResumeToJd(appId, resume, snap, path, targets);
}
