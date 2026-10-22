// Build the conscience CLI and dashboard bundles (contracts §16, amendment 5).
//   src/cli.ts            -> dist/jh.mjs         (shebang banner)
//   src/dashboard/main.ts -> dist/dashboard.mjs
//   dashboard-ui/*        -> dist/dashboard-ui/
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");

/** Shared options; packages stay bundled, node builtins stay external. */
const common = {
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	external: ["node:*"],
	logLevel: "info",
	// Bundled CJS deps (e.g. commander) may call require() on builtins.
	banner: {
		js: 'import { createRequire as __jhCreateRequire } from "node:module"; const require = __jhCreateRequire(import.meta.url);',
	},
};

mkdirSync(dist, { recursive: true });

await build({
	...common,
	entryPoints: [join(root, "src", "cli.ts")],
	outfile: join(dist, "jh.mjs"),
	banner: { js: `#!/usr/bin/env node\n${common.banner.js}` },
});

await build({
	...common,
	entryPoints: [join(root, "src", "dashboard", "main.ts")],
	outfile: join(dist, "dashboard.mjs"),
});

const uiSrc = join(root, "dashboard-ui");
const uiOut = join(dist, "dashboard-ui");
if (!existsSync(uiSrc)) {
	console.error(`build: missing ${uiSrc}`);
	process.exit(1);
}
rmSync(uiOut, { recursive: true, force: true });
cpSync(uiSrc, uiOut, { recursive: true });
console.log(`copied dashboard-ui -> ${uiOut}`);
