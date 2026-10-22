import { z } from "zod";

/** One application in a packet; `jd_path` is relative to the packet dir. */
export const PacketApp = z.object({
	app_id: z.number().int().positive(),
	company: z.string(),
	title: z.string(),
	url: z.string().nullable(),
	jd_path: z.string(),
});
export type PacketApp = z.infer<typeof PacketApp>;

/** Packet ids: p-YYYYMMDD-HHMM in local time, optionally with a -N suffix. */
export const PACKET_ID_RE = /^p-\d{8}-\d{4}(-\d+)?$/;

/** Run ids from the cloud become directory names; nothing but [A-Za-z0-9_-]. */
export const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;

/** packets/<id>/packet.json. */
export const PacketManifest = z.object({
	id: z.string().regex(PACKET_ID_RE),
	created_at: z.string(),
	schema_version: z.number().int().nonnegative(),
	apps: z.array(PacketApp),
});
export type PacketManifest = z.infer<typeof PacketManifest>;

export const CloudAppStatus = z.enum(["ready", "below_bar", "no_go", "failed"]);
export type CloudAppStatus = z.infer<typeof CloudAppStatus>;

/** results/<id>/summary.json, written by /cloud-resume after each app. */
export const CloudSummary = z.object({
	packet_id: z.string(),
	finished_at: z.string(),
	apps: z.array(
		z.object({
			app_id: z.number().int().positive(),
			run_id: z.string().nullable(),
			/** The winner after step 6; import validates this draft. */
			winner_draft_id: z.string().nullable().optional(),
			status: CloudAppStatus,
			ats: z.number().nullable(),
			hm_verdict: z.string().nullable(),
			notes: z.array(z.string()),
		}),
	),
});
export type CloudSummary = z.infer<typeof CloudSummary>;
