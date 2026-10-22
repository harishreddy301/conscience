import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { type Db, tx, userVersion } from "../db/index.js";
import { isInside } from "./export.js";
import { defaultRun, type Run } from "./git.js";
import {
	CloudSummary,
	PACKET_ID_RE,
	PacketManifest,
	RUN_ID_RE,
} from "./schema.js";

export interface ImportReport {
	packet_id: string;
	imported: {
		app_id: number;
		run_id: string;
		valid: boolean;
		errors: string[];
	}[];
	skipped: string[];
	missing: number[];
}

export interface ImportOptions {
	db: Db;
	dataDir: string;
	packetId: string;
	artifactsRoot: string;
	validate: (draftPath: string) => { ok: boolean; errors: string[] };
	run?: Run;
	/** Copies a run dir (recursive). Injected in tests. */
	copy?: (src: string, dest: string) => void;
}

const defaultCopy = (src: string, dest: string): void =>
	cpSync(src, dest, { recursive: true });

function assertInside(child: string, parent: string, what: string): void {
	if (!isInside(child, parent))
		throw new ValidationError(
			`${what} ${child} escapes ${parent}`,
			{ path: child, root: parent },
			"path_escape",
		);
}

const RUN_COLS =
	"id, application_id, workdir, jd_path, keywords_json, status, iterations, final_draft_id, ats_score, hm_verdict, quality, created_at, finalized_at";
const DRAFT_COLS =
	"run_id, id, angle, iteration, path, ats_score, valid, created_at";
const REVIEW_COLS =
	"run_id, draft_id, reviewer, verdict, score, json, created_at";
const SNAPSHOT_COLS =
	"application_id, title_posted, seniority, must_haves_json, nice_to_haves_json, keywords_json, location, remote, salary, summary, source_url, captured_at";

type SqlValue = string | number | null;

/** resume_runs columns as read from the cloud DB. */
interface RunRow {
	id: string;
	application_id: number;
	workdir: string;
	jd_path: string;
	keywords_json: SqlValue;
	status: string;
	iterations: number;
	final_draft_id: string | null;
	ats_score: SqlValue;
	hm_verdict: SqlValue;
	quality: SqlValue;
	created_at: string;
	finalized_at: SqlValue;
}

interface DraftRow {
	run_id: string;
	id: string;
	angle: string;
	iteration: number;
	path: string;
	ats_score: SqlValue;
	valid: SqlValue;
	created_at: string;
}

const ALIAS = "cloud";

function readJson(path: string, what: string): unknown {
	if (!existsSync(path)) throw new NotFoundError(`${what} not found: ${path}`);
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch (e) {
		throw new ValidationError(
			`invalid JSON in ${path}: ${(e as Error).message}`,
		);
	}
}

/** Re-root a cloud path under the local run dir; paths outside the cloud workdir stay as they are. */
export function rebase(
	p: string,
	cloudWorkdir: string,
	localWorkdir: string,
): string {
	const base = cloudWorkdir.replace(/[\\/]+$/, "");
	if (p === base) return localWorkdir;
	if (p.startsWith(`${base}/`) || p.startsWith(`${base}\\`)) {
		const rest = p
			.slice(base.length + 1)
			.split(/[\\/]+/)
			.filter(Boolean);
		return join(localWorkdir, ...rest);
	}
	return p;
}

function pickWinner(
	db: Db,
	runId: string,
	fromSummary: string | null | undefined,
	runRow: RunRow,
): string | null {
	const named = fromSummary ?? runRow.final_draft_id;
	if (named) return named;
	const best = db
		.prepare(
			`SELECT id FROM main.resume_drafts WHERE run_id = ? AND valid = 1
			 ORDER BY iteration DESC, ats_score DESC, created_at DESC LIMIT 1`,
		)
		.get(runId) as { id: string } | undefined;
	return best?.id ?? null;
}

/**
 * Merge a packet's cloud results into the local DB (ADR 006): copy run dirs
 * into <artifactsRoot>/<appId>/runs/<runId>/, insert only runs whose id is new
 * (with their drafts, reviews and missing JD snapshots), rewrite paths to the
 * local copy, then validate each winner. Never changes applications.status.
 */
export async function importResults(
	opts: ImportOptions,
): Promise<ImportReport> {
	const run = opts.run ?? defaultRun;
	const copy = opts.copy ?? defaultCopy;
	const { db } = opts;
	if (!PACKET_ID_RE.test(opts.packetId))
		throw new ValidationError(
			`invalid packet id ${JSON.stringify(opts.packetId)} (expected p-YYYYMMDD-HHMM)`,
			{ packet: opts.packetId },
			"bad_packet_id",
		);
	const dataDir = resolve(opts.dataDir);
	const artifactsRoot = resolve(opts.artifactsRoot);
	await run("git", ["pull", "-q", "--ff-only"], dataDir);

	const resDir = join(dataDir, "results", opts.packetId);
	assertInside(resDir, dataDir, "results dir");
	const manifestPath = join(dataDir, "packets", opts.packetId, "packet.json");
	const manifest = existsSync(manifestPath)
		? PacketManifest.parse(readJson(manifestPath, "packet manifest"))
		: null;
	const summary = CloudSummary.parse(
		readJson(join(resDir, "summary.json"), "cloud summary"),
	);
	for (const a of summary.apps)
		if (a.run_id !== null && !RUN_ID_RE.test(a.run_id))
			throw new ValidationError(
				`invalid run id ${JSON.stringify(a.run_id)} for app ${a.app_id} in summary.json`,
				{ app_id: a.app_id },
				"bad_run_id",
			);
	const cloudDb = join(resDir, "jh.db");
	if (!existsSync(cloudDb))
		throw new NotFoundError(`cloud DB not found: ${cloudDb}`);

	const report: ImportReport = {
		packet_id: opts.packetId,
		imported: [],
		skipped: [],
		missing: [],
	};
	const inSummary = new Set(summary.apps.map((a) => a.app_id));
	for (const a of manifest?.apps ?? [])
		if (!inSummary.has(a.app_id)) report.missing.push(a.app_id);

	db.prepare(`ATTACH DATABASE ? AS ${ALIAS}`).run(cloudDb);
	const copied: string[] = [];
	const toValidate: {
		app_id: number;
		run_id: string;
		winner: string | null;
	}[] = [];
	try {
		const remote = (
			db.prepare(`PRAGMA ${ALIAS}.user_version`).get() as {
				user_version: number;
			}
		).user_version;
		const local = userVersion(db);
		if (remote !== local)
			throw new ValidationError(
				`cloud DB schema v${remote} differs from local v${local}; update jh on both sides and re-run the packet`,
				{ cloud: remote, local },
				"schema_mismatch",
			);

		const plan: {
			app: (typeof summary.apps)[number];
			run: RunRow;
			localDir: string;
		}[] = [];
		for (const app of summary.apps) {
			if (!app.run_id) continue;
			const exists = db
				.prepare("SELECT 1 FROM main.resume_runs WHERE id = ?")
				.get(app.run_id);
			if (exists) {
				report.skipped.push(app.run_id);
				continue;
			}
			const cloudRun = db
				.prepare(`SELECT ${RUN_COLS} FROM ${ALIAS}.resume_runs WHERE id = ?`)
				.get(app.run_id) as RunRow | undefined;
			const srcDir = join(resDir, String(app.app_id), app.run_id);
			assertInside(srcDir, resDir, "cloud run dir");
			const known = db
				.prepare("SELECT 1 FROM main.applications WHERE id = ?")
				.get(app.app_id);
			if (
				!cloudRun ||
				cloudRun.application_id !== app.app_id ||
				!existsSync(srcDir) ||
				!known
			) {
				report.missing.push(app.app_id);
				continue;
			}
			const localDir = join(
				artifactsRoot,
				String(app.app_id),
				"runs",
				app.run_id,
			);
			assertInside(localDir, artifactsRoot, "local run dir");
			if (existsSync(localDir))
				throw new ValidationError(
					`run dir ${localDir} already exists but run ${app.run_id} is not in the DB; move it aside and retry`,
					{ run_id: app.run_id },
					"run_dir_exists",
				);
			plan.push({ app, run: cloudRun, localDir });
		}

		for (const p of plan) {
			// Record first: a copy that fails half way is still rolled back.
			copied.push(p.localDir);
			copy(
				join(resDir, String(p.app.app_id), p.app.run_id as string),
				p.localDir,
			);
		}

		tx(db, () => {
			const insRun = db.prepare(
				`INSERT INTO main.resume_runs(${RUN_COLS}) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			const insDraft = db.prepare(
				`INSERT INTO main.resume_drafts(${DRAFT_COLS}) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
			);
			const insReview = db.prepare(
				`INSERT INTO main.resume_reviews(${REVIEW_COLS}) SELECT ${REVIEW_COLS} FROM ${ALIAS}.resume_reviews WHERE run_id = ? ORDER BY id`,
			);
			const insSnapshot = db.prepare(
				`INSERT INTO main.jd_snapshots(${SNAPSHOT_COLS}) SELECT ${SNAPSHOT_COLS} FROM ${ALIAS}.jd_snapshots s
				 WHERE s.application_id = ? AND NOT EXISTS (SELECT 1 FROM main.jd_snapshots m WHERE m.application_id = s.application_id)`,
			);
			for (const { app, run: r, localDir } of plan) {
				const runId = app.run_id as string;
				const cloudWorkdir = String(r.workdir);
				insRun.run(
					r.id,
					r.application_id,
					localDir,
					rebase(String(r.jd_path), cloudWorkdir, localDir),
					r.keywords_json,
					// Layout and finalize run locally: never import a final state.
					"running",
					r.iterations,
					null,
					r.ats_score,
					r.hm_verdict,
					r.quality,
					r.created_at,
					null,
				);
				const drafts = db
					.prepare(
						`SELECT ${DRAFT_COLS} FROM ${ALIAS}.resume_drafts WHERE run_id = ?`,
					)
					.all(runId) as unknown as DraftRow[];
				for (const d of drafts)
					insDraft.run(
						d.run_id,
						d.id,
						d.angle,
						d.iteration,
						rebase(String(d.path), cloudWorkdir, localDir),
						d.ats_score,
						d.valid,
						d.created_at,
					);
				insReview.run(runId);
				insSnapshot.run(app.app_id);
				toValidate.push({
					app_id: app.app_id,
					run_id: runId,
					winner: pickWinner(db, runId, app.winner_draft_id, r),
				});
			}
		});
	} catch (e) {
		for (const dir of copied)
			if (isInside(dir, artifactsRoot))
				rmSync(dir, { recursive: true, force: true });
		throw e;
	} finally {
		try {
			db.exec(`DETACH DATABASE ${ALIAS}`);
		} catch {
			// Never mask the original error.
		}
	}

	for (const v of toValidate) {
		const draft = v.winner
			? (db
					.prepare("SELECT path FROM resume_drafts WHERE run_id = ? AND id = ?")
					.get(v.run_id, v.winner) as { path: string } | undefined)
			: undefined;
		let result: { ok: boolean; errors: string[] };
		if (!draft) result = { ok: false, errors: ["NO_WINNER_DRAFT"] };
		else {
			try {
				result = opts.validate(draft.path);
			} catch (e) {
				result = { ok: false, errors: [(e as Error).message] };
			}
		}
		if (v.winner)
			db.prepare(
				"UPDATE resume_drafts SET valid = ? WHERE run_id = ? AND id = ?",
			).run(result.ok ? 1 : 0, v.run_id, v.winner);
		report.imported.push({
			app_id: v.app_id,
			run_id: v.run_id,
			valid: result.ok,
			errors: result.errors,
		});
	}

	audit({
		actor: "jh",
		action: "cloud.import",
		target: `packet:${opts.packetId}`,
		detail: {
			imported: report.imported.map((i) => i.run_id),
			skipped: report.skipped.length,
			missing: report.missing,
		},
	});
	return report;
}
