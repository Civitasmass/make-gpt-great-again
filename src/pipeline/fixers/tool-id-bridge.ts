import type { AnthropicContentBlock, AnthropicMessagesRequest } from '../../types/anthropic.js';
import type { RequestContext, RequestFixer } from '../fixer.js';

/**
 * ## Problem
 * Anthropic pairs a tool call with its result via `tool_use.id` /
 * `tool_result.tool_use_id` (ids like `toolu_01Xy…`); OpenAI pairs
 * `function_call.call_id` / `function_call_output.call_id` (ids like
 * `call_ab12…`). If the pairing breaks on replay, OpenAI 400s with
 * "No tool call found for function call output" — the classic multi-turn
 * proxy crash, usually surfacing only on the SECOND tool round-trip.
 *
 * ## Fix — a stateless bijection (no id table to lose between processes):
 * The stream translator mints Anthropic ids as `'toolu_' + call_id`
 * (call_id charset is already Anthropic-safe). This fixer reverses that on
 * replay, in both tool_use and tool_result blocks:
 *  - id starts with 'toolu_call_'  → strip 'toolu_' (round-trip of our mint)
 *  - id starts with 'toolu_'       → keep as-is (a genuine Anthropic id from a
 *    mixed transcript, e.g. a session that began on real Claude; OpenAI
 *    accepts arbitrary call_id strings as long as call and output agree)
 *  - anything else → keep as-is
 * The invariant that matters (and the one the test asserts): after fixing,
 * every tool_use id equals its paired tool_result id, and replayed ids equal
 * the call_id OpenAI originally issued.
 *
 * ## Spec: tests/fixers/tool-id-bridge.test.ts
 */

const MINTED_PREFIX = 'toolu_call_';

function bridgeId(id: string): string {
  return id.startsWith(MINTED_PREFIX) ? id.slice('toolu_'.length) : id;
}

function bridgeBlock(block: AnthropicContentBlock): AnthropicContentBlock {
  if (block.type === 'tool_use') return { ...block, id: bridgeId(block.id) };
  if (block.type === 'tool_result') return { ...block, tool_use_id: bridgeId(block.tool_use_id) };
  return block;
}

export const toolIdBridge: RequestFixer = {
  name: 'tool-id-bridge',
  why: 'Bridge toolu_* ↔ call_* ids statelessly so multi-turn tool loops replay without "no tool call found" 400s.',
  status: 'ready',
  apply(req: AnthropicMessagesRequest, _ctx: RequestContext): AnthropicMessagesRequest {
    const messages = req.messages.map((message) => {
      if (typeof message.content === 'string') return message;
      return { ...message, content: message.content.map(bridgeBlock) };
    });
    return { ...req, messages };
  },
};
