import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "scripts", "cloud-setup.sh");
const TOKEN = "fixture-token-1234567890-not-real";

const hasBashAndGit =
	spawnSync("bash", ["-c", "command -v git"], { encoding: "utf8" }).status ===
	0;

/** Every file under root whose bytes contain `needle`. */
function filesContaining(root: string, needle: string): string[] {
	const hits: string[] = [];
	const walk = (dir: string) => {
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			const st = statSync(p, { throwIfNoEntry: false });
			if (!st) continue;
			if (st.isDirectory()) walk(p);
			else if (st.isFile() && readFileSync(p).includes(needle)) hits.push(p);
		}
	};
	walk(root);
	return hits;
}

describe("cloud-setup.sh (static)", () => {
	const text = readFileSync(SCRIPT, "utf8");

	it("never puts the token in a URL, on a command line or in a trace", () => {
		expect(text).not.toMatch(/x-access-token:\$\{?DATA_TOKEN/);
		expect(text).not.toMatch(/@github\.com/);
		expect(text).not.toMatch(/http\.extraheader/);
		expect(text).not.toMatch(/^\s*set\s+-[a-z]*x/m);
		expect(text).not.toMatch(/echo[^\n]*\$\{?DATA_TOKEN/);
	});

	it("writes settings.local.json through JSON.stringify, not a heredoc", () => {
		expect(text).not.toMatch(/<<\s*'?JSON/);
		expect(text).toMatch(/JSON\.stringify/);
	});
});

describe.skipIf(!hasBashAndGit)(
	"cloud-setup.sh (run)",
	{ timeout: 60_000 },
	() => {
		let tmp: string;
		let fakeRepo: string;
		let bare: string;
		let dataDir: string;
		let jhHome: string;

		const git = (cwd: string, ...args: string[]) => {
			const r = spawnSync("git", args, { cwd, encoding: "utf8" });
			if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
			return r.stdout;
		};

		beforeEach(() => {
			tmp = mkdtempSync(join(tmpdir(), "jh-cloud-setup-"));
			// A fake code checkout: the script works relative to its own location.
			fakeRepo = join(tmp, "code");
			mkdirSync(join(fakeRepo, "scripts"), { recursive: true });
			cpSync(SCRIPT, join(fakeRepo, "scripts", "cloud-setup.sh"));
			for (const d of [
				"agents",
				"commands",
				"skills/demo",
				"dist",
				".git/info",
			])
				mkdirSync(join(fakeRepo, d), { recursive: true });
			writeFileSync(join(fakeRepo, "agents", "a.md"), "a\n");
			writeFileSync(join(fakeRepo, "commands", "c.md"), "c\n");
			writeFileSync(join(fakeRepo, "skills", "demo", "SKILL.md"), "s\n");
			writeFileSync(join(fakeRepo, "dist", "jh.mjs"), "process.exit(0);\n");
			// A local bare "data repo" with one commit.
			bare = join(tmp, "data.git");
			git(tmp, "init", "-q", "--bare", bare);
			const seed = join(tmp, "seed");
			git(tmp, "init", "-q", seed);
			mkdirSync(join(seed, "me"));
			writeFileSync(join(seed, "me", "profile.yaml"), "name: Fictional\n");
			git(seed, "add", ".");
			git(
				seed,
				"-c",
				"user.name=t",
				"-c",
				"user.email=t@example.com",
				"commit",
				"-q",
				"-m",
				"seed",
			);
			git(seed, "push", "-q", bare, "HEAD:refs/heads/main");
			git(tmp, "--git-dir", bare, "symbolic-ref", "HEAD", "refs/heads/main");
			dataDir = join(tmp, "conscience-data");
			jhHome = join(tmp, "jh-home");
		});

		afterEach(() => {
			rmSync(tmp, { recursive: true, force: true });
		});

		function runSetup(): { status: number | null; out: string } {
			const r = spawnSync(
				"bash",
				[join(fakeRepo, "scripts", "cloud-setup.sh")],
				{
					encoding: "utf8",
					env: {
						...process.env,
						DATA_TOKEN: TOKEN,
						DATA_REPO: "acme/conscience-data",
						CLOUD_SETUP_DATA_URL: bare.replace(/\\/g, "/"),
						CLOUD_SETUP_DATA_DIR: dataDir.replace(/\\/g, "/"),
						CLOUD_SETUP_JH_HOME: jhHome.replace(/\\/g, "/"),
						// Keep the developer's global git config out of it.
						GIT_CONFIG_GLOBAL: join(tmp, "gitconfig").replace(/\\/g, "/"),
						GIT_CONFIG_NOSYSTEM: "1",
					},
				},
			);
			return { status: r.status, out: `${r.stdout}${r.stderr}` };
		}

		it("clones the data repo without writing the token anywhere", () => {
			const r = runSetup();
			expect(r.out).not.toContain(TOKEN);
			expect(r.status, r.out).toBe(0);
			expect(readFileSync(join(dataDir, "me", "profile.yaml"), "utf8")).toBe(
				"name: Fictional\n",
			);
			expect(filesContaining(tmp, TOKEN)).toEqual([]);
			expect(git(dataDir, "remote", "get-url", "origin").trim()).toBe(
				bare.replace(/\\/g, "/"),
			);
		});

		it("writes valid settings.local.json and re-runs cleanly", () => {
			expect(runSetup().status).toBe(0);
			const second = runSetup();
			expect(second.status, second.out).toBe(0);
			const settings = JSON.parse(
				readFileSync(join(fakeRepo, ".claude", "settings.local.json"), "utf8"),
			) as { env: Record<string, string> };
			expect(settings.env.JOB_HUNTER_DATA_REPO).toBe(
				dataDir.replace(/\\/g, "/"),
			);
			expect(settings.env.JOB_HUNTER_ME).toBe(
				`${dataDir.replace(/\\/g, "/")}/me`,
			);
			expect(Object.values(settings.env).join(" ")).not.toContain(TOKEN);
		});
	},
);
