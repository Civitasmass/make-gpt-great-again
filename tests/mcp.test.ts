import { describe, expect, it } from 'vitest';
import { handleMcpMessage, type McpDeps } from '../src/mcp.js';
import { MockBackend } from '../src/backends/mock.js';
import { testConfig } from './helpers.js';

/**
 * `mgga mcp` speaks newline-delimited JSON-RPC over stdio so any MCP client
 * (Claude Code first) gets an ask_gpt tool. These tests pin the dispatch —
 * the stdio loop around it is a dozen lines of plumbing.
 */
function deps(): McpDeps {
  return { cfg: testConfig({ backend: 'mock' }), backend: MockBackend.hello(), version: '0.0.0-test' };
}

const call = (method: string, params?: Record<string, unknown>) =>
  handleMcpMessage({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }, deps());

describe('mcp dispatch', () => {
  it('initialize: echoes the protocol version and announces the tools capability', async () => {
    const res = (await call('initialize', { protocolVersion: '2025-06-18' })) as {
      result: { protocolVersion: string; serverInfo: { name: string }; capabilities: { tools: object } };
    };
    expect(res.result.protocolVersion).toBe('2025-06-18');
    expect(res.result.serverInfo.name).toBe('mgga');
    expect(res.result.capabilities.tools).toBeDefined();
  });

  it('tools/list: exactly one tool, ask_gpt, with prompt required', async () => {
    const res = (await call('tools/list')) as {
      result: { tools: Array<{ name: string; inputSchema: { required: string[] } }> };
    };
    expect(res.result.tools).toHaveLength(1);
    expect(res.result.tools[0]!.name).toBe('ask_gpt');
    expect(res.result.tools[0]!.inputSchema.required).toEqual(['prompt']);
  });

  it('tools/call ask_gpt: answers with a model@effort header so the caller knows who spoke', async () => {
    const res = (await call('tools/call', { name: 'ask_gpt', arguments: { prompt: 'hi' } })) as {
      result: { content: Array<{ type: string; text: string }> };
    };
    expect(res.result.content[0]!.text).toMatch(/^\[gpt-5\.6-sol/);
    expect(res.result.content[0]!.text).toContain('Hello from mgga');
  });

  it('tools/call without a prompt is an invalid-params error', async () => {
    const res = (await call('tools/call', { name: 'ask_gpt', arguments: {} })) as {
      error: { code: number };
    };
    expect(res.error.code).toBe(-32602);
  });

  it('notifications (no id) are consumed silently', async () => {
    const res = await handleMcpMessage(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      deps(),
    );
    expect(res).toBeNull();
  });

  it('unknown methods are -32601, not a crash', async () => {
    const res = (await call('resources/list')) as { error: { code: number } };
    expect(res.error.code).toBe(-32601);
  });
});
