import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { z } from "zod";
import { audit } from "../core/audit.js";
import { JhError, NotFoundError, ValidationError } from "../core/errors.js";
import { action, emit } from "../core/output.js";
import { jhHome, repoRoot } from "../core/paths.js";
import {
	loadOrCreateToken,
	privateIPv4s,
	rotateToken,
	tokenPath,
} from "../dashboard/lan.js";
import { createServer, listening } from "../dashboard/server.js";
import { storedPort } from "../dashboard/supervisor.js";
import { openDb } from "../db/index.js";
import { getSetting, setSetting } from "../db/repo.js";
import { withDb } from "../db/tracking.js";
import { learnSummary } from "../learn/index.js";

export const TASK_NAME = "conscience-dashboard";
export const DEFAULT_PORT = 4777;
const Port = z.coerce.number().int().min(1).max(65535);

/** scripts/ next to dist/ when bundled (dist/jh.mjs -> ../scripts), else the repo's scripts/. */
export function scriptsDir(): string {
	const candidates = [
		fileURLToPath(new URL("../scripts/", import.meta.url)),
		repoRoot() ? join(repoRoot() as string, "scripts") : undefined,
	];
	for (const c of candidates)
		if (c && existsSync(join(c, "install-dashboard.ps1"))) return c;
	throw new NotFoundError(
		"scripts/install-dashboard.ps1 not found next to dist/",
	);
}

async function configuredPort(explicit?: string): Promise<number> {
	if (explicit) return Port.parse(explicit);
	return withDb((db) =>
		storedPort(getSetting(db, "dashboard.port", DEFAULT_PORT), DEFAULT_PORT),
	);
}

export async function probeHealth(
	port: number,
	timeoutMs = 1500,
): Promise<{ running: boolean; pid?: number }> {
	try {
		const r = await fetch(`http://127.0.0.1:${port}/healthz`, {
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (!r.ok) return { running: false };
		const body = (await r.json()) as { pid?: number };
		return { running: true, pid: body.pid };
	} catch {
		return { running: false };
	}
}

function scheduledTaskState(): string | null {
	if (process.platform !== "win32") return null;
	const r = spawnSync(
		"powershell.exe",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`$t = Get-ScheduledTask -TaskName '${TASK_NAME}' -ErrorAction SilentlyContinue; if ($t) { $t.State.ToString() }`,
		],
		{ encoding: "utf8", timeout: 15_000, windowsHide: true },
	);
	const out = (r.stdout ?? "").trim();
	return out || null;
}

function openUrl(url: string): void {
	const [cmd, args] =
		process.platform === "win32"
			? ["cmd.exe", ["/c", "start", "", url]]
			: process.platform === "darwin"
				? ["open", [url]]
				: ["xdg-open", [url]];
	spawn(cmd, args, {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	}).unref();
}

function runPowerShellScript(
	file: string,
	args: string[],
	json?: boolean,
): void {
	if (process.platform !== "win32")
		throw new ValidationError(
			"dashboard install/uninstall uses Windows Task Scheduler; run on Windows",
		);
	const r = spawnSync(
		"powershell.exe",
		["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...args],
		{
			stdio: json ? ["ignore", "pipe", "pipe"] : "inherit",
			encoding: "utf8",
			windowsHide: true,
		},
	);
	if (r.status !== 0)
		throw new JhError(
			`${file} failed with exit code ${r.status}${json ? `: ${(r.stderr ?? "").trim()}` : ""}`,
			1,
			"script_failed",
		);
}

/** Startup lines for LAN mode. The only place the token is ever printed. */
export function lanBanner(
	ips: readonly string[],
	port: number,
	token: string,
	readOnly: boolean,
): string {
	const lines = [
		`LAN mode${readOnly ? " (read-only for other devices)" : ""}: listening on 0.0.0.0:${port}`,
	];
	if (ips.length === 0)
		lines.push(
			"No private IPv4 address found (10.x, 172.16-31.x, 192.168.x). Are you on Wi-Fi?",
		);
	for (const ip of ips)
		lines.push(
			`Open on your phone (same Wi-Fi): http://${ip}:${port}/?token=${token}`,
		);
	lines.push(
		"WARNING: anyone with this link can see your job-hunt data. Do not share it; rotate with 'jh dashboard token --rotate'.",
		"Windows may ask to allow Node.js through the firewall: allow it on PRIVATE networks only, never Public.",
	);
	return `${lines.join("\n")}\n`;
}

async function serve(opts: {
	port?: string;
	home?: string;
	lan?: boolean;
	readOnly?: boolean;
}): Promise<void> {
	if (opts.home) process.env.JOB_HUNTER_HOME = resolve(opts.home);
	if (opts.readOnly && !opts.lan)
		throw new ValidationError("--read-only only applies with --lan");
	const db = openDb();
	const port = opts.port
		? Port.parse(opts.port)
		: storedPort(getSetting(db, "dashboard.port", DEFAULT_PORT), DEFAULT_PORT);
	const ips = opts.lan ? privateIPv4s() : [];
	const token = opts.lan ? loadOrCreateToken() : "";
	const server = createServer(db, {
		port,
		learn: learnSummary,
		log: (l) => process.stderr.write(`${l}\n`),
		lan: opts.lan
			? { token, ips, readOnly: Boolean(opts.readOnly) }
			: undefined,
	});
	const bound = await listening(server);
	process.stdout.write(
		`dashboard on http://127.0.0.1:${bound} (Ctrl+C to stop)\n`,
	);
	if (opts.lan)
		process.stdout.write(lanBanner(ips, bound, token, Boolean(opts.readOnly)));
	const stop = () => {
		server.close();
		db.close();
		process.exit(0);
	};
	process.on("SIGINT", stop);
	process.on("SIGTERM", stop);
	await new Promise<void>((r) => server.on("close", () => r()));
}

export function register(program: Command): void {
	const dash = program
		.command("dashboard")
		.description(
			"local dashboard on 127.0.0.1 (study clock, interviews, pipeline)",
		);

	dash
		.command("serve")
		.description("run the dashboard in the foreground (no supervisor)")
		.option("--port <n>", "port (default: settings dashboard.port = 4777)")
		.option("--home <dir>", "JOB_HUNTER_HOME override")
		.option(
			"--lan",
			"also serve on this machine's Wi-Fi/LAN address (token required)",
		)
		.option("--read-only", "with --lan: other devices can only view")
		.action(action(serve));

	dash
		.command("token")
		.description(
			"LAN access token file (~/.job-hunter/dashboard-token); --rotate makes a new one",
		)
		.option("--rotate", "replace the token (old links stop working)")
		.option("--json", "machine-readable output")
		.action(
			action(async (opts: { rotate?: boolean; json?: boolean }) => {
				// The token itself is never printed here or audited.
				if (opts.rotate) {
					rotateToken();
					audit({ actor: "user", action: "dashboard.token.rotate" });
				} else loadOrCreateToken();
				const path = tokenPath();
				emit({ path, rotated: Boolean(opts.rotate) }, opts.json, () =>
					opts.rotate
						? `rotated the token in ${path}; restart 'jh dashboard serve --lan' to print the new link`
						: `token stored in ${path}; 'jh dashboard serve --lan' prints the link`,
				);
			}),
		);

	dash
		.command("open")
		.description("open the dashboard in the default browser")
		.option("--port <n>", "port")
		.option("--json", "machine-readable output")
		.action(
			action(async (opts: { port?: string; json?: boolean }) => {
				const port = await configuredPort(opts.port);
				const url = `http://127.0.0.1:${port}/`;
				const health = await probeHealth(port);
				openUrl(url);
				emit({ url, running: health.running }, opts.json, () =>
					health.running
						? `opened ${url}`
						: `opened ${url} (not responding: run 'jh dashboard install' or 'jh dashboard serve')`,
				);
			}),
		);

	dash
		.command("status")
		.description("whether the dashboard is running and the logon task state")
		.option("--port <n>", "port")
		.option("--json", "machine-readable output")
		.action(
			action(async (opts: { port?: string; json?: boolean }) => {
				const port = await configuredPort(opts.port);
				const health = await probeHealth(port);
				const res = {
					url: `http://127.0.0.1:${port}/`,
					port,
					...health,
					task: scheduledTaskState(),
				};
				emit(
					res,
					opts.json,
					(r: typeof res) =>
						`${r.running ? `running (pid ${r.pid})` : "not running"} at ${r.url}; task ${r.task ?? "not installed"}`,
				);
			}),
		);

	dash
		.command("install")
		.description(
			`register the '${TASK_NAME}' logon task (Windows) and start it`,
		)
		.option("--port <n>", "port (default: settings dashboard.port = 4777)")
		.option(
			"--open-at-logon",
			"also open the dashboard in the browser at logon",
		)
		.option("--json", "machine-readable output")
		.action(
			action(
				async (opts: {
					port?: string;
					openAtLogon?: boolean;
					json?: boolean;
				}) => {
					const port = await configuredPort(opts.port);
					const script = join(scriptsDir(), "install-dashboard.ps1");
					const args = ["-Port", String(port), "-JhHome", jhHome()];
					if (opts.openAtLogon) args.push("-OpenAtLogon");
					runPowerShellScript(script, args, opts.json);
					// status/open read dashboard.port, so remember the installed port.
					await withDb((db) => setSetting(db, "dashboard.port", port));
					audit({
						actor: "user",
						action: "dashboard.install",
						detail: { port, openAtLogon: Boolean(opts.openAtLogon) },
					});
					const health = await probeHealth(port, 3000);
					emit(
						{ task: TASK_NAME, port, running: health.running },
						opts.json,
						() =>
							`installed ${TASK_NAME} on port ${port}${health.running ? " (running)" : ""}`,
					);
				},
			),
		);

	dash
		.command("uninstall")
		.description(`stop and remove the '${TASK_NAME}' logon task`)
		.option("--json", "machine-readable output")
		.action(
			action(async (opts: { json?: boolean }) => {
				runPowerShellScript(
					join(scriptsDir(), "uninstall-dashboard.ps1"),
					[],
					opts.json,
				);
				audit({ actor: "user", action: "dashboard.uninstall" });
				emit(
					{ task: TASK_NAME, removed: true },
					opts.json,
					() => `removed ${TASK_NAME}`,
				);
			}),
		);
}
