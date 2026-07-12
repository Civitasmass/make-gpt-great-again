import { describe, expect, it } from 'vitest';
import { systemShim } from '../../src/pipeline/fixers/system-shim.js';
import { baseRequest, makeCtx, testConfig } from '../helpers.js';

/**
 * THE PROBLEM: Claude Code's system prompt assumes Claude's post-training —
 * tool-first bias, keep-going-until-done. GPT dropped into the same prompt
 * yields early ("let me know if I should continue") and describes instead of
 * acting. The shim appends explicit harness discipline; it's data (config),
 * so tuning GPT's personality per model never needs a code change.
 */
describe('fixer: system-shim', () => {
  it('appends the shim to a string system prompt, separated by a blank line', () => {
    const ctx = makeCtx();
    const fixed = systemShim.apply(baseRequest({ system: 'You are Claude Code.' }), ctx);
    expect(fixed.system).toBe(`You are Claude Code.\n\n${ctx.config.shimText}`);
  });

  it('appends one text block to a block-array system prompt, leaving the cached prefix byte-stable', () => {
    const ctx = makeCtx();
    const original = [{ type: 'text' as const, text: 'You are Claude Code.' }];
    const fixed = systemShim.apply(baseRequest({ system: original }), ctx);

    const blocks = fixed.system as Array<{ type: 'text'; text: string }>;
    // Prefix untouched (prompt caching keys on it), shim strictly appended.
    expect(blocks[0]).toEqual(original[0]);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]!.text).toBe(ctx.config.shimText);
  });

  it('creates a system prompt when the request had none', () => {
    const ctx = makeCtx();
    const fixed = systemShim.apply(baseRequest(), ctx);
    expect(fixed.system).toBe(ctx.config.shimText);
  });

  it('honours a per-model custom shim string', () => {
    const cfg = testConfig();
    cfg.models['gpt-5.6-luna']!.shim = 'Luna: implement exactly what the tests specify.';
    const ctx = makeCtx('gpt-5.6-luna', cfg);
    const fixed = systemShim.apply(baseRequest({ system: 'base' }), ctx);
    expect(fixed.system).toBe('base\n\nLuna: implement exactly what the tests specify.');
  });

  it('is a no-op when the profile disables the shim', () => {
    const cfg = testConfig();
    cfg.models['gpt-5.6-sol']!.shim = false;
    const ctx = makeCtx('gpt-5.6-sol', cfg);
    const req = baseRequest({ system: 'base' });
    expect(systemShim.apply(req, ctx)).toEqual(req);
  });
});
