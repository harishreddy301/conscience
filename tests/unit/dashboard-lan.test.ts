import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lanBanner } from "../../src/commands/dashboard.js";
import {
	isLoopback,
	isPrivateIPv4,
	loadOrCreateToken,
	privateIPv4s,
	rotateToken,
	TOKEN_COOKIE,
	tokenMatches,
	tokenPath,
} from "../../src/dashboard/lan.js";
import {
	createServer,
	listening,
	type ServerOptions,
} from "../../src/dashboard/server.js";
import { type Db, openDb } from "../../src/db/index.js";

const TOKEN = "A".repeat(43);
const LAN_IP = "192.168.1.50";

interface Res {
	status: number;
	headers: http.IncomingHttpHeaders;
	body: string;
}

let home: string;
let db: Db;
let server: http.Server | undefined;
let port: number;
/** Simulated remote address seen by the server (DI). */
let remote: string;

function request(
	method: string,
	path: string,
	headers: Record<string, string> = {},
	body?: string,
): Promise<Res> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				method,
				path,
				headers: { Host: `${LAN_IP}:${port}`, ...headers },
			},
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (c: Buffer) => chunks.push(c));
				res.on("end", () =>
					resolve({
						status: res.statusCode ?? 0,
						headers: res.headers,
						body: Buffer.concat(chunks).toString("utf8"),
					}),
				);
			},
		);
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

async function start(o: Partial<ServerOptions> = {}): Promise<void> {
	// Tests bind loopback even in LAN mode (no firewall prompt) and inject the
	// remote address instead.
	server = createServer(db, {
		port: 0,
		host: "127.0.0.1",
		remoteAddress: () => remote,
		...o,
	});
	port = await listening(server);
}

const lan = (readOnly = false): Partial<ServerOptions> => ({
	lan: { token: TOKEN, ips: [LAN_IP], readOnly },
});

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jh-lan-"));
	process.env.JOB_HUNTER_HOME = home;
	process.env.JOB_HUNTER_ME = join(home, "missing-me");
	db = openDb(":memory:");
	remote = "192.168.1.77";
});
afterEach(async () => {
	const s = server;
	server = undefined;
	if (s) await new Promise<void>((r) => s.close(() => r()));
	db.close();
	rmSync(home, { recursive: true, force: true });
	delete process.env.JOB_HUNTER_HOME;
	delete process.env.JOB_HUNTER_ME;
});

describe("default mode", () => {
	it("binds 127.0.0.1 only and rejects a private-IP Host", async () => {
		server = createServer(db, { port: 0 });
		port = await listening(server);
		expect((server.address() as AddressInfo).address).toBe("127.0.0.1");
		const r = await request("GET", "/healthz");
		expect(r.status).toBe(421);
		const ok = await request("GET", "/healthz", {
			Host: `127.0.0.1:${port}`,
		});
		expect(ok.status).toBe(200);
	});

	it("loopback requests never need a token in default mode", async () => {
		server = createServer(db, { port: 0, remoteAddress: () => "10.0.0.9" });
		port = await listening(server);
		// No LAN options: no token gate at all (the socket is loopback-only).
		const r = await request("GET", "/api/summary", {
			Host: `localhost:${port}`,
		});
		expect(r.status).toBe(200);
	});
});

describe("LAN mode", () => {
	it("allows a private-IP Host but still rejects unknown hosts", async () => {
		await start(lan());
		remote = "127.0.0.1";
		expect((await request("GET", "/healthz")).status).toBe(200);
		expect(
			(await request("GET", "/healthz", { Host: "evil.example" })).status,
		).toBe(421);
		expect(
			(await request("GET", "/healthz", { Host: `10.9.9.9:${port}` })).status,
		).toBe(421);
	});

	it("a remote request without the token gets 401", async () => {
		await start(lan());
		const r = await request("GET", "/api/summary");
		expect(r.status).toBe(401);
		expect(r.body).toMatch(/open the link printed in the terminal/i);
		expect(r.body).not.toContain(TOKEN);
		expect(r.headers["x-frame-options"]).toBe("DENY");
		expect(r.headers["referrer-policy"]).toBe("no-referrer");
	});

	it("a bad token gets 401 (query or cookie)", async () => {
		await start(lan());
		expect((await request("GET", "/?token=nope")).status).toBe(401);
		expect((await request("GET", `/?token=${"B".repeat(43)}`)).status).toBe(
			401,
		);
		expect(
			(
				await request("GET", "/api/summary", {
					Cookie: `${TOKEN_COOKIE}=wrong`,
				})
			).status,
		).toBe(401);
	});

	it("?token= sets an HttpOnly SameSite=Lax cookie and strips the query; the cookie then gets 200", async () => {
		await start(lan());
		const r = await request("GET", `/api/summary?token=${TOKEN}&x=1`);
		expect(r.status).toBe(303);
		expect(r.headers.location).toBe("/api/summary?x=1");
		const cookie = String(r.headers["set-cookie"]?.[0] ?? "");
		expect(cookie).toContain(`${TOKEN_COOKIE}=${TOKEN}`);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Lax");
		const ok = await request("GET", "/api/summary", {
			Cookie: `other=1; ${TOKEN_COOKIE}=${TOKEN}`,
		});
		expect(ok.status).toBe(200);
		expect(ok.headers["cache-control"]).toBe("no-store");
		expect(ok.headers["x-content-type-options"]).toBe("nosniff");
	});

	it("loopback works without a token", async () => {
		await start(lan());
		for (const addr of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
			remote = addr;
			expect((await request("GET", "/api/summary")).status).toBe(200);
		}
	});

	it("read-only blocks POST from remote but not from loopback", async () => {
		await start(lan(true));
		const headers = {
			Cookie: `${TOKEN_COOKIE}=${TOKEN}`,
			"Content-Type": "application/json",
			"X-JH": "1",
		};
		const r = await request("POST", "/api/study/clock-in", headers, "{}");
		expect(r.status).toBe(403);
		expect(JSON.parse(r.body)).toMatchObject({ error: "read_only" });
		expect(
			(await request("GET", "/api/summary", { Cookie: headers.Cookie })).status,
		).toBe(200);
		remote = "127.0.0.1";
		const local = await request("POST", "/api/study/clock-in", headers, "{}");
		expect(local.status).toBe(201);
	});

	it("without read-only, an authenticated remote POST works", async () => {
		await start(lan());
		const r = await request(
			"POST",
			"/api/study/clock-in",
			{
				Cookie: `${TOKEN_COOKIE}=${TOKEN}`,
				"Content-Type": "application/json",
				"X-JH": "1",
			},
			"{}",
		);
		expect(r.status).toBe(201);
	});
});

describe("LAN helpers", () => {
	it("detects private non-internal IPv4 addresses only", () => {
		const ifaces = {
			wifi: [
				{ address: "192.168.1.50", family: "IPv4", internal: false },
				{ address: "fe80::1", family: "IPv6", internal: false },
			],
			lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
			vpn: [
				{ address: "10.0.0.5", family: "IPv4", internal: false },
				{ address: "172.20.1.1", family: "IPv4", internal: false },
				{ address: "172.32.1.1", family: "IPv4", internal: false },
				{ address: "8.8.8.8", family: "IPv4", internal: false },
			],
		} as unknown as Parameters<typeof privateIPv4s>[0];
		expect(privateIPv4s(ifaces)).toEqual([
			"10.0.0.5",
			"172.20.1.1",
			"192.168.1.50",
		]);
		expect(isPrivateIPv4("192.169.0.1")).toBe(false);
		expect(isLoopback("192.168.1.2")).toBe(false);
		expect(isLoopback(undefined)).toBe(false);
	});

	it("compares tokens in constant time without throwing on length mismatch", () => {
		expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
		expect(tokenMatches("short", TOKEN)).toBe(false);
		expect(tokenMatches(null, TOKEN)).toBe(false);
	});

	it("persists the token, reuses it, and rotate changes it", () => {
		const a = loadOrCreateToken(home);
		expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
		expect(readFileSync(tokenPath(home), "utf8").trim()).toBe(a);
		if (process.platform !== "win32")
			expect(statSync(tokenPath(home)).mode & 0o777).toBe(0o600);
		expect(loadOrCreateToken(home)).toBe(a);
		const b = rotateToken(home);
		expect(b).not.toBe(a);
		expect(loadOrCreateToken(home)).toBe(b);
	});

	it("the startup banner prints one link per IP plus the warnings", () => {
		const out = lanBanner(["192.168.1.50", "10.0.0.5"], 4777, TOKEN, true);
		expect(out).toContain(
			`Open on your phone (same Wi-Fi): http://192.168.1.50:4777/?token=${TOKEN}`,
		);
		expect(out).toContain(
			`Open on your phone (same Wi-Fi): http://10.0.0.5:4777/?token=${TOKEN}`,
		);
		expect(out).toMatch(/anyone with this link/i);
		expect(out).toMatch(/PRIVATE networks only/);
	});
});
