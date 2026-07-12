import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ResponsesRequest, ResponsesStreamEvent } from '../types/openai.js';
import type { ResolvedConfig } from '../config.js';
import type { Backend, QuotaSnapshot, QuotaWindow } from './backend.js';
import { UpstreamError, errorEnvelope } from '../errors.js';
import { streamResponses } from './http.js';

/**
 * ChatGPT/Codex backend — GPT-5.6 through an existing `codex login`, no API key.
 *
 * The Codex CLI talks to a Responses-shaped endpoint on the ChatGPT backend.
 * This backend rides the same OAuth session, which makes mgga usable with a
 * ChatGPT subscription alone. It is inherently less official than the API
 * backend: expect the contract below to need re-verification against a live
 * Codex CLI whenever OpenAI ships a breaking change (see AGENTS.md §Verification).
 *
 * ## Contract
 *
 * 1. Credential discovery (cross-platform by construction — no WSL/mac/Windows
 *    special-casing anywhere): `auth.json` under `$CODEX_HOME`, else
 *    `~/.codex` via os.homedir(), else cfg.codexHome. Shape:
 *    `{ tokens: { access_token, account_id?, id_token? } }`. If account_id is
 *    absent, decode the `id_token` JWT and read
 *    `claims["https://api.openai.com/auth"].chatgpt_account_id`.
 * 2. `POST {baseUrl}/responses` with:
 *      Authorization: Bearer <access_token>
 *      chatgpt-account-id: <account id>
 *      originator: codex_cli_rs
 *      OpenAI-Beta: responses=experimental
 *      version: <cfg.clientVersion>
 *      accept: text/event-stream
 *    The `version` header matters: the endpoint VERSION-GATES models. Without
 *    it (or with an old value) newly-shipped models fail as a bare
 *    "Model not found <slug>"; with it the server says what it really means
 *    ("requires a newer version of Codex"). Verified live 2026-07-12 with
 *    gpt-5.6-luna: invisible at 0.137.0, streams fine at 0.144.1.
 * 3. Request invariants this endpoint enforces (translator already satisfies
 *    them, assert don't fix): stream:true, store:false,
 *    include:["reasoning.encrypted_content"].
 * 4. On 401: re-read auth.json once (the Codex CLI refreshes tokens in place;
 *    a concurrently-running codex will have rewritten the file) and retry the
 *    request a single time; then give up with an authentication_error telling
 *    the user to run `codex login`.
 * 5. Streaming/abort/error semantics identical to the openai backend.
 *
 * ## Known open risks (verify during implementation)
 * - The endpoint may reject a fully custom `instructions` string and expect a
 *   Codex-flavoured preamble. Fallback design: send Codex base instructions
 *   as `instructions` and demote our system prompt to a leading `developer`
 *   message. Gate by probing once at startup, not per request.
 * - Per-account rate limits are the subscription's; surface 429 bodies verbatim.
 */

interface CodexCredentials {
  accessToken: string;
  accountId: string | null;
  /** Where the credentials were read from — surfaced in error messages. */
  source: string;
}

export class ChatGptBackend implements Backend {
  readonly name = 'chatgpt';
  /**
   * Verified live 2026-07-12: this endpoint 400s "Unsupported parameter" on
   * fields api.openai.com accepts. Output length rides the reasoning budget
   * here — the effort-and-budget cap only applies on the openai backend.
   */
  readonly unsupportedParams = ['max_output_tokens', 'truncation'] as const;
  /** One session id per proxy process keeps upstream prompt-cache affinity. */
  private readonly sessionId = randomUUID();
  /** Refreshed passively from every 2xx response's x-codex-* headers. */
  private lastQuota: QuotaSnapshot | null = null;
  readonly quota = (): QuotaSnapshot | null => this.lastQuota;

  constructor(private readonly cfg: ResolvedConfig['chatgpt']) {}

  async *stream(
    req: ResponsesRequest,
    opts: { signal: AbortSignal },
  ): AsyncIterable<ResponsesStreamEvent> {
    assertTranslatorInvariants(req);

    let yielded = false;
    try {
      for await (const event of this.attempt(req, opts.signal)) {
        yielded = true;
        yield event;
      }
    } catch (err) {
      // 401 before any event: the on-disk token may have been rotated by a
      // running Codex CLI — re-read once and retry once.
      if (yielded || !(err instanceof UpstreamError) || err.status !== 401) throw err;
      try {
        yield* this.attempt(req, opts.signal);
      } catch (retryErr) {
        if (retryErr instanceof UpstreamError && retryErr.status === 401) {
          throw new UpstreamError(
            401,
            errorEnvelope(
              'authentication_error',
              'ChatGPT rejected the Codex session token (twice). Run the Codex CLI once — or `codex login` — to refresh auth.json, then retry.',
            ),
            retryErr.retryAfter,
          );
        }
        throw retryErr;
      }
    }
  }

  private attempt(req: ResponsesRequest, signal: AbortSignal): AsyncIterable<ResponsesStreamEvent> {
    const creds = readCodexCredentials(this.cfg);
    const headers: Record<string, string> = {
      authorization: `Bearer ${creds.accessToken}`,
      originator: 'codex_cli_rs',
      'OpenAI-Beta': 'responses=experimental',
      session_id: this.sessionId,
    };
    if (this.cfg.clientVersion) headers['version'] = this.cfg.clientVersion;
    if (creds.accountId) headers['chatgpt-account-id'] = creds.accountId;
    return streamResponses(`${this.cfg.baseUrl}/responses`, headers, req, signal, (res) => {
      const snapshot = parseQuotaHeaders(res.headers);
      if (snapshot) this.lastQuota = snapshot;
    });
  }
}

// ---------------------------------------------------------------------------
// Quota headers — the subscription meter, captured live 2026-07-12:
//   x-codex-plan-type: pro
//   x-codex-primary-used-percent: 1        (5h window,   x-codex-primary-window-minutes: 300)
//   x-codex-secondary-used-percent: 51     (weekly,      x-codex-secondary-window-minutes: 10080)
//   x-codex-{primary,secondary}-reset-at: <epoch seconds>
// ---------------------------------------------------------------------------

export function parseQuotaHeaders(headers: Headers): QuotaSnapshot | null {
  const primary = parseQuotaWindow(headers, 'primary');
  const secondary = parseQuotaWindow(headers, 'secondary');
  if (!primary && !secondary) return null;

  const snapshot: QuotaSnapshot = { capturedAt: new Date().toISOString() };
  const plan = headers.get('x-codex-plan-type');
  if (plan) snapshot.planType = plan;
  if (primary) snapshot.primary = primary;
  if (secondary) snapshot.secondary = secondary;
  return snapshot;
}

function parseQuotaWindow(headers: Headers, tier: 'primary' | 'secondary'): QuotaWindow | undefined {
  const used = headers.get(`x-codex-${tier}-used-percent`);
  if (used === null) return undefined;
  const minutes = Number(headers.get(`x-codex-${tier}-window-minutes`) ?? 0);
  const resetEpoch = Number(headers.get(`x-codex-${tier}-reset-at`) ?? 0);
  return {
    usedPercent: Number(used),
    windowMinutes: minutes,
    resetsAt: resetEpoch > 0 ? new Date(resetEpoch * 1000).toISOString() : '',
  };
}

function assertTranslatorInvariants(req: ResponsesRequest): void {
  const ok =
    req.stream === true &&
    req.store === false &&
    (req.include ?? []).includes('reasoning.encrypted_content');
  if (!ok) {
    throw new UpstreamError(
      500,
      errorEnvelope(
        'api_error',
        'internal: request violates chatgpt-backend invariants (stream:true, store:false, include reasoning.encrypted_content) — a fixer or translator regressed',
      ),
    );
  }
}

// ---------------------------------------------------------------------------
// Credential discovery
// ---------------------------------------------------------------------------

export function readCodexCredentials(cfg: ResolvedConfig['chatgpt']): CodexCredentials {
  const candidates = [process.env['CODEX_HOME'], join(homedir(), '.codex'), cfg.codexHome]
    .filter((dir): dir is string => typeof dir === 'string' && dir.length > 0)
    .map((dir) => join(dir, 'auth.json'));

  const authPath = candidates.find((path) => existsSync(path));
  if (!authPath) {
    throw new UpstreamError(
      401,
      errorEnvelope(
        'authentication_error',
        `no Codex credentials found (looked for: ${candidates.join(', ')}) — run \`codex login\` or set CODEX_HOME`,
      ),
    );
  }

  let parsed: { tokens?: { access_token?: string; account_id?: string; id_token?: string } };
  try {
    parsed = JSON.parse(readFileSync(authPath, 'utf8')) as typeof parsed;
  } catch (err) {
    throw new UpstreamError(
      401,
      errorEnvelope('authentication_error', `cannot parse ${authPath}: ${(err as Error).message}`),
    );
  }

  const accessToken = parsed.tokens?.access_token;
  if (!accessToken) {
    throw new UpstreamError(
      401,
      errorEnvelope(
        'authentication_error',
        `${authPath} has no tokens.access_token — run \`codex login\` (API-key-only auth cannot reach the ChatGPT backend; use backend:"openai" instead)`,
      ),
    );
  }

  return {
    accessToken,
    accountId: parsed.tokens?.account_id ?? accountIdFromIdToken(parsed.tokens?.id_token),
    source: authPath,
  };
}

function accountIdFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const payload = idToken.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const auth = claims['https://api.openai.com/auth'] as
      | { chatgpt_account_id?: string }
      | undefined;
    return auth?.chatgpt_account_id ?? null;
  } catch {
    return null;
  }
}
