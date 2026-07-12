import { describe, expect, it } from 'vitest';
import { estimateInputTokens } from '../src/util/tokens.js';

/**
 * count_tokens drives Claude Code's context meter and compaction timing. The
 * estimator only has to be directionally honest — but it must NEVER wildly
 * undercount CJK (CJK-heavy prompts are common; undercounting delays compaction
 * until the request 400s upstream). Exact numbers are implementation detail;
 * these tests pin ranges and monotonicity.
 */
describe('estimateInputTokens', () => {
  it('estimates ASCII prose at roughly 4 chars per token', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20); // 920 chars
    const tokens = estimateInputTokens({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: text }],
    });
    expect(tokens).toBeGreaterThan(180);
    expect(tokens).toBeLessThan(350);
  });

  it('budgets CJK text at about one token per character, not one per four', () => {
    const cjk = 'トークン推定用の多言語サンプル文字列だ'.repeat(10); // 190 CJK chars
    const tokens = estimateInputTokens({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: cjk }],
    });
    expect(tokens).toBeGreaterThanOrEqual(130);
  });

  it('grows when messages, tools, or system prompt are added', () => {
    const base = estimateInputTokens({
      model: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'hello' }],
    });
    const withMore = estimateInputTokens({
      model: 'gpt-5.6-sol',
      system: 'You are terse.',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
      ],
      tools: [
        {
          name: 'Bash',
          description: 'Run a shell command',
          input_schema: { type: 'object', properties: { command: { type: 'string' } } },
        },
      ],
    });
    expect(withMore).toBeGreaterThan(base);
  });

  it('counts tool_use and tool_result blocks in replayed history', () => {
    const tokens = estimateInputTokens({
      model: 'gpt-5.6-sol',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls -la' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'file-a\nfile-b\n'.repeat(50) }],
        },
      ],
    });
    expect(tokens).toBeGreaterThan(100);
  });
});
