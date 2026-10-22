#!/usr/bin/env node
// SessionStart hook: tell the user what needs attention before agents start working.
// Checks:
//   1. MCP servers reported by `claude mcp list` that need (re)authentication;
//   2. API keys declared but empty in <JOB_HUNTER_HOME>/.env;
//   3. the me/ workspace: missing, never ingested, or holding estimated metrics awaiting a decision.
// It never throws: any failure in a check just drops that check's message.
import { exec } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const home = resolve(process.env.JOB_HUNTER_HOME || join(homedir(), ".job-hunter"));
const envFile = join(home, ".env");
/** Path-style settings, not API keys: an empty value just means "use the default". */
const NOT_KEYS = new Set(["JOB_HUNTER_HOME", "JOB_HUNTER_ME", "JOB_HUNTER_DB", "CHROME_PATH"]);

function readEnvPairs() {
	if (!existsSync(envFile)) return [];
	const out = [];
	for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
		const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
		if (!m) continue;
		const raw = m[2].trim();
		const quoted = raw.match(/^"([^"]*)"|^'([^']*)'/);
		const value = quoted ? (quoted[1] ?? quoted[2] ?? "") : raw.replace(/\s+#.*$/, "").trim();
		out.push([m[1], value]);
	}
	return out;
}

function mcpProblems() {
	return new Promise((done) => {
		exec("claude mcp list", { timeout: 20000 }, (err, stdout) => {
			if (err && !stdout) return done([]);
			const out = [];
			for (const line of String(stdout).split(/\r?\n/)) {
				const m = line.match(/^(.+?):\s.*-\s*[!✗×]\s*(Needs authentication|Failed.*)$/);
				if (m) out.push(`${m[1].trim()} (${m[2].trim()})`);
			}
			done(out);
		});
	});
}

function missingKeys(pairs) {
	return pairs.filter(([k, v]) => !NOT_KEYS.has(k) && v === "").map(([k]) => k);
}

function meRoot(pairs) {
	const fromEnv = process.env.JOB_HUNTER_ME || pairs.find(([k]) => k === "JOB_HUNTER_ME")?.[1];
	if (fromEnv) return resolve(fromEnv);
	// Mirror core/paths meDir(): an existing <plugin root>/me wins over <home>/me.
	const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
	if (pluginRoot && existsSync(join(pluginRoot, "me"))) return resolve(pluginRoot, "me");
	return resolve(join(home, "me"));
}

function workspaceNotes(pairs) {
	const root = meRoot(pairs);
	if (!existsSync(root)) {
		const legacy = existsSync(join(home, "profile.yaml")) || existsSync(join(home, "resume.yaml"));
		return [
			legacy
				? `me/ workspace not set up; legacy files found in ${home}: run \`jh me init --dir <path>\` then \`jh me migrate\``
				: "me/ workspace not set up: run `jh me init --dir <path>`, add your resume and experience READMEs, then /intake",
		];
	}
	const master = join(root, "master-resume.yaml");
	if (!existsSync(master) || !/^\s*-\s*id:/m.test(readFileSync(master, "utf8")))
		return [`me/ (${root}) has no master resume yet: run /intake`];
	const pending = (readFileSync(master, "utf8").match(/^\s*status:\s*["']?estimated["']?\s*$/gm) ?? []).length;
	return pending ? [`${pending} estimated metric(s) await your decision: run /confirm-metrics`] : [];
}

function safely(fn, fallback) {
	try {
		return fn();
	} catch {
		return fallback;
	}
}

async function main() {
	const pairs = safely(readEnvPairs, []);
	const mcp = await mcpProblems().catch(() => []);
	const keys = safely(() => missingKeys(pairs), []);
	const me = safely(() => workspaceNotes(pairs), []);
	if (!mcp.length && !keys.length && !me.length) return;
	const lines = ["conscience: things to sort out before full autonomy"];
	if (mcp.length) lines.push(`  MCP servers: ${mcp.join(", ")}  → run /mcp to sign in`);
	if (keys.length) lines.push(`  Empty API keys in ${envFile}: ${keys.join(", ")}`);
	for (const note of me) lines.push(`  ${note}`);
	const msg = lines.join("\n");
	console.log(
		JSON.stringify({
			systemMessage: msg,
			hookSpecificOutput: {
				hookEventName: "SessionStart",
				additionalContext: `${msg}\nMention this to the user at the start of your first reply, then continue with what works.`,
			},
		}),
	);
}

main().catch(() => {});
