/**
 * Email -> application linking and the status effect of each email kind.
 * Precedence: explicit id > thread > sender domain (ATS/mailbox domains skipped) > company hint > none.
 */

import type { AppStatus } from "../core/state.js";
import type { Db } from "../db/index.js";
import {
	type ApplicationView,
	findCompanyByDomain,
	findCompanyByName,
	getApplication,
	listApplications,
} from "../db/repo.js";
import { threadLink } from "../db/tracking.js";
import type { EmailIngestItem, EmailKind } from "./schemas.js";

export type LinkVia =
	| "explicit"
	| "thread"
	| "domain"
	| "company_hint"
	| "none";

export interface LinkResult {
	applicationId: number | null;
	companyId: number | null;
	via: LinkVia;
}

export interface Effect {
	to?: AppStatus;
	createApplication?: boolean;
	createInterview?: boolean;
}

/** Senders that are ATS platforms or personal mailboxes: never identify the employer. */
export const SHARED_SENDER_DOMAINS: ReadonlySet<string> = new Set([
	"greenhouse.io",
	"greenhouse-mail.io",
	"lever.co",
	"hire.lever.co",
	"myworkday.com",
	"myworkdayjobs.com",
	"workday.com",
	"ashbyhq.com",
	"smartrecruiters.com",
	"icims.com",
	"jobvite.com",
	"taleo.net",
	"successfactors.com",
	"successfactors.eu",
	"bamboohr.com",
	"workablemail.com",
	"workable.com",
	"recruitee.com",
	"breezy.hr",
	"jazzhr.com",
	"applytojob.com",
	"rippling.com",
	"teamtailor.com",
	"personio.de",
	"oraclecloud.com",
	"linkedin.com",
	"indeed.com",
	"indeedemail.com",
	"ziprecruiter.com",
	"glassdoor.com",
	"wellfound.com",
	"hackerrank.com",
	"hackerrankforwork.com",
	"codility.com",
	"codesignal.com",
	"calendly.com",
	"goodtime.io",
	"gmail.com",
	"googlemail.com",
	"outlook.com",
	"hotmail.com",
	"live.com",
	"yahoo.com",
	"icloud.com",
	"proton.me",
	"protonmail.com",
]);

/** Minimum confidence before an email may change application status. */
export const MIN_EFFECT_CONFIDENCE = 0.6;
/** Minimum confidence before an email may create an application. */
export const MIN_CREATE_CONFIDENCE = 0.8;

/** Extract the bare address from `"Name" <a@b.com>` or `a@b.com`. */
export function emailAddress(from: string): string {
	const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(from);
	const raw = angle?.[1] ?? from.trim();
	return raw.toLowerCase();
}

export function domainOf(from: string): string {
	const addr = emailAddress(from);
	const at = addr.lastIndexOf("@");
	return at >= 0
		? addr
				.slice(at + 1)
				.replace(/[>\s]+$/, "")
				.toLowerCase()
		: "";
}

/** "mail.jobs.stripe.com" -> ["mail.jobs.stripe.com","jobs.stripe.com","stripe.com"]. */
export function domainCandidates(domain: string): string[] {
	const labels = domain.split(".").filter(Boolean);
	const out: string[] = [];
	for (let i = 0; i <= labels.length - 2; i++)
		out.push(labels.slice(i).join("."));
	return out;
}

export function isSharedSenderDomain(domain: string): boolean {
	return domainCandidates(domain).some((d) => SHARED_SENDER_DOMAINS.has(d));
}

/** Prefer the most recent non-terminal application for a company. */
function bestApplicationFor(db: Db, companyId: number): number | null {
	const apps: ApplicationView[] = listApplications(db, {
		companyId,
		limit: 20,
	});
	const active = apps.find((a) => ACTIVEISH.has(a.status));
	return (active ?? apps[0])?.id ?? null;
}

const ACTIVEISH: ReadonlySet<string> = new Set([
	"applied",
	"assessment",
	"interviewing",
	"offer",
	"ghosted",
	"tailored",
	"shortlisted",
]);

function byExplicit(db: Db, item: EmailIngestItem): LinkResult | null {
	if (!item.application_id) return null;
	const app = getApplication(db, item.application_id);
	if (!app) return null;
	return { applicationId: app.id, companyId: app.company_id, via: "explicit" };
}

function byThread(db: Db, item: EmailIngestItem): LinkResult | null {
	const t = threadLink(db, item.thread_id);
	if (!t || t.application_id === null) return null;
	return {
		applicationId: t.application_id,
		companyId: t.company_id,
		via: "thread",
	};
}

function byDomain(db: Db, item: EmailIngestItem): LinkResult | null {
	const domain = domainOf(item.from);
	if (!domain || isSharedSenderDomain(domain)) return null;
	for (const d of domainCandidates(domain)) {
		const c = findCompanyByDomain(db, d);
		if (c)
			return {
				applicationId: bestApplicationFor(db, c.id),
				companyId: c.id,
				via: "domain",
			};
	}
	return null;
}

function byCompanyHint(db: Db, item: EmailIngestItem): LinkResult | null {
	if (!item.company) return null;
	const c = findCompanyByName(db, item.company);
	if (!c) return null;
	return {
		applicationId: bestApplicationFor(db, c.id),
		companyId: c.id,
		via: "company_hint",
	};
}

export function resolveLink(db: Db, item: EmailIngestItem): LinkResult {
	for (const step of [byExplicit, byThread, byDomain, byCompanyHint]) {
		const r = step(db, item);
		if (r) return r;
	}
	return { applicationId: null, companyId: null, via: "none" };
}

const TARGET: Partial<Record<EmailKind, AppStatus>> = {
	confirmation: "applied",
	rejection: "rejected",
	interview_invite: "interviewing",
	assessment: "assessment",
};

/**
 * What an email of `kind` should do to an application currently in `current`
 * (null = no linked application). Transitions are applied softly by the caller.
 */
export function effectFor(
	kind: EmailKind,
	current: AppStatus | null,
	confidence: number,
): Effect {
	if (confidence < MIN_EFFECT_CONFIDENCE) return {};
	const to = TARGET[kind];
	const effect: Effect = {};
	if (kind === "interview_invite") effect.createInterview = true;
	if (!to) return effect;
	if (current !== null) {
		if (current !== to) effect.to = to;
		return effect;
	}
	if (kind !== "rejection" && confidence >= MIN_CREATE_CONFIDENCE) {
		effect.createApplication = true;
		effect.to = to;
	}
	return effect;
}
