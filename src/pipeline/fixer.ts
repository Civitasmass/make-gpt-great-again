import type { AnthropicMessagesRequest, AnthropicStreamEvent } from '../types/anthropic.js';
import type { ReasoningEffort } from '../types/openai.js';
import type { ModelProfile, ResolvedConfig } from '../config.js';

/**
 * The fixer pipeline — mgga's core idea.
 *
 * "GPT sucks in <harness>" is never one bug; it is a pile of small impedance
 * mismatches between what an Anthropic-native client sends and what an OpenAI
 * reasoning model needs. mgga models each mismatch as a *fixer*: one file, one
 * problem, one `why` string, one test file. `mgga doctor` prints the table, so
 * the pipeline is self-documenting.
 *
 * Request fixers are pure Anthropic → Anthropic normalisations that run before
 * translation. Response fixers wrap the translated Anthropic event stream on
 * the way back. Cross-dialect mapping itself lives in src/translate/.
 */

export interface Warning {
  fixer: string;
  message: string;
}

/** Mutable per-request state threaded through fixers, translator, and stream. */
export interface RequestContext {
  config: ResolvedConfig;
  profile: ModelProfile;
  /** Upstream model slug (post-routing). */
  targetModel: string;
  /** Model id the client asked for — echoed back in responses so Claude Code stays coherent. */
  clientModel: string;
  /** Effort pinned by a `:effort` model suffix; outranks everything except MGGA_EFFORT. */
  pinnedEffort?: ReasoningEffort;
  /** Reasoning effort decided by the effort-and-budget fixer. */
  reasoningEffort?: ReasoningEffort;
  /** max_output_tokens decided by the effort-and-budget fixer. */
  maxOutputTokens?: number;
  /** Upstream prompt-cache routing key derived by strip-cache-control. */
  promptCacheKey?: string;
  /** Lowered tool name → original name (see schema-lowering); consulted when streaming tool calls back. */
  toolNameMap: Map<string, string>;
  /** Non-fatal notes accumulated by fixers; logged, and surfaced by tests. */
  warnings: Warning[];
}

export function createContext(
  init: Pick<RequestContext, 'config' | 'profile' | 'targetModel' | 'clientModel'> &
    Pick<Partial<RequestContext>, 'pinnedEffort'>,
): RequestContext {
  return { ...init, toolNameMap: new Map(), warnings: [] };
}

export interface RequestFixer {
  name: string;
  /** One sentence: which GPT-in-Claude-Code failure this prevents. Shown by `mgga doctor`. */
  why: string;
  /** 'stub' fixers are declared architecture; `mgga doctor` reports them and tests fail with a contract pointer. */
  status: 'ready' | 'stub';
  apply(req: AnthropicMessagesRequest, ctx: RequestContext): AnthropicMessagesRequest;
}

export interface ResponseFixer {
  name: string;
  why: string;
  status: 'ready' | 'stub';
  wrap(
    events: AsyncIterable<AnthropicStreamEvent>,
    ctx: RequestContext,
  ): AsyncIterable<AnthropicStreamEvent>;
}

/** Run request fixers left to right. Fixers must not mutate their input — each returns a new request. */
export function applyRequestFixers(
  req: AnthropicMessagesRequest,
  ctx: RequestContext,
  fixers: readonly RequestFixer[],
): AnthropicMessagesRequest {
  return fixers.reduce((acc, fixer) => fixer.apply(acc, ctx), req);
}

/** Nest response fixers around a stream, first fixer innermost (closest to the model). */
export function wrapResponseFixers(
  events: AsyncIterable<AnthropicStreamEvent>,
  ctx: RequestContext,
  fixers: readonly ResponseFixer[],
): AsyncIterable<AnthropicStreamEvent> {
  return fixers.reduce((acc, fixer) => fixer.wrap(acc, ctx), events);
}
