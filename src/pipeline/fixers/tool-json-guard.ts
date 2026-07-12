import type { AnthropicStreamEvent } from '../../types/anthropic.js';
import type { RequestContext, ResponseFixer } from '../fixer.js';

/**
 * ## Problem
 * When a stream ends early (output-token limit, upstream hiccup, model
 * misstep), a tool call's streamed JSON arguments can be left truncated:
 * `{"file_path": "src/ind`. Claude Code then throws a client-side JSON parse
 * error and the whole agent turn dies — one malformed tool call costs the
 * entire session's momentum.
 *
 * ## Fix (response-side stream wrapper)
 * Buffer input_json_delta text per tool_use block. At content_block_stop:
 *  - valid JSON (or empty → "{}") → pass everything through untouched, in
 *    original chunking;
 *  - invalid → attempt a mechanical close: strip a trailing partial token,
 *    close any open string, then close open [ and { in stack order; if the
 *    result parses, emit it as a single input_json_delta with a ctx warning;
 *  - still invalid → emit "{}" and a warning. The model sees its own tool
 *    call fail cleanly (the harness reports bad args) and retries — infinitely
 *    better than a dead session.
 * Non-tool blocks and all other events flow through unmodified; per-event
 * ordering is preserved. This fixer buffers ONLY tool_use blocks: text and
 * thinking latency stay untouched.
 *
 * ## Spec: tests/fixers/tool-json-guard.test.ts
 */

type DeltaEvent = Extract<AnthropicStreamEvent, { type: 'content_block_delta' }>;

interface ToolBuffer {
  deltas: DeltaEvent[];
  json: string;
}

export const toolJsonGuard: ResponseFixer = {
  name: 'tool-json-guard',
  why: 'Truncated tool-call JSON must degrade to a retryable bad-args error, never a dead Claude Code session.',
  status: 'ready',
  async *wrap(
    events: AsyncIterable<AnthropicStreamEvent>,
    ctx: RequestContext,
  ): AsyncIterable<AnthropicStreamEvent> {
    const buffers = new Map<number, ToolBuffer>();

    for await (const event of events) {
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        buffers.set(event.index, { deltas: [], json: '' });
        yield event;
        continue;
      }

      if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
        const buffer = buffers.get(event.index);
        if (buffer) {
          buffer.deltas.push(event);
          buffer.json += event.delta.partial_json;
          continue;
        }
      }

      if (event.type === 'content_block_stop') {
        const buffer = buffers.get(event.index);
        if (buffer) {
          buffers.delete(event.index);
          yield* flushToolBlock(buffer, event.index, ctx);
          yield event;
          continue;
        }
      }

      yield event;
    }

    // Stream died before the stop event: release the raw deltas rather than
    // swallowing them — downstream sees exactly what upstream sent.
    for (const buffer of buffers.values()) yield* buffer.deltas;
  },
};

function* flushToolBlock(
  buffer: ToolBuffer,
  index: number,
  ctx: RequestContext,
): Generator<AnthropicStreamEvent> {
  const raw = buffer.json;
  if (raw.trim() === '') return; // empty argument stream — client treats it as {}

  if (parses(raw)) {
    yield* buffer.deltas; // untouched, original chunking
    return;
  }

  const repaired = mechanicalClose(raw);
  if (repaired !== null) {
    ctx.warnings.push({
      fixer: 'tool-json-guard',
      message: `mechanically closed truncated tool JSON (${raw.length} chars buffered)`,
    });
    yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: repaired } };
    return;
  }

  ctx.warnings.push({
    fixer: 'tool-json-guard',
    message: 'tool JSON was beyond repair; replaced with {} so the call fails retryably',
  });
  yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{}' } };
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Mechanical close
// ---------------------------------------------------------------------------

interface ScanState {
  stack: Array<'{' | '['>;
  inString: boolean;
  escape: boolean;
}

function scan(text: string): ScanState {
  const stack: Array<'{' | '['> = [];
  let inString = false;
  let escape = false;
  for (const ch of text) {
    if (inString) {
      if (escape) escape = false;
      else if (ch === '\\') escape = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  return { stack, inString, escape };
}

/**
 * Strip a trailing partial token, close any open string, then close open
 * brackets in stack order. Returns the repaired string only if it parses.
 */
function mechanicalClose(raw: string): string | null {
  let text = raw;
  let state = scan(text);

  if (state.inString) {
    if (state.escape) text = text.slice(0, -1); // dangling backslash
    text += '"';
  } else {
    text = text.replace(/[A-Za-z0-9+\-.]+\s*$/, '').replace(/[,:]\s*$/, '');
  }

  state = scan(text);
  let closers = '';
  for (let i = state.stack.length - 1; i >= 0; i--) {
    closers += state.stack[i] === '{' ? '}' : ']';
  }

  const candidate = text + closers;
  return parses(candidate) ? candidate : null;
}
