import { describe, expect, it } from 'vitest';
import { streamError, translateHttpError } from '../src/translate/errors.js';

/**
 * Claude Code's retry/backoff keys on Anthropic error types + status codes.
 * Faithful mapping is the difference between "waits politely for the rate
 * limit" and "hammers a dead endpoint / crashes the session". The upstream
 * message must survive verbatim — it is the only debugging signal users get.
 */
describe('translateHttpError', () => {
  const CASES: Array<[number, string]> = [
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [403, 'permission_error'],
    [404, 'not_found_error'],
    [413, 'request_too_large'],
    [429, 'rate_limit_error'],
    [500, 'api_error'],
    [502, 'api_error'],
    [503, 'overloaded_error'],
    [529, 'overloaded_error'],
    [418, 'api_error'], // anything unexpected degrades to api_error
  ];

  it.each(CASES)('maps upstream %i to anthropic %s', (status, type) => {
    const err = translateHttpError(status, '{"error":{"message":"boom"}}');
    expect(err.envelope.error.type).toBe(type);
  });

  it('preserves the upstream message with provenance', () => {
    const err = translateHttpError(400, '{"error":{"message":"Unknown parameter: cache_control"}}');
    expect(err.envelope.error.message).toContain('upstream(openai)');
    expect(err.envelope.error.message).toContain('Unknown parameter: cache_control');
  });

  it('survives an unparseable body by truncating it into the message', () => {
    const err = translateHttpError(500, '<html>' + 'x'.repeat(2000));
    expect(err.envelope.error.message.length).toBeLessThan(600);
    expect(err.envelope.error.message).toContain('<html>');
  });

  it('carries retry-after through for client backoff', () => {
    const err = translateHttpError(429, '{"error":{"message":"rate limited"}}', '17');
    expect(err.retryAfter).toBe('17');
    expect(err.status).toBe(429);
  });
});

describe('streamError', () => {
  it('maps rate-limit stream errors so Claude Code backs off instead of dying', () => {
    const event = streamError({ code: 'rate_limit_exceeded', message: 'slow down' });
    expect(event).toEqual({
      type: 'error',
      error: { type: 'rate_limit_error', message: expect.stringContaining('slow down') },
    });
  });

  it('degrades unknown codes to api_error, message preserved', () => {
    const event = streamError({ code: 'mystery_code', message: 'something odd' });
    expect(event).toMatchObject({
      type: 'error',
      error: { type: 'api_error', message: expect.stringContaining('something odd') },
    });
  });
});
