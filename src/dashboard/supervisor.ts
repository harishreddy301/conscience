/**
 * Supervisor: forks the dashboard child and respawns it with exponential backoff
 * (1s .. 60s). Also provides the size-rotated log used by both processes.
 */
import { type ChildProcess, fork } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	renameSync,
	rmSync,
	statSync,
} from "node:fs";

export const LOG_MAX_BYTES = 1024 * 1024;
export const LOG_KEEP = 3;
export const MIN_BACKOFF_MS = 1000;
export const MAX_BACKOFF_MS = 60_000;
/** A child that ran this long is considered healthy; backoff resets. */
export const HEALTHY_RUN_MS = 60_000;
/** Child exit code meaning "another dashboard already owns the port": do not respawn. */
export const EXIT_PORT_IN_USE = 3;

export type LogFn = (line: string) => void;

export interface DashboardArgs {
	port?: number;
	home?: string;
	ui?: string;
	child: boolean;
}

/** Parse `--port N --home DIR --ui DIR --child` (also `--port=N`). */
export function parseDashboardArgs(argv: string[]): DashboardArgs {
	const out: DashboardArgs = { child: false };
	for (let i = 0; i < argv.length; i++) {
		const [flag, inline] = (argv[i] ?? "").split(/=(.*)/s, 2);
		const value = (): string => {
			const v = inline ?? argv[++i];
			if (v === undefined || v === "") throw new Error(`${flag} needs a value`);
			return v;
		};
		if (flag === "--child") out.child = true;
		else if (flag === "--home") out.home = value();
		else if (flag === "--ui") out.ui = value();
		else if (flag === "--port") {
			const n = Number(value());
			if (!Number.isInteger(n) || n < 0 || n > 65535)
				throw new Error("--port must be 0..65535");
			out.port = n;
		}
	}
	return out;
}

/** Args to pass to the forked child (adds --child, forwards the rest). */
export function childArgs(a: DashboardArgs): string[] {
	const out = ["--child"];
	if (a.port !== undefined) out.push("--port", String(a.port));
	if (a.home) out.push("--home", a.home);
	if (a.ui) out.push("--ui", a.ui);
	return out;
}

/** A stored dashboard.port value, or `fallback` when it is not a valid port. */
export function storedPort(
	raw: unknown,
	fallback: number,
	log?: LogFn,
): number {
	const n = Number(raw);
	if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
	log?.(
		`invalid dashboard.port setting ${JSON.stringify(raw)}; using ${fallback}`,
	);
	return fallback;
}

/** Rotate `path` -> `.1` -> `.2` when it would exceed maxBytes; keeps `keep` files total. */
export function rotateIfNeeded(
	path: string,
	incomingBytes: number,
	maxBytes = LOG_MAX_BYTES,
	keep = LOG_KEEP,
): boolean {
	if (!existsSync(path)) return false;
	if (statSync(path).size + incomingBytes <= maxBytes) return false;
	const oldest = `${path}.${keep - 1}`;
	if (existsSync(oldest)) rmSync(oldest, { force: true });
	for (let i = keep - 2; i >= 1; i--) {
		const from = `${path}.${i}`;
		if (existsSync(from)) renameSync(from, `${path}.${i + 1}`);
	}
	renameSync(path, `${path}.1`);
	return true;
}

export function createRotatingLog(
	path: string,
	o: { maxBytes?: number; keep?: number; tag?: string } = {},
): LogFn {
	return (line: string) => {
		const text = `${new Date().toISOString()} ${o.tag ? `[${o.tag}] ` : ""}${line.replace(/\s+$/, "")}\n`;
		try {
			rotateIfNeeded(path, Buffer.byteLength(text), o.maxBytes, o.keep);
			appendFileSync(path, text, { mode: 0o600 });
		} catch {
			// Logging must never take the dashboard down.
		}
	};
}

/** Next delay: double the previous (min 1s, max 60s); reset after a healthy run. */
export function nextBackoff(prevMs: number, ranForMs: number): number {
	if (ranForMs >= HEALTHY_RUN_MS) return MIN_BACKOFF_MS;
	if (prevMs <= 0) return MIN_BACKOFF_MS;
	return Math.min(MAX_BACKOFF_MS, prevMs * 2);
}

export interface SuperviseOptions {
	script: string;
	args: string[];
	log: LogFn;
	execArgv?: string[];
	/** Injected for tests. */
	spawn?: (script: string, args: string[], execArgv: string[]) => ChildProcess;
	schedule?: (fn: () => void, ms: number) => unknown;
}

export interface Supervisor {
	stop(): void;
}

const defaultSpawn = (
	script: string,
	args: string[],
	execArgv: string[],
): ChildProcess =>
	fork(script, args, { execArgv, stdio: ["ignore", "pipe", "pipe", "ipc"] });

function pipeOutput(child: ChildProcess, log: LogFn): void {
	const forward = (buf: Buffer) => {
		for (const line of buf.toString("utf8").split(/\r?\n/))
			if (line.trim()) log(`child: ${line}`);
	};
	child.stdout?.on("data", forward);
	child.stderr?.on("data", forward);
}

/** Keep one child running until stop() or a port-in-use exit. */
export function supervise(o: SuperviseOptions): Supervisor {
	const spawn = o.spawn ?? defaultSpawn;
	const schedule = o.schedule ?? ((fn, ms) => setTimeout(fn, ms));
	let child: ChildProcess | null = null;
	let stopped = false;
	let delay = 0;

	const start = () => {
		if (stopped) return;
		const startedAt = Date.now();
		let handled = false;
		const restart = (why: string) => {
			if (handled) return;
			handled = true;
			child = null;
			if (stopped) return;
			delay = nextBackoff(delay, Date.now() - startedAt);
			o.log(`${why}; restarting in ${delay}ms`);
			schedule(start, delay);
		};
		let c: ChildProcess;
		try {
			c = spawn(o.script, o.args, o.execArgv ?? process.execArgv);
		} catch (e) {
			restart(`spawn failed: ${(e as Error).message}`);
			return;
		}
		child = c;
		o.log(`started child pid=${c.pid}`);
		pipeOutput(c, o.log);
		// A failed fork emits 'error' (and maybe no 'exit'); without a listener
		// it would crash the supervisor.
		c.on("error", (e) => restart(`child error: ${e.message}`));
		c.on("exit", (code, signal) => {
			if (handled) return;
			if (!stopped && code === EXIT_PORT_IN_USE) {
				handled = true;
				child = null;
				o.log("port already in use by another dashboard; supervisor exiting");
				stopped = true;
				return;
			}
			restart(`child exited code=${code} signal=${signal}`);
		});
	};

	start();
	return {
		stop() {
			stopped = true;
			child?.kill();
		},
	};
}
