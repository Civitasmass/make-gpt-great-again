/**
 * Anthropic Messages API — the dialect Claude Code speaks to us.
 *
 * These types are deliberately hand-written (no SDK dependency) and cover the
 * subset of the wire protocol that Claude Code actually exercises. Shapes were
 * captured against the 2026-07 API; when in doubt the source of truth is
 * https://docs.anthropic.com/en/api/messages and a `--verbose` capture of real
 * Claude Code traffic (see ARCHITECTURE.md § Capturing traffic).
 */

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface AnthropicMessagesRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  /** Claude Code sends an array of text blocks so it can cache-control them. */
  system?: string | AnthropicTextBlock[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  thinking?: AnthropicThinkingConfig;
  output_config?: AnthropicOutputConfig;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  stop_sequences?: string[];
  stream?: boolean;
  metadata?: { user_id?: string };
  /** Client-side context-window policy; meaningless upstream, never forwarded. */
  context_management?: unknown;
}

/** Claude Code's /model effort selector rides here (low | medium | high). */
export interface AnthropicOutputConfig {
  effort?: string;
}

export interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolUseBlock
  | AnthropicToolResultBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock;

/** Prompt-caching marker. Valid for Anthropic, a hard 400 for OpenAI — see the strip-cache-control fixer. */
export interface AnthropicCacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: AnthropicCacheControl | null;
}

export interface AnthropicImageBlock {
  type: 'image';
  source:
    | { type: 'base64'; media_type: string; data: string }
    | { type: 'url'; url: string };
  cache_control?: AnthropicCacheControl | null;
}

export interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  cache_control?: AnthropicCacheControl | null;
}

export interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | Array<AnthropicTextBlock | AnthropicImageBlock>;
  is_error?: boolean;
  cache_control?: AnthropicCacheControl | null;
}

/**
 * Extended-thinking block. `signature` is opaque to the client and replayed
 * verbatim on the next turn — which is exactly the slot we use to round-trip
 * OpenAI's `encrypted_content` (ARCHITECTURE.md § The signature trick).
 */
export interface AnthropicThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface AnthropicRedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export interface AnthropicTool {
  name: string;
  description?: string;
  /** JSON Schema (draft 2020-12). OpenAI accepts a narrower dialect — see the schema-lowering fixer. */
  input_schema: JsonSchema;
  cache_control?: AnthropicCacheControl | null;
}

export type AnthropicToolChoice =
  | { type: 'auto'; disable_parallel_tool_use?: boolean }
  | { type: 'any'; disable_parallel_tool_use?: boolean }
  | { type: 'tool'; name: string; disable_parallel_tool_use?: boolean }
  | { type: 'none' };

/**
 * 'adaptive' (plus output_config.effort) is what 2026 Claude Code actually
 * sends — captured live 2026-07-12. The budgeted form still arrives from
 * older clients and direct SDK users.
 */
export type AnthropicThinkingConfig =
  | { type: 'enabled'; budget_tokens: number }
  | { type: 'disabled' }
  | { type: 'adaptive'; display?: string };

/** Loose JSON-Schema shape: we transform these structurally, we never validate against them. */
export type JsonSchema = { [key: string]: unknown };

// ---------------------------------------------------------------------------
// Response (non-streaming)
// ---------------------------------------------------------------------------

export type AnthropicStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'refusal';

export interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface AnthropicResponseMessage {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: AnthropicStopReason | null;
  stop_sequence: string | null;
  usage: AnthropicUsage;
}

// ---------------------------------------------------------------------------
// Response (streaming) — the exact SSE event grammar Claude Code parses.
//
// One request produces, in order:
//   message_start
//   ping
//   ( content_block_start (content_block_delta)* content_block_stop )*
//   message_delta
//   message_stop
// with `error` allowed to terminate the stream at any point.
// ---------------------------------------------------------------------------

export type AnthropicStreamEvent =
  | { type: 'message_start'; message: AnthropicResponseMessage }
  | { type: 'ping' }
  | { type: 'content_block_start'; index: number; content_block: AnthropicContentBlock }
  | { type: 'content_block_delta'; index: number; delta: AnthropicContentDelta }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason: AnthropicStopReason; stop_sequence: string | null };
      usage: AnthropicUsage;
    }
  | { type: 'message_stop' }
  | { type: 'error'; error: AnthropicErrorShape };

export type AnthropicContentDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'input_json_delta'; partial_json: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'signature_delta'; signature: string };

// ---------------------------------------------------------------------------
// Errors — https://docs.anthropic.com/en/api/errors
// ---------------------------------------------------------------------------

export type AnthropicErrorType =
  | 'invalid_request_error'
  | 'authentication_error'
  | 'permission_error'
  | 'not_found_error'
  | 'request_too_large'
  | 'rate_limit_error'
  | 'api_error'
  | 'overloaded_error';

export interface AnthropicErrorShape {
  type: AnthropicErrorType;
  message: string;
}

export interface AnthropicErrorEnvelope {
  type: 'error';
  error: AnthropicErrorShape;
}

// ---------------------------------------------------------------------------
// Token counting — POST /v1/messages/count_tokens
// ---------------------------------------------------------------------------

export interface AnthropicCountTokensRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: string | AnthropicTextBlock[];
  tools?: AnthropicTool[];
  thinking?: AnthropicThinkingConfig;
}

export interface AnthropicCountTokensResponse {
  input_tokens: number;
}
