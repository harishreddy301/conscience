import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { ensureDir, logsDir } from "./paths.js";

export interface AuditEvent {
	actor: string;
	action: string;
	target?: string;
	detail?: unknown;
}

export function auditFile(): string {
	return join(logsDir(), "audit.jsonl");
}

/**
 * Append {at, actor, action, target?, detail?} to <logsDir>/audit.jsonl.
 * Best effort: a logging failure is reported on stderr, never thrown, so the
 * action it records is not undone by a full disk or locked file.
 */
export function audit(event: AuditEvent): void {
	const line = JSON.stringify({ at: new Date().toISOString(), ...event });
	try {
		ensureDir(logsDir());
		appendFileSync(auditFile(), `${line}\n`, "utf8");
	} catch (e) {
		process.stderr.write(
			`warning: audit log write failed: ${(e as Error).message}\n`,
		);
	}
}
