import { describe, expect, it } from "vitest";
import { detectAts } from "../../src/adapters/detect.js";

describe("detectAts", () => {
	it.each([
		[
			"https://morganstanley.eightfold.ai/careers",
			"eightfold",
			"morganstanley",
			undefined,
		],
		["https://ms.wd5.myworkdayjobs.com/External", "workday", "ms", "External"],
		[
			"https://ms.wd5.myworkdayjobs.com/en-US/External/job/123",
			"workday",
			"ms",
			"External",
		],
		["https://boards.greenhouse.io/stripe", "greenhouse", "stripe", undefined],
		[
			"https://job-boards.greenhouse.io/anthropic/jobs/1",
			"greenhouse",
			"anthropic",
			undefined,
		],
		["https://jobs.lever.co/palantir/abc", "lever", "palantir", undefined],
		["https://jobs.ashbyhq.com/openai", "ashby", "openai", undefined],
		[
			"https://jobs.smartrecruiters.com/Visa",
			"smartrecruiters",
			"visa",
			undefined,
		],
		["https://apply.workable.com/acme/", "workable", "acme", undefined],
	])("%s → %s/%s", (url, ats, tenant, site) => {
		expect(detectAts(url)).toMatchObject({
			ats,
			tenant,
			...(site ? { site } : {}),
		});
	});

	it("returns null for unknown sites", () => {
		expect(detectAts("https://www.morganstanley.com/careers")).toBeNull();
	});
});
