/**
 * Study clock: blocks, sessions (one open at a time), on-time, streak, ISO-week hours.
 * All local-date maths uses the `timezone` setting (default: system zone).
 */
import { audit } from "../core/audit.js";
import { ConflictError, NotFoundError } from "../core/errors.js";
import type { Db } from "../db/index.js";
import { getSetting, timezone } from "../db/repo.js";
import {
	closeSession,
	completeTask,
	getSession,
	getTask,
	insertSession,
	insertTask,
	listBlocks,
	listTasks,
	openSession,
	recentSessions,
	sessionsSince,
} from "../db/tracking.js";
import type {
	BlockStatus,
	StudyBlock,
	StudySession,
	StudySettings,
	StudySummary,
	StudyTask,
} from "./schemas.js";
import {
	addDaysKey,
	addMinutes,
	isoDow,
	isoWeekStartKey,
	isValidTimeZone,
	localDateKey,
	minutesBetween,
	minutesPerLocalDay,
	overlapMinutes,
	startOfLocalDay,
	systemTimeZone,
	zonedToUtc,
} from "./time.js";

export const STUDY_DEFAULTS: StudySettings = {
	graceMinutes: 30,
	streakMinMinutes: 60,
	maxSessionMinutes: 240,
	weeklyGoalHours: 15,
};

/** How far back the summary loads sessions (bounds the streak). */
const HISTORY_DAYS = 370;

export function studySettings(db: Db): StudySettings {
	const num = (key: string, fallback: number): number => {
		const v = Number(getSetting<unknown>(db, key, fallback));
		return Number.isFinite(v) ? v : fallback;
	};
	return {
		graceMinutes: num("study.grace_minutes", STUDY_DEFAULTS.graceMinutes),
		streakMinMinutes: num(
			"study.streak_min_minutes",
			STUDY_DEFAULTS.streakMinMinutes,
		),
		maxSessionMinutes: num(
			"study.max_session_minutes",
			STUDY_DEFAULTS.maxSessionMinutes,
		),
		weeklyGoalHours: num(
			"study.weekly_goal_hours",
			STUDY_DEFAULTS.weeklyGoalHours,
		),
	};
}

export function studyTimeZone(db: Db): string {
	const tz = timezone(db);
	return tz && isValidTimeZone(tz) ? tz : systemTimeZone();
}

/** Effective end of a session: ended_at, else now (optionally capped). */
export function sessionEnd(
	s: StudySession,
	now: Date,
	maxMinutes?: number,
): Date {
	if (s.ended_at) return new Date(s.ended_at);
	if (maxMinutes === undefined) return now;
	const cap = addMinutes(new Date(s.started_at), maxMinutes);
	return cap.getTime() < now.getTime() ? cap : now;
}

export function sessionMinutes(
	s: StudySession,
	now: Date,
	maxMinutes?: number,
): number {
	return Math.max(
		0,
		minutesBetween(new Date(s.started_at), sessionEnd(s, now, maxMinutes)),
	);
}

function blockDays(b: StudyBlock): number[] {
	return b.days.split(",").map(Number);
}

function blockWindow(
	b: StudyBlock,
	dayKey: string,
	tz: string,
): { start: Date; end: Date } {
	return {
		start: zonedToUtc(dayKey, b.start_local, tz),
		end: zonedToUtc(dayKey, b.end_local, tz),
	};
}

/** Blocks scheduled on the local day of `now`. */
export function blocksToday(
	blocks: StudyBlock[],
	now: Date,
	tz: string,
): StudyBlock[] {
	const dow = isoDow(localDateKey(now, tz));
	return blocks.filter((b) => b.active && blockDays(b).includes(dow));
}

/**
 * The block a clock-in at `now` belongs to: its window, opened `grace` minutes early.
 * Outside every block -> null (counts for hours and streak, not on-time).
 */
export function blockFor(
	blocks: StudyBlock[],
	now: Date,
	tz: string,
	graceMinutes: number,
): StudyBlock | null {
	const today = localDateKey(now, tz);
	for (const b of blocksToday(blocks, now, tz)) {
		const w = blockWindow(b, today, tz);
		const opens = addMinutes(w.start, -graceMinutes).getTime();
		if (now.getTime() >= opens && now.getTime() < w.end.getTime()) return b;
	}
	return null;
}

function stateOf(
	now: Date,
	w: { start: Date; end: Date },
	clockedIn: boolean,
	minutes: number,
): BlockStatus["state"] {
	if (clockedIn) return "in_progress";
	if (now.getTime() < w.start.getTime()) return "upcoming";
	if (now.getTime() < w.end.getTime()) return "in_progress";
	return minutes > 0 ? "done" : "missed";
}

export function blockStatusToday(
	blocks: StudyBlock[],
	sessions: StudySession[],
	now: Date,
	tz: string,
	s: StudySettings,
): BlockStatus[] {
	const today = localDateKey(now, tz);
	return blocksToday(blocks, now, tz).map((b) => {
		const w = blockWindow(b, today, tz);
		const mine = sessions.filter(
			(x) =>
				x.block_id === b.id &&
				localDateKey(new Date(x.started_at), tz) === today,
		);
		const minutes = mine.reduce(
			(sum, x) => sum + sessionMinutes(x, now, s.maxSessionMinutes),
			0,
		);
		const clockedIn = mine.some((x) => x.ended_at === null);
		const firstStart = mine
			.map((x) => Date.parse(x.started_at))
			.sort((a, c) => a - c)[0];
		const onTime =
			firstStart === undefined
				? null
				: firstStart <= addMinutes(w.start, s.graceMinutes).getTime();
		return {
			block_id: b.id,
			label: b.label,
			start_local: b.start_local,
			end_local: b.end_local,
			start_at: w.start.toISOString(),
			end_at: w.end.toISOString(),
			state: stateOf(now, w, clockedIn, minutes),
			minutes: Math.round(minutes),
			on_time: onTime,
			clocked_in: clockedIn,
		};
	});
}

/** Minutes studied per local date, splitting sessions across midnight. */
export function minutesByDay(
	sessions: StudySession[],
	now: Date,
	tz: string,
): Map<string, number> {
	const totals = new Map<string, number>();
	for (const s of sessions) {
		const start = new Date(s.started_at);
		const end = sessionEnd(s, now);
		if (end.getTime() <= start.getTime()) continue;
		for (const [day, m] of minutesPerLocalDay(start, end, tz))
			totals.set(day, (totals.get(day) ?? 0) + m);
	}
	return totals;
}

/**
 * Consecutive days (ending today or yesterday) with >= minMinutes.
 * Today only counts once satisfied, so the streak never drops during the day.
 */
export function streak(
	sessions: StudySession[],
	now: Date,
	tz: string,
	minMinutes: number,
): number {
	const totals = minutesByDay(sessions, now, tz);
	const ok = (k: string): boolean => (totals.get(k) ?? 0) >= minMinutes;
	const today = localDateKey(now, tz);
	let key = ok(today) ? today : addDaysKey(today, -1);
	let n = 0;
	while (ok(key)) {
		n++;
		key = addDaysKey(key, -1);
	}
	return n;
}

/** Minutes studied in the current ISO week (Mon 00:00 local .. now). */
export function weeklyMinutes(
	sessions: StudySession[],
	now: Date,
	tz: string,
): number {
	const monday = isoWeekStartKey(localDateKey(now, tz));
	const weekStart = startOfLocalDay(monday, tz);
	const weekEnd = startOfLocalDay(addDaysKey(monday, 7), tz);
	const until = weekEnd.getTime() < now.getTime() ? weekEnd : now;
	const total = sessions.reduce(
		(sum, s) =>
			sum +
			overlapMinutes(
				new Date(s.started_at),
				sessionEnd(s, now),
				weekStart,
				until,
			),
		0,
	);
	return Math.round(total);
}

/** Close sessions open longer than the max at start+max, flagged auto_closed. */
export function autoCloseStale(db: Db, now: Date, maxMinutes: number): number {
	const open = openSession(db);
	if (!open) return 0;
	if (sessionMinutes(open, now) <= maxMinutes) return 0;
	const end = addMinutes(new Date(open.started_at), maxMinutes);
	closeSession(db, open.id, end.toISOString(), { autoClosed: true });
	audit({
		actor: "study",
		action: "study.auto_close",
		target: String(open.id),
	});
	return 1;
}

function conflict(reason: string): ConflictError {
	return new ConflictError(reason, { reason });
}

function isUniqueViolation(e: unknown): boolean {
	return e instanceof Error && /UNIQUE constraint/i.test(e.message);
}

export function clockIn(
	db: Db,
	o: { topic?: string; source: "cli" | "dashboard" },
	now: Date = new Date(),
): StudySession {
	const s = studySettings(db);
	const tz = studyTimeZone(db);
	autoCloseStale(db, now, s.maxSessionMinutes);
	if (openSession(db)) throw conflict("already_clocked_in");
	const block = blockFor(listBlocks(db), now, tz, s.graceMinutes);
	let id: number;
	try {
		id = insertSession(db, {
			block_id: block?.id ?? null,
			started_at: now.toISOString(),
			topic: o.topic || undefined,
			source: o.source,
		});
	} catch (e) {
		if (isUniqueViolation(e)) throw conflict("already_clocked_in");
		throw e;
	}
	audit({
		actor: o.source,
		action: "study.clock_in",
		target: String(id),
		detail: { topic: o.topic, block: block?.label ?? null },
	});
	return getSession(db, id) as StudySession;
}

export function clockOut(
	db: Db,
	o: { notes?: string },
	now: Date = new Date(),
): StudySession {
	const s = studySettings(db);
	const open = openSession(db);
	if (!open) throw conflict("not_clocked_in");
	const capped = sessionMinutes(open, now) > s.maxSessionMinutes;
	const end = capped
		? addMinutes(new Date(open.started_at), s.maxSessionMinutes)
		: now;
	closeSession(db, open.id, end.toISOString(), {
		notes: o.notes || undefined,
		autoClosed: capped,
	});
	audit({
		actor: "study",
		action: "study.clock_out",
		target: String(open.id),
		detail: { auto_closed: capped },
	});
	return getSession(db, open.id) as StudySession;
}

export function addStudyTask(
	db: Db,
	t: { title: string; planned_for?: string },
): StudyTask {
	const id = insertTask(db, t);
	return getTask(db, id) as StudyTask;
}

/** Mark a task done, attaching it to the open session if any. */
export function finishStudyTask(
	db: Db,
	id: number,
	now: Date = new Date(),
): StudyTask {
	const task = getTask(db, id);
	if (!task) throw new NotFoundError(`study task ${id} not found`);
	if (!task.done_at)
		completeTask(db, id, now.toISOString(), openSession(db)?.id ?? null);
	return getTask(db, id) as StudyTask;
}

export function studyTasks(db: Db, now: Date, tz: string): StudyTask[] {
	const todayStart = startOfLocalDay(localDateKey(now, tz), tz);
	return listTasks(db, { doneSinceIso: todayStart.toISOString() });
}

export function studySummary(db: Db, now: Date = new Date()): StudySummary {
	const s = studySettings(db);
	const tz = studyTimeZone(db);
	autoCloseStale(db, now, s.maxSessionMinutes);
	const today = localDateKey(now, tz);
	const since = startOfLocalDay(addDaysKey(today, -HISTORY_DAYS), tz);
	const sessions = sessionsSince(db, since.toISOString());
	const active = listBlocks(db, true);
	const open = openSession(db);
	const weekMin = weeklyMinutes(sessions, now, tz);
	const goalMinutes = Math.round(s.weeklyGoalHours * 60);
	return {
		tz,
		today,
		now: now.toISOString(),
		open: open
			? {
					...open,
					elapsed_minutes: Math.round(
						sessionMinutes(open, now, s.maxSessionMinutes),
					),
				}
			: null,
		blocks: blockStatusToday(active, sessions, now, tz, s),
		allBlocks: listBlocks(db, false),
		todayMinutes: Math.round(minutesByDay(sessions, now, tz).get(today) ?? 0),
		streak: streak(sessions, now, tz, s.streakMinMinutes),
		week: {
			minutes: weekMin,
			goalMinutes,
			pct: goalMinutes
				? Math.min(100, Math.round((weekMin / goalMinutes) * 100))
				: 0,
		},
		settings: s,
		tasks: studyTasks(db, now, tz),
		recent: recentSessions(db, 10),
	};
}
