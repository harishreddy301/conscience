#!/usr/bin/env bash
# Setup script for the `conscience-cloud` Claude Code cloud environment (ADR 006).
# Environment settings provide DATA_REPO (owner/name) and DATA_TOKEN (a
# fine-grained PAT scoped to that one repo).
#
# The token is never echoed, never put in a URL or on a command line, and never
# written to disk: git reads it from the environment at call time through a
# GIT_ASKPASS helper that contains no secret. Never add `set -x` here.
set -euo pipefail

if [ -z "${DATA_TOKEN:-}" ]; then
	echo "cloud-setup: DATA_TOKEN not set; skipping (local checkout?)"
	exit 0
fi
: "${DATA_REPO:?cloud-setup: DATA_REPO must be set (owner/name)}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The CLOUD_SETUP_* overrides exist for tests/unit/cloud-setup.test.ts.
DATA_DIR="${CLOUD_SETUP_DATA_DIR:-/root/conscience-data}"
JH_HOME="${CLOUD_SETUP_JH_HOME:-/root/jh-home}"
DATA_URL="${CLOUD_SETUP_DATA_URL:-https://github.com/${DATA_REPO}.git}"
ASKPASS="$JH_HOME/bin/git-askpass"
cd "$REPO_ROOT"

# 0. Credentials: no helper caches the token, no prompt ever blocks. The
# askpass helper answers GitHub's username/password prompts from the env.
mkdir -p "$JH_HOME/bin"
cat >"$ASKPASS" <<'ASKPASS_SH'
#!/bin/sh
case "$1" in
Username*) echo x-access-token ;;
*) printf '%s\n' "${DATA_TOKEN:?DATA_TOKEN is not set}" ;;
esac
ASKPASS_SH
chmod 700 "$ASKPASS"
git config --global --unset-all credential.helper >/dev/null 2>&1 || true
export GIT_TERMINAL_PROMPT=0
export GIT_ASKPASS="$ASKPASS"

# 1. Data repo: clone, or pull when a previous setup already cloned it. origin
# stays tokenless; an older clone with a token in its URL is rewritten.
if [ -d "$DATA_DIR/.git" ]; then
	git -C "$DATA_DIR" remote set-url origin "$DATA_URL"
	git -C "$DATA_DIR" pull -q --ff-only
else
	git clone -q "$DATA_URL" "$DATA_DIR"
fi
git -C "$DATA_DIR" config core.askPass "$ASKPASS"
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

# 5. Point jh and the plugin at the data repo for this session. Values are
# JSON-escaped by node; DATA_TOKEN is not among them (git reads it from the
# environment through the askpass helper).
CS_REPO_ROOT="$REPO_ROOT" CS_DATA_DIR="$DATA_DIR" CS_JH_HOME="$JH_HOME" node -e '
const e = process.env;
const env = {
	CLAUDE_PLUGIN_ROOT: e.CS_REPO_ROOT,
	JOB_HUNTER_ME: `${e.CS_DATA_DIR}/me`,
	JOB_HUNTER_HOME: e.CS_JH_HOME,
	JOB_HUNTER_DB: `${e.CS_JH_HOME}/jh.db`,
	JOB_HUNTER_DATA_REPO: e.CS_DATA_DIR,
};
process.stdout.write(`${JSON.stringify({ env }, null, 2)}\n`);
' >.claude/settings.local.json

# 6. Machine state for this session.
mkdir -p "$JH_HOME"

# 7. Smoke check (never fails the setup). It uses a throwaway DB so that
# /cloud-resume can tell whether the packet DB has been copied into place yet.
JOB_HUNTER_ME="$DATA_DIR/me" JOB_HUNTER_HOME="$JH_HOME" JOB_HUNTER_DB="$JH_HOME/doctor.db" \
	JOB_HUNTER_DATA_REPO="$DATA_DIR" node dist/jh.mjs doctor --json || true
