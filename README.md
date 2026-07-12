# Make GPT Great Again (mgga)

![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%E2%89%A5%2022-brightgreen)
![runtime deps](https://img.shields.io/badge/runtime%20deps-0-orange)
![tests](https://img.shields.io/badge/tests-129%20passing-success)
[![GitHub stars](https://img.shields.io/github/stars/Civitasmass/make-gpt-great-again?style=social)](https://github.com/Civitasmass/make-gpt-great-again/stargazers)

Run OpenAI's **GPT-5.6 family — Sol / Terra / Luna — inside Claude Code**, with the
harness quirks actually fixed.

GPT-5.6 is a great model that deserves a great harness. `mgga` is a small,
dependency-free Anthropic-Messages → OpenAI-Responses proxy: Claude Code talks to it
as if it were Anthropic, and it talks to OpenAI (your ChatGPT/Codex subscription, or
an API key) as a first-class Responses client — encrypted reasoning replay included.

```
┌────────────────────────────── Claude Code ───────────────────────────────┐
│ the harness — tools · subagents · auto mode · statusline                 │
│ /model gpt-5.6-sol:ultra                                                 │
└──────────────────────────────────────────────────────────────────────────┘
            │  Anthropic Messages                     ▲  Anthropic SSE
            ▼                                         │
┌───────────────────────── mgga · localhost:5656 ──────────────────────────┐
│ route      claude-* tiers → sol / terra / luna · gpt-* passes through    │
│ fix ▾      strip-cache-control · system-shim · schema-lowering           │
│            reasoning-bridge · tool-id-bridge · effort-and-budget         │
│ translate  Anthropic Messages ⇄ OpenAI Responses                         │
│ guard ▴    tool-json-guard — truncated tool JSON degrades retryably      │
└──────────────────────────────────────────────────────────────────────────┘
            │  OpenAI Responses                       ▲  SSE · quota headers
            ▼                                         │
┌──────────────────────────────── backends ────────────────────────────────┐
│ chatgpt — rides your Codex OAuth login (subscription, no API key)        │
│ openai  — API key · api.openai.com or any Responses-shaped endpoint      │
└──────────────────────────────────────────────────────────────────────────┘
            │
            ▼
┌──────────────────────────────── GPT-5.6 ─────────────────────────────────┐
│ Sol (frontier) · Terra (balanced) · Luna (fast)                          │
└──────────────────────────────────────────────────────────────────────────┘
```

## Why not just point a generic proxy at it?

Because "GPT sucks in \<harness\>" is never one bug — it is a pile of small impedance
mismatches. mgga models each one as a **fixer**: one file, one problem, one `why`
string, one test file. `mgga doctor` prints the table:

| fixer | without it | with it |
|---|---|---|
| `strip-cache-control` | every request 400s (`cache_control` is Anthropic-only) | markers stripped; session id reused as OpenAI `prompt_cache_key` |
| `system-shim` | GPT yields early, narrates instead of acting | harness discipline appended to the system prompt (configurable per model) |
| `schema-lowering` | one MCP server 400s the whole session (schema dialect, 64-char names) | schemas lowered, long names hashed deterministically and restored on the way back |
| `reasoning-bridge` | GPT **re-derives its plan on every tool call** — the big one | encrypted reasoning replayed across the loop (see the signature trick) |
| `tool-id-bridge` | second tool round-trip dies: "No tool call found…" | stateless `toolu_call_*` ↔ `call_*` bijection |
| `effort-and-budget` | deep thoughts truncate the visible answer | thinking budgets → reasoning efforts; output ceiling gets reasoning headroom |
| `tool-json-guard` | one truncated tool call kills the session | mechanical JSON close, or `{}` so the call fails *retryably* |

### The signature trick

OpenAI reasoning models carry their chain-of-thought between tool calls as encrypted
`reasoning` items that **must be replayed** (mgga runs `store:false` — the server keeps
nothing). Anthropic's protocol happens to round-trip an opaque `signature` field on
thinking blocks. mgga smuggles `encrypted_content` through it:

```
capture   GPT reasoning item ──▶ mgga ──▶ thinking block · signature ⟵ encrypted_content
replay    thinking block ──▶ mgga ──▶ reasoning item · encrypted_content ⟵ signature

          ⇒ the model keeps its plan across the whole tool loop
```

Verified live against the ChatGPT backend: the replayed item is accepted and the model
keeps its plan. This is the single biggest quality lever a GPT proxy has, and the one
naive proxies drop. Details in [ARCHITECTURE.md](ARCHITECTURE.md).

## Quickstart

Requires Node ≥ 22. No runtime dependencies.

```bash
npm install && npm run build

# Option A — ride your ChatGPT subscription (needs a `codex login` on this machine):
node dist/index.js serve

# Option B — API key:
OPENAI_API_KEY=sk-… MGGA_BACKEND=openai node dist/index.js serve
```

Point Claude Code at it:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:5656
export ANTHROPIC_AUTH_TOKEN=mgga        # any non-empty value (set MGGA_API_KEY to enforce one)
claude --model gpt-5.6-sol
```

Or use the bundled launcher, which does all of that plus profile isolation
(`~/.claude-gpt`), proxy autostart, and GPT-friendly harness tuning:

```bash
./launcher/claudex.sh            # macOS / Linux / Git Bash
launcher\claudex.ps1             # Windows PowerShell
```

## The models

Slugs come from the Codex models manifest; all three stream, call tools in parallel,
accept images, and support reasoning summaries.

| slug | role | reasoning efforts | mapped from |
|---|---|---|---|
| `gpt-5.6-sol` | frontier agentic coding | low…**ultra** | `claude-opus-*` (+ default) |
| `gpt-5.6-terra` | balanced everyday work | low…ultra | `claude-sonnet-*` |
| `gpt-5.6-luna` | fast & affordable | low…max | `claude-haiku-*`, background tasks |

Claude Code asks for Claude ids (including hidden background calls); the alias table
routes every one of them to a GPT-5.6 sibling. `/model gpt-5.6-terra` also Just Works
(unknown `gpt-*` ids pass through).

### Choosing thinking effort

Claude Code's effort UI stops at *high*, but GPT-5.6 goes up to *ultra*. mgga resolves
effort with this priority (every rung clamps into the model's supported tiers):

1. `MGGA_EFFORT` env on the proxy — global ops pin
2. **a `:effort` model suffix** — `/model gpt-5.6-sol:ultra` — the only door to
   `xhigh` / `max` / `ultra`; persists for the session because Claude Code replays
   the model string on every request
3. Claude Code's /model effort selector (`output_config.effort`, low / medium / high)
4. legacy `thinking.budget_tokens` → the configurable `effortMap`
5. adaptive thinking → `medium` (the GPT-5.6 factory default); disabled → `effortFloor`

Subagents: the in-UI selector propagates to them automatically (verified live —
a subagent ran `terra@high` with the selector at high). For depth beyond the UI,
`CLAUDEX_EFFORT=max claudex` suffixes every model tier for the whole session, and
per-task depth is the mother agent's choice between the bundled agent tiers:
[`gpt-quick`](examples/agents/gpt-quick.md) (luna) / [`gpt`](examples/agents/gpt.md)
(sol) / [`gpt-deep`](examples/agents/gpt-deep.md) (sol:max) — the agent descriptions
tell the caller when each tier is worth the spend.

## Configuration

Everything is data, not code. Drop an `mgga.config.json` next to the process (or point
`MGGA_CONFIG` at one):

```jsonc
{
  "port": 5656,
  "backend": "chatgpt",              // chatgpt | openai | mock
  "defaultModel": "gpt-5.6-sol",
  "aliases": {                        // pattern → slug, first match wins
    "claude-opus-*": "gpt-5.6-sol",
    "claude-sonnet-*": "gpt-5.6-terra",
    "claude-haiku-*": "gpt-5.6-luna"
  },
  "effortMap": [                      // Anthropic thinking budget → OpenAI effort
    { "maxBudget": 8192,  "effort": "low" },
    { "maxBudget": 24576, "effort": "medium" },
    { "maxBudget": 65536, "effort": "high" },
    { "maxBudget": null,  "effort": "xhigh" }
  ],
  "models": {
    "gpt-5.6-sol": {
      "effortFloor": "low",           // effort when the client doesn't ask for thinking
      "reasoningHeadroom": 8192,      // extra output budget so reasoning can't starve text
      "shim": true,                   // true = built-in text, "…" = custom, false = off
      "replayReasoning": true
    }
  },
  "chatgpt": { "clientVersion": "0.144.1" },
  "openai":  { "baseUrl": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY" }
}
```

Env overrides: `MGGA_PORT`, `MGGA_BACKEND`, `MGGA_DEFAULT_MODEL`, `MGGA_EFFORT`
(pin a global effort), `MGGA_API_KEY` (require clients to present a key),
`MGGA_CONFIG`, `CODEX_HOME`.

## Backends

- **chatgpt** — rides an existing `codex login` (`~/.codex/auth.json`); no API key.
  Uses the same OAuth session as the Codex CLI, works wherever codex works.
- **openai** — `api.openai.com` or any Responses-shaped endpoint (Azure, LiteLLM,
  vLLM ≥ 0.10) via `openai.baseUrl`.
- **mock** — scripted responses; powers the test suite and credential-free demos.

### Field notes from the live wire (2026-07)

Learned by pointing this at the real ChatGPT backend — these cost us an afternoon so
they don't cost you one:

- The codex endpoint **rejects `max_output_tokens` and `truncation`** ("Unsupported
  parameter") even though api.openai.com accepts them. Backends declare
  `unsupportedParams`; the server strips them post-translation.
- The endpoint **version-gates models** on the `version` header. Too old (or missing)
  and a shipped model 400s as a bare **"Model not found"** — with the header it says
  what it means ("requires a newer version of Codex"). New model 404ing? Bump
  `chatgpt.clientVersion`.
- Replayed reasoning items are accepted **without an `id`** — signature-trick replay
  needs only `encrypted_content` (+ optional summary).
- 401s usually mean the on-disk Codex token aged out: run the Codex CLI once (or
  `codex login`) and retry — mgga re-reads the file automatically on the first 401.

## Subscription quota, live

The Codex backend reports subscription usage on every response (x-codex-* headers);
mgga snapshots the latest reading and serves it at `GET /quota` — checking costs
nothing. `launcher/statusline.mjs` puts it in Claude Code's status bar:

```
gpt-5.6-sol | 5h 4% (resets 2.8h) | wk 23% (resets 5.2d) | pro
```

Wire it up in your Claude Code profile's `settings.json`:

```json
{ "statusLine": { "type": "command", "command": "node \"<repo>/launcher/statusline.mjs\"" } }
```

Note the billing identity: everything claudex spends comes out of the SAME ChatGPT
subscription windows as your Codex CLI — Claude Code's "API usage" cost display is
its own fiction (it never sees the real billing path).

## Ask GPT from anywhere (CLI & MCP)

The HTTP proxy is not the only door — the same pipeline runs in-process:

```bash
mgga ask "why is this regex catastrophic?"        # one-shot answer, no server needed
git diff | mgga ask "review this diff"            # stdin pipes in
mgga ask -m gpt-5.6-sol:high "prove it"           # effort by suffix, same grammar
```

And `mgga mcp` is a stdio MCP server exposing the same thing as an **`ask_gpt` tool**,
so *other agents* can drink from it. Wire it into your Claude Code (any install — it
lands in your user config):

```bash
claude mcp add --scope user gpt -- node <repo>/dist/index.js mcp
```

Yes, that means Claude consulting GPT mid-task as a native tool call — a second
frontier opinion, one invocation away, billed to the same subscription.

## GPT subagents inside a real Claude session (mixed mode)

`ask_gpt` is stateless Q&A. For the full thing — Claude **delegating a task to a GPT
subagent that has its own tool loop** — turn on mixed mode:

```jsonc
// mgga.config.json               (or: MGGA_ANTHROPIC_PASSTHROUGH=1 mgga serve)
{ "anthropic": { "passthrough": true } }
```

then point your *normal* Claude Code at mgga (`ANTHROPIC_BASE_URL=http://127.0.0.1:5656`).
The proxy now splits traffic by family:

- `claude-*` → forwarded to `api.anthropic.com` **byte-for-byte** — your own
  credentials, your prompt-cache prefixes, untouched. mgga is a transparent pipe.
- `gpt-*` → the translation pipeline, as ever.

Drop [`examples/agents/gpt.md`](examples/agents/gpt.md) into `~/.claude/agents/` and
Claude gains a native `gpt` subagent: `Task(subagent_type: "gpt", prompt: …)` spawns
GPT-5.6 with full tool access inside your Claude session. Two frontier families, one
harness, cross-checking each other.

Trade-off to know: in mixed mode your Claude traffic depends on mgga being up. It is
a very thin pipe — but it is a pipe. Keep `mgga serve` supervised or wired to your
shell's launcher.

## Testing

```bash
npm test                      # 119 offline tests — the wire protocol spec, executable
node scripts/live-smoke.mjs   # optional: 2-turn tool loop against the real backend
```

The test suite is written as documentation: every fixer has a THE PROBLEM header and
scenario names that read as protocol rules. If you add a fixer, `mgga doctor` and
`tests/doctor.test.ts` will hold you to registering and explaining it.

## Non-goals (v1)

Strict-mode tool schemas, Anthropic server tools (web search), self-refreshing OAuth
(the Codex CLI owns token rotation), retries (Claude Code already backs off correctly).
Rationale in [ARCHITECTURE.md](ARCHITECTURE.md#non-goals).

## Disclaimer

mgga is an independent project, affiliated with neither OpenAI nor Anthropic. The
`chatgpt` backend rides *your own* Codex CLI login on *your own* subscription — mind
the applicable terms of service, and expect that unofficial surface to change without
notice (that's what `mgga doctor`, the version-gate note, and the live-smoke script
are for). No telemetry, no middleman: your prompts go from your machine to OpenAI,
full stop.

## Star History

<a href="https://star-history.com/#Civitasmass/make-gpt-great-again&Date">Track this repo on star-history.com</a>
<!-- The chart renders once the repo has stars and is indexed — swap back in then:
[![Star History Chart](https://api.star-history.com/svg?repos=Civitasmass/make-gpt-great-again&type=Date)](https://star-history.com/#Civitasmass/make-gpt-great-again&Date)
-->

## License

MIT
