import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ValidationError } from "../core/errors.js";

const execFileP = promisify(execFile);

/** Run a command in `cwd` and resolve with its stdout. Injected in tests. */
export type Run = (cmd: string, args: string[], cwd: string) => Promise<string>;

export const defaultRun: Run = async (cmd, args, cwd) => {
	const { stdout } = await execFileP(cmd, args, {
		cwd,
		timeout: 120_000,
		maxBuffer: 16 * 1024 * 1024,
		windowsHide: true,
	});
	return stdout;
};

/** Throw unless the data repo's GitHub remote is private (ADR 006). */
export async function assertPrivateRemote(
	dataDir: string,
	run: Run,
): Promise<void> {
	let visibility: string;
	try {
		visibility = (
			await run(
				"gh",
				["repo", "view", "--json", "visibility", "-q", ".visibility"],
				dataDir,
			)
		).trim();
	} catch (e) {
		throw new ValidationError(
			`could not verify that the data repo is private: ${(e as Error).message}`,
			{ dataDir },
			"data_repo_unverified",
		);
	}
	if (visibility.toUpperCase() !== "PRIVATE")
		throw new ValidationError(
			`data repo must be private (gh reports ${visibility || "nothing"}); see ADR 006`,
			{ dataDir, visibility },
			"data_repo_not_private",
		);
}

/** Stage `paths` (default: everything), commit, push; the push is retried once. */
export async function commitAndPush(
	dataDir: string,
	message: string,
	run: Run,
	paths: string[] = ["."],
): Promise<void> {
	await run("git", ["add", "-A", "--", ...paths], dataDir);
	const staged = await run("git", ["diff", "--cached", "--name-only"], dataDir);
	if (staged.trim()) await run("git", ["commit", "-q", "-m", message], dataDir);
	try {
		await run("git", ["push", "-q"], dataDir);
	} catch {
		await run("git", ["push", "-q"], dataDir);
	}
}
