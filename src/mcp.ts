import { createInterface } from 'node:readline';
import type { Backend } from './backends/backend.js';
import type { ResolvedConfig } from './config.js';
import { askOnce } from './ask.js';

/**
 * `mgga mcp` — a stdio MCP server exposing one tool, ask_gpt, so ANY MCP
 * client (Claude Code first among them) can hand a question to GPT-5.6 as a
 * native tool call. Claude asking GPT for a second opinion becomes a
 * one-tool-call reflex instead of a context switch.
 *
 * Wire it into Claude Code:
 *   claude mcp add --scope user gpt -- node <repo>/dist/index.js mcp
 *
 * The transport is newline-delimited JSON-RPC 2.0 over stdio (the MCP stdio
 * framing). Hand-rolled on purpose: three methods do not earn an SDK.
 */

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

const ASK_TOOL = {
  name: 'ask_gpt',
  description:
    'Ask OpenAI GPT-5.6 a one-shot question — a second opinion, an independent ' +
    'review, or an alternative take from a different frontier model family. ' +
    'Include ALL needed context in the prompt: the call is stateless and the ' +
    'model sees nothing else. Pick a tier by suffix, e.g. "gpt-5.6-sol:high" ' +
    '(sol=frontier, terra=balanced, luna=fast; efforts low…ultra).',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: 'The full, self-contained question or task.' },
      model: {
        type: 'string',
        description: 'Model slug with optional :effort suffix. Default gpt-5.6-sol.',
      },
      system: { type: 'string', description: 'Optional system prompt.' },
    },
    required: ['prompt'],
  },
} as const;

export interface McpDeps {
  cfg: ResolvedConfig;
  backend: Backend;
  version: string;
}

/** Pure dispatch — one JSON-RPC request in, one response (or null for notifications) out. */
export async function handleMcpMessage(
  msg: JsonRpcMessage,
  deps: McpDeps,
): Promise<JsonRpcMessage | null> {
  if (msg.id === undefined || msg.id === null) return null; // notification — nothing to answer

  const reply = (result: unknown): JsonRpcMessage => ({ jsonrpc: '2.0', id: msg.id, result });

  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: (msg.params?.['protocolVersion'] as string) ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'mgga', version: deps.version },
      });

    case 'ping':
      return reply({});

    case 'tools/list':
      return reply({ tools: [ASK_TOOL] });

    case 'tools/call': {
      const name = msg.params?.['name'];
      if (name !== ASK_TOOL.name) {
        return { jsonrpc: '2.0', id: msg.id, ...errorBody(-32602, `unknown tool: ${String(name)}`) };
      }
      const args = (msg.params?.['arguments'] ?? {}) as {
        prompt?: string;
        model?: string;
        system?: string;
      };
      if (!args.prompt) {
        return { jsonrpc: '2.0', id: msg.id, ...errorBody(-32602, 'ask_gpt requires a prompt') };
      }
      try {
        const answer = await askOnce(deps.cfg, deps.backend, {
          prompt: args.prompt,
          ...(args.model !== undefined ? { model: args.model } : {}),
          ...(args.system !== undefined ? { system: args.system } : {}),
        });
        const header = `[${answer.model}${answer.effort ? ` @ ${answer.effort}` : ''}]`;
        return reply({ content: [{ type: 'text', text: `${header}\n${answer.text}` }] });
      } catch (err) {
        // Tool-level failures ride inside the result so the CLIENT model sees
        // them and can retry/adjust — a JSON-RPC error would kill the call.
        return reply({
          content: [{ type: 'text', text: `ask_gpt failed: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        });
      }
    }

    default:
      return { jsonrpc: '2.0', id: msg.id, ...errorBody(-32601, `method not found: ${msg.method}`) };
  }
}

function errorBody(code: number, message: string): { error: { code: number; message: string } } {
  return { error: { code, message } };
}

/** The stdio loop. Runs until stdin closes. */
export async function runMcpServer(deps: McpDeps): Promise<void> {
  const lines = createInterface({ input: process.stdin, terminal: false });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      continue; // not JSON — ignore rather than corrupt the stream
    }
    const response = await handleMcpMessage(msg, deps);
    if (response) process.stdout.write(JSON.stringify(response) + '\n');
  }
}
