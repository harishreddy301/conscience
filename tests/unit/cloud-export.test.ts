import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	exportPacket,
	isExportable,
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
const ME_FIXTURE = join(HERE, "..", "fixtures", "cloud", "me.fixture");
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
	writeFileSync(join(me, "tk.sh"), "echo fictional\n");
	writeFileSync(join(me, ".env"), "FAKE=not-a-secret\n");
	mkdirSync(join(me, "sub"), { recursive: true });
	writeFileSync(join(me, "sub", ".env.local"), "FAKE=not-a-secret\n");
	return me;
}

function fakeRun(visibility: string): {
	run: Run;
	calls: { cmd: string; args: string[] }[];
} {
	const calls: { cmd: string; args: string[] }[] = [];
	const run: Run = async (cmd, args) => {
		calls.push({ cmd, args });
		if (cmd === "gh") return `${visibility}\n`;
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
