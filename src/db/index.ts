import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dbPath, ensureDir } from "../core/paths.js";
import { MIGRATIONS } from "./migrations.js";

export type Db = DatabaseSync;

export function nowIso(): string {
	return new Date().toISOString();
}

/**
 * Open (creating if needed) the SQLite database and bring it to the latest schema.
 * Default path is dbPath(); ":memory:" is allowed.
 */
export function openDb(path: string = dbPath()): Db {
	if (path !== ":memory:") ensureDir(dirname(path));
	const db = new DatabaseSync(path);
	try {
		// busy_timeout first: switching journal mode needs a lock, and a
		// concurrent opener (dashboard + CLI) must wait instead of SQLITE_BUSY.
		db.exec("PRAGMA busy_timeout=5000");
		db.exec("PRAGMA journal_mode=WAL");
		db.exec("PRAGMA foreign_keys=ON");
		migrate(db);
	} catch (e) {
		db.close();
		throw e;
	}
	return db;
}

export function userVersion(db: Db): number {
	const row = db.prepare("PRAGMA user_version").get() as
		| { user_version: number }
		| undefined;
	return row?.user_version ?? 0;
}

/** Apply MIGRATIONS[user_version..] each in its own transaction; returns the final version. */
export function migrate(db: Db): number {
	let version = userVersion(db);
	if (version > MIGRATIONS.length) {
		throw new Error(
			`database schema v${version} is newer than this jh (v${MIGRATIONS.length}); update the plugin`,
		);
	}
	while (version < MIGRATIONS.length) {
		version = tx(db, () => {
			// Re-read under the write lock: another process may have migrated
			// while we waited on BEGIN IMMEDIATE.
			const current = userVersion(db);
			if (current >= MIGRATIONS.length) return current;
			const sql = MIGRATIONS[current] as string;
			const next = current + 1;
			db.exec(sql);
			db.exec(`PRAGMA user_version=${next}`);
			return next;
		});
	}
	return version;
}

/**
 * Transaction depth per connection. Tracked here rather than via
 * DatabaseSync#isTransaction, which only exists from Node 22.16 / 24.0
 * while engines allows >=22.13.
 */
const depth = new WeakMap<Db, number>();
let savepointSeq = 0;

/**
 * Run fn in a transaction (BEGIN IMMEDIATE / COMMIT / ROLLBACK).
 * Nested calls use a SAVEPOINT so an inner failure rolls back only its part.
 */
export function tx<T>(db: Db, fn: () => T): T {
	const d = depth.get(db) ?? 0;
	if (d > 0) return savepoint(db, d, fn);
	db.exec("BEGIN IMMEDIATE");
	depth.set(db, 1);
	try {
		const out = fn();
		db.exec("COMMIT");
		return out;
	} catch (e) {
		try {
			db.exec("ROLLBACK");
		} catch {
			// already rolled back by SQLite; keep the original error
		}
		throw e;
	} finally {
		depth.set(db, 0);
	}
}

function savepoint<T>(db: Db, d: number, fn: () => T): T {
	const name = `jh_sp_${++savepointSeq}`;
	db.exec(`SAVEPOINT ${name}`);
	depth.set(db, d + 1);
	try {
		const out = fn();
		db.exec(`RELEASE ${name}`);
		return out;
	} catch (e) {
		try {
			db.exec(`ROLLBACK TO ${name}`);
			db.exec(`RELEASE ${name}`);
		} catch {
			// savepoint gone (whole transaction rolled back); rethrow the root cause
		}
		throw e;
	} finally {
		depth.set(db, d);
	}
}
