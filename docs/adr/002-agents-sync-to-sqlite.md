# ADR-002: Agents sync Gmail and Calendar into SQLite; the dashboard never calls MCP

- Status: accepted
- Date: 2026-10-15

## Context

The dashboard must show interviews, application replies and assessments even when no Claude Code session is open, and it starts at logon as a small background Node server. Gmail and Google Calendar are reachable only through MCP connectors inside a Claude session. A background server cannot hold connector credentials or call MCP.

## Decision

- `email-tracker` (sonnet) and `calendar-sync` (haiku) run inside a Claude session (`/track`, `/today`, `/loop 2h /track`, or the optional scheduled `claude -p "/track"`).
- They write normalized JSON to `~/.job-hunter/inbox/` and call `jh email ingest`, `jh interview upsert`, bracketed by `jh sync begin` / `jh sync end` (cursor and error recorded in `sync_runs`).
- Code does the linking (explicit id → thread → sender domain → company hint) and the soft, forward-only status moves.
- The dashboard server (`node:http` + `node:sqlite`) only reads and writes SQLite and `me/` metrics. It shows sync freshness and a red `connector_unavailable` chip when syncs fail.

## Consequences

- The dashboard is always available, fast and offline-safe; it holds no credentials.
- Data is as fresh as the last sync; freshness is visible in the header.
- Only a subject, sender and 500-character snippet are stored, never full bodies.
- Email content is untrusted: classification happens in the agent, effects are applied by code with confidence thresholds.
