import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGENTS_DIR = join(ROOT, "agents");

/** Consolidated roster (plan.md + amendments 13, W7). Model per agent. */
const ROSTER: Readonly<Record<string, "opus" | "sonnet" | "haiku">> = {
	conscience: "opus",
	"resume-writer": "sonnet",
	"hiring-manager": "opus",
	"cover-letter-writer": "opus",
	"metric-miner": "opus",
	"ats-screener": "sonnet",
	"fact-checker": "sonnet",
	"application-submitter": "sonnet",
	"outreach-drafter": "sonnet",
	"resume-intake": "sonnet",
	"email-tracker": "sonnet",
	"interview-prep": "sonnet",
	"outcome-analyst": "sonnet",
	"recruiter-screen": "haiku",
	"resume-formatter": "haiku",
	"pipeline-clerk": "haiku",
	"calendar-sync": "haiku",
	"job-scout": "haiku",
};

/**
 * Agents whose connector tool names were not verified when the roster was
 * written (contract section 15): they may omit `tools` and inherit. When they
 * do declare it, it must still be a comma-separated string.
 */
const MAY_INHERIT_TOOLS: ReadonlySet<string> = new Set([
	"email-tracker",
	"calendar-sync",
]);

/** Agents that are owned by this workstream and must exist. */
const REQUIRED_AGENTS = [
	"resume-writer",
	"hiring-manager",
	"ats-screener",
	"recruiter-screen",
	"fact-checker",
	"resume-formatter",
	"cover-letter-writer",
	"conscience",
	"application-submitter",
	"pipeline-clerk",
	"outreach-drafter",
	"job-scout",
] as const;

const Frontmatter = z.object({
	name: z.string().regex(/^[a-z][a-z0-9-]*$/),
	description: z.string().min(20),
	tools: z.string().min(1).optional(),
	model: z.enum(["opus", "sonnet", "haiku"]),
});
type Frontmatter = z.infer<typeof Frontmatter>;

/** Contract section 13 CLI map (+ discover, learn from amendments). */
const CLI: Readonly<Record<string, readonly string[] | null>> = {
	doctor: null,
	discover: null,
	app: ["add", "list", "show", "transition", "ghost-sweep", "set-posted"],
	me: ["init", "path", "status", "extract", "ingest", "migrate", "validate"],
	metrics: ["list", "propose", "confirm"],
	resume: [
		"prepare",
		"validate",
		"render",
		"layout",
		"bold",
		"review",
		"gate",
		"status",
		"finalize",
	],
	ats: ["keywords", "score"],
	jd: ["snapshot", "show", "compare"],
	cover: ["render"],
	email: ["ingest", "list", "link"],
	interview: ["upsert", "list", "prep"],
	study: ["in", "out", "status", "blocks", "set", "task"],
	sync: ["begin", "end", "status"],
	dashboard: ["serve", "open", "status", "install", "uninstall"],
	learn: ["analyze", "playbook", "status"],
	// ADR-005
	policy: ["show", "check", "record", "eval"],
	autopilot: ["preflight", "escalations"],
	// ADR-006
	cloud: ["export", "import", "status"],
};

function splitFrontmatter(src: string): {
	data: unknown;
	body: string;
} {
	const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(src);
	if (!m) throw new Error("missing YAML frontmatter block");
	return { data: parseYaml(m[1] ?? ""), body: m[2] ?? "" };
}

function toolList(tools: string): string[] {
	return tools
		.split(",")
		.map((t) => t.trim())
		.filter(Boolean);
}

/** Pull code (inline spans and fenced blocks) out of markdown. */
function codeSnippets(md: string): string[] {
	const out: string[] = [];
	for (const m of md.matchAll(/```[^\n]*\n([\s\S]*?)```/g))
		out.push(m[1] ?? "");
	const noFences = md.replace(/```[\s\S]*?```/g, "");
	for (const m of noFences.matchAll(/`([^`\n]+)`/g)) out.push(m[1] ?? "");
	return out;
}

/** Every `jh <cmd> [<sub>]` (or `dist/jh.mjs" <cmd> ...`) found in code. */
function jhCalls(md: string): { cmd: string; sub?: string }[] {
	const calls: { cmd: string; sub?: string }[] = [];
	const re = /\bjh(?:\.mjs"?)?[ \t]+([a-z][a-z-]*)(?:[ \t]+([a-z][a-z-]*))?/g;
	for (const code of codeSnippets(md)) {
		for (const m of code.matchAll(re)) {
			const cmd = m[1] ?? "";
			calls.push(m[2] ? { cmd, sub: m[2] } : { cmd });
		}
	}
	return calls;
}

function unknownCalls(md: string): string[] {
	const bad: string[] = [];
	for (const { cmd, sub } of jhCalls(md)) {
		if (!(cmd in CLI)) {
			bad.push(`jh ${cmd}`);
			continue;
		}
		const subs = CLI[cmd];
		if (subs && sub && !subs.includes(sub)) bad.push(`jh ${cmd} ${sub}`);
	}
	return bad;
}

function agentFiles(): string[] {
	if (!existsSync(AGENTS_DIR)) return [];
	return readdirSync(AGENTS_DIR).filter((f) => f.endsWith(".md"));
}

function loadAgent(file: string): Frontmatter {
	const src = readFileSync(join(AGENTS_DIR, file), "utf8");
	return Frontmatter.parse(splitFrontmatter(src).data);
}

function markdownUnder(dir: string): string[] {
	const abs = join(ROOT, dir);
	if (!existsSync(abs)) return [];
	return readdirSync(abs, { recursive: true, encoding: "utf8" })
		.filter((f) => f.endsWith(".md"))
		.map((f) => join(abs, f));
}

describe("helpers", () => {
	it("splits frontmatter and parses YAML", () => {
		const { data, body } = splitFrontmatter(
			"---\nname: x\nmodel: haiku\n---\nBody\n",
		);
		expect(data).toEqual({ name: "x", model: "haiku" });
		expect(body).toBe("Body\n");
	});

	it("rejects a file without frontmatter", () => {
		expect(() => splitFrontmatter("# no frontmatter")).toThrow();
	});

	it("rejects a YAML list for tools", () => {
		const r = Frontmatter.safeParse({
			name: "x",
			description: "a description long enough",
			tools: ["Read", "Bash"],
			model: "haiku",
		});
		expect(r.success).toBe(false);
	});

	it("finds jh calls in inline code and fences, both call forms", () => {
		const md = [
			"Run `jh app list --status tailored --json` first.",
			"```sh",
			'node "C:/plugin/dist/jh.mjs" resume gate r1 --draft d1',
			"```",
			"Prose mention of jh outside code is ignored: jh foo bar.",
		].join("\n");
		expect(jhCalls(md)).toEqual([
			{ cmd: "resume", sub: "gate" },
			{ cmd: "app", sub: "list" },
		]);
	});

	it("flags unknown commands and subcommands", () => {
		expect(unknownCalls("`jh app frobnicate 1` and `jh scout run`")).toEqual([
			"jh app frobnicate",
			"jh scout",
		]);
		expect(unknownCalls("`jh discover stripe --json`")).toEqual([]);
	});
});

describe("agents/*.md frontmatter", () => {
	it("includes every agent this workstream owns", () => {
		const names = agentFiles().map((f) => f.replace(/\.md$/, ""));
		for (const a of REQUIRED_AGENTS) expect(names).toContain(a);
	});

	it.each(agentFiles())("%s has valid frontmatter per roster", (file) => {
		const fm = loadAgent(file);
		expect(fm.name).toBe(file.replace(/\.md$/, ""));
		expect(Object.keys(ROSTER)).toContain(fm.name);
		expect(fm.model).toBe(ROSTER[fm.name]);
		if (!MAY_INHERIT_TOOLS.has(fm.name)) {
			expect(typeof fm.tools).toBe("string");
			expect(toolList(fm.tools ?? "").length).toBeGreaterThan(0);
		}
	});

	it("pins job-scout to haiku and outcome-analyst to sonnet", () => {
		expect(ROSTER["job-scout"]).toBe("haiku");
		expect(ROSTER["outcome-analyst"]).toBe("sonnet");
	});

	it.each(agentFiles())(
		"%s: no browsing agent runs on opus (Rule 3)",
		(file) => {
			const fm = loadAgent(file);
			const browses = toolList(fm.tools ?? "").some((t) =>
				t.startsWith("mcp__claude-in-chrome__"),
			);
			if (browses) expect(fm.model).not.toBe("opus");
		},
	);
});

describe("jh invocations in agents/, skills/ and commands/", () => {
	const files = [
		...markdownUnder("agents"),
		...markdownUnder("skills"),
		...markdownUnder("commands"),
	];
	it.each(files)("%s only calls contract section 13 commands", (file) => {
		expect(unknownCalls(readFileSync(file, "utf8"))).toEqual([]);
	});
});
