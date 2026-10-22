import { readFile } from "node:fs/promises";
import { Command } from "commander";
import { ZodError } from "zod";
import { JhError, NotFoundError, ValidationError } from "./errors.js";

/** Print a result: JSON on stdout with --json, otherwise human text. */
export function emit(
	data: unknown,
	json: boolean | undefined,
	// biome-ignore lint/suspicious/noExplicitAny: human formatters receive caller-shaped data
	human?: (d: any) => string,
): void {
	if (json || !human) {
		process.stdout.write(`${JSON.stringify(data, null, json ? 0 : 2)}\n`);
		return;
	}
	const text = human(data);
	if (text) process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return (
		typeof v === "object" &&
		v !== null &&
		!Array.isArray(v) &&
		!(v instanceof Command)
	);
}

/** Commander passes (...args, opts, command); find whether --json was set. */
export function wantsJson(args: readonly unknown[]): boolean {
	for (let i = args.length - 1; i >= 0; i--) {
		const a = args[i];
		if (a instanceof Command) return Boolean(a.optsWithGlobals().json);
		if (isPlainObject(a)) return Boolean(a.json);
	}
	return false;
}

/** Normalize any thrown value into a JhError. */
export function toJhError(e: unknown): JhError {
	if (e instanceof JhError) return e;
	if (e instanceof ZodError) {
		const details = e.issues.map((i) => ({
			path: i.path.join("."),
			message: i.message,
		}));
		const first = details[0];
		const summary = first
			? `${first.path || "input"}: ${first.message}`
			: "invalid input";
		return new ValidationError(summary, details);
	}
	const message = e instanceof Error ? e.message : String(e);
	return new JhError(message, 1, "runtime");
}

export function reportError(err: JhError, json: boolean): void {
	process.exitCode = err.exitCode;
	if (json) {
		const body: Record<string, unknown> = {
			error: err.code,
			message: err.message,
		};
		if (err.details !== undefined) body.details = err.details;
		process.stdout.write(`${JSON.stringify(body)}\n`);
		return;
	}
	process.stderr.write(`error (${err.code}): ${err.message}\n`);
}

/** Wrap a commander action: errors set process.exitCode and print per --json. */
export function action<A extends unknown[]>(
	fn: (...a: A) => unknown | Promise<unknown>,
): (...a: A) => Promise<void> {
	return async (...a: A) => {
		try {
			await fn(...a);
		} catch (e) {
			reportError(toJhError(e), wantsJson(a));
		}
	};
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function readSource(pathOrDash: string): Promise<string> {
	if (pathOrDash === "-") return readStdin();
	try {
		return await readFile(pathOrDash, "utf8");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT")
			throw new NotFoundError(`file not found: ${pathOrDash}`);
		throw e;
	}
}

/** Read and parse JSON from a file path, or stdin when "-". */
export async function readJsonInput(pathOrDash: string): Promise<unknown> {
	const raw = await readSource(pathOrDash);
	try {
		return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
	} catch (e) {
		const where = pathOrDash === "-" ? "stdin" : pathOrDash;
		throw new ValidationError(
			`invalid JSON in ${where}: ${(e as Error).message}`,
		);
	}
}
