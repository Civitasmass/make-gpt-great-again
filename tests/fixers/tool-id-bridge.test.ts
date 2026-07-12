import { describe, expect, it } from 'vitest';
import { toolIdBridge } from '../../src/pipeline/fixers/tool-id-bridge.js';
import type { AnthropicContentBlock } from '../../src/types/anthropic.js';
import { baseRequest, makeCtx } from '../helpers.js';

/**
 * THE PROBLEM: OpenAI pairs function_call ↔ function_call_output by call_id;
 * Anthropic pairs tool_use ↔ tool_result by its own id format. A proxy that
 * mints ids without a reversible scheme works on turn 1 and explodes on turn
 * 2 with "No tool call found for function call output" — the classic
 * only-fails-in-real-sessions bug. The bridge is stateless: mint
 * `toolu_ + call_id` on the way out, strip it on the way back.
 */
describe('fixer: tool-id-bridge', () => {
  it('recovers the original OpenAI call_id from ids we minted', () => {
    const fixed = toolIdBridge.apply(
      baseRequest({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_call_9f3a77', name: 'Bash', input: {} }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_call_9f3a77', content: 'ok' }],
          },
        ],
      }),
      makeCtx(),
    );

    const assistant = fixed.messages[0]!.content as AnthropicContentBlock[];
    const user = fixed.messages[1]!.content as AnthropicContentBlock[];
    expect(assistant[0]).toMatchObject({ id: 'call_9f3a77' });
    expect(user[0]).toMatchObject({ tool_use_id: 'call_9f3a77' });
  });

  it('leaves genuine Anthropic ids alone (mixed transcript that began on real Claude)', () => {
    const fixed = toolIdBridge.apply(
      baseRequest({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'toolu_01A2B3C4', name: 'Read', input: {} }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_01A2B3C4', content: 'data' }],
          },
        ],
      }),
      makeCtx(),
    );
    const assistant = fixed.messages[0]!.content as AnthropicContentBlock[];
    expect(assistant[0]).toMatchObject({ id: 'toolu_01A2B3C4' });
  });

  it('THE invariant: after fixing, every tool_result still points at its tool_use', () => {
    const ids = ['toolu_call_a1', 'toolu_01NATIVE', 'weird-id-from-somewhere'];
    const fixed = toolIdBridge.apply(
      baseRequest({
        messages: [
          {
            role: 'assistant',
            content: ids.map((id) => ({ type: 'tool_use' as const, id, name: 'T', input: {} })),
          },
          {
            role: 'user',
            content: ids.map((id) => ({ type: 'tool_result' as const, tool_use_id: id, content: 'r' })),
          },
        ],
      }),
      makeCtx(),
    );

    const uses = (fixed.messages[0]!.content as AnthropicContentBlock[]).map(
      (b) => (b as { id: string }).id,
    );
    const results = (fixed.messages[1]!.content as AnthropicContentBlock[]).map(
      (b) => (b as { tool_use_id: string }).tool_use_id,
    );
    expect(results).toEqual(uses);
  });
});
