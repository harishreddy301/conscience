import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Command } from "commander";
import { z } from "zod";
import { audit } from "../core/audit.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import { action, emit } from "../core/output.js";
import { artifactsDir, ensureDir } from "../core/paths.js";
import { type Db, openDb } from "../db/index.js";
import { getApplication, setArtifactsDir } from "../db/repo.js";
import { loadProfile } from "../me/load.js";
import type { Profile } from "../me/schema.js";
import { type CoverFormat, renderCover } from "../render/cover.js";
import type { RenderResult } from "../render/fit.js";
import { TailoredResume } from "../resume/schema.js";

type Basics = TailoredResume["basics"];

const BasicsSchema = TailoredResume.shape.basics;
const CoverFormats = z
	.array(z.enum(["pdf", "docx", "txt"]))
	.min(1, "at least one format");
const AppId = z.coerce.number().int().positive();

export function parseCoverFormats(raw: string): CoverFormat[] {
	const list = raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	const parsed = CoverFormats.safeParse([...new Set(list)]);
	if (!parsed.success)
		throw new ValidationError(
			`invalid --formats "${raw}": use any of pdf,docx,txt`,
		);
	return parsed.data;
}

/** Map profile identity to resume basics (used when no tailored resume exists yet). */
export function basicsFromProfile(p: Profile): Basics {
	const id = p.identity;
	return BasicsSchema.parse({
		name: id.name,
		headline: "",
		email: id.email,
		phone: id.phone,
		location: id.location,
		links: Object.entries(id.links ?? {}).map(([label, url]) => ({
			label,
			url,
		})),
	});
}

/** Basics from the application's finalized resume.json, else from me/profile.yaml. */
export function resolveBasics(
	dir: string,
	profile: () => Profile = loadProfile,
): Basics {
	const file = join(dir, "resume.json");
	if (existsSync(file)) {
		const raw = JSON.parse(readFileSync(file, "utf8")) as { basics?: unknown };
		const parsed = BasicsSchema.safeParse(raw.basics);
		if (!parsed.success)
			throw new ValidationError(
				`${file}: basics are invalid`,
				parsed.error.issues,
			);
		return parsed.data;
	}
	return basicsFromProfile(profile());
}

function readMarkdown(path: string): string {
	if (!existsSync(path)) throw new NotFoundError(`file not found: ${path}`);
	const md = readFileSync(path, "utf8").replace(/^﻿/, "");
	if (!md.trim()) throw new ValidationError(`cover letter is empty: ${path}`);
	return md;
}

export interface CoverRenderOutput extends RenderResult {
	app_id: number;
	company: string;
	out_dir: string;
	markdown: string;
}

/** Render `<cover.md>` for application `appId` into its artifacts directory. */
export async function coverRender(
	db: Db,
	mdPath: string,
	appId: number,
	formats: CoverFormat[],
	profile: () => Profile = loadProfile,
): Promise<CoverRenderOutput> {
	const md = readMarkdown(mdPath);
	const app = getApplication(db, appId);
	if (!app) throw new NotFoundError(`application ${appId} not found`);
	const outDir = ensureDir(app.artifacts_dir ?? artifactsDir(appId));
	if (!app.artifacts_dir) setArtifactsDir(db, appId, outDir);
	const mdOut = join(outDir, "cover.md");
	if (resolve(mdPath) !== resolve(mdOut)) copyFileSync(mdPath, mdOut);
	const basics = resolveBasics(outDir, profile);
	const result = await renderCover(md, basics, app.company, outDir, formats);
	audit({
		actor: "cli",
		action: "cover.render",
		target: `app:${appId}`,
		detail: { files: result.files, warnings: result.warnings },
	});
	return {
		...result,
		app_id: appId,
		company: app.company,
		out_dir: outDir,
		markdown: mdOut,
	};
}

function human(r: CoverRenderOutput): string {
	const lines = [`cover letter for ${r.company} (app ${r.app_id})`];
	for (const [fmt, path] of Object.entries(r.files))
		lines.push(`  ${fmt.padEnd(4)} ${path}`);
	if (r.pages !== null) lines.push(`  pages ${r.pages}`);
	for (const w of r.warnings) lines.push(`  warning: ${w}`);
	return lines.join("\n");
}

export function register(program: Command): void {
	const cover = program
		.command("cover")
		.description("cover letters rendered in the resume theme");
	cover
		.command("render <coverMd>")
		.description(
			"render a cover-letter markdown file to <artifacts>/<app>/cover.{pdf,docx,txt}",
		)
		.requiredOption("--app <id>", "application id")
		.option("--formats <list>", "comma-separated: pdf,docx,txt", "pdf,docx,txt")
		.option("--json", "machine-readable output")
		.action(
			action(
				async (
					coverMd: string,
					opts: { app: string; formats: string; json?: boolean },
				) => {
					const id = AppId.safeParse(opts.app);
					if (!id.success)
						throw new ValidationError(`invalid --app "${opts.app}"`);
					const formats = parseCoverFormats(opts.formats);
					const db = openDb();
					try {
						const out = await coverRender(db, coverMd, id.data, formats);
						emit(out, opts.json, human);
						if (formats.includes("pdf") && !out.files.pdf) process.exitCode = 1;
					} finally {
						db.close();
					}
				},
			),
		);
}
