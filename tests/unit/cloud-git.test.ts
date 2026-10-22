import { describe, expect, it } from "vitest";
import {
	assertPrivateRemote,
	commitAndPush,
	parseGithubSlug,
	type Run,
	syncDataRepo,
} from "../../src/cloud/git.js";
import { ValidationError } from "../../src/core/errors.js";

type Call = { cmd: string; args: string[] };

/**
 * A fake Run: `handler` returns stdout for a call or throws to simulate a
 * failure. Every call is recorded.
 */
function fakeRun(handler: (c: Call, n: number) => string): {
	run: Run;
	calls: Call[];
} {
	const calls: Call[] = [];
	const run: Run = async (cmd, args) => {
		const c = { cmd, args };
		calls.push(c);
		return handler(c, calls.length);
	};
	return { run, calls };
}

const line = (c: Call) => [c.cmd, ...c.args].join(" ");

describe("parseGithubSlug", () => {
	it("reads owner/name from https and ssh remotes", () => {
		expect(parseGithubSlug("https://github.com/acme/conscience-data.git")).toBe(
			"acme/conscience-data",
		);
		expect(parseGithubSlug("https://github.com/acme/conscience-data")).toBe(
			"acme/conscience-data",
		);
		expect(parseGithubSlug("git@github.com:acme/conscience-data.git\n")).toBe(
			"acme/conscience-data",
		);
		expect(parseGithubSlug("ssh://git@github.com/acme/data.git")).toBe(
			"acme/data",
		);
	});

	it("returns null for non-GitHub or malformed remotes", () => {
		expect(parseGithubSlug("https://gitlab.com/acme/data.git")).toBeNull();
		expect(parseGithubSlug("/tmp/bare.git")).toBeNull();
		expect(parseGithubSlug("https://github.com/acme")).toBeNull();
	});
});

describe("assertPrivateRemote", () => {
	it("asks gh about the push remote of origin by name", async () => {
		const { run, calls } = fakeRun((c) => {
			if (c.cmd === "git")
				return "https://github.com/acme/conscience-data.git\n";
			return "PRIVATE\n";
		});
		await assertPrivateRemote("/data", run);
		expect(line(calls[0] as Call)).toBe("git remote get-url --push origin");
		expect(calls[1]?.cmd).toBe("gh");
		expect(calls[1]?.args.slice(0, 3)).toEqual([
			"repo",
			"view",
			"acme/conscience-data",
		]);
	});

	it("refuses a public repo", async () => {
		const { run } = fakeRun((c) =>
			c.cmd === "git" ? "git@github.com:acme/data.git" : "PUBLIC",
		);
		await expect(assertPrivateRemote("/data", run)).rejects.toMatchObject({
			code: "data_repo_not_private",
		});
	});

	it("refuses a push remote that is not on GitHub", async () => {
		const { run, calls } = fakeRun(() => "https://example.com/acme/data.git");
		await expect(assertPrivateRemote("/data", run)).rejects.toBeInstanceOf(
			ValidationError,
		);
		expect(calls.some((c) => c.cmd === "gh")).toBe(false);
	});
});

describe("syncDataRepo", () => {
	it("pulls with rebase and autostash from origin", async () => {
		const { run, calls } = fakeRun((c) =>
			c.args[0] === "rev-parse" ? "main\n" : "",
		);
		await syncDataRepo("/data", run);
		expect(calls.map(line)).toContain(
			"git pull -q --rebase --autostash origin main",
		);
	});

	it("tolerates an empty remote with no branches yet", async () => {
		const { run } = fakeRun((c) => {
			if (c.args[0] === "rev-parse") return "main\n";
			if (c.args[0] === "pull")
				throw new Error("couldn't find remote ref main");
			return ""; // ls-remote: no heads
		});
		await expect(syncDataRepo("/data", run)).resolves.toBeUndefined();
	});

	it("rethrows a pull failure when the remote has branches", async () => {
		const { run } = fakeRun((c) => {
			if (c.args[0] === "rev-parse") return "main\n";
			if (c.args[0] === "pull") throw new Error("conflict");
			return "abc123\trefs/heads/main\n";
		});
		await expect(syncDataRepo("/data", run)).rejects.toThrow("conflict");
	});
});

describe("commitAndPush", () => {
	it("stages and commits only the given paths, then pushes to origin", async () => {
		const { run, calls } = fakeRun((c) => {
			if (c.args[0] === "rev-parse") return "main\n";
			if (c.args[0] === "diff") return "me/profile.yaml\n";
			return "";
		});
		await commitAndPush("/data", "packet p", run, ["me", "packets/p-1"]);
		const l = calls.map(line);
		expect(l).toContain("git add -A -- me packets/p-1");
		expect(l).toContain("git commit -q -m packet p -- me packets/p-1");
		expect(l).toContain("git push -q -u origin main");
	});

	it("on a rejected push, rebases onto origin and retries once", async () => {
		let pushes = 0;
		const { run, calls } = fakeRun((c) => {
			if (c.args[0] === "rev-parse") return "main\n";
			if (c.args[0] === "diff") return "x\n";
			if (c.args[0] === "push" && ++pushes === 1)
				throw new Error("rejected (fetch first)");
			return "";
		});
		await commitAndPush("/data", "m", run, ["me"]);
		const l = calls.map(line);
		const firstPush = l.indexOf("git push -q -u origin main");
		const pull = l.indexOf("git pull -q --rebase --autostash origin main");
		expect(firstPush).toBeGreaterThan(-1);
		expect(pull).toBeGreaterThan(firstPush);
		expect(l.lastIndexOf("git push -q -u origin main")).toBeGreaterThan(pull);
		expect(pushes).toBe(2);
	});

	it("gives up after the retry fails", async () => {
		const { run } = fakeRun((c) => {
			if (c.args[0] === "rev-parse") return "main\n";
			if (c.args[0] === "diff") return "x\n";
			if (c.args[0] === "push") throw new Error("rejected");
			return "";
		});
		await expect(commitAndPush("/data", "m", run, ["me"])).rejects.toThrow(
			"rejected",
		);
	});
});
