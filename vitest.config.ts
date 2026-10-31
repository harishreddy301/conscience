import { defineConfig } from "vitest/config";

// Windows CI runners are much slower at module loading and SQLite file I/O;
// the 5s default times out tests that finish in well under a second on Linux.
const slow = process.platform === "win32";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		testTimeout: slow ? 30_000 : 5_000,
		hookTimeout: slow ? 30_000 : 10_000,
	},
});
