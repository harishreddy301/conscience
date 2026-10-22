import type { EffectivePolicy } from "./load.js";
import { type GateRule, HM_VERDICTS, type HmVerdict } from "./schema.js";
import { trackOf } from "./triage.js";

/**
 * The submit gate from the policy (ADR-005): the resume loop's numbers, with
 * per-track relaxations (e.g. FDE accepts an HM "maybe" at ATS 80+). The fact
 * check must pass and, when `gates.layout.required`, so must the layout gate.
 */

export interface PolicyGateInput {
	title: string;
	ats: number | null;
	hm_verdict: string | null;
	recruiter_passes: number | null;
	valid: boolean | null;
	factcheck: "pass" | "fail" | "none";
	layout_pass: boolean | null;
}

export interface PolicyGateResult {
	pass: boolean;
	track: string | null;
	rule: GateRule;
	reasons: string[];
}

export function ruleFor(e: EffectivePolicy, track: string | null): GateRule {
	const g = e.policy.gates;
	const t = track ? g.by_track[track] : undefined;
	return { ...g.default, ...(t ?? {}) } as GateRule;
}

function isVerdict(v: string | null): v is HmVerdict {
	return v !== null && (HM_VERDICTS as readonly string[]).includes(v);
}

export function policyGate(
	e: EffectivePolicy,
	input: PolicyGateInput,
): PolicyGateResult {
	const track = trackOf(input.title, e.policy.tracks);
	const rule = ruleFor(e, track);
	const reasons: string[] = [];
	if (input.valid === false) reasons.push("resume fails jh resume validate");
	if (input.factcheck !== "pass")
		reasons.push(`fact check is ${input.factcheck}, needs pass`);
	if (input.ats === null) reasons.push("no ATS score");
	else if (input.ats < rule.ats_min)
		reasons.push(`ATS ${input.ats} is below ${rule.ats_min}`);
	if (!isVerdict(input.hm_verdict)) reasons.push("no hiring-manager verdict");
	else if (!rule.verdicts.includes(input.hm_verdict))
		reasons.push(
			`hiring-manager verdict "${input.hm_verdict}" is not one of ${rule.verdicts.join("|")}${track ? ` for track ${track}` : ""}`,
		);
	if (rule.recruiter_min !== undefined) {
		if (input.recruiter_passes === null)
			reasons.push("no recruiter-screen result");
		else if (input.recruiter_passes < rule.recruiter_min)
			reasons.push(
				`recruiter-screen ${input.recruiter_passes}/8, needs ${rule.recruiter_min}`,
			);
	}
	if (e.policy.gates.layout.required && input.layout_pass !== true)
		reasons.push(
			input.layout_pass === false
				? "layout gate failed"
				: "no layout gate result",
		);
	return { pass: reasons.length === 0, track, rule, reasons };
}
