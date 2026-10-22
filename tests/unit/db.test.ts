import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type Db,
	migrate,
	nowIso,
	openDb,
	tx,
	userVersion,
} from "../../src/db/index.js";
import { MIGRATIONS, TABLES } from "../../src/db/migrations.js";
import {
	countByStatus,
	createApplication,
	findCompanyByDomain,
	findCompanyByName,
	getApplication,
	getSetting,
	insertEvent,
	insertJob,
	listApplications,
	listEvents,
	normName,
	normTitle,
	setArtifactsDir,
	setJobJd,
	setSetting,
	timezone,
	upsertCompany,
} from "../../src/db/repo.js";

let db: Db;

beforeEach(() => {
	db = openDb(":memory:");
});

afterEach(() => {
	db.close();
});

function tableNames(d: Db): string[] {
	return (
		d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
			name: string;
		}[]
	).map((r) => r.name);
}

describe("openDb / migrate", () => {
	it("sets user_version to the migration count (4)", () => {
		expect(MIGRATIONS.length).toBe(4);
		expect(userVersion(db)).toBe(4);
	});

	it("creates the 13 core tables plus study_tasks, resume_variants and jd_snapshots", () => {
		const names = tableNames(db);
		for (const t of TABLES) expect(names).toContain(t);
		const core = TABLES.filter(
			(t) =>
				t !== "study_tasks" &&
				t !== "resume_variants" &&
				t !== "jd_snapshots" &&
				t !== "escalations",
		);
		expect(core).toHaveLength(13);
	});

	it("turns foreign keys on", () => {
		expect(
			(db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number })
				.foreign_keys,
		).toBe(1);
		expect(() =>
			db
				.prepare(
					"INSERT INTO jobs(company_id,title,title_norm,discovered_at) VALUES(999,'x','x',?)",
				)
				.run(nowIso()),
		).toThrow(/FOREIGN KEY/);
	});

	it("seeds the 05:30-08:00 Morning study block and settings", () => {
		const blocks = db.prepare("SELECT * FROM study_blocks").all() as Record<
			string,
			unknown
		>[];
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			label: "Morning study",
			days: "1,2,3,4,5,6,7",
			start_local: "05:30",
			end_local: "08:00",
			active: 1,
		});
		expect(getSetting(db, "study.weekly_goal_hours", 0)).toBe(15);
		expect(getSetting(db, "study.grace_minutes", 0)).toBe(30);
		expect(getSetting(db, "dashboard.port", 0)).toBe(4777);
	});

	it("allows only one open study session (study_one_open)", () => {
		const ins = db.prepare(
			"INSERT INTO study_sessions(started_at, source) VALUES(?, 'cli')",
		);
		ins.run(nowIso());
		expect(() => ins.run(nowIso())).toThrow(/UNIQUE/);
		db.prepare("UPDATE study_sessions SET ended_at = ?").run(nowIso());
		expect(() => ins.run(nowIso())).not.toThrow();
	});

	it("is idempotent and reopens a file db at the same version", () => {
		expect(migrate(db)).toBe(MIGRATIONS.length);
		const dir = mkdtempSync(join(tmpdir(), "jh-db-"));
		try {
			const file = join(dir, "nested", "jh.db");
			const a = openDb(file);
			a.close();
			expect(existsSync(file)).toBe(true);
			const b = openDb(file);
			expect(userVersion(b)).toBe(MIGRATIONS.length);
			expect(
				(
					b.prepare("SELECT COUNT(*) AS n FROM study_blocks").get() as {
						n: number;
					}
				).n,
			).toBe(1);
			b.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("refuses a database newer than this build", () => {
		db.exec("PRAGMA user_version=99");
		expect(() => migrate(db)).toThrow(/newer/);
	});
});

describe("tx", () => {
	it("rolls back on error", () => {
		expect(() =>
			tx(db, () => {
				setSetting(db, "k", 1);
				throw new Error("boom");
			}),
		).toThrow("boom");
		expect(getSetting(db, "k", null)).toBeNull();
	});

	it("nests with savepoints", () => {
		tx(db, () => {
			setSetting(db, "outer", 1);
			expect(() =>
				tx(db, () => {
					setSetting(db, "inner", 2);
					throw new Error("inner");
				}),
			).toThrow();
		});
		expect(getSetting(db, "outer", null)).toBe(1);
		expect(getSetting(db, "inner", null)).toBeNull();
	});

	it("nests without DatabaseSync#isTransaction (Node 22.13-22.15)", () => {
		// Simulate the older runtime: the property is absent there.
		const old = new Proxy(db, {
			get(t, p) {
				if (p === "isTransaction") return undefined;
				const v = Reflect.get(t, p, t);
				return typeof v === "function" ? v.bind(t) : v;
			},
		});
		tx(old, () => {
			setSetting(old, "a", 1);
			tx(old, () => tx(old, () => setSetting(old, "b", 2)));
		});
		expect(getSetting(db, "a", null)).toBe(1);
		expect(getSetting(db, "b", null)).toBe(2);
		// The depth counter is reset, so a fresh top-level tx still works.
		tx(db, () => setSetting(db, "c", 3));
		expect(getSetting(db, "c", null)).toBe(3);
	});

	it("keeps the original error when the savepoint is already gone", () => {
		expect(() =>
			tx(db, () =>
				tx(db, () => {
					db.exec("ROLLBACK");
					throw new Error("root cause");
				}),
			),
		).toThrow("root cause");
		tx(db, () => setSetting(db, "after", 1));
		expect(getSetting(db, "after", null)).toBe(1);
	});
});

describe("getSetting with a schema", () => {
	it("falls back when the stored value has the wrong shape", () => {
		setSetting(db, "dashboard.port", "garbage");
		const portSchema = {
			safeParse: (v: unknown) =>
				typeof v === "number"
					? ({ success: true, data: v } as const)
					: ({ success: false } as const),
		};
		expect(getSetting(db, "dashboard.port", 4777, portSchema)).toBe(4777);
		setSetting(db, "dashboard.port", 5000);
		expect(getSetting(db, "dashboard.port", 4777, portSchema)).toBe(5000);
	});
});

describe("migrate under concurrency", () => {
	it("a second opener after another process migrated does not re-run migrations", () => {
		const dir = mkdtempSync(join(tmpdir(), "jh-mig-"));
		const path = join(dir, "jh.db");
		const a = openDb(path);
		const b = openDb(path);
		expect(userVersion(b)).toBe(MIGRATIONS.length);
		// Simulate a stale read: migrate() re-checks user_version under the lock.
		expect(migrate(b)).toBe(MIGRATIONS.length);
		a.close();
		b.close();
		rmSync(dir, { recursive: true, force: true });
	});
});

describe("normalization", () => {
	it("normName strips punctuation and legal suffixes", () => {
		expect(normName("Acme, Inc.")).toBe("acme");
		expect(normName("  Foo   Bar LLC ")).toBe("foo bar");
		expect(normName("Société Générale S.A.")).toBe("societe generale s a");
		expect(normName("Co")).toBe("co");
		expect(normName("AT&T Corp")).toBe("at and t");
	});

	it("normTitle expands abbreviations", () => {
		expect(normTitle("Sr. Data Engineer (Remote)")).toBe(
			"senior data engineer remote",
		);
	});
});

describe("companies and jobs", () => {
	it("upsertCompany dedupes by name_norm and fills a null domain", () => {
		const a = upsertCompany(db, { name: "Acme Inc" });
		expect(a.domain).toBeNull();
		const b = upsertCompany(db, {
			name: "ACME",
			domain: "https://www.Acme.com/careers",
		});
		expect(b.id).toBe(a.id);
		expect(b.domain).toBe("acme.com");
		const c = upsertCompany(db, { name: "acme", domain: "other.com" });
		expect(c.domain).toBe("acme.com");
		expect(findCompanyByDomain(db, "acme.com")?.id).toBe(a.id);
		expect(findCompanyByName(db, "Acme, LLC")?.id).toBe(a.id);
	});

	it("insertJob dedupes on source_key and fingerprint", () => {
		const co = upsertCompany(db, { name: "Acme" });
		const j1 = insertJob(db, {
			company_id: co.id,
			title: "Data Engineer",
			location: "Austin, TX",
			source_key: "gh:1",
		});
		const sameKey = insertJob(db, {
			company_id: co.id,
			title: "Other",
			source_key: "gh:1",
		});
		expect(sameKey.id).toBe(j1.id);
		const sameFp = insertJob(db, {
			company_id: co.id,
			title: "data engineer",
			location: "Austin",
			url: "https://x/1",
			source_key: "lever:9",
		});
		expect(sameFp.id).toBe(j1.id);
		expect(sameFp.url).toBe("https://x/1");
		const other = insertJob(db, {
			company_id: co.id,
			title: "Data Engineer",
			location: "Denver, CO",
		});
		expect(other.id).not.toBe(j1.id);
		setJobJd(db, other.id, "JD text");
		expect(
			insertJob(db, {
				company_id: co.id,
				title: "Data Engineer",
				location: "Denver",
			}).jd_text,
		).toBe("JD text");
	});
});

describe("applications and events", () => {
	function seedApp(status?: Parameters<typeof createApplication>[1]["status"]) {
		const co = upsertCompany(db, { name: "Acme", domain: "acme.com" });
		const job = insertJob(db, {
			company_id: co.id,
			title: "DE",
			url: "https://acme.com/j/1",
		});
		return createApplication(db, { job_id: job.id, status });
	}

	it("createApplication defaults and returns existing for a job", () => {
		const a = seedApp();
		expect(a.status).toBe("shortlisted");
		expect(a.source).toBe("conscience");
		expect(a.applied_at).toBeNull();
		const again = createApplication(db, {
			job_id: a.job_id,
			status: "applied",
		});
		expect(again.id).toBe(a.id);
		expect(again.status).toBe("shortlisted");
	});

	it("sets applied_at for submitted statuses", () => {
		const a = seedApp("applied");
		expect(a.applied_at).not.toBeNull();
	});

	it("getApplication returns the joined view", () => {
		const a = seedApp();
		const v = getApplication(db, a.id);
		expect(v).toMatchObject({
			company: "Acme",
			company_domain: "acme.com",
			title: "DE",
			url: "https://acme.com/j/1",
		});
		setArtifactsDir(db, a.id, "/tmp/x");
		expect(getApplication(db, a.id)?.artifacts_dir).toBe("/tmp/x");
	});

	it("insertEvent bumps last_event_at forward only", () => {
		const a = seedApp();
		insertEvent(db, {
			application_id: a.id,
			kind: "note",
			actor: "t",
			detail: { n: 1 },
			at: "2999-01-01T00:00:00.000Z",
		});
		insertEvent(db, {
			application_id: a.id,
			kind: "note",
			actor: "t",
			at: "2000-01-01T00:00:00.000Z",
		});
		expect(getApplication(db, a.id)?.last_event_at).toBe(
			"2999-01-01T00:00:00.000Z",
		);
		const ev = listEvents(db, a.id);
		expect(ev).toHaveLength(2);
		expect(ev[0]?.at).toBe("2000-01-01T00:00:00.000Z");
		expect(JSON.parse(ev[1]?.detail_json ?? "null")).toEqual({ n: 1 });
	});

	it("listApplications filters and orders", () => {
		const co = upsertCompany(db, { name: "Beta" });
		const ids: number[] = [];
		for (const [i, status] of (
			["shortlisted", "applied", "rejected"] as const
		).entries()) {
			const job = insertJob(db, { company_id: co.id, title: `Role ${i}` });
			const app = createApplication(db, { job_id: job.id, status });
			insertEvent(db, {
				application_id: app.id,
				kind: "note",
				actor: "t",
				at: `2030-01-0${i + 1}T00:00:00.000Z`,
			});
			ids.push(app.id);
		}
		expect(listApplications(db).map((a) => a.id)).toEqual([...ids].reverse());
		expect(
			listApplications(db, { status: ["applied"] }).map((a) => a.id),
		).toEqual([ids[1]]);
		expect(listApplications(db, { active: true })).toHaveLength(2);
		expect(
			listApplications(db, { sinceIso: "2030-01-02T00:00:00.000Z" }),
		).toHaveLength(2);
		expect(listApplications(db, { companyId: co.id, limit: 1 })).toHaveLength(
			1,
		);
		const counts = countByStatus(db);
		expect(counts).toMatchObject({
			shortlisted: 1,
			applied: 1,
			rejected: 1,
			offer: 0,
		});
	});
});

describe("settings", () => {
	it("round-trips JSON values and tolerates raw strings", () => {
		setSetting(db, "a", { x: [1, 2] });
		expect(getSetting(db, "a", null)).toEqual({ x: [1, 2] });
		expect(getSetting(db, "missing", "fb")).toBe("fb");
		db.prepare(
			"INSERT INTO settings(key,value) VALUES('raw','Europe/Berlin')",
		).run();
		expect(getSetting(db, "raw", "")).toBe("Europe/Berlin");
	});

	it("timezone uses the setting, else the system zone", () => {
		expect(timezone(db)).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
		setSetting(db, "timezone", "Asia/Kolkata");
		expect(timezone(db)).toBe("Asia/Kolkata");
	});
});
