import type { AnthropicMessagesRequest, JsonSchema } from '../../types/anthropic.js';
import type { RequestContext, RequestFixer } from '../fixer.js';

/**
 * ## Problem
 * Anthropic tools carry full JSON Schema draft 2020-12; OpenAI's function
 * schemas accept a narrower dialect and reject or misread the rest. Claude
 * Code's built-in tools (and MCP servers especially) trip this constantly:
 * `format: "uri"`, `oneOf` unions, `const` discriminators, names longer than
 * OpenAI's 64-char limit (`mcp__server__tool` composites).
 *
 * ## Fix — lower every tool schema to the safe dialect, recursively:
 *  - drop `$schema`, `$id`, and any `format` (semantic loss only, never a 400)
 *  - `oneOf` → `anyOf` (equivalent acceptance, better OpenAI support)
 *  - `const: x` → `enum: [x]`
 *  - drop `patternProperties` / `propertyNames` / `if`+`then`+`else`,
 *    each recorded as a ctx warning (these silently narrow validation)
 *  - non-object root → wrap as {type:'object', properties:{value: original},
 *    required:['value']} with a warning (OpenAI requires object roots)
 *  - recurse through properties / items / prefixItems / anyOf / allOf / $defs
 *  - names > 64 chars or with illegal chars → `slice(0,48) + '_' + fnv1a32hex`,
 *    recorded in ctx.toolNameMap (lowered → original) so the stream translator
 *    can restore the original name on the way back. Deterministic: the same
 *    original always lowers to the same name, across processes.
 *
 * `strict: true` mode (require-all + additionalProperties:false rewriting) is
 * deliberately out of scope for v1 — see ARCHITECTURE.md §Non-goals.
 *
 * ## Spec: tests/fixers/schema-lowering.test.ts
 */
export const schemaLowering: RequestFixer = {
  name: 'schema-lowering',
  why: "Anthropic tools use JSON Schema 2020-12; OpenAI accepts a narrower dialect and a 64-char name limit — lower schemas instead of 400ing.",
  status: 'ready',
  apply(req: AnthropicMessagesRequest, ctx: RequestContext): AnthropicMessagesRequest {
    if (!req.tools || req.tools.length === 0) return req;

    const tools = req.tools.map((tool) => {
      const warn = (detail: string) =>
        ctx.warnings.push({ fixer: 'schema-lowering', message: `tool ${tool.name}: ${detail}` });

      let schema = lowerSchema(tool.input_schema, warn) as JsonSchema;
      if (schema['type'] !== 'object') {
        warn('non-object schema root wrapped as {value: …} (OpenAI requires object parameters)');
        schema = { type: 'object', properties: { value: schema }, required: ['value'] };
      }

      const name = lowerToolName(tool.name);
      if (name !== tool.name) ctx.toolNameMap.set(name, tool.name);

      return { ...tool, name, input_schema: schema };
    });

    return { ...req, tools };
  },
};

// ---------------------------------------------------------------------------
// Name lowering
// ---------------------------------------------------------------------------

const SAFE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Deterministic across processes — pure function of the original name. */
export function lowerToolName(name: string): string {
  if (SAFE_NAME.test(name)) return name;
  const sanitized = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48);
  return `${sanitized}_${fnv1a32hex(name)}`;
}

function fnv1a32hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// Schema lowering
// ---------------------------------------------------------------------------

/** Keywords whose values are themselves schemas (or arrays/maps of schemas). */
const RECURSE_DIRECT = new Set(['items', 'prefixItems', 'anyOf', 'allOf', 'not', 'additionalProperties']);
const RECURSE_MAP = new Set(['properties', '$defs', 'definitions']);
const DROP_SILENT = new Set(['$schema', '$id', 'format']);
const DROP_WARN = new Set(['patternProperties', 'propertyNames', 'if', 'then', 'else']);

function lowerSchema(schema: unknown, warn: (detail: string) => void): unknown {
  if (Array.isArray(schema)) return schema.map((entry) => lowerSchema(entry, warn));
  if (schema === null || typeof schema !== 'object') return schema;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
    if (DROP_SILENT.has(key)) continue;
    if (DROP_WARN.has(key)) {
      warn(`dropped ${key} (not expressible in OpenAI function schemas — validation narrows silently)`);
      continue;
    }
    if (key === 'oneOf') {
      out['anyOf'] = lowerSchema(value, warn);
      continue;
    }
    if (key === 'const') {
      out['enum'] = [value];
      continue;
    }
    if (RECURSE_DIRECT.has(key)) {
      out[key] = lowerSchema(value, warn);
      continue;
    }
    if (RECURSE_MAP.has(key) && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const mapped: Record<string, unknown> = {};
      for (const [prop, sub] of Object.entries(value as Record<string, unknown>)) {
        mapped[prop] = lowerSchema(sub, warn);
      }
      out[key] = mapped;
      continue;
    }
    out[key] = value;
  }
  return out;
}
