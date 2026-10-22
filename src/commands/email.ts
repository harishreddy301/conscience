import type { Command } from "commander";
import { z } from "zod";
import { audit } from "../core/audit.js";
import { NotFoundError } from "../core/errors.js";
import { action, emit, readJsonInput } from "../core/output.js";
import { type Db, tx } from "../db/index.js";
import { getApplication, insertEvent } from "../db/repo.js";
import { getEmail, linkEmail, listEmails, withDb } from "../db/tracking.js";
import { effectFor } from "../tracking/email-link.js";
import {
	applyTransitions,
	type IngestResult,
	ingestEmails,
	itemFromEmailRow,
	recordInterview,
} from "../tracking/ingest.js";
import {
	EmailIngestBatch,
	EmailKind,
	type EmailRow,
} from "../tracking/schemas.js";

const Id = z.coerce.number().int().positive();
const ListOpts = z.object({
	unlinked: z.boolean().optional(),
	kind: EmailKind.optional(),
	limit: z.coerce.number().int().min(1).max(1000).default(50),
});

function humanIngest(r: IngestResult): string {
	const lines = [`ingested ${r.ingested}, duplicates ${r.duplicates}`];
	for (const i of r.items) {
		if (i.duplicate) continue;
		const app = i.application_id ? `app ${i.application_id}` : "unlinked";
		const move = i.changed
			? ` ${i.from_status ?? "new"} -> ${i.to_status}`
			: "";
		lines.push(`  ${i.gmail_message_id}  via ${i.via}  ${app}${move}`);
	}
	return lines.join("\n");
}

function humanEmails(rows: (EmailRow & { company: string | null })[]): string {
	if (!rows.length) return "no emails";
	return rows
		.map(
			(e) =>
				`${String(e.id).padStart(5)}  ${e.received_at.slice(0, 10)}  ${e.kind.padEnd(16)} ${(e.application_id ? `app ${e.application_id}` : "unlinked").padEnd(10)} ${e.company ?? e.from_domain}  ${e.subject}`,
		)
		.join("\n");
}

/**
 * Link an email to an application and apply its kind's effect (soft), in one
 * transaction. Re-linking is idempotent: no second email event, and an
 * interview invite creates (or reuses) its interview row like ingest does.
 */
export function linkEmailToApp(db: Db, emailId: number, appId: number) {
	const result = tx(db, () => {
		const email = getEmail(db, emailId);
		if (!email) throw new NotFoundError(`email ${emailId} not found`);
		const app = getApplication(db, appId);
		if (!app) throw new NotFoundError(`application ${appId} not found`);
		linkEmail(db, emailId, appId, app.company_id);
		const seen = db
			.prepare(
				"SELECT 1 FROM application_events WHERE application_id = ? AND kind = 'email' AND email_id = ? LIMIT 1",
			)
			.get(appId, emailId);
		if (!seen)
			insertEvent(db, {
				application_id: appId,
				kind: "email",
				actor: "user",
				email_id: emailId,
				detail: { kind: email.kind, subject: email.subject, linked: "manual" },
				at: email.received_at,
			});
		const item = itemFromEmailRow(email);
		const effect = effectFor(email.kind, app.status, email.confidence);
		const moved = effect.to
			? applyTransitions(db, appId, effect.to, emailId, item, "user")
			: null;
		const interviewId = effect.createInterview
			? recordInterview(db, item, emailId, appId, app.company_id)
			: undefined;
		return { moved, interviewId };
	});
	audit({
		actor: "user",
		action: "email.link",
		target: `application:${appId}`,
		detail: { emailId },
	});
	return {
		emailId,
		applicationId: appId,
		transition: result.moved,
		...(result.interviewId !== undefined
			? { interview_id: result.interviewId }
			: {}),
	};
}

export function register(program: Command): void {
	const email = program
		.command("email")
		.description("ingest and link job-related Gmail messages");

	email
		.command("ingest")
		.description(
			"ingest classified emails (JSON array or {items}) from a file or - for stdin",
		)
		.requiredOption("--file <path>", "JSON file, or - for stdin")
		.option("--dry-run", "show what would happen without writing")
		.option("--json", "machine-readable output")
		.action(
			action(
				async (opts: { file: string; dryRun?: boolean; json?: boolean }) => {
					const items = EmailIngestBatch.parse(await readJsonInput(opts.file));
					const res = await withDb((db) =>
						ingestEmails(db, items, { dryRun: opts.dryRun }),
					);
					emit(res, opts.json, humanIngest);
				},
			),
		);

	email
		.command("list")
		.description("list ingested emails, newest first")
		.option("--unlinked", "only emails not linked to an application")
		.option(
			"--kind <kind>",
			"confirmation|rejection|interview_invite|assessment|recruiter|other",
		)
		.option("--limit <n>", "max rows", "50")
		.option("--json", "machine-readable output")
		.action(
			action(async (opts: Record<string, unknown> & { json?: boolean }) => {
				const f = ListOpts.parse(opts);
				const rows = await withDb((db) => listEmails(db, f));
				emit(rows, opts.json, humanEmails);
			}),
		);

	email
		.command("link <emailId> <appId>")
		.description("link an email to an application and apply its status effect")
		.option("--json", "machine-readable output")
		.action(
			action(
				async (emailId: string, appId: string, opts: { json?: boolean }) => {
					const res = await withDb((db) =>
						linkEmailToApp(db, Id.parse(emailId), Id.parse(appId)),
					);
					emit(
						res,
						opts.json,
						(r: typeof res) =>
							`linked email ${r.emailId} -> app ${r.applicationId}${r.transition?.changed ? ` (${r.transition.from} -> ${r.transition.to})` : ""}`,
					);
				},
			),
		);
}
