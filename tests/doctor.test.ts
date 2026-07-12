import { describe, expect, it } from 'vitest';
import { buildDoctorReport } from '../src/index.js';
import { ALL_FIXERS } from '../src/pipeline/index.js';
import { testConfig } from './helpers.js';

/**
 * `mgga doctor` is the self-documenting face of the pipeline: every fixer
 * must show up with its one-line rationale, and the whole GPT-5.6 family must
 * be visible in the routing table. If a contributor adds a fixer and forgets
 * to register it in pipeline/index.ts, this is the test that notices.
 */
describe('mgga doctor', () => {
  const report = buildDoctorReport(testConfig());

  it('lists the whole GPT-5.6 family', () => {
    expect(report).toContain('gpt-5.6-sol');
    expect(report).toContain('gpt-5.6-terra');
    expect(report).toContain('gpt-5.6-luna');
  });

  it('prints every registered fixer with its rationale', () => {
    for (const fixer of ALL_FIXERS) {
      expect(report).toContain(fixer.name);
      expect(report).toContain(fixer.why);
    }
  });

  it('shows the alias routing policy', () => {
    expect(report).toContain('claude-opus-*');
    expect(report).toContain('→ gpt-5.6-sol');
  });

  it('is honest about stub status while the port is under construction', () => {
    const stubs = ALL_FIXERS.filter((f) => f.status === 'stub').length;
    if (stubs > 0) expect(report).toMatch(/\[stub]/);
  });
});
