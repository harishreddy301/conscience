import { Command } from "commander";
import { register as registerApp } from "./commands/app.js";
import { register as registerAts } from "./commands/ats.js";
import { register as registerAutopilot } from "./commands/autopilot.js";
import { register as registerCover } from "./commands/cover.js";
import { register as registerDashboard } from "./commands/dashboard.js";
import { register as registerDoctor } from "./commands/doctor.js";
import { register as registerEmail } from "./commands/email.js";
import { register as registerInterview } from "./commands/interview.js";
import { register as registerJd } from "./commands/jd.js";
import { register as registerLearn } from "./commands/learn.js";
import { register as registerMe } from "./commands/me.js";
import { register as registerMetrics } from "./commands/metrics.js";
import { register as registerPolicy } from "./commands/policy.js";
import { register as registerResume } from "./commands/resume.js";
import { register as registerStudy } from "./commands/study.js";
import { register as registerSync } from "./commands/sync.js";
import { loadEnv } from "./core/env.js";
import { discoverCareers } from "./sources/exa.js";

// Must run before any meDir()/dbPath() call (contracts §0).
loadEnv();
const program = new Command();

program
	.name("jh")
	.description(
		"conscience: deterministic job-hunt engine used by the plugin's agents",
	)
	.version("0.1.0");

for (const register of [
	registerDoctor,
	registerApp,
	registerMe,
	registerMetrics,
	registerResume,
	registerAts,
	registerJd,
	registerCover,
	registerEmail,
	registerInterview,
	registerStudy,
	registerSync,
	registerDashboard,
	registerLearn,
	registerPolicy,
	registerAutopilot,
]) {
	register(program);
}

program
	.command("discover <company>")
	.description(
		"find where a company posts jobs and which ATS serves them (uses Exa)",
	)
	.option("--json", "machine-readable output")
	.action(async (company: string, opts: { json?: boolean }) => {
		const found = await discoverCareers(company);
		if (opts.json) return console.log(JSON.stringify(found));
		for (const b of found.boards) {
			console.log(
				`${b.ats.padEnd(16)} ${b.tenant}${b.site ? `/${b.site}` : ""}  ${b.url}`,
			);
		}
		for (const p of found.otherPages)
			console.log(`${"(unknown)".padEnd(16)} ${p}`);
		if (!found.boards.length) process.exitCode = 1;
	});

await program.parseAsync();
