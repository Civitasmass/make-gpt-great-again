import { describe, expect, it } from 'vitest';
import { stripCacheControl } from '../../src/pipeline/fixers/strip-cache-control.js';
import { baseRequest, makeCtx } from '../helpers.js';

/**
 * THE PROBLEM: Claude Code marks its system prompt, tool table, and the tail
 * of the conversation with `cache_control` so Anthropic can prefix-cache.
 * OpenAI rejects unknown fields → every request dies with a 400 before the
 * model sees it. This is the very first crash anyone hits pointing Claude
 * Code at an OpenAI-backed proxy.
 */
describe('fixer: strip-cache-control', () => {
  const CACHED = { type: 'ephemeral' as const };

  it('removes cache_control everywhere Claude Code puts it', () => {
    const req = baseRequest({
      system: [{ type: 'text', text: 'You are Claude Code.', cache_control: CACHED }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hi', cache_control: CACHED }] },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {}, cache_control: CACHED }],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 't1',
              content: [{ type: 'text', text: 'ok', cache_control: CACHED }],
              cache_control: CACHED,
            },
          ],
        },
      ],
      tools: [{ name: 'Bash', input_schema: { type: 'object' }, cache_control: CACHED }],
    });

    const fixed = stripCacheControl.apply(req, makeCtx());
    expect(JSON.stringify(fixed)).not.toContain('cache_control');
  });

  it('reuses the Claude Code session id as the OpenAI prompt_cache_key', () => {
    const ctx = makeCtx();
    stripCacheControl.apply(
      baseRequest({ metadata: { user_id: 'user_5b1f…hash' } }),
      ctx,
    );
    expect(ctx.promptCacheKey).toBe('user_5b1f…hash');
  });

  it('leaves promptCacheKey unset when the client sent no metadata', () => {
    const ctx = makeCtx();
    stripCacheControl.apply(baseRequest(), ctx);
    expect(ctx.promptCacheKey).toBeUndefined();
  });

  it('does not mutate the incoming request (fixers are pure)', () => {
    const req = baseRequest({
      system: [{ type: 'text', text: 's', cache_control: CACHED }],
    });
    const frozen = JSON.stringify(req);
    stripCacheControl.apply(req, makeCtx());
    expect(JSON.stringify(req)).toBe(frozen);
  });
});
