/**
 * Local dashboard HTTP server (node:http). Binds 127.0.0.1 by default.
 * Security: Host allow-list (421), POST needs JSON + `X-JH: 1` (403), 4 KB bodies, strict CSP.
 * Opt-in LAN mode (`lan`): binds 0.0.0.0, allows the machine's private IPs as
 * Host, and requires the access token from non-loopback clients (401), with an
 * optional read-only mode for them (403 on anything but GET/HEAD).
 */
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ZodError } from "zod";
import {
	ConflictError,
	IllegalTransitionError,
	JhError,
	NotFoundError,
	ValidationError,
} from "../core/errors.js";
import { repoRoot } from "../core/paths.js";
import type { Db } from "../db/index.js";
import type { LearnSummary } from "../learn/index.js";
import { type ApiResponse, matchRoute } from "./api.js";
import {
	isLoopback,
	type LanOptions,
	readCookie,
	TOKEN_COOKIE,
	tokenMatches,
} from "./lan.js";

export const MAX_BODY_BYTES = 4096;
export const CSP =
	"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export interface ServerOptions {
	port: number;
	/** Bind address. Default: 127.0.0.1, or 0.0.0.0 when `lan` is set. */
	host?: "127.0.0.1" | "0.0.0.0";
	/** Opt-in LAN mode (token auth for non-loopback clients). */
	lan?: LanOptions;
	/** Remote address of a request (injectable for tests). */
	remoteAddress?: (req: http.IncomingMessage) => string | undefined;
	uiDir?: string;
	learn?: (db: Db) => LearnSummary;
	now?: () => Date;
	log?: (line: string) => void;
}

const STATIC: Record<string, { file: string; type: string }> = {
	"/": { file: "index.html", type: "text/html; charset=utf-8" },
	"/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
	"/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
	"/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
	"/board.js": { file: "board.js", type: "text/javascript; charset=utf-8" },
	"/board.css": { file: "board.css", type: "text/css; charset=utf-8" },
};

/** dist/dashboard-ui (bundled) -> <repoRoot>/dashboard-ui -> ../../dashboard-ui from src. */
export function resolveUiDir(explicit?: string): string | null {
	const here = dirname(fileURLToPath(import.meta.url));
	const root = repoRoot();
	const candidates = [
		explicit,
		join(here, "dashboard-ui"),
		root ? join(root, "dashboard-ui") : undefined,
		join(here, "..", "..", "dashboard-ui"),
	];
	for (const c of candidates) {
		if (c && existsSync(join(c, "index.html"))) return c;
	}
	return null;
}

class HttpError extends Error {
	constructor(
		public status: number,
		public code: string,
		message: string,
	) {
		super(message);
	}
}

function statusForJhError(e: JhError): number {
	if (e instanceof ValidationError) return 400;
	if (e instanceof ConflictError) return 409;
	if (e instanceof IllegalTransitionError) return 409;
	if (e instanceof NotFoundError) return 404;
	return 500;
}

/** Map an error to {status, payload}. Conflict reasons surface as `error`. */
export function errorResponse(e: unknown): ApiResponse {
	if (e instanceof HttpError)
		return { status: e.status, json: { error: e.code, message: e.message } };
	if (e instanceof ZodError)
		return {
			status: 400,
			json: {
				error: "validation",
				message: "invalid request",
				details: e.issues,
			},
		};
	if (e instanceof JhError) {
		const status = statusForJhError(e);
		return {
			status,
			json: {
				error: e.code,
				message: status >= 500 ? "internal error" : e.message,
			},
		};
	}
	return {
		status: 500,
		json: { error: "internal", message: "internal error" },
	};
}

function securityHeaders(res: http.ServerResponse): void {
	res.setHeader("Content-Security-Policy", CSP);
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Referrer-Policy", "no-referrer");
	res.setHeader("X-Frame-Options", "DENY");
	res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
	res.setHeader("Cache-Control", "no-store");
}

function send(res: http.ServerResponse, r: ApiResponse): void {
	for (const [k, v] of Object.entries(r.headers ?? {})) res.setHeader(k, v);
	if (r.body !== undefined) {
		res.writeHead(r.status, {
			"Content-Type": r.contentType ?? "application/octet-stream",
		});
		res.end(r.body);
		return;
	}
	res.writeHead(r.status, {
		"Content-Type": "application/json; charset=utf-8",
	});
	res.end(JSON.stringify(r.json ?? null));
}

export function allowedHosts(
	port: number,
	lanIps: readonly string[] = [],
): Set<string> {
	return new Set([
		`127.0.0.1:${port}`,
		`localhost:${port}`,
		...lanIps.map((ip) => `${ip}:${port}`),
	]);
}

/** Cookie lifetime for a LAN client that presented the token (30 days). */
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;

const UNAUTHORIZED_PAGE =
	'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>conscience</title><p>Not authorized. Open the link printed in the terminal.</p>';

/**
 * LAN-mode gate for non-loopback clients. Returns a response to send instead of
 * routing, or null to continue. Never logs or echoes the token.
 */
export function lanGate(
	req: http.IncomingMessage,
	lan: LanOptions,
	remote: string | undefined,
): ApiResponse | null {
	if (isLoopback(remote)) return null;
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const method = req.method ?? "GET";
	const queryToken = url.searchParams.get("token");
	const cookieToken = readCookie(req.headers.cookie, TOKEN_COOKIE);
	const viaQuery = queryToken !== null && tokenMatches(queryToken, lan.token);
	const viaCookie = queryToken === null && tokenMatches(cookieToken, lan.token);
	if (!viaQuery && !viaCookie)
		return {
			status: 401,
			body: UNAUTHORIZED_PAGE,
			contentType: "text/html; charset=utf-8",
		};
	if (lan.readOnly && method !== "GET" && method !== "HEAD")
		return {
			status: 403,
			json: { error: "read_only", message: "dashboard is read-only on LAN" },
		};
	if (viaQuery && (method === "GET" || method === "HEAD")) {
		// Trade the one-time ?token= for a cookie and strip it from the URL.
		url.searchParams.delete("token");
		const qs = url.searchParams.toString();
		return {
			status: 303,
			headers: {
				// Lax, not Strict: a link tapped in another app is a cross-site navigation, and a
				// Strict cookie would be dropped on the follow-up GET (401 on phones). POSTs stay
				// protected by the CSRF token and origin check.
				"Set-Cookie": `${TOKEN_COOKIE}=${lan.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${COOKIE_MAX_AGE}`,
				Location: `${url.pathname}${qs ? `?${qs}` : ""}`,
			},
			body: "",
			contentType: "text/plain; charset=utf-8",
		};
	}
	return null;
}

function checkPost(req: http.IncomingMessage): void {
	const type = String(req.headers["content-type"] ?? "").toLowerCase();
	if (!type.startsWith("application/json") || req.headers["x-jh"] !== "1")
		throw new HttpError(
			403,
			"forbidden",
			"POST requires Content-Type: application/json and X-JH: 1",
		);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const tooLarge = () =>
			new HttpError(413, "too_large", "request body over 4 KB");
		const declared = Number(req.headers["content-length"]);
		if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
			req.pause();
			reject(tooLarge());
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let done = false;
		const onData = (c: Buffer) => {
			size += c.length;
			if (size > MAX_BODY_BYTES) {
				// Stop reading now; the caller closes the connection after the 413.
				done = true;
				req.off("data", onData);
				req.pause();
				reject(tooLarge());
				return;
			}
			chunks.push(c);
		};
		req.on("data", onData);
		req.on("end", () => {
			if (done) return;
			done = true;
			const text = Buffer.concat(chunks).toString("utf8").trim();
			if (!text) return resolve({});
			try {
				resolve(JSON.parse(text));
			} catch {
				reject(new HttpError(400, "validation", "body is not valid JSON"));
			}
		});
		req.on("error", (e) => {
			if (done) return;
			done = true;
			reject(e);
		});
	});
}

function serveStatic(uiDir: string | null, path: string): ApiResponse | null {
	const entry = STATIC[path];
	if (!entry) return null;
	if (!uiDir)
		return {
			status: 503,
			body: "dashboard UI files not found (dashboard-ui/)",
			contentType: "text/plain; charset=utf-8",
		};
	return {
		status: 200,
		body: readFileSync(join(uiDir, entry.file)),
		contentType: entry.type,
	};
}

/** Remote (non-loopback LAN) client, and whether LAN read-only mode applies to it. */
function clientOf(
	req: http.IncomingMessage,
	o: ServerOptions,
): { remote: boolean; readOnly: boolean } {
	if (!o.lan) return { remote: false, readOnly: false };
	const addr = (o.remoteAddress ?? ((r) => r.socket.remoteAddress))(req);
	const remote = !isLoopback(addr);
	return { remote, readOnly: remote && Boolean(o.lan.readOnly) };
}

async function route(
	req: http.IncomingMessage,
	db: Db,
	o: ServerOptions,
	uiDir: string | null,
): Promise<ApiResponse> {
	const url = new URL(req.url ?? "/", "http://127.0.0.1");
	const method = req.method ?? "GET";
	if (method === "GET" && url.pathname === "/healthz")
		return { status: 200, json: { ok: true, pid: process.pid } };
	if (method === "GET") {
		const s = serveStatic(uiDir, url.pathname);
		if (s) return s;
	}
	const m = matchRoute(method, url.pathname);
	if (!m) throw new HttpError(404, "not_found", "no such route");
	if ("methodNotAllowed" in m)
		throw new HttpError(405, "method_not_allowed", "method not allowed");
	let body: unknown;
	if (method === "POST") {
		checkPost(req);
		body = await readBody(req);
	}
	return m.route.handler(
		{
			method,
			path: url.pathname,
			query: url.searchParams,
			params: m.params,
			body,
			headers: req.headers,
			client: clientOf(req, o),
		},
		{ db, learn: o.learn, now: o.now },
	);
}

function pathOnly(url: string | undefined): string {
	return (url ?? "/").split("?")[0] ?? "/";
}

function boundPort(server: http.Server): number {
	const a = server.address();
	return a && typeof a === "object" ? a.port : 0;
}

/** Create and start the dashboard server. Await `listening(server)` for the port. */
export function createServer(db: Db, o: ServerOptions): http.Server {
	const uiDir = resolveUiDir(o.uiDir);
	const log = o.log ?? (() => {});
	const remoteOf =
		o.remoteAddress ??
		((req: http.IncomingMessage) => req.socket.remoteAddress);
	const server = http.createServer((req, res) => {
		securityHeaders(res);
		const host = String(req.headers.host ?? "").toLowerCase();
		if (!allowedHosts(boundPort(server), o.lan?.ips).has(host)) {
			send(res, {
				status: 421,
				json: { error: "misdirected", message: "bad Host" },
			});
			return;
		}
		if (o.lan) {
			const gate = lanGate(req, o.lan, remoteOf(req));
			if (gate) {
				send(res, gate);
				return;
			}
		}
		route(req, db, o, uiDir)
			.then((r) => send(res, r))
			.catch((e: unknown) => {
				const r = errorResponse(e);
				// Method and path only: never log query strings or bodies.
				if (r.status >= 500)
					log(
						`error ${req.method} ${pathOnly(req.url)}: ${(e as Error)?.message ?? e}`,
					);
				if (r.status === 413) {
					// Do not drain an oversized body: close once the 413 is out.
					res.setHeader("Connection", "close");
					res.once("finish", () => req.destroy());
				}
				if (!res.headersSent) send(res, r);
			});
	});
	server.requestTimeout = 30_000;
	server.headersTimeout = 15_000;
	server.listen(o.port, o.host ?? (o.lan ? "0.0.0.0" : "127.0.0.1"));
	return server;
}

/** Resolves with the bound port once the server is listening. */
export function listening(server: http.Server): Promise<number> {
	if (server.listening) return Promise.resolve(boundPort(server));
	return new Promise((resolve, reject) => {
		server.once("listening", () => resolve(boundPort(server)));
		server.once("error", reject);
	});
}
