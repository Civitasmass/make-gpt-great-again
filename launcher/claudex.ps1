# claudex.ps1 — launch Claude Code on the GPT-5.6 family via a local mgga proxy.
#
#   claudex                 interactive session (defaults to gpt-5.6-sol)
#   claudex -p "prompt"     one-shot, like plain claude
#
# What it does, in order:
#   1. isolates state under ~/.claude-gpt (your real Claude profiles stay untouched)
#   2. starts `mgga serve` in the background if nothing answers on the port
#   3. points Claude Code at the proxy and maps every model tier to a GPT-5.6 sibling
#
# Overrides (set before calling):
#   CLAUDEX_CLAUDE_CMD  path to a specific claude executable   (default: `claude` on PATH)
#   CLAUDEX_PORT        proxy port                             (default: 5656)

$ErrorActionPreference = 'Stop'
$port = if ($env:CLAUDEX_PORT) { $env:CLAUDEX_PORT } else { '5656' }
$repo = Split-Path -Parent $PSScriptRoot
$base = "http://127.0.0.1:$port"

# -- 1. isolated profile ------------------------------------------------------
$env:CLAUDE_CONFIG_DIR = "$env:USERPROFILE\.claude-gpt"

# Start as a clean top-level session: scrub nested-claude vars inherited from a
# parent Claude session (same hygiene as any multi-profile launcher).
foreach ($v in 'CLAUDE_CODE_CHILD_SESSION','CLAUDE_CODE_SSE_PORT','CLAUDE_CODE_SESSION_ID','CLAUDE_CODE_ENTRYPOINT','CLAUDECODE') {
    Remove-Item "Env:\$v" -ErrorAction SilentlyContinue
}

# -- 2. ensure the proxy is up ------------------------------------------------
function Test-Proxy {
    try { (Invoke-RestMethod -Uri "$base/healthz" -TimeoutSec 2).ok -eq $true } catch { $false }
}

if (-not (Test-Proxy)) {
    $dist = Join-Path $repo 'dist\index.js'
    if (-not (Test-Path $dist)) {
        Write-Host "[claudex] $dist missing - run 'npm install && npm run build' in $repo first." -ForegroundColor Red
        exit 1
    }
    Write-Host "[claudex] starting mgga proxy on port $port ..." -ForegroundColor DarkGray
    Start-Process -FilePath 'node' -ArgumentList @($dist, 'serve', '--port', $port) `
        -WorkingDirectory $repo -WindowStyle Hidden | Out-Null
    $deadline = (Get-Date).AddSeconds(10)
    while (-not (Test-Proxy)) {
        if ((Get-Date) -gt $deadline) {
            Write-Host "[claudex] proxy did not come up on $base - check 'node dist\index.js serve' by hand." -ForegroundColor Red
            exit 1
        }
        Start-Sleep -Milliseconds 200
    }
}

# -- 3. point Claude Code at GPT-5.6 -------------------------------------------
$env:ANTHROPIC_BASE_URL   = $base
$env:ANTHROPIC_AUTH_TOKEN = 'mgga'          # any non-empty value; set MGGA_API_KEY to enforce one
# Session-wide effort: `CLAUDEX_EFFORT=max claudex` suffixes every model tier,
# so the main thread AND every subagent tier think at that depth. Claude Code's
# in-UI effort selector (low/medium/high) propagates to subagents by itself —
# verified live 2026-07-12: a subagent ran terra@high while the selector was
# high. The suffix is how you reach the GPT-only max/ultra tiers.
$suffix = if ($env:CLAUDEX_EFFORT) { ":$($env:CLAUDEX_EFFORT)" } else { '' }
$env:ANTHROPIC_MODEL                = "gpt-5.6-sol$suffix"
$env:ANTHROPIC_DEFAULT_OPUS_MODEL   = "gpt-5.6-sol$suffix"
$env:ANTHROPIC_DEFAULT_SONNET_MODEL = "gpt-5.6-terra$suffix"
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL  = "gpt-5.6-luna$suffix"
$env:ANTHROPIC_SMALL_FAST_MODEL     = 'gpt-5.6-luna'   # background chores stay cheap on purpose
# CLAUDE_CODE_SUBAGENT_MODEL is deliberately NOT set — subagents fall to the
# tier envs above (same suffix), and per-task depth is chosen by the MOTHER
# agent picking an agent tier: gpt-quick (luna) / gpt (sol) / gpt-deep (sol:max).

# Harness tuning for GPT (community-verified starting points):
# always send a thinking budget so the effort mapper engages; keep tool
# concurrency modest; skip deferred-tool search, which GPT handles poorly.
$env:CLAUDE_CODE_ALWAYS_ENABLE_EFFORT      = '1'
$env:CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY  = '3'
$env:ENABLE_TOOL_SEARCH                    = 'false'
$env:API_TIMEOUT_MS                        = '600000'  # xhigh/max reasoning can be slow

$claude = if ($env:CLAUDEX_CLAUDE_CMD) { $env:CLAUDEX_CLAUDE_CMD } else { 'claude' }
& $claude @args
exit $LASTEXITCODE
