import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { register } from "../../src/commands/metrics.js";
import { NotFoundError, ValidationError } from "../../src/core/errors.js";
import { ingestDraft } from "../../src/me/ingest.js";
import { loadMaster } from "../../src/me/load.js";
import {
	decideMetric,
	listMetrics,
	loadLedger,
	pendingMetricCount,
	proposeMetrics,
	renderMetricsMd,
} from "../../src/me/metrics.js";
import type { MetricProposal } from "../../src/me/schema.js";
import {
	loadDraft,
	runCli,
	type TempWorkspace,
	tempWorkspace,
} from "../fixtures/me/helpers.js";

const ACME = "acme-analytics-2022";
const B1 = `${ACME}.b01`;
const B2 = `${ACME}.b02`;
const NOW = new Date("2026-03-01T12:00:00.000Z");

function proposal(
	bullet_id: string,
	value: string,
	extra: Partial<MetricProposal> = {},
): MetricProposal {
	return {
		bullet_id,
		phrase: `about ${value} saved`,
		value,
		derivation: "10 analysts x 2 h/week from the README Team & scale section",
		source_ref: "experience/acme-2022.md#numbers-im-unsure-about",
		confidence: "medium",
		...extra,
	};
}

let ws: TempWorkspace;
beforeEach(() => {
	ws = tempWorkspace();
	ingestDraft(loadDraft(), { paths: ws.paths });
});
afterEach(() => ws.cleanup());

function metric(id: string) {
	const found = listMetrics({}, ws.paths).find((m) => m.id === id);
	if (!found) throw new Error(`no metric ${id}`);
	return found;
}

describe("proposeMetrics", () => {
	it("assigns <bullet>.mN with status estimated, continuing after existing metrics", () => {
		const r = proposeMetrics(
			[proposal(B2, "20 hours/week"), proposal(B1, "35%")],
			ws.paths,
		);
		expect(r).toEqual({ added: [`${B2}.m1`, `${B1}.m2`], skipped: [] });
		expect(metric(`${B2}.m1`)).toMatchObject({
			status: "estimated",
			confidence: "medium",
			role_id: ACME,
			bullet_id: B2,
		});
		expect(pendingMetricCount(ws.paths)).toBe(2);
		expect(readFileSync(ws.paths.metricsMd, "utf8")).toContain(`${B2}.m1`);
	});

	it("skips duplicates, unknown bullets and retired bullets", () => {
		const r = proposeMetrics(
			[proposal(B1, "40 Minutes"), proposal("nope-2020.b01", "5")],
			ws.paths,
		);
		expect(r).toEqual({ added: [], skipped: [B1, "nope-2020.b01"] });
	});

	it("rejects an invalid proposal before writing anything", () => {
		expect(() =>
			proposeMetrics([proposal(B2, "5", { derivation: "x" })], ws.paths),
		).toThrow(ValidationError);
		expect(pendingMetricCount(ws.paths)).toBe(0);
	});
});

describe("decideMetric", () => {
	beforeEach(() => {
		proposeMetrics(
			[
				proposal(B2, "20 hours/week"),
				proposal(B1, "35%"),
				proposal(`${ACME}.b02`, "3 teams"),
			],
			ws.paths,
		);
	});

	it("accept turns the estimate into a fact and appends to confirmed-metrics.yaml", () => {
		const v = decideMetric(`${B2}.m1`, { action: "accept" }, ws.paths, NOW);
		expect(v.status).toBe("fact");
		expect(loadLedger(ws.paths).metrics).toEqual([
			expect.objectContaining({
				id: `${B2}.m1`,
				bullet_id: B2,
				status: "confirmed",
				value: "20 hours/week",
				decided_at: NOW.toISOString(),
			}),
		]);
	});

	it("edit changes the value (and optionally phrase) and makes it a fact", () => {
		const v = decideMetric(
			`${B1}.m2`,
			{ action: "edit", value: "30%", phrase: "about 30% lower cost" },
			ws.paths,
			NOW,
		);
		expect(v).toMatchObject({
			status: "fact",
			value: "30%",
			phrase: "about 30% lower cost",
		});
		expect(loadLedger(ws.paths).metrics[0]).toMatchObject({
			status: "edited",
			value: "30%",
		});
		expect(() =>
			decideMetric(`${B1}.m2`, { action: "edit", value: "  " }, ws.paths),
		).toThrow(ValidationError);
	});

	it("reject sets rejected; metrics.md and pendingMetricCount follow", () => {
		decideMetric(`${B2}.m2`, { action: "reject" }, ws.paths, NOW);
		expect(metric(`${B2}.m2`).status).toBe("rejected");
		expect(pendingMetricCount(ws.paths)).toBe(2);
		const md = readFileSync(ws.paths.metricsMd, "utf8");
		expect(md).toMatch(new RegExp(`${B2}\\.m2\`[^\\n]*rejected`));
		expect(md).toContain("Pending estimates: 2");
		decideMetric(`${B2}.m1`, { action: "accept" }, ws.paths);
		decideMetric(`${B1}.m2`, { action: "accept" }, ws.paths);
		expect(pendingMetricCount(ws.paths)).toBe(0);
		expect(listMetrics({ status: "fact" }, ws.paths)).toHaveLength(3);
		expect(
			listMetrics({ roleId: "brightline-logistics-2019" }, ws.paths),
		).toEqual([]);
	});

	it("unknown id is not found", () => {
		expect(() =>
			decideMetric("nope.b01.m1", { action: "accept" }, ws.paths),
		).toThrow(NotFoundError);
	});

	it("re-ingest keeps the decisions and pending estimates", () => {
		decideMetric(
			`${B2}.m1`,
			{ action: "edit", value: "18 hours/week" },
			ws.paths,
		);
		decideMetric(`${B2}.m2`, { action: "reject" }, ws.paths);
		const r = ingestDraft(loadDraft(), { paths: ws.paths });
		expect(r).toMatchObject({ added: [], updated: [], retired: [] });
		expect(metric(`${B2}.m1`)).toMatchObject({
			status: "fact",
			value: "18 hours/week",
		});
		expect(metric(`${B2}.m2`).status).toBe("rejected");
		expect(metric(`${B1}.m2`).status).toBe("estimated");
	});

	it("decisions survive a rebuilt master via the ledger", () => {
		decideMetric(`${B2}.m1`, { action: "accept" }, ws.paths);
		decideMetric(`${B2}.m2`, { action: "reject" }, ws.paths);
		rmSync(ws.paths.masterResume);
		ingestDraft(loadDraft(), { paths: ws.paths });
		expect(metric(`${B2}.m1`)).toMatchObject({
			status: "fact",
			value: "20 hours/week",
		});
		expect(metric(`${B2}.m2`).status).toBe("rejected");
	});

	it("a source that later states the number verbatim promotes the estimate to fact", () => {
		const d = loadDraft();
		d.roles[0]?.bullets[1]?.metrics.push({
			phrase: "saves 20 hours/week",
			value: "20 hours/week",
			source_ref: "experience/acme-2022.md#outcomes",
		});
		ingestDraft(d, { paths: ws.paths });
		expect(metric(`${B2}.m1`)).toMatchObject({
			status: "fact",
			source_ref: "experience/acme-2022.md#outcomes",
		});
		expect(loadMaster(ws.paths).roles[0]?.bullets[1]?.metrics).toHaveLength(2);
	});
});

describe("pendingMetricCount and metrics.md", () => {
	it("is 0 when the master resume is missing", () => {
		rmSync(ws.paths.masterResume);
		expect(pendingMetricCount(ws.paths)).toBe(0);
		expect(listMetrics({}, ws.paths)).toEqual([]);
	});

	it("renders an empty-state hint", () => {
		const md = renderMetricsMd(
			{
				version: 1,
				summary_seeds: [],
				skills: [],
				roles: [],
				education: [],
				certifications: [],
				publications: [],
			},
			{ version: 1, metrics: [] },
		);
		expect(md).toContain("No metrics yet");
	});
});

describe("jh metrics", () => {
	it("propose, list and confirm round-trip with --json", async () => {
		const file = join(ws.base, "proposals.json");
		writeFileSync(
			file,
			JSON.stringify({ proposals: [proposal(B2, "20 hours/week")] }),
		);
		const p = await runCli(register, [
			"metrics",
			"propose",
			"--file",
			file,
			"--json",
		]);
		expect(p.json()).toEqual({ added: [`${B2}.m1`], skipped: [] });
		const l = await runCli(register, [
			"metrics",
			"list",
			"--status",
			"estimated",
			"--json",
		]);
		expect((l.json() as { id: string }[]).map((m) => m.id)).toEqual([
			`${B2}.m1`,
		]);
		const c = await runCli(register, [
			"metrics",
			"confirm",
			`${B2}.m1`,
			"--edit",
			"15 hours/week",
			"--json",
		]);
		expect(c.exitCode).toBe(0);
		expect(c.json()).toMatchObject({ status: "fact", value: "15 hours/week" });
	});

	it("confirm needs exactly one decision flag; bad --status is a validation error", async () => {
		const c = await runCli(register, [
			"metrics",
			"confirm",
			`${B1}.m1`,
			"--accept",
			"--reject",
			"--json",
		]);
		expect(c.exitCode).toBe(2);
		const l = await runCli(register, [
			"metrics",
			"list",
			"--status",
			"maybe",
			"--json",
		]);
		expect(l.exitCode).toBe(2);
		const n = await runCli(register, [
			"metrics",
			"confirm",
			"x.b01.m1",
			"--accept",
			"--json",
		]);
		expect(n.exitCode).toBe(1);
		expect(n.json()).toMatchObject({ error: "not_found" });
	});
});
