import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { exportPacket } from "../cloud/export.js";
import { type ImportReport, importResults } from "../cloud/import.js";
import { CloudSummary, PacketManifest } from "../cloud/schema.js";
import { JhError, ValidationError } from "../core/errors.js";
import { action, emit } from "../core/output.js";
import { artifactsDir, meDir, repoRoot } from "../core/paths.js";
import { type Db, openDb } from "../db/index.js";
import { loadMe } from "../resume/gate.js";
import { validateDraftFile } from "./resume.js";

interface JsonOpt {
	json?: boolean;
}

/** The local clone of the private data repo (ADR 006). */
export function dataRepoDir(): string {
	const dir = process.env.JOB_HUNTER_DATA_REPO;
	if (!dir)
		throw new JhError(
			"set JOB_HUNTER_DATA_REPO (see ADR 006)",
			1,
			"data_repo_unset",
		);
	return resolve(dir);
}

/**
 * The code repo root for the "data repo inside the code repo" guard. Fails
 * closed: without a located code repo the guard cannot run, so export refuses.
 */
export function codeRepoRootOrFail(root: string | null): string {
	if (!root)
		throw new JhError(
			"could not locate the conscience code repo (.claude-plugin/plugin.json), so the data-repo location cannot be checked",
			1,
			"code_repo_unknown",
		);
	return root;
}

function withDb<T>(fn: (db: Db) => T): T {
	const db = openDb();
	try {
		return fn(db);
	} finally {
		db.close();
	}
}

function parseIds(csv: string): number[] {
	const ids = csv
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
		.map(Number);
	if (!ids.length || ids.some((n) => !Number.isInteger(n) || n <= 0))
		throw new ValidationError("--apps must be comma-separated application ids");
	return ids;
}

function parseQueue(v: string | undefined): number | undefined {
	if (v === undefined) return undefined;
	const n = Number(v);
	if (!Number.isInteger(n) || n <= 0)
		throw new ValidationError("--queue must be a positive integer");
	return n;
}

async function runExport(o: JsonOpt & { apps?: string; queue?: string }) {
	const dataDir = dataRepoDir();
	const db = openDb();
	try {
		const m = await exportPacket({
			db,
			meDir: meDir().path,
			dataDir,
			codeRepoRoot: codeRepoRootOrFail(repoRoot()),
			appIds: o.apps ? parseIds(o.apps) : undefined,
			queue: parseQueue(o.queue),
		});
		emit(
			m,
			o.json,
			(x: PacketManifest) =>
				`packet ${x.id}: ${x.apps.length} apps pushed\n${x.apps.map((a) => `  ${a.app_id} ${a.company} - ${a.title}`).join("\n")}`,
		);
	} finally {
		db.close();
	}
}

async function runImport(packet: string, o: JsonOpt) {
	const dataDir = dataRepoDir();
	const db = openDb();
	try {
		const me = loadMe();
		const report = await importResults({
			db,
			dataDir,
			packetId: packet,
			artifactsRoot: artifactsDir(),
			validate: (draftPath) => {
				const json = JSON.parse(readFileSync(draftPath, "utf8"));
				const v = validateDraftFile(db, draftPath, json, me);
				return {
					ok: v.ok,
					errors: v.errors.map((e) => `${e.code} ${e.path}: ${e.message}`),
				};
			},
		});
		emit(report, o.json, (r: ImportReport) =>
			[
				`packet ${r.packet_id}: ${r.imported.length} imported, ${r.skipped.length} skipped, ${r.missing.length} missing`,
				...r.imported.map(
					(i) =>
						`  ${i.app_id} ${i.run_id} ${i.valid ? "valid: ready for layout and finalize" : `INVALID ${i.errors.join("; ")}`}`,
				),
				...(r.missing.length ? [`  missing: ${r.missing.join(", ")}`] : []),
			].join("\n"),
		);
	} finally {
		db.close();
	}
}

export interface PacketStatus {
	id: string;
	apps: number;
	has_results: boolean;
	imported: boolean;
	/** Set when packet.json or summary.json is unreadable; the packet is still listed. */
	error?: string;
}

function readJsonFile(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8"));
}

/** Packets in the data repo, oldest first, with their results and import state. */
export function packetStatus(db: Db, dataDir: string): PacketStatus[] {
	const root = join(dataDir, "packets");
	if (!existsSync(root)) return [];
	const has = db.prepare("SELECT 1 FROM resume_runs WHERE id = ?");
	return readdirSync(root, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort()
		.map((id) => {
			const errors: string[] = [];
			const manifestPath = join(root, id, "packet.json");
			let apps = 0;
			if (existsSync(manifestPath)) {
				try {
					apps = PacketManifest.parse(readJsonFile(manifestPath)).apps.length;
				} catch (e) {
					errors.push(`packet.json: ${(e as Error).message.split("\n")[0]}`);
				}
			} else errors.push("packet.json: missing");
			const resDir = join(dataDir, "results", id);
			const summaryPath = join(resDir, "summary.json");
			let imported = false;
			if (existsSync(summaryPath)) {
				try {
					const s = CloudSummary.parse(readJsonFile(summaryPath));
					const runIds = s.apps.flatMap((a) => (a.run_id ? [a.run_id] : []));
					imported = runIds.length > 0 && runIds.every((r) => has.get(r));
				} catch (e) {
					errors.push(`summary.json: ${(e as Error).message.split("\n")[0]}`);
				}
			}
			const status: PacketStatus = {
				id,
				apps,
				has_results: existsSync(resDir),
				imported,
			};
			if (errors.length) status.error = errors.join("; ");
			return status;
		});
}

function runStatusCmd(o: JsonOpt) {
	const dataDir = dataRepoDir();
	const packets = withDb((db) => packetStatus(db, dataDir));
	emit(
		{ data_dir: dataDir, packets },
		o.json,
		(r: { packets: PacketStatus[] }) =>
			r.packets.length
				? r.packets
						.map(
							(p) =>
								`${p.id}  ${p.apps} apps  results=${p.has_results ? "yes" : "no"}  imported=${p.imported ? "yes" : "no"}${p.error ? `  CORRUPT ${p.error}` : ""}`,
						)
						.join("\n")
				: "no packets",
	);
}

export function register(program: Command): void {
	const cloud = program
		.command("cloud")
		.description(
			"run the resume loop in cloud sessions via the private data repo (ADR 006): export, import, status",
		);

	cloud
		.command("export")
		.description(
			"build a packet (apps, JD text, DB snapshot, allowlisted me/) and push it to the private data repo",
		)
		.option("--apps <ids>", "comma-separated application ids")
		.option(
			"--queue <n>",
			"take the next n shortlisted apps with JD text and no finalized resume (default 10)",
		)
		.option("--json", "machine-readable output")
		.action(action(runExport));

	cloud
		.command("import <packet>")
		.description(
			"pull the data repo and merge a packet's cloud resume runs into the local DB, then re-validate each winner",
		)
		.option("--json", "machine-readable output")
		.action(action(runImport));

	cloud
		.command("status")
		.description("list packets in the data repo with results and import state")
		.option("--json", "machine-readable output")
		.action(action(runStatusCmd));
}
