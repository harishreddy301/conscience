import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { register } from "../../src/commands/study.js";
import { ConflictError } from "../../src/core/errors.js";
import { type Db, openDb } from "../../src/db/index.js";
import { setSetting } from "../../src/db/repo.js";
import { getSession, listBlocks } from "../../src/db/tracking.js";
import type { StudyBlock, StudySession } from "../../src/tracking/schemas.js";
import {
	addStudyTask,
	blockStatusToday,
	clockIn,
	clockOut,
	finishStudyTask,
	minutesByDay,
	STUDY_DEFAULTS,
	streak,
	studySummary,
	weeklyMinutes,
} from "../../src/tracking/study.js";
import {
	isoWeekStartKey,
	localDateKey,
	zonedToUtc,
} from "../../src/tracking/time.js";

const IST = "Asia/Kolkata";
const NY = "America/New_York";
let home: string;
let db: Db;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jh-study-"));
	process.env.JOB_HUNTER_HOME = home;
	db = openDb(":memory:");
	setSetting(db, "timezone", IST);
});
afterEach(() => {
	db.close();
	rmSync(home, { recursive: true, force: true });
	delete process.env.JOB_HUNTER_HOME;
});

/** Local wall time in a zone as a Date. */
const at = (day: string, hhmm: string, tz = IST): Date =>
	zonedToUtc(day, hhmm, tz);

let nextId = 1;
function session(
	start: Date,
	end: Date | null,
	blockId: number | null = null,
): StudySession {
	return {
		id: nextId++,
		block_id: blockId,
		started_at: start.toISOString(),
		ended_at: end ? end.toISOString() : null,
		topic: null,
		notes: null,
		source: "cli",
		auto_closed: 0,
	};
}

const BLOCK: StudyBlock = {
	id: 1,
	label: "Morning study",
	days: "1,2,3,4,5,6,7",
	start_local: "05:30",
	end_local: "08:00",
	active: 1,
	created_at: "2026-01-01T00:00:00Z",
};

describe("time helpers", () => {
	it("converts local wall time across DST", () => {
		expect(at("2026-10-31", "12:00", NY).toISOString()).toBe(
			"2026-10-31T16:00:00.000Z",
		);
		expect(at("2026-11-01", "12:00", NY).toISOString()).toBe(
			"2026-11-01T17:00:00.000Z",
		);
		expect(at("2026-03-08", "02:30", NY).toISOString()).toBe(
			"2026-03-08T07:30:00.000Z",
		);
		expect(isoWeekStartKey("2026-11-01")).toBe("2026-10-26");
		expect(localDateKey(new Date("2026-10-14T19:00:00Z"), IST)).toBe(
			"2026-10-15",
		);
	});
});

describe("seed defaults", () => {
	it("seeds the 05:30-08:00 Morning study block and a 15h goal", () => {
		expect(listBlocks(db)).toMatchObject([
			{ label: "Morning study", start_local: "05:30", end_local: "08:00" },
		]);
		const s = studySummary(db, at("2026-10-15", "04:00"));
		expect(s.settings).toEqual(STUDY_DEFAULTS);
		expect(s.week.goalMinutes).toBe(900);
		expect(s.tz).toBe(IST);
	});
});

describe("clockIn / clockOut", () => {
	it("clocking in twice throws ConflictError already_clocked_in", () => {
		clockIn(db, { source: "cli" }, at("2026-10-15", "06:00"));
		const again = () =>
			clockIn(db, { source: "cli" }, at("2026-10-15", "06:05"));
		expect(again).toThrow(ConflictError);
		try {
			again();
		} catch (e) {
			expect((e as ConflictError).code).toBe("already_clocked_in");
		}
	});

	it("clocking out without a session throws not_clocked_in", () => {
		expect(() => clockOut(db, {}, at("2026-10-15", "06:00"))).toThrow(
			/not_clocked_in/,
		);
	});

	it("clockOut caps a session at 240 minutes and flags auto_closed", () => {
		const s = clockIn(db, { source: "cli" }, at("2026-10-15", "05:30"));
		const out = clockOut(db, { notes: "long one" }, at("2026-10-15", "11:00"));
		expect(out.auto_closed).toBe(1);
		expect(out.ended_at).toBe(at("2026-10-15", "09:30").toISOString());
		expect(out.notes).toBe("long one");
		expect(getSession(db, s.id)?.ended_at).toBe(out.ended_at);
	});

	it("a stale open session is auto-closed before the next clock-in", () => {
		clockIn(db, { source: "cli" }, at("2026-10-14", "05:30"));
		const next = clockIn(
			db,
			{ source: "dashboard" },
			at("2026-10-15", "05:40"),
		);
		expect(next.source).toBe("dashboard");
		const sum = studySummary(db, at("2026-10-15", "05:50"));
		expect(sum.recent.find((r) => r.id !== next.id)?.auto_closed).toBe(1);
	});

	it("a 06:00 clock-in is on time with 30 min grace; 06:31 is late", () => {
		const s = clockIn(db, { source: "cli" }, at("2026-10-15", "06:00"));
		expect(s.block_id).not.toBeNull();
		const sum = studySummary(db, at("2026-10-15", "06:10"));
		expect(sum.blocks[0]).toMatchObject({
			on_time: true,
			state: "in_progress",
			clocked_in: true,
		});
		clockOut(db, {}, at("2026-10-15", "07:00"));

		clockIn(db, { source: "cli" }, at("2026-10-16", "06:31"));
		const late = studySummary(db, at("2026-10-16", "06:40"));
		expect(late.blocks[0]?.on_time).toBe(false);
	});

	it("a clock-in outside any block gets block_id null and counts for hours/streak only", () => {
		const s = clockIn(db, { source: "cli" }, at("2026-10-15", "20:00"));
		expect(s.block_id).toBeNull();
		clockOut(db, {}, at("2026-10-15", "21:30"));
		const sum = studySummary(db, at("2026-10-15", "22:00"));
		expect(sum.todayMinutes).toBe(90);
		expect(sum.week.minutes).toBe(90);
		expect(sum.streak).toBe(1);
		expect(sum.blocks[0]).toMatchObject({
			on_time: null,
			minutes: 0,
			state: "missed",
		});
	});
});

describe("blockStatusToday", () => {
	const day = "2026-10-15";
	const status = (now: Date, sessions: StudySession[]) =>
		blockStatusToday([BLOCK], sessions, now, IST, STUDY_DEFAULTS)[0];

	it("upcoming before the window", () => {
		expect(status(at(day, "05:00"), [])?.state).toBe("upcoming");
	});
	it("in_progress inside the window or while clocked in", () => {
		expect(status(at(day, "06:00"), [])?.state).toBe("in_progress");
		const open = session(at(day, "05:10"), null, BLOCK.id);
		expect(status(at(day, "05:20"), [open])).toMatchObject({
			state: "in_progress",
			clocked_in: true,
		});
	});
	it("done after the window with minutes; missed without", () => {
		const s = session(at(day, "05:45"), at(day, "07:45"), BLOCK.id);
		expect(status(at(day, "09:00"), [s])).toMatchObject({
			state: "done",
			minutes: 120,
			on_time: true,
		});
		expect(status(at(day, "09:00"), [])).toMatchObject({
			state: "missed",
			minutes: 0,
			on_time: null,
		});
	});
	it("skips blocks not scheduled today", () => {
		const weekdays = { ...BLOCK, days: "1,2,3,4,5" };
		// 2026-10-17 is a Saturday.
		expect(
			blockStatusToday(
				[weekdays],
				[],
				at("2026-10-17", "06:00"),
				IST,
				STUDY_DEFAULTS,
			),
		).toEqual([]);
	});
});

describe("streak", () => {
	const twoHours = (day: string) => session(at(day, "06:00"), at(day, "08:00"));

	it("counts consecutive qualifying days ending yesterday while today is short", () => {
		const s = [
			twoHours("2026-10-12"),
			twoHours("2026-10-13"),
			twoHours("2026-10-14"),
		];
		const short = session(at("2026-10-15", "06:00"), at("2026-10-15", "06:30"));
		expect(streak([...s, short], at("2026-10-15", "09:00"), IST, 60)).toBe(3);
		expect(streak(s, at("2026-10-15", "05:00"), IST, 60)).toBe(3);
	});
	it("includes today once the minimum is met", () => {
		const s = [twoHours("2026-10-14"), twoHours("2026-10-15")];
		expect(streak(s, at("2026-10-15", "09:00"), IST, 60)).toBe(2);
	});
	it("breaks on a missed day", () => {
		const s = [twoHours("2026-10-12"), twoHours("2026-10-14")];
		expect(streak(s, at("2026-10-15", "09:00"), IST, 60)).toBe(1);
	});
	it("an open session counts up to now", () => {
		const open = session(at("2026-10-15", "06:00"), null);
		expect(streak([open], at("2026-10-15", "07:00"), IST, 60)).toBe(1);
		expect(streak([open], at("2026-10-15", "06:30"), IST, 60)).toBe(0);
	});
});

describe("midnight crossing", () => {
	it("splits a session across local midnight", () => {
		const s = session(at("2026-10-14", "23:00"), at("2026-10-15", "01:30"));
		const m = minutesByDay([s], at("2026-10-15", "09:00"), IST);
		expect(m.get("2026-10-14")).toBe(60);
		expect(m.get("2026-10-15")).toBe(90);
		expect(streak([s], at("2026-10-15", "09:00"), IST, 60)).toBe(2);
	});
});

describe("weeklyMinutes (ISO week, local zone)", () => {
	it("uses the Kolkata Monday 00:00 boundary", () => {
		// Monday 2026-10-12 00:00 IST = Sunday 18:30Z.
		const before = session(
			at("2026-10-11", "23:00"),
			at("2026-10-12", "00:30"),
		);
		const inside = session(
			at("2026-10-13", "06:00"),
			at("2026-10-13", "07:00"),
		);
		expect(
			weeklyMinutes([before, inside], at("2026-10-15", "12:00"), IST),
		).toBe(90);
	});

	it("handles the New York DST change inside the week", () => {
		// ISO week Mon 2026-10-26 (EDT) .. Sun 2026-11-01 (EST from 02:00).
		const straddle = session(
			at("2026-10-25", "23:30", NY),
			at("2026-10-26", "00:30", NY),
		);
		const monday = session(
			at("2026-10-26", "06:00", NY),
			at("2026-10-26", "07:00", NY),
		);
		const sunday = session(
			at("2026-11-01", "08:00", NY),
			at("2026-11-01", "09:00", NY),
		);
		const now = at("2026-11-01", "12:00", NY);
		expect(weeklyMinutes([straddle, monday, sunday], now, NY)).toBe(150);
		// Next week starts Mon 2026-11-02 00:00 EST (05:00Z).
		const late = session(
			at("2026-11-01", "23:00", NY),
			at("2026-11-02", "01:00", NY),
		);
		expect(weeklyMinutes([late], at("2026-11-02", "02:00", NY), NY)).toBe(60);
	});

	it("ignores sessions from earlier weeks", () => {
		const old = session(at("2026-10-01", "06:00"), at("2026-10-01", "08:00"));
		expect(weeklyMinutes([old], at("2026-10-15", "12:00"), IST)).toBe(0);
	});
});

describe("study tasks", () => {
	it("adds tasks and completes them against the open session", () => {
		const t = addStudyTask(db, {
			title: "Graphs: Dijkstra",
			planned_for: "2026-10-15",
		});
		const s = clockIn(db, { source: "cli" }, at("2026-10-15", "06:00"));
		const done = finishStudyTask(db, t.id, at("2026-10-15", "06:30"));
		expect(done.session_id).toBe(s.id);
		expect(done.done_at).toBe(at("2026-10-15", "06:30").toISOString());
		const tasks = studySummary(db, at("2026-10-15", "07:00")).tasks;
		expect(tasks.map((x) => x.id)).toContain(t.id);
		// Completed yesterday -> hidden today.
		expect(studySummary(db, at("2026-10-16", "07:00")).tasks).toHaveLength(0);
	});

	it("finishing an unknown task is not found", () => {
		expect(() => finishStudyTask(db, 999)).toThrow(/not found/);
	});
});

describe("CLI: jh study", () => {
	let out: string[];

	beforeEach(() => {
		process.env.JOB_HUNTER_DB = join(home, "cli.db");
		process.exitCode = undefined;
		out = [];
		vi.spyOn(process.stdout, "write").mockImplementation(
			(chunk: string | Uint8Array) => {
				out.push(String(chunk));
				return true;
			},
		);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		process.exitCode = undefined;
		delete process.env.JOB_HUNTER_DB;
	});

	async function jh(...argv: string[]): Promise<unknown> {
		out = [];
		const program = new Command().exitOverride();
		register(program);
		await program.parseAsync(argv, { from: "user" });
		return JSON.parse(out.join("").trim().split("\n").at(-1) ?? "null");
	}

	it("clocks in and out; a second clock-in exits 2 with already_clocked_in", async () => {
		const s = await jh("study", "in", "--topic", "graphs", "--json");
		expect(s).toMatchObject({ topic: "graphs", source: "cli" });
		const again = (await jh("study", "in", "--json")) as { error: string };
		expect(again.error).toBe("already_clocked_in");
		expect(process.exitCode).toBe(2);
		process.exitCode = undefined;
		const o = (await jh("study", "out", "--notes", "done", "--json")) as {
			ended_at: string | null;
		};
		expect(o.ended_at).not.toBeNull();
		const st = (await jh("study", "status", "--json")) as {
			open: unknown;
			week: { goalMinutes: number };
		};
		expect(st.open).toBeNull();
		expect(st.week.goalMinutes).toBe(900);
	});

	it("edits blocks, sets settings and manages tasks", async () => {
		const blocks = (await jh("study", "blocks", "list", "--json")) as {
			id: number;
		}[];
		const id = String(blocks[0]?.id);
		const edited = await jh(
			"study",
			"blocks",
			"edit",
			id,
			"--start",
			"06:00",
			"--end",
			"08:00",
			"--json",
		);
		expect(edited).toMatchObject({ start_local: "06:00", end_local: "08:00" });
		const bad = (await jh(
			"study",
			"blocks",
			"edit",
			id,
			"--start",
			"09:00",
			"--json",
		)) as { error: string };
		expect(bad.error).toBe("validation");
		process.exitCode = undefined;

		expect(
			await jh("study", "set", "weekly_goal_hours", "12", "--json"),
		).toEqual({ key: "study.weekly_goal_hours", value: 12 });
		expect(
			await jh("study", "set", "timezone", "America/New_York", "--json"),
		).toEqual({ key: "timezone", value: "America/New_York" });
		const unknown = (await jh("study", "set", "nope", "1", "--json")) as {
			error: string;
		};
		expect(unknown.error).toBe("validation");

		const t = (await jh(
			"study",
			"task",
			"add",
			"Heaps",
			"--for",
			"2026-10-16",
			"--json",
		)) as { id: number };
		await jh("study", "task", "done", String(t.id), "--json");
		const all = (await jh("study", "task", "list", "--all", "--json")) as {
			id: number;
			done_at: string | null;
		}[];
		expect(all.find((x) => x.id === t.id)?.done_at).not.toBeNull();
	});
});
