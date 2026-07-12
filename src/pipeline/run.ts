import type { AnthropicMessagesRequest, AnthropicStreamEvent } from '../types/anthropic.js';
import type { Backend } from '../backends/backend.js';
import { resolveModel, type ResolvedConfig, type RoutedModel } from '../config.js';
import { applyRequestFixers, createContext, wrapResponseFixers, type RequestContext } from './fixer.js';
import { REQUEST_FIXERS, RESPONSE_FIXERS } from './index.js';
import { translateRequest } from '../translate/request.js';
import { translateStream } from '../translate/stream.js';

/**
 * The one pipeline, callable from anywhere: route → request fixers →
 * translate → strip backend dialect → backend → stream translate → response
 * fixers. The HTTP server wraps it in SSE; `mgga ask` and `mgga mcp` consume
 * it in-process — same fixes everywhere, no server required.
 */
export interface PipelineRun {
  events: AsyncIterable<AnthropicStreamEvent>;
  ctx: RequestContext;
  route: RoutedModel;
}

export function runPipeline(
  request: AnthropicMessagesRequest,
  cfg: ResolvedConfig,
  backend: Backend,
  signal: AbortSignal,
): PipelineRun {
  const route = resolveModel(request.model, cfg);
  const ctx = createContext({
    config: cfg,
    profile: route.profile,
    targetModel: route.target,
    clientModel: request.model,
    ...(route.pinnedEffort !== undefined ? { pinnedEffort: route.pinnedEffort } : {}),
  });

  const fixed = applyRequestFixers(request, ctx, REQUEST_FIXERS);
  const upstream = translateRequest(fixed, ctx);
  for (const param of backend.unsupportedParams ?? []) delete upstream[param];
  const events = translateStream(backend.stream(upstream, { signal }), ctx);
  return { events: wrapResponseFixers(events, ctx, RESPONSE_FIXERS), ctx, route };
}
