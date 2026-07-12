import { describe, expect, it } from 'vitest';
import { toolJsonGuard } from '../../src/pipeline/fixers/tool-json-guard.js';
import type { AnthropicStreamEvent } from '../../src/types/anthropic.js';
import { collect, fromArray, makeCtx } from '../helpers.js';

/**
 * THE PROBLEM: a stream that dies mid-tool-call (token limit, upstream blip)
 * leaves truncated JSON arguments like `{"file_path": "src/ind`. Claude Code
 * fails the JSON parse and the whole agent turn dies. One flaky chunk should
 * cost one retried tool call, not the session.
 */
function toolStream(jsonChunks: string[]): AnthropicStreamEvent[] {
  return [
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_call_1', name: 'Read', input: {} },
    },
    ...jsonChunks.map(
      (partial_json): AnthropicStreamEvent => ({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json },
      }),
    ),
    { type: 'content_block_stop', index: 0 },
  ];
}

/** Reassemble whatever JSON the guard let through for block 0. */
function emittedJson(events: AnthropicStreamEvent[]): string {
  return events
    .filter(
      (e): e is Extract<AnthropicStreamEvent, { type: 'content_block_delta' }> =>
        e.type === 'content_block_delta',
    )
    .map((e) => (e.delta.type === 'input_json_delta' ? e.delta.partial_json : ''))
    .join('');
}

describe('response fixer: tool-json-guard', () => {
  it('passes valid JSON through untouched, preserving the original chunking', async () => {
    const events = toolStream(['{"file_path"', ': "a.ts"}']);
    const out = await collect(toolJsonGuard.wrap(fromArray(events), makeCtx()));
    expect(out).toEqual(events);
  });

  it('mechanically closes truncated JSON so the client can parse it', async () => {
    const ctx = makeCtx();
    const out = await collect(
      toolJsonGuard.wrap(fromArray(toolStream(['{"file_path": "src/ind'])), ctx),
    );
    expect(() => JSON.parse(emittedJson(out))).not.toThrow();
    expect(ctx.warnings.some((w) => w.fixer === 'tool-json-guard')).toBe(true);
    // The stream still ends properly — stop event intact.
    expect(out.at(-1)).toEqual({ type: 'content_block_stop', index: 0 });
  });

  it('falls back to {} when the JSON is beyond repair — a retryable bad call, not a dead session', async () => {
    const ctx = makeCtx();
    const out = await collect(
      toolJsonGuard.wrap(fromArray(toolStream(['{"a": nope nope['])), ctx),
    );
    expect(() => JSON.parse(emittedJson(out))).not.toThrow();
    expect(ctx.warnings.length).toBeGreaterThan(0);
  });

  it('treats an empty argument stream as {}', async () => {
    const out = await collect(toolJsonGuard.wrap(fromArray(toolStream([])), makeCtx()));
    expect(JSON.parse(emittedJson(out) || '{}')).toEqual({});
  });

  it('does not buffer or reorder text blocks — only tool_use pays the latency', async () => {
    const textEvents: AnthropicStreamEvent[] = [
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hel' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
      { type: 'content_block_stop', index: 0 },
    ];
    const out = await collect(toolJsonGuard.wrap(fromArray(textEvents), makeCtx()));
    expect(out).toEqual(textEvents);
  });
});
