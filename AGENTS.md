# Working on mgga (humans and agents alike)

The test suite is the specification. Source headers carry the contracts; tests pin
them. If code and a test disagree, assume the test is right until a LIVE capture
proves otherwise — then change BOTH the test and the header, and say why in the test.

## Ground rules

- `npm test` (offline, mock-backed) must be green before and after your change.
  `npx tsc --noEmit` too. Neither touches the network.
- A red test whose failure is a `NotImplementedError` is a WORK ITEM: the error
  message names the contract (file header + spec test) to implement.
- No runtime dependencies. The entire value of this proxy is that it is small enough
  to audit over coffee.
- Fixers are pure functions, one problem each, registered in `pipeline/index.ts`
  (order matters and is documented there), each with a `why` string that
  `mgga doctor` prints and a test file that reads as the problem statement.

## Verification

Some contracts describe OpenAI's side of the wire and can silently drift. When
touching them, re-verify against the live endpoint (`scripts/live-smoke.mjs`, or a
one-off capture per ARCHITECTURE.md §Capturing traffic) rather than trusting docs —
including these docs:

- `backends/chatgpt.ts` — headers, version gating, auth.json shape. Known live facts
  (2026-07-12): `max_output_tokens`/`truncation` rejected; models version-gated via
  the `version` header; reasoning replay accepted without item ids.
- `translate/stream.ts` — the Responses SSE event grammar.
- `types/openai.ts` — hand-written subset; extend it from captures, not from memory.

Record what you verified WITH DATES in the relevant header. "Verified live
2026-07-12" is information; "this works" is not.

## Restarting a running proxy

Killing the process cuts every in-flight session mid-response — in mixed mode
that includes the user's REAL Claude sessions. Always drain instead:

```bash
curl -X POST http://127.0.0.1:5656/shutdown   # stops new connections, exits when streams finish
# poll: curl -s http://127.0.0.1:5656/healthz  → activeStreams / draining
```

Then start the new build. Only hard-kill when the drain timeout (120s) is
unacceptable and the user has confirmed nothing important is running.

## Adding a fixer

1. `src/pipeline/fixers/<name>.ts` — header: ## Problem / ## Fix / ## Spec pointer.
2. `tests/fixers/<name>.test.ts` — a THE PROBLEM comment plus scenarios named as
   behaviours, not methods.
3. Register in `pipeline/index.ts` (pick the position deliberately; update the
   ordering comment).
4. `tests/doctor.test.ts` will fail until the fixer is registered — that's the point.
