import {
	type Analysis,
	DEFAULTS,
	DIMENSIONS,
	type Dimension,
	type Pattern,
	strengthFor,
} from "./analyze.js";

const DIMENSION_LABEL: Record<Dimension, string> = {
	framing: "Headline framing",
	angle: "Draft angle",
	role_family: "Role family",
	source: "Application source",
	keyword: "JD keyword on the resume",
	bullet: "Master bullet used",
	phrasing: "Bullet phrasing",
	title_choice: "Title choice (posted family <- shown title)",
};

/** Section headings whose list items are exempt from the citation rule. */
const EXEMPT_SECTION = /how to read|not enough data|notes|method|exploration/i;
const CITATION = /\bn\s*=\s*(\d+)\b[^)\n]*?\b(weak|moderate)\b/i;

function pct(x: number | null): string {
	return x === null ? "n/a" : `${Math.round(x * 100)}%`;
}

function advice(p: Pattern): string {
	const label = DIMENSION_LABEL[p.dimension];
	const verb = p.direction === "working" ? "Favour" : "Avoid or rework";
	return `${verb} ${label.toLowerCase()} **${p.value}**: ${p.positives}/${p.n} callbacks (${pct(p.rate)}, lift ${p.lift ?? "n/a"}x; n=${p.n}, ${p.strength}).`;
}

function header(a: Analysis): string[] {
	const t = a.totals;
	return [
		"# Resume playbook",
		"",
		`Generated ${a.generated_at.slice(0, 10)} from ${t.submitted} submitted applications: ${t.positive} callbacks, ${t.negative} rejections, ${t.ghosted} ghosted, ${t.pending} still pending.`,
		`Baseline callback rate: ${pct(a.baseline.rate)} (n=${t.resolved}, ${strengthFor(t.resolved)}).`,
		"",
		"## How to read this",
		"",
		`- A callback is an assessment, interview or offer. Ghosted means ${a.params.ghost_days}+ days with no reply.`,
		`- Patterns with fewer than ${a.params.min_n} resolved applications are never shown. **weak** means n < ${a.params.moderate_n}; **moderate** means n >= ${a.params.moderate_n}.`,
		"- These are correlations, not guarantees. Never trade truthfulness for a pattern: only fact metrics and master bullets are allowed.",
		"",
	];
}

function section(title: string, items: string[], empty: string): string[] {
	return [`## ${title}`, "", ...(items.length ? items : [`_${empty}_`]), ""];
}

function explorationLines(a: Analysis): string[] {
	const e = a.exploration;
	const lines = [
		`- Exploration ratio: about ${pct(e.ratio)} of applications use a non-best angle so the playbook keeps learning.`,
	];
	const best = a.features.angle.find((s) => s.value === e.best_angle);
	if (best) {
		lines.push(
			`- Current best angle **${best.value}**: ${best.positives}/${best.n} callbacks (${pct(best.rate)}; n=${best.n}, ${best.strength}). Explore: ${e.explore_angles.join(", ")}.`,
		);
	}
	lines.push(`- Rule: ${e.rule}`);
	return lines;
}

function gapLines(a: Analysis): string[] {
	return DIMENSIONS.filter((d) => a.features[d].length === 0).map(
		(d) =>
			`- ${DIMENSION_LABEL[d]}: no value has n >= ${a.params.min_n} resolved applications yet.`,
	);
}

/** Deterministic baseline playbook. The outcome-analyst agent rewrites it in plain language. */
export function renderPlaybook(a: Analysis): string {
	const working = a.patterns
		.filter((p) => p.direction === "working")
		.slice(0, 10)
		.map((p) => `- ${advice(p)}`);
	const notWorking = a.patterns
		.filter((p) => p.direction === "not_working")
		.slice(0, 10)
		.map((p) => `- ${advice(p)}`);
	const lines = [
		...header(a),
		...section("What's working", working, "No pattern beats the baseline yet."),
		...section(
			"What's not working",
			notWorking,
			"No pattern underperforms the baseline yet.",
		),
		...section("Angle mix (exploration)", explorationLines(a), ""),
		...section("Not enough data yet", gapLines(a), "Every dimension has data."),
	];
	return `${lines.join("\n").trimEnd()}\n`;
}

export interface PlaybookIssue {
	line: number;
	message: string;
}

/**
 * Check that every claim (list item outside exempt sections) cites `n=<k>` and a strength,
 * that k >= min n, and that the strength matches k.
 */
export function lintPlaybook(md: string): {
	ok: boolean;
	issues: PlaybookIssue[];
} {
	const issues: PlaybookIssue[] = [];
	let exempt = false;
	md.split(/\r?\n/).forEach((raw, i) => {
		const line = raw.trim();
		const heading = /^#{1,6}\s+(.*)$/.exec(line);
		if (heading) {
			exempt = EXEMPT_SECTION.test(heading[1] ?? "");
			return;
		}
		if (exempt || !/^([-*+]|\d+\.)\s+/.test(line)) return;
		if (/^([-*+]|\d+\.)\s+rule:/i.test(line)) return;
		const m = CITATION.exec(line);
		if (!m) {
			issues.push({
				line: i + 1,
				message: "claim does not cite n=<count> and weak|moderate",
			});
			return;
		}
		const n = Number(m[1]);
		const strength = (m[2] ?? "").toLowerCase();
		if (n < DEFAULTS.minN) {
			issues.push({
				line: i + 1,
				message: `claim cites n=${n}, below the minimum of ${DEFAULTS.minN}`,
			});
		} else if (strength !== strengthFor(n)) {
			issues.push({
				line: i + 1,
				message: `n=${n} must be labelled ${strengthFor(n)}, not ${strength}`,
			});
		}
	});
	if (!/^#\s+\S/m.test(md)) {
		issues.push({ line: 1, message: "playbook needs a top-level # title" });
	}
	return { ok: issues.length === 0, issues };
}
