import { DEFAULTS, resolveModel, type ResolvedConfig } from '../src/config.js';
import { createContext, type RequestContext } from '../src/pipeline/fixer.js';
import type { AnthropicMessagesRequest } from '../src/types/anthropic.js';

/** A fresh, mutation-safe copy of the built-in config. */
export function testConfig(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return { ...structuredClone(DEFAULTS), ...overrides };
}

/**
 * Build the per-request context the way the server does. `requested` is what
 * the client asked for (a Claude id or a gpt slug); routing decides the rest.
 */
export function makeCtx(
  requested = 'claude-opus-4-7',
  cfg: ResolvedConfig = testConfig(),
): RequestContext {
  const route = resolveModel(requested, cfg);
  return createContext({
    config: cfg,
    profile: route.profile,
    targetModel: route.target,
    clientModel: requested,
    ...(route.pinnedEffort !== undefined ? { pinnedEffort: route.pinnedEffort } : {}),
  });
}

/** The smallest legal Claude Code request; tests override what they exercise. */
export function baseRequest(
  overrides: Partial<AnthropicMessagesRequest> = {},
): AnthropicMessagesRequest {
  return {
    model: 'claude-opus-4-7',
    max_tokens: 32_000,
    messages: [{ role: 'user', content: 'hi' }],
    ...overrides,
  };
}

export async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

export async function* fromArray<T>(items: readonly T[]): AsyncGenerator<T> {
  for (const item of items) yield item;
}

export function neverAbort(): AbortSignal {
  return new AbortController().signal;
}
