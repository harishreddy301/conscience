import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { JdKeywords } from "../../../src/ats/keywords.js";
import { MasterResume, Profile } from "../../../src/me/schema.js";
import { TailoredResume } from "../../../src/resume/schema.js";

export const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
export const fixturePath = (name: string) => join(FIXTURE_DIR, name);

const text = (name: string) => readFileSync(fixturePath(name), "utf8");

export function master(): MasterResume {
	return MasterResume.parse(parseYaml(text("master-resume.fixture.yaml")));
}

export function profile(): Profile {
	return Profile.parse(parseYaml(text("profile.fixture.yaml")));
}

export function keywords(): JdKeywords {
	return JdKeywords.parse(JSON.parse(text("keywords.fixture.json")));
}

/** Raw draft JSON (deep copy, safe to mutate). */
export function draftJson(): Record<string, unknown> {
	return JSON.parse(text("tailored.fixture.json"));
}

export function draft(): TailoredResume {
	return TailoredResume.parse(draftJson());
}
