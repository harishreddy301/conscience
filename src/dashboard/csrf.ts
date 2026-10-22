/**
 * CSRF protection for the board's POST endpoints: a same-origin check plus a
 * double-submit token (HttpOnly SameSite=Strict cookie `jh_csrf`, echoed by
 * the page in the `X-CSRF-Token` header; the page learns it from GET /api/board).
 * Tokens are secrets: never log them.
 */
import { randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { readCookie, tokenMatches } from "./lan.js";

export const CSRF_COOKIE = "jh_csrf";
export const CSRF_HEADER = "x-csrf-token";
const CSRF_RE = /^[A-Za-z0-9_-]{32,64}$/;

function header(h: IncomingHttpHeaders, name: string): string | undefined {
	const v = h[name];
	return Array.isArray(v) ? v[0] : v;
}

/** The request's valid CSRF cookie, or null. */
export function csrfCookie(h: IncomingHttpHeaders): string | null {
	const c = readCookie(header(h, "cookie"), CSRF_COOKIE);
	return c && CSRF_RE.test(c) ? c : null;
}

/** Reuse the cookie's token or mint one; `setCookie` is set when a new cookie must be sent. */
export function issueCsrf(h: IncomingHttpHeaders): {
	token: string;
	setCookie?: string;
} {
	const existing = csrfCookie(h);
	if (existing) return { token: existing };
	const token = randomBytes(32).toString("base64url");
	return {
		token,
		setCookie: `${CSRF_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/`,
	};
}

/**
 * null when the request passes; otherwise a short reason code.
 * Same-origin: an Origin header must equal http://<Host>; without Origin,
 * Sec-Fetch-Site (if sent) must be same-origin. Token: header must equal cookie.
 */
export function csrfFailure(h: IncomingHttpHeaders): string | null {
	const host = header(h, "host");
	const origin = header(h, "origin");
	if (origin !== undefined) {
		if (!host || origin !== `http://${host}`) return "cross_origin";
	} else {
		const site = header(h, "sec-fetch-site");
		if (site !== undefined && site !== "same-origin") return "cross_origin";
	}
	const cookie = csrfCookie(h);
	const given = header(h, CSRF_HEADER);
	if (!cookie || !given || !tokenMatches(given, cookie)) return "csrf";
	return null;
}
