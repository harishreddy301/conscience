import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { audit } from "../core/audit.js";
import {
	ConflictError,
	NotFoundError,
	ValidationError,
} from "../core/errors.js";
import { type Db, userVersion } from "../db/index.js";
import {
	assertPrivateRemote,
	commitAndPush,
	defaultRun,
	type Run,
	syncDataRepo,
} from "./git.js";
import { type PacketApp, PacketManifest } from "./schema.js";

/** Files over this size never leave the PC. */
export const MAX_EXPORT_BYTES = 5 * 1024 * 1024;
export const DEFAULT_QUEUE = 10;

/** The only file types that leave the PC (ADR 006). */
export const EXPORT_EXTENSIONS = [
	".md",
	".yaml",
	".yml",
	".json",
	".txt",
	".pdf",
	".docx",
] as const;

/**
 * The export allowlist for me/ (ADR 006): documents with an allowlisted
 * extension, never `tk.sh`, `.env*`, backups (`*.backup*`, `*.bak*`, `*~`),
 * anything under `.git/`, or files over 5 MB. Case-insensitive.
 */
export function isExportable(relPath: string, sizeBytes: number): boolean {
	if (sizeBytes > MAX_EXPORT_BYTES) return false;
	const parts = relPath
		.toLowerCase()
		.split(/[\\/]+/)
		.filter(Boolean);
	const name = parts.at(-1);
	if (!name) return false;
	if (parts.some((p) => p === ".git" || p.startsWith(".env"))) return false;
	if (name === "tk.sh" || name.endsWith("~")) return false;
	if (name.includes(".backup") || name.includes(".bak")) return false;
	return EXPORT_EXTENSIONS.some((ext) => name.endsWith(ext));
}

interface AppRow {
	app_id: number;
	company: string;
	title: string;
	url: string | null;
	jd_text: string | null;
}

const APP_SQL = `SELECT a.id AS app_id, c.name AS company, j.title AS title,
	COALESCE(j.url, j.canonical_url) AS url, j.jd_text AS jd_text
	FROM applications a JOIN jobs j ON j.id = a.job_id JOIN companies c ON c.id = j.company_id`;

const NOT_FINALIZED = `NOT EXISTS (SELECT 1 FROM resume_runs r
	WHERE r.application_id = a.id AND r.status = 'finalized')`;

function toPacketApp(r: AppRow): PacketApp {
	return {
		app_id: r.app_id,
		company: r.company,
		title: r.title,
		url: r.url,
		jd_path: `jd/${r.app_id}.txt`,
	};
}

function selectRows(
	db: Db,
	opts: { appIds?: number[]; queue?: number },
): AppRow[] {
	if (opts.appIds?.length) {
		return opts.appIds.map((id) => {
			const row = db.prepare(`${APP_SQL} WHERE a.id = ?`).get(id) as
				| AppRow
				| undefined;
			if (!row) throw new NotFoundError(`application ${id} not found`);
			if (!row.jd_text?.trim())
				throw new ValidationError(
					`application ${id} has no JD text; fetch it before exporting`,
					{ app_id: id },
					"jd_missing",
				);
			return row;
		});
	}
	const limit = opts.queue ?? DEFAULT_QUEUE;
	if (!Number.isInteger(limit) || limit <= 0)
		throw new ValidationError("--queue must be a positive integer");
	return db
		.prepare(
			`${APP_SQL} WHERE a.status = 'shortlisted' AND j.jd_text IS NOT NULL AND trim(j.jd_text) <> ''
			   AND ${NOT_FINALIZED}
			 ORDER BY (a.requested_by IS NULL), a.last_event_at DESC, a.id DESC LIMIT ?`,
		)
		.all(limit) as unknown as AppRow[];
}

/**
 * Apps for a packet: the given ids, or the queue of shortlisted apps with JD
 * text and no finalized run (user-requested first, then newest activity).
 */
export function selectApps(
	db: Db,
	opts: { appIds?: number[]; queue?: number },
): PacketApp[] {
	return selectRows(db, opts).map(toPacketApp);
}

function canonical(p: string): string {
	const abs = resolve(p);
	try {
		return realpathSync.native(abs);
	} catch {
		return abs;
	}
}

/** True when `child` is `parent` or sits under it (case-insensitive on Windows). */
export function isInside(child: string, parent: string): boolean {
	const fold = (s: string) =>
		process.platform === "win32" ? s.toLowerCase() : s;
	const rel = relative(fold(canonical(parent)), fold(canonical(child)));
	return (
		rel === "" ||
		(!rel.startsWith(`..${sep}`) &&
			rel !== ".." &&
			!/^[a-zA-Z]:/.test(rel) &&
			!rel.startsWith(sep))
	);
}

/** Local-time packet id: p-YYYYMMDD-HHMM. */
export function packetId(now: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `p-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

function walkFiles(root: string, rel = ""): { rel: string; size: number }[] {
	const dir = join(root, rel);
	if (!existsSync(dir)) return [];
	const out: { rel: string; size: number }[] = [];
	for (const name of readdirSync(dir)) {
		const r = rel ? `${rel}/${name}` : name;
		const st = lstatSync(join(root, r));
		if (st.isSymbolicLink()) continue;
		if (st.isDirectory()) {
			if (name === ".git") continue;
			out.push(...walkFiles(root, r));
		} else if (st.isFile()) out.push({ rel: r, size: st.size });
	}
	return out;
}

/** Remove empty directories under root (not root itself). */
function pruneEmpty(root: string, rel = ""): boolean {
	const dir = join(root, rel);
	let empty = true;
	for (const name of readdirSync(dir)) {
		const r = rel ? `${rel}/${name}` : name;
		const st = lstatSync(join(root, r));
		if (st.isDirectory() && !st.isSymbolicLink()) {
			if (pruneEmpty(root, r)) rmSync(join(root, r), { recursive: true });
			else empty = false;
		} else empty = false;
	}
	return empty;
}

/** Throw if `p` exists and is a symlink (or junction), or not of the expected kind. */
function assertNoLink(p: string, kind: "dir" | "file"): void {
	let st: ReturnType<typeof lstatSync>;
	try {
		st = lstatSync(p);
	} catch {
		return; // does not exist yet
	}
	if (
		st.isSymbolicLink() ||
		(kind === "dir" ? !st.isDirectory() : !st.isFile())
	)
		throw new ValidationError(
			`refusing to mirror me/ through ${p}: it is a link or not a plain ${kind === "dir" ? "directory" : "file"}`,
			{ path: p },
			"mirror_unsafe_path",
		);
}

/** Check dest and every directory between it and `rel`'s parent, then the file itself. */
function safeTarget(dest: string, rel: string): string {
	const parts = rel.split("/");
	let dir = dest;
	for (const part of parts.slice(0, -1)) {
		dir = join(dir, part);
		assertNoLink(dir, "dir");
	}
	const target = join(dest, ...parts);
	assertNoLink(target, "file");
	if (!isInside(target, dest))
		throw new ValidationError(
			`refusing to write ${target} outside ${dest}`,
			{ path: target },
			"mirror_unsafe_path",
		);
	return target;
}

/** Mirror the allowlisted files of meDir into dest; files gone from me/ are deleted. */
export function mirrorMe(
	meDir: string,
	dest: string,
): { copied: number; removed: number } {
	assertNoLink(dest, "dir");
	const keep = walkFiles(meDir).filter((f) => isExportable(f.rel, f.size));
	const wanted = new Set(keep.map((f) => f.rel));
	// Every path is checked before anything is removed or written.
	const stale = walkFiles(dest).filter((f) => !wanted.has(f.rel));
	const staleTargets = stale.map((f) => safeTarget(dest, f.rel));
	const targets = keep.map((f) => safeTarget(dest, f.rel));
	for (const t of staleTargets) rmSync(t);
	keep.forEach((f, i) => {
		const target = targets[i] as string;
		mkdirSync(dirname(target), { recursive: true });
		safeTarget(dest, f.rel);
		copyFileSync(join(meDir, f.rel), target);
	});
	mkdirSync(dest, { recursive: true });
	pruneEmpty(dest);
	return { copied: keep.length, removed: staleTargets.length };
}

export interface ExportOptions {
	db: Db;
	meDir: string;
	dataDir: string;
	codeRepoRoot: string;
	appIds?: number[];
	queue?: number;
	run?: Run;
	now?: Date;
}

/**
 * Build packets/<id>/ (packet.json, jd/<appId>.txt, a VACUUM INTO snapshot of
 * the DB), mirror the allowlisted me/ into the data repo, commit and push.
 * Every guard runs before anything is written; the local DB is never changed.
 */
export async function exportPacket(
	opts: ExportOptions,
): Promise<PacketManifest> {
	const run = opts.run ?? defaultRun;
	const dataDir = resolve(opts.dataDir);
	if (!existsSync(dataDir))
		throw new NotFoundError(`data repo clone not found at ${dataDir}`);
	if (isInside(dataDir, opts.codeRepoRoot))
		throw new ValidationError(
			`data repo ${dataDir} sits inside the code repo ${opts.codeRepoRoot}; clone it elsewhere (ADR 006)`,
			{ dataDir, codeRepoRoot: opts.codeRepoRoot },
			"data_repo_inside_code_repo",
		);
	if (!existsSync(opts.meDir))
		throw new NotFoundError(`me/ workspace not found at ${opts.meDir}`);
	if (isInside(opts.meDir, dataDir) || isInside(dataDir, opts.meDir))
		throw new ValidationError(
			"me/ and the data repo must be separate folders",
			{ meDir: opts.meDir, dataDir },
			"data_repo_overlaps_me",
		);
	const rows = selectRows(opts.db, opts);
	if (rows.length === 0)
		throw new ValidationError(
			"no applications to export (need shortlisted apps with JD text and no finalized resume)",
			undefined,
			"nothing_to_export",
		);
	await assertPrivateRemote(dataDir, run);
	// Rebase onto origin first so the push below does not race a cloud push.
	await syncDataRepo(dataDir, run);

	const now = opts.now ?? new Date();
	const id = packetId(now);
	const pktDir = join(dataDir, "packets", id);
	if (existsSync(pktDir))
		throw new ConflictError(
			`packet ${id} already exists; wait a minute and retry`,
		);

	const manifest = PacketManifest.parse({
		id,
		created_at: now.toISOString(),
		schema_version: userVersion(opts.db),
		apps: rows.map(toPacketApp),
	});
	mkdirSync(join(pktDir, "jd"), { recursive: true });
	for (const r of rows)
		writeFileSync(
			join(pktDir, "jd", `${r.app_id}.txt`),
			r.jd_text ?? "",
			"utf8",
		);
	writeFileSync(
		join(pktDir, "packet.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);
	opts.db.prepare("VACUUM INTO ?").run(join(pktDir, "jh.db"));
	const me = mirrorMe(resolve(opts.meDir), join(dataDir, "me"));

	await commitAndPush(dataDir, `packet ${id}: ${rows.length} apps`, run, [
		"me",
		`packets/${id}`,
	]);
	audit({
		actor: "jh",
		action: "cloud.export",
		target: `packet:${id}`,
		detail: { apps: manifest.apps.map((a) => a.app_id), me_files: me.copied },
	});
	return manifest;
}
