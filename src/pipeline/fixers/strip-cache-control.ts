import type { AnthropicMessagesRequest } from '../../types/anthropic.js';
import type { RequestContext, RequestFixer } from '../fixer.js';

/**
 * ## Problem
 * Claude Code decorates its system prompt, tool table, and recent messages
 * with Anthropic prompt-caching markers (`cache_control: {type:"ephemeral"}`).
 * OpenAI rejects unknown fields — every request 400s before the model even
 * sees it. This is the first thing that breaks in any naive proxy.
 *
 * ## Fix
 * Delete every `cache_control` key: system blocks, message content blocks
 * (including blocks nested inside tool_result content), and tool definitions.
 * OpenAI caches by prefix automatically; to help its cache router, derive
 * `ctx.promptCacheKey` from `metadata.user_id` when present (Claude Code puts
 * a stable session hash there), so the translator can emit `prompt_cache_key`.
 *
 * Deletion is TARGETED at the positions the Anthropic API defines — a user
 * field that happens to be named cache_control inside tool_use.input is data,
 * not a marker, and survives.
 *
 * ## Spec: tests/fixers/strip-cache-control.test.ts
 */
export const stripCacheControl: RequestFixer = {
  name: 'strip-cache-control',
  why: "Anthropic cache markers are a hard 400 on OpenAI; strip them and reuse the session id as OpenAI's prompt_cache_key.",
  status: 'ready',
  apply(req: AnthropicMessagesRequest, ctx: RequestContext): AnthropicMessagesRequest {
    if (req.metadata?.user_id) ctx.promptCacheKey = req.metadata.user_id;

    const out = structuredClone(req);
    if (Array.isArray(out.system)) {
      for (const block of out.system) delete block.cache_control;
    }
    for (const message of out.messages) {
      if (typeof message.content === 'string') continue;
      for (const block of message.content) {
        delete (block as { cache_control?: unknown }).cache_control;
        if (block.type === 'tool_result' && Array.isArray(block.content)) {
          for (const inner of block.content) delete inner.cache_control;
        }
      }
    }
    for (const tool of out.tools ?? []) delete tool.cache_control;
    return out;
  },
};
