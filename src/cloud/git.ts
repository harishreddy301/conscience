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

/** owner/name from a GitHub remote URL (https, ssh or scp form), else null. */
export function parseGithubSlug(url: string): string | null {
	const m = url
		.trim()
		.match(
			/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
		);
	return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * Throw unless origin's push URL is a private GitHub repo (ADR 006). The repo
 * is named explicitly so gh never guesses from other remotes.
 */
export async function assertPrivateRemote(
	dataDir: string,
	run: Run,
): Promise<void> {
	let slug: string | null;
	let visibility: string;
	try {
		const url = await run(
			"git",
			["remote", "get-url", "--push", "origin"],
			dataDir,
		);
		slug = parseGithubSlug(url);
		if (!slug)
			throw new ValidationError(
				"origin's push URL is not a GitHub repository",
				{ dataDir },
				"data_repo_unverified",
			);
		visibility = (
			await run(
				"gh",
				["repo", "view", slug, "--json", "visibility", "-q", ".visibility"],
				dataDir,
			)
		).trim();
	} catch (e) {
		if (e instanceof ValidationError) throw e;
		throw new ValidationError(
			`could not verify that the data repo is private: ${(e as Error).message}`,
			{ dataDir },
			"data_repo_unverified",
		);
	}
	if (visibility.toUpperCase() !== "PRIVATE")
		throw new ValidationError(
			`data repo ${slug} must be private (gh reports ${visibility || "nothing"}); see ADR 006`,
			{ dataDir, repo: slug, visibility },
			"data_repo_not_private",
		);
}

async function currentBranch(dataDir: string, run: Run): Promise<string> {
	return (
		await run("git", ["rev-parse", "--abbrev-ref", "HEAD"], dataDir)
	).trim();
}

async function pullRebase(
	dataDir: string,
	branch: string,
	run: Run,
): Promise<void> {
	await run(
		"git",
		["pull", "-q", "--rebase", "--autostash", "origin", branch],
		dataDir,
	);
}

/**
 * Bring the clone up to date with origin (rebase, autostash). A remote with
 * no branches yet (a fresh data repo) is fine; any other failure is thrown.
 */
export async function syncDataRepo(dataDir: string, run: Run): Promise<void> {
	const branch = await currentBranch(dataDir, run);
	try {
		await pullRebase(dataDir, branch, run);
	} catch (e) {
		const heads = await run("git", ["ls-remote", "--heads", "origin"], dataDir);
		if (heads.trim()) throw e;
	}
}

/**
 * Stage and commit only `paths`, push to origin; a rejected push is rebased
 * onto origin and retried once.
 */
export async function commitAndPush(
	dataDir: string,
	message: string,
	run: Run,
	paths: string[],
): Promise<void> {
	await run("git", ["add", "-A", "--", ...paths], dataDir);
	const staged = await run(
		"git",
		["diff", "--cached", "--name-only", "--", ...paths],
		dataDir,
	);
	if (staged.trim())
		await run("git", ["commit", "-q", "-m", message, "--", ...paths], dataDir);
	const branch = await currentBranch(dataDir, run);
	const push = () =>
		run("git", ["push", "-q", "-u", "origin", branch], dataDir);
	try {
		await push();
	} catch {
		await pullRebase(dataDir, branch, run);
		await push();
	}
}
