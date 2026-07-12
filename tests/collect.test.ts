import { describe, expect, it } from 'vitest';
import type { AnthropicStreamEvent } from '../src/types/anthropic.js';
import { UpstreamError } from '../src/errors.js';
import { collectMessage } from '../src/util/collect.js';
import { fromArray } from './helpers.js';

/**
 * collectMessage() is our executable definition of the Anthropic stream
 * grammar: it folds events into the non-streaming message shape. It backs the
 * `stream:false` code path AND the stream-translator tests, so it has to be
 * trustworthy on its own.
 */
const START: AnthropicStreamEvent = {
  type: 'message_start',
  message: {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-4-7',
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 0 },
  },
};

describe('collectMessage', () => {
  it('folds text, tool_use (chunked JSON), and thinking blocks into a message', async () => {
    const message = await collectMessage(
      fromArray<AnthropicStreamEvent>([
        START,
        { type: 'ping' },
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan…' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'ENC' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Run' } },
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'ning ls' } },
        { type: 'content_block_stop', index: 1 },
        { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_call_1', name: 'Bash', input: {} } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"comm' } },
        { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: 'and":"ls"}' } },
        { type: 'content_block_stop', index: 2 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 10, output_tokens: 25 } },
        { type: 'message_stop' },
      ]),
    );

    expect(message.content).toEqual([
      { type: 'thinking', thinking: 'plan…', signature: 'ENC' },
      { type: 'text', text: 'Running ls' },
      { type: 'tool_use', id: 'toolu_call_1', name: 'Bash', input: { command: 'ls' } },
    ]);
    expect(message.stop_reason).toBe('tool_use');
    expect(message.usage.output_tokens).toBe(25);
  });

  it('treats an empty tool-args buffer as {}', async () => {
    const message = await collectMessage(
      fromArray<AnthropicStreamEvent>([
        START,
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'NoArgs', input: {} } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { input_tokens: 1, output_tokens: 1 } },
        { type: 'message_stop' },
      ]),
    );
    expect(message.content[0]).toMatchObject({ type: 'tool_use', input: {} });
  });

  it('rethrows a mid-stream error event as an UpstreamError with the mapped status', async () => {
    const stream = fromArray<AnthropicStreamEvent>([
      START,
      { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
    ]);
    await expect(collectMessage(stream)).rejects.toMatchObject({
      constructor: UpstreamError,
      status: 429,
    });
  });

  it('rejects a stream that never sent message_start', async () => {
    await expect(collectMessage(fromArray<AnthropicStreamEvent>([{ type: 'message_stop' }]))).rejects.toThrow(
      /message_start/,
    );
  });
});
