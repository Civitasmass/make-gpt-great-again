import type { RequestFixer, ResponseFixer } from './fixer.js';
import { stripCacheControl } from './fixers/strip-cache-control.js';
import { systemShim } from './fixers/system-shim.js';
import { schemaLowering } from './fixers/schema-lowering.js';
import { reasoningBridge } from './fixers/reasoning-bridge.js';
import { toolIdBridge } from './fixers/tool-id-bridge.js';
import { effortAndBudget } from './fixers/effort-and-budget.js';
import { toolJsonGuard } from './fixers/tool-json-guard.js';

/**
 * The pipeline, in execution order. Order is part of the contract:
 *  1. strip-cache-control — first, it touches every block the others read.
 *  2. system-shim         — appends to the system prompt before anything
 *                           measures or translates it.
 *  3. schema-lowering     — must run before tool-id-bridge/translation so
 *                           ctx.toolNameMap exists when history is mapped.
 *  4. reasoning-bridge    — sanitises thinking blocks the translator replays.
 *  5. tool-id-bridge      — rewrites ids everywhere after blocks stopped moving.
 *  6. effort-and-budget   — reads the final request, writes ctx knobs; last.
 */
export const REQUEST_FIXERS: readonly RequestFixer[] = [
  stripCacheControl,
  systemShim,
  schemaLowering,
  reasoningBridge,
  toolIdBridge,
  effortAndBudget,
];

export const RESPONSE_FIXERS: readonly ResponseFixer[] = [toolJsonGuard];

export const ALL_FIXERS = [...REQUEST_FIXERS, ...RESPONSE_FIXERS] as const;
