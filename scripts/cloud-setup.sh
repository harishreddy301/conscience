#!/usr/bin/env bash
# Setup script for the `conscience-cloud` Claude Code cloud environment (ADR 006).
# Environment settings provide DATA_REPO (owner/name) and DATA_TOKEN (a
# fine-grained PAT scoped to that one repo). The token is never echoed.
set -euo pipefail

if [ -z "${DATA_TOKEN:-}" ]; then
	echo "cloud-setup: DATA_TOKEN not set; skipping (local checkout?)"
	exit 0
fi
: "${DATA_REPO:?cloud-setup: DATA_REPO must be set (owner/name)}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR=/root/conscience-data
JH_HOME=/root/jh-home
cd "$REPO_ROOT"

# Never cache or prompt for credentials; the token lives only in the clone's remote URL.
git config --global --unset-all credential.helper >/dev/null 2>&1 || true
export GIT_TERMINAL_PROMPT=0

# 1. Data repo: clone, or pull when a previous setup already cloned it.
if [ -d "$DATA_DIR/.git" ]; then
	git -C "$DATA_DIR" pull -q --ff-only
else
	git clone -q "https://x-access-token:${DATA_TOKEN}@github.com/${DATA_REPO}.git" "$DATA_DIR"
fi
git -C "$DATA_DIR" config user.name "conscience-cloud"
git -C "$DATA_DIR" config user.email "conscience-cloud@users.noreply.github.com"

# 2-4. Link the plugin's agents, commands and skills into .claude/ (a repo-root
# .claude-plugin is not loaded by cloud sessions).
mkdir -p .claude/agents .claude/commands .claude/skills
for f in agents/*.md; do ln -sfn "$REPO_ROOT/$f" ".claude/agents/$(basename "$f")"; done
for f in commands/*.md; do ln -sfn "$REPO_ROOT/$f" ".claude/commands/$(basename "$f")"; done
for d in skills/*/; do
	name="$(basename "$d")"
	ln -sfn "$REPO_ROOT/skills/$name" ".claude/skills/$name"
done
# Keep the links out of `git status` in this checkout.
{
	for f in agents/*.md; do echo "/.claude/agents/$(basename "$f")"; done
	for f in commands/*.md; do echo "/.claude/commands/$(basename "$f")"; done
	for d in skills/*/; do echo "/.claude/skills/$(basename "$d")"; done
} >>.git/info/exclude 2>/dev/null || true

# 5. Point jh and the plugin at the data repo for this session.
cat >.claude/settings.local.json <<JSON
{
  "env": {
    "CLAUDE_PLUGIN_ROOT": "$REPO_ROOT",
    "JOB_HUNTER_ME": "$DATA_DIR/me",
    "JOB_HUNTER_HOME": "$JH_HOME",
    "JOB_HUNTER_DB": "$JH_HOME/jh.db",
    "JOB_HUNTER_DATA_REPO": "$DATA_DIR"
  }
}
JSON

# 6. Machine state for this session.
mkdir -p "$JH_HOME"

# 7. Smoke check (never fails the setup). It uses a throwaway DB so that
# /cloud-resume can tell whether the packet DB has been copied into place yet.
JOB_HUNTER_ME="$DATA_DIR/me" JOB_HUNTER_HOME="$JH_HOME" JOB_HUNTER_DB="$JH_HOME/doctor.db" \
	JOB_HUNTER_DATA_REPO="$DATA_DIR" node dist/jh.mjs doctor --json || true
