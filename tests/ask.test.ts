import { describe, expect, it } from 'vitest';
import { askOnce } from '../src/ask.js';
import { MockBackend } from '../src/backends/mock.js';
import type { Backend } from '../src/backends/backend.js';
import type { ResponsesRequest } from '../src/types/openai.js';
import { testConfig } from './helpers.js';

/**
 * `mgga ask` / the ask_gpt MCP tool: a second frontier model one function
 * call away from any agent. Same pipeline as the server — same fixes — but
 * in-process, stateless, and tuned for bare Q&A rather than harness driving.
 */
describe('askOnce', () => {
  it('routes the default model and returns the plain-text answer', async () => {
    const result = await askOnce(testConfig({ backend: 'mock' }), MockBackend.hello(), {
      prompt: 'hi',
    });
    expect(result.text).toContain('Hello from mgga');
    expect(result.model).toBe('gpt-5.6-sol');
  });

  it('honours the `:effort` suffix grammar, same as everywhere else in mgga', async () => {
    const result = await askOnce(testConfig(), MockBackend.hello(), {
      prompt: 'hi',
      model: 'gpt-5.6-sol:ultra',
    });
    expect(result.model).toBe('gpt-5.6-sol');
    expect(result.effort).toBe('ultra');
  });

  it('disables the harness shim — a bare question needs no tool-bridging lecture', async () => {
    let seen: ResponsesRequest | undefined;
    const capturing: Backend = {
      name: 'mock',
      stream(req, opts) {
        seen = req;
        return MockBackend.hello().stream(req, opts);
      },
    };
    await askOnce(testConfig(), capturing, { prompt: 'hi', system: 'You are terse.' });
    expect(seen!.instructions).toBe('You are terse.'); // exactly the caller's system, no shim appended
  });
});
