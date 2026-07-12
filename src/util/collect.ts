import type {
  AnthropicContentBlock,
  AnthropicResponseMessage,
  AnthropicStreamEvent,
} from '../types/anthropic.js';
import { UpstreamError, errorEnvelope, statusForErrorType } from '../errors.js';

/**
 * Fold an Anthropic event stream into the final non-streaming message.
 *
 * mgga always streams upstream (reasoning models want it, and it keeps one
 * code path); when the client asked for `stream: false` the server collects
 * with this function. It doubles as an executable definition of the Anthropic
 * stream grammar — the stream-translator tests assert through it.
 */
export async function collectMessage(
  events: AsyncIterable<AnthropicStreamEvent>,
): Promise<AnthropicResponseMessage> {
  let message: AnthropicResponseMessage | null = null;
  const blocks: AnthropicContentBlock[] = [];
  const jsonBuffers = new Map<number, string>();

  for await (const event of events) {
    switch (event.type) {
      case 'message_start':
        message = { ...event.message, content: [] };
        break;

      case 'content_block_start':
        blocks[event.index] = structuredClone(event.content_block);
        if (event.content_block.type === 'tool_use') jsonBuffers.set(event.index, '');
        break;

      case 'content_block_delta': {
        const block = blocks[event.index];
        if (!block) break;
        const delta = event.delta;
        if (delta.type === 'text_delta' && block.type === 'text') {
          block.text += delta.text;
        } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
          block.thinking += delta.thinking;
        } else if (delta.type === 'signature_delta' && block.type === 'thinking') {
          block.signature = (block.signature ?? '') + delta.signature;
        } else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
          jsonBuffers.set(event.index, (jsonBuffers.get(event.index) ?? '') + delta.partial_json);
        }
        break;
      }

      case 'content_block_stop': {
        const block = blocks[event.index];
        if (block?.type === 'tool_use') {
          const raw = jsonBuffers.get(event.index) ?? '';
          block.input = raw.trim() === '' ? {} : (JSON.parse(raw) as Record<string, unknown>);
        }
        break;
      }

      case 'message_delta':
        if (message) {
          message.stop_reason = event.delta.stop_reason;
          message.stop_sequence = event.delta.stop_sequence;
          message.usage = { ...message.usage, ...event.usage };
        }
        break;

      case 'error':
        throw new UpstreamError(
          statusForErrorType(event.error.type),
          errorEnvelope(event.error.type, event.error.message),
        );

      case 'ping':
      case 'message_stop':
        break;
    }
  }

  if (!message) {
    throw new UpstreamError(500, errorEnvelope('api_error', 'stream ended before message_start'));
  }
  message.content = blocks.filter((b): b is AnthropicContentBlock => b !== undefined);
  return message;
}
