/** Exit codes: 1 runtime/not found, 2 validation/conflict, 3 illegal transition. */
export type ExitCode = 1 | 2 | 3;

export class JhError extends Error {
	constructor(
		message: string,
		public exitCode: ExitCode,
		public code: string,
		public details?: unknown,
	) {
		super(message);
		this.name = new.target.name;
	}
}

const SNAKE_TOKEN = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;

/**
 * Subclasses take (message, details?, code?). When no code is given and the
 * message is itself a snake_case token (e.g. "already_clocked_in"), that token
 * becomes the code so callers can branch on err.code.
 */
function pickCode(message: string, fallback: string, code?: string): string {
	if (code) return code;
	return SNAKE_TOKEN.test(message) ? message : fallback;
}

export class ValidationError extends JhError {
	constructor(message: string, details?: unknown, code?: string) {
		super(message, 2, pickCode(message, "validation", code), details);
	}
}

export class ConflictError extends JhError {
	constructor(message: string, details?: unknown, code?: string) {
		super(message, 2, pickCode(message, "conflict", code), details);
	}
}

export class IllegalTransitionError extends JhError {
	constructor(message: string, details?: unknown, code?: string) {
		super(message, 3, pickCode(message, "illegal_transition", code), details);
	}
}

export class NotFoundError extends JhError {
	constructor(message: string, details?: unknown, code?: string) {
		super(message, 1, pickCode(message, "not_found", code), details);
	}
}

export function isJhError(e: unknown): e is JhError {
	return e instanceof JhError;
}
