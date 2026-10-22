import { describe, expect, it } from "vitest";
import type { TailoredResume } from "../../src/resume/schema.js";
import { numericTokens, validateTailored } from "../../src/resume/validate.js";
import * as fx from "../fixtures/resume/fixtures.js";

const M = fx.master();
const P = fx.profile();

/** Mutate a fresh copy of the valid draft, then validate it. */
function check(mutate: (d: TailoredResume) => void) {
	const d = fx.draft();
	mutate(d);
	return validateTailored(d, M, P);
}

const codes = (r: { errors: { code: string }[] }) =>
	r.errors.map((e) => e.code);
const role0 = (d: TailoredResume) =>
	d.experience[0] as TailoredResume["experience"][number];
const bullet = (d: TailoredResume, role: number, i: number) =>
	(d.experience[role] as TailoredResume["experience"][number]).bullets[
		i
	] as TailoredResume["experience"][number]["bullets"][number];

describe("numericTokens", () => {
	it("normalizes units, separators and currency", () => {
		expect(numericTokens("cut cost by $1,200 and 45% in 6 hours")).toEqual([
			"$1200",
			"45%",
			"6h",
		]);
		expect(
			numericTokens("grew to 10+ customers, 3x faster, 2.5 million rows"),
		).toEqual(["10+", "3x", "2.5m"]);
		expect(numericTokens("100ms p99 over 30 minutes")).toEqual([
			"100ms",
			"30min",
		]);
	});

	it("skips tokens glued to letters and tool versions", () => {
		expect(
			numericTokens("Used S3, EC2, K8s and Python 3.11 for 3D maps"),
		).toEqual([]);
	});

	it("keeps decimals after lowercase words", () => {
		expect(numericTokens("improved throughput by 2.5")).toEqual(["2.5"]);
	});
});

describe("classic-navy optional fields", () => {
	it("accepts an Environment line of tools named in the role's bullets or source skills", () => {
		const r = check((d) => {
			// "S3" is in a bullet; "AWS" and "dbt" are source-bullet skill tags.
			role0(d).environment = ["S3", "Airflow", "AWS", "dbt"];
		});
		expect(r.errors).toEqual([]);
	});

	it("flags an Environment tool the role never mentions as ENV_UNKNOWN_TOOL", () => {
		const r = check((d) => {
			role0(d).environment = ["Python", "Kubernetes"];
		});
		expect(codes(r)).toEqual(["ENV_UNKNOWN_TOOL"]);
		expect(r.errors[0]?.token).toBe("Kubernetes");
	});

	it("checks summary highlights for sources and numbers", () => {
		const ok = check((d) => {
			d.summary.highlights = [
				{
					label: "Streaming",
					text: "Cut pipeline latency by 45% by moving ingestion to streaming.",
					source_ids: ["acme-analytics-2021.b01"],
					emphasis: ["45%", "streaming"],
				},
			];
		});
		expect(ok.errors).toEqual([]);
		const bad = check((d) => {
			d.summary.highlights = [
				{
					label: "Streaming",
					text: "Cut pipeline latency by 70% by moving ingestion to streaming.",
					source_ids: ["acme-analytics-2021.b01", "nope.b01"],
					emphasis: ["70%"],
				},
			];
		});
		expect(codes(bad).sort()).toEqual(["NUMBER_UNSOURCED", "UNKNOWN_SOURCE"]);
	});

	it("rejects coursework that is not in the master education entry", () => {
		const r = check((d) => {
			const e = d.education[0];
			if (e) e.coursework = ["Invented Course"];
		});
		expect(codes(r)).toEqual(["EDU_MISMATCH"]);
	});
});

describe("validateTailored", () => {
	it("passes the valid fixture", () => {
		const r = validateTailored(fx.draftJson(), M, P);
		expect(r.errors).toEqual([]);
		expect(r.ok).toBe(true);
	});

	it("reports schema violations", () => {
		const json = fx.draftJson();
		json.schema = "other/v2";
		const r = validateTailored(json, M, P);
		expect(r.ok).toBe(false);
		expect(codes(r)).toEqual(["SCHEMA"]);
	});

	it("flags a changed title, employer or dates as FIXED_FACT_CHANGED", () => {
		const r = check((d) => {
			role0(d).title = "Principal Data Engineer";
		});
		expect(codes(r)).toEqual(["FIXED_FACT_CHANGED"]);
		expect(r.errors[0]?.path).toBe("experience[0].title");
		expect(
			codes(
				check((d) => {
					role0(d).employer = "Acme Inc";
				}),
			),
		).toEqual(["FIXED_FACT_CHANGED"]);
		expect(
			codes(
				check((d) => {
					role0(d).start = "2020-03";
				}),
			),
		).toEqual(["FIXED_FACT_CHANGED"]);
	});

	it("flags an unknown source id", () => {
		const r = check((d) => {
			bullet(d, 0, 1).source_ids = ["acme-analytics-2021.b99"];
		});
		expect(codes(r)).toEqual(["UNKNOWN_SOURCE"]);
	});

	it("flags a source bullet from a different role", () => {
		const r = check((d) => {
			bullet(d, 0, 1).source_ids = ["globex-corporation-2017.b02"];
		});
		expect(codes(r)).toContain("UNKNOWN_SOURCE");
	});

	it("flags an unknown role id", () => {
		expect(
			codes(
				check((d) => {
					role0(d).role_id = "nowhere-2020";
				}),
			),
		).toEqual(["UNKNOWN_SOURCE"]);
	});

	it("flags a retired source id", () => {
		const r = check((d) => {
			bullet(d, 0, 1).source_ids = ["acme-analytics-2021.b04"];
		});
		expect(codes(r)).toEqual(["RETIRED_SOURCE"]);
	});

	it("flags a number with no fact metric as NUMBER_UNSOURCED", () => {
		const r = check((d) => {
			bullet(d, 0, 1).text =
				"Migrated nightly batch ETL to Airflow DAGs, cutting failures by 45%";
			bullet(d, 0, 1).emphasis = ["Airflow DAGs", "45%"];
		});
		expect(codes(r)).toEqual(["NUMBER_UNSOURCED"]);
		expect(r.errors[0]?.token).toBe("45%");
	});

	it("flags a number taken from an estimated metric as ESTIMATED_METRIC", () => {
		const r = check((d) => {
			bullet(d, 0, 1).text =
				"Migrated nightly batch ETL to Airflow DAGs, saving 10 hours of toil each week";
			bullet(d, 0, 1).emphasis = ["Airflow DAGs", "10 hours"];
		});
		expect(codes(r)).toEqual(["ESTIMATED_METRIC"]);
	});

	it("flags a reference to an estimated metric id as ESTIMATED_METRIC", () => {
		const r = check((d) => {
			bullet(d, 0, 1).metrics = [
				{ metric_id: "acme-analytics-2021.b02.m1", text: "10 hours" },
			];
		});
		expect(codes(r)).toEqual(["ESTIMATED_METRIC"]);
	});

	it("allows S3, EC2, Python 3.11 and the role's own years", () => {
		const r = check((d) => {
			bullet(d, 0, 2).text =
				"Led a team of 4 engineers on S3 and EC2 with Python 3.11 from 2021 onward";
			bullet(d, 0, 2).emphasis = ["4 engineers", "S3"];
		});
		expect(r.errors).toEqual([]);
	});

	it("rejects a year outside the role's dates", () => {
		const r = check((d) => {
			bullet(d, 0, 2).text =
				"Led a team of 4 engineers building a warehouse launched in 2015";
			bullet(d, 0, 2).emphasis = ["team", "4 engineers"];
		});
		expect(codes(r)).toEqual(["NUMBER_UNSOURCED"]);
	});

	it("allows experience years in the summary but not other numbers", () => {
		expect(
			check((d) => {
				d.summary.text = "Data engineer with 8 years in Python.";
				d.summary.emphasis = ["8 years", "Python"];
			}).ok,
		).toBe(true);
		const r = check((d) => {
			d.summary.text = "Data engineer with 12+ years in Python.";
			d.summary.emphasis = ["12+ years", "Python"];
		});
		expect(codes(r)).toEqual(["NUMBER_UNSOURCED"]);
	});

	it("flags an invented skill as UNKNOWN_SKILL", () => {
		const r = check((d) => {
			d.skills[0]?.items.push("Rust");
		});
		expect(codes(r)).toEqual(["UNKNOWN_SKILL"]);
		expect(r.errors[0]?.token).toBe("Rust");
	});

	it("matches skills case- and punctuation-insensitively", () => {
		expect(
			check((d) => void d.skills[0]?.items.push("nodejs", "PYTHON")).ok,
		).toBe(true);
	});

	it("requires education and certifications to match the master exactly", () => {
		expect(
			codes(
				check((d) => {
					(d.education[0] as { degree: string }).degree = "M.S.";
				}),
			),
		).toEqual(["EDU_MISMATCH"]);
		expect(
			codes(
				check((d) => {
					d.certifications[0] = { name: "CKA" };
				}),
			),
		).toEqual(["CERT_MISMATCH"]);
		expect(
			codes(
				check((d) => {
					d.publications = [
						{
							title: "A paper not in the master",
							venue: "Nowhere",
							year: "2025",
						},
					];
				}),
			),
		).toEqual(["PUB_MISMATCH"]);
	});

	it("accepts a publication copied verbatim from the master", () => {
		const pub = {
			title: "Fictional Fixture Paper",
			venue: "Journal of Fixtures",
			year: "2024",
		};
		const m = { ...M, publications: [pub] };
		const d = fx.draft();
		d.publications = [{ ...pub }];
		expect(codes(validateTailored(d, m, P))).toEqual([]);
	});

	it("rejects a changed name or email when the profile is known", () => {
		expect(
			codes(
				check((d) => {
					d.basics.name = "J. Rivera";
				}),
			),
		).toEqual(["FIXED_FACT_CHANGED"]);
	});

	it("treats banned phrases, pronouns and long bullets as warnings only", () => {
		const r = check((d) => {
			bullet(d, 0, 1).text =
				"Responsible for migrating nightly batch ETL to Airflow; I was passionate about world-class reliability and data quality across every pipeline, every dashboard and every downstream consumer that depended on the warehouse being fresh each morning";
			bullet(d, 0, 1).emphasis = ["Airflow", "data quality"];
		});
		expect(r.ok).toBe(true);
		const w = r.warnings.map((x) => x.code);
		expect(w).toContain("BANNED_PHRASE");
		expect(w).toContain("PRONOUN");
		expect(w).toContain("BULLET_TOO_LONG");
		expect(
			r.warnings.filter((x) => x.code === "BANNED_PHRASE").map((x) => x.token),
		).toEqual(["responsible for", "passionate", "world-class"]);
	});

	it("flags duplicate bullet ids", () => {
		const r = check((d) => {
			bullet(d, 0, 1).id = bullet(d, 0, 0).id;
		});
		expect(codes(r)).toContain("SCHEMA");
	});
});

describe("display titles (TITLE_NOT_APPROVED)", () => {
	const withVariants = () => {
		const m = structuredClone(M);
		const acme = m.roles.find((r) => r.id === "acme-analytics-2021");
		if (!acme) throw new Error("fixture role missing");
		acme.title_variants = [
			"Senior Data Platform Engineer",
			"Analytics Engineer",
		];
		return m;
	};
	const checkWith = (master: typeof M, mutate: (d: TailoredResume) => void) => {
		const d = fx.draft();
		mutate(d);
		return validateTailored(d, master, P);
	};

	it("accepts the official title or an approved variant, spelled exactly", () => {
		const m = withVariants();
		for (const t of [
			"Senior Data Engineer",
			"Senior Data Platform Engineer",
			"Analytics Engineer",
		]) {
			const r = checkWith(m, (d) => {
				role0(d).display_title = t;
			});
			expect(r.errors).toEqual([]);
		}
	});

	it("rejects a casing or spacing the user never wrote, naming the approved spelling", () => {
		for (const t of [
			"  analytics   engineer ",
			"SENIOR DATA PLATFORM ENGINEER",
		]) {
			const r = checkWith(withVariants(), (d) => {
				role0(d).display_title = t;
			});
			expect(codes(r)).toEqual(["TITLE_NOT_APPROVED"]);
			expect(r.errors[0]?.message).toContain("approved spelling");
		}
	});

	it("rejects a display title the user never approved", () => {
		const r = checkWith(withVariants(), (d) => {
			role0(d).display_title = "Head of Data";
		});
		expect(codes(r)).toEqual(["TITLE_NOT_APPROVED"]);
		expect(r.errors[0]?.path).toBe("experience[0].display_title");
		expect(r.errors[0]?.token).toBe("Head of Data");
		expect(r.errors[0]?.message).toContain("Analytics Engineer");
	});

	it("rejects any variant when the role has none recorded", () => {
		const r = check((d) => {
			role0(d).display_title = "Senior Data Platform Engineer";
		});
		expect(codes(r)).toEqual(["TITLE_NOT_APPROVED"]);
		expect(r.errors[0]?.message).toContain("no title_variants");
	});

	it("still requires the official title field to match the master", () => {
		const r = checkWith(withVariants(), (d) => {
			role0(d).title = "Analytics Engineer";
			role0(d).display_title = "Analytics Engineer";
		});
		expect(codes(r)).toEqual(["FIXED_FACT_CHANGED"]);
	});
});

describe("headline within targets (HEADLINE_OFF_TARGET)", () => {
	it("does not warn when the headline names a target role", () => {
		const r = check(() => {});
		expect(r.warnings.map((w) => w.code)).not.toContain("HEADLINE_OFF_TARGET");
	});

	it("warns (not errors) when the headline names none of the targets", () => {
		const r = check((d) => {
			d.basics.headline = "Engineering Manager | Data Platform";
		});
		expect(r.errors).toEqual([]);
		const w = r.warnings.find((x) => x.code === "HEADLINE_OFF_TARGET");
		expect(w?.path).toBe("basics.headline");
		expect(w?.message).toContain("Analytics Engineer");
	});

	it("is skipped when the profile has no targets", () => {
		const d = fx.draft();
		d.basics.headline = "Engineering Manager";
		const r = validateTailored(d, M, { ...P, targets: { roles: [] } });
		expect(r.warnings.map((w) => w.code)).not.toContain("HEADLINE_OFF_TARGET");
	});
});
