import { describe, expect, it } from 'vitest';
import { reasoningBridge } from '../../src/pipeline/fixers/reasoning-bridge.js';
import type { AnthropicContentBlock } from '../../src/types/anthropic.js';
import { baseRequest, makeCtx, testConfig } from '../helpers.js';

/**
 * THE PROBLEM: the single biggest "GPT plays dumb through a proxy" cause.
 * OpenAI reasoning models carry their plan between tool calls as encrypted
 * reasoning items that MUST be replayed (we run store:false). Anthropic
 * transcripts carry thinking blocks with an opaque `signature` the client
 * replays verbatim. mgga smuggles encrypted_content through that signature —
 * this fixer sanitises the replayed history so only replayable thinking
 * survives.
 */
describe('fixer: reasoning-bridge', () => {
  const assistantTurn = (blocks: AnthropicContentBlock[]) =>
    baseRequest({
      messages: [
        { role: 'user', content: 'do the thing' },
        { role: 'assistant', content: blocks },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'ok' }] },
      ],
    });

  it('keeps signed thinking blocks (they carry replayable encrypted reasoning)', () => {
    const fixed = reasoningBridge.apply(
      assistantTurn([
        { type: 'thinking', thinking: 'first inspect the file', signature: 'gAAAA-encrypted' },
        { type: 'tool_use', id: 'call_1', name: 'Read', input: { file: 'a.ts' } },
      ]),
      makeCtx(),
    );
    const assistant = fixed.messages[1]!.content as AnthropicContentBlock[];
    expect(assistant[0]).toMatchObject({ type: 'thinking', signature: 'gAAAA-encrypted' });
  });

  it('drops unsigned thinking blocks with a warning — nothing upstream can replay them', () => {
    const ctx = makeCtx();
    const fixed = reasoningBridge.apply(
      assistantTurn([
        { type: 'thinking', thinking: 'orphaned thought' },
        { type: 'text', text: 'done' },
      ]),
      ctx,
    );
    const assistant = fixed.messages[1]!.content as AnthropicContentBlock[];
    expect(assistant).toEqual([{ type: 'text', text: 'done' }]);
    expect(ctx.warnings.some((w) => w.fixer === 'reasoning-bridge')).toBe(true);
  });

  it('drops redacted_thinking (Anthropic-encrypted, meaningless to OpenAI)', () => {
    const ctx = makeCtx();
    const fixed = reasoningBridge.apply(
      assistantTurn([
        { type: 'redacted_thinking', data: 'AAAA' },
        { type: 'text', text: 'done' },
      ]),
      ctx,
    );
    const assistant = fixed.messages[1]!.content as AnthropicContentBlock[];
    expect(assistant.every((b) => b.type !== 'redacted_thinking')).toBe(true);
  });

  it('drops ALL thinking when the profile opts out of reasoning replay', () => {
    const cfg = testConfig();
    cfg.models['gpt-5.6-sol']!.replayReasoning = false;
    const fixed = reasoningBridge.apply(
      assistantTurn([
        { type: 'thinking', thinking: 'plan', signature: 'gAAAA' },
        { type: 'text', text: 'done' },
      ]),
      makeCtx('gpt-5.6-sol', cfg),
    );
    const assistant = fixed.messages[1]!.content as AnthropicContentBlock[];
    expect(assistant).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('never touches user messages', () => {
    const req = assistantTurn([{ type: 'text', text: 'done' }]);
    const fixed = reasoningBridge.apply(req, makeCtx());
    expect(fixed.messages[0]).toEqual(req.messages[0]);
    expect(fixed.messages[2]).toEqual(req.messages[2]);
  });
});
