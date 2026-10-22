import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
	ConflictError,
	NotFoundError,
	ValidationError,
} from "../core/errors.js";
import {
	ensureDir,
	jhHome,
	type MePaths,
	meDir,
	mePaths,
} from "../core/paths.js";
import {
	readFrontMatter,
	readValidated,
	saveMaster,
	slug,
	writeFileAtomic,
} from "./load.js";
import {
	ConfirmedMetrics,
	EXPERIENCE_SECTIONS,
	ExperienceFrontMatter,
	type MasterBullet,
	MasterResume,
	type MasterRole,
	Profile,
	StoryFrontMatter,
} from "./schema.js";

/** Generated or user-decided files that `--force` must never clobber. */
const PROTECTED = new Set([
	"master-resume.yaml",
	"confirmed-metrics.yaml",
	"metrics.md",
]);
/** Folders whose fictional examples are copied with a leading "_" so intake ignores them. */
const EXAMPLE_DIRS = new Set([
	"experience",
	"stories",
	"sample-resume",
	"learnings",
]);
const INTAKE_STATE = "state.json";

// --- templates ----------------------------------------------------------------

/** templates/me, found by walking up from this module (works from src/ and dist/). */
export function templatesMeDir(
	start: string = dirname(fileURLToPath(import.meta.url)),
): string {
	let dir = resolve(start);
	for (;;) {
		const candidate = join(dir, "templates", "me");
		if (existsSync(join(candidate, "README.md"))) return candidate;
		const parent = dirname(dir);
		if (parent === dir)
			throw new NotFoundError("templates/me not found next to the jh CLI");
		dir = parent;
	}
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p));
		else if (e.isFile()) out.push(p);
	}
	return out;
}

/**
 * Template path -> workspace path: ".example" is stripped; a fictional example in
 * experience/, stories/ or sample-resume/ gets an "_example-" prefix (e.g.
 * experience/acme-2022.example.md -> experience/_example-acme-2022.md) so it is
 * never ingested as the user's own history. "_TEMPLATE.example.md" -> "_TEMPLATE.md".
 */
export function workspaceRel(templateRel: string): string {
	const parts = templateRel.split(/[\\/]/);
	const file = parts.pop() ?? "";
	const stripped = file.replace(/\.example(?=\.[^.]+$)/, "");
	const isExample = stripped !== file;
	const folder = parts[0];
	const name =
		isExample && folder && EXAMPLE_DIRS.has(folder) && !stripped.startsWith("_")
			? `_example-${stripped}`
			: stripped;
	return [...parts, name].join("/");
}

// --- .env -------------------------------------------------------------------

/** Upsert one KEY=value line, keeping every other line (and its order) intact. */
export function upsertEnvLine(
	content: string,
	key: string,
	value: string,
): string {
	const line = `${key}="${value}"`;
	const eol = content.includes("\r\n") ? "\r\n" : "\n";
	const lines = content.length ? content.split(/\r?\n/) : [];
	const re = new RegExp(`^\\s*${key}\\s*=`);
	const idx = lines.findIndex((l) => re.test(l));
	if (idx >= 0) {
		lines[idx] = line;
		return lines.join(eol);
	}
	while (lines.length && lines[lines.length - 1] === "") lines.pop();
	lines.push(line, "");
	return lines.join(eol);
}

export function toForwardSlashes(p: string): string {
	return p.split(sep).join("/").replace(/\\/g, "/");
}

function writeMeEnv(dir: string): { envFile: string; changed: boolean } {
	const envFile = join(jhHome(), ".env");
	const before = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
	const after = upsertEnvLine(before, "JOB_HUNTER_ME", toForwardSlashes(dir));
	if (after !== before) writeFileAtomic(envFile, after);
	process.env.JOB_HUNTER_ME = dir;
	return { envFile, changed: after !== before };
}

// --- init -------------------------------------------------------------------

export interface InitResult {
	dir: string;
	created: string[];
	overwritten: string[];
	skipped: string[];
	envFile: string;
	envUpdated: boolean;
}

export function defaultMeDir(): string {
	if (process.env.JOB_HUNTER_ME) return resolve(process.env.JOB_HUNTER_ME);
	// Same resolution order as core/paths meDir(): an existing <repo>/me wins.
	const loc = meDir();
	return loc.source === "repo" ? loc.path : join(jhHome(), "me");
}

/** Copy templates/me into `dir` (default <jhHome>/me) and point JOB_HUNTER_ME at it. */
export function initWorkspace(
	o: { dir?: string; force?: boolean; templatesDir?: string } = {},
): InitResult {
	const dir = resolve(o.dir ?? defaultMeDir());
	const src = o.templatesDir ?? templatesMeDir();
	const result: InitResult = {
		dir,
		created: [],
		overwritten: [],
		skipped: [],
		envFile: "",
		envUpdated: false,
	};
	for (const file of walk(src)) {
		const rel = workspaceRel(toForwardSlashes(relative(src, file)));
		const dest = join(dir, rel);
		const present = existsSync(dest);
		if (present && (!o.force || PROTECTED.has(rel))) {
			result.skipped.push(rel);
			continue;
		}
		ensureDir(dirname(dest));
		copyFileSync(file, dest);
		(present ? result.overwritten : result.created).push(rel);
	}
	for (const sub of [
		"sample-resume",
		"experience",
		"stories",
		".intake",
		".cache",
	])
		ensureDir(join(dir, sub));
	const env = writeMeEnv(dir);
	return { ...result, envFile: env.envFile, envUpdated: env.changed };
}

// --- status -------------------------------------------------------------------

const IntakeState = z.object({
	at: z.string(),
	files: z.record(z.string(), z.string()),
});
type IntakeState = z.infer<typeof IntakeState>;

function sha1(file: string): string {
	return createHash("sha1").update(readFileSync(file)).digest("hex");
}

/** The human-authored inputs that intake reads (relative, forward slashes). */
export function inputFiles(paths: MePaths): string[] {
	const root = paths.root;
	if (!existsSync(root)) return [];
	const top = [
		paths.readme,
		paths.profile,
		paths.preferences,
		paths.targets,
	].filter((f) => existsSync(f));
	const dirs = [
		paths.sampleResumeDir,
		paths.experienceDir,
		paths.storiesDir,
	].filter((d) => existsSync(d));
	const nested = dirs.flatMap((d) => walk(d));
	return [...top, ...nested]
		.map((f) => toForwardSlashes(relative(root, f)))
		.sort();
}

/** Snapshot input hashes into .intake/state.json after an ingest. */
export function writeIntakeState(paths: MePaths, now: Date): void {
	const files: Record<string, string> = {};
	for (const rel of inputFiles(paths)) files[rel] = sha1(join(paths.root, rel));
	const state: IntakeState = { at: now.toISOString(), files };
	writeFileAtomic(
		join(paths.intakeDir, INTAKE_STATE),
		`${JSON.stringify(state, null, 2)}\n`,
	);
}

function readIntakeState(paths: MePaths): IntakeState | null {
	const file = join(paths.intakeDir, INTAKE_STATE);
	if (!existsSync(file)) return null;
	const r = IntakeState.safeParse(JSON.parse(readFileSync(file, "utf8")));
	return r.success ? r.data : null;
}

/** True for a file intake should treat as the user's own content (not a guide or example). */
export function isUserContent(rel: string): boolean {
	const name = basename(rel);
	return name !== "README.md" && !name.startsWith("_") && !name.startsWith(".");
}

export interface MeStatus {
	root: string;
	exists: boolean;
	files: { rel: string; sha1: string; changed: boolean }[];
	lastIntake: string | null;
	missing: string[];
	/** Resumes dropped at the workspace root; they belong in sample-resume/. */
	misplaced: string[];
	needsIntake: boolean;
}

export function meStatus(paths: MePaths = mePaths()): MeStatus {
	const state = readIntakeState(paths);
	const files = inputFiles(paths).map((rel) => {
		const h = sha1(join(paths.root, rel));
		return { rel, sha1: h, changed: state?.files[rel] !== h };
	});
	const missing = ["profile.yaml", "preferences.md", "targets.md"].filter(
		(f) => !existsSync(join(paths.root, f)),
	);
	const has = (dir: string) =>
		files.some((f) => f.rel.startsWith(`${dir}/`) && isUserContent(f.rel));
	const misplaced = existsSync(paths.root)
		? readdirSync(paths.root, { withFileTypes: true })
				.filter((e) => e.isFile() && /\.(pdf|docx)$/i.test(e.name))
				.map((e) => e.name)
				.sort()
		: [];
	if (!has("sample-resume"))
		missing.push(
			misplaced.length
				? `sample-resume/<your resume>.pdf|docx|md (move ${misplaced.join(", ")} from the workspace root into sample-resume/)`
				: "sample-resume/<your resume>.pdf|docx|md",
		);
	if (!has("experience")) missing.push("experience/<employer-YYYY>.md");
	const removed = state
		? Object.keys(state.files).some((rel) => !files.some((f) => f.rel === rel))
		: false;
	return {
		root: paths.root,
		exists: existsSync(paths.root),
		files,
		lastIntake: state?.at ?? null,
		missing,
		misplaced,
		needsIntake:
			!state ||
			!existsSync(paths.masterResume) ||
			removed ||
			files.some((f) => f.changed && isUserContent(f.rel)),
	};
}

// --- validate -----------------------------------------------------------------

export interface WorkspaceIssue {
	file: string;
	path?: string;
	message: string;
}

export interface WorkspaceValidation {
	ok: boolean;
	errors: WorkspaceIssue[];
	warnings: WorkspaceIssue[];
}

function collect(file: string, fn: () => void, errors: WorkspaceIssue[]): void {
	try {
		fn();
	} catch (e) {
		const details = (e as { details?: unknown }).details;
		if (Array.isArray(details))
			for (const d of details as { path?: string; message: string }[])
				errors.push({ file, path: d.path, message: d.message });
		else errors.push({ file, message: (e as Error).message });
	}
}

function checkRoleIds(
	role: MasterRole,
	file: string,
	seen: Set<string>,
	errors: WorkspaceIssue[],
): void {
	const max = role.bullets.reduce(
		(n, b: MasterBullet) => Math.max(n, Number(b.id.split(".b")[1] ?? 0)),
		0,
	);
	if (role.next_bullet <= max)
		errors.push({
			file,
			path: role.id,
			message: `next_bullet ${role.next_bullet} must exceed b${max}`,
		});
	if (role.end !== "present" && role.end < role.start)
		errors.push({ file, path: role.id, message: "end is before start" });
	for (const b of role.bullets) {
		if (seen.has(b.id))
			errors.push({ file, path: b.id, message: "duplicate bullet id" });
		seen.add(b.id);
		if (!b.id.startsWith(`${role.id}.b`))
			errors.push({
				file,
				path: b.id,
				message: `bullet id must start with ${role.id}.b`,
			});
		for (const m of b.metrics) {
			if (seen.has(m.id))
				errors.push({ file, path: m.id, message: "duplicate metric id" });
			seen.add(m.id);
			if (!m.id.startsWith(`${b.id}.m`))
				errors.push({
					file,
					path: m.id,
					message: `metric id must start with ${b.id}.m`,
				});
		}
	}
}

function validateMaster(
	paths: MePaths,
	errors: WorkspaceIssue[],
): MasterResume | null {
	let master: MasterResume | null = null;
	collect(
		"master-resume.yaml",
		() => {
			master = readValidated(paths.masterResume, MasterResume, "master resume");
		},
		errors,
	);
	if (!master) return null;
	const m: MasterResume = master;
	const seen = new Set<string>();
	for (const role of m.roles) {
		if (seen.has(role.id))
			errors.push({
				file: "master-resume.yaml",
				path: role.id,
				message: "duplicate role id",
			});
		seen.add(role.id);
		checkRoleIds(role, "master-resume.yaml", seen, errors);
	}
	return m;
}

function markdownIn(dir: string): string[] {
	return existsSync(dir)
		? readdirSync(dir).filter((f) => f.endsWith(".md") && isUserContent(f))
		: [];
}

function validateExperience(
	paths: MePaths,
	errors: WorkspaceIssue[],
	warnings: WorkspaceIssue[],
): void {
	for (const f of markdownIn(paths.experienceDir)) {
		const file = `experience/${f}`;
		collect(
			file,
			() => {
				const doc = readFrontMatter(
					readFileSync(join(paths.experienceDir, f), "utf8"),
				);
				if (!doc.hasFrontMatter)
					throw new ValidationError("missing front matter");
				const r = ExperienceFrontMatter.safeParse(doc.data);
				if (!r.success)
					throw new ValidationError(
						"bad front matter",
						r.error.issues.map((i) => ({
							path: i.path.join("."),
							message: i.message,
						})),
					);
				for (const s of EXPERIENCE_SECTIONS)
					if (
						!new RegExp(
							`^##\\s+${s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`,
							"mi",
						).test(doc.body)
					)
						warnings.push({ file, message: `missing section "## ${s}"` });
			},
			errors,
		);
	}
}

function validateStories(
	paths: MePaths,
	master: MasterResume | null,
	errors: WorkspaceIssue[],
): void {
	const roleIds = new Set(master?.roles.map((r) => r.id) ?? []);
	const bulletIds = new Set(
		master?.roles.flatMap((r) => r.bullets.map((b) => b.id)) ?? [],
	);
	for (const f of markdownIn(paths.storiesDir)) {
		const file = `stories/${f}`;
		collect(
			file,
			() => {
				const doc = readFrontMatter(
					readFileSync(join(paths.storiesDir, f), "utf8"),
				);
				const fm = StoryFrontMatter.parse(doc.data ?? {});
				if (master && !roleIds.has(fm.role_id))
					throw new ValidationError(`unknown role_id ${fm.role_id}`);
				for (const b of fm.bullet_ids)
					if (master && !bulletIds.has(b))
						errors.push({
							file,
							path: "bullet_ids",
							message: `unknown bullet id ${b}`,
						});
			},
			errors,
		);
	}
}

/** Schema and id checks across the whole workspace. */
export function validateWorkspace(
	paths: MePaths = mePaths(),
): WorkspaceValidation {
	const errors: WorkspaceIssue[] = [];
	const warnings: WorkspaceIssue[] = [];
	if (!existsSync(paths.root))
		throw new NotFoundError(`me/ workspace not found: ${paths.root}`);
	collect(
		"profile.yaml",
		() => readValidated(paths.profile, Profile, "profile"),
		errors,
	);
	const master = existsSync(paths.masterResume)
		? validateMaster(paths, errors)
		: null;
	if (!master)
		warnings.push({
			file: "master-resume.yaml",
			message: "no master resume yet; run /intake",
		});
	if (existsSync(paths.confirmedMetrics))
		collect(
			"confirmed-metrics.yaml",
			() =>
				readValidated(
					paths.confirmedMetrics,
					ConfirmedMetrics,
					"confirmed metrics",
				),
			errors,
		);
	validateExperience(paths, errors, warnings);
	validateStories(paths, master, errors);
	return { ok: errors.length === 0, errors, warnings };
}

// --- migrate ------------------------------------------------------------------

const LegacyResume = z.object({
	summary: z.string().optional(),
	roles: z
		.array(
			z.object({
				employer: z.string(),
				title: z.string(),
				start: z.string().regex(/^\d{4}-\d{2}$/),
				end: z.string(),
				location: z.string().optional(),
				bullets: z
					.array(
						z.object({
							text: z.string(),
							skills: z.array(z.string()).default([]),
							fields: z.array(z.string()).default([]),
							metrics: z.array(z.string()).default([]),
						}),
					)
					.default([]),
			}),
		)
		.default([]),
	education: z
		.array(
			z.object({
				school: z.string(),
				degree: z.string(),
				field: z.string(),
				year: z.coerce.string(),
			}),
		)
		.default([]),
	certifications: z
		.array(
			z.object({
				name: z.string(),
				issuer: z.string().optional(),
				year: z.coerce.string().optional(),
			}),
		)
		.default([]),
});

/** Convert the v0.1 ~/.job-hunter/resume.yaml shape into a v1 master resume with fresh stable ids. */
export function convertLegacyResume(raw: unknown): MasterResume {
	const legacy = LegacyResume.parse(raw ?? {});
	const taken = new Set<string>();
	const roles: MasterRole[] = legacy.roles.map((r) => {
		let id = `${slug(r.employer)}-${r.start.slice(0, 4)}`;
		for (let n = 2; taken.has(id); n++)
			id = `${slug(r.employer)}-${r.start.slice(0, 4)}-${n}`;
		taken.add(id);
		const bullets: MasterBullet[] = r.bullets.map((b, i) => {
			const bid = `${id}.b${String(i + 1).padStart(2, "0")}`;
			return {
				id: bid,
				text: b.text,
				skills: b.skills,
				fields: b.fields,
				source_refs: ["legacy:resume.yaml"],
				metrics: b.metrics.map((m, j) => ({
					id: `${bid}.m${j + 1}`,
					phrase: m,
					value: m,
					status: "fact" as const,
					source_ref: "legacy:resume.yaml",
				})),
			};
		});
		const end = r.end.trim().toLowerCase() === "present" ? "present" : r.end;
		return {
			id,
			kind: "role" as const,
			employer: r.employer,
			title: r.title,
			start: r.start,
			end,
			...(r.location ? { location: r.location } : {}),
			next_bullet: bullets.length + 1,
			bullets,
		};
	});
	return MasterResume.parse({
		version: 1,
		summary_seeds: legacy.summary ? [legacy.summary] : [],
		skills: [],
		roles,
		education: legacy.education,
		certifications: legacy.certifications,
	});
}

export interface MigrateResult {
	dir: string;
	copied: string[];
	converted: string[];
	skipped: string[];
}

/** Move v0.1 files from <jhHome> into the me/ workspace. Originals are kept (copied to .intake/legacy/). */
export function migrateLegacy(paths: MePaths): MigrateResult {
	const home = jhHome();
	const result: MigrateResult = {
		dir: paths.root,
		copied: [],
		converted: [],
		skipped: [],
	};
	const legacyProfile = join(home, "profile.yaml");
	const legacyResume = join(home, "resume.yaml");
	if (!existsSync(legacyProfile) && !existsSync(legacyResume))
		throw new NotFoundError(`no legacy profile.yaml or resume.yaml in ${home}`);
	if (resolve(paths.root) === resolve(home))
		throw new ConflictError(
			"me/ resolves to the legacy home; run `jh me init --dir <path>` first",
		);
	const backup = ensureDir(join(paths.intakeDir, "legacy"));
	if (existsSync(legacyProfile)) {
		copyFileSync(legacyProfile, join(backup, "profile.yaml"));
		if (
			existsSync(paths.profile) &&
			statSync(paths.profile).size > 0 &&
			!isTemplateProfile(paths.profile)
		)
			result.skipped.push("profile.yaml");
		else {
			copyFileSync(legacyProfile, paths.profile);
			result.copied.push("profile.yaml");
		}
	}
	if (existsSync(legacyResume)) {
		copyFileSync(legacyResume, join(backup, "resume.yaml"));
		if (existsSync(paths.masterResume) && hasRoles(paths.masterResume))
			result.skipped.push("master-resume.yaml");
		else {
			saveMaster(
				convertLegacyResume(parseYaml(readFileSync(legacyResume, "utf8"))),
				paths,
			);
			result.converted.push("resume.yaml -> master-resume.yaml");
		}
	}
	return result;
}

function isTemplateProfile(file: string): boolean {
	const raw = parseYaml(readFileSync(file, "utf8")) as {
		identity?: { name?: string };
	} | null;
	return !raw?.identity?.name;
}

function hasRoles(file: string): boolean {
	const raw = parseYaml(readFileSync(file, "utf8")) as {
		roles?: unknown[];
	} | null;
	return Array.isArray(raw?.roles) && raw.roles.length > 0;
}
