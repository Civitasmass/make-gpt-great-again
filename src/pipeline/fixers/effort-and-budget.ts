import type { AnthropicMessagesRequest } from '../../types/anthropic.js';
import type { ReasoningEffort } from '../../types/openai.js';
import type { RequestContext, RequestFixer } from '../fixer.js';
import { EFFORT_LADDER, clampEffort, effortForBudget } from '../../config.js';

/**
 * ## Problem
 * The two knobs don't line up — and Claude Code speaks THREE dialects of
 * "how hard should the model think":
 *   1. `output_config: {effort}` — the /model effort selector (2026 clients;
 *      captured live 2026-07-12). Tops out at 'high'.
 *   2. `thinking: {type:'adaptive'}` — "model decides" (2026 default).
 *   3. `thinking: {type:'enabled', budget_tokens}` — the budgeted form from
 *      older clients and direct SDK users.
 * Meanwhile OpenAI wants one discrete `reasoning.effort`, GPT-5.6 has tiers
 * Claude's UI cannot name (xhigh / max / ultra), and Anthropic's `max_tokens`
 * bounds visible output while OpenAI's bounds reasoning + visible combined —
 * forwarding it verbatim starves deep answers into empty truncation.
 *
 * ## Fix (writes ctx fields; the translator emits them)
 * ctx.reasoningEffort — first match wins, every rung clamps into
 * profile.efforts:
 *   1. $MGGA_EFFORT                 — global ops pin
 *   2. ctx.pinnedEffort             — `:effort` model suffix
 *                                     (`/model gpt-5.6-sol:ultra` — the only
 *                                     door to tiers above 'high')
 *   3. output_config.effort         — Claude Code's effort selector
 *   4. thinking enabled + budget    — via cfg.effortMap (budget ladder)
 *   5. thinking adaptive            — 'medium' (the GPT-5.6 factory default)
 *   6. disabled / absent            — profile.effortFloor
 * ctx.maxOutputTokens = min(req.max_tokens + profile.reasoningHeadroom,
 * profile.maxOutputTokens). Request passes through unchanged.
 *
 * ## Spec: tests/fixers/effort-and-budget.test.ts
 */
export const effortAndBudget: RequestFixer = {
  name: 'effort-and-budget',
  why: "Map thinking budgets onto reasoning efforts and give max_tokens reasoning headroom so deep thoughts don't truncate the visible answer.",
  status: 'ready',
  apply(req: AnthropicMessagesRequest, ctx: RequestContext): AnthropicMessagesRequest {
    ctx.reasoningEffort = decideEffort(req, ctx);
    ctx.maxOutputTokens = Math.min(
      req.max_tokens + ctx.profile.reasoningHeadroom,
      ctx.profile.maxOutputTokens,
    );
    return req;
  },
};

function decideEffort(req: AnthropicMessagesRequest, ctx: RequestContext): ReasoningEffort {
  const globalPin = process.env['MGGA_EFFORT'];
  if (globalPin) return clampEffort(globalPin, ctx.profile);

  if (ctx.pinnedEffort) return clampEffort(ctx.pinnedEffort, ctx.profile);

  const uiEffort = req.output_config?.effort;
  if (uiEffort && EFFORT_LADDER.includes(uiEffort)) return clampEffort(uiEffort, ctx.profile);

  const thinking = req.thinking;
  if (thinking?.type === 'enabled') {
    return effortForBudget(thinking.budget_tokens, ctx.profile, ctx.config.effortMap);
  }
  if (thinking?.type === 'adaptive') return clampEffort('medium', ctx.profile);

  return clampEffort(ctx.profile.effortFloor, ctx.profile);
}
