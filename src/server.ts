import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AnthropicCountTokensRequest, AnthropicMessagesRequest } from './types/anthropic.js';
import { NotImplementedError, UpstreamError, errorEnvelope, statusForErrorType } from './errors.js';
import type { ResolvedConfig } from './config.js';
import type { RequestContext } from './pipeline/fixer.js';
import { runPipeline } from './pipeline/run.js';
import type { Backend } from './backends/backend.js';
import { formatSse } from './util/sse.js';
import { estimateInputTokens } from './util/tokens.js';
import { collectMessage } from './util/collect.js';

/**
 * The HTTP face of mgga: an Anthropic-Messages-compatible server that Claude
 * Code points at via ANTHROPIC_BASE_URL. Endpoints:
 *
 *   POST /v1/messages               streaming and non-streaming completions
 *   POST /v1/messages/count_tokens  context-meter support
 *   GET  /v1/models                 the routing registry, Anthropic-shaped
 *   GET  /healthz                   liveness + active backend
 *
 * The server is deliberately thin: parse → route model → run request fixers →
 * translate → backend → translate stream → run response fixers → serialise.
 * Everything interesting lives in those stages; everything here is plumbing.
 */
export function createMggaServer(cfg: ResolvedConfig, backend: Backend): Server {
  const state: ServerState = { activeStreams: 0, draining: false };
  const server = createServer((req, res) => {
    void handle(req, res, cfg, backend, state, server).catch((err: unknown) => {
      // Last-resort guard; stage errors are handled (and typed) inside handle().
      console.error('[mgga] unhandled:', err);
      if (!res.headersSent) sendError(res, 500, errorEnvelope('api_error', String(err)));
      else res.end();
    });
  });
  return server;
}

interface ServerState {
  activeStreams: number;
  draining: boolean;
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: ResolvedConfig,
  backend: Backend,
  state: ServerState,
  server: Server,
): Promise<void> {
  const url = (req.url ?? '/').split('?')[0]!;

  if (req.method === 'GET' && url === '/healthz') {
    return sendJson(res, 200, {
      ok: !state.draining,
      backend: backend.name,
      models: Object.keys(cfg.models),
      activeStreams: state.activeStreams,
      ...(state.draining ? { draining: true } : {}),
    });
  }

  // Graceful restart: stop accepting new work, let in-flight streams finish,
  // then exit — so upgrading the proxy never cuts a session mid-response.
  // Loopback-only by construction (the server binds wherever the user says,
  // but shutdown must come from the same machine).
  if (req.method === 'POST' && url === '/shutdown') {
    const remote = req.socket.remoteAddress ?? '';
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      return sendError(res, 403, errorEnvelope('permission_error', 'shutdown is loopback-only'));
    }
    state.draining = true;
    sendJson(res, 202, { draining: true, activeStreams: state.activeStreams });
    console.error(`[mgga] draining — ${state.activeStreams} stream(s) in flight`);
    server.close(() => process.exit(0)); // resolves when the last connection ends
    setTimeout(() => {
      console.error('[mgga] drain timeout — exiting with streams still open');
      process.exit(0);
    }, 120_000).unref();
    const poll = setInterval(() => {
      if (state.activeStreams === 0) {
        clearInterval(poll);
        server.closeIdleConnections();
      }
    }, 500);
    poll.unref();
    return;
  }

  if (req.method === 'GET' && url === '/quota') {
    return sendJson(
      res,
      200,
      backend.quota?.() ?? { note: 'no quota data yet — it arrives with the first upstream response' },
    );
  }

  if (req.method === 'GET' && url === '/v1/models') {
    return sendJson(res, 200, {
      data: Object.keys(cfg.models).map((id) => ({ id, type: 'model', display_name: id })),
      has_more: false,
    });
  }

  if (req.method !== 'POST' || (url !== '/v1/messages' && url !== '/v1/messages/count_tokens')) {
    return sendError(res, 404, errorEnvelope('not_found_error', `no route for ${req.method} ${url}`));
  }

  if (!authorized(req, cfg)) {
    return sendError(res, 401, errorEnvelope('authentication_error', 'invalid x-api-key'));
  }

  const rawBody = await readBody(req);
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return sendError(res, 400, errorEnvelope('invalid_request_error', 'request body is not valid JSON'));
  }

  // Mixed mode: claude-* traffic is not ours to translate — hand it to
  // Anthropic byte-for-byte and let GPT and Claude share one proxy.
  if (cfg.anthropic.passthrough && ((body as { model?: string }).model ?? '').startsWith('claude-')) {
    state.activeStreams++;
    try {
      return await proxyToAnthropic(req, res, rawBody, cfg);
    } finally {
      state.activeStreams--;
    }
  }

  if (url === '/v1/messages/count_tokens') {
    const count = estimateInputTokens(body as AnthropicCountTokensRequest);
    return sendJson(res, 200, { input_tokens: count });
  }

  const request = body as AnthropicMessagesRequest;

  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  let ctx: RequestContext | undefined;
  state.activeStreams++;
  try {
    const run = runPipeline(request, cfg, backend, abort.signal);
    ctx = run.ctx;
    const guarded = run.events;
    console.error(
      `[mgga] ${request.model} → ${run.route.target}@${ctx.reasoningEffort} (${run.route.via}) stream=${request.stream === true}`,
    );

    if (request.stream === true) {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      for await (const event of guarded) {
        res.write(formatSse(event.type, event));
      }
      res.end();
    } else {
      const message = await collectMessage(guarded);
      sendJson(res, 200, message);
    }
  } catch (err) {
    handleStageError(err, res);
  } finally {
    state.activeStreams--;
    for (const w of ctx?.warnings ?? []) console.error(`[mgga] warn ${w.fixer}: ${w.message}`);
  }
}

/** Headers worth forwarding each way. Everything else (host, length, encoding) is transport-local. */
const PASSTHROUGH_REQUEST_HEADERS = [
  'authorization',
  'x-api-key',
  'anthropic-version',
  'anthropic-beta',
  'anthropic-dangerous-direct-browser-access',
  'content-type',
  'accept',
  'user-agent',
  'x-app',
] as const;
const PASSTHROUGH_RESPONSE_HEADERS = ['content-type', 'request-id', 'retry-after'] as const;

/**
 * Mixed-mode reverse proxy: the request travels to Anthropic exactly as the
 * client built it — same bytes (prompt-cache prefixes survive), same auth
 * (the client's own subscription/API credentials; mgga holds none). SSE or
 * JSON, the response streams straight back.
 */
async function proxyToAnthropic(
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: string,
  cfg: ResolvedConfig,
): Promise<void> {
  const abort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) abort.abort();
  });

  const headers: Record<string, string> = {};
  for (const name of PASSTHROUGH_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${cfg.anthropic.baseUrl}${req.url ?? '/v1/messages'}`, {
      method: 'POST',
      headers,
      body: rawBody,
      signal: abort.signal,
    });
  } catch (err) {
    if (abort.signal.aborted) return;
    return sendError(res, 502, errorEnvelope('api_error', `anthropic passthrough failed: ${String(err)}`));
  }
  console.error(`[mgga] ⇄ anthropic passthrough (${upstream.status})`);

  const responseHeaders: Record<string, string> = {};
  for (const name of PASSTHROUGH_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) responseHeaders[name] = value;
  }
  res.writeHead(upstream.status, responseHeaders);
  if (!upstream.body) return void res.end();
  try {
    for await (const chunk of upstream.body) res.write(chunk);
  } catch {
    // client or upstream went away mid-stream — nothing left to salvage
  }
  res.end();
}

function handleStageError(err: unknown, res: ServerResponse): void {
  if (err instanceof NotImplementedError) {
    return emitError(res, 501, errorEnvelope('api_error', err.message));
  }
  if (err instanceof UpstreamError) {
    const headers = err.retryAfter !== undefined ? { 'retry-after': err.retryAfter } : undefined;
    return emitError(res, err.status, err.envelope, headers);
  }
  return emitError(res, 500, errorEnvelope('api_error', err instanceof Error ? err.message : String(err)));
}

/** Errors after SSE headers are sent must ride the stream as an `error` event. */
function emitError(
  res: ServerResponse,
  status: number,
  envelope: ReturnType<typeof errorEnvelope>,
  headers?: Record<string, string>,
): void {
  if (res.headersSent) {
    res.write(formatSse('error', envelope));
    res.end();
    return;
  }
  if (headers) for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  sendJson(res, status, envelope);
}

function authorized(req: IncomingMessage, cfg: ResolvedConfig): boolean {
  if (cfg.apiKey === null) return true;
  const presented =
    (req.headers['x-api-key'] as string | undefined) ??
    (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  return presented === cfg.apiKey;
}

const MAX_BODY_BYTES = 64 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new UpstreamError(413, errorEnvelope('request_too_large', 'request body exceeds 64MB')));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, envelope: ReturnType<typeof errorEnvelope>): void {
  sendJson(res, status, envelope);
}

export { statusForErrorType };
