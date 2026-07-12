import { describe, expect, it } from 'vitest';
import { schemaLowering } from '../../src/pipeline/fixers/schema-lowering.js';
import type { AnthropicTool } from '../../src/types/anthropic.js';
import { baseRequest, makeCtx } from '../helpers.js';

/**
 * THE PROBLEM: Anthropic tools speak full JSON Schema 2020-12; OpenAI's
 * function schemas accept a narrower dialect and a 64-char name limit. MCP
 * servers are the worst offenders (`mcp__long-server-name__tool` composites,
 * `format: "uri"`, `oneOf` unions) — without lowering, adding one MCP server
 * can 400 every request in the session.
 */
function toolWith(schema: Record<string, unknown>, name = 'Test'): AnthropicTool {
  return { name, input_schema: schema };
}

function lowered(schema: Record<string, unknown>, name = 'Test') {
  const ctx = makeCtx();
  const fixed = schemaLowering.apply(baseRequest({ tools: [toolWith(schema, name)] }), ctx);
  return { tool: fixed.tools![0]!, ctx };
}

describe('fixer: schema-lowering', () => {
  it('drops `format` (semantic hint, hard 400 on OpenAI) and `$schema`', () => {
    const { tool } = lowered({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      properties: { url: { type: 'string', format: 'uri' } },
    });
    expect(JSON.stringify(tool.input_schema)).not.toContain('format');
    expect(JSON.stringify(tool.input_schema)).not.toContain('$schema');
  });

  it('rewrites oneOf → anyOf, recursively', () => {
    const { tool } = lowered({
      type: 'object',
      properties: {
        target: { oneOf: [{ type: 'string' }, { type: 'object', properties: { id: { oneOf: [{ type: 'number' }] } } }] },
      },
    });
    const text = JSON.stringify(tool.input_schema);
    expect(text).not.toContain('oneOf');
    expect(text).toContain('anyOf');
  });

  it('rewrites const → single-value enum', () => {
    const { tool } = lowered({
      type: 'object',
      properties: { kind: { const: 'file' } },
    });
    expect(JSON.stringify(tool.input_schema)).toContain('"enum":["file"]');
  });

  it('drops validators OpenAI cannot express, and says so in a warning', () => {
    const { tool, ctx } = lowered({
      type: 'object',
      patternProperties: { '^x-': { type: 'string' } },
      properties: { a: { type: 'string' } },
    });
    expect(JSON.stringify(tool.input_schema)).not.toContain('patternProperties');
    expect(ctx.warnings.some((w) => w.message.includes('patternProperties'))).toBe(true);
  });

  it('wraps a non-object root (OpenAI requires object parameters)', () => {
    const { tool, ctx } = lowered({ type: 'string' });
    expect(tool.input_schema).toMatchObject({
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    });
    expect(ctx.warnings.length).toBeGreaterThan(0);
  });

  it('shortens >64-char MCP names deterministically and records the reverse mapping', () => {
    const longName = 'mcp__extremely-long-server-name__an-even-longer-tool-name-that-overflows';
    const { tool: first, ctx } = lowered({ type: 'object' }, longName);
    const { tool: second } = lowered({ type: 'object' }, longName);

    expect(first.name.length).toBeLessThanOrEqual(64);
    // Deterministic across processes: same input, same lowered name.
    expect(second.name).toBe(first.name);
    // The stream translator uses this map to give Claude Code its original name back.
    expect(ctx.toolNameMap.get(first.name)).toBe(longName);
  });

  it('leaves already-safe schemas byte-identical (no gratuitous rewriting)', () => {
    const safe = {
      type: 'object',
      properties: { command: { type: 'string', description: 'shell command' } },
      required: ['command'],
    };
    const { tool } = lowered(safe);
    expect(tool.input_schema).toEqual(safe);
  });
});
