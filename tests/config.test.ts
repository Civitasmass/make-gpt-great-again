import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clampEffort, effortForBudget, loadConfig, resolveModel } from '../src/config.js';
import { testConfig } from './helpers.js';

/**
 * Routing is the whole "make the GPT-5.6 family usable in Claude Code" story:
 * Claude Code asks for Claude models by id (including hidden background calls
 * to small models) and every single request must land on a GPT sibling —
 * silently falling through to a wrong model is how proxies burn money and
 * confuse users. All policy is data (aliases/effortMap), so these tests also
 * pin the shipped defaults.
 */
describe('model routing', () => {
  const cfg = testConfig();

  it('resolves exact gpt slugs from the registry', () => {
    const route = resolveModel('gpt-5.6-sol', cfg);
    expect(route).toMatchObject({ target: 'gpt-5.6-sol', via: 'exact' });
  });

  it('maps each Claude tier onto its GPT-5.6 sibling', () => {
    expect(resolveModel('claude-opus-4-7', cfg).target).toBe('gpt-5.6-sol');
    expect(resolveModel('claude-opus-4-20990101', cfg).target).toBe('gpt-5.6-sol');
    expect(resolveModel('claude-sonnet-4-6', cfg).target).toBe('gpt-5.6-terra');
    // Claude Code uses small models for background tasks (title generation,
    // summarisation) — these ids arrive without the user ever typing them.
    expect(resolveModel('claude-haiku-4-5-20251001', cfg).target).toBe('gpt-5.6-luna');
    expect(resolveModel('claude-3-5-haiku-20241022', cfg).target).toBe('gpt-5.6-luna');
  });

  it('passes unknown gpt-* ids through untouched, so `/model gpt-x` just works', () => {
    const route = resolveModel('gpt-7-experimental', cfg);
    expect(route).toMatchObject({ target: 'gpt-7-experimental', via: 'passthrough' });
  });

  it('lands everything else on the default model instead of erroring', () => {
    const route = resolveModel('totally-unknown', cfg);
    expect(route).toMatchObject({ target: cfg.defaultModel, via: 'default' });
  });

  it('peels a `:effort` suffix and pins it, clamped to the routed model', () => {
    expect(resolveModel('gpt-5.6-sol:ultra', cfg)).toMatchObject({
      target: 'gpt-5.6-sol',
      via: 'exact',
      pinnedEffort: 'ultra',
    });
    // luna has no ultra tier — the pin snaps down to its strongest.
    expect(resolveModel('gpt-5.6-luna:ultra', cfg)).toMatchObject({
      target: 'gpt-5.6-luna',
      pinnedEffort: 'max',
    });
  });

  it('leaves unknown suffixes in the model string — not every colon is an effort', () => {
    const route = resolveModel('gpt-5.6-sol:turbo', cfg);
    expect(route.pinnedEffort).toBeUndefined();
    expect(route.target).toBe('gpt-5.6-sol:turbo'); // passthrough; upstream will say what it thinks
  });
});

describe('thinking budget → reasoning effort', () => {
  const cfg = testConfig();
  const profile = cfg.models['gpt-5.6-sol']!;

  it('uses the effort floor when the client did not ask for thinking', () => {
    expect(effortForBudget(undefined, profile, cfg.effortMap)).toBe('low');
  });

  it('maps budgets through the table, boundaries inclusive', () => {
    expect(effortForBudget(4_096, profile, cfg.effortMap)).toBe('low');
    expect(effortForBudget(8_192, profile, cfg.effortMap)).toBe('low');
    expect(effortForBudget(8_193, profile, cfg.effortMap)).toBe('medium');
    expect(effortForBudget(24_576, profile, cfg.effortMap)).toBe('medium');
    expect(effortForBudget(65_536, profile, cfg.effortMap)).toBe('high');
    expect(effortForBudget(1_000_000, profile, cfg.effortMap)).toBe('xhigh');
  });

  it('clamps efforts into what the model actually supports', () => {
    // GPT-5.6 starts at 'low' — a 'minimal' request snaps up to the weakest supported.
    expect(clampEffort('minimal', profile)).toBe('low');
    expect(clampEffort('ultra', profile)).toBe('ultra');
    expect(clampEffort('nonsense', profile)).toBe(profile.efforts[0]);
  });
});

describe('config loading', () => {
  it('merges a user config file over defaults without losing unmentioned models', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mgga-'));
    const file = join(dir, 'mgga.config.json');
    writeFileSync(
      file,
      JSON.stringify({
        port: 7777,
        models: { 'gpt-5.6-sol': { reasoningHeadroom: 1234 } },
        aliases: { 'claude-*': 'gpt-5.6-luna' },
      }),
    );

    const cfg = loadConfig(file, {});
    expect(cfg.port).toBe(7777);
    expect(cfg.models['gpt-5.6-sol']!.reasoningHeadroom).toBe(1234);
    // Partial profile override keeps the other defaults…
    expect(cfg.models['gpt-5.6-sol']!.efforts).toContain('max');
    // …and models the file never mentioned survive.
    expect(cfg.models['gpt-5.6-terra']).toBeDefined();
    expect(cfg.source).toBe(file);
  });

  it('lets env vars win over the file', () => {
    const cfg = loadConfig(undefined, { MGGA_PORT: '9999', MGGA_BACKEND: 'mock' });
    expect(cfg.port).toBe(9999);
    expect(cfg.backend).toBe('mock');
  });

  it('throws on an explicitly named file that does not exist', () => {
    expect(() => loadConfig('does-not-exist.json', {})).toThrow(/cannot load config/);
  });

  it('silently uses defaults when the implicit ./mgga.config.json is absent', () => {
    // Run from an empty temp dir — the repo root may legitimately carry a
    // local mgga.config.json (that's the documented way to use it).
    const empty = mkdtempSync(join(tmpdir(), 'mgga-empty-'));
    const previous = process.cwd();
    process.chdir(empty);
    try {
      const cfg = loadConfig(undefined, {});
      expect(cfg.source).toBe('defaults');
    } finally {
      process.chdir(previous);
    }
  });
});
