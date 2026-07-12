import type { AnthropicMessagesRequest } from './types/anthropic.js';
import type { Backend } from './backends/backend.js';
import type { ResolvedConfig } from './config.js';
import { runPipeline } from './pipeline/run.js';
import { collectMessage } from './util/collect.js';
import type { Warning } from './pipeline/fixer.js';

/**
 * One-shot question → answer, shared by `mgga ask` (CLI) and `mgga mcp`
 * (tool server). Runs the full fixer pipeline in-process — no HTTP server
 * needed — so a second model is one function call away from any agent.
 *
 * The system-shim is disabled here on purpose: it teaches GPT how to drive
 * Claude Code's TOOLS, and an ask has no tools — the shim would only burn
 * tokens and confuse a plain Q&A. Effort rides the `:effort` model suffix
 * (`gpt-5.6-sol:high`), same grammar as everywhere else in mgga.
 */
export interface AskOptions {
  prompt: string;
  model?: string;
  system?: string;
  maxTokens?: number;
}

export interface AskResult {
  text: string;
  model: string;
  effort: string | undefined;
  warnings: Warning[];
}

export async function askOnce(
  cfg: ResolvedConfig,
  backend: Backend,
  opts: AskOptions,
): Promise<AskResult> {
  const quiet: ResolvedConfig = {
    ...cfg,
    models: Object.fromEntries(
      Object.entries(cfg.models).map(([slug, profile]) => [slug, { ...profile, shim: false as const }]),
    ),
  };

  const request: AnthropicMessagesRequest = {
    model: opts.model ?? quiet.defaultModel,
    max_tokens: opts.maxTokens ?? 8_192,
    messages: [{ role: 'user', content: opts.prompt }],
    ...(opts.system !== undefined ? { system: opts.system } : {}),
  };

  const { events, ctx, route } = runPipeline(request, quiet, backend, new AbortController().signal);
  const message = await collectMessage(events);
  const text = message.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');

  return { text, model: route.target, effort: ctx.reasoningEffort, warnings: ctx.warnings };
}
