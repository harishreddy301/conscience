export type AtsId =
	| "greenhouse"
	| "lever"
	| "ashby"
	| "workday"
	| "eightfold"
	| "smartrecruiters"
	| "workable"
	| "recruitee";

export interface TenantRef {
	ats: AtsId;
	tenant: string;
	/** Workday career-site name, e.g. "External" in ms.wd5.myworkdayjobs.com/External */
	site?: string;
	url: string;
}

const PATTERNS: Array<{ ats: AtsId; re: RegExp }> = [
	{
		ats: "greenhouse",
		re: /^(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([\w-]+)/i,
	},
	{
		ats: "greenhouse",
		re: /^boards-api\.greenhouse\.io\/v1\/boards\/([\w-]+)/i,
	},
	{ ats: "lever", re: /^jobs(?:\.eu)?\.lever\.co\/([\w.-]+)/i },
	{ ats: "ashby", re: /^jobs\.ashbyhq\.com\/([\w.%-]+)/i },
	{ ats: "eightfold", re: /^([\w-]+)\.eightfold\.ai/i },
	{
		ats: "smartrecruiters",
		re: /^(?:jobs|careers)\.smartrecruiters\.com\/([\w-]+)/i,
	},
	{ ats: "workable", re: /^apply\.workable\.com\/([\w-]+)/i },
	{ ats: "recruitee", re: /^([\w-]+)\.recruitee\.com/i },
];

const WORKDAY =
	/^([\w-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([\w-]+)/;

/** Map a careers URL to the ATS and tenant that serve it, or null if unrecognised. */
export function detectAts(rawUrl: string): TenantRef | null {
	const hostPath = rawUrl.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
	const wd = hostPath.match(WORKDAY);
	if (wd?.[1] && wd[3]) {
		return {
			ats: "workday",
			tenant: wd[1],
			site: wd[3],
			url: `https://${wd[1]}.${wd[2]}.myworkdayjobs.com/${wd[3]}`,
		};
	}
	for (const { ats, re } of PATTERNS) {
		const m = hostPath.match(re);
		if (m?.[1]) return { ats, tenant: m[1].toLowerCase(), url: rawUrl };
	}
	return null;
}
