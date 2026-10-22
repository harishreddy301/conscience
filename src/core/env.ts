import { existsSync } from "node:fs";
import { join } from "node:path";
import { jhHome } from "./paths.js";

export * from "./paths.js";

/**
 * Load <jhHome>/.env into process.env (existing env vars win).
 * Must run before meDir()/dbPath() so JOB_HUNTER_ME and JOB_HUNTER_DB apply.
 */
export function loadEnv(): void {
	const file = join(jhHome(), ".env");
	if (existsSync(file)) process.loadEnvFile(file);
}
