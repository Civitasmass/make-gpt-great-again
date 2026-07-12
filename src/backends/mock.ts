import type {
  ResponsesRequest,
  ResponsesResponse,
  ResponsesStreamEvent,
  ResponsesUsage,
} from '../types/openai.js';
import type { Backend } from './backend.js';

/**
 * Scripted backend: replays a fixed list of Responses stream events. Used by
 * the test suite and by `mgga serve` with `backend: "mock"` so the whole wire
 * path can be exercised with zero credentials.
 */
export class MockBackend implements Backend {
  readonly name = 'mock';
  constructor(private readonly script: (req: ResponsesRequest) => ResponsesStreamEvent[]) {}

  static fromEvents(events: ResponsesStreamEvent[]): MockBackend {
    return new MockBackend(() => events);
  }

  /** Canned greeting used by `backend: "mock"` — proves the plumbing end to end. */
  static hello(): MockBackend {
    return new MockBackend((req) =>
      scriptTextResponse(`Hello from mgga! You asked for model "${req.model}".`, { model: req.model }),
    );
  }

  async *stream(
    req: ResponsesRequest,
    opts: { signal: AbortSignal },
  ): AsyncIterable<ResponsesStreamEvent> {
    for (const event of this.script(req)) {
      if (opts.signal.aborted) return;
      yield event;
    }
  }
}

// ---------------------------------------------------------------------------
// Script builders — shared by tests so each scenario reads as a story.
// ---------------------------------------------------------------------------

export interface ScriptOptions {
  model?: string;
  usage?: ResponsesUsage;
}

const DEFAULT_USAGE: ResponsesUsage = {
  input_tokens: 42,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens: 7,
  output_tokens_details: { reasoning_tokens: 0 },
};

export function baseResponse(
  status: ResponsesResponse['status'],
  opts: ScriptOptions = {},
): ResponsesResponse {
  return {
    id: 'resp_mock_1',
    object: 'response',
    model: opts.model ?? 'gpt-5.6-sol',
    status,
    output: [],
    ...(status !== 'in_progress' ? { usage: opts.usage ?? DEFAULT_USAGE } : {}),
  };
}

/** created → one text message streamed in two deltas → completed. */
export function scriptTextResponse(text: string, opts: ScriptOptions = {}): ResponsesStreamEvent[] {
  const mid = Math.ceil(text.length / 2);
  return [
    { type: 'response.created', response: baseResponse('in_progress', opts) },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_mock_1', role: 'assistant', content: [] },
    },
    {
      type: 'response.content_part.added',
      item_id: 'msg_mock_1',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text: '' },
    },
    { type: 'response.output_text.delta', item_id: 'msg_mock_1', output_index: 0, content_index: 0, delta: text.slice(0, mid) },
    { type: 'response.output_text.delta', item_id: 'msg_mock_1', output_index: 0, content_index: 0, delta: text.slice(mid) },
    { type: 'response.output_text.done', item_id: 'msg_mock_1', output_index: 0, content_index: 0, text },
    {
      type: 'response.content_part.done',
      item_id: 'msg_mock_1',
      output_index: 0,
      content_index: 0,
      part: { type: 'output_text', text },
    },
    {
      type: 'response.output_item.done',
      output_index: 0,
      item: { type: 'message', id: 'msg_mock_1', role: 'assistant', content: [{ type: 'output_text', text }] },
    },
    {
      type: 'response.completed',
      response: {
        ...baseResponse('completed', opts),
        output: [{ type: 'message', id: 'msg_mock_1', role: 'assistant', content: [{ type: 'output_text', text }] }],
      },
    },
  ];
}

/** created → one function_call with arguments streamed in two deltas → completed. */
export function scriptToolCall(
  name: string,
  argumentsJson: string,
  opts: ScriptOptions = {},
): ResponsesStreamEvent[] {
  const mid = Math.ceil(argumentsJson.length / 2);
  const item = { type: 'function_call', call_id: 'call_mock_1', name, arguments: '' } as const;
  const done = { ...item, arguments: argumentsJson };
  return [
    { type: 'response.created', response: baseResponse('in_progress', opts) },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_mock_1', output_index: 0, delta: argumentsJson.slice(0, mid) },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_mock_1', output_index: 0, delta: argumentsJson.slice(mid) },
    { type: 'response.function_call_arguments.done', item_id: 'fc_mock_1', output_index: 0, arguments: argumentsJson },
    { type: 'response.output_item.done', output_index: 0, item: done },
    { type: 'response.completed', response: { ...baseResponse('completed', opts), output: [done] } },
  ];
}

/** created → reasoning (two summary parts + encrypted payload) → text → completed. */
export function scriptReasoningThenText(
  summaryParts: string[],
  encrypted: string,
  text: string,
  opts: ScriptOptions = {},
): ResponsesStreamEvent[] {
  const events: ResponsesStreamEvent[] = [
    { type: 'response.created', response: baseResponse('in_progress', opts) },
    { type: 'response.output_item.added', output_index: 0, item: { type: 'reasoning', id: 'rs_mock_1', summary: [] } },
  ];
  summaryParts.forEach((part, i) => {
    events.push(
      { type: 'response.reasoning_summary_part.added', item_id: 'rs_mock_1', output_index: 0, summary_index: i },
      { type: 'response.reasoning_summary_text.delta', item_id: 'rs_mock_1', output_index: 0, summary_index: i, delta: part },
      { type: 'response.reasoning_summary_text.done', item_id: 'rs_mock_1', output_index: 0, summary_index: i, text: part },
      { type: 'response.reasoning_summary_part.done', item_id: 'rs_mock_1', output_index: 0, summary_index: i },
    );
  });
  const reasoningDone = {
    type: 'reasoning',
    id: 'rs_mock_1',
    summary: summaryParts.map((text) => ({ type: 'summary_text' as const, text })),
    encrypted_content: encrypted,
  } as const;
  events.push({ type: 'response.output_item.done', output_index: 0, item: reasoningDone });

  const textEvents = scriptTextResponse(text, opts)
    .filter((e) => !['response.created', 'response.completed'].includes(e.type))
    .map((e) => ('output_index' in e ? { ...e, output_index: 1 } : e)) as ResponsesStreamEvent[];
  events.push(...textEvents);

  events.push({
    type: 'response.completed',
    response: {
      ...baseResponse('completed', opts),
      output: [
        reasoningDone,
        { type: 'message', id: 'msg_mock_1', role: 'assistant', content: [{ type: 'output_text', text }] },
      ],
    },
  });
  return events;
}
