import { z } from "zod";
import { detectAts, type TenantRef } from "../adapters/detect.js";

// Raw HTTP instead of exa-js: the SDK pulls in node-fetch (CJS), which breaks the single-file ESM bundle.
const ExaSearchResponse = z.object({
	results: z
		.array(z.object({ url: z.string(), title: z.string().nullish() }))
		.nullish()
		.transform((r) => r ?? []),
});
const EXA_TIMEOUT_MS = 30_000;

export interface CareersDiscovery {
	company: string;
	boards: TenantRef[];
	/** Careers pages found that don't match a known ATS (candidates for Firecrawl or a new adapter). */
	otherPages: string[];
}

/**
 * Find where a company actually posts its jobs. Only result URLs are needed, so the request
 * carries no `contents` (metadata-only results, per the build-with-exa skill).
 */
export async function discoverCareers(
	company: string,
): Promise<CareersDiscovery> {
	const key = process.env.EXA_API_KEY;
	if (!key) throw new Error("EXA_API_KEY is not set in ~/.job-hunter/.env");
	const resp = await fetch("https://api.exa.ai/search", {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-api-key": key },
		body: JSON.stringify({
			query: `${company} careers job openings`,
			type: "auto",
		}),
		signal: AbortSignal.timeout(EXA_TIMEOUT_MS),
	});
	if (!resp.ok)
		throw new Error(
			`Exa search failed: HTTP ${resp.status} ${await resp.text()}`,
		);
	const parsed = ExaSearchResponse.safeParse(await resp.json());
	if (!parsed.success)
		throw new Error(
			`Exa search returned an unexpected response: ${parsed.error.message}`,
		);
	const res = parsed.data;

	const boards = new Map<string, TenantRef>();
	const otherPages: string[] = [];
	for (const r of res.results) {
		const ref = detectAts(r.url);
		if (ref) boards.set(`${ref.ats}:${ref.tenant}:${ref.site ?? ""}`, ref);
		else if (/career|job/i.test(r.url)) otherPages.push(r.url);
	}
	return { company, boards: [...boards.values()], otherPages };
}
