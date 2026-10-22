import { z } from "zod";

/** Keywords extracted from a job description by the ats-screener agent. */
export const KeywordTerm = z.object({
	term: z.string().min(1),
	aliases: z.array(z.string().min(1)).default([]),
	weight: z.number().min(1).max(3).default(1),
});

export const JdKeywords = z.object({
	required: z.array(KeywordTerm),
	preferred: z
		.array(
			z.object({
				term: z.string().min(1),
				aliases: z.array(z.string().min(1)).default([]),
				weight: z.number().default(1),
			}),
		)
		.default([]),
	titles: z.array(z.string()).default([]),
	knockouts: z
		.object({
			min_years: z.number().optional(),
			degree: z.string().optional(),
			work_auth: z.string().optional(),
			location: z.string().optional(),
			clearance: z.string().optional(),
		})
		.default({}),
});
export type JdKeywords = z.infer<typeof JdKeywords>;
export type KeywordTerm = { term: string; aliases: string[]; weight: number };

const SPECIAL_TOKENS: ReadonlyArray<[RegExp, string]> = [
	[/c\+\+/g, " cpp "],
	[/c#/g, " csharp "],
	[/f#/g, " fsharp "],
	[/(^|[^a-z0-9])\.net\b/g, "$1 dotnet "],
];

/** Naive English plural stem for one lowercase word. */
export function stemWord(w: string): string {
	if (w.length <= 3 || /\d/.test(w)) return w;
	if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
	if (/(ses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
	if (w.endsWith("s") && !/(ss|us|js)$/.test(w)) return w.slice(0, -1);
	return w;
}

/**
 * Normalize a term or a run of text for matching: lowercase, fold intra-word
 * punctuation (node.js = nodejs, ci/cd = cicd), keep c++/c#/.net distinct,
 * and stem plurals word by word.
 */
export function normTerm(s: string): string {
	let t = s.toLowerCase();
	for (const [re, rep] of SPECIAL_TOKENS) t = t.replace(re, rep);
	// Join words split by . - _ / when glued on both sides ("node.js", "ci/cd").
	t = t.replace(/([a-z0-9])[.\-_/]+(?=[a-z0-9])/g, "$1");
	t = t.replace(/[^a-z0-9]+/g, " ");
	return t.split(/\s+/).filter(Boolean).map(stemWord).join(" ");
}

/** Normalized token list of a text. */
export function tokens(text: string): string[] {
	const n = normTerm(text);
	return n ? n.split(" ") : [];
}

/**
 * True when `text` contains `title` as whole words after normTerm (case,
 * punctuation and dashes ignored). Shared by jd compare and /learn so the
 * dashboard and the learning feature never disagree.
 */
export function containsTitle(text: string, title: string): boolean {
	const t = normTerm(title);
	return t.length > 0 && ` ${normTerm(text)} `.includes(` ${t} `);
}

/** Start indexes of non-overlapping occurrences of `needle` in `hay`. */
export function findSeq(
	hay: readonly string[],
	needle: readonly string[],
): number[] {
	const hits: number[] = [];
	if (needle.length === 0) return hits;
	for (let i = 0; i + needle.length <= hay.length; ) {
		if (needle.every((w, j) => hay[i + j] === w)) {
			hits.push(i);
			i += needle.length;
		} else i++;
	}
	return hits;
}

/** All normalized spellings (term plus aliases) of a keyword, longest first. */
export function variants(k: { term: string; aliases?: string[] }): string[][] {
	const seen = new Set<string>();
	const out: string[][] = [];
	for (const raw of [k.term, ...(k.aliases ?? [])]) {
		const n = normTerm(raw);
		if (!n || seen.has(n)) continue;
		seen.add(n);
		out.push(n.split(" "));
	}
	return out.sort((a, b) => b.length - a.length);
}

/**
 * Occurrences of a keyword (any spelling) in pre-tokenized text. Longer
 * spellings claim their tokens first, so "react native" and "react" aliases
 * never count the same words twice.
 */
export function countKeyword(
	hay: readonly string[],
	k: { term: string; aliases?: string[] },
): number {
	const used = new Set<number>();
	let count = 0;
	for (const v of variants(k)) {
		for (const start of findSeq(hay, v)) {
			const span = v.map((_, j) => start + j);
			if (span.some((i) => used.has(i))) continue;
			for (const i of span) used.add(i);
			count++;
		}
	}
	return count;
}
