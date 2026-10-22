import { readFileSync } from "node:fs";
import { JdKeywords } from "../ats/keywords.js";
import { ATS_PASS, type AtsReport, scoreResume } from "../ats/score.js";
import { NotFoundError, ValidationError } from "../core/errors.js";
import type { Db } from "../db/index.js";
import {
	getDraft,
	getRun,
	listReviews,
	type ResumeDraftRow,
	type ResumeRunRow,
} from "../db/resume.js";
import { loadMaster, loadProfile } from "../me/load.js";
import type { MasterResume, Profile } from "../me/schema.js";
import {
	type GateResult,
	latestByReviewer,
	type ReviewReport,
	recruiterPasses,
} from "./review.js";
import { TailoredResume } from "./schema.js";
import { type ValidationResult, validateTailored } from "./validate.js";

export const RECRUITER_MIN_PASSES = 6;

export interface GateInput {
	ats: number;
	valid: boolean;
	reviews: readonly ReviewReport[];
}

/** Pure gate: ats >= 80, HM "interview", recruiter passes >= 6, valid. */
export function evaluateGate(input: GateInput): GateResult {
	const latest = latestByReviewer(input.reviews);
	const hm = latest["hiring-manager"]?.verdict ?? null;
	const recruiter = recruiterPasses(latest["recruiter-screen"]);
	const fc = latest["fact-checker"]?.verdict;
	const factcheck = fc === "pass" ? "pass" : fc === "fail" ? "fail" : "none";
	const reasons: string[] = [];
	if (!input.valid) reasons.push("draft fails jh resume validate");
	if (input.ats < ATS_PASS)
		reasons.push(`ATS score ${input.ats} is below ${ATS_PASS}`);
	if (hm === null) reasons.push("no hiring-manager review yet");
	else if (hm !== "interview")
		reasons.push(`hiring-manager verdict is "${hm}", needs "interview"`);
	if (!latest["recruiter-screen"])
		reasons.push("no recruiter-screen review yet");
	else if (recruiter < RECRUITER_MIN_PASSES)
		reasons.push(
			`recruiter-screen passes ${recruiter}/8, needs ${RECRUITER_MIN_PASSES}`,
		);
	return {
		pass: reasons.length === 0,
		ats: input.ats,
		hm_verdict: hm,
		recruiter_passes: recruiter,
		valid: input.valid,
		factcheck,
		reasons,
	};
}

export interface MeData {
	master: MasterResume;
	profile?: Profile;
}

/** Load master and (optionally) profile from the active me/ workspace. */
export function loadMe(): MeData {
	const master = loadMaster();
	let profile: Profile | undefined;
	try {
		profile = loadProfile();
	} catch (e) {
		if (!(e instanceof NotFoundError)) throw e;
	}
	return { master, profile };
}

export function requireRun(db: Db, runId: string): ResumeRunRow {
	const run = getRun(db, runId);
	if (!run) throw new NotFoundError(`resume run ${runId} not found`, { runId });
	return run;
}

export function requireDraft(
	db: Db,
	runId: string,
	draftId: string,
): ResumeDraftRow {
	const d = getDraft(db, runId, draftId);
	if (!d)
		throw new NotFoundError(
			`draft ${draftId} is not registered on run ${runId}; run jh resume validate <draft.json> first`,
			{ runId, draftId },
		);
	return d;
}

/** Read and schema-parse a draft file. */
export function readDraft(path: string): TailoredResume {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		throw new NotFoundError(`draft file not found: ${path}`, { path });
	}
	let json: unknown;
	try {
		json = JSON.parse(raw.replace(/^﻿/, ""));
	} catch (e) {
		throw new ValidationError(
			`invalid JSON in ${path}: ${(e as Error).message}`,
		);
	}
	return TailoredResume.parse(json);
}

export function runKeywords(run: ResumeRunRow): JdKeywords | null {
	if (!run.keywords_json) return null;
	return JdKeywords.parse(JSON.parse(run.keywords_json));
}

export interface DraftAssessment {
	draft: TailoredResume;
	validation: ValidationResult;
	ats: AtsReport | null;
	atsScore: number;
	reviews: ReviewReport[];
	gate: GateResult;
}

/**
 * Score a registered draft now: validate against me/, ATS-score it with the
 * run's keywords (falling back to the latest ats-screener score), and apply
 * the gate to its reviews.
 */
export function assessDraft(
	db: Db,
	runId: string,
	draftId: string,
	me: MeData = loadMe(),
	rendered?: { html: string; text: string; docxXml?: string },
): DraftAssessment {
	const run = requireRun(db, runId);
	const row = requireDraft(db, runId, draftId);
	const draft = readDraft(row.path);
	const validation = validateTailored(draft, me.master, me.profile);
	const kw = runKeywords(run);
	const ats = kw ? scoreResume(draft, kw, rendered, me.profile) : null;
	const reviews = listReviews(db, runId, draftId);
	const screener = latestByReviewer(reviews)["ats-screener"];
	const atsScore = ats?.total ?? screener?.score ?? 0;
	const gate = evaluateGate({ ats: atsScore, valid: validation.ok, reviews });
	if (!ats && !screener)
		gate.reasons.push(
			"no keywords set (jh ats keywords set) and no ats-screener review",
		);
	return {
		draft,
		validation,
		ats,
		atsScore,
		reviews,
		gate: { ...gate, pass: gate.pass && gate.reasons.length === 0 },
	};
}
