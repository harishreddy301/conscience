import type { EffectivePolicy } from "./load.js";
import { REQUIRED_ESCALATE_KINDS } from "./load.js";
import { deepEqual, getIn, splitPath } from "./ops.js";

export interface PolicyIssue {
	code: string;
	message: string;
	path?: string;
}

export interface PolicyCheck {
	ok: boolean;
	rev: number;
	path: string;
	exists: boolean;
	conflicts: PolicyIssue[];
	warnings: PolicyIssue[];
}

/**
 * Consistency checks (pure). Conflicts: a hand edit that a correction
 * overrides, a profile mirror that disagrees, an escalate kind removed by
 * someone other than the user, a standing approval not set by the user, an
 * unknown track. Warnings: softer drift (e.g. two daily caps).
 */
export function checkPolicy(e: EffectivePolicy): PolicyCheck {
	const conflicts: PolicyIssue[] = [];
	const warnings: PolicyIssue[] = [];
	const p = e.policy;
	const corr = p.corrections;

	// Corrections: increasing revs, rev at least the last one.
	let last = 0;
	for (const c of corr) {
		if (c.rev <= last)
			conflicts.push({
				code: "corrections_not_append_only",
				message: `correction rev ${c.rev} follows rev ${last}`,
			});
		last = Math.max(last, c.rev);
		if (c.actor === "user" && !c.quote)
			warnings.push({
				code: "user_correction_without_quote",
				message: `rev ${c.rev} is attributed to the user without a quote`,
			});
	}
	if (e.file.rev < last)
		conflicts.push({
			code: "rev_behind_corrections",
			message: `rev ${e.file.rev} is behind the last correction (rev ${last})`,
		});

	// Hand edits that the corrections replay overrides.
	const touched = new Set(corr.flatMap((c) => c.ops.map((o) => o.path)));
	for (const path of touched) {
		const parts = splitPath(path);
		const a = getIn(e.file, parts);
		const b = getIn(p, parts);
		if (!deepEqual(a, b))
			conflicts.push({
				code: "hand_edit_overridden",
				path,
				message: `${path} in the file differs from the recorded corrections; the corrections win (use jh policy record)`,
			});
	}

	// Escalate kinds: only the user can remove one.
	const missing = REQUIRED_ESCALATE_KINDS.filter(
		(k) => !p.escalate.kinds.includes(k),
	);
	if (missing.length) {
		const userRemoved = corr.some(
			(c) =>
				c.actor === "user" && c.ops.some((o) => o.path.startsWith("escalate")),
		);
		(userRemoved ? warnings : conflicts).push({
			code: "escalate_kind_missing",
			path: "escalate.kinds",
			message: `escalate kinds missing: ${missing.join(", ")}${userRemoved ? " (removed by the user)" : " (not removed by the user)"}`,
		});
	}

	// Standing approval: user-set, mirrored in profile.yaml.
	if (p.submit.confirm === "standing") {
		const bySubmit = corr.filter((c) =>
			c.ops.some((o) => o.path === "submit" || o.path.startsWith("submit.")),
		);
		const lastSubmit = bySubmit.at(-1);
		if (lastSubmit?.actor !== "user")
			conflicts.push({
				code: "standing_not_user_set",
				path: "submit.confirm",
				message:
					"submit.confirm is standing but no user correction set it (record it with --actor user --quote)",
			});
	}
	const mirror = e.derived.submit_without_confirm;
	if (mirror !== null && mirror !== (p.submit.confirm === "standing"))
		conflicts.push({
			code: "submit_mirror_mismatch",
			path: "submit.confirm",
			message: `profile.yaml autonomy.submit_without_confirm is ${mirror} but submit.confirm is ${p.submit.confirm}`,
		});

	// Track references.
	const tracks = new Set(Object.keys(p.tracks));
	for (const t of p.triage.titles.exclude_tracks)
		if (!tracks.has(t))
			conflicts.push({
				code: "unknown_track",
				path: "triage.titles.exclude_tracks",
				message: `track "${t}" is not defined under tracks`,
			});
	for (const t of Object.keys(p.gates.by_track))
		if (!tracks.has(t))
			conflicts.push({
				code: "unknown_track",
				path: "gates.by_track",
				message: `track "${t}" is not defined under tracks`,
			});

	// Overrides: one per application.
	const ids = p.eligibility.overrides.map((o) => o.app_id);
	const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
	if (dup.length)
		conflicts.push({
			code: "duplicate_override",
			path: "eligibility.overrides",
			message: `more than one override for app ${[...new Set(dup)].join(", ")}`,
		});

	// Softer drift.
	const cap = p.preflight.daily_cap;
	if (
		cap !== undefined &&
		e.derived.daily_cap !== null &&
		cap !== e.derived.daily_cap
	)
		warnings.push({
			code: "daily_cap_differs",
			path: "preflight.daily_cap",
			message: `policy daily_cap ${cap} differs from profile autonomy.daily_apply_cap ${e.derived.daily_cap}; the policy wins`,
		});
	if (!e.exists)
		warnings.push({
			code: "no_policy_file",
			message: `${e.path} does not exist; defaults apply (copy templates/me/decision-policy.example.yaml)`,
		});

	return {
		ok: conflicts.length === 0,
		rev: e.rev,
		path: e.path,
		exists: e.exists,
		conflicts,
		warnings,
	};
}
