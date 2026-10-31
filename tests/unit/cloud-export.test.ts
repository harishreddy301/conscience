import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	exportPacket,
	isExportable,
	mirrorMe,
	selectApps,
} from "../../src/cloud/export.js";
import type { Run } from "../../src/cloud/git.js";
import { ValidationError } from "../../src/core/errors.js";
import { type Db, openDb, userVersion } from "../../src/db/index.js";
import {
	createApplication,
	insertJob,
	upsertCompany,
} from "../../src/db/repo.js";
import { createRun, finalizeRun } from "../../src/db/resume.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLOUD_FIXTURES = join(HERE, "..", "fixtures", "cloud");
const ME_FIXTURE = join(CLOUD_FIXTURES, "me.fixture");
const JD = "Fictional posting: build data pipelines in Python and SQL. ".repeat(
	3,
);

let tmp: string;
let db: Db;
let savedHome: string | undefined;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "jh-cloud-export-"));
	savedHome = process.env.JOB_HUNTER_HOME;
	// audit() writes under JOB_HUNTER_HOME; keep it in the temp dir.
	process.env.JOB_HUNTER_HOME = join(tmp, "home");
	db = openDb(join(tmp, "local.db"));
	pulledBeforePacket = [];
});

afterEach(() => {
	db.close();
	if (savedHome === undefined) delete process.env.JOB_HUNTER_HOME;
	else process.env.JOB_HUNTER_HOME = savedHome;
	rmSync(tmp, { recursive: true, force: true });
});

function addApp(company: string, title: string, jd?: string): number {
	const c = upsertCompany(db, { name: company });
	const j = insertJob(db, {
		company_id: c.id,
		title,
		url: `https://jobs.example.com/${company.toLowerCase()}`,
		jd_text: jd,
	});
	return createApplication(db, { job_id: j.id, status: "shortlisted" }).id;
}

/** A me/ copy with secret-like files the allowlist must skip. */
function meWithSecrets(): string {
	const me = join(tmp, "me");
	cpSync(ME_FIXTURE, me, { recursive: true });
	// Stored under *.fixture.yaml names so the CI privacy check allows them;
	// copied in under the real me/ names the export expects.
	cpSync(
		join(CLOUD_FIXTURES, "profile.fixture.yaml"),
		join(me, "profile.yaml"),
	);
	cpSync(
		join(CLOUD_FIXTURES, "master-resume.fixture.yaml"),
		join(me, "master-resume.yaml"),
	);
	writeFileSync(join(me, "tk.sh"), "echo fictional\n");
	writeFileSync(join(me, ".env"), "FAKE=not-a-secret\n");
	mkdirSync(join(me, "sub"), { recursive: true });
	writeFileSync(join(me, "sub", ".env.local"), "FAKE=not-a-secret\n");
	return me;
}

/** For each pull: true when no packets/ dir existed yet at that moment. */
let pulledBeforePacket: boolean[] = [];

function fakeRun(visibility: string): {
	run: Run;
	calls: { cmd: string; args: string[] }[];
} {
	const calls: { cmd: string; args: string[] }[] = [];
	const run: Run = async (cmd, args, cwd) => {
		calls.push({ cmd, args });
		if (cmd === "gh") return `${visibility}\n`;
		if (args[0] === "remote")
			return "https://github.com/acme/conscience-data.git\n";
		if (args[0] === "rev-parse") return "main\n";
		if (args[0] === "diff") return "me/profile.yaml\n";
		if (args[0] === "pull")
			pulledBeforePacket.push(!existsSync(join(cwd, "packets")));
		return "";
	};
	return { run, calls };
}

describe("isExportable", () => {
	it("keeps ordinary me/ files", () => {
		expect(isExportable("profile.yaml", 100)).toBe(true);
		expect(isExportable("experience/a.md", 100)).toBe(true);
	});

	it("skips secrets, backups and large files", () => {
		expect(isExportable("tk.sh", 10)).toBe(false);
		expect(isExportable(".env", 10)).toBe(false);
		expect(isExportable("sub/.env.local", 10)).toBe(false);
		expect(isExportable("sub\\.env.local", 10)).toBe(false);
		expect(isExportable("master-resume.backup-1.yaml", 10)).toBe(false);
		expect(isExportable("sample-resume/big.pdf", 6_000_000)).toBe(false);
	});

	it("allows only known document extensions, case-insensitively", () => {
		for (const ok of [
			"a.md",
			"b.YAML",
			"c.yml",
			"d.json",
			"e.txt",
			"sample-resume/r.PDF",
			"sample-resume/r.docx",
		])
			expect(isExportable(ok, 10), ok).toBe(true);
		for (const bad of [
			"TK.SH",
			".ENV",
			"sub/.Env.Local",
			"sub\\.env.json",
			"x.BACKUP.yaml",
			"master-resume.bak.yaml",
			"profile.yaml~",
			"id_rsa",
			"a.pem",
			"notes",
			"run.sh",
			"key.p12",
		])
			expect(isExportable(bad, 10), bad).toBe(false);
	});
});

describe("exportPacket guards", () => {
	it("refuses a public data repo before writing anything", async () => {
		addApp("Acme", "Data Engineer", JD);
		const dataDir = join(tmp, "data");
		mkdirSync(dataDir);
		const { run } = fakeRun("PUBLIC");
		await expect(
			exportPacket({
				db,
				meDir: meWithSecrets(),
				dataDir,
				codeRepoRoot: join(tmp, "code"),
				queue: 10,
				run,
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(existsSync(join(dataDir, "packets"))).toBe(false);
		expect(existsSync(join(dataDir, "me"))).toBe(false);
	});

	it("refuses a data repo cloned inside the code repo", async () => {
		addApp("Acme", "Data Engineer", JD);
		const code = join(tmp, "code");
		const dataDir = join(code, "conscience-data");
		mkdirSync(dataDir, { recursive: true });
		const { run, calls } = fakeRun("PRIVATE");
		await expect(
			exportPacket({
				db,
				meDir: meWithSecrets(),
				dataDir,
				codeRepoRoot: code,
				queue: 10,
				run,
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(existsSync(join(dataDir, "packets"))).toBe(false);
		expect(calls.some((c) => c.args.includes("push"))).toBe(false);
	});
});

describe("exportPacket", () => {
	it("writes the packet, the DB snapshot and the allowlisted me/", async () => {
		const a = addApp("Acme", "Data Engineer", JD);
		const b = addApp("Globex", "Analytics Engineer", `${JD} Globex.`);
		addApp("Initech", "No JD Engineer"); // no jd_text: never selected
		const dataDir = join(tmp, "data");
		mkdirSync(join(dataDir, "me"), { recursive: true });
		writeFileSync(join(dataDir, "me", "stale.md"), "removed from me/\n");
		const { run, calls } = fakeRun("PRIVATE");

		const m = await exportPacket({
			db,
			meDir: meWithSecrets(),
			dataDir,
			codeRepoRoot: join(tmp, "code"),
			queue: 10,
			run,
			now: new Date(2026, 9, 22, 9, 5),
		});

		expect(m.id).toBe("p-20261022-0905");
		expect(m.schema_version).toBe(userVersion(db));
		expect(m.apps.map((x) => x.app_id).sort()).toEqual([a, b].sort());
		const pkt = join(dataDir, "packets", m.id);
		const onDisk = JSON.parse(readFileSync(join(pkt, "packet.json"), "utf8"));
		expect(onDisk.id).toBe(m.id);
		for (const app of m.apps) {
			expect(app.jd_path).toBe(`jd/${app.app_id}.txt`);
			const stored = db
				.prepare(
					"SELECT j.jd_text FROM applications a JOIN jobs j ON j.id = a.job_id WHERE a.id = ?",
				)
				.get(app.app_id) as { jd_text: string };
			expect(readFileSync(join(pkt, app.jd_path), "utf8")).toBe(stored.jd_text);
		}

		const snap = openDb(join(pkt, "jh.db"));
		try {
			expect(userVersion(snap)).toBe(userVersion(db));
		} finally {
			snap.close();
		}

		expect(existsSync(join(dataDir, "me", "profile.yaml"))).toBe(true);
		expect(
			existsSync(join(dataDir, "me", "experience", "acme-analytics.md")),
		).toBe(true);
		expect(existsSync(join(dataDir, "me", "tk.sh"))).toBe(false);
		expect(existsSync(join(dataDir, "me", ".env"))).toBe(false);
		expect(existsSync(join(dataDir, "me", "sub", ".env.local"))).toBe(false);
		expect(existsSync(join(dataDir, "me", "master-resume.backup-1.yaml"))).toBe(
			false,
		);
		expect(existsSync(join(dataDir, "me", "stale.md"))).toBe(false);

		expect(calls.some((c) => c.cmd === "git" && c.args[0] === "push")).toBe(
			true,
		);
		// The clone is rebased onto origin before the packet is written.
		expect(pulledBeforePacket).toEqual([true]);
	});

	it("refuses when no app qualifies, before writing anything", async () => {
		const dataDir = join(tmp, "data");
		mkdirSync(dataDir);
		const { run } = fakeRun("PRIVATE");
		await expect(
			exportPacket({
				db,
				meDir: meWithSecrets(),
				dataDir,
				codeRepoRoot: join(tmp, "code"),
				queue: 10,
				run,
			}),
		).rejects.toBeInstanceOf(ValidationError);
		expect(existsSync(join(dataDir, "packets"))).toBe(false);
	});
});

describe("selectApps", () => {
	it("skips apps that already have a finalized run", () => {
		const done = addApp("Acme", "Data Engineer", JD);
		const open = addApp("Globex", "Analytics Engineer", JD);
		createRun(db, {
			id: `${done}-run`,
			application_id: done,
			workdir: join(tmp, "w"),
			jd_path: join(tmp, "w", "jd.txt"),
		});
		finalizeRun(db, `${done}-run`, {
			final_draft_id: "d1-impact",
			ats_score: 85,
			hm_verdict: "interview",
			quality: "ok",
			iterations: 1,
		});
		expect(selectApps(db, { queue: 10 }).map((a) => a.app_id)).toEqual([open]);
	});

	it("honours explicit ids and the queue size", () => {
		const a = addApp("Acme", "Data Engineer", JD);
		addApp("Globex", "Analytics Engineer", JD);
		addApp("Initech", "Platform Engineer", JD);
		expect(selectApps(db, { appIds: [a] }).map((x) => x.app_id)).toEqual([a]);
		expect(selectApps(db, { queue: 2 })).toHaveLength(2);
	});
});

/** A directory link (a junction on Windows needs no privilege); false if unsupported. */
function tryDirLink(target: string, path: string): boolean {
	try {
		symlinkSync(target, path, "junction");
		return true;
	} catch {
		return false;
	}
}

describe("mirrorMe symlink safety", () => {
	it("refuses a symlinked subdir in the destination and leaves its target alone", (ctx) => {
		const me = meWithSecrets();
		const outside = join(tmp, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "acme-analytics.md"), "outside\n");
		writeFileSync(join(outside, "precious.txt"), "keep\n");
		const dest = join(tmp, "data", "me");
		mkdirSync(dest, { recursive: true });
		if (!tryDirLink(outside, join(dest, "experience"))) ctx.skip();
		expect(() => mirrorMe(me, dest)).toThrow(ValidationError);
		expect(readFileSync(join(outside, "acme-analytics.md"), "utf8")).toBe(
			"outside\n",
		);
		expect(existsSync(join(outside, "precious.txt"))).toBe(true);
	});

	it("refuses a symlinked destination", (ctx) => {
		const me = meWithSecrets();
		const outside = join(tmp, "outside");
		mkdirSync(outside);
		writeFileSync(join(outside, "precious.txt"), "keep\n");
		mkdirSync(join(tmp, "data"));
		const dest = join(tmp, "data", "me");
		if (!tryDirLink(outside, dest)) ctx.skip();
		expect(() => mirrorMe(me, dest)).toThrow(ValidationError);
		expect(existsSync(join(outside, "precious.txt"))).toBe(true);
		expect(existsSync(join(outside, "profile.yaml"))).toBe(false);
	});
});

describe("exportPacket DB snapshot", () => {
	function addPersonalRows(appId: number): void {
		const now = new Date().toISOString();
		db.prepare(
			`INSERT INTO emails(gmail_message_id, thread_id, received_at, from_addr, from_domain, subject, kind, confidence, application_id, ingested_at)
			 VALUES('m1', 't1', ?, 'recruiter@example.com', 'example.com', 'Fictional subject', 'recruiter', 0.9, ?, ?)`,
		).run(now, appId, now);
		db.prepare(
			`INSERT INTO interviews(application_id, company_name, source, updated_at) VALUES(?, 'Initech', 'manual', ?)`,
		).run(appId, now);
		db.prepare(
			`INSERT INTO study_blocks(label, days, start_local, end_local, created_at) VALUES('x', 'mon', '09:00', '10:00', ?)`,
		).run(now);
		db.prepare(
			`INSERT INTO sync_runs(kind, started_at, actor) VALUES('gmail', ?, 'jh')`,
		).run(now);
	}

	it("keeps only the packet's apps and drops personal tracking tables", async () => {
		const a = addApp("Acme", "Data Engineer", JD);
		const other = addApp("Initech", "Platform Engineer", JD);
		addPersonalRows(other);
		const dataDir = join(tmp, "data");
		mkdirSync(dataDir);
		const { run, calls } = fakeRun("PRIVATE");
		const m = await exportPacket({
			db,
			meDir: meWithSecrets(),
			dataDir,
			codeRepoRoot: join(tmp, "code"),
			appIds: [a],
			run,
			now: new Date(2026, 9, 22, 9, 5),
		});
		// No -wal/-shm leftovers get committed next to the snapshot.
		expect(readdirSync(join(dataDir, "packets", m.id)).sort()).toEqual([
			"jd",
			"jh.db",
			"packet.json",
		]);
		const snap = openDb(join(dataDir, "packets", m.id, "jh.db"));
		const n = (sql: string) => (snap.prepare(sql).get() as { n: number }).n;
		try {
			expect(
				snap
					.prepare("SELECT id FROM applications")
					.all()
					.map((r) => r.id),
			).toEqual([a]);
			expect(n("SELECT count(*) AS n FROM jobs")).toBe(1);
			expect(
				snap
					.prepare("SELECT name FROM companies")
					.all()
					.map((r) => r.name),
			).toEqual(["Acme"]);
			for (const t of [
				"emails",
				"interviews",
				"study_blocks",
				"study_sessions",
				"study_tasks",
				"sync_runs",
			])
				expect(n(`SELECT count(*) AS n FROM ${t}`), t).toBe(0);
			expect(
				n(
					`SELECT count(*) AS n FROM application_events WHERE application_id <> ${a}`,
				),
			).toBe(0);
		} finally {
			snap.close();
		}
		// The local DB is untouched.
		expect(
			(db.prepare("SELECT count(*) AS n FROM emails").get() as { n: number }).n,
		).toBe(1);
		// Only the packet paths are committed.
		const commit = calls.find((c) => c.args[0] === "commit");
		expect(commit?.args.slice(-3)).toEqual(["--", "me", `packets/${m.id}`]);
	});

	it("refuses a snapshot over the size cap and leaves no packet behind", async () => {
		addApp("Acme", "Data Engineer", JD);
		const dataDir = join(tmp, "data");
		mkdirSync(dataDir);
		const { run, calls } = fakeRun("PRIVATE");
		await expect(
			exportPacket({
				db,
				meDir: meWithSecrets(),
				dataDir,
				codeRepoRoot: join(tmp, "code"),
				queue: 10,
				run,
				maxSnapshotBytes: 1024,
				now: new Date(2026, 9, 22, 9, 5),
			}),
		).rejects.toMatchObject({ code: "snapshot_too_large" });
		expect(existsSync(join(dataDir, "packets", "p-20261022-0905"))).toBe(false);
		expect(calls.some((c) => c.args[0] === "push")).toBe(false);
	});
});
