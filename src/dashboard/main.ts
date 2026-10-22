/**
 * Dashboard entry point (bundled to dist/dashboard.mjs).
 *   node dist/dashboard.mjs [--port 4777] [--home <jhHome>]      -> supervisor
 *   node dist/dashboard.mjs --child [--port 4777] [--home <dir>]  -> HTTP server
 * --home is applied to JOB_HUNTER_HOME before loadEnv(), so the scheduled task
 * always sees the right data directory.
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "../core/env.js";
import { ensureDir, logsDir } from "../core/paths.js";
import { openDb } from "../db/index.js";
import { getSetting } from "../db/repo.js";
import { learnSummary } from "../learn/index.js";
import { createServer, listening } from "./server.js";
import {
	childArgs,
	createRotatingLog,
	type DashboardArgs,
	EXIT_PORT_IN_USE,
	type LogFn,
	parseDashboardArgs,
	storedPort,
	supervise,
} from "./supervisor.js";

export const DEFAULT_PORT = 4777;

function runChild(args: DashboardArgs, log: LogFn): void {
	const db = openDb();
	const port =
		args.port ??
		storedPort(
			getSetting(db, "dashboard.port", DEFAULT_PORT),
			DEFAULT_PORT,
			log,
		);
	const server = createServer(db, {
		port,
		uiDir: args.ui,
		learn: learnSummary,
		log,
	});
	server.on("error", (e: NodeJS.ErrnoException) => {
		log(`server error: ${e.code ?? ""} ${e.message}`);
		db.close();
		process.exit(e.code === "EADDRINUSE" ? EXIT_PORT_IN_USE : 1);
	});
	listening(server)
		.then((p) => log(`listening on http://127.0.0.1:${p} pid=${process.pid}`))
		.catch(() => {});
	const shutdown = (why: string) => {
		log(`shutting down (${why})`);
		server.close();
		db.close();
		process.exit(0);
	};
	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("disconnect", () => shutdown("supervisor gone"));
	process.on("uncaughtException", (e) => {
		log(`uncaught: ${e.stack ?? e.message}`);
		process.exit(1);
	});
}

function runSupervisor(args: DashboardArgs, log: LogFn): void {
	const sup = supervise({
		script: fileURLToPath(import.meta.url),
		args: childArgs(args),
		log,
	});
	const stop = () => {
		log("supervisor stopping");
		sup.stop();
		setTimeout(() => process.exit(0), 500).unref();
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	log(`supervisor pid=${process.pid}`);
}

function main(): void {
	const args = parseDashboardArgs(process.argv.slice(2));
	if (args.home) {
		args.home = resolve(args.home);
		process.env.JOB_HUNTER_HOME = args.home;
	}
	loadEnv();
	const log = createRotatingLog(join(ensureDir(logsDir()), "dashboard.log"), {
		tag: args.child ? "server" : "supervisor",
	});
	if (args.child) runChild(args, log);
	else runSupervisor(args, log);
}

main();
