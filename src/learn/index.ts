import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db/index.js";
import {
	getLearnState,
	type LearnState,
	listOutcomeEmails,
	listOutcomeEvents,
	listOutcomeRows,
	setLearnState,
} from "../db/learn.js";
import {
	type Analysis,
	type AnalyzeOptions,
	analyze,
	buildSamples,
	type Exploration,
	type FeatureStat,
	type Pattern,
	shouldExplore,
	type Totals,
	type WeeklyPoint,
} from "./analyze.js";

export {
	getVariant,
	type ResumeVariant,
	ResumeVariantInput,
	recordVariant,
} from "../db/learn.js";
export * from "./analyze.js";
export * from "./features.js";
export * from "./playbook.js";

/** New resolved outcomes since the last analysis that make /learn due. */
export const NEW_OUTCOMES_TRIGGER = 5;
/** Days since the last analysis that make /learn due. */
export const WEEKLY_TRIGGER_DAYS = 7;

/** Payload for the dashboard "What's working" card (GET /api/learn). */
export interface LearnSummary {
	generated_at: string;
	totals: Totals;
	callback_rate: number | null;
	median_time_to_response_days: number | null;
	weekly: WeeklyPoint[];
	by_framing: FeatureStat[];
	by_angle: FeatureStat[];
	by_title_choice: FeatureStat[];
	top_patterns: Pattern[];
	exploration: Exploration;
	last_run_at: string | null;
	new_outcomes: number;
}

export interface LearnStatus {
	last_run_at: string | null;
	resolved_now: number;
	resolved_at_last_run: number;
	new_outcomes: number;
	days_since_last_run: number | null;
	due: boolean;
	reason: string;
	playbook_path: string | null;
	playbook_exists: boolean;
	stats_path: string | null;
	explore?: { app_id: number; explore: boolean; ratio: number };
}

/** Load outcomes from the DB and run the deterministic analysis. */
export function runAnalysis(db: Db, opts: AnalyzeOptions = {}): Analysis {
	const samples = buildSamples(
		listOutcomeRows(db),
		listOutcomeEvents(db),
		listOutcomeEmails(db),
		opts,
	);
	return analyze(samples, opts);
}

export function learnSummary(db: Db, now: Date = new Date()): LearnSummary {
	const a = runAnalysis(db, { now });
	const state = getLearnState(db);
	return {
		generated_at: a.generated_at,
		totals: a.totals,
		callback_rate: a.baseline.rate,
		median_time_to_response_days: a.median_time_to_response_days,
		weekly: a.weekly,
		by_framing: a.features.framing,
		by_angle: a.features.angle,
		by_title_choice: a.features.title_choice,
		top_patterns: a.patterns.slice(0, 5),
		exploration: a.exploration,
		last_run_at: state.last_run_at,
		new_outcomes: Math.max(0, a.totals.resolved - state.resolved_at_last_run),
	};
}

/** `<me>/learnings` */
export function learningsDir(meRoot: string): string {
	return join(meRoot, "learnings");
}

export function writeStats(dir: string, a: Analysis): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "stats.json");
	writeFileSync(path, `${JSON.stringify(a, null, 2)}\n`, "utf8");
	return path;
}

export function writePlaybook(dir: string, md: string): string {
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "playbook.md");
	writeFileSync(path, md.endsWith("\n") ? md : `${md}\n`, "utf8");
	return path;
}

/** Remember this run so `learn status` can count new outcomes. */
export function markRun(db: Db, a: Analysis): LearnState {
	const state: LearnState = {
		last_run_at: a.generated_at,
		resolved_at_last_run: a.totals.resolved,
	};
	setLearnState(db, state);
	return state;
}

function dueReason(
	resolved: number,
	newOutcomes: number,
	days: number | null,
): { due: boolean; reason: string } {
	if (resolved === 0) return { due: false, reason: "no resolved outcomes yet" };
	if (days === null) return { due: true, reason: "never analyzed" };
	if (newOutcomes >= NEW_OUTCOMES_TRIGGER)
		return { due: true, reason: `${newOutcomes} new outcomes since last run` };
	if (days >= WEEKLY_TRIGGER_DAYS && newOutcomes > 0)
		return { due: true, reason: `${Math.floor(days)} days since last run` };
	return { due: false, reason: "up to date" };
}

/** Whether /learn should run now, and where its outputs live. dir = learnings dir or null if me/ is absent. */
export function learnStatus(
	db: Db,
	dir: string | null,
	o: { now?: Date; appId?: number } = {},
): LearnStatus {
	const now = o.now ?? new Date();
	const a = runAnalysis(db, { now });
	const state = getLearnState(db);
	const newOutcomes = Math.max(
		0,
		a.totals.resolved - state.resolved_at_last_run,
	);
	const days = state.last_run_at
		? (now.getTime() - Date.parse(state.last_run_at)) / 86_400_000
		: null;
	const playbookPath = dir ? join(dir, "playbook.md") : null;
	const status: LearnStatus = {
		last_run_at: state.last_run_at,
		resolved_now: a.totals.resolved,
		resolved_at_last_run: state.resolved_at_last_run,
		new_outcomes: newOutcomes,
		days_since_last_run: days === null ? null : Math.round(days * 10) / 10,
		...dueReason(a.totals.resolved, newOutcomes, days),
		playbook_path: playbookPath,
		playbook_exists: playbookPath ? existsSync(playbookPath) : false,
		stats_path: dir ? join(dir, "stats.json") : null,
	};
	if (o.appId !== undefined) {
		const ratio = a.params.exploration_ratio;
		status.explore = {
			app_id: o.appId,
			explore: shouldExplore(o.appId, ratio),
			ratio,
		};
	}
	return status;
}
