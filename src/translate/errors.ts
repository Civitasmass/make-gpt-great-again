import type { AnthropicErrorType, AnthropicStreamEvent } from '../types/anthropic.js';
import { UpstreamError, errorEnvelope, statusForErrorType } from '../errors.js';

/**
 * OpenAI error dialect → Anthropic error dialect.
 *
 * Claude Code's retry/backoff logic keys on Anthropic error types and HTTP
 * status codes, so faithful mapping here is what makes rate limits and
 * outages degrade gracefully instead of crashing the session.
 *
 * ## Contract (spec'd by tests/translate.errors.test.ts)
 *
 * translateHttpError(status, body, retryAfter?):
 *   - Parse body as {"error": {...}} when possible; the Anthropic message is
 *     `upstream(openai): ${error.message}` (or the raw body, truncated to
 *     512 chars, when unparseable). Never swallow the upstream message —
 *     it is the only debugging signal the user gets.
 *   - Status → Anthropic type: 400→invalid_request_error,
 *     401→authentication_error, 403→permission_error, 404→not_found_error,
 *     413→request_too_large, 429→rate_limit_error, 500-502→api_error,
 *     503/529→overloaded_error, anything else→api_error.
 *   - Returns (not throws) an UpstreamError carrying the mapped status,
 *     envelope, and retryAfter passthrough.
 *
 * streamError(event): mid-stream `error` / `response.failed` → the Anthropic
 *   SSE `error` event. code 'rate_limit_exceeded'→rate_limit_error,
 *   'server_error'→api_error, anything else→api_error, message preserved.
 */

const BODY_EXCERPT_CHARS = 512;

function anthropicTypeForStatus(status: number): AnthropicErrorType {
  switch (status) {
    case 400: return 'invalid_request_error';
    case 401: return 'authentication_error';
    case 403: return 'permission_error';
    case 404: return 'not_found_error';
    case 413: return 'request_too_large';
    case 429: return 'rate_limit_error';
    case 503:
    case 529: return 'overloaded_error';
    default: return 'api_error'; // 500–502 and anything unexpected
  }
}

export function translateHttpError(
  status: number,
  body: string,
  retryAfter?: string,
): UpstreamError {
  let upstreamMessage: string | undefined;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed?.error?.message === 'string') upstreamMessage = parsed.error.message;
  } catch {
    // Unparseable body (HTML gateway page, empty string, …) — excerpt it below.
  }
  const message = `upstream(openai): ${upstreamMessage ?? body.slice(0, BODY_EXCERPT_CHARS)}`;
  const type = anthropicTypeForStatus(status);
  return new UpstreamError(statusForErrorType(type), errorEnvelope(type, message), retryAfter);
}

export function streamError(event: { code?: string | null; message: string }): AnthropicStreamEvent {
  const type: AnthropicErrorType =
    event.code === 'rate_limit_exceeded' ? 'rate_limit_error' : 'api_error';
  return { type: 'error', error: { type, message: `upstream(openai): ${event.message}` } };
}
