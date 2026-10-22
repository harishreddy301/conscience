import { describe, expect, it } from "vitest";
import { splitEmphasis } from "../../src/render/emphasis.js";

describe("splitEmphasis", () => {
	it("bolds each phrase once and keeps the text intact", () => {
		const segs = splitEmphasis("Cut costs 28% with Spark on Spark", [
			"28%",
			"Spark",
		]);
		expect(segs.map((s) => s.text).join("")).toBe(
			"Cut costs 28% with Spark on Spark",
		);
		expect(segs.filter((s) => s.bold).map((s) => s.text)).toEqual([
			"28%",
			"Spark",
		]);
	});

	it("ignores missing and overlapping phrases", () => {
		const segs = splitEmphasis("Delta Lake on S3", [
			"Delta Lake",
			"Lake on",
			"Kafka",
		]);
		expect(segs).toEqual([
			{ text: "Delta Lake", bold: true },
			{ text: " on S3", bold: false },
		]);
	});

	it("returns one plain run without phrases", () => {
		expect(splitEmphasis("plain")).toEqual([{ text: "plain", bold: false }]);
	});
});
