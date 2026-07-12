/**
 * OpenAI Responses API — the dialect we speak upstream.
 *
 * The GPT-5.x reasoning models are Responses-API-first (Chat Completions loses
 * reasoning-state replay, which is precisely the thing naive proxies get wrong),
 * so this is the only upstream dialect mgga supports. Hand-written subset, no
 * SDK dependency. Source of truth: https://platform.openai.com/docs/api-reference/responses
 * — verify against live traffic before v1 (see AGENTS.md § Verification).
 */

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

/** GPT-5.6 supports low…ultra (per Codex models manifest); older 5.x also had 'minimal'. */
export type ReasoningEffort =
  | 'minimal'
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'
  | 'ultra'
  | (string & {});

export interface ResponsesRequest {
  model: string;
  /** Maps from the Anthropic `system` prompt (after fixers ran). */
  instructions?: string;
  input: ResponsesInputItem[];
  tools?: ResponsesTool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; name: string };
  parallel_tool_calls?: boolean;
  reasoning?: {
    effort?: ReasoningEffort;
    /** 'auto' asks for streamable reasoning summaries — our `thinking_delta` source. */
    summary?: 'auto' | 'concise' | 'detailed';
  };
  max_output_tokens?: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  /**
   * mgga always sends store:false + include reasoning.encrypted_content:
   * the proxy is stateless, so reasoning state must travel through the client.
   */
  store?: boolean;
  include?: string[];
  prompt_cache_key?: string;
  truncation?: 'auto' | 'disabled';
  text?: { verbosity?: 'low' | 'medium' | 'high' };
}

export type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem
  | ResponsesReasoningItem;

export interface ResponsesInputMessage {
  type: 'message';
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: ResponsesContentPart[];
}

export type ResponsesContentPart =
  | { type: 'input_text'; text: string }
  | { type: 'input_image'; image_url: string; detail?: 'low' | 'high' | 'auto' }
  | { type: 'output_text'; text: string };

export interface ResponsesFunctionCallItem {
  type: 'function_call';
  /** Pairs the call with its output across turns. Bridged from/to Anthropic tool_use ids. */
  call_id: string;
  name: string;
  /** JSON-encoded arguments string. */
  arguments: string;
  id?: string;
}

export interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

/**
 * Replayed chain-of-thought. `encrypted_content` is returned when requested via
 * `include` and MUST be sent back on the next turn for the model to keep its
 * reasoning across a tool loop — the single biggest quality lever this proxy has.
 */
export interface ResponsesReasoningItem {
  type: 'reasoning';
  id?: string;
  summary?: Array<{ type: 'summary_text'; text: string }>;
  encrypted_content?: string;
}

export interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
  strict?: boolean;
}

// ---------------------------------------------------------------------------
// Response object
// ---------------------------------------------------------------------------

export interface ResponsesUsage {
  input_tokens: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens: number;
  output_tokens_details?: { reasoning_tokens?: number };
  total_tokens?: number;
}

export type ResponsesOutputItem =
  | { type: 'message'; id?: string; role: 'assistant'; content: ResponsesOutputContent[]; status?: string }
  | (ResponsesFunctionCallItem & { status?: string })
  | ResponsesReasoningItem;

export type ResponsesOutputContent =
  | { type: 'output_text'; text: string; annotations?: unknown[] }
  | { type: 'refusal'; refusal: string };

export interface ResponsesResponse {
  id: string;
  object: 'response';
  model: string;
  status: 'completed' | 'incomplete' | 'failed' | 'in_progress';
  output: ResponsesOutputItem[];
  usage?: ResponsesUsage;
  incomplete_details?: { reason: 'max_output_tokens' | 'content_filter' | (string & {}) };
  error?: OpenAIErrorShape | null;
}

// ---------------------------------------------------------------------------
// Streaming events (SSE `data:` payloads, discriminated on `type`)
// ---------------------------------------------------------------------------

export type ResponsesStreamEvent =
  | { type: 'response.created'; response: ResponsesResponse }
  | { type: 'response.in_progress'; response: ResponsesResponse }
  | { type: 'response.output_item.added'; output_index: number; item: ResponsesOutputItem }
  | { type: 'response.output_item.done'; output_index: number; item: ResponsesOutputItem }
  | { type: 'response.content_part.added'; item_id: string; output_index: number; content_index: number; part: ResponsesOutputContent }
  | { type: 'response.content_part.done'; item_id: string; output_index: number; content_index: number; part: ResponsesOutputContent }
  | { type: 'response.output_text.delta'; item_id: string; output_index: number; content_index: number; delta: string }
  | { type: 'response.output_text.done'; item_id: string; output_index: number; content_index: number; text: string }
  | { type: 'response.function_call_arguments.delta'; item_id: string; output_index: number; delta: string }
  | { type: 'response.function_call_arguments.done'; item_id: string; output_index: number; arguments: string }
  | { type: 'response.reasoning_summary_part.added'; item_id: string; output_index: number; summary_index: number }
  | { type: 'response.reasoning_summary_part.done'; item_id: string; output_index: number; summary_index: number }
  | { type: 'response.reasoning_summary_text.delta'; item_id: string; output_index: number; summary_index: number; delta: string }
  | { type: 'response.reasoning_summary_text.done'; item_id: string; output_index: number; summary_index: number; text: string }
  | { type: 'response.completed'; response: ResponsesResponse }
  | { type: 'response.incomplete'; response: ResponsesResponse }
  | { type: 'response.failed'; response: ResponsesResponse }
  | { type: 'error'; code?: string | null; message: string; param?: string | null }
  // Forward-compat: unknown event types must be ignored, never crash the stream.
  | { type: string; [key: string]: unknown };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface OpenAIErrorShape {
  message: string;
  type?: string;
  code?: string | null;
  param?: string | null;
}

export interface OpenAIErrorEnvelope {
  error: OpenAIErrorShape;
}
