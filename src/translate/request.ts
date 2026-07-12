import type {
  AnthropicImageBlock,
  AnthropicMessagesRequest,
  AnthropicMessage,
  AnthropicToolResultBlock,
} from '../types/anthropic.js';
import type {
  ResponsesContentPart,
  ResponsesInputItem,
  ResponsesReasoningItem,
  ResponsesRequest,
  ResponsesTool,
} from '../types/openai.js';
import type { RequestContext } from '../pipeline/fixer.js';

/**
 * Anthropic Messages request → OpenAI Responses request.
 *
 * Runs AFTER the request fixers, so the input is already normalised:
 * cache_control stripped, system shim appended, tool schemas lowered (and
 * ctx.toolNameMap populated), thinking blocks sanitised, tool ids in call_*
 * form, ctx.reasoningEffort / ctx.maxOutputTokens decided.
 *
 * ## Contract (spec'd by tests/translate.request.test.ts)
 *
 * 1. model = ctx.targetModel.
 *
 * 2. instructions = the system prompt flattened to one string (blocks joined
 *    with "\n\n"). Absent system → no instructions field.
 *
 * 3. messages → input items, order-preserving:
 *    - user string content → message{role:'user', content:[input_text]}.
 *    - user blocks: every tool_result becomes a standalone function_call_output
 *      item FIRST (call_id = block.tool_use_id, output = text flattened; when
 *      is_error, prefix "ERROR: "). Images inside a tool_result cannot ride a
 *      function_call_output — append them to the trailing user message and
 *      push a ctx warning. Remaining text/image blocks form one user message
 *      (text → input_text; image base64 → input_image data URL
 *      `data:{media_type};base64,{data}`; image url → input_image url).
 *    - assistant blocks: thinking (signed) → reasoning item {encrypted_content:
 *      signature} — the replay half of the signature trick; text →
 *      message{role:'assistant', content:[output_text]}; tool_use →
 *      function_call {call_id: id, name: lowered via ctx.toolNameMap,
 *      arguments: JSON.stringify(input)}. Block order within the assistant
 *      turn is preserved (reasoning must stay adjacent to the tool call it
 *      preceded, or the model loses its plan).
 *
 * 4. tools → [{type:'function', name, description, parameters}] using the
 *    already-lowered schema/name. tool_choice: auto→'auto', any→'required',
 *    tool→{type:'function',name}, none→'none'.
 *    disable_parallel_tool_use:true → parallel_tool_calls:false (else true).
 *
 * 5. reasoning = {effort: ctx.reasoningEffort, summary:'auto'};
 *    max_output_tokens = ctx.maxOutputTokens.
 *
 * 6. Hard invariants: stream:true, store:false,
 *    include:['reasoning.encrypted_content'],
 *    prompt_cache_key: ctx.promptCacheKey (when set).
 *    `truncation` is deliberately NOT sent: the ChatGPT codex endpoint 400s
 *    on it (verified live 2026-07-12), and for an agent harness silent
 *    middle-of-context truncation is worse than a clean overflow error —
 *    Claude Code owns compaction.
 *
 * 7. Dropped-with-warning (reasoning models reject them): temperature, top_p,
 *    top_k, stop_sequences. Each drop appends {fixer:'translate', message}.
 */
export function translateRequest(
  req: AnthropicMessagesRequest,
  ctx: RequestContext,
): ResponsesRequest {
  const lowerName = reverseNameLookup(ctx);

  const out: ResponsesRequest = {
    model: ctx.targetModel,
    input: translateMessages(req.messages, lowerName, ctx),
    stream: true,
    store: false,
    include: ['reasoning.encrypted_content'],
  };

  const instructions = flattenSystem(req.system);
  if (instructions !== undefined) out.instructions = instructions;

  if (req.tools && req.tools.length > 0) {
    out.tools = req.tools.map((tool) => {
      const mapped: ResponsesTool = {
        type: 'function',
        name: tool.name,
        parameters: tool.input_schema,
      };
      if (tool.description !== undefined) mapped.description = tool.description;
      return mapped;
    });

    let disableParallel = false;
    const choice = req.tool_choice;
    if (choice) {
      switch (choice.type) {
        case 'auto': out.tool_choice = 'auto'; break;
        case 'any': out.tool_choice = 'required'; break;
        case 'none': out.tool_choice = 'none'; break;
        case 'tool': out.tool_choice = { type: 'function', name: lowerName(choice.name) }; break;
      }
      disableParallel = choice.type !== 'none' && choice.disable_parallel_tool_use === true;
    }
    out.parallel_tool_calls = !disableParallel;
  }

  if (ctx.reasoningEffort !== undefined) {
    out.reasoning = { effort: ctx.reasoningEffort, summary: 'auto' };
  }
  if (ctx.maxOutputTokens !== undefined) out.max_output_tokens = ctx.maxOutputTokens;
  if (ctx.promptCacheKey !== undefined) out.prompt_cache_key = ctx.promptCacheKey;

  const dropped: Array<[name: string, present: boolean]> = [
    ['temperature', req.temperature !== undefined],
    ['top_p', req.top_p !== undefined],
    ['top_k', req.top_k !== undefined],
    ['stop_sequences', req.stop_sequences !== undefined && req.stop_sequences.length > 0],
  ];
  for (const [name, present] of dropped) {
    if (present) {
      ctx.warnings.push({
        fixer: 'translate',
        message: `dropped ${name} — GPT reasoning models reject sampling overrides`,
      });
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function flattenSystem(system: AnthropicMessagesRequest['system']): string | undefined {
  if (system === undefined) return undefined;
  if (typeof system === 'string') return system;
  return system.map((block) => block.text).join('\n\n');
}

/**
 * ctx.toolNameMap stores lowered → original (the direction the stream
 * translator needs). History replay needs the opposite: Claude Code echoes
 * ORIGINAL names back, and upstream only knows the lowered ones.
 */
function reverseNameLookup(ctx: RequestContext): (name: string) => string {
  if (ctx.toolNameMap.size === 0) return (name) => name;
  const reverse = new Map<string, string>();
  for (const [lowered, original] of ctx.toolNameMap) reverse.set(original, lowered);
  return (name) => reverse.get(name) ?? name;
}

function translateMessages(
  messages: AnthropicMessage[],
  lowerName: (name: string) => string,
  ctx: RequestContext,
): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];

  for (const message of messages) {
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        items.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: message.content }] });
        continue;
      }
      const parts: ResponsesContentPart[] = [];
      const imagesFromToolResults: ResponsesContentPart[] = [];
      for (const block of message.content) {
        switch (block.type) {
          case 'tool_result':
            items.push({
              type: 'function_call_output',
              call_id: block.tool_use_id,
              output: toolResultOutput(block, imagesFromToolResults, ctx),
            });
            break;
          case 'text':
            parts.push({ type: 'input_text', text: block.text });
            break;
          case 'image':
            parts.push(imagePart(block));
            break;
          default:
            break; // thinking blocks never occur in user messages
        }
      }
      parts.push(...imagesFromToolResults);
      if (parts.length > 0) items.push({ type: 'message', role: 'user', content: parts });
      continue;
    }

    // assistant
    if (typeof message.content === 'string') {
      if (message.content !== '') {
        items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: message.content }] });
      }
      continue;
    }
    for (const block of message.content) {
      switch (block.type) {
        case 'thinking': {
          if (!block.signature) break; // reasoning-bridge already warned; nothing replayable
          const item: ResponsesReasoningItem = {
            type: 'reasoning',
            summary: block.thinking === '' ? [] : [{ type: 'summary_text', text: block.thinking }],
            encrypted_content: block.signature,
          };
          items.push(item);
          break;
        }
        case 'text':
          items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: block.text }] });
          break;
        case 'tool_use':
          items.push({
            type: 'function_call',
            call_id: block.id,
            name: lowerName(block.name),
            arguments: JSON.stringify(block.input),
          });
          break;
        default:
          break; // redacted_thinking was dropped by reasoning-bridge
      }
    }
  }

  return items;
}

function toolResultOutput(
  block: AnthropicToolResultBlock,
  imageSink: ResponsesContentPart[],
  ctx: RequestContext,
): string {
  let text = '';
  const content = block.content;
  if (typeof content === 'string') {
    text = content;
  } else if (content) {
    const parts: string[] = [];
    for (const inner of content) {
      if (inner.type === 'text') {
        parts.push(inner.text);
      } else {
        imageSink.push(imagePart(inner));
        ctx.warnings.push({
          fixer: 'translate',
          message: `tool_result ${block.tool_use_id}: image moved into a user message (function_call_output carries text only)`,
        });
      }
    }
    text = parts.join('\n');
  }
  return block.is_error ? `ERROR: ${text}` : text;
}

function imagePart(block: AnthropicImageBlock): ResponsesContentPart {
  const source = block.source;
  return {
    type: 'input_image',
    image_url:
      source.type === 'base64' ? `data:${source.media_type};base64,${source.data}` : source.url,
  };
}
