import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { countKeyword, tokens } from "../ats/keywords.js";
import { type AtsReport, scoreResume } from "../ats/score.js";
import { audit } from "../core/audit.js";
import {
	ConflictError,
	IllegalTransitionError,
	NotFoundError,
	ValidationError,
} from "../core/errors.js";
import { artifactsDir, ensureDir } from "../core/paths.js";
import { type AppStatus, transition } from "../core/state.js";
import { type Db, tx } from "../db/index.js";
import { getJdSnapshot } from "../db/jd.js";
import { recordVariant } from "../db/learn.js";
import { getApplication, setArtifactsDir } from "../db/repo.js";
import { finalizeRun, type Quality, upsertDraft } from "../db/resume.js";
import { variantFromResume } from "../learn/features.js";
import {
	docxDocumentXml,
	type Format,
	type LayoutGateResult,
	layoutGate,
	layoutSpecFrom,
	type RenderResult,
	renderAll,
	renderHtml,
	renderText,
} from "../render/index.js";
import {
	assessDraft,
	evaluateGate,
	loadMe,
	type MeData,
	requireDraft,
	requireRun,
	runKeywords,
} from "./gate.js";
import {
	type GateResult,
	latestByReviewer,
	mergedFixes,
	type ReviewReport,
} from "./review.js";
import { allBullets, allRoles, type TailoredResume } from "./schema.js";

export const FINAL_FORMATS: readonly Format[] = ["html", "pdf", "docx", "txt"];
const FINALIZABLE: ReadonlySet<AppStatus> = new Set([
	"discovered",
	"shortlisted",
	"tailored",
]);
const ACTOR = "jh resume finalize";

export interface FinalizeOptions {
	runId: string;
	draftId: string;
	quality?: Quality;
	formats?: Format[];
	me?: MeData;
}

export interface FinalizeResult {
	run_id: string;
	app_id: number;
	draft_id: string;
	artifacts_dir: string;
	files: Record<string, string>;
	ats: number;
	quality: Quality;
	gate: GateResult;
	pages: number | null;
	warnings: string[];
	status: AppStatus;
	layout: LayoutGateResult;
}

/** {bullet_id: source_ids[]} plus the summary's sources. */
export function provenanceOf(r: TailoredResume): Record<string, string[]> {
	const out: Record<string, string[]> = { summary: r.summary.source_ids };
	for (const b of allBullets(r)) out[b.id] = b.source_ids;
	return out;
}

function writeJson(path: string, data: unknown): string {
	writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	return path;
}

function assertFinalizable(db: Db, runId: string, appId: number): AppStatus {
	const app = getApplication(db, appId);
	if (!app)
		throw new NotFoundError(`application ${appId} not found`, { appId, runId });
	if (!FINALIZABLE.has(app.status))
		throw new IllegalTransitionError(
			`application ${appId} is ${app.status}; only discovered, shortlisted or tailored applications can be finalized`,
			{ appId, status: app.status },
		);
	return app.status;
}

function requireFactcheck(reviews: readonly ReviewReport[]): ReviewReport {
	const fc = latestByReviewer(reviews)["fact-checker"];
	if (fc?.verdict !== "pass")
		throw new ValidationError(
			fc
				? `fact-checker verdict is "${fc.verdict}"; finalize needs a passing fact-check`
				: "no fact-checker review; run the fact-checker and jh resume review add first",
			{ factcheck: fc ?? null },
			"factcheck_required",
		);
	return fc;
}

function renderedViews(r: TailoredResume, render: RenderResult) {
	const read = (f?: string) =>
		f && existsSync(f) ? readFileSync(f, "utf8") : undefined;
	const docx = render.files.docx;
	return {
		html: read(render.files.html) ?? renderHtml(r),
		text: read(render.files.txt) ?? renderText(r),
		docxXml:
			docx && existsSync(docx)
				? docxDocumentXml(readFileSync(docx))
				: undefined,
	};
}

/** Copy renders into the application folder under their final names. */
function placeArtifacts(
	r: TailoredResume,
	render: RenderResult,
	dir: string,
): Record<string, string> {
	const files: Record<string, string> = {
		json: writeJson(join(dir, "resume.json"), r),
	};
	for (const [fmt, src] of Object.entries(render.files)) {
		if (!src || !existsSync(src)) continue;
		const generic = join(dir, `resume.${fmt}`);
		copyFileSync(src, generic);
		files[fmt] = generic;
		if (fmt === "pdf" || fmt === "docx") {
			const named = join(dir, basename(src));
			if (named !== generic) copyFileSync(src, named);
			files[`${fmt}_named`] = named;
		}
	}
	return files;
}

function variantKeywords(
	r: TailoredResume,
	ats: AtsReport | null,
	kwTerms: string[],
) {
	if (!ats) return [...new Set(allBullets(r).flatMap((b) => b.keywords))];
	const all = tokens(
		allRoles(r)
			.flatMap((x) => x.bullets.map((b) => b.text))
			.concat(
				r.summary.text,
				r.basics.headline,
				...r.skills.flatMap((g) => g.items),
			)
			.join(" | "),
	);
	return kwTerms.filter((t) => countKeyword(all, { term: t }) > 0);
}

function moveToTailored(db: Db, appId: number, from: AppStatus, runId: string) {
	const detail = { run_id: runId };
	if (from === "discovered")
		transition(db, appId, "shortlisted", { actor: ACTOR, detail });
	if (from !== "tailored")
		transition(db, appId, "tailored", { actor: ACTOR, detail });
}

/**
 * Finalize a run: refuse unless the draft validates and the fact-checker
 * passed; render; write resume.* plus provenance/ats/review/factcheck JSON to
 * <artifacts>/<app>/; record the variant for outcome learning; and move the
 * application to `tailored`.
 */
export async function finalizeResume(
	db: Db,
	o: FinalizeOptions,
): Promise<FinalizeResult> {
	const run = requireRun(db, o.runId);
	if (run.status !== "running")
		throw new ConflictError(
			`run ${run.id} is already ${run.status}`,
			{ status: run.status },
			"run_not_running",
		);
	const me = o.me ?? loadMe();
	const a = assessDraft(db, o.runId, o.draftId, me);
	if (!a.validation.ok)
		throw new ValidationError(
			`draft ${o.draftId} fails validation (${a.validation.errors.length} errors)`,
			{ errors: a.validation.errors },
			"validation_failed",
		);
	const fact = requireFactcheck(a.reviews);
	const appId = run.application_id;
	const fromStatus = assertFinalizable(db, run.id, appId);

	const dir = ensureDir(artifactsDir(appId));
	const stage = ensureDir(join(run.workdir, "render", "final"));
	const render = await renderAll(
		a.draft,
		stage,
		o.formats ?? [...FINAL_FORMATS],
	);
	const wantFormats = o.formats ?? [...FINAL_FORMATS];
	if (wantFormats.includes("pdf") && !render.files.pdf) {
		// Leave the run `running` so finalize can be retried once Chrome works.
		throw new ValidationError(
			"PDF rendering failed; the run stays open so finalize can be retried",
			{ warnings: render.warnings },
			"pdf_failed",
		);
	}
	// Layout gate (user spec): page count, 2-line bullets with 60-80% last
	// lines, one-line skills/Environment/publication rows, a full last page,
	// per-role bullet counts, no em dash. A failing layout never ships.
	const layout = await layoutGate(a.draft, {
		spec: layoutSpecFrom(me.profile),
		density: render.density,
		pdfPath: render.files.pdf,
	});
	if (!layout.pass)
		throw new ValidationError(
			`layout gate failed (${layout.failures.length} issue(s)): ${layout.failures
				.slice(0, 3)
				.map((f) => `${f.code} ${f.path}`)
				.join("; ")}`,
			{ layout },
			"layout_gate_failed",
		);
	const kw = runKeywords(run);
	const ats = kw
		? scoreResume(a.draft, kw, renderedViews(a.draft, render), me.profile)
		: null;
	const atsScore = ats?.total ?? a.atsScore;
	const gate = evaluateGate({ ats: atsScore, valid: true, reviews: a.reviews });
	const fits = render.overflow_lines === undefined;
	const quality: Quality =
		o.quality ?? (gate.pass && fits ? "ok" : "below_bar");

	const files = placeArtifacts(a.draft, render, dir);
	files.provenance = writeJson(
		join(dir, "provenance.json"),
		provenanceOf(a.draft),
	);
	files.ats = writeJson(
		join(dir, "ats.json"),
		ats ?? { total: atsScore, source: "ats-screener" },
	);
	files.review = writeJson(join(dir, "review.json"), {
		run_id: run.id,
		draft_id: o.draftId,
		quality,
		gate,
		reviews: latestByReviewer(a.reviews),
		open_fixes: mergedFixes(a.reviews),
	});
	files.factcheck = writeJson(join(dir, "factcheck.json"), fact);
	files.layout = writeJson(join(dir, "layout.json"), layout);

	const kwTerms = kw
		? [...kw.required, ...kw.preferred].map((k) => k.term)
		: [];
	const hm = gate.hm_verdict;
	tx(db, () => {
		upsertDraft(db, {
			run_id: run.id,
			id: o.draftId,
			angle: a.draft.angle,
			iteration: a.draft.iteration,
			path: requireDraft(db, run.id, o.draftId).path,
			ats_score: atsScore,
			valid: true,
		});
		finalizeRun(db, run.id, {
			final_draft_id: o.draftId,
			ats_score: atsScore,
			hm_verdict: hm,
			quality,
			iterations: Math.max(run.iterations, a.draft.iteration),
		});
		setArtifactsDir(db, appId, dir);
		const app = getApplication(db, appId);
		recordVariant(
			db,
			appId,
			// Bucketed features (framing class, phrasing tags, role family) so
			// values repeat across applications and analysis can reach n>=3.
			variantFromResume(a.draft, {
				ats_score: Math.max(0, Math.min(100, Math.round(atsScore))),
				pages: render.pages ?? a.draft.layout.pages,
				source: app?.source ?? null,
				keywords: variantKeywords(a.draft, ats, kwTerms),
				posted_title: getJdSnapshot(db, appId)?.title_posted ?? null,
			}),
		);
		moveToTailored(db, appId, fromStatus, run.id);
	});
	audit({
		actor: ACTOR,
		action: "resume.finalize",
		target: `application:${appId}`,
		detail: {
			run_id: run.id,
			draft_id: o.draftId,
			ats: atsScore,
			quality,
			dir,
		},
	});
	return {
		run_id: run.id,
		app_id: appId,
		draft_id: o.draftId,
		artifacts_dir: dir,
		files,
		ats: atsScore,
		quality,
		gate,
		pages: render.pages,
		warnings: render.warnings,
		status: "tailored",
		layout,
	};
}
