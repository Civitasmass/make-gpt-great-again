import type { AnthropicErrorEnvelope, AnthropicErrorType } from './types/anthropic.js';

/**
 * Thrown by architecture stubs. The `contract` string tells the implementer
 * exactly which doc section / test file specifies the expected behaviour, so a
 * failing call is a work item, not a mystery.
 */
export class NotImplementedError extends Error {
  readonly contract: string;

  constructor(what: string, contract: string) {
    super(`mgga: ${what} is not implemented yet. Contract: ${contract}`);
    this.name = 'NotImplementedError';
    this.contract = contract;
  }
}

/** An upstream (or internal) failure already translated to the Anthropic error dialect. */
export class UpstreamError extends Error {
  readonly status: number;
  readonly envelope: AnthropicErrorEnvelope;
  /** Propagated so clients can honour upstream rate-limit pacing. */
  readonly retryAfter?: string;

  constructor(status: number, envelope: AnthropicErrorEnvelope, retryAfter?: string) {
    super(envelope.error.message);
    this.name = 'UpstreamError';
    this.status = status;
    this.envelope = envelope;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export function errorEnvelope(type: AnthropicErrorType, message: string): AnthropicErrorEnvelope {
  return { type: 'error', error: { type, message } };
}

/** The HTTP status Anthropic pairs with each error type — what Claude Code's retry logic keys on. */
export function statusForErrorType(type: AnthropicErrorType): number {
  switch (type) {
    case 'invalid_request_error': return 400;
    case 'authentication_error': return 401;
    case 'permission_error': return 403;
    case 'not_found_error': return 404;
    case 'request_too_large': return 413;
    case 'rate_limit_error': return 429;
    case 'api_error': return 500;
    case 'overloaded_error': return 529;
  }
}
