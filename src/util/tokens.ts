import type { AnthropicCountTokensRequest } from '../types/anthropic.js';

/**
 * Token estimation for POST /v1/messages/count_tokens.
 *
 * Claude Code calls this endpoint to drive its context meter and compaction
 * heuristics; it needs to be *directionally* right, not exact. We estimate
 * from serialized length — English/code averages ~3.6–4 chars per token on
 * modern BPE vocabularies; CJK runs closer to 1–2 chars per token, which the
 * per-character floor below accounts for. Typical error is within ±15%,
 * plenty for a progress meter. If exactness ever matters, swap this module
 * for a real tokenizer behind the same function signature.
 */

const CHARS_PER_TOKEN = 3.8;
/** CJK codepoints don't pack like ASCII — budget roughly one token per character. */
const TOKENS_PER_CJK_CHAR = 1;
const PER_MESSAGE_OVERHEAD = 4;
const PER_TOOL_OVERHEAD = 12;
const REQUEST_OVERHEAD = 20;

function textTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x2e80 && cp <= 0x9fff) cjk++;
    else if (cp >= 0x3040 && cp <= 0x30ff) cjk++;
    else if (cp >= 0xac00 && cp <= 0xd7af) cjk++;
  }
  const ascii = text.length - cjk;
  return Math.ceil(ascii / CHARS_PER_TOKEN + cjk * TOKENS_PER_CJK_CHAR);
}

export function estimateInputTokens(req: AnthropicCountTokensRequest): number {
  let total = REQUEST_OVERHEAD;

  const system = req.system;
  if (typeof system === 'string') total += textTokens(system);
  else if (system) for (const block of system) total += textTokens(block.text);

  for (const message of req.messages) {
    total += PER_MESSAGE_OVERHEAD;
    if (typeof message.content === 'string') {
      total += textTokens(message.content);
      continue;
    }
    for (const block of message.content) {
      switch (block.type) {
        case 'text':
          total += textTokens(block.text);
          break;
        case 'thinking':
          total += textTokens(block.thinking);
          break;
        case 'tool_use':
          total += textTokens(block.name) + textTokens(JSON.stringify(block.input));
          break;
        case 'tool_result': {
          const content = block.content;
          if (typeof content === 'string') total += textTokens(content);
          else if (content) {
            for (const inner of content) {
              total += inner.type === 'text' ? textTokens(inner.text) : 1_100; // image ≈ fixed budget
            }
          }
          break;
        }
        case 'image':
          total += 1_100;
          break;
        case 'redacted_thinking':
          total += Math.ceil(block.data.length / 6);
          break;
      }
    }
  }

  for (const tool of req.tools ?? []) {
    total += PER_TOOL_OVERHEAD;
    total += textTokens(tool.name) + textTokens(tool.description ?? '');
    total += textTokens(JSON.stringify(tool.input_schema));
  }

  return total;
}
