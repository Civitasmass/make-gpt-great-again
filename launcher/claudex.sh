#!/usr/bin/env bash
# claudex — launch Claude Code on the GPT-5.6 family via a local mgga proxy.
# POSIX twin of claudex.ps1; see that file for the full commentary.
#
#   ./launcher/claudex.sh            interactive (defaults to gpt-5.6-sol)
#   ./launcher/claudex.sh -p "..."   one-shot
#
# Overrides: CLAUDEX_CLAUDE_CMD (claude executable), CLAUDEX_PORT (default 5656)
set -euo pipefail

port="${CLAUDEX_PORT:-5656}"
base="http://127.0.0.1:${port}"
repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export CLAUDE_CONFIG_DIR="${HOME}/.claude-gpt"
unset CLAUDE_CODE_CHILD_SESSION CLAUDE_CODE_SSE_PORT CLAUDE_CODE_SESSION_ID CLAUDE_CODE_ENTRYPOINT CLAUDECODE 2>/dev/null || true

proxy_up() { curl -sf -m 2 "${base}/healthz" >/dev/null 2>&1; }

if ! proxy_up; then
  dist="${repo}/dist/index.js"
  if [ ! -f "$dist" ]; then
    echo "[claudex] ${dist} missing — run 'npm install && npm run build' in ${repo} first." >&2
    exit 1
  fi
  echo "[claudex] starting mgga proxy on port ${port} ..." >&2
  (cd "$repo" && nohup node "$dist" serve --port "$port" >/dev/null 2>&1 &)
  for _ in $(seq 1 50); do
    proxy_up && break
    sleep 0.2
  done
  proxy_up || { echo "[claudex] proxy did not come up on ${base}" >&2; exit 1; }
fi

export ANTHROPIC_BASE_URL="$base"
export ANTHROPIC_AUTH_TOKEN='mgga'
# CLAUDEX_EFFORT=max suffixes every tier — whole session (subagents included)
# thinks at that depth. The in-UI selector (low/medium/high) propagates to
# subagents on its own; the suffix reaches the GPT-only max/ultra tiers.
suffix="${CLAUDEX_EFFORT:+:${CLAUDEX_EFFORT}}"
export ANTHROPIC_MODEL="gpt-5.6-sol${suffix}"
export ANTHROPIC_DEFAULT_OPUS_MODEL="gpt-5.6-sol${suffix}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="gpt-5.6-terra${suffix}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="gpt-5.6-luna${suffix}"
export ANTHROPIC_SMALL_FAST_MODEL='gpt-5.6-luna'   # background chores stay cheap
# CLAUDE_CODE_SUBAGENT_MODEL deliberately unset — subagents fall to the tier envs
# above; per-task depth = the mother picking gpt-quick / gpt / gpt-deep.
export CLAUDE_CODE_ALWAYS_ENABLE_EFFORT='1'
export CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY='3'
export ENABLE_TOOL_SEARCH='false'
export API_TIMEOUT_MS='600000'

exec "${CLAUDEX_CLAUDE_CMD:-claude}" "$@"
