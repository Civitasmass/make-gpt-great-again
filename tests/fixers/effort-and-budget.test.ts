import { describe, expect, it } from 'vitest';
import { effortAndBudget } from '../../src/pipeline/fixers/effort-and-budget.js';
import { baseRequest, makeCtx, testConfig } from '../helpers.js';

/**
 * THE PROBLEM: two mismatched knobs. Anthropic buys thinking with a token
 * budget; OpenAI with a discrete effort level. And Anthropic's max_tokens
 * bounds visible output while OpenAI's max_output_tokens bounds
 * reasoning+visible combined — forward it verbatim and a hard problem burns
 * its whole budget thinking, returning an empty truncated answer. Users read
 * that as "GPT is broken"; it's actually the proxy starving it.
 */
describe('fixer: effort-and-budget', () => {
  it('maps a thinking budget onto the effort ladder', () => {
    const ctx = makeCtx();
    effortAndBudget.apply(
      baseRequest({ thinking: { type: 'enabled', budget_tokens: 10_000 } }),
      ctx,
    );
    expect(ctx.reasoningEffort).toBe('medium');
  });

  it('uses the profile effort floor when thinking is disabled or absent', () => {
    const disabled = makeCtx();
    effortAndBudget.apply(baseRequest({ thinking: { type: 'disabled' } }), disabled);
    expect(disabled.reasoningEffort).toBe('low');

    const absent = makeCtx();
    effortAndBudget.apply(baseRequest(), absent);
    expect(absent.reasoningEffort).toBe('low');
  });

  it('escalates huge budgets to the top of the configured table', () => {
    const ctx = makeCtx();
    effortAndBudget.apply(
      baseRequest({ thinking: { type: 'enabled', budget_tokens: 500_000 } }),
      ctx,
    );
    expect(ctx.reasoningEffort).toBe('xhigh');
  });

  it('adds reasoning headroom on top of the client max_tokens', () => {
    const ctx = makeCtx(); // default profile: headroom 8192
    effortAndBudget.apply(baseRequest({ max_tokens: 32_000 }), ctx);
    expect(ctx.maxOutputTokens).toBe(32_000 + 8_192);
  });

  it('clamps to the model output ceiling', () => {
    const cfg = testConfig();
    cfg.models['gpt-5.6-sol']!.maxOutputTokens = 64_000;
    const ctx = makeCtx('claude-opus-4-7', cfg);
    effortAndBudget.apply(baseRequest({ max_tokens: 200_000 }), ctx);
    expect(ctx.maxOutputTokens).toBe(64_000);
  });

  it('passes the request through unchanged — this fixer only writes ctx knobs', () => {
    const req = baseRequest({ thinking: { type: 'enabled', budget_tokens: 10_000 } });
    const fixed = effortAndBudget.apply(req, makeCtx());
    expect(fixed).toEqual(req);
  });

  // ── the 2026 wire protocol (captured live 2026-07-12) ────────────────────
  // Claude Code stopped sending budgets: it sends thinking:{type:'adaptive'}
  // and puts the /model effort selector in output_config.effort.

  it("maps Claude Code's effort selector (output_config.effort) straight through", () => {
    const ctx = makeCtx();
    effortAndBudget.apply(
      baseRequest({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }),
      ctx,
    );
    expect(ctx.reasoningEffort).toBe('high');
  });

  it('treats adaptive thinking with no selector as the GPT-5.6 factory default (medium)', () => {
    const ctx = makeCtx();
    effortAndBudget.apply(baseRequest({ thinking: { type: 'adaptive' } }), ctx);
    expect(ctx.reasoningEffort).toBe('medium');
  });

  it('a `:effort` model suffix outranks the UI selector — the only door to ultra', () => {
    // Claude Code's effort UI stops at high; `/model gpt-5.6-sol:ultra` is how
    // users reach the GPT-only tiers, and it persists because the client
    // replays the model string on every request.
    const ctx = makeCtx('gpt-5.6-sol:ultra');
    effortAndBudget.apply(
      baseRequest({ thinking: { type: 'adaptive' }, output_config: { effort: 'high' } }),
      ctx,
    );
    expect(ctx.reasoningEffort).toBe('ultra');
  });

  it('suffix efforts clamp into what the routed model supports (luna tops out at max)', () => {
    const ctx = makeCtx('gpt-5.6-luna:ultra');
    effortAndBudget.apply(baseRequest(), ctx);
    expect(ctx.reasoningEffort).toBe('max');
  });
});
