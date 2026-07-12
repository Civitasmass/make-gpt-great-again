import type { ResponsesRequest, ResponsesStreamEvent } from '../types/openai.js';
import type { ResolvedConfig } from '../config.js';

/**
 * A backend is a transport, nothing more: it takes a fully-translated OpenAI
 * Responses request and yields Responses stream events. All model knowledge
 * lives in the shared translator/fixers, so every backend gets every fix.
 *
 * Shipping backends:
 *  - openai  — api.openai.com (or any compatible base URL) with an API key.
 *  - chatgpt — the Codex backend, riding an existing `codex login` (OAuth
 *              tokens from ~/.codex/auth.json). Works anywhere the Codex CLI
 *              works: macOS, Linux, Windows, WSL.
 *  - mock    — scripted events for tests and offline demos.
 */
/** One rate-limit window as reported by the upstream (e.g. Codex 5h / weekly). */
export interface QuotaWindow {
  usedPercent: number;
  windowMinutes: number;
  /** ISO timestamp of the window reset. */
  resetsAt: string;
}

/** Latest upstream quota reading; refreshed passively from response headers. */
export interface QuotaSnapshot {
  capturedAt: string;
  planType?: string;
  primary?: QuotaWindow;
  secondary?: QuotaWindow;
}

export interface Backend {
  readonly name: string;
  /**
   * Request params this endpoint hard-rejects ("Unsupported parameter" 400s).
   * The SERVER strips them after translation — backends still never edit
   * requests, they only declare their dialect. Discovered live: the ChatGPT
   * codex endpoint rejects fields api.openai.com accepts.
   */
  readonly unsupportedParams?: ReadonlyArray<keyof ResponsesRequest>;
  /** Latest quota reading, if this backend can see one (GET /quota serves it). */
  readonly quota?: () => QuotaSnapshot | null;
  /**
   * Must yield parsed SSE events until the terminal `response.completed` /
   * `response.failed` / `response.incomplete` / `error` event, honour `signal`
   * by aborting the upstream request, and throw UpstreamError (already in the
   * Anthropic error dialect via translate/errors.ts) on non-2xx responses.
   */
  stream(req: ResponsesRequest, opts: { signal: AbortSignal }): AsyncIterable<ResponsesStreamEvent>;
}

export async function createBackend(cfg: ResolvedConfig): Promise<Backend> {
  switch (cfg.backend) {
    case 'openai': {
      const { OpenAIBackend } = await import('./openai.js');
      return new OpenAIBackend(cfg.openai);
    }
    case 'chatgpt': {
      const { ChatGptBackend } = await import('./chatgpt.js');
      return new ChatGptBackend(cfg.chatgpt);
    }
    case 'mock': {
      const { MockBackend } = await import('./mock.js');
      return MockBackend.hello();
    }
  }
}
