/**
 * Opt-in LAN (Wi-Fi) mode helpers: private IPv4 detection, the persisted access
 * token, and constant-time token checks. The token is a secret: never log it.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { ensureDir, jhHome } from "../core/paths.js";

export const TOKEN_FILE = "dashboard-token";
export const TOKEN_COOKIE = "jh_token";
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

export interface LanOptions {
	/** Access token required from non-loopback clients. */
	token: string;
	/** Reject non-GET/HEAD requests from non-loopback clients with 403. */
	readOnly?: boolean;
	/** Private IPv4 addresses added to the Host allow-list. */
	ips: string[];
}

type Interfaces = ReturnType<typeof networkInterfaces>;

/** True for 10/8, 172.16/12 and 192.168/16. */
export function isPrivateIPv4(ip: string): boolean {
	const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
	if (!m) return false;
	const [a, b] = [Number(m[1]), Number(m[2])];
	if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
	return (
		a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
	);
}

/** Non-internal private IPv4 addresses of this machine (deduplicated, sorted). */
export function privateIPv4s(
	ifaces: Interfaces = networkInterfaces(),
): string[] {
	const out = new Set<string>();
	for (const list of Object.values(ifaces)) {
		for (const a of list ?? []) {
			const v4 = a.family === "IPv4" || (a.family as unknown) === 4;
			if (v4 && !a.internal && isPrivateIPv4(a.address)) out.add(a.address);
		}
	}
	return [...out].sort();
}

export function isLoopback(addr: string | undefined): boolean {
	if (!addr) return false;
	const a = addr.toLowerCase();
	return a === "::1" || a.startsWith("127.") || a.startsWith("::ffff:127.");
}

export function tokenPath(home: string = jhHome()): string {
	return join(home, TOKEN_FILE);
}

export function generateToken(): string {
	return randomBytes(32).toString("base64url");
}

function writeToken(path: string, token: string): void {
	writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
	try {
		chmodSync(path, 0o600);
	} catch {
		// Not supported everywhere (e.g. some Windows filesystems).
	}
}

/** Read the persisted token, creating it (0600) when missing or malformed. */
export function loadOrCreateToken(home: string = jhHome()): string {
	ensureDir(home);
	const path = tokenPath(home);
	if (existsSync(path)) {
		const t = readFileSync(path, "utf8").trim();
		if (TOKEN_RE.test(t)) return t;
	}
	const t = generateToken();
	writeToken(path, t);
	return t;
}

/** Replace the persisted token with a fresh one. */
export function rotateToken(home: string = jhHome()): string {
	ensureDir(home);
	const t = generateToken();
	writeToken(tokenPath(home), t);
	return t;
}

/** Constant-time comparison (hashing first makes lengths equal). */
export function tokenMatches(
	given: string | null | undefined,
	expected: string,
): boolean {
	if (!given) return false;
	const a = createHash("sha256").update(given).digest();
	const b = createHash("sha256").update(expected).digest();
	return timingSafeEqual(a, b);
}

export function readCookie(
	header: string | undefined,
	name: string,
): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const i = part.indexOf("=");
		if (i < 0) continue;
		if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
	}
	return null;
}
