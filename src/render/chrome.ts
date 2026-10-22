import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const CHROME_TIMEOUT_MS = 30_000;
const PROFILE_PREFIX = "jh-chrome-";

/** Candidate Chrome/Chromium/Edge executables for this platform, in priority order. */
export function chromeCandidates(
	env: NodeJS.ProcessEnv = process.env,
	platform: NodeJS.Platform = process.platform,
): string[] {
	const out: string[] = [];
	if (env.CHROME_PATH) out.push(env.CHROME_PATH);
	if (platform === "win32") {
		const rel = ["Google", "Chrome", "Application", "chrome.exe"];
		for (const base of [
			env.ProgramFiles,
			env["ProgramFiles(x86)"],
			env.LOCALAPPDATA,
		]) {
			if (base) out.push(join(base, ...rel));
		}
		for (const base of [env["ProgramFiles(x86)"], env.ProgramFiles]) {
			if (base)
				out.push(join(base, "Microsoft", "Edge", "Application", "msedge.exe"));
		}
	} else if (platform === "darwin") {
		out.push(
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		);
	} else {
		out.push(
			"/usr/bin/google-chrome",
			"/usr/bin/google-chrome-stable",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/snap/bin/chromium",
			"/usr/bin/microsoft-edge",
		);
	}
	return out;
}

/** First existing Chrome-family executable, or null. CHROME_PATH wins when it exists. */
export function findChrome(): string | null {
	for (const p of chromeCandidates()) {
		if (existsSync(p)) return p;
	}
	return null;
}

/** A fresh, throwaway profile so the user's real ("Staffing") profile is never touched. */
export function makeThrowawayProfile(): string {
	return mkdtempSync(join(tmpdir(), PROFILE_PREFIX));
}

const BASE_ARGS = [
	"--headless=new",
	"--disable-gpu",
	"--no-first-run",
	"--no-default-browser-check",
	"--disable-extensions",
	"--disable-sync",
	"--disable-background-networking",
	"--disable-component-update",
	"--disable-default-apps",
	"--mute-audio",
	"--hide-scrollbars",
] as const;

export function printToPdfArgs(
	profileDir: string,
	pageUrl: string,
	outPdf: string,
): string[] {
	return [
		...BASE_ARGS,
		`--user-data-dir=${profileDir}`,
		"--no-pdf-header-footer",
		"--print-to-pdf-no-header",
		`--print-to-pdf=${outPdf}`,
		pageUrl,
	];
}

export function dumpDomArgs(profileDir: string, pageUrl: string): string[] {
	return [
		...BASE_ARGS,
		`--user-data-dir=${profileDir}`,
		"--virtual-time-budget=2000",
		"--dump-dom",
		pageUrl,
	];
}

let lastArgs: readonly string[] = [];

/** Arguments of the most recent Chrome launch (diagnostics and tests). */
export function lastChromeArgs(): readonly string[] {
	return lastArgs;
}

export interface ChromeRun {
	code: number | null;
	stdout: string;
	stderr: string;
}

/**
 * Run Chrome once with a throwaway profile built by `buildArgs`, then delete
 * the profile. Rejects on spawn failure or timeout.
 */
export async function runChrome(
	buildArgs: (profileDir: string) => string[],
	timeoutMs = CHROME_TIMEOUT_MS,
): Promise<ChromeRun> {
	const exe = findChrome();
	if (!exe)
		throw new Error(
			"Chrome not found: install Google Chrome or set CHROME_PATH",
		);
	const profile = makeThrowawayProfile();
	const args = buildArgs(profile);
	lastArgs = Object.freeze([...args]);
	try {
		return await spawnWithTimeout(exe, args, timeoutMs);
	} finally {
		removeQuietly(profile);
	}
}

function spawnWithTimeout(
	exe: string,
	args: string[],
	timeoutMs: number,
): Promise<ChromeRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(exe, args, {
			windowsHide: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8").on("data", (d: string) => {
			stdout += d;
		});
		child.stderr.setEncoding("utf8").on("data", (d: string) => {
			stderr += d;
		});
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`Chrome timed out after ${timeoutMs}ms`));
		}, timeoutMs);
		child.on("error", (e) => {
			clearTimeout(timer);
			reject(e);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

export function removeQuietly(dir: string): void {
	try {
		rmSync(dir, {
			recursive: true,
			force: true,
			maxRetries: 5,
			retryDelay: 200,
		});
	} catch {
		// Chrome can hold profile files briefly on Windows; a leftover temp dir is harmless.
	}
}
