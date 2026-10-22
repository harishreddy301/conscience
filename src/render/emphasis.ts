/** A run of text, bold or not. */
export interface Segment {
	text: string;
	bold: boolean;
}

/** Where emphasis phrases land in a text, plus the ones that could not be placed. */
export interface EmphasisLayout {
	/** Bold [start, end) offsets, sorted, non-overlapping. */
	spans: [number, number][];
	/** Phrases that do not occur in the text. */
	missing: string[];
	/** Phrases whose first occurrence overlaps an earlier phrase. */
	overlapping: string[];
}

/**
 * Place each emphasis phrase at its first occurrence in `text`. Missing
 * phrases and phrases that overlap an earlier match are reported, not placed,
 * so the plain text always reads exactly as `text`. Shared by every renderer
 * and the validator so what is checked is what is shown.
 */
export function locateEmphasis(
	text: string,
	phrases: readonly string[] = [],
): EmphasisLayout {
	const spans: [number, number][] = [];
	const missing: string[] = [];
	const overlapping: string[] = [];
	for (const p of phrases) {
		if (!p) continue;
		const at = text.indexOf(p);
		if (at < 0) {
			missing.push(p);
			continue;
		}
		const end = at + p.length;
		if (spans.some(([s, e]) => at < e && end > s)) {
			overlapping.push(p);
			continue;
		}
		spans.push([at, end]);
	}
	spans.sort((a, b) => a[0] - b[0]);
	return { spans, missing, overlapping };
}

/**
 * Split `text` into runs, marking the first occurrence of each emphasis
 * phrase as bold. Phrases that are missing or overlap an earlier match are
 * ignored, so the plain text always reads exactly as `text`.
 */
export function splitEmphasis(
	text: string,
	phrases: readonly string[] = [],
): Segment[] {
	const { spans } = locateEmphasis(text, phrases);
	const out: Segment[] = [];
	let pos = 0;
	for (const [s, e] of spans) {
		if (s > pos) out.push({ text: text.slice(pos, s), bold: false });
		out.push({ text: text.slice(s, e), bold: true });
		pos = e;
	}
	if (pos < text.length) out.push({ text: text.slice(pos), bold: false });
	return out;
}

/** Plain text of a run list (the markup stripped). */
export function stripEmphasis(segments: readonly Segment[]): string {
	return segments.map((s) => s.text).join("");
}
