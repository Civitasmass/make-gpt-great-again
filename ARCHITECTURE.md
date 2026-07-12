# mgga architecture

One process, one pass, no state:

```
POST /v1/messages (Anthropic dialect, from Claude Code)
  │
  ├─ resolveModel()          config.ts     claude-* → gpt-5.6-* (alias table)
  ├─ REQUEST_FIXERS          pipeline/     Anthropic → Anthropic normalisation
  │    strip-cache-control → system-shim → schema-lowering →
  │    reasoning-bridge → tool-id-bridge → effort-and-budget
  ├─ translateRequest()      translate/    Anthropic → Responses dialect
  ├─ strip backend.unsupportedParams       (per-endpoint dialect, server-side)
  ├─ Backend.stream()        backends/     transport only (openai | chatgpt | mock)
  ├─ translateStream()       translate/    Responses SSE → Anthropic SSE
  ├─ RESPONSE_FIXERS         pipeline/     tool-json-guard
  └─ SSE out … or collectMessage() for stream:false
```

Design rules that keep it honest:

- **Fixers are pure** (request in, request out) and ordered; the order is documented
  in `pipeline/index.ts` and it is part of the contract.
- **Backends are transports.** All model knowledge lives in fixers/translators, so
  every backend gets every fix. The single exception is `unsupportedParams` — a
  *declaration* of endpoint dialect that the server enforces, so backends still never
  edit requests.
- **The proxy is stateless.** Anything that must survive between turns travels
  through the client (see the signature trick). You can kill and restart mgga
  mid-session and nothing is lost.
- **Model policy is data.** Routing aliases, effort ladders, output ceilings, and the
  system shim are config with shipped defaults — a new GPT generation should be a
  config edit, not a code change.

## The signature trick

The problem: OpenAI reasoning models emit *encrypted* reasoning items. With
`store:false` (mandatory for a stateless proxy, and what codex itself uses) OpenAI
keeps nothing server-side; if the next request doesn't replay those items, the model
re-derives its plan from scratch on every tool call. That is precisely the "GPT is
somehow dumb through a proxy" experience.

The observation: Anthropic's protocol already round-trips an opaque token on thinking
blocks — `signature`. Claude Code preserves and replays it faithfully and never looks
inside.

So mgga maps one onto the other, symmetrically:

- **capture** (`translate/stream.ts`): reasoning summaries stream as `thinking_delta`;
  when the reasoning item completes, its `encrypted_content` is emitted as a
  `signature_delta`. A reasoning item with no summary still opens/closes a thinking
  block so the signature has a home.
- **replay** (`pipeline/fixers/reasoning-bridge.ts` + `translate/request.ts`): a
  signed thinking block in assistant history becomes a `reasoning` input item with
  `encrypted_content = signature`. Unsigned/redacted thinking is dropped with a
  warning — there is nothing upstream can do with it.

Verified live (2026-07-12, ChatGPT backend): replayed items are accepted without an
`id`, and the continuation visibly uses the earlier plan.

## Backends

- `openai.ts` — `POST {baseUrl}/responses`, `Authorization: Bearer $KEY`. Works with
  any Responses-shaped endpoint; that's why baseUrl is config.
- `chatgpt.ts` — the Codex backend at `chatgpt.com/backend-api/codex/responses`,
  riding `~/.codex/auth.json` (`codex login`). Headers that matter:
  `chatgpt-account-id` (from auth.json or the id_token JWT), `originator`,
  `OpenAI-Beta: responses=experimental`, and `version` — the endpoint version-gates
  models by it (a missing/old version turns "upgrade your CLI" into a bare
  "Model not found"). On a first-401 the auth file is re-read once, because a running
  Codex CLI rotates tokens in place. mgga deliberately does NOT refresh OAuth tokens
  itself: two writers on one refresh-token family is how you corrupt a login.
- `mock.ts` — scripted events; also exports the script builders the tests share.

## Capturing traffic

When something disagrees with these docs, capture reality and update the contract:

- **Anthropic side**: run Claude Code with `ANTHROPIC_BASE_URL` pointed at mgga and
  read the server log (`[mgga] model → target` lines), or park `nc -l` on the port
  for one request.
- **OpenAI side**: `scripts/live-smoke.mjs` exercises a two-turn tool loop; add
  `console.error(JSON.stringify(req))` in a backend for one run when you need the
  exact wire shape. Keep captured blobs out of the repo — they embed account ids.

## Non-goals

- **strict tool schemas** — Claude Code's schemas aren't strict-compatible
  (`additionalProperties`, optionality); GPT-5.6 is reliable on plain JSON mode, and
  lowering semantics silently is worse than not promising them.
- **Anthropic server tools** (web_search etc.) — they execute inside Anthropic's
  cloud; faking them client-side would be a different product.
- **OAuth refresh** — the Codex CLI owns token rotation; we only re-read its file.
- **retries** — Claude Code's backoff is already correct; double-retrying multiplies
  load exactly when upstream is hurting.
- **exact tokenisation** — count_tokens is a documented estimate (±15%); the context
  meter needs direction, not decimals.
