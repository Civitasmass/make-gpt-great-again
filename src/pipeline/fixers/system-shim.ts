import type { AnthropicMessagesRequest } from '../../types/anthropic.js';
import type { RequestContext, RequestFixer } from '../fixer.js';

/**
 * ## Problem
 * Claude Code's system prompt is written for Claude: it leans on behaviours
 * Anthropic post-trains for (tool-first bias, keep-going-until-done, terse
 * status text). GPT models dropped into the same prompt under-call tools,
 * yield the turn early ("let me know if you want me to continue"), and
 * narrate instead of acting — the bulk of the "great model, sucks in the
 * harness" gap that this project exists to close.
 *
 * ## Fix
 * Append a short, configurable harness-discipline shim to the system prompt:
 * profile.shim === true → cfg.shimText (see DEFAULT_SHIM), a string → that
 * text, false → fixer is a no-op. The shim is appended as a final system
 * block (never prepended: Claude Code's cache-friendly prefix must stay
 * byte-stable, and instructions that come last win recency). String system
 * prompts stay strings; block arrays gain one text block.
 *
 * This fixer is where per-model personality tuning lives — it is data
 * (config), not code, on purpose. Tune the text per model in
 * mgga.config.json models.<slug>.shim.
 *
 * ## Spec: tests/fixers/system-shim.test.ts
 */
export const systemShim: RequestFixer = {
  name: 'system-shim',
  why: 'GPT needs explicit harness discipline (act, persist, verify) appended to a Claude-flavoured system prompt.',
  status: 'ready',
  apply(req: AnthropicMessagesRequest, ctx: RequestContext): AnthropicMessagesRequest {
    const shim = ctx.profile.shim;
    if (shim === false) return req;
    const text = typeof shim === 'string' ? shim : ctx.config.shimText;

    if (req.system === undefined) return { ...req, system: text };
    if (typeof req.system === 'string') return { ...req, system: `${req.system}\n\n${text}` };
    return { ...req, system: [...req.system, { type: 'text', text }] };
  },
};
