import { describe, expect, it } from 'vitest';
import { translateStream } from '../src/translate/stream.js';
import type { AnthropicStreamEvent } from '../src/types/anthropic.js';
import type { ResponsesStreamEvent } from '../src/types/openai.js';
import {
  baseResponse,
  scriptReasoningThenText,
  scriptTextResponse,
  scriptToolCall,
} from '../src/backends/mock.js';
import { collect, fromArray, makeCtx } from './helpers.js';

/**
 * The heart of mgga: OpenAI Responses SSE → Anthropic Messages SSE. Each
 * scenario is written as the full expected event sequence, because ordering
 * IS the contract — Claude Code's parser is a state machine and one event out
 * of place kills the session.
 */
const types = (events: AnthropicStreamEvent[]) => events.map((e) => e.type);

describe('translateStream', () => {
  it('S1 plain text: the canonical happy path', async () => {
    const out = await collect(translateStream(fromArray(scriptTextResponse('Hello world')), makeCtx()));

    expect(types(out)).toEqual([
      'message_start',
      'ping',
      'content_block_start',
      'content_block_delta',
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]);

    const start = out[0] as Extract<AnthropicStreamEvent, { type: 'message_start' }>;
    // Claude Code matches the echoed model against what it asked for.
    expect(start.message.model).toBe('claude-opus-4-7');
    expect(start.message.id).toContain('resp_mock_1');

    const finale = out[6] as Extract<AnthropicStreamEvent, { type: 'message_delta' }>;
    expect(finale.delta.stop_reason).toBe('end_turn');
    expect(finale.usage).toMatchObject({ input_tokens: 42, output_tokens: 7 });
  });

  it('S2 tool call: minted toolu_ id, original name restored, JSON chunking preserved', async () => {
    const ctx = makeCtx();
    // schema-lowering shortened this name on the way out; the map restores it.
    ctx.toolNameMap.set('mcp__srv__tool_ab12cd34', 'mcp__server-with-very-long-name__tool');

    const out = await collect(
      translateStream(fromArray(scriptToolCall('mcp__srv__tool_ab12cd34', '{"command":"ls -la"}')), ctx),
    );

    const start = out.find(
      (e): e is Extract<AnthropicStreamEvent, { type: 'content_block_start' }> =>
        e.type === 'content_block_start',
    )!;
    expect(start.content_block).toMatchObject({
      type: 'tool_use',
      id: 'toolu_call_mock_1', // mint half of the tool-id bridge
      name: 'mcp__server-with-very-long-name__tool',
    });

    const deltas = out.filter(
      (e): e is Extract<AnthropicStreamEvent, { type: 'content_block_delta' }> =>
        e.type === 'content_block_delta',
    );
    // Pure passthrough: exactly the upstream chunk boundaries, reassembling to the same JSON.
    expect(deltas).toHaveLength(2);
    const json = deltas
      .map((d) => (d.delta.type === 'input_json_delta' ? d.delta.partial_json : ''))
      .join('');
    expect(JSON.parse(json)).toEqual({ command: 'ls -la' });

    const finale = out.find(
      (e): e is Extract<AnthropicStreamEvent, { type: 'message_delta' }> => e.type === 'message_delta',
    )!;
    expect(finale.delta.stop_reason).toBe('tool_use');
  });

  it('S3 reasoning: summaries become thinking deltas; encrypted_content becomes the signature', async () => {
    const out = await collect(
      translateStream(
        fromArray(scriptReasoningThenText(['Plan A.', 'Then step two.'], 'gAAAA-ENCRYPTED', 'Done.')),
        makeCtx(),
      ),
    );

    const thinkingDeltas = out
      .filter(
        (e): e is Extract<AnthropicStreamEvent, { type: 'content_block_delta' }> =>
          e.type === 'content_block_delta',
      )
      .map((e) => e.delta);

    // Two summary parts joined as paragraphs of ONE thinking block…
    expect(thinkingDeltas).toContainEqual({ type: 'thinking_delta', thinking: 'Plan A.' });
    expect(thinkingDeltas).toContainEqual({ type: 'thinking_delta', thinking: '\n\n' });
    expect(thinkingDeltas).toContainEqual({ type: 'thinking_delta', thinking: 'Then step two.' });
    // …and the capture half of the signature trick.
    expect(thinkingDeltas).toContainEqual({ type: 'signature_delta', signature: 'gAAAA-ENCRYPTED' });

    // Thinking block closes before the text block opens; indexes are 0 then 1.
    const starts = out.filter(
      (e): e is Extract<AnthropicStreamEvent, { type: 'content_block_start' }> =>
        e.type === 'content_block_start',
    );
    expect(starts.map((s) => [s.index, s.content_block.type])).toEqual([
      [0, 'thinking'],
      [1, 'text'],
    ]);
  });

  it('S4 output-token starvation maps to stop_reason max_tokens', async () => {
    const script = scriptTextResponse('truncated answ').map((e) =>
      e.type === 'response.completed'
        ? ({
            type: 'response.incomplete',
            response: {
              ...baseResponse('incomplete'),
              incomplete_details: { reason: 'max_output_tokens' },
            },
          } as ResponsesStreamEvent)
        : e,
    );
    const out = await collect(translateStream(fromArray(script), makeCtx()));
    const finale = out.find(
      (e): e is Extract<AnthropicStreamEvent, { type: 'message_delta' }> => e.type === 'message_delta',
    )!;
    expect(finale.delta.stop_reason).toBe('max_tokens');
    expect(types(out).at(-1)).toBe('message_stop');
  });

  it('S5 mid-stream upstream error: open blocks close, then ONE error event, then the stream ends', async () => {
    const script: ResponsesStreamEvent[] = [
      { type: 'response.created', response: baseResponse('in_progress') },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'message', id: 'm1', role: 'assistant', content: [] },
      },
      {
        type: 'response.content_part.added',
        item_id: 'm1',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '' },
      },
      { type: 'response.output_text.delta', item_id: 'm1', output_index: 0, content_index: 0, delta: 'par' },
      { type: 'error', code: 'server_error', message: 'upstream exploded' },
    ];
    const out = await collect(translateStream(fromArray(script), makeCtx()));

    expect(types(out)).toContain('content_block_stop'); // no dangling block
    const last = out.at(-1) as Extract<AnthropicStreamEvent, { type: 'error' }>;
    expect(last.type).toBe('error');
    expect(last.error.message).toContain('upstream exploded');
  });

  it('S6 parallel tool calls become two tool_use blocks with distinct indexes', async () => {
    const script: ResponsesStreamEvent[] = [
      { type: 'response.created', response: baseResponse('in_progress') },
      { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call_a', name: 'Read', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fa', output_index: 0, delta: '{"f":"a"}' },
      { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', call_id: 'call_a', name: 'Read', arguments: '{"f":"a"}' } },
      { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', call_id: 'call_b', name: 'Read', arguments: '' } },
      { type: 'response.function_call_arguments.delta', item_id: 'fb', output_index: 1, delta: '{"f":"b"}' },
      { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', call_id: 'call_b', name: 'Read', arguments: '{"f":"b"}' } },
      {
        type: 'response.completed',
        response: {
          ...baseResponse('completed'),
          output: [
            { type: 'function_call', call_id: 'call_a', name: 'Read', arguments: '{"f":"a"}' },
            { type: 'function_call', call_id: 'call_b', name: 'Read', arguments: '{"f":"b"}' },
          ],
        },
      },
    ];
    const out = await collect(translateStream(fromArray(script), makeCtx()));
    const starts = out.filter(
      (e): e is Extract<AnthropicStreamEvent, { type: 'content_block_start' }> =>
        e.type === 'content_block_start',
    );
    expect(starts.map((s) => [s.index, (s.content_block as { id?: string }).id])).toEqual([
      [0, 'toolu_call_a'],
      [1, 'toolu_call_b'],
    ]);
  });

  it('S7 ignores upstream event types it has never heard of (forward compatibility)', async () => {
    const script: ResponsesStreamEvent[] = [
      { type: 'response.created', response: baseResponse('in_progress') },
      { type: 'response.shiny.new_event', anything: 'goes' },
      { type: 'response.completed', response: baseResponse('completed') },
    ];
    const out = await collect(translateStream(fromArray(script), makeCtx()));
    expect(types(out)).toEqual(['message_start', 'ping', 'message_delta', 'message_stop']);
  });
});
