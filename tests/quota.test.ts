import { describe, expect, it } from 'vitest';
import { parseQuotaHeaders } from '../src/backends/chatgpt.js';

/**
 * The Codex backend reports subscription usage on every response via
 * x-codex-* headers (captured live 2026-07-12). mgga snapshots them so
 * GET /quota — and the claudex statusline — can show how much subscription
 * is left without spending anything to ask.
 */
describe('parseQuotaHeaders', () => {
  it('parses the live header shape into a two-window snapshot', () => {
    const headers = new Headers({
      'x-codex-plan-type': 'pro',
      'x-codex-primary-used-percent': '1',
      'x-codex-primary-window-minutes': '300',
      'x-codex-primary-reset-at': '1783840243',
      'x-codex-secondary-used-percent': '51',
      'x-codex-secondary-window-minutes': '10080',
      'x-codex-secondary-reset-at': '1784354888',
    });

    const snapshot = parseQuotaHeaders(headers)!;
    expect(snapshot.planType).toBe('pro');
    expect(snapshot.primary).toMatchObject({ usedPercent: 1, windowMinutes: 300 });
    expect(snapshot.primary!.resetsAt).toBe(new Date(1783840243 * 1000).toISOString());
    expect(snapshot.secondary).toMatchObject({ usedPercent: 51, windowMinutes: 10080 });
    expect(snapshot.capturedAt).toBeTruthy();
  });

  it('tolerates a single-window reading', () => {
    const snapshot = parseQuotaHeaders(new Headers({ 'x-codex-primary-used-percent': '7' }))!;
    expect(snapshot.primary?.usedPercent).toBe(7);
    expect(snapshot.secondary).toBeUndefined();
  });

  it('returns null when the endpoint sends no quota headers (openai backend, proxies)', () => {
    expect(parseQuotaHeaders(new Headers({ 'content-type': 'text/event-stream' }))).toBeNull();
  });
});
