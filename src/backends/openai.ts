import type { ResponsesRequest, ResponsesStreamEvent } from '../types/openai.js';
import type { ResolvedConfig } from '../config.js';
import type { Backend } from './backend.js';
import { UpstreamError, errorEnvelope } from '../errors.js';
import { streamResponses } from './http.js';

/**
 * Direct OpenAI Responses API backend (API-key auth).
 *
 * ## Contract (spec'd by tests/e2e.server.test.ts + ARCHITECTURE.md §Backends)
 *
 * 1. `POST {baseUrl}/responses` with `Authorization: Bearer ${env[apiKeyEnv]}`,
 *    `Content-Type: application/json`, body = the ResponsesRequest verbatim
 *    (it already carries stream/store/include — backends never edit requests).
 * 2. Non-2xx → read the body and throw via translateHttpError() so the client
 *    receives an Anthropic-dialect error with the upstream message preserved,
 *    including `retry-after` on 429s.
 * 3. 2xx → parse the SSE body with parseSseStream(), JSON.parse each `data:`
 *    payload, yield it as a ResponsesStreamEvent. Ignore `[DONE]` sentinels
 *    and blank keep-alives. Unknown event types are yielded as-is (the stream
 *    translator ignores what it doesn't know).
 * 4. `opts.signal` aborts the fetch; an abort must terminate the generator
 *    quietly (no throw) — the server already stopped listening.
 * 5. No retries here: retry policy belongs to the client (Claude Code already
 *    backs off on 429/5xx). One request in, one stream out.
 *
 * Compatible with any Responses-shaped endpoint (Azure `{resource}.openai.azure.com`,
 * LiteLLM, vLLM ≥0.10) via `openai.baseUrl` — that's the whole reason baseUrl
 * is config, not code.
 */
export class OpenAIBackend implements Backend {
  readonly name = 'openai';

  constructor(private readonly cfg: ResolvedConfig['openai']) {}

  async *stream(
    req: ResponsesRequest,
    opts: { signal: AbortSignal },
  ): AsyncIterable<ResponsesStreamEvent> {
    const envVar = this.cfg.apiKeyEnv ?? 'OPENAI_API_KEY';
    const apiKey = process.env[envVar];
    if (!apiKey) {
      throw new UpstreamError(
        401,
        errorEnvelope(
          'authentication_error',
          `${envVar} is not set — the openai backend needs an API key (or switch to backend:"chatgpt" to ride a Codex CLI login)`,
        ),
      );
    }

    yield* streamResponses(
      `${this.cfg.baseUrl}/responses`,
      { authorization: `Bearer ${apiKey}` },
      req,
      opts.signal,
    );
  }
}
