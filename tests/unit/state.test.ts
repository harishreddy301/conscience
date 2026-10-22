import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IllegalTransitionError } from "../../src/core/errors.js";
import {
	APP_STATUSES,
	type AppSource,
	type AppStatus,
	canTransition,
	ghostSweep,
	isForward,
	TERMINAL,
	transition,
} from "../../src/core/state.js";
import { type Db, openDb } from "../../src/db/index.js";
import {
	createApplication,
	getApplication,
	insertJob,
	listEvents,
	upsertCompany,
} from "../../src/db/repo.js";

const LEGAL: readonly [AppStatus, AppStatus][] = [
	["discovered", "shortlisted"],
	["discovered", "dismissed"],
	["shortlisted", "tailored"],
	["shortlisted", "dismissed"],
	["applied", "assessment"],
	["applied", "interviewing"],
	["applied", "rejected"],
	["applied", "ghosted"],
	["assessment", "interviewing"],
	["assessment", "offer"],
	["assessment", "rejected"],
	["assessment", "ghosted"],
	["interviewing", "assessment"],
	["interviewing", "offer"],
	["interviewing", "rejected"],
	["interviewing", "ghosted"],
	["ghosted", "assessment"],
	["ghosted", "interviewing"],
	["ghosted", "rejected"],
	["offer", "accepted"],
	["offer", "declined"],
	// held (ADR-005)
	["discovered", "held"],
	["shortlisted", "held"],
	["tailored", "held"],
	["held", "shortlisted"],
	["held", "tailored"],
	["held", "dismissed"],
];

let home: string;
let savedHome: string | undefined;
let db: Db;
let seq = 0;

beforeEach(() => {
	savedHome = process.env.JOB_HUNTER_HOME;
	home = mkdtempSync(join(tmpdir(), "jh-state-"));
	process.env.JOB_HUNTER_HOME = home;
	db = openDb(":memory:");
});

afterEach(() => {
	db.close();
	if (savedHome === undefined) delete process.env.JOB_HUNTER_HOME;
	else process.env.JOB_HUNTER_HOME = savedHome;
	rmSync(home, { recursive: true, force: true });
});

function newApp(status: AppStatus, source: AppSource = "conscience"): number {
	const co = upsertCompany(db, { name: "Acme" });
	const job = insertJob(db, { company_id: co.id, title: `Role ${++seq}` });
	return createApplication(db, { job_id: job.id, status, source }).id;
}

describe("canTransition", () => {
	it.each(LEGAL)("%s -> %s is legal", (from, to) => {
		expect(canTransition(from, to)).toBe(true);
	});

	it("allows withdrawn from every non-terminal status only", () => {
		for (const s of APP_STATUSES) {
			if (s === "withdrawn") continue;
			expect(canTransition(s, "withdrawn")).toBe(!TERMINAL.has(s));
		}
	});

	it("rejects everything else", () => {
		const legal = new Set(LEGAL.map(([a, b]) => `${a}>${b}`));
		for (const from of APP_STATUSES) {
			for (const to of APP_STATUSES) {
				if (
					to === "withdrawn" ||
					to === "applied" ||
					legal.has(`${from}>${to}`)
				)
					continue;
				expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
			}
		}
	});

	it("gates tailored -> applied on factcheckPassed or external", () => {
		expect(canTransition("tailored", "applied")).toBe(false);
		expect(
			canTransition("tailored", "applied", { factcheckPassed: false }),
		).toBe(false);
		expect(
			canTransition("tailored", "applied", { factcheckPassed: true }),
		).toBe(true);
		expect(canTransition("tailored", "applied", { external: true })).toBe(true);
	});

	it("allows discovered/shortlisted -> applied only when external", () => {
		expect(canTransition("discovered", "applied")).toBe(false);
		expect(
			canTransition("shortlisted", "applied", { factcheckPassed: true }),
		).toBe(false);
		expect(canTransition("discovered", "applied", { external: true })).toBe(
			true,
		);
		expect(canTransition("shortlisted", "applied", { external: true })).toBe(
			true,
		);
		expect(canTransition("rejected", "applied", { external: true })).toBe(
			false,
		);
	});
});

describe("isForward", () => {
	it("ranks the pipeline", () => {
		expect(isForward("applied", "interviewing")).toBe(true);
		expect(isForward("interviewing", "applied")).toBe(false);
		expect(isForward("interviewing", "assessment")).toBe(true);
		expect(isForward("offer", "interviewing")).toBe(false);
		expect(isForward("applied", "applied")).toBe(false);
		expect(isForward("assessment", "ghosted")).toBe(true);
		expect(isForward("ghosted", "interviewing")).toBe(true);
	});
});

describe("transition", () => {
	it("moves, writes an event and an audit line", () => {
		const id = newApp("shortlisted");
		const r = transition(db, id, "tailored", {
			actor: "resume-writer",
			note: "draft ok",
		});
		expect(r).toEqual({ from: "shortlisted", to: "tailored", changed: true });
		expect(getApplication(db, id)?.status).toBe("tailored");
		const ev = listEvents(db, id).at(-1);
		expect(ev).toMatchObject({
			kind: "transition",
			from_status: "shortlisted",
			to_status: "tailored",
			actor: "resume-writer",
		});
		expect(JSON.parse(ev?.detail_json ?? "{}")).toEqual({ note: "draft ok" });
		const log = readFileSync(join(home, "logs", "audit.jsonl"), "utf8")
			.trim()
			.split("\n");
		expect(JSON.parse(log.at(-1) ?? "{}")).toMatchObject({
			actor: "resume-writer",
			action: "app.transition",
		});
	});

	it("throws IllegalTransitionError (exit 3) for illegal edges", () => {
		const id = newApp("shortlisted");
		let err: unknown;
		try {
			transition(db, id, "offer", { actor: "t" });
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(IllegalTransitionError);
		expect((err as IllegalTransitionError).exitCode).toBe(3);
		expect((err as IllegalTransitionError).code).toBe("illegal_transition");
		expect(getApplication(db, id)?.status).toBe("shortlisted");
	});

	it("needs factcheckPassed for tailored -> applied on conscience apps", () => {
		const id = newApp("tailored");
		expect(() => transition(db, id, "applied", { actor: "t" })).toThrow(
			IllegalTransitionError,
		);
		const r = transition(db, id, "applied", {
			actor: "t",
			factcheckPassed: true,
		});
		expect(r.changed).toBe(true);
		expect(getApplication(db, id)?.applied_at).not.toBeNull();
	});

	it("skips the factcheck gate for external/email sources and the external flag", () => {
		const ext = newApp("tailored", "external");
		expect(transition(db, ext, "applied", { actor: "t" }).changed).toBe(true);
		const mail = newApp("shortlisted", "email");
		expect(transition(db, mail, "applied", { actor: "t" }).changed).toBe(true);
		const flagged = newApp("tailored");
		expect(
			transition(db, flagged, "applied", {
				actor: "email",
				external: true,
				soft: true,
			}).changed,
		).toBe(true);
	});

	it("soft mode never throws on illegal or backward moves", () => {
		const id = newApp("interviewing", "external");
		expect(
			transition(db, id, "applied", { actor: "email", soft: true }),
		).toEqual({
			from: "interviewing",
			to: "applied",
			changed: false,
		});
		expect(
			transition(db, id, "discovered", { actor: "email", soft: true }).changed,
		).toBe(false);
		expect(
			transition(db, id, "assessment", { actor: "email", soft: true }).changed,
		).toBe(true);
		expect(
			transition(db, id, "offer", { actor: "email", soft: true }).changed,
		).toBe(true);
		expect(
			transition(db, id, "rejected", { actor: "email", soft: true }).changed,
		).toBe(false);
	});

	it("treats a same-status move as a no-op", () => {
		const id = newApp("applied", "external");
		const before = listEvents(db, id).length;
		expect(transition(db, id, "applied", { actor: "t" }).changed).toBe(false);
		expect(listEvents(db, id)).toHaveLength(before);
	});

	it("throws not_found for a missing application", () => {
		expect(() =>
			transition(db, 999, "tailored", { actor: "t", soft: true }),
		).toThrow(/not found/);
	});
});

describe("ghostSweep", () => {
	it("ghosts applied/assessment apps silent for 21 days", () => {
		const now = new Date("2030-02-01T00:00:00.000Z");
		const day = 86_400_000;
		const at = (d: number) => new Date(now.getTime() - d * day).toISOString();
		const old = newApp("applied", "external");
		const exactly = newApp("assessment", "external");
		const fresh = newApp("applied", "external");
		const interviewing = newApp("interviewing", "external");
		const pairs: [number, number][] = [
			[old, 30],
			[exactly, 21],
			[fresh, 20],
			[interviewing, 60],
		];
		for (const [id, d] of pairs) {
			db.prepare("UPDATE applications SET last_event_at = ? WHERE id = ?").run(
				at(d),
				id,
			);
		}
		const moved = ghostSweep(db, { now });
		expect(moved.sort()).toEqual([old, exactly].sort());
		expect(getApplication(db, old)?.status).toBe("ghosted");
		expect(getApplication(db, fresh)?.status).toBe("applied");
		expect(getApplication(db, interviewing)?.status).toBe("interviewing");
		expect(ghostSweep(db, { now })).toEqual([]);
		expect(ghostSweep(db, { now, days: 10 })).toEqual([fresh]);
	});
});
