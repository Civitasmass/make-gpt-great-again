import type { AnthropicStopReason, AnthropicStreamEvent } from '../types/anthropic.js';
import type {
  ResponsesOutputItem,
  ResponsesResponse,
  ResponsesStreamEvent,
} from '../types/openai.js';
import type { RequestContext } from '../pipeline/fixer.js';
import { streamError } from './errors.js';

/**
 * OpenAI Responses SSE → Anthropic Messages SSE. The heart of mgga.
 *
 * A small state machine: OpenAI streams a flat list of output items
 * (reasoning / message / function_call) indexed by output_index; Anthropic
 * streams content blocks indexed by a monotonically increasing block index.
 * We assign Anthropic indexes in arrival order and remember the mapping.
 *
 * ## Event mapping (spec'd by tests/translate.stream.test.ts)
 *
 * response.created
 *   → message_start {message: {id: "msg_" + response.id, role:'assistant',
 *     model: ctx.clientModel (the id the client asked for — Claude Code
 *     matches it against its own request), content: [], stop_reason: null,
 *     usage: {input_tokens: 0, output_tokens: 0}}}
 *   → ping                       (Anthropic sends one; some clients expect it)
 *
 * output_item.added(message) + content_part.added(output_text)
 *   → content_block_start {type:'text', text:''}
 * response.output_text.delta → content_block_delta {type:'text_delta'}
 * content_part.added(refusal) → treat as a text block; remember refusal=true.
 *
 * output_item.added(function_call)
 *   → content_block_start {type:'tool_use', id: 'toolu_' + call_id (the
 *     mint half of the tool-id bridge), name: ctx.toolNameMap.get(name) ?? name,
 *     input: {}}
 * function_call_arguments.delta → content_block_delta {type:'input_json_delta',
 *     partial_json: delta}   (pure passthrough — never re-chunk JSON)
 *
 * output_item.added(reasoning) → content_block_start {type:'thinking', thinking:''}
 * reasoning_summary_text.delta → content_block_delta {type:'thinking_delta'}
 * reasoning_summary_part.added (summary_index > 0) → thinking_delta "\n\n"
 *     (parts are separate paragraphs; Anthropic has one thinking string)
 * output_item.done(reasoning).encrypted_content
 *   → content_block_delta {type:'signature_delta', signature: encrypted_content}
 *     — the capture half of the signature trick. A reasoning item with no
 *     summary still opens/closes a thinking block so the signature has a home.
 *
 * output_item.done(any) → content_block_stop for its block (exactly once).
 *
 * response.completed
 *   → message_delta {delta: {stop_reason: output contains a function_call
 *     ? 'tool_use' : (refusal seen ? 'refusal' : 'end_turn'), stop_sequence: null},
 *     usage: {input_tokens, output_tokens,
 *             cache_read_input_tokens: input_tokens_details.cached_tokens ?? 0}}
 *   → message_stop
 * response.incomplete → same, stop_reason: incomplete_details.reason
 *     'max_output_tokens' → 'max_tokens'; 'content_filter' → 'refusal'.
 * response.failed / error → translate via streamError() (translate/errors.ts),
 *     emit the Anthropic `error` event, then end the stream.
 *
 * Robustness invariants:
 *  - Unknown upstream event types are ignored (forward compatibility).
 *  - Any block still open when the terminal event arrives is closed first
 *    (content_block_stop) so the client never sees a dangling block.
 *  - The generator finishes promptly after message_stop / error; it never
 *    waits for upstream EOF.
 */

interface BlockState {
  index: number;
  kind: 'text' | 'tool_use' | 'thinking';
  closed: boolean;
}

type EventOf<T extends string> = Extract<ResponsesStreamEvent, { type: T }>;

export async function* translateStream(
  events: AsyncIterable<ResponsesStreamEvent>,
  ctx: RequestContext,
): AsyncGenerator<AnthropicStreamEvent> {
  let nextIndex = 0;
  let started = false;
  let sawFunctionCall = false;
  let sawRefusal = false;
  const blocks = new Map<number, BlockState>(); // upstream output_index → block

  function open(outputIndex: number, kind: BlockState['kind']): BlockState {
    const state: BlockState = { index: nextIndex++, kind, closed: false };
    blocks.set(outputIndex, state);
    return state;
  }

  function* closeOpenBlocks(): Generator<AnthropicStreamEvent> {
    const open = [...blocks.values()].filter((b) => !b.closed).sort((a, b) => a.index - b.index);
    for (const state of open) {
      state.closed = true;
      yield { type: 'content_block_stop', index: state.index };
    }
  }

  function* finale(response: ResponsesResponse, stopReason: AnthropicStopReason): Generator<AnthropicStreamEvent> {
    yield* closeOpenBlocks();
    const usage = response.usage;
    const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
    yield {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: Math.max(0, (usage?.input_tokens ?? 0) - cached),
        output_tokens: usage?.output_tokens ?? 0,
        cache_read_input_tokens: cached,
      },
    };
    yield { type: 'message_stop' };
  }

  for await (const event of events) {
    switch (event.type) {
      case 'response.created': {
        if (started) break;
        started = true;
        const { response } = event as EventOf<'response.created'>;
        yield {
          type: 'message_start',
          message: {
            id: `msg_${response.id}`,
            type: 'message',
            role: 'assistant',
            model: ctx.clientModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        };
        yield { type: 'ping' };
        break;
      }

      case 'response.output_item.added': {
        const { output_index, item } = event as EventOf<'response.output_item.added'>;
        if (item.type === 'function_call') {
          sawFunctionCall = true;
          const state = open(output_index, 'tool_use');
          yield {
            type: 'content_block_start',
            index: state.index,
            content_block: {
              type: 'tool_use',
              id: `toolu_${item.call_id}`,
              name: ctx.toolNameMap.get(item.name) ?? item.name,
              input: {},
            },
          };
        } else if (item.type === 'reasoning') {
          const state = open(output_index, 'thinking');
          yield {
            type: 'content_block_start',
            index: state.index,
            content_block: { type: 'thinking', thinking: '' },
          };
        }
        // message items wait for content_part.added — no visible block yet.
        break;
      }

      case 'response.content_part.added': {
        const { output_index, part } = event as EventOf<'response.content_part.added'>;
        if (part.type === 'refusal') sawRefusal = true;
        if (!blocks.has(output_index)) {
          const state = open(output_index, 'text');
          yield {
            type: 'content_block_start',
            index: state.index,
            content_block: { type: 'text', text: '' },
          };
        }
        break;
      }

      case 'response.output_text.delta': {
        const { output_index, delta } = event as EventOf<'response.output_text.delta'>;
        const state = blocks.get(output_index);
        if (state && !state.closed) {
          yield { type: 'content_block_delta', index: state.index, delta: { type: 'text_delta', text: delta } };
        }
        break;
      }

      case 'response.function_call_arguments.delta': {
        const { output_index, delta } = event as EventOf<'response.function_call_arguments.delta'>;
        const state = blocks.get(output_index);
        if (state && !state.closed) {
          yield {
            type: 'content_block_delta',
            index: state.index,
            delta: { type: 'input_json_delta', partial_json: delta },
          };
        }
        break;
      }

      case 'response.reasoning_summary_part.added': {
        const { output_index, summary_index } = event as EventOf<'response.reasoning_summary_part.added'>;
        const state = blocks.get(output_index);
        if (state && !state.closed && summary_index > 0) {
          yield {
            type: 'content_block_delta',
            index: state.index,
            delta: { type: 'thinking_delta', thinking: '\n\n' },
          };
        }
        break;
      }

      case 'response.reasoning_summary_text.delta': {
        const { output_index, delta } = event as EventOf<'response.reasoning_summary_text.delta'>;
        const state = blocks.get(output_index);
        if (state && !state.closed) {
          yield { type: 'content_block_delta', index: state.index, delta: { type: 'thinking_delta', thinking: delta } };
        }
        break;
      }

      case 'response.output_item.done': {
        const { output_index, item } = event as EventOf<'response.output_item.done'>;
        const state = blocks.get(output_index);
        if (state && !state.closed) {
          if (item.type === 'reasoning' && item.encrypted_content) {
            yield {
              type: 'content_block_delta',
              index: state.index,
              delta: { type: 'signature_delta', signature: item.encrypted_content },
            };
          }
          state.closed = true;
          yield { type: 'content_block_stop', index: state.index };
        }
        break;
      }

      case 'response.completed': {
        const { response } = event as EventOf<'response.completed'>;
        const hasCall =
          sawFunctionCall || response.output.some((item: ResponsesOutputItem) => item.type === 'function_call');
        yield* finale(response, hasCall ? 'tool_use' : sawRefusal ? 'refusal' : 'end_turn');
        return;
      }

      case 'response.incomplete': {
        const { response } = event as EventOf<'response.incomplete'>;
        const reason = response.incomplete_details?.reason;
        yield* finale(
          response,
          reason === 'max_output_tokens' ? 'max_tokens' : reason === 'content_filter' ? 'refusal' : 'end_turn',
        );
        return;
      }

      case 'response.failed': {
        const { response } = event as EventOf<'response.failed'>;
        yield* closeOpenBlocks();
        yield streamError({
          code: response.error?.code ?? null,
          message: response.error?.message ?? 'upstream reported failure with no detail',
        });
        return;
      }

      case 'error': {
        const err = event as EventOf<'error'>;
        yield* closeOpenBlocks();
        yield streamError({ code: err.code ?? null, message: err.message });
        return;
      }

      default:
        break; // forward compatibility: unknown event types are ignored
    }
  }

  // Upstream EOF without a terminal event (connection drop mid-response).
  yield* closeOpenBlocks();
  yield streamError({ code: null, message: 'stream ended without a terminal event' });
}
