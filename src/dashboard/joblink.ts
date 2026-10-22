/**
 * "Add a job link": URL validation and optional, SSRF-safe enrichment from the
 * public Greenhouse / Ashby / Lever JSON APIs.
 *
 * SSRF rules: we never fetch the user's URL. We only build API URLs for a
 * fixed set of https hosts from validated path segments, refuse redirects,
 * refuse hosts that resolve to private/loopback/link-local addresses, time out
 * after 5 s and cap the response size. All fetched text is untrusted data.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { z } from "zod";

export const MAX_URL_LENGTH = 2048;
export const ENRICH_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 3_000_000;
const SLUG = /^[A-Za-z0-9][\w.-]{0,99}$/;
const UUIDISH = /^[A-Za-z0-9-]{6,64}$/;

/** The only hosts enrichment will ever contact. */
export const ENRICH_HOSTS: ReadonlySet<string> = new Set([
	"boards-api.greenhouse.io",
	"api.lever.co",
	"api.eu.lever.co",
	"api.ashbyhq.com",
]);

export const AddLinkBody = z.object({
	url: z.string().trim().min(1).max(MAX_URL_LENGTH),
	note: z.string().trim().max(500).optional(),
});
export type AddLinkBody = z.infer<typeof AddLinkBody>;

export class LinkError extends Error {
	constructor(
		public code: string,
		message: string,
	) {
		super(message);
	}
}

/** Parse and validate a pasted job URL: http(s) only, <= 2048 chars, no credentials. */
export function validateJobUrl(raw: string): URL {
	const s = raw.trim();
	if (!s) throw new LinkError("invalid_url", "URL is empty");
	if (s.length > MAX_URL_LENGTH)
		throw new LinkError("invalid_url", `URL is longer than ${MAX_URL_LENGTH}`);
	let u: URL;
	try {
		u = new URL(s);
	} catch {
		throw new LinkError("invalid_url", "not a valid URL");
	}
	if (u.protocol !== "http:" && u.protocol !== "https:")
		throw new LinkError("invalid_url", "only http and https links are allowed");
	if (u.username || u.password)
		throw new LinkError(
			"invalid_url",
			"links with credentials are not allowed",
		);
	if (!u.hostname) throw new LinkError("invalid_url", "URL has no host");
	u.hash = "";
	return u;
}

// ------------------------------------------------------------ private addresses

function v4Private(ip: string): boolean {
	const p = ip.split(".").map(Number);
	const [a, b] = [p[0] ?? 0, p[1] ?? 0];
	return (
		a === 0 ||
		a === 10 ||
		a === 127 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 198 && (b === 18 || b === 19)) ||
		a >= 224
	);
}

/** True for loopback, private, link-local, CGNAT, multicast and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
	const kind = isIP(ip);
	if (kind === 4) return v4Private(ip);
	if (kind !== 6) return true;
	const a = ip.toLowerCase();
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(a);
	if (mapped?.[1]) return v4Private(mapped[1]);
	return (
		a === "::" ||
		a === "::1" ||
		a.startsWith("fc") ||
		a.startsWith("fd") ||
		a.startsWith("fe8") ||
		a.startsWith("fe9") ||
		a.startsWith("fea") ||
		a.startsWith("feb") ||
		a.startsWith("ff")
	);
}

// ------------------------------------------------------------ ATS detection

export interface AtsTarget {
	ats: "greenhouse" | "lever" | "ashby";
	tenant: string;
	jobId: string;
	/** The public API URL we would fetch (always https on ENRICH_HOSTS). */
	api: string;
}

function segs(u: URL): string[] {
	return u.pathname.split("/").filter(Boolean).map(decodeSafe);
}

function decodeSafe(s: string): string {
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** Recognize a Greenhouse / Lever / Ashby posting URL. Only https links qualify. */
export function detectAtsTarget(u: URL): AtsTarget | null {
	if (u.protocol !== "https:") return null;
	const host = u.hostname.toLowerCase();
	const p = segs(u);
	if (/^(boards|job-boards)(\.eu)?\.greenhouse\.io$/.test(host)) {
		const tenant = p[0];
		const i = p.indexOf("jobs");
		const jobId =
			i > 0 ? p[i + 1] : (u.searchParams.get("gh_jid") ?? undefined);
		if (tenant && jobId && SLUG.test(tenant) && /^\d{1,20}$/.test(jobId))
			return {
				ats: "greenhouse",
				tenant,
				jobId,
				api: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(tenant)}/jobs/${jobId}`,
			};
		return null;
	}
	const lever = /^jobs(\.eu)?\.lever\.co$/.exec(host);
	if (lever) {
		const [tenant, jobId] = p;
		if (tenant && jobId && SLUG.test(tenant) && UUIDISH.test(jobId))
			return {
				ats: "lever",
				tenant,
				jobId,
				api: `https://api${lever[1] ? ".eu" : ""}.lever.co/v0/postings/${encodeURIComponent(tenant)}/${jobId}`,
			};
		return null;
	}
	if (host === "jobs.ashbyhq.com") {
		const [tenant, jobId] = p;
		if (tenant && jobId && SLUG.test(tenant) && UUIDISH.test(jobId))
			return {
				ats: "ashby",
				tenant,
				jobId,
				api: `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(tenant)}`,
			};
	}
	return null;
}

// ------------------------------------------------------------ enrichment

export interface Enriched {
	title?: string;
	company?: string;
	location?: string;
	posted_at?: string;
}

export interface EnrichDeps {
	fetch?: typeof fetch;
	lookup?: (host: string) => Promise<string[]>;
	timeoutMs?: number;
}

const defaultLookup = async (host: string): Promise<string[]> =>
	(await dnsLookup(host, { all: true })).map((a) => a.address);

/** Strip control characters, collapse whitespace, cap length. Untrusted text. */
export function cleanText(v: unknown, max = 200): string | undefined {
	if (typeof v !== "string") return undefined;
	const s = v
		.replace(/\p{Cc}+/gu, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, max);
	return s || undefined;
}

function isoOrUndef(v: unknown): string | undefined {
	if (typeof v !== "string" && typeof v !== "number") return undefined;
	const t = typeof v === "number" ? v : Date.parse(v);
	return Number.isFinite(t) && t > 0 ? new Date(t).toISOString() : undefined;
}

/** "acme-corp" -> "Acme Corp". */
export function humanizeSlug(slug: string): string {
	return slug
		.split(/[-_.]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ");
}

async function readCapped(res: Response): Promise<unknown> {
	const declared = Number(res.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES)
		throw new Error("response too large");
	if (!res.body) return null;
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_RESPONSE_BYTES) {
			await reader.cancel();
			throw new Error("response too large");
		}
		chunks.push(value);
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Fetch JSON from an allow-listed https API host, refusing redirects and private addresses. */
export async function safeFetchJson(
	apiUrl: string,
	deps: EnrichDeps = {},
): Promise<unknown> {
	const u = new URL(apiUrl);
	if (u.protocol !== "https:" || !ENRICH_HOSTS.has(u.hostname))
		throw new Error("host not allowed");
	const addrs = await (deps.lookup ?? defaultLookup)(u.hostname);
	if (!addrs.length || addrs.some(isPrivateAddress))
		throw new Error("host resolves to a private address");
	const res = await (deps.fetch ?? fetch)(u.toString(), {
		redirect: "error",
		headers: { Accept: "application/json" },
		signal: AbortSignal.timeout(deps.timeoutMs ?? ENRICH_TIMEOUT_MS),
	});
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	return readCapped(res);
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
	v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};

function fromGreenhouse(j: Obj, t: AtsTarget): Enriched {
	return {
		title: cleanText(j.title),
		company: cleanText(j.company_name) ?? humanizeSlug(t.tenant),
		location: cleanText(obj(j.location).name),
		posted_at: isoOrUndef(j.first_published) ?? isoOrUndef(j.updated_at),
	};
}

function fromLever(j: Obj, t: AtsTarget): Enriched {
	return {
		title: cleanText(j.text),
		company: humanizeSlug(t.tenant),
		location: cleanText(obj(j.categories).location),
		posted_at: isoOrUndef(j.createdAt),
	};
}

function fromAshby(j: Obj, t: AtsTarget): Enriched {
	const jobs = Array.isArray(j.jobs) ? j.jobs.map(obj) : [];
	const hit = jobs.find((x) => x.id === t.jobId);
	if (!hit) return { company: humanizeSlug(t.tenant) };
	return {
		title: cleanText(hit.title),
		company: humanizeSlug(t.tenant),
		location: cleanText(hit.location),
		posted_at: isoOrUndef(hit.publishedAt),
	};
}

/**
 * Best-effort title/company/location/posted date. Never throws: any failure
 * (unknown host, timeout, redirect, private address, bad JSON) returns {}.
 */
export async function enrichJobLink(
	u: URL,
	deps: EnrichDeps = {},
): Promise<Enriched & { ats?: AtsTarget["ats"]; tenant?: string }> {
	const t = detectAtsTarget(u);
	if (!t) return {};
	try {
		const j = obj(await safeFetchJson(t.api, deps));
		const e =
			t.ats === "greenhouse"
				? fromGreenhouse(j, t)
				: t.ats === "lever"
					? fromLever(j, t)
					: fromAshby(j, t);
		return { ...e, ats: t.ats, tenant: t.tenant };
	} catch {
		return { company: humanizeSlug(t.tenant), ats: t.ats, tenant: t.tenant };
	}
}

/** Company name from the hostname: "careers.acme.com" -> "acme.com". */
export function companyFromHost(u: URL): string {
	const host = u.hostname.toLowerCase().replace(/^www\./, "");
	if (isIP(host) || isIP(host.replace(/^\[|\]$/g, ""))) return host;
	const parts = host.split(".");
	return parts.length > 2 ? parts.slice(-2).join(".") : host;
}

/** A readable title from the URL's last word-like path segment, if any. */
export function titleFromPath(u: URL): string | undefined {
	const p = segs(u).reverse();
	for (const s of p) {
		const words = s
			.replace(/\.[a-z]{2,5}$/i, "")
			.split(/[-_+\s]+/)
			.filter((w) => /^[A-Za-z][A-Za-z.&]*$/.test(w));
		if (words.length >= 2 && words.join("").length >= 6)
			return cleanText(humanizeSlug(words.join("-")), 120);
	}
	return undefined;
}
