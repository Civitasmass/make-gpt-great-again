import { describe, expect, it } from 'vitest';
import { formatSse, parseSseStream } from '../src/util/sse.js';
import { collect, fromArray } from './helpers.js';

/**
 * Both directions of mgga are SSE, and the classic proxy bug is assuming one
 * network chunk == one event. OpenAI happily splits an event across TCP
 * chunks (and uses CRLF); if the parser hiccups, the user sees half a tool
 * call and a dead session. These tests pin the parser against exactly those
 * conditions.
 */
describe('parseSseStream', () => {
  it('parses a single well-formed event', async () => {
    const events = await collect(parseSseStream(fromArray(['data: {"a":1}\n\n'])));
    expect(events).toEqual([{ event: null, data: '{"a":1}' }]);
  });

  it('reassembles an event split across arbitrary chunk boundaries', async () => {
    const wire = 'event: response.output_text.delta\ndata: {"delta":"hel' + 'lo"}\n\n';
    for (const cut of [1, 5, 17, wire.length - 2]) {
      const events = await collect(parseSseStream(fromArray([wire.slice(0, cut), wire.slice(cut)])));
      expect(events).toEqual([
        { event: 'response.output_text.delta', data: '{"delta":"hello"}' },
      ]);
    }
  });

  it('handles CRLF line endings (some proxies re-serialise this way)', async () => {
    const events = await collect(parseSseStream(fromArray(['data: 1\r\n\r\ndata: 2\r\n\r\n'])));
    expect(events.map((e) => e.data)).toEqual(['1', '2']);
  });

  it('joins multi-line data fields with newlines, per the SSE spec', async () => {
    const events = await collect(parseSseStream(fromArray(['data: line1\ndata: line2\n\n'])));
    expect(events).toEqual([{ event: null, data: 'line1\nline2' }]);
  });

  it('ignores comment lines and unknown fields', async () => {
    const events = await collect(
      parseSseStream(fromArray([': keep-alive\nretry: 100\ndata: x\n\n'])),
    );
    expect(events).toEqual([{ event: null, data: 'x' }]);
  });

  it('flushes a final event that lacks the trailing blank line', async () => {
    const events = await collect(parseSseStream(fromArray(['data: last\n'])));
    expect(events).toEqual([{ event: null, data: 'last' }]);
  });

  it('yields [DONE] sentinels — dropping them is the caller’s policy', async () => {
    const events = await collect(parseSseStream(fromArray(['data: [DONE]\n\n'])));
    expect(events).toEqual([{ event: null, data: '[DONE]' }]);
  });

  it('decodes UTF-8 split in the middle of a multibyte character', async () => {
    const bytes = new TextEncoder().encode('data: 你好\n\n');
    const cut = 8; // inside the first CJK character
    const events = await collect(
      parseSseStream(fromArray([bytes.slice(0, cut), bytes.slice(cut)])),
    );
    expect(events).toEqual([{ event: null, data: '你好' }]);
  });
});

describe('formatSse', () => {
  it('emits the exact Anthropic wire shape: event line, data line, blank line', () => {
    expect(formatSse('ping', { type: 'ping' })).toBe('event: ping\ndata: {"type":"ping"}\n\n');
  });
});
