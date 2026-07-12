import { readFileSync } from 'node:fs';
import type { ReasoningEffort } from './types/openai.js';

/**
 * Configuration + model registry.
 *
 * Everything model-specific in mgga is data, not code: which GPT models exist,
 * how Claude model ids map onto them, how Anthropic thinking budgets map onto
 * reasoning efforts, and what per-model system shim to apply. Users override
 * any of it with an `mgga.config.json` — new model generations should never
 * require a code change.
 */

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface ModelProfile {
  /** Reasoning efforts the model accepts; requested efforts are clamped into this list (in order, weakest → strongest). */
  efforts: ReasoningEffort[];
  /** Effort used when the client disables/omits extended thinking. */
  effortFloor: ReasoningEffort;
  /** Hard cap applied after headroom inflation (see the effort-and-budget fixer). */
  maxOutputTokens: number;
  /** Extra output budget so reasoning tokens don't starve visible output. */
  reasoningHeadroom: number;
  /** Append the harness shim to the system prompt (true = built-in text, string = custom, false = off). */
  shim: boolean | string;
  /** Replay signed thinking blocks as encrypted reasoning items (the signature trick). */
  replayReasoning: boolean;
}

export interface EffortMapEntry {
  /** Upper bound (inclusive) of the Anthropic thinking budget_tokens; null = catch-all. */
  maxBudget: number | null;
  effort: ReasoningEffort;
}

export interface MggaConfig {
  port?: number;
  backend?: 'openai' | 'chatgpt' | 'mock';
  openai?: { baseUrl?: string; apiKeyEnv?: string };
  /**
   * clientVersion: the Codex CLI version to present upstream. The ChatGPT
   * backend VERSION-GATES models — too old (or absent) and new models come
   * back as a bare "Model not found". Bump it when a new model 404s.
   */
  chatgpt?: { baseUrl?: string; codexHome?: string | null; clientVersion?: string };
  /**
   * Mixed mode. With passthrough on, claude-* requests are forwarded to
   * api.anthropic.com BYTE-FOR-BYTE (body and auth headers untouched) while
   * gpt-* requests run the translation pipeline — one proxy, two frontier
   * families, so a REAL Claude session can spawn GPT subagents natively.
   */
  anthropic?: { baseUrl?: string; passthrough?: boolean };
  defaultModel?: string;
  models?: Record<string, Partial<ModelProfile>>;
  /** Pattern → model slug. Patterns support a `*` wildcard; first match wins (insertion order). */
  aliases?: Record<string, string>;
  effortMap?: EffortMapEntry[];
  /** Replaces the built-in shim text globally. */
  shimText?: string;
  /** If set, clients must present it as `x-api-key` (or Bearer). Defaults from MGGA_API_KEY. */
  apiKey?: string | null;
}

export interface ResolvedConfig extends Required<Omit<MggaConfig, 'models' | 'apiKey'>> {
  models: Record<string, ModelProfile>;
  apiKey: string | null;
  /** Where the config came from, for `mgga doctor`. */
  source: string;
}

// ---------------------------------------------------------------------------
// Defaults — the GPT-5.6 family as shipped 2026-07 (slugs from the Codex models manifest)
// ---------------------------------------------------------------------------

const GPT56_EFFORTS: ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/**
 * The harness bridge. Claude Code already ships full tool schemas and its own
 * system prompt — what a GPT model lacks is the MUSCLE MEMORY: it was
 * post-trained on the Codex tool suite (shell + apply_patch), not Claude's.
 * This shim translates the differences into terms the model already knows.
 * It is data, not code — override globally via shimText or per model via
 * models.<slug>.shim.
 */
export const DEFAULT_SHIM = [
  'You are a GPT model running inside Claude Code, an agentic coding harness. Its tool suite',
  'differs from the one you were trained on; bridge notes:',
  '- Edit tool ≈ apply_patch with old/new blocks: old_string must match the file byte-for-byte',
  '  (indentation and whitespace included) and be unique in the file. Always Read a file before',
  '  editing it, and copy old_string verbatim from the Read output — never from memory.',
  '- Prefer the dedicated tools over shell equivalents: Read (not cat), Grep (not grep/rg),',
  '  Glob (not find), Write (not heredocs). They are faster and their output is formatted for you.',
  '- Independent tool calls go in ONE assistant turn (they run in parallel); serialize only when',
  '  one call needs the output of another.',
  '- Bias to action: inspect the repository with tools instead of asking the user. Keep working',
  '  until the task is fully resolved before yielding; never ask for mid-task confirmation.',
  '- If a tool call fails, CHANGE something before retrying — read the error and fix the cause,',
  '  or drop the failing option (e.g. worktree isolation needs a git repo with commits).',
  '  Never repeat an identical failed call.',
  '- When delegating with the Task tool, match the agent tier to the stakes: gpt-quick for',
  '  mechanical work, gpt for everyday tasks, gpt-deep only where being wrong is expensive.',
  '  If a cheap tier reports the task is harder than briefed, re-delegate one tier up.',
  '- Verify before declaring success: run the tests or re-read what you changed.',
  '- Never write tool syntax in plain text — only invoke tools through the tool-calling interface.',
  '- Keep visible replies short: what changed and what is next, no narration.',
].join('\n');

const DEFAULT_PROFILE: ModelProfile = {
  efforts: GPT56_EFFORTS,
  effortFloor: 'low',
  maxOutputTokens: 128_000,
  reasoningHeadroom: 8_192,
  shim: true,
  replayReasoning: true,
};

export const DEFAULTS: ResolvedConfig = {
  port: 5656,
  // `openai` needs an API key; `chatgpt` rides an existing Codex CLI login. Pick explicitly.
  backend: process.env['OPENAI_API_KEY'] ? 'openai' : 'chatgpt',
  openai: { baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY' },
  chatgpt: {
    baseUrl: 'https://chatgpt.com/backend-api/codex',
    codexHome: null,
    clientVersion: '0.144.1', // verified live 2026-07-12: gpt-5.6-luna is gated behind ≥ latest CLI
  },
  anthropic: { baseUrl: 'https://api.anthropic.com', passthrough: false },
  defaultModel: 'gpt-5.6-sol',
  models: {
    'gpt-5.6-sol': { ...DEFAULT_PROFILE }, // frontier agentic coding model
    'gpt-5.6-terra': { ...DEFAULT_PROFILE }, // balanced everyday model
    // Luna tops out at 'max' — no 'ultra' tier, per the Codex models manifest.
    'gpt-5.6-luna': { ...DEFAULT_PROFILE, efforts: GPT56_EFFORTS.filter((e) => e !== 'ultra') },
  },
  aliases: {
    // Claude Code asks for Claude models by id; route each tier to a GPT-5.6 sibling.
    // Edit to taste in mgga.config.json — this table is the whole routing policy.
    // (Ids that match nothing fall through to defaultModel, so new Claude
    // model families keep working without a config change.)
    'claude-opus-*': 'gpt-5.6-sol',
    'claude-sonnet-*': 'gpt-5.6-terra',
    'claude-haiku-*': 'gpt-5.6-luna',
    'claude-3-*': 'gpt-5.6-luna', // legacy small-model ids used for background tasks
  },
  effortMap: [
    { maxBudget: 8_192, effort: 'low' },
    { maxBudget: 24_576, effort: 'medium' },
    { maxBudget: 65_536, effort: 'high' },
    { maxBudget: null, effort: 'xhigh' },
  ],
  shimText: DEFAULT_SHIM,
  apiKey: null,
  source: 'defaults',
};

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Precedence (weakest → strongest): built-in defaults → config file → env vars.
 * File resolution: explicit `path` arg → $MGGA_CONFIG → ./mgga.config.json (if present).
 */
export function loadConfig(path?: string, env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  let fileCfg: MggaConfig = {};
  let source = 'defaults';

  const candidate = path ?? env['MGGA_CONFIG'] ?? 'mgga.config.json';
  try {
    fileCfg = JSON.parse(readFileSync(candidate, 'utf8')) as MggaConfig;
    source = candidate;
  } catch (err: unknown) {
    const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
    const explicit = path !== undefined || env['MGGA_CONFIG'] !== undefined;
    // A missing default-path file is fine; a missing *explicit* file or a parse error is not.
    if (!missing || explicit) {
      throw new Error(`mgga: cannot load config ${candidate}: ${(err as Error).message}`);
    }
  }

  const models: Record<string, ModelProfile> = {};
  for (const [slug, profile] of Object.entries({ ...DEFAULTS.models })) {
    models[slug] = { ...profile };
  }
  for (const [slug, partial] of Object.entries(fileCfg.models ?? {})) {
    models[slug] = { ...(models[slug] ?? DEFAULT_PROFILE), ...partial };
  }

  return {
    ...DEFAULTS,
    ...fileCfg,
    openai: { ...DEFAULTS.openai, ...fileCfg.openai },
    chatgpt: { ...DEFAULTS.chatgpt, ...fileCfg.chatgpt },
    anthropic: {
      ...DEFAULTS.anthropic,
      ...fileCfg.anthropic,
      ...(env['MGGA_ANTHROPIC_PASSTHROUGH'] !== undefined
        ? { passthrough: ['1', 'true'].includes(env['MGGA_ANTHROPIC_PASSTHROUGH']) }
        : {}),
    },
    aliases: fileCfg.aliases ?? DEFAULTS.aliases,
    effortMap: fileCfg.effortMap ?? DEFAULTS.effortMap,
    models,
    port: Number(env['MGGA_PORT'] ?? fileCfg.port ?? DEFAULTS.port),
    backend: (env['MGGA_BACKEND'] as ResolvedConfig['backend']) ?? fileCfg.backend ?? DEFAULTS.backend,
    defaultModel: env['MGGA_DEFAULT_MODEL'] ?? fileCfg.defaultModel ?? DEFAULTS.defaultModel,
    shimText: fileCfg.shimText ?? DEFAULTS.shimText,
    apiKey: env['MGGA_API_KEY'] ?? fileCfg.apiKey ?? null,
    source,
  };
}

// ---------------------------------------------------------------------------
// Model routing
// ---------------------------------------------------------------------------

export interface RoutedModel {
  /** The upstream OpenAI model slug we will actually call. */
  target: string;
  profile: ModelProfile;
  /** How the route was decided — surfaced in logs and `mgga doctor`. */
  via: 'exact' | 'alias' | 'passthrough' | 'default';
  /**
   * Effort pinned by a `:effort` model suffix (`/model gpt-5.6-sol:ultra`).
   * Claude Code's own effort UI stops at 'high'; the suffix is the only door
   * to the GPT-only 'max' and 'ultra' tiers, and it persists per session
   * because Claude Code replays the model string on every request.
   */
  pinnedEffort?: ReasoningEffort;
}

export const EFFORT_LADDER: ReasoningEffort[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

/** `gpt-5.6-sol:ultra` → base `gpt-5.6-sol`, effort `ultra`. Unknown suffixes are left in the model string. */
function splitEffortSuffix(requested: string): { base: string; effort?: ReasoningEffort } {
  const at = requested.lastIndexOf(':');
  if (at === -1) return { base: requested };
  const suffix = requested.slice(at + 1);
  if (!EFFORT_LADDER.includes(suffix)) return { base: requested };
  return { base: requested.slice(0, at), effort: suffix };
}

function globMatch(pattern: string, value: string): boolean {
  const re = new RegExp(
    '^' + pattern.split('*').map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$',
  );
  return re.test(value);
}

/**
 * A `:effort` suffix is peeled off first, then: exact registry hit → alias
 * table (first match wins) → any `gpt-*` id passes through untouched (so
 * `/model gpt-5.6-luna` in Claude Code Just Works) → everything else lands on
 * defaultModel. Pinned efforts clamp into what the routed model supports.
 */
export function resolveModel(requested: string, cfg: ResolvedConfig): RoutedModel {
  const { base, effort } = splitEffortSuffix(requested);
  const route = resolveBase(base, cfg);
  return effort ? { ...route, pinnedEffort: clampEffort(effort, route.profile) } : route;
}

function resolveBase(requested: string, cfg: ResolvedConfig): RoutedModel {
  const exact = cfg.models[requested];
  if (exact) return { target: requested, profile: exact, via: 'exact' };

  for (const [pattern, target] of Object.entries(cfg.aliases)) {
    if (globMatch(pattern, requested)) {
      return { target, profile: cfg.models[target] ?? { ...DEFAULT_PROFILE }, via: 'alias' };
    }
  }

  if (requested.startsWith('gpt-')) {
    return { target: requested, profile: { ...DEFAULT_PROFILE }, via: 'passthrough' };
  }

  return {
    target: cfg.defaultModel,
    profile: cfg.models[cfg.defaultModel] ?? { ...DEFAULT_PROFILE },
    via: 'default',
  };
}

/** Map an Anthropic thinking budget onto a reasoning effort, clamped to what the model supports. */
export function effortForBudget(
  budget: number | undefined,
  profile: ModelProfile,
  effortMap: EffortMapEntry[],
): ReasoningEffort {
  if (budget === undefined) return clampEffort(profile.effortFloor, profile);
  for (const entry of effortMap) {
    if (entry.maxBudget === null || budget <= entry.maxBudget) return clampEffort(entry.effort, profile);
  }
  return clampEffort(profile.effortFloor, profile);
}

/** Snap an effort into the model's supported list (nearest not-stronger; floor at the weakest). */
export function clampEffort(effort: ReasoningEffort, profile: ModelProfile): ReasoningEffort {
  if (profile.efforts.includes(effort)) return effort;
  const want = EFFORT_LADDER.indexOf(effort);
  if (want === -1) return profile.efforts[0]!;
  for (let i = want; i >= 0; i--) {
    const candidate = EFFORT_LADDER[i]!;
    if (profile.efforts.includes(candidate)) return candidate;
  }
  return profile.efforts[0]!;
}
