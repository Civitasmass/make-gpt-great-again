import type { AnthropicMessagesRequest } from '../../types/anthropic.js';
import type { RequestContext, RequestFixer } from '../fixer.js';

/**
 * ## Problem
 * The #1 reason GPT plays dumb inside agent harnesses that proxy it: its
 * chain-of-thought is dropped between tool calls. Anthropic transcripts carry
 * `thinking` blocks that the client replays verbatim; OpenAI reasoning models
 * carry state as encrypted `reasoning` items that MUST be sent back on the
 * next turn (we run store:false — the server keeps nothing). A proxy that
 * discards either side forces the model to re-derive its plan on every tool
 * round-trip: slower, dumber, and more expensive.
 *
 * ## Fix (with the stream translator, this is "the signature trick")
 * Downstream, the stream translator stashes each reasoning item's
 * `encrypted_content` into the thinking block's `signature` — a field Claude
 * Code already round-trips as an opaque token. This fixer handles the replay
 * side: sanitise assistant-history thinking blocks so the translator can map
 * them back onto reasoning items:
 *  - thinking block with a signature → keep (translator turns it into a
 *    reasoning item with encrypted_content = signature)
 *  - thinking block without a signature → drop with a warning (nothing to
 *    replay; sending plaintext thinking back confuses the model)
 *  - redacted_thinking → drop with a warning (Anthropic-encrypted, useless
 *    upstream)
 *  - profile.replayReasoning === false → drop all thinking blocks silently
 *    (escape hatch for endpoints that reject reasoning replay)
 * User-message thinking blocks never exist; only assistant turns are touched.
 *
 * ## Spec: tests/fixers/reasoning-bridge.test.ts
 */
export const reasoningBridge: RequestFixer = {
  name: 'reasoning-bridge',
  why: "Replay GPT's encrypted reasoning (smuggled through Anthropic thinking signatures) so the model keeps its plan across tool calls.",
  status: 'ready',
  apply(req: AnthropicMessagesRequest, ctx: RequestContext): AnthropicMessagesRequest {
    const replay = ctx.profile.replayReasoning;

    const messages = req.messages.map((message) => {
      if (message.role !== 'assistant' || typeof message.content === 'string') return message;

      const content = message.content.filter((block) => {
        if (block.type === 'thinking') {
          if (!replay) return false; // silent, by contract
          if (block.signature) return true;
          ctx.warnings.push({
            fixer: 'reasoning-bridge',
            message: 'dropped an unsigned thinking block — nothing upstream can replay it',
          });
          return false;
        }
        if (block.type === 'redacted_thinking') {
          if (replay) {
            ctx.warnings.push({
              fixer: 'reasoning-bridge',
              message: 'dropped redacted_thinking (Anthropic-encrypted; meaningless upstream)',
            });
          }
          return false;
        }
        return true;
      });

      return { ...message, content };
    });

    return { ...req, messages };
  },
};
